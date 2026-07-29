// Terminal-log retention — WP-8: first-sweep IPC + broadcast + scan-complete
// sinks. WP-1..WP-5 already own the policy, executor, durable state, and
// scheduler; this module is DELIVERY + WIRING only.
//
// Three deliberate disciplines live here:
//
//   1. BROADCAST TO EVERY WINDOW, SKIPPING DESTROYED ONES. The first-sweep
//      banner is app-chrome that may be showing in a detached window too, so a
//      state change pushes to `BrowserWindow.getAllWindows()` (via an injected
//      accessor) exactly like `lifecycle-settings` does — never just the main
//      window. A destroyed window is skipped (its `webContents.send` would
//      throw).
//   2. PULL + PUSH. `log-retention:get-state` lets a renderer that mounted AFTER
//      the sweep completed still see the notice; `log-retention:state-changed`
//      pushes it to renderers already mounted. Acknowledgement persists (only
//      the nested `acknowledgedAt`) and rebroadcasts so a second window's banner
//      clears too.
//   3. LIVE-ACCESSOR SINKS. The scan-complete/sweep-event sinks the scheduler
//      calls close over an ACCESSOR for the heap-telemetry instance, not a
//      captured value — the scheduler is constructed BEFORE telemetry exists and
//      is only STARTED after, so `emitSweepEvent` must read the live instance.
//      A sink bound to the (still-null) telemetry at construction would silently
//      drop every sweep line; the accessor is what makes the index.ts ordering
//      (construct scheduler → construct telemetry → start scheduler) safe.

import type { LogRetentionState } from '../../shared/types';
import type { LogRetentionSweepEvent } from '../watchdog/heap-telemetry';
import type { RetentionScanSummary } from '../log-retention/log-retention-scheduler';

export const LOG_RETENTION_CHANNELS = {
  getState: 'log-retention:get-state',
  stateChanged: 'log-retention:state-changed',
  acknowledgeNotice: 'log-retention:acknowledge-notice',
} as const;

// ── Broadcast (push) ──────────────────────────────────────────────────────────

/** The minimal window shape the broadcast needs — matches Electron's
 *  `BrowserWindow` so `BrowserWindow.getAllWindows()` flows straight in, but is
 *  injectable so this is unit-testable without electron. */
export interface BroadcastWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/**
 * Push the current retention state to EVERY window, skipping destroyed ones.
 * A single-window push would leave a detached window's banner stale; sending to
 * a destroyed window throws — hence both guards, mirroring lifecycle-settings.
 */
export function broadcastLogRetentionState(
  getWindows: () => BroadcastWindowLike[],
  state: LogRetentionState,
): void {
  for (const win of getWindows()) {
    if (!win.isDestroyed()) win.webContents.send(LOG_RETENTION_CHANNELS.stateChanged, state);
  }
}

// ── IPC registration (pull + acknowledge) ─────────────────────────────────────

export interface LogRetentionIpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface LogRetentionIpcDeps {
  /** Read the durable retention state (the scheduler is the writer). */
  readState: () => LogRetentionState;
  /** Set ONLY the nested `acknowledgedAt` (create-once notice, dismissed). */
  acknowledge: (nowIso: string) => void;
  /** Push the given state to every live window. */
  broadcast: (state: LogRetentionState) => void;
  now: () => number;
}

export function registerLogRetentionIpc(ipc: LogRetentionIpcLike, deps: LogRetentionIpcDeps): void {
  // Pull: a renderer mounting AFTER the sweep still gets the notice.
  ipc.handle(LOG_RETENTION_CHANNELS.getState, () => deps.readState());

  // Dismiss: persist acknowledgement, then rebroadcast the FRESH state so every
  // window (incl. detached) clears its banner, not just the sender's.
  ipc.handle(LOG_RETENTION_CHANNELS.acknowledgeNotice, () => {
    deps.acknowledge(new Date(deps.now()).toISOString());
    const state = deps.readState();
    deps.broadcast(state);
    return state;
  });
}

// ── Scan-complete + sweep-event sinks (scheduler wiring) ──────────────────────

/**
 * Map a scheduler `RetentionScanSummary` to the telemetry `LogRetentionSweepEvent`.
 * `beforeBytes` is the managed disk total the scan measured (pre-sweep);
 * `afterBytes = before - reclaimed`. `durationMs` is derived from the summary's
 * scan-start timestamp to the emit time (`nowMs`) — an honest wall-clock, never
 * a synthetic constant. Every counter is the executor's ACTUAL removal, carried
 * verbatim from the summary.
 */
export function buildLogRetentionSweepEvent(
  summary: RetentionScanSummary,
  targetBytes: number,
  nowMs: number,
): LogRetentionSweepEvent {
  const beforeBytes = summary.managedBytes;
  const reclaimedBytes = summary.bytesReclaimed;
  const scanStartMs = Date.parse(summary.scannedAt);
  return {
    beforeBytes,
    afterBytes: Math.max(0, beforeBytes - reclaimedBytes),
    removedFiles: summary.filesRemoved,
    reclaimedBytes,
    reclaimedAgents: summary.agentsReclaimed,
    targetBytes,
    outcome: summary.outcome,
    durationMs: Number.isFinite(scanStartMs) ? Math.max(0, nowMs - scanStartMs) : 0,
    scanErrors: summary.scanErrors,
  };
}

/** The heap-telemetry surface the sweep-event sink needs (the single writer). */
export interface SweepTelemetrySink {
  emitLogRetentionSweep(ev: LogRetentionSweepEvent): void;
}

export interface RetentionSinkDeps {
  /** LIVE accessor for the telemetry instance — NOT a captured value. Returns
   *  null until telemetry is constructed; the scheduler is started only after,
   *  so a real sweep always sees a live instance. */
  getHeapTelemetry: () => SweepTelemetrySink | null;
  /** Current cap in bytes (`unlimited` ⇒ +∞). */
  getTargetBytes: () => number;
  now: () => number;
  /** Read the durable state the scheduler just wrote (for the broadcast). */
  readState: () => LogRetentionState;
  /** Push the just-completed state to every window. */
  broadcast: (state: LogRetentionState) => void;
}

/**
 * Build the two sinks the scheduler calls after a completed scan. `emitSweepEvent`
 * routes the actual-removal summary to the SINGLE telemetry writer via the live
 * accessor; `onScanComplete` broadcasts the durable state (already persisted by
 * the scheduler's own scan, WP-5) so mounted renderers update.
 *
 * Note the live accessor: if the sink captured `heapTelemetry` by value at
 * construction (when it is still null), every sweep line would be lost. Reading
 * it lazily is what lets the scheduler be CONSTRUCTED before telemetry yet only
 * STARTED after — the load-bearing index.ts ordering.
 */
export function makeRetentionSinks(deps: RetentionSinkDeps): {
  emitSweepEvent: (summary: RetentionScanSummary) => void;
  onScanComplete: (summary: RetentionScanSummary) => void;
} {
  return {
    emitSweepEvent: (summary) =>
      deps
        .getHeapTelemetry()
        ?.emitLogRetentionSweep(buildLogRetentionSweepEvent(summary, deps.getTargetBytes(), deps.now())),
    onScanComplete: () => deps.broadcast(deps.readState()),
  };
}
