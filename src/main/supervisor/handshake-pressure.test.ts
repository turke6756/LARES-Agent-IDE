// Handshake PRESSURE harness — deterministic fault-injection probes against the
// supervisor→worker prompt-delivery handshake stack:
//
//   layer 1  _doSendInput            byte delivery (per-platform encodings)
//   layer 2  confirmSubmission       synchronous confirm-and-retry (contract providers)
//   layer 3  sendInputConfirmed      turn-start proof (hook / status-poll / unconfirmed)
//   layer 4  deliverToSupervisor     orchestration event delivery retry loop
//
// Companion to experiments/handshake-pressure-test/PROTOCOL.md (Tier 1).
// Costs zero tokens. Same conventions as groupthink-pressure.test.ts:
//
//   INVARIANT-* — behavior that MUST hold. A failure = a regression.
//   PROBE-*     — a demonstrated WEAKNESS, pinned so it is reproducible on
//                 demand. If a PROBE fails, the weakness may have been FIXED:
//                 verify, flip it to an INVARIANT, and record the change in
//                 experiments/handshake-pressure-test/findings.md.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/handshake-pressure.test.js

import assert from 'node:assert/strict';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { AgentSupervisor, SubmitNotConfirmedError } from './index';
import { StatusMonitor } from './status-monitor';
import { WindowsRunner } from './windows-runner';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { makeStatusMonitorFakes, patchDatabaseModule } from './test-helpers/fake-status-deps';
import {
  MAX_SUBMIT_RETRIES, CONFIRM_WINDOW_FIRST_MS, CONFIRM_WINDOW_RETRY_MS,
  HANDSHAKE_CONFIRM_WINDOW_MS,
} from '../../shared/constants';
import type { Agent, AgentStatus } from '../../shared/types';

// ── Clamp setTimeout so real-delay sleeps (Enter delay, confirm polls) fire
//    fast. Same trick as groupthink-pressure.test.ts. ────────────────────────
const realSetTimeout = global.setTimeout;
(global as any).setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(fn, Math.min(typeof ms === 'number' ? ms : 0, 2), ...rest)) as typeof setTimeout;

// ── Test harness ─────────────────────────────────────────────────────────────
interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Slim DB patch (subset of agent-supervisor.test.ts's patchDb) ─────────────
function patchDb(agentsMap: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus', 'updateAgentLastSendError',
    'updateAgentLastSend',
    'updateAgentPid', 'getAgent', 'addEvent', 'updateAgentLastOutput',
    'updateAgentExitCode', 'getActiveAgents', 'getAllAgents',
    'getSupervisorAgent', 'addFileActivity',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id);
    if (a) a.status = status;
  };
  db.updateAgentHookStatus = () => {};
  db.updateAgentLastSendError = (id: string, err: { message: string; ts: number } | null) => {
    const a = agentsMap.get(id);
    if (a) a.lastSendError = err;
  };
  db.updateAgentLastSend = (id: string, outcome: Agent['lastSend']) => {
    const a = agentsMap.get(id);
    if (a) a.lastSend = outcome;
  };
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;

  // §B3 — status writes route through applyStatusTransition; keep them in the fake.
  patchApplyStatusTransition(db as unknown as Record<string, unknown>);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

// ── Full-supervisor rig: real AgentSupervisor + recording Windows runner ─────
interface SupHarness {
  supervisor: AgentSupervisor;
  agent: Agent;
  writes: string[];
  handoffFailures: Array<{ agentId: string; attempts: number }>;
  cleanup(): void;
}

