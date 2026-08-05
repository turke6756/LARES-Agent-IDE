import { Agent, LaunchAgentInput } from '../../shared/types';
import type { DispatchContext } from '../git-checkpoints/dispatch-context';

// 'promotion' is the planning-lane promotion lifecycle (WP-P3B-core). It is NOT
// an auto-executing catalog orchestration: it never routes through
// OrchestrationService.start_run/execute (which immediately calls execute()).
// Its rows are created directly by the promotion service's two-phase
// bind-before-deliver dispatch and reconciled by WP-P3-reconcile — never
// boot-aborted (see markActiveRunsAborted's `name <> 'promotion'` SQL filter).
export type OrchestrationName = 'groupthink' | 'promotion';
export type OrchestrationMode = 'serial' | 'parallel';
export type RunStatus = 'starting' | 'running' | 'complete' | 'stalled' | 'aborted' | 'error';
export type OrchestrationPlanBindingMode = 'explicit' | 'agent-default';

export interface OrchestrationBinding {
  planId: string | null;
  planItemId: string | null;
  mode: OrchestrationPlanBindingMode;
}

/** Catalog entry returned by GET /api/orchestrations/catalog. (The
 *  `list_orchestrations` MCP tool that used to front this was deleted in the
 *  context-overhead pass; the route and this type remain.) */
export interface OrchestrationDescriptor {
  name: OrchestrationName;
  title: string;
  description: string;
  modes: OrchestrationMode[];
  params: Record<string, {
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    default?: unknown;
    description: string;
  }>;
}

/** Caller-supplied request for a groupthink run. */
export interface RunOrchestrationRequest {
  name: OrchestrationName;
  workspaceId: string;
  supervisorId: string;
  mode?: OrchestrationMode;          // default 'serial'
  topic?: string;
  planPath?: string;                 // resolved against workspace root
  // WP6 planning-surface rail: when set, the run edits an EXISTING plan surface
  // registered in the plans table at `sectionAnchor` rather than writing a fresh
  // plan file. planId references a `plans` row; sectionAnchor is the `sec_`
  // writeback target. Both are stamped onto every launched member's env
  // (AGENT_DASHBOARD_PLAN_ID / _PLAN_SECTION) via the WP1 launch rail, and drive
  // one-writer-per-plan enforcement (§D-WRITE-POLICY) + section-change done-detection.
  planId?: string;
  /** Requested marked planning intent. Trusted launch code validates this
   *  against (workspaceId, planId) before freezing it onto the run row. */
  planningIntentId?: string;
  sectionAnchor?: string;
  leadProvider?: string;             // default 'claude'
  reviewerProvider?: string;         // default 'codex'
  turnTimeoutMs?: number;            // default 600000
  keepAgents?: boolean;
  // Resume inputs (any one):
  resumeRunId?: string;              // preferred — rehydrate from DB
  resumeLeadId?: string;             // structured legacy (serial only)
  resumeReviewerId?: string;
  legacyCommand?: string;            // a full `node scripts/groupthink-v2.js …` string
}

/** Result of the confirmed handoff send (mirrors AgentSupervisor.sendInputConfirmed). */
export type SendInputConfirmedResult = {
  delivered: boolean;
  confirmed: boolean;
  mode: 'hook' | 'status-poll' | 'unconfirmed';
};

/** Dropped-submit recovery variant the runner applies to worker sends.
 *  - 'raw'                 : current/baseline behavior — client.sendInput, no
 *                            handshake, no recovery (reproduces the kickoff bug).
 *  - 'recover-fallthrough' : confirmed handshake + evidence-gated re-press; on
 *                            exhaustion DO NOT throw — fall through to the
 *                            waitTurnComplete backstop. Kickoff may relaunch.
 *  - 'recover-throw'       : same recovery, but THROW a STALL: delivery error on
 *                            relay exhaustion (the plan's chosen terminal). Kickoff
 *                            relaunch.
 *  EXPERIMENT field: default 'raw' so nothing else changes. */
export type SubmitRecoveryPolicy = 'raw' | 'recover-fallthrough' | 'recover-throw';

/** Live + persisted run record (one row in `orchestrations`). */
export interface OrchestrationRun {
  runId: string;
  name: OrchestrationName;
  mode: OrchestrationMode;
  status: RunStatus;
  workspaceId: string;
  supervisorId: string;
  topic: string;
  planPath: string;                  // absolute
  // WP6 planning-surface rail (frozen at dispatch). See RunOrchestrationRequest.
  planId?: string;
  /** Server-witnessed planning-intent association, frozen for this run. */
  planningIntentId?: string | null;
  /** Frozen item stamp for the run (SC-WP-3A). Null/absent for a plan-only or
   *  default binding; an explicit plan+item run carries the validated item id. */
  planItemId?: string | null;
  /** Frozen once for the run. Stage II supports plan-only explicit bindings;
   *  Stage III (SC-WP-3A) additionally carries a validated explicit item. */
  planBindingMode?: OrchestrationPlanBindingMode;
  sectionAnchor?: string;
  leadProvider: string;
  reviewerProvider: string;
  turnTimeoutMs: number;
  leadId?: string;
  reviewerId?: string;
  turn?: number;
  round?: number;
  lastRelayedTs: Record<string, string>;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  // --- EXPERIMENT (exp/gt-handshake-pressure) ---
  /** Which dropped-submit recovery variant the runner applies. Default 'raw'. */
  submitRecoveryPolicy?: SubmitRecoveryPolicy;
  /** Optional recovery-window tuning. The pressure harness scales these down so
   *  the real-time F-F delay sweep runs in milliseconds rather than tens of
   *  seconds; production leaves it undefined → the plan's constants apply. */
  submitRecoveryWindow?: { attempts?: number; recheckMs?: number; pollMs?: number; handshakeMs?: number };
  /** WP1/BUG-37: bounded re-poll window after the deadline chat-binding recovery.
   *  Same test-scaling role as submitRecoveryWindow — the pressure harness shrinks
   *  it so the permanent-blackout probe throws in milliseconds; production leaves
   *  it undefined → RECOVERY_REPOLL_MS (15s) applies. */
  recoveryRepollMs?: number;
}

