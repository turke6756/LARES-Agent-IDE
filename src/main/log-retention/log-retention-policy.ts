// Terminal-log retention — WP-2: pure bundle summarization + sweep selection.
//
// ZERO IO. No `fs`, no database, no Electron. Every function here takes
// already-collected stat data as plain arguments and returns plain data, so it
// is exhaustively unit-testable without a filesystem. `path` is used only for
// pure path normalization (`norm` / `isManagedLogPath`).
//
// The four managed sidecars of an agent's terminal log — the `.log` itself plus
// `.scrollback`, `.checkpoint`, `.checkpoint.tmp` — together form a "bundle".
// Retention reasons about a bundle as a unit: its total on-disk bytes, its file
// count, and the mtime of its NEWEST member (freshness gates the min-age rule).

import * as path from 'path';

/** The four managed suffixes of a terminal-log bundle. `''` = the `.log` itself. */
export type ManagedSuffix = '' | '.scrollback' | '.checkpoint' | '.checkpoint.tmp';

/** One present managed file's stat facts (already collected by the caller). */
export interface ManagedStatEntry {
  suffix: ManagedSuffix;
  size: number;
  mtimeMs: number;
}

export interface ManagedBundleSummary {
  agentId: string;
  totalBytes: number;
  fileCount: number;
  /** `Math.max` of present mtimes; **null** for an empty bundle (never a
   *  synthetic 0 / Infinity / now). */
  newestMtimeMs: number | null;
}

/**
 * Summarize the managed files that are actually present for one agent.
 * `entries` holds ONLY files that exist (the caller omits ENOENT); an empty
 * array is a legitimately empty bundle and yields `newestMtimeMs: null`.
 */
export function summarizeManagedBundle(
  agentId: string,
  entries: ManagedStatEntry[],
): ManagedBundleSummary {
  let totalBytes = 0;
  let newestMtimeMs: number | null = null;
  for (const e of entries) {
    totalBytes += e.size;
    // Newest = the maximum mtime across present files. Starting from null (not
    // 0) keeps an empty bundle honestly null and never lets a synthetic floor
    // masquerade as a real timestamp.
    newestMtimeMs = newestMtimeMs === null ? e.mtimeMs : Math.max(newestMtimeMs, e.mtimeMs);
  }
  return { agentId, totalBytes, fileCount: entries.length, newestMtimeMs };
}

