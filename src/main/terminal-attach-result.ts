// WP-3e — the `terminal:attach` result-shape builder, extracted from the IPC
// handler so the deferred WP-3a attach-path integration assertions (live-attach
// result shape / dead-attach path) can be exercised without standing up Electron
// `ipcMain` or a real supervisor.
//
// This owns ONLY the atomic {ok, live, terminalEpoch, snapshotCutoff, degraded}
// composition. The IPC handler still owns the listener-registration side effects
// (register the forwarding listener BEFORE this runs, per the WP-3a barrier
// contract) and the try/catch that maps a thrown live-attach into {ok:false}.
//
//   LIVE (a runner exists): the write barrier proves which `.log` bytes are
//     durable — `snapshotCutoff` is that proven-readable cutoff and `degraded`
//     flags an epoch whose offset↔file mapping a write error invalidated.
//   DEAD (no runner): `snapshotCutoff` is the persisted `.log` size (fstat) and
//     the epoch is the last one recorded for this agent (null if it was never
//     launched this process). A dead agent is never degraded.

import type { HistoryNotice, TerminalAttachResult } from '../shared/types';

/** The narrow supervisor surface the attach-result builder consumes. Declaring
 *  it here (rather than importing the whole supervisor) keeps the builder unit-
 *  testable against a fake. */
export interface AttachResultSupervisor {
  hasRunner(agentId: string): boolean;
  agentLogWriteBarrier(agentId: string): Promise<{ cutoff: number; degraded: boolean }>;
  agentEpoch(agentId: string): string | null;
  agentLogSize(agentId: string): Promise<number>;
  lastTerminalEpoch: Map<string, string>;
  /** WP-6: DB-backed reclaimed-history marker (WP-4 seam). Carried on the attach
   *  result for BOTH live and dead agents with NO extra `stat`. */
  agentTerminalHistoryNotice(agentId: string): HistoryNotice;
}

/**
 * Build the atomic attach result. Re-derives `live` from `hasRunner` so there is
 * a single source of truth for the returned shape regardless of the caller's
 * branch. Never throws for the dead path; the live path may reject if the
 * barrier does (the IPC handler wraps that into `{ok:false}`).
 */
export async function computeTerminalAttachResult(
  supervisor: AttachResultSupervisor,
  agentId: string,
): Promise<TerminalAttachResult> {
  if (supervisor.hasRunner(agentId)) {
    const { cutoff, degraded } = await supervisor.agentLogWriteBarrier(agentId);
    return {
      ok: true,
      live: true,
      terminalEpoch: supervisor.agentEpoch(agentId),
      snapshotCutoff: cutoff,
      degraded,
      // WP-6: DB marker, no extra stat. The barrier already ran; this is the
      // reclaimed-history disclosure for a revived (marked + growing log) agent.
      historyNotice: supervisor.agentTerminalHistoryNotice(agentId),
    };
  }
  const snapshotCutoff = await supervisor.agentLogSize(agentId);
  return {
    ok: true,
    live: false,
    terminalEpoch: supervisor.lastTerminalEpoch.get(agentId) ?? null,
    snapshotCutoff,
    degraded: false,
    // WP-6: DB marker fetched after the size read (no extra stat of its own).
    historyNotice: supervisor.agentTerminalHistoryNotice(agentId),
  };
}
