// P1 work item C — dashboard-side spool tailer
// (plans/p1-hook-spool-multi-transport.md §3).
//
// The v7 hook script ALWAYS appends its event record to
// <workspace>/.lares/pending-status.jsonl (transport 1). This tailer
// polls that file once per StatusMonitor tick (driven by the supervisor's
// single hook-transport poller — never per-agent) and forwards every
// complete, well-formed record to the supervisor's central applier.
//
// Hard rules (per plan):
//   - The tailer NEVER dedupes — that is applyHookStatusEvent's job.
//   - Poll-based stat/read, no fs.watch (unreliable on \\wsl.localhost UNC).
//   - Read errors are "no data this tick" (R3) — never crash the poll loop.
//   - No rotation/truncation in P1 (R2; consumed-then-truncate is racy with a
//     concurrently-appending hook). Truncate DETECTION only: size < offset →
//     reset offset, clear the partial buffer.

import fs from 'fs';
import path from 'path';
import { detectPathType, wslToWindowsPath } from '../path-utils';
import { workspaceStateDir } from '../workspace-state-dir';
import type { ParsedHookEvent } from './index';

/** Startup lookback window: at init the tailer seeks to
 *  max(0, size - 64 KB) and deliberately discards the first (possibly
 *  partial) line. */
export const SPOOL_LOOKBACK_BYTES = 64 * 1024;
/** During the startup lookback, only events younger than this apply. */
export const SPOOL_LOOKBACK_MAX_AGE_MS = 10 * 60_000;
/** Per-tick read cap — a monster delta finishes over a few ticks instead of
 *  blocking one. */
const MAX_BYTES_PER_DRAIN = 1024 * 1024;
const WARN_INTERVAL_MS = 30_000;

/** Resolve the WINDOWS-SIDE read path of a workspace's spool file. WSL
 *  workspaces (posix or already-UNC roots) map to the \\wsl... UNC form via
 *  the same path mapping the scaffolder/launch diagnostics use; Windows roots
 *  pass through. This is the path the tailer actually opens. */
export function resolveSpoolReadPath(workspaceRoot: string): string {
  const winRoot = detectPathType(workspaceRoot) === 'wsl' && workspaceRoot.startsWith('/')
    ? wslToWindowsPath(workspaceRoot)
    : workspaceRoot;
  return path.join(workspaceStateDir(winRoot), 'pending-status.jsonl');
}

/** Canonical map key for a spool read path. Tailer instances are keyed by
 *  this (NOT by workspace id) so the same logical workspace reached via
 *  Windows and WSL path forms can never spawn two tailers on one file or two
 *  files for one workspace. Normalizes separators, case (Windows paths are
 *  case-insensitive), and the \\wsl$\ ↔ \\wsl.localhost\ alias pair. */
export function canonicalSpoolKey(readPath: string): string {
  let p = path.normalize(readPath).toLowerCase();
  p = p.replace(/^\\\\wsl\$\\/, '\\\\wsl.localhost\\');
  return p;
}

