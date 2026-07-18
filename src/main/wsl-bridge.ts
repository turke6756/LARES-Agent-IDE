// RULE (Node→wsl.exe argv boundary): wsl.exe strips/mangles double quotes when
// it reconstructs the command line it hands to the Linux side. Any NEW or
// CHANGED `bash -lc` script in this file that contains a `"` MUST be wrapped in
// `wslBashEnvelope` (it base64s the whole script so only [A-Za-z0-9+/=], spaces
// and `|` cross the boundary — no quote class to mangle), and every interpolated
// session name / workspace path / file path MUST go through `shQuote` first
// (single-quote-only is not enough — a literal `'` in a path still corrupts a
// hand-written `'${path}'`). Pre-existing single-quote-only callers are immune
// to the quote-strip symptom and are intentionally left untouched.
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import type { WslStatus, WslDistroStatus } from '../shared/types';

const execFileAsync = promisify(execFile);

export function wslSpawn(command: string): ChildProcess {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn('wsl.exe', ['bash', '-lc', command], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export interface WslExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WslExecOptions {
  timeout?: number;
  maxBuffer?: number;
  input?: string;
  throwOnError?: boolean;
  trimOutput?: boolean;
}

function wslEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function decodeWslListOutput(value: string | Buffer | undefined): string {
  if (!value) return '';
  if (Buffer.isBuffer(value)) {
    const hasNullPadding = value.includes(0);
    return value
      .toString(hasNullPadding ? 'utf16le' : 'utf8')
      .replace(/\u0000/g, '')
      .replace(/^\uFEFF/, '');
  }
  return value.replace(/\u0000/g, '').replace(/^\uFEFF/, '');
}

function parseWslDistroRow(line: string): WslDistroStatus | null {
  const trimmed = line.trim();
  if (!trimmed || /^NAME\s+STATE\s+VERSION$/i.test(trimmed)) return null;

  const isDefault = trimmed.startsWith('*');
  const row = isDefault ? trimmed.slice(1).trim() : trimmed;
  const columns = row.split(/\s{2,}/).filter(Boolean);
  if (columns.length >= 2) {
    return {
      name: columns[0],
      state: columns[1],
      version: columns[2],
      default: isDefault,
    };
  }

  const fallback = row.match(/^(.+?)\s+(Running|Stopped|Installing|Converting|Uninstalling)(?:\s+(\d+))?$/i);
  if (!fallback) return null;
  return {
    name: fallback[1].trim(),
    state: fallback[2],
    version: fallback[3],
    default: isDefault,
  };
}

function parseWslListVerbose(output: string, error?: string): WslStatus {
  const normalized = output.replace(/\r/g, '\n');
  if (/no installed distributions/i.test(normalized)) {
    return { state: 'no-distro', distros: [], error };
  }

  const distros = normalized
    .split('\n')
    .map(parseWslDistroRow)
    .filter((distro): distro is WslDistroStatus => distro !== null);
  if (distros.length === 0) {
    return { state: error ? 'unavailable' : 'unknown', distros: [], error };
  }

  const defaultDistro = distros.find((distro) => distro.default)?.name;
  const hasRunning = distros.some((distro) => distro.state.toLowerCase() === 'running');
  const hasStopped = distros.some((distro) => distro.state.toLowerCase() === 'stopped');

  return {
    state: hasRunning ? 'running' : hasStopped ? 'stopped' : 'unknown',
    defaultDistro,
    distros,
    error,
  };
}

// On a Windows-only machine every `wsl.exe` invocation can trigger Windows'
// "install WSL" flow (windowsHide:true hides the probe console but NOT that
// install UI). getPassiveWslStatus is called from the health-check on startup
// and on every workspace select / Sidebar / DirectoryTree mount, so an
// uncached negative result means a popup storm. Cache the first "WSL is absent"
// outcome for the process lifetime and never re-invoke wsl.exe again once we
// know it isn't there. Present-but-transient states ('unknown', 'stopped',
// 'running') are NOT cached so a later start of WSL is still observed.
let cachedAbsentWslStatus: WslStatus | null = null;

function isAbsentWslState(state: WslStatus['state']): boolean {
  return state === 'no-distro' || state === 'unavailable';
}

export async function getPassiveWslStatus(): Promise<WslStatus> {
  if (cachedAbsentWslStatus) return cachedAbsentWslStatus;
  const status = await probePassiveWslStatus();
  if (isAbsentWslState(status.state)) {
    cachedAbsentWslStatus = status;
  }
  return status;
}

async function probePassiveWslStatus(): Promise<WslStatus> {
  try {
    const { stdout, stderr } = await execFileAsync('wsl.exe', ['-l', '-v'], {
      encoding: 'buffer',
      env: wslEnv(),
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const output = decodeWslListOutput(stdout);
    const error = decodeWslListOutput(stderr).trim() || undefined;
    return parseWslListVerbose(output, error);
  } catch (err: any) {
    const output = `${decodeWslListOutput(err?.stdout)}\n${decodeWslListOutput(err?.stderr)}`;
    if (/no installed distributions/i.test(output)) {
      return { state: 'no-distro', distros: [] };
    }
    return {
      state: 'unavailable',
      distros: [],
      error: decodeWslListOutput(err?.stderr).trim() || err?.message || 'WSL is unavailable',
    };
  }
}

function normalizeOutput(value: string | Buffer | undefined, trimOutput: boolean): string {
  const text = value?.toString() || '';
  return trimOutput ? text.trim() : text;
}

function makeWslExecError(command: string, result: WslExecResult): Error {
  const detail = result.stderr || `exit code ${result.exitCode}`;
  const err = new Error(`wsl.exe command failed: ${detail}`);
  Object.assign(err, { command, ...result });
  return err;
}

function wslExecWithInput(command: string, options: WslExecOptions, trimOutput: boolean): Promise<WslExecResult> {
  return new Promise((resolve) => {
    const timeout = options.timeout ?? 10000;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const proc = spawn('wsl.exe', ['bash', '-lc', command], {
      env: wslEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exceededBuffer = false;

    const finish = (exitCode: number): void => {
      const timeoutMessage = timedOut ? `Command timed out after ${timeout}ms` : '';
      const bufferMessage = exceededBuffer ? `Command exceeded maxBuffer ${maxBuffer}` : '';
      resolve({
        stdout: normalizeOutput(stdout, trimOutput),
        stderr: normalizeOutput(stderr || timeoutMessage || bufferMessage, trimOutput),
        exitCode,
      });
    };

    const maybeKillForBuffer = (): void => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxBuffer) return;
      exceededBuffer = true;
      try { proc.kill(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* ignore */ }
    }, timeout);

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      maybeKillForBuffer();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      maybeKillForBuffer();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      stderr = stderr || err.message;
      finish(1);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish(typeof code === 'number' ? code : 1);
    });

    proc.stdin?.end(options.input);
  });
}

export async function wslExecCommand(command: string, options: WslExecOptions = {}): Promise<WslExecResult> {
  const trimOutput = options.trimOutput ?? true;
  try {
    if (options.input !== undefined) {
      const result = await wslExecWithInput(command, options, trimOutput);
      if (options.throwOnError && result.exitCode !== 0) {
        throw makeWslExecError(command, result);
      }
      return result;
    }

    const { stdout, stderr } = await execFileAsync('wsl.exe', ['bash', '-lc', command], {
      encoding: 'utf-8',
      env: wslEnv(),
      timeout: options.timeout ?? 10000,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
    });
    return {
      stdout: normalizeOutput(stdout, trimOutput),
      stderr: normalizeOutput(stderr, trimOutput),
      exitCode: 0,
    };
  } catch (err: any) {
    const result: WslExecResult = {
      stdout: normalizeOutput(err.stdout, trimOutput),
      stderr: normalizeOutput(err.stderr, trimOutput) || err.message || 'WSL command failed',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
    if (options.throwOnError) {
      throw makeWslExecError(command, result);
    }
    return result;
  }
}

export async function wslExec(command: string, timeout = 10000): Promise<WslExecResult> {
  return wslExecCommand(command, { timeout });
}

export async function isWslAvailable(): Promise<boolean> {
  try {
    const result = await wslExec('echo ok');
    return result.stdout === 'ok';
  } catch {
    return false;
  }
}

export async function isTmuxAvailable(): Promise<boolean> {
  const result = await wslExec('tmux -V');
  return result.exitCode === 0;
}

export async function isClaudeAvailableInWsl(): Promise<boolean> {
  const result = await wslExec('which claude');
  return result.exitCode === 0;
}

let inotifywaitAvailable: boolean | null = null;
export async function isInotifywaitAvailable(): Promise<boolean> {
  if (inotifywaitAvailable !== null) return inotifywaitAvailable;
  const result = await wslExec('which inotifywait');
  inotifywaitAvailable = result.exitCode === 0;
  return inotifywaitAvailable;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
}

export async function tmuxListSessions(): Promise<TmuxSession[]> {
  const result = await wslExec("tmux ls -F '#{session_name}:#{session_attached}' 2>/dev/null || true");
  if (!result.stdout) return [];
  return result.stdout.split('\n').filter(Boolean).map(line => {
    const [name, attached] = line.split(':');
    return { name, attached: attached === '1' };
  });
}

/** Scrollback lines tmux retains per pane. tmux's built-in default is 2000,
 *  which silently drops a long-running agent's output once it scrolls past
 *  that — so a user who detaches from a `tmux attach` and returns later finds
 *  the history truncated to the last 2000 lines (everything produced while
 *  away is gone). We set a large limit so re-attaching a supervisor (or any
 *  agent) shows the full session, not a lazy-loaded tail. ~100k lines costs
 *  at most tens of MB per pane and is allocated lazily as lines are produced. */
export const TMUX_HISTORY_LIMIT = 100000;

/** CHOKE POINT for the Node→wsl.exe argv boundary. wsl.exe strips/mangles
 *  double quotes when it reconstructs the command line, so ANY bash script
 *  containing `"` (incl. `"$(...)"`, `"$VAR"`) corrupts when passed as
 *  `wsl.exe bash -lc <script>`: inner $-expansion is lost, the decoded command
 *  word-splits, and only the first token runs. Base64 the whole script and
 *  decode it through a pipe to bash — the string handed to wsl.exe then
 *  contains ONLY [A-Za-z0-9+/=], spaces and `|`: no quote class to mangle.
 *  Every inner quote is parsed by a Linux-side bash the quotes never crossed a
 *  boundary to reach. `printf %s` (not echo) avoids echo flag/newline
 *  ambiguity; base64 has no `%`.
 *
 *  RULE (scoped to NEW or CHANGED WSL bash scripts): a script that contains a
 *  `"` MUST be wrapped here, and any session name / workspace path / file path
 *  interpolated into it MUST go through shQuote first (single-quote-only is not
 *  enough — a literal `'` in a path still corrupts a hand-written '${path}').
 *  Pre-existing single-quote-only callers are immune to the quote-strip symptom
 *  and are intentionally left untouched by this parity fix. */
export function wslBashEnvelope(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s ${b64} | base64 -d | bash`;
}

export function buildTmuxNewSessionCommand(name: string, workDir: string, command: string): string {
  // L-A / BUG-22: base64-envelope the command body so the outer shell layer
  // never needs to escape single quotes, dollar signs, backticks, newlines,
  // or embedded `$(...)` substitutions intended for the inner bash. The
  // base64 alphabet (A-Za-z0-9+/=) contains no shell-special characters, so
  // the outer wsl-bash sees an opaque payload — no quoting class to break.
  // The outer `"$(...)"` substitution decodes once and feeds the result as a
  // single argument to `bash -lic`, which is identical to the prior
  // `bash -lic '<cmd>'` shape but immune to quoting drift in `command`.
  //
  // First-launch silent-exit fix: prepend `setsid` so the tmux server starts
  // in its own session, fully detached from the calling wsl.exe process
  // group. Without this, when wsl.exe exits after `tmux new-session -d`
  // returns 0, claude's TUI startup (isatty / controlling-terminal probe)
  // trips on the closing pgroup and exits silently — wasting a restart
  // cycle on every first launch. setsid makes the tmux daemon its own
  // session leader so claude's pane survives wsl.exe shutdown.
  //
  // Scrollback persistence: `set-option -g history-limit` runs as a chained
  // tmux command (`\;` — bash passes the literal `;` to tmux as its command
  // separator) BEFORE `new-session`. history-limit is read when a pane's grid
  // is created and is NOT applied retroactively, so it must be set on the
  // global options first; the pane that `new-session` then creates inherits
  // the larger buffer. Setting it globally is idempotent across launches and
  // starts the server if none is running.
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  const tmuxScript =
    `setsid tmux set-option -g history-limit ${TMUX_HISTORY_LIMIT} \\; ` +
    `new-session -d -s ${shQuote(name)} -c ${shQuote(workDir)} -- bash -lic "$(echo ${b64} | base64 -d)"`;
  // BUG-WSLQUOTE: the inner `"$(...)"` double quotes do NOT survive the
  // Node→wsl.exe argv translation. Wrapping the whole tmuxScript in
  // wslBashEnvelope makes those inner quotes opaque base64 — parsed by the
  // final `bash` in the pipe, never crossing the boundary. name/workDir are
  // shQuote'd so a literal `'` in a workspace path can't break the inner script.
  return wslBashEnvelope(tmuxScript);
}

export interface TmuxNewSessionResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Fully-rendered outer `tmux new-session ...` command (base64-enveloped
   *  payload) that was handed to wslExec — distinct from the inner shell
   *  command passed in by the caller. Captured for diagnostic logging
   *  (BUG-22 Step 1). */
  tmuxCommand: string;
}

export async function tmuxNewSession(
  name: string,
  workDir: string,
  command: string,
  // Default `wslExec` is wired in production; tests inject a stub so the
  // unit boundary doesn't have to spawn wsl.exe. The signature matches the
  // overload `tmuxNewSession` calls today.
  exec: (cmd: string, timeout: number) => Promise<WslExecResult> = wslExec,
): Promise<TmuxNewSessionResult> {
  // Create session with the command as the pane process. When the command
  // exits, the tmux pane/session closes automatically, which causes
  // `tmux attach` in the PTY to exit → proper status update. Use bash -lic
  // (login + interactive) so .bashrc aliases / venv activation hooks fire.
  //
  // BUG-22 Step 1: return a structured result instead of throwing on non-zero
  // exit. Normal tmux failures are data the caller needs for diagnostics, not
  // exceptions to catch. wslExec already returns exitCode and never throws.
  const tmuxCommand = buildTmuxNewSessionCommand(name, workDir, command);
  const result = await exec(tmuxCommand, 15000);
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    tmuxCommand,
  };
}

export interface TmuxWaitForSessionResult {
  ok: boolean;
  waitedMs: number;
  lastError?: string;
}

/**
 * BUG-22 Step 2: poll `tmux has-session -t '<name>'` from the Node side until
 * the session is enumerable or `timeoutMs` elapses. Runs between
 * `tmuxNewSession` returning ok and the PTY attach so the cold-launch
 * create→attach race can't surface as a phantom `can't find session` exit-1.
 *
 * The diagnostic from Step 1 confirmed `tmux new-session -d` can return 0 a
 * few ms before the tmux server's session registry is queryable, even though
 * the shell-side poll in `buildTmuxAttachCmd` lives inside the same `wsl.exe`
 * invocation as the attach. Adding a Node-side wait gives us a clean
 * latency-instrumented gate: success on first poll adds ~0–20ms, and the
 * `waitedMs` value lands in the JSONL log so the wait-time distribution is
 * observable after shipping.
 *
 * The function never throws — it returns `{ok:false}` on timeout so the
 * caller can log a warning and still attempt the attach (preserving the
 * existing failure path through the runner exit handler).
 */
export async function tmuxWaitForSession(
  name: string,
  timeoutMs: number,
  exec: (cmd: string, timeout: number) => Promise<WslExecResult> = wslExec,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = () => Date.now(),
): Promise<TmuxWaitForSessionResult> {
  const start = now();
  const checkCmd = `tmux has-session -t '${name}'`;
  let lastError: string | undefined;
  // First check is immediate — the common case is the session is already
  // registered by the time we get here.
  while (true) {
    const result = await exec(checkCmd, 2000);
    if (result.exitCode === 0) {
      return { ok: true, waitedMs: now() - start };
    }
    lastError = result.stderr || `exit code ${result.exitCode}`;
    if (now() - start >= timeoutMs) {
      return { ok: false, waitedMs: now() - start, lastError };
    }
    await sleep(20);
  }
}

export async function tmuxSendKeys(name: string, text: string): Promise<void> {
  // Chain literal-text send and Enter into a single wsl.exe invocation so they
  // either both happen or neither does. Splitting them across two wsl.exe
  // spawns lets a flaky second spawn drop the Enter silently, leaving the
  // message typed but unsubmitted in Claude Code's prompt buffer.
  const escaped = shellSingleQuoteEscape(text);
  const result = await wslExec(
    `tmux send-keys -t '${name}' -l '${escaped}' \\; send-keys -t '${name}' Enter`,
    5000
  );
  if (result.exitCode !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr || 'unknown error'}`);
  }
}

function shellSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** P1 (plans/p1-hook-spool-multi-transport.md §3/§4) — single-quote a value
 *  for a bash command line. Safe for any byte content: embedded single quotes
 *  become the standard '\'' splice. Used for the DASHBOARD_SPOOL_PATH launch
 *  env prefix (workspace paths can contain spaces) and for every tmux session
 *  name in tmuxReadStatusOptions. */
export function shQuote(value: string): string {
  return `'${shellSingleQuoteEscape(value)}'`;
}

// Hex byte sequences for tmux `send-keys -H`.
// Kitty keyboard protocol (CSI-u) — all three providers on Linux enable this
// and expect Enter as `\x1b[13u`. Plain `\r` from `tmux send-keys Enter` is
// silently dropped in disambiguate mode.
export const TMUX_KITTY_ENTER_HEX = '1b 5b 31 33 75';            // \x1b[13u
// Bracketed paste markers — claude on Linux treats the wrapped body as pasted
// content (renders multi-line correctly without submitting). Sent explicitly
// around claude's paste rather than via `paste-buffer -p`, because `-p` only
// inserts the markers when the pane application has already requested
// bracketed-paste mode — if claude hadn't enabled it yet (e.g. mid-startup),
// an unwrapped multi-line body could partially submit. Verified empirically:
// `-p` against a pane that never requested paste mode emits no markers.
const TMUX_BP_START_HEX = '1b 5b 32 30 30 7e';             // \x1b[200~
const TMUX_BP_END_HEX = '1b 5b 32 30 31 7e';               // \x1b[201~

// Sleep covers codex's PasteBurst (8 ms) and gemini's bufferFastReturn (30 ms,
// only active when kitty mode is *off* — the WSL pty doesn't always advertise
// it) so the trailing submit Enter isn't rewritten as newline-insert.
const POST_BODY_SLEEP_SECONDS = '0.08';

export type TmuxProvider = 'claude' | 'codex' | 'gemini' | 'unknown';

/** Command + stdin payload produced by {@link buildTmuxSendInputCmd}. The
 *  body travels on stdin (consumed by `tmux load-buffer -`), never inside
 *  `cmd` itself, so the assembled command stays a constant ~150 bytes
 *  regardless of payload size. The previous per-line `send-keys \; ...`
 *  encoding grew with the payload and a full GroupThink draft (~14–20 KB)
 *  overflowed both tmux's command-length limit and Windows CreateProcess's
 *  ~32 KB argv cap, breaking the quoting so draft text ran as bash — see
 *  plans/wsl-codex-relay-length-bug-2026-06-10.md. */
export interface TmuxSendInputCommand {
  cmd: string;
  /** Newline-normalized body to pipe to `cmd`'s stdin; absent when the
   *  command is submit-only (empty body). */
  stdin?: string;
}

/**
 * Pure builder for the WSL tmux input-relay command. Exposed so the
 * provider-specific encoding (and the submit/no-submit branches added for
 * BUG-01) can be unit-tested without spawning wsl.exe.
 *
 * Returns null when there is nothing to send (empty body + submit:false) or
 * when the provider is 'unknown' (which falls back to the legacy tmuxSendKeys
 * path that's already covered elsewhere).
 */
export function buildTmuxSendInputCmd(
  name: string,
  text: string,
  provider: TmuxProvider,
  submit: boolean
): TmuxSendInputCommand | null {
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'gemini') {
    return null;
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip nested bracketed-paste markers so a hostile payload can't terminate
  // claude's paste wrapper early (or fake one around codex's raw paste) and
  // reach the agent's input handler as key events.
  const body = normalized.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
  const submitCmd = `tmux send-keys -t '${name}' -H ${TMUX_KITTY_ENTER_HEX}`;

  if (body.length === 0) {
    return submit ? { cmd: submitCmd } : null;
  }

  // Deliver the body as a tmux buffer paste: `load-buffer -` fills a buffer
  // from stdin and `paste-buffer -d` replays it into the pane (deleting the
  // buffer afterwards). Per provider:
  // - claude: explicit bracketed-paste markers around the paste (multi-line
  //   content renders without submitting), with `-r` suppressing tmux's
  //   default LF→CR translation — the pane receives the exact byte stream
  //   (\x1b[200~ + body-with-LF + \x1b[201~) the old per-`send-keys -l`
  //   wrapping produced. Markers are sent via `send-keys -H`, not
  //   `paste-buffer -p`, because `-p` is conditional on the app having
  //   requested paste mode (see TMUX_BP_START_HEX).
  // - codex/gemini: raw paste with default LF→CR translation, verified live
  //   on WSL (plans/wsl-codex-relay-length-bug-2026-06-10.md): a 20 KB /
  //   312-line paste lands in codex's composer intact, with no premature
  //   submit and no external-editor confirmation flow. (An earlier comment
  //   here claimed bracketed paste opens codex's external-editor confirmation
  //   flow on Linux; that did not reproduce — and is moot for a raw paste,
  //   which sends no bracketed-paste markers.)
  const bodyCmd = provider === 'claude'
    ? `tmux send-keys -t '${name}' -H ${TMUX_BP_START_HEX} \\; ` +
      `load-buffer - \\; paste-buffer -d -r -t '${name}' \\; ` +
      `send-keys -t '${name}' -H ${TMUX_BP_END_HEX}`
    : `tmux load-buffer - \\; paste-buffer -d -t '${name}'`;
  if (!submit) return { cmd: bodyCmd, stdin: body };
  return {
    cmd: `${bodyCmd} && sleep ${POST_BODY_SLEEP_SECONDS} && ${submitCmd}`,
    stdin: body,
  };
}

/**
 * Send `text` to a WSL agent via tmux, then submit, using a provider-aware
 * encoding. The body is piped to `tmux load-buffer -` on stdin and pasted
 * into the pane — length-safe for arbitrarily large relays (see
 * {@link buildTmuxSendInputCmd}). All three providers enable kitty keyboard
 * protocol on Linux at startup; tmux's `send-keys Enter` (a bare `\r` byte)
 * is dropped in that mode, so submit must be sent as the kitty CSI key event
 * `\x1b[13u`.
 *
 * `submit` defaults to true. Set it to false to leave the text in the agent's
 * prompt buffer without pressing Enter — used by launch_agent's `submit:false`
 * flag (BUG-01).
 */
export async function tmuxSendInput(
  name: string,
  text: string,
  provider: TmuxProvider = 'unknown',
  submit: boolean = true
): Promise<void> {
  if (provider === 'unknown') {
    // Unknown provider: keep legacy `\r`-via-tmux-Enter path. submit:false has
    // no effect — the legacy path was always submit-only.
    await tmuxSendKeys(name, text);
    return;
  }

  const input = buildTmuxSendInputCmd(name, text, provider, submit);
  if (!input) return; // nothing to do (e.g. empty body + submit:false)
  const result = await wslExecCommand(input.cmd, { timeout: 8000, input: input.stdin });
  if (result.exitCode !== 0) {
    throw new Error(`tmux input relay (${provider}) failed: ${result.stderr || 'unknown error'}`);
  }
}

/**
 * C2 (plans/global-hook-rollout-and-submit-confirmation.md §3.2) — pure builder
 * for the submit-ONLY tmux command: a bare kitty-CSI Enter (`\x1b[13u`) with NO
 * body and NO bracketed-paste wrapper. This is the byte sequence the
 * synchronous confirm-and-retry re-presses on each retry.
 *
 * `buildTmuxSendInputCmd(name,'',provider,true)` now produces this same bare
 * Enter (the buffer-paste body is skipped entirely for an empty body), but
 * this dedicated builder remains the canonical entrypoint for re-pressing
 * submit. All three WSL providers enable kitty keyboard protocol, so the same
 * `\x1b[13u` is the correct submit for each; the body already sits in the
 * composer, so no re-paste is ever needed.
 *
 * Exported so the shape can be asserted without spawning wsl.exe.
 */
export function buildTmuxSubmitOnlyCmd(name: string): string {
  return `tmux send-keys -t '${name}' -H ${TMUX_KITTY_ENTER_HEX}`;
}

/**
 * BUG-10 reactive resend / C2 confirm-retry — replay ONLY the submit keystroke
 * into a tmux pane, with no body. Used by StatusMonitor's Enter-resend recovery
 * and the synchronous confirm-and-retry when a prompt was delivered but the
 * paste-race ate the trailing Enter. The body is already sitting in the agent's
 * prompt buffer, so resending it would duplicate the text.
 */
export async function tmuxSendSubmit(name: string): Promise<void> {
  const result = await wslExec(buildTmuxSubmitOnlyCmd(name), 8000);
  if (result.exitCode !== 0) {
    throw new Error(`tmux send-keys (submit) failed: ${result.stderr || 'unknown error'}`);
  }
}

export async function tmuxKillSession(name: string): Promise<void> {
  await wslExec(`tmux kill-session -t '${name}' 2>/dev/null || true`);
}

export async function isTmuxSessionAlive(name: string): Promise<boolean> {
  const result = await wslExec(`tmux has-session -t '${name}' 2>/dev/null && echo yes || echo no`);
  return result.stdout === 'yes';
}

/**
 * Build the bash command the PTY runs to attach to a tmux session.
 *
 * Adds a `tmux has-session` poll-until-success guard before the attach so the
 * first-launch race documented in `plans/bug-supervisor-wsl-launch-investigation.md`
 * (Bug B, candidate 1) self-heals instead of crashing.
 *
 * The race: `tmuxNewSession` returns as soon as `tmux new-session -d` forks
 * the pane process, not when the session is fully ready for clients. The
 * subsequent `wsl.exe bash -lc 'tmux attach -t <name>'` can hit the server
 * before the session registers and exit 1 with `can't find session: <name>`.
 * That looks to the dashboard like an immediate `crashed (exitCode:1)`,
 * which triggers `auto_restart`. The restart uses `resume=true`, which skips
 * the supervisor/worker command wrap (index.ts:1421) — so the second attempt
 * succeeds and pollutes the lifecycle history with a phantom crash + ~13s of
 * recovery latency every cold WSL Claude launch.
 *
 * Poll cadence: up to 30 × 100ms = 3s. If the session genuinely never
 * appears (e.g. the wrapped command died inside the pane before the
 * dashboard ever attached, candidates 2 and 3 in the investigation file),
 * the loop falls through and the bare `tmux attach` still runs — the dashboard
 * sees the same `can't find session` exit-1 it sees today, just delayed by
 * the poll budget. So this fix is strictly defensive: it can fix the race,
 * never makes other failure modes worse.
 *
 * Builder is exported so the shape (poll guard present, session name quoted)
 * can be asserted in a unit test without spawning wsl.exe.
 */
export function buildTmuxAttachCmd(name: string): string {
  const attempts = Array.from({ length: 30 }, (_, i) => String(i + 1)).join(' ');
  return (
    `for i in ${attempts}; do tmux has-session -t '${name}' 2>/dev/null && break; sleep 0.1; done; ` +
    `tmux attach -t '${name}'`
  );
}

/**
 * P1 work item D (plans/p1-hook-spool-multi-transport.md §4) — read the
 * `@agentdashboard-status` pane option for a batch of tmux sessions in ONE
 * `wsl.exe` invocation. The v7 hook script writes its event record there
 * (transport 3) so the dashboard can recover a hook event even when both the
 * spool and HTTP were unreachable.
 *
 * The pane id is resolved explicitly per session (`display-message -p
 * '#{pane_id}'`) rather than relying on session-scope option fallback; a
 * session that no longer exists is skipped (`|| continue`). Every session
 * name passes through {@link shQuote}, even though generated names look safe
 * today. The `$(...)` substitution around `show-options` strips the trailing
 * newline the stored option value carries (the script sets the whole spool
 * LINE, newline included).
 *
 * Returns session → raw option value (empty string when unset — `-q` makes
 * show-options print nothing for a missing option). The caller parses the
 * JSON and routes through the central applier; this helper stays transport
 * plumbing only.
 */
export async function tmuxReadStatusOptions(
  sessionNames: string[],
  exec: (cmd: string, timeout: number) => Promise<WslExecResult> = wslExec,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  if (sessionNames.length === 0) return values;

  const quoted = sessionNames.map(shQuote).join(' ');
  const script =
    `for s in ${quoted}; do ` +
    `p=$(tmux display-message -p -t "$s" '#{pane_id}' 2>/dev/null) || continue; ` +
    `printf '%s\\t%s\\n' "$s" "$(tmux show-options -pqv -t "$p" @agentdashboard-status 2>/dev/null)"; ` +
    `done`;
  const result = await exec(wslBashEnvelope(script), 8000);
  if (result.exitCode !== 0 && !result.stdout) return values;

  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    values.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return values;
}

export async function tmuxCapturePane(name: string, lines = 50): Promise<string> {
  const result = await wslExec(
    `tmux capture-pane -t '${name}' -p -S -${lines} 2>/dev/null || echo ''`
  );
  return result.stdout;
}
