import type { Agent, AgentStatus, ContextStats, FileActivity } from '../../shared/types';
import { hasSupervisorPrivilege } from '../../shared/types';
import type { ChatEventBatch, ToolUseEvent } from '../../shared/session-events';
import type { StatusChangedEvent } from './status-events';
import type { ForceWorkingOpts, WaitingKind } from './status-monitor';
import {
  SupervisorEvent,
  buildEventPayload,
  buildConsolidatedPayload,
} from './event-payload-builder';
import {
  SUPERVISOR_EVENT_COOLDOWN_MS,
  SUPERVISOR_EVENT_LOG_TAIL_LINES,
  SUPERVISOR_CONTEXT_THRESHOLDS,
  SUPERVISOR_EVENT_QUEUE_MAX,
  SUPERVISOR_EVENT_DRAIN_INTERVAL_MS,
  SUPERVISOR_USER_TYPING_QUIESCENT_MS,
  TRANSIENT_SUB_TTL_MS,
  TRANSIENT_SUB_PENDING_START_TIMEOUT_MS,
  TRANSIENT_SUB_MAX_PER_TARGET,
} from '../../shared/constants';

/** Subset of StatusMonitor's public surface that the bridge needs to drive
 *  Pipeline B → status wiring. Injected so tests can stub it. */
export interface StatusMonitorForceCollaborator {
  forceIdle(agentId: string, source: string): void;
  forceWaiting(agentId: string, kind: WaitingKind, excerpt: string): void;
  /** BUG-09 §3.1 — typed options carry `toolUseId` / `resolvedToolUseId` so
   *  the latch can pair `tool-use` ↔ `tool-result` events. */
  forceWorking(agentId: string, opts: ForceWorkingOpts): void;
}

export interface EventBridgeDeps {
  getAgent(id: string): Agent | null;
  /** Resolve the agent that should RECEIVE `worker`'s lifecycle events. The
   *  return is a *recipient*, not necessarily the owner: explicit owner edge
   *  (the launcher), if alive → the owner; a terminal/missing owner → the
   *  structural workspace-supervisor backstop; no owner edge but supervised →
   *  structural supervisor (legacy); otherwise null (unowned + unsupervised →
   *  drop). Wraps `getOwnerForWorker(worker)` in production. */
  getOwnerForWorker(worker: Agent): Agent | null;
  sendInput(supervisorId: string, text: string): Promise<void>;
  addAuditEvent(
    agentId: string,
    type: 'supervisor_event' | 'supervisor_event_batch',
    payload: string,
  ): void;
  getAgentLog(agentId: string, lines: number): Promise<string>;
  getContextStats(agentId: string): ContextStats | null;
  now(): number;
  scheduleDrain(ms: number, fn: () => void): { cancel(): void };
  /** Pipeline B status hints from `onChatEvents`. Added in P1A-02. */
  statusMonitor: StatusMonitorForceCollaborator;
  /** BUG-11: epoch-ms of the last byte the user wrote into this agent's PTY
   *  via `writeToAgent` (xterm keystrokes / paste / drop / query-injection).
   *  Returns undefined when the agent has never received a user-PTY write.
   *  Used to defer event auto-submit while the user is actively typing. */
  getLastUserPtyWriteAt(agentId: string): number | undefined;
  /** BUG-41: true while a continuation swap is mid-flight for this agent id
   *  (from `continuationRelaunch` entry until the launch tail's `finally`,
   *  success AND failure). During that window the recipient's status walks
   *  `working → done → restarting → launching`; the sub-second `done` window
   *  between `stopAgent` and the `restarting` flip would otherwise DROP (and a
   *  drain firing then would PURGE) events keyed to that recipient. The bridge
   *  treats a `done` recipient as a queue-status — never a drop/purge — only
   *  while this holds; a genuinely-stopped `done` (predicate false) still
   *  purges, and because the predicate always clears in the launch tail's
   *  finally, the drain re-arm loop always terminates. */
  isContinuationSwapInFlight(agentId: string): boolean;
  /** BUG-20: fetch the agent's most recent clean assistant chat message
   *  (typically wrapping `AgentChatService.getMessages`). Returning
   *  `undefined` (or throwing — the caller swallows errors) makes the bridge
   *  fall back to the PTY-frame logTail preview. */
  getLastAssistantMessage(agentId: string): Promise<string | undefined>;
  /** BUG-20: fetch recent file activities for the agent — typically a thin
   *  wrapper over `getFileActivities(agentId)`. Returning an empty array (or
   *  throwing) makes the bridge omit the "Files touched:" section. */
  getFileActivities(agentId: string): FileActivity[];
  /** WP2 provenance spine — transcript-side breadcrumb capture. When present,
   *  `case 'tool-use':` forwards the event so plan read/edit-target touches are
   *  persisted as trusted turn evidence. Optional: absent → the bridge runs
   *  exactly as before (planning-surface code stays independently shippable). */
  planTouchTracker?: PlanTouchTrackerCollaborator;
}

/** The one method the bridge needs from the tracker; injected so tests can stub
 *  it and so the tracker's DB deps stay out of the bridge. Tolerant by contract
 *  (never throws), so the bridge does not guard the call. */
export interface PlanTouchTrackerCollaborator {
  observeToolUse(agentId: string, event: ToolUseEvent): void;
}

// P2-03: 'waiting' is a trigger status so the supervisor gets a notification
// when an agent blocks on user input. The waiting → working transition (user
// answered the prompt) is filtered below as noise.
//
// 'done' is NOT a trigger status. A clean exit (code 0) is never the actionable
// signal — the turn-end `idle` event already carried the worker's hand-off, and
// the process exiting afterwards adds nothing a supervisor can act on. This
// previously suppressed only the (idle → done) transition, which still left
// working → done and every stop_agent teardown waking the owner for a
// non-event. A non-clean exit is 'crashed', which still delivers.
const TRIGGER_STATUSES: ReadonlyArray<AgentStatus> = ['idle', 'crashed', 'waiting'];

