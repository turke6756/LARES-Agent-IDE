// Idle-agent lifecycle §B5/§B6 — the locked, idempotent, HONEST stop engine.
//
// Covers:
//   - terminateVerifiedAgent maps every OwnershipStore ReapOutcome.action
//     (terminated / gone / reused / unavailable / unverifiable) onto the stop
//     engine's vocabulary, deletes the ownership row on success, and NEVER
//     deletes it when the identity could not be verified (fail-closed);
//   - the WSL branch kills the tmux session (the process authority there) and
//     the reapViaJob → reapViaTreeWalk fallback on 'unavailable';
//   - a runner that confirms exit yields outcome 'stopped' + `done` + the
//     recorded stop reason;
//   - stop is idempotent ('already_stopped') and normalizes a live row with no
//     runner ('normalized');
//   - THE honest-failure rule: a runner that never confirms exit + a
//     termination that cannot be verified → outcome 'failed',
//     killedRunner:false, the agent is NOT marked done, its runner-map entry is
//     RETAINED, and a `stop-failed` audit row is written;
//   - the per-agent lifecycle lock serializes concurrent ops and produces no
//     unhandled rejection when a locked op throws;
//   - the emitter audit: no `statusChanged` emitter in supervisor/index.ts or
//     status-monitor.ts derives `fromStatus` from a separate getAgent() read.
//
//   npm run build:main
//   node dist/main/main/supervisor/lifecycle-stop.test.js

import assert from 'node:assert/strict';
import * as fsp from 'node:fs';
import * as pathp from 'node:path';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import type { Agent, AgentStatus, StopResult } from '../../shared/types';
import type { AgentSupervisor as AgentSupervisorType } from './index';

// The runner-exit budget is a class static resolved at module-evaluation time,
// so it must be shrunk BEFORE ./index is loaded — hence the require() below
// rather than a hoisted ES import.
process.env.DASHBOARD_STOP_RUNNER_WAIT_MS = '120';
process.env.DASHBOARD_STOP_WSL_RUNNER_WAIT_MS = '120';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSupervisor } = require('./index') as { AgentSupervisor: new () => AgentSupervisorType };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WindowsRunner } = require('./windows-runner') as { WindowsRunner: new () => FakeRunner };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wslBridge = require('../wsl-bridge') as { tmuxKillSession: (n: string) => Promise<void> };

