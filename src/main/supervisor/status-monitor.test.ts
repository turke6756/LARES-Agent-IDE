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

function makeMonitor(opts: {
  fakes: ReturnType<typeof makeStatusMonitorFakes>;
  agent: Agent;
  alive?: boolean;
}) {
  const { fakes, agent } = opts;
  const alive = opts.alive ?? true;
  fakes.agents.set(agent.id, agent);
  fakes.aliveOverride.set(agent.id, alive);
  // Default: PTY says "active right now" — we let tests override per scenario.
  fakes.lastOutputAt.set(agent.id, fakes.now.value);
  const monitor = new StatusMonitor(
    async (a) => fakes.aliveOverride.get(a.id) ?? true,
    (id) => fakes.lastOutputAt.get(id) ?? 0,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'crashed', lastExitCode: 1 });
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
    const agent = makeAgent('w-1', { status: 'launching' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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

test('BR-16 corollary: forceWorking clears the latch and lets PTY truth resume', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    assert.ok(monitor.getLatchSnapshot(agent.id), 'latch set');

    // A real new turn arrives.
    monitor.forceWorking(agent.id, 'task-started');
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'forceWorking cleared the latch');
    assert.equal(agent.status, 'working');

    // PTY now governs.
    fakes.lastOutputAt.set(agent.id, fakes.now.value);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working', 'PTY truth resumes after latch cleared');
  } finally {
    restore();
  }
});

// ── BR-17 ────────────────────────────────────────────────────────────
test('BR-17: idle latch TTL expires; PTY truth resumes', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWaiting(agent.id, 'y-n', '(y/N)');
    fakes.now.value += WAITING_LATCH_TIMEOUT_MS;

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'waiting', 'waiting latch inclusive at TTL');
  } finally {
    restore();
  }
});

// ── Misc invariants ──────────────────────────────────────────────────
test('forceWorking on already-working agent only clears latch, no event', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Seed a stale idle latch.
    (monitor as any).turnLatch.set(agent.id, { state: 'idle', setAt: fakes.now.value });

    monitor.forceWorking(agent.id, 'tool-use');
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'latch cleared');
    assert.equal(fakes.updates.length, 0, 'no DB write when already working');
    assert.equal(fakes.emissions.length, 0, 'no event when already working');
  } finally {
    restore();
  }
});

test('latch invalidation: a second forceIdle/forceWaiting overwrites the prior latch state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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