// BUG-20: the chat-first preview + file-activity sections only make sense
// for terminal statuses where the agent has just produced output. Skipped
// for 'waiting' (that branch has its own kind/excerpt rendering).
const TERMINAL_PREVIEW_STATUSES: ReadonlyArray<AgentStatus> = ['idle', 'done', 'crashed'];

// BUG-20: cap how many file_activities rows we hand to the payload builder.
// The builder applies its own visible cap (FILES_TOUCHED_MAX_ENTRIES); this
// is just so a hot worker that touched hundreds of files doesn't drag the
// whole list through the bridge for no reason.
const FILE_ACTIVITY_FETCH_CAP = 20;

/** Transient one-turn cross-agent event subscription. A privileged subscriber
 *  (supervisor / supervisor-lane persona) that sends a *submitted* message to
 *  another agent is auto-subscribed to ONE turn outcome: the next terminal
 *  flip (idle/done/crashed) — or a TTL backstop — consumes it. */
type TransientTurnSubscription = {
  targetAgentId: string;
  subscriberAgentId: string;
  state: 'pending-start' | 'armed';
  createdAt: number;
  expiresAt: number;            // createdAt + TRANSIENT_SUB_TTL_MS
  sawWaiting: boolean;
  ttlHandle: { cancel(): void };
  startWatchdog: { cancel(): void } | null;
};

export class EventBridge {
  private eventCooldowns = new Map<string, number>();
  private lastContextThreshold = new Map<string, number>();
  // Increment 0: queue + drain handle are now keyed by RECIPIENT id. Two
  // independently-busy recipients no longer collide on one queue/timer (a
  // latent cross-supervisor bug), and recipient-scoped state is the
  // precondition for the Increment 1 subscriber fan-out.
  private queuedEventsByRecipient = new Map<string, SupervisorEvent[]>();
  private drainHandlesByRecipient = new Map<string, { cancel(): void }>();
  // Increment 1: transient one-turn cross-agent subscriptions, keyed by target.
  private subscriptionsByTarget = new Map<string, TransientTurnSubscription[]>();

  constructor(private readonly deps: EventBridgeDeps) {}

  /**
   * SINGLE source of truth for "who receives this agent's lifecycle event".
   * Every owner-directed delivery site routes through here — NO divergent gates
   * (this codebase has been bitten by drifting predicates before).
   *
   * Resolves the recipient via `getOwnerForWorker` (explicit live owner →
   * terminal/missing-owner structural backstop → legacy supervised backstop →
   * null), then applies the notifyOwner mute:
   *
   *   The mute fires ONLY when the resolved recipient IS the agent's EXPLICIT
   *   owner (`recipient.id === agent.ownerAgentId`) AND `agent.notifyOwner ===
   *   false`. In that case the event is dropped (return null).
   *
   * Crucially, the mute does NOT fire on the structural backstop: if the owner
   * is terminal/missing and getOwnerForWorker falls back to the workspace
   * supervisor, that recipient is not the owner → not muted → the backstop still
   * delivers. So a muted agent whose owner dies still surfaces a crash to the
   * structural supervisor (safety net preserved).
   */
  private ownerRecipientComponent(agent: Agent): Agent | null {
    const recipient = this.deps.getOwnerForWorker(agent);
    if (!recipient) return null;
    if (agent.notifyOwner === false
        && agent.ownerAgentId
        && recipient.id === agent.ownerAgentId) {
      return null; // owned + muted + recipient is the explicit owner → drop
    }
    return recipient;
  }

  private eventIsSubscriberEligible(event: SupervisorEvent): boolean {
    if (event.type === 'worker_stalled') return true;
    if (event.type === 'status_change') {
      return event.toStatus === 'idle' || event.toStatus === 'done'
          || event.toStatus === 'crashed' || event.toStatus === 'waiting';
    }
    return false;
  }

  /** Live, eligible subscribers of `targetId` for `event`. armed-only; drops
   *  terminal/missing subscribers; caps `waiting` at one per subscription. */
  private liveSubscribersOf(targetId: string, event: SupervisorEvent): Agent[] {
    const list = this.subscriptionsByTarget.get(targetId) ?? [];
    const out: Agent[] = [];
    for (const s of list) {
      if (s.state !== 'armed') continue;
      if (event.type === 'status_change' && event.toStatus === 'waiting' && s.sawWaiting) continue;
      const a = this.deps.getAgent(s.subscriberAgentId);
      if (!a || ['done', 'crashed'].includes(a.status)) continue;
      out.push(a);
    }
    return out;
  }

  /** SINGLE source of truth for fan-out. Owner component (suppressed for
   *  supervisor targets — preserves the structural-noise drop) tagged
   *  viaSubscription:false; subscriber component tagged true. Deduped by id,
   *  owner wins. */
  private recipientsFor(agent: Agent, event: SupervisorEvent): Array<{ recipient: Agent; viaSubscription: boolean }> {
    const out: Array<{ recipient: Agent; viaSubscription: boolean }> = [];
    const owner = agent.isSupervisor ? null : this.ownerRecipientComponent(agent);
    // A terminal owner is normally dropped here (genuinely dead → no delivery).
    // BUG-41 exception: a 'done' owner whose continuation swap is mid-flight is
    // NOT dead — its PTY is being replaced under the same id. Admit it so
    // deliver()'s 'done'+swap branch can QUEUE the event (it would otherwise be
    // dropped before deliver() is ever reached). 'crashed' is still terminal.
    if (owner && (!['done', 'crashed'].includes(owner.status)
        || (owner.status === 'done' && this.deps.isContinuationSwapInFlight(owner.id)))) {
      out.push({ recipient: owner, viaSubscription: false });
    }
    if (this.eventIsSubscriberEligible(event)) {
      for (const s of this.liveSubscribersOf(agent.id, event)) {
        if (out.some(o => o.recipient.id === s.id)) continue; // owner dedup
        out.push({ recipient: s, viaSubscription: true });
      }
    }
    return out;
  }

  // ── Transient one-turn cross-agent subscription registry ──────────────
  // The privilege/owner-dedup/liveness predicate lives HERE — single source of
  // truth (api-server.ts does only body-derived gating). Both scheduled
  // callbacks are void-wrapped, and the async TTL handler catches internally,
  // so a scheduled callback can never produce an unhandled rejection.

