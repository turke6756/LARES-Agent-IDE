import type {
  AgentStatus,
  ContinuationPhase,
  ContinuationPhaseSignal,
  ForceContinuationResult,
} from '../../shared/types';
import { hasSupervisorPrivilege } from '../../shared/types';
import type { WaitingKind } from './status-monitor';
import {
  CONTINUATION_OPPORTUNITY_FLOOR_PCT,
  CONTINUATION_IDLE_DEBOUNCE_TICKS,
  CONTINUATION_BACKOFF_MS,
  CONTINUATION_BACKOFF_CAP_MS,
  CONTINUATION_ESCAPE_MAX_ATTEMPTS,
  CONTINUATION_ESCAPE_MAX_ALIVE_MS,
  CONTINUATION_POST_NOTE_GRACE_MS,
  CONTINUATION_POST_NOTE_IDLE_POLLS,
  HANDSHAKE_TIMEOUT_MS,
} from '../../shared/constants';

/** Context-brick Inc 5B — the continuation lifecycle watcher.
 *
 *  Pure decision logic with INJECTED effects, mirroring
 *  `claude-clear-rotation.ts` (pure guard fns + effect callbacks). The watcher
 *  never mutates runner/session state and never mints attempt ids locally: it
 *  observes the DB and calls the authenticated continuation routes (or their
 *  injected effect equivalents — see `continuation-watcher-wiring.ts`). Its
 *  local view is ADVISORY; the relaunch route re-checks every gate
 *  server-side against fresh reads.
 *
 *  Fail-safe direction is ALWAYS keep-alive + page human (timeout,
 *  scrape-only, awaiting-human). A stuck-alive supervisor is
 *  recoverable; a killed-without-note one is not.
 *
 *  Owned-busy is NOT a blocker (Edward 2026-07-05): a continuation transfer
 *  is ALLOWED while owned agents work — their worker dashboard events queue
 *  by agent id and land in the successor session. The owned rows are still
 *  observed for crashed-id triage and the in-flight guard. */

// The trigger context percentage is an ALIAS of the shared threshold array's
// SOFT OPPORTUNITY FLOOR (80%). Never re-declare it as a literal that can
// silently diverge. There is NO hard ceiling (Phase 5B removed it): higher
// context only makes the opportunity more desirable, it never forces a kill.
//
// This is NOT the supervisor's context_threshold notification tier — those were
// collapsed to a single 95% interrupt to stop spamming owners, while the
// continuation opportunity still opens at 80%. Two questions, two constants.
export const CONTINUATION_TRIGGER_CONTEXT_PCT = CONTINUATION_OPPORTUNITY_FLOOR_PCT;

/** The force-press contract. One definition lives in `shared/types.ts` (main,
 *  preload and renderer all read it); re-exported here so callers inside the
 *  supervisor tree can import it beside the watcher itself. */
export type { ForceContinuationCode, ForceContinuationResult } from '../../shared/types';

/** Result of the attempt-open effect. `null` used to collapse every rejection
 *  — a 409 (an attempt row is already open), a transport failure and a missing
 *  row all looked identical, so the watcher logged one indistinguishable line
 *  and backed off for 300 s. The discriminated shape keeps the server's reason
 *  alive as far as the log today, and as far as the card in Slice 2. */
export type OpenAttemptResult =
  | { status: 'ok'; attemptId: string; startedAt: string }
  | { status: 'rejected'; code: string; httpStatus: number; error: string };

/** Slice 2 §2.6 — the relaunch effects' result. `boolean` discarded the server's
 *  reason into a `console.warn` in the wiring, so the card could only replace
 *  SILENT failure with VAGUE failure ("relaunch rejected"). Mirrors
 *  `OpenAttemptResult`; the rejection reason rides onto the `backoff` phase. */
export type RelaunchResult =
  | { ok: true }
  | { ok: false; code: string; httpStatus: number; error: string };

/** Slice 2 — the phase contract re-exported beside the watcher that emits it,
 *  the same way `ForceContinuationResult` is. One definition, in shared/types. */
export type { ContinuationPhase, ContinuationPhaseState, ContinuationPhaseSignal } from '../../shared/types';

/** How often the commit-observation loop re-reads the brick row. */
export const CONTINUATION_NOTE_POLL_MS = 5_000;

export interface OwnedAgentRow {
  id: string;
  status: AgentStatus;
}

