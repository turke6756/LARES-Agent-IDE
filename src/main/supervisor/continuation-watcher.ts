import type { AgentStatus } from '../../shared/types';
import type { WaitingKind } from './status-monitor';
import {
  SUPERVISOR_CONTEXT_THRESHOLDS,
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
 *  scrape-only, owned-busy, awaiting-human). A stuck-alive supervisor is
 *  recoverable; a killed-without-note one is not. */

// The trigger context percentage is an ALIAS of the shared threshold array's
// SOFT OPPORTUNITY FLOOR ([0] = 80%) — the same per-agent source event-bridge.ts
// uses for context_threshold events. Never re-declare it as a literal that can
// silently diverge. There is NO hard ceiling (Phase 5B removed it): higher
// context only makes the opportunity more desirable, it never forces a kill.
export const CONTINUATION_TRIGGER_CONTEXT_PCT = SUPERVISOR_CONTEXT_THRESHOLDS[0];

/** How often the commit-observation loop re-reads the brick row. */
export const CONTINUATION_NOTE_POLL_MS = 5_000;

/** Raw-DB-row statuses of OWNED agents that block a handoff. 'receiving' is
 *  deliberately absent: it is projection-only (overlaid by
 *  `ApiServer.withInputInFlight`) and never appears in a raw DB row, so a
 *  status-set check for it would be a silent no-op — the explicit
 *  `isInputInFlight` guard covers that hazard instead. 'crashed' is
 *  non-blocking; crashed ids ride the attempt reason for successor triage.
 *  There is no 'stopped' status. */
export const OWNED_BUSY_BLOCKLIST: ReadonlySet<AgentStatus> =
  new Set<AgentStatus>(['launching', 'working', 'waiting', 'restarting']);

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

  if (s.attemptInProgress) blockers.push('attempt-in-progress');
  if (s.now < s.backoffUntil) blockers.push('backoff');
  if (s.contextPercentage === null || s.contextPercentage < CONTINUATION_TRIGGER_CONTEXT_PCT) {
    blockers.push('context-below-threshold');
  }
  if (s.consecutiveIdleTicks < CONTINUATION_IDLE_DEBOUNCE_TICKS) blockers.push('not-idle');
  if (s.awaitingHuman) blockers.push('awaiting-human');
  const busy = s.owned.filter(a => OWNED_BUSY_BLOCKLIST.has(a.status));
  if (busy.length > 0) {
    blockers.push(`owned-busy:${busy.map(a => `${a.id}(${a.status})`).join(',')}`);
  }
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
export function buildNoteRequestMessage(attemptId: string, reason: string): string {
  return (
    `[DASHBOARD EVENT] Continuation handoff opened (attempt ${attemptId}). ` +
    `Reason: ${reason}. Your context is nearly exhausted; the dashboard will ` +
    `relaunch you with a fresh session carrying a continuation note you author NOW. ` +
    `Call the save_continuation_brick tool with a note of AT MOST 6 KB: current ` +
    `objective, per-owned-agent state (ids + what each is doing), decisions/questions ` +
    `pending with the human, and pointers (file paths, plan ids) instead of prose. ` +
    `Do not start new work this turn.`
  );
}

export type HandshakeResult = 'ok' | 'unconfirmed' | 'failed';