  registerTransientTurnSubscription(input: {
    targetAgentId: string; subscriberAgentId: string; ttlMs?: number;
  }): { registered: boolean; reason?: string } {
    const { targetAgentId, subscriberAgentId } = input;
    if (subscriberAgentId === targetAgentId) return { registered: false, reason: 'self' };

    const target = this.deps.getAgent(targetAgentId);
    if (!target) return { registered: false, reason: 'target-missing' };

    const subscriber = this.deps.getAgent(subscriberAgentId);
    if (!subscriber || ['done', 'crashed'].includes(subscriber.status)) {
      return { registered: false, reason: 'subscriber-not-live' };
    }
    // Privilege gate — structurally forecloses "worker subscribes to the fleet".
    if (!hasSupervisorPrivilege(subscriber)) {
      return { registered: false, reason: 'not-privileged' };
    }
    // Owner dedup: a subscriber that is already the target's resolved recipient
    // gets the event the normal way — no subscription needed.
    const owner = this.ownerRecipientComponent(target);
    if (owner && owner.id === subscriberAgentId) return { registered: false, reason: 'is-owner' };

    const list = this.subscriptionsByTarget.get(targetAgentId) ?? [];
    const existing = list.find(s => s.subscriberAgentId === subscriberAgentId);
    const now = this.deps.now();
    const ttlMs = input.ttlMs ?? TRANSIENT_SUB_TTL_MS;
    const scheduleTtl = () => this.deps.scheduleDrain(
      ttlMs, () => { void this.onSubscriptionTtl(targetAgentId, subscriberAgentId); });
    const scheduleWatchdog = () => this.deps.scheduleDrain(
      TRANSIENT_SUB_PENDING_START_TIMEOUT_MS,
      () => { this.onSubscriptionStartWatchdog(targetAgentId, subscriberAgentId); });

    if (existing) {
      // REFRESH (never stack): reset to pending-start, reset both timers.
      existing.ttlHandle.cancel();
      existing.startWatchdog?.cancel();
      existing.state = 'pending-start';
      existing.createdAt = now;
      existing.expiresAt = now + ttlMs;
      existing.sawWaiting = false;
      existing.ttlHandle = scheduleTtl();
      existing.startWatchdog = scheduleWatchdog();
      return { registered: true };
    }
    if (list.length >= TRANSIENT_SUB_MAX_PER_TARGET) return { registered: false, reason: 'target-cap' };

    const sub: TransientTurnSubscription = {
      targetAgentId, subscriberAgentId, state: 'pending-start',
      createdAt: now, expiresAt: now + ttlMs, sawWaiting: false,
      ttlHandle: scheduleTtl(),
      startWatchdog: scheduleWatchdog(),
    };
    list.push(sub);
    this.subscriptionsByTarget.set(targetAgentId, list);
    return { registered: true };
  }

  cancelTransientTurnSubscriptionsForPair(targetAgentId: string, subscriberAgentId: string): void {
    this.removeSubscription(targetAgentId, subscriberAgentId);
  }

  private removeSubscription(targetAgentId: string, subscriberAgentId: string): void {
    const list = this.subscriptionsByTarget.get(targetAgentId);
    if (!list) return;
    const idx = list.findIndex(s => s.subscriberAgentId === subscriberAgentId);
    if (idx === -1) return;
    list[idx].ttlHandle.cancel();
    list[idx].startWatchdog?.cancel();
    list.splice(idx, 1);
    if (list.length === 0) this.subscriptionsByTarget.delete(targetAgentId);
  }

  private onSubscriptionStartWatchdog(targetAgentId: string, subscriberAgentId: string): void {
    const sub = this.subscriptionsByTarget.get(targetAgentId)?.find(s => s.subscriberAgentId === subscriberAgentId);
    if (!sub || sub.state !== 'pending-start') return;   // promoted already → no-op
    this.removeSubscription(targetAgentId, subscriberAgentId); // silent prune
  }

  private async onSubscriptionTtl(targetAgentId: string, subscriberAgentId: string): Promise<void> {
    try {
      const sub = this.subscriptionsByTarget.get(targetAgentId)?.find(s => s.subscriberAgentId === subscriberAgentId);
      if (!sub) return;
      const wasArmed = sub.state === 'armed';
      this.removeSubscription(targetAgentId, subscriberAgentId);
      if (!wasArmed) return; // pending-start at TTL (watchdog normally beat us) → silent
      const subscriber = this.deps.getAgent(subscriberAgentId);
      const target = this.deps.getAgent(targetAgentId);
      if (!subscriber || ['done', 'crashed'].includes(subscriber.status)) return;
      await this.deliver(subscriber, {
        type: 'transient_subscription_expired',
        agentId: targetAgentId,
        agentTitle: target?.title ?? targetAgentId,
        workspaceId: target?.workspaceId ?? subscriber.workspaceId,
      });
    } catch (err) {
      console.error('[event-bridge] Error delivering transient_subscription_expired:', err);
    }
  }

  /** Promote pending-start subscriptions for `targetId` to armed when the
   *  target begins a turn; the start-watchdog is no longer needed. */
  private promoteOnWorking(targetId: string): void {
    const list = this.subscriptionsByTarget.get(targetId);
    if (!list) return;
    for (const s of list) {
      if (s.state !== 'pending-start') continue;
      s.state = 'armed';
      s.startWatchdog?.cancel();
      s.startWatchdog = null;
    }
  }

  /** Post-delivery: terminal status consumes the subscription; first `waiting`
   *  sets the cap. Only subscribers that were actually in `recipients` (i.e.
   *  armed + delivered) are affected. */
  private applyConsumption(
    targetId: string,
    event: SupervisorEvent,
    recipients: Array<{ recipient: Agent; viaSubscription: boolean }>,
  ): void {
    if (event.type !== 'status_change') return;
    const subIds = new Set(recipients.filter(r => r.viaSubscription).map(r => r.recipient.id));
    if (subIds.size === 0) return;
    const consuming = event.toStatus === 'idle' || event.toStatus === 'done' || event.toStatus === 'crashed';
    const list = this.subscriptionsByTarget.get(targetId);
    if (!list) return;
    for (const sid of subIds) {
      const sub = list.find(s => s.subscriberAgentId === sid);
      if (!sub) continue;
      if (consuming) this.removeSubscription(targetId, sid);
      else if (event.toStatus === 'waiting') sub.sawWaiting = true;
    }
  }

