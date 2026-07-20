// Idle-agent lifecycle — the stop-intent record that guards §B5's honest failure.
//
// §B5 deliberately RETAINS the runner-map entry when a stop cannot be verified.
// The consequence it flagged: the process's eventual exit would otherwise flow
// through the normal runner-exit path, write `done`/`crashed`, emit a SECOND
// `statusChanged`, and — the real danger — trigger auto-restart on a crash exit
// code, resurrecting the agent the user just tried to stop.
//
// Covers:
//   - a late exit after an HONEST-FAILURE stop: no auto-restart, exactly one
//     terminal `statusChanged` across the whole stop, attributed to the stop's
//     own reason (not 'crashed'), and the intent record is cleared;
//   - a genuine crash with NO stop intent still auto-restarts (the pre-existing
//     behaviour is untouched);
//   - a runner exit arriving DURING an in-flight stop does not double-emit —
//     the stop path stays the single status authority;
//   - a shutdown-time exit still keeps the pre-quit status (reconcile path).
//
//   npm run build:main
//   node dist/main/main/supervisor/lifecycle-stop-intent.test.js

import assert from 'node:assert/strict';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import type { Agent, AgentStatus, AgentStopReason, StopResult } from '../../shared/types';
import type { AgentSupervisor as AgentSupervisorType } from './index';

// Same requirement as lifecycle-stop.test.ts: the runner-exit budget is a class
// static resolved at module-evaluation time, so shrink it before ./index loads.
process.env.DASHBOARD_STOP_RUNNER_WAIT_MS = '80';
process.env.DASHBOARD_STOP_WSL_RUNNER_WAIT_MS = '80';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSupervisor } = require('./index') as { AgentSupervisor: new () => AgentSupervisorType };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WindowsRunner } = require('./windows-runner') as { WindowsRunner: new () => FakeRunner };

