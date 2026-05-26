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

export async function getPassiveWslStatus(): Promise<WslStatus> {
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
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  return `setsid tmux new-session -d -s '${name}' -c '${workDir}' -- bash -lic "$(echo ${b64} | base64 -d)"`;
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

// Hex byte sequences for tmux `send-keys -H`.
// Kitty keyboard protocol (CSI-u) — codex/gemini on Linux enable this and
// expect Enter as `\x1b[13u`, Shift+Enter as `\x1b[13;2u`. Plain `\r` from
// `tmux send-keys Enter` is silently dropped in disambiguate mode.
export const TMUX_KITTY_ENTER_HEX = '1b 5b 31 33 75';            // \x1b[13u
const TMUX_KITTY_SHIFT_ENTER_HEX = '1b 5b 31 33 3b 32 75'; // \x1b[13;2u
// Bracketed paste markers — claude on Linux treats the wrapped body as pasted
// content (renders multi-line correctly without entering paste-confirmation),
// then accepts a separate kitty Enter to submit.
const TMUX_BP_START_HEX = '1b 5b 32 30 30 7e';             // \x1b[200~
const TMUX_BP_END_HEX = '1b 5b 32 30 31 7e';               // \x1b[201~

// Sleep covers codex's PasteBurst (8 ms) and gemini's bufferFastReturn (30 ms,
// only active when kitty mode is *off* — the WSL pty doesn't always advertise
// it) so the trailing submit Enter isn't rewritten as newline-insert.
const POST_BODY_SLEEP_SECONDS = '0.08';

export type TmuxProvider = 'claude' | 'codex' | 'gemini' | 'unknown';

/**
 * Pure builder for the WSL `tmux send-keys` shell command. Exposed so the
 * provider-specific encoding (and the submit/no-submit branches added for
 * BUG-01) can be unit-tested without spawning wsl.exe.
 *
 * Returns null when the provider is 'unknown' (which falls back to the legacy
 * tmuxSendKeys path that's already covered elsewhere).
 */
export function buildTmuxSendInputCmd(
  name: string,
  text: string,
  provider: TmuxProvider,
  submit: boolean
): string | null {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const submitCmd = `tmux send-keys -t '${name}' -H ${TMUX_KITTY_ENTER_HEX}`;

  if (provider === 'claude') {
    // Strip nested bracketed-paste markers so a hostile payload can't escape
    // the wrapper and reach claude's input handler outside paste mode.
    const body = normalized.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
    const escaped = shellSingleQuoteEscape(body);
    const bodyCmd =
      `tmux send-keys -t '${name}' -H ${TMUX_BP_START_HEX} \\; ` +
      `send-keys -t '${name}' -l '${escaped}' \\; ` +
      `send-keys -t '${name}' -H ${TMUX_BP_END_HEX}`;
    if (!submit) return bodyCmd;
    return `${bodyCmd} && sleep ${POST_BODY_SLEEP_SECONDS} && ${submitCmd}`;
  }

  if (provider === 'codex' || provider === 'gemini') {
    const lines = normalized.split('\n');
    const parts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        parts.push(`send-keys -t '${name}' -l '${shellSingleQuoteEscape(lines[i])}'`);
      }
      if (i < lines.length - 1) {
        parts.push(`send-keys -t '${name}' -H ${TMUX_KITTY_SHIFT_ENTER_HEX}`);
      }
    }
    const bodyCmd = parts.length > 0 ? `tmux ${parts.join(' \\; ')}` : '';
    if (!submit) return bodyCmd || null;
    return bodyCmd
      ? `${bodyCmd} && sleep ${POST_BODY_SLEEP_SECONDS} && ${submitCmd}`
      : submitCmd;
  }

  return null;
}

/**
 * Send `text` to a WSL agent via tmux, then submit, using a provider-aware
 * encoding. All three providers enable kitty keyboard protocol on Linux at
 * startup; tmux's `send-keys Enter` (a bare `\r` byte) is dropped in that
 * mode, so submit must be sent as the kitty CSI key event `\x1b[13u`.
 *
 * - claude: bracketed-paste-wrap the body so multi-line content renders without
 *   triggering paste-confirmation, then submit.
 * - codex/gemini: type body line-by-line, encoding embedded `\n` as kitty
 *   Shift+Enter (`\x1b[13;2u`) so the final Enter is the only submit event.
 *   Bracketed paste opens codex's external-editor confirmation flow on Linux
 *   too (same regression as Windows), so don't wrap.
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

  const cmd = buildTmuxSendInputCmd(name, text, provider, submit);
  if (!cmd) return; // nothing to do (e.g. empty body + submit:false)
  const result = await wslExec(cmd, 8000);
  if (result.exitCode !== 0) {
    throw new Error(`tmux send-keys (${provider}) failed: ${result.stderr || 'unknown error'}`);
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

export async function tmuxCapturePane(name: string, lines = 50): Promise<string> {
  const result = await wslExec(
    `tmux capture-pane -t '${name}' -p -S -${lines} 2>/dev/null || echo ''`
  );
  return result.stdout;
}
