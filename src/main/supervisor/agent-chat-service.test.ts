// WP-4 (memory-hardening Part B) — parity between the `getMessages(limit:1)`
// two-scan short-circuit and the full path, plus the pure per-turn build.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/agent-chat-service.test.js
//
// The message builders are pure (no database, no dispatcher) so the fast path
// and full path can be compared directly on identical event fixtures — which is
// exactly the "parity vs the full path" guarantee the plan requires.

import assert from 'node:assert/strict';
import {
  buildMessages,
  buildMessagesFullPath,
  buildMessagesLimitOne,
  buildMessageForTurn,
  type TurnAgent,
  type GetMessagesOptions,
} from './agent-chat-service';
import type {
  SessionEvent,
  UserTextEvent,
  AssistantTextEvent,
  ThinkingEvent,
  ToolUseEvent,
} from '../../shared/session-events';

const AGENT: TurnAgent = { resumeSessionId: 'sess-1', provider: 'claude' };

// ── Event fixture builders ─────────────────────────────────────────────

let clock = 1_700_000_000_000;
function nextTs(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function user(uuid: string, text: string): UserTextEvent {
  return { type: 'user-text', uuid, timestamp: nextTs(), agentId: 'agent-1', text };
}
function assistant(uuid: string, text: string, turnComplete?: boolean): AssistantTextEvent {
  return { type: 'assistant-text', uuid, timestamp: nextTs(), agentId: 'agent-1', text, turnComplete };
}
function thinking(uuid: string, text: string): ThinkingEvent {
  return { type: 'thinking', uuid, timestamp: nextTs(), agentId: 'agent-1', text };
}
function toolUse(uuid: string, toolName: string): ToolUseEvent {
  return {
    type: 'tool-use',
    uuid,
    timestamp: nextTs(),
    agentId: 'agent-1',
    toolUseId: `${uuid}-tu`,
    toolName,
    input: { foo: 'bar' },
  };
}

// ── Tiny runner (mirrors session-log-dispatcher.test.ts) ───────────────

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

/** Assert the fast path agrees with the full path for the given options. */
function assertParity(events: SessionEvent[], options: GetMessagesOptions, label: string): void {
  const full = buildMessagesFullPath(events, AGENT, options);
  const fast = buildMessagesLimitOne(events, AGENT, options);
  assert.deepEqual(fast, full, `${label}: fast path must equal full path`);
}

// A rich, mixed fixture exercising every turn shape:
//   u1  user
//   a1  assistant-text (complete)
//   u2  user
//   a2  thinking + tool-use only  → no message
//   a3  two assistant-text (last completes)
//   m1  user + assistant under one turn id → user precedence
function richFixture(): SessionEvent[] {
  return [
    user('u1', 'hi'),
    assistant('a1', 'resp1', true),
    user('u2', 'again'),
    thinking('a2#0', 'hmm'),
    toolUse('a2#1', 'Bash'),
    assistant('a3#0', 'resp3a', false),
    assistant('a3#1', 'resp3b', true),
    user('m1#0', 'mix'),
    assistant('m1#1', 'mixresp', true),
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────

test('parity: {limit:1} selects the newest message-bearing turn', () => {
  const events = richFixture();
  assertParity(events, { limit: 1 }, '{limit:1}');
  // Concretely: newest turn (m1) is user-precedence → user "mix".
  const fast = buildMessagesLimitOne(events, AGENT, { limit: 1 });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].role, 'user');
  assert.equal(fast[0].content, 'mix');
});

test('parity: {limit:1, role:"assistant"} skips the newer user turn', () => {
  const events = richFixture();
  assertParity(events, { limit: 1, role: 'assistant' }, '{limit:1,assistant}');
  const fast = buildMessagesLimitOne(events, AGENT, { limit: 1, role: 'assistant' });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].role, 'assistant');
  // a3 is the newest assistant-text turn; m1 is user (skipped), a2 is tool-only.
  assert.equal(fast[0].content, 'resp3a\nresp3b');
  assert.equal(fast[0].turnComplete, true, 'turnComplete from the LAST assistant-text event');
});

test('parity: {limit:1, role:"user"} selects the newest user turn', () => {
  const events = richFixture();
  assertParity(events, { limit: 1, role: 'user' }, '{limit:1,user}');
  const fast = buildMessagesLimitOne(events, AGENT, { limit: 1, role: 'user' });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].role, 'user');
  assert.equal(fast[0].content, 'mix'); // m1 (user precedence) is newest user turn
});

