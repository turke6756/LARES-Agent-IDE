import type { Agent, ContextStats } from '../../../shared/types';
import type { EventBridgeDeps } from '../event-bridge';
import type { ForceWorkingOpts, WaitingKind } from '../status-monitor';

interface ScheduledTask {
  id: number;
  delay: number;
  scheduledAt: number;
  fn: () => void;
  cancelled: boolean;
}

/** Drainable scheduler the test drives manually. The real bridge uses
 *  setTimeout; here every scheduleDrain becomes a recorded task the test
 *  can fire on demand or after advancing the fake clock. */
export class FakeScheduler {
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  constructor(private readonly getNow: () => number) {}

  schedule(ms: number, fn: () => void): { cancel(): void } {
    const task: ScheduledTask = {
      id: this.nextId++,
      delay: ms,
      scheduledAt: this.getNow(),
      fn,
      cancelled: false,
    };
    this.tasks.push(task);
    return { cancel: () => { task.cancelled = true; } };
  }

  /** Fire every task whose scheduledAt + delay <= currentNow. */
  runDue(currentNow: number): number {
    const ready = this.tasks.filter(t => !t.cancelled && t.scheduledAt + t.delay <= currentNow);
    this.tasks = this.tasks.filter(t => !ready.includes(t));
    for (const t of ready) t.fn();
    return ready.length;
  }

  /** Pop and fire the next non-cancelled task regardless of timing. */
  runNext(): boolean {
    while (this.tasks.length > 0) {
      const t = this.tasks.shift()!;
      if (!t.cancelled) {
        t.fn();
        return true;
      }
    }
    return false;
  }

  pendingCount(): number {
    return this.tasks.filter(t => !t.cancelled).length;
  }
}

export interface SendInputRecord {
  agentId: string;
  text: string;
  resolved: boolean;
  error?: Error;
}

export interface AuditEventRecord {
  agentId: string;
  type: 'supervisor_event' | 'supervisor_event_batch';
  payload: string;
}

export interface StatusForceCall {
  method: 'forceIdle' | 'forceWaiting' | 'forceWorking';
  agentId: string;
  source?: string;
  kind?: WaitingKind;
  excerpt?: string;
  /** BUG-09 §3.1 — typed-options surface on forceWorking. The flat
   *  `source` field above is also populated (from `opts.source`) so existing
   *  tests reading `c.source` keep working. */
  workingOpts?: ForceWorkingOpts;
}

export interface FakeBridgeDepsBundle {
  deps: EventBridgeDeps;
  agents: Map<string, Agent>;
  contextStats: Map<string, ContextStats>;
  logs: Map<string, string>;
  sendInputCalls: SendInputRecord[];
  auditEvents: AuditEventRecord[];
  scheduler: FakeScheduler;
  /** Calls recorded by the fake StatusMonitor collaborator (P1A-02). */
  statusForceCalls: StatusForceCall[];
  setNow(t: number): void;
  getNow(): number;
  /** Queue a single-shot error for the NEXT sendInput call. */
  setSendInputError(err: Error | null): void;
}

export function makeFakeBridgeDeps(): FakeBridgeDepsBundle {
  let now = 1_000_000;
  const agents = new Map<string, Agent>();
  const contextStats = new Map<string, ContextStats>();
  const logs = new Map<string, string>();
  const sendInputCalls: SendInputRecord[] = [];
  const auditEvents: AuditEventRecord[] = [];
  const statusForceCalls: StatusForceCall[] = [];
  const scheduler = new FakeScheduler(() => now);
  let nextSendError: Error | null = null;

  const deps: EventBridgeDeps = {
    getAgent: (id) => agents.get(id) ?? null,
    getSupervisorForWorker: (worker) => {
      for (const a of agents.values()) {
        if (a.isSupervisor && a.workspaceId === worker.workspaceId) return a;
      }
      return null;
    },
    sendInput: async (agentId, text) => {
      if (nextSendError) {
        const err = nextSendError;
        nextSendError = null;
        sendInputCalls.push({ agentId, text, resolved: false, error: err });
        throw err;
      }
      sendInputCalls.push({ agentId, text, resolved: true });
    },
    addAuditEvent: (agentId, type, payload) => {
      auditEvents.push({ agentId, type, payload });
    },
    getAgentLog: async (agentId, _lines) => logs.get(agentId) ?? '',
    getContextStats: (agentId) => contextStats.get(agentId) ?? null,
    now: () => now,
    scheduleDrain: (ms, fn) => scheduler.schedule(ms, fn),
    statusMonitor: {
      forceIdle: (agentId, source) => {
        statusForceCalls.push({ method: 'forceIdle', agentId, source });
      },
      forceWaiting: (agentId, kind, excerpt) => {
        statusForceCalls.push({ method: 'forceWaiting', agentId, kind, excerpt });
      },
      forceWorking: (agentId, opts) => {
        statusForceCalls.push({
          method: 'forceWorking',
          agentId,
          source: opts.source,
          workingOpts: opts,
        });
      },
    },
  };

  return {
    deps,
    agents,
    contextStats,
    logs,
    sendInputCalls,
    auditEvents,
    scheduler,
    statusForceCalls,
    setNow: (t) => { now = t; },
    getNow: () => now,
    setSendInputError: (err) => { nextSendError = err; },
  };
}

export function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    workspaceId: 'ws-1',
    title: `Agent ${id}`,
    slug: id,
    roleDescription: '',
    workingDirectory: '/tmp',
    command: 'claude',
    provider: 'claude',
    isSupervisor: false,
    isSupervised: true,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    resumeSessionId: null,
    status: 'idle',
    isAttached: false,
    restartCount: 0,
    lastExitCode: null,
    pid: null,
    logPath: null,
    templateId: null,
    systemPrompt: null,
    createdAt: '2026-05-16T00:00:00Z',
    updatedAt: '2026-05-16T00:00:00Z',
    lastOutputAt: null,
    lastAttachedAt: null,
    ...overrides,
  };
}

/** Yield until all queued microtasks have run. Useful when the bridge's
 *  fire-and-forget `void deliver(...)` calls need to settle before the test
 *  inspects sendInput / audit state. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
