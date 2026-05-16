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