  async onStatusChanged(data: StatusChangedEvent): Promise<void> {
    try {
      const agent = this.deps.getAgent(data.agentId);
      if (!agent) return;

      // Transient subscription: promote pending-start subscriptions the moment
      // the target begins a turn. Above the TRIGGER_STATUSES guard and all
      // status filtering so it also fires for supervisor targets. 'working' is
      // not a trigger status; nothing further to deliver.
      if (data.status === 'working') {
        this.promoteOnWorking(agent.id);
      }

      // 'done' is filtered by TRIGGER_STATUSES below, but the target's turn is
      // definitively over — consume any transient one-turn subscriptions here.
      // Otherwise they would sit until TTL and then fire a
      // `transient_subscription_expired` notice for an agent that simply exited
      // cleanly: exactly the noise that dropping the 'done' event removes.
      if (data.status === 'done') {
        for (const s of [...(this.subscriptionsByTarget.get(agent.id) ?? [])]) {
          this.removeSubscription(agent.id, s.subscriberAgentId);
        }
      }

      if (!TRIGGER_STATUSES.includes(data.status)) return;
      if (data.fromStatus !== undefined && data.fromStatus === data.status) return;

      // P2-03: a waiting → working transition (user just answered the prompt)
      // is not a notification-worthy event — the latch clears, no need to
      // wake the supervisor.
      if (data.fromStatus === 'waiting' && data.status === 'working') return;

      // launching → idle is launch-complete noise: the agent finished booting
      // and is simply ready for its first instruction — nothing happened that
      // a supervisor needs to react to. Suppress it. All other idle arrivals
      // (working → idle, waiting → idle, etc.) are real turn-end signals and
      // still deliver.
      if (data.fromStatus === 'launching' && data.status === 'idle') return;

      // (The former idle → done suppression is gone — 'done' is no longer a
      // trigger status at all, so every → done transition is filtered above.)

      // Crashes / completions bypass the per-agent 10s cooldown (D-06): a
      // runner exit isn't a flicker, and silently dropping the second of two
      // close-together exits would lose a real failure. All other sources
      // (monitor, launch, restart, etc.) still respect the cooldown.
      const lastEvent = this.eventCooldowns.get(data.agentId) || 0;
      if (data.source !== 'runner-exit'
          && this.deps.now() - lastEvent < SUPERVISOR_EVENT_COOLDOWN_MS) return;
      this.eventCooldowns.set(data.agentId, this.deps.now());

      const logTail = await this.deps.getAgentLog(data.agentId, SUPERVISOR_EVENT_LOG_TAIL_LINES);
      const stats = this.deps.getContextStats(data.agentId);

      // BUG-20: pre-fetch the clean assistant chat message + recent file
      // activities for terminal statuses so the payload builder can render
      // the real assistant prose (not Claude Code TUI footer chrome) and a
      // "Files touched:" section. Failures degrade to today's PTY-tail.
      let lastAssistantMessage: string | undefined;
      let filesTouched: FileActivity[] | undefined;
      if (TERMINAL_PREVIEW_STATUSES.includes(data.status)) {
        lastAssistantMessage = await this.fetchLastAssistantMessage(data.agentId);
        filesTouched = this.fetchFileActivities(data.agentId);
      }

      const event: SupervisorEvent = {
        type: 'status_change',
        agentId: agent.id,
        agentTitle: agent.title,
        workspaceId: agent.workspaceId,
        fromStatus: data.fromStatus ?? agent.status,
        toStatus: data.status,
        lastExitCode: agent.lastExitCode,
        contextPercentage: stats?.contextPercentage,
        contextWindowMax: stats?.contextWindowMax,
        totalContextTokens: stats?.totalContextTokens,
        turnCount: stats?.turnCount,
        model: stats?.model,
        logTail,
        lastAssistantMessage,
        filesTouched: filesTouched?.map(f => ({
          filePath: f.filePath,
          operation: f.operation,
        })),
        // P2-03: pass waiting metadata through to the payload builder when
        // present on the inbound event.
        waitingKind: data.waitingKind,
        waitingExcerpt: data.waitingExcerpt,
      };

      const recipients = this.recipientsFor(agent, event);
      for (const { recipient, viaSubscription } of recipients) {
        // Per-subscriber shallow clone keeps deliver/buildEventPayload
        // signatures stable while framing the subscriber's copy as a reply.
        await this.deliver(recipient, viaSubscription ? { ...event, viaSubscription: true } : event);
      }
      this.applyConsumption(agent.id, event, recipients);
    } catch (err) {
      console.error('[event-bridge] Error handling supervisor event:', err);
    }
  }

