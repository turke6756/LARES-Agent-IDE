// Slice 2 §4.3/§4.7 — the main-process phase AUTHORITY and the launch tail.
//
// Two things are pinned here, both of them load-bearing for the fix:
//
//   1. `publishContinuationPhase` is the single writer of the in-memory map the
//      renderer hydrates from, and `phase: null` DELETES rather than storing a
//      null — a hydration after completion must show nothing, not a stale label.
//      The map is deliberately NOT a DB table (§6): phases must survive a
//      renderer reload, not a main restart.
//   2. The launch tail is THE completion point (§2.4). Relaunch-ok only means
//      the route accepted; the tail is detached and can still fail and crash the
//      agent. So: tail success → clear; tail throw → a PERSISTENT `failed`
//      carrying the launch error (no automatic retry exists from there, which is
//      exactly what distinguishes `failed` from `backoff`).
//
//   npm run build:main
//   node dist/main/main/supervisor/continuation-phase-authority.test.js

import assert from 'node:assert/strict';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import type { Agent, AgentStatus, ContinuationPhaseSignal, ContinuationPhaseState } from '../../shared/types';
import type { AgentSupervisor as AgentSupervisorType } from './index';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSupervisor } = require('./index') as { AgentSupervisor: new () => AgentSupervisorType };

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function patchDb(agentsMap: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'getAgent', 'addEvent', 'getActiveAgents', 'getAllAgents',
    // The tail's failure path emits statusChanged, which the event bridge picks
    // up and fans out through these reads. Stub them so the failure test is not
    // buried in "no DB" noise from an unrelated subsystem.
    'getSupervisorAgent', 'getOwnerForWorker', 'getFileActivities',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  db.getSupervisorAgent = () => null;
  db.getOwnerForWorker = () => null;
  db.getFileActivities = () => [];
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  patchApplyStatusTransition(db);
  return () => { for (const k of keys) db[k] = orig[k]; };
}

interface Harness {
  supervisor: AgentSupervisorType;
  agent: Agent;
  signals: ContinuationPhaseSignal[];
  cleanup(): void;
}

function setup(): Harness {
  const agent = makeAgent('sup-phase-1', { status: 'restarting' });
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const restoreDb = patchDb(agentsMap);
  const supervisor = new AgentSupervisor();
  const priv = supervisor as unknown as Record<string, unknown>;
  priv.writeAgentRegistry = () => {};
  priv.releaseChatRing = () => {};
  const signals: ContinuationPhaseSignal[] = [];
  supervisor.on('continuationPhaseChanged', (s: ContinuationPhaseSignal) => { signals.push(s); });
  return { supervisor, agent, signals, cleanup: () => { restoreDb(); } };
}

/** Read the private map directly. `listContinuationPhases` is the read the
 *  renderer uses, but an ABSENCE assertion has to go under it: a future
 *  allocating accessor would make "not listed" vacuously true. */
function rawPhases(supervisor: AgentSupervisorType): Map<string, ContinuationPhaseState> {
  return (supervisor as unknown as { continuationPhases: Map<string, ContinuationPhaseState> }).continuationPhases;
}

/** Drive the private launch tail with `launchWindowsAgent` stubbed, then wait
 *  out its 1 s timer plus the awaited launch. */
async function runLaunchTail(
  h: Harness,
  launch: () => Promise<void>,
): Promise<void> {
  const priv = h.supervisor as unknown as Record<string, unknown>;
  priv.launchWindowsAgent = launch;
  priv.launchWslAgent = launch;
  priv.notifyTerminalRebound = () => {};
  (priv.continuationLaunchTail as (id: string, s: string) => void).call(h.supervisor, h.agent.id, 'sess-new');
  // The tail is a detached setTimeout(…, 1000); give it room to run to its
  // finally block.
  await new Promise((r) => setTimeout(r, 1400));
}

// ── The authority map ─────────────────────────────────────────────────

