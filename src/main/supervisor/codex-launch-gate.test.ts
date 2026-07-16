// Layer B — CodexLaunchGate serialization tests.
//
// Verifies the launch-gate contract that keeps concurrent/temporally-close
// codex launches (which deliberately share one working directory) from racing
// each other through the launch→sid-bind window:
//   - the FIRST launch acquires instantly (lock free);
//   - a CONCURRENT launch on the SAME home serializes behind it and only
//     proceeds once the holder releases (release-on-bind);
//   - a wedged launch whose discovery never settles is force-released by the
//     per-holder hard-cap timer instead of wedging the queue;
//   - the escape hatch (enabled:false) is an instant no-op with no
//     serialization;
//   - distinct homes ('windows' vs 'wsl') never block each other.
//
// The gate is pure/injectable (clock + timers), so these run without the app.
// Non-codex launches "bypassing the gate" is a CALLER-level property: the
// supervisor only calls `acquire` inside the `shouldDiscoverCodexSession`
// (codex-only) branch of each launch path (src/main/supervisor/index.ts
// ~3134 windows / ~4068 wsl), so claude/gemini launches never reach the gate.
//
// Compile via:
//   npm run build:main
//   node dist/main/main/supervisor/codex-launch-gate.test.js

import assert from 'node:assert/strict';
import { CodexLaunchGate } from './codex-launch-gate';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

// Flush all pending microtasks by yielding one real macrotask. Lets us assert
// "not resolved yet" without accidentally resolving a still-queued acquire.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A controllable clock so `waitedMs` is deterministic.
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Capturing timer seam: hard-cap callbacks are stored, never auto-fired.
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  entries: Array<{ fn: () => void; ms: number; cleared: boolean }>;
} {
  const entries: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    entries,
    setTimer: (fn, ms) => { entries.push({ fn, ms, cleared: false }); return entries.length - 1; },
    clearTimer: (h) => { const e = entries[h as number]; if (e) e.cleared = true; },
  };
}

test('first acquire is instant — lock free (waitedMs 0, queuedBehind 0)', async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gate = new CodexLaunchGate({ hardCapMs: 100_000, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {} });
  const a = await gate.acquire('windows');
  assert.equal(a.waitedMs, 0);
  assert.equal(a.queuedBehind, 0);
});

test('two concurrent same-home launches serialize; release-on-bind releases the queue', async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gate = new CodexLaunchGate({ hardCapMs: 100_000, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {} });

  const a = await gate.acquire('windows');

  let bResolved = false;
  let b: Awaited<ReturnType<typeof gate.acquire>> | null = null;
  const bP = gate.acquire('windows').then((x) => { bResolved = true; b = x; return x; });

  // B requested while A holds → it must NOT resolve until A releases.
  clock.advance(250);
  await flush();
  assert.equal(bResolved, false, 'second concurrent launch must wait behind the first');

  // Release-on-bind: A binds its sid → the queue advances.
  a.release();
  await bP;
  assert.equal(bResolved, true, 'releasing the holder lets the next launch proceed');
  assert.equal(b!.queuedBehind, 1, 'B saw exactly one launch ahead of it');
  assert.equal(b!.waitedMs, 250, 'B waited the elapsed time behind A');
});

test('release is idempotent — double-release advances the queue only once', async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gate = new CodexLaunchGate({ hardCapMs: 100_000, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {} });

  const a = await gate.acquire('windows');
  let bDone = false; gate.acquire('windows').then(() => { bDone = true; });
  let cDone = false; gate.acquire('windows').then(() => { cDone = true; });

  a.release();
  a.release(); // second call must be a no-op — must NOT skip B and free C too
  await flush();
  assert.equal(bDone, true, 'B (next in line) proceeds');
  assert.equal(cDone, false, 'C must still wait behind B — double-release did not leak a second slot');
});

test('hard-cap timer force-releases a wedged launch (discovery never settles)', async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gate = new CodexLaunchGate({ hardCapMs: 5_000, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {} });

  // A acquires but NEVER releases (its discovery is wedged).
  await gate.acquire('windows');
  assert.equal(timers.entries.length, 1, 'A registered its hard-cap timer');
  assert.equal(timers.entries[0].ms, 5_000, 'hard-cap timer uses the configured cap');

  let bResolved = false;
  const bP = gate.acquire('windows').then(() => { bResolved = true; });
  await flush();
  assert.equal(bResolved, false, 'B is wedged behind A until the hard cap fires');

  // Fire A's hard-cap timer → A is force-released → B proceeds.
  timers.entries[0].fn();
  await bP;
  assert.equal(bResolved, true, 'hard cap force-releases the wedged holder and unblocks the queue');
});

test('normal release cancels the hard-cap timer (no leaked force-release)', async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gate = new CodexLaunchGate({ hardCapMs: 5_000, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {} });
  const a = await gate.acquire('windows');
  a.release();
  assert.equal(timers.entries[0].cleared, true, 'releasing on bind clears the pending hard-cap timer');
});

test('escape hatch (enabled:false) — acquire is an instant no-op, no serialization', async () => {
  const gate = new CodexLaunchGate({ hardCapMs: 1_000, enabled: false });
  assert.equal(gate.isEnabled(), false);
  const a = await gate.acquire('windows');
  assert.equal(a.waitedMs, 0);
  assert.equal(a.queuedBehind, 0);
  // A second acquire must NOT block even though A never released.
  let bResolved = false;
  gate.acquire('windows').then(() => { bResolved = true; });
  await flush();
  assert.equal(bResolved, true, 'a disabled gate never queues a concurrent launch');
});

test('distinct homes do not block each other (windows hold ≠ wsl queue)', async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gate = new CodexLaunchGate({ hardCapMs: 100_000, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {} });

  // Hold 'windows' and never release it.
  await gate.acquire('windows');

  let wslResolved = false;
  const wslP = gate.acquire('wsl').then(() => { wslResolved = true; });
  await flush();
  assert.equal(wslResolved, true, 'a wsl launch is not serialized behind a windows hold');
  await wslP;
});

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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