  /**
   * Pipeline B → status wiring. See plans/agent-lifecycle-hardening-plan.md
   * §2.1 for the dispatch table. Gemini agents skip the
   * `assistant-text + turnComplete: true → forceIdle` branch (D-07) because
   * `gemini-transcript-reader.ts:327` hardcodes `turnComplete: true` and the
   * transcript can later rewrite the same turn with tool calls. Other
   * branches (waiting detection, tool-use, etc.) apply to Gemini normally.
   *
   * Branch order intentionally checks `endsWithQuestion === true` BEFORE the
   * `turnComplete === true` branch so when P2-01 lands the routing flips to
   * `forceWaiting` without further dispatcher changes. Today the flag is
   * always undefined.
   */
  onChatEvents(batch: ChatEventBatch): void {
    try {
      // BUG-09 §3.8 — the dispatcher's first batch per agent is the on-disk
      // replay of pre-existing events. Pre-existing tool-use / turnComplete /
      // endsWithQuestion no longer reflect live state, so we must not call
      // force* on them. The PTY signal carries the agent's true status
      // through the brief window between dispatcher attach and the first
      // live event.
      if (batch.initialLoad === true) return;
      for (const event of batch.events) {
        const agentId = event.agentId;
        const agent = this.deps.getAgent(agentId);
        if (!agent) continue;

        // Hook-backed lanes — claude/codex workers (supervised OR plain),
        // researchers, and the supervisor — derive working/idle/waiting SOLELY
        // from their hook pipeline (UserPromptSubmit→working, Stop→idle,
        // Notification→waiting via applyHookStatusEvent). The chat-stream must
        // not write status for them: it raced the hooks (masking hook firing)
        // and, via `endsWithQuestion`, manufactured a `waiting` state with no
        // real TUI prompt behind it. `waiting` now means exactly one thing — a
        // Notification hook fired (a prompt the human must key through) — so
        // ending a turn with a question is just a normal turn end (→ idle via
        // the Stop hook). Skip the entire status switch for these lanes.
        //
        // Gemini has no hook scaffold, so it falls through to the chat-stream
        // below as its only working/idle signal (it never reaches `waiting`).
        if ((agent.isSupervised || agent.isWorker || agent.isSupervisor || agent.isResearcher)
            && agent.provider !== 'gemini') {
          continue;
        }

        switch (event.type) {
          case 'assistant-text': {
            // Hookless providers (gemini) only. A turn that ends with a question
            // is a normal turn end (→ idle); `waiting` is reserved for a real
            // Notification hook, which gemini does not emit.
            if (event.turnComplete === true) {
              // BUG-09 §3.9 — D-07 gate removed. The Gemini reader now
              // computes turnComplete from `allToolsResolved && usageLanded`
              // and emits an assistant-text-patch when the turn later
              // becomes complete, so we can route Gemini through forceIdle
              // on the same path as Claude/Codex.
              this.deps.statusMonitor.forceIdle(agentId, 'turnComplete');
            } else {
              // BUG-09 §3.3 / C11 — any non-terminal assistant-text refreshes
              // the working latch, not just `stopReason === 'tool_use'`. Closes
              // the Codex hole and anticipates streamed assistant emissions.
              // BUG-18 Change 3 — mark the turn as in-flight so a subsequent
              // `tool_result → next-assistant thinking gap` cannot collapse
              // the latch's effective TTL down to model-pending.
              this.deps.statusMonitor.forceWorking(agentId, {
                source: 'assistant-text',
                ttlClass: 'model-pending',
                turnInFlight: true,
              });
            }
            break;
          }
          case 'assistant-text-patch': {
            // Hookless providers (gemini) only — see assistant-text. No
            // endsWithQuestion → waiting; turn completion routes to idle.
            if (event.turnComplete === true) {
              // BUG-09 §3.9 — D-07 gate removed (see assistant-text branch).
              this.deps.statusMonitor.forceIdle(agentId, 'turnComplete');
            }
            break;
          }
          case 'thinking':
            // BUG-09 §3.3 / C11 — thinking blocks are high-cadence positive
            // evidence that the model is still running. The previous "not
            // status-bearing" comment was correct for the binary latch but
            // stops being correct once `working` is latchable.
            // BUG-18 Change 1 — promote from `model-pending` (180 s) to
            // `thinking-pending` (900 s). Claude's xhigh extended-thinking
            // empirically gaps to 311 s before the next event in this
            // workspace; the new ceiling covers that comfortably.
            this.deps.statusMonitor.forceWorking(agentId, {
              source: 'thinking',
              ttlClass: 'thinking-pending',
            });
            break;
          case 'tool-use':
            // WP2 provenance spine (R2 §2.3) — capture read=intent + native
            // edit-target breadcrumbs BEFORE the status latch. The transcript
            // carries the tool name + args for both providers; native Edit never
            // hits the MCP handler, so this is the ONLY capture path for edit
            // targets. Tolerant by contract (never throws), so no guard here.
            this.deps.planTouchTracker?.observeToolUse(agentId, event as ToolUseEvent);
            // BUG-18 Change 3 — mark the turn as in-flight; the latch keeps
            // tool-pending TTL even after this tool resolves until either
            // (a) the next refresh stores a longer ttlClass, or (b)
            // `forceIdle('turnComplete')` overwrites the latch.
            this.deps.statusMonitor.forceWorking(agentId, {
              source: 'tool-use',
              toolUseId: event.toolUseId,
              ttlClass: 'tool-pending',
              turnInFlight: true,
            });
            break;
          case 'tool-result':
            this.deps.statusMonitor.forceWorking(agentId, {
              source: 'tool-result',
              resolvedToolUseId: event.toolUseId,
              ttlClass: 'tool-pending',
            });
            break;
          case 'user-text':
            this.deps.statusMonitor.forceWorking(agentId, {
              source: 'user-turn',
              ttlClass: 'model-pending',
            });
            break;
          case 'task-started':
            // BUG-18 Change 3 — see tool-use comment. task-started is the
            // earliest positive signal a Codex turn has begun; without
            // marking it in-flight, the first model-pending refresh that
            // lands afterwards would collapse the TTL ceiling.
            this.deps.statusMonitor.forceWorking(agentId, {
              source: 'task-started',
              ttlClass: 'model-pending',
              turnInFlight: true,
            });
            break;
          // usage, system-init: not status-bearing.
        }
      }
    } catch (err) {
      console.error('[event-bridge] Error in onChatEvents:', err);
    }
  }

