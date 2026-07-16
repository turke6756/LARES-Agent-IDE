import type { Agent } from '../../../shared/types';
import { hasSupervisorPrivilege } from '../../../shared/types';

// ── Context-brick continuation split-button: renderer-local contract mirror ──
//
// The split button drives two preload methods the PARALLEL worker owns
// (src/preload + src/shared/types.ts). Because this worker must not edit those
// files, the contract is mirrored here and reached through a null-tolerant
// accessor — exactly the `getBrowserApi()` pattern in stores/browser-store.ts.
// Until the parallel side merges, getContinuationApi() returns null and the
// button self-disables with an "unavailable" note instead of crashing.
//
// Contract (pinned):
//   setContinuationEnabled(agentId, enabled) -> { ok: boolean }
//   forceContinuationHandoff(agentId)        -> { ok: boolean; error?: string }
//   Agent.continuationEnabled: boolean  (rides the agent payload)

export interface ContinuationApi {
  setContinuationEnabled(agentId: string, enabled: boolean): Promise<{ ok: boolean }>;
  forceContinuationHandoff(agentId: string): Promise<{ ok: boolean; error?: string }>;
}

/** Null-tolerant accessor. Returns the two contract methods only when BOTH are
 *  present on `window.api.agents` at runtime; otherwise null so callers can
 *  render an inert control instead of throwing. The `unknown` cast lets this
 *  compile whether or not IpcApi has been extended with the methods yet. */
export function getContinuationApi(): ContinuationApi | null {
  if (typeof window === 'undefined') return null;
  const agents = (window as unknown as { api?: { agents?: Partial<ContinuationApi> } }).api?.agents;
  if (
    !agents ||
    typeof agents.setContinuationEnabled !== 'function' ||
    typeof agents.forceContinuationHandoff !== 'function'
  ) {
    return null;
  }
  return agents as ContinuationApi;
}

/** The continuation split button belongs on SUPERVISOR-PRIVILEGED cards only. The
 *  auto continuation watcher in main is supervisor-privilege-scoped
 *  (continuation-watcher-wiring filters on `hasSupervisorPrivilege && provider ===
 *  'claude'`) — the structural workspace supervisor AND a privilegeLane:'supervisor'
 *  persona (#19). Workers are handed off by their supervisor via dashboard events,
 *  so worker cards must not show the control. Missing provider defaults to claude,
 *  matching the rest of the card code (`agent.provider || 'claude'`). */
export function isContinuationEligible(agent: Pick<Agent, 'provider' | 'isSupervisor' | 'privilegeLane'>): boolean {
  return hasSupervisorPrivilege(agent) && (agent.provider ?? 'claude') === 'claude';
}

/** Read the agent's continuation flag tolerantly. The field rides the agent
 *  payload once the parallel worker adds it to the Agent type; until then it is
 *  absent, so we default to `true` (feature on) and reconcile from the next
 *  refresh. Read via an index cast so this compiles before the type lands. */
export function getContinuationEnabled(agent: Agent): boolean {
  const v = (agent as { continuationEnabled?: boolean }).continuationEnabled;
  return v === undefined ? true : v;
}

/** Turn a forceContinuationHandoff outcome into a short, unobtrusive message —
 *  or null when it succeeded. Mirrors browser-store's navErrorMessage(): pure,
 *  so the button's error surfacing is unit-testable without React. Pass a caught
 *  value as `thrown` for the IPC-rejected path. */
export function forceErrorMessage(
  res: { ok: boolean; error?: string } | null | undefined,
  thrown?: unknown,
): string | null {
  if (thrown !== undefined) {
    const raw = thrown instanceof Error ? thrown.message : String(thrown);
    return raw.trim() ? `Transfer failed — ${raw.trim()}` : 'Transfer failed';
  }
  if (!res) return 'Transfer unavailable';
  if (res.ok) return null;
  return res.error?.trim() ? `Transfer failed — ${res.error.trim()}` : 'Transfer failed';
}
