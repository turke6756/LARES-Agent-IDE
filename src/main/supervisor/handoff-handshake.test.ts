// Worker handoff handshake tests.
//
// Covers the three new surfaces:
//   1. event-payload-builder rendering for `handoff_failed` / `worker_stalled`
//      (single + consolidated digests).
//   2. EventBridge.onHandoffFailed / onWorkerStalled gating (supervised-only,
//      live-supervisor-only) and delivery payload.
//   3. StatusMonitor.checkWorkerStalled — fires once per working stretch when
//      every signal (raw PTY, hook, input) is older than WORKER_STALL_WARN_MS;
//      re-arms when the agent leaves `working` or a signal goes fresh.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/handoff-handshake.test.js

import assert from 'node:assert/strict';
import { buildEventPayload, buildConsolidatedPayload, SupervisorEvent } from './event-payload-builder';
import { EventBridge, EventBridgeDeps } from './event-bridge';
import { StatusMonitor } from './status-monitor';
import { AgentSupervisor } from './index';
import { WORKER_STALL_WARN_MS, CONFIRM_WINDOW_FIRST_MS } from '../../shared/constants';
import { Agent } from '../../shared/types';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'w-handoff-1',
    workspaceId: 'ws-1',
    title: 'Worker One',
    roleDescription: '',
    workingDirectory: 'C:\\ws\\.dashboard\\workers\\claude',
    command: 'claude',
    provider: 'claude',
    status: 'working',
    isSupervisor: false,
    isSupervised: true,
    isWorker: true,
    ...overrides,
  } as unknown as Agent;
}

function makeSupervisorAgent(): Agent {
  return makeAgent({
    id: 'sup-1',
    title: 'Supervisor',
    isSupervisor: true,
    isSupervised: false,
    isWorker: false,
    status: 'idle',
  });
}

// ── 1. Payload rendering ─────────────────────────────────────────────────

test('handoff_failed payload has distinct header + recovery guidance', () => {
  const event: SupervisorEvent = {
    type: 'handoff_failed',
    agentId: 'w-handoff-1-long-id',
    agentTitle: 'Worker One',
    workspaceId: 'ws-1',
    handoffAttempts: 3,
    failureMessage: 'Submit not confirmed after 3 re-press attempts',
  };
  const text = buildEventPayload(event);
  assert.ok(text.startsWith('[DASHBOARD EVENT] Worker handoff FAILED'), text);
  assert.ok(text.includes('re-pressed 3x'), 'attempt count rendered');
  assert.ok(text.includes('NOT working'), 'explicit not-working framing');
  assert.ok(text.includes('send_keys_to_agent'), 'recovery guidance present');
});

test('worker_stalled payload renders minutes + guidance', () => {
  const event: SupervisorEvent = {
    type: 'worker_stalled',
    agentId: 'w-handoff-1-long-id',
    agentTitle: 'Worker One',
    workspaceId: 'ws-1',
    stalledForMs: 17 * 60 * 1000,
  };
  const text = buildEventPayload(event);
  assert.ok(text.startsWith('[DASHBOARD EVENT] Worker appears stalled'), text);
  assert.ok(text.includes('~17 min'), 'minutes rendered');
  assert.ok(text.includes('read_agent_log'), 'guidance present');
});

test('consolidated digest lines for both new types', () => {
  const base = { agentId: 'w-handoff-1-long-id', agentTitle: 'Worker One', workspaceId: 'ws-1' };
  const text = buildConsolidatedPayload([
    { ...base, type: 'handoff_failed' },
    { ...base, type: 'worker_stalled', stalledForMs: 20 * 60 * 1000 },
  ]);
  assert.ok(text.includes('handoff FAILED'), text);
  assert.ok(text.includes('stalled — working ~20 min'), text);
});

// ── 2. EventBridge gating + delivery ─────────────────────────────────────

interface BridgeHarness {
  bridge: EventBridge;
  delivered: Array<{ supervisorId: string; text: string }>;
}

function makeBridge(agents: Record<string, Agent>, supervisor: Agent | null): BridgeHarness {
  const delivered: Array<{ supervisorId: string; text: string }> = [];
  const deps: EventBridgeDeps = {
    getAgent: (id: string) => agents[id] ?? null,
    getSupervisorForWorker: () => supervisor,
    sendInput: async (supervisorId: string, text: string) => { delivered.push({ supervisorId, text }); },
    addAuditEvent: () => {},
    getAgentLog: async () => 'log tail line',
    getContextStats: () => null,
    now: () => Date.now(),
    scheduleDrain: (_ms: number, fn: () => void) => { fn(); return { cancel: () => {} }; },
    statusMonitor: {
      forceWorking: () => {},
      forceIdle: () => {},
      forceWaiting: () => {},
    } as unknown as EventBridgeDeps['statusMonitor'],
    getLastUserPtyWriteAt: () => undefined,
    getLastAssistantMessage: async () => undefined,
    getFileActivities: () => [],
  };
  return { bridge: new EventBridge(deps), delivered };
}

