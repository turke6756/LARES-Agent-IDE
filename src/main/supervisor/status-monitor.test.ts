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

test('BR-16 corollary (BUG-09 inverted): forceWorking overwrites the prior latch with a working entry', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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

// ── BR-14 ────────────────────────────────────────────────────────────
test('BR-14: PTY (y/N) prompt in ring tail → inferStatus returns waiting + arms latch', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_LATCH_MODEL_PENDING_MS - 1_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'working',
      'tool-pending TTL applies while a tool remains outstanding');
  } finally {
    restore();
  }
});

test('BUG-09: both tools resolve — effective TTL shrinks to model-pending', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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

    // Just past model-pending TTL — latch should be considered expired and PTY
    // truth resumes.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_MS + 1_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'idle',
      'effective TTL is model-pending once outstandingToolIds is empty');
  } finally {
    restore();
  }
});

test('BUG-09 §3.1 / C7: forceWorking refreshes refreshedAt on an already-working latch', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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
    const agent = makeAgent('w-1', { status: 'working' });
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

test('BUG-09 §3.7: forgetAgent drops latch + statusHoldUntil', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-1', { status: 'working' });
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