/** Phase 5A — is the agent blocked on a HUMAN answer? ALL 7 WaitingKind members
 *  are keystroke-blocking prompts. Non-blocking notification types are filtered
 *  by `isNonBlockingNotificationType` BEFORE `forceWaiting()` is ever called
 *  (index.ts v9 idle-vs-waiting fix), and `getWaitingKind` returns a kind ONLY
 *  while the latch state is 'waiting' — so any latch that reaches here is a real
 *  human-answer prompt (incl. `permission_prompt`, which rides `'notification'`).
 *  A future NON-blocking kind must be added here explicitly.
 *
 *  The old `idle + last-turn-ends-with-?` clause is GONE: a merely-idle agent
 *  whose last message happens to end with '?' is fully available and must
 *  qualify for a fresh session (it wedged supervisor `Context brick -2`). */
export function isBlockingWaitKind(kind: WaitingKind | null): boolean {
  return kind !== null;
}
export function computeAwaitingHuman(waitingKind: WaitingKind | null): boolean {
  return isBlockingWaitKind(waitingKind);
}

export interface TriggerSnapshot {
  /** Self context percentage (null = no stats yet). */
  contextPercentage: number | null;
  /** Consecutive StatusMonitor ticks the self agent has been idle. */
  consecutiveIdleTicks: number;
  /** Phase 5A predicate — a blocking WaitingKind latch is held (any of the 7). */
  awaitingHuman: boolean;
  /** Raw DB rows of owned agents (owner_agent_id = self), terminal included. */
  owned: OwnedAgentRow[];
  /** Owned ids (and self) with an input delivery currently in flight. */
  inputInFlightIds: string[];
  /** An orchestration owned by self is 'starting'|'running'. */
  orchestrationRunning: boolean;
  /** Watcher-internal: an attempt cycle is already running for this agent. */
  attemptInProgress: boolean;
  /** Per-agent continuation toggle is OFF (Agent.continuationEnabled === false).
   *  A hard blocker: a disabled agent must never open a handoff attempt. */
  continuationDisabled: boolean;
  /** Watcher-internal backoff gate. */
  now: number;
  backoffUntil: number;
}

export interface TriggerDecision {
  fire: boolean;
  blockers: string[];
  /** Crashed owned ids — NON-blocking, but they ride the attempt reason. */
  crashedOwnedIds: string[];
}

/** Pure trigger guard — ALL gates must clear for the watcher to fire. */
export function decideContinuationTrigger(s: TriggerSnapshot): TriggerDecision {
  const blockers: string[] = [];
  const crashedOwnedIds = s.owned.filter(a => a.status === 'crashed').map(a => a.id);

  // Per-agent policy gate (Edward 2026-07-05): a disabled agent never opens an
  // attempt via the normal trigger. (The force entry point bypasses the trigger
  // but rejects a disabled agent up front, so this invariant still holds.)
  if (s.continuationDisabled) blockers.push('continuation-disabled');
  if (s.attemptInProgress) blockers.push('attempt-in-progress');
  if (s.now < s.backoffUntil) blockers.push('backoff');
  if (s.contextPercentage === null || s.contextPercentage < CONTINUATION_TRIGGER_CONTEXT_PCT) {
    blockers.push('context-below-threshold');
  }
  if (s.consecutiveIdleTicks < CONTINUATION_IDLE_DEBOUNCE_TICKS) blockers.push('not-idle');
  if (s.awaitingHuman) blockers.push('awaiting-human');
  // Owned-busy is NOT a blocker (Edward 2026-07-05): busy owned agents no
  // longer gate the handoff. The owned rows still feed crashed-id triage and
  // the input-in-flight guard below.
  if (s.inputInFlightIds.length > 0) {
    blockers.push(`input-in-flight:${s.inputInFlightIds.join(',')}`);
  }
  if (s.orchestrationRunning) blockers.push('orchestration-running');

  return { fire: blockers.length === 0, blockers, crashedOwnedIds };
}

/** Kill authorization is EXACTLY one thing: a note_source='tool' brick row
 *  for the CURRENT attempt with written_at > attempt.started_at. A scrape
 *  NEVER authorizes (the wiring only ever queries source=tool; this guard is
 *  the belt to that suspender, and the relaunch route re-checks both). */
export function isKillAuthorized(
  brick: { writtenAt: string } | null,
  attemptStartedAt: string,
): boolean {
  return brick !== null && brick.writtenAt > attemptStartedAt;
}

/** Phase 5B (Option B) — the durable effort budget for the note-less escape,
 *  resolved by the wiring from `getContinuationEscapeBudget` scoped to the
 *  agent's current successor generation. No context-percentage anywhere. */
export interface EscapeBudget {
  /** Aborted attempts in the current successor cycle (excludes the open one). */
  abortedCount: number;
  /** Epoch ms of the earliest attempt this cycle (incl. the still-open one);
   *  null when there are none. Drives the alive-time clock. */
  firstAttemptStartedAtMs: number | null;
}

