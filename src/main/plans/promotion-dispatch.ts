// WP-P3B-core — promotion delivery adapter + delivery oracle.
//
// This module owns the crash-safe two-phase bind-before-deliver dispatch and the
// restart-time inspection that decides, from durable evidence alone, exactly
// where a prior attempt got to. It is the "live-process back half" that
// promote-proposal.ts hands the dispatch to; the front half (identity, de-dup,
// branch) lives there.
//
// The frozen lifecycle (spec §R-P3 points 5, 6; WP-P3B-core step 4):
//   Phase 1  reserve the promotion orchestration row (status 'starting',
//            promotion.reserved) AND bind promotion_requests.orchestration_id —
//            atomically, BEFORE any launch (reservePromotionOrchestration).
//   Phase 2a atomic agent+member+event txn INSIDE launchAgent
//            (bindPromotionAgentAtomic, driven by the trusted
//            InternalLaunchContext) — no promotion task in initialUserPrompt.
//   Phase 2b confirmed delivery: persist promotion.delivery_attempt BEFORE the
//            confirmed send, submit the marked prompt through the
//            turn-start-confirmed seam, and write promotion.delivered + flip the
//            run to 'running' ONLY after a matching turn-start confirmation.
//
// Run status only ever moves 'starting' → 'running'; the internal phases are
// distinguished by the promotion.* events, never by new status values.

import type { Agent, LaunchAgentInput } from '../../shared/types';
import { isPlanArtifactId, isProposalArtifactId } from '../../shared/planning-artifact-ids';
import type { OrchestrationRun, SendInputConfirmedResult } from '../orchestration/types';
// Type-only import — erased at compile time, so no runtime cycle with the
// supervisor module. InternalLaunchContext is main-process-only (never in
// src/shared/types.ts): the trusted binding a plain API/IPC caller cannot supply.
import type { InternalLaunchContext } from '../supervisor';
import {
  reservePromotionOrchestration,
  recordPromotionDeliveryAttempt,
  recordPromotionDelivered,
  recordPromotionFailed,
  getPromotionWorkerMember,
  hasOrchestrationEvent,
  getOrchestrationRun,
  getAgent,
  type PromotionRequestRow,
} from '../database';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The narrow supervisor surface the promotion adapter needs. AgentSupervisor
 *  satisfies this structurally — `launchAgent(input, internal)` runs Phase 2a
 *  atomically, `sendInputConfirmed` is the turn-start-confirmed send seam, and
 *  `resubmitEnter` re-presses only the submit keystroke (dropped-Enter recovery,
 *  never a body). Injected so the dispatch/oracle are unit-testable with a fake. */
export interface PromotionDeliverer {
  launchAgent(input: LaunchAgentInput, internal: InternalLaunchContext): Promise<Agent>;
  sendInputConfirmed(agentId: string, text: string): Promise<SendInputConfirmedResult>;
  resubmitEnter?(agentId: string): void;
}

/** Reads durable chat/turn evidence for the bound agent: has a turn STARTED
 *  since `sinceIso`? The oracle uses this — not the in-memory send result — so a
 *  restart can still tell `submitted-unconfirmed` from `delivered`. Injected;
 *  production wires it to turn-record / session-log evidence. */
export type TurnStartWitness = (agentId: string, sinceIso?: string) => boolean | Promise<boolean>;

export interface PromotionDispatchInput {
  request: PromotionRequestRow;
  workspaceId: string;
  supervisorId: string;
  /** The full marked prompt body — deterministic identity + promotionRequestId +
   *  responsibility bootstrap event_id + marker; NEVER a document list (§P3-GAP). */
  prompt: string;
  /** Stable delivery marker `promotion:<requestId>`. */
  marker: string;
  /** LaunchAgentInput for the planning worker — carries NO initialUserPrompt
   *  (the promotion task is delivered in Phase 2b, not via the fire-and-forget
   *  initial-prompt rail). */
  launchInput: LaunchAgentInput;
  /** true for a failed → pending retry (attempt_count++, new attempt row). */
  retry: boolean;
  deliverer: PromotionDeliverer;
  now: () => string;
  genRunId: () => string;
}

