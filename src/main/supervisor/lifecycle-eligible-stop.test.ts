// Idle-agent lifecycle §B6.1 — the TOCTOU-free eligible stop.
//
// Covers:
//   - ineligible → 'skipped' carrying the exclusion codes, and NO stop runs;
//   - 'not_found' comes back as its own per-agent result, not as 'skipped';
//   - explicit mode + active warnings + confirmActive !== true → 'skipped' with
//     the WARNINGS as codes (the flag GATES execution, it is not merely
//     carried), and the same request with confirmActive:true stops;
//   - an honest §B5 'failed' stop surfaces as a per-agent 'failed', never
//     silently as 'stopped';
//   - guards are evaluated INSIDE the lock (the snapshot is assembled while the
//     lock is held) and the agent's OWN lock never excludes it.
//
//   npm run build:main
//   node dist/main/main/supervisor/lifecycle-eligible-stop.test.js

import assert from 'node:assert/strict';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import type { Agent, AgentStatus, BulkStopItemResult } from '../../shared/types';
import type { GuardDeps } from '../lifecycle/guards';
import type { AgentSupervisor as AgentSupervisorType } from './index';

process.env.DASHBOARD_STOP_RUNNER_WAIT_MS = '60';
process.env.DASHBOARD_STOP_WSL_RUNNER_WAIT_MS = '60';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSupervisor } = require('./index') as { AgentSupervisor: new () => AgentSupervisorType };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WindowsRunner } = require('./windows-runner') as { WindowsRunner: new () => FakeRunner };

interface FakeRunner {
  kill(): void;
  emit(ev: string, ...args: unknown[]): boolean;
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const AGENT = 'agent-eligible-1';
const HOUR = 60 * 60 * 1000;

function patchDb(agentsMap: Map<string, Agent>, audit: Array<{ agentId: string; type: string }>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'getAgent', 'addEvent',
    'updateAgentExitCode', 'updateAgentLastOutput', 'getActiveAgents',
    'getAllAgents', 'getSupervisorAgent', 'incrementRestartCount', 'getAgentsByOwner',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = (agentId: string, type: string) => { audit.push({ agentId, type }); };
  db.updateAgentExitCode = () => {};
  db.updateAgentLastOutput = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.incrementRestartCount = () => {};
  db.getAgentsByOwner = () => [];
  patchApplyStatusTransition(db);
  return () => { for (const k of keys) db[k] = orig[k]; };
}

interface Harness {
  supervisor: AgentSupervisorType;
  agent: Agent;
  /** Records the selfLockedAgent + lock state seen by the guard assembly. */
  observed: { selfLockSeen: boolean; lockedDuringAssembly: boolean | null };
  stopCalls: string[];
  injectRunner(opts: { confirmsExit: boolean }): void;
  setGuards(over: Partial<GuardDeps>): void;
  run(mode: 'explicit' | 'stale-idle', opts?: { staleThresholdMs?: number | null; confirmActive?: boolean }): Promise<BulkStopItemResult>;
  cleanup(): void;
}

function setup(over: Partial<Agent> = {}, ownership: 'terminated' | 'unverifiable' = 'terminated'): Harness {
  const agent = makeAgent(AGENT, { status: 'idle', ...over });
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const audit: Array<{ agentId: string; type: string }> = [];
  const restoreDb = patchDb(agentsMap, audit);

  const supervisor = new AgentSupervisor();
  const priv = supervisor as unknown as Record<string, unknown>;
  priv.writeAgentRegistry = () => {};
  priv.releaseChatRing = () => {};
  priv.releaseSpoolTailer = () => {};
  priv.ownership = {
    getOwnership: () => ({ agentId: agent.id, transport: 'conpty', tmuxSession: null }),
    verifyStopOwnership: () => ({ kind: ownership === 'terminated' ? 'verified-job' : 'unverifiable' }),
    reapViaJob: () => ({ action: ownership, pids: [] }),
    reapViaTreeWalk: () => ({ action: ownership, pids: [] }),
    deleteOwnership: () => {},
  };
  priv.processLister = { list: async () => [] };

  const observed = { selfLockSeen: false, lockedDuringAssembly: null as boolean | null };
  const stopCalls: string[] = [];
  const origStop = priv.stopAgentLocked as (id: string, o?: unknown) => Promise<unknown>;
  priv.stopAgentLocked = function patched(id: string, o?: unknown) {
    stopCalls.push(id);
    return origStop.call(supervisor, id, o);
  };

  const idleSince = new Date(Date.now() - 48 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
  let guards: GuardDeps = {
    getAgent: (id) => ({ id, status: agentsMap.get(id)?.status ?? 'idle', idleSince }),
    getLiveChildren: () => [],
    activeOrchestrationIds: () => [],
    hasPendingDelivery: () => false,
    isContinuationInFlight: () => false,
    isLifecycleLocked: (id) => supervisor.isLifecycleLocked(id),
    hasLiveRunner: () => true,
    verifyStopOwnership: () => ({ kind: 'verified-job' }),
    getAgentBrowserState: (id) => ({
      agentId: id, tabCount: 0, loading: false, signinPending: false,
      needsHumanAttention: false, pendingDownload: false, activeLease: false,
    }),
    now: () => Date.now(),
  };
  // The real guardDeps getter reads live DB rows; swap in a controllable set so
  // each guard can be exercised in isolation. The LOCK reading stays real.
  Object.defineProperty(supervisor, 'guardDeps', {
    configurable: true,
    get: () => ({
      ...guards,
      isLifecycleLocked: (id: string) => {
        const locked = guards.isLifecycleLocked(id);
        observed.lockedDuringAssembly = locked;
        return locked;
      },
    }),
  });

  return {
    supervisor,
    agent,
    observed,
    stopCalls,
    injectRunner: ({ confirmsExit }) => {
      const fake = new WindowsRunner();
      Object.defineProperty(fake, 'isAlive', { get: () => true, configurable: true });
      fake.kill = () => { if (confirmsExit) setImmediate(() => fake.emit('exit', 0, null)); };
      (priv.windowsRunners as Map<string, unknown>).set(agent.id, fake);
    },
    setGuards: (o) => { guards = { ...guards, ...o }; },
    run: (mode, opts) => supervisor.stopIfEligibleLocked(agent.id, mode, mode === 'explicit' ? 'manual-selection' : 'automatic-stale-idle', opts),
    cleanup: () => { restoreDb(); },
  };
}

// ── Skips ────────────────────────────────────────────────────────────────────

test('an ineligible stale-idle agent is SKIPPED with its exclusion codes and no stop runs', async () => {
  const h = setup();
  try {
    h.setGuards({ hasPendingDelivery: () => true });
    const r = await h.run('stale-idle', { staleThresholdMs: 24 * HOUR });
    assert.equal(r.result, 'skipped');
    assert.deepEqual(r.codes, ['pending_delivery']);
    assert.deepEqual(h.stopCalls, [], 'nothing was stopped');
    assert.equal(h.agent.status, 'idle');
  } finally { h.cleanup(); }
});

test("a missing agent comes back as 'not_found', not 'skipped'", async () => {
  const h = setup();
  try {
    h.setGuards({ getAgent: () => null });
    const r = await h.run('stale-idle', { staleThresholdMs: 24 * HOUR });
    assert.equal(r.result, 'not_found');
    assert.deepEqual(r.codes, ['not_found']);
    assert.deepEqual(h.stopCalls, []);
  } finally { h.cleanup(); }
});

test('stale-idle: a guard-unavailable agent is never auto-stopped', async () => {
  const h = setup();
  try {
    h.setGuards({ getAgentBrowserState: () => null });
    const r = await h.run('stale-idle', { staleThresholdMs: 24 * HOUR });
    assert.equal(r.result, 'skipped');
    assert.deepEqual(r.codes, ['guard_unavailable']);
  } finally { h.cleanup(); }
});

// ── confirmActive gates EXECUTION ────────────────────────────────────────────

test('explicit + warnings + confirmActive !== true → skipped with the warnings as codes', async () => {
  const h = setup({ status: 'working' });
  try {
    h.injectRunner({ confirmsExit: true });
    const r = await h.run('explicit');
    assert.equal(r.result, 'skipped', 'the flag GATES execution — it is not merely carried through');
    assert.deepEqual(r.codes, ['not_idle']);
    assert.deepEqual(h.stopCalls, []);
    assert.equal(h.agent.status, 'working', 'the agent is untouched');
  } finally { h.cleanup(); }
});

test('explicit + warnings + confirmActive:true → the stop runs', async () => {
  const h = setup({ status: 'working' });
  try {
    h.injectRunner({ confirmsExit: true });
    const r = await h.run('explicit', { confirmActive: true });
    assert.equal(r.result, 'stopped');
    assert.deepEqual(r.codes, []);
    assert.deepEqual(h.stopCalls, [AGENT]);
    assert.equal(h.agent.status, 'done');
  } finally { h.cleanup(); }
});

test('explicit with NO active guards stops without any confirmation', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    const r = await h.run('explicit');
    assert.equal(r.result, 'stopped');
    assert.equal(r.outcome, 'stopped');
  } finally { h.cleanup(); }
});

