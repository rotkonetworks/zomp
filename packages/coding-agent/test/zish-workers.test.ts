import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listZishSessions, readZishTranscript } from "@oh-my-pi/pi-coding-agent/zish/workers";

const temporaryDirs: string[] = [];
const originalHome = Bun.env.HOME;

function temporaryDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryDirs.push(dir);
	return dir;
}

afterEach(() => {
	Bun.env.HOME = originalHome;
	for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("zish worker control plane", () => {
	it("consumes only whole transcript lines, and never replays one", () => {
		const file = path.join(temporaryDir("zish-transcript-"), "session.jsonl");
		const committed = '{"t":"start","name":"agent"}\n{"t":"say","text":"hi"}\n';
		// The host appends while readers run, so a torn tail line is the normal
		// case, not an exceptional one: it must be left for the next read.
		fs.writeFileSync(file, `${committed}{"t":"ru`);

		const first = readZishTranscript(file);
		expect(first.events.map(event => event.t)).toEqual(["start", "say"]);
		expect(first.offset).toBe(committed.length);

		fs.appendFileSync(file, 'n","cmd":"ls"}\n');
		const second = readZishTranscript(file, first.offset);
		expect(second.events.map(event => event.t)).toEqual(["run"]);
		expect(second.events[0]?.cmd).toBe("ls");
		expect(readZishTranscript(file, second.offset).events).toEqual([]);
	});

	it("reports no events for a transcript that has not been written yet", () => {
		const file = path.join(temporaryDir("zish-absent-"), "missing.jsonl");
		expect(readZishTranscript(file)).toEqual({ events: [], offset: 0 });
	});

	it("skips a torn registry record instead of failing the whole listing", () => {
		const home = temporaryDir("zish-home-");
		Bun.env.HOME = home;
		const dir = path.join(home, ".zish", "sessions");
		fs.mkdirSync(dir, { recursive: true });
		// The registry is rewritten in place, so an empty read is reachable.
		fs.writeFileSync(path.join(dir, "1-1.meta"), "");
		fs.writeFileSync(path.join(dir, "not-a-meta"), '{"id":9}');
		fs.writeFileSync(
			path.join(dir, "1-2.meta"),
			JSON.stringify({
				id: 2,
				host: 1,
				name: "agent",
				state: "awaiting",
				transcript: "/t.jsonl",
				ctl: "/t.ctl",
				q: "go?",
			}),
		);

		const sessions = listZishSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.state).toBe("awaiting");
		expect(sessions[0]?.q).toBe("go?");
	});
});
