import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { getScriptPath } from './paths';

/**
 * Spawns Claude via a separate Node.js process that uses node-pty.
 * This avoids Electron's native module mismatch — node-pty works
 * under regular Node but not under Electron without VS Build Tools rebuild.
 */
export class WindowsRunner extends EventEmitter {
  private host: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
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
  // In-memory ring buffer for instant log retrieval (avoids fs.createWriteStream flush delays)
  private outputRing: string[] = [];
  private static readonly MAX_RING_LINES = 500;
  private _dataCount: number = 0;
  private _totalBytes: number = 0;

  get pid(): number | null {
    return this._pid;
  }

  /** Time of last sustained output burst (Claude actively generating) */
  get lastOutputTime(): number {
    return this._lastMeaningfulBurst;
  }

  get isAlive(): boolean {
    return this._alive;
  }

  launch(workDir: string, command: string, args: string[], logPath: string, directSpawn = false): void {
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });

    // Find the pty-host script
    const ptyHostPath = getScriptPath('pty-host.js');

    // Spawn pty-host under regular Node.js (not Electron)
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;

    this.host = spawn('node', [ptyHostPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
        } catch {
          // ignore parse errors
        }
      }
    });

    this.host.stderr?.on('data', (data: Buffer) => {
      console.error('[pty-host stderr]', data.toString());
    });

    this.host.on('exit', () => {
      if (this._alive) {
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        const reportedCode = this._intentionalKill ? 0 : 137;
        this.emit('exit', reportedCode, null);
      }
      this.host = null;
    });

    // Send spawn command
    this.sendToHost({
      type: 'spawn',
      command,
      args,
      cwd: workDir,
      cols: 120,
      rows: 40,
      directSpawn,
    });

    this._alive = true;
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'data':
        this._dataCount++;
        this._totalBytes += (msg.data?.length || 0);
        if (this._dataCount === 1 || this._dataCount === 10 || this._dataCount === 100) {
          console.log(`[WindowsRunner] data event #${this._dataCount}, total ${this._totalBytes} bytes, ring ${this.outputRing.length} lines`);
        }
        this._lastOutputTime = Date.now();
        // Track output volume to distinguish active generation from idle echo.
        // When Claude is working, it streams lots of text quickly (>200 bytes in 3s).
        // User keystrokes echo back as tiny chunks.
        if (this.hasMeaningfulContent(msg.data)) {
          const now = Date.now();
          if (now - this._outputWindowStart > 3000) {
            // Start a new measurement window
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
        // Append to in-memory ring buffer for instant log reads
        const newLines = msg.data.split('\n');
        if (this.outputRing.length > 0 && newLines.length > 0) {
          // Append first chunk to last existing line (partial line continuation)
          this.outputRing[this.outputRing.length - 1] += newLines[0];
          for (let i = 1; i < newLines.length; i++) {
            this.outputRing.push(newLines[i]);
          }
        } else {
          this.outputRing.push(...newLines);
        }
        // Trim ring buffer
        if (this.outputRing.length > WindowsRunner.MAX_RING_LINES) {
          this.outputRing.splice(0, this.outputRing.length - WindowsRunner.MAX_RING_LINES);
        }
        this.emit('data', msg.data);
        break;

      case 'pid':
        this._pid = msg.pid;
        console.log(`[WindowsRunner] PTY pid: ${msg.pid}`);
        break;

      case 'exit':
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        {
          const reportedCode = this._intentionalKill ? 0 : ((msg.exitCode ?? 1) || 137);
          this.emit('exit', reportedCode, msg.signal);
        }
        // Kill the host process too
        if (this.host && !this.host.killed) {
          this.host.kill();
        }
        this.host = null;
        break;

      case 'ready':
        console.log('[WindowsRunner] pty-host ready');
        break;
    }
  }

  private hasMeaningfulContent(data: string): boolean {
    // Strip ANSI escape sequences and control characters
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences
                        .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC sequences
                        .replace(/\x1b[()][0-9A-Z]/g, '')         // Character set
                        .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '') // Mode changes
                        .replace(/[\x00-\x1f]/g, '');              // Control chars
    return stripped.trim().length > 0;
  }

  private sendToHost(msg: any): void {
    if (this.host?.stdin?.writable) {
      this.host.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  /** P2-02: return the trailing `maxBytes` bytes of the ring buffer joined as
   *  one string. Used by the PromptPatternDetector via StatusMonitor — pattern
   *  matching against the tail of the live PTY without disk I/O. */
  getOutputRingTail(maxBytes = 4096): string {
    if (this.outputRing.length === 0) return '';
    const joined = this.outputRing.join('\n');
    if (joined.length <= maxBytes) return joined;
    return joined.slice(joined.length - maxBytes);
  }

  /** Return the last N lines from the in-memory ring buffer (instant, no disk I/O). */
  captureOutput(lines = 50): string {
    // If ring buffer is empty, fall back to log file for initial data
    if (this.outputRing.length === 0 && this.logStream) {
      // Ring buffer empty — try reading last bytes from log file directly
      const logPath = (this.logStream as any).path as string;
      if (logPath && fs.existsSync(logPath)) {
        try {
          const content = fs.readFileSync(logPath, 'utf-8');
          const allLines = content.split('\n');
          return allLines.slice(-lines).join('\n');
        } catch { /* ignore */ }
      }
    }
    const start = Math.max(0, this.outputRing.length - lines);
    return this.outputRing.slice(start).join('\n');
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

  kill(): void {
    this._intentionalKill = true;
    this._alive = false;
    this.sendToHost({ type: 'kill' });
    setTimeout(() => {
      if (this.host && !this.host.killed) {
        this.host.kill();
      }
      this.host = null;
    }, 1000);
  }
}
