import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { getPtyHostPath } from './paths';
import { sanitizeClaudeChildEnv } from './env-sanitize';
import { spawnBundledNode } from '../node-runtime';
import { ensureNodeShimDir, withNodeShimOnPath } from '../node-shim';
import { ensureGitShimDir } from '../git/git-shim';
import { readLastLines } from './log-readers/tail-file';

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
  // WP-1a delete-shutdown contract: once true, persistScrollback() is a no-op so
  // a post-kill `exit` handler can never recreate `.scrollback` after delete
  // (which would leak a sidecar the reclaim pass already unlinked).
  private _deleting: boolean = false;
  private buffer: string = '';
  // In-memory ring buffer for instant log retrieval (avoids fs.createWriteStream flush delays).
  // BUG-15: bumped from 500 lines to 10000 / 1MB so the terminal viewer can paint a useful
  // scrollback snapshot on mount. Both caps apply — the tighter one wins.
  // Scrollback-persistence bump: 10k/1MB truncated long supervisor sessions —
  // the snapshot painted on a fresh mount (or after an app restart) showed only
  // the tail. Raised to 50k lines / 8 MB to align with the renderer's 50k-line
  // xterm scrollback (so the repaint isn't dropped) while keeping the on-mount
  // paint cost bounded. Both caps apply — the tighter one wins.
  private outputRing: string[] = [];
  private outputRingBytes: number = 0;
  private static readonly MAX_RING_LINES = 50000;
  private static readonly MAX_RING_BYTES = 8_000_000;
  private _logPath: string | null = null;
  private _dataCount: number = 0;
  private _totalBytes: number = 0;

  // WP-3a — log byte-offset instrumentation + epoch. The append-only `.log` is
  // the durable PTY record; its byte offset is a lightweight replay cursor for
  // the renderer's exact-once rehydrate. All of this state is reset atomically
  // at every log-stream open (`_resetLogEpoch`) so a reused runner instance can
  // never carry a stale offset into a new stream.
  //   _logBaseOffset     the file's byte size when this stream opened (append base)
  //   _logBytesWritten   cumulative UTF-8 bytes handed to this stream since open
  //   _lastFlushedOffset highest CONTIGUOUS successfully-flushed prefix offset
  //   _writeErrored      once true, offset↔file mapping is permanently degraded
  //                      this epoch (recovery falls back to the ring snapshot)
  //   _lastWriteFlushed  settles when the most-recent queued write's callback ran
  //   _epoch             opaque per-stream id; a new stream ⇒ a new epoch
  private _logBaseOffset: number = 0;
  private _logBytesWritten: number = 0;
  private _lastFlushedOffset: number = 0;
  private _writeErrored: boolean = false;
  private _lastWriteFlushed: Promise<void> = Promise.resolve();
  private _epoch: string = '';

  get pid(): number | null {
    return this._pid;
  }

  /** BUG-09 §3.5 — last time a sustained meaningful-content burst landed
   *  (>200 stripped bytes within a 3 s window). Used to promote `idle → working`.
   *  Stays stale during Claude TUI Coalescing / spinner-only phases.
   *
   *  Renamed from `lastOutputTime` — the prior name was a misnomer (it has
   *  always returned `_lastMeaningfulBurst`, not `_lastOutputTime`) and the
   *  bug-09 investigation tripped on it. */
  get lastMeaningfulBurstTime(): number {
    return this._lastMeaningfulBurst;
  }

  /** BUG-09 §3.5 — raw PTY-output timestamp, advanced by every `data` event
   *  (spinner redraws included). Used to keep a `working` latch alive: as
   *  long as the PTY is emitting *anything* — even single-glyph spinner
   *  redraws — we should not downgrade `working → idle`. Complementary to
   *  {@link lastMeaningfulBurstTime}. */
  get lastRawOutputTime(): number {
    return this._lastOutputTime;
  }

  get isAlive(): boolean {
    return this._alive;
  }

  launch(workDir: string, command: string, args: string[], logPath: string, directSpawn = false, extraEnv?: Record<string, string>): void {
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    this._logPath = logPath;
    // WP-3a: a fresh WindowsRunner is minted per launch, so this always opens a
    // brand-new stream — reset the offset/epoch state to the file's current
    // (append) size and emit a new epoch.
    this._resetLogEpoch();

    // The pty-host helper ships inside the app bundle (dist/ → app.asar), so its
    // `require('node-pty')` resolves through our own module tree.
    const ptyHostPath = getPtyHostPath();

    // Spawn pty-host on the runtime we ship — Electron-as-Node, never a system
    // `node` (F3). `extraEnv` is merged in so callers can inject
    // provider-specific vars (e.g. BUG-13 Path A sets
    // CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false on Claude launches). pty-host
    // builds the PTY child's env from its own process.env, so anything we set
    // here reaches the PTY child. Sanitized AFTER the merge so child-session
    // markers can't sneak back in via extraEnv
    // (docs/BUG_claude-child-session-env-poisoning.md), and sanitized BEFORE
    // spawnBundledNode adds ELECTRON_RUN_AS_NODE so the sanitizer can never
    // strip the flag the helper needs. pty-host itself deletes that marker
    // again before it spawns the PTY child (plan §5.3).
    let env = sanitizeClaudeChildEnv({ ...process.env, ...(extraEnv || {}) });

    // Bundled-node-exposure plan §1.3: APPEND the userData node-shim dir to the
    // pty-host's PATH so a Node-free Windows machine still resolves `node` for
    // hook / statusLine subprocesses. Appended → any real project/system node
    // keeps precedence (§0.3). pty-host builds the PTY child env from its own
    // process.env (deleting ELECTRON_RUN_AS_NODE first), so this shim dir
    // transparently reaches the provider CLI and its hooks — no pty-host edit.
    try {
      env = withNodeShimOnPath(env, ensureNodeShimDir());
      // Git-Native WP-G0.4: drop a `git` shim into that SAME (already-appended)
      // dir, but only when Lares fell back to bundled git. Async resolution →
      // fire-and-forget; the shim is consumed only when the agent later runs
      // `git`, and ensureGitShimDir never rejects.
      void ensureGitShimDir();
    } catch (err) {
      // Retry failed. Don't pretend hooks will work, but don't block the launch
      // either (the agent is still usable for MCP-tool work per the VM report).
      // Surface it honestly: the console is the signal.
      console.error(`[node-shim] shim unavailable for ${workDir}; hooks may fail if no system node:`, err);
    }

    this.host = spawnBundledNode(ptyHostPath, [], { env });

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
        this.persistScrollback();
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
        // BUG-13 Path B: gate the raw output timestamp on meaningful content
        // so a ghost-text-only redraw (cursor save + tiny payload + cursor
        // restore, no newline) doesn't keep `_lastRawOutputTime` fresh and
        // silently block legitimate `working → idle` downgrades.
        if (this.hasMeaningfulContent(msg.data)) {
          this._lastOutputTime = Date.now();
          // Track output volume to distinguish active generation from idle echo.
          // When Claude is working, it streams lots of text quickly (>200 bytes in 3s).
          // User keystrokes echo back as tiny chunks.
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
        // WP-3a: byte-offset instrumentation + per-write barrier. `endOff` is
        // the LOGICAL PTY cursor (base + cumulative UTF-8 bytes); it advances
        // unconditionally so the renderer can dedup live events by offset. The
        // write callback advances `_lastFlushedOffset` only on the contiguous
        // successful prefix — a single write error permanently degrades this
        // epoch's offset↔file mapping and never advances the flushed cutoff.
        const n = Buffer.byteLength(msg.data, 'utf8');
        this._logBytesWritten += n;
        const endOff = this._logBaseOffset + this._logBytesWritten;
        this._lastWriteFlushed = new Promise<void>((res) => {
          if (!this.logStream) return res();
          this.logStream.write(msg.data, (err) => {
            if (err) {
              this._writeErrored = true;               // permanent for this epoch
            } else if (!this._writeErrored) {
              this._lastFlushedOffset = endOff;         // never advance past the first failed write
            }
            res();                                      // settle, never hang
          });
        });
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
        this.outputRingBytes += msg.data.length;
        // Trim ring buffer to BOTH line and byte caps; tighter cap wins.
        while (
          this.outputRing.length > WindowsRunner.MAX_RING_LINES ||
          this.outputRingBytes > WindowsRunner.MAX_RING_BYTES
        ) {
          const dropped = this.outputRing.shift();
          if (dropped === undefined) break;
          this.outputRingBytes -= dropped.length + 1; // +1 for the join newline
          if (this.outputRingBytes < 0) this.outputRingBytes = 0;
        }
        // WP-3a: forward the logical end offset alongside the data. Consumers
        // that ignore the extra arg (status/file trackers) are unaffected.
        this.emit('data', msg.data, endOff);
        break;

      case 'pid':
        this._pid = msg.pid;
        console.log(`[WindowsRunner] PTY pid: ${msg.pid}`);
        // D4 ownership: the root PID arrives asynchronously from the pty host, so
        // surface it as an event for the supervisor to record durable ownership.
        this.emit('pid', msg.pid);
        break;

      case 'exit':
        this._alive = false;
        this.logStream?.end();
        this.logStream = null;
        this.persistScrollback();
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
    const trimmed = stripped.trim();
    if (trimmed.length === 0) return false;
    // BUG-13 Path B: a ghost-text-only burst (e.g. Claude Code rendering
    // `❯ commit this` as a grey suggestion) carries a tiny payload inside
    // cursor save/restore wrappers and never contains a newline. Real
    // assistant streaming, tool output, and paste payloads either ship a
    // newline-bearing chunk or push well above the per-event byte floor.
    // The 200-byte rolling-burst threshold above is preserved as a second
    // line of defense.
    return data.includes('\n') || trimmed.length >= 64;
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

  /** BUG-15: return the entire ring buffer as a single string. The terminal
   *  viewer calls this on mount via the `getRingBuffer` IPC to paint the
   *  initial scrollback before subscribing to live data. */
  getFullRing(): string {
    return this.outputRing.join('\n');
  }

  /** Layer-3 memory telemetry: O(1) reads of this runner's retained terminal RAM
   *  ring. `outputRingBytes` is the running byte sum maintained on append/trim. */
  get ringBytes(): number { return this.outputRingBytes; }
  get ringLines(): number { return this.outputRing.length; }

  /** WP-3a: the current LOGICAL PTY cursor (append base + cumulative UTF-8
   *  bytes handed to the stream this epoch). Not proven durable — that is what
   *  `logWriteBarrier` is for. */
  get currentLogOffset(): number { return this._logBaseOffset + this._logBytesWritten; }

  /** WP-3a: opaque per-stream epoch id. A new stream (launch) ⇒ a new epoch. */
  get terminalEpoch(): string { return this._epoch; }

  /** WP-3a: false once any write in this epoch errored — the byte offset can no
   *  longer be trusted as a `.log` replay position (degraded recovery only). */
  get logOffsetsReliable(): boolean { return !this._writeErrored; }

  /** WP-3a: reset all offset/epoch state to the file's current (append) size and
   *  mint a fresh epoch. Called at every log-stream open, AFTER the previous
   *  stream has closed, so a reused runner instance can never carry a stale
   *  offset forward. Emits `epochChanged` so the supervisor updates its
   *  `lastTerminalEpoch` map synchronously. */
  private _resetLogEpoch(): void {
    let base = 0;
    try { if (this._logPath) base = fs.statSync(this._logPath).size; } catch { base = 0; }
    this._logBaseOffset = base;
    this._logBytesWritten = 0;
    this._lastFlushedOffset = base;
    this._writeErrored = false;
    this._lastWriteFlushed = Promise.resolve();
    this._epoch = randomUUID();
    this.emit('epochChanged', this._epoch);
  }

  /** WP-3a: returns a cutoff PROVEN readable from a fresh fd (the highest
   *  contiguous flushed prefix), plus a degraded flag when any write in this
   *  epoch errored. Captures the pending-write promise SYNCHRONOUSLY before
   *  yielding so a write racing the await cannot change the returned cutoff; a
   *  write error settles the per-write promise (never rejects/hangs). Never
   *  certifies a logical offset as durable. */
  async logWriteBarrier(): Promise<{ cutoff: number; degraded: boolean }> {
    const pending = this._lastWriteFlushed;   // synchronous capture
    await pending;
    return { cutoff: this._lastFlushedOffset, degraded: this._writeErrored };
  }

  /** WP-3a: atomically capture the in-memory ring text AND the current logical
   *  PTY cursor in one synchronous step (call AFTER the live listener is
   *  installed). Used only by degraded recovery, where `.log` byte offsets are
   *  no longer a valid replay position. */
  getRingSnapshot(): { text: string; logicalCutoff: number } {
    return { text: this.outputRing.join('\n'), logicalCutoff: this.currentLogOffset };
  }

  /** BUG-15: write the current ring contents to disk so the terminal viewer
   *  can recover scrollback after the runner has exited. Best-effort — any
   *  error is swallowed (the agent is being torn down anyway). */
  persistScrollback(): void {
    // WP-1a: never recreate `.scrollback` once a delete is in flight — the
    // reclaim pass has already (or is about to) unlink it.
    if (this._deleting) return;
    if (!this._logPath) return;
    try {
      fs.writeFileSync(`${this._logPath}.scrollback`, this.outputRing.join('\n'));
    } catch {
      // ignore — runner is shutting down
    }
  }

  /** Return the last N lines from the in-memory ring buffer (instant, no disk I/O). */
  async captureOutput(lines = 50): Promise<string> {
    // If ring buffer is empty, fall back to log file for initial data
    if (this.outputRing.length === 0 && this.logStream) {
      // Ring buffer empty — read the tail of the log file directly.
      // WP-2: bounded backward-paged reader (was a whole-file readFileSync).
      const logPath = (this.logStream as any).path as string;
      if (logPath) {
        try {
          return await readLastLines(logPath, lines);
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

  /** Ask claude.exe to exit cleanly so it finishes its final ~/.claude.json
   *  write before the process dies. Resolves true on clean exit, false if we
   *  had to fall back to kill(). Claude-provider runners only — /exit into a
   *  codex/gemini TUI is undefined behavior. */
  async gracefulExit(timeoutMs = 4000): Promise<boolean> {
    if (!this._alive || !this.host) return true;
    this._intentionalKill = true;
    this.persistScrollback();
    // Esc clears any half-typed input or open menu; the pauses keep the
    // slash-command autocomplete from racing the keystrokes (same two-step
    // shape as WslRunner's tmux graceful path, wsl-runner.ts:777-781).
    this.write('\x1b');
    await new Promise(r => setTimeout(r, 150));
    this.write('/exit');
    await new Promise(r => setTimeout(r, 150));
    this.write('\r');
    const exited = await new Promise<boolean>(resolve => {
      const t = setTimeout(() => { this.removeListener('exit', onExit); resolve(false); }, timeoutMs);
      const onExit = () => { clearTimeout(t); resolve(true); };
      this.once('exit', onExit);
    });
    if (!exited) this.kill();
    return exited;
  }

  /** WP-1a delete-shutdown contract. Tears the runner down for a permanent
   *  delete: blocks any later `persistScrollback()`, closes the log stream so
   *  the OS releases the file handle before the reclaim pass unlinks it, then
   *  kills the pty-host. Resolves only after the log stream has fully closed so
   *  the caller can safely unlink `.log` immediately afterward. */
  async disposeForDelete(): Promise<void> {
    this._deleting = true;                 // blocks any later persistScrollback()
    this._intentionalKill = true;
    this._alive = false;
    this.sendToHost({ type: 'kill' });
    await this.closeLogStream();
    if (this.host && !this.host.killed) this.host.kill();
    this.host = null;
  }

  /** Settles exactly once on finish|close|error — never hangs delete on stream
   *  failure. */
  private closeLogStream(): Promise<void> {
    return new Promise((resolve) => {
      const s = this.logStream; this.logStream = null;
      if (!s) return resolve();
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      s.once('finish', fin); s.once('close', fin); s.once('error', fin); s.end();
    });
  }

  kill(): void {
    this._intentionalKill = true;
    this._alive = false;
    // BUG-15: persist scrollback eagerly. The pty-host's exit handler also
    // calls persistScrollback, but kill() may force-terminate the host before
    // that handler runs — write here so we never lose the snapshot.
    this.persistScrollback();
    this.sendToHost({ type: 'kill' });
    setTimeout(() => {
      if (this.host && !this.host.killed) {
        this.host.kill();
      }
      this.host = null;
    }, 1000);
  }
}