function setupSupervisor(opts: {
  agent: Agent;
  /** Sequential results for the stubbed confirmSubmission (last value repeats). */
  confirmResults: boolean[];
}): SupHarness {
  const agentsMap = new Map<string, Agent>([[opts.agent.id, opts.agent]]);
  const restoreDb = patchDb(agentsMap);

  const supervisor = new AgentSupervisor();
  (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};

  const writes: string[] = [];
  const fake = new WindowsRunner();
  Object.defineProperty(fake, 'isAlive', { get: () => true, configurable: true });
  (fake as unknown as { write: (data: string) => void }).write = (data: string) => { writes.push(data); };
  (supervisor as unknown as { windowsRunners: Map<string, WindowsRunner> })
    .windowsRunners.set(opts.agent.id, fake);

  let confirmCall = 0;
  const monitor = (supervisor as unknown as {
    monitor: { confirmSubmission: (id: string, prior: number) => Promise<boolean> };
  }).monitor;
  monitor.confirmSubmission = async () => {
    const i = Math.min(confirmCall, opts.confirmResults.length - 1);
    confirmCall++;
    return opts.confirmResults[i];
  };

  const handoffFailures: Array<{ agentId: string; attempts: number }> = [];
  const bridge = (supervisor as unknown as {
    bridge: { onHandoffFailed: (p: { agent: Agent; attempts: number; message: string }) => Promise<void> };
  }).bridge;
  bridge.onHandoffFailed = async (p) => { handoffFailures.push({ agentId: p.agent.id, attempts: p.attempts }); };

  return { supervisor, agent: opts.agent, writes, handoffFailures, cleanup: restoreDb };
}

function makeClaudeWorker(id: string): Agent {
  return makeAgent(id, {
    provider: 'claude', isWorker: true, isSupervised: true, status: 'idle',
    command: 'claude', workingDirectory: 'C:\\tmp',
  });
}

/** Constructor-free AgentSupervisor for surfaces that only touch stubbed seams
 *  (same pattern as handoff-handshake.test.ts's makeConfirmSeam). */
function makeBareSupervisor(): AgentSupervisor {
  const sup = Object.create(AgentSupervisor.prototype) as AgentSupervisor;
  (sup as unknown as { inputInFlight: Set<string> }).inputInFlight = new Set();
  return sup;
}

// ═════════════════════════════════════════════════════════════════════
// PROBE-H1 — sendInputConfirmed's status-poll fallback has NO baseline
//
// The hook proof requires the UserPromptSubmit timestamp to advance PAST a
// pre-send baseline. The `status === 'working'` fallback has no such baseline:
// a `working` that predates the send — the tail of a PREVIOUS turn, or a turn
// started by someone else's input — confirms THIS submit instantly, even when
// the hook timestamp never moves. The MCP working-state send guard reads the
// same status field, so a stale-idle reading lets the send through and the
// previous turn's `working` then "confirms" it. mode:'status-poll' is therefore
// proof that SOME turn is running, not that OUR prompt started one.
// Hardening candidate: baseline the status too (require an idle→working
// transition observed AFTER the send), or return a distinct lower-confidence
// mode the caller can treat accordingly.
// ═════════════════════════════════════════════════════════════════════
test('PROBE-H1 sendInputConfirmed: a pre-existing working status confirms a submit the hook never saw', async () => {
  const agent = makeClaudeWorker('h1-worker');
  agent.status = 'working';   // working BEFORE our send — previous turn still running
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const restoreDb = patchDb(agentsMap);
  try {
    const sup = makeBareSupervisor();
    (sup as unknown as { monitor: { getLastStartHookEventAt: (id: string) => number | undefined } }).monitor = {
      getLastStartHookEventAt: () => 0,   // the hook NEVER advances
    };
    (sup as unknown as { sendInput: (id: string, text: string) => Promise<boolean> }).sendInput =
      async () => true;                   // bytes "delivered" (weak proof, e.g. WSL)

    const result = await sup.sendInputConfirmed(agent.id, 'hello');
    assert.deepEqual(result, { delivered: true, confirmed: true, mode: 'status-poll' },
      'confirmed via status-poll with ZERO per-send evidence (the weakness this probe pins)');
  } finally {
    restoreDb();
  }
});