interface FakeRunner {
  kill(): void;
  emit(ev: string, ...args: unknown[]): boolean;
  once(ev: string, fn: (...a: unknown[]) => void): unknown;
  removeListener(ev: string, fn: (...a: unknown[]) => void): unknown;
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function patchDb(
  agentsMap: Map<string, Agent>,
  audit: Array<{ agentId: string; type: string; payload?: string }>,
  transitions: Array<{ id: string; status: string; stopReason: string | null }>,
): () => void {
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
  // The shared shim ignores the stop reason; record it so the tests can prove
  // the late exit is attributed to the stop rather than to a crash.
  const shim = db.applyStatusTransition as (id: string, s: AgentStatus) => unknown;
  db.applyStatusTransition = (id: string, status: AgentStatus, opts?: { stopReason?: string }) => {
    transitions.push({ id, status, stopReason: opts?.stopReason ?? null });
    return shim(id, status);
  };

  return () => { for (const k of keys) db[k] = orig[k]; };
}

interface Harness {
  supervisor: AgentSupervisorType;
  agent: Agent;
  audit: Array<{ agentId: string; type: string; payload?: string }>;
  emissions: Array<{ agentId: string; status: string; fromStatus?: string; source?: string }>;
  autoRestarts: string[];
  transitions: Array<{ id: string; status: string; stopReason: string | null }>;
  /** Install a runner whose kill() never confirms exit (the honest-failure setup). */
  injectSilentRunner(): FakeRunner;
  runnerMap(): Map<string, unknown>;
  /** Fire the runner's exit through the supervisor's single exit authority. */
  fireExit(exitCode: number): void;
  stop(reason?: AgentStopReason): Promise<StopResult>;
  intent(): string | null;
  cleanup(): void;
}

function setup(over: Partial<Agent> = {}, ownershipOutcome: 'terminated' | 'unverifiable' = 'unverifiable'): Harness {
  const agent = makeAgent('agent-intent-1', { status: 'working', autoRestartEnabled: true, ...over });
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const audit: Array<{ agentId: string; type: string; payload?: string }> = [];
  const transitions: Harness['transitions'] = [];
  const restoreDb = patchDb(agentsMap, audit, transitions);

  const supervisor = new AgentSupervisor();
  const priv = supervisor as unknown as Record<string, unknown>;
  priv.writeAgentRegistry = () => {};
  priv.releaseChatRing = () => {};
  priv.releaseSpoolTailer = () => {};

  const autoRestarts: string[] = [];
  priv.handleAutoRestart = (a: Agent) => { autoRestarts.push(a.id); };

  const monitor = priv.monitor as Record<string, unknown>;
  monitor.clearLaunch = () => {};

  priv.ownership = {
    getOwnership: () => ({ agentId: agent.id, transport: 'conpty', tmuxSession: null }),
    reapViaJob: () => ({ action: ownershipOutcome, pids: [] }),
    reapViaTreeWalk: () => ({ action: ownershipOutcome, pids: [] }),
    deleteOwnership: () => {},
  };
  priv.processLister = { list: async () => [] };

  const emissions: Harness['emissions'] = [];
  supervisor.on('statusChanged', (e: { agentId: string; status: string; fromStatus?: string; source?: string }) => {
    emissions.push(e);
  });

  return {
    supervisor,
    agent,
    audit,
    emissions,
    autoRestarts,
    transitions,
    injectSilentRunner: () => {
      const fake = new WindowsRunner();
      Object.defineProperty(fake, 'isAlive', { get: () => true, configurable: true });
      fake.kill = () => { /* never emits 'exit' — the stop cannot be confirmed */ };
      (priv.windowsRunners as Map<string, unknown>).set(agent.id, fake);
      return fake;
    },
    runnerMap: () => priv.windowsRunners as Map<string, unknown>,
    fireExit: (exitCode: number) => {
      (priv.handleRunnerExit as (id: string, code: number, t: string) => void)
        .call(supervisor, agent.id, exitCode, 'windows');
    },
    stop: (reason: AgentStopReason = 'manual-card') =>
      (supervisor as unknown as { stopAgent(id: string, o?: unknown): Promise<StopResult> })
        .stopAgent(agent.id, { reason }),
    intent: () => supervisor.peekStopIntent(agent.id),
    cleanup: () => { restoreDb(); },
  };
}

// ── The regression this item exists for ──────────────────────────────────────

test('late exit after an HONEST-FAILURE stop never auto-restarts, even on a crash exit code', async () => {
  const h = setup();
  try {
    h.injectSilentRunner();
    const r = await h.stop();
    assert.equal(r.outcome, 'failed', 'setup: the stop must fail honestly');
    assert.equal(h.runnerMap().has(h.agent.id), true, '§B5 retains the runner entry on a failed stop');
    assert.equal(h.intent(), 'stop-failed', 'the intent is RETAINED across an honest failure');

    // The process finally dies — with a CRASH exit code, the resurrection vector.
    h.fireExit(1);

    assert.deepEqual(h.autoRestarts, [], 'a stopped agent must never be auto-restarted by its own late exit');
    assert.equal(h.intent(), null, 'the record is cleared once the late exit is handled');
    assert.equal(h.runnerMap().has(h.agent.id), false, 'the retained runner entry is finally dropped');
  } finally { h.cleanup(); }
});

test('late exit after an honest failure emits exactly ONE terminal statusChanged, attributed to the stop', async () => {
  const h = setup();
  try {
    h.injectSilentRunner();
    await h.stop('manual-selection');
    assert.equal(h.emissions.length, 0, 'an honest failure emits nothing — the UI must not say "Stopped"');

    h.fireExit(1);

    assert.equal(h.emissions.length, 1, 'exactly one terminal emission across the whole stop');
    assert.equal(h.emissions[0].status, 'done', "not 'crashed' — the exit was intentional");
    assert.equal(h.emissions[0].source, 'stop');
    assert.equal(h.agent.status, 'done');
    assert.deepEqual(
      h.transitions.filter((t) => t.stopReason !== null),
      [{ id: h.agent.id, status: 'done', stopReason: 'manual-selection' }],
      'one reasoned terminal write, attributed to the stop that asked for it',
    );
    const stopped = h.audit.filter((e) => e.type === 'stopped');
    assert.equal(stopped.length, 1);
    assert.match(String(stopped[0].payload), /late-runner-exit/);
    assert.equal(h.audit.some((e) => e.type === 'crashed'), false, 'no crash row for an intentional exit');
  } finally { h.cleanup(); }
});

test('a genuine crash with NO stop intent still auto-restarts (pre-existing behaviour preserved)', async () => {
  const h = setup();
  try {
    h.injectSilentRunner();
    assert.equal(h.intent(), null, 'setup: no stop was requested');

    h.fireExit(1);

    assert.deepEqual(h.autoRestarts, [h.agent.id], 'an unintended crash still auto-restarts');
    assert.equal(h.emissions.length, 1);
    assert.equal(h.emissions[0].status, 'crashed');
    assert.equal(h.emissions[0].source, 'runner-exit');
  } finally { h.cleanup(); }
});

test('a clean (exit-code 0) natural exit with no intent does not auto-restart but does emit done', async () => {
  const h = setup();
  try {
    h.injectSilentRunner();
    h.fireExit(0);
    assert.deepEqual(h.autoRestarts, []);
    assert.equal(h.emissions.length, 1);
    assert.equal(h.emissions[0].status, 'done');
    assert.equal(h.emissions[0].source, 'runner-exit');
  } finally { h.cleanup(); }
});

// ── The in-flight case: the stop path stays the single status authority ──────

test('an exit arriving DURING a stop does not double-emit — the stop writes the only status', async () => {
  const h = setup({}, 'terminated');
  try {
    const runner = h.injectSilentRunner();
    // A realistic kill: the pty host reports the exit through the same authority
    // the real runner's 'exit' listener calls.
    runner.kill = () => { setImmediate(() => h.fireExit(1)); };

    const r = await h.stop();

    assert.equal(r.outcome, 'stopped');
    assert.equal(h.emissions.length, 1, 'one emission, from the stop — not one from each path');
    assert.equal(h.emissions[0].source, 'stop');
    assert.deepEqual(h.autoRestarts, [], 'a killed runner exiting non-zero is not a crash');
    assert.equal(h.intent(), null, 'a clean stop clears its intent');
    assert.equal(h.audit.some((e) => e.type === 'crashed'), false);
  } finally { h.cleanup(); }
});

test('an already-terminal idempotent stop leaves no intent behind', async () => {
  const h = setup({ status: 'done' });
  try {
    const r = await h.stop();
    assert.equal(r.outcome, 'already_stopped');
    assert.equal(h.intent(), null);
  } finally { h.cleanup(); }
});

// ── Shutdown still wins ──────────────────────────────────────────────────────

test('a shutdown-time exit keeps the pre-quit status so reconcile() respawns it', async () => {
  const h = setup();
  try {
    h.injectSilentRunner();
    (h.supervisor as unknown as { shuttingDown: boolean }).shuttingDown = true;
    h.fireExit(1);
    assert.deepEqual(h.emissions, []);
    assert.equal(h.agent.status, 'working', 'status untouched at drain time');
    assert.deepEqual(h.autoRestarts, []);
    assert.equal(h.runnerMap().has(h.agent.id), false);
  } finally { h.cleanup(); }
});

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(e as Error).message}`);
    }
  }
  console.log(`\nlifecycle stop-intent: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