export interface CommittedBrickView {
  id: string;
  writtenAt: string;
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
  /** Raw DB rows via getAgentsByOwner (terminal included, 'done' filtered by wiring). */
  getOwnedAgents(agentId: string): OwnedAgentRow[];
  /** SupervisorManager.isInputInFlight — via the injected instance handle. */
  isInputInFlight(agentId: string): boolean;
  /** hasRunningOrchestrationForSupervisor ('starting'|'running' block). */
  hasRunningOrchestration(agentId: string): boolean;
  /** POST /api/agents/:id/continuation-attempt — server allocates successorGen.
   *  Null on rejection (e.g. 409 open-attempt-exists). */
  openAttempt(
    agentId: string,
    input: { reason: string; thresholdContextPct: number },
  ): Promise<{ attemptId: string; startedAt: string } | null>;
  /** Inject the note request via the send_message HANDSHAKE machinery
   *  (sendInputConfirmed) — never a bare PTY write. */
  requestNote(agentId: string, message: string): Promise<HandshakeResult>;
  /** GET /api/supervisor/continuation-brick?…&source=tool — the
   *  commit-observation read. Tool source ONLY; scrape never authorizes. */
  getCommittedToolBrick(agentId: string, attemptId: string): Promise<CommittedBrickView | null>;
  /** POST /api/agents/:id/continuation-relaunch — the ONLY kill path; the
   *  route re-checks every gate server-side. False on 4xx (keep-alive). */
  relaunch(agentId: string, attemptId: string): Promise<boolean>;
  /** Same route with emptyMemoEscape=true — the note-less "none" escape mode
   *  (Phase 5B). The route re-checks the effort budget server-side. */
  relaunchNone(agentId: string, attemptId: string): Promise<boolean>;
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
        now: this.fx.now(),
        backoffUntil: st.backoffUntil,
      });
      if (!decision.fire) continue;

      st.attemptInProgress = true;
      void this.runAttemptCycle(agentId, decision.crashedOwnedIds, st)
        .catch(err => this.fx.log(`[continuation-watcher] attempt cycle error for ${agentId}: ${err}`))
        .finally(() => { st.attemptInProgress = false; });
    }
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
      };
      this.state.set(agentId, st);
    }
    return st;
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
      const opened = await this.fx.openAttempt(agentId, {
        reason,
        thresholdContextPct: CONTINUATION_TRIGGER_CONTEXT_PCT,
      });
      if (!opened) {
        this.fx.log(`[continuation-watcher] openAttempt rejected for ${agentId}; backing off`);
        this.backoff(st);
        return;
      }
      st.openAttempt = opened;
    }
    const attempt = st.openAttempt;

    // 1b. Relaunch-only retry: the brick already committed on a prior cycle
    //     but the route said no (owned-busy etc.). Nothing to re-request. Re-run
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
      buildNoteRequestMessage(attempt.attemptId, `context ≥ ${CONTINUATION_TRIGGER_CONTEXT_PCT}%`),
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
      return;
    }
    // 'ok' | 'unconfirmed' both proceed to commit observation: 'unconfirmed'
    // is not proof of failure, and the DB row — not the tool response — is
    // the authority either way.

    // 3. Commit-observed wait: poll the brick DB row until committed or
    //    timeout. A tool/HTTP timeout AFTER commit still lands here as
    //    success because we read the row, not the response.
    const deadline = this.fx.now() + HANDSHAKE_TIMEOUT_MS;
    for (;;) {
      const brick = await this.fx.getCommittedToolBrick(agentId, attempt.attemptId);
      if (isKillAuthorized(brick, attempt.startedAt)) {
        st.committedReady = true;
        // BUG-39: the commit is kill-AUTHORIZATION, not kill-TIMING. The author
        // is by construction still mid-turn (it just made the tool call), so
        // wait for its turn to complete before the PTY stop — else its closing
        // message + transcript tail are truncated ≤5 s after commit.
        await this.waitPostNoteGrace(agentId);
        await this.tryRelaunch(agentId, attempt.attemptId, st);
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
      const ok = await this.fx.relaunchNone(agentId, attempt.attemptId);
      if (ok) {
        this.fx.pageHuman(agentId,
          `Continuation note-less escape fired after effort budget exhausted (attempt ${attempt.attemptId}; ${budget.abortedCount} prior aborts this cycle).`);
        this.clearCycle(st);
        return;
      }
      this.fx.pageHuman(agentId,
        `Continuation note-less escape relaunch was rejected server-side (attempt ${attempt.attemptId}); supervisor kept alive.`);
      this.backoff(st);
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
  }

  /** BUG-39 (WP1) — post-note grace: after the brick commits, poll self-idle on
   *  the note-poll cadence until the author's turn completes (N consecutive idle
   *  readings) OR a bounded grace deadline (started NOW, at commit-observation)
   *  passes — then proceed to relaunch either way. `isIdle` is the same injected
   *  StatusMonitor-latch effect the trigger uses; no new wiring surface. */
  private async waitPostNoteGrace(agentId: string): Promise<void> {
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
    const ok = await this.fx.relaunch(agentId, attemptId);
    if (ok) {
      this.clearCycle(st);
      return;
    }
    // Server-side gate disagreed (owned-busy / in-flight / awaiting-human /
    // orchestration). Keep-alive, keep the committed brick, back off and
    // retry the relaunch only.
    this.fx.log(`[continuation-watcher] relaunch rejected server-side for ${agentId} (attempt ${attemptId}); keep-alive, will retry`);
    this.backoff(st);
  }
}
