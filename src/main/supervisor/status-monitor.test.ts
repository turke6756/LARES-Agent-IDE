// Tests for the Pipeline B turn-latch behavior added in M2A (P1A-01).
// Covers BR-11, BR-16, BR-17, BR-18 from the agent-lifecycle hardening plan.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/status-monitor.test.js

import assert from 'node:assert/strict';
import { StatusMonitor } from './status-monitor';
import {
  makeStatusMonitorFakes,
  patchDatabaseModule,
  makeAgent,
} from './test-helpers/fake-status-deps';
import {
  IDLE_LATCH_TIMEOUT_MS,
  WAITING_LATCH_TIMEOUT_MS,
  WORKING_THRESHOLD_MS,
  WORKING_LATCH_MODEL_PENDING_MS,
  WORKING_LATCH_TOOL_PENDING_MS,
  WORKING_LATCH_THINKING_PENDING_MS,
  WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS,
  WORKING_LATCH_TOOL_PENDING_UNSUPERVISED_MS,
  WORKING_LATCH_THINKING_PENDING_UNSUPERVISED_MS,
  SUPERVISOR_WORKING_LATCH_MS,
  LAUNCH_SETTLE_TIMEOUT_MS,
  LAUNCH_SETTLE_OVERRUN_GRACE_MS,
  START_HOOK_SILENCE_WARN_MS,
  START_HOOK_RESEND_AFTER_MS,
  START_HOOK_RESEND_INTERVAL_MS,
  START_HOOK_RESEND_MAX_ATTEMPTS,
  HOOK_CANARY_WINDOW_MS,
  CONFIRM_WINDOW_FIRST_MS,
  CONFIRM_POLL_MS,
  MAX_SUBMIT_RETRIES,
} from '../../shared/constants';
import type { Agent } from '../../shared/types';
import type { StatusChangedEvent } from './status-events';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// Default worker fixture for inference-behavior tests. The shared `makeAgent`
// from fake-bridge-deps defaults to provider:'claude' + isSupervised:true.
// Post §12.5 the Class IV skip is gated on `isSupervised` (any provider), so
// any supervised fixture would short-circuit inference. Existing tests are
// about generic latch / TTL behavior and read more cleanly when run against
// a fixture whose inference is NOT short-circuited — unsupervised codex is
// the simplest such shape. Tests that specifically exercise the supervised
// lanes (Class IV, watchdog, supervisor short-latch) import makeAgent
// directly and set the supervision flags explicitly.
function makeWorker(id: string, overrides: Partial<Agent> = {}): Agent {
  return makeAgent(id, { provider: 'codex', isSupervised: false, ...overrides });
}

function makeMonitor(opts: {
  fakes: ReturnType<typeof makeStatusMonitorFakes>;
  agent: Agent;
  alive?: boolean;
  ringTails?: Map<string, string>;
}) {
  const { fakes, agent } = opts;
  const alive = opts.alive ?? true;
  fakes.agents.set(agent.id, agent);
  fakes.aliveOverride.set(agent.id, alive);
  // Default: PTY says "active right now" — we let tests override per scenario.
  fakes.lastOutputAt.set(agent.id, fakes.now.value);
  const ringTails = opts.ringTails ?? new Map<string, string>();
  const monitor = new StatusMonitor(
    async (a) => fakes.aliveOverride.get(a.id) ?? true,
    (id) => fakes.lastOutputAt.get(id) ?? 0,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
    (id) => ringTails.get(id) ?? '',
    // BUG-09 §3.5 — raw PTY signal. Defaults to `lastOutputAt` so legacy
    // tests behave as before; new dual-signal tests override
    // `lastRawOutputAt` directly.
    (id) => fakes.lastRawOutputAt.get(id) ?? fakes.lastOutputAt.get(id) ?? 0,
  );
  monitor.on('statusChanged', (payload: StatusChangedEvent) => {
    fakes.emissions.push(payload);
  });
  return monitor;
}

// Tiny accessor for the private inferStatus — the same shape `poll()` exercises.
function inferStatus(monitor: StatusMonitor, agent: Agent): Promise<string | null> {
  return (monitor as any).inferStatus(agent);
}

// ── BR-11 ────────────────────────────────────────────────────────────
test('BR-11: turnComplete → forceIdle fires even while statusHoldUntil is active', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Plant a hold 5s in the future to simulate a debounce window.
    (monitor as any).statusHoldUntil.set(agent.id, fakes.now.value + 5_000);

    monitor.forceIdle(agent.id, 'turnComplete');

    assert.equal(fakes.updates.length, 1, 'BR-11: status write happened');
    assert.equal(fakes.updates[0].status, 'idle');
    assert.equal(fakes.emissions.length, 1, 'BR-11: statusChanged emitted');
    assert.equal(fakes.emissions[0].status, 'idle');
    assert.equal(fakes.emissions[0].fromStatus, 'working');
    assert.equal(fakes.emissions[0].source, 'monitor');

    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'idle', 'BR-11: latch armed to idle');
  } finally {
    restore();
  }
});

test('forceIdle no-ops on terminal status (crashed)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'crashed', lastExitCode: 1 });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    monitor.forceIdle(agent.id, 'turnComplete');

    assert.equal(fakes.updates.length, 0, 'crashed → forceIdle is a no-op');
    assert.equal(fakes.emissions.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'no latch set on terminal');
  } finally {
    restore();
  }
});

test('forceIdle no-ops on transitional status (launching)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'launching' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    assert.equal(fakes.updates.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

// ── BR-16 ────────────────────────────────────────────────────────────
test('BR-16: idle latch holds against PTY burst — Codex incident in test form', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Establish the latch.
    monitor.forceIdle(agent.id, 'turnComplete');
    // Synthetic: status update mutated agent.status via the fake patch.
    assert.equal(agent.status, 'idle');

    // Advance time 5s and simulate a "meaningful burst" — PTY just printed.
    fakes.now.value += 5_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle', 'BR-16: PTY burst MUST NOT promote latched-idle back to working');
  } finally {
    restore();
  }
});

test('BR-16 corollary (BUG-09 inverted): forceWorking overwrites the prior latch with a working entry', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    const idleLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(idleLatch && idleLatch.state === 'idle', 'idle latch set');

    // A real new turn arrives. Per BUG-09 §3.1 the latch is now a tagged
    // `working` entry rather than being deleted — chat-stream truth keeps
    // governing the agent across the Coalescing window that PTY can't see.
    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });
    const workingLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(workingLatch && workingLatch.state === 'working',
      'forceWorking installed a working latch');
    assert.equal(agent.status, 'working');

    // PTY going silent must NOT downgrade — the working latch carries us
    // through. Push elapsed past WORKING_THRESHOLD_MS to prove this.
    fakes.now.value += WORKING_THRESHOLD_MS + 1_000;
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'working latch survives PTY silence within model-pending TTL');
  } finally {
    restore();
  }
});

// ── BR-17 ────────────────────────────────────────────────────────────
test('BR-17: idle latch TTL expires; PTY truth resumes', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    assert.ok(monitor.getLatchSnapshot(agent.id), 'latch present immediately');

    // Tick forward past the idle TTL. Set PTY to "just printed" so the
    // fallback path would return 'working' if the latch were respected.
    fakes.now.value += IDLE_LATCH_TIMEOUT_MS + 1;
    fakes.lastOutputAt.set(agent.id, fakes.now.value);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working', 'BR-17: latch expired, PTY says working');
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'BR-17: latch entry cleaned up on expiry');
  } finally {
    restore();
  }
});

test('BR-17 boundary: latch still active at exactly TTL ms', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    fakes.now.value += IDLE_LATCH_TIMEOUT_MS;
    fakes.lastOutputAt.set(agent.id, fakes.now.value);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle', 'latch is inclusive at exactly TTL');
  } finally {
    restore();
  }
});

// ── BR-18 ────────────────────────────────────────────────────────────
test('BR-18: waiting latch TTL expires; agent falls to PTY-inferred status', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWaiting(agent.id, 'question', 'Are you sure?');
    assert.equal(agent.status, 'waiting');
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'waiting');
    assert.equal(latch.waitingKind, 'question');
    assert.equal(latch.waitingExcerpt, 'Are you sure?');

    // Past waiting TTL; PTY went quiet long ago — should fall to idle.
    fakes.now.value += WAITING_LATCH_TIMEOUT_MS + 1;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle', 'BR-18: PTY-quiet → idle once waiting latch expires');
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

test('BR-18 boundary: waiting latch still active at exactly TTL ms', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWaiting(agent.id, 'y-n', '(y/N)');
    fakes.now.value += WAITING_LATCH_TIMEOUT_MS;

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'waiting', 'waiting latch inclusive at TTL');
  } finally {
    restore();
  }
});

