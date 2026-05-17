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

test('different text passes through (no false-positive dedupe)', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello');
  reader.queue.push(realUserText('something else', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 2, 'synthetic + real both emit');
  const e0 = emitted[0].events[0];
  const e1 = emitted[1].events[0];
  assert.ok(e0.type === 'user-text' && e0.text === 'hello');
  assert.ok(e1.type === 'user-text' && e1.text === 'something else');
});

test('whitespace differences still match (normalization)', () => {
  const { dispatcher, reader, emitted } = makeDispatcher();
  dispatcher.appendSyntheticUserText('agent-1', 'hello   world');
  reader.queue.push(realUserText('hello world', new Date()));
  dispatcher.pollNow();
  assert.equal(emitted.length, 1, 'normalized text matches');
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
