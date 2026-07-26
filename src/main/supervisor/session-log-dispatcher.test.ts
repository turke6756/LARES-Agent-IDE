// Reconcile-synthetic dedupe test for SessionLogDispatcher.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/session-log-dispatcher.test.js

import assert from 'node:assert/strict';
import { SessionLogDispatcher, truncateUtf8ToBytes, type SessionStaleEvent } from './session-log-dispatcher';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';
import type { AgentProvider } from '../../shared/types';
import type {
  SessionEvent,
  UserTextEvent,
  ChatEventBatch,
  AssistantTextEvent,
  AssistantTextPatchEvent,
} from '../../shared/session-events';

class FakeReader implements ChatLogReader {
  readonly provider = 'codex' as const;
  queue: SessionEvent[] = [];
  pollSession(_session: ChatLogReaderSession): SessionEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  invalidatePath(_agentId: string): void {}
}

function makeDispatcher(): {
  dispatcher: SessionLogDispatcher;
  reader: FakeReader;
  emitted: ChatEventBatch[];
} {
  const reader = new FakeReader();
  const dispatcher = new SessionLogDispatcher(() => [
    {
      agentId: 'agent-1',
      sessionId: 'sess-1',
      workingDirectory: '/repo',
      provider: 'codex' as const,
    },
  ]);
  dispatcher.register(reader);
  const emitted: ChatEventBatch[] = [];
  dispatcher.on('chat-events', (b) => emitted.push(b));
  return { dispatcher, reader, emitted };
}

function realUserText(text: string, when: Date): UserTextEvent {
  return {
    type: 'user-text',
    uuid: `real:${Math.random()}`,
    timestamp: when.toISOString(),
    agentId: 'agent-1',
    text,
  };
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

// ── Tests ────────────────────────────────────────────────────────────

test('synthetic followed by matching real within window: real is dropped', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello world');
  reader.queue.push(realUserText('hello world', new Date()));
  dispatcher.pollNow();
  // First batch: synthetic. Second batch: would be real, but dedupe drops it.
  assert.equal(emitted.length, 1, 'only synthetic batch should emit');
  assert.equal(emitted[0].events[0].uuid.startsWith('synthetic:'), true);
});

test('recency-only dedupe: real with different text still drops within window', () => {
  // Post-fix contract: text content is no longer the dedupe key. Any real
  // user-text arriving within the window of an unconsumed synthetic is
  // assumed to be the PTY echo of that send (the alternative — concurrent
  // direct-TUI typing — is rare and explicitly documented as a known
  // attribution race in SyntheticMarker's comment).
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  reader.queue.push(realUserText('something else', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'synthetic only; real dropped by recency match');
  assert.equal(emitted[0].events[0].uuid.startsWith('synthetic:'), true);
});

test('real arriving outside the 35s window passes through', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  // Simulate a real event 60s later
  const future = new Date(Date.now() + 60_000);
  reader.queue.push(realUserText('hello', future));
  dispatcher.pollNow();
  assert.equal(emitted.length, 2, 'out-of-window real should pass through');
});

test('marker is consumed on hit (second matching real is NOT dropped)', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  reader.queue.push(realUserText('hello', new Date()), realUserText('hello', new Date()));
  dispatcher.pollNow();
  // First real consumed by marker; second real has no marker left.
  assert.equal(emitted.length, 2, 'synthetic batch + second real batch');
});

// ── Recency dedupe: PTY unicode-mangling repro (the original bug) ────

test('em-dash flattened by PTY still dedupes (the original bug)', () => {
  // Repro of plans/groupthink-duplicate-relay-investigation.md: ConPTY /
  // Win32 Input Mode replaces U+2014 (em-dash) with a single space before
  // codex sees the input. Pre-fix, the text-equality dedupe missed and
  // both copies emitted. Post-fix, recency wins.
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'Draft 1 — review of doc');
  reader.queue.push(realUserText('Draft 1   review of doc', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'mangled real should still be dropped');
  assert.equal(emitted[0].events[0].uuid.startsWith('synthetic:'), true);
});

