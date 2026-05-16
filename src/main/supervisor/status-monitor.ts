import { EventEmitter } from 'events';
import { Agent, AgentStatus } from '../../shared/types';
import {
  STATUS_POLL_INTERVAL_MS,
  WORKING_THRESHOLD_MS,
  IDLE_LATCH_TIMEOUT_MS,
  WAITING_LATCH_TIMEOUT_MS,
} from '../../shared/constants';
import { getActiveAgents, updateAgentStatus, addEvent } from '../database';
import type { StatusChangedEvent } from './status-events';

export type WaitingKind = 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern';

interface TurnLatchEntry {
  state: 'idle' | 'waiting';
  setAt: number;
  waitingKind?: WaitingKind;
  waitingExcerpt?: string;
}

const TERMINAL_STATUSES: ReadonlyArray<AgentStatus> = ['crashed', 'done'];
const TRANSITIONAL_STATUSES: ReadonlyArray<AgentStatus> = ['launching', 'restarting'];

export class StatusMonitor extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private checkAlive: (agent: Agent) => Promise<boolean>;
  private getLastOutput: (agentId: string) => number;
  private getAgentFn: (id: string) => Agent | null;
  // Hold a status for a short period after a transition to prevent PTY
  // byte-flicker from immediately undoing it.
  private statusHoldUntil = new Map<string, number>();
  // Per-agent latch driven by Pipeline B (chat-stream `turnComplete` / waiting
  // signals). While set, `inferStatus` returns the latched state regardless
  // of PTY activity. See plans/agent-lifecycle-hardening-plan.md §2.1.1.
  private turnLatch = new Map<string, TurnLatchEntry>();
  private now: () => number;

  constructor(
    checkAlive: (agent: Agent) => Promise<boolean>,
    getLastOutput: (agentId: string) => number,
    getAgentFn: (id: string) => Agent | null,
    now: () => number = () => Date.now()
  ) {
    super();
    this.checkAlive = checkAlive;
    this.getLastOutput = getLastOutput;
    this.getAgentFn = getAgentFn;
    this.now = now;
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

  /** Pipeline B has high-confidence end-of-turn truth. Bypasses
   *  `statusHoldUntil` (the hold exists to dampen PTY flicker, which the chat
   *  stream isn't subject to). No-ops on terminal/transitional states. */
  forceIdle(agentId: string, source: string): void {
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    const prior = agent.status;
    this.turnLatch.set(agentId, { state: 'idle', setAt: this.now() });
    if (prior === 'idle') return; // already idle — latch updated, no event needed

    updateAgentStatus(agentId, 'idle');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'idle', source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'idle',
      fromStatus: prior,
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

    updateAgentStatus(agentId, 'waiting');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'waiting', source: kind }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'waiting',
      fromStatus: prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
  }

  /** Explicit "turn continues" signal from Pipeline B (tool-use, tool-result,
   *  user-turn, task-started). Clears the latch and updates status via the
   *  normal path (no debounce bypass — `working` doesn't need it). */
  forceWorking(agentId: string, source: string): void {
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    this.turnLatch.delete(agentId);
    if (agent.status === 'working') return;

    const prior = agent.status;
    updateAgentStatus(agentId, 'working');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'working', source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'working',
      fromStatus: prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
  }

  /** Test seam — used by status-monitor.test.ts to introspect the latch. */
  getLatchSnapshot(agentId: string): Readonly<TurnLatchEntry> | undefined {
    return this.turnLatch.get(agentId);
  }

  private async poll(): Promise<void> {
    const agents = getActiveAgents();
    for (const agent of agents) {
      try {
        const newStatus = await this.inferStatus(agent);
        if (newStatus && newStatus !== agent.status) {
          // Debounce: hold a status for a short period to prevent rapid flipping
          const holdUntil = this.statusHoldUntil.get(agent.id) || 0;
          if (this.now() < holdUntil) continue;

          updateAgentStatus(agent.id, newStatus);
          // Shorter hold for idle transitions (agent finished), longer for working
          this.statusHoldUntil.set(agent.id, this.now() + (newStatus === 'idle' ? 1500 : 2500));
          addEvent(agent.id, 'status_change', JSON.stringify({ from: agent.status, to: newStatus }));
          const payload: StatusChangedEvent = {
            agentId: agent.id,
            status: newStatus,
            fromStatus: agent.status,
            source: 'monitor',
          };
          this.emit('statusChanged', payload);
        }
      } catch {
        // Ignore individual agent check failures
      }
    }
  }

  private async inferStatus(agent: Agent): Promise<AgentStatus | null> {
    if (agent.status === 'restarting' || agent.status === 'launching') {
      return null; // Don't override transitional states
    }

    const alive = await this.checkAlive(agent);
    if (!alive) {
      if (agent.lastExitCode === 0) return 'done';
      return 'crashed';
    }

    // Pipeline B latch — high-confidence chat-stream truth overrides PTY.
    // PTY bursts cannot promote a latched-idle agent back to 'working' until
    // the TTL expires or an explicit forceWorking clears it.
    const latched = this.turnLatch.get(agent.id);
    if (latched) {
      const age = this.now() - latched.setAt;
      const ttl = latched.state === 'waiting' ? WAITING_LATCH_TIMEOUT_MS : IDLE_LATCH_TIMEOUT_MS;
      if (age <= ttl) return latched.state;
      this.turnLatch.delete(agent.id);
      // fall through to PTY fallback
    }

    const lastOutput = this.getLastOutput(agent.id);
    const elapsed = this.now() - lastOutput;

    if (elapsed < WORKING_THRESHOLD_MS) return 'working';
    return 'idle';
  }
}