interface FakeRunner {
  kill(): void;
  emit(ev: string, ...args: unknown[]): boolean;
  once(ev: string, fn: (...a: unknown[]) => void): unknown;
  removeListener(ev: string, fn: (...a: unknown[]) => void): unknown;
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── DB module patching (same shape as agent-supervisor.test.ts) ───────────────

function patchDb(agentsMap: Map<string, Agent>, audit: Array<{ agentId: string; type: string; payload?: string }>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'getAgent', 'addEvent',
    'updateAgentExitCode', 'updateAgentLastOutput', 'getActiveAgents',
    'getAllAgents', 'getSupervisorAgent', 'incrementRestartCount',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = (agentId: string, type: string, payload?: string) => { audit.push({ agentId, type, payload }); };
  db.updateAgentExitCode = () => {};
  db.updateAgentLastOutput = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.incrementRestartCount = () => {};
  patchApplyStatusTransition(db);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

// ── Harness ───────────────────────────────────────────────────────────────────

type ReapAction = 'terminated' | 'gone' | 'reused' | 'unavailable' | 'unverifiable';

interface FakeOwnership {
  row: { agentId: string; transport: 'conpty' | 'wsl'; tmuxSession: string | null } | null;
  jobAction: ReapAction;
  treeAction: ReapAction;
  deleted: string[];
  treeWalkCalls: number;
}

interface Harness {
  supervisor: AgentSupervisorType;
  agent: Agent;
  agentsMap: Map<string, Agent>;
  audit: Array<{ agentId: string; type: string; payload?: string }>;
  emissions: Array<{ agentId: string; status: string; fromStatus?: string; source?: string }>;
  ownership: FakeOwnership;
  /** Install a runner whose kill() either confirms exit or stays silent. */
  injectRunner(opts: { confirmsExit: boolean }): FakeRunner;
  runnerMap(): Map<string, unknown>;
  cleanup(): void;
}

function setup(over: Partial<Agent> = {}): Harness {
  const agent = makeAgent('agent-stop-1', { status: 'working', ...over });
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const audit: Array<{ agentId: string; type: string; payload?: string }> = [];
  const restoreDb = patchDb(agentsMap, audit);

  const supervisor = new AgentSupervisor();
  const priv = supervisor as unknown as Record<string, unknown>;
  priv.writeAgentRegistry = () => {};
  // Keep the deferred ring release from touching the real session-log reader.
  priv.releaseChatRing = () => {};

  const ownership: FakeOwnership = {
    row: { agentId: agent.id, transport: 'conpty', tmuxSession: null },
    jobAction: 'terminated',
    treeAction: 'terminated',
    deleted: [],
    treeWalkCalls: 0,
  };
  priv.ownership = {
    getOwnership: (id: string) => (ownership.row && ownership.row.agentId === id ? ownership.row : null),
    reapViaJob: () => ({ action: ownership.jobAction, pids: [111] }),
    reapViaTreeWalk: () => { ownership.treeWalkCalls++; return { action: ownership.treeAction, pids: [222] }; },
    deleteOwnership: (id: string) => { ownership.deleted.push(id); },
  };
  priv.processLister = { list: async () => [] };

  const emissions: Harness['emissions'] = [];
  supervisor.on('statusChanged', (e: { agentId: string; status: string; fromStatus?: string; source?: string }) => {
    emissions.push(e);
  });

  const origTmuxKill = wslBridge.tmuxKillSession;

  return {
    supervisor,
    agent,
    agentsMap,
    audit,
    emissions,
    ownership,
    injectRunner: ({ confirmsExit }) => {
      const fake = new WindowsRunner();
      Object.defineProperty(fake, 'isAlive', { get: () => true, configurable: true });
      fake.kill = () => {
        // A real runner's kill() leads to an 'exit' emission from the pty host.
        if (confirmsExit) setImmediate(() => fake.emit('exit', 0, null));
      };
      (priv.windowsRunners as Map<string, unknown>).set(agent.id, fake);
      return fake;
    },
    runnerMap: () => priv.windowsRunners as Map<string, unknown>,
    cleanup: () => { wslBridge.tmuxKillSession = origTmuxKill; restoreDb(); },
  };
}

// ── terminateVerifiedAgent: ReapOutcome mapping ───────────────────────────────

type TerminateResult = { outcome: string; pids?: number[]; error?: string };
function terminate(h: Harness): Promise<TerminateResult> {
  return (h.supervisor as unknown as { terminateVerifiedAgent(id: string): Promise<TerminateResult> })
    .terminateVerifiedAgent(h.agent.id);
}

test("terminateVerifiedAgent: 'terminated' → terminated + ownership row deleted", async () => {
  const h = setup();
  try {
    h.ownership.jobAction = 'terminated';
    const r = await terminate(h);
    assert.equal(r.outcome, 'terminated');
    assert.deepEqual(h.ownership.deleted, [h.agent.id]);
  } finally { h.cleanup(); }
});

test("terminateVerifiedAgent: 'gone' → already-gone + row deleted", async () => {
  const h = setup();
  try {
    h.ownership.jobAction = 'gone';
    const r = await terminate(h);
    assert.equal(r.outcome, 'already-gone');
    assert.deepEqual(h.ownership.deleted, [h.agent.id]);
  } finally { h.cleanup(); }
});

test("terminateVerifiedAgent: 'reused' → already-gone (we declined to kill a stranger)", async () => {
  const h = setup();
  try {
    h.ownership.jobAction = 'reused';
    const r = await terminate(h);
    assert.equal(r.outcome, 'already-gone');
    assert.deepEqual(h.ownership.deleted, [h.agent.id]);
  } finally { h.cleanup(); }
});

test("terminateVerifiedAgent: 'unverifiable' → unverifiable and the row is KEPT (fail-closed)", async () => {
  const h = setup();
  try {
    h.ownership.jobAction = 'unverifiable';
    const r = await terminate(h);
    assert.equal(r.outcome, 'unverifiable');
    assert.deepEqual(h.ownership.deleted, [], 'an unverified identity is left for manual reconciliation');
  } finally { h.cleanup(); }
});

test("terminateVerifiedAgent: job 'unavailable' falls back to the verified tree walk", async () => {
  const h = setup();
  try {
    h.ownership.jobAction = 'unavailable';
    h.ownership.treeAction = 'terminated';
    const r = await terminate(h);
    assert.equal(h.ownership.treeWalkCalls, 1, 'tree walk engaged');
    assert.equal(r.outcome, 'terminated');
  } finally { h.cleanup(); }
});

test("terminateVerifiedAgent: still 'unavailable' after the tree walk → failed", async () => {
  const h = setup();
  try {
    h.ownership.jobAction = 'unavailable';
    h.ownership.treeAction = 'unavailable';
    const r = await terminate(h);
    assert.equal(r.outcome, 'failed');
    assert.deepEqual(h.ownership.deleted, []);
  } finally { h.cleanup(); }
});

test('terminateVerifiedAgent: no ownership row → already-gone', async () => {
  const h = setup();
  try {
    h.ownership.row = null;
    const r = await terminate(h);
    assert.equal(r.outcome, 'already-gone');
  } finally { h.cleanup(); }
});

test('terminateVerifiedAgent: ownership store not armed → unverifiable (never a silent success)', async () => {
  const h = setup();
  try {
    (h.supervisor as unknown as Record<string, unknown>).ownership = null;
    const r = await terminate(h);
    assert.equal(r.outcome, 'unverifiable');
  } finally { h.cleanup(); }
});

test('terminateVerifiedAgent: WSL transport kills the tmux session and deletes the row', async () => {
  const h = setup();
  try {
    h.ownership.row = { agentId: h.agent.id, transport: 'wsl', tmuxSession: 'ad-agent-1' };
    const killed: string[] = [];
    wslBridge.tmuxKillSession = async (n: string) => { killed.push(n); };
    const r = await terminate(h);
    assert.deepEqual(killed, ['ad-agent-1'], 'tmux is the process authority for WSL agents');
    assert.equal(r.outcome, 'terminated');
    assert.deepEqual(h.ownership.deleted, [h.agent.id]);
  } finally { h.cleanup(); }
});

test('terminateVerifiedAgent: WSL row with no tmux session → already-gone', async () => {
  const h = setup();
  try {
    h.ownership.row = { agentId: h.agent.id, transport: 'wsl', tmuxSession: null };
    const r = await terminate(h);
    assert.equal(r.outcome, 'already-gone');
  } finally { h.cleanup(); }
});

// ── stopAgent outcomes ────────────────────────────────────────────────────────

test('stop with a confirming runner → stopped, done, reason recorded', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    const r: StopResult = await h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' });
    assert.equal(r.outcome, 'stopped');
    assert.equal(r.killedRunner, true);
    assert.equal(r.reason, 'manual-card');
    assert.equal(h.agentsMap.get(h.agent.id)!.status, 'done');
    assert.equal(h.runnerMap().has(h.agent.id), false, 'runner-map entry dropped');
    assert.ok(h.audit.some((e) => e.type === 'stopped'), 'stopped audit row written');
    assert.ok(h.emissions.some((e) => e.status === 'done' && e.source === 'stop'));
  } finally { h.cleanup(); }
});

