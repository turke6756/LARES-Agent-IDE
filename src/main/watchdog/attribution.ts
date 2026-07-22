// Per-agent memory attribution (incident-2026-07-11 §5 full-D5, Wave 4).
//
// Joins the D4 durable ownership rows to live per-process memory: for each
// ConPTY agent it resolves the live PID set (the live-instance Job Object's
// `listJobPids` when a handle is held, else the creation-time-verified
// `Win32_Process` tree walk for rows from prior epochs / native-off), sums each
// PID's working set + commit charge, and rolls the whole thing up into app-owned
// totals (Electron via `app.getAppMetrics()` + the owned CLI trees).
//
// PURE + dependency-injected: the tree resolver, the per-PID memory getters, the
// Electron summary, and the clock are all injected so this is unit-testable with
// no live processes, no native module, and no electron. The production resolvers
// live in the index.ts wiring (job pids from the OwnershipStore; per-PID bytes
// from process-memory.ts's single Win32_Process snapshot — "use what exists", no
// new native call, per the plan's per-PID-memory constraint).

import type { OwnershipRow } from '../supervisor/ownership/types';

/** How an agent's live PID set was resolved. `job` = live-instance Job Object
 *  `listJobPids`; `tree-walk` = verified Win32_Process walk; `none` = WSL (no
 *  Win32 PID) or nothing resolvable. */
export type AttributionSource = 'job' | 'tree-walk' | 'none';

/** A commit-byte category: the sum of every PID that resolved, plus whether
 *  EVERY expected PID resolved. `complete: false` means the true figure is
 *  ≥ `bytes` — the shortfall must never be attributed to "other/system". */
export interface CommitCategory { bytes: number; complete: boolean }

/** Per-agent memory footprint of the hosted CLI process tree. */
export interface AgentMemoryUsage {
  agentId: string;
  transport: 'conpty' | 'wsl';
  /** Sum of the tree's per-PID working-set bytes (the load-bearing figure). */
  cliTreeBytes: number;
  /** Sum of the tree's per-PID commit/private bytes (best-effort proxy). */
  cliCommitBytes: number;
  /** True iff the tree resolved (source !== 'none') AND every PID in it
   *  returned commit bytes. WSL rows are always false. */
  commitComplete: boolean;
  /** Number of live PIDs in the resolved tree. */
  pidCount: number;
  source: AttributionSource;
}

/** App-owned rollup: Electron's own processes plus the owned CLI trees. The
 *  `totalOwned*` pair is the input to the full-D5 "whole-app-owned process
 *  count" cap (rev-3 rename from the Electron-only D5-lite cap). */
export interface AppOwnedTotals {
  electronProcessCount: number;
  electronBytes: number;
  ownedCliProcessCount: number;
  ownedCliBytes: number;
  totalOwnedProcessCount: number;
  totalOwnedBytes: number;
}

export interface AttributionResult {
  perAgent: AgentMemoryUsage[];
  totals: AppOwnedTotals;
  /** Electron's own commit bytes from the shared snapshot; null when no
   *  Electron PID was supplied. complete ⇔ every supplied PID resolved. */
  electronCommit: CommitCategory | null;
  at: number;
}

export interface ResolvedTree {
  pids: number[];
  source: AttributionSource;
}

export interface AttributionDeps {
  /** Every durable ownership row (current + prior epochs). */
  listOwnershipRows: () => OwnershipRow[];
  /** Resolve the live PID set for a ConPTY row: `listJobPids` for a held live
   *  job, else the verified tree walk. May return `{ pids: [], source: 'none' }`
   *  when nothing is alive. Never throws (wiring swallows). */
  resolveTree: (row: OwnershipRow) => ResolvedTree;
  /** Per-PID working-set bytes; null when the PID isn't in the snapshot. */
  workingSetBytes: (pid: number) => number | null;
  /** Per-PID commit/private bytes; null when unknown. */
  commitBytes: (pid: number) => number | null;
  /** Electron app-owned processes summary (app.getAppMetrics()). `pids` feeds
   *  the commit-category rollup through the SAME injected `commitBytes(pid)` as
   *  the CLI trees — one snapshot, one timestamp, one missing-data behavior. */
  electron: () => { processCount: number; workingSetBytes: number; pids: number[] };
  now: () => number;
}

