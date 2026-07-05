// Context-brick Inc 5 — lifecycle-watcher tests, pure-logic style like
// claude-clear-rotation's: fake effects, fake clock, no real DB/HTTP/PTY.
// The StatusMonitor getWaitingKind tests ride the existing fake-status-deps
// monkey-patch helpers.
//
//   npm run build:main
//   node dist/main/main/supervisor/continuation-watcher.test.js

import assert from 'node:assert/strict';
import {
  ContinuationWatcher,
  type ContinuationWatcherEffects,
  type TriggerSnapshot,
  type OwnedAgentRow,
  type CommittedBrickView,
  type HandshakeResult,
  type EscapeBudget,
  decideContinuationTrigger,
  computeAwaitingHuman,
  isBlockingWaitKind,
  isEscapeBudgetExhausted,
  nextBackoffMs,
  isKillAuthorized,
  buildNoteRequestMessage,
  buildContinuationKickoffMessage,
  decidePostNoteProceed,
  OWNED_BUSY_BLOCKLIST,
  CONTINUATION_TRIGGER_CONTEXT_PCT,
} from './continuation-watcher';
import * as watcherModule from './continuation-watcher';
import {
  SUPERVISOR_CONTEXT_THRESHOLDS,
  CONTINUATION_IDLE_DEBOUNCE_TICKS,
  CONTINUATION_BACKOFF_MS,
  CONTINUATION_BACKOFF_CAP_MS,
  CONTINUATION_ESCAPE_MAX_ATTEMPTS,
  CONTINUATION_ESCAPE_MAX_ALIVE_MS,
  CONTINUATION_POST_NOTE_GRACE_MS,
  CONTINUATION_POST_NOTE_IDLE_POLLS,
  HANDSHAKE_TIMEOUT_MS,
} from '../../shared/constants';
import { StatusMonitor } from './status-monitor';
import type { WaitingKind } from './status-monitor';
import {
  makeStatusMonitorFakes,
  patchDatabaseModule,
  makeAgent,
} from './test-helpers/fake-status-deps';
import type { AgentStatus } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

// ── Threshold aliasing + no-hard-ceiling assertion ────────────────────

test('trigger percentage is an ALIAS of the soft opportunity floor SUPERVISOR_CONTEXT_THRESHOLDS[0]', () => {
  assert.equal(CONTINUATION_TRIGGER_CONTEXT_PCT, SUPERVISOR_CONTEXT_THRESHOLDS[0]);
  assert.equal(CONTINUATION_TRIGGER_CONTEXT_PCT, 80);
});

test('Phase 5B — no CONTINUATION_HARD_CEILING_PCT / decideEmptyMemoOutcome symbol remains in the watcher module', () => {
  assert.equal('CONTINUATION_HARD_CEILING_PCT' in watcherModule, false,
    'the hard ceiling was deleted — no export may reintroduce it');
  assert.equal('decideEmptyMemoOutcome' in watcherModule, false,
    'the percentage split was deleted — replaced by the effort-budget escape');
});

// ── 5A: getWaitingKind (real StatusMonitor, private latch) ────────────

function makeMonitor() {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const agent = makeAgent('sup-1', { status: 'working' });
  fakes.agents.set(agent.id, agent);
  const monitor = new StatusMonitor(
    async () => true,
    (id) => fakes.lastOutputAt.get(id) ?? 0,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
    () => '',
    (id) => fakes.lastOutputAt.get(id) ?? 0,
  );
  return { fakes, restore, agent, monitor };
}

test('getWaitingKind: waiting latch with kind → that kind', () => {
  const { restore, agent, monitor } = makeMonitor();
  try {
    monitor.forceWaiting(agent.id, 'question', 'Should I apply the migration?');
    assert.equal(monitor.getWaitingKind(agent.id), 'question');
    monitor.forceWaiting(agent.id, 'y-n', '(y/n)');
    assert.equal(monitor.getWaitingKind(agent.id), 'y-n');
  } finally { restore(); }
});

test('getWaitingKind: no latch / non-waiting latch → null (MUST-VERIFY: kind set ONLY while state==="waiting")', () => {
  const { restore, agent, monitor } = makeMonitor();
  try {
    assert.equal(monitor.getWaitingKind(agent.id), null);           // no latch
    monitor.forceWaiting(agent.id, 'question', 'q?');
    monitor.forceIdle(agent.id, 'turnComplete');                    // overwrites to idle
    assert.equal(monitor.getWaitingKind(agent.id), null);
  } finally { restore(); }
});