  /**
   * BUG-22 Step 1 diagnostic: invoked from the WslRunner `tmuxNewSessionFailed`
   * event path so the supervisor learns about the failure as a distinct event,
   * separate from the generic `Agent status changed` crash that follows when
   * `tmux attach` reports `can't find session`. Keeps the agent-side audit log
   * intact via `addAuditEvent('supervisor_event', ...)`.
   *
   * Does not fake a worker status change — there's no transition to emit; the
   * worker is still in `launching`. The event-bridge `deliver()` path is
   * reused so the same queue / drain / user-typing guarantees apply.
   */
  async onTmuxNewSessionFailed(input: {
    agent: Agent;
    tmuxSessionName: string;
    command: string;
    tmuxExitCode: number | null;
    tmuxStderr: string;
    tmuxCommand: string;
  }): Promise<void> {
    try {
      const { agent } = input;

      const event: SupervisorEvent = {
        type: 'tmux_new_session_failed',
        agentId: agent.id,
        agentTitle: agent.title,
        workspaceId: agent.workspaceId,
        tmuxSessionName: input.tmuxSessionName,
        command: input.command,
        tmuxExitCode: input.tmuxExitCode,
        tmuxStderr: input.tmuxStderr,
        tmuxCommand: input.tmuxCommand,
      };

      // Owner-only event (subscriber-ineligible). For a supervisor target the
      // owner component is suppressed → recipientsFor yields [] → clean no-op,
      // matching the prior `if (agent.isSupervisor) return;` short-circuit.
      const recipients = this.recipientsFor(agent, event);
      for (const { recipient, viaSubscription } of recipients) {
        await this.deliver(recipient, viaSubscription ? { ...event, viaSubscription: true } : event);
      }
    } catch (err) {
      console.error('[event-bridge] Error handling tmux_new_session_failed:', err);
    }
  }

  /**
   * Handoff handshake — the synchronous confirm-and-retry in `_doSendInput`
   * exhausted its re-press attempts without observing a UserPromptSubmit
   * hook: the prompt was typed into the worker's PTY but the turn never
   * started. Without this event a fire-and-forget caller (UI chat bar,
   * background queue, orchestration scripts POSTing /input) leaves the
   * supervisor waiting forever for a Stop-hook idle event that can never
   * come. Reuses the standard deliver() queue/drain path.
   */
  async onHandoffFailed(input: {
    agent: Agent;
    attempts: number;
    message: string;
  }): Promise<void> {
    try {
      const { agent } = input;

      const logTail = await this.deps.getAgentLog(agent.id, SUPERVISOR_EVENT_LOG_TAIL_LINES);
      const event: SupervisorEvent = {
        type: 'handoff_failed',
        agentId: agent.id,
        agentTitle: agent.title,
        workspaceId: agent.workspaceId,
        handoffAttempts: input.attempts,
        failureMessage: input.message,
        logTail,
      };

      // Owner-only event (subscriber-ineligible); supervisor target → [].
      const recipients = this.recipientsFor(agent, event);
      for (const { recipient, viaSubscription } of recipients) {
        await this.deliver(recipient, viaSubscription ? { ...event, viaSubscription: true } : event);
      }
    } catch (err) {
      console.error('[event-bridge] Error handling handoff_failed:', err);
    }
  }

  /**
   * Stalled-worker watchdog (StatusMonitor.checkWorkerStalled) — a
   * supervised worker has been `working` with zero signal (no raw PTY
   * output, no hook event, no fresh input) for WORKER_STALL_WARN_MS. This is
   * the supervisor's "this is taking forever" sense: a worker that never
   * finishes emits no Stop hook and therefore no status event, ever.
   * One-shot per working stretch (the monitor dedupes).
   */
  async onWorkerStalled(input: {
    agent: Agent;
    stalledForMs: number;
  }): Promise<void> {
    try {
      const { agent } = input;

      const logTail = await this.deps.getAgentLog(agent.id, SUPERVISOR_EVENT_LOG_TAIL_LINES);
      const event: SupervisorEvent = {
        type: 'worker_stalled',
        agentId: agent.id,
        agentTitle: agent.title,
        workspaceId: agent.workspaceId,
        stalledForMs: input.stalledForMs,
        logTail,
      };

      // worker_stalled is subscriber-eligible (non-consuming) — fan out to the
      // owner AND any armed subscribers; supervisor target → subscribers only.
      const recipients = this.recipientsFor(agent, event);
      for (const { recipient, viaSubscription } of recipients) {
        await this.deliver(recipient, viaSubscription ? { ...event, viaSubscription: true } : event);
      }
    } catch (err) {
      console.error('[event-bridge] Error handling worker_stalled:', err);
    }
  }

  onContextStatsChanged(stats: ContextStats): void {
    try {
      const agent = this.deps.getAgent(stats.agentId);
      // KEEP the supervisor early-drop: context_threshold is subscriber-
      // ineligible, so removing it would gain nothing — but it would let the
      // lastContextThreshold mutation below run for supervisor targets, which
      // is real state corruption. The delivery tail still routes through the
      // predicate (yields the owner only, since the event is ineligible).
      if (!agent || agent.isSupervisor) return;

      const crossed = SUPERVISOR_CONTEXT_THRESHOLDS.filter(t => stats.contextPercentage >= t);
      if (crossed.length === 0) return;
      const threshold = Math.max(...crossed);

      const lastThreshold = this.lastContextThreshold.get(stats.agentId) || 0;
      if (threshold <= lastThreshold) return;
      this.lastContextThreshold.set(stats.agentId, threshold);

      const event: SupervisorEvent = {
        type: 'context_threshold',
        agentId: agent.id,
        agentTitle: agent.title,
        workspaceId: agent.workspaceId,
        contextPercentage: stats.contextPercentage,
        contextWindowMax: stats.contextWindowMax,
        totalContextTokens: stats.totalContextTokens,
        turnCount: stats.turnCount,
        model: stats.model,
      };

      for (const { recipient } of this.recipientsFor(agent, event)) {
        void this.deliver(recipient, event);
      }
    } catch (err) {
      console.error('[event-bridge] Error checking context threshold:', err);
    }
  }

