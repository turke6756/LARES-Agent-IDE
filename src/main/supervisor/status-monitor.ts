import { EventEmitter } from 'events';
import { Agent, AgentStatus, PersistedAgentStatus } from '../../shared/types';
import {
  STATUS_POLL_INTERVAL_MS,
  HOOK_SILENCE_WARN_MS,
  START_HOOK_SILENCE_WARN_MS,
  START_HOOK_RESEND_AFTER_MS,
  START_HOOK_RESEND_INTERVAL_MS,
  START_HOOK_RESEND_MAX_ATTEMPTS,
  CONFIRM_WINDOW_FIRST_MS,
  CONFIRM_WINDOW_RETRY_MS,
  CONFIRM_POLL_MS,
  MAX_SUBMIT_RETRIES,
  LAUNCH_SETTLE_TIMEOUT_MS,
  LAUNCH_SETTLE_OVERRUN_GRACE_MS,
  HOOK_CANARY_WINDOW_MS,
  WORKER_STALL_WARN_MS,
} from '../../shared/constants';
import { getActiveAgents, applyStatusTransition, updateAgentHookStatus, addEvent } from '../database';
import type { StatusChangedEvent } from './status-events';

export type WaitingKind = 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern' | 'notification';

// BUG-18 Change 1 — added `thinking-pending` (900 s ceiling) for Claude
// extended-thinking and equivalent provider phases where no chat event
// lands for minutes.
export type WorkingLatchTtlClass = 'short' | 'model-pending' | 'tool-pending' | 'thinking-pending';

/** Typed options for {@link StatusMonitor.forceWorking}. See
 *  plans/bug-09-fix-design.md §3.1 — the previous `(agentId, source)` shape
 *  could not carry the toolUseId pairing the consolidated fix needs. */
export interface ForceWorkingOpts {
  source: string;
  toolUseId?: string;
  resolvedToolUseId?: string;
  ttlClass: WorkingLatchTtlClass;
  /** BUG-18 Change 3 — marker that "this turn has begun and has not yet
   *  hit a terminal event." Set by the bridge on tool-use, task-started,
   *  and non-terminal assistant-text. Once true, the latch refresh holds
   *  it true across subsequent refreshes; forceIdle('turnComplete')
   *  overwrites the whole latch and naturally clears it. While true and
   *  no tools are outstanding, `inferStatus` forces the effective TTL to
   *  the tool-pending ceiling so a `tool_result → next assistant thinking
   *  gap` (Claude writeup §2.1) can survive past the model-pending floor. */
  turnInFlight?: boolean;
}

interface IdleLatchEntry {
  state: 'idle';
  setAt: number;
}

interface WaitingLatchEntry {
  state: 'waiting';
  setAt: number;
  waitingKind: WaitingKind;
  waitingExcerpt: string;
}

/** BUG-09 §3.1 — `working` is now a first-class latch state. The latch carries
 *  the set of outstanding `toolUseId`s so a tool that is silently running can
 *  hold the latch indefinitely (within `tool-pending` TTL) without depending
 *  on PTY bursts crossing the 200 B/3 s gate. */
interface WorkingLatchEntry {
  state: 'working';
  setAt: number;
  refreshedAt: number;
  outstandingToolIds: Set<string>;
  source: string;
  ttlClass: WorkingLatchTtlClass;
  /** BUG-18 Change 3 — set true by the bridge on tool-use, task-started, or
   *  non-terminal assistant-text refreshes. Sticks through subsequent
   *  refreshes; cleared only when `forceIdle('turnComplete')` overwrites
   *  the latch. See {@link ForceWorkingOpts.turnInFlight}. */
  turnInFlight: boolean;
}

export type TurnLatchEntry = IdleLatchEntry | WaitingLatchEntry | WorkingLatchEntry;

const TERMINAL_STATUSES: ReadonlyArray<AgentStatus> = ['crashed', 'done'];
const TRANSITIONAL_STATUSES: ReadonlyArray<AgentStatus> = ['launching', 'restarting'];

/** BUG-23 — `'launch-settle'` (wallclock budget exhausted) and `'stop-hook'`
 *  (authoritative end-of-turn signal arrived) are the ONLY sources allowed
 *  to bypass the `TRANSITIONAL_STATUSES` guard for the `'launching' → 'idle'`
 *  transition. Every other write path keeps the existing guard. The narrow
 *  bypass exists because, post-BUG-23, the launch site writes `'launching'`
 *  rather than `'working'`, and nothing else in the system can move a
 *  supervised Claude worker out of `'launching'` (PTY inference is disabled
 *  for that lane by Plan 1, and the regular `forceIdle` no-ops on
 *  transitional states). Future contributors: copying the `force*` guard
 *  pattern is correct; this surgical exception is a load-bearing decision —
 *  keep `canForceTransition()` as the named locus so the bypass stays
 *  visible. */
export type PromoteFromLaunchingSource = 'launch-settle' | 'stop-hook' | 'other';
function canForceTransition(
  curr: AgentStatus,
  target: AgentStatus,
  source: PromoteFromLaunchingSource,
): boolean {
  if (curr !== 'launching') return false;
  if (target !== 'idle') return false;
  return source === 'launch-settle' || source === 'stop-hook';
}

