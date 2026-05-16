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
import { PromptPatternDetector } from './prompt-pattern-detector';

export type WaitingKind = 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern';

const PTY_QUIET_FOR_PATTERN_MS = 2_000;

/** Strip ANSI escape sequences and control bytes from PTY data so the
 *  PromptPatternDetector can match against clean text. Mirrors the regex set
 *  in `windows-runner.ts:hasMeaningfulContent` / `wsl-runner.ts:hasMeaningfulContent`. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

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
  /** P2-02: Pulls the trailing PTY bytes for prompt-pattern matching.
   *  Defaults to empty string when not injected (tests). */
  private getOutputRingTail: (agentId: string) => string;
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
    now: () => number = () => Date.now(),
    getOutputRingTail: (agentId: string) => string = () => ''
  ) {
    super();
    this.checkAlive = checkAlive;
    this.getLastOutput = getLastOutput;
    this.getAgentFn = getAgentFn;
    this.now = now;
    this.getOutputRingTail = getOutputRingTail;
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
      // P2-03: kind + excerpt ride on the event so the bridge can render
      // "[DASHBOARD EVENT] Agent waiting for input" without re-reading the latch.
      waitingKind: kind,
      waitingExcerpt: excerpt,
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

    // P2-02: PTY prompt-pattern detection. Only runs once the PTY has been
    // quiet for ≥2s so a still-streaming agent isn't classified as waiting
    // mid-burst. On match, arm the waiting latch (which `forceWaiting` does
    // for us) and return 'waiting' for this tick.
    if (elapsed > PTY_QUIET_FOR_PATTERN_MS) {
      const tail = this.getOutputRingTail(agent.id);
      if (tail) {
        const stripped = stripAnsi(tail);
        const hit = PromptPatternDetector.match(stripped);
        if (hit) {
          // Map the detector's narrow kind to WaitingKind directly — both
          // unions share the same string literals for tty patterns.
          this.forceWaiting(agent.id, hit.kind as WaitingKind, hit.excerpt);
          return 'waiting';
        }
      }
    }

    if (elapsed < WORKING_THRESHOLD_MS) return 'working';
    return 'idle';
  }
}
