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

import type { RequestedPlanBinding, ResolvedPlanStamp } from '../../shared/commit-candidates';
import type { GitCapability } from '../../shared/types';
import type { TurnContext } from './turn-coordinator';

export type { ResolvedPlanStamp } from '../../shared/commit-candidates';

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
  /** Untrusted wire-level request. Its shape deliberately has no `source` field. */
  requestedPlanBinding?: RequestedPlanBinding;
}

/** A symbol-keyed value cannot arrive through JSON or an object-shaped wire binding.
 * Lifecycle rails use `withResolvedPlanStamp`; ordinary callers use
 * `requestedPlanBinding` and are resolved against authoritative state below. */
const TRUSTED_PLAN_STAMP: unique symbol = Symbol('lares.trusted-plan-stamp');
type TrustedStampCarrier = { readonly [TRUSTED_PLAN_STAMP]?: ResolvedPlanStamp };

/** Attach a stamp already resolved by trusted boundary/lifecycle code. The symbol is
 * intentionally private: a `RequestedPlanBinding`, even when coerced, cannot name it. */
export function withResolvedPlanStamp(
  dispatch: DispatchContext,
  stamp: ResolvedPlanStamp,
): DispatchContext {
  const trusted = { ...dispatch } as DispatchContext & TrustedStampCarrier;
  Object.defineProperty(trusted, TRUSTED_PLAN_STAMP, {
    value: Object.freeze({ ...stamp }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return trusted;
}

/**
 * Derive a turn's task label from free prompt text (WP3, defect-2 fallback). Used
 * only when the dispatch carries no explicit `taskLabel` (== dispatch brief). Steps,
 * in order: first non-empty trimmed line → collapse internal whitespace runs to a
 * single space → strip a single leading `@mention` or `-`/`*` bullet marker →
 * truncate to 120 chars. Returns null when nothing usable remains (blank/empty in).
 */
export function deriveTaskLabel(promptText: string | null | undefined): string | null {
  if (!promptText) return null;
  // 1. First non-empty trimmed line.
  let line = '';
  for (const raw of promptText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed) { line = trimmed; break; }
  }
  if (!line) return null;
  // 2. Collapse internal whitespace runs to a single space.
  line = line.replace(/\s+/g, ' ').trim();
  // 3. Strip a single leading @mention or -/* bullet marker (only when followed by
  //    content — a bare marker with nothing after it is left as-is).
  line = line.replace(/^(?:@\S+|[-*])\s+/, '').trim();
  if (!line) return null;
  // 4. Truncate to 120 chars.
  if (line.length > 120) line = line.slice(0, 120).trimEnd();
  return line || null;
}

/** The minimal agent shape the builder reads (a subset of the DB `Agent`). */
export interface DispatchAgentInfo {
  workspaceId: string;
  planId?: string | null;
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
  /** Authoritative plan/workspace membership check. Required for an explicit plan;
   * optional during the 2B→2C wiring transition, where absence fails closed. */
  planInWorkspace?: (workspaceId: string, planId: string) => boolean;
  /** Stage ③ plugs the plan_work_packages lookup into this seam. Stage ② rejects
   * every non-null item before consulting it. */
  planItemInPlan?: (workspaceId: string, planId: string, planItemId: string) => boolean;
}

export type PlanBindingResolution =
  | { ok: true; stamp: ResolvedPlanStamp }
  | {
      ok: false;
      reason: 'invalid-plan-id' | 'plan-not-in-workspace' | 'plan-item-unsupported';
    };

const MAX_PLAN_ID_UTF8_BYTES = 256;

/** Resolve only wire-safe sources. Carry sources are impossible through this API;
 * they can enter a DispatchContext only through `withResolvedPlanStamp`. */
export function resolveRequestedPlanBinding(
  deps: DispatchDeps,
  agent: DispatchAgentInfo,
  requested: RequestedPlanBinding | undefined,
): PlanBindingResolution {
  const binding = requested ?? { mode: 'agent-default' };
  if (binding.mode === 'none') {
    return { ok: true, stamp: { planId: null, planItemId: null, source: 'explicit-none' } };
  }
  if (binding.mode === 'agent-default') {
    return {
      ok: true,
      stamp: { planId: agent.planId ?? null, planItemId: null, source: 'agent-default' },
    };
  }

  // Runtime checks are intentional: the HTTP/IPC body is not made trustworthy by
  // satisfying the compile-time union. Preserve the exact id; never trim/fallback.
  if (
    typeof binding.planId !== 'string'
    || binding.planId.length === 0
    || Buffer.byteLength(binding.planId, 'utf8') > MAX_PLAN_ID_UTF8_BYTES
  ) {
    return { ok: false, reason: 'invalid-plan-id' };
  }
  let planIsValid = false;
  try {
    planIsValid = deps.planInWorkspace?.(agent.workspaceId, binding.planId) ?? false;
  } catch {
    // Validation infrastructure failures are never an excuse to accept or fall back.
  }
  if (!planIsValid) {
    return { ok: false, reason: 'plan-not-in-workspace' };
  }
  if (binding.planItemId !== null) {
    // Do not call an always-true placeholder. There is no authoritative item entity
    // until plan_work_packages lands in Stage ③.
    return { ok: false, reason: 'plan-item-unsupported' };
  }
  return {
    ok: true,
    stamp: { planId: binding.planId, planItemId: null, source: 'explicit' },
  };
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
  const trustedStamp = (dispatch as DispatchContext & TrustedStampCarrier)[TRUSTED_PLAN_STAMP];
  const resolution = trustedStamp
    ? { ok: true as const, stamp: trustedStamp }
    : resolveRequestedPlanBinding(deps, agent, dispatch.requestedPlanBinding);
  // Boundary code rejects invalid explicit bindings before enqueue. Keep this
  // builder non-throwing/fail-open if a legacy caller bypasses that boundary.
  if (!resolution.ok) return null;

  return {
    workspaceId: agent.workspaceId,
    agentId,
    capability,
    agentTitle: agent.title ?? null,
    ownerAgentId,
    ownerBrickGeneration,
    planStamp: resolution.stamp,
    sessionId: dispatch.sessionId ?? agent.resumeSessionId ?? null,
    taskLabel: dispatch.taskLabel ?? null,
    quality: 'guaranteed',
  };
}