// ── 5A: awaiting-human predicate — ALL 7 WaitingKinds block, null does not ──

test('isBlockingWaitKind / computeAwaitingHuman: every WaitingKind blocks; null does not', () => {
  const ALL_KINDS: WaitingKind[] =
    ['question', 'y-n', 'enter', 'choice', 'approve', 'tty-pattern', 'notification'];
  for (const kind of ALL_KINDS) {
    assert.equal(isBlockingWaitKind(kind), true, `${kind} must block`);
    assert.equal(computeAwaitingHuman(kind), true, `${kind} → awaiting-human`);
  }
  // 'notification' carries permission_prompt after isNonBlockingNotificationType
  // has already filtered the non-blocking ones BEFORE forceWaiting — so a
  // surviving 'notification' latch is a real human-answer prompt.
  assert.equal(computeAwaitingHuman('notification'), true, 'notification explicitly blocks');
  // null latch → NOT awaiting: a merely-idle turn (even one ending with "?")
  // must qualify for a fresh session (the old ends-with-? clause is gone).
  assert.equal(isBlockingWaitKind(null), false);
  assert.equal(computeAwaitingHuman(null), false);
});

// ── 5B: trigger matrix ────────────────────────────────────────────────

function allClearSnapshot(overrides: Partial<TriggerSnapshot> = {}): TriggerSnapshot {
  return {
    contextPercentage: CONTINUATION_TRIGGER_CONTEXT_PCT,
    consecutiveIdleTicks: CONTINUATION_IDLE_DEBOUNCE_TICKS,
    awaitingHuman: false,
    owned: [],
    inputInFlightIds: [],
    orchestrationRunning: false,
    attemptInProgress: false,
    now: 1_000_000,
    backoffUntil: 0,
    ...overrides,
  };
}

test('trigger: all-clear fires', () => {
  const d = decideContinuationTrigger(allClearSnapshot());
  assert.equal(d.fire, true);
  assert.deepEqual(d.blockers, []);
});

test('trigger: each gate independently blocks', () => {
  const cases: Array<[string, Partial<TriggerSnapshot>]> = [
    ['context below threshold', { contextPercentage: CONTINUATION_TRIGGER_CONTEXT_PCT - 1 }],
    ['context unknown', { contextPercentage: null }],
    ['idle debounce not met', { consecutiveIdleTicks: CONTINUATION_IDLE_DEBOUNCE_TICKS - 1 }],
    ['awaiting human', { awaitingHuman: true }],
    ['owned busy', { owned: [{ id: 'w1', status: 'working' as AgentStatus }] }],
    ['input in flight', { inputInFlightIds: ['w1'] }],
    ['orchestration running', { orchestrationRunning: true }],
    ['attempt in progress', { attemptInProgress: true }],
    ['backoff', { backoffUntil: 2_000_000 }],
  ];
  for (const [name, ov] of cases) {
    const d = decideContinuationTrigger(allClearSnapshot(ov));
    assert.equal(d.fire, false, `${name} should block`);
    assert.ok(d.blockers.length > 0, `${name} should record a blocker`);
  }
});

test('busy-blocklist: launching|working|waiting|restarting block; idle/done/crashed do not; receiving not in the set', () => {
  for (const s of ['launching', 'working', 'waiting', 'restarting'] as AgentStatus[]) {
    const d = decideContinuationTrigger(allClearSnapshot({ owned: [{ id: 'w', status: s }] }));
    assert.equal(d.fire, false, `${s} should block`);
  }
  for (const s of ['idle', 'done', 'crashed'] as AgentStatus[]) {
    const d = decideContinuationTrigger(allClearSnapshot({ owned: [{ id: 'w', status: s }] }));
    assert.equal(d.fire, true, `${s} should NOT block`);
  }
  // 'receiving' is projection-only and never appears in a raw DB row — a
  // blocklist entry for it would be a silent no-op, so it must not be there.
  assert.equal(OWNED_BUSY_BLOCKLIST.has('receiving' as AgentStatus), false);
});

test('crashed owned agents are non-blocking but their ids ride the decision', () => {
  const d = decideContinuationTrigger(allClearSnapshot({
    owned: [
      { id: 'w-crashed', status: 'crashed' as AgentStatus },
      { id: 'w-idle', status: 'idle' as AgentStatus },
    ],
  }));
  assert.equal(d.fire, true);
  assert.deepEqual(d.crashedOwnedIds, ['w-crashed']);
});