/** Pure predicate — is the note-less escape authorized by the effort budget?
 *  Fires iff enough aborted attempts have accrued OR the cycle has been alive
 *  past the cap. Identical logic runs server-side in the relaunch route. */
export function isEscapeBudgetExhausted(budget: EscapeBudget, now: number): boolean {
  if (budget.abortedCount >= CONTINUATION_ESCAPE_MAX_ATTEMPTS) return true;
  return budget.firstAttemptStartedAtMs !== null
    && now - budget.firstAttemptStartedAtMs >= CONTINUATION_ESCAPE_MAX_ALIVE_MS;
}

/** Doubling backoff: 300 s initial, doubling to the cap. */
export function nextBackoffMs(prevBackoffMs: number | null): number {
  return prevBackoffMs === null
    ? CONTINUATION_BACKOFF_MS
    : Math.min(prevBackoffMs * 2, CONTINUATION_BACKOFF_CAP_MS);
}

/** BUG-39 (WP1) — the post-note grace decision. After the brick commits, the
 *  watcher waits for the author's turn to complete before killing the PTY, so
 *  the closing message + transcript tail survive. Pure guard in the same style
 *  as the trigger/kill-auth predicates:
 *   - 'turn-complete'  → enough consecutive idle observations; proceed to kill.
 *   - 'grace-expired'  → the bounded grace deadline passed; proceed ANYWAY
 *                        (note freshness beats liveness; never immortal).
 *   - 'wait'           → keep polling.
 *  turn-complete is checked FIRST so a turn that finishes exactly at the
 *  deadline is credited as complete rather than a forced overrun. */
export type PostNoteProceed = 'turn-complete' | 'grace-expired' | 'wait';
export function decidePostNoteProceed(
  consecutiveIdlePolls: number,
  now: number,
  graceDeadline: number,
): PostNoteProceed {
  if (consecutiveIdlePolls >= CONTINUATION_POST_NOTE_IDLE_POLLS) return 'turn-complete';
  if (now >= graceDeadline) return 'grace-expired';
  return 'wait';
}

/** BUG-39 (WP2) — the successor pre-stage kickoff. Auto-submitted as a
 *  `[DASHBOARD]`-labelled initial USER message the instant the fresh
 *  continuation session boots, so it orients itself (and is WARM) before the
 *  human arrives. The hard stop is load-bearing: pre-stage spends ORIENTATION
 *  tokens, never ACTION tokens — acting before the human replies would repeat
 *  the exact class of surprise this removes. Unit-testable (fixed text). */
/** Which active agents ride the auto continuation watcher on each monitor tick:
 *  supervisor-PRIVILEGED (the structural workspace supervisor OR a
 *  privilegeLane:'supervisor' persona, #19) AND claude-provider (continuation is
 *  claude-only). Exported from this pure module so the wiring's monitorTick filter
 *  is unit-testable without pulling in electron. */
export function isContinuationWatchEligible(
  a: { isSupervisor?: boolean; privilegeLane?: 'supervisor'; provider?: string },
): boolean {
  return hasSupervisorPrivilege(a) && a.provider === 'claude';
}

export function buildContinuationKickoffMessage(): string {
  return (
    `[DASHBOARD] Continuation pre-stage (automatic — the human has not spoken yet).\n` +
    `You are a fresh continuation session; your predecessor's note is in your system prompt.\n` +
    `Orient NOW so you are warm when the human arrives:\n` +
    `1. get_my_context; 2. read memory/MEMORY.md's top/active block; 3. verify the note's\n` +
    `in-flight claims with cheap reads (git log/status, list_agents) — trust tools over the note.\n` +
    `Then post a short readiness summary (≤10 lines: state verified, discrepancies, what you\n` +
    `will do on the human's go) and END YOUR TURN. Do NOT start or resume work, do NOT\n` +
    `dispatch/message workers, do NOT edit files until the human speaks.`
  );
}

/** The note-request prompt injected via the send handshake. */
export function buildNoteRequestMessage(
  attemptId: string,
  reason: string,
  remainingDeferrals: number,
): string {
  const deferOffer = remainingDeferrals > 0
    ? ` If you are close to finishing something that would materially benefit from your current context, ` +
      `you may defer this handoff by calling defer_continuation with a short reason (and optional ` +
      `retry_after_minutes, 5–30); the dashboard will re-ask later. ` +
      `${remainingDeferrals} deferral${remainingDeferrals === 1 ? '' : 's'} remain.`
    : '';
  return (
    `[DASHBOARD EVENT] Continuation handoff opened (attempt ${attemptId}). ` +
    `Reason: ${reason}. Your context is nearly exhausted; the dashboard will ` +
    `relaunch you with a fresh session carrying a continuation note you author NOW. ` +
    `Call the save_continuation_brick tool with a note of AT MOST 6 KB: current ` +
    `objective, per-owned-agent state (ids + what each is doing), decisions/questions ` +
    `pending with the human, and pointers (file paths, plan ids) instead of prose. ` +
    `Do not start new work this turn.` + deferOffer
  );
}