// ── BR-14 ────────────────────────────────────────────────────────────
test('BR-14: PTY (y/N) prompt in ring tail → inferStatus returns waiting + arms latch', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const ringTails = new Map<string, string>();
    ringTails.set(agent.id, 'Do you want to proceed? (y/N) ');
    const monitor = makeMonitor({ fakes, agent, ringTails });

    // PTY went quiet >2s ago so the detector is allowed to run.
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 5_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'waiting', 'BR-14: pattern match returns waiting');

    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'waiting', 'BR-14: forceWaiting armed the latch');
    assert.equal(latch.waitingKind, 'y-n');
    assert.match(latch.waitingExcerpt ?? '', /\(y\/N\)/);

    // One statusChanged emission from forceWaiting; updates show the write.
    const waitingEmits = fakes.emissions.filter(e => e.status === 'waiting');
    assert.equal(waitingEmits.length, 1, 'BR-14: one waiting transition fired');
  } finally {
    restore();
  }
});

test('BR-14 guard: PTY pattern is NOT consulted while PTY is still streaming', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const ringTails = new Map<string, string>();
    ringTails.set(agent.id, 'Approve?');
    const monitor = makeMonitor({ fakes, agent, ringTails });

    // PTY active right now — detector must not fire.
    fakes.lastOutputAt.set(agent.id, fakes.now.value);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working');
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined,
      'no waiting latch while PTY is still streaming');
  } finally {
    restore();
  }
});

// ── Misc invariants ──────────────────────────────────────────────────
test('BUG-09 §3.1: forceWorking on already-working agent installs working latch (no DB write)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Seed a stale idle latch.
    (monitor as any).turnLatch.set(agent.id, { state: 'idle', setAt: fakes.now.value });

    monitor.forceWorking(agent.id, {
      source: 'tool-use',
      toolUseId: 'tu-1',
      ttlClass: 'tool-pending',
    });
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working',
      'BUG-09: forceWorking overwrites the stale idle latch with a working one');
    assert.equal(latch.outstandingToolIds.size, 1);
    assert.ok(latch.outstandingToolIds.has('tu-1'));
    assert.equal(fakes.updates.length, 0, 'no DB write when already working');
    assert.equal(fakes.emissions.length, 0, 'no event when already working');
  } finally {
    restore();
  }
});

// ── BUG-09 §3.1 / §3.7 (Bundle 1) ────────────────────────────────────

test('BUG-09: working latch holds through Coalescing gap (model-pending TTL)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    // PTY goes silent for 30 s (Coalescing window). The pre-BUG-09 detector
    // would flip to idle because elapsed > WORKING_THRESHOLD_MS=8s.
    fakes.now.value += 30_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 30_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'BUG-09: working latch beats PTY silence within model-pending TTL');
  } finally {
    restore();
  }
});

test('BUG-09: parallel tools — single tool-result keeps tool-pending TTL', async () => {
  // §12.5 migration: makeWorker now defaults isSupervised:false (supervised
  // workers all skip inference), so this test exercises the unsupervised
  // latch lane. Latch math (refresh + outstanding tools) is provider-agnostic;
  // we swap supervised TTL constants for their unsupervised variants and the
  // semantic intent ("tool-pending TTL applies while a tool is outstanding")
  // is preserved.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'B', ttlClass: 'tool-pending' });

    const before = monitor.getLatchSnapshot(agent.id);
    assert.ok(before && before.state === 'working');
    assert.equal(before.outstandingToolIds.size, 2);

    // Resolve only A — B is still outstanding.
    monitor.forceWorking(agent.id, {
      source: 'tool-result',
      resolvedToolUseId: 'A',
      ttlClass: 'tool-pending',
    });

    const after = monitor.getLatchSnapshot(agent.id);
    assert.ok(after && after.state === 'working');
    assert.equal(after.outstandingToolIds.size, 1, 'B is still outstanding');
    assert.ok(after.outstandingToolIds.has('B'));

    // Beyond model-pending TTL but under tool-pending TTL → still working.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS - 1_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'tool-pending TTL applies while a tool remains outstanding');
  } finally {
    restore();
  }
});

test('BUG-18 Change 1: both tools resolve — latch still survives past model-pending (ttlClass=tool-pending stored)', async () => {
  // Updated for BUG-18 Change 1. Before Change 1, `inferStatus` derived the
  // effective TTL solely from `outstandingToolIds.size` and the stored
  // `ttlClass` was dead data. That meant a `tool-result` resolving the last
  // outstanding tool collapsed the TTL back to model-pending (180 s) —
  // exactly the Claude §2.1 "tool_result → next-assistant thinking gap"
  // false-idle pathway (3 of 25 sampled gaps cleared 180 s). Change 1 makes
  // `ttlClass` the source-of-truth, so a latch whose last refresh stored
  // `tool-pending` keeps the 900 s ceiling even after the last tool resolves.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'B', ttlClass: 'tool-pending' });
    monitor.forceWorking(agent.id, {
      source: 'tool-result',
      resolvedToolUseId: 'A',
      ttlClass: 'tool-pending',
    });
    monitor.forceWorking(agent.id, {
      source: 'tool-result',
      resolvedToolUseId: 'B',
      ttlClass: 'tool-pending',
    });

    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.outstandingToolIds.size, 0, 'no outstanding tools');
    assert.equal(latch.ttlClass, 'tool-pending',
      'latch retained tool-pending ttlClass from last forceWorking');

    // Just past model-pending TTL: pre-Change-1 this would flip to idle.
    // Post-Change-1 the latch's tool-pending ceiling holds working.
    // (§12.5: unsupervised constants now — supervised lane skips inference.)
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    let inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'Change 1: ttlClass=tool-pending holds past model-pending even with no outstanding tools');

    // Push past tool-pending TTL — latch must finally expire and PTY truth
    // takes over (stale PTY → idle).
    fakes.now.value += WORKING_LATCH_TOOL_PENDING_UNSUPERVISED_MS;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'latch eventually expires once age exceeds the tool-pending ceiling');
  } finally {
    restore();
  }
});

test('BUG-09 §3.1 / C7: forceWorking refreshes refreshedAt on an already-working latch', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });
    const first = monitor.getLatchSnapshot(agent.id);
    assert.ok(first && first.state === 'working');
    const refreshedAt1 = first.refreshedAt;

    fakes.now.value += 5_000;
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'X', ttlClass: 'tool-pending' });
    const second = monitor.getLatchSnapshot(agent.id);
    assert.ok(second && second.state === 'working');
    assert.ok(second.refreshedAt > refreshedAt1,
      'C7: refreshedAt advances on subsequent forceWorking calls');
    assert.equal(second.setAt, first.setAt,
      'setAt is preserved across refresh — only refreshedAt advances');
    assert.ok(second.outstandingToolIds.has('X'),
      'tool-use toolUseId is now in the outstanding set');
  } finally {
    restore();
  }
});

test('BUG-09 §3.1 / C8: forceIdle overwrites a working latch (does not delete)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    monitor.forceIdle(agent.id, 'turnComplete');

    const idleLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(idleLatch && idleLatch.state === 'idle',
      'C8: idle latch overwrote the working latch instead of deleting it');

    // Within idle latch TTL, even a PTY burst cannot promote back to working.
    fakes.now.value += 5_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'idle latch suppresses PTY-noise promotion as before');
  } finally {
    restore();
  }
});

test('BUG-09 §3.1 (Codex round 3): PTY (y/N) does NOT override tool-pending working latch', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const ringTails = new Map<string, string>();
    // The tail still has a (y/N) line from a prior turn — but a tool is
    // genuinely outstanding, so pattern detection must not fire forceWaiting.
    ringTails.set(agent.id, 'Do you want to proceed? (y/N) ');
    const monitor = makeMonitor({ fakes, agent, ringTails });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });

    // PTY quiet >2s so the detector would otherwise fire.
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 5_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'tool-pending working latch outranks a (y/N) line in the ring tail');
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working',
      'pattern detection did not overwrite the tool-pending latch');
  } finally {
    restore();
  }
});

test('BUG-09 §3.1: PTY (y/N) DOES override model-pending working latch', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const ringTails = new Map<string, string>();
    ringTails.set(agent.id, 'Do you want to proceed? (y/N) ');
    const monitor = makeMonitor({ fakes, agent, ringTails });

    // model-pending latch with NO outstanding tools — pattern detection still beats it.
    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    fakes.lastOutputAt.set(agent.id, fakes.now.value - 5_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'waiting',
      'model-pending latch yields to a real waiting-prompt pattern');
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'waiting');
  } finally {
    restore();
  }
});

