// Terminal-log retention — WP-5: the OS-idle full-scan scheduler.
//
// Modeled on `lifecycle/idle-sweep.ts`, with the same conservatism (5-min
// startup delay, single-flight, self-unref'd timers, fresh-delay-on-resume)
// plus three retention-specific disciplines:
//
//   - IDLE GATE, FAIL CLOSED. A scan only runs when the OS reports `'idle'` or
//     `'locked'` from `powerMonitor.getSystemIdleState(60)`. `'active'`,
//     `'unknown'`, a throw, or no powerMonitor all SKIP — deleting a user's
//     terminal history mid-session is exactly what we refuse to risk.
//   - CADENCE SEEDED FROM PERSISTED STATE. The 60-second poll launches a full
//     scan only when `now - lastFullScanAt >= 6h`. `lastFullScanAt` is read from
//     the durable state file at start, so a restart inside the window does NOT
//     re-scan after the startup delay.
//   - O(1) GAUGES, ZERO FS. `collectGauges()` returns the LAST cached scan
//     observation. A gauge read on a gated (skipped) tick never touches the
//     disk — it is explicitly not a fresh scan.
//
// NO REPAIR PASS: the scan feeds `planRetentionSweep` unchanged. A marked row is
// not excluded and gets no priority; residue re-enters ordinary policy. A small
// residue persisting under target is preferred over deleting revived history.
//
// This module is self-contained: constructing it starts nothing. `index.ts`
// (WP-5) wires it and adds the gauge provider but does NOT start it — WP-8 owns
// the real start, sinks, and ordering.

import {
  planRetentionSweep,
  type RetentionBundle,
} from './log-retention-policy';
import type { InventoryResult } from './log-retention-inventory';
import {
  applyFullScan,
  applyFirstSweepIfReclaimed,
} from '../lifecycle/log-retention-state';
import { LOG_RETENTION_MIN_AGE_MS, type LogRetentionState, type RetentionExecutionResult } from '../../shared/types';
import type { GaugeReading } from '../watchdog/heap-telemetry';

export const STARTUP_DELAY_MS = 5 * 60 * 1000;
export const IDLE_POLL_MS = 60 * 1000;
export const FULL_SCAN_CADENCE_MS = 6 * 60 * 60 * 1000;

/** `powerMonitor` shape the scheduler consumes. Extends the suspend/resume hooks
 *  with `getSystemIdleState(sec)` (`getSystemIdleTime` is NOT used). */
export interface RetentionPowerMonitorLike {
  getSystemIdleState(idleThresholdSec: number): string;
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}

/** The observation broadcast after each completed scan. `emitSweepEvent` /
 *  `onScanComplete` default to no-ops in WP-5; WP-8 installs the real sinks. */
export interface RetentionScanSummary {
  scannedAt: string;
  managedFileCount: number;
  managedBytes: number;
  filesRemoved: number;
  bytesReclaimed: number;
  agentsReclaimed: number;
  scanErrors: number;
  invalidCount: number;
  outcome: 'under-target' | 'swept-to-target' | 'target-unmet';
}

export interface LogRetentionSchedulerDeps {
  /** fs-touching inventory, bound to the same approved dir the executor uses. */
  inventory: (approvedLogsDir: string) => InventoryResult;
  /** The supervisor executor (`runRetentionSweepPlan`). */
  runSweepPlan: (toSweep: RetentionBundle[]) => Promise<RetentionExecutionResult[]>;
  /** Target bytes from the retention cap (`'unlimited'` → +∞ ⇒ empty plan). */
  loadCapBytes: () => number;
  /** `supervisor.getApprovedLogsDirForRetention` — the EXACT dir reclaim uses. */
  getApprovedLogsDir: () => string;
  powerMonitor?: RetentionPowerMonitorLike | null;
  now: () => number;
  timers?: {
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (h: unknown) => void;
    setImmediate?: (cb: () => void) => void;
  };
  readState: () => LogRetentionState;
  writeState: (state: LogRetentionState) => void;
  /** WP-8 sink. Default no-op. */
  emitSweepEvent?: (summary: RetentionScanSummary) => void;
  /** WP-8 sink. Default no-op. */
  onScanComplete?: (summary: RetentionScanSummary) => void;
  log?: (msg: string) => void;
}

