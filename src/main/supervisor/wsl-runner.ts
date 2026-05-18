import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import path from 'path';
import { tmuxNewSession, tmuxKillSession, isTmuxSessionAlive, tmuxCapturePane, wslExec } from '../wsl-bridge';
import { getScriptPath } from './paths';

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

  constructor(sessionName: string) {
    super();
    this.sessionName = sessionName;
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
   */
  async launch(workDir: string, command: string, logPath: string): Promise<void> {
    // Kill any stale tmux session with the same name (leftover from previous app run)
    if (await isTmuxSessionAlive(this.sessionName)) {
      console.log(`[WSL] Killing stale tmux session '${this.sessionName}'`);
      await tmuxKillSession(this.sessionName);
    }

    // Create tmux session for persistence (agent survives dashboard restart)
    // No tee needed — the PTY logStream captures output directly
    try {
      await tmuxNewSession(this.sessionName, workDir, command);
      console.log(`[WSL] Created tmux session '${this.sessionName}'`);
    } catch (err) {
      console.error(`[WSL] Failed to create tmux session:`, err);
      // Continue anyway — we'll run directly in PTY
    }

    // Now spawn the PTY that attaches to the tmux session for live terminal output
    this.spawnPtyHost(workDir, command, logPath, false);
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
      if (this._alive) {
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        this.persistScrollback();
        const reportedCode = this._intentionalKill ? 0 : ((code ?? 1) || 137);
        this.emit('exit', reportedCode, null);
      }
      this.host = null;
    });

    // Build the WSL command
    let bashCmd: string;
    if (reconnect) {
      // Reconnect: attach to existing tmux session
      bashCmd = `tmux attach -t '${this.sessionName}'`;
    } else {
      // Fresh launch: attach to the tmux session we just created
      bashCmd = `tmux attach -t '${this.sessionName}'`;
    }

    this.sendToHost({
      type: 'spawn',
      command: 'wsl.exe',
      args: ['bash', '-lc', bashCmd],
      cols: 120,
      rows: 40,
    });

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
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        this.persistScrollback();
        {
          const reportedCode = this._intentionalKill ? 0 : ((msg.exitCode ?? 1) || 137);
          this.emit('exit', reportedCode, msg.signal);
        }
        if (this.host && !this.host.killed) {
          this.host.kill();
        }
        this.host = null;
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