test('in-flight guard blocks even when every owned status is clear', () => {
  const d = decideContinuationTrigger(allClearSnapshot({
    owned: [{ id: 'w1', status: 'idle' as AgentStatus }],
    inputInFlightIds: ['w1'],
  }));
  assert.equal(d.fire, false);
  assert.ok(d.blockers.some(b => b.startsWith('input-in-flight')));
});

// ── 5B: kill-auth / escape-budget / backoff pure guards ───────────────

test('isKillAuthorized: tool brick written after attempt start ONLY', () => {
  const startedAt = '2026-07-03T10:00:00.000Z';
  assert.equal(isKillAuthorized({ writtenAt: '2026-07-03T10:01:00.000Z' }, startedAt), true);
  assert.equal(isKillAuthorized({ writtenAt: '2026-07-03T09:59:00.000Z' }, startedAt), false);
  assert.equal(isKillAuthorized(null, startedAt), false);
});

test('isEscapeBudgetExhausted: fires on abort count OR alive-time; never on a fresh cycle', () => {
  const now = 10_000_000;
  // Fresh cycle: zero aborts, open attempt started just now → NOT exhausted.
  assert.equal(isEscapeBudgetExhausted(
    { abortedCount: 0, firstAttemptStartedAtMs: now }, now), false);
  // Under both caps → NOT exhausted.
  assert.equal(isEscapeBudgetExhausted(
    { abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS - 1, firstAttemptStartedAtMs: now - 1_000 }, now), false);
  // Abort count reached → exhausted (zero alive time needed).
  assert.equal(isEscapeBudgetExhausted(
    { abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS, firstAttemptStartedAtMs: now }, now), true);
  // Alive-time reached with ZERO aborts (the still-open attempt) → exhausted.
  assert.equal(isEscapeBudgetExhausted(
    { abortedCount: 0, firstAttemptStartedAtMs: now - CONTINUATION_ESCAPE_MAX_ALIVE_MS }, now), true);
  // No attempts at all (null clock) + zero aborts → NOT exhausted.
  assert.equal(isEscapeBudgetExhausted(
    { abortedCount: 0, firstAttemptStartedAtMs: null }, now), false);
});

test('nextBackoffMs: 300s initial, doubling to the cap', () => {
  const b1 = nextBackoffMs(null);
  assert.equal(b1, CONTINUATION_BACKOFF_MS);
  const b2 = nextBackoffMs(b1);
  assert.equal(b2, CONTINUATION_BACKOFF_MS * 2);
  assert.equal(nextBackoffMs(CONTINUATION_BACKOFF_CAP_MS), CONTINUATION_BACKOFF_CAP_MS);
});

// ── 5B: watcher state machine with fake effects ──────────────────────

interface FakeWorld {
  now: { value: number };
  contextPct: number | null;
  idle: boolean;
  awaitingHuman: boolean;
  owned: OwnedAgentRow[];
  inFlight: Set<string>;
  orchestration: boolean;
  toolBrick: CommittedBrickView | null;
  handshakeResult: HandshakeResult;
  openAttemptResult: { attemptId: string; startedAt: string } | null;
  relaunchOk: boolean;
  relaunchNoneOk: boolean;
  escapeBudget: EscapeBudget;
  calls: {
    openAttempt: Array<{ agentId: string; reason: string; thresholdContextPct: number }>;
    requestNote: Array<{ agentId: string; message: string }>;
    brickPolls: number;
    relaunch: Array<{ agentId: string; attemptId: string }>;
    relaunchNone: Array<{ agentId: string; attemptId: string }>;
    abortAttempt: Array<{ agentId: string; attemptId: string; detail: string }>;
    handoffFailedRecovery: Array<{ agentId: string; attemptId: string }>;
    pageHuman: Array<{ agentId: string; message: string }>;
    getEscapeBudget: number;
  };
}

function makeWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    now: { value: 1_000_000 },
    contextPct: CONTINUATION_TRIGGER_CONTEXT_PCT + 5,
    idle: true,
    awaitingHuman: false,
    owned: [],
    inFlight: new Set(),
    orchestration: false,
    toolBrick: null,
    handshakeResult: 'ok',
    openAttemptResult: { attemptId: 'att-1', startedAt: '2026-07-03T10:00:00.000Z' },
    relaunchOk: true,
    relaunchNoneOk: true,
    // Default: a fresh cycle — one open attempt started "now", zero aborts, so
    // the escape branch never fires unless a test arms the budget.
    escapeBudget: { abortedCount: 0, firstAttemptStartedAtMs: 1_000_000 },
    calls: {
      openAttempt: [], requestNote: [], brickPolls: 0, relaunch: [],
      relaunchNone: [], abortAttempt: [], handoffFailedRecovery: [], pageHuman: [],
      getEscapeBudget: 0,
    },
    ...overrides,
  };
}

function makeEffects(w: FakeWorld): ContinuationWatcherEffects {
  return {
    now: () => w.now.value,
    // Fake sleep: advance the clock, yield a microtask. The commit-observation
    // loop crosses HANDSHAKE_TIMEOUT_MS in a handful of iterations.
    sleep: async (ms) => { w.now.value += ms; },
    getContextPercentage: () => w.contextPct,
    isIdle: () => w.idle,
    isAwaitingHuman: () => w.awaitingHuman,
    getOwnedAgents: () => w.owned,
    isInputInFlight: (id) => w.inFlight.has(id),
    hasRunningOrchestration: () => w.orchestration,
    openAttempt: async (agentId, input) => {
      w.calls.openAttempt.push({ agentId, ...input });
      return w.openAttemptResult;
    },
    requestNote: async (agentId, message) => {
      w.calls.requestNote.push({ agentId, message });
      return w.handshakeResult;
    },
    getCommittedToolBrick: async () => {
      w.calls.brickPolls++;
      return w.toolBrick;
    },
    relaunch: async (agentId, attemptId) => {
      w.calls.relaunch.push({ agentId, attemptId });
      return w.relaunchOk;
    },
    relaunchNone: async (agentId, attemptId) => {
      w.calls.relaunchNone.push({ agentId, attemptId });
      return w.relaunchNoneOk;
    },
    getEscapeBudget: () => {
      w.calls.getEscapeBudget++;
      return w.escapeBudget;
    },
    abortAttempt: (agentId, attemptId, detail) => {
      w.calls.abortAttempt.push({ agentId, attemptId, detail });
    },
    handoffFailedRecovery: async (agentId, attemptId) => {
      w.calls.handoffFailedRecovery.push({ agentId, attemptId });
    },
    pageHuman: (agentId, message) => { w.calls.pageHuman.push({ agentId, message }); },
    log: () => {},
  };
}

const SELF = 'sup-1';