  // `supervisor` here is the resolved recipient (owner or structural fallback),
  // not necessarily the structural supervisor — kept as the param name for a
  // no-semantic-change diff. Busy/launching/attached/typing recipients QUEUE +
  // drain (never fall back); only missing/terminal recipients were filtered out
  // upstream by getOwnerForWorker + the per-handler liveness gate.
  private async deliver(supervisor: Agent, event: SupervisorEvent): Promise<void> {
    const fresh = this.deps.getAgent(supervisor.id);
    if (!fresh) return;

    // BUG-41: 'restarting' is the continuation-swap PTY-replacement window —
    // busy, not terminal. Queue + drain exactly like working/launching so the
    // batch survives to the fresh session; NEVER drop it into the line-below
    // drop, and never flush into the not-yet-spawned PTY.
    if (fresh.status === 'working' || fresh.status === 'launching' || fresh.status === 'restarting') {
      this.queueEvent(supervisor.id, event);
      this.armDrain(supervisor.id);
      console.log(`[event-bridge] Queued event (supervisor ${fresh.status}): ${event.type} for "${event.agentTitle}"`);
      return;
    }

    // BUG-41: the sub-second 'done' window mid-continuation-swap, between
    // `stopAgent` and the 'restarting' status flip. Only when a swap is in
    // flight for THIS recipient do we treat 'done' as a queue-status — the PTY
    // is about to be replaced under the same id, so the event must survive. A
    // genuinely-stopped 'done' (no swap in flight) falls through to the drop.
    if (fresh.status === 'done' && this.deps.isContinuationSwapInFlight(fresh.id)) {
      this.queueEvent(supervisor.id, event);
      this.armDrain(supervisor.id);
      console.log(`[event-bridge] Queued event (recipient done, continuation swap in flight): ${event.type} for "${event.agentTitle}"`);
      return;
    }

    if (fresh.status === 'idle' || fresh.status === 'waiting') {
      if (fresh.isAttached) {
        this.queueEvent(supervisor.id, event);
        this.armDrain(supervisor.id);
        console.log(`[event-bridge] Queued event (supervisor attached/user viewing): ${event.type} for "${event.agentTitle}"`);
        return;
      }

      // BUG-11: defer auto-submit while the user is actively typing into the
      // supervisor's PTY (any byte through `writeToAgent` in the last
      // SUPERVISOR_USER_TYPING_QUIESCENT_MS). The 'isAttached' branch above
      // is insufficient: it tracks renderer-mounted state, not keystrokes,
      // so an external tmux client or a freshly-detached terminal would slip
      // through. Composes with drain (which also re-checks this) — events
      // queue until the user is quiet, then flush via the normal drain path.
      if (this.isUserTyping(fresh.id)) {
        this.queueEvent(supervisor.id, event);
        this.armDrain(supervisor.id);
        console.log(`[event-bridge] Queued event (user typing): ${event.type} for "${event.agentTitle}"`);
        return;
      }

      const payload = buildEventPayload(event);
      await this.deps.sendInput(fresh.id, payload);
      this.deps.addAuditEvent(
        fresh.id,
        'supervisor_event',
        JSON.stringify({ type: event.type, agentId: event.agentId, agentTitle: event.agentTitle }),
      );
      console.log(`[event-bridge] Sent event to supervisor: ${event.type} for "${event.agentTitle}"`);
      return;
    }

    console.log(`[event-bridge] Dropped event (supervisor ${fresh.status}): ${event.type} for "${event.agentTitle}"`);
  }

  /** BUG-11: true iff the user wrote to this agent's PTY in the last
   *  SUPERVISOR_USER_TYPING_QUIESCENT_MS milliseconds. */
  private isUserTyping(agentId: string): boolean {
    const last = this.deps.getLastUserPtyWriteAt(agentId);
    if (last === undefined) return false;
    return this.deps.now() - last < SUPERVISOR_USER_TYPING_QUIESCENT_MS;
  }

  private queueEvent(recipientId: string, event: SupervisorEvent): void {
    const q = this.queuedEventsByRecipient.get(recipientId) ?? [];
    q.push(event);
    if (q.length > SUPERVISOR_EVENT_QUEUE_MAX) q.shift();
    this.queuedEventsByRecipient.set(recipientId, q);
  }

  /** BUG-41: re-queue a batch that failed to send at the FRONT of the
   *  recipient's queue — ahead of anything that arrived during the send await —
   *  preserving order and respecting SUPERVISOR_EVENT_QUEUE_MAX (drop oldest on
   *  overflow, the same policy as `queueEvent`). Used by `drain()` so a
   *  throwing/no-op `sendInput` never silently loses the batch. */
  private requeueFront(recipientId: string, events: SupervisorEvent[]): void {
    const q = this.queuedEventsByRecipient.get(recipientId) ?? [];
    const merged = [...events, ...q];
    while (merged.length > SUPERVISOR_EVENT_QUEUE_MAX) merged.shift();
    this.queuedEventsByRecipient.set(recipientId, merged);
  }

  private armDrain(recipientId: string): void {
    if (this.drainHandlesByRecipient.has(recipientId)) return;
    const handle = this.deps.scheduleDrain(
      SUPERVISOR_EVENT_DRAIN_INTERVAL_MS,
      () => { void this.drain(recipientId); },
    );
    this.drainHandlesByRecipient.set(recipientId, handle);
  }

  private async drain(recipientId: string): Promise<void> {
    // delete-at-top + armDrain re-add keeps the "one live handle per
    // recipient" invariant — equivalent to HEAD's null-then-rearm.
    this.drainHandlesByRecipient.delete(recipientId);

    const supervisor = this.deps.getAgent(recipientId);
    if (!supervisor || ['done', 'crashed'].includes(supervisor.status)) {
      // BUG-41: a 'done' recipient mid-continuation-swap is NOT terminal — the
      // PTY is about to be replaced under the same id. Re-arm and KEEP the
      // queue so it drains to the fresh session; do NOT purge. A genuinely-
      // stopped 'done' (no swap in flight), a 'crashed', or a missing agent
      // still purges as before. The launch tail clears the predicate in its
      // finally (success AND failure), so this re-arm loop always terminates.
      if (supervisor && supervisor.status === 'done'
          && this.deps.isContinuationSwapInFlight(recipientId)) {
        this.armDrain(recipientId);
        return;
      }
      this.queuedEventsByRecipient.delete(recipientId);
      return;
    }

    // BUG-41: 'restarting' is the continuation-swap PTY-replacement window —
    // busy, not terminal. Re-arm and keep the queue (never flush into a
    // possibly-absent PTY, never purge). Mirrors deliver()'s restarting branch.
    if (supervisor.status === 'working' || supervisor.status === 'launching'
        || supervisor.status === 'restarting') {
      this.armDrain(recipientId);
      return;
    }

    // BUG-11: re-check user-typing activity on drain, same as deliver().
    // Without this, a drain timer that fires while the user is still typing
    // would ship the queue into the active prompt buffer — the exact bug.
    if (this.isUserTyping(recipientId)) {
      this.armDrain(recipientId);
      return;
    }

    const events = this.queuedEventsByRecipient.get(recipientId) ?? [];
    if (events.length === 0) return;

    // BUG-41: delete-AFTER-send. Remove the batch, attempt the send, and on
    // throw re-queue it at the FRONT (ahead of anything that arrived during the
    // await) capped at SUPERVISOR_EVENT_QUEUE_MAX, then re-arm. Net effect:
    // events leave the queue only once `sendInput` resolves successfully, so a
    // write that no-ops/throws into an absent PTY never loses the batch.
    this.queuedEventsByRecipient.delete(recipientId);
    const payload = buildConsolidatedPayload(events);
    try {
      await this.deps.sendInput(supervisor.id, payload);
    } catch (err) {
      this.requeueFront(recipientId, events);
      this.armDrain(recipientId);
      console.error(`[event-bridge] drain sendInput failed for ${recipientId}; re-queued ${events.length} event(s):`, err);
      return;
    }
    this.deps.addAuditEvent(
      supervisor.id,
      'supervisor_event_batch',
      JSON.stringify({ count: events.length }),
    );
    console.log(`[event-bridge] Drained ${events.length} queued events to ${supervisor.id}`);
  }