test('BUG-09 §3.6: poll/chat race — stale poll write skipped when force* moved status', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });

    // Simulate a poll tick whose inferStatus is about to write `idle`
    // (PTY-quiet path). Race condition: in between inferStatus resolving and
    // the write, a chat event fires forceWorking, mutating agent.status to
    // 'working'. We trigger this by manually mutating agent.status here —
    // semantically equivalent to "the force* path just mutated this record".

    // Drive the poll loop:
    await (monitor as any).poll();
    // First poll: agent was 'idle', alive, PTY just printed → returns
    // 'working' (because lastOutputAt was seeded to now in makeMonitor).
    // So we expect one update to 'working' and one emission. Sanity check.
    assert.equal(fakes.updates[0]?.status, 'working');

    // Now set up the race: agent currently 'working' but PTY went quiet long
    // enough that inferStatus would return 'idle'. Mutate agent.status as if
    // a force* path just wrote a new value out of band.
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 20_000);
    fakes.now.value += 1_000;

    // Wedge a hook so that BEFORE poll's compare/write, a competing force*
    // mutates the agent record. We use the test's mutable agents map to
    // simulate that.
    const origInferStatus = (monitor as any).inferStatus.bind(monitor);
    (monitor as any).inferStatus = async (a: any) => {
      const result = await origInferStatus(a);
      // Race: a chat event just made the agent waiting.
      const live = fakes.agents.get(a.id);
      if (live) live.status = 'waiting';
      return result;
    };

    const updatesBefore = fakes.updates.length;
    await (monitor as any).poll();
    // The stale poll write (intended to flip to 'idle') must be skipped —
    // the live record moved on to 'waiting'.
    assert.equal(fakes.updates.length, updatesBefore,
      'BUG-09 §3.6: stale poll write skipped after force* mutated the record');
  } finally {
    restore();
  }
});

test('BUG-09 §3.7: forgetAgent drops latch + statusHoldUntil', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    (monitor as any).statusHoldUntil.set(agent.id, fakes.now.value + 10_000);
    assert.ok(monitor.getLatchSnapshot(agent.id), 'latch seeded');
    assert.ok((monitor as any).statusHoldUntil.has(agent.id), 'hold seeded');

    monitor.forgetAgent(agent.id);

    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'latch dropped');
    assert.ok(!(monitor as any).statusHoldUntil.has(agent.id), 'hold dropped');
  } finally {
    restore();
  }
});

// ── BUG-09 §3.5 (Bundle 3) — dual PTY signal logic ───────────────────

test('BUG-09 §3.5: spinner-only redraws keep a working agent from downgrading', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Simulate the Coalescing window: meaningful burst stale (>8s ago),
    // raw output fresh (spinner glyph just redrew). Pre-Bundle-3 logic
    // looked at the meaningful signal only and would have returned 'idle'.
    fakes.now.value += 15_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 15_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - 100);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'BUG-09 §3.5: raw PTY freshness keeps a working agent working');
  } finally {
    restore();
  }
});

test('BUG-09 §3.5: idle agent does NOT promote on raw-only PTY freshness', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });

    // Meaningful stale, raw fresh — but the agent is currently idle.
    // The "raw keeps working alive" rule must NOT promote idle → working.
    fakes.now.value += 15_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 15_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - 100);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'idle agent stays idle without a meaningful burst — raw alone is not enough');
  } finally {
    restore();
  }
});

test('BUG-09 §3.5: working → idle once BOTH PTY signals go stale', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    fakes.now.value += 20_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 20_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - 15_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'both signals stale → real downgrade fires (the latch covers the false-positive case)');
  } finally {
    restore();
  }
});

test('latch invalidation: a second forceIdle/forceWaiting overwrites the prior latch state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    const t1 = monitor.getLatchSnapshot(agent.id);
    assert.ok(t1 && t1.state === 'idle');

    fakes.now.value += 1_000;
    monitor.forceWaiting(agent.id, 'enter', 'Press Enter');
    const t2 = monitor.getLatchSnapshot(agent.id);
    assert.ok(t2 && t2.state === 'waiting' && t2.waitingExcerpt === 'Press Enter');
    assert.ok(t2.setAt > t1.setAt, 'latch setAt advances on overwrite');
  } finally {
    restore();
  }
});

// ── BUG-18 Changes 1, 2, 3 ───────────────────────────────────────────

test('BUG-18 Change 1: thinking-pending latch survives past model-pending but expires at thinking-pending ceiling', async () => {
  // The Claude xhigh-effort case from plans/status-flip-bug18-investigation-claude.md §1.
  // A `thinking` event refreshes the latch with ttlClass='thinking-pending'.
  // Pre-Change-1 the latch's effective TTL was always model-pending; Change 1
  // makes ttlClass=thinking-pending hold past the model-pending ceiling.
  // §12.5 migration: makeWorker now defaults isSupervised:false, so we
  // exercise the unsupervised tier (thinking-pending=120 s, model-pending=30 s).
  // Semantic intent ("thinking-pending class outlives model-pending TTL") is
  // preserved.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'thinking', ttlClass: 'thinking-pending' });
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.ttlClass, 'thinking-pending');

    // Past model-pending TTL but well inside thinking-pending. PTY stale, so
    // the only thing keeping the agent working is the ttlClass ceiling.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 5_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    let inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'thinking-pending holds working through a gap longer than model-pending');

    // Push past the thinking-pending ceiling — latch must finally expire.
    fakes.now.value += WORKING_LATCH_THINKING_PENDING_UNSUPERVISED_MS;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'thinking-pending latch expires at its ceiling');
  } finally {
    restore();
  }
});

test('BUG-18 Change 1: thinking-pending boundary — still working at exactly the thinking-pending ceiling', async () => {
  // §12.5: see sibling test above. Unsupervised constants now.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'thinking', ttlClass: 'thinking-pending' });
    fakes.now.value += WORKING_LATCH_THINKING_PENDING_UNSUPERVISED_MS;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'TTL window is inclusive at the ceiling');
  } finally {
    restore();
  }
});

test('BUG-18 Change 2: user-input-submitted seed (tool-pending) survives past model-pending with no chat events', async () => {
  // Mirrors the production seed at src/main/supervisor/index.ts after
  // sendInput delivery: forceWorking(agentId, { source:'user-input-submitted',
  // ttlClass:'tool-pending' }). Before Change 2 this was model-pending, too
  // tight for first-turn extended thinking. §12.5 migration: unsupervised tier
  // (tool-pending=120 s, model-pending=30 s); semantic ("tool-pending seed
  // outlives model-pending TTL") preserved.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'user-input-submitted',
      ttlClass: 'tool-pending',
    });

    // Failure window: no chat events fire past model-pending, PTY stale.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 30_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'BUG-18 Change 2: tool-pending seed holds through a model-pending-exceeding silent gap');
  } finally {
    restore();
  }
});

// Removed §12.5: two BUG-18 Change 3 tests that asserted turnInFlight
// promotes the effective TTL to tool-pending past the model-pending
// ceiling. That promotion only lives in the supervised-non-supervisor
// branch of inferStatus (status-monitor.ts:689-692), which is no longer
// reachable now that the Class IV skip returns null for any supervised
// worker. The Change 3 latch-state recording (sticky turnInFlight, no
// auto-clear on refresh) is still covered by the two tests below.

test('BUG-18 Change 3: turnInFlight is sticky-true across refreshes that omit the flag', async () => {
  // The bridge sets turnInFlight=true on tool-use/task-started/non-terminal
  // assistant-text. Other refreshes (tool-result, user-text) don't set it.
  // Sticky semantics: once true, subsequent refreshes preserve it until
  // forceIdle clears the whole latch.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'task-started',
      ttlClass: 'model-pending',
      turnInFlight: true,
    });
    let latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working' && latch.turnInFlight === true);

    // A refresh without turnInFlight (e.g. tool-result) must NOT clear it.
    monitor.forceWorking(agent.id, {
      source: 'tool-result',
      resolvedToolUseId: 'X',
      ttlClass: 'tool-pending',
    });
    latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.turnInFlight, true,
      'turnInFlight stays true across a refresh that omits the flag');
  } finally {
    restore();
  }
});

test('BUG-18 Change 3: turnInFlight stays false when never set (no impact on legacy paths)', async () => {
  // Regression guard: forceWorking calls that don't carry turnInFlight (e.g.
  // direct `notifyUserInputDelivered` from sendInput on a waiting agent)
  // must not silently flip the override on.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'user-input',
      ttlClass: 'model-pending',
    });
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.turnInFlight, false,
      'turnInFlight defaults to false when the caller omits the flag');

    // Past model-pending TTL with no tools and no turnInFlight — latch must
    // expire on schedule (no Change-3 override). PTY is stale → idle.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'without turnInFlight, model-pending still expires at 180 s as before');
  } finally {
    restore();
  }
});