export type HandshakeResult = 'ok' | 'unconfirmed' | 'failed';

export interface CommittedBrickView {
  id: string;
  writtenAt: string;
}

export interface CommittedDeferralView {
  id: string;
  reason: string;
  retryAfterMinutes: number;
  deferredAt: string;
}

export interface ContinuationWatcherEffects {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Per-agent context percentage (ContextStatsMonitor), null when unknown. */
  getContextPercentage(agentId: string): number | null;
  /** Self is idle this tick (DB status written by the StatusMonitor latch). */
  isIdle(agentId: string): boolean;
  /** Inc 5A — SupervisorManager.isAwaitingHuman. */
  isAwaitingHuman(agentId: string): boolean;
  /** Per-agent continuation toggle (Agent.continuationEnabled). false → the
   *  `continuation-disabled` trigger blocker AND force rejection. */
  isContinuationEnabled(agentId: string): boolean;
  /** Raw DB rows via getAgentsByOwner (terminal included, 'done' filtered by wiring). */
  getOwnedAgents(agentId: string): OwnedAgentRow[];
  /** SupervisorManager.isInputInFlight — via the injected instance handle. */
  isInputInFlight(agentId: string): boolean;
  /** hasRunningOrchestrationForSupervisor ('starting'|'running' block). */
  hasRunningOrchestration(agentId: string): boolean;
  /** Is this agent in the set the tick actually visits? A force on an agent
   *  outside it sets a flag nothing will ever read — reject instead of lying.
   *  Wired to the SAME expression `watcher.tick(ids)` is fed
   *  (`getContinuationWatchIds`), evaluated at call time — never a mirror. */
  isWatchEligible(agentId: string): boolean;
  /** POST /api/agents/:id/continuation-attempt — server allocates successorGen.
   *  A rejection (e.g. 409 open-attempt-exists) carries its code + reason. */
  openAttempt(
    agentId: string,
    input: { reason: string; thresholdContextPct: number },
  ): Promise<OpenAttemptResult>;
  /** Inject the note request via the send_message HANDSHAKE machinery
   *  (sendInputConfirmed) — never a bare PTY write. */
  requestNote(agentId: string, message: string): Promise<HandshakeResult>;
  /** GET /api/supervisor/continuation-brick?…&source=tool — the
   *  commit-observation read. Tool source ONLY; scrape never authorizes. */
  getCommittedToolBrick(agentId: string, attemptId: string): Promise<CommittedBrickView | null>;
  /** Observe a durable deferral row committed for this exact attempt. */
  getCommittedDeferral(agentId: string, attemptId: string): Promise<CommittedDeferralView | null>;
  /** Remaining generation-scoped deferrals, used to condition the prompt. */
  getRemainingDeferrals(agentId: string, attemptId: string): number;
  /** POST /api/agents/:id/continuation-relaunch — the ONLY kill path; the
   *  route re-checks every gate server-side. A 4xx is keep-alive AND carries
   *  the route's reason (which gate said no) onto the `backoff` phase. */
  relaunch(agentId: string, attemptId: string): Promise<RelaunchResult>;
  /** Same route with emptyMemoEscape=true — the note-less "none" escape mode
   *  (Phase 5B). The route re-checks the effort budget server-side. */
  relaunchNone(agentId: string, attemptId: string): Promise<RelaunchResult>;
  /** Phase 5B — the durable escape budget for the current successor cycle,
   *  resolved by the wiring (DB helper scoped to the agent's current successor
   *  generation, converting UTC timestamps to epoch ms). */
  getEscapeBudget(agentId: string): EscapeBudget;
  /** Close the attempt 'aborted' + addEvent 'continuation_aborted'. */
  abortAttempt(agentId: string, attemptId: string, detail: string): void;
  /** handoff_failed recovery for a definitively-failed handshake (dropped
   *  submit). Pre-attempt: consumes no kill-auth, generation unadvanced. */
  handoffFailedRecovery(agentId: string, attemptId: string): Promise<void>;
  /** Page the human — existing surface: dashboard timeline event (+ log). */
  pageHuman(agentId: string, message: string): void;
  /** Slice 2 §4.2 — publish the cycle's live phase to the authoritative
   *  main-process map (which broadcasts it to every dashboard window). Pure
   *  observation: it NEVER affects control flow, and the watcher never reads
   *  it back. Completion is deliberately NOT published here — relaunch-ok
   *  leaves the phase at `relaunching` and the supervisor's launch tail owns
   *  the clear/`failed` outcome (§2.4). */
  publishPhase(signal: ContinuationPhaseSignal): void;
  log(message: string): void;
}