export interface PromotionDispatchResult {
  runId: string;
  agentId: string;
  /** true once a matching turn-start confirmed delivery (promotion.delivered
   *  written, run → running). false = submitted-unconfirmed, request stays
   *  pending for the reconciler's submit-only resume. */
  delivered: boolean;
}

function buildPromotionRun(runId: string, input: PromotionDispatchInput, iso: string): OrchestrationRun {
  return {
    runId,
    name: 'promotion',
    mode: 'serial',
    status: 'starting',
    workspaceId: input.workspaceId,
    supervisorId: input.supervisorId,
    topic: `promote:${input.request.proposalArtifactId}`,
    // No plan rail; the planning worker scaffolds the folder itself. planPath is
    // a required column — the deterministic target folder is the honest value.
    planPath: input.request.targetFolderRelPath,
    leadProvider: 'claude',
    reviewerProvider: 'claude',
    turnTimeoutMs: 600_000,
    lastRelayedTs: {},
    startedAt: iso,
    updatedAt: iso,
    planBindingMode: 'agent-default',
  };
}

/** The crash-safe dispatch (Phase 1 → 2a → 2b). Every boundary leaves durable
 *  evidence the oracle can read; nothing here writes scaffold bytes or touches
 *  plan.json (that is the worker's job). Returns the runId/agentId + whether
 *  delivery was confirmed. */
export async function dispatchPromotion(input: PromotionDispatchInput): Promise<PromotionDispatchResult> {
  if (!isProposalArtifactId(input.request.proposalArtifactId)
      || !isPlanArtifactId(input.request.planArtifactId)
      || input.request.planArtifactId.slice('plan_'.length)
        !== input.request.proposalArtifactId.slice('prop_'.length)) {
    throw new Error('promotion dispatch rejected non-contract or mismatched portable artifact identity');
  }
  const runId = input.genRunId();

  // ── Phase 1 — reserve orchestration + bind onto the request, atomically,
  //    BEFORE any launchAgent call. This is the bind-before-delivery gap the
  //    auto-executing orchestration/service.ts (insertOrchestration→execute())
  //    does not provide — hence the promotion-specific lifecycle here.
  const reserveTs = input.now();
  reservePromotionOrchestration({
    requestId: input.request.id,
    run: buildPromotionRun(runId, input, reserveTs),
    ts: reserveTs,
    incrementAttempt: input.retry,
  });

  // ── Phase 2a — atomic agent+binding txn INSIDE launchAgent. The trusted
  //    InternalLaunchContext drives bindPromotionAgentAtomic (agent row + worker
  //    member + promotion.agent_bound event + orchestration touch, one txn),
  //    THEN the process spawns. A crash before that commit → no agent, no member
  //    (reserved-unbound); after it → the exact bound agent.
  let agent: Agent;
  try {
    agent = await input.deliverer.launchAgent(input.launchInput, {
      orchestrationBinding: { runId, role: 'worker', evidenceKind: 'promotion' },
    });
  } catch (err) {
    recordPromotionFailed({
      requestId: input.request.id, runId, ts: input.now(),
      reason: `launch-failed: ${errMsg(err)}`,
    });
    throw err;
  }

  // ── Phase 2b — confirmed delivery, attempt-logged. Persist the attempt BEFORE
  //    entering the confirmed send so restart inspection distinguishes "never
  //    attempted" (bound-undelivered) from "attempt interrupted"
  //    (submitted-unconfirmed).
  recordPromotionDeliveryAttempt(runId, input.now(), input.marker);
  let confirmed = false;
  try {
    const res = await input.deliverer.sendInputConfirmed(agent.id, input.prompt);
    confirmed = res.confirmed;
  } catch (err) {
    // A hard delivery failure (no runner accepted the bytes) — terminal for this
    // attempt. A retry may go failed → pending only after this is witnessed.
    recordPromotionFailed({
      requestId: input.request.id, runId, ts: input.now(),
      reason: `delivery-failed: ${errMsg(err)}`,
    });
    throw err;
  }

  // Record delivered + status → running ONLY on a matching turn-start
  // confirmation — never on submission, never on launchAgent return.
  if (confirmed) recordPromotionDelivered(runId, input.now());
  return { runId, agentId: agent.id, delivered: confirmed };
}

