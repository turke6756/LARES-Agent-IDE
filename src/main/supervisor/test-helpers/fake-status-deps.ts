import type { Agent, AgentStatus } from '../../../shared/types';
import { makeAgent } from './fake-bridge-deps';

/**
 * Test seam for StatusMonitor. The real StatusMonitor mutates the database
 * via `updateAgentStatus`; in tests we patch that module-level function to
 * recorded calls + an in-memory agent map.
 *
 * StatusMonitor.poll() reads `getActiveAgents()` from the database too — for
 * the BR-11/16/17/18 suite we don't exercise `poll()`, only `inferStatus`
 * and the force* methods, so the polling DB read is irrelevant.
 */
export interface StatusUpdate {
  agentId: string;
  status: AgentStatus;
}

export interface StatusMonitorFakes {
  agents: Map<string, Agent>;
  /** Recorded calls to `updateAgentStatus` (in insertion order). */
  updates: StatusUpdate[];
  /** Recorded `addEvent` audit rows. */
  audit: Array<{ agentId: string; type: string; payload: string }>;
  /** Recorded `statusChanged` emissions from the monitor. */
  emissions: Array<{ agentId: string; status: AgentStatus; fromStatus?: AgentStatus; source: string }>;
  /** Controllable PTY last-output timestamp per agent. */
  lastOutputAt: Map<string, number>;
  /** Controllable alive predicate. */
  aliveOverride: Map<string, boolean>;
  /** Controllable clock (advanced by the test). */
  now: { value: number };
}

export function makeStatusMonitorFakes(): StatusMonitorFakes {
  return {
    agents: new Map(),
    updates: [],
    audit: [],
    emissions: [],
    lastOutputAt: new Map(),
    aliveOverride: new Map(),
    now: { value: 1_000_000 },
  };
}

/**
 * Patches the database module's `updateAgentStatus` and `addEvent` so the
 * fake records calls instead of writing to SQLite. Returns a restore fn.
 *
 * IMPORTANT: this mutates the module object — tests must always restore in
 * a `finally` to avoid leaking state across the suite.
 */
export function patchDatabaseModule(fakes: StatusMonitorFakes): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../../database') as {
    updateAgentStatus: (id: string, status: AgentStatus) => void;
    addEvent: (id: string, type: string, payload: string | null) => void;
    getActiveAgents: () => Agent[];
  };

  const origUpdate = db.updateAgentStatus;
  const origAdd = db.addEvent;
  const origActive = db.getActiveAgents;

  db.updateAgentStatus = (id, status) => {
    fakes.updates.push({ agentId: id, status });
    const a = fakes.agents.get(id);
    if (a) a.status = status;
  };
  db.addEvent = (id, type, payload) => {
    fakes.audit.push({ agentId: id, type, payload: payload ?? '' });
  };
  db.getActiveAgents = () => Array.from(fakes.agents.values());

  return () => {
    db.updateAgentStatus = origUpdate;
    db.addEvent = origAdd;
    db.getActiveAgents = origActive;
  };
}

export { makeAgent };
