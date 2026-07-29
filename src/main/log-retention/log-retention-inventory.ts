// Terminal-log retention — WP-5: on-disk inventory of managed log bundles.
//
// The single fs-touching step of the scheduler's scan. It turns the agent rows
// into `RetentionBundle`s the pure planner (WP-2) can select from, and it does
// so under three hard rules that keep retention safe:
//
//   1. VALIDATE BEFORE STATTING. A row whose stored `logPath` is not the exact
//      managed path for its id (`isManagedLogPath`) is out of scope — it is
//      NEVER statted (never touch a corrupt row's arbitrary path) and never
//      becomes a bundle; it is only counted in `invalidCount`.
//   2. SHARED PATH ⇒ SHARED-REFERENCE, COUNTED ONCE. Because agents can share a
//      working directory, two rows can (corruptly) reference one normalized
//      path. Every associated row becomes `preliminaryEligible=false /
//      blocker:'shared-reference'`, the physical bundle's bytes/files are
//      counted exactly ONCE (a single carrier row holds them; the rest hold
//      zero), and NONE of them can enter `toSweep`. The final primitive
//      validation remains authoritative, but this stops a shared bundle at the
//      planner too.
//   3. ENOENT IS THE ONLY ABSENCE. A missing file is simply omitted from the
//      bundle. Any OTHER stat error makes the whole bundle non-reclaimable
//      (`blocker:'stat-error'`) and increments `scanErrors` — it is NEVER
//      treated as a zero-byte (and therefore empty/eligible-looking) file.

import {
  isManagedLogPath,
  summarizeManagedBundle,
  type ManagedStatEntry,
  type ManagedSuffix,
  type RetentionBundle,
  norm,
} from './log-retention-policy';

/** The four managed suffixes of a bundle. `''` = the `.log` itself. */
const SIDECARS: ManagedSuffix[] = ['', '.scrollback', '.checkpoint', '.checkpoint.tmp'];

/** The minimal row facts the inventory needs. `hasRunner` is a PRELIMINARY
 *  liveness read; the executor re-checks under the lifecycle lock, which stays
 *  authoritative. `status` gates terminal-ness. */
export interface InventoryRow {
  agentId: string;
  status: string;
  logPath: string | null;
  hasRunner: boolean;
}

/** One managed file's stat facts, or `null` for ENOENT. A non-ENOENT failure is
 *  signalled by THROWING (mirrors `fs.statSync`), so the inventory can tell an
 *  absent file from a broken one. */
export type StatFn = (p: string) => { size: number; mtimeMs: number } | null;

export interface InventoryResult {
  bundles: RetentionBundle[];
  /** Count of non-ENOENT stat failures encountered (one per affected bundle). */
  scanErrors: number;
  /** Count of rows rejected before statting for an out-of-scope stored path. */
  invalidCount: number;
}

const isTerminal = (status: string): boolean => status === 'done' || status === 'crashed';

/** Stat the four managed paths of ONE bundle. Returns the present entries plus a
 *  `statError` flag (true iff a non-ENOENT stat threw for any sidecar). */