// Supervisor short-latch — the supervisor reads only its own status (via the
// /input gate and event-bridge queue gate), so it bypasses the long
// worker-shaped TTLs and uses SUPERVISOR_WORKING_LATCH_MS instead. The
// turnInFlight ceiling and tool-pending floor are also skipped.
test('supervisor short-latch: tool-pending TTL is ignored, latch expires at SUPERVISOR_WORKING_LATCH_MS', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('sup-1', { status: 'working', isSupervisor: true });
    const monitor = makeMonitor({ fakes, agent });

    // Same refresh shape a worker would get: tool-pending ttlClass, turnInFlight set.
    monitor.forceWorking(agent.id, {
      source: 'tool-use',
      toolUseId: 'X',
      ttlClass: 'tool-pending',
      turnInFlight: true,
    });

    // Within the short latch window: still working.
    fakes.now.value += SUPERVISOR_WORKING_LATCH_MS - 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    let inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'within SUPERVISOR_WORKING_LATCH_MS, supervisor stays working');

    // Past the short latch — for a worker, tool-pending (900s) and turnInFlight
    // would both still hold this as `working`. For a supervisor it must flip.
    fakes.now.value += 2_000; // total elapsed > SUPERVISOR_WORKING_LATCH_MS
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'past SUPERVISOR_WORKING_LATCH_MS with stale PTY, supervisor flips to idle ' +
      'regardless of tool-pending/turnInFlight that would hold a worker for 15 min');
  } finally {
    restore();
  }
});

test('supervisor short-latch: non-supervisor under identical state retains tool-pending ceiling (regression guard)', async () => {
  // Mirror of the previous test with isSupervisor:false — proves the bypass
  // is scoped and we haven't accidentally shortened the worker path.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working', isSupervisor: false });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'tool-use',
      toolUseId: 'X',
      ttlClass: 'tool-pending',
      turnInFlight: true,
    });

    // Far past SUPERVISOR_WORKING_LATCH_MS, well within tool-pending TTL.
    fakes.now.value += SUPERVISOR_WORKING_LATCH_MS + 60_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'worker keeps tool-pending ceiling (900s) — supervisor bypass did not leak');
  } finally {
    restore();
  }
});

// ── Tightened TTLs for unsupervised non-supervisor agents ───────────
// See plans/tighten-inference-for-unsupervised-agents.md. The unsupervised
// lane has no supervisor consumer reacting expensively to false-idle, so
// the worker-shaped 180 s / 900 s ceilings are replaced with 30 s / 120 s.
// `turnInFlight` promotion (BUG-18 Change 3) is intentionally dropped for
// unsupervised — its purpose is supervisor protection.

test('unsupervised: model-pending latch decays at 30 s, not 180 s', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('u-1', { status: 'working', isSupervised: false });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    // Just past the unsupervised model-pending ceiling, well below the
    // supervised one. PTY is stale on both signals so only the latch
    // could be holding `working`.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'unsupervised model-pending expires at 30 s (not the 180 s supervised ceiling)');
  } finally {
    restore();
  }
});

test('unsupervised: model-pending boundary — still working just inside 30 s', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('u-1', { status: 'working', isSupervised: false });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    // 1 s inside the ceiling. Spinner-only PTY stays stale on meaningful but
    // raw byte path is fresh — so even if the latch held, PTY fallback would
    // also vote working. To isolate the latch, stale both signals:
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS - 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'inside the unsupervised model-pending window, latch still holds working');
  } finally {
    restore();
  }
});

test('unsupervised: tool-pending latch decays at 120 s, not 900 s', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('u-1', { status: 'working', isSupervised: false });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    // Resolve the tool so `hasOutstandingTools` is false; the stored
    // ttlClass ('tool-pending') is what we're testing the ceiling for.
    monitor.forceWorking(agent.id, {
      source: 'tool-result',
      resolvedToolUseId: 'A',
      ttlClass: 'tool-pending',
    });

    fakes.now.value += WORKING_LATCH_TOOL_PENDING_UNSUPERVISED_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'unsupervised tool-pending expires at 120 s (not the 900 s supervised ceiling)');
  } finally {
    restore();
  }
});

test('unsupervised: outstanding tool still floors at 120 s tool-pending', async () => {
  // The hasOutstandingTools floor is kept for unsupervised — we just lowered
  // its value. While a tool is genuinely outstanding, the latch holds past
  // the 30 s model-pending ceiling up to the 120 s tool-pending ceiling.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('u-1', { status: 'working', isSupervised: false });
    const monitor = makeMonitor({ fakes, agent });

    // Seed with model-pending then add an outstanding tool — outstanding
    // tools must promote the effective TTL up to tool-pending regardless of
    // the stored class.
    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'X', ttlClass: 'model-pending' });

    // 90 s elapsed: well past 30 s model-pending, under 120 s tool-pending.
    fakes.now.value += 90_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'outstanding tool floors the effective TTL at 120 s for unsupervised');
  } finally {
    restore();
  }
});

test('unsupervised: thinking-pending latch decays at 120 s, not 900 s', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('u-1', { status: 'working', isSupervised: false });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'thinking', ttlClass: 'thinking-pending' });

    fakes.now.value += WORKING_LATCH_THINKING_PENDING_UNSUPERVISED_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'unsupervised thinking-pending expires at 120 s (not the 900 s supervised ceiling)');
  } finally {
    restore();
  }
});

test('unsupervised: turnInFlight does NOT promote the effective TTL', async () => {
  // BUG-18 Change 3's turnInFlight promotion exists to suppress false-idle
  // events that a supervisor would react to. For unsupervised agents there
  // is no such consumer; the model-pending ceiling fires at 30 s even when
  // turnInFlight is set.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('u-1', { status: 'working', isSupervised: false });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'assistant-text',
      ttlClass: 'model-pending',
      turnInFlight: true,
    });
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.turnInFlight, true,
      'turnInFlight is still recorded on the latch (write path unchanged)');

    // 35 s elapsed — past the unsupervised model-pending ceiling. For a
    // supervised agent, turnInFlight would promote to tool-pending (900 s)
    // and hold working. For unsupervised, it must flip idle.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 5_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'unsupervised lane skips the turnInFlight promotion (BUG-18 Change 3 is supervisor-targeted)');
  } finally {
    restore();
  }
});

// Removed §12.5: "supervised Codex still uses 900 s tool-pending" and
// "supervised Gemini still uses 900 s thinking-pending". Both are
// directly contradicted by the broadened Class IV skip — any supervised
// worker now bypasses inference entirely, so the supervised-tier TTL
// branch (status-monitor.ts:684) is no longer reachable for non-supervisor
// agents. The Class IV section below covers the new behavior.

test('unsupervised non-regression: supervised Claude agent does NOT pick up unsupervised ceilings (Plan 1 short-circuits)', async () => {
  // Originally written under Plan 2 to assert "supervised Claude retains
  // the 180 s supervised ceiling." Re-classified once Plan 1 landed: a
  // supervised Claude worker now hits the Class IV inference-skip at the
  // top of inferStatus and returns null (the latch-driven status wins).
  // The semantic intent is preserved — the unsupervised tightening still
  // must not leak into the supervised-Claude lane — but the verification
  // shape changed from "supervised TTL fires" to "no inference flip at all."
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    // Same setup as before — past unsupervised model-pending, inside the
    // old supervised model-pending. With Plan 1 the lane is now skipped.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 5_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Claude bypasses inference entirely (Plan 1 §2.1) — ' +
      'unsupervised tightening did not leak into this lane');
  } finally {
    restore();
  }
});

// ── Class IV inference-skip for supervised workers ─────────────────
// See plans/disable-inference-for-supervised-claude-workers.md +
// plans/class-iv-worker-hook-scaffold.md §12.5 (broadening). inferStatus
// returns null for `isSupervised` (any provider), letting the Stop-hook +
// notifyUserInputDelivered latch state become the sole truth source. The
// alive check above the short-circuit preserves done/crashed detection.
// Unsupervised workers and the supervisor itself keep their existing
// inference behavior. Gemini supervised workers also hit the skip even
// though their hook scaffold isn't landed yet (§12.2) — that's the
// intentional trade-off so missing scaffolds are visible, not masked.