// ── Delivery oracle ─────────────────────────────────────────────────────────

export type DeliveryProbe =
  | { state: 'not-reserved' }
  | { state: 'reserved-unbound' }
  | { state: 'bound-undelivered'; agentId: string }
  | { state: 'submitted-unconfirmed'; agentId: string }
  | { state: 'delivered'; agentId: string }
  | { state: 'indeterminate'; boundAgentId?: string; diagnostic: string };

export interface PromotionDeliveryInspector {
  inspectDelivery(orchestrationId: string): Promise<DeliveryProbe>;
  /** Confirm turn start only — re-press submit, re-witness; NEVER retype a body. */
  resumeSubmitOnly(orchestrationId: string): Promise<void>;
}

/** Marker AND matching turn-start required; submission is not delivery. Because
 *  the worker member is bound (Phase 2a) BEFORE any send, a crash after agent
 *  creation always leaves the member row → recovery finds the exact bound agent;
 *  a crash before it → no member → provably reserved-unbound. */
export class PromotionDeliveryInspectorImpl implements PromotionDeliveryInspector {
  constructor(
    private readonly deliverer: PromotionDeliverer,
    private readonly turnStartWitness: TurnStartWitness,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async inspectDelivery(orchestrationId: string): Promise<DeliveryProbe> {
    const run = getOrchestrationRun(orchestrationId);
    if (!run) return { state: 'not-reserved' };

    const agentId = getPromotionWorkerMember(orchestrationId);
    if (!agentId) return { state: 'reserved-unbound' };

    if (!hasOrchestrationEvent(orchestrationId, 'promotion.delivery_attempt')) {
      return { state: 'bound-undelivered', agentId };
    }
    // A delivered event is the durable stamp of a confirmed turn start.
    if (hasOrchestrationEvent(orchestrationId, 'promotion.delivered')) {
      return { state: 'delivered', agentId };
    }
    // Attempt present, no delivered stamp yet — consult durable turn evidence so
    // a crash after turn-start but before the stamp still reads `delivered`.
    try {
      const started = await this.turnStartWitness(agentId, run.startedAt);
      return started ? { state: 'delivered', agentId } : { state: 'submitted-unconfirmed', agentId };
    } catch (err) {
      // Genuinely unreadable PTY/turn state — keep the request pending with a
      // diagnostic, never a blind resend.
      return { state: 'indeterminate', boundAgentId: agentId, diagnostic: errMsg(err) };
    }
  }

  async resumeSubmitOnly(orchestrationId: string): Promise<void> {
    const probe = await this.inspectDelivery(orchestrationId);
    // A submitted body awaiting confirmation — re-press submit, re-witness the
    // turn. NEVER retype the body.
    if (probe.state !== 'submitted-unconfirmed') return;
    const run = getOrchestrationRun(orchestrationId);
    const agent = getAgent(probe.agentId);
    if (!run || (run.status !== 'starting' && run.status !== 'running')) return;
    if (!agent || agent.status === 'done' || agent.status === 'crashed') return;
    this.deliverer.resubmitEnter?.(probe.agentId);
    const started = await this.turnStartWitness(probe.agentId, run.startedAt);
    if (started) recordPromotionDelivered(orchestrationId, this.now());
  }
}
