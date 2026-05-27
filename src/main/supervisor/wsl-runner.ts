import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import path from 'path';
import { tmuxNewSession, tmuxKillSession, isTmuxSessionAlive, tmuxCapturePane, wslExec, buildTmuxAttachCmd, tmuxWaitForSession, TmuxNewSessionResult } from '../wsl-bridge';
import { getScriptPath } from './paths';

/** BUG-22 Step 1 diagnostic metadata passed from `launchWslAgent` so the
 *  runner can append one complete JSONL record per launch attempt once the
 *  attach result is known. */
export interface WslLaunchDiagnostics {
  launchStartedAt: string;
  /** Workspace-relative `.dashboard/launches.log` path. When null, JSONL
   *  appending is disabled (no workspace path available). */
  launchesLogPath: string | null;
  agentId: string;
  agentTitle: string;
  workspaceId: string;
  provider: string;
  isSupervisor: boolean;
  isSupervised: boolean;
  resume: boolean;
  freshSession: boolean;
}

/** BUG-22 Step 1 diagnostic: the failure-header block prepended to the agent's
 *  PTY log when `tmuxNewSession` returns `ok: false`. Pure builder so the
 *  format can be unit-tested without spawning tmux. */
export function buildTmuxFailureHeaderBlock(input: {
  tmuxSessionName: string;
  tmuxExitCode: number | null;
  tmuxStderr: string;
  command: string;
  nowIso?: string;
}): string {
  const stamp = input.nowIso ?? new Date().toISOString();
  const stderrText = input.tmuxStderr && input.tmuxStderr.length > 0
    ? input.tmuxStderr
    : '(empty)';
  const exitCodeStr = input.tmuxExitCode != null
    ? String(input.tmuxExitCode)
    : '(unknown)';
  return [
    '===== WSL tmux session creation failed =====',
    `timestamp: ${stamp}`,
    `tmux session: ${input.tmuxSessionName}`,
    `tmux exit code: ${exitCodeStr}`,
    'stderr:',
    stderrText,
    '',
    'command:',
    input.command,
    '============================================',
    '',
  ].join('\n');
}

/** BUG-22 Step 1 diagnostic: pure builder for the JSONL log record so the
 *  exact serialization shape can be unit-tested without spawning a runner. */
export function buildLaunchRecord(input: {
  diagnostics: WslLaunchDiagnostics;
  sessionName: string;
  workDir: string;
  command: string;
  tmuxResult: TmuxNewSessionResult | null;
  attachAttempted: boolean;
  attachExitCode: number | null;
  attachSignal: string | null;
  outputTail: string;
  /** BUG-22 Step 2: milliseconds spent in `tmuxWaitForSession` between
   *  `tmuxNewSession` returning ok and the PTY attach starting. Undefined
   *  when the wait was skipped (e.g. tmuxNewSession failed pre-attach). */
  attachWaitMs?: number;
  nowIso?: string;
}): WslLaunchAttemptLogRecord {
  const tmux = input.tmuxResult;
  return {
    schema_version: 1,
    timestamp: input.nowIso ?? new Date().toISOString(),
    launch_started_at: input.diagnostics.launchStartedAt,
    agent_id: input.diagnostics.agentId,
    agent_title: input.diagnostics.agentTitle,
    workspace_id: input.diagnostics.workspaceId,
    provider: input.diagnostics.provider,
    is_supervisor: input.diagnostics.isSupervisor,
    is_supervised: input.diagnostics.isSupervised,
    resume: input.diagnostics.resume,
    fresh_session: input.diagnostics.freshSession,
    work_dir: input.workDir,
    tmux_session_name: input.sessionName,
    command: input.command,
    tmux_new_session: {
      ok: tmux?.ok ?? false,
      exit_code: tmux?.exitCode ?? null,
      stderr: tmux?.stderr ?? '',
      stdout: tmux?.stdout ?? '',
      tmux_command: tmux?.tmuxCommand ?? '',
    },
    attach_wait_ms: input.attachWaitMs,
    attach_result: {
      attempted: input.attachAttempted,
      exit_code: input.attachExitCode,
      signal: input.attachSignal,
      output_tail: input.outputTail,
    },
  };
}