test('Class IV: supervised Claude worker — inferStatus returns null (short-circuit)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    // No latch armed, PTY stale on both signals — under the unsupervised or
    // supervised codex/gemini lanes this would return 'idle'. With Plan 1
    // the lane is skipped and inference returns null (latch wins).
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Claude bypasses inference — null signals "no change" to the poll loop');
  } finally {
    restore();
  }
});

test('Class IV: supervised Claude worker — alive check still produces done on exit 0', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
      lastExitCode: 0,
    });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'done',
      'alive check runs above the Class IV short-circuit; done/crashed detection preserved');
  } finally {
    restore();
  }
});

test('Class IV: supervised Claude worker — alive check still produces crashed on non-zero exit', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
      lastExitCode: 137,
    });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'crashed',
      'crashed detection preserved for supervised Claude (alive check above the short-circuit)');
  } finally {
    restore();
  }
});

test('Class IV: supervised Codex worker — inference is now skipped (broadened §12.5)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-codex', {
      status: 'working',
      isSupervised: true,
      provider: 'codex',
    });
    const monitor = makeMonitor({ fakes, agent });

    // Even with a working-latch armed and PTY signals stale (which would
    // previously promote idle via inference), the Class IV skip now returns
    // null — the Stop-hook is the sole idle-truth source for codex too.
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    fakes.now.value += 60_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Codex bypasses inference (Class IV gate broadened per §12.5)');
  } finally {
    restore();
  }
});

test('Class IV: supervised Gemini worker — inference is now skipped (broadened §12.5)', async () => {
  // Gemini has no hook scaffold yet (§12.2 follow-up), so a supervised
  // Gemini worker has NO idle-truth source after this broadening except
  // chat-stream/turn-complete events. The user explicitly accepts that —
  // they want missing scaffolds visible. Test asserts the skip semantics,
  // not the downstream consequence.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-gemini', {
      status: 'working',
      isSupervised: true,
      provider: 'gemini',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'thinking', ttlClass: 'thinking-pending' });
    fakes.now.value += 300_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Gemini bypasses inference (Class IV gate broadened per §12.5)');
  } finally {
    restore();
  }
});

test('Class IV: unsupervised Claude agent — inference still runs (Plan 2 snappy lane)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('u-claude', {
      status: 'working',
      isSupervised: false,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    // Past the unsupervised 30 s model-pending ceiling — must flip idle, not
    // null. Confirms the Class IV gate is `isSupervised`, not just `provider`:
    // unsupervised Claude agents still run inference.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'unsupervised Claude hits the Plan 2 unsupervised lane, not the Class IV skip');
  } finally {
    restore();
  }
});

test('Class IV: isSupervisor + provider Claude — still uses supervisor short-latch (not Class IV skip)', async () => {
  // isSupervisor:true sets isSupervised:false in production, but the Class
  // IV gate is `isSupervised` (any provider) so a hypothetical isSupervisor
  // agent never reaches it regardless. This asserts the supervisor lane
  // wins over Class IV when both could theoretically apply.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('sup-claude', {
      status: 'working',
      isSupervised: false,
      isSupervisor: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'tool-use',
      toolUseId: 'X',
      ttlClass: 'tool-pending',
      turnInFlight: true,
    });

    // Past SUPERVISOR_WORKING_LATCH_MS — supervisor flips idle even though
    // tool-pending + turnInFlight would hold a worker for 15 min.
    fakes.now.value += SUPERVISOR_WORKING_LATCH_MS + 2_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'supervisor lane fires; Class IV skip does not apply (gate is isSupervised, not isSupervisor)');
  } finally {
    restore();
  }
});

// ── Class IV §2.2 hook-silence watchdog (BUG-23 reframe) ────────────

/** Capture console.warn calls for the duration of a watchdog test. Restored
 *  in finally. Tests assert against the captured array. */
function captureWarn(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

/** Test seam — invoke the private watchdog directly. Mirrors the inferStatus
 *  accessor pattern above. */
function checkWatchdog(monitor: StatusMonitor, agent: Agent): void {
  (monitor as any).checkHookSilenceWatchdog(agent);
}

test('watchdog: supervised Claude idle >15 min after input delivered with NO hook ever fires a warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    // Input delivered 20 minutes ago; never any Stop-hook event.
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 1,
      'BUG-23 reframe: scaffold-broken signature (input in, no hook ever) fires once');
    assert.match(warn.warnings[0], /\[class-iv\]/, 'warning is tagged for Class IV scaffold');
    assert.match(warn.warnings[0], /w-claude/, 'warning identifies the agent');
    assert.match(warn.warnings[0], /no Stop-hook event has ever been recorded/,
      'warning explains the scaffold-broken signature directly');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: any prior hook recorded suppresses warning (scaffold works)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);
    // Hook fired ever, even long ago — scaffold is proven working.
    monitor.recordHookEventAt(agent.id, fakes.now.value - 16 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 0,
      'any prior hook proves scaffold works — watchdog stays silent');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: no input delivered yet → no warning (hook absence is expected pre-input)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
      createdAt: new Date(fakes.now.value - 60 * 60 * 1000).toISOString(),
    });
    const monitor = makeMonitor({ fakes, agent });

    // Agent has existed for an hour but never received input. No hook
    // expected; no warning warranted.
    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 0,
      'no input delivered → hook absence is expected → no warning');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: dedupes repeated polls within the cooldown window', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);
    fakes.now.value += 1_000;
    checkWatchdog(monitor, agent);
    fakes.now.value += 1_000;
    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 1,
      'three checks inside the cooldown produce a single warning');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: supervised Codex idle >15 min with NO hook fires a warning (broadened §12.5)', () => {
  // Codex now has a Stop-hook scaffold (§12.1) — the watchdog must catch a
  // codex-side scaffold break (missing .codex/config.toml, missing env, etc.)
  // the same way it catches a Claude-side break.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-codex', {
      status: 'idle',
      isSupervised: true,
      provider: 'codex',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 1,
      'supervised Codex now also has a Stop-hook scaffold — watchdog fires on silence');
    assert.match(warn.warnings[0], /\[class-iv\]/, 'warning is tagged for Class IV scaffold');
    assert.match(warn.warnings[0], /supervised codex worker/,
      'warning attributes the silent-hook signal to codex specifically');
    assert.match(warn.warnings[0], /w-codex/, 'warning identifies the agent');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: unsupervised Claude is NOT watched (out of scope)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('u-claude', {
      status: 'idle',
      isSupervised: false,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 0,
      'unsupervised Claude has no hook scaffold — watchdog must not fire');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: status flipping out of idle clears the dedupe; back to idle re-arms', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);
    assert.equal(warn.warnings.length, 1, 'first warning fires');

    // Status flips to working (the user manually intervened, or another
    // input went in) — must clear dedupe.
    agent.status = 'working';
    checkWatchdog(monitor, agent);
    assert.equal(warn.warnings.length, 1, 'no warning while working');

    // Back to idle with still no hook ever fired.
    agent.status = 'idle';
    fakes.now.value += 1_000;
    checkWatchdog(monitor, agent);
    assert.equal(warn.warnings.length, 2,
      'fresh idle re-entry with still no hook re-arms the warning');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: forgetAgent clears the hook-event + input-delivered + dedupe state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordHookEventAt(agent.id, fakes.now.value);
    monitor.recordInputDelivered(agent.id, fakes.now.value);
    assert.equal(monitor.getLastHookEventAt(agent.id), fakes.now.value);

    monitor.forgetAgent(agent.id);
    assert.equal(monitor.getLastHookEventAt(agent.id), undefined,
      'forgetAgent drops the hook-event timestamp — no stale state across restarts');
    // Re-arming a watchdog test after forgetAgent should produce no warning
    // because lastInputDeliveredAt was cleared too.
    const warn = captureWarn();
    try {
      fakes.now.value += 20 * 60 * 1000;
      checkWatchdog(monitor, agent);
      assert.equal(warn.warnings.length, 0,
        'forgetAgent also clears lastInputDeliveredAt so no false warning fires');
    } finally {
      warn.restore();
    }
  } finally {
    restore();
  }
});

// ── BUG-23 launch settle timer + promoteFromLaunching ───────────────────

/** Test seam — invoke the private poll() once. */
async function pollOnce(monitor: StatusMonitor): Promise<void> {
  await (monitor as any).poll();
}