test('onHandoffFailed delivers to a live supervisor for a supervised worker', async () => {
  const worker = makeAgent();
  const supervisor = makeSupervisorAgent();
  // deliver() re-fetches the supervisor by id, so it must be resolvable.
  const h = makeBridge({ [worker.id]: worker, [supervisor.id]: supervisor }, supervisor);
  await h.bridge.onHandoffFailed({ agent: worker, attempts: 3, message: 'no hook' });
  assert.equal(h.delivered.length, 1, 'exactly one delivery');
  assert.equal(h.delivered[0].supervisorId, supervisor.id);
  assert.ok(h.delivered[0].text.includes('Worker handoff FAILED'), h.delivered[0].text);
});

test('onHandoffFailed is a no-op for unsupervised agents', async () => {
  const worker = makeAgent({ isSupervised: false });
  const h = makeBridge({ [worker.id]: worker }, makeSupervisorAgent());
  await h.bridge.onHandoffFailed({ agent: worker, attempts: 3, message: 'no hook' });
  assert.equal(h.delivered.length, 0);
});

test('onWorkerStalled delivers; no-op when supervisor is crashed', async () => {
  const worker = makeAgent();
  const liveSupervisor = makeSupervisorAgent();
  const liveHarness = makeBridge(
    { [worker.id]: worker, [liveSupervisor.id]: liveSupervisor },
    liveSupervisor,
  );
  await liveHarness.bridge.onWorkerStalled({ agent: worker, stalledForMs: 16 * 60 * 1000 });
  assert.equal(liveHarness.delivered.length, 1);
  assert.ok(liveHarness.delivered[0].text.includes('Worker appears stalled'));

  const crashedSupervisor = { ...makeSupervisorAgent(), status: 'crashed' } as Agent;
  const deadHarness = makeBridge({ [worker.id]: worker }, crashedSupervisor);
  await deadHarness.bridge.onWorkerStalled({ agent: worker, stalledForMs: 16 * 60 * 1000 });
  assert.equal(deadHarness.delivered.length, 0);
});

// ── 3. StatusMonitor stall watchdog ──────────────────────────────────────

interface MonitorHarness {
  monitor: StatusMonitor;
  now: { value: number };
  rawOutputAt: { value: number };
  stalls: Array<{ agentId: string; stalledForMs: number }>;
}

function makeMonitor(): MonitorHarness {
  const now = { value: 1_000_000_000 };
  const rawOutputAt = { value: 0 };
  const monitor = new StatusMonitor(
    async () => true,
    () => rawOutputAt.value,           // meaningful burst
    () => null,
    () => now.value,
    () => '',
    () => rawOutputAt.value,           // raw output
  );
  const stalls: Array<{ agentId: string; stalledForMs: number }> = [];
  monitor.setWorkerStalledHandler((agent, stalledForMs) => {
    stalls.push({ agentId: agent.id, stalledForMs });
  });
  return { monitor, now, rawOutputAt, stalls };
}

type MonitorPrivate = { checkWorkerStalled(agent: Agent): void };

test('stall fires once when working with all signals older than threshold', () => {
  const h = makeMonitor();
  const agent = makeAgent({ status: 'working' });
  h.rawOutputAt.value = h.now.value;

  // Fresh signal — no stall.
  (h.monitor as unknown as MonitorPrivate).checkWorkerStalled(agent);
  assert.equal(h.stalls.length, 0, 'fresh signal must not stall');

  // Cross the threshold — fires exactly once across repeated polls.
  h.now.value += WORKER_STALL_WARN_MS + 60_000;
  (h.monitor as unknown as MonitorPrivate).checkWorkerStalled(agent);
  (h.monitor as unknown as MonitorPrivate).checkWorkerStalled(agent);
  assert.equal(h.stalls.length, 1, 'one-shot per working stretch');
  assert.equal(h.stalls[0].agentId, agent.id);
  assert.ok(h.stalls[0].stalledForMs >= WORKER_STALL_WARN_MS);
});

test('fresh PTY output re-arms; leaving working re-arms', () => {
  const h = makeMonitor();
  const agent = makeAgent({ status: 'working' });
  const priv = h.monitor as unknown as MonitorPrivate;
  h.rawOutputAt.value = h.now.value;

  h.now.value += WORKER_STALL_WARN_MS + 1_000;
  priv.checkWorkerStalled(agent);
  assert.equal(h.stalls.length, 1);

  // Output resumes → warned flag clears; a later stall fires again.
  h.rawOutputAt.value = h.now.value;
  priv.checkWorkerStalled(agent);
  h.now.value += WORKER_STALL_WARN_MS + 1_000;
  priv.checkWorkerStalled(agent);
  assert.equal(h.stalls.length, 2, 're-armed after fresh signal');

  // Leaving working also re-arms.
  priv.checkWorkerStalled(makeAgent({ status: 'idle' }));
  h.rawOutputAt.value = 1; // ancient but non-zero
  priv.checkWorkerStalled(agent);
  assert.equal(h.stalls.length, 3, 're-armed after leaving working');
});

