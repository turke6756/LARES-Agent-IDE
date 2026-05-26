// Reconcile-synthetic dedupe test for SessionLogDispatcher.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/session-log-dispatcher.test.js

import assert from 'node:assert/strict';
import { SessionLogDispatcher } from './session-log-dispatcher';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';
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