// ═════════════════════════════════════════════════════════════════════
// WP5 evidence matrix at the sendInputConfirmed (layer 3) seam.
//
// The dead-hook behavior is now UNIFIED across lanes (VM report §6 fix):
//   • supervisor/contract target, hooks dead → the re-press exhausts but the
//     send NO LONGER throws; sendInputConfirmed resolves
//     { delivered:true, confirmed:false, mode:'unconfirmed' }.
//   • worker target with the SAME dead hooks (hook_status='broken') → same
//     unconfirmed resolution.
//   • no runner accepted the bytes → still REJECTS with a delivery-failed error
//     (the ONLY reject — nothing was typed).
// ═════════════════════════════════════════════════════════════════════
test('WP5-H supervisor target, dead hooks → sendInputConfirmed resolves unconfirmed (NO reject)', async () => {
  const agent = makeAgent('wp1h-sup', {
    provider: 'claude', isSupervisor: true, isWorker: false, isSupervised: false,
    status: 'idle', hookStatus: 'unknown', command: 'claude', workingDirectory: 'C:\\tmp',
  });
  // confirmResults:[false] → the re-press exhausts; the send resolves delivered-
  // unconfirmed (no throw) and the layer-3 poll then reports unconfirmed.
  const h = setupSupervisor({ agent, confirmResults: [false] });
  // Fast-forward the layer-3 confirm-poll deadline (monotonic jump, as in the
  // worker case below) so the unconfirmed branch is reached without the real
  // 15 s wall-clock wait.
  const realNow = Date.now;
  let clock = 1_000_000;
  const step = HANDSHAKE_CONFIRM_WINDOW_MS * 10;
  (global as unknown as { Date: { now: () => number } }).Date.now = () => { clock += step; return clock; };
  try {
    const result = await h.supervisor.sendInputConfirmed(agent.id, 'hi');
    assert.deepEqual(result, { delivered: true, confirmed: false, mode: 'unconfirmed' },
      'a contract target with dead hooks now resolves unconfirmed — never rejects (VM §6 unified)');
  } finally {
    (global as unknown as { Date: { now: () => number } }).Date.now = realNow;
    h.cleanup();
  }
});

test('WP1-H worker target, SAME dead hooks (broken) → resolves delivered+unconfirmed (no reject)', async () => {
  const agent = makeAgent('wp1h-wrk', {
    provider: 'claude', isWorker: true, isSupervised: true, status: 'idle',
    hookStatus: 'broken', command: 'claude', workingDirectory: 'C:\\tmp',
  });
  // confirmResults never consumed — usesSubmitConfirmation is false for broken.
  const h = setupSupervisor({ agent, confirmResults: [false] });
  // Force the confirm-poll deadline to expire quickly so the unconfirmed branch
  // is reached without the real 15 s wall-clock wait. A MONOTONIC stub (each
  // call jumps far forward) is robust no matter how many Date.now calls the
  // send path makes before the deadline is computed — within two iterations the
  // clock has passed any deadline of HANDSHAKE_CONFIRM_WINDOW_MS.
  const realNow = Date.now;
  let clock = 1_000_000;
  const step = HANDSHAKE_CONFIRM_WINDOW_MS * 10;
  (global as unknown as { Date: { now: () => number } }).Date.now = () => {
    clock += step;
    return clock;
  };
  try {
    const result = await h.supervisor.sendInputConfirmed(agent.id, 'hi');
    assert.deepEqual(result, { delivered: true, confirmed: false, mode: 'unconfirmed' },
      'the broken worker delivers but cannot confirm — resolves, never rejects');
  } finally {
    (global as unknown as { Date: { now: () => number } }).Date.now = realNow;
    h.cleanup();
  }
});