test('non-worker agents and zero-signal agents are skipped', () => {
  const h = makeMonitor();
  const priv = h.monitor as unknown as MonitorPrivate;
  h.now.value += WORKER_STALL_WARN_MS * 2;

  h.rawOutputAt.value = 1; // ancient
  priv.checkWorkerStalled(makeAgent({ isSupervised: false, isWorker: false, status: 'working' }));
  assert.equal(h.stalls.length, 0, 'non-worker-lane agents skipped (inference covers them)');

  h.rawOutputAt.value = 0; // no reference point at all
  priv.checkWorkerStalled(makeAgent({ status: 'working' }));
  assert.equal(h.stalls.length, 0, 'no signal reference → no guess');
});

test('hook event freshness suppresses the stall', () => {
  const h = makeMonitor();
  const priv = h.monitor as unknown as MonitorPrivate;
  const agent = makeAgent({ status: 'working' });
  h.rawOutputAt.value = 1; // ancient PTY
  h.now.value += WORKER_STALL_WARN_MS * 2;
  // A recent hook event (e.g. UserPromptSubmit just fired) counts as signal.
  h.monitor.recordHookEventAt(agent.id, h.now.value - 1_000);
  priv.checkWorkerStalled(agent);
  assert.equal(h.stalls.length, 0, 'fresh hook event must suppress stall');
});

// ── 4. sendInputConfirmed delivery gate + constants invariant ────────────

/** Constructor-free AgentSupervisor: the surfaces under test only touch
 *  `monitor.getLastStartHookEventAt` and `sendInput`, both stubbed, so we
 *  skip the constructor's runner/bridge/DB wiring entirely. */
function makeConfirmSeam(opts: {
  delivered: boolean;
  /** Sequential return values for getLastStartHookEventAt (baseline first). */
  startHookAts: Array<number | undefined>;
}): { sup: AgentSupervisor; sendInputCalls: number[] } {
  const sup = Object.create(AgentSupervisor.prototype) as AgentSupervisor;
  let hookCall = 0;
  (sup as unknown as { monitor: { getLastStartHookEventAt: (id: string) => number | undefined } }).monitor = {
    getLastStartHookEventAt: () => {
      const v = opts.startHookAts[Math.min(hookCall, opts.startHookAts.length - 1)];
      hookCall++;
      return v;
    },
  };
  const sendInputCalls: number[] = [];
  (sup as unknown as { sendInput: (id: string, text: string) => Promise<boolean> }).sendInput =
    async () => { sendInputCalls.push(1); return opts.delivered; };
  return { sup, sendInputCalls };
}

test('sendInputConfirmed rejects with code delivery-failed when delivery is false', async () => {
  const { sup, sendInputCalls } = makeConfirmSeam({ delivered: false, startHookAts: [0] });
  await assert.rejects(
    () => sup.sendInputConfirmed('w-dead-1', 'hello'),
    (err: unknown) => {
      const e = err as Error & { code?: string };
      assert.equal(e.code, 'delivery-failed', `expected code 'delivery-failed'; got ${String(e.code)}`);
      assert.ok(e.message.includes('w-dead-1'), `message must name the agent; got: ${e.message}`);
      assert.ok(/NO bytes were typed/i.test(e.message), `message must state nothing was typed; got: ${e.message}`);
      return true;
    },
  );
  assert.equal(sendInputCalls.length, 1, 'exactly one send attempt — no confirm poll on failed delivery');
});

test('sendInputConfirmed resolves mode=hook when delivered and the start hook advances', async () => {
  // Baseline read returns 0; the first poll iteration sees the hook at 10.
  const { sup } = makeConfirmSeam({ delivered: true, startHookAts: [0, 10] });
  const result = await sup.sendInputConfirmed('w-ok-1', 'hello');
  assert.deepEqual(result, { delivered: true, confirmed: true, mode: 'hook' });
});

test('constants invariant: CONFIRM_WINDOW_FIRST_MS ≥ hook POST self-abort + cold-spawn budget', () => {
  // The v6 dashboard-status.mjs hook script self-aborts its POST at 2500ms
  // (buildDashboardStatusScript(2500, true)) — but that timer starts INSIDE
  // the spawned hook process, after node boot. The first confirm window must
  // therefore cover the self-abort PLUS the cold node spawn budget (1500ms),
  // or a legitimately slow hook earns a premature Enter re-press. See the
  // invariant comment in src/shared/constants.ts.
  const HOOK_POST_SELF_ABORT_MS = 2500;
  const COLD_NODE_SPAWN_BUDGET_MS = 1500;
  assert.ok(
    CONFIRM_WINDOW_FIRST_MS >= HOOK_POST_SELF_ABORT_MS + COLD_NODE_SPAWN_BUDGET_MS,
    `CONFIRM_WINDOW_FIRST_MS (${CONFIRM_WINDOW_FIRST_MS}) must be ≥ hook POST self-abort ` +
    `(${HOOK_POST_SELF_ABORT_MS}) + cold node spawn budget (${COLD_NODE_SPAWN_BUDGET_MS})`,
  );
});

// ── Runner ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${t.name}`);
      console.error(err);
    }
  }
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
