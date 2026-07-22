import type { ContinuationPhase, ContinuationPhaseState, ContinuationPhaseSignal } from '../../../shared/types';

// Pure view logic for the continuation handoff's live phase — the replacement
// for continuation-transfer.ts, which derived "is this agent transferring?" from
// the statusChanged stream.
//
// Why that derivation was replaced rather than extended: `restarting` +
// `source:'continuation'` is emitted at the very END of the cycle (the session
// swap), so the flag — and the 2.4 s gold glow bound to it — existed for a
// sub-second window at the tail of a 30–150 s operation. The phase rail is
// published by the watcher from the FIRST moment (the press) and is
// main-authoritative, so the same visual now covers the whole cycle.
//
// Everything here is pure so the store/card behavior is unit-testable without
// React, the IPC bridge, or a clock.

/** Base label per phase. `backoff` and `failed` compose further copy from the
 *  state's `message` / `retryAt` — see continuationPhaseLabel. */
export const CONTINUATION_PHASE_LABELS: Record<ContinuationPhase, string> = {
  'queued': 'Continuation queued…',
  'opening': 'Opening handoff…',
  'awaiting-note': 'Waiting for agent to save note…',
  'note-committed': 'Continuation note saved',
  'waiting-for-idle': 'Finishing current response…',
  'relaunching': 'Switching sessions…',
  'launching': 'Starting fresh session…',
  'backoff': 'Retrying…',
  'failed': 'Continuation failed',
};

/** Does this phase mean "a handoff is running"? Drives the gold glow.
 *
 *  `failed` is excluded deliberately: it is a PERSISTENT terminal label with no
 *  automatic retry behind it, and an animation that never stops would read as
 *  "still working" forever. `backoff` IS included — a retry is genuinely
 *  scheduled, and that is exactly the stretch the old flag left dark. */
export function isActivePhase(phase: ContinuationPhase | null | undefined): boolean {
  return Boolean(phase) && phase !== 'failed';
}

/** `4m 58s` / `45s`. Floors at 0 so a passed deadline reads `0s` rather than a
 *  negative countdown while the next tick is still pending. */
export function formatRetryCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/** The one compact line the card renders under its header. `now` is passed in
 *  (never read from a clock here) so the countdown is deterministic in tests and
 *  driven by the component's own 1 s display timer — main sends no countdown
 *  events. */
export function continuationPhaseLabel(
  state: Pick<ContinuationPhaseState, 'phase' | 'message' | 'retryAt'>,
  now: number,
): string {
  const base = CONTINUATION_PHASE_LABELS[state.phase];
  if (state.phase === 'backoff') {
    const head = state.retryAt !== undefined
      ? `Retry in ${formatRetryCountdown(state.retryAt - now)}`
      : 'Retrying';
    return state.message ? `${head} — ${state.message}` : `${head}…`;
  }
  if (state.phase === 'failed') {
    return state.message ? `Continuation failed: ${state.message}` : base;
  }
  return base;
}

/** Fold one authoritative phase signal into the map. `phase: null` DELETES —
 *  it is the completion signal, not a phase. Returns the SAME object reference
 *  when nothing changed so callers can skip the state write. */
export function nextPhaseMap(
  current: Readonly<Record<string, ContinuationPhaseState>>,
  signal: ContinuationPhaseSignal,
): Record<string, ContinuationPhaseState> {
  if (signal.phase === null) {
    if (!(signal.agentId in current)) return current as Record<string, ContinuationPhaseState>;
    const next = { ...current };
    delete next[signal.agentId];
    return next;
  }
  return { ...current, [signal.agentId]: signal };
}

/** Missed-event safety, narrowly scoped. A generic agent refresh must NEVER
 *  clear a phase just because the agent's status is not 'restarting' — that was
 *  precisely the old reconcileTransferSet bug that erased an independent
 *  operation. The only thing a refresh proves is that an agent is GONE, so the
 *  only entries dropped are ones whose agent is absent from an authoritative
 *  list AND was in scope for that list (`inScope`). A workspace-scoped refresh
 *  passes an `inScope` predicate so it cannot touch other workspaces' agents. */
export function prunePhasesForAgents(
  current: Readonly<Record<string, ContinuationPhaseState>>,
  presentAgentIds: ReadonlySet<string>,
  inScope: (agentId: string) => boolean = () => true,
): Record<string, ContinuationPhaseState> {
  const doomed = Object.keys(current).filter((id) => !presentAgentIds.has(id) && inScope(id));
  if (doomed.length === 0) return current as Record<string, ContinuationPhaseState>;
  const next = { ...current };
  for (const id of doomed) delete next[id];
  return next;
}