function statBundle(logPath: string, statFn: StatFn): { entries: ManagedStatEntry[]; statError: boolean } {
  const entries: ManagedStatEntry[] = [];
  let statError = false;
  for (const suffix of SIDECARS) {
    let st: { size: number; mtimeMs: number } | null;
    try {
      st = statFn(logPath + suffix);
    } catch {
      // A real, non-ENOENT failure. The file may well exist and have size — we
      // must NOT record it as size 0. Mark the whole bundle non-reclaimable.
      statError = true;
      continue;
    }
    if (st === null) continue; // ENOENT — absent, omit
    entries.push({ suffix, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { entries, statError };
}

/**
 * Build the managed-bundle inventory from agent rows.
 *
 * `bundles` feeds the pure planner. `preliminaryEligible` captures everything
 * except the age gate (the planner applies `minAgeMs`/`nowMs`) and everything
 * except the final under-lock liveness recheck (the executor is authoritative).
 * The reclaimed MARKER is deliberately NOT consulted — a marked-but-revived
 * bundle that is again over policy is re-eligible (no repair pass, no priority).
 */
export function inventoryBundles(
  rows: InventoryRow[],
  approvedLogsDir: string,
  statFn: StatFn,
): InventoryResult {
  // ── Reference census over EVERY row with a stored path (valid or not). ──
  // A physical path referenced by more than one row is a shared reference — the
  // SAME authoritative test the reclaim primitive runs (`getAllAgents().some(
  // other references target)`), lifted here so a shared bundle is not even
  // selected. A corrupt row that (invalidly) points at another agent's managed
  // file still contributes to this count, so the valid owner is protected.
  const refCount = new Map<string, number>();
  for (const row of rows) {
    if (!row.logPath) continue;
    const key = norm(row.logPath);
    refCount.set(key, (refCount.get(key) ?? 0) + 1);
  }

  // ── Partition: valid managed rows vs out-of-scope rows (never statted) ──
  const valid: InventoryRow[] = [];
  let invalidCount = 0;
  for (const row of rows) {
    if (row.logPath && isManagedLogPath(row.logPath, row.agentId, approvedLogsDir)) valid.push(row);
    else invalidCount++;
  }

  // ── Group valid rows by normalized (full) path. Two DISTINCT valid rows can
  // only collide here via a win32 case-fold of their ids; a valid row can also
  // be shared with an INVALID duplicate (caught via refCount below). ──
  const groups = new Map<string, InventoryRow[]>();
  for (const row of valid) {
    const key = norm(row.logPath as string);
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }

  const bundles: RetentionBundle[] = [];
  let scanErrors = 0;

  for (const [key, group] of groups.entries()) {
    // Shared iff ANY other row (valid or invalid) also references this path.
    const shared = (refCount.get(key) ?? 0) > 1;
    // Deterministic order so the shared-group "carrier" (the row that holds the
    // once-counted bytes) is stable across runs.
    group.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));

    // Stat the physical bundle ONCE (every row in a group normalizes to the same
    // path). Use the first row's raw stored path.
    const { entries, statError } = statBundle(group[0].logPath as string, statFn);
    if (statError) scanErrors++;
    const summary = summarizeManagedBundle(group[0].agentId, entries);

    if (shared) {
      // Shared reference: every associated valid row is ineligible; the physical
      // bytes are counted exactly ONCE (carrier = the first row), the rest
      // contribute zero so pressure is never double-counted. None can enter
      // toSweep. (An INVALID duplicate that triggered `shared` is not emitted as
      // a bundle — it is already in `invalidCount`.)
      group.forEach((row, i) => {
        const carrier = i === 0;
        bundles.push({
          agentId: row.agentId,
          totalBytes: carrier ? summary.totalBytes : 0,
          fileCount: carrier ? summary.fileCount : 0,
          newestMtimeMs: carrier ? summary.newestMtimeMs : null,
          preliminaryEligible: false,
          blocker: 'shared-reference',
        });
      });
      continue;
    }

    // ── Single-owner bundle: classify eligibility (marker is NOT a factor) ──
    const row = group[0];
    const hasFiles = summary.fileCount > 0 && summary.newestMtimeMs !== null;
    let blocker: RetentionBundle['blocker'];
    let preliminaryEligible: boolean;
    if (statError) {
      preliminaryEligible = false;
      blocker = 'stat-error';
    } else if (!isTerminal(row.status)) {
      preliminaryEligible = false;
      blocker = 'not-terminal';
    } else if (row.hasRunner) {
      preliminaryEligible = false;
      blocker = 'live-runner';
    } else if (!hasFiles) {
      preliminaryEligible = false;
      blocker = 'empty';
    } else {
      // Terminal, no runner, managed path, present files — the planner applies
      // the age gate and the target accumulation from here.
      preliminaryEligible = true;
    }

    bundles.push({
      agentId: row.agentId,
      totalBytes: summary.totalBytes,
      fileCount: summary.fileCount,
      newestMtimeMs: summary.newestMtimeMs,
      preliminaryEligible,
      ...(blocker ? { blocker } : {}),
    });
  }

  return { bundles, scanErrors, invalidCount };
}
