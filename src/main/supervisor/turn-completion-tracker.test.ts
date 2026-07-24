// Git-Native WP-G1.4 — turn-completion-tracker tests.
//
//   npm run build:main
//   node dist/main/main/supervisor/turn-completion-tracker.test.js
//
// This layer is PURE LOGIC (no git, no fs, no real timers): a deterministic
// fake clock + scheduler drives idle debounce and the upgrade window exactly, so
// the suite is synchronous and flake-free. We prove:
//   - each of the four sources completes a turn exactly once, and repeats dedup;
//   - a stale idle with NO correlated start does NOT complete the turn;
//   - the consult order holds (hook beats a later session-log; session-log beats
//     a later idle) — a weaker/equal signal after close is a no-op;
//   - a higher-fidelity signal within the window performs a metadata-only
//     `after_quality` upgrade that never re-opens the turn, and does nothing once
//     the window has elapsed;
//   - multiple agents are tracked independently.

import assert from 'node:assert/strict';

import {
  TurnCompletionTracker,
  type CompletionSource,
  type TurnCompleteEvent,
} from './turn-completion-tracker';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── deterministic clock + scheduler ─────────────────────────────────────────

/** A synchronous fake clock whose `advance` also fires due injected timers, in
 *  chronological order — no real time passes. */
class FakeScheduler {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clear = (h: unknown): void => {
    this.timers.delete(h as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < dueAt) { dueAt = t.at; dueId = id; }
      }
      if (dueId === null) break;
      const t = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.now = t.at;
      t.fn();
    }
    this.now = target;
  }
}

const IDLE_DEBOUNCE = 100;
const UPGRADE_WINDOW = 1_000;

interface Harness {
  tracker: TurnCompletionTracker;
  sched: FakeScheduler;
  events: Array<{ agentId: string; ev: TurnCompleteEvent }>;
}

function harness(): Harness {
  const sched = new FakeScheduler();
  const events: Array<{ agentId: string; ev: TurnCompleteEvent }> = [];
  const tracker = new TurnCompletionTracker({
    now: () => sched.now,
    setTimer: sched.set,
    clearTimer: sched.clear,
    idleDebounceMs: IDLE_DEBOUNCE,
    upgradeWindowMs: UPGRADE_WINDOW,
  });
  tracker.onTurnComplete((agentId, ev) => events.push({ agentId, ev }));
  return { tracker, sched, events };
}

const A = 'agent-A';
const B = 'agent-B';

// ── each source resolves once, deduped ───────────────────────────────────────

for (const source of ['hook', 'session-log', 'terminal'] as CompletionSource[]) {
  test(`${source} completes an open turn exactly once and dedups repeats`, () => {
    const { tracker, events } = harness();
    tracker.beginTurn(A);
    fire(tracker, A, source);
    fire(tracker, A, source); // duplicate signal
    fire(tracker, A, source);
    assert.equal(events.length, 1, 'exactly one turnComplete');
    assert.equal(events[0].agentId, A);
    assert.equal(events[0].ev.source, source);
    assert.equal(events[0].ev.afterQuality, source, 'source → after_quality is identity');
    assert.equal(events[0].ev.upgrade, false);
  });
}

test('idle-fallback completes once (after start) and dedups repeats', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteStart(A);
  tracker.noteIdle(A);
  sched.advance(IDLE_DEBOUNCE); // debounce elapses → completes
  assert.equal(events.length, 1);
  assert.equal(events[0].ev.source, 'idle-fallback');
  assert.equal(events[0].ev.afterQuality, 'idle-fallback');
  // Further idle notes on the now-closed turn do nothing.
  tracker.noteIdle(A);
  sched.advance(IDLE_DEBOUNCE);
  assert.equal(events.length, 1, 'no second completion from a repeat idle');
});

// ── a signal with no open turn is ignored ────────────────────────────────────

test('a completion signal for an agent with no open turn is ignored', () => {
  const { tracker, events } = harness();
  tracker.noteHookStop(A); // never beganTurn
  assert.equal(events.length, 0);
});

// ── stale idle without correlated start does NOT complete ─────────────────────

test('a stale idle with no prior start does NOT complete the turn', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteIdle(A); // no noteStart → idle is unproven
  sched.advance(IDLE_DEBOUNCE * 3);
  assert.equal(events.length, 0, 'idle without start must not complete');
  // The turn is still open — a real signal still completes it.
  tracker.noteHookStop(A);
  assert.equal(events.length, 1);
  assert.equal(events[0].ev.source, 'hook');
});

// ── consult order honored (weaker-after-close is a no-op) ─────────────────────

test('hook beats a later session-log (weaker signal after close is a no-op)', () => {
  const { tracker, events } = harness();
  tracker.beginTurn(A);
  tracker.noteHookStop(A);
  tracker.noteSessionLogComplete(A); // arrives later, lower fidelity
  assert.equal(events.length, 1, 'no second event for the weaker later signal');
  assert.equal(events[0].ev.source, 'hook');
});