test('en-dash flattened by PTY still dedupes', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'pages 884–895 reviewed');
  reader.queue.push(realUserText('pages 884 895 reviewed', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1);
});

test('smart apostrophe flattened by PTY still dedupes', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'don’t skip the heartbeat');
  reader.queue.push(realUserText('don t skip the heartbeat', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1);
});

test('ellipsis flattened by PTY still dedupes', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'and then… confirm');
  reader.queue.push(realUserText('and then  confirm', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1);
});

test('multiple in-flight synthetics: reals consume markers FIFO', () => {
  // Two back-to-back script sends, both eventually echoed by codex with
  // unicode mangled to ASCII. With recency-only dedupe, FIFO consumption
  // means both reals drop regardless of text identity.
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'first — message');
  dispatcher.appendSyntheticUserText('agent-1', 'second — message');
  // Note: real arrival order doesn't matter (and could be reversed in
  // pathological codex flush patterns) — FIFO marker consumption is robust
  // either way. Here we use the natural in-order case.
  reader.queue.push(
    realUserText('first   message', new Date()),
    realUserText('second   message', new Date()),
  );
  dispatcher.pollNow();
  // 2 synthetic batches; both reals dropped.
  assert.equal(emitted.length, 2, 'only the two synthetics should emit');
  assert.ok(emitted[0].events[0].uuid.startsWith('synthetic:'));
  assert.ok(emitted[1].events[0].uuid.startsWith('synthetic:'));
});

test('synthetic recorded after real arrives: both emit (real had no marker)', () => {
  // Edge case for the dedupe contract: if a real `user-text` event lands
  // before any synthetic marker exists for that agent, the real flows
  // through unmodified, and a subsequent synthetic still emits its own
  // event. Chat ends up with both — documented behavior, not a regression.
  const { dispatcher, reader, emitted } = makeDispatcher();
  reader.queue.push(realUserText('preexisting input', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'real emits (no marker yet)');
  assert.ok(emitted[0].events[0].uuid.startsWith('real:'));

  dispatcher.appendSyntheticUserText('agent-1', 'preexisting input');
  assert.equal(emitted.length, 2, 'synthetic still emits after the real');
  assert.ok(emitted[1].events[0].uuid.startsWith('synthetic:'));
});

test('window boundary: real at exactly +35s is still dropped', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  // Pin the marker timestamp deterministically so the boundary math doesn't
  // race the few-ms between this test's `Date.now()` and the one inside
  // `appendSyntheticUserText`.
  const markerTs = 1_000_000_000_000;
  (dispatcher as any).syntheticMarkers.get('agent-1')[0].timestamp = markerTs;
  reader.queue.push(realUserText('hello', new Date(markerTs + 35_000)));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'boundary is inclusive — dedupe still fires');
});

test('window boundary: real at +35001ms passes through', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  const markerTs = 1_000_000_000_000;
  (dispatcher as any).syntheticMarkers.get('agent-1')[0].timestamp = markerTs;
  reader.queue.push(realUserText('hello', new Date(markerTs + 35_001)));
  dispatcher.pollNow();
  assert.equal(emitted.length, 2, 'one tick past the boundary is outside');
});

test('real user event dropped by synthetic dedupe is remembered by uuid on replay', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  const real = realUserText('hello', new Date());
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  reader.queue.push(real);
  dispatcher.pollNow();
  reader.queue.push(real);
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'synthetic batch only; replayed real stays dropped');
});

test('duplicate reader events are ignored by uuid', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  const real = realUserText('hello', new Date());
  reader.queue.push(real);
  dispatcher.pollNow();
  reader.queue.push(real);
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'same event uuid should emit once');
});

test('non-user-text events are never dedupe candidates', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  // Push an assistant-text with the same text as the synthetic — must pass through
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'a:1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'hello',
  } as SessionEvent);
  dispatcher.pollNow();
  assert.equal(emitted.length, 2, 'assistant-text never deduped');
});

