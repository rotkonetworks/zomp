/**
 * zish worker control plane.
 *
 * zish hosts long-lived *session feats* (`feat.toml` `kind = "session"`) and
 * publishes each one as three files under `~/.zish/sessions`:
 *
 *   `<hostpid>-<id>.meta`           live state, rewritten on every transition
 *   `<hostpid>-<id>-<name>.jsonl`   append-only transcript, already JSON-escaped
 *   `<hostpid>-<id>.ctl`            control FIFO: `{"t":"answer"}` / `{"t":"kill"}`
 *
 * A session reaches that registry only under the **async** host — an interactive
 * zish whose stdout is a tty. `zish -c` selects the sync host, which registers
 * nothing and refuses `prompt` outright ("Nobody to ask in sync mode"), so a
 * worker the model can steer has to be started on a PTY.
 *
 * Every reader here is hostile-tolerant rather than trusting: the registry is
 * rewritten in place and the transcript is appended to, so a torn last line is
 * expected, not exceptional, and is skipped instead of thrown.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";

export interface ZishSessionMeta {
	/** Per-host session id — the number `session answer`/`session kill` take. */
	id: number;
	/** pid of the zish process hosting the session. */
	host: number;
	/** Session name (`agent`, or any other session feat). */
	name: string;
	/** `awaiting` means a question is parked and `q` holds it; `tool` means a `run` is in flight. */
	state: "running" | "tool" | "awaiting";
	/** Transcript JSONL path. */
	transcript: string;
	/** Control FIFO path; empty when the host could not create one. */
	ctl: string;
	/** The parked question, when `state` is `awaiting`. */
	q: string;
}

export interface ZishTranscriptEvent {
	/** Event kind: `start` `say` `stream` `run` `result` `prompt` `answer` `denied` `note` `end`. */
	t: string;
	[key: string]: unknown;
}

/** Where zish keeps its session registry; honors the same `$HOME` the shell does. */
export function zishSessionsDir(): string {
	return path.join(Bun.env.HOME ?? os.homedir(), ".zish", "sessions");
}

/** Live sessions published by every hosting zish on the machine, oldest host first. */
export function listZishSessions(): ZishSessionMeta[] {
	const dir = zishSessionsDir();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const sessions: ZishSessionMeta[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".meta")) continue;
		try {
			sessions.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as ZishSessionMeta);
		} catch {
			// Rewritten in place: a racing read can catch a torn line. Skip it.
		}
	}
	return sessions.sort((a, b) => a.host - b.host || a.id - b.id);
}

export interface ZishTranscriptPage {
	events: ZishTranscriptEvent[];
	/** Byte offset to pass back for the next incremental read. */
	offset: number;
}

/**
 * Read transcript events strictly after `offset`. Only newline-terminated lines
 * are consumed, so the offset always lands on a line boundary and a partially
 * written tail is re-read on the next call instead of being decoded as garbage.
 */
export function readZishTranscript(file: string, offset = 0): ZishTranscriptPage {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { events: [], offset };
	}
	const lastNewline = text.lastIndexOf("\n");
	if (lastNewline < offset) return { events: [], offset };
	const events: ZishTranscriptEvent[] = [];
	for (const line of text.slice(offset, lastNewline).split("\n")) {
		if (line === "") continue;
		try {
			events.push(JSON.parse(line) as ZishTranscriptEvent);
		} catch {
			// A torn line inside the committed region is dropped, never fatal.
		}
	}
	return { events, offset: lastNewline + 1 };
}

/**
 * Write one control frame to a session's FIFO. The host holds the FIFO open
 * read-write, so a writer never blocks on open, and a session that ended between
 * the registry read and this write simply fails the open — reported, not thrown.
 */
export function writeZishControl(meta: ZishSessionMeta, frame: Record<string, unknown>): boolean {
	if (!meta.ctl) return false;
	let fd: number;
	try {
		fd = fs.openSync(meta.ctl, "w");
	} catch {
		return false;
	}
	try {
		fs.writeSync(fd, `${JSON.stringify(frame)}\n`);
		return true;
	} catch {
		return false;
	} finally {
		fs.closeSync(fd);
	}
}

/** Deliver the answer to a session parked on `prompt`; false when it is gone. */
export function answerZishSession(meta: ZishSessionMeta, text: string): boolean {
	return writeZishControl(meta, { t: "answer", text });
}

/** Ask a session's host to tear it down; false when it is already gone. */
export function killZishSession(meta: ZishSessionMeta): boolean {
	return writeZishControl(meta, { t: "kill" });
}

export interface ZishWorker {
	pty: PtySession;
	/** pid of the hosting zish process, and the `host` field its sessions carry. */
	pid: number;
	/** The session id assigned to `command`, once it appears in the registry. */
	waitForSession(idleMs?: number, timeoutMs?: number): Promise<ZishSessionMeta | undefined>;
	/** Everything the worker has written so far. */
	transcript(): ZishTranscriptPage;
	/** Ask the worker a question's answer; returns false when its session is gone. */
	answer(text: string): boolean;
	/** Stop the worker: end its session, then kill the host process. */
	kill(): void;
}

/**
 * Start an interactive zish on a PTY and type `command` into it. The PTY is what
 * makes the session async — and therefore steerable — so this is the only way to
 * start a worker the model can talk to after the fact.
 */
export async function spawnZishWorker(options: {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	onOutput?: (chunk: string) => void;
}): Promise<ZishWorker> {
	// The user's own zish when `$SHELL` is one, else whatever `zish` is on PATH.
	const configured = Bun.env.SHELL ?? "";
	const shell = path.basename(configured).includes("zish") ? configured : "zish";
	const pty = new PtySession();
	const started = Promise.withResolvers<number>();
	// The PTY keeps this promise pending for the worker's entire life, so it is
	// deliberately not awaited as a whole — only the pid handshake is.
	void pty
		.startArgv(
			{ application: shell, args: ["-l"], cwd: options.cwd, env: options.env, cols: 120, rows: 40 },
			(err, chunk) => {
				if (!err && chunk) options.onOutput?.(chunk);
			},
			(err, pid) => {
				if (err) started.reject(err);
				else started.resolve(pid);
			},
		)
		.catch(() => undefined);
	const pid = await started.promise;
	pty.write(`${options.command}\n`);

	let offset = 0;
	let meta: ZishSessionMeta | undefined;
	const transcript = (): ZishTranscriptPage => {
		if (!meta) return { events: [], offset };
		const page = readZishTranscript(meta.transcript, offset);
		offset = page.offset;
		return page;
	};

	return {
		pty,
		pid,
		async waitForSession(idleMs = 100, timeoutMs = 30_000): Promise<ZishSessionMeta | undefined> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				meta = listZishSessions().find(session => session.host === pid);
				if (meta) return meta;
				if (Date.now() >= deadline) return undefined;
				await Bun.sleep(idleMs);
			}
		},
		transcript,
		answer: (text: string) => (meta ? answerZishSession(meta, text) : false),
		kill: () => {
			if (meta) killZishSession(meta);
			pty.kill();
		},
	};
}
