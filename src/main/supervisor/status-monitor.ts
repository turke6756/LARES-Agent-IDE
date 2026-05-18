import { EventEmitter } from 'events';
import { Agent, AgentStatus } from '../../shared/types';
import {
  STATUS_POLL_INTERVAL_MS,
  WORKING_THRESHOLD_MS,
  IDLE_LATCH_TIMEOUT_MS,
  WAITING_LATCH_TIMEOUT_MS,
  WORKING_LATCH_MODEL_PENDING_MS,
  WORKING_LATCH_TOOL_PENDING_MS,
} from '../../shared/constants';
import { getActiveAgents, updateAgentStatus, addEvent } from '../database';
import type { StatusChangedEvent } from './status-events';
import { PromptPatternDetector } from './prompt-pattern-detector';

export type WaitingKind = 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern';

export type WorkingLatchTtlClass = 'short' | 'model-pending' | 'tool-pending';

/** Typed options for {@link StatusMonitor.forceWorking}. See
 *  plans/bug-09-fix-design.md §3.1 — the previous `(agentId, source)` shape
 *  could not carry the toolUseId pairing the consolidated fix needs. */
export interface ForceWorkingOpts {
  source: string;
  toolUseId?: string;
  resolvedToolUseId?: string;
  ttlClass: WorkingLatchTtlClass;
}

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
}

export type TurnLatchEntry = IdleLatchEntry | WaitingLatchEntry | WorkingLatchEntry;

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
  // signals, plus BUG-09's `working` variant). While set within TTL,
  // `inferStatus` honors the latched state. See plans/bug-09-fix-design.md §3.1.
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

  /** BUG-09 §3.1 — Explicit "turn continues" signal from Pipeline B. Replaces
   *  the previous binary "delete latch" behavior with a tagged `working`
   *  latch that pairs `tool-use` ↔ `tool-result` events by `toolUseId`. Always
   *  refreshes `refreshedAt`, including when the latch is already `working`
   *  (closes C7). */
  forceWorking(agentId: string, opts: ForceWorkingOpts): void {
    const agent = this.getAgentFn(agentId);
    if (!agent) return;
    if (TERMINAL_STATUSES.includes(agent.status)) return;
    if (TRANSITIONAL_STATUSES.includes(agent.status)) return;

    const now = this.now();
    const existing = this.turnLatch.get(agentId);

    let outstanding: Set<string>;
    let setAt: number;
    if (existing && existing.state === 'working') {
      outstanding = existing.outstandingToolIds;
      setAt = existing.setAt;
    } else {
      outstanding = new Set<string>();
      setAt = now;
    }

    if (opts.toolUseId) outstanding.add(opts.toolUseId);
    if (opts.resolvedToolUseId) outstanding.delete(opts.resolvedToolUseId);

    this.turnLatch.set(agentId, {
      state: 'working',
      setAt,
      refreshedAt: now,
      outstandingToolIds: outstanding,
      source: opts.source,
      ttlClass: opts.ttlClass,
    });

    if (agent.status === 'working') return; // already working — latch refreshed, no event needed

    const prior = agent.status;
    updateAgentStatus(agentId, 'working');
    addEvent(agentId, 'status_change', JSON.stringify({ from: prior, to: 'working', source: opts.source }));
    const payload: StatusChangedEvent = {
      agentId,
      status: 'working',
      fromStatus: prior,
      source: 'monitor',
    };
    this.emit('statusChanged', payload);
  }

  /** BUG-09 §3.7 — drop all per-agent state on delete/restart so a stale
   *  `tool-pending` latch (up to 15 min) does not survive a runner crash. */
  forgetAgent(agentId: string): void {
    this.turnLatch.delete(agentId);
    this.statusHoldUntil.delete(agentId);
  }

  /** Test seam — used by status-monitor.test.ts to introspect the latch. */
  getLatchSnapshot(agentId: string): TurnLatchEntry | undefined {
    return this.turnLatch.get(agentId);
  }

  private async poll(): Promise<void> {
    const agents = getActiveAgents();
    for (const agent of agents) {
      try {
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
      if (latched.state === 'working') {
        const age = this.now() - latched.refreshedAt;
        const hasOutstandingTools = latched.outstandingToolIds.size > 0;
        const effectiveTtl = hasOutstandingTools
          ? WORKING_LATCH_TOOL_PENDING_MS
          : WORKING_LATCH_MODEL_PENDING_MS;
        if (age <= effectiveTtl) {
          // BUG-09 §3.1 (Codex round 3) — tiered PTY-pattern-detection vs
          // latched working:
          //   tool-pending: skip pattern detection. A silently-running tool
          //     can leave a `(y/N)`-shaped line in the ring tail from an
          //     earlier turn; pattern detection would spuriously fire
          //     `forceWaiting` and overwrite the genuine tool-pending latch.
          //   model-pending: run pattern detection first; real waiting prompts
          //     still beat the generic latched-working state.
          if (hasOutstandingTools) return 'working';

          const lastOutputForPattern = this.getLastOutput(agent.id);
          const elapsedForPattern = this.now() - lastOutputForPattern;
          if (elapsedForPattern > PTY_QUIET_FOR_PATTERN_MS) {
            const tail = this.getOutputRingTail(agent.id);
            if (tail) {
              const stripped = stripAnsi(tail);
              const hit = PromptPatternDetector.match(stripped);
              if (hit) {
                this.forceWaiting(agent.id, hit.kind as WaitingKind, hit.excerpt);
                return 'waiting';
              }
            }
          }
          return 'working';
        }
        this.turnLatch.delete(agent.id);
        // fall through to PTY fallback
      } else {
        const age = this.now() - latched.setAt;
        const ttl = latched.state === 'waiting' ? WAITING_LATCH_TIMEOUT_MS : IDLE_LATCH_TIMEOUT_MS;
        if (age <= ttl) return latched.state;
        this.turnLatch.delete(agent.id);
        // fall through to PTY fallback
      }
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