test('BR-12 (dispatcher half): assistant-text-patch mutates ring buffer entry in place', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  // Poll 1: emit the assistant-text only.
  const at: AssistantTextEvent = {
    type: 'assistant-text',
    uuid: 'a:split-1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'response body',
  };
  reader.queue.push(at);
  dispatcher.pollNow();
  assert.equal(emitted.length, 1);
  const ringAfterPoll1 = dispatcher.getCachedEvents('agent-1').events;
  const ringEntry = ringAfterPoll1.find(e => e.uuid === 'a:split-1');
  assert.ok(ringEntry && ringEntry.type === 'assistant-text');
  assert.equal(ringEntry.turnComplete, undefined, 'pre-patch: turnComplete not yet set');

  // Poll 2: dispatcher receives the patch and must mutate the prior event in place.
  const patch: AssistantTextPatchEvent = {
    type: 'assistant-text-patch',
    uuid: 'atp:split-1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    targetUuid: 'a:split-1',
    turnComplete: true,
    stopReason: 'task_complete',
  };
  reader.queue.push(patch);
  // The dispatcher's per-agent rate limiter would skip a back-to-back tick;
  // clear it so the second poll actually runs.
  (dispatcher as any).nextPollAt.clear();
  dispatcher.pollNow();

  // The patch is in the second batch alongside the existing ring entry.
  assert.equal(emitted.length, 2);
  assert.ok(emitted[1].events.some(e => e.type === 'assistant-text-patch'));

  // Ring mutated in place — same object identity, new flags.
  const ringAfterPoll2 = dispatcher.getCachedEvents('agent-1').events;
  const mutated = ringAfterPoll2.find(e => e.uuid === 'a:split-1');
  assert.ok(mutated && mutated.type === 'assistant-text');
  assert.equal(mutated.turnComplete, true, 'patch propagated turnComplete');
  assert.equal(mutated.stopReason, 'task_complete', 'patch propagated stopReason');
  assert.strictEqual(mutated, ringEntry, 'in-place mutation preserves object identity');
});

test('BUG-07: pollNow(agentId) bypasses nextPollAt rate-limit gate', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();

  // Poll once so any first-call bookkeeping is settled.
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'a:initial',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'initial',
  } as SessionEvent);
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'initial poll emits the seed event');

  // Simulate the background tick having just run for this agent: pin
  // nextPollAt far enough in the future that `tick()` would skip the agent.
  (dispatcher as any).nextPollAt.set('agent-1', Date.now() + 60_000);

  // A new event lands on disk (in the fake reader's queue).
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'a:fresh',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'fresh turn',
  } as SessionEvent);

  // Pre-fix: pollNow() → tick() would `continue` past agent-1 and never
  // drain the queue, so emitted.length stays at 1 and the new event is
  // invisible to AgentChatService.getMessages. Post-fix: pollNow(agentId)
  // bypasses the gate and pollOne() drains the queue.
  dispatcher.pollNow('agent-1');
  assert.equal(emitted.length, 2, 'forced pollNow(agentId) should fire despite future nextPollAt');
  assert.equal(emitted[1].events[0].uuid, 'a:fresh');

  // It must also refresh the gate (so we don't accidentally promote one
  // forced call into an unbounded poll storm).
  const dueAfter = (dispatcher as any).nextPollAt.get('agent-1') as number;
  assert.ok(dueAfter > Date.now(), 'forced poll must re-arm nextPollAt');
});

test('BUG-07: pollNow(agentId) does NOT reset other agents\' gating timers', () => {
  const reader = new FakeReader();
  const dispatcher = new SessionLogDispatcher(() => [
    { agentId: 'agent-1', sessionId: 's1', workingDirectory: '/repo', provider: 'codex' as const },
    { agentId: 'agent-2', sessionId: 's2', workingDirectory: '/repo', provider: 'codex' as const },
  ]);
  dispatcher.register(reader);
  const emitted: ChatEventBatch[] = [];
  dispatcher.on('chat-events', (b) => emitted.push(b));

  const futureGate = Date.now() + 60_000;
  (dispatcher as any).nextPollAt.set('agent-1', futureGate);
  (dispatcher as any).nextPollAt.set('agent-2', futureGate);

  reader.queue.push({
    type: 'assistant-text',
    uuid: 'a:only-agent-1-cares',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'fresh',
  } as SessionEvent);
  dispatcher.pollNow('agent-1');

  const after2 = (dispatcher as any).nextPollAt.get('agent-2') as number;
  assert.equal(after2, futureGate, 'agent-2 gate must be untouched by a scoped pollNow');
});