interface AgentWatchState {
  consecutiveIdleTicks: number;
  attemptInProgress: boolean;
  backoffUntil: number;
  lastBackoffMs: number | null;
  /** Open attempt carried across retries (handshake-failed keeps it open). */
  openAttempt: { attemptId: string; startedAt: string } | null;
  /** Brick committed but relaunch rejected server-side — retry relaunch only. */
  committedReady: boolean;
  /** A supervisor-requested force is queued: the next tick opens an attempt
   *  bypassing the trigger conditions (but still honoring disabled + one-open). */
  forcePending: boolean;
}

export class ContinuationWatcher {
  private state = new Map<string, AgentWatchState>();

  constructor(private readonly fx: ContinuationWatcherEffects) {}

  /** One periodic pass over the watched (supervisor) agent ids. Rides the
   *  StatusMonitor poll tick — synchronous decision, async attempt cycle
   *  detached with an in-progress latch so ticks never re-enter it. */
  tick(agentIds: string[]): void {
    for (const agentId of agentIds) {
      const st = this.getState(agentId);
      st.consecutiveIdleTicks = this.fx.isIdle(agentId) ? st.consecutiveIdleTicks + 1 : 0;

      const owned = this.fx.getOwnedAgents(agentId);
      const decision = decideContinuationTrigger({
        contextPercentage: this.fx.getContextPercentage(agentId),
        consecutiveIdleTicks: st.consecutiveIdleTicks,
        awaitingHuman: this.fx.isAwaitingHuman(agentId),
        owned,
        inputInFlightIds: [...owned.map(a => a.id), agentId]
          .filter(id => this.fx.isInputInFlight(id)),
        orchestrationRunning: this.fx.hasRunningOrchestration(agentId),
        attemptInProgress: st.attemptInProgress,
        continuationDisabled: !this.fx.isContinuationEnabled(agentId),
        now: this.fx.now(),
        backoffUntil: st.backoffUntil,
      });

      // Force (Edward 2026-07-05): a supervisor-requested handoff bypasses the
      // TRIGGER conditions (context threshold, idle debounce, backoff) but runs
      // the NORMAL attempt cycle end-to-end. It still honors the two invariants
      // force must never cross: a disabled agent never opens an attempt, and an
      // attempt already in progress is not duplicated (idempotent "start now").
      if (st.forcePending) {
        if (!this.fx.isContinuationEnabled(agentId)) {
          st.forcePending = false;          // disabled after the force was queued — drop it
          continue;
        }
        if (st.attemptInProgress) {
          st.forcePending = false;          // idempotent: the running cycle IS the handoff
          continue;
        }
        st.forcePending = false;
        st.attemptInProgress = true;
        void this.runAttemptCycle(agentId, decision.crashedOwnedIds, st)
          .catch(err => this.fx.log(`[continuation-watcher] forced attempt cycle error for ${agentId}: ${err}`))
          .finally(() => { st.attemptInProgress = false; });
        continue;
      }

      if (!decision.fire) continue;

      st.attemptInProgress = true;
      void this.runAttemptCycle(agentId, decision.crashedOwnedIds, st)
        .catch(err => this.fx.log(`[continuation-watcher] attempt cycle error for ${agentId}: ${err}`))
        .finally(() => { st.attemptInProgress = false; });
    }
  }