export class StatusMonitor extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private checkAlive: (agent: Agent) => Promise<boolean>;
  /** BUG-09 §3.5 — last meaningful-burst timestamp (used to promote
   *  `idle → working`). Stays stale during Coalescing / spinner-only phases. */
  private getLastMeaningfulBurst: (agentId: string) => number;
  /** BUG-09 §3.5 — last raw PTY byte timestamp (used to keep a `working`
   *  agent from being downgraded to `idle` while the spinner is still
   *  redrawing). */
  private getLastRawOutput: (agentId: string) => number;
  private getAgentFn: (id: string) => Agent | null;
  /** P2-02: Pulls the trailing PTY bytes for prompt-pattern matching.
   *  Defaults to empty string when not injected (tests). */
  private getOutputRingTail: (agentId: string) => string;
  // Hold a status for a short period after a transition to prevent PTY
  // byte-flicker from immediately undoing it.
  private statusHoldUntil = new Map<string, number>();
  // Per-agent latch driven by Pipeline B (chat-stream `turnComplete` / waiting
  // signals, plus BUG-09's `working` variant). While set within TTL,
  // `inferStatus` honors the latched state. See plans/bug-09-fix-design.md §3.1.
  private turnLatch = new Map<string, TurnLatchEntry>();
  // Class IV (plans/disable-inference-for-supervised-claude-workers.md §2.3 + §2.2)
  // — last Stop-hook event timestamp per agent, used by the §2.2 watchdog to
  // detect hook silence on supervised Claude workers. Writes go through
  // `recordHookEventAt`, called by `AgentSupervisor.forceIdleFromHook`.
  private lastHookEventAt = new Map<string, number>();
  // Dedupes watchdog warnings so we don't re-warn every poll tick (every 1.5 s)
  // once silence exceeds the threshold. Cleared on a real hook event and on
  // any non-working status.
  private lastWatchdogWarnAt = new Map<string, number>();
  // Start-hook silence watchdog — separate map keyed only on
  // `hook-start` source events so a Stop hook can't satisfy a missed
  // UserPromptSubmit hook (the bug we're trying to detect is specifically
  // a missing start hook).
  private lastStartHookEventAt = new Map<string, number>();
  // Dedupes start-hook silence warnings per input delivery — cleared when a
  // new input is delivered (re-arms the watchdog for the new turn) and when
  // any start-hook event fires.
  private lastStartWatchdogWarnAt = new Map<string, number>();
  // BUG-10 reactive Enter-resend — per-input attempt counter and last-resend
  // stamp. Both reset on a real start-hook event (submit took) and on a new
  // input delivery (fresh turn). See checkStartHookResend.
  private startHookResendCount = new Map<string, number>();
  private lastStartHookResendAt = new Map<string, number>();
  // BUG-10 — injected by AgentSupervisor: replays ONLY the submit keystroke
  // (no body) to an agent whose prompt was delivered but never submitted.
  // Left undefined in tests that don't exercise the resend path.
  private resubmit?: (agentId: string) => void;
  // BUG-23 — wallclock stamp set when `runner.launch()` returns, read by
  // `poll()` to fire the per-provider settle-timer promotion `launching → idle`.
  // Cleared synchronously by `promoteFromLaunching` so a hook arriving inside
  // the settle window prevents a duplicate `launch-settle` emission on the
  // next poll tick. Also cleared in `forgetAgent` and on terminal-exit
  // detection inside `poll()`.
  private launchedAt = new Map<string, number>();
  // Dedupe for the narrow overrun warning (settle timer itself misbehaving).
  private lastLaunchOverrunWarnAt = new Map<string, number>();
  // HOOK_SYSTEM_DESIGN.md §5.4 / B5 — launch-time hook canary. Stamped (with
  // the launch wallclock) by `recordHookCanary` when a worker-lane agent
  // launches; cleared by `clearHookCanary` the instant any hook event arrives.
  // While armed, `checkHookCanary` flips hook_status 'unknown' → 'broken' once
  // HOOK_CANARY_WINDOW_MS elapses with no hook — proving the scaffold never
  // loaded, without waiting for the 15-min silence watchdog.
  private canaryArmedAt = new Map<string, number>();
  // BUG-23 §watchdog reframe — wallclock stamp set when the supervisor delivers
  // input to an agent (sendInput). The reframed Class IV watchdog uses this to
  // detect a scaffold-broken supervised Claude worker: input went in, but no
  // Stop hook ever came back. Stays set across subsequent inputs (last wins).
  private lastInputDeliveredAt = new Map<string, number>();
  // Synchronous submit-confirmation in-flight marker (plan §coordination). While
  // an agent id is in this set, `_doSendInput`'s confirm-and-retry owns the
  // re-press for that turn, so the reactive `checkStartHookResend` /
  // `checkStartHookSilence` pollers MUST stand down to avoid double-pressing or
  // a spurious silence warning during a legitimate first-window+retry.
  private confirmInFlight = new Set<string>();
  // Injected by AgentSupervisor: the centralized contract-vs-fallback predicate
  // (`usesSubmitConfirmation`). The reactive Enter-resend poller uses it to skip
  // contract providers entirely — they go through the synchronous path, and the
  // reactive path remains ONLY as the fallback for non-contract providers
  // (Gemini / unconfirmable-Codex). Left undefined in tests that don't exercise
  // the poller-coordination seam (then no agent is treated as contract).
  private usesSubmitConfirmation?: (agent: Agent) => boolean;
  // Stalled-worker watchdog — agents already warned for the CURRENT working
  // stretch, so the event fires once per stretch instead of every poll tick.
  // Cleared when the agent leaves `working`, when any signal goes fresh
  // again, and in forgetAgent.
  private workerStallWarned = new Set<string>();
  // Injected by AgentSupervisor: delivers the worker_stalled supervisor event
  // (EventBridge.onWorkerStalled). Left undefined in tests that don't
  // exercise the stall seam (then the watchdog is warn-only via console).
  private onWorkerStalled?: (agent: Agent, stalledForMs: number) => void;
  // P1 §3 — single hook-transport drain callback (spool tailers + tmux
  // option poll), injected by AgentSupervisor via setHookTransportPoller.
  // Runs once per poll tick, before any per-agent work. Undefined in tests
  // that don't exercise the transport seam.
  private hookTransportPoller?: () => void;
  private now: () => number;
  /** Injectable poll delay. Defaults to real `setTimeout`. Tests inject a
   *  fake that advances the fake clock so {@link confirmSubmission} resolves
   *  deterministically without real wall-clock waits. SEAM NOTE: this controls
   *  only POLL/WINDOW timing — the confirmation COMPARISON
   *  (`getLastStartHookEventAt > priorStartHookAt`) is Date.now-vs-Date.now
   *  (hooks are recorded host-side with real `Date.now()`), independent of this
   *  clock. See plan §2.4. */
  private sleep: (ms: number) => Promise<void>;

  constructor(
    checkAlive: (agent: Agent) => Promise<boolean>,
    getLastMeaningfulBurst: (agentId: string) => number,
    getAgentFn: (id: string) => Agent | null,
    now: () => number = () => Date.now(),
    getOutputRingTail: (agentId: string) => string = () => '',
    /** BUG-09 §3.5 — optional raw PTY timestamp accessor. Defaults to the
     *  meaningful-burst accessor when not provided so existing tests don't
     *  have to thread a second function through. Production callers should
     *  always supply this. */
    getLastRawOutput?: (agentId: string) => number,
    /** Optional injectable poll delay for {@link confirmSubmission}. */
    sleep?: (ms: number) => Promise<void>,
  ) {
    super();
    this.checkAlive = checkAlive;
    this.getLastMeaningfulBurst = getLastMeaningfulBurst;
    this.getLastRawOutput = getLastRawOutput ?? getLastMeaningfulBurst;
    this.getAgentFn = getAgentFn;
    this.now = now;
    this.getOutputRingTail = getOutputRingTail;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Inject the contract-vs-fallback predicate. AgentSupervisor wires its
   *  `usesSubmitConfirmation` here so the reactive resend poller can skip
   *  contract providers (the synchronous path owns their re-press). */
  setSubmitConfirmationPredicate(fn: (agent: Agent) => boolean): void {
    this.usesSubmitConfirmation = fn;
  }

  /** Inject the stalled-worker event sink. AgentSupervisor wires
   *  EventBridge.onWorkerStalled here so checkWorkerStalled can notify the
   *  workspace supervisor. */
  setWorkerStalledHandler(fn: (agent: Agent, stalledForMs: number) => void): void {
    this.onWorkerStalled = fn;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), STATUS_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** BUG-10 — register the submit-resend handler. AgentSupervisor injects a
   *  closure that replays the per-platform submit keystroke to the agent's
   *  PTY/tmux pane. Without it, checkStartHookResend degrades to warn-only. */
  setResubmitHandler(fn: (agentId: string) => void): void {
    this.resubmit = fn;
  }

  /** P1 (plans/p1-hook-spool-multi-transport.md §3) — register the single
   *  hook-transport poller. `poll()` invokes it EXACTLY ONCE at the very top
   *  of each tick, before `getActiveAgents()` and therefore before any
   *  per-agent watchdog/canary work, so a spool-delivered SessionStart
   *  disarms the canary BEFORE the canary evaluates the same tick. The
   *  supervisor registers one callback that drains all spool tailers and
   *  (every 4th tick) fires the tmux pane-option poll. */
  setHookTransportPoller(fn: () => void): void {
    this.hookTransportPoller = fn;
  }

  /** Pipeline B has high-confidence end-of-turn truth. Bypasses
   *  `statusHoldUntil` (the hold exists to dampen PTY flicker, which the chat
   *  stream isn't subject to). No-ops on terminal/transitional states.
   *
   *  BUG-09 §3.1 / C8: overwrites the prior latch with an `idle` entry rather
   *  than `delete`-ing it, so the post-turn PTY-noise protection that the idle
   *  latch provides is preserved even when a prior latch was `working`. */
  forceIdle(agentId: string, source: string): void {
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    const prior = agent.status;
    this.turnLatch.set(agentId, { state: 'idle', setAt: this.now() });
    if (prior === 'idle') return; // already idle — latch updated, no event needed

    const t = applyStatusTransition(agentId, 'idle');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'idle', source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'idle',
      // §B3: fromStatus comes from the in-transaction prior read, never a
      // separate getAgent() — a second read can observe another writer.
      fromStatus: t?.prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
  }

  /** Pipeline B detected the agent is blocked on user input. Sets the latch
   *  to 'waiting' with kind + excerpt for the supervisor payload. */
  forceWaiting(agentId: string, kind: WaitingKind, excerpt: string): void {
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    const prior = agent.status;
    this.turnLatch.set(agentId, {
      state: 'waiting',
      setAt: this.now(),
      waitingKind: kind,
      waitingExcerpt: excerpt,
    });
    if (prior === 'waiting') return;

    const t = applyStatusTransition(agentId, 'waiting');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'waiting', source: kind }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'waiting',
      fromStatus: t?.prior,
      source: 'monitor',
      // P2-03: kind + excerpt ride on the event so the bridge can render
      // "[DASHBOARD EVENT] Agent waiting for input" without re-reading the latch.
      waitingKind: kind,
      waitingExcerpt: excerpt,
    };
    this.emit('statusChanged', payload);
  }

  /** Context-brick Inc 5A — expose the waiting-latch kind for
   *  `isAwaitingHuman`. Reads the private `waitingKind` field; returns it
   *  ONLY while the latch state is 'waiting' (an idle/working latch, or no
   *  latch, yields null even if a stale waiting entry was overwritten). */
  getWaitingKind(agentId: string): WaitingKind | null {
    const latch = this.turnLatch.get(agentId);
    if (!latch || latch.state !== 'waiting') return null;
    return latch.waitingKind;
  }

  /** BUG-09 §3.1 — Explicit "turn continues" signal from Pipeline B. Replaces
   *  the previous binary "delete latch" behavior with a tagged `working`
   *  latch that pairs `tool-use` ↔ `tool-result` events by `toolUseId`. Always
   *  refreshes `refreshedAt`, including when the latch is already `working`
   *  (closes C7).
   *
   *  String-source overload — Class IV UserPromptSubmit hook path. Carries no
   *  toolUseId / ttlClass; latch fields are filled with safe defaults. For
   *  supervised agents (the sole consumer) inference is short-circuited at
   *  `inferStatus`, so the latch TTL is bookkeeping rather than load-bearing. */
  forceWorking(agentId: string, opts: ForceWorkingOpts): void;
  forceWorking(agentId: string, source: string): void;
  forceWorking(agentId: string, optsOrSource: ForceWorkingOpts | string): void {
    if (typeof optsOrSource === 'string') {
      this.forceWorkingFromHook(agentId, optsOrSource);
      return;
    }
    const opts = optsOrSource;
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    const now = this.now();
    const existing = this.turnLatch.get(agentId);

    let outstanding: Set<string>;
    let setAt: number;
    let priorTurnInFlight = false;
    if (existing && existing.state === 'working') {
      outstanding = existing.outstandingToolIds;
      setAt = existing.setAt;
      priorTurnInFlight = existing.turnInFlight;
    } else {
      outstanding = new Set<string>();
      setAt = now;
    }

    if (opts.toolUseId) outstanding.add(opts.toolUseId);
    if (opts.resolvedToolUseId) outstanding.delete(opts.resolvedToolUseId);

    // BUG-18 Change 3 — turnInFlight is sticky-true across refreshes. It
    // can only be cleared by `forceIdle('turnComplete')` overwriting the
    // entire latch (and even then the new latch is `idle`, not `working`).
    const turnInFlight = priorTurnInFlight || opts.turnInFlight === true;

    this.turnLatch.set(agentId, {
      state: 'working',
      setAt,
      refreshedAt: now,
      outstandingToolIds: outstanding,
      source: opts.source,
      ttlClass: opts.ttlClass,
      turnInFlight,
    });

    if (agent.status === 'working') return; // already working — latch refreshed, no event needed

    const prior = agent.status;
    const t = applyStatusTransition(agentId, 'working');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'working', source: opts.source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'working',
      fromStatus: t?.prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
  }

  /** Class IV UserPromptSubmit-hook entry point. Mirrors `forceIdle`'s shape
   *  but flips to `'working'`. Latch fields not carried by the hook (toolUseId,
   *  ttlClass, turnInFlight) default to safe values; for supervised agents
   *  `inferStatus` short-circuits before reading the TTL, so the latch is
   *  bookkeeping for the watchdog rather than a TTL ceiling. */
  private forceWorkingFromHook(agentId: string, source: string): void {
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    const now = this.now();
    const prior = agent.status;
    this.turnLatch.set(agentId, {
      state: 'working',
      setAt: now,
      refreshedAt: now,
      outstandingToolIds: new Set<string>(),
      source,
      ttlClass: 'tool-pending',
      turnInFlight: true,
    });
    if (prior === 'working') return;

    const t = applyStatusTransition(agentId, 'working');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'working', source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'working',
      fromStatus: t?.prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
  }

  /** BUG-09 §3.7 — drop all per-agent state on delete/restart so a stale
   *  `tool-pending` latch (up to 15 min) does not survive a runner crash.
   *  BUG-23 §cleanup — also drop the launch + input-delivered + overrun-warn
   *  state so a restart re-stamps cleanly. */
  forgetAgent(agentId: string): void {
    this.turnLatch.delete(agentId);
    this.statusHoldUntil.delete(agentId);
    this.lastHookEventAt.delete(agentId);
    this.lastWatchdogWarnAt.delete(agentId);
    this.launchedAt.delete(agentId);
    this.lastLaunchOverrunWarnAt.delete(agentId);
    this.lastInputDeliveredAt.delete(agentId);
    this.lastStartHookEventAt.delete(agentId);
    this.lastStartWatchdogWarnAt.delete(agentId);
    this.startHookResendCount.delete(agentId);
    this.lastStartHookResendAt.delete(agentId);
    this.canaryArmedAt.delete(agentId);
    this.confirmInFlight.delete(agentId);
    this.workerStallWarned.delete(agentId);
  }

  /** Class IV §2.3 — called by `AgentSupervisor.forceIdleFromHook` and
   *  `forceWorkingFromHook` whenever a hook POST lands. The §2.2 watchdog
   *  reads this map; the start-hook watchdog uses the separate start-only
   *  map populated by `recordStartHookEventAt`. */
  recordHookEventAt(agentId: string, ts: number): void {
    this.lastHookEventAt.set(agentId, ts);
    // A real hook event resets the dedupe so a future silence period
    // produces a fresh warning.
    this.lastWatchdogWarnAt.delete(agentId);
  }

  /** Records the UserPromptSubmit-hook arrival timestamp on its own map so
   *  the start-hook silence watchdog can detect the specific signature
   *  (input went in, no start hook came back) without false-matching a
   *  Stop-hook arrival. Called by `AgentSupervisor.forceWorkingFromHook`. */
  recordStartHookEventAt(agentId: string, ts: number): void {
    this.lastStartHookEventAt.set(agentId, ts);
    this.lastStartWatchdogWarnAt.delete(agentId);
    // The submit took — stand the Enter-resend recovery down for this turn.
    this.startHookResendCount.delete(agentId);
    this.lastStartHookResendAt.delete(agentId);
  }

  /** BUG-23 — called by `AgentSupervisor.launchWindowsAgent` /
   *  `launchWslAgent` immediately after `runner.launch()` returns. Stamps the
   *  wallclock so `poll()` can promote `'launching' → 'idle'` once the
   *  per-provider settle window has elapsed. Naturally idempotent: a restart
   *  overwrites the prior timestamp. */
  recordLaunch(agentId: string, ts: number = this.now()): void {
    this.launchedAt.set(agentId, ts);
    this.lastLaunchOverrunWarnAt.delete(agentId);
  }

  /** BUG-23 — explicit clear, used by terminal-exit cleanup and tests. The
   *  promotion path clears synchronously via `promoteFromLaunching` itself. */
  clearLaunch(agentId: string): void {
    this.launchedAt.delete(agentId);
    this.lastLaunchOverrunWarnAt.delete(agentId);
  }

  /** HOOK_SYSTEM_DESIGN.md §5.4 / B5 — arm the launch-time hook canary. Called
   *  by `AgentSupervisor.launchAgent` for worker-lane agents right after the
   *  agent row is created. Stamps the launch wallclock; `checkHookCanary`
   *  reads it on each poll tick. Naturally idempotent — a relaunch re-arms. */
  recordHookCanary(agentId: string, ts: number = this.now()): void {
    this.canaryArmedAt.set(agentId, ts);
  }

  /** HOOK_SYSTEM_DESIGN.md §5.4 / B5 — disarm the canary. Called via
   *  `AgentSupervisor.stampHookHealthy` the instant any hook event arrives, so
   *  a healthy worker can never be flipped to 'broken'. */
  clearHookCanary(agentId: string): void {
    this.canaryArmedAt.delete(agentId);
  }

  /** Test seam — whether the launch canary is currently armed for an agent. */
  isHookCanaryArmed(agentId: string): boolean {
    return this.canaryArmedAt.has(agentId);
  }

  /** BUG-23 §watchdog reframe — called by `AgentSupervisor._doSendInput` the
   *  moment the body+Enter has been written, BEFORE the synchronous
   *  confirm-and-retry wait (stamping after that wait would land the
   *  timestamp PAST the observed UserPromptSubmit hook and trip a false
   *  start-hook-silence warning — see the call-site comment). Used by the
   *  reframed Class IV watchdog to detect a scaffold-broken supervised
   *  Claude worker (input went in, no hook came back). */
  recordInputDelivered(agentId: string, ts: number = this.now()): void {
    this.lastInputDeliveredAt.set(agentId, ts);
    // Re-arm the start-hook silence watchdog for the new turn so a prior
    // warning's dedupe doesn't suppress a fresh missed-start-hook warning.
    this.lastStartWatchdogWarnAt.delete(agentId);
    // Re-arm the Enter-resend recovery for the new turn.
    this.startHookResendCount.delete(agentId);
    this.lastStartHookResendAt.delete(agentId);
  }

  /** BUG-23 — the ONLY path allowed to bypass the `TRANSITIONAL_STATUSES`
   *  guard for the `'launching' → 'idle'` transition. See
   *  {@link canForceTransition} for the load-bearing decision; future
   *  contributors must route any new `'launching' → 'idle'` write through
   *  this helper rather than copy the bypass. Clears `launchedAt`
   *  synchronously before emitting so the next poll tick's settle check
   *  no-ops and we never double-emit a status change. */
  promoteFromLaunching(agentId: string, source: PromoteFromLaunchingSource): boolean {
    const agent = this.getAgentFn(agentId);
    if (!agent) return false;
    if (!canForceTransition(agent.status, 'idle', source)) return false;

    // Clear the settle timer synchronously so a hook + timer firing in the
    // same poll tick produces a single status change, not two.
    this.launchedAt.delete(agentId);
    this.lastLaunchOverrunWarnAt.delete(agentId);

    // Arm an idle latch so post-promotion PTY noise doesn't immediately
    // flip the agent back to working via inference. Mirrors `forceIdle`'s
    // latch behavior for the supervised lane.
    this.turnLatch.set(agentId, { state: 'idle', setAt: this.now() });

    const prior = agent.status;
    const t = applyStatusTransition(agentId, 'idle');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'idle', source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'idle',
      fromStatus: t?.prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
    return true;
  }

  /** Test seam — used by status-monitor.test.ts to introspect the latch. */
  getLatchSnapshot(agentId: string): TurnLatchEntry | undefined {
    return this.turnLatch.get(agentId);
  }

  /** Test seam — last hook-event timestamp for an agent, or undefined. */
  getLastHookEventAt(agentId: string): number | undefined {
    return this.lastHookEventAt.get(agentId);
  }

  /** Test seam — last start-hook event timestamp for an agent. */
  getLastStartHookEventAt(agentId: string): number | undefined {
    return this.lastStartHookEventAt.get(agentId);
  }

  /** Q6 launch-time self-test signal — has a UserPromptSubmit (`hook-start`)
   *  event EVER fired for this agent since launch? Used by AgentSupervisor's
   *  `usesSubmitConfirmation` to gate Codex onto the throwing contract only once
   *  its start hook has provably fired (trusted+enabled for this launch). The
   *  map is set by `recordStartHookEventAt` and cleared only by `forgetAgent`. */
  hasObservedStartHook(agentId: string): boolean {
    return this.lastStartHookEventAt.has(agentId);
  }

  /** Test seam — whether a synchronous confirm is in flight for an agent. */
  isConfirmInFlight(agentId: string): boolean {
    return this.confirmInFlight.has(agentId);
  }

  /** Synchronous submit confirmation (plan §1 part 1, §2.3, §2.4, Q4). Called by
   *  `AgentSupervisor._doSendInput` AFTER the body + initial Enter were sent for
   *  a contract provider. Confirms the submit actually started a turn by watching
   *  for the UserPromptSubmit (`hook-start`) timestamp to advance past
   *  `priorStartHookAt`; if the first window lapses unconfirmed, re-presses the
   *  submit-only keystroke (via the injected `resubmit` handler — the C2
   *  submit-only builder) up to MAX_SUBMIT_RETRIES times, polling after EACH
   *  press including the last. Returns true on a confirmed turn start, false on
   *  exhaustion (the caller surfaces `lastSendError` + throws).
   *
   *  `priorStartHookAt` MUST be captured by the caller BEFORE sending the body
   *  (§2.3 pre-send baseline): a fast hook that POSTs before `sentAt` would
   *  otherwise be missed and re-pressed after a real submit. It is a real
   *  Date.now-based value (from `getLastStartHookEventAt`), so the `>` comparison
   *  is host-clock-vs-host-clock regardless of the injectable poll clock.
   *
   *  While running, the agent is flagged `confirmInFlight` so the reactive
   *  resend/silence pollers stand down (no double-press, no spurious warn). */
  async confirmSubmission(agentId: string, priorStartHookAt: number): Promise<boolean> {
    this.confirmInFlight.add(agentId);
    try {
      // First (widest) window — the initial body+Enter was already issued by
      // the caller; just watch for the hook.
      if (await this.pollForStartHook(agentId, priorStartHookAt, CONFIRM_WINDOW_FIRST_MS)) {
        return true;
      }
      // Retry loop: submit-only re-press, then poll the (tighter) retry window.
      // The final iteration is polled before the loop exits, so we never throw
      // on an unconfirmed last press (§2.3).
      for (let attempt = 1; attempt <= MAX_SUBMIT_RETRIES; attempt++) {
        try {
          this.resubmit?.(agentId);
        } catch (err) {
          console.error(`[confirm-submit] re-press failed for ${agentId}:`, err);
        }
        if (await this.pollForStartHook(agentId, priorStartHookAt, CONFIRM_WINDOW_RETRY_MS)) {
          return true;
        }
      }
      return false;
    } finally {
      this.confirmInFlight.delete(agentId);
    }
  }

  /** Poll the start-hook timestamp for up to `windowMs`, returning true as soon
   *  as it advances past `priorStartHookAt`. Checks immediately, then sleeps
   *  CONFIRM_POLL_MS between checks. Window timing uses the injectable clock;
   *  the comparison uses the Date.now-based recorded hook timestamp (see the
   *  `sleep` field's SEAM NOTE). */
  private async pollForStartHook(
    agentId: string,
    priorStartHookAt: number,
    windowMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + windowMs;
    while (true) {
      if ((this.lastStartHookEventAt.get(agentId) ?? 0) > priorStartHookAt) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(CONFIRM_POLL_MS);
    }
  }

  private async poll(): Promise<void> {
    // P1 §3 — drain the hook transports ONCE per tick (not once per agent),
    // BEFORE any per-agent watchdog/canary work below: a spool-delivered
    // SessionStart must disarm the canary before checkHookCanary evaluates
    // this same tick. Synchronous by design for the spool; the tmux read is
    // async and applies on completion (a tick of latency is fine for a
    // 6 s-cadence backstop).
    try {
      this.hookTransportPoller?.();
    } catch (err) {
      console.warn('[status-monitor] hook transport poller failed this tick:', err);
    }

    const agents = getActiveAgents();
    for (const agent of agents) {
      try {
        // BUG-23 — settle-timer promotion. Runs before inference so we don't
        // race the (no-op for `'launching'`) `inferStatus` short-circuit.
        // Returns true if the agent was promoted on this tick; either way
        // the per-tick work for this agent is done.
        if (this.checkLaunchSettle(agent)) continue;

        // Class IV §2.2 watchdog runs alongside inference (not inside it,
        // because inferStatus short-circuits for supervised Claude workers).
        // BUG-23 reframe: warn if a supervised Claude worker received input
        // ≥ HOOK_SILENCE_WARN_MS ago and is currently idle but has never
        // had a Stop-hook event recorded — that's the scaffold-broken
        // signature (input went in, no hook came back). See
        // checkHookSilenceWatchdog. Warn-only; no auto-fallback to
        // inference.
        this.checkHookSilenceWatchdog(agent);
        // Class IV start-hook silence — paste-race fix watchdog (BUG-10).
        // Fires on the much shorter START_HOOK_SILENCE_WARN_MS budget.
        this.checkStartHookSilence(agent);
        // BUG-10 reactive recovery — resend the dropped Enter (bounded) when
        // the start-hook silence is the paste-race signature.
        this.checkStartHookResend(agent);
        // HOOK_SYSTEM_DESIGN.md §5.4 / B5 — launch-time hook canary. Flips
        // hook_status 'unknown' → 'broken' once the launch window elapses with
        // no hook event. Status itself is untouched; inference stays disabled.
        this.checkHookCanary(agent);
        // Handoff handshake — stalled-worker watchdog. One-shot
        // worker_stalled supervisor event when a worker sits `working` with
        // zero PTY/hook/input signal for WORKER_STALL_WARN_MS.
        this.checkWorkerStalled(agent);

        const newStatus = await this.inferStatus(agent);
        if (newStatus && newStatus !== agent.status) {
          // BUG-09 §3.6 — re-read the agent record after inferStatus returns
          // and before writing. If a chat event fired forceWorking/forceIdle/
          // forceWaiting between the inference and this write (they go
          // through updateAgentStatus synchronously, see status-monitor's
          // force* methods), the stale poll write would otherwise overwrite
          // it back to the inferred-but-wrong status. Re-reading lets the
          // chat-stream truth win.
          //
          // Codex round 3 note: the gap between `await this.inferStatus(agent)`
          // resolving and the writes below is JS run-to-completion, so the
          // re-read is belt-and-suspenders today (the force* paths are
          // synchronous). It becomes load-bearing if any of force*'s writes
          // ever go async.
          const fresh = this.getAgentFn(agent.id);
          if (fresh && fresh.status !== agent.status) continue;

          // Debounce: hold a status for a short period to prevent rapid flipping
          const holdUntil = this.statusHoldUntil.get(agent.id) || 0;
          if (this.now() < holdUntil) continue;

          const t = applyStatusTransition(agent.id, newStatus);
          // Shorter hold for idle transitions (agent finished), longer for working
          this.statusHoldUntil.set(agent.id, this.now() + (newStatus === 'idle' ? 1500 : 2500));
          addEvent(agent.id, 'status_change', JSON.stringify({ from: agent.status, to: newStatus }));
          const payload: StatusChangedEvent = {
            agentId: agent.id,
            status: newStatus,
            fromStatus: t?.prior,
            source: 'monitor',
          };
          this.emit('statusChanged', payload);
        }
      } catch {
        // Ignore individual agent check failures
      }
    }

    // Context-brick Inc 5B — the lifecycle watcher's tick seam. Emitted at the
    // END of each poll so subscribers observe post-inference statuses.
    this.emit('tick');
  }

  /** BUG-23 — per-provider settle-timer promotion of `'launching' → 'idle'`.
   *  Runs at the top of each poll tick before inference. Returns true if the
   *  per-tick handling for this agent is complete (agent was launching this
   *  tick and either got promoted or just sat in the settle window — either
   *  way, inferStatus would no-op on `'launching'`).
   *
   *  Also emits the narrow "settle-overrun" warning if a launching agent sits
   *  past `LAUNCH_SETTLE_TIMEOUT_MS + LAUNCH_SETTLE_OVERRUN_GRACE_MS` without
   *  being promoted — that means promoteFromLaunching itself failed (cleared
   *  launchedAt but the DB write was lost, or similar) and is a different
   *  failure mode from a quietly-broken hook scaffold. */
  private checkLaunchSettle(agent: Agent): boolean {
    if (agent.status !== 'launching') {
      // Defensive: stale entry from a previous launching run. Clearing here
      // is belt-and-suspenders — promoteFromLaunching + forgetAgent +
      // clearLaunch all clear synchronously. Leave the map quiet rather than
      // pay a delete on every tick.
      return false;
    }
    const stamp = this.launchedAt.get(agent.id);
    if (stamp === undefined) {
      // The agent is in `'launching'` but we never received a recordLaunch.
      // This is normal on app restart when reconnecting to a DB row that
      // was created (default = 'launching') but the runner is no longer
      // alive — inferStatus → checkAlive will handle the done/crashed
      // detection on the next pass. Don't promote without a stamp.
      return true;
    }
    const budget = LAUNCH_SETTLE_TIMEOUT_MS[agent.provider];
    const elapsed = this.now() - stamp;
    if (elapsed < budget) return true;

    const overrun = elapsed - budget;
    if (overrun >= LAUNCH_SETTLE_OVERRUN_GRACE_MS) {
      // The timer should have fired by now. Warn (deduped) and still try to
      // promote — if promoteFromLaunching fails again, the next overrun
      // window will re-warn.
      const lastWarn = this.lastLaunchOverrunWarnAt.get(agent.id) ?? 0;
      if (this.now() - lastWarn >= LAUNCH_SETTLE_OVERRUN_GRACE_MS) {
        console.warn(
          `[bug-23] launch-settle overrun: agent ${agent.id} (${agent.provider}) ` +
          `has been 'launching' for ${Math.round(elapsed / 1000)} s ` +
          `(budget ${Math.round(budget / 1000)} s + grace ` +
          `${Math.round(LAUNCH_SETTLE_OVERRUN_GRACE_MS / 1000)} s). ` +
          `Settle timer itself may be misbehaving.`
        );
        this.lastLaunchOverrunWarnAt.set(agent.id, this.now());
      }
    }

    this.promoteFromLaunching(agent.id, 'launch-settle');
    return true;
  }

  /** Class IV §2.2 (BUG-23 reframe) — warn when a supervised worker has been
   *  delivered input but no Stop hook has EVER fired for it. This is the
   *  scaffold-broken signal (missing script, missing env, bad settings.json
   *  / config.toml): input went in, no hook came back. Pre-BUG-23 the
   *  watchdog watched `status === 'working'`, but with the launch swap +
   *  settle timer those workers no longer sit in `'working'` for long
   *  stretches — the symptom shifted from "stuck working" to "input
   *  delivered, status went idle (via settle), and still no hook ever
   *  arrived." Detecting the latter directly preserves the scaffold-broken
   *  signal without false-positives on quietly-idle workers.
   *
   *  Scope broadened per plans/class-iv-worker-hook-scaffold.md §12.5 — now
   *  fires for any supervised provider whose hook never fires. Codex has a
   *  Stop-hook scaffold (§12.1); Gemini does not yet, so the watchdog will
   *  warn for every supervised Gemini worker until §12.2 lands. That's the
   *  desired behavior: a missing scaffold should be loud, not silent.
   *
   *  Dedupes via `lastWatchdogWarnAt`. */
  private checkHookSilenceWatchdog(agent: Agent): void {
    if (!(agent.isSupervised || agent.isWorker || agent.isResearcher)) return;
    if (agent.status !== 'idle') {
      // Only warn from the idle state. Working / waiting / launching mean
      // the system is reacting normally; clear dedupe so a later re-entry
      // into idle with no hook re-warns.
      this.lastWatchdogWarnAt.delete(agent.id);
      return;
    }
    // No hooks ever recorded for this agent? That's the scaffold-broken
    // signature. If a hook has ever fired, the scaffold works and the
    // watchdog has nothing to say.
    if (this.lastHookEventAt.has(agent.id)) {
      this.lastWatchdogWarnAt.delete(agent.id);
      return;
    }
    // No input has been delivered yet? Then "no hook recorded" is expected
    // (hooks fire on turn-end, no turn has happened). Don't warn.
    const inputAt = this.lastInputDeliveredAt.get(agent.id);
    if (inputAt === undefined) return;

    const now = this.now();
    const silenceMs = now - inputAt;
    if (silenceMs < HOOK_SILENCE_WARN_MS) return;

    const lastWarn = this.lastWatchdogWarnAt.get(agent.id) ?? 0;
    if (now - lastWarn < HOOK_SILENCE_WARN_MS) return;

    const minutes = Math.round(silenceMs / 60_000);
    console.warn(
      `[class-iv] supervised ${agent.provider} worker ${agent.id} received input ` +
      `${minutes} min ago and is idle, but no Stop-hook event has ever ` +
      `been recorded — verify .lares/scripts/dashboard-status.mjs is ` +
      `wired and AGENT_ID + DASHBOARD_PORT envs reach the worker.`
    );
    this.lastWatchdogWarnAt.set(agent.id, now);
  }

  /** HOOK_SYSTEM_DESIGN.md §5.4 / B5 — launch-time hook canary. When a
   *  worker-lane agent launches, `recordHookCanary` arms a window; the first
   *  hook event of any kind disarms it via `clearHookCanary`. If the window
   *  elapses while still armed AND hook_status is still 'unknown', the scaffold
   *  never loaded — flip hook_status to 'broken' (loud warning) so the UI/
   *  supervisor can surface it immediately instead of waiting for the 15-min
   *  silence watchdog.
   *
   *  Deliberately does NOT touch `status` and does NOT re-enable inference for
   *  worker-lane agents — 'broken' is a health signal only. Fires at most once
   *  per arm (disarms itself after flipping). A 'degraded' (B2) or already
   *  'healthy' agent is left alone — we only act on 'unknown'. */
  private checkHookCanary(agent: Agent): void {
    const armedAt = this.canaryArmedAt.get(agent.id);
    if (armedAt === undefined) return;

    if (this.now() - armedAt < HOOK_CANARY_WINDOW_MS) return;

    // Window elapsed. Disarm regardless of outcome so we evaluate exactly once.
    this.canaryArmedAt.delete(agent.id);

    // A hook event between arm and now would have cleared the canary already,
    // so reaching here means none arrived. Only flip from the launch default;
    // never clobber a 'degraded' (B2) or a racing 'healthy'.
    if ((agent.hookStatus ?? 'unknown') !== 'unknown') return;

    updateAgentHookStatus(agent.id, 'broken');
    console.warn(
      `[hook-canary] ${agent.provider} worker ${agent.id} produced no hook event ` +
      `within ${Math.round(HOOK_CANARY_WINDOW_MS / 1000)} s of launch — hook scaffold ` +
      `appears broken (missing/unloaded settings.json or config.toml, missing ` +
      `AGENT_ID/DASHBOARD_PORT env, or an un-instrumented command). hook_status='broken'. ` +
      `Worker-lane status stays hook-owned (PTY inference remains disabled).`,
    );
  }

  /** Start-hook silence watchdog (BUG-10 paste-race fix). For supervised
   *  workers, fires once per input delivery when:
   *    - agent is idle (the lie we're detecting)
   *    - input was delivered ≥ START_HOOK_SILENCE_WARN_MS ago
   *    - no UserPromptSubmit hook landed since that input delivery
   *  Warn-only; emits a `'start-hook-silence-watchdog'` status-change event
   *  so a supervisor consumer can observe the false-idle window. */
  private checkStartHookSilence(agent: Agent): void {
    if (!(agent.isSupervised || agent.isWorker || agent.isResearcher)) return;
    if (agent.status !== 'idle') return;
    // A synchronous confirm is mid-flight — its first-window+retry budget is a
    // legitimate not-yet-confirmed window; don't trip the silence warn.
    if (this.confirmInFlight.has(agent.id)) return;

    const inputAt = this.lastInputDeliveredAt.get(agent.id);
    if (inputAt === undefined) return;

    const now = this.now();
    if (now - inputAt < START_HOOK_SILENCE_WARN_MS) return;

    const lastStartHook = this.lastStartHookEventAt.get(agent.id) ?? 0;
    if (lastStartHook >= inputAt) return;

    const lastWarn = this.lastStartWatchdogWarnAt.get(agent.id) ?? 0;
    if (lastWarn >= inputAt) return;

    const seconds = Math.round((now - inputAt) / 1000);
    console.warn(
      `[bug-10] supervised ${agent.provider} worker ${agent.id} received input ` +
      `${seconds}s ago but no UserPromptSubmit hook has fired — dashboard ` +
      `may be lying that the agent is idle (paste race). Verify the ` +
      `UserPromptSubmit hook scaffold.`
    );
    this.lastStartWatchdogWarnAt.set(agent.id, now);
    const payload: StatusChangedEvent = {
      agentId: agent.id,
      status: agent.status,
      fromStatus: agent.status,
      source: 'start-hook-silence-watchdog',
    };
    this.emit('statusChanged', payload);
  }

  /** BUG-10 reactive recovery — when the start-hook silence signature is
   *  present (input delivered, agent still idle, no UserPromptSubmit hook
   *  since), resend ONLY the submit keystroke to recover a dropped Enter.
   *
   *  Scoped to hook-backed providers (claude/codex workers): the resend's
   *  stop condition is the authoritative UserPromptSubmit hook, which gemini
   *  and non-worker agents don't emit, so for them "no hook" is not evidence
   *  of a dropped Enter. Bounded to START_HOOK_RESEND_MAX_ATTEMPTS so a
   *  genuinely-broken hook scaffold (no hook will ever come) degrades to the
   *  warn-only checkStartHookSilence rather than resending forever.
   *
   *  Safety: the body is never re-sent (it already sits in the prompt buffer),
   *  and the resend only fires from `idle` — once the real (or a resent) Enter
   *  takes, the hook flips status to `working` and recordStartHookEventAt
   *  stands this recovery down. */
  private checkStartHookResend(agent: Agent): void {
    if (!this.resubmit) return;
    if (!(agent.isSupervised || agent.isWorker || agent.isResearcher)) return;
    // Hook-backed providers only — see method doc.
    if (agent.provider !== 'claude' && agent.provider !== 'codex') return;
    // Coordination with the synchronous path (plan §coordination): contract
    // providers re-press inside `_doSendInput`'s confirm-and-retry. The reactive
    // poller remains ONLY the fallback for non-contract providers
    // (unconfirmable-Codex). Skip if this agent uses the throwing contract, and
    // skip while a confirm is mid-flight (belt-and-suspenders — the predicate
    // already covers contract agents, this also guards the in-flight window).
    if (this.confirmInFlight.has(agent.id)) return;
    if (this.usesSubmitConfirmation?.(agent)) return;
    // `working` means the hook fired (submit took); only act from the idle lie.
    if (agent.status !== 'idle') return;

    const inputAt = this.lastInputDeliveredAt.get(agent.id);
    if (inputAt === undefined) return;

    // A UserPromptSubmit hook since the input → the submit took, nothing to do.
    const lastStartHook = this.lastStartHookEventAt.get(agent.id) ?? 0;
    if (lastStartHook >= inputAt) return;

    const now = this.now();
    // Give the genuine hook time to round-trip before assuming a drop.
    if (now - inputAt < START_HOOK_RESEND_AFTER_MS) return;

    const attempts = this.startHookResendCount.get(agent.id) ?? 0;
    if (attempts >= START_HOOK_RESEND_MAX_ATTEMPTS) return;

    // Space out retries (the first one is gated by RESEND_AFTER above).
    const lastResend = this.lastStartHookResendAt.get(agent.id) ?? 0;
    if (attempts > 0 && now - lastResend < START_HOOK_RESEND_INTERVAL_MS) return;

    this.startHookResendCount.set(agent.id, attempts + 1);
    this.lastStartHookResendAt.set(agent.id, now);
    const seconds = Math.round((now - inputAt) / 1000);
    console.warn(
      `[bug-10] resending Enter to ${agent.provider} worker ${agent.id} ` +
      `(attempt ${attempts + 1}/${START_HOOK_RESEND_MAX_ATTEMPTS}) — input ` +
      `${seconds}s ago, still idle, no UserPromptSubmit hook (dropped-Enter ` +
      `paste race).`
    );
    try {
      this.resubmit(agent.id);
    } catch (err) {
      console.error(`[bug-10] resend Enter failed for ${agent.id}:`, err);
    }
  }

  /** Handoff handshake — stalled-worker watchdog. A supervised/worker-lane
   *  agent in `working` whose every signal (raw PTY output, hook events,
   *  delivered input) is older than WORKER_STALL_WARN_MS is presumed stuck:
   *  a live turn keeps the PTY streaming (token output or spinner redraws
   *  advance lastRawOutputTime), and a worker that never finishes will never
   *  emit the Stop hook the supervisor is waiting on. Fires the injected
   *  worker_stalled sink ONCE per working stretch; re-arms when the agent
   *  leaves `working` or any signal goes fresh again.
   *
   *  Workers only: non-worker agents have PTY inference active, which
   *  already flips a silent agent to idle (and notifies via status_change).
   */
  private checkWorkerStalled(agent: Agent): void {
    if (!(agent.isSupervised || agent.isWorker || agent.isResearcher)) return;
    if (agent.status !== 'working') {
      this.workerStallWarned.delete(agent.id);
      return;
    }

    const lastSignal = Math.max(
      this.getLastRawOutput(agent.id),
      this.lastHookEventAt.get(agent.id) ?? 0,
      this.lastInputDeliveredAt.get(agent.id) ?? 0,
    );
    // No reference point at all (e.g. monitor restarted mid-turn and the
    // runner has produced no output since) — don't guess.
    if (lastSignal <= 0) return;

    const stalledForMs = this.now() - lastSignal;
    if (stalledForMs < WORKER_STALL_WARN_MS) {
      // Signal is fresh again — re-arm for a future stall in this stretch.
      this.workerStallWarned.delete(agent.id);
      return;
    }
    if (this.workerStallWarned.has(agent.id)) return;
    this.workerStallWarned.add(agent.id);

    const mins = Math.round(stalledForMs / 60000);
    console.warn(
      `[stall-watchdog] ${agent.provider} worker ${agent.id} ("${agent.title}") has been ` +
      `'working' with zero PTY/hook signal for ~${mins} min — presumed stalled.`
    );
    try {
      this.onWorkerStalled?.(agent, stalledForMs);
    } catch (err) {
      console.error(`[stall-watchdog] worker_stalled sink failed for ${agent.id}:`, err);
    }
  }

  // Returns a PERSISTED status (never the projection-only 'receiving') — the
  // poll loop feeds this straight into applyStatusTransition.
  private async inferStatus(agent: Agent): Promise<PersistedAgentStatus | null> {
    if (agent.status === 'restarting' || agent.status === 'launching') {
      return null; // Don't override transitional states
    }

    const alive = await this.checkAlive(agent);
    if (!alive) {
      if (agent.lastExitCode === 0) return 'done';
      return 'crashed';
    }

    // Status is hook-owned for EVERY agent. working/idle/waiting come from the
    // hook pipeline (UserPromptSubmit→working, Stop→idle, Notification→waiting
    // via applyHookStatusEvent) and, for hookless providers (gemini), from the
    // chat-stream's turnComplete in event-bridge. PTY heuristics — the
    // working-latch TTL read, raw/meaningful burst inference, and the
    // PromptPatternDetector → `waiting` fallback — were removed: they raced the
    // hooks and manufactured false working/idle and a `waiting` state that
    // didn't correspond to a real TUI prompt. `inferStatus` now only resolves
    // liveness (done/crashed, handled by the `!alive` branch above); for a live
    // agent it is a deliberate no-op so the last hook / chat-stream write stands.
    return null;
  }
}