test('BUG-26: rebindAgent clears the ring buffer for the agent', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  // Seed the dispatcher with wrong-attribution events that came in under the
  // pre-binding (sessionId="") code path.
  reader.queue.push(
    {
      type: 'user-text',
      uuid: 'wrong:u1',
      timestamp: new Date().toISOString(),
      agentId: 'agent-1',
      text: 'wrong prompt',
    } as SessionEvent,
    {
      type: 'assistant-text',
      uuid: 'wrong:a1',
      timestamp: new Date().toISOString(),
      agentId: 'agent-1',
      text: 'wrong reply',
    } as SessionEvent,
    {
      type: 'assistant-text',
      uuid: 'wrong:a2',
      timestamp: new Date().toISOString(),
      agentId: 'agent-1',
      text: 'another wrong reply',
    } as SessionEvent,
  );
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'initial wrong-attribution batch emitted');
  assert.equal(dispatcher.getCachedEvents('agent-1').events.length, 3);

  // Late binding fires: rebind drops the ring so the chat now reflects only
  // events from the freshly-resolved (correct) rollout.
  dispatcher.rebindAgent('agent-1');
  assert.equal(
    dispatcher.getCachedEvents('agent-1').events.length,
    0,
    'rebind must clear eventsByAgent so getCachedEvents returns no stale events'
  );
});

test('BUG-26: rebindAgent resets emittedInitialBatch so the next batch is marked initialLoad', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  // First batch — flagged initialLoad: true.
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'first:1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'pre-rebind reply',
  } as SessionEvent);
  dispatcher.pollNow();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].initialLoad, true, 'pre-rebind first batch is initialLoad: true');

  // Subsequent batches drop the flag.
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'second:1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'pre-rebind second batch',
  } as SessionEvent);
  (dispatcher as any).nextPollAt.clear();
  dispatcher.pollNow();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].initialLoad, undefined, 'second batch is not initialLoad');

  // Rebind, then queue a new event — the next batch must be re-flagged
  // initialLoad: true so the event-bridge skips stale-event latch updates.
  dispatcher.rebindAgent('agent-1');
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'post-rebind:1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'correct reply',
  } as SessionEvent);
  (dispatcher as any).nextPollAt.clear();
  dispatcher.pollNow();
  assert.equal(emitted.length, 3);
  assert.equal(
    emitted[2].initialLoad,
    true,
    'post-rebind batch must be flagged initialLoad: true so event-bridge can suppress latches'
  );
});

test('BUG-26: rebindAgent clears synthetic markers (so a stale marker can\'t eat the next real)', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  // Park a synthetic marker as if we appended an echo before the rebind.
  dispatcher.appendSyntheticUserText('agent-1', 'pre-rebind echo');
  assert.equal(emitted.length, 1);
  assert.ok(
    (dispatcher as any).syntheticMarkers.get('agent-1')?.length >= 1,
    'pre-condition: marker is registered'
  );

  // Rebind drops the marker; a fresh real user-text after the rebind must
  // pass through (rather than being dropped as if it were the echo of a
  // long-since-completed pre-bind send).
  dispatcher.rebindAgent('agent-1');
  const markers = (dispatcher as any).syntheticMarkers.get('agent-1');
  assert.ok(!markers || markers.length === 0, 'rebind cleared synthetic markers');

  reader.queue.push({
    type: 'user-text',
    uuid: 'post-rebind-real',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'post-rebind echo',
  } as SessionEvent);
  dispatcher.pollNow();
  assert.equal(
    emitted.length,
    2,
    'post-rebind real user-text must NOT be consumed by a stale marker',
  );
});

