/**
 * Shared git plumbing for the zomp fork tooling.
 *
 * The repository root comes from the current working directory, so every
 * command in `zomp/` works from any subdirectory and from a linked worktree.
 */
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const top = await $`git rev-parse --show-toplevel`.quiet().nothrow();
export const IS_REPO = top.exitCode === 0;
export const ROOT = IS_REPO ? top.stdout.toString().trim() : process.cwd();

/** True while `git rebase` is mid-flight, on either backend. */
export async function rebaseInProgress(): Promise<boolean> {
	for (const state of ["rebase-merge", "rebase-apply"]) {
		const dir = await git("rev-parse", "--git-path", state);
		if (!dir.ok) continue;
		const stats = await fs.stat(path.resolve(ROOT, dir.out)).catch(() => null);
		if (stats?.isDirectory()) return true;
	}
	return false;
}

export interface GitResult {
	ok: boolean;
	out: string;
	err: string;
}

export async function git(...args: string[]): Promise<GitResult> {
	const result = await $`git ${args}`.cwd(ROOT === "" ? process.cwd() : ROOT).quiet().nothrow();
	return {
		ok: result.exitCode === 0,
		out: result.stdout.toString().trim(),
		err: result.stderr.toString().trim(),
	};
}

export function fail(message: string): never {
	console.error(`\n✗ ${message}`);
	process.exit(1);
}