// ── Honest failure ───────────────────────────────────────────────────────────

test("an honest §B5 'failed' stop surfaces as a per-agent 'failed', never as 'stopped'", async () => {
  const h = setup({ status: 'working' }, 'unverifiable');
  try {
    h.injectRunner({ confirmsExit: false }); // never confirms → escalation → unverifiable
    const r = await h.run('explicit', { confirmActive: true });
    assert.equal(r.result, 'failed');
    assert.equal(r.outcome, 'failed');
    assert.equal(h.agent.status, 'working', 'the UI must never say "Stopped" over a live process');
  } finally { h.cleanup(); }
});

// ── The lock ─────────────────────────────────────────────────────────────────

test("the agent's OWN lifecycle lock does not exclude it (selfLockedAgent)", async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    const r = await h.run('stale-idle', { staleThresholdMs: 24 * HOUR });
    assert.equal(h.observed.lockedDuringAssembly, true,
      'sanity: the guard assembly really did run while this agent held the lock');
    assert.equal(r.result, 'stopped', 'and it was NOT excluded as lifecycle_busy');
  } finally { h.cleanup(); }
});

test('a concurrent eligible stop serializes — the second finds the agent already stopped', async () => {
  const h = setup();
  try {
    h.injectRunner({ confirmsExit: true });
    const [a, b] = await Promise.all([
      h.run('stale-idle', { staleThresholdMs: 24 * HOUR }),
      h.run('stale-idle', { staleThresholdMs: 24 * HOUR }),
    ]);
    const results = [a.result, b.result].sort();
    assert.deepEqual(results, ['skipped', 'stopped'],
      'the second pass sees status done → not_idle, so it skips instead of double-stopping');
    assert.equal(h.agent.status, 'done');
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
  console.log(`\nlifecycle eligible-stop: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