  /** Supervisor-level entry point (Edward 2026-07-05): request the watcher open
   *  a continuation attempt for this agent on its NEXT tick, bypassing the
   *  trigger conditions but running the normal attempt cycle (note-request →
   *  brick commit → post-note grace → relaunch, escape budget if the author
   *  never responds). Force means "start now", NOT "kill now" — the attempt
   *  cycle's own safety is preserved.
   *   - Rejects an agent the tick will never visit (the press cannot lie).
   *   - Rejects a disabled agent (a disabled agent must never open an attempt).
   *   - Idempotent when an attempt is already open / in progress OR a force is
   *     already queued → returns ok without minting a second. */
  forceHandoff(agentId: string): ForceContinuationResult {
    // Order matters: the watch-set check is FIRST because it is the only failure
    // whose OLD behavior was a false ok — the flag was set on a state entry no
    // tick would ever visit (getActiveAgents excludes done/crashed).
    if (!this.fx.isWatchEligible(agentId)) {
      return {
        ok: false,
        code: 'continuation-not-watched',
        error: 'This agent is not being watched for continuation — it must be a running Claude supervisor.',
      };
    }
    if (!this.fx.isContinuationEnabled(agentId)) {
      return {
        ok: false,
        code: 'continuation-disabled',
        error: 'Automatic context transfer is off for this agent; turn it on before forcing a handoff.',
      };
    }
    // Reached only past both rejections, so a refused force creates NO watcher
    // state (getState is the allocating read).
    const st = this.getState(agentId);
    if (st.attemptInProgress || st.forcePending) return { ok: true };
    // The press is accepted: say so on the authoritative rail BEFORE the flag,
    // so the card's label + glow are live from this instant rather than from
    // whenever the next monitor tick happens to land.
    this.publish(agentId, 'queued');
    st.forcePending = true;
    return { ok: true };
  }

  /** Test/observability hook. */
  getAgentState(agentId: string): Readonly<AgentWatchState> {
    return this.getState(agentId);
  }

  forgetAgent(agentId: string): void {
    this.state.delete(agentId);
  }

  private getState(agentId: string): AgentWatchState {
    let st = this.state.get(agentId);
    if (!st) {
      st = {
        consecutiveIdleTicks: 0,
        attemptInProgress: false,
        backoffUntil: 0,
        lastBackoffMs: null,
        openAttempt: null,
        committedReady: false,
        forcePending: false,
      };
      this.state.set(agentId, st);
    }
    return st;
  }

  /** One-line phase emit. Every call site is a pure observation bolted beside
   *  existing control flow — none of them branch on the result. */
  private publish(
    agentId: string,
    phase: ContinuationPhase,
    extra: { attemptId?: string; message?: string; retryAt?: number } = {},
  ): void {
    this.fx.publishPhase({ agentId, phase, ...extra, updatedAt: this.fx.now() });
  }

  /** `backoff` + the phase that explains it. Always called AFTER `this.backoff`
   *  so `st.backoffUntil` is the real retry deadline the card counts down to. */
  private publishBackoff(agentId: string, st: AgentWatchState, message: string): void {
    this.publish(agentId, 'backoff', {
      message,
      retryAt: st.backoffUntil,
      ...(st.openAttempt ? { attemptId: st.openAttempt.attemptId } : {}),
    });
  }

  private backoff(st: AgentWatchState): void {
    st.lastBackoffMs = nextBackoffMs(st.lastBackoffMs);
    st.backoffUntil = this.fx.now() + st.lastBackoffMs;
  }

  private clearCycle(st: AgentWatchState): void {
    st.openAttempt = null;
    st.committedReady = false;
    st.backoffUntil = 0;
    st.lastBackoffMs = null;
  }

