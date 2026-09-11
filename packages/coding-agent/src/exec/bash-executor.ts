/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import { spawn } from "node:child_process";
import { ExponentialYield } from "@oh-my-pi/pi-agent-core/utils/yield";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type MinimizerOptions,
	PtySession,
	Shell,
	type ShellFilesystem,
	type ShellRunResult,
} from "@oh-my-pi/pi-natives";
import { $env } from "@oh-my-pi/pi-utils/env";
import { isCmdShell, isExecutable, isZishShell, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import { Settings } from "../config/settings";
import { type OutputArtifactError, OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { loadDirenvEnv } from "./direnv";
import { buildNonInteractiveEnv } from "./non-interactive-env";

import {
	cfgBashDirenv,
	cfgBashDirenvLoadTimeoutMs,
	cfgShellMinimizer,
	cfgShellPath,
	type ShellMinimizerSettings,
} from "./settings";

export interface BashExecutorOptions {
	cwd?: string;
	/** Milliseconds before aborting the command; 0 disables the executor deadline. */
	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Run through the configured user shell instead of brush parsing directly. */
	useUserShell?: boolean;
	/** Run supported user shells (zsh/fish) on a headless PTY; requires `useUserShell`. */
	pty?: BashPtyOptions;
	/**
	 * Filesystem for `scheme://` paths in this run of the embedded shell (a URL
	 * `cwd` included). External shells and processes never see it.
	 */
	filesystem?: ShellFilesystem;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * Invoked when the native minimizer rewrote the command's output, giving
	 * the caller a chance to persist the lossless original capture (typically
	 * via the session's `ArtifactManager`). The returned id is spliced into
	 * the sink output as `artifact://<id>` so the agent can retrieve the raw
	 * bytes. Return `undefined` to skip the footer.
	 */
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

/** Viewport + raw-output callback enabling the user-shell PTY path (`!` hotkey). */
export interface BashPtyOptions {
	cols: number;
	rows: number;
	/** Receives raw PTY bytes (ANSI intact) for virtual-terminal rendering. */
	onChunk: (chunk: string) => void;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	/** True when the command was killed by its timeout deadline (not a user abort). */
	timedOut?: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	artifactError?: OutputArtifactError;
	workingDir?: string;
	/** Terminal graphics extracted from raw stdout before sanitization or truncation. */
	images?: ImageContent[];
}

/** POSIX-safe variable name — gates which direnv unsets we inject into the
 *  command line, so a hostile `.envrc` can't smuggle shell syntax through
 *  `unset`. `.envrc` never produces non-identifier names in practice. */
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `scheme://` working directory: it exists only in the embedded shell's injected filesystem. */
const URL_CWD_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface DirenvPreflightOptions {
	/** Caller-supplied env overlay; these values win over direnv-provided ones. */
	callerEnv?: Record<string, string>;
	signal?: AbortSignal;
	/** Full direnv-load budget (`bash.direnvLoadTimeoutMs`). A positive
	 *  `callerTimeoutMs` clamps the effective load below this; `0`/undefined
	 *  leaves the full budget. */
	timeoutMs?: number;
	/** The caller's command deadline (ms). A positive value clamps the direnv
	 *  load so a cold `.envrc` can't outlast a short-timeout command; `0` or
	 *  undefined means "no caller clamp" — the load keeps its full `timeoutMs`
	 *  budget (a disabled command deadline is NOT a 0 ms load). Centralizing the
	 *  clamp here keeps every backend (executeBash, ACP terminal, PTY) on one
	 *  contract instead of each re-deriving it. */
	callerTimeoutMs?: number;
	/** `bash.direnv` setting — `"off"` skips the load entirely. */
	direnvSetting: "auto" | "off";
	/** Shell wrapper prefix (profiler/strace) to place *after* the unset prefix,
	 *  matching `executeBash`'s ordering. Backends that apply their own shell
	 *  wrapping (ACP `wrapShellLineForClientTerminal`) omit this. */
	commandPrefix?: string | undefined;
}

/**
 * Load the repo's direnv/devenv env and fold it into a `(command, env)` pair so
 * every bash backend (one-shot `executeBash`, ACP client terminal, PTY) exposes
 * the same devenv tools. Encapsulates: load the diff, merge `set` under the
 * caller's overlay (caller wins), and prepend a regex-gated `unset -v` for
 * variables the `.envrc` removes (skipping any the caller re-supplied).
 *
 * Returns the possibly-prefixed command plus the merged env, or the inputs
 * unchanged (`env` = `callerEnv`) when direnv is off, absent, or has no `.envrc`.
 * Pure transform: does NOT layer non-interactive env defaults — that stays the
 * caller's job (so interactive PTY/ACP paths keep their own env shape).
 */
export async function applyDirenvPreflight(
	command: string,
	cwd: string,
	opts: DirenvPreflightOptions,
): Promise<{ command: string; env: Record<string, string> | undefined }> {
	const withPrefix = (line: string): string => (opts.commandPrefix ? `${opts.commandPrefix} ${line}` : line);
	// A positive caller deadline clamps the direnv load below its full budget so
	// a cold `.envrc` can't outlast a short-timeout command; `0`/undefined means
	// "no caller clamp" (a disabled command deadline is not a 0 ms load). Every
	// backend routes through here, so the clamp lives in one place.
	const loadTimeoutMs =
		opts.callerTimeoutMs !== undefined && opts.callerTimeoutMs > 0
			? Math.min(opts.timeoutMs ?? opts.callerTimeoutMs, opts.callerTimeoutMs)
			: opts.timeoutMs;
	const direnvDiff =
		opts.direnvSetting === "off" ? null : await loadDirenvEnv(cwd, { timeoutMs: loadTimeoutMs, signal: opts.signal });
	if (!direnvDiff) {
		return { command: withPrefix(command), env: opts.callerEnv };
	}
	// The caller's explicit env still wins over direnv-provided values.
	const mergedEnv = { ...direnvDiff.set, ...opts.callerEnv };
	// direnv can also *remove* inherited variables (a `.envrc` doing
	// `unset AWS_PROFILE`). An env overlay can only add/override, so prepend a
	// real `unset` for those — unless the caller re-supplied the same var
	// explicitly, in which case the caller wins.
	const direnvUnsets = direnvDiff.unset.filter(
		name => !(opts.callerEnv && name in opts.callerEnv) && SAFE_ENV_NAME.test(name),
	);
	const unsetPrefix = direnvUnsets.length > 0 ? `unset -v ${direnvUnsets.join(" ")}; ` : "";
	return { command: `${unsetPrefix}${withPrefix(command)}`, env: mergedEnv };
}

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const shellSessionQuarantines = new Map<string, Promise<unknown>>();
/** Session keys with a command currently in flight on the persistent Shell. */
const shellSessionsInUse = new Set<string>();

/**
 * Shells retained past their turn because a background (`nohup`/`&`) job is
 * still running. A per-call `:async:` Shell is normally dropped at teardown,
 * which SIGKILLs its children via kill-on-drop. Keeping the reference alive lets
 * the process survive across turns; the Shell is dropped once its last
 * background job exits (reaped by the poll loop below). Children stay
 * kill-on-drop, so they still die when the harness tears the Shell down on exit.
 */
const retainedShells = new Set<Shell>();
const RETAIN_REAP_INTERVAL_MS = 5_000;
// Native cancellation may spend two seconds unwinding the shell before its
// N-API chunk bridge drains. The JS watchdog must not race that teardown.
const NATIVE_TIMEOUT_FALLBACK_GRACE_MS = 5_000;
// Upper bound on how long a quarantined session's cleanup may pend before the
// record is force-released. Native cancellation normally settles `runPromise`
// in ~2s, but a wedged native run (e.g. a grandchild holding the stdout pipe)
// could otherwise leave the run promise pending for the life of the process,
// leaking the session key in `brokenShellSessions`/`shellSessionQuarantines`
// (#10308). The backing timer is unref'd so it never keeps the process alive.
const QUARANTINE_CLEANUP_TIMEOUT_MS = 30_000;

async function retainShellWithLiveBackgroundJobs(shell: Shell): Promise<void> {
	let live: number;
	try {
		live = await shell.liveBackgroundJobCount();
	} catch {
		return;
	}
	if (live <= 0) return;
	retainedShells.add(shell);
	const interval = setInterval(() => {
		void shell
			.liveBackgroundJobCount()
			.then(remaining => {
				if (remaining > 0) return;
				clearInterval(interval);
				retainedShells.delete(shell);
			})
			.catch(() => {
				clearInterval(interval);
				retainedShells.delete(shell);
			});
	}, RETAIN_REAP_INTERVAL_MS);
	interval.unref?.();
}

/**
 * A timer promise that resolves after {@link QUARANTINE_CLEANUP_TIMEOUT_MS}.
 * Used to bound quarantine cleanup; the timer is unref'd so it never keeps the
 * process alive on its own.
 */
function quarantineCleanupDeadline(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, QUARANTINE_CLEANUP_TIMEOUT_MS);
	timer.unref?.();
	return promise;
}

function quarantineShellSession(
	sessionKey: string,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const settled = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	// Defensive bound: a never-settling `runPromise` must not pin the quarantine
	// record for the life of the process (#10308).
	const cleanup = Promise.race([settled, quarantineCleanupDeadline()]);
	shellSessionQuarantines.set(sessionKey, cleanup);
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

function resolveShellCwd(cwd: string | undefined): string | undefined {
	// Preserve the caller's logical cwd string. Brush
