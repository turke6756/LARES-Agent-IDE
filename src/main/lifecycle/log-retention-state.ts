// Terminal-log retention — WP-5: durable scheduler state.
//
// A tiny JSON file under userData that outlives a restart so the 6-hour
// full-scan cadence is honored ACROSS process boundaries: the scheduler seeds
// its due time from `lastFullScanAt`, so a restart inside the window does not
// re-scan. It also carries the one-time first-sweep notice (the durable,
// dismissible global banner that surfaces the backlog clear).
//
// Two disciplines mirror `lifecycle-settings.ts`, and for the same reason —
// this file participates in a DELETION policy:
//   1. the write is ATOMIC (tmp + renameSync) so a crash mid-write can never
//      leave a truncated file that reads back as a bogus scan time;
//   2. the read VALIDATES the whole shape and falls back to DEFAULTS on
//      anything malformed rather than trusting whatever is on disk.
//
// The mutation helpers are split into PURE transforms (`applyFullScan`,
// `applyFirstSweepIfReclaimed`, `applyAcknowledge`) and thin disk-bound
// wrappers (`recordFullScan`, …). The scheduler composes the pure transforms
// against its INJECTED `readState`/`writeState` so it stays testable without
// touching a real filesystem; the wrappers exist for direct callers.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import type { LogRetentionState } from '../../shared/types';

export const DEFAULT_LOG_RETENTION_STATE: LogRetentionState = {
  lastFullScanAt: null,
  firstSweepNotice: null,
};

/** Injectable for tests; production resolves under Electron's userData. */
export function logRetentionStatePath(dir?: string): string {
  return path.join(dir ?? app.getPath('userData'), 'log-retention-state.json');
}

function isFirstSweepNotice(v: unknown): v is LogRetentionState['firstSweepNotice'] {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.completedAt === 'string' &&
    typeof o.agents === 'number' &&
    typeof o.bytes === 'number' &&
    (o.acknowledgedAt === null || typeof o.acknowledgedAt === 'string')
  );
}

/** Validate the full persisted shape. Field-independent is unnecessary here (a
 *  corrupt file is corrupt as a whole), but each field is still checked so a
 *  partially-mangled object never slips a wrong-typed value through. */
export function isLogRetentionState(v: unknown): v is LogRetentionState {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const lastOk = o.lastFullScanAt === null || typeof o.lastFullScanAt === 'string';
  return lastOk && isFirstSweepNotice(o.firstSweepNotice);
}

/**
 * Read the persisted state. ANY problem — missing file, unreadable file,
 * invalid JSON, wrong shape — yields the DEFAULT (both fields null). A corrupt
 * file must never seed a bogus `lastFullScanAt` (which would suppress a scan
 * forever) or a bogus notice.
 */
export function readState(dir?: string): LogRetentionState {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(logRetentionStatePath(dir), 'utf8'));
    if (isLogRetentionState(raw)) {
      // Reconstruct from validated fields (never hand back the raw object) so a
      // stray extra property can't ride along into memory.
      return {
        lastFullScanAt: raw.lastFullScanAt,
        firstSweepNotice: raw.firstSweepNotice
          ? {
              completedAt: raw.firstSweepNotice.completedAt,
              agents: raw.firstSweepNotice.agents,
              bytes: raw.firstSweepNotice.bytes,
              acknowledgedAt: raw.firstSweepNotice.acknowledgedAt,
            }
          : null,
      };
    }
  } catch { /* first run or unreadable — fall through to the default */ }
  return { ...DEFAULT_LOG_RETENTION_STATE };
}

/** Persist state atomically (tmp + rename). Best-effort: a write failure is
 *  logged and the tmp file cleaned; the next scan simply re-writes. */
export function writeState(state: LogRetentionState, dir?: string): void {
  const target = logRetentionStatePath(dir);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[retention] failed to persist log-retention state:', err);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

// ── Pure transforms (no IO) — the scheduler composes these against injected IO ─

/** Stamp the completed-pass time. Updated after EVERY completed scan. */
export function applyFullScan(state: LogRetentionState, nowIso: string): LogRetentionState {
  return { ...state, lastFullScanAt: nowIso };
}

/**
 * CREATE-ONCE first-sweep notice. Only when `bytes > 0` (a zero-byte scan
 * clears no backlog and raises no banner) and only when no notice exists yet —
 * the `agents`/`bytes` payload of the FIRST reclaiming sweep is preserved
 * verbatim and NEVER overwritten by a later sweep.
 */
export function applyFirstSweepIfReclaimed(
  state: LogRetentionState,
  notice: { completedAt: string; agents: number; bytes: number },
): LogRetentionState {
  if (notice.bytes <= 0) return state;         // nothing reclaimed → no banner
  if (state.firstSweepNotice) return state;    // create-once; never overwrite
  return {
    ...state,
    firstSweepNotice: {
      completedAt: notice.completedAt,
      agents: notice.agents,
      bytes: notice.bytes,
      acknowledgedAt: null,
    },
  };
}

/** Set ONLY the nested `acknowledgedAt` (banner dismissed). No-op when there is
 *  no notice yet. */
export function applyAcknowledge(state: LogRetentionState, nowIso: string): LogRetentionState {
  if (!state.firstSweepNotice) return state;
  return {
    ...state,
    firstSweepNotice: { ...state.firstSweepNotice, acknowledgedAt: nowIso },
  };
}

// ── Disk-bound convenience wrappers (read → transform → write) ────────────────

export function recordFullScan(nowIso: string, dir?: string): void {
  writeState(applyFullScan(readState(dir), nowIso), dir);
}

export function recordFirstSweepIfReclaimed(
  notice: { completedAt: string; agents: number; bytes: number },
  dir?: string,
): void {
  writeState(applyFirstSweepIfReclaimed(readState(dir), notice), dir);
}

export function acknowledgeFirstSweepNotice(nowIso: string, dir?: string): void {
  writeState(applyAcknowledge(readState(dir), nowIso), dir);
}