test('BUG-26: rebindAgent delegates to reader.invalidatePath(agentId)', () => {
  // Belt-and-suspenders: rebind must also drop the reader's file-offset
  // state so the reader can re-resolve to the newly-bound rollout from byte 0.
  const reader = new FakeReader();
  let invalidatedFor: string | null = null;
  reader.invalidatePath = (id) => { invalidatedFor = id; };
  const dispatcher = new SessionLogDispatcher(() => [
    { agentId: 'agent-X', sessionId: '', workingDirectory: '/repo', provider: 'codex' as const },
  ]);
  dispatcher.register(reader);
  dispatcher.rebindAgent('agent-X');
  assert.equal(invalidatedFor, 'agent-X', 'rebindAgent must call reader.invalidatePath(agentId)');
});

test('BUG-26 Layer 2/3: rebindAgent emits "agent-rebound" exactly once with { agentId }', () => {
  // Downstream consumers (ContextStatsMonitor + the file_activities DB
  // table) don't subscribe to chat events — they need a discrete signal so
  // the supervisor can purge their per-agent state on late binding.
  const { dispatcher } = makeDispatcher();
  const events: Array<{ agentId: string }> = [];
  dispatcher.on('agent-rebound', (payload) => events.push(payload));

  dispatcher.rebindAgent('agent-1');
  assert.equal(events.length, 1, 'one emit per rebindAgent call');
  assert.deepEqual(events[0], { agentId: 'agent-1' });

  dispatcher.rebindAgent('agent-2');
  assert.equal(events.length, 2, 'each rebind fires its own event');
  assert.deepEqual(events[1], { agentId: 'agent-2' });
});

test('codex sessions with blank sessionId are still polled', () => {
  const reader = new FakeReader();
  const dispatcher = new SessionLogDispatcher(() => [
    {
      agentId: 'agent-1',
      sessionId: '',
      workingDirectory: '/repo',
      provider: 'codex' as const,
    },
  ]);
  dispatcher.register(reader);
  const emitted: ChatEventBatch[] = [];
  dispatcher.on('chat-events', (b) => emitted.push(b));
  reader.queue.push({
    type: 'assistant-text',
    uuid: 'a:blank-session',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text: 'hello before discovery',
  } as SessionEvent);
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'blank-session codex agent should still poll');
  assert.equal(emitted[0].events[0].uuid, 'a:blank-session');
});

// ── /clear-rotation: session-pinned stale-drain + successor validate ──

// Reader exposing a one-shot session-pinned stale drain and an optional
// validateClearSuccessor delegate. The stale records carry the session-pinned
// shape (agentId + staleSessionId + workingDirectory + observedAt) so the
// dispatcher can re-emit them verbatim as `'session-stale'`.
class StaleReader implements ChatLogReader {
  readonly provider: AgentProvider;
  private staleQueue: SessionStaleEvent[][];
  constructor(provider: AgentProvider, staleQueue: SessionStaleEvent[][] = []) {
    this.provider = provider;
    this.staleQueue = staleQueue;
  }
  pollSession(_session: ChatLogReaderSession): SessionEvent[] { return []; }
  invalidatePath(_agentId: string): void {}
  drainStaleSignals(): SessionStaleEvent[] {
    return this.staleQueue.length ? this.staleQueue.shift()! : [];
  }
  validateClearSuccessor?(
    _wd: string, _cur: string, _cand: string, _started?: string
  ): boolean;
}

// A reader with no /clear-rotation methods at all.
class PlainReader implements ChatLogReader {
  readonly provider: AgentProvider;
  constructor(provider: AgentProvider) { this.provider = provider; }
  pollSession(_session: ChatLogReaderSession): SessionEvent[] { return []; }
  invalidatePath(_agentId: string): void {}
}

function staleSignal(agentId: string, staleSessionId: string): SessionStaleEvent {
  return { agentId, staleSessionId, workingDirectory: 'C:\\repo', observedAt: 1_700_000_000_000 };
}

test('20: pollNow drains a reader\'s session-pinned stale signals and emits session-stale once', () => {
  // Returns one record once, then [] — the dispatcher must re-emit the FULL
  // session-pinned payload (not a bare { agentId }) exactly once.
  const sig = staleSignal('a1', 'sess-a1');
  const reader = new StaleReader('claude', [[sig]]);
  const dispatcher = new SessionLogDispatcher(() => []);
  dispatcher.register(reader);

  const staleEmitted: SessionStaleEvent[] = [];
  dispatcher.on('session-stale', (p) => staleEmitted.push(p));

  dispatcher.pollNow();
  dispatcher.pollNow(); // second drain returns [] → no further emit

  assert.deepEqual(staleEmitted, [sig]);
});