test('publishContinuationPhase stores, overwrites, and broadcasts every signal', () => {
  const h = setup();
  try {
    h.supervisor.publishContinuationPhase({ agentId: 'a', phase: 'queued', updatedAt: 1 });
    h.supervisor.publishContinuationPhase({ agentId: 'a', phase: 'awaiting-note', attemptId: 'att-1', updatedAt: 2 });
    h.supervisor.publishContinuationPhase({ agentId: 'b', phase: 'opening', updatedAt: 3 });

    const listed = h.supervisor.listContinuationPhases();
    assert.equal(listed.length, 2, 'one entry per agent — later signals overwrite');
    const a = listed.find((p) => p.agentId === 'a')!;
    assert.equal(a.phase, 'awaiting-note');
    assert.equal(a.attemptId, 'att-1');
    assert.equal(h.signals.length, 3, 'every signal is broadcast, including overwrites');
  } finally { h.cleanup(); }
});

test('phase:null DELETES the entry (hydration after completion must show nothing)', () => {
  const h = setup();
  try {
    h.supervisor.publishContinuationPhase({ agentId: 'a', phase: 'launching', updatedAt: 1 });
    h.supervisor.publishContinuationPhase({ agentId: 'a', phase: null });
    // Asserted against the raw map, not the accessor.
    assert.equal(rawPhases(h.supervisor).has('a'), false, 'the entry is deleted, not stored as null');
    assert.deepEqual(h.supervisor.listContinuationPhases(), []);
    assert.deepEqual(h.signals[h.signals.length - 1], { agentId: 'a', phase: null },
      'the clear is still broadcast so live windows drop the label');
  } finally { h.cleanup(); }
});

test('a clear for an agent with no phase is a harmless no-op broadcast', () => {
  const h = setup();
  try {
    h.supervisor.publishContinuationPhase({ agentId: 'ghost', phase: null });
    assert.deepEqual(h.supervisor.listContinuationPhases(), []);
    assert.equal(h.signals.length, 1);
  } finally { h.cleanup(); }
});

// ── The launch tail is the completion point ───────────────────────────

test('launch tail SUCCESS clears the phase (and only after the launch resolves)', async () => {
  const h = setup();
  try {
    h.supervisor.publishContinuationPhase({ agentId: h.agent.id, phase: 'launching', updatedAt: 1 });
    let launchResolved = false;
    await runLaunchTail(h, async () => {
      // While the launch is still in flight the label must still be up — that
      // is the last and most failure-prone second of the whole cycle.
      assert.equal(rawPhases(h.supervisor).has(h.agent.id), true,
        'the phase must survive until the launch actually resolves');
      launchResolved = true;
    });
    assert.equal(launchResolved, true, 'the stub launch ran');
    assert.equal(rawPhases(h.supervisor).has(h.agent.id), false, 'success clears the phase');
    assert.deepEqual(h.signals[h.signals.length - 1], { agentId: h.agent.id, phase: null });
  } finally { h.cleanup(); }
});

test('launch tail CATCH sets a persistent `failed` carrying the launch error', async () => {
  const h = setup();
  try {
    h.supervisor.publishContinuationPhase({ agentId: h.agent.id, phase: 'launching', updatedAt: 1 });
    await runLaunchTail(h, async () => { throw new Error('claude CLI not found on PATH'); });

    const state = rawPhases(h.supervisor).get(h.agent.id);
    assert.ok(state, 'the failure must leave a phase behind — a blank card IS the original bug');
    assert.equal(state!.phase, 'failed');
    assert.equal(state!.message, 'claude CLI not found on PATH',
      'the card shows WHY, so the next field report is diagnosable');
    // `failed` is persistent BY DESIGN: unlike `backoff` there is no automatic
    // retry from here, so nothing clears it until the human acts.
    assert.deepEqual(h.supervisor.listContinuationPhases().map((p) => p.phase), ['failed']);
    assert.equal(h.signals.some((s) => s.phase === null), false,
      'a failed tail must NOT emit the completion clear');
  } finally { h.cleanup(); }
});

test('a later force replaces a persistent `failed` (it is not a permanent wedge)', async () => {
  const h = setup();
  try {
    await runLaunchTail(h, async () => { throw new Error('boom'); });
    assert.equal(rawPhases(h.supervisor).get(h.agent.id)?.phase, 'failed');
    // The watcher's next `queued` publish is an ordinary overwrite.
    h.supervisor.publishContinuationPhase({ agentId: h.agent.id, phase: 'queued', updatedAt: 99 });
    assert.equal(rawPhases(h.supervisor).get(h.agent.id)?.phase, 'queued');
  } finally { h.cleanup(); }
});

// ── Runner ───────────────────────────────────────────────────────────

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
