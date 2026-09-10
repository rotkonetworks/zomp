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
import { isCmdShell, isExecutable, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";
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
	// Preserve the caller's logical cwd string. Brush uses this value to update `PWD` and its
	// internal working directory, so realpathing here collapses symlinks before the shell sees them.
	return cwd;
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
		sourceOutlineLevel: group.sourceOutlineLevel === "default" ? undefined : group.sourceOutlineLevel,
		legacyFilters: group.legacyFilters,
	};
}

function shellBasename(shell: string): string {
	return shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isBashShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash");
}

const UNSUPPORTED_UNQUOTED_CD_CHARS = "\\$`;&|<>(){}*?[]!#\"'";

function hasUnsupportedUnquotedCdSyntax(value: string): boolean {
	for (const char of value) {
		if (/\s/.test(char) || UNSUPPORTED_UNQUOTED_CD_CHARS.includes(char)) return true;
	}
	return false;
}

export function isPersistentShellCdCommand(command: string): boolean {
	if (/[\r\n]/.test(command)) return false;

	const trimmed = command.trim();
	if (trimmed === "cd") return true;
	if (!trimmed.startsWith("cd") || !/[ \t]/.test(trimmed[2] ?? "")) return false;

	let rest = trimmed.slice(2).trim();
	if (rest === "" || rest === "--") return true;

	let hasOptionTerminator = false;
	if (/^--[ \t]/.test(rest)) {
		hasOptionTerminator = true;
		rest = rest.slice(2).trimStart();
	}
	if (rest === "") return true;

	const quote = rest[0];
	let target: string;
	let quoted = false;
	if (quote === `"` || quote === "'") {
		if (rest.length < 2 || rest[rest.length - 1] !== quote) return false;
		target = rest.slice(1, -1);
		if (target.includes(quote)) return false;
		if (quote === `"` && /[\\$`\r\n]/.test(target)) return false;
		quoted = true;
	} else {
		if (hasUnsupportedUnquotedCdSyntax(rest)) return false;
		target = rest;
	}

	if (target === "") return false;
	if (/^[+-]\d+$/.test(target)) return false;
	if (!hasOptionTerminator && target.startsWith("-") && target !== "-") return false;
	if (!quoted && target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return false;
	return true;
}

function needsInteractiveShellArg(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("zsh") || basename.includes("fish");
}

function supportsAutoUserShell(shell: string): boolean {
	const basename = shellBasename(shell);
	return basename.includes("bash") || basename.includes("zsh") || basename.includes("fish");
}

function hasInteractiveShellArg(args: string[]): boolean {
	return args.some(arg => arg === "--interactive" || /^-[^-]*i/.test(arg));
}

function ensureInteractiveShellArgs(shell: string, args: string[]): string[] {
	if (!needsInteractiveShellArg(shell)) return args;

	// fish sources the same config files (config.fish + conf.d) for interactive
	// shells as for login shells, so the inherited `-l` adds nothing — it only
	// marks the shell as login, firing `status is-login` blocks in user config
	// (agent/keychain setup, path mutation) on every `!` command. zsh keeps `-l`
	// because .zprofile is login-only. Args originate from procmgr's
	// getShellArgs(), so login only ever appears as a standalone `-l`/`--login`.
	const effectiveArgs = shellBasename(shell).includes("fish")
		? args.filter(arg => arg !== "-l" && arg !== "--login")
		: args;

	if (hasInteractiveShellArg(effectiveArgs)) return effectiveArgs;

	const commandIndex = effectiveArgs.findIndex(arg => arg === "-c" || arg === "--command");
	if (commandIndex !== -1) {
		return [...effectiveArgs.slice(0, commandIndex), "-i", ...effectiveArgs.slice(commandIndex)];
	}

	const compactCommandIndex = effectiveArgs.findIndex(arg => /^-[^-]*c[^-]*$/.test(arg));
	if (compactCommandIndex !== -1) {
		return effectiveArgs.map((arg, index) => (index === compactCommandIndex ? arg.replace("c", "ic") : arg));
	}

	return [...effectiveArgs, "-i"];
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUserShellCommand(shell: string, args: string[], command: string): string {
	return [shell, ...ensureInteractiveShellArgs(shell, args), command].map(quoteShellArg).join(" ");
}

function resolveUserShellConfig(settings: Settings, baseConfig: ShellConfig): ShellConfig {
	const customShellPath = cfgShellPath.get(settings);
	const envShell = Bun.env.SHELL;
	if (customShellPath || process.platform === "win32" || !envShell || envShell === baseConfig.shell) {
		return baseConfig;
	}
	if (!supportsAutoUserShell(envShell) || !isExecutable(envShell)) {
		return baseConfig;
	}

	return {
		...baseConfig,
		shell: envShell,
		env: {
			...baseConfig.env,
			SHELL: envShell,
		},
	};
}

/**
 * Env for the user-shell PTY path: keep the non-interactive guards (pagers,
 * editors, credential prompts) but restore color — the PTY makes stdout a
 * TTY, so TERM/NO_COLOR/CI are all that keep tools monochrome.
 */
function buildUserShellPtyEnv(
	shellEnv: Record<string, string>,
	commandEnv: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = { ...shellEnv, ...commandEnv, TERM: "xterm-256color" };
	delete env.NO_COLOR;
	delete env.CI;
	return env;
}

/**
 * Run a user-shell command on a headless PTY. Interactive zsh/fish startup
 * (zle, job control, gitstatus) requires a real TTY — piping through the
 * embedded shell produces `can't change option: zle` noise and colorless
 * output. Raw bytes stream to `pty.onChunk` for virtual-terminal rendering;
 * the sink keeps the sanitized capture for the transcript and the model.
 */
async function executeUserShellPty(run: {
	shell: string;
	args: string[];
	command: string;
	cwd: string | undefined;
	env: Record<string, string>;
	pty: BashPtyOptions;
	timeoutMs: number | undefined;
	signal: AbortSignal | undefined;
	sink: OutputSink;
	graphics: TerminalGraphicsDecoder;
	dump: (notice?: string) => Promise<OutputSummary & { images?: ImageContent[] }>;
}): Promise<BashResult> {
	const session = new PtySession();
	const result = await session.startArgv(
		{
			application: run.shell,
			args: [...ensureInteractiveShellArgs(run.shell, run.args), run.command],
			cwd: run.cwd,
			env: run.env,
			timeoutMs: run.timeoutMs,
			signal: run.signal,
			cols: run.pty.cols,
			rows: run.pty.rows,
		},
		(err, chunk) => {
			if (err || !chunk) return;
			run.pty.onChunk(chunk);
			// Preserve raw bytes for the terminal display, but extract graphics
			// before the transcript sink sanitizes or truncates the clean text.
			const clean = run.graphics.push(chunk);
			if (clean) run.sink.push(clean.replace(/\r\n?/gu, "\n"));
		},
	);
	if (result.timedOut) {
		return {
			exitCode: undefined,
			cancelled: true,
			timedOut: true,
			...(await run.dump(
				run.timeoutMs !== undefined
					? `Command timed out after ${Math.round(run.timeoutMs / 1000)} seconds`
					: "Command timed out",
			)),
		};
	}
	if (result.cancelled) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await run.dump("Command cancelled")),
		};
	}
	return {
		exitCode: result.exitCode,
		cancelled: false,
		...(await run.dump()),
	};
}

/**
 * Run one command through an external shell binary (`<shell> <args...> <command>`),
 * streaming merged stdout/stderr into the shared sink. The command text is
 * handed to the real shell verbatim, so its own syntax — zish feats, zsh/fish
 * builtins — works without the embedded parser having to understand it.
 *
 * The child leads its own process group (`detached`), so a timeout or abort
 * kills the whole tree instead of orphaning a `para`/`&` fan-out.
 */
async function executeExternalShell(run: {
	shell: string;
	args: string[];
	command: string;
	cwd: string | undefined;
	env: Record<string, string>;
	timeoutMs: number | undefined;
	signal: AbortSignal | undefined;
	sink: OutputSink;
	enqueueChunk: (chunk: string) => void;
	dump: (notice?: string) => Promise<OutputSummary & { images?: ImageContent[] }>;
}): Promise<BashResult> {
	const child = spawn(run.shell, [...run.args, run.command], {
		cwd: run.cwd,
		env: run.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const killTree = (signal: NodeJS.Signals) => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};

	let killReason: "cancelled" | "timeout" | undefined;
	const kill = (reason: "cancelled" | "timeout") => {
		if (killReason !== undefined) return;
		killReason = reason;
		killTree("SIGKILL");
	};
	const onAbort = () => kill("cancelled");
	if (run.signal?.aborted) kill("cancelled");
	else run.signal?.addEventListener("abort", onAbort, { once: true });

	const timer = run.timeoutMs === undefined ? undefined : setTimeout(() => kill("timeout"), run.timeoutMs);

	// stdout and stderr are separate pipes; both feed the one sink so the model
	// sees a single ordered stream, matching the native backend's merged capture.
	const decoders = [new TextDecoder(), new TextDecoder()];
	let streamIndex = 0;
	for (const stream of [child.stdout, child.stderr]) {
		const decoder = decoders[streamIndex++];
		stream?.on("data", (chunk: Buffer) => run.enqueueChunk(decoder.decode(chunk, { stream: true })));
	}

	const exitCode = await new Promise<number | undefined>(resolve => {
		child.on("error", err => {
			run.enqueueChunk(`${err.message}\n`);
			resolve(undefined);
		});
		child.on("close", code => resolve(code ?? undefined));
	});
	clearTimeout(timer);
	run.signal?.removeEventListener("abort", onAbort);
	// Flush a trailing multi-byte sequence left buffered by the streaming decoders.
	for (const decoder of decoders) run.enqueueChunk(decoder.decode());

	if (killReason === "timeout") {
		return {
			exitCode: undefined,
			cancelled: true,
			timedOut: true,
			...(await run.dump(
				run.timeoutMs === undefined
					? "Command timed out"
					: `Command timed out after ${Math.round(run.timeoutMs / 1000)} seconds`,
			)),
		};
	}
	if (killReason === "cancelled") {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await run.dump("Command cancelled")),
		};
	}
	return {
		exitCode,
		cancelled: false,
		...(await run.dump()),
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const baseShellConfig = settings.getShellConfig();
	const shellConfig =
		options?.useUserShell === true ? resolveUserShellConfig(settings, baseShellConfig) : baseShellConfig;
	const { shell, args, env: shellEnv, prefix } = shellConfig;
	const bashShell = isBashShell(shell);
	// `!` hotkey commands on zsh/fish run in a real PTY: interactive shell
	// startup (zle, job control, gitstatus) needs a TTY, and tools only emit
	// color when stdout is one. bash keeps the snapshot + embedded-shell path;
	// `cd` keeps the persistent shell so the session cwd can follow it.
	const ptyRequest = options?.pty;
	const usePty =
		ptyRequest !== undefined &&
		options?.useUserShell === true &&
		!bashShell &&
		supportsAutoUserShell(shell) &&
		$env.PI_NO_PTY !== "1" &&
		!isPersistentShellCdCommand(command);
	const snapshotPath = bashShell ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(cfgShellMinimizer.get(settings));

	const commandCwd = resolveShellCwd(options?.cwd);
	const virtualCwd = commandCwd !== undefined && URL_CWD_RE.test(commandCwd);
	if (virtualCwd && (usePty || !options?.filesystem)) {
		throw new Error(`Working directory ${commandCwd} needs the embedded shell with an injected filesystem`);
	}
	// One deadline rule for every backend. A positive caller timeout is the
	// deadline; `0` disables it; unset defaults to 300s. `nativeOwnsTimeout`
	// marks the native shell as the enforcer — the JS timer is then only a
	// backstop that must not race the native teardown.
	const requestedTimeoutMs = options?.timeout;
	const deadlineTimeoutMs = requestedTimeoutMs === 0 ? undefined : Math.max(1_000, requestedTimeoutMs ?? 300_000);
	const nativeTimeoutMs = requestedTimeoutMs !== undefined && requestedTimeoutMs > 0 ? requestedTimeoutMs : undefined;
	const nativeOwnsTimeout = nativeTimeoutMs !== undefined;
	// Fold the repo's direnv/devenv env into the command + env so devenv tools
	// land on PATH; the caller's explicit `env` still wins. Thread the caller's
	// signal + timeout so an aborted / short-timeout call can't hang on a cold
	// `.envrc` load before the abort listener is installed. The helper applies
	// the configured shell `prefix` after any `unset -v` it prepends. A URL cwd
	// has no `.envrc` on the host.
	const preflight = await applyDirenvPreflight(command, commandCwd ?? process.cwd(), {
		callerEnv: options?.env,
		signal: options?.signal,
		timeoutMs: cfgBashDirenvLoadTimeoutMs.get(settings),
		callerTimeoutMs: options?.timeout,
		direnvSetting: virtualCwd ? "off" : cfgBashDirenv.get(settings),
		commandPrefix: prefix,
	});
	const commandEnv = buildNonInteractiveEnv(preflight.env);
	const runCdInPersistentShell = options?.useUserShell === true && !prefix && isPersistentShellCdCommand(command);
	// Never wrap in cmd.exe: it is only the Windows no-bash fallback for spawn
	// paths, and the embedded brush shell runs the POSIX line better directly.
	const finalCommand =
		options?.useUserShell === true && !bashShell && !isCmdShell(shell) && !runCdInPersistentShell
			? buildUserShellCommand(shell, args, preflight.command)
			: preflight.command;

	// Create output sink for truncation and artifact handling
	const graphics = new TerminalGraphicsDecoder();
	const sink = new OutputSink({
		onChunk: usePty ? undefined : options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: !usePty && options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	let graphicsFinished = false;
	let decodedImages: ImageContent[] = [];
	const enqueueChunk = (chunk: string) => {
		if (!acceptingChunks) return;
		const clean = graphics.push(chunk);
		if (clean) sink.push(clean);
	};
	const dump = async (notice?: string): Promise<OutputSummary & { images?: ImageContent[] }> => {
		if (!graphicsFinished) {
			graphicsFinished = true;
			const tail = graphics.finish();
			if (tail) sink.push(tail);
			decodedImages = await graphics.images();
		}
		return {
			...(await sink.dump(notice)),
			...(decodedImages.length > 0 ? { images: decodedImages } : {}),
		};
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await dump("Command cancelled")),
		};
	}

	if (usePty && ptyRequest) {
		try {
			return await executeUserShellPty({
				shell,
				args,
				command: preflight.command,
				cwd: commandCwd,
				env: buildUserShellPtyEnv(shellEnv, commandEnv),
				pty: ptyRequest,
				timeoutMs: deadlineTimeoutMs,
				signal: options?.signal,
				sink,
				graphics,
				dump,
			});
		} finally {
			await sink.dispose();
		}
	}

	// A shell the embedded bash parser cannot emulate (zish, zsh, fish, dash)
	// runs as a real subprocess with the whole command text handed to it. Three
	// cases stay on the native path:
	//   - an explicit `shellPath` is required, so the default `$SHELL`-derived
	//     shell keeps the native session (state, minimizer, in-process builtins);
	//     a custom *bash* path does too, since the embedded shell already is bash.
	//   - `!` shortcut commands keep the user-shell path, which owns interactive
	//     startup (zshrc/fish config, PTY) that a bare `-c` spawn would skip.
	//   - a bare `cd` keeps the persistent shell, so `OLDPWD` and the session
	//     cwd stay exact instead of being re-derived.
	const configuredShellPath = settings.get("shellPath");
	if (
		configuredShellPath !== undefined &&
		configuredShellPath === shell &&
		process.platform !== "win32" &&
		!bashShell &&
		!isCmdShell(shell) &&
		options?.useUserShell !== true &&
		!isPersistentShellCdCommand(command)
	) {
		try {
			return await executeExternalShell({
				shell,
				args,
