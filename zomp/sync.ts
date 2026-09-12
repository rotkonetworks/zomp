#!/usr/bin/env bun
/**
 * Keep the zomp fork on top of upstream oh-my-pi.
 *
 *   bun zomp/sync.ts             fetch, rebase main onto upstream/main, regenerate patches
 *   bun zomp/sync.ts --no-fetch  rebase onto the already-fetched upstream/main
 *   bun zomp/sync.ts --resolve   resolve rebase conflicts through a model, then verify
 *   bun zomp/sync.ts --patches   regenerate + verify zomp/patches only
 *   bun zomp/sync.ts --check     typecheck the delta (runs on a bare CI runner)
 *   bun zomp/sync.ts --test      also run the zish/exec tests (needs the native addon)
 *
 * zomp's delta is a linear commit series on top of `upstream/main`, so the fork
 * ships in two equivalent forms:
 *
 *   git fetch upstream && git rebase upstream/main        # in this checkout
 *   git am zomp/patches/*.patch                           # on a vanilla oh-my-pi
 *
 * Every run re-verifies that the patch series applied to a pristine
 * `upstream/main` worktree reproduces this branch's tree hash exactly.
 * `--resolve` implies `--check`: a model-merged tree never ships untypechecked.
 */
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fail, git, IS_REPO } from "./git";
import { resolveRebaseConflicts } from "./resolve";

const PATCH_DIR = path.join(import.meta.dir, "patches");
const UPSTREAM = "upstream/main";
const UPSTREAM_URL = "https://github.com/can1357/oh-my-pi.git";
const BRANCH = "main";

const FLAGS: Record<string, true> = {
	"--no-fetch": true,
	"--patches": true,
	"--resolve": true,
	"--check": true,
	"--test": true,
};
const argv = process.argv.slice(2);
const unknown = argv.filter(arg => FLAGS[arg] !== true);
if (unknown.length > 0) {
	console.error(`unknown flag(s): ${unknown.join(", ")}`);
	process.exit(2);
}

if (!IS_REPO) fail("not a git checkout — run this from the zomp repository");
const identity = await git("config", "user.email");
if (identity.out === "") {
	fail("git has no user.email — rewriting commits needs one (`git config user.email you@example.com`)");
}

// ── Fetch + rebase ───────────────────────────────────────────────────────────

const previousHead = (await git("rev-parse", "HEAD")).out;

