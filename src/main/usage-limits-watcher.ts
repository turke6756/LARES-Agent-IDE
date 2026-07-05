// Claude subscription usage-limits watcher (plans/usage-limits-mcp-and-ui.md).
//
// Watches each open workspace's `.dashboard/usage/latest.json` — the raw record
// written by the dashboard-statusline.mjs script — and maintains an account-wide
// per-window last-known state. The pure `toReading` projection is the unit-test
// seam; the class is the runtime glue (fs.watch + 300ms debounce + per-window
// merge) that emits a derived `UsageLimitsReading` on every change.

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type {
  UsageLimitsRawRecord,
  UsageLimitsReading,
  UsageWindowReading,
} from '../shared/types';
import { USAGE_LIMITS_STALE_MS } from '../shared/constants';

/** Per-window last-known state kept in memory by the watcher. `captured_at` is
 *  the observing record's `captured_at`, tracked PER WINDOW so a five-hour-only
 *  event never erases a known seven-day value (and vice versa). */
export interface UsageLastKnownWindow {
  used_percentage: number;
  resets_at: number;
  captured_at: number;
}

export interface UsageLastKnown {
  five_hour: UsageLastKnownWindow | null;
  seven_day: UsageLastKnownWindow | null;
}

/** Resolve the stale threshold: main-side env override DASHBOARD_USAGE_STALE_MS,
 *  else the shared default. Read per-call so tests / ops can flip it live. */
export function resolveStaleMs(): number {
  const env = process.env.DASHBOARD_USAGE_STALE_MS;
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) && n > 0 ? n : USAGE_LIMITS_STALE_MS;
}