/** Full-path normalization (incl. basename). win32 is case-insensitive. */
export function norm(p: string): string {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

/**
 * Validate that a STORED log path is the exact managed path for `agentId` under
 * `approvedLogsDir` (`<approvedLogsDir>/<agentId>.log`). Validation only — the
 * stored path (never a reconstructed one) is what is handed to reclaim.
 */
export function isManagedLogPath(logPath: string, agentId: string, approvedLogsDir: string): boolean {
  return norm(logPath) === norm(path.join(approvedLogsDir, `${agentId}.log`));
}

/** A reason a bundle cannot be swept. Age is applied by the planner (`too-young`);
 *  the other reasons are established upstream (inventory / row facts). */
export type RetentionBlocker =
  | 'shared-reference'
  | 'invalid-path'
  | 'stat-error'
  | 'not-terminal'
  | 'live-runner'
  | 'too-young'
  | 'empty';

/**
 * A summarized, upstream-classified bundle fed to the planner. `preliminaryEligible`
 * captures everything EXCEPT the age gate (which the planner applies against
 * `nowMs`/`minAgeMs`):
 *
 *   preliminaryEligible = status ∈ {done,crashed} && !hasRunner && isManagedLogPath
 *                         && fileCount > 0 && newestMtimeMs !== null
 *
 * The reclaimed MARKER is deliberately NOT a factor — a marked-but-revived agent
 * whose bundle is again over policy is re-eligible.
 */
export interface RetentionBundle {
  agentId: string;
  totalBytes: number;
  fileCount: number;
  newestMtimeMs: number | null;
  preliminaryEligible: boolean;
  blocker?: RetentionBlocker;
}

export interface RetentionSweepPlan {
  /** Bundles to sweep, oldest-first, exactly enough to reach the target. */
  toSweep: RetentionBundle[];
  /** Σ bytes of every valid, distinct bundle — regardless of eligibility. */
  managedTotalBytes: number;
  /** Σ file counts of every valid, distinct bundle — regardless of eligibility. */
  managedFileCount: number;
  projectedFreedBytes: number;
  remainingOverageBytes: number;
  outcome: 'under-target' | 'swept-to-target' | 'target-unmet';
  /** Census of bundles that could NOT be swept, keyed by blocker reason. */
  blockers: Partial<Record<RetentionBlocker, number>>;
}

export interface RetentionSweepParams {
  targetBytes: number;
  minAgeMs: number;
  nowMs: number;
}

/**
 * Select which bundles to sweep to bring managed disk under `targetBytes`.
 *
 * Disk pressure (`managedTotalBytes`/`managedFileCount`) counts EVERY bundle
 * passed in — ineligible bundles still occupy disk; they simply never enter
 * `toSweep`. A bundle is sweep-eligible only when it is `preliminaryEligible`
 * AND has present files AND its newest file is at least `minAgeMs` old
 * (boundary inclusive: `age === minAgeMs` is eligible).
 */
export function planRetentionSweep(
  bundles: RetentionBundle[],
  { targetBytes, minAgeMs, nowMs }: RetentionSweepParams,
): RetentionSweepPlan {
  let managedTotalBytes = 0;
  let managedFileCount = 0;
  const eligible: RetentionBundle[] = [];
  const blockers: Partial<Record<RetentionBlocker, number>> = {};
  const addBlocker = (r: RetentionBlocker): void => { blockers[r] = (blockers[r] ?? 0) + 1; };

  for (const b of bundles) {
    // Pressure counts every bundle — eligible or not. Ineligible bundles are
    // disk we cannot reclaim, not disk we pretend isn't there.
    managedTotalBytes += b.totalBytes;
    managedFileCount += b.fileCount;

    const hasFiles = b.fileCount > 0 && b.newestMtimeMs !== null;
    // `>=` — the min-age boundary is inclusive.
    const oldEnough = hasFiles && nowMs - (b.newestMtimeMs as number) >= minAgeMs;

    if (b.preliminaryEligible && hasFiles && oldEnough) {
      eligible.push(b);
      continue;
    }

    // Classify why this bundle stays on disk (honest blocker census).
    if (!hasFiles) addBlocker('empty');
    else if (b.blocker) addBlocker(b.blocker);
    else if (!b.preliminaryEligible) addBlocker('invalid-path');
    else addBlocker('too-young');
  }

  // Oldest-first by newest-file mtime ascending; deterministic `agentId` tiebreak.
  eligible.sort((a, b) => {
    const am = a.newestMtimeMs as number;
    const bm = b.newestMtimeMs as number;
    if (am !== bm) return am - bm;
    return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
  });

  const toSweep: RetentionBundle[] = [];
  let projectedFreedBytes = 0;
  for (const b of eligible) {
    if (managedTotalBytes - projectedFreedBytes <= targetBytes) break;
    toSweep.push(b);
    projectedFreedBytes += b.totalBytes;
  }

  const remainingOverageBytes = Math.max(0, managedTotalBytes - projectedFreedBytes - targetBytes);

  let outcome: RetentionSweepPlan['outcome'];
  if (managedTotalBytes <= targetBytes) outcome = 'under-target';
  else if (remainingOverageBytes === 0) outcome = 'swept-to-target';
  else outcome = 'target-unmet';

  return {
    toSweep,
    managedTotalBytes,
    managedFileCount,
    projectedFreedBytes,
    remainingOverageBytes,
    outcome,
    blockers,
  };
}