/** BUG-22 Step 1 diagnostic: append one JSONL record to `launchesLogPath`.
 *  Best-effort — file I/O failures are logged to `console.error` and swallowed
 *  so the diagnostic path can never block or fail a launch. */
export function appendLaunchRecord(
  launchesLogPath: string,
  record: WslLaunchAttemptLogRecord,
): void {
  try {
    const dir = path.dirname(launchesLogPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(launchesLogPath, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error(`[WSL] failed to append launches.log at ${launchesLogPath}:`, err);
  }
}

/** BUG-22 Step 1 diagnostic: shape of the JSONL record appended to
 *  `<workspace>/.dashboard/launches.log` once per launch attempt. */
export interface WslLaunchAttemptLogRecord {
  schema_version: 1;
  timestamp: string;
  launch_started_at: string;
  agent_id: string;
  agent_title: string;
  workspace_id: string;
  provider: string;
  is_supervisor: boolean;
  is_supervised: boolean;
  resume: boolean;
  fresh_session: boolean;
  work_dir: string;
  tmux_session_name: string;
  command: string;
  tmux_new_session: {
    ok: boolean;
    exit_code: number | null;
    stderr: string;
    stdout: string;
    tmux_command: string;
  };
  /** BUG-22 Step 2: ms spent in `tmuxWaitForSession` before attach. Lets us
   *  watch the wait-time distribution post-ship to confirm the race fix
   *  bounds latency on the success path. Omitted when the wait was skipped. */
  attach_wait_ms?: number;
  attach_result: {
    attempted: boolean;
    exit_code: number | null;
    signal: string | null;
    output_tail: string;
  };
}

/** BUG-22 Step 3: test-injectable seams for `WslRunner`. Default to the
 *  production implementations; unit tests pass stubs so they can drive the
 *  silent-reconnect machinery without spawning wsl.exe or a pty-host. */
export interface WslRunnerSeams {
  isTmuxSessionAlive?: (name: string) => Promise<boolean>;
  now?: () => number;
}

/**
 * Runs a Claude agent inside WSL via node-pty (through pty-host.js).
 *
 * Architecture mirrors WindowsRunner: the PTY is spawned at launch time
 * and stays alive. A tmux session is also created so the agent can survive
 * dashboard restarts. On reconnect we attach to tmux; on fresh launch we
 * run the command directly in a PTY for reliable terminal output.
 */
export class WslRunner extends EventEmitter {
  private host: ChildProcess | null = null;
  private sessionName: string;
  // BUG-22 Step 3: injectable seams. Stored as instance fields so the
  // production code path is identical to the test path (no branching on
  // `this._seams` at call sites).
  private readonly _isTmuxSessionAlive: (name: string) => Promise<boolean>;
  private readonly _now: () => number;
  // BUG-22 Step 3: rolling-window log of silent reconnect timestamps. Caps
  // the silent-reconnect loop at MAX_PHANTOM_RECONNECTS_PER_MIN within any
  // 60-second window so a reliably-failing attach can't spin forever; once
  // the cap is exceeded the next phantom exit falls through to the normal
  // crash path so the supervisor sees the failure.
  private _phantomReconnectTimestamps: number[] = [];
  private static readonly MAX_PHANTOM_RECONNECTS_PER_MIN = 3;
  private static readonly PHANTOM_RECONNECT_WINDOW_MS = 60_000;
  private _lastOutputTime: number = 0;
  private _lastMeaningfulBurst: number = 0;
  private _recentOutputBytes: number = 0;
  private _outputWindowStart: number = 0;
  /** While > Date.now(), data bursts do NOT advance `_lastMeaningfulBurst`.
   *  Set by `markInteractionIgnoreWindow` so a fresh attach (TUI redraw) does
   *  not flip the agent's status to 'working'. P1B-03. */
  private _ignoreBurstUntil: number = 0;
  private _pid: number | null = null;
  private _alive: boolean = false;
  private _intentionalKill: boolean = false;
  private buffer: string = '';
  private logStream: fs.WriteStream | null = null;
  // BUG-22 Step 1 diagnostic state — captured at launch and consumed once at
  // the first attach exit (or pre-attach failure) to append exactly one JSONL
  // record to `<workspace>/.dashboard/launches.log`.
  private _diagnostics: WslLaunchDiagnostics | null = null;
  private _launchWorkDir: string = '';
  private _launchCommand: string = '';
  private _tmuxResult: TmuxNewSessionResult | null = null;
  private _attachAttempted: boolean = false;
  // BUG-22 Step 2: captured from `tmuxWaitForSession` so the JSONL record
  // exposes wait-time post-ship. Undefined when the wait was skipped (tmux
  // creation failed before we got there).
  private _attachWaitMs: number | undefined = undefined;
  private _launchRecordWritten: boolean = false;
  // P2-02: ring buffer sibling for PromptPatternDetector. WindowsRunner ships
  // one for chat-history use; the WSL path historically pulled tail bytes via
  // a `tmuxCapturePane` subprocess. We mirror the Windows shape so the
  // detector can poll the tail in-process without a per-tick exec.
  // BUG-15: also serves as the terminal viewer's scrollback source; bumped
  // from 500 lines to 10000 / 1MB so the snapshot is useful.
  private outputRing: string[] = [];
  private outputRingBytes: number = 0;
  private static readonly MAX_RING_LINES = 10000;
  private static readonly MAX_RING_BYTES = 1_000_000;
  private _logPath: string | null = null;

  constructor(sessionName: string, seams: WslRunnerSeams = {}) {
    super();
    this.sessionName = sessionName;
    this._isTmuxSessionAlive = seams.isTmuxSessionAlive ?? isTmuxSessionAlive;
    this._now = seams.now ?? (() => Date.now());
  }

  /** BUG-09 §3.5 — see windows-runner.ts for full docstring. */
  get lastMeaningfulBurstTime(): number {
    return this._lastMeaningfulBurst;
  }

  /** BUG-09 §3.5 — see windows-runner.ts for full docstring. */
  get lastRawOutputTime(): number {
    return this._lastOutputTime;
  }

  get pid(): number | null {
    return this._pid;
  }

  get isAlive(): boolean {
    return this._alive;
  }

  /**
   * Launch the agent. Spawns pty-host.js running `wsl.exe bash -lc "cd /dir && command"`
   * directly in a PTY, so terminal data flows from the start (just like WindowsRunner).
   * Also creates a tmux session for persistence/reconnect.
   *
   * BUG-22 Step 1: `diagnostics` is consumed once at the first attach exit (or
   * pre-attach failure) to append a single JSONL record describing the launch
   * attempt — the tmux-new-session result, the rendered command, and the
   * attach result. Pass `null` to disable per-attempt JSONL logging.
   */
  async launch(
    workDir: string,
    command: string,
    logPath: string,
    diagnostics: WslLaunchDiagnostics | null = null,
  ): Promise<void> {
    this._diagnostics = diagnostics;
    this._launchWorkDir = workDir;
    this._launchCommand = command;
    this._tmuxResult = null;
    this._attachAttempted = false;
    this._attachWaitMs = undefined;
    this._launchRecordWritten = false;

    // Kill any stale tmux session with the same name (leftover from previous app run)
    if (await isTmuxSessionAlive(this.sessionName)) {
      console.log(`[WSL] Killing stale tmux session '${this.sessionName}'`);
      await tmuxKillSession(this.sessionName);
    }

    // Create tmux session for persistence (agent survives dashboard restart).
    // BUG-22 Step 1: tmuxNewSession is now structured-result; non-zero exit is
    // data, not an exception. Capture the result for the diagnostic JSONL and,
    // on failure, prepend a clear failure block to the agent PTY log so the
    // dashboard's terminal viewer surfaces it at a glance.
    const tmuxResult = await tmuxNewSession(this.sessionName, workDir, command);
    this._tmuxResult = tmuxResult;
    if (tmuxResult.ok) {
      console.log(`[WSL] Created tmux session '${this.sessionName}'`);
    } else {
      console.error(
        `[WSL:${this.sessionName}] tmux-new-session failed exit=${tmuxResult.exitCode}: ${tmuxResult.stderr}`,
      );
      const header = buildTmuxFailureHeaderBlock({
        tmuxSessionName: this.sessionName,
        tmuxExitCode: tmuxResult.exitCode,
        tmuxStderr: tmuxResult.stderr,
        command,
      });
      if (logPath) {
        try {
          const logDir = path.dirname(logPath);
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          fs.appendFileSync(logPath, header);
        } catch (err) {
          console.error(`[WSL:${this.sessionName}] failed to write tmux failure header:`, err);
        }
      }
      // Also seed the in-memory ring so the terminal viewer surfaces the
      // header even before the PTY attach starts producing data.
      this.appendToRing(header);
      // Surface the failure to the supervisor pipeline. Pre-attach we still
      // proceed to spawn the PTY — `tmux attach` will fail with `can't find
      // session` and exit 1, which carries normal crashed-status semantics.
      this.emit('tmuxNewSessionFailed', {
        tmuxSessionName: this.sessionName,
        command,
        tmuxExitCode: tmuxResult.exitCode,
        tmuxStderr: tmuxResult.stderr,
        tmuxCommand: tmuxResult.tmuxCommand,
      });
    }

    // BUG-22 Step 2: between `tmuxNewSession` returning ok and the PTY attach,
    // poll `tmux has-session` from Node until the session is enumerable. The
    // Step 1 diagnostic showed `tmux new-session -d` can exit 0 a few ms
    // before the server's session registry answers queries, so a small wait
    // here eliminates the cold-launch race that surfaces as a phantom
    // `can't find session` exit-1 → auto-restart cycle. On the success path
    // (session already registered) this adds ~0–20ms; on timeout we log and
    // proceed so the existing failure path still fires through the runner
    // exit handler.
    if (tmuxResult.ok) {
      const wait = await tmuxWaitForSession(this.sessionName, 2000);
      this._attachWaitMs = wait.waitedMs;
      if (!wait.ok) {
        console.warn(
          `[WSL:${this.sessionName}] tmux session not enumerable after ${wait.waitedMs}ms ` +
          `(lastError=${wait.lastError ?? 'none'}); attaching anyway`,
        );
      }
    }

    // Spawn the PTY that attaches to the tmux session. The attach is what
    // surfaces output to the dashboard; we always attempt it even on
    // tmuxNewSession failure so the subsequent exit lands through the same
    // runner-exit path the dashboard already handles.
    this.spawnPtyHost(workDir, command, logPath, false);
  }

  /** BUG-22 Step 1: append a string to the in-memory output ring buffer
   *  without flipping any meaningful-content / activity flags. Used by the
   *  tmux failure header so the terminal viewer can render it immediately. */
  private appendToRing(text: string): void {
    const newLines = text.split('\n');
    if (this.outputRing.length > 0 && newLines.length > 0) {
      this.outputRing[this.outputRing.length - 1] += newLines[0];
      for (let i = 1; i < newLines.length; i++) {
        this.outputRing.push(newLines[i]);
      }
    } else {
      this.outputRing.push(...newLines);
    }
    this.outputRingBytes += text.length;
    while (
      this.outputRing.length > WslRunner.MAX_RING_LINES ||
      this.outputRingBytes > WslRunner.MAX_RING_BYTES
    ) {
      const dropped = this.outputRing.shift();
      if (dropped === undefined) break;
      this.outputRingBytes -= dropped.length + 1;
      if (this.outputRingBytes < 0) this.outputRingBytes = 0;
    }
  }

  /** BUG-22 Step 1: append one JSONL record to the workspace's launches.log
   *  describing the full launch attempt. Called exactly once per attempt; the
   *  internal `_launchRecordWritten` guard prevents double-writes when both
   *  the pty-host process exits and the inner PTY emits an `exit` message.
   *
   *  Protected so unit tests can subclass `WslRunner` and assert that the
   *  silent-reconnect path does NOT call this and the true-crash path does.
   */
  protected writeLaunchRecord(attachExitCode: number | null, attachSignal: string | null): void {
    if (this._launchRecordWritten) return;
    this._launchRecordWritten = true;
    const diag = this._diagnostics;
    if (!diag || !diag.launchesLogPath) return;
    const record = buildLaunchRecord({
      diagnostics: diag,
      sessionName: this.sessionName,
      workDir: this._launchWorkDir,
      command: this._launchCommand,
      tmuxResult: this._tmuxResult,
      attachAttempted: this._attachAttempted,
      attachExitCode,
      attachSignal,
      outputTail: this.getOutputRingTail(4096),
      attachWaitMs: this._attachWaitMs,
    });
    appendLaunchRecord(diag.launchesLogPath, record);
  }

  /** BUG-22 Step 3: respawn the pty-host in reconnect mode after a phantom
   *  exit. Extracted as a protected method so unit tests can subclass
   *  `WslRunner` and spy on calls without spawning a real Node process. */
  protected respawnForPhantomExit(): void {
    this.spawnPtyHost('', '', this._logPath ?? '', true);
  }

  /** BUG-22 Step 3: shared handler for both the host-process exit and the
   *  inner-PTY `exit` message. Branches between a silent reconnect (when
   *  tmux is still alive and we're under the reconnect-loop cap) and the
   *  real teardown-and-emit path.
   *
   *  The silent-reconnect path is what hides the phantom `wsl.exe tmux
   *  attach` exits documented in BUG-22 — those exits leave the tmux session
   *  fully alive but used to surface as `crashed → auto_restart`, bumping
   *  `restart_count` and flashing "Restarts: 1" in the UI for what was
   *  really a healthy launch. We now check the tmux side first and respawn
   *  the attach with no exit emit / no JSONL diagnostic / no scrollback
   *  flush, so the supervisor and UI see a single uninterrupted run.
   *
   *  When tmux is genuinely gone, or when the rolling-window reconnect cap
   *  is exceeded, we fall through to the existing teardown path so a real
   *  failure still surfaces.
   */
  private async _handleHostExit(
    exitCode: number | null,
    signal: NodeJS.Signals | string | null,
    source: 'host' | 'inner-pty',
  ): Promise<void> {
    if (!this._alive) {
      // Already torn down by a prior exit (e.g. inner-PTY exit handled first,
      // host.on('exit') firing as the host process winds down afterward).
      // Clear the host reference and bail.
      this.host = null;
      return;
    }

    if (!this._intentionalKill) {
      const now = this._now();
      const windowStart = now - WslRunner.PHANTOM_RECONNECT_WINDOW_MS;
      this._phantomReconnectTimestamps = this._phantomReconnectTimestamps.filter(
        (t) => t >= windowStart,
      );

      if (this._phantomReconnectTimestamps.length < WslRunner.MAX_PHANTOM_RECONNECTS_PER_MIN) {
        let tmuxAlive = false;
        try {
          tmuxAlive = await this._isTmuxSessionAlive(this.sessionName);
        } catch (err) {
          console.warn(`[pty-host:${this.sessionName}] isTmuxSessionAlive threw, treating as dead:`, err);
        }
        if (tmuxAlive) {
          console.log(
            `[pty-host:${this.sessionName}] phantom exit (code ${exitCode}) but tmux alive — silently reconnecting`,
          );
          this._phantomReconnectTimestamps.push(now);

          const oldHost = this.host;
          this.host = null;
          if (oldHost) {
            // Detach the old host's exit listener so the kill below doesn't
            // re-enter _handleHostExit and trigger an unwanted second reconnect.
            // For the 'host' source we're inside that listener's callback —
            // removing future invocations is still correct.
            oldHost.removeAllListeners('exit');
            if (source === 'inner-pty' && !oldHost.killed) {
              // The inner PTY exited but the host script itself keeps
              // running until it's told to die. Kill it so we don't leak.
              oldHost.kill();
            }
          }
          this.respawnForPhantomExit();
          return;
        }
      } else {
        console.warn(
          `[pty-host:${this.sessionName}] phantom reconnect cap reached ` +
          `(${WslRunner.MAX_PHANTOM_RECONNECTS_PER_MIN} within ${WslRunner.PHANTOM_RECONNECT_WINDOW_MS}ms) ` +
          `— treating exit (code ${exitCode}) as a real crash`,
        );
      }
    }

    // True crash / intentional kill / cap-exceeded path. Real exit codes flow
    // through unmangled — the prior `|| 137` coercion existed to disguise
    // clean inner-PTY exits as SIGKILL so the dashboard wouldn't mark them
    // `done`; now that the silent-reconnect path absorbs those phantom clean
    // exits, real exit codes deserve their real values.
    this._alive = false;
    this.logStream?.end();
    this.logStream = null;
    this.persistScrollback();
    const reportedCode = this._intentionalKill ? 0 : (exitCode ?? 1);
    this.writeLaunchRecord(reportedCode, signal == null ? null : String(signal));
    this.emit('exit', reportedCode, signal);

    // Inner-PTY exit leaves the host script running on its own; clean it up.
    // For source='host' the process already exited, so the kill is a no-op.
    if (source === 'inner-pty' && this.host && !this.host.killed) {
      this.host.kill();
    }
    this.host = null;
  }

  /**
   * Reconnect to an existing tmux session (after dashboard restart).
   */
  reconnect(logPath: string): void {
    this.spawnPtyHost('', '', logPath, true);
  }

  private spawnPtyHost(workDir: string, command: string, logPath: string, reconnect: boolean): void {
    if (this.host) return;

    const logDir = path.dirname(logPath);
    if (logPath && !fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    if (logPath) {
      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      this._logPath = logPath;
    }

    const ptyHostPath = getScriptPath('pty-host.js');

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;

    this.host = spawn('node', [ptyHostPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.host.stderr?.setEncoding('utf-8');
    this.host.stderr?.on('data', (chunk: string) => {
      console.error(`[pty-host:${this.sessionName}] ${chunk.trim()}`);
    });

    this.host.stdout?.setEncoding('utf-8');
    this.host.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch {}
      }
    });

    this.host.on('exit', (code) => {
      console.log(`[pty-host:${this.sessionName}] exited with code ${code}`);
      // BUG-22 Step 3: route through `_handleHostExit` so the host-process
      // exit path shares the silent-reconnect check with the inner-PTY
      // `exit` message path. The EventEmitter doesn't await the returned
      // promise, which is fine — nothing further depends on its completion.
      void this._handleHostExit(code, null, 'host');
    });

    // Build the WSL command. Both fresh-launch and reconnect attach to a tmux
    // session by name; `buildTmuxAttachCmd` wraps the attach in a short
    // `tmux has-session` poll so the cold-launch create→attach race documented
    // in plans/bug-supervisor-wsl-launch-investigation.md doesn't surface as a
    // phantom `crashed (exitCode:1) → auto_restart` cycle. Reconnect can use
    // the same shape — if the session is already up (the common case), the
    // poll exits on iteration 1.
    const bashCmd = buildTmuxAttachCmd(this.sessionName);

    this.sendToHost({
      type: 'spawn',
      command: 'wsl.exe',
      args: ['bash', '-lc', bashCmd],
      cols: 120,
      rows: 40,
    });
    // BUG-22 Step 1: record that the attach was attempted so the diagnostic
    // JSONL distinguishes "attach exited with code N" from "attach never
    // started" (e.g. pty-host failed to fork). The reconnect path also passes
    // through here, but reconnects don't carry diagnostics so writeLaunchRecord
    // is a no-op for them.
    this._attachAttempted = true;

    this._alive = true;
    this._lastOutputTime = Date.now();
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'data':
        // BUG-13 Path B: gate the raw output timestamp on meaningful content
        // (mirrors windows-runner.ts) so ghost-text-only PTY redraws don't
        // block legitimate `working → idle` downgrades.
        if (this.hasMeaningfulContent(msg.data)) {
          this._lastOutputTime = Date.now();
          const now = Date.now();
          if (now - this._outputWindowStart > 3000) {
            this._outputWindowStart = now;
            this._recentOutputBytes = 0;
          }
          this._recentOutputBytes += msg.data.length;
          // P1B-03: during the attach ignore window, count bytes for the
          // rolling 3s window but do NOT advance the meaningful-burst
          // timestamp — a TUI redraw on attach is not real activity.
          if (this._recentOutputBytes > 200 && now >= this._ignoreBurstUntil) {
            this._lastMeaningfulBurst = now;
          }
        }
        this.logStream?.write(msg.data);
        // P2-02: feed the ring buffer for PromptPatternDetector. Same
        // partial-line handling as WindowsRunner so a chunk ending mid-line
        // doesn't fragment the next-arriving prompt across two ring entries.
        {
          const newLines = msg.data.split('\n');
          if (this.outputRing.length > 0 && newLines.length > 0) {
            this.outputRing[this.outputRing.length - 1] += newLines[0];
            for (let i = 1; i < newLines.length; i++) {
              this.outputRing.push(newLines[i]);
            }
          } else {
            this.outputRing.push(...newLines);
          }
          this.outputRingBytes += msg.data.length;
          // BUG-15: trim by line cap AND byte cap; tighter cap wins.
          while (
            this.outputRing.length > WslRunner.MAX_RING_LINES ||
            this.outputRingBytes > WslRunner.MAX_RING_BYTES
          ) {
            const dropped = this.outputRing.shift();
            if (dropped === undefined) break;
            this.outputRingBytes -= dropped.length + 1;
            if (this.outputRingBytes < 0) this.outputRingBytes = 0;
          }
        }
        this.emit('data', msg.data);
        break;

      case 'pid':
        this._pid = msg.pid;
        console.log(`[pty-host:${this.sessionName}] PTY pid: ${msg.pid}`);
        break;

      case 'exit':
        console.log(`[pty-host:${this.sessionName}] PTY exited: code=${msg.exitCode} signal=${msg.signal}`);
        // BUG-22 Step 3: route through `_handleHostExit` so the inner-PTY
        // exit path shares the silent-reconnect check with the host-process
        // exit path. handleMessage stays synchronous — we don't await.
        void this._handleHostExit(msg.exitCode ?? null, msg.signal ?? null, 'inner-pty');
        break;

      case 'ready':
        console.log(`[pty-host:${this.sessionName}] ready`);
        break;

      case 'error':
        console.error(`[pty-host:${this.sessionName}] error: ${msg.error}`);
        break;
    }
  }

  private hasMeaningfulContent(data: string): boolean {
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                        .replace(/\x1b\][^\x07]*\x07/g, '')
                        .replace(/\x1b[()][0-9A-Z]/g, '')
                        .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '')
                        .replace(/[\x00-\x1f]/g, '');
    const trimmed = stripped.trim();
    if (trimmed.length === 0) return false;
    // BUG-13 Path B: ghost-text-only redraws carry tiny payloads with no
    // newline; real output either spans a newline or comfortably exceeds the
    // per-event floor. The 200-byte rolling-burst gate above is preserved.
    return data.includes('\n') || trimmed.length >= 64;
  }

  async isStillAlive(): Promise<boolean> {
    // Check PTY host first
    if (this._alive && this.host) return true;
    // Fallback: check tmux session
    return isTmuxSessionAlive(this.sessionName);
  }

  async captureOutput(lines = 50): Promise<string> {
    return tmuxCapturePane(this.sessionName, lines);
  }

  /** P2-02: trailing bytes of the in-process ring buffer. Matches the
   *  Windows runner's shape; called from `StatusMonitor` via the
   *  `getOutputRingTail` collaborator so the PromptPatternDetector doesn't
   *  have to shell out to `tmux capture-pane` on every tick. */
  getOutputRingTail(maxBytes = 4096): string {
    if (this.outputRing.length === 0) return '';
    const joined = this.outputRing.join('\n');
    if (joined.length <= maxBytes) return joined;
    return joined.slice(joined.length - maxBytes);
  }

  /** BUG-15: return the entire ring buffer as a single string. Mirrors
   *  WindowsRunner.getFullRing — used by the terminal viewer's snapshot IPC. */
  getFullRing(): string {
    return this.outputRing.join('\n');
  }

  /** BUG-15: persist ring buffer to disk so the terminal viewer can recover
   *  scrollback after the runner has exited. */
  persistScrollback(): void {
    if (!this._logPath) return;
    try {
      fs.writeFileSync(`${this._logPath}.scrollback`, this.outputRing.join('\n'));
    } catch {
      // ignore — runner is shutting down
    }
  }

  /**
   * attach() is now a no-op for initial data flow (PTY runs from launch).
   * It exists so attachAgent() in the supervisor still works — the caller
   * just hooks up an onData listener via the returned bridge.
   */
  attach(): void {
    // If PTY host died but tmux session is still alive, reconnect
    if (!this.host) {
      console.log(`[WSL] Re-attaching to tmux session '${this.sessionName}'`);
      this.spawnPtyHost('', '', '', true);
    }
  }

  detach(): void {
    // No-op — we keep the PTY running so data keeps flowing.
    // The IPC layer handles adding/removing listeners.
  }

  private sendToHost(msg: any): void {
    if (this.host?.stdin?.writable) {
      this.host.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  /** Suppress meaningful-burst advances for `ms` milliseconds. Called by
   *  `AgentSupervisor.attachAgent` so the initial TUI redraw on attach does
   *  not flip the agent to 'working'. P1B-03. */
  markInteractionIgnoreWindow(ms = 750): void {
    this._ignoreBurstUntil = Date.now() + ms;
  }

  write(data: string): void {
    this.sendToHost({ type: 'write', data });
  }

  resize(cols: number, rows: number): void {
    this.sendToHost({ type: 'resize', cols, rows });
  }

  async kill(): Promise<void> {
    this._intentionalKill = true;
    this._alive = false;
    // BUG-15: persist ring buffer eagerly so a force-kill that bypasses the
    // pty-host exit handler still leaves a scrollback file for the viewer.
    this.persistScrollback();

    // Graceful shutdown attempt: try to save session state
    if (await isTmuxSessionAlive(this.sessionName)) {
      try {
        console.log(`[WSL] Gracefully stopping agent in '${this.sessionName}'...`);
        // Send Ctrl+C to interrupt any running generation/prompt
        await wslExec(`tmux send-keys -t '${this.sessionName}' C-c`);
        await new Promise(r => setTimeout(r, 500));
        
        // Send /exit to trigger clean shutdown and state save
        await wslExec(`tmux send-keys -t '${this.sessionName}' /exit Enter`);
        
        // Wait up to 3s for session to vanish (clean exit)
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (!(await isTmuxSessionAlive(this.sessionName))) {
            console.log(`[WSL] Agent exited cleanly.`);
            break;
          }
        }
      } catch (err) {
        console.warn(`[WSL] Graceful shutdown failed:`, err);
      }
    }

    // Kill the PTY host
    this.sendToHost({ type: 'kill' });
    setTimeout(() => {
      if (this.host && !this.host.killed) {
        this.host.kill();
      }
      this.host = null;
    }, 1000);
    this.logStream?.end();
    this.logStream = null;
    // Force kill the tmux session if it's still there
    await tmuxKillSession(this.sessionName);
  }
}
