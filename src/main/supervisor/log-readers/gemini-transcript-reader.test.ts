// Self-contained smoke test for GeminiTranscriptReader.
//
//   npm run build:main
//   node dist/main/supervisor/log-readers/gemini-transcript-reader.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiTranscriptReader, findGeminiTranscriptByCwd } from './gemini-transcript-reader';
import { flattenToolResultContent } from './types';
import type { ChatLogReaderSession } from './types';
import type { SessionEvent } from '../../../shared/session-events';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find repo root from ${start}`);
}

const REPO_ROOT = findRepoRoot(__dirname);
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  'src', 'main', 'supervisor', 'log-readers', '__fixtures__', 'gemini-transcript-sample.jsonl'
);

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error(`FIXTURE_PATH does not exist: ${FIXTURE_PATH}`);
  process.exit(2);
}

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeReader(fixturePath: string = FIXTURE_PATH): GeminiTranscriptReader {
  return new (class extends GeminiTranscriptReader {
    constructor() {
      super();
      (this as any).resolvedPaths.set('test-agent', fixturePath);
    }
  })();
}

function makeSession(overrides: Partial<ChatLogReaderSession> = {}): ChatLogReaderSession {
  return {
    agentId: 'test-agent',
    sessionId: '512a598e-5202-45b2-8089-5d961d1935fe',
    workingDirectory: 'C:\\Users\\fixture',
    provider: 'gemini',
    subscribed: true,
    ...overrides,
  };
}

function pollAll(reader: GeminiTranscriptReader): SessionEvent[] {
  return reader.pollSession(makeSession());
}

function countByType(events: SessionEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────

test('fixture parses with all expected event types', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const counts = countByType(events);
  assert.equal(counts['system-init'], 1, 'should emit exactly one system-init');
  assert.ok((counts['user-text'] || 0) >= 1, 'expect a user-text');
  assert.ok((counts['assistant-text'] || 0) >= 1, 'expect an assistant-text');
  assert.ok((counts['thinking'] || 0) >= 1, 'expect a thinking event');
  assert.ok((counts['tool-use'] || 0) >= 1, 'expect a tool-use');
  assert.ok((counts['tool-result'] || 0) >= 1, 'expect a tool-result');
  assert.ok((counts['usage'] || 0) >= 1, 'expect a usage');
});

test('mutating-id rewrite emits text + tool-use + tool-result each exactly once', () => {
  const reader = makeReader();
  const events = pollAll(reader);

  const toolUses = events.filter(e => e.type === 'tool-use');
  assert.equal(toolUses.length, 1, 'exactly one tool-use across rewrites');
  const tu = toolUses[0];
  assert.ok(tu.type === 'tool-use');
  assert.equal(tu.toolName, 'read_file');
  assert.equal((tu.input as any)?.file_path, 'CLAUDE.md');

  const toolResults = events.filter(e => e.type === 'tool-result');
  assert.equal(toolResults.length, 1, 'exactly one tool-result');
  const tr = toolResults[0];
  assert.ok(tr.type === 'tool-result');
  assert.match(tr.content, /Claude rules/);

  const assistantTexts = events.filter(e => e.type === 'assistant-text');
  // T1 has empty content (tool-only), T2 has 'Done.' — only T2 should produce text
  assert.equal(assistantTexts.length, 1);
  const at = assistantTexts[0];
  assert.ok(at.type === 'assistant-text');
  assert.equal(at.text, 'Done.');
});

test('thoughts emit as thinking events', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const thinking = events.filter(e => e.type === 'thinking');
  assert.ok(thinking.length >= 1);
  assert.ok(thinking[0].type === 'thinking');
  assert.match(thinking[0].text, /Project Structure/);
});

test('usage event has gemini-3-flash extended context window', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const usages = events.filter(e => e.type === 'usage');
  assert.ok(usages.length >= 1);
  const u = usages[0];
  assert.ok(u.type === 'usage');
  assert.equal(u.model, 'gemini-3-flash-preview');
  assert.equal(u.contextWindowMax, 1_000_000);
  assert.ok(u.cumulativeContextTokens > 0);
  assert.equal(u.cacheCreationTokens, 0);
});

test('flattenToolResultContent descends into functionResponse.response.output', () => {
  const flat = flattenToolResultContent([{ functionResponse: { response: { output: 'X' } } }]);
  assert.equal(flat, 'X');
  const flat2 = flattenToolResultContent([{ functionResponse: { response: { error: 'boom' } } }]);
  assert.equal(flat2, 'boom');
});

test('info and $set lines produce no events', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  // Header → 1 system-init only. No info/setting events should leak.
  for (const e of events) {
    assert.notEqual(e.uuid, undefined);
    assert.ok(['system-init', 'user-text', 'assistant-text', 'thinking', 'tool-use', 'tool-result', 'usage'].includes(e.type));
  }
});

test('incremental polling emits new events from appended lines without duplicates', () => {
  const original = fs.readFileSync(FIXTURE_PATH, 'utf-8').split('\n').filter(Boolean);
  const half = Math.max(1, Math.floor(original.length / 2));
  const tmpPath = path.join(os.tmpdir(), `gemini-tail-${Date.now()}.jsonl`);
  fs.writeFileSync(tmpPath, original.slice(0, half).join('\n') + '\n');
  try {
    const reader = makeReader(tmpPath);
    const first = reader.pollSession(makeSession());
    // Append remainder
    fs.writeFileSync(tmpPath, original.join('\n') + '\n');
    const second = reader.pollSession(makeSession());

    assert.ok(first.length > 0, 'first poll should emit events');
    assert.ok(second.length > 0, 'second poll should emit events from appended lines');

    const firstUuids = new Set(first.map(e => e.uuid));
    for (const e of second) {
      assert.ok(!firstUuids.has(e.uuid), `duplicate uuid across polls: ${e.uuid}`);
    }
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('malformed JSON line is skipped without throwing', () => {
  const tmpPath = path.join(os.tmpdir(), `gemini-malformed-${Date.now()}.jsonl`);
  const original = fs.readFileSync(FIXTURE_PATH, 'utf-8').split('\n').filter(Boolean);
  // First line is the session header — keep + add garbage.
  fs.writeFileSync(tmpPath, original[0] + '\n{not valid json\nalso not json\n');
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession());
    assert.ok(events.some(e => e.type === 'system-init'));
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('findGeminiTranscriptByCwd matches via .project_root file', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cwd-'));
  const slugDir = path.join(tmpRoot, 'myproj');
  const chatsDir = path.join(slugDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const cwd = 'C:\\Users\\fixture\\myproject';
  fs.writeFileSync(path.join(slugDir, '.project_root'), cwd.toLowerCase());
  const sessionFile = path.join(chatsDir, 'session-2026-05-02T12-00-abcdef12.jsonl');
  fs.writeFileSync(sessionFile, '');
  try {
    const found = findGeminiTranscriptByCwd([tmpRoot], cwd);
    assert.equal(found, sessionFile);
    const miss = findGeminiTranscriptByCwd([tmpRoot], 'C:\\Users\\does\\not\\match');
    assert.equal(miss, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findGeminiTranscriptByCwd ignores transcripts older than agent start', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cwd-new-'));
  const slugDir = path.join(tmpRoot, 'myproj');
  const chatsDir = path.join(slugDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const cwd = 'C:\\Users\\fixture\\myproject';
  fs.writeFileSync(path.join(slugDir, '.project_root'), cwd.toLowerCase());
  const oldFile = path.join(chatsDir, 'session-2026-05-02T12-00-abcdef12.jsonl');
  fs.writeFileSync(oldFile, '');
  const oldTime = new Date('2026-05-02T12:00:00Z');
  fs.utimesSync(oldFile, oldTime, oldTime);
  try {
    const found = findGeminiTranscriptByCwd([tmpRoot], cwd, '2026-05-02 12:05:00');
    assert.equal(found, null);

    const newFile = path.join(chatsDir, 'session-2026-05-02T12-06-fedcba98.jsonl');
    fs.writeFileSync(newFile, '');
    const newTime = new Date('2026-05-02T12:06:00Z');
    fs.utimesSync(newFile, newTime, newTime);
    const foundNew = findGeminiTranscriptByCwd([tmpRoot], cwd, '2026-05-02 12:05:00');
    assert.equal(foundNew, newFile);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('P2-01: endsWithQuestion is set per-turn from trimmed assistant content', () => {
  const sessionId = 'a7f1aef0-1111-2222-3333-4444aaaaaaaa';
  const tmpPath = path.join(os.tmpdir(), `gemini-q-${Date.now()}.jsonl`);
  const header = JSON.stringify({
    sessionId, projectHash: 'h', startTime: '2026-05-16T13:30:00.000Z', kind: 'main',
  });
  const turnQ = JSON.stringify({
    id: 'tQ', timestamp: '2026-05-16T13:30:05.000Z', type: 'gemini',
    content: 'Would you like to continue?', model: 'gemini-3-flash-preview',
  });
  const turnNotQ = JSON.stringify({
    id: 'tN', timestamp: '2026-05-16T13:30:10.000Z', type: 'gemini',
    content: 'Done.', model: 'gemini-3-flash-preview',
  });
  const turnTrailingWs = JSON.stringify({
    id: 'tW', timestamp: '2026-05-16T13:30:15.000Z', type: 'gemini',
    content: 'What now?   \n\n', model: 'gemini-3-flash-preview',
  });
  fs.writeFileSync(tmpPath, [header, turnQ, turnNotQ, turnTrailingWs].join('\n') + '\n');
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession({ sessionId }));
    const texts = events.filter(e => e.type === 'assistant-text');
    assert.equal(texts.length, 3);
    const byId = new Map<string, any>();
    for (const t of texts) byId.set((t as any).text, t);
    assert.equal(byId.get('Would you like to continue?').endsWithQuestion, true);
    assert.equal(byId.get('Done.').endsWithQuestion, false);
    // entry.content is trimmed to 'What now?' before the assistant-text emits;
    // trailing whitespace doesn't survive that path, so this also reports true.
    assert.equal(byId.get('What now?').endsWithQuestion, true,
      'trailing whitespace before ? still produces endsWithQuestion=true after trimEnd');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('BUG-09 §3.9: turnComplete gates on allToolsResolved && usageLanded', () => {
  const sessionId = 'b1c1aef0-aaaa-bbbb-cccc-dddd11112222';
  const tmpPath = path.join(os.tmpdir(), `gemini-tc-${Date.now()}.jsonl`);
  const header = JSON.stringify({
    sessionId, projectHash: 'h', startTime: '2026-05-18T00:00:00.000Z', kind: 'main',
  });

  // Phase A: assistant content + a tool call WITHOUT a result, no tokens.
  // Expectation: emit assistant-text with turnComplete=false (not done yet).
  const phaseA = JSON.stringify({
    id: 'turn-1',
    timestamp: '2026-05-18T00:00:01.000Z',
    type: 'gemini',
    content: 'Reading the file now.',
    model: 'gemini-3-flash-preview',
    toolCalls: [
      { id: 'tc-1', name: 'read_file', status: 'pending', args: { path: 'a.md' } },
    ],
  });
  fs.writeFileSync(tmpPath, [header, phaseA].join('\n') + '\n');

  const reader = makeReader(tmpPath);
  const first = reader.pollSession(makeSession({ sessionId }));
  const textsA = first.filter(e => e.type === 'assistant-text');
  assert.equal(textsA.length, 1);
  assert.ok(textsA[0].type === 'assistant-text');
  assert.equal(textsA[0].turnComplete, false,
    'BUG-09 §3.9: turnComplete=false until tools resolve + tokens land');

  // Phase B: same turn rewritten — tool now has a result, but tokens still
  // missing. Expectation: still NOT complete; no patch yet.
  const phaseB = JSON.stringify({
    id: 'turn-1',
    timestamp: '2026-05-18T00:00:02.000Z',
    type: 'gemini',
    content: 'Reading the file now.',
    model: 'gemini-3-flash-preview',
    toolCalls: [
      { id: 'tc-1', name: 'read_file', status: 'success', args: { path: 'a.md' }, result: 'contents' },
    ],
  });
  fs.writeFileSync(tmpPath, [header, phaseB].join('\n') + '\n');
  reader.invalidatePath('test-agent');
  (reader as any).resolvedPaths.set('test-agent', tmpPath);
  // Re-emit by simulating fresh agent — easier than mid-file diffing.
  const reader2 = makeReader(tmpPath);
  const second = reader2.pollSession(makeSession({ sessionId }));
  const textsB = second.filter(e => e.type === 'assistant-text');
  assert.equal(textsB.length, 1);
  assert.ok(textsB[0].type === 'assistant-text');
  assert.equal(textsB[0].turnComplete, false,
    'tools resolved but no tokens yet → still incomplete');
  const patchesB = second.filter(e => e.type === 'assistant-text-patch');
  assert.equal(patchesB.length, 0, 'no patch when assistant-text already incomplete');

  // Phase C: tokens land → turnComplete=true on a fresh emit.
  const phaseC = JSON.stringify({
    id: 'turn-1',
    timestamp: '2026-05-18T00:00:03.000Z',
    type: 'gemini',
    content: 'Reading the file now.',
    model: 'gemini-3-flash-preview',
    toolCalls: [
      { id: 'tc-1', name: 'read_file', status: 'success', args: { path: 'a.md' }, result: 'contents' },
    ],
    tokens: { input: 10, cached: 0, output: 5 },
  });
  fs.writeFileSync(tmpPath, [header, phaseC].join('\n') + '\n');
  const reader3 = makeReader(tmpPath);
  const third = reader3.pollSession(makeSession({ sessionId }));
  const textsC = third.filter(e => e.type === 'assistant-text');
  assert.equal(textsC.length, 1);
  assert.ok(textsC[0].type === 'assistant-text');
  assert.equal(textsC[0].turnComplete, true,
    'tools resolved + tokens landed → turnComplete=true on fresh emit');

  fs.unlinkSync(tmpPath);
});

test('BUG-09 §3.9: assistant-text-patch flips turnComplete on later poll', () => {
  const sessionId = 'c2d2aef0-eeee-ffff-0000-1111aaaabbbb';
  const tmpPath = path.join(os.tmpdir(), `gemini-patch-${Date.now()}.jsonl`);
  const header = JSON.stringify({
    sessionId, projectHash: 'h', startTime: '2026-05-18T00:00:00.000Z', kind: 'main',
  });

  // First poll sees the assistant emission without tokens.
  const phaseA = JSON.stringify({
    id: 'turn-X',
    timestamp: '2026-05-18T00:00:01.000Z',
    type: 'gemini',
    content: 'I am thinking.',
    model: 'gemini-3-flash-preview',
  });
  fs.writeFileSync(tmpPath, [header, phaseA].join('\n') + '\n');

  const reader = makeReader(tmpPath);
  const first = reader.pollSession(makeSession({ sessionId }));
  const textsA = first.filter(e => e.type === 'assistant-text');
  assert.equal(textsA.length, 1);
  assert.ok(textsA[0].type === 'assistant-text');
  assert.equal(textsA[0].turnComplete, false);
  const targetUuid = textsA[0].uuid;

  // Second poll: same turn now has tokens. Reader must emit an
  // assistant-text-patch flipping turnComplete to true.
  const phaseB = JSON.stringify({
    id: 'turn-X',
    timestamp: '2026-05-18T00:00:02.000Z',
    type: 'gemini',
    content: 'I am thinking.',
    model: 'gemini-3-flash-preview',
    tokens: { input: 8, cached: 0, output: 3 },
  });
  fs.appendFileSync(tmpPath, phaseB + '\n');
  const second = reader.pollSession(makeSession({ sessionId }));
  const patches = second.filter(e => e.type === 'assistant-text-patch');
  assert.equal(patches.length, 1, 'BUG-09 §3.9: patch fires on completion');
  assert.ok(patches[0].type === 'assistant-text-patch');
  assert.equal(patches[0].turnComplete, true);
  assert.equal(patches[0].targetUuid, targetUuid);

  // Third poll without further changes: no duplicate patch.
  const third = reader.pollSession(makeSession({ sessionId }));
  const dup = third.filter(e => e.type === 'assistant-text-patch');
  assert.equal(dup.length, 0, 'patch emitted at most once per turn');

  fs.unlinkSync(tmpPath);
});

test('getFullToolResult re-reads the rewritten gemini line', async () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const tr = events.find(e => e.type === 'tool-result');
  assert.ok(tr && tr.type === 'tool-result');
  const full = await reader.getFullToolResult('test-agent', tr.toolUseId);
  assert.ok(full !== null);
  assert.match(full as string, /Claude rules/);
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
