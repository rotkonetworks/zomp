/**
 * LLM-assisted resolution for the conflicts the zomp fork hits when its commit
 * series is replayed onto fresh upstream oh-my-pi code.
 *
 * One request per conflicting file. The model receives the replayed commit, the
 * change that commit made to the file, and the working-tree file with its
 * conflict markers, and returns the merged file. Nothing from the reply is
 * trusted beyond the bytes written into that one file — the caller's gates
 * (typecheck, then tests) decide whether the result is allowed to ship.
 */
import { $ } from "bun";
import * as path from "node:path";
import { fail, git, rebaseInProgress, ROOT } from "./git";
import instructions from "./resolve.prompt.md" with { type: "text" };
import retryInstructions from "./resolve-retry.prompt.md" with { type: "text" };

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.ZOMP_RESOLVE_MODEL || "deepseek/deepseek-v4.1-flash";
const MAX_ROUNDS = 32;
const MAX_FILE_BYTES = 512 * 1024;

/** Machine-owned files: never hand a conflict in one of these to a model. */
const NEVER_RESOLVE = [
	"bun.lock",
	"Cargo.lock",
	"package-lock.json",
	"packages/catalog/src/models.json",
	"packages/catalog/src/compat/rules.json",
];
const NEVER_RESOLVE_PATTERNS = [/\.generated\./, /^packages\/natives\/native\//, /^dist\//];

export interface ResolutionReport {
	resolved: string[];
	skipped: string[];
}

interface Completion {
	choices?: Array<{ message?: { content?: string } }>;
	error?: { message?: string };
}

function isPlausible(candidate: string, original: string): boolean {
	if (candidate.length === 0) return false;
	if (/^(<{7}|={7}|>{7}|\|{7})/m.test(candidate)) return false;
	if (/^diff --git /m.test(candidate)) return false;
	// A reply under half the conflicting file's size means a truncated stream.
	return candidate.length >= Math.min(original.length, 400) / 2;
}

function unwrapFence(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
	return fenced === null ? trimmed : fenced[1];
}

async function complete(system: string, user: string, maxTokens: number): Promise<string> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) fail("OPENROUTER_API_KEY is unset — cannot resolve conflicts automatically");
	let lastError = "no attempt made";
	for (let attempt = 1; attempt <= 3; attempt++) {
		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: MODEL,
				temperature: 0,
				max_tokens: maxTokens,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
			signal: AbortSignal.timeout(900_000),
		}).catch((error: Error) => {
			lastError = error.message;
			return null;
		});
		if (response === null) continue;
		if (!response.ok) {
			lastError = `${response.status} ${(await response.text()).slice(0, 400)}`;
			if (response.status !== 429 && response.status < 500) break;
			await Bun.sleep(attempt * 5_000);
			continue;
		}
		const payload = (await response.json()) as Completion;
		const content = payload.choices?.[0]?.message?.content ?? "";
		if (content.trim() !== "") return content;
		lastError = payload.error?.message ?? "empty completion";
		await Bun.sleep(attempt * 5_000);
	}
	return fail(`model call failed: ${lastError}`);
}

/** Merge one conflicting file and stage the result. */
async function resolveFile(file: string, commitMessage: string, log: (line: string) => void): Promise<void> {
	const absolute = path.join(ROOT, file);
	const original = await Bun.file(absolute).text();
	if (original.length > MAX_FILE_BYTES) {
		fail(`${file} is ${(original.length / 1024).toFixed(0)} KiB — too large to resolve automatically`);
	}
	const change = (await git("show", "-U20", "REBASE_HEAD", "--", file)).out;
	const user = [
		"<commit>",
		commitMessage,
		"</commit>",
		"",
		`<original-change path="${file}">`,
		change,
		"</original-change>",
		"",
		`<conflicting-file path="${file}">`,
		original,
		"</conflicting-file>",
	].join("\n");
	// Output budget tracks the file: ~3 characters per token, never under 4k.
	const maxTokens = Math.min(60_000, Math.max(4_000, Math.ceil(original.length / 3)));

	let reply = unwrapFence(await complete(instructions, user, maxTokens));
	if (!isPlausible(reply, original)) {
		log(`  ↻ ${file}: first reply rejected, asking again`);
		const rejection = ["<rejected-reply>", reply, "</rejected-reply>"].join("\n");
		reply = unwrapFence(await complete(retryInstructions, `${user}\n\n${rejection}`, maxTokens));
		if (!isPlausible(reply, original)) {
			fail(`${file}: model did not return the merged file (markers, diff, or truncated output)`);
		}
	}
	await Bun.write(absolute, reply.endsWith("\n") ? reply : `${reply}\n`);
	log(`  ✓ ${file}`);
}

/**
 * Drive an in-progress rebase to completion, resolving each round of conflicts
 * through the model. Returns what was merged and what became empty.
 */
export async function resolveRebaseConflicts(
	log: (line: string) => void = console.log,
): Promise<ResolutionReport> {
	const report: ResolutionReport = { resolved: [], skipped: [] };
	if (!(await rebaseInProgress())) fail("no rebase in progress — nothing to resolve");

	for (let round = 0; round < MAX_ROUNDS; round++) {
		const conflicted = (await git("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
		if (conflicted.length > 0) {
			const commitMessage = (await git("log", "-1", "--format=%B", "REBASE_HEAD")).out;
			const subject = commitMessage.split("\n")[0];
			log(`conflict in "${subject}" — ${conflicted.length} file(s), model ${MODEL}`);
			for (const file of conflicted) {
				const frozen = NEVER_RESOLVE.includes(file) || NEVER_RESOLVE_PATTERNS.some(pattern => pattern.test(file));
				if (frozen) fail(`${file} is machine-owned — regenerate it instead of resolving by hand`);
				await resolveFile(file, commitMessage, log);
				report.resolved.push(file);
			}
			// A hand-merged file still has to look like the rest of the repo.
			const formattable = conflicted.filter(file => /\.(ts|tsx|json)$/.test(file));
			if (formattable.length > 0) {
				const formatted = await $`./node_modules/.bin/oxfmt --write ${formattable}`.cwd(ROOT).quiet().nothrow();
				if (formatted.exitCode !== 0) log(`  ⚠ oxfmt unavailable — formatting not applied`);
			}
			const staged = await git("add", "--", ...conflicted);
			if (!staged.ok) fail(`git add failed:\n${staged.err}`);
		}

		if (!(await rebaseInProgress())) break;
		const cont = await git("-c", "core.editor=true", "rebase", "--continue");
		if (cont.ok) continue;
		if ((await git("diff", "--name-only", "--diff-filter=U")).out !== "") continue;
		if (/nothing to commit|now empty|empty commit/i.test(`${cont.out}\n${cont.err}`)) {
			const head = (await git("log", "-1", "--format=%h %s", "REBASE_HEAD")).out;
			const skipped = await git("rebase", "--skip");
			if (!skipped.ok) fail(`git rebase --skip failed:\n${skipped.err}`);
			report.skipped.push(head);
			log(`skipped: ${head} (its change is already in the new upstream)`);
			continue;
		}
		fail(`git rebase --continue failed:\n${cont.err || cont.out}`);
	}

	if (await rebaseInProgress()) fail(`rebase still has conflicts after ${MAX_ROUNDS} rounds — resolve by hand`);
	const leftover = await git("diff", "--name-only", "--diff-filter=U");
	if (leftover.out !== "") fail(`unresolved conflicts remain: ${leftover.out}`);
	return report;
}
