// Git-Native WP-G1.2 — checkpoint-queue: per-key priority serialization with
// eager, timer-driven deadline expiry.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/checkpoint-queue.test.js
//
// This layer is PURE LOGIC (no git, no fs), so the tests drive the real queue
// with short real timers and controllable in-memory "ops". The 30-second running
// AFTER of the spec is simulated with proportionally scaled durations (a
// ~300ms-running AFTER + a 50ms BEFORE deadline) so the suite stays fast while
// still proving the BEFORE resolves `{skipped:'deadline'}` on time while the
// AFTER is still running and the BEFORE's callback is never later invoked.

import assert from 'node:assert/strict';

import {
  CheckpointQueue,
  type CheckpointPriority,
  type QueueTelemetrySample,
  type SkippedDeadline,
} from './checkpoint-queue';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** True iff `v` is the deadline-skip sentinel. */
function isSkipped(v: unknown): v is SkippedDeadline {
  return typeof v === 'object' && v !== null && (v as SkippedDeadline).skipped === 'deadline';
}

const KEY = 'C:/repo/.git';
const OTHER = 'D:/other/.git';

// ── serialization ──────────────────────────────────────────────────────────

test('two ops on the same key never overlap', async () => {
  const q = new CheckpointQueue();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  const op = (id: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    order.push(id);
    active--;
    return id;
  };

  const results = await Promise.all([
    q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, op(1)),
    q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, op(2)),
    q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, op(3)),
  ]);

  assert.equal(maxActive, 1, 'at most one op may run at a time on a key');
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3], 'same-priority ops run FIFO');
  assert.equal(q.queueDepth(KEY), 0);
});

test('different keys run concurrently', async () => {
  const q = new CheckpointQueue();
  let active = 0;
  let maxActive = 0;

  const op = () => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(60);
    active--;
  };

  await Promise.all([
    q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, op()),
    q.withPriority(OTHER, { priority: 'AFTER', deadlineAt: Infinity }, op()),
  ]);

  assert.equal(maxActive, 2, 'ops on distinct keys must overlap');
});

test('same key string serializes; the queue does not itself case-fold (git-runtime does)', async () => {
  // The queue treats the key as OPAQUE — case-folding already happened upstream
  // in git-runtime. So identical key strings serialize, and two differently-
  // cased strings are, at THIS layer, simply different keys. We assert the
  // serialization contract on identical keys (the invariant the queue owns).
  const q = new CheckpointQueue();
  let active = 0;
  let maxActive = 0;
  const op = () => async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; };

  await Promise.all([
    q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, op()),
    q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, op()),
  ]);
  assert.equal(maxActive, 1);
});

test('a rejected op does not poison the chain', async () => {
  const q = new CheckpointQueue();
  const ran: string[] = [];

  const bad = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    ran.push('bad');
    throw new Error('boom');
  });
  const good = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    ran.push('good');
    return 'ok';
  });

  await assert.rejects(() => bad, /boom/);
  assert.equal(await good, 'ok', 'a later op still runs after an earlier rejection');
  assert.deepEqual(ran, ['bad', 'good']);
});

// ── priority ─────────────────────────────────────────────────────────────────

test('a queued RESTORE preempts a queued BEFORE', async () => {
  const q = new CheckpointQueue();
  const order: string[] = [];
  const gate = deferred<void>();

  // Hold the key with a running op so both of the next two sit queued together.
  const held = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    order.push('held');
    await gate.promise;
  });

  // Enqueue BEFORE first, then RESTORE — RESTORE must still dequeue first.
  const before = q.withPriority(KEY, { priority: 'BEFORE', deadlineAt: Infinity }, async () => { order.push('before'); });
  const restore = q.withPriority(KEY, { priority: 'RESTORE', deadlineAt: Infinity }, async () => { order.push('restore'); });

  await sleep(20);
  gate.resolve();
  await Promise.all([held, before, restore]);

  assert.deepEqual(order, ['held', 'restore', 'before'], 'RESTORE outranks BEFORE regardless of enqueue order');
});

test('MAINTENANCE waits for full idle (no higher item queued or running)', async () => {
  const q = new CheckpointQueue();
  const order: string[] = [];
  const gate = deferred<void>();

  const held = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    order.push('after');
    await gate.promise;
  });

  // MAINTENANCE enqueued BEFORE the BEFORE — but it must yield to it.
  const maint = q.withPriority(KEY, { priority: 'MAINTENANCE', deadlineAt: Infinity }, async () => { order.push('maint'); });
  const before = q.withPriority(KEY, { priority: 'BEFORE', deadlineAt: Infinity }, async () => { order.push('before'); });

  await sleep(20);
  assert.deepEqual(order, ['after'], 'MAINTENANCE must not start while a higher op runs');
  gate.resolve();
  await Promise.all([held, maint, before]);

  assert.deepEqual(order, ['after', 'before', 'maint'], 'MAINTENANCE runs only once nothing higher is queued or running');
});

// ── eager, timer-driven expiry ────────────────────────────────────────────────

