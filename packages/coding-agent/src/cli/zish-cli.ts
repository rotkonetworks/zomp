/**
 * Control plane for zish workers.
 *
 * zish hosts long-lived session feats and publishes them under
 * `~/.zish/sessions` (see {@link ../zish/workers}). This subcommand is how a
 * caller — a person, or the model driving it through the shell — discovers those
 * sessions, reads what they did, and steers them out of band. `spawn` is the one
 * piece zish cannot do for itself: it starts a worker on a PTY, because only the
 * async host (stdout on a tty) registers a session that can be steered later.
 *
 * Output is terse by contract: one record per line, tab-separated, nothing
 * decorative. `--json` is the escape hatch for machine consumers.
 */
import {
	answerZishSession,
	killZishSession,
	listZishSessions,
	readZishTranscript,
	spawnZishWorker,
	type ZishSessionMeta,
	type ZishTranscriptEvent,
} from "../zish/workers";

export type ZishAction = "list" | "tail" | "answer" | "kill" | "spawn";

export interface ZishCommandArgs {
	action: ZishAction;
	/** pid of the hosting zish process (`host`); required by tail/answer/kill. */
	host?: number;
	/** Session id; required by tail/answer/kill. */
	id?: number;
	/** Answer text for `answer`. */
	text?: string;
	/** Shell line to type into a freshly spawned worker. */
	command?: string;
	json: boolean;
	follow: boolean;
	/** Byte offset to begin reading a transcript from. */
	from: number;
	/** Seconds to wait for a spawned worker to publish its session. */
	timeout: number;
}

/** One transcript event as a tab-separated line, keeping only its own fields. */
function renderEvent(event: ZishTranscriptEvent): string {
	const text = (value: unknown) => String(value ?? "");
	switch (event.t) {
		case "say":
		case "stream":
		case "note":
			return `${event.t}\t${text(event.text)}`;
		case "run":
			return `run\t${text(event.cmd)}`;
		case "result":
			return `result\t${text(event.code)}\t${text(event.out)}`;
		case "prompt":
			return `prompt\t${text(event.text)}`;
		case "answer":
			return `answer\t${text(event.text)}`;
		case "denied":
			return `denied\t${text(event.call)}\t${text(event.reason)}`;
		case "start":
			return `start\t${text(event.name)}`;
		default:
			return event.t;
	}
}

function requireSession(host: number | undefined, id: number | undefined): ZishSessionMeta {
	if (host === undefined || id === undefined) throw new Error("zish: <host> and <id> are required");
	const session = listZishSessions().find(candidate => candidate.host === host && candidate.id === id);
	if (!session) throw new Error(`zish: no live session ${host}-${id}`);
	return session;
}

function listSessions(json: boolean): void {
	const sessions = listZishSessions();
	if (json) {
		process.stdout.write(`${JSON.stringify(sessions)}\n`);
		return;
	}
	for (const session of sessions) {
		process.stdout.write(`${session.host}\t${session.id}\t${session.state}\t${session.name}\t${session.q}\n`);
	}
}

/**
 * Stream a session's transcript, stopping at `end` or — without `--follow` —
 * after the events already written. The offset only ever advances on a line
 * boundary, so a partially written tail is re-read rather than mis-decoded.
 */
async function tailSession(session: ZishSessionMeta, follow: boolean, from: number): Promise<void> {
	let offset = from;
	for (;;) {
		const page = readZishTranscript(session.transcript, offset);
		offset = page.offset;
		for (const event of page.events) {
			process.stdout.write(`${renderEvent(event)}\n`);
			if (event.t === "end") return;
		}
		if (!follow) return;
		await Bun.sleep(200);
	}
}

/**
 * Start an interactive zish on a PTY, type `command` into it, and follow the
 * session it publishes. The first line printed is the session's identity, so a
 * caller can steer it from another process; everything after it is the
 * transcript feed.
 */
async function spawnWorker(cmd: ZishCommandArgs): Promise<void> {
	const worker = await spawnZishWorker({ command: cmd.command ?? "", cwd: process.cwd() });
	const stop = () => worker.kill();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		const session = await worker.waitForSession(100, cmd.timeout * 1000);
		if (!session) {
			throw new Error("zish: worker started but published no session (is the command a session feat?)");
		}
		process.stdout.write(`${session.host}\t${session.id}\t${session.name}\n`);
		await tailSession(session, true, 0);
	} finally {
		// The interactive shell outlives the feat it hosts, and an idle prompt
		// holds this process open forever. A one-shot spawn is done when its feat
		// is, so reclaim the PTY rather than leaving a shell parked at a prompt.
		worker.kill();
	}
}

export async function runZishCommand(cmd: ZishCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "list":
			return listSessions(cmd.json);
		case "tail":
			return tailSession(requireSession(cmd.host, cmd.id), cmd.follow, cmd.from);
		case "spawn":
			return spawnWorker(cmd);
		case "answer": {
			const session = requireSession(cmd.host, cmd.id);
			if (!answerZishSession(session, cmd.text ?? "")) {
				throw new Error(`zish: session ${session.host}-${session.id} did not accept the answer`);
			}
			return;
		}
		case "kill": {
			const session = requireSession(cmd.host, cmd.id);
			if (!killZishSession(session)) {
				throw new Error(`zish: session ${session.host}-${session.id} did not accept the kill`);
			}
			return;
		}
	}
}