  /** Lifecycle hook called by `AgentSupervisor.deleteAgent`. Mirrors the
   *  HEAD cleanup at index.ts:1625-1627: drop the agent's cooldown +
   *  threshold entries, and prune queued events for that worker. The drain
   *  timer is supervisor-scoped, not worker-scoped, and is intentionally
   *  left running here — same as HEAD. */
  forgetAgent(agentId: string): void {
    this.eventCooldowns.delete(agentId);
    this.lastContextThreshold.delete(agentId);
    // drop agentId as a RECIPIENT (its own queue + drain handle)
    this.queuedEventsByRecipient.delete(agentId);
    this.drainHandlesByRecipient.get(agentId)?.cancel();
    this.drainHandlesByRecipient.delete(agentId);
    // strip events ABOUT agentId from every other recipient's queue
    for (const [rid, q] of this.queuedEventsByRecipient) {
      const filtered = q.filter(e => e.agentId !== agentId);
      if (filtered.length === 0) this.queuedEventsByRecipient.delete(rid);
      else this.queuedEventsByRecipient.set(rid, filtered);
    }
    // Increment 1: drop subscriptions where the forgotten agent is the TARGET…
    const asTarget = this.subscriptionsByTarget.get(agentId);
    if (asTarget) {
      for (const s of asTarget) { s.ttlHandle.cancel(); s.startWatchdog?.cancel(); }
      this.subscriptionsByTarget.delete(agentId);
    }
    // …or the SUBSCRIBER (scan every target list).
    for (const [tid, list] of this.subscriptionsByTarget) {
      const keep = list.filter(s => {
        if (s.subscriberAgentId !== agentId) return true;
        s.ttlHandle.cancel(); s.startWatchdog?.cancel(); return false;
      });
      if (keep.length === 0) this.subscriptionsByTarget.delete(tid);
      else this.subscriptionsByTarget.set(tid, keep);
    }
  }

  /** P2-03: called from `AgentSupervisor.sendInput` after a send resolves.
   *  If the target agent was waiting on user input, clear the latch via
   *  `forceWorking` so the status field flips back to 'working' immediately
   *  (the `waiting → working` transition itself is filtered by the bridge so
   *  the supervisor doesn't get a noise event). Safe to call on any agent —
   *  no-op for agents that aren't currently waiting. */
  notifyUserInputDelivered(agentId: string): void {
    const agent = this.deps.getAgent(agentId);
    if (!agent || agent.status !== 'waiting') return;
    // Paste-race fix: worker agents' idle→working transition is owned
    // exclusively by the UserPromptSubmit hook. Optimistic seeds here (which
    // fire on every PTY write, including pastes that were never submitted)
    // would re-introduce the false-working bug the hook scaffold exists to
    // close. The brief flicker between input send and hook arrival (50ms–3s)
    // is intentional and truthful. Applies to supervised and plain workers.
    if (agent.isSupervised || agent.isWorker) return;
    this.deps.statusMonitor.forceWorking(agentId, {
      source: 'user-input',
      ttlClass: 'model-pending',
    });
  }

  /** BUG-20: safe wrapper around the chat dep. Errors degrade to undefined
   *  so the payload builder falls back to the PTY-frame tail. */
  private async fetchLastAssistantMessage(agentId: string): Promise<string | undefined> {
    try {
      const text = await this.deps.getLastAssistantMessage(agentId);
      if (!text || !text.trim()) return undefined;
      return text;
    } catch (err) {
      console.error('[event-bridge] getLastAssistantMessage failed; falling back to logTail:', err);
      return undefined;
    }
  }

  /** BUG-20: safe wrapper around the file-activities dep. Errors degrade to
   *  undefined so the "Files touched:" section is omitted. */
  private fetchFileActivities(agentId: string): FileActivity[] | undefined {
    try {
      const all = this.deps.getFileActivities(agentId);
      if (!all || all.length === 0) return undefined;
      return all.slice(0, FILE_ACTIVITY_FETCH_CAP);
    } catch (err) {
      console.error('[event-bridge] getFileActivities failed; omitting Files touched:', err);
      return undefined;
    }
  }

  /** Test seam: cancel any pending drain timer and run the drain logic now. */
  async drainPendingFor(recipientId: string): Promise<void> {
    this.drainHandlesByRecipient.get(recipientId)?.cancel();
    this.drainHandlesByRecipient.delete(recipientId);
    await this.drain(recipientId);
  }

  /** Test seam: read-only view of the queued events. With a recipientId,
   *  returns just that recipient's queue; without, the flattened union of
   *  every recipient's queue (back-compat default). */
  getQueueSnapshot(recipientId?: string): SupervisorEvent[] {
    if (recipientId !== undefined) return [...(this.queuedEventsByRecipient.get(recipientId) ?? [])];
    return [...this.queuedEventsByRecipient.values()].flat();
  }
}