test('scaled long-AFTER: a BEFORE behind a 300ms AFTER skips by its 50ms deadline, callback never invoked', async () => {
  const q = new CheckpointQueue();
  let beforeFnCalled = false;
  let afterFnCalled = false;
  let afterDone = false;

  // The 30-second AFTER of the spec, scaled to 300ms.
  const after = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    afterFnCalled = true;
    await sleep(300);
    afterDone = true;
    return 'after';
  });

  const enqueuedAt = Date.now();
  const before = q.withPriority(KEY, { priority: 'BEFORE', deadlineAt: Date.now() + 50 }, async () => {
    beforeFnCalled = true;
    return 'before';
  });

  const beforeResult = await before;
  const elapsed = Date.now() - enqueuedAt;

  assert.ok(isSkipped(beforeResult), 'BEFORE must resolve {skipped:deadline}');
  assert.ok(elapsed >= 40 && elapsed < 250, `BEFORE should skip at ~50ms while AFTER still runs (got ${elapsed}ms)`);
  assert.equal(beforeFnCalled, false, "the BEFORE's callback must never be invoked");
  assert.equal(afterDone, false, 'the AFTER is still running when the BEFORE skips');

  const afterResult = await after;
  assert.equal(afterResult, 'after');
  assert.equal(afterFnCalled, true);
  assert.equal(afterDone, true);

  // Give the (already-fired) machinery time to (not) call the skipped callback.
  await sleep(20);
  assert.equal(beforeFnCalled, false, "the skipped BEFORE's callback stays uninvoked after the AFTER completes");
});

test('a deadline-expired queued item skips before running', async () => {
  const q = new CheckpointQueue();
  let ranB = false;
  const gate = deferred<void>();

  const held = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    await gate.promise;
  });

  const b = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Date.now() + 40 }, async () => {
    ranB = true;
  });

  await sleep(80); // let B's deadline fire while the key is held
  assert.ok(isSkipped(await b), 'the expired item resolves skipped');
  assert.equal(ranB, false, 'the expired item never runs');
  assert.equal(q.queueDepth(KEY), 0, 'the cancelled item is removed from the queue');

  gate.resolve();
  await held;
});

test('fire-at-dequeue race: a cancelled item is skipped at the dequeue seam, pump proceeds to the next', async () => {
  const q = new CheckpointQueue();
  const order: string[] = [];
  let ranB = false;
  const gate = deferred<void>();

  // A holds the key under manual control.
  const a = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    order.push('a');
    await gate.promise;
  });

  // B is queued with a short deadline and WILL be cancelled while A still holds
  // the key; C is queued valid. When A releases, pump must skip the cancelled B
  // and run C.
  const b = q.withPriority(KEY, { priority: 'BEFORE', deadlineAt: Date.now() + 20 }, async () => { ranB = true; });
  const c = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => { order.push('c'); });

  await sleep(50); // B's deadline fires here (A still held)
  assert.ok(isSkipped(await b), 'B is cancelled before it could dequeue');
  gate.resolve();
  await Promise.all([a, c]);

  assert.equal(ranB, false, "the cancelled item's callback is never invoked at the dequeue seam");
  assert.deepEqual(order, ['a', 'c'], 'pump skips the cancelled item and runs the next valid one');
});

test('withLock never expires — it runs even after waiting past any finite deadline', async () => {
  const q = new CheckpointQueue();
  let ran = false;
  const gate = deferred<void>();

  const held = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    await gate.promise;
  });

  const locked = q.withLock(KEY, async () => { ran = true; return 'locked'; });

  // Hold the key far longer than any finite deadline a caller might have set.
  await sleep(120);
  assert.equal(ran, false, 'the lock op waits its turn');
  gate.resolve();

  const result = await locked;
  assert.equal(result, 'locked', 'withLock resolves with its real value, never {skipped}');
  assert.equal(ran, true);
  await held;
});

// ── telemetry ────────────────────────────────────────────────────────────────

test('queueWaitMs and execMs are recorded separately; skipped items emit no sample', async () => {
  const samples: QueueTelemetrySample[] = [];
  const q = new CheckpointQueue((s) => samples.push(s));
  const gate = deferred<void>();

  // First op holds the key ~held so the second op accrues real queueWaitMs.
  const held = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    await gate.promise;
    await sleep(10);
    return 'held';
  });

  const waiter = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {
    await sleep(30);
    return 'waiter';
  });

  // A third op that expires while queued — it must NOT produce a telemetry sample.
  const skipped = q.withPriority(KEY, { priority: 'BEFORE', deadlineAt: Date.now() + 40 }, async () => 'never');

  await sleep(60);
  gate.resolve();
  await Promise.all([held, waiter]);
  assert.ok(isSkipped(await skipped));

  assert.equal(samples.length, 2, 'only the two ops that actually ran emit samples (the skipped one does not)');

  const [heldSample, waiterSample] = samples;
  assert.equal(heldSample.priority, 'AFTER');
  assert.ok(heldSample.execMs >= 5, `held execMs should reflect its runtime (got ${heldSample.execMs})`);

  assert.ok(waiterSample.queueWaitMs >= 50, `waiter queueWaitMs should reflect the queue wait (got ${waiterSample.queueWaitMs})`);
  assert.ok(waiterSample.execMs >= 25, `waiter execMs should reflect its runtime (got ${waiterSample.execMs})`);
  for (const s of samples) {
    assert.equal(s.key, KEY);
    assert.ok(Number.isFinite(s.queueWaitMs) && s.queueWaitMs >= 0);
    assert.ok(Number.isFinite(s.execMs) && s.execMs >= 0);
  }
});

test('queueDepth reflects waiting items, excluding the running one', async () => {
  const q = new CheckpointQueue();
  const gate = deferred<void>();

  const held = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => { await gate.promise; });
  const w1 = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {});
  const w2 = q.withPriority(KEY, { priority: 'AFTER', deadlineAt: Infinity }, async () => {});

  await sleep(20);
  assert.equal(q.queueDepth(KEY), 2, 'two waiters queued behind the running op');
  gate.resolve();
  await Promise.all([held, w1, w2]);
  assert.equal(q.queueDepth(KEY), 0);
});

// avoid an unused-import lint on the exported priority union
const _priorities: CheckpointPriority[] = ['RESTORE', 'BEFORE', 'AFTER', 'MAINTENANCE'];
void _priorities;

// ── runner ────────────────────────────────────────────────────────────────────

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