/** Compute the full attribution snapshot. Never throws: a resolver / getter that
 *  throws is treated as "unknown" for that row/PID, and the rest still rolls up. */
export function computeAttribution(deps: AttributionDeps): AttributionResult {
  const rows = safe(() => deps.listOwnershipRows(), [] as OwnershipRow[]);
  const perAgent: AgentMemoryUsage[] = [];
  // A PID may in principle appear under two rows (shared tree, stale rows). Count
  // its bytes/process ONCE toward the app-owned totals; per-agent figures still
  // reflect each agent's own resolved tree.
  const countedPids = new Set<number>();
  let ownedCliBytes = 0;
  let ownedCliProcessCount = 0;

  for (const row of rows) {
    if (row.transport === 'wsl') {
      perAgent.push({
        agentId: row.agentId,
        transport: 'wsl',
        cliTreeBytes: 0,
        cliCommitBytes: 0,
        commitComplete: false, // no Win32 PID → commit is unknowable, not zero
        pidCount: 0,
        source: 'none',
      });
      continue;
    }
    const resolved = safe(() => deps.resolveTree(row), { pids: [], source: 'none' as const });
    let treeBytes = 0;
    let treeCommit = 0;
    let allResolved = true; // a PID whose commitBytes returns null flips this
    for (const pid of resolved.pids) {
      const ws = safe(() => deps.workingSetBytes(pid), null);
      if (ws != null) treeBytes += ws;
      const cm = safe(() => deps.commitBytes(pid), null);
      if (cm != null) treeCommit += cm;
      else allResolved = false;
      if (!countedPids.has(pid)) {
        countedPids.add(pid);
        ownedCliProcessCount += 1;
        if (ws != null) ownedCliBytes += ws;
      }
    }
    const source: AttributionSource = resolved.pids.length > 0 ? resolved.source : 'none';
    perAgent.push({
      agentId: row.agentId,
      transport: 'conpty',
      cliTreeBytes: treeBytes,
      cliCommitBytes: treeCommit,
      commitComplete: resolved.pids.length > 0 && source !== 'none' && allResolved,
      pidCount: resolved.pids.length,
      source,
    });
  }

  const el = safe(() => deps.electron(), { processCount: 0, workingSetBytes: 0, pids: [] as number[] });
  // Electron's commit category, through the SAME commitBytes snapshot as the
  // CLI trees. No PIDs supplied (getAppMetrics threw / degraded) → null, never
  // a false "0 B complete".
  let electronCommit: CommitCategory | null = null;
  if (el.pids.length > 0) {
    let bytes = 0;
    let complete = true;
    for (const pid of el.pids) {
      const cm = safe(() => deps.commitBytes(pid), null);
      if (cm != null) bytes += cm;
      else complete = false;
    }
    electronCommit = { bytes, complete };
  }
  const totals: AppOwnedTotals = {
    electronProcessCount: el.processCount,
    electronBytes: el.workingSetBytes,
    ownedCliProcessCount,
    ownedCliBytes,
    totalOwnedProcessCount: el.processCount + ownedCliProcessCount,
    totalOwnedBytes: el.workingSetBytes + ownedCliBytes,
  };
  return { perAgent, totals, electronCommit, at: safe(() => deps.now(), 0) };
}

/** Look up one agent's usage in a computed result (for the per-agent budget gate). */
export function usageForAgent(result: AttributionResult | null, agentId: string): AgentMemoryUsage | null {
  if (!result) return null;
  return result.perAgent.find((u) => u.agentId === agentId) ?? null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
