import { EventEmitter } from 'events';
import { Agent, AgentStatus } from '../../shared/types';
import { STATUS_POLL_INTERVAL_MS, WORKING_THRESHOLD_MS } from '../../shared/constants';
import { getActiveAgents, updateAgentStatus, addEvent } from '../database';

export class StatusMonitor extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private checkAlive: (agent: Agent) => Promise<boolean>;
  private getLastOutput: (agentId: string) => number;
  // Track how long an agent has been in a status to prevent rapid flipping
  private statusHoldUntil = new Map<string, number>();

  constructor(
    checkAlive: (agent: Agent) => Promise<boolean>,
    getLastOutput: (agentId: string) => number
  ) {
    super();
    this.checkAlive = checkAlive;
    this.getLastOutput = getLastOutput;
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

  private async poll(): Promise<void> {
    const agents = getActiveAgents();
    for (const agent of agents) {
      try {
        const newStatus = await this.inferStatus(agent);
        if (newStatus && newStatus !== agent.status) {
          // Debounce: hold a status for a short period to prevent rapid flipping
          const holdUntil = this.statusHoldUntil.get(agent.id) || 0;
          if (Date.now() < holdUntil) continue;

          updateAgentStatus(agent.id, newStatus);
          // Shorter hold for idle transitions (agent finished), longer for working
          this.statusHoldUntil.set(agent.id, Date.now() + (newStatus === 'idle' ? 1500 : 2500));
          addEvent(agent.id, 'status_change', JSON.stringify({ from: agent.status, to: newStatus }));
          this.emit('statusChanged', { agentId: agent.id, status: newStatus, fromStatus: agent.status });
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

    const lastOutput = this.getLastOutput(agent.id);
    const elapsed = Date.now() - lastOutput;

    if (elapsed < WORKING_THRESHOLD_MS) return 'working';
    return 'idle';
  }
}