test("stop defaults the reason to 'supervisor' when none is supplied", async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    const r = await h.supervisor.stopAgent(h.agent.id);
    assert.equal(r.reason, 'supervisor');
  } finally { h.cleanup(); }
});

test('stop of an unknown agent → not_found', async () => {
  const h = setup();
  try {
    const r = await h.supervisor.stopAgent('nope');
    assert.equal(r.outcome, 'not_found');
    assert.equal(r.killedRunner, false);
  } finally { h.cleanup(); }
});

test('stop of an already-terminal agent with no runner → already_stopped (idempotent, no re-emission)', async () => {
  const h = setup({ status: 'done' });
  try {
    const r = await h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' });
    assert.equal(r.outcome, 'already_stopped');
    assert.equal(r.killedRunner, false);
    assert.equal(h.emissions.length, 0, 'a redundant stop must not re-announce "done"');
  } finally { h.cleanup(); }
});

test('stop of a LIVE agent with no runner → normalized (row reconciled to done)', async () => {
  const h = setup({ status: 'working' });
  try {
    const r = await h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' });
    assert.equal(r.outcome, 'normalized');
    assert.equal(r.killedRunner, false);
    assert.equal(h.agentsMap.get(h.agent.id)!.status, 'done');
  } finally { h.cleanup(); }
});

