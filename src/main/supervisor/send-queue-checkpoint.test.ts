// Git-Native WP-G1.7 — send-queue → before-checkpoint wiring tests.
//
//   npm run build:main
//   node dist/main/main/supervisor/send-queue-checkpoint.test.js
//
// Drives the REAL AgentSupervisor._deliverAndConfirm (via sendInput) with a fake
// checkpoint engine + an overridden _doSendInput, proving the WP-G1.7 send-path
// contract:
//   - the before-checkpoint runs BEFORE _doSendInput, and ONLY on submit;
//   - a checkpoint failure (thrown builder / thrown beforeCheckpoint) NEVER fails
//     delivery — the bytes are still sent and the outcome is delivered;
//   - a delivery reject (_doSendInput → false) closes the just-opened turn via
//     onDeliveryFailed (never left open);
//   - the DispatchContext supplied to sendInput is threaded into buildTurnContext.

import assert from 'node:assert/strict';
import { AgentSupervisor } from './index';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import type { Agent, AgentStatus } from '../../shared/types';
import type { DispatchContext } from '../git-checkpoints/dispatch-context';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function patchDb(agentsMap: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus',
    'updateAgentLastSendError', 'updateAgentLastSend', 'updateAgentPid',
    'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addFileActivity',
    'getTeamMembership', 'getCurrentBrick',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  db.updateAgentStatus = (id: string, status: AgentStatus) => { const a = agentsMap.get(id); if (a) a.status = status; };
  db.updateAgentHookStatus = () => {};
  db.updateAgentLastSendError = () => {};
  db.updateAgentLastSend = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.getTeamMembership = () => null;
  db.getCurrentBrick = () => null;
  patchApplyStatusTransition(db as unknown as Record<string, unknown>);
  return () => { for (const k of keys) db[k] = orig[k]; };
}

interface FakeEngine {
  order: string[];
  builtWith: (DispatchContext | undefined)[];
  deliveredValue: boolean;
  buildThrows: boolean;
  beforeThrows: boolean;
  onDeliveryFailedCalls: number;
  ctxToReturn: unknown;
  closeListener: ((event: { agentId: string; turnId: string; status: 'accepted'; afterQuality: 'idle-fallback' }) => void) | null;
}

