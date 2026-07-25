// dispatch-context.ts — the send-path dispatch context + server-side turn-context
// builder (Git-Native WP-G1.7). MAIN-PROCESS ONLY.
//
// The send path carries a small DispatchContext from the API/orchestration caller
// (or a human terminal) down to `_deliverAndConfirm`. From it the coordinator's
// `TurnContext` is assembled AT DISPATCH, server-side. Two identity rules are
// load-bearing (plan WP-G1.7):
//   • `ownerBrickGeneration` is NEVER supplied by the caller — it is read here from
//     the OWNER agent's current generation. DispatchContext has no slot for it, so a
//     caller cannot inject one through the typed API; even a coerced value is
//     ignored because this builder always overwrites it from authoritative state
//     (mirrors the X-Supervisor-Id-derives-owner pattern in api-server.ts).
//   • A `human-terminal` send is owner-less: `owner_agent_id` is forced NULL
//     regardless of any ownerAgentId the caller passed.

import type { GitCapability } from '../../shared/types';
import type { TurnContext } from './turn-coordinator';

/** Where a send originated. Human terminals are owner-less; orchestration/api sends
 *  carry an owning supervisor (derived server-side, never trusted from the body). */
export type DispatchOrigin = 'orchestration' | 'human-terminal' | 'api';

/** The caller-supplied dispatch context. Note the DELIBERATE absence of
 *  `ownerBrickGeneration` — it is derived server-side (see module header). */
export interface DispatchContext {
  origin: DispatchOrigin;
  /** The owning supervisor agent id for an orchestration/api send. Ignored (forced
   *  NULL) for a `human-terminal` send. */
  ownerAgentId?: string | null;
  taskLabel?: string | null;
  sessionId?: string | null;
}

/** The minimal agent shape the builder reads (a subset of the DB `Agent`). */
export interface DispatchAgentInfo {
  workspaceId: string;
  title?: string | null;
  resumeSessionId?: string | null;
  continuationGeneration?: number | null;
}

export interface DispatchDeps {
  /** Look up an agent (self + owner) — bound to database.ts `getAgent` in prod. */
  getAgent: (id: string) => DispatchAgentInfo | null;
  /** Resolve the agent's canonical-workspace git capability (bootstrap caches a
   *  per-workspace probe). Returns null when the workspace is not a usable repo —
   *  the caller then skips the checkpoint entirely (delivery still proceeds). */
  resolveCapability: (agent: DispatchAgentInfo) => Promise<GitCapability | null>;
}

/**
 * Assemble a coordinator `TurnContext` from a DispatchContext at dispatch time.
 * Returns null when the agent is unknown or its workspace is not a usable git repo
 * (no checkpoint is taken; delivery is unaffected).
 */
export async function buildDispatchTurnContext(
  deps: DispatchDeps,
  agentId: string,
  dispatch: DispatchContext,
): Promise<TurnContext | null> {
  const agent = deps.getAgent(agentId);
  if (!agent) return null;

  const capability = await deps.resolveCapability(agent);
  if (!capability || !capability.repoRoot) return null; // non-repo/unusable → skip

  // Owner is NULL for a human terminal; otherwise the caller-named owner, whose
  // brick generation is read SERVER-SIDE (never from the dispatch body).
  const humanTerminal = dispatch.origin === 'human-terminal';
  const ownerAgentId = humanTerminal ? null : dispatch.ownerAgentId ?? null;
  const owner = ownerAgentId ? deps.getAgent(ownerAgentId) : null;
  const ownerBrickGeneration = owner ? owner.continuationGeneration ?? 0 : null;

  return {
    workspaceId: agent.workspaceId,
    agentId,
    capability,
    agentTitle: agent.title ?? null,
    ownerAgentId,
    ownerBrickGeneration,
    sessionId: dispatch.sessionId ?? agent.resumeSessionId ?? null,
    taskLabel: dispatch.taskLabel ?? null,
    quality: 'guaranteed',
  };
}