test('WP1-H runner present but not alive → sendInputConfirmed REJECTS (delivery-failed)', async () => {
  const agent = makeAgent('wp1h-dead', {
    provider: 'claude', isWorker: true, isSupervised: true, status: 'idle',
    hookStatus: 'broken', command: 'claude', workingDirectory: '/home/test',
    tmuxSessionName: 'agent-wp1h-dead',
  });
  const h = setupSupervisor({ agent, confirmResults: [true] });
  // Swap the injected (alive) windows runner for a dead WSL runner: the runner
  // EXISTS (so sendInput's eager no-runner guard passes) but reports not-alive,
  // so _doSendInput returns delivered:false and sendInputConfirmed raises the
  // delivery-failed coded error — the "nothing was typed" path.
  (h.supervisor as unknown as { windowsRunners: Map<string, unknown> }).windowsRunners.delete(agent.id);
  (h.supervisor as unknown as { wslRunners: Map<string, unknown> }).wslRunners.set(agent.id, { isAlive: false });
  try {
    await assert.rejects(
      () => h.supervisor.sendInputConfirmed(agent.id, 'hi'),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'delivery-failed',
      'a not-alive runner rejects with a delivery-failed code — nothing was typed',
    );
  } finally {
    h.cleanup();
  }
});

// ═════════════════════════════════════════════════════════════════════
// PROBE-H2 — a hook landing after confirm exhaustion is never reconciled:
//            the handshake reports a hard failure for a turn that started
//
// Worst-case confirm budget is CONFIRM_WINDOW_FIRST_MS + MAX_SUBMIT_RETRIES ×
// CONFIRM_WINDOW_RETRY_MS (= 4000 + 3×1200 = 7600ms). A UserPromptSubmit hook
// that lands at 7.7s — cold node spawn beyond the 1500ms budget on a loaded
// box — arrives AFTER confirmSubmission returned false, AFTER the
// SubmitNotConfirmedError threw, and AFTER handoff_failed told the supervisor
// the worker is "NOT working". There is no recovered/reconciliation signal, so
// the supervisor's natural recovery (re-send) double-prompts a working agent.
// This is the handshake's version of GroupThink's false stall.
// Hardening candidate: when a start hook arrives while/after a confirm for the
// same agent exhausted, emit a follow-up handoff_recovered event (and clear
// lastSendError).
// ═════════════════════════════════════════════════════════════════════
test('PROBE-H2 confirmSubmission: hook arriving past the 7.6s exhaustion budget is reported as a hard failure with no reconciliation', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('h2-worker', { provider: 'claude', isWorker: true, status: 'idle' });
    fakes.agents.set(agent.id, agent);
    fakes.aliveOverride.set(agent.id, true);
    const startedAt = fakes.now.value;
    const presses = { count: 0 };
    const monitor = new StatusMonitor(
      async () => true,
      (id) => fakes.lastOutputAt.get(id) ?? 0,
      (id) => fakes.agents.get(id) ?? null,
      () => fakes.now.value,
      () => '',
      (id) => fakes.lastRawOutputAt.get(id) ?? 0,
      async (ms: number) => { fakes.now.value += ms; },   // fake clock; hook never fires in-window
    );
    monitor.setResubmitHandler(() => { presses.count++; });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    const elapsed = fakes.now.value - startedAt;
    assert.equal(confirmed, false, 'contract reports the turn never started');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES, 'all re-presses spent');
    assert.equal(elapsed, CONFIRM_WINDOW_FIRST_MS + MAX_SUBMIT_RETRIES * CONFIRM_WINDOW_RETRY_MS,
      'pins the worst-case exhaustion budget the late hook must beat (7600ms)');

    // The slow hook now lands — 100ms after exhaustion. The monitor records
    // proof the turn started, but the SubmitNotConfirmedError / handoff_failed
    // already fired and nothing ever reconciles them (the weakness this probe
    // pins): grep the codebase — no handoff_recovered event exists.
    monitor.recordStartHookEventAt(agent.id, fakes.now.value + 100);
    assert.equal(monitor.hasObservedStartHook(agent.id), true,
      'dashboard now holds proof the "failed" turn actually started');
    assert.ok((monitor.getLastStartHookEventAt(agent.id) ?? 0) > 0, 'hook timestamp recorded post-exhaustion');
  } finally {
    restore();
  }
});

