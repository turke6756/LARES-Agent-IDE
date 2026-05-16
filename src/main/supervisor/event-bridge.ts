import type { Agent, AgentStatus, ContextStats } from '../../shared/types';
import type { ChatEventBatch } from '../../shared/session-events';
import type { StatusChangedEvent } from './status-events';
import type { WaitingKind } from './status-monitor';
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
} from '../../shared/constants';

/** Subset of StatusMonitor's public surface that the bridge needs to drive
 *  Pipeline B → status wiring. Injected so tests can stub it. */
export interface StatusMonitorForceCollaborator {
  forceIdle(agentId: string, source: string): void;
  forceWaiting(agentId: string, kind: WaitingKind, excerpt: string): void;
  forceWorking(agentId: string, source: string): void;
}

export interface EventBridgeDeps {
  getAgent(id: string): Agent | null;
  /** Resolve the supervisor that should receive `worker`'s events.
   *  Today this wraps `getSupervisorAgent(worker.workspaceId)`; the
   *  multi-supervisor migration swaps it to `worker.supervisorId`. */
  getSupervisorForWorker(worker: Agent): Agent | null;
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
}

// P2-03: 'waiting' is a trigger status so the supervisor gets a notification
// when an agent blocks on user input. The waiting → working transition (user
// answered the prompt) is filtered below as noise.
const TRIGGER_STATUSES: ReadonlyArray<AgentStatus> = ['idle', 'crashed', 'done', 'waiting'];

export class EventBridge {
  private eventCooldowns = new Map<string, number>();
  private supervisorQueuedEvents: SupervisorEvent[] = [];
  private lastContextThreshold = new Map<string, number>();
  private drainHandle: { cancel(): void } | null = null;

  constructor(private readonly deps: EventBridgeDeps) {}