test('BUG-23: supervised Claude in launching → idle at settle (no hook fires)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Just before the budget — no promotion yet.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude - 1;
    await pollOnce(monitor);
    assert.equal(agent.status, 'launching', 'still launching just before budget');
    assert.equal(fakes.emissions.length, 0, 'no emission before budget');

    // Cross the budget threshold — should promote on the next tick.
    fakes.now.value += 2;
    await pollOnce(monitor);
    assert.equal(agent.status, 'idle', 'promoted to idle after settle');
    assert.equal(fakes.emissions.length, 1);
    assert.equal(fakes.emissions[0].status, 'idle');
    assert.equal(fakes.emissions[0].fromStatus, 'launching');
    assert.equal(fakes.emissions[0].source, 'monitor');
    // The audit row carries the source descriptor.
    const audit = fakes.audit.find(r => r.type === 'status_change');
    assert.ok(audit && audit.payload.includes('launch-settle'),
      'status_change audit row records the launch-settle source');
  } finally {
    restore();
  }
});

test('BUG-23: Stop hook arriving mid-settle promotes via hook path; settle no-ops next tick', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Half-way through the settle window: hook fires.
    fakes.now.value += Math.floor(LAUNCH_SETTLE_TIMEOUT_MS.claude / 2);
    const ok = monitor.promoteFromLaunching(agent.id, 'stop-hook');
    assert.equal(ok, true, 'hook promotion returns true');
    assert.equal(agent.status, 'idle', 'hook drove the agent to idle inside settle');
    const audit = fakes.audit.find(r => r.type === 'status_change');
    assert.ok(audit && audit.payload.includes('stop-hook'),
      'status_change audit row records the stop-hook source');
    const emissionsBefore = fakes.emissions.length;

    // Cross the budget. The settle check must NOT emit a second status_change.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude;
    await pollOnce(monitor);
    assert.equal(fakes.emissions.length, emissionsBefore,
      'launchedAt was cleared by promoteFromLaunching — settle timer no-ops');
  } finally {
    restore();
  }
});

test('BUG-23: non-supervised codex promotes at codex settle (25s default)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-codex', {
      status: 'launching',
      isSupervised: false,
      provider: 'codex',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.codex - 1;
    await pollOnce(monitor);
    assert.equal(agent.status, 'launching', 'still launching just before codex budget');

    fakes.now.value += 2;
    await pollOnce(monitor);
    assert.equal(agent.status, 'idle', 'promoted at codex settle budget');
    assert.equal(LAUNCH_SETTLE_TIMEOUT_MS.codex, 25_000,
      'codex default budget matches spec');
  } finally {
    restore();
  }
});

test('BUG-23: terminal exit during launch — clearLaunch wipes settle timer; no spurious promote on next tick', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    // Simulate "runner exited and the runner.on('exit') handler wrote crashed".
    // getActiveAgents excludes crashed/done, but we directly exercise
    // checkLaunchSettle's defensive behavior via clearLaunch.
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Crash happens mid-launch.
    agent.status = 'crashed';
    monitor.clearLaunch(agent.id);

    // Even if poll() were called against this agent, promotion must not fire
    // — agent is no longer launching, and the stamp was cleared.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude * 2;
    await pollOnce(monitor);
    assert.equal(agent.status, 'crashed', 'stays crashed; no promotion');
    const promoteEmissions = fakes.emissions.filter(e => e.status === 'idle');
    assert.equal(promoteEmissions.length, 0, 'no idle promotion emitted');
  } finally {
    restore();
  }
});

test('BUG-23: forgetAgent clears launchedAt + lastLaunchOverrunWarnAt', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    monitor.forgetAgent(agent.id);

    // After forgetAgent, the agent has no stamp. promoteFromLaunching from a
    // launch-settle source should still work as a logical promotion if the
    // agent is in 'launching' state — but checkLaunchSettle skips entirely
    // when no stamp is set (the "reconnect / no recordLaunch" lane), so no
    // promotion fires.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude * 3;
    await pollOnce(monitor);
    assert.equal(agent.status, 'launching',
      'forgetAgent dropped the stamp → settle check no-ops on the launching agent');
  } finally {
    restore();
  }
});

test('BUG-23: promoteFromLaunching refuses when not in launching status', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    const ok = monitor.promoteFromLaunching(agent.id, 'stop-hook');
    assert.equal(ok, false, 'guard blocks bypass when not in launching');
    assert.equal(agent.status, 'working', 'status unchanged');
    assert.equal(fakes.emissions.length, 0, 'no emission');
  } finally {
    restore();
  }
});

test('BUG-23: promoteFromLaunching with source="other" refuses (canForceTransition gate)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    const ok = monitor.promoteFromLaunching(agent.id, 'other');
    assert.equal(ok, false, 'only launch-settle and stop-hook bypass the guard');
    assert.equal(agent.status, 'launching', 'status unchanged');
  } finally {
    restore();
  }
});

test('BUG-23: settle-overrun grace fires the narrow timer-misbehaving warning', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Force the agent past budget + grace. To trigger the warning rather
    // than have promoteFromLaunching succeed and clear the stamp, we
    // pre-empt promotion by flipping the in-memory agent record's status
    // back to 'launching' right before poll (simulating a DB lag scenario).
    // Simpler: just verify checkLaunchSettle path warns when overrun is
    // present by calling it directly with a stamp deep in the past, then
    // assert the warning shape.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude + LAUNCH_SETTLE_OVERRUN_GRACE_MS + 100;
    // Re-stamp launch into the past so the elapsed delta is meaningful.
    // (recordLaunch defaults to now(); we need it stale.)
    (monitor as any).launchedAt.set(agent.id, fakes.now.value - (LAUNCH_SETTLE_TIMEOUT_MS.claude + LAUNCH_SETTLE_OVERRUN_GRACE_MS + 100));
    await pollOnce(monitor);

    assert.equal(agent.status, 'idle',
      'still promotes on the same tick (warning is belt-and-suspenders)');
    assert.ok(warn.warnings.length >= 1,
      'overrun warning emitted at least once');
    assert.ok(warn.warnings.some(w => w.includes('launch-settle overrun')),
      'narrow warning carries the bug-23 tag');
  } finally {
    warn.restore();
    restore();
  }
});

// ── Class IV UserPromptSubmit start-hook forceWorking + watchdog ──────

function checkStartHookSilence(monitor: StatusMonitor, agent: Agent): void {
  (monitor as any).checkStartHookSilence(agent);
}

test('forceWorking(source) string overload: idle → working flips status + arms working latch', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, 'hook-start');

    assert.equal(fakes.updates.length, 1, 'status write happened');
    assert.equal(fakes.updates[0].status, 'working');
    assert.equal(fakes.emissions.length, 1);
    assert.equal(fakes.emissions[0].status, 'working');
    assert.equal(fakes.emissions[0].fromStatus, 'idle');
    assert.equal(fakes.emissions[0].source, 'monitor');

    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working', 'working latch armed');
  } finally {
    restore();
  }
});

test('forceWorking(source) string overload: no-op on terminal status', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'crashed', isSupervised: true, provider: 'claude', lastExitCode: 1 });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    monitor.forceWorking(agent.id, 'hook-start');

    assert.equal(fakes.updates.length, 0, 'crashed → forceWorking(source) is a no-op');
    assert.equal(fakes.emissions.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

test('forceWorking(source) string overload: no-op on transitional status (launching)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'launching', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, 'hook-start');

    assert.equal(fakes.updates.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

test('start-hook watchdog: supervised idle, input delivered ≥3s ago, no start hook → warns once + emits status-change', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);

    assert.equal(warn.warnings.length, 1, 'fired exactly once');
    assert.match(warn.warnings[0], /\[bug-10\]/, 'warning is tagged for the paste-race fix');
    assert.match(warn.warnings[0], /UserPromptSubmit/);

    const startEmissions = fakes.emissions.filter((e) => e.source === 'start-hook-silence-watchdog');
    assert.equal(startEmissions.length, 1, 'one watchdog event emitted');
    assert.equal(startEmissions[0].status, 'idle');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: dedupes per input delivery (no re-warn within the same turn)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);
    fakes.now.value += 1_500;
    checkStartHookSilence(monitor, agent);
    fakes.now.value += 1_500;
    checkStartHookSilence(monitor, agent);

    assert.equal(warn.warnings.length, 1, 'one warning across multiple polls within the same turn');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: fresh input delivery re-arms after a prior warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 1, 'first warning fires');

    fakes.now.value += 10_000;
    monitor.recordInputDelivered(agent.id, fakes.now.value);
    fakes.now.value += START_HOOK_SILENCE_WARN_MS + 500;
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 2, 'second input delivery re-arms the watchdog');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: start hook landing after input silences the warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    const inputAt = fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500);
    monitor.recordInputDelivered(agent.id, inputAt);
    monitor.recordStartHookEventAt(agent.id, inputAt + 100);

    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 0, 'a start-hook arrival silences the watchdog');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: prior Stop-hook does NOT satisfy a missed UserPromptSubmit', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    monitor.recordHookEventAt(agent.id, fakes.now.value);

    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 1,
      'a Stop-hook arrival cannot mask a missing UserPromptSubmit — the bug we are detecting');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: status !== idle → no warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'working', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);

    assert.equal(warn.warnings.length, 0, 'no warning when the dashboard is not lying (status != idle)');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: under the threshold → no warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS - 500));
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 0,
      'inside the START_HOOK_SILENCE_WARN_MS budget — too early to warn');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: unsupervised agents are NOT watched', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('u-claude', { status: 'idle', isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 0,
      'unsupervised agents do not run the supervised hook scaffold — out of scope');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: forgetAgent clears the start-hook + dedupe state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordStartHookEventAt(agent.id, fakes.now.value);
    assert.equal(monitor.getLastStartHookEventAt(agent.id), fakes.now.value);

    monitor.forgetAgent(agent.id);
    assert.equal(monitor.getLastStartHookEventAt(agent.id), undefined,
      'forgetAgent drops the start-hook timestamp');
  } finally {
    restore();
  }
});

