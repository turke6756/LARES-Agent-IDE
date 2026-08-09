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
import type { GitCapability, ResolvedIntentStamp } from '../../shared/types';
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

export interface PlanningActivityBinding {
  executionRunId: string;
  path: string;
  repositoryKey: string;
  objectDatabaseKey: string;
}

/** A symbol-keyed value cannot arrive through JSON or an object-shaped wire binding.
 * Lifecycle rails use `withResolvedPlanStamp`; ordinary callers use
 * `requestedPlanBinding` and are resolved against authoritative state below. */
const TRUSTED_PLAN_STAMP: unique symbol = Symbol('lares.trusted-plan-stamp');
const TRUSTED_INTENT_STAMP: unique symbol = Symbol('lares.trusted-intent-stamp');
const TRUSTED_ACTIVITY_BINDING: unique symbol = Symbol('lares.trusted-activity-binding');
type TrustedStampCarrier = { readonly [TRUSTED_PLAN_STAMP]?: ResolvedPlanStamp };
type TrustedIntentCarrier = { readonly [TRUSTED_INTENT_STAMP]?: ResolvedIntentStamp };
type TrustedActivityCarrier = { readonly [TRUSTED_ACTIVITY_BINDING]?: PlanningActivityBinding };

function copyTrustedCarriers(
  source: DispatchContext,
  target: DispatchContext,
  skip: 'plan' | 'intent' | 'activity',
): void {
  const trusted = source as DispatchContext & TrustedStampCarrier & TrustedIntentCarrier & TrustedActivityCarrier;
  const targetTrusted = target as DispatchContext & TrustedStampCarrier & TrustedIntentCarrier & TrustedActivityCarrier;
  const planStamp = trusted[TRUSTED_PLAN_STAMP];
  const intentStamp = trusted[TRUSTED_INTENT_STAMP];
  const activity = trusted[TRUSTED_ACTIVITY_BINDING];
  if (planStamp && skip !== 'plan') Object.defineProperty(targetTrusted, TRUSTED_PLAN_STAMP, {
    value: planStamp, enumerable: false, writable: false, configurable: false,
  });
  if (intentStamp && skip !== 'intent') Object.defineProperty(targetTrusted, TRUSTED_INTENT_STAMP, {
    value: intentStamp, enumerable: false, writable: false, configurable: false,
  });
  if (activity && skip !== 'activity') Object.defineProperty(targetTrusted, TRUSTED_ACTIVITY_BINDING, {
    value: activity, enumerable: false, writable: false, configurable: false,
  });
}

/** Attach a stamp already resolved by trusted boundary/lifecycle code. The symbol is
 * intentionally private: a `RequestedPlanBinding`, even when coerced, cannot name it. */