test('21: validateClearSuccessor delegates to the claude reader, false when method absent', () => {
  // Reader implements the method → its boolean is returned, and it receives
  // (workingDirectory, currentSessionId, candidateSessionId, startedAt) — the
  // provider arg is stripped by the dispatcher.
  const reader = new StaleReader('claude');
  const seen: string[] = [];
  reader.validateClearSuccessor = (wd, cur, cand, started) => {
    seen.push(wd, cur, cand, started ?? '<none>');
    return cand === 'good';
  };
  const dispatcher = new SessionLogDispatcher(() => []);
  dispatcher.register(reader);
  assert.equal(dispatcher.validateClearSuccessor('claude', 'C:\\repo', 'cur', 'good', 'T0'), true);
  assert.deepEqual(seen, ['C:\\repo', 'cur', 'good', 'T0']);
  // Same reader, a candidate it rejects → false.
  assert.equal(dispatcher.validateClearSuccessor('claude', 'C:\\repo', 'cur', 'bad', 'T0'), false);

  // Registered reader lacks the method → false (never throws).
  const plainDispatcher = new SessionLogDispatcher(() => []);
  plainDispatcher.register(new PlainReader('claude'));
  assert.equal(plainDispatcher.validateClearSuccessor('claude', 'C:\\repo', 'cur', 'good'), false);

  // No reader registered for the provider at all → false.
  const emptyDispatcher = new SessionLogDispatcher(() => []);
  assert.equal(emptyDispatcher.validateClearSuccessor('claude', 'C:\\repo', 'cur', 'good'), false);
});

// ── WP-1c: chat ring byte budget + per-event hard cap ──────────────────

const RING_BUFFER_MAX = 2000;
const RING_BYTE_BUDGET = 8 * 1024 * 1024;
const EVENT_TEXT_HARD_CAP = 1 * 1024 * 1024;
const TRUNC_MARKER = '\n…[truncated]';

function assistantText(uuid: string, text: string): SessionEvent {
  return {
    type: 'assistant-text',
    uuid,
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    text,
  } as SessionEvent;
}

test('WP-1c: truncateUtf8ToBytes — ASCII prefix', () => {
  assert.equal(truncateUtf8ToBytes('hello world', 5), 'hello');
  assert.equal(truncateUtf8ToBytes('hello', 100), 'hello', 'under cap returns whole string');
  assert.equal(truncateUtf8ToBytes('hello', 0), '', 'zero budget yields empty');
});

test('WP-1c: truncateUtf8ToBytes — multibyte BMP counted by bytes, never split', () => {
  // Each U+3042 (あ) is 3 UTF-8 bytes. maxBytes=4 fits exactly one.
  const s = 'あいう';
  const out = truncateUtf8ToBytes(s, 4);
  assert.equal(out, 'あ');
  assert.ok(Buffer.byteLength(out, 'utf8') <= 4);
  // maxBytes=5 still only one whole char (two would be 6 bytes) — no partial byte.
  assert.equal(truncateUtf8ToBytes(s, 5), 'あ');
});

test('WP-1c: truncateUtf8ToBytes — never splits a surrogate pair near the boundary', () => {
  // U+1F600 (😀) is 4 UTF-8 bytes / 2 UTF-16 code units.
  const s = 'A😀'; // 1 + 4 = 5 bytes
  // Budget lands inside the emoji: must drop it wholesale, keeping only 'A'.
  const out4 = truncateUtf8ToBytes(s, 4);
  assert.equal(out4, 'A', 'a boundary inside the pair backs off to before the high surrogate');
  assert.ok(Buffer.byteLength(out4, 'utf8') <= 4);
  const lastUnit = out4.charCodeAt(out4.length - 1);
  assert.ok(!(lastUnit >= 0xd800 && lastUnit <= 0xdbff), 'result never ends on a lone high surrogate');
  // Exactly enough bytes: the whole pair fits.
  assert.equal(truncateUtf8ToBytes(s, 5), 'A😀');
  // Two emoji, budget fits one pair only (second would need 8 bytes).
  assert.equal(truncateUtf8ToBytes('😀😀', 5), '😀');
});