  private async runAttemptCycle(
    agentId: string,
    crashedOwnedIds: string[],
    st: AgentWatchState,
  ): Promise<void> {
    // 1. Open (or reuse) the attempt — the SERVER allocates successorGen; the
    //    watcher never mints ids. A handshake-failed retry arrives here with
    //    the prior attempt still open and skips straight to the note request.
    if (!st.openAttempt) {
      const pct = this.fx.getContextPercentage(agentId);
      const reason =
        `self context ${pct ?? '?'}% ≥ ${CONTINUATION_TRIGGER_CONTEXT_PCT}% threshold` +
        (crashedOwnedIds.length > 0
          ? `; crashed owned agents (non-blocking, need triage): ${crashedOwnedIds.join(', ')}`
          : '');
      this.publish(agentId, 'opening');
      const opened = await this.fx.openAttempt(agentId, {
        reason,
        thresholdContextPct: CONTINUATION_TRIGGER_CONTEXT_PCT,
      });
      if (opened.status !== 'ok') {
        this.fx.log(`[continuation-watcher] openAttempt rejected for ${agentId} (${opened.code}): ${opened.error}; backing off`);
        this.backoff(st);
        this.publishBackoff(agentId, st, opened.error);
        return;
      }
      st.openAttempt = { attemptId: opened.attemptId, startedAt: opened.startedAt };
    }
    const attempt = st.openAttempt;

    // 1b. Relaunch-only retry: the brick already committed on a prior cycle
    //     but the route said no (self-busy / in-flight etc.). Nothing to re-request. Re-run
    //     the post-note grace loop: a retry-later relaunch can race a NEW turn
    //     (e.g. the human replied meanwhile), so re-observe turn-complete first.
    if (st.committedReady) {
      await this.waitPostNoteGrace(agentId);
      await this.tryRelaunch(agentId, attempt.attemptId, st);
      return;
    }

    // 2. Inject the note request via the send handshake — never a bare write.
    const handshake = await this.fx.requestNote(
      agentId,
      buildNoteRequestMessage(
        attempt.attemptId,
        `context ≥ ${CONTINUATION_TRIGGER_CONTEXT_PCT}%`,
        this.fx.getRemainingDeferrals(agentId, attempt.attemptId),
      ),
    );
    if (handshake === 'failed') {
      // PRE-ATTEMPT failure: the turn provably never started, so no tool
      // brick can exist — no kill-authorization consumed, generation
      // unadvanced. Run the handoff_failed recovery, back off, and retry
      // later with the attempt still open (don't burn HANDSHAKE_TIMEOUT_MS
      // on a swallowed submit).
      this.fx.log(`[continuation-watcher] note-request handshake FAILED for ${agentId} (pre-attempt); attempt ${attempt.attemptId} stays open`);
      await this.fx.handoffFailedRecovery(agentId, attempt.attemptId);
      this.backoff(st);
      this.publishBackoff(agentId, st, 'the note request was not delivered');
      return;
    }
    // 'ok' | 'unconfirmed' both proceed to commit observation: 'unconfirmed'
    // is not proof of failure, and the DB row — not the tool response — is
    // the authority either way.

    // 3. Commit-observed wait: poll the brick DB row until committed or
    //    timeout. A tool/HTTP timeout AFTER commit still lands here as
    //    success because we read the row, not the response.
    const deadline = this.fx.now() + HANDSHAKE_TIMEOUT_MS;
    // The 180 s wait is the single longest silence in the whole cycle and the
    // one users read as a hang. Name it before entering the loop.
    this.publish(agentId, 'awaiting-note', { attemptId: attempt.attemptId });
    for (;;) {
      const brick = await this.fx.getCommittedToolBrick(agentId, attempt.attemptId);
      if (isKillAuthorized(brick, attempt.startedAt)) {
        st.committedReady = true;
        this.publish(agentId, 'note-committed', { attemptId: attempt.attemptId });
        // BUG-39: the commit is kill-AUTHORIZATION, not kill-TIMING. The author
        // is by construction still mid-turn (it just made the tool call), so
        // wait for its turn to complete before the PTY stop — else its closing
        // message + transcript tail are truncated ≤5 s after commit.
        await this.waitPostNoteGrace(agentId);
        await this.tryRelaunch(agentId, attempt.attemptId, st);
        return;
      }
      const deferral = await this.fx.getCommittedDeferral(agentId, attempt.attemptId);
      if (deferral) {
        // The route atomically closed the attempt with disposition 'deferred'.
        // This is a caller-chosen retry, not a failed note attempt: it never
        // invokes abortAttempt and never advances the doubling failure backoff.
        st.openAttempt = null;
        st.committedReady = false;
        st.lastBackoffMs = null;
        st.backoffUntil = this.fx.now() + deferral.retryAfterMinutes * 60_000;
        this.publish(agentId, 'backoff', {
          attemptId: attempt.attemptId,
          message: `Supervisor deferred the continuation: ${deferral.reason} Retry in ${deferral.retryAfterMinutes} minutes.`,
          retryAt: st.backoffUntil,
        });
        return;
      }
      if (this.fx.now() >= deadline) break;
      await this.fx.sleep(CONTINUATION_NOTE_POLL_MS);
    }

    // 4. Timeout with no committed tool row — the empty-memo branch (Phase 5B
    //    Option B). NO context-percentage anywhere: the note-less escape fires
    //    ONLY once the durable effort budget is exhausted (enough aborted
    //    attempts OR the cycle alive past the cap), scoped to this successor
    //    generation. The budget is read BEFORE aborting, so the current attempt
    //    is not yet counted among the aborts.
    const budget = this.fx.getEscapeBudget(agentId);
    if (isEscapeBudgetExhausted(budget, this.fx.now())) {
      // Effort budget spent: proceed with the "none" Block C so an idle
      // supervisor that never authors a note is never left alive+expensive
      // forever. The route re-checks the same budget + every other gate.
      const res = await this.fx.relaunchNone(agentId, attempt.attemptId);
      if (res.ok) {
        this.fx.pageHuman(agentId,
          `Continuation note-less escape fired after effort budget exhausted (attempt ${attempt.attemptId}; ${budget.abortedCount} prior aborts this cycle).`);
        // Same rule as tryRelaunch: relaunch-ok is NOT completion. The route
        // hands off to the supervisor's stop → mint → launch tail, and only the
        // tail knows whether the successor actually came up.
        this.publish(agentId, 'relaunching', { attemptId: attempt.attemptId });
        this.clearCycle(st);
        return;
      }
      this.fx.pageHuman(agentId,
        `Continuation note-less escape relaunch was rejected server-side (attempt ${attempt.attemptId}); supervisor kept alive.`);
      this.backoff(st);
      this.publishBackoff(agentId, st, res.error);
      return;
    }
    // Budget not yet spent: ABORT keep-alive — close 'aborted', page the human,
    // back off (doubling), retry later from a clean attempt. The abort feeds the
    // budget so a persistently note-less agent eventually escapes.
    this.fx.abortAttempt(agentId, attempt.attemptId,
      `no tool-authored note committed within ${HANDSHAKE_TIMEOUT_MS} ms`);
    this.fx.pageHuman(agentId,
      `Continuation attempt ${attempt.attemptId} aborted: no note committed within ${Math.round(HANDSHAKE_TIMEOUT_MS / 1000)} s ` +
      `(escape budget: ${budget.abortedCount + 1}/${CONTINUATION_ESCAPE_MAX_ATTEMPTS} aborts). Supervisor kept alive; will back off and retry.`);
    st.openAttempt = null;
    st.committedReady = false;
    this.backoff(st);
    // §2.5 — the abort closes ONE attempt but schedules a retry, so the phase is
    // `backoff` carrying the abort message. Emitting a terminal-sounding
    // `aborted` here would be wrong AND would flicker: `backoff` overwrites it
    // one statement later.
    this.publish(agentId, 'backoff', {
      attemptId: attempt.attemptId,
      message: `Attempt aborted: no continuation note was saved within ${Math.round(HANDSHAKE_TIMEOUT_MS / 1000)} seconds.`,
      retryAt: st.backoffUntil,
    });
  }