/** Tolerant parse of a raw record file. Returns null on any malformation. */
export function parseRawRecord(text: string): UsageLimitsRawRecord | null {
  if (!text || !text.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Partial<UsageLimitsRawRecord>;
  if (typeof rec.captured_at !== 'number') return null;
  // Only accept windows that carry both numeric fields; drop malformed ones.
  const clean: UsageLimitsRawRecord = {
    schema: 1,
    source: 'claude_statusline',
    captured_at: rec.captured_at,
    session_id: typeof rec.session_id === 'string' ? rec.session_id : null,
    agent_id: typeof rec.agent_id === 'string' ? rec.agent_id : null,
    claude_project_dir: typeof rec.claude_project_dir === 'string' ? rec.claude_project_dir : null,
  };
  const fh = rec.five_hour;
  if (fh && typeof fh.used_percentage === 'number' && typeof fh.resets_at === 'number') {
    clean.five_hour = { used_percentage: fh.used_percentage, resets_at: fh.resets_at };
  }
  const sd = rec.seven_day;
  if (sd && typeof sd.used_percentage === 'number' && typeof sd.resets_at === 'number') {
    clean.seven_day = { used_percentage: sd.used_percentage, resets_at: sd.resets_at };
  }
  if (!clean.five_hour && !clean.seven_day) return null;
  return clean;
}

/** Defensive seconds→ms normalization. The harness sends `resets_at` in unix
 *  seconds; anything already ≥ 1e12 is treated as ms and passed through. */
export function normalizeResetsAt(v: number): number {
  return v < 1e12 ? v * 1000 : v;
}

function windowReading(w: UsageLastKnownWindow, now: number, staleMs: number): UsageWindowReading {
  const resets_at_ms = normalizeResetsAt(w.resets_at);
  return {
    used_percentage: w.used_percentage,
    resets_at: w.resets_at,
    resets_at_ms,
    resets_in_seconds: Math.max(0, (resets_at_ms - now) / 1000),
    captured_at: w.captured_at,
    age_seconds: Math.max(0, (now - w.captured_at) / 1000),
    stale: now - w.captured_at > staleMs,
  };
}

/** Pure projection from last-known state to the derived reading returned over
 *  IPC / the HTTP API / the MCP tool. Nothing known → `no_reading_yet`. */
export function toReading(
  lastKnown: UsageLastKnown,
  now: number,
  staleMs: number = resolveStaleMs(),
): UsageLimitsReading {
  const fh = lastKnown.five_hour ? windowReading(lastKnown.five_hour, now, staleMs) : null;
  const sd = lastKnown.seven_day ? windowReading(lastKnown.seven_day, now, staleMs) : null;
  if (!fh && !sd) {
    return { available: false, reason: 'no_reading_yet', account_wide: true };
  }
  const captured: number[] = [];
  if (lastKnown.five_hour) captured.push(lastKnown.five_hour.captured_at);
  if (lastKnown.seven_day) captured.push(lastKnown.seven_day.captured_at);
  const captured_at = Math.max(...captured);
  return {
    available: true,
    account_wide: true,
    source: 'claude_statusline',
    captured_at,
    age_seconds: Math.max(0, (now - captured_at) / 1000),
    stale: now - captured_at > staleMs,
    five_hour: fh,
    seven_day: sd,
  };
}

/** Per-window merge: for each window present in `rec` with a `captured_at` that
 *  is not older than the known value, replace it. Absent windows are untouched.
 *  Returns true if any window changed. Pure (mutates the passed lastKnown). */
export function mergeRawRecord(lastKnown: UsageLastKnown, rec: UsageLimitsRawRecord): boolean {
  let changed = false;
  if (rec.five_hour) {
    const prev = lastKnown.five_hour;
    if (!prev || rec.captured_at >= prev.captured_at) {
      lastKnown.five_hour = {
        used_percentage: rec.five_hour.used_percentage,
        resets_at: rec.five_hour.resets_at,
        captured_at: rec.captured_at,
      };
      changed = true;
    }
  }
  if (rec.seven_day) {
    const prev = lastKnown.seven_day;
    if (!prev || rec.captured_at >= prev.captured_at) {
      lastKnown.seven_day = {
        used_percentage: rec.seven_day.used_percentage,
        resets_at: rec.seven_day.resets_at,
        captured_at: rec.captured_at,
      };
      changed = true;
    }
  }
  return changed;
}

/** Watches every open workspace's usage dir and maintains an account-wide
 *  reading. Emits `'changed'` with a `UsageLimitsReading` on every merge. */
export class UsageLimitsWatcher extends EventEmitter {
  private lastKnown: UsageLastKnown = { five_hour: null, seven_day: null };
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  private usageDirFor(root: string): string {
    return path.join(root, '.dashboard', 'usage');
  }

  /** Idempotent. Ensures the usage dir exists, watches the PARENT dir (survives
   *  the script's atomic rename over latest.json), and does an initial read. */
  addWorkspace(root: string): void {
    if (this.closed || !root) return;
    const usageDir = this.usageDirFor(root);
    if (this.watchers.has(usageDir)) return;
    try {
      fs.mkdirSync(usageDir, { recursive: true });
    } catch {
      /* best-effort; may already exist */
    }
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(usageDir, (_event, filename) => {
        // filename can be null on some platforms; only skip when we know it is
        // a different file.
        if (filename && filename !== 'latest.json') return;
        this.scheduleRead(usageDir);
      });
    } catch {
      return; // dir unwatchable — capture is best-effort
    }
    watcher.on('error', () => {});
    this.watchers.set(usageDir, watcher);
    // Rebuild last-known from any file already on disk (restart caveat: only the
    // newest file is read, so a window absent from it stays unknown).
    this.scheduleRead(usageDir);
  }

  removeWorkspace(root: string): void {
    const usageDir = this.usageDirFor(root);
    const w = this.watchers.get(usageDir);
    if (w) {
      try {
        w.close();
      } catch {
        /* best-effort */
      }
      this.watchers.delete(usageDir);
    }
    const t = this.debounceTimers.get(usageDir);
    if (t) {
      clearTimeout(t);
      this.debounceTimers.delete(usageDir);
    }
  }

  private scheduleRead(usageDir: string): void {
    const existing = this.debounceTimers.get(usageDir);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      usageDir,
      setTimeout(() => {
        this.debounceTimers.delete(usageDir);
        this.readAndMerge(usageDir);
      }, 300),
    );
  }

  private readAndMerge(usageDir: string): void {
    if (this.closed) return;
    let text: string;
    try {
      text = fs.readFileSync(path.join(usageDir, 'latest.json'), 'utf8');
    } catch {
      return; // no file yet / transient read during rename
    }
    const rec = parseRawRecord(text);
    if (!rec) return;
    if (mergeRawRecord(this.lastKnown, rec)) {
      this.emit('changed', this.getReading());
    }
  }

  getReading(): UsageLimitsReading {
    return toReading(this.lastKnown, Date.now());
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        /* best-effort */
      }
    }
    this.watchers.clear();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}