export function withResolvedPlanStamp(
  dispatch: DispatchContext,
  stamp: ResolvedPlanStamp,
): DispatchContext {
  const trusted = { ...dispatch } as DispatchContext & TrustedStampCarrier;
  copyTrustedCarriers(dispatch, trusted, 'plan');
  const carriedIntent = (stamp as ResolvedPlanStamp & {
    intentStamp?: ResolvedIntentStamp;
  }).intentStamp;
  Object.defineProperty(trusted, TRUSTED_PLAN_STAMP, {
    value: Object.freeze({
      planId: stamp.planId,
      planItemId: stamp.planItemId,
      source: stamp.source,
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  if (carriedIntent && !(trusted as DispatchContext & TrustedIntentCarrier)[TRUSTED_INTENT_STAMP]) {
    Object.defineProperty(trusted, TRUSTED_INTENT_STAMP, {
      value: Object.freeze({ ...carriedIntent }),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return trusted;
}

/** Attach a main-resolved intent stamp through a non-wire, private-symbol carrier. */
export function withResolvedIntentStamp(
  dispatch: DispatchContext,
  stamp: ResolvedIntentStamp,
): DispatchContext {
  const trusted = { ...dispatch } as DispatchContext & TrustedIntentCarrier;
  copyTrustedCarriers(dispatch, trusted, 'intent');
  Object.defineProperty(trusted, TRUSTED_INTENT_STAMP, {
    value: Object.freeze({ ...stamp }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return trusted;
}

/** Attach the DB-resolved physical execution root. Private-symbol carriage prevents
 * an API/request body from redirecting checkpoint capability to an arbitrary cwd. */
export function withPlanningActivityBinding(
  dispatch: DispatchContext,
  binding: PlanningActivityBinding,
): DispatchContext {
  const trusted = { ...dispatch } as DispatchContext & TrustedActivityCarrier;
  copyTrustedCarriers(dispatch, trusted, 'activity');
  Object.defineProperty(trusted, TRUSTED_ACTIVITY_BINDING, {
    value: Object.freeze({ ...binding }), enumerable: false, writable: false, configurable: false,
  });
  return trusted;
}

/**
 * Resolve the explicit plan+package binding used by the planning-surface package
 * dispatcher, then freeze that already-validated stamp onto the internal dispatch
 * carrier. This deliberately goes THROUGH `resolveRequestedPlanBinding` first, so
 * SC-WP-3A item membership and the WP-P5C active-run gate remain authoritative;
 * callers cannot use the trusted carrier to bypass either check.
 */
export function resolvePackageDispatchContext(
  deps: DispatchDeps,
  agent: DispatchAgentInfo,
  input: {
    ownerAgentId: string | null;
    planId: string;
    planItemId: string;
    taskLabel?: string | null;
  },
): Extract<PlanBindingResolution, { ok: false }>
  | (Extract<PlanBindingResolution, { ok: true }> & { dispatch: DispatchContext }) {
  const resolution = resolveRequestedPlanBinding(deps, agent, {
    mode: 'explicit',
    planId: input.planId,
    planItemId: input.planItemId,
  });
  if (!resolution.ok) return resolution;
  return {
    ...resolution,
    dispatch: withResolvedPlanStamp({
      origin: 'orchestration',
      ownerAgentId: input.ownerAgentId,
      taskLabel: input.taskLabel ?? null,
    }, resolution.stamp),
  };
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
  workingDirectory?: string;
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
  /** WP-5 trusted run binding; production probes this physical worktree path. */
  resolveActivityCapability?: (binding: PlanningActivityBinding) => Promise<GitCapability | null>;
  /** Authoritative plan/workspace membership check. Required for an explicit plan;
   * optional during the 2B→2C wiring transition, where absence fails closed. */
  planInWorkspace?: (workspaceId: string, planId: string) => boolean;
  /** Authoritative plan_work_packages item lookup (SC-WP-3A). When wired, a
   * non-null item is validated against (workspace_id, plan_id, id). A boundary
   * that does NOT wire this lookup fails closed — items are rejected there as
   * unsupported rather than accepted through an always-true seam. */
  planItemInPlan?: (workspaceId: string, planId: string, planItemId: string) => boolean;
  /**
   * WP-P5D agent-default source. Production resolves this from the dispatcher's
   * `supervisor_active_plan`, returning a plan only while its execution run is
   * active. The target agent's `planId` remains the compatibility fallback for
   * older boundaries that have not wired the P5D source seam. A lookup failure
   * defaults to no plan; it must never revive a stale agent/focus binding.
   */
  resolveActivePlanDefault?: (agent: DispatchAgentInfo) => string | null;
  /**
   * WP-P5C-gate: the authoritative pre-Implement gate for a resolved plan binding,
   * keyed by the globally-unique plan id. It reports whether the plan is a
   * `format='structured'` plan and, if so, whether it currently has an ACTIVE
   * execution run (`getActivePlanExecutionRun`). A structured plan WITHOUT an active
   * run cannot be bound to a worker before Implement — the human trigger that mints
   * the run is the only thing that opens the gate. Legacy HTML/md plans report
   * `isStructured:false` and are NEVER gated (their behavior is unchanged). Returns
   * null when the plan is unknown to the gate (treated as ungated — legacy). A
   * boundary that does NOT wire this leaves the gate inactive; the pre-P5 boundaries
   * carried no structured plans, so that is the transition-safe default. */
  planImplementGate?: (planId: string) => PlanImplementGate | null;
}

/** The pre-Implement gate verdict for a single plan (WP-P5C-gate). */
export interface PlanImplementGate {
  /** True iff the plan row is `format='structured'`. */
  isStructured: boolean;
  /** True iff `getActivePlanExecutionRun(planId)` returned a live run. */
  hasActiveExecutionRun: boolean;
}

export type PlanBindingResolution =
  | { ok: true; stamp: ResolvedPlanStamp }
  | {
      ok: false;
      reason:
        | 'invalid-plan-id'
        | 'plan-not-in-workspace'
        | 'plan-item-unsupported'
        | 'invalid-plan-item-id'
        | 'plan-item-not-in-plan'
        | 'structured-plan-not-implemented';
    };

const MAX_PLAN_ID_UTF8_BYTES = 256;

/**
 * WP-P5C-gate chokepoint. Wraps a resolved stamp in the pre-Implement gate so EVERY
 * bound plan — explicit-plan, explicit-plan+item, or agent-default — is refused when
 * it names a `format='structured'` plan that lacks an active execution run. A null
 * planId (`explicit-none`, or an agent with no default plan) is never gated. When no
 * gate is wired, the seam is inactive (legacy boundaries carried no structured plans).
 * A gate lookup that THROWS fails closed: we cannot prove the plan is dispatchable, so
 * it is refused (validation-infra failures are never an excuse to open the gate).
 */
function gateResolvedStamp(deps: DispatchDeps, stamp: ResolvedPlanStamp): PlanBindingResolution {
  if (stamp.planId === null || !deps.planImplementGate) return { ok: true, stamp };
  let gate: PlanImplementGate | null;
  try {
    gate = deps.planImplementGate(stamp.planId);
  } catch {
    return { ok: false, reason: 'structured-plan-not-implemented' };
  }
  // A legacy/unknown plan (null verdict or isStructured:false) is passed through
  // unchanged. Only an affirmatively structured plan with no active run is refused.
  if (gate && gate.isStructured && !gate.hasActiveExecutionRun) {
    return { ok: false, reason: 'structured-plan-not-implemented' };
  }
  return { ok: true, stamp };
}

/** Resolve only wire-safe sources. Carry sources are impossible through this API;
 * they can enter a DispatchContext only through `withResolvedPlanStamp`. */
export function resolveRequestedPlanBinding(
  deps: DispatchDeps,
  agent: DispatchAgentInfo,
  requested: RequestedPlanBinding | undefined,
): PlanBindingResolution {
  const binding = requested ?? { mode: 'agent-default' };
  if (binding.mode === 'none') {
    return gateResolvedStamp(deps, { planId: null, planItemId: null, source: 'explicit-none' });
  }
  if (binding.mode === 'agent-default') {
    let planId = agent.planId ?? null;
    if (deps.resolveActivePlanDefault) {
      try {
        planId = deps.resolveActivePlanDefault(agent);
      } catch {
        planId = null;
      }
    }
    return gateResolvedStamp(deps, {
      planId, planItemId: null, source: 'agent-default',
    });
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
    // SC-WP-3A: item stamping is enabled — validate against the authoritative
    // plan_work_packages entity, keyed on (workspace_id, plan_id, id). A boundary
    // that does not wire the lookup fails closed (never an always-true seam).
    if (!deps.planItemInPlan) {
      return { ok: false, reason: 'plan-item-unsupported' };
    }
    if (
      typeof binding.planItemId !== 'string'
      || binding.planItemId.length === 0
      || Buffer.byteLength(binding.planItemId, 'utf8') > MAX_PLAN_ID_UTF8_BYTES
    ) {
      return { ok: false, reason: 'invalid-plan-item-id' };
    }
    let itemIsValid = false;
    try {
      itemIsValid = deps.planItemInPlan(agent.workspaceId, binding.planId, binding.planItemId);
    } catch {
      // Validation infrastructure failures are never an excuse to accept or fall back.
    }
    if (!itemIsValid) {
      return { ok: false, reason: 'plan-item-not-in-plan' };
    }
    return gateResolvedStamp(deps, {
      planId: binding.planId, planItemId: binding.planItemId, source: 'explicit',
    });
  }
  return gateResolvedStamp(deps, {
    planId: binding.planId, planItemId: null, source: 'explicit',
  });
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

  const activityBinding = (dispatch as DispatchContext & TrustedActivityCarrier)[TRUSTED_ACTIVITY_BINDING];
  const capability = activityBinding && deps.resolveActivityCapability
    ? await deps.resolveActivityCapability(activityBinding)
    : await deps.resolveCapability(agent);
  if (!capability || !capability.repoRoot) return null; // non-repo/unusable → skip

  // Owner is NULL for a human terminal; otherwise the caller-named owner, whose
  // brick generation is read SERVER-SIDE (never from the dispatch body).
  const humanTerminal = dispatch.origin === 'human-terminal';
  const ownerAgentId = humanTerminal ? null : dispatch.ownerAgentId ?? null;
  const owner = ownerAgentId ? deps.getAgent(ownerAgentId) : null;
  const ownerBrickGeneration = owner ? owner.continuationGeneration ?? 0 : null;
  // A trusted stamp arrives only through `withResolvedPlanStamp` from lifecycle rails
  // (e.g. the Implement/dispatch service that has ALREADY minted the execution run), so
  // it bypasses the WP-P5C-gate pre-Implement check applied to wire/default bindings.
  const trustedStamp = (dispatch as DispatchContext & TrustedStampCarrier)[TRUSTED_PLAN_STAMP];
  const trustedIntentStamp = (dispatch as DispatchContext & TrustedIntentCarrier)[TRUSTED_INTENT_STAMP];
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
    intentStamp: trustedIntentStamp,
    sessionId: dispatch.sessionId ?? agent.resumeSessionId ?? null,
    taskLabel: dispatch.taskLabel ?? null,
    quality: 'guaranteed',
  };
}