test('session-log beats a later idle', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteStart(A);
  tracker.noteSessionLogComplete(A); // closes as session-log
  tracker.noteIdle(A); // idle on a closed turn — dropped at arm time
  sched.advance(IDLE_DEBOUNCE * 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].ev.source, 'session-log');
});

// ── metadata-only upgrade within the window ──────────────────────────────────

test('a higher-fidelity signal within the window upgrades after_quality, no re-open', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteStart(A);
  tracker.noteIdle(A);
  sched.advance(IDLE_DEBOUNCE); // closes as idle-fallback
  assert.equal(events.length, 1);
  assert.equal(events[0].ev.source, 'idle-fallback');

  sched.advance(UPGRADE_WINDOW / 2); // still inside the window
  tracker.noteHookStop(A); // higher fidelity → metadata upgrade
  assert.equal(events.length, 2, 'the upgrade emits a second event');
  const up = events[1].ev;
  assert.equal(up.source, 'hook');
  assert.equal(up.afterQuality, 'hook');
  assert.equal(up.upgrade, true);
  assert.equal(up.previousSource, 'idle-fallback');

  // Never re-opens: another idle can't complete/emit, and a weaker signal is a
  // no-op even inside the window.
  tracker.noteIdle(A);
  sched.advance(IDLE_DEBOUNCE);
  tracker.noteSessionLogComplete(A);
  assert.equal(events.length, 2, 'closed turn never re-opens or takes a weaker upgrade');
});

test('the upgrade chain is bounded — a second upgrade past the window is ignored', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteTerminalExit(A); // closes as terminal
  assert.equal(events.length, 1);
  assert.equal(events[0].ev.source, 'terminal');

  sched.advance(UPGRADE_WINDOW / 2);
  tracker.noteSessionLogComplete(A); // higher than terminal, inside window → upgrade
  assert.equal(events.length, 2);
  assert.equal(events[1].ev.source, 'session-log');
  assert.equal(events[1].ev.upgrade, true);

  // Window is anchored to the ORIGINAL close, not the last upgrade: push past it.
  sched.advance(UPGRADE_WINDOW); // now well beyond the original close
  tracker.noteHookStop(A); // would outrank, but the window has elapsed
  assert.equal(events.length, 2, 'no upgrade once the window (from initial close) elapsed');
});

test('a higher-fidelity signal AFTER the window does not upgrade', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteStart(A);
  tracker.noteIdle(A);
  sched.advance(IDLE_DEBOUNCE); // closes as idle-fallback
  sched.advance(UPGRADE_WINDOW + 1); // window elapses
  tracker.noteHookStop(A);
  assert.equal(events.length, 1, 'no upgrade after the window');
  assert.equal(events[0].ev.source, 'idle-fallback');
});

// ── multiple agents independent ──────────────────────────────────────────────

test('multiple agents are tracked independently', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.beginTurn(B);

  // A completes by hook; B has only an unproven idle.
  tracker.noteHookStop(A);
  tracker.noteIdle(B); // no start for B → must not complete
  sched.advance(IDLE_DEBOUNCE * 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].agentId, A);

  // Now prove B on its own timeline.
  tracker.noteStart(B);
  tracker.noteIdle(B);
  sched.advance(IDLE_DEBOUNCE);
  assert.equal(events.length, 2);
  assert.equal(events[1].agentId, B);
  assert.equal(events[1].ev.source, 'idle-fallback');
});

test('beginTurn opens a fresh turn — a new turn completes again and cancels a stale idle timer', () => {
  const { tracker, sched, events } = harness();
  tracker.beginTurn(A);
  tracker.noteHookStop(A);
  assert.equal(events.length, 1);

  // A brand-new turn for the same agent resolves independently.
  tracker.beginTurn(A);
  // An idle armed in this turn, then a re-beginTurn, must not fire for the old gen.
  tracker.noteStart(A);
  tracker.noteIdle(A);
  tracker.beginTurn(A); // supersedes; cancels the pending idle timer
  sched.advance(IDLE_DEBOUNCE * 2);
  assert.equal(events.length, 1, 'the superseded idle timer must not complete');
  tracker.noteSessionLogComplete(A);
  assert.equal(events.length, 2);
  assert.equal(events[1].ev.source, 'session-log');
});

// ── helper ───────────────────────────────────────────────────────────────────

function fire(t: TurnCompletionTracker, agentId: string, source: CompletionSource): void {
  switch (source) {
    case 'hook': t.noteHookStop(agentId); break;
    case 'session-log': t.noteSessionLogComplete(agentId); break;
    case 'terminal': t.noteTerminalExit(agentId); break;
    case 'idle-fallback': t.noteIdle(agentId); break;
  }
}

// ── runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
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