// ── BUG-10 Enter-resend recovery (checkStartHookResend) ──────────────
/** Test seam — invoke the private resend recovery directly. */
function checkStartHookResend(monitor: StatusMonitor, agent: Agent): void {
  (monitor as any).checkStartHookResend(agent);
}

/** Wire a recording resubmit handler; returns the array it pushes agent ids into. */
function armResubmit(monitor: StatusMonitor): string[] {
  const resends: string[] = [];
  monitor.setResubmitHandler((id) => resends.push(id));
  return resends;
}

test('resend: claude worker idle ≥3s after input with no start hook → resends Enter', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [agent.id], 'exactly one Enter resend fired');
    assert.match(warn.warnings.join('\n'), /\[bug-10\] resending Enter/, 'logs the resend');
  } finally {
    warn.restore();
    restore();
  }
});

test('resend: no resend before START_HOOK_RESEND_AFTER_MS elapses', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS - 500));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'genuine hook still has time to round-trip — no resend yet');
  } finally {
    restore();
  }
});

test('resend: a UserPromptSubmit hook since the input cancels the resend', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    const inputAt = fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100);
    monitor.recordInputDelivered(agent.id, inputAt);
    monitor.recordStartHookEventAt(agent.id, inputAt + 50); // submit took
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'the start hook proves the submit landed — nothing to resend');
  } finally {
    restore();
  }
});

test('resend: working status (hook already flipped it) → no resend', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'working', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'working means the submit took — never resend');
  } finally {
    restore();
  }
});

test('resend: bounded at START_HOOK_RESEND_MAX_ATTEMPTS, spaced by the interval', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    // Hammer the watchdog every 1.5s well past the budget; only MAX attempts fire.
    for (let i = 0; i < 10; i++) {
      checkStartHookResend(monitor, agent);
      fakes.now.value += START_HOOK_RESEND_INTERVAL_MS;
    }

    assert.equal(resends.length, START_HOOK_RESEND_MAX_ATTEMPTS,
      `resends cap at ${START_HOOK_RESEND_MAX_ATTEMPTS} then defer to the warn-only watchdog`);
  } finally {
    warn.restore();
    restore();
  }
});

test('resend: a fresh input delivery re-arms the attempt budget', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    // Exhaust the budget on turn 1.
    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    for (let i = 0; i < 10; i++) {
      checkStartHookResend(monitor, agent);
      fakes.now.value += START_HOOK_RESEND_INTERVAL_MS;
    }
    const afterTurn1 = resends.length;

    // Turn 2: new input delivery resets the counter.
    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.equal(resends.length, afterTurn1 + 1, 'a new turn gets a fresh resend budget');
  } finally {
    warn.restore();
    restore();
  }
});

test('resend: gemini worker is NOT resent (no UserPromptSubmit hook to gate on)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-gemini', { status: 'idle', isWorker: true, isSupervised: false, provider: 'gemini' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'gemini has no start hook, so idle is not evidence of a dropped Enter');
  } finally {
    restore();
  }
});

test('resend: non-worker unsupervised agent is NOT resent', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('u-claude', { status: 'idle', isWorker: false, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'non-worker agents derive working from inference, not the hook');
  } finally {
    restore();
  }
});

// ── Launch-time hook canary (HOOK_SYSTEM_DESIGN.md §5.4 / B5) ──────────

// Drive a poll tick the same way the live loop does.
function poll(monitor: StatusMonitor): Promise<void> {
  return (monitor as any).poll();
}

test('canary: marks hook_status=broken after the window with no hook event', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cw-1', { provider: 'codex', isSupervised: true, status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value);

    // Before the window elapses: poll must not flip anything.
    await poll(monitor);
    assert.equal(fakes.hookUpdates.length, 0, 'no hook-status write before the window elapses');
    assert.ok(monitor.isHookCanaryArmed(agent.id), 'canary stays armed before the window');

    // Window elapses with no hook → broken.
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(fakes.hookUpdates.length, 1, 'canary writes hook_status exactly once');
    assert.equal(fakes.hookUpdates[0].agentId, agent.id);
    assert.equal(fakes.hookUpdates[0].hookStatus, 'broken');
    assert.ok(!monitor.isHookCanaryArmed(agent.id), 'canary disarms after firing');

    // The canary must NOT touch `status` (no status write to anything else).
    assert.ok(
      !fakes.updates.some((u) => u.agentId === agent.id),
      `canary must not change status; got updates ${JSON.stringify(fakes.updates)}`,
    );

    // A second poll must not re-fire.
    await poll(monitor);
    assert.equal(fakes.hookUpdates.length, 1, 'canary fires at most once per arm');
  } finally {
    restore();
  }
});

test('canary: a hook event before the window disarms it → never marked broken', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cw-2', { provider: 'codex', isSupervised: true, status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value);

    // A hook arrives inside the window — the supervisor's stampHookHealthy
    // calls clearHookCanary (emulated directly here).
    monitor.clearHookCanary(agent.id);
    assert.ok(!monitor.isHookCanaryArmed(agent.id), 'canary disarmed by the hook');

    // Window elapses; poll must NOT mark broken.
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);
    assert.equal(
      fakes.hookUpdates.filter((h) => h.hookStatus === 'broken').length,
      0,
      'a healthy hook before the window must prevent a broken verdict',
    );
  } finally {
    restore();
  }
});

test('canary: does not clobber a degraded (B2) hook_status', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    // B2 marked this codex worker degraded at launch; the canary was never
    // armed for it. Even if armed, the 'unknown'-only guard protects it.
    const agent = makeAgent('cw-3', { provider: 'codex', isSupervised: true, status: 'idle', hookStatus: 'degraded' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value);

    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(
      fakes.hookUpdates.filter((h) => h.hookStatus === 'broken').length,
      0,
      'canary must not overwrite a degraded status with broken',
    );
    assert.equal(agent.hookStatus, 'degraded', 'degraded status is preserved');
  } finally {
    restore();
  }
});

// ── Synchronous submit confirmation (plan §1 part 1, §2.3, §2.4, Q4) ─────
//
// confirmSubmission's POLL/WINDOW timing rides the injectable clock (advanced
// by a fake `sleep`); the CONFIRMATION COMPARISON
// (`getLastStartHookEventAt > priorStartHookAt`) is the Date.now-based recorded
// hook ts vs the pre-send baseline. These tests drive the fake clock + fire the
// start hook at chosen moments to exercise every branch.

interface ConfirmCtx {
  monitor: StatusMonitor;
  presses: { count: number };
  now: number;
}

/** Build a StatusMonitor wired for confirmSubmission tests: a fake `sleep`
 *  advances the fake clock and runs `onSleep`; the resubmit handler counts
 *  presses and runs `onPress`. */
function makeConfirmMonitor(
  fakes: ReturnType<typeof makeStatusMonitorFakes>,
  agent: Agent,
  opts: { onSleep?: (ctx: ConfirmCtx) => void; onPress?: (ctx: ConfirmCtx) => void } = {},
): { monitor: StatusMonitor; presses: { count: number } } {
  fakes.agents.set(agent.id, agent);
  fakes.aliveOverride.set(agent.id, true);
  const presses = { count: 0 };
  const monitor = new StatusMonitor(
    async () => true,
    (id) => fakes.lastOutputAt.get(id) ?? 0,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
    () => '',
    (id) => fakes.lastRawOutputAt.get(id) ?? 0,
    async (ms: number) => {
      fakes.now.value += ms;
      opts.onSleep?.({ monitor, presses, now: fakes.now.value });
    },
  );
  monitor.setResubmitHandler(() => {
    presses.count++;
    opts.onPress?.({ monitor, presses, now: fakes.now.value });
  });
  return { monitor, presses };
}