test('non-contiguous repeated turn id: both paths agree', () => {
  // Turn A is split by an interleaved B event: A#0, B#0, A#1.
  const events: SessionEvent[] = [
    assistant('A#0', 'a-part1', false),
    user('B#0', 'b'),
    assistant('A#1', 'a-part2', true),
  ];
  assertParity(events, { limit: 1 }, 'non-contiguous {limit:1}');
  assertParity(events, { limit: 1, role: 'assistant' }, 'non-contiguous {limit:1,assistant}');
  assertParity(events, { limit: 1, role: 'user' }, 'non-contiguous {limit:1,user}');

  // The assistant turn must reassemble both fragments chronologically.
  const asst = buildMessagesLimitOne(events, AGENT, { limit: 1, role: 'assistant' });
  assert.equal(asst[0].content, 'a-part1\na-part2');
  assert.equal(asst[0].turnComplete, true);
});

test('mixed user+assistant under one turn id → user precedence (both paths)', () => {
  const events: SessionEvent[] = [
    user('t#0', 'the question'),
    assistant('t#1', 'the answer', true),
  ];
  assertParity(events, { limit: 1 }, 'mixed {limit:1}');
  const both = buildMessagesFullPath(events, AGENT, { limit: 1 });
  assert.equal(both.length, 1);
  assert.equal(both[0].role, 'user', 'a turn with any user-text is a user message');
  assert.equal(both[0].content, 'the question');

  // role:'assistant' finds NO message (the only turn is a user turn).
  assertParity(events, { limit: 1, role: 'assistant' }, 'mixed {limit:1,assistant}');
  assert.deepEqual(buildMessagesLimitOne(events, AGENT, { limit: 1, role: 'assistant' }), []);
});

test('newest assistant turn is tool-use-only → skips to previous assistant-text turn', () => {
  const events: SessionEvent[] = [
    assistant('old', 'the real answer', true),
    thinking('new#0', 'planning'),
    toolUse('new#1', 'Read'),
  ];
  assertParity(events, { limit: 1 }, 'tool-only {limit:1}');
  assertParity(events, { limit: 1, role: 'assistant' }, 'tool-only {limit:1,assistant}');
  const fast = buildMessagesLimitOne(events, AGENT, { limit: 1, role: 'assistant' });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].content, 'the real answer', 'tool-use-only turn yields no message; skip to it');
});

test('turnComplete comes from the LAST assistant-text event', () => {
  // Two assistant-text events in one turn; last one completes.
  const completeLast: SessionEvent[] = [
    assistant('t#0', 'partial', false),
    assistant('t#1', 'final', true),
  ];
  assert.equal(buildMessagesLimitOne(completeLast, AGENT, { limit: 1 })[0].turnComplete, true);

  // Last one is NOT complete → message is incomplete even if an earlier one was.
  const incompleteLast: SessionEvent[] = [
    assistant('t2#0', 'first', true),
    assistant('t2#1', 'still going', false),
  ];
  assert.equal(buildMessagesLimitOne(incompleteLast, AGENT, { limit: 1 })[0].turnComplete, false);
  assertParity(incompleteLast, { limit: 1 }, 'turnComplete-from-last');
});

test('limit:0 routes to the full path and matches it (returns all, newest-first)', () => {
  const events = richFixture();
  const routed = buildMessages(events, AGENT, { limit: 0 });
  const full = buildMessagesFullPath(events, AGENT, { limit: 0 });
  assert.deepEqual(routed, full, 'limit:0 must not take the fast path');
  // Full path with falsy limit returns ALL message-bearing turns.
  // u1,a1,u2,a3,m1 produce messages (a2 is tool-only) → 5 messages.
  assert.equal(routed.length, 5);
  assert.equal(routed[0].content, 'mix', 'newest first');
});

test('limit:1 routing goes through the fast path', () => {
  const events = richFixture();
  const routed = buildMessages(events, AGENT, { limit: 1 });
  const fast = buildMessagesLimitOne(events, AGENT, { limit: 1 });
  assert.deepEqual(routed, fast);
});

test('empty events → [] on both paths', () => {
  assert.deepEqual(buildMessagesLimitOne([], AGENT, { limit: 1 }), []);
  assert.deepEqual(buildMessagesFullPath([], AGENT, { limit: 1 }), []);
  assert.deepEqual(buildMessages([], AGENT, { limit: 1 }), []);
});

test('buildMessageForTurn: thinking/tool-use-only turn → null', () => {
  const turn: SessionEvent[] = [thinking('x#0', 'think'), toolUse('x#1', 'Grep')];
  assert.equal(buildMessageForTurn(turn, AGENT), null);
});

test('buildMessageForTurn: empty turn → null', () => {
  assert.equal(buildMessageForTurn([], AGENT), null);
});

test('parity across a broad option matrix on the rich fixture', () => {
  const events = richFixture();
  const matrix: GetMessagesOptions[] = [
    { limit: 1 },
    { limit: 1, role: 'user' },
    { limit: 1, role: 'assistant' },
  ];
  for (const opt of matrix) assertParity(events, opt, JSON.stringify(opt));
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