function setup(opts: { alive?: boolean; deliveredValue?: boolean; buildThrows?: boolean; beforeThrows?: boolean } = {}) {
  const agent = makeAgent('cp-1', { provider: 'claude', status: 'idle', isSupervised: false, workingDirectory: 'C:\\tmp' });
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const restoreDb = patchDb(agentsMap);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ledger = require('../plans/package-ledger') as Record<string, unknown>;
  const originalRecordHandoffResult = ledger.recordHandoffResult;
  const handoffResults: Array<{ command: { resultKind: string; handoffAttemptId: string; kickoffTurnId?: string | null }; witness: { outcome: string; completionQuality?: string | null } }> = [];
  ledger.recordHandoffResult = (command: typeof handoffResults[number]['command'], witness: typeof handoffResults[number]['witness']) => {
    handoffResults.push({ command, witness });
  };

  const origWinLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  const origWslLaunch = (WslRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (this: WindowsRunner) {
    (this as unknown as { _pid: number; _alive: boolean })._pid = 1; (this as unknown as { _alive: boolean })._alive = true;
  };
  (WslRunner.prototype as { launch: unknown }).launch = async function (this: WslRunner) {
    (this as unknown as { _alive: boolean })._alive = true;
  };

  const supervisor = new AgentSupervisor();
  (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};

  const fake = new WindowsRunner();
  Object.defineProperty(fake, 'isAlive', { get: () => opts.alive !== false, configurable: true });
  (fake as unknown as { write: (d: string) => void }).write = () => {};
  (supervisor as unknown as { windowsRunners: Map<string, WindowsRunner> }).windowsRunners.set(agent.id, fake);

  const engine: FakeEngine = {
    order: [], builtWith: [], deliveredValue: opts.deliveredValue !== false,
    buildThrows: !!opts.buildThrows, beforeThrows: !!opts.beforeThrows,
    onDeliveryFailedCalls: 0,
    closeListener: null,
    ctxToReturn: { workspaceId: 'ws-1', agentId: agent.id, capability: {}, quality: 'guaranteed' },
  };
  const coordinator = {
    beforeCheckpoint: async (_id: string, _ctx: unknown) => {
      if (engine.beforeThrows) throw new Error('before-checkpoint blew up');
      engine.order.push('beforeCheckpoint');
      return { turnId: 't1', ready: true, quality: 'guaranteed', failureReason: null };
    },
    onDeliveryFailed: (_id: string) => { engine.order.push('onDeliveryFailed'); engine.onDeliveryFailedCalls++; return 't1'; },
    markCrashed: () => {}, markInterrupted: () => {}, markStopped: () => {},
    currentWitnessTarget: () => null,
    onTurnClosed: (listener: NonNullable<FakeEngine['closeListener']>) => { engine.closeListener = listener; return () => {}; },
    shutdown: async () => {},
  };
  const completionTracker = { noteStart: () => {}, noteIdle: () => {}, noteTerminalExit: () => {}, disposeAll: () => {} };
  (supervisor as unknown as { attachCheckpointEngine: (e: unknown) => void }).attachCheckpointEngine({
    coordinator, completionTracker,
    buildTurnContext: async (_id: string, dispatch: DispatchContext) => {
      engine.builtWith.push(dispatch);
      if (engine.buildThrows) throw new Error('build blew up');
      return engine.ctxToReturn;
    },
  });

  // Override the pure-delivery step so ordering is observable and no PTY is needed.
  (supervisor as unknown as { _doSendInput: (id: string, t: string, s: boolean) => Promise<boolean> })._doSendInput =
    async (_id: string, _t: string, _s: boolean) => { engine.order.push('doSendInput'); return engine.deliveredValue; };
  // Stub confirmation so the send resolves without wall-clock polling.
  (supervisor as unknown as { awaitSendConfirmation: (...a: unknown[]) => Promise<string | null> }).awaitSendConfirmation =
    async () => 'session-log';

  return {
    supervisor, engine, agent, handoffResults,
    cleanup: () => {
      (WindowsRunner.prototype as { launch: unknown }).launch = origWinLaunch;
      (WslRunner.prototype as { launch: unknown }).launch = origWslLaunch;
      ledger.recordHandoffResult = originalRecordHandoffResult;
      restoreDb();
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────────────

test('before-checkpoint runs BEFORE _doSendInput on a submit', async () => {
  const h = setup();
  try {
    await h.supervisor.sendInput(h.agent.id, 'hi', { submit: true });
    assert.deepEqual(h.engine.order, ['beforeCheckpoint', 'doSendInput'],
      'the before-snapshot must precede any PTY byte');
  } finally { h.cleanup(); }
});

test('before-checkpoint is SKIPPED on a non-submit (submit:false)', async () => {
  const h = setup();
  try {
    await h.supervisor.sendInput(h.agent.id, 'prefill', { submit: false });
    assert.deepEqual(h.engine.order, ['doSendInput'], 'no checkpoint without a submit');
    assert.equal(h.engine.builtWith.length, 0, 'the turn context is not even built without a submit');
  } finally { h.cleanup(); }
});

test('a thrown context-build does NOT fail delivery (fail open)', async () => {
  const h = setup({ buildThrows: true });
  try {
    const delivered = await h.supervisor.sendInput(h.agent.id, 'hi', { submit: true });
    assert.equal(delivered, true, 'bytes still delivered despite the checkpoint failure');
    assert.deepEqual(h.engine.order, ['doSendInput']);
  } finally { h.cleanup(); }
});

test('a thrown beforeCheckpoint does NOT fail delivery (fail open)', async () => {
  const h = setup({ beforeThrows: true });
  try {
    const delivered = await h.supervisor.sendInput(h.agent.id, 'hi', { submit: true });
    assert.equal(delivered, true);
    assert.deepEqual(h.engine.order, ['doSendInput'], 'delivery proceeds even when the snapshot throws');
  } finally { h.cleanup(); }
});

test('a delivery reject closes the opened turn via onDeliveryFailed', async () => {
  const h = setup({ deliveredValue: false });
  try {
    const outcome = await h.supervisor.sendInputWithOutcome(h.agent.id, 'hi', { submit: true });
    assert.equal(outcome.disposition, 'failed');
    assert.equal(h.engine.onDeliveryFailedCalls, 1, 'the just-opened turn is closed delivery_failed');
    assert.deepEqual(h.engine.order, ['beforeCheckpoint', 'doSendInput', 'onDeliveryFailed']);
  } finally { h.cleanup(); }
});

test('the DispatchContext is threaded into buildTurnContext', async () => {
  const h = setup();
  try {
    const dispatch: DispatchContext = { origin: 'orchestration', ownerAgentId: 'sup-9', taskLabel: 'ship it' };
    await h.supervisor.sendInput(h.agent.id, 'hi', { submit: true }, dispatch);
    assert.equal(h.engine.builtWith.length, 1);
    assert.deepEqual(h.engine.builtWith[0], dispatch);
  } finally { h.cleanup(); }
});

test('no dispatch → defaults to a human-terminal context', async () => {
  const h = setup();
  try {
    await h.supervisor.sendInput(h.agent.id, 'hi', { submit: true });
    assert.equal(h.engine.builtWith[0]?.origin, 'human-terminal');
  } finally { h.cleanup(); }
});

test('attempt-correlated kickoff records successor_oriented only when its exact checkpoint turn completes', async () => {
  const h = setup();
  try {
    const priv = h.supervisor as unknown as {
      beginContinuationOrientation(id: string, c: { attemptId: string; successorSessionId: string }): void;
    };
    priv.beginContinuationOrientation(h.agent.id, { attemptId: 'att-oriented', successorSessionId: 'sess-new' });
    await h.supervisor.sendInput(h.agent.id, 'orientation kickoff', { submit: true });
    assert.equal(h.handoffResults.length, 0, 'delivery/start confirmation is not orientation completion');

    h.engine.closeListener?.({
      agentId: h.agent.id, turnId: 'some-other-turn', status: 'accepted', afterQuality: 'idle-fallback',
    });
    assert.equal(h.handoffResults.length, 0, 'an unrelated terminal turn cannot satisfy the handoff');

    h.engine.closeListener?.({
      agentId: h.agent.id, turnId: 't1', status: 'accepted', afterQuality: 'idle-fallback',
    });
    assert.deepEqual(h.handoffResults.map((r) => [
      r.command.resultKind, r.command.handoffAttemptId, r.command.kickoffTurnId,
      r.witness.outcome, r.witness.completionQuality,
    ]), [['successor_oriented', 'att-oriented', 't1', 'succeeded', 'idle-fallback']]);
  } finally { h.cleanup(); }
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