test('stop escalates to verified termination when the runner does not confirm exit', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: false });
    h.ownership.jobAction = 'terminated';
    const r = await h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' });
    assert.equal(r.outcome, 'stopped', 'verified termination is as good as a confirmed exit');
    assert.equal(r.killedRunner, true);
    assert.equal(h.agentsMap.get(h.agent.id)!.status, 'done');
  } finally { h.cleanup(); }
});

test('HONEST FAILURE: unverifiable termination → failed, NOT done, runner retained', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: false });
    h.ownership.jobAction = 'unverifiable';
    const r = await h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' });
    assert.equal(r.outcome, 'failed');
    assert.equal(r.killedRunner, false, 'we did not kill anything we could verify');
    assert.equal(h.agentsMap.get(h.agent.id)!.status, 'working', 'the agent keeps its live status');
    assert.equal(h.runnerMap().has(h.agent.id), true, 'the runner-map entry is RETAINED');
    assert.equal(h.emissions.length, 0, 'the UI is never told "Stopped" over a possibly-live process');
    const failed = h.audit.find((e) => e.type === 'stop-failed');
    assert.ok(failed, 'a stop-failed audit row is written');
    assert.match(String(failed!.payload), /unverifiable/);
  } finally { h.cleanup(); }
});

test("HONEST FAILURE: 'failed' termination is equally honest", async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: false });
    h.ownership.jobAction = 'unavailable';
    h.ownership.treeAction = 'unavailable';
    const r = await h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' });
    assert.equal(r.outcome, 'failed');
    assert.equal(h.agentsMap.get(h.agent.id)!.status, 'working');
  } finally { h.cleanup(); }
});

test('a retry after an honest failure can still succeed', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: false });
    h.ownership.jobAction = 'unverifiable';
    assert.equal((await h.supervisor.stopAgent(h.agent.id)).outcome, 'failed');
    h.ownership.jobAction = 'terminated'; // the operator reconciled it
    const r = await h.supervisor.stopAgent(h.agent.id);
    assert.equal(r.outcome, 'stopped');
    assert.equal(h.agentsMap.get(h.agent.id)!.status, 'done');
  } finally { h.cleanup(); }
});

// ── §B6 lifecycle lock ────────────────────────────────────────────────────────

test('the lifecycle lock serializes concurrent ops on one agent', async () => {
  const h = setup();
  try {
    const withLock = (h.supervisor as unknown as {
      withLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
    }).withLifecycleLock.bind(h.supervisor);
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      withLock(h.agent.id, slow('a', 30)),
      withLock(h.agent.id, slow('b', 1)),
      withLock(h.agent.id, slow('c', 1)),
    ]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'],
      'no interleaving — each op runs to completion before the next starts');
  } finally { h.cleanup(); }
});