/** Durable evidence kinds for the promotion lifecycle (WP-P3B-core). These are
 *  the phase markers that distinguish the internal promotion phases — the run
 *  `status` only ever moves `starting` (reserved / bound-unconfirmed) →
 *  `running` (confirmed delivery). Ordered by lifecycle position:
 *   - reserved         : Phase 1 committed (orchestration row + bound onto the request)
 *   - agent_bound      : Phase 2a committed (agent row + worker member, atomically)
 *   - delivery_attempt : the confirmed-send body was about to be submitted
 *   - delivered        : marker AND a matching turn-start were both observed
 *   - failed           : terminal launch/delivery failure for this attempt
 */
export type PromotionEventKind =
  | 'promotion.reserved'
  | 'promotion.agent_bound'
  | 'promotion.delivery_attempt'
  | 'promotion.delivered'
  | 'promotion.failed';

export interface OrchestrationEvent {
  runId: string;
  ts: string;
  kind:
    | 'started' | 'turn' | 'round' | 'complete' | 'stalled' | 'aborted' | 'error' | 'delivery_failed'
    | PromotionEventKind;
  payload: unknown;
}

/** The narrow surface the runner needs from the dashboard — keeps the ported
 *  logic decoupled and unit-testable with a fake. Concretely implemented by
 *  dashboard-client.ts. */
export interface DashboardClient {
  launchAgent(input: LaunchAgentInput): Promise<Agent>;
  getAgent(id: string): Agent | null;
  getMessages(id: string, opts: { limit: number; role?: 'assistant' | 'user' }):
    Promise<Array<{ content: string; ts: string; turnComplete?: boolean }>>;
  /** WP1/BUG-37: force a codex chat-binding recovery (→ supervisor.maybeRecoverCodexSid).
   *  waitTurnComplete calls this once at the stall deadline before conceding a
   *  timeout, so a lost discovery race that blacked out the chat can rebind and
   *  reveal a completed-but-unread turn. Self-gates in the supervisor (no-op for
   *  non-codex / already-bound / inside the discovery grace); safe to call always. */
  recoverChatBinding(id: string): void;
  sendInput(id: string, text: string, dispatch: DispatchContext): Promise<void>;
  /** Confirmed handoff send (→ supervisor.sendInputConfirmed). Resolves with
   *  turn-start proof: mode 'hook'|'status-poll' ⇒ confirmed:true; 'unconfirmed'
   *  ⇒ confirmed:false (no proof within the handshake window — NOT failure).
   *  REJECTS on hard failure (SubmitNotConfirmedError, or a `delivery-failed`-
   *  coded Error). V1/V2 use this instead of raw sendInput so a dropped submit
   *  is detected and recovered rather than silently STALLed. */
  sendInputConfirmed(id: string, text: string, dispatch: DispatchContext): Promise<SendInputConfirmedResult>;
  /** Re-press ONLY the submit keystroke (→ supervisor.resubmitEnter) to recover
   *  a dropped Enter. No body, never queued — a single keystroke. */
  resubmitEnter(id: string): void;
  isInputInFlight(id: string): boolean;
  // Source-reality reconciliation: the standalone script cleaned members up via
  // `DELETE /api/agents/:id`, which maps to `AgentSupervisor.stopAgent` (marks
  // the agent `done` + kills its process but KEEPS the DB record so run history
  // stays browsable). We name the seam `stopAgent` to match that semantics — not
  // `deleteAgent`, which fully purges the row.
  stopAgent(id: string): Promise<void>;
}

/** Per-run hooks the runner calls to persist progress + emit events. */
export interface OrchestrationRunContext {
  run: OrchestrationRun;
  signal: AbortSignal;
  persist(): void;
  emit(kind: OrchestrationEvent['kind'], payload: unknown): void;
}

/** Runner dispatch surface. Injectable into OrchestrationService so the service
 *  lifecycle (detach / persist / deliver / abort / boot-reconcile) is unit
 *  testable without the real groupthink relay loop. */
export type OrchestrationRunner =
  (client: DashboardClient, ctx: OrchestrationRunContext) => Promise<void>;