test('WP-1c: whole-turn eviction when BOTH count and byte thresholds are crossed', () => {
  const { dispatcher, reader } = makeDispatcher();
  // 700 turns × 3 events = 2100 events (> RING_BUFFER_MAX=2000) and ~13.5 MiB
  // (> RING_BYTE_BUDGET=8 MiB): BOTH caps are crossed.
  //
  // WB-24: the turn shape is deliberately `[big(20 KB), small, small]` with an
  // ODD event count. Under CORRECT whole-turn eviction the byte budget is the
  // binding constraint and the surviving head lands on a turn start (`#0`),
  // with the ring length a multiple of 3. Under a naive per-EVENT eviction the
  // budget is satisfied right after dropping some turn's big `#0` element,
  // leaving that turn's `#1`/`#2` fragment at the head — so `head.uuid` ends
  // `#1` and the length is not a multiple of 3. Only whole-turn eviction yields
  // the asserted shape (a uniform 2-event fixture would let the even count-cap
  // boundary satisfy the assertion regardless — the reason this fixture is odd).
  const big = 'x'.repeat(20000);
  const turns = 700;
  for (let i = 0; i < turns; i++) {
    reader.queue.push(assistantText(`t${i}#0`, big));
    reader.queue.push(assistantText(`t${i}#1`, 'y'));
    reader.queue.push(assistantText(`t${i}#2`, 'z'));
  }
  dispatcher.pollNow();

  const buf = (dispatcher as any).eventsByAgent.get('agent-1') as SessionEvent[];
  const bytes = (dispatcher as any).ringBytesByAgent.get('agent-1') as number;
  const sizes = (dispatcher as any).ringEventBytes.get('agent-1') as number[];

  assert.ok(buf.length <= RING_BUFFER_MAX, `count within cap (${buf.length})`);
  assert.ok(bytes <= RING_BYTE_BUDGET, `bytes within budget (${bytes})`);
  assert.equal(sizes.length, buf.length, 'ringEventBytes stays aligned with the ring');
  assert.equal(dispatcher.getCachedEvents('agent-1').truncated, true, 'truncated flag set');

  // The surviving ring starts at a turn boundary and holds only whole 3-event
  // turns — no partial-turn fragment was left at the head.
  assert.ok(buf[0].uuid.endsWith('#0'), `head is a turn start (${buf[0].uuid})`);
  assert.equal(buf.length % 3, 0, 'only whole 3-event turns survive');
  for (let j = 0; j < buf.length; j += 3) {
    const prefix = buf[j].uuid.split('#')[0];
    assert.ok(buf[j].uuid.endsWith('#0'), `turn start at index ${j} (${buf[j].uuid})`);
    assert.ok(buf[j + 1].uuid.endsWith('#1'), `same turn at ${j + 1} (${buf[j + 1].uuid})`);
    assert.ok(buf[j + 2].uuid.endsWith('#2'), `same turn at ${j + 2} (${buf[j + 2].uuid})`);
    assert.equal(buf[j + 1].uuid.split('#')[0], prefix, 'events share the turn id');
    assert.equal(buf[j + 2].uuid.split('#')[0], prefix, 'events share the turn id');
  }
});

test('WP-1c: multibyte payload counted by bytes, not characters', () => {
  const { dispatcher, reader } = makeDispatcher();
  const N = 100;
  reader.queue.push(assistantText('ascii#0', 'a'.repeat(N))); // N bytes
  reader.queue.push(assistantText('multi#0', 'あ'.repeat(N))); // 3N bytes
  dispatcher.pollNow();
  const sizes = (dispatcher as any).ringEventBytes.get('agent-1') as number[];
  // Difference is purely the byte delta (2 extra bytes per multibyte char),
  // independent of the fixed per-event overhead.
  assert.equal(sizes[1] - sizes[0], 2 * N, 'byte accounting, not char count');
});