test('the lock does not serialize DIFFERENT agents', async () => {
  const h = setup();
  try {
    const withLock = (h.supervisor as unknown as {
      withLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
    }).withLifecycleLock.bind(h.supervisor);
    const order: string[] = [];
    await Promise.all([
      withLock('agent-A', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('A'); }),
      withLock('agent-B', async () => { order.push('B'); }),
    ]);
    assert.deepEqual(order, ['B', 'A'], 'B did not wait behind A');
  } finally { h.cleanup(); }
});

test('a rejecting locked op does NOT poison the chain and produces no unhandled rejection', async () => {
  const h = setup();
  try {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const withLock = (h.supervisor as unknown as {
        withLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
      }).withLifecycleLock.bind(h.supervisor);
      const boom = withLock(h.agent.id, async () => { throw new Error('boom'); });
      const after = withLock(h.agent.id, async () => 'ok');
      await assert.rejects(boom, /boom/);
      assert.equal(await after, 'ok', 'the successor still ran');
      // Give the microtask + macrotask queues a chance to surface a rejection.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(unhandled, [], 'the lock cleanup must never emit an unhandled rejection');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  } finally { h.cleanup(); }
});

test('concurrent stops of the same agent serialize: one stops, the other is idempotent', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    const [a, b] = await Promise.all([
      h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' }),
      h.supervisor.stopAgent(h.agent.id, { reason: 'manual-card' }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['already_stopped', 'stopped'],
      'the second stop observes the first one\'s result rather than racing it');
    assert.equal(h.emissions.filter((e) => e.status === 'done').length, 1, 'exactly one done emission');
  } finally { h.cleanup(); }
});

test('the lock is released after an op settles (no leak)', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    await h.supervisor.stopAgent(h.agent.id);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.supervisor.isLifecycleLocked(h.agent.id), false);
  } finally { h.cleanup(); }
});

// ── §B3 emitter audit ─────────────────────────────────────────────────────────

function readSource(rel: string): string {
  // dist/main/main/supervisor/<file>.js → repo root is four levels up.
  const candidates = [
    pathp.resolve(__dirname, '../../../..', rel),
    pathp.resolve(process.cwd(), rel),
  ];
  for (const c of candidates) if (fsp.existsSync(c)) return fsp.readFileSync(c, 'utf8');
  throw new Error(`could not locate ${rel} from ${__dirname} / ${process.cwd()}`);
}

test('emitter audit: no statusChanged emitter derives fromStatus from a separate getAgent()', () => {
  for (const rel of ['src/main/supervisor/index.ts', 'src/main/supervisor/status-monitor.ts']) {
    const src = readSource(rel);
    // `const X = getAgent(...)?.status` … later used as `fromStatus: X` — the
    // exact pattern applyStatusTransition's in-transaction prior read replaces.
    const re = /const\s+(\w+)\s*=\s*getAgent\([^)]*\)\??\.?status[\s\S]{0,600}?fromStatus:\s*(\w+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      assert.notEqual(m[1], m[2],
        `${rel}: fromStatus is being read from a separate getAgent() (\`${m[1]}\`) — ` +
        'it must come from applyStatusTransition\'s in-transaction prior');
    }
  }
});

test('emitter audit: every status write in supervisor/index.ts + status-monitor.ts is a transition write', () => {
  for (const rel of ['src/main/supervisor/index.ts', 'src/main/supervisor/status-monitor.ts']) {
    const src = readSource(rel);
    // updateAgentStatus is a thin shim OVER applyStatusTransition, so both are
    // legal writers — what must never appear is a raw `UPDATE agents SET status`.
    assert.ok(!/UPDATE\s+agents\s+SET[\s\S]{0,80}\bstatus\s*=/i.test(src),
      `${rel}: status must never be written with raw SQL — route it through applyStatusTransition`);
  }
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