  /** BUG-39 (WP1) — post-note grace: after the brick commits, poll self-idle on
   *  the note-poll cadence until the author's turn completes (N consecutive idle
   *  readings) OR a bounded grace deadline (started NOW, at commit-observation)
   *  passes — then proceed to relaunch either way. `isIdle` is the same injected
   *  StatusMonitor-latch effect the trigger uses; no new wiring surface. */
  private async waitPostNoteGrace(agentId: string): Promise<void> {
    // Emitted HERE rather than at the two call sites so the committedReady
    // retry path is covered by the same one line.
    this.publish(agentId, 'waiting-for-idle');
    const graceDeadline = this.fx.now() + CONTINUATION_POST_NOTE_GRACE_MS;
    let consecutiveIdlePolls = 0;
    for (;;) {
      consecutiveIdlePolls = this.fx.isIdle(agentId) ? consecutiveIdlePolls + 1 : 0;
      const proceed = decidePostNoteProceed(consecutiveIdlePolls, this.fx.now(), graceDeadline);
      if (proceed === 'turn-complete') {
        this.fx.log(`[continuation-watcher] post-note turn-complete observed for ${agentId} (${consecutiveIdlePolls} idle polls); proceeding to relaunch`);
        return;
      }
      if (proceed === 'grace-expired') {
        this.fx.log(`[continuation-watcher] post-note grace expired for ${agentId} (${CONTINUATION_POST_NOTE_GRACE_MS} ms); proceeding to relaunch anyway`);
        return;
      }
      await this.fx.sleep(CONTINUATION_NOTE_POLL_MS);
    }
  }

  private async tryRelaunch(agentId: string, attemptId: string, st: AgentWatchState): Promise<void> {
    this.publish(agentId, 'relaunching', { attemptId });
    const res = await this.fx.relaunch(agentId, attemptId);
    if (res.ok) {
      // §2.4 — relaunch-ok is NOT completion and MUST NOT clear the phase. The
      // route schedules a DETACHED launch tail that can still fail and mark the
      // agent crashed; the tail publishes `launching`, then either the clear or
      // a persistent `failed`. Ending the label here would put the card back to
      // "nothing happening" for the last, most failure-prone second.
      this.clearCycle(st);
      return;
    }
    // Server-side gate disagreed (self-busy / in-flight / awaiting-human /
    // orchestration). Keep-alive, keep the committed brick, back off and
    // retry the relaunch only.
    this.fx.log(`[continuation-watcher] relaunch rejected server-side for ${agentId} (attempt ${attemptId}) (${res.code}): ${res.error}; keep-alive, will retry`);
    this.backoff(st);
    this.publish(agentId, 'backoff', { attemptId, message: res.error, retryAt: st.backoffUntil });
  }
}