// ═════════════════════════════════════════════════════════════════════
// PROBE-H3 — the send queue un-poisons after SubmitNotConfirmedError, so the
//            next send pastes a SECOND body into a composer that may still
//            hold the first
//
// sendInput's per-agent queue deliberately survives a failed send
// (`previous.catch(() => undefined)`). A SubmitNotConfirmedError means the
// body was typed but no turn started — the likeliest physical state is the
// body sitting UNSUBMITTED in the composer. Nothing clears it: the next send
// bracket-pastes body #2 right behind body #1 and presses Enter, submitting a
// concatenated mega-prompt (or, for a supervisor retrying the same text, a
// doubled prompt).
// Hardening candidate: after confirm exhaustion, clear the composer (Ctrl+C /
// Esc / Ctrl+U per provider) before allowing the next queued send, or surface
// a composer-dirty flag the caller must acknowledge.
// ═════════════════════════════════════════════════════════════════════
test('PROBE-H3 sendInput: a send after an unconfirmed send pastes a second body with no composer clear in between', async () => {
  const h = setupSupervisor({
    agent: makeClaudeWorker('h3-worker'),
    confirmResults: [false, true],   // send #1 exhausts (unconfirmed); send #2 confirms
  });
  try {
    // WP5 — send #1 no longer throws; it delivers unconfirmed (body typed, turn
    // never confirmed). The composer is still the likely holder of body #1.
    const delivered1 = await h.supervisor.sendInput(h.agent.id, 'FIRST BODY', { submit: true });
    assert.equal(delivered1, true, 'send #1 delivered (unconfirmed) — no throw under WP5');
    const ok = await h.supervisor.sendInput(h.agent.id, 'SECOND BODY', { submit: true });
    assert.equal(ok, true, 'send #2 proceeds normally');

    const idx1 = h.writes.findIndex((w) => w.includes('FIRST BODY'));
    const idx2 = h.writes.findIndex((w) => w.includes('SECOND BODY'));
    assert.ok(idx1 !== -1 && idx2 > idx1, 'both bodies were written to the same PTY');
    const between = h.writes.slice(idx1 + 1, idx2);
    assert.ok(between.every((w) => w === '\r'),
      `nothing between the bodies except Enter presses — no Ctrl+C/Esc/Ctrl+U composer clear ` +
      `(the weakness this probe pins); got: ${JSON.stringify(between)}`);
  } finally {
    h.cleanup();
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-H4 — an unconfirmed send retries then returns ok:false
//                (durable delivery_failed)
//
// deliverToSupervisor used to await sendInputConfirmed but never read
// `confirmed`. The supervisor is a non-contract agent (not supervised/worker),
// so a dropped Enter on its pane resolves { confirmed: false, mode: 'unconfirmed' }
// and the loop returned { ok: true } — the OrchestrationService recorded NO
// delivery_failed row, so a groupthink completion/stall event could vanish with
// every durability mechanism reporting success. The fix treats an unconfirmed
// resolution as a retryable failure inside the existing retry loop; on exhaustion
// it returns { ok: false } so the service writes the durable delivery_failed row.
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-H4 deliverToSupervisor: an unconfirmed send retries then returns ok:false (durable delivery_failed)', async () => {
  const supervisorAgent = makeAgent('h4-sup', { provider: 'claude', status: 'idle', isSupervisor: true });
  const agentsMap = new Map<string, Agent>([[supervisorAgent.id, supervisorAgent]]);
  const restoreDb = patchDb(agentsMap);
  try {
    const sup = makeBareSupervisor();
    const confirmedResults: Array<{ confirmed: boolean; mode: string }> = [];
    (sup as unknown as {
      sendInputConfirmed: (id: string, text: string) => Promise<{ delivered: boolean; confirmed: boolean; mode: string }>;
    }).sendInputConfirmed = async () => {
      const r = { delivered: true, confirmed: false, mode: 'unconfirmed' };
      confirmedResults.push(r);
      return r;
    };

    const res = await sup.deliverToSupervisor(supervisorAgent.id, '[DASHBOARD EVENT] groupthink.complete ...', {
      maxAttempts: 2, intervalMs: 1,
    });
    assert.equal(confirmedResults.length, 2, 'the unconfirmed send retried to exhaustion');
    assert.deepEqual(res, { ok: false },
      'exhausted unconfirmed delivery returns ok:false so a durable delivery_failed row gets written');
  } finally {
    restoreDb();
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-H5 (WP5) — re-press exhaustion is NOT a failure. The send resolves
// delivered-unconfirmed: it does NOT throw, does NOT set the legacy
// lastSendError, and does NOT auto-fire handoff_failed (hook absence is never a
// hard failure — VM §6). The persisted lastSend records the delivered-unconfirmed
// outcome so pollers can still see the confirmation gap.
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-H5 (WP5) exhaustion: delivered-unconfirmed — no throw, no lastSendError, no handoff_failed', async () => {
  const h = setupSupervisor({
    agent: makeClaudeWorker('h5-worker'),
    confirmResults: [false],
  });
  try {
    const outcome = await h.supervisor.sendInputWithOutcome(h.agent.id, 'hello', { submit: true });
    assert.equal(outcome.disposition, 'delivered-unconfirmed', 'exhausted re-press → delivered-unconfirmed');
    assert.equal(outcome.delivered, true);
    assert.ok(!h.agent.lastSendError, 'no legacy lastSendError set for a delivered-unconfirmed send');
    assert.equal(h.handoffFailures.length, 0, 'delivered-unconfirmed does NOT auto-fire handoff_failed');
    assert.ok(h.agent.lastSend && h.agent.lastSend.disposition === 'delivered-unconfirmed',
      'the outcome is persisted via updateAgentLastSend');
  } finally {
    h.cleanup();
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-H6 — per-agent send serialization: two overlapping sends must not
// interleave bodies on the PTY (body A, submit, body B, submit — in order).
// PROBE-H3's concatenation risk is about composer STATE; this invariant is
// about WIRE ordering, which the queue does guarantee and must keep.
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-H6 sendInput: two overlapping sends serialize — no interleaved bodies on the PTY', async () => {
  const h = setupSupervisor({
    agent: makeClaudeWorker('h6-worker'),
    confirmResults: [true, true],
  });
  try {
    const p1 = h.supervisor.sendInput(h.agent.id, 'BODY ALPHA', { submit: true });
    const p2 = h.supervisor.sendInput(h.agent.id, 'BODY BETA', { submit: true });
    assert.equal(h.supervisor.isInputInFlight(h.agent.id), true, 'in-flight while queued');
    await Promise.all([p1, p2]);

    const idxA = h.writes.findIndex((w) => w.includes('BODY ALPHA'));
    const enterAfterA = h.writes.findIndex((w, i) => i > idxA && w === '\r');
    const idxB = h.writes.findIndex((w) => w.includes('BODY BETA'));
    assert.ok(idxA !== -1 && enterAfterA !== -1 && idxB !== -1, 'all three writes present');
    assert.ok(idxA < enterAfterA && enterAfterA < idxB,
      `body A submitted before body B was typed; writes=${JSON.stringify(h.writes)}`);
    assert.equal(h.supervisor.isInputInFlight(h.agent.id), false, 'in-flight cleared after drain');
  } finally {
    h.cleanup();
  }
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  const failedProbes: string[] = [];
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
      if (t.name.startsWith('PROBE-')) failedProbes.push(t.name);
    }
  }
  if (failedProbes.length) {
    console.log('\nNOTE: failing PROBE-* cases may mean a known weakness was FIXED, not that the');
    console.log('handshake regressed. Verify the new behavior, flip the probe to an INVARIANT,');
    console.log('and record it in experiments/handshake-pressure-test/findings.md:');
    for (const n of failedProbes) console.log(`  - ${n}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
