// Targeted smoke test for ClaudeJsonlReader. Currently covers P2-01's
// endsWithQuestion computation since that's the first behavior tied to a
// dedicated test here; older claude reader behavior is exercised end-to-end
// by the dispatcher tests.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/claude-jsonl-reader.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeJsonlReader } from './claude-jsonl-reader';
import type { ChatLogReaderSession } from './types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeReader(fixturePath: string): ClaudeJsonlReader {
  return new (class extends ClaudeJsonlReader {
    constructor() {
      super();
      (this as any).resolvedPaths.set('test-agent', fixturePath);
    }
  })();
}

function makeSession(overrides: Partial<ChatLogReaderSession> = {}): ChatLogReaderSession {
  return {
    agentId: 'test-agent',
    sessionId: 'claude-test-session',
    workingDirectory: 'C:\\Users\\fixture',
    provider: 'claude',
    subscribed: true,
    ...overrides,
  };
}

function writeFixture(lines: object[]): string {
  const tmpPath = path.join(os.tmpdir(), `claude-jsonl-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(tmpPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return tmpPath;
}

// ── P2-01: endsWithQuestion ──────────────────────────────────────────

test('P2-01: end_turn assistant ending in ? has endsWithQuestion=true', () => {
  const tmpPath = writeFixture([
    {
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-05-16T14:00:00.000Z',
      message: {
        model: 'claude-opus',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Did that resolve the issue?' }],
      },
    },
  ]);
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession());
    const at = events.find(e => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text');
    assert.equal(at.turnComplete, true);
    assert.equal(at.endsWithQuestion, true);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('P2-01: end_turn assistant not ending in ? has endsWithQuestion=false', () => {
  const tmpPath = writeFixture([
    {
      type: 'assistant',
      uuid: 'a-2',
      timestamp: '2026-05-16T14:00:01.000Z',
      message: {
        model: 'claude-opus',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'All done.' }],
      },
    },
  ]);
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession());
    const at = events.find(e => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text');
    assert.equal(at.turnComplete, true);
    assert.equal(at.endsWithQuestion, false);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('P2-01: tool_use stop_reason leaves endsWithQuestion unset (no turnComplete)', () => {
  // Mid-turn chunks (stop_reason !== 'end_turn') shouldn't compute the flag.
  const tmpPath = writeFixture([
    {
      type: 'assistant',
      uuid: 'a-3',
      timestamp: '2026-05-16T14:00:02.000Z',
      message: {
        model: 'claude-opus',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Should I edit this file?' }],
      },
    },
  ]);
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession());
    const at = events.find(e => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text');
    assert.equal(at.turnComplete, false);
    assert.equal(at.endsWithQuestion, undefined,
      'mid-turn assistant chunks do not surface endsWithQuestion');
  } finally {
    fs.unlinkSync(tmpPath);
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