export class LogRetentionScheduler {
  private startupTimer: unknown = null;
  private pollTimer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private suspended = false;

  /** Last completed-scan time (ms), seeded from persisted `lastFullScanAt`. Null
   *  = never scanned (immediately due). Updated only after a completed scan. */
  private lastScanMs: number | null = null;

  // ── Cached O(1) gauge observation — updated only inside doScan ──
  private managedFileCount = 0;
  private managedBytes = 0;
  private cumulativeFilesRemoved = 0;
  private cumulativeBytesReclaimed = 0;

  private readonly onSuspend = (): void => { this.suspended = true; this.disarm(); };
  private readonly onResume = (): void => {
    this.suspended = false;
    if (this.stopped) return;
    // A FRESH startup delay, never a catch-up burst: the machine was asleep, no
    // history aged in any meaningful sense, and the human just sat back down.
    this.armStartupDelay();
  };

  constructor(private readonly deps: LogRetentionSchedulerDeps) {}

  private get setTimer(): (fn: () => void, ms: number) => unknown {
    return this.deps.timers?.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; });
  }
  private get clearTimer(): (h: unknown) => void {
    return this.deps.timers?.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }
  private get setIntervalTimer(): (fn: () => void, ms: number) => unknown {
    return this.deps.timers?.setInterval ?? ((fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; });
  }
  private get clearIntervalTimer(): (h: unknown) => void {
    return this.deps.timers?.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }
  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(msg);
  }

  /**
   * Arm the scheduler. MUST be called after `app.whenReady()` — Electron's
   * `powerMonitor` throws if touched before ready. NOTE (WP-5): index.ts
   * constructs but does NOT call this; WP-8 owns the real start.
   */
  start(): void {
    if (this.stopped) return;
    this.seedDueTime();
    this.armStartupDelay();
    this.deps.powerMonitor?.on('suspend', this.onSuspend);
    this.deps.powerMonitor?.on('resume', this.onResume);
  }

  /** Seed the due clock from persisted state so a restart inside the 6-h window
   *  does not re-scan. `Date.parse` here is SCHEDULING math only — never the
   *  reclaimed marker (which stays an ISO string end-to-end). A missing or
   *  unparseable value ⇒ null ⇒ due (fail toward the first scan). */
  private seedDueTime(): void {
    const iso = this.deps.readState().lastFullScanAt;
    const ms = iso ? Date.parse(iso) : NaN;
    this.lastScanMs = Number.isFinite(ms) ? ms : null;
  }

  private armStartupDelay(): void {
    this.disarm();
    this.startupTimer = this.setTimer(() => {
      this.startupTimer = null;
      void this.tick(); // gated: idle + due
      this.pollTimer = this.setIntervalTimer(() => { void this.tick(); }, IDLE_POLL_MS);
    }, STARTUP_DELAY_MS);
  }

  private disarm(): void {
    if (this.startupTimer !== null) { this.clearTimer(this.startupTimer); this.startupTimer = null; }
    if (this.pollTimer !== null) { this.clearIntervalTimer(this.pollTimer); this.pollTimer = null; }
  }

  /** The idle gate — fail CLOSED. Only `'idle'`/`'locked'` proceed; `'active'`,
   *  `'unknown'`, a throw, or no powerMonitor all return false (skip). */
  private isIdle(): boolean {
    try {
      const s = this.deps.powerMonitor?.getSystemIdleState(60);
      return s === 'idle' || s === 'locked';
    } catch {
      return false;
    }
  }

  /** The cadence gate. Never scanned (null) ⇒ due. Otherwise due iff at least
   *  `FULL_SCAN_CADENCE_MS` has elapsed since the last completed scan. */
  private isDue(): boolean {
    return this.lastScanMs === null || this.deps.now() - this.lastScanMs >= FULL_SCAN_CADENCE_MS;
  }

  /** One poll tick: gate on idle THEN on cadence; run a scan only if both pass.
   *  Exposed (via the instance) so tests can drive a tick deterministically. */
  async tick(): Promise<void> {
    if (this.stopped || this.suspended) return;
    if (!this.isIdle()) return; // OS not idle → skip (fail closed)
    if (!this.isDue()) return;  // within the 6-h window → skip (no re-scan)
    await this.runScan();
  }

  /** Run a full scan now. SINGLE-FLIGHT: a slow scan is never joined by a second
   *  (a later due+idle tick simply awaits the in-flight one). Exposed for a
   *  future manual "run now" and for tests. */
  runScan(): Promise<void> {
    if (this.stopped || this.suspended) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const run = this.doScan()
      .catch((e) => { this.log(`[retention] scan failed: ${String(e)}`); })
      .finally(() => { if (this.inFlight === run) this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async doScan(): Promise<void> {
    const nowMs = this.deps.now();
    const dir = this.deps.getApprovedLogsDir();
    const inv = this.deps.inventory(dir);
    const capBytes = this.deps.loadCapBytes();
    const plan = planRetentionSweep(inv.bundles, {
      targetBytes: capBytes,
      minAgeMs: LOG_RETENTION_MIN_AGE_MS,
      nowMs,
    });

    // The executor is authoritative — it re-checks liveness under the lock and
    // reports what it ACTUALLY removed. Counters come from that, never the plan.
    const results = await this.deps.runSweepPlan(plan.toSweep);

    let filesRemoved = 0;
    let bytesReclaimed = 0;
    let agentsReclaimed = 0;
    for (const r of results) {
      if (r.removed.length > 0) {
        agentsReclaimed++;
        for (const f of r.removed) { filesRemoved++; bytesReclaimed += f.bytes; }
      }
    }

    // Cached O(1) gauge observation. Disk totals reflect the just-scanned managed
    // set; cumulative reclaim accrues ACTUAL removals across scans.
    this.managedFileCount = plan.managedFileCount;
    this.managedBytes = plan.managedTotalBytes;
    this.cumulativeFilesRemoved += filesRemoved;
    this.cumulativeBytesReclaimed += bytesReclaimed;

    const nowIso = new Date(nowMs).toISOString();
    // One atomic state write: stamp the completed-scan time AND (create-once,
    // bytes>0-only) the first-sweep notice.
    let state = this.deps.readState();
    state = applyFullScan(state, nowIso);
    state = applyFirstSweepIfReclaimed(state, { completedAt: nowIso, agents: agentsReclaimed, bytes: bytesReclaimed });
    this.deps.writeState(state);
    this.lastScanMs = nowMs;

    const summary: RetentionScanSummary = {
      scannedAt: nowIso,
      managedFileCount: this.managedFileCount,
      managedBytes: this.managedBytes,
      filesRemoved,
      bytesReclaimed,
      agentsReclaimed,
      scanErrors: inv.scanErrors,
      invalidCount: inv.invalidCount,
      outcome: plan.outcome,
    };
    (this.deps.emitSweepEvent ?? ((): void => {}))(summary);
    (this.deps.onScanComplete ?? ((): void => {}))(summary);
  }

  /** O(1), ZERO fs. Returns the last cached observation — a gated tick that
   *  never scanned still answers from cache, explicitly not a fresh scan. */
  collectGauges(): GaugeReading[] {
    return [
      { name: 'terminal-log-disk', count: this.managedFileCount, bytes: this.managedBytes },
      { name: 'terminal-log-reclaimed', count: this.cumulativeFilesRemoved, bytes: this.cumulativeBytesReclaimed },
    ];
  }

  /** Shutdown: disarm, unhook power events, and drain any in-flight scan so a
   *  reclaim is never abandoned half-way. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.disarm();
    this.deps.powerMonitor?.removeListener('suspend', this.onSuspend);
    this.deps.powerMonitor?.removeListener('resume', this.onResume);
    const pending = this.inFlight;
    if (pending) await pending.catch(() => {});
  }
}