test('WP-1c: oversized assistant text (>1 MiB) — cache truncated, live batch untouched', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  const big = 'x'.repeat(Math.floor(1.5 * 1024 * 1024)); // 1.5 MiB
  const ev = assistantText('big#0', big);
  reader.queue.push(ev);
  dispatcher.pollNow();

  // Live 'chat-events' batch carries the ORIGINAL, untruncated object.
  assert.equal(emitted.length, 1);
  const live = emitted[0].events[0] as any;
  assert.equal(Buffer.byteLength(live.text, 'utf8'), big.length, 'live text is not truncated');
  assert.strictEqual(live, ev, 'batch delivers the original object reference');

  // Cached ring copy is a DIFFERENT object, truncated to <= 1 MiB incl. marker.
  const cached = dispatcher.getCachedEvents('agent-1').events[0] as any;
  assert.notStrictEqual(cached, ev, 'ring copy is a clone, not the original');
  assert.ok(Buffer.byteLength(cached.text, 'utf8') <= EVENT_TEXT_HARD_CAP, 'ring text <= 1 MiB');
  assert.ok(cached.text.endsWith(TRUNC_MARKER), 'ring text ends with the truncation marker');
});

test('WP-1c: event under the cap is stored by identity (no clone)', () => {
  const { dispatcher, reader } = makeDispatcher();
  const ev = assistantText('small#0', 'just a little text');
  reader.queue.push(ev);
  dispatcher.pollNow();
  const cached = dispatcher.getCachedEvents('agent-1').events[0];
  assert.strictEqual(cached, ev, 'sub-cap events are stored by original reference');
});

test('WP-1c: oversized tool-use.input — live delivery intact, cache evicts it', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  const toolUses: SessionEvent[] = [];
  dispatcher.on('tool-use', (e) => toolUses.push(e));

  const oversized = {
    type: 'tool-use',
    uuid: 'tu#0',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    toolUseId: 'tu-0',
    toolName: 'Write',
    input: { data: 'x'.repeat(9 * 1024 * 1024) }, // > RING_BYTE_BUDGET
  } as SessionEvent;
  reader.queue.push(oversized);
  dispatcher.pollNow();

  // Both live fan-outs receive the ORIGINAL, unmodified object.
  assert.strictEqual(emitted[0].events[0], oversized, "'chat-events' gets the original");
  assert.equal(toolUses.length, 1);
  assert.strictEqual(toolUses[0], oversized, "'tool-use' fan-out gets the original");
  assert.equal((oversized as any).input.data.length, 9 * 1024 * 1024, 'input never truncated');

  // The cache evicts the oversized single-event turn entirely.
  assert.equal(dispatcher.getCachedEvents('agent-1').events.length, 0, 'evicted from the ring');
  assert.equal((dispatcher as any).ringBytesByAgent.get('agent-1'), 0, 'ring byte total back to 0');
});

test('WP-1c: ringBytesByAgent / ringEventBytes reset on rebindAgent and forgetAgent', () => {
  // rebind
  {
    const { dispatcher, reader } = makeDispatcher();
    reader.queue.push(assistantText('r#0', 'seed'));
    dispatcher.pollNow();
    assert.ok((dispatcher as any).ringBytesByAgent.has('agent-1'));
    assert.ok((dispatcher as any).ringEventBytes.has('agent-1'));
    dispatcher.rebindAgent('agent-1');
    assert.equal((dispatcher as any).ringBytesByAgent.has('agent-1'), false, 'rebind clears byte total');
    assert.equal((dispatcher as any).ringEventBytes.has('agent-1'), false, 'rebind clears size array');
  }
  // forget
  {
    const { dispatcher, reader } = makeDispatcher();
    reader.queue.push(assistantText('f#0', 'seed'));
    dispatcher.pollNow();
    assert.ok((dispatcher as any).ringBytesByAgent.has('agent-1'));
    dispatcher.forgetAgent('agent-1');
    assert.equal((dispatcher as any).ringBytesByAgent.has('agent-1'), false, 'forget clears byte total');
    assert.equal((dispatcher as any).ringEventBytes.has('agent-1'), false, 'forget clears size array');
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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