if (!argv.includes("--patches")) {
	if (!argv.includes("--no-fetch")) {
		if (!(await git("remote", "get-url", "upstream")).ok) {
			console.log(`adding upstream remote → ${UPSTREAM_URL}`);
			const added = await git("remote", "add", "upstream", UPSTREAM_URL);
			if (!added.ok) fail(`git remote add upstream failed:\n${added.err}`);
		}
		process.stdout.write("fetching upstream… ");
		const fetched = await git("fetch", "upstream", "--prune");
		if (!fetched.ok) {
			console.log("FAILED");
			fail(`git fetch upstream failed:\n${fetched.err}`);
		}
		console.log("ok");
	}

	const dirty = await git("status", "--porcelain", "--untracked-files=no");
	if (dirty.out !== "") fail(`working tree has uncommitted changes:\n${dirty.out}\ncommit or stash them first`);

	const ahead = (await git("rev-list", "--count", `${UPSTREAM}..${BRANCH}`)).out;
	const behind = (await git("rev-list", "--count", `${BRANCH}..${UPSTREAM}`)).out;
	process.stdout.write(`replaying ${ahead} zomp commit(s) onto ${behind} upstream commit(s)… `);

	const rebased = await git("rebase", UPSTREAM);
	if (!rebased.ok && argv.includes("--resolve")) {
		console.log("conflicts");
		const report = await resolveRebaseConflicts();
		for (const skipped of report.skipped) console.log(`  skipped: ${skipped} (already upstream)`);
	} else if (!rebased.ok) {
		console.log("CONFLICT");
		const conflicts = (await git("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
		console.error(
			[
				"",
				"✗ rebase stopped — either resolve by hand:",
				conflicts.length > 0 ? `  conflicted: ${conflicts.join(", ")}` : "",
				"  git add <files> && git rebase --continue",
				"",
				"  …or let the model do it: bun zomp/sync.ts --resolve --check",
				"  (then: bun zomp/sync.ts --patches)",
				"",
				"`git config rerere.enabled true` makes repeat resolutions automatic.",
			]
				.filter(Boolean)
				.join("\n"),
		);
		process.exit(1);
	} else {
		console.log("ok");
	}

	const newHead = (await git("rev-parse", "HEAD")).out;
	if (newHead !== previousHead) {
		const lockfiles = await git("diff", "--name-only", `${previousHead}..${newHead}`, "--", "bun.lock");
		if (lockfiles.out !== "") {
			console.log("lockfiles moved upstream — running bun install");
			const installed = await $`bun install`.nothrow();
			if (installed.exitCode !== 0) fail("bun install failed");
		}
		console.log(`main: ${previousHead.slice(0, 9)} → ${newHead.slice(0, 9)} (rewritten)`);
	}
}

// ── Patch series ─────────────────────────────────────────────────────────────

await fs.rm(PATCH_DIR, { recursive: true, force: true });
const formatted = await git(
	"format-patch",
	"--zero-commit",
	"--no-signature",
	"-U3",
	`${UPSTREAM}..${BRANCH}`,
	"-o",
	PATCH_DIR,
);
if (!formatted.ok) fail(`git format-patch failed:\n${formatted.err}`);

const patches = (await fs.readdir(PATCH_DIR))
	.filter(name => name.endsWith(".patch"))
	.sort()
	.map(name => path.join(PATCH_DIR, name));
if (patches.length === 0) fail("no patches generated — is main actually ahead of upstream/main?");
process.stdout.write(`${patches.length} patch(es) → zomp/patches … `);

// ── Verify: pristine upstream/main + `git am` reproduces this branch's tree ──

const expected = (await git("rev-parse", `${BRANCH}^{tree}`)).out;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zomp-verify-"));
const worktree = path.join(tmp, "tree");
let verification: string | null = null;
try {
	const added = await git("worktree", "add", "--detach", worktree, UPSTREAM);
	if (!added.ok) {
		console.log("SKIPPED");
		console.error(`  ⚠ could not create a verification worktree: ${added.err}`);
	} else {
		const applied = await $`git am ${patches}`.cwd(worktree).quiet().nothrow();
		const actual =
			applied.exitCode === 0
				? (await $`git rev-parse HEAD^{tree}`.cwd(worktree).quiet().nothrow()).stdout.toString().trim()
				: "";
		if (actual === expected) {
			console.log("verified");
		} else {
			console.log("FAILED");
			verification = `patch series does not reproduce ${BRANCH} (${
				actual === "" ? applied.stderr.toString().trim() : actual
			} ≠ ${expected})`;
		}
	}
} finally {
	await git("worktree", "remove", "--force", worktree);
	await fs.rm(tmp, { recursive: true, force: true });
}
if (verification !== null) fail(verification);

// ── Optional gates ───────────────────────────────────────────────────────────

const gates: Array<[string, string[]]> = [];
if (argv.includes("--check") || argv.includes("--resolve")) {
	gates.push(
		["coding-agent typecheck", ["bun", "--cwd=packages/coding-agent", "run", "check:types"]],
		["utils check", ["bun", "--cwd=packages/utils", "run", "check"]],
	);
}
if (argv.includes("--test")) {
	gates.push([
		"zish tests",
		[
			"bun",
			"test",
			"packages/coding-agent/test/zish-workers.test.ts",
			"packages/coding-agent/test/bash-executor.test.ts",
		],
	]);
}
for (const [label, command] of gates) {
	process.stdout.write(`${label}… `);
	const result = await $`${command}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		console.log("FAILED");
		console.error(result.stdout.toString() + result.stderr.toString());
		process.exit(1);
	}
	console.log("ok");
}

const summary = (await git("diff", "--shortstat", UPSTREAM, BRANCH)).out;
const tag = (await git("describe", "--tags", "--abbrev=0", UPSTREAM)).out;
console.log(`\n✓ ${BRANCH} = ${UPSTREAM}${tag === "" ? "" : ` (${tag})`} + ${patches.length} commit(s)`);
console.log(`  delta: ${summary.replace(/^\s*\d+ files? changed,?\s*/, "")}`);
console.log("  apply elsewhere: git am zomp/patches/*.patch");
console.log("  push (history was rewritten): git push --force-with-lease origin main");