export interface HookSpoolTailerDeps {
  /** Forward one complete parsed record. The supervisor's sink resolves the
   *  agent (drop if unknown / no live runner) and calls
   *  applyHookStatusEvent(agentId, record, 'spool'). */
  onRecord: (record: ParsedHookEvent) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class HookSpoolTailer {
  readonly readPath: string;
  private deps: HookSpoolTailerDeps;
  private now: () => number;

  private initialized = false;
  /** Byte offset of the next read. */
  private offset = 0;
  /** Partial-line buffer: the final non-newline-terminated tail of the last
   *  read. Kept as a Buffer so a multi-byte UTF-8 sequence split across two
   *  reads can't be corrupted by an early toString(). Only complete
   *  newline-terminated records are ever parsed. */
  private partial: Buffer = Buffer.alloc(0);
  /** True until the first complete line after a >64 KB startup seek has been
   *  discarded (it is, by construction, possibly partial). */
  private discardFirstLine = false;
  /** True while consuming the content that existed at init time — those
   *  records get the startup-lookback gates (10-min age bound + 'active'
   *  suppression). Cleared once the init-time size has been consumed. */
  private lookbackEndOffset = 0;
  private lastWarnAt = 0;

  constructor(readPath: string, deps: HookSpoolTailerDeps) {
    this.readPath = readPath;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    // Establish the startup position NOW, at creation (= worker launch) time,
    // so content appended AFTER the tailer exists is live, not lookback. A
    // confirmed-missing file (ENOENT) initializes at 0 with NO lookback —
    // a brand-new workspace's first SessionStart must apply normally. Any
    // other stat error (flaky UNC) leaves init for the first successful
    // drain, which conservatively treats the then-existing content as
    // historical.
    try {
      this.initFrom(fs.statSync(this.readPath).size);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.initFrom(0);
    }
  }

  private initFrom(size: number): void {
    this.initialized = true;
    if (size > SPOOL_LOOKBACK_BYTES) {
      // Seek into the tail; the first line we see is possibly partial —
      // deliberately discard it.
      this.offset = size - SPOOL_LOOKBACK_BYTES;
      this.discardFirstLine = true;
    } else {
      this.offset = 0;
      this.discardFirstLine = false;
    }
    // Everything that already exists is historical → lookback gates apply.
    this.lookbackEndOffset = size;
  }

  /** Drain any new complete records. Called once per StatusMonitor tick by
   *  the supervisor's hook-transport poller. Never throws — any fs error is
   *  "no data this tick" (R3: \\wsl.localhost can be slow/flaky). */
  drain(): void {
    try {
      this.drainInner();
    } catch (err) {
      this.warn(`spool read failed (treated as no data this tick): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private drainInner(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.readPath);
    } catch {
      // Missing file = no data. (A workspace that has never spooled.)
      return;
    }

    if (!this.initialized) {
      // Constructor-time stat failed with a non-ENOENT error (flaky UNC) —
      // initialize from the first successful stat instead.
      this.initFrom(st.size);
    }

    if (st.size < this.offset) {
      // Truncate-shrink detection: someone replaced/truncated the file.
      // Reset to the top and drop the partial — it belonged to the old file.
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      this.discardFirstLine = false;
      this.lookbackEndOffset = 0;
    }
    if (st.size === this.offset) return;

    let budget = MAX_BYTES_PER_DRAIN;
    const fd = fs.openSync(this.readPath, 'r');
    try {
      while (this.offset < st.size && budget > 0) {
        const want = Math.min(64 * 1024, st.size - this.offset, budget);
        const buf = Buffer.alloc(want);
        const got = fs.readSync(fd, buf, 0, want, this.offset);
        if (got <= 0) break;
        this.offset += got;
        budget -= got;
        this.consume(buf.subarray(0, got));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Split delta into complete newline-terminated lines; the final
   *  unterminated element becomes the new partial and is NEVER parsed. */
  private consume(chunk: Buffer): void {
    let data = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    let start = 0;
    while (true) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) break;
      const lineBuf = data.subarray(start, nl);
      // Byte position where this line ENDED (relative to consumed offset):
      // every byte up to and including this newline has been consumed from
      // `data`, whose tail end corresponds to this.offset.
      const lineEndOffset = this.offset - (data.length - (nl + 1));
      start = nl + 1;
      this.handleLine(lineBuf.toString('utf8'), lineEndOffset);
    }
    this.partial = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
  }

  private handleLine(rawLine: string, lineEndOffset: number): void {
    if (this.discardFirstLine) {
      // First complete line after the startup seek — possibly the tail half
      // of a record. Discard without parsing (plan §3).
      this.discardFirstLine = false;
      return;
    }
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) return;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.warn(`malformed spool line skipped (${line.length} chars)`);
      return;
    }
    if (record === null || typeof record !== 'object') {
      this.warn('non-object spool record skipped');
      return;
    }
    const ev = record as ParsedHookEvent;

    // Startup-lookback gates: a record that already existed at init time is
    // historical. Apply only fresh ones, and NEVER 'active' or 'waiting' — a
    // historical SessionStart proving an OLD launch loaded hooks must not stamp
    // the CURRENT launch healthy, and a stale replayed Notification 'waiting'
    // (launch/turn-specific, like the canary) must not resurrect an old wait at
    // startup. Fresh records read during normal tailing apply normally.
    if (lineEndOffset <= this.lookbackEndOffset) {
      if (ev.state === 'active' || ev.state === 'waiting') return;
      if (typeof ev.ts !== 'number' || ev.ts < this.now() - SPOOL_LOOKBACK_MAX_AGE_MS) return;
    }

    this.deps.onRecord(ev);
  }

  private warn(msg: string): void {
    const now = this.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    console.warn(`[hook-spool] ${this.readPath}: ${msg}`);
  }
}