test('confirm (a): submit confirmed inside the first window — no re-press', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-a', { provider: 'claude', isWorker: true, status: 'idle' });
    let sleepCount = 0;
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      onSleep: ({ monitor: m, now }) => {
        // Fire the start hook on the 2nd poll — well inside the 2000ms window.
        if (++sleepCount === 2) m.recordStartHookEventAt(agent.id, now);
      },
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, true, 'hook arriving in the first window confirms');
    assert.equal(presses.count, 0, 'no submit-only re-press when the first window confirms');
    assert.equal(monitor.isConfirmInFlight(agent.id), false, 'confirm-in-flight cleared on resolve');
  } finally {
    restore();
  }
});

test('confirm (b): submit confirmed on a retry window after a re-press', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-b', { provider: 'claude', isWorker: true, status: 'idle' });
    let firstPressDone = false;
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      onPress: () => { firstPressDone = true; },
      onSleep: ({ monitor: m, now }) => {
        // Only confirm once the first re-press has happened (i.e. in a retry
        // window, never the first window).
        if (firstPressDone) m.recordStartHookEventAt(agent.id, now);
      },
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, true, 'hook arriving after a re-press confirms');
    assert.equal(presses.count, 1, 'exactly one re-press was needed');
  } finally {
    restore();
  }
});

test('confirm (c): exhaustion → false after MAX_SUBMIT_RETRIES re-presses', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-c', { provider: 'claude', isWorker: true, status: 'idle' });
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      // Hook never fires.
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, false, 'no hook ever → exhausted → false');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES,
      `exactly MAX_SUBMIT_RETRIES (${MAX_SUBMIT_RETRIES}) submit-only re-presses`);
    assert.equal(monitor.isConfirmInFlight(agent.id), false, 'confirm-in-flight cleared even on exhaustion');
  } finally {
    restore();
  }
});

test('confirm (d): pre-send baseline race — a stale prior hook does NOT falsely confirm', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-d', { provider: 'claude', isWorker: true, status: 'idle' });
    const { monitor, presses } = makeConfirmMonitor(fakes, agent);
    // A hook from a PRIOR turn already exists at t=500. No NEW hook ever fires.
    monitor.recordStartHookEventAt(agent.id, 500);
    const prior = monitor.getLastStartHookEventAt(agent.id) ?? 0;
    assert.equal(prior, 500, 'baseline captures the prior hook');

    const confirmed = await monitor.confirmSubmission(agent.id, prior);
    assert.equal(confirmed, false,
      'a stale hook == baseline must not confirm (comparison is strict >, not >=)');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES, 'it retried rather than false-confirming on the stale hook');
  } finally {
    restore();
  }
});

test('confirm (e): the final retry IS polled before giving up', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-e', { provider: 'claude', isWorker: true, status: 'idle' });
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      onPress: ({ monitor: m, presses: p, now }) => {
        // Fire the hook only on the LAST re-press. If the loop pressed-then-
        // returned without polling the final press, this would never confirm.
        if (p.count === MAX_SUBMIT_RETRIES) m.recordStartHookEventAt(agent.id, now + 1);
      },
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, true, 'a hook landing on the final retry window still confirms');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES, 'all retries used; the last one was polled');
  } finally {
    restore();
  }
});

test('confirm coordination: reactive resend skips contract providers + in-flight agents', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-coord', { provider: 'codex', isWorker: true, status: 'idle' });
    fakes.agents.set(agent.id, agent);
    fakes.aliveOverride.set(agent.id, true);
    let resends = 0;
    const monitor = makeMonitor({ fakes, agent });
    monitor.setResubmitHandler(() => { resends++; });

    // Arm the reactive-resend signature: input delivered long ago, still idle,
    // no start hook since.
    monitor.recordInputDelivered(agent.id, fakes.now.value - START_HOOK_RESEND_AFTER_MS - 1_000);

    // 1) Predicate says this agent is a contract provider → reactive path skips.
    monitor.setSubmitConfirmationPredicate(() => true);
    (monitor as any).checkStartHookResend(agent);
    assert.equal(resends, 0, 'contract providers re-press via the synchronous path only');

    // 2) Predicate false (fallback provider) but a confirm is in flight → still skip.
    monitor.setSubmitConfirmationPredicate(() => false);
    (monitor as any).confirmInFlight.add(agent.id);
    (monitor as any).checkStartHookResend(agent);
    assert.equal(resends, 0, 'no reactive re-press while a synchronous confirm is in flight');

    // 3) Predicate false + not in flight → the reactive fallback fires.
    (monitor as any).confirmInFlight.delete(agent.id);
    (monitor as any).checkStartHookResend(agent);
    assert.equal(resends, 1, 'non-contract provider falls back to the reactive resend');
  } finally {
    restore();
  }
});

// ── P1 §3 — hook-transport poller tick ordering (plan §5 E4) ─────────────

test('P1 tick ordering: transport poller runs BEFORE the canary — a spool SessionStart disarms it, no broken stamp that tick', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('tp-1', {
      status: 'idle',
      isWorker: true,
      isSupervised: false,
      provider: 'claude',
      hookStatus: 'unknown',
    });
    const monitor = makeMonitor({ fakes, agent });
    // Canary armed long enough ago that THIS tick would flip 'broken'.
    monitor.recordHookCanary(agent.id, fakes.now.value - HOOK_CANARY_WINDOW_MS - 1_000);

    // The poller simulates what the supervisor's spool drain does when the
    // spool holds a SessionStart for this agent: stamp healthy + disarm.
    // (The applier itself is unit-tested in agent-supervisor.test.ts; here
    // the contract under test is the ORDERING — poller before per-agent
    // canary evaluation in the same poll() tick.)
    monitor.setHookTransportPoller(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const db = require('../database') as { updateAgentHookStatus: (id: string, s: 'healthy', ts?: number) => void };
      db.updateAgentHookStatus(agent.id, 'healthy', fakes.now.value);
      monitor.clearHookCanary(agent.id);
    });

    await pollOnce(monitor);

    assert.equal(agent.hookStatus, 'healthy', 'the spool SessionStart won the tick');
    const brokenStamps = fakes.hookUpdates.filter((u) => u.hookStatus === 'broken');
    assert.equal(brokenStamps.length, 0,
      'the canary must NOT stamp broken on the same tick the transport delivered proof-of-load');
    assert.equal(monitor.isHookCanaryArmed(agent.id), false, 'canary disarmed');
  } finally {
    restore();
  }
});

test('P1 tick ordering CONTROL: without the transport poller the same tick flips broken (ordering is load-bearing)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('tp-2', {
      status: 'idle',
      isWorker: true,
      isSupervised: false,
      provider: 'claude',
      hookStatus: 'unknown',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value - HOOK_CANARY_WINDOW_MS - 1_000);

    await pollOnce(monitor);

    const brokenStamps = fakes.hookUpdates.filter((u) => u.hookStatus === 'broken');
    assert.equal(brokenStamps.length, 1,
      'control: an expired canary with NO transport delivery flips broken — proving the ordering test is meaningful');
  } finally {
    restore();
  }
});

test('P1 tick ordering: the poller runs exactly ONCE per tick regardless of agent count', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const a1 = makeAgent('tp-n1', { status: 'idle', isWorker: true });
    const a2 = makeAgent('tp-n2', { status: 'idle', isWorker: true });
    const a3 = makeAgent('tp-n3', { status: 'idle', isWorker: true });
    const monitor = makeMonitor({ fakes, agent: a1 });
    for (const a of [a2, a3]) {
      fakes.agents.set(a.id, a);
      fakes.aliveOverride.set(a.id, true);
      fakes.lastOutputAt.set(a.id, fakes.now.value);
    }

    let pollerRuns = 0;
    monitor.setHookTransportPoller(() => { pollerRuns++; });

    await pollOnce(monitor);
    assert.equal(pollerRuns, 1, 'one tick, three agents → exactly one transport drain');
    await pollOnce(monitor);
    assert.equal(pollerRuns, 2, 'second tick → second drain');
  } finally {
    restore();
  }
});

test('P1 tick ordering: a throwing transport poller never breaks the poll loop', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const agent = makeAgent('tp-err', { status: 'launching', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);
    monitor.setHookTransportPoller(() => { throw new Error('transport boom'); });

    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude + 1;
    await pollOnce(monitor);
    assert.equal(agent.status, 'idle',
      'per-agent work (settle promotion) still ran despite the poller throwing');
  } finally {
    console.warn = origWarn;
    restore();
  }
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
