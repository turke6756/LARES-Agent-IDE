// Attribution service (incident-2026-07-11 §5 full-D5, Wave 4).
//
// The stateful shell around the pure attribution engine: owns the periodic
// process-memory snapshot, caches the latest rollup, and exposes the
// budget/owned-cap admission helpers that the index.ts wiring layers onto the
// D5-lite sampler gates. Kept OUT of the sampler (whose commit syscall is
// per-15s and hot) because attribution's Win32_Process snapshot is a rare
// shell-out — refreshed on a slow cadence + on-demand when the meter/orphan
// panel pulls, never per commit-sample.
//
// Everything the engine needs is injected (store accessor, electron summary,
// snapshot reader, clock), so this is unit-testable with no live processes.

import {
  computeAttribution,
  usageForAgent,
  type AttributionResult,
  type ResolvedTree,
} from './attribution';
import {
  checkAgentBudget,
  checkOwnedProcessCap,
  DEFAULT_BUDGET_CONFIG,
  type BudgetConfig,
} from './budget';
import { readProcessMemorySnapshot, makeSnapshot, type ProcessMemorySnapshot } from './process-memory';
import type { OwnershipRow, ProcessInfo } from '../supervisor/ownership/types';
import type { AdmissionDecision } from './types';

/** The read-only slice of OwnershipStore the service consumes (structural — the
 *  concrete store satisfies it). */
export interface OwnershipReadFacade {
  listOwnershipRows(): OwnershipRow[];
  getLiveJobPids(agentId: string): number[] | null;
  classifyTree(row: OwnershipRow, processes: ProcessInfo[]): { status: string; pids: number[] };
}

export interface AttributionServiceDeps {
  /** The ownership store, or null until startOwnership() arms it. */
  getStore: () => OwnershipReadFacade | null;
  /** app.getAppMetrics() rollup — Electron process count + working-set bytes. */
  electron: () => { processCount: number; workingSetBytes: number };
  /** Injectable for tests; defaults to the real Win32_Process snapshot. */
  readSnapshot?: () => Promise<ProcessMemorySnapshot>;
  now?: () => number;
  /** Background refresh cadence (ms). Default 45 s — well off the hot path. */
  refreshIntervalMs?: number;
  config?: BudgetConfig;
  log?: (msg: string) => void;
}

const EMPTY_SNAPSHOT = makeSnapshot([]);

export class AttributionService {
  private latest: AttributionResult | null = null;
  private lastSnapshot: ProcessMemorySnapshot = EMPTY_SNAPSHOT;
  private refreshing: Promise<AttributionResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cfg: BudgetConfig;
  private readonly now: () => number;
  private readonly readSnapshot: () => Promise<ProcessMemorySnapshot>;
  private readonly intervalMs: number;

  constructor(private readonly deps: AttributionServiceDeps) {
    this.cfg = deps.config ?? DEFAULT_BUDGET_CONFIG;
    this.now = deps.now ?? (() => Date.now());
    this.readSnapshot = deps.readSnapshot ?? readProcessMemorySnapshot;
    this.intervalMs = deps.refreshIntervalMs ?? 45_000;
  }

  /** Begin the background refresh loop (kicks one immediate refresh). Idempotent.
   *  The timer is unref'd so attribution never holds the event loop open. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Recompute the attribution rollup from a fresh process-memory snapshot.
   *  Coalesces concurrent callers onto one in-flight refresh. Never rejects. */
  async refresh(): Promise<AttributionResult> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<AttributionResult> {
    let snapshot: ProcessMemorySnapshot = EMPTY_SNAPSHOT;
    try {
      snapshot = await this.readSnapshot();
    } catch (e) {
      this.log(`[attribution] snapshot read failed: ${String(e)}`);
    }
    this.lastSnapshot = snapshot;
    const store = this.deps.getStore();

    const resolveTree = (row: OwnershipRow): ResolvedTree => {
      // Prefer the live-instance Job Object PID list; fall back to the verified
      // Win32 tree walk for prior-epoch / native-off rows.
      const jobPids = store?.getLiveJobPids(row.agentId);
      if (jobPids && jobPids.length > 0) return { pids: jobPids, source: 'job' };
      const cls = store?.classifyTree(row, snapshot.processes);
      if (cls && cls.status === 'tree' && cls.pids.length > 0) {
        return { pids: cls.pids, source: 'tree-walk' };
      }
      return { pids: [], source: 'none' };
    };

    const result = computeAttribution({
      listOwnershipRows: () => store?.listOwnershipRows() ?? [],
      resolveTree,
      workingSetBytes: (pid) => snapshot.workingSetBytes(pid),
      commitBytes: (pid) => snapshot.commitBytes(pid),
      electron: this.deps.electron,
      now: this.now,
    });
    this.latest = result;
    return result;
  }

  /** Last computed rollup (null before the first refresh completes). */
  getLatest(): AttributionResult | null {
    return this.latest;
  }

  /** Refresh, then return the fresh rollup — used by the on-demand IPC pull so a
   *  meter/orphan-panel open reflects live memory, not a stale cache. */
  async getFresh(): Promise<AttributionResult | null> {
    await this.refresh();
    return this.latest;
  }

  // ── admission helpers (layered onto the D5-lite sampler gates) ─────────────

  /** Whole-app owned-process cap gate for NEW agent launches. Fail-open on a
   *  cold cache (the sampler's fail-closed Electron cap still applies). */
  checkLaunchOwnedCap(): AdmissionDecision {
    return checkOwnedProcessCap(this.latest?.totals, this.cfg);
  }

  /** Owned-cap + per-agent budget gate for NEW agent tabs. Owned-cap first (a
   *  whole-app problem), then the opening agent's own budget if known. */
  checkTabAdmission(agentId?: string): AdmissionDecision {
    const cap = checkOwnedProcessCap(this.latest?.totals, this.cfg);
    if (!cap.allowed) return cap;
    if (agentId) return checkAgentBudget(usageForAgent(this.latest, agentId), this.cfg);
    return { allowed: true };
  }

  /** Best-effort byte estimate for an orphan candidate's PID set, from the last
   *  snapshot (the "Reap now" list's per-agent memory estimate). */
  estimateBytesForPids(pids: number[]): number {
    let total = 0;
    for (const pid of pids) {
      const ws = this.lastSnapshot.workingSetBytes(pid);
      if (ws != null) total += ws;
    }
    return total;
  }

  private log(msg: string): void {
    try { (this.deps.log ?? ((m: string) => console.warn(m)))(msg); } catch { /* never throw */ }
  }
}