/** Tick until the debounce fires, then drain the detached attempt cycle. */
async function fireAndDrain(watcher: ContinuationWatcher, w: FakeWorld): Promise<void> {
  for (let i = 0; i < CONTINUATION_IDLE_DEBOUNCE_TICKS; i++) watcher.tick([SELF]);
  for (let i = 0; i < 500 && watcher.getAgentState(SELF).attemptInProgress; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(watcher.getAgentState(SELF).attemptInProgress, false, 'attempt cycle should settle');
}

test('idle debounce: first tick never fires, second tick does', async () => {
  const w = makeWorld({ toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' } });
  const watcher = new ContinuationWatcher(makeEffects(w));
  watcher.tick([SELF]);
  assert.equal(w.calls.openAttempt.length, 0, 'one idle tick must not fire');
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.openAttempt.length, 1);
});

test('idle@100% + committed note → normal continue (no escape, no abort)', async () => {
  const w = makeWorld({ contextPct: 100, toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' } });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.openAttempt.length, 1);
  assert.equal(w.calls.requestNote.length, 1, 'note request goes through the handshake effect');
  assert.ok(w.calls.requestNote[0].message.includes('save_continuation_brick'),
    'note request instructs the tool path');
  assert.deepEqual(w.calls.relaunch, [{ agentId: SELF, attemptId: 'att-1' }]);
  assert.equal(w.calls.relaunchNone.length, 0, 'no note-less escape when a note committed');
  assert.equal(w.calls.abortAttempt.length, 0);
  assert.equal(watcher.getAgentState(SELF).backoffUntil, 0, 'success clears backoff');
});

test('working@100% → not fired (idle gate holds it back before any attempt)', async () => {
  const w = makeWorld({ contextPct: 100, idle: false });
  const watcher = new ContinuationWatcher(makeEffects(w));
  for (let i = 0; i < 5; i++) watcher.tick([SELF]);
  assert.equal(w.calls.openAttempt.length, 0, 'a working agent near 100% is left to finish');
  assert.equal(w.calls.relaunchNone.length, 0);
});

test('handshake FAILED is pre-attempt: recovery runs, attempt stays open, no relaunch, no abort, backoff set', async () => {
  const w = makeWorld({ handshakeResult: 'failed' });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.handoffFailedRecovery.length, 1);
  assert.equal(w.calls.relaunch.length, 0, 'no kill-authorization consumed');
  assert.equal(w.calls.relaunchNone.length, 0);
  assert.equal(w.calls.abortAttempt.length, 0, 'attempt stays open');
  const st = watcher.getAgentState(SELF);
  assert.equal(st.openAttempt?.attemptId, 'att-1', 'attempt carried for the retry');
  assert.ok(st.backoffUntil > w.now.value - 1, 'backoff armed');
  assert.equal(st.lastBackoffMs, CONTINUATION_BACKOFF_MS);
});

test('handshake-failed retry reuses the still-open attempt (no second openAttempt, generation unadvanced)', async () => {
  const w = makeWorld({ handshakeResult: 'failed' });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.openAttempt.length, 1);
  // recover the world: handshake now succeeds and a tool brick commits
  w.handshakeResult = 'ok';
  w.toolBrick = { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' };
  w.now.value = watcher.getAgentState(SELF).backoffUntil + 1; // past backoff
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.openAttempt.length, 1, 'open attempt reused — server allocates NO new generation');
  assert.equal(w.calls.requestNote.length, 2);
  assert.deepEqual(w.calls.relaunch, [{ agentId: SELF, attemptId: 'att-1' }]);
});

test('handshake UNCONFIRMED proceeds to commit observation (not a definitive failure)', async () => {
  const w = makeWorld({
    handshakeResult: 'unconfirmed',
    toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.handoffFailedRecovery.length, 0);
  assert.equal(w.calls.relaunch.length, 1);
});

test('idle@100%, no note, budget NOT exhausted (aborts<MAX && alive<MAX_MS) → abort-retry + page, NO escape', async () => {
  const w = makeWorld({
    contextPct: 100,
    toolBrick: null,
    escapeBudget: { abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS - 1, firstAttemptStartedAtMs: 1_000_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.ok(w.calls.brickPolls > 1, 'commit-observed: the DB row was polled');
  assert.equal(w.calls.relaunch.length, 0, 'keep-alive: never killed');
  assert.equal(w.calls.relaunchNone.length, 0, 'budget not spent → no note-less escape');
  assert.deepEqual(w.calls.abortAttempt.map(c => c.attemptId), ['att-1']);
  assert.equal(w.calls.pageHuman.length, 1, 'human paged on the failed cycle');
  const st = watcher.getAgentState(SELF);
  assert.equal(st.openAttempt, null, 'aborted attempt not reused');
  assert.equal(st.lastBackoffMs, CONTINUATION_BACKOFF_MS);
});

test('idle@100%, no note, abortedCount >= MAX → relaunchNone (note-less escape)', async () => {
  const w = makeWorld({
    contextPct: 100,
    toolBrick: null,
    escapeBudget: { abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS, firstAttemptStartedAtMs: 1_000_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 0);
  assert.deepEqual(w.calls.relaunchNone, [{ agentId: SELF, attemptId: 'att-1' }]);
  assert.equal(w.calls.abortAttempt.length, 0, 'escape, not abort, once the budget is spent');
  assert.equal(w.calls.pageHuman.length, 1, 'escape pages the human');
});

test('idle@100%, no note, alive >= MAX_MS via the current OPEN attempt (zero aborts) → relaunchNone', async () => {
  const w = makeWorld({
    contextPct: 100,
    toolBrick: null,
    // firstAttemptStartedAtMs far enough back that now - start >= MAX_ALIVE_MS
    // even though zero aborts have been recorded (clarification 2).
    escapeBudget: { abortedCount: 0, firstAttemptStartedAtMs: 1_000_000 - CONTINUATION_ESCAPE_MAX_ALIVE_MS - 10_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.deepEqual(w.calls.relaunchNone, [{ agentId: SELF, attemptId: 'att-1' }]);
  assert.equal(w.calls.abortAttempt.length, 0);
});

test('escape budget from a PRIOR generation does not carry: a fresh cycle (zero aborts, recent start) does NOT escape immediately', async () => {
  // The wiring scopes getEscapeBudget to the current successor generation since
  // the last relaunch, so a fresh cycle reports {0, just-now} → abort-retry.
  const w = makeWorld({
    contextPct: 100,
    toolBrick: null,
    escapeBudget: { abortedCount: 0, firstAttemptStartedAtMs: 1_000_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunchNone.length, 0, 'a fresh cycle must not escape on stale prior-gen failures');
  assert.equal(w.calls.abortAttempt.length, 1, 'it abort-retries instead');
});

test('backoff doubles across consecutive aborts, capped', async () => {
  const w = makeWorld({
    toolBrick: null,
    escapeBudget: { abortedCount: 0, firstAttemptStartedAtMs: 1_000_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  const seen: number[] = [];
  for (let round = 0; round < 6; round++) {
    w.now.value = Math.max(w.now.value, watcher.getAgentState(SELF).backoffUntil) + 1;
    // Keep the cycle in "abort" territory: pin the clock reference forward so
    // alive-time never trips, and hold aborts below MAX.
    w.escapeBudget = { abortedCount: 0, firstAttemptStartedAtMs: w.now.value };
    await fireAndDrain(watcher, w);
    seen.push(watcher.getAgentState(SELF).lastBackoffMs ?? -1);
  }
  assert.equal(seen[0], CONTINUATION_BACKOFF_MS);
  assert.equal(seen[1], CONTINUATION_BACKOFF_MS * 2);
  assert.equal(seen[2], CONTINUATION_BACKOFF_MS * 4);
  assert.ok(seen[5] <= CONTINUATION_BACKOFF_CAP_MS, 'doubling is capped');
});

test('timeout-after-commit = success: brick row appears late, poll observes it, relaunch fires', async () => {
  const w = makeWorld({ toolBrick: null });
  // The supervisor's tool/HTTP response was never observed, but the row
  // commits mid-poll (well before the watcher deadline).
  const effects = makeEffects(w);
  const origSleep = effects.sleep;
  let elapsed = 0;
  effects.sleep = async (ms) => {
    await origSleep(ms);
    elapsed += ms;
    if (elapsed >= 60_000 && !w.toolBrick) {
      w.toolBrick = { id: 'b-late', writtenAt: '2026-07-03T10:01:30.000Z' };
    }
  };
  const watcher = new ContinuationWatcher(effects);
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.abortAttempt.length, 0);
  assert.deepEqual(w.calls.relaunch, [{ agentId: SELF, attemptId: 'att-1' }]);
});

test('scrape never authorizes: tool-source poll stays null → no relaunch; budget-not-spent → abort', async () => {
  // The effect queries source=tool ONLY; a scrape row is invisible to it by
  // construction. With no tool row and a fresh budget the watcher aborts.
  const w = makeWorld({
    toolBrick: null,
    escapeBudget: { abortedCount: 0, firstAttemptStartedAtMs: 1_000_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 0);
  assert.equal(w.calls.relaunchNone.length, 0);
  assert.equal(w.calls.abortAttempt.length, 1);
});

test('a tool brick written BEFORE the attempt opened does not authorize', async () => {
  const w = makeWorld({
    toolBrick: { id: 'b-stale', writtenAt: '2026-07-03T09:00:00.000Z' }, // < startedAt
    escapeBudget: { abortedCount: 0, firstAttemptStartedAtMs: 1_000_000 },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 0, 'stale brick is not kill-authorization');
  assert.equal(w.calls.abortAttempt.length, 1);
});

test('"none"-mode escape rejected server-side → keep-alive + page + backoff', async () => {
  const w = makeWorld({
    toolBrick: null,
    escapeBudget: { abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS, firstAttemptStartedAtMs: 1_000_000 },
    relaunchNoneOk: false,
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunchNone.length, 1);
  assert.equal(w.calls.pageHuman.length, 1);
  assert.ok(watcher.getAgentState(SELF).backoffUntil > 0);
});

test('relaunch rejected server-side after a committed brick → keep-alive, retry relaunch only', async () => {
  const w = makeWorld({
    toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' },
    relaunchOk: false,
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 1);
  assert.equal(w.calls.abortAttempt.length, 0, 'committed attempt kept');
  // gates clear again after backoff → retries the relaunch WITHOUT a second
  // note request or attempt
  w.relaunchOk = true;
  w.now.value = watcher.getAgentState(SELF).backoffUntil + 1;
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 2);
  assert.equal(w.calls.openAttempt.length, 1, 'no second attempt minted');
  assert.equal(w.calls.requestNote.length, 1, 'no duplicate note request');
});

test('trigger gates hold the watcher back before any attempt: awaiting-human blocks (correct fail-safe, not a bug)', async () => {
  const w = makeWorld({ awaitingHuman: true });
  const watcher = new ContinuationWatcher(makeEffects(w));
  for (let i = 0; i < 5; i++) watcher.tick([SELF]);
  assert.equal(w.calls.openAttempt.length, 0);
  assert.equal(w.calls.requestNote.length, 0);
});

test('owned busy / in-flight / orchestration block before any attempt', async () => {
  for (const ov of [
    { owned: [{ id: 'w1', status: 'working' as AgentStatus }] },
    { owned: [{ id: 'w1', status: 'idle' as AgentStatus }], inFlight: new Set(['w1']) },
    { orchestration: true },
  ] as Partial<FakeWorld>[]) {
    const w = makeWorld(ov);
    const watcher = new ContinuationWatcher(makeEffects(w));
    for (let i = 0; i < 4; i++) watcher.tick([SELF]);
    assert.equal(w.calls.openAttempt.length, 0);
  }
});

test('crashed owned ids ride the attempt reason', async () => {
  const w = makeWorld({
    owned: [{ id: 'w-crashed', status: 'crashed' as AgentStatus }],
    toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' },
  });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.openAttempt.length, 1);
  assert.ok(w.calls.openAttempt[0].reason.includes('w-crashed'),
    `crashed id should ride the reason, got: ${w.calls.openAttempt[0].reason}`);
});

test('openAttempt rejection (e.g. 409 open-attempt-exists) → backoff, no note request', async () => {
  const w = makeWorld({ openAttemptResult: null });
  const watcher = new ContinuationWatcher(makeEffects(w));
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.requestNote.length, 0);
  assert.ok(watcher.getAgentState(SELF).backoffUntil > 0);
});

test('note-request message content: attempt id + tool instruction + byte cap', () => {
  const msg = buildNoteRequestMessage('att-9', 'context ≥ 80%');
  assert.ok(msg.includes('att-9'));
  assert.ok(msg.includes('save_continuation_brick'));
  assert.ok(msg.includes('6 KB'));
});

// ── BUG-39 WP1: post-note grace decision + loop ───────────────────────

test('decidePostNoteProceed: N idle polls → turn-complete; deadline passed → grace-expired; else wait', () => {
  const deadline = 1_000_000;
  // turn-complete takes priority even at the exact deadline.
  assert.equal(decidePostNoteProceed(CONTINUATION_POST_NOTE_IDLE_POLLS, deadline, deadline), 'turn-complete');
  assert.equal(decidePostNoteProceed(CONTINUATION_POST_NOTE_IDLE_POLLS, deadline - 1, deadline), 'turn-complete');
  // Below the idle threshold, before the deadline → keep waiting.
  assert.equal(decidePostNoteProceed(CONTINUATION_POST_NOTE_IDLE_POLLS - 1, deadline - 1, deadline), 'wait');
  // Below the idle threshold, deadline reached → proceed anyway.
  assert.equal(decidePostNoteProceed(CONTINUATION_POST_NOTE_IDLE_POLLS - 1, deadline, deadline), 'grace-expired');
  assert.equal(decidePostNoteProceed(0, deadline + 5, deadline), 'grace-expired');
});

test('post-note grace: brick committed while author still working → no relaunch until N consecutive idle polls', async () => {
  const w = makeWorld({ toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' } });
  const effects = makeEffects(w);
  const logs: string[] = [];
  effects.log = (m) => { logs.push(m); };
  // The 2 debounce ticks read idle=true (fire); then the author is mid-turn
  // (working) for 3 grace polls before its turn completes.
  let idleCalls = 0;
  effects.isIdle = () => {
    idleCalls++;
    if (idleCalls <= CONTINUATION_IDLE_DEBOUNCE_TICKS) return true;   // debounce ticks
    return idleCalls > CONTINUATION_IDLE_DEBOUNCE_TICKS + 3;          // working 3 polls, then idle
  };
  const watcher = new ContinuationWatcher(effects);
  await fireAndDrain(watcher, w);
  assert.deepEqual(w.calls.relaunch, [{ agentId: SELF, attemptId: 'att-1' }],
    'relaunch fires exactly once, only after the turn completes');
  assert.ok(logs.some(l => l.includes('turn-complete observed')),
    'grace exit logged as turn-complete');
  // It genuinely waited: at least (working polls + the N idle polls) grace reads.
  assert.ok(idleCalls >= CONTINUATION_IDLE_DEBOUNCE_TICKS + 3 + CONTINUATION_POST_NOTE_IDLE_POLLS,
    `grace loop should have polled through the working turn, saw ${idleCalls} idle reads`);
});

test('post-note grace: author never goes idle → relaunch fires at the grace deadline (never immortal)', async () => {
  const w = makeWorld({ toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' } });
  const effects = makeEffects(w);
  const logs: string[] = [];
  effects.log = (m) => { logs.push(m); };
  let idleCalls = 0;
  effects.isIdle = () => {
    idleCalls++;
    return idleCalls <= CONTINUATION_IDLE_DEBOUNCE_TICKS;   // idle for the debounce, then working forever
  };
  const startNow = w.now.value;
  const watcher = new ContinuationWatcher(effects);
  await fireAndDrain(watcher, w);
  assert.deepEqual(w.calls.relaunch, [{ agentId: SELF, attemptId: 'att-1' }],
    'a wedged post-note turn still relaunches at the grace deadline');
  assert.ok(logs.some(l => l.includes('grace expired')), 'grace exit logged as grace-expired');
  assert.ok(w.now.value - startNow >= CONTINUATION_POST_NOTE_GRACE_MS,
    'the fake clock advanced past the full grace window before proceeding');
});

test('committedReady retry path re-runs the post-note grace loop before relaunching', async () => {
  const w = makeWorld({
    toolBrick: { id: 'b1', writtenAt: '2026-07-03T10:00:05.000Z' },
    relaunchOk: false,
  });
  const effects = makeEffects(w);
  const logs: string[] = [];
  effects.log = (m) => { logs.push(m); };
  const watcher = new ContinuationWatcher(effects);
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 1, 'first relaunch rejected server-side');
  const graceExitsAfterFirst = logs.filter(l => l.includes('proceeding to relaunch')).length;
  assert.equal(graceExitsAfterFirst, 1, 'grace ran once on the first cycle');
  // Recover: relaunch now succeeds; advance past backoff so the retry fires.
  w.relaunchOk = true;
  w.now.value = watcher.getAgentState(SELF).backoffUntil + 1;
  await fireAndDrain(watcher, w);
  assert.equal(w.calls.relaunch.length, 2, 'committedReady retry relaunches');
  assert.equal(w.calls.openAttempt.length, 1, 'no second attempt minted');
  assert.equal(w.calls.requestNote.length, 1, 'no duplicate note request');
  const graceExitsTotal = logs.filter(l => l.includes('proceeding to relaunch')).length;
  assert.equal(graceExitsTotal, 2, 'the grace loop re-ran on the committedReady retry path');
});

// ── BUG-39 WP2: successor pre-stage kickoff builder ───────────────────

test('kickoff message: [DASHBOARD]-labelled, orientation-only, hard stop before action', () => {
  const msg = buildContinuationKickoffMessage();
  assert.ok(msg.startsWith('[DASHBOARD] Continuation pre-stage'), 'clearly dashboard-labelled');
  assert.ok(msg.includes('get_my_context'), 'orientation step present');
  assert.ok(msg.includes('END YOUR TURN'), 'hard stop present');
  assert.ok(/Do NOT start or resume work/.test(msg), 'action is forbidden until the human speaks');
  // Snapshot the exact text so an accidental reword is caught.
  assert.equal(msg, [
    '[DASHBOARD] Continuation pre-stage (automatic — the human has not spoken yet).',
    "You are a fresh continuation session; your predecessor's note is in your system prompt.",
    'Orient NOW so you are warm when the human arrives:',
    "1. get_my_context; 2. read memory/MEMORY.md's top/active block; 3. verify the note's",
    'in-flight claims with cheap reads (git log/status, list_agents) — trust tools over the note.',
    'Then post a short readiness summary (≤10 lines: state verified, discrepancies, what you',
    'will do on the human\'s go) and END YOUR TURN. Do NOT start or resume work, do NOT',
    'dispatch/message workers, do NOT edit files until the human speaks.',
  ].join('\n'));
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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