  async onStatusChanged(data: StatusChangedEvent): Promise<void> {
    try {
      const agent = this.deps.getAgent(data.agentId);
      if (!agent || agent.isSupervisor || !agent.isSupervised) return;

      if (!TRIGGER_STATUSES.includes(data.status)) return;
      if (data.fromStatus !== undefined && data.fromStatus === data.status) return;

      // P2-03: a waiting → working transition (user just answered the prompt)
      // is not a notification-worthy event — the latch clears, no need to
      // wake the supervisor.
      if (data.fromStatus === 'waiting' && data.status === 'working') return;

      const supervisor = this.deps.getSupervisorForWorker(agent);
      if (!supervisor || ['done', 'crashed'].includes(supervisor.status)) return;

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
        // P2-03: pass waiting metadata through to the payload builder when
        // present on the inbound event.
        waitingKind: data.waitingKind,
        waitingExcerpt: data.waitingExcerpt,
      };

      await this.deliver(supervisor, event);
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
      for (const event of batch.events) {
        const agentId = event.agentId;
        const agent = this.deps.getAgent(agentId);
        if (!agent) continue;

        switch (event.type) {
          case 'assistant-text': {
            if (event.endsWithQuestion === true) {
              const excerpt = event.text.slice(-300);
              this.deps.statusMonitor.forceWaiting(agentId, 'question', excerpt);
            } else if (event.turnComplete === true) {
              if (agent.provider === 'gemini') break; // D-07 — Gemini opt-out
              this.deps.statusMonitor.forceIdle(agentId, 'turnComplete');
            } else if (event.stopReason === 'tool_use') {
              this.deps.statusMonitor.forceWorking(agentId, 'turnContinues');
            }
            break;
          }
          case 'assistant-text-patch': {
            if (event.endsWithQuestion === true) {
              // P2-03: the patch event carries the flag but not the text body —
              // the body lives on the mutated ring entry the dispatcher already
              // updated in place. The supervisor still gets "Agent waiting for
              // input" plus log tail; the excerpt slot is left empty here since
              // pulling the text would require another reach into the chat
              // service. Acceptable tradeoff for the split-batch corner case.
              this.deps.statusMonitor.forceWaiting(agentId, 'question', '');
            } else if (event.turnComplete === true) {
              if (agent.provider === 'gemini') break;
              this.deps.statusMonitor.forceIdle(agentId, 'turnComplete');
            }
            break;
          }
          case 'tool-use':
            this.deps.statusMonitor.forceWorking(agentId, 'tool-use');
            break;
          case 'tool-result':
            this.deps.statusMonitor.forceWorking(agentId, 'tool-result');
            break;
          case 'user-text':
            this.deps.statusMonitor.forceWorking(agentId, 'user-turn');
            break;
          case 'task-started':
            this.deps.statusMonitor.forceWorking(agentId, 'task-started');
            break;
          // thinking, usage, system-init: not status-bearing.
        }
      }
    } catch (err) {
      console.error('[event-bridge] Error in onChatEvents:', err);
    }
  }

  onContextStatsChanged(stats: ContextStats): void {
    try {
      const agent = this.deps.getAgent(stats.agentId);
      if (!agent || agent.isSupervisor || !agent.isSupervised) return;

      const crossed = SUPERVISOR_CONTEXT_THRESHOLDS.filter(t => stats.contextPercentage >= t);
      if (crossed.length === 0) return;
      const threshold = Math.max(...crossed);

      const lastThreshold = this.lastContextThreshold.get(stats.agentId) || 0;
      if (threshold <= lastThreshold) return;
      this.lastContextThreshold.set(stats.agentId, threshold);

      const supervisor = this.deps.getSupervisorForWorker(agent);
      if (!supervisor || ['done', 'crashed'].includes(supervisor.status)) return;

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

      void this.deliver(supervisor, event);
    } catch (err) {
      console.error('[event-bridge] Error checking context threshold:', err);
    }
  }

  private async deliver(supervisor: Agent, event: SupervisorEvent): Promise<void> {
    const fresh = this.deps.getAgent(supervisor.id);
    if (!fresh) return;

    if (fresh.status === 'working' || fresh.status === 'launching') {
      this.queueEvent(event);
      this.armDrain(supervisor.id);
      console.log(`[event-bridge] Queued event (supervisor busy): ${event.type} for "${event.agentTitle}"`);
      return;
    }

    if (fresh.status === 'idle' || fresh.status === 'waiting') {
      if (fresh.isAttached) {
        this.queueEvent(event);
        this.armDrain(supervisor.id);
        console.log(`[event-bridge] Queued event (supervisor attached/user viewing): ${event.type} for "${event.agentTitle}"`);
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

  private queueEvent(event: SupervisorEvent): void {
    this.supervisorQueuedEvents.push(event);
    if (this.supervisorQueuedEvents.length > SUPERVISOR_EVENT_QUEUE_MAX) {
      this.supervisorQueuedEvents.shift();
    }
  }

  private armDrain(supervisorId: string): void {
    if (this.drainHandle) return;
    this.drainHandle = this.deps.scheduleDrain(
      SUPERVISOR_EVENT_DRAIN_INTERVAL_MS,
      () => { void this.drain(supervisorId); },
    );
  }

  private async drain(supervisorId: string): Promise<void> {
    this.drainHandle = null;

    const supervisor = this.deps.getAgent(supervisorId);
    if (!supervisor || ['done', 'crashed'].includes(supervisor.status)) {
      this.supervisorQueuedEvents = [];
      return;
    }

    if (supervisor.status === 'working' || supervisor.status === 'launching') {
      this.armDrain(supervisorId);
      return;
    }

    if (this.supervisorQueuedEvents.length === 0) return;

    const events = [...this.supervisorQueuedEvents];
    this.supervisorQueuedEvents = [];

    const payload = buildConsolidatedPayload(events);
    await this.deps.sendInput(supervisor.id, payload);
    this.deps.addAuditEvent(
      supervisor.id,
      'supervisor_event_batch',
      JSON.stringify({ count: events.length }),
    );
    console.log(`[event-bridge] Drained ${events.length} queued events to supervisor`);
  }

  /** Lifecycle hook called by `AgentSupervisor.deleteAgent`. Mirrors the
   *  HEAD cleanup at index.ts:1625-1627: drop the agent's cooldown +
   *  threshold entries, and prune queued events for that worker. The drain
   *  timer is supervisor-scoped, not worker-scoped, and is intentionally
   *  left running here — same as HEAD. */
  forgetAgent(agentId: string): void {
    this.eventCooldowns.delete(agentId);
    this.lastContextThreshold.delete(agentId);
    this.supervisorQueuedEvents = this.supervisorQueuedEvents.filter(e => e.agentId !== agentId);
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
    this.deps.statusMonitor.forceWorking(agentId, 'user-input');
  }

  /** Test seam: cancel any pending drain timer and run the drain logic now. */
  async drainPendingFor(supervisorId: string): Promise<void> {
    if (this.drainHandle) {
      this.drainHandle.cancel();
      this.drainHandle = null;
    }
    await this.drain(supervisorId);
  }

  /** Test seam: read-only view of the queued events. */
  getQueueSnapshot(): SupervisorEvent[] {
    return [...this.supervisorQueuedEvents];
  }
}
