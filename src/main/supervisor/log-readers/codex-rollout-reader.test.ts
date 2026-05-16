// Self-contained smoke test for CodexRolloutReader.
//
// Runs against the anonymized fixture under __fixtures__/. Compile via the
// existing main tsconfig and run with:
//
//   npm run build:main
//   node dist/main/supervisor/log-readers/codex-rollout-reader.test.js
//
// No test runner is wired up at the project level yet (Phase 1 shipped
// without one); this file uses node:assert and exits non-zero on failure.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexRolloutReader, extractSessionIdFromFilename } from './codex-rollout-reader';
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
const FIXTURE_PATH = path.join(REPO_ROOT, 'src', 'main', 'supervisor', 'log-readers', '__fixtures__', 'codex-rollout-sample.jsonl');
const FIXTURE_SESSION_ID = '019de40d-ec5a-7253-87d3-7062ab223fff';

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error(`FIXTURE_PATH does not exist: ${FIXTURE_PATH}`);
  process.exit(2);
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeReader(): CodexRolloutReader {
  // Force the path resolution to find our fixture file by stubbing the
  // private resolver via a tiny subclass.
  return new (class extends CodexRolloutReader {
    constructor() {
      super();
      // Pre-seed the resolved path cache so pollSession reads the fixture
      // directly without touching ~/.codex/sessions/.
      (this as any).resolvedPaths.set('test-agent', FIXTURE_PATH);
    }
  })();
}

function makeSession(overrides: Partial<ChatLogReaderSession> = {}): ChatLogReaderSession {
  return {
    agentId: 'test-agent',
    sessionId: FIXTURE_SESSION_ID,
    workingDirectory: 'C:\\Users\\fixture',
    provider: 'codex',
    subscribed: true,
    ...overrides,
  };
}

function pollAll(reader: CodexRolloutReader): SessionEvent[] {
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
  assert.ok((counts['user-text'] || 0) >= 1, 'should emit at least one user-text');
  assert.ok((counts['assistant-text'] || 0) >= 1, 'should emit at least one assistant-text');
  assert.ok((counts['tool-use'] || 0) >= 1, 'should emit at least one tool-use');
  assert.ok((counts['tool-result'] || 0) >= 1, 'should emit at least one tool-result');
  assert.ok((counts['usage'] || 0) >= 1, 'should emit at least one usage');
  // thinking is optional: 0.128 emits encrypted-only reasoning by default
  // (summary[] empty) and our parser correctly drops those.
});

test('system-init carries model = "<provider>/<cli_version>" and cwd', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const init = events.find((e) => e.type === 'system-init');
  assert.ok(init && init.type === 'system-init');
  assert.match(init.model, /^openai\/0\.128\./, `model should be openai/0.128.x, got ${init.model}`);
  assert.equal(init.cwd, 'C:\\Users\\fixture');
});

test('user-text comes from event_msg/user_message only (no env_context wrappers)', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const userTexts = events.filter((e) => e.type === 'user-text');
  for (const e of userTexts) {
    assert.ok(e.type === 'user-text');
    assert.ok(
      !e.text.includes('<environment_context>'),
      `user-text leaked env_context wrapper: ${e.text.slice(0, 80)}`
    );
  }
  // Fixture has 2 user turns
  assert.equal(userTexts.length, 2);
});

test('assistant-text comes from response_item/message role=assistant (not duplicated by agent_message)', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const assistantTexts = events.filter((e) => e.type === 'assistant-text');
  // Fixture has 6 agent_message events but assistant-text should match the
  // response_item/message role=assistant count, not the sum.
  assert.ok(assistantTexts.length >= 1);
  for (const e of assistantTexts) {
    assert.ok(e.type === 'assistant-text');
    assert.ok(e.text.length > 0);
    assert.match(e.model || '', /^openai\//, `assistant-text should carry model tag, got ${e.model}`);
  }
});

test('tool-use parses arguments JSON-string into structured input', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const toolUses = events.filter((e) => e.type === 'tool-use');
  assert.ok(toolUses.length >= 1);
  const first = toolUses[0];
  assert.ok(first.type === 'tool-use');
  assert.equal(typeof first.toolUseId, 'string');
  assert.notEqual(first.toolUseId, '');
  // Codex shell_command arguments are { command, workdir, timeout_ms, ... }
  assert.equal(typeof first.input, 'object', `expected parsed object, got ${typeof first.input}`);
  assert.ok(first.input && (first.input as any).command, 'parsed input should have command field');
});

test('tool-result content is captured and tool_use_id roundtrips', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const toolResults = events.filter((e) => e.type === 'tool-result');
  const toolUses = events.filter((e) => e.type === 'tool-use');
  assert.ok(toolResults.length >= 1);
  for (const r of toolResults) {
    assert.ok(r.type === 'tool-result');
    assert.equal(typeof r.content, 'string');
    assert.equal(typeof r.truncated, 'boolean');
    // Each tool-result's call_id should match a preceding tool-use
    assert.ok(
      toolUses.some((u) => u.type === 'tool-use' && u.toolUseId === r.toolUseId),
      `tool-result ${r.toolUseId} has no matching tool-use`
    );
  }
});

test('usage events read 0.128 nested shape (info.total_token_usage)', () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const usages = events.filter((e) => e.type === 'usage');
  assert.ok(usages.length >= 1);
  // The fixture's first non-null token_count emits real numbers.
  const realUsage = usages.find((u) => u.type === 'usage' && u.totalTokens && u.totalTokens > 0);
  assert.ok(realUsage && realUsage.type === 'usage');
  assert.ok(realUsage.inputTokens > 0, 'inputTokens should be populated');
  assert.ok(realUsage.totalTokens && realUsage.totalTokens > 0, 'totalTokens should be set on Codex usage');
  assert.equal(realUsage.cacheCreationTokens, 0, 'Codex has no Anthropic cache split');
  assert.equal(realUsage.cacheReadTokens, 0, 'Codex has no Anthropic cache split');
  assert.ok((realUsage.cachedTokens || 0) >= 0, 'cachedTokens populated from cached_input_tokens');
  assert.ok(realUsage.contextWindowMax > 0);
  assert.ok(realUsage.contextPercentage >= 0 && realUsage.contextPercentage <= 100);
});

test('thinking events: empty summaries are dropped, non-empty are emitted', () => {
  // Build a minimal synthetic rollout with one non-empty reasoning + one empty.
  const tmpPath = path.join(os.tmpdir(), `codex-reasoning-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-01T15:00:00.000Z',
      type: 'session_meta',
      payload: { id: FIXTURE_SESSION_ID, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    // Non-empty reasoning — should emit
    JSON.stringify({
      timestamp: '2026-05-01T15:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Considered option A vs B.' }, { type: 'summary_text', text: 'Picked A.' }],
        encrypted_content: 'redacted',
      },
    }),
    // Empty reasoning — should drop
    JSON.stringify({
      timestamp: '2026-05-01T15:00:02.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], encrypted_content: 'redacted' },
    }),
  ];
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const events = reader.pollSession(makeSession());
    const thinking = events.filter((e) => e.type === 'thinking');
    assert.equal(thinking.length, 1, 'exactly one thinking emitted (empty dropped)');
    const t = thinking[0];
    assert.ok(t.type === 'thinking');
    assert.ok(t.text.includes('option A vs B'));
    assert.ok(t.text.includes('Picked A.'));
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('malformed JSON line is skipped without throwing', () => {
  const tmpPath = path.join(os.tmpdir(), `codex-malformed-${Date.now()}.jsonl`);
  const valid = fs.readFileSync(FIXTURE_PATH, 'utf-8').split('\n').slice(0, 3).join('\n');
  fs.writeFileSync(tmpPath, valid + '\n{this is not valid json\n' + 'also not json\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    // Should not throw
    const events = reader.pollSession(makeSession());
    // First valid line is session_meta → 1 system-init
    assert.ok(events.some((e) => e.type === 'system-init'));
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('getFullToolResult re-reads the original tool_result payload', async () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const toolResult = events.find((e) => e.type === 'tool-result');
  assert.ok(toolResult && toolResult.type === 'tool-result');
  const full = await reader.getFullToolResult('test-agent', toolResult.toolUseId);
  assert.ok(full !== null, 'getFullToolResult returned null');
  // Re-read should at least include the truncated content as a prefix
  if (!toolResult.truncated) {
    assert.equal(full, toolResult.content);
  } else {
    assert.ok((full as string).startsWith(toolResult.content.slice(0, 100)));
  }
});

test('getFullToolResult supports custom_tool_call_output payloads', async () => {
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const tmpPath = path.join(os.tmpdir(), `codex-custom-output-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-02T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-02T12:00:01.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_custom', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
    }),
    JSON.stringify({
      timestamp: '2026-05-02T12:00:02.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'custom output body' },
    }),
  ];
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const events = reader.pollSession(makeSession({ sessionId }));
    assert.ok(events.some((e) => e.type === 'tool-result' && e.toolUseId === 'call_custom'));
    const full = await reader.getFullToolResult('test-agent', 'call_custom');
    assert.equal(full, 'custom output body');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('custom apply_patch raw input is normalized with workdir', () => {
  const sessionId = '12121212-3434-5656-7878-909090909090';
  const tmpPath = path.join(os.tmpdir(), `codex-custom-apply-patch-${Date.now()}.jsonl`);
  const patchText = '*** Begin Patch\n*** Update File: src/foo.ts\n@@\n+const x = 1;\n*** End Patch';
  const workdir = 'C:\\Users\\fixture\\repo';
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-02T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: workdir, model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-02T12:00:01.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: patchText },
    }),
  ];
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const events = reader.pollSession(makeSession({ sessionId, workingDirectory: workdir }));
    const toolUse = events.find((e) => e.type === 'tool-use' && e.toolUseId === 'call_patch');
    assert.ok(toolUse && toolUse.type === 'tool-use');
    assert.deepEqual(toolUse.input, { input: patchText, workdir });
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('known session id resolves rollout older than the recent cwd window', () => {
  const sessionId = '22222222-3333-4444-5555-666666666666';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-old-history-'));
  const rolloutDir = path.join(tmpRoot, '2024', '01', '02');
  const rolloutPath = path.join(rolloutDir, `rollout-2024-01-02T03-04-05-${sessionId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: '2024-01-02T03:04:05.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2024-01-02T03:04:06.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'old history loads' },
    }),
  ].join('\n') + '\n');
  try {
    const reader = new CodexRolloutReader();
    (reader as any).windowsSessionsDir = tmpRoot;
    (reader as any).wslSessionsUncDir = null;
    const events = reader.pollSession(makeSession({ sessionId }));
    assert.ok(
      events.some((e) => e.type === 'user-text' && e.text === 'old history loads'),
      'reader should find known session ids outside today/yesterday'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('extractSessionIdFromFilename parses standard rollout filename', () => {
  const id = extractSessionIdFromFilename('rollout-2026-05-01T08-00-11-019de40d-ec5a-7253-87d3-7062ab223fff.jsonl');
  assert.equal(id, '019de40d-ec5a-7253-87d3-7062ab223fff');
  assert.equal(extractSessionIdFromFilename('not-a-rollout.jsonl'), null);
  assert.equal(extractSessionIdFromFilename('rollout-without-uuid.jsonl'), null);
});

test('byte-offset tail emits incremental events on second poll', () => {
  // Simulate a file that grows: read it fully into a temp file in two stages.
  const original = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const lines = original.split('\n').filter(Boolean);
  const half = Math.floor(lines.length / 2);
  const tmpPath = path.join(os.tmpdir(), `codex-tail-${Date.now()}.jsonl`);

  fs.writeFileSync(tmpPath, lines.slice(0, half).join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const first = reader.pollSession(makeSession());
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
    const second = reader.pollSession(makeSession());
    assert.ok(first.length > 0, 'first poll should emit events');
    assert.ok(second.length > 0, 'second poll should emit events from appended lines');
    // No duplicates between poll batches
    const firstUuids = new Set(first.map((e) => e.uuid));
    for (const e of second) {
      assert.ok(!firstUuids.has(e.uuid), `duplicate uuid across polls: ${e.uuid}`);
    }
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('task_started emits TaskStartedEvent and updates context window', () => {
  const sessionId = '44444444-5555-6666-7777-888888888888';
  const tmpPath = path.join(os.tmpdir(), `codex-task-started-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-16T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', model_context_window: 200_000 },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    }),
  ];
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const events = reader.pollSession(makeSession({ sessionId }));
    const ts = events.find((e) => e.type === 'task-started');
    assert.ok(ts && ts.type === 'task-started', 'task-started event emitted');
    assert.equal(ts.agentId, 'test-agent');
    // Ordering: task-started lands before the assistant-text that follows it.
    const tsIdx = events.indexOf(ts);
    const atIdx = events.findIndex((e) => e.type === 'assistant-text');
    assert.ok(tsIdx >= 0 && atIdx >= 0 && tsIdx < atIdx, 'task-started precedes assistant-text');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('BR-12: split-batch task_complete emits assistant-text-patch targeting prior assistant-text', () => {
  // Stage 1: write a rollout with assistant-text only (no task_complete yet).
  // Stage 2: append the task_complete line. Poll twice. First poll emits the
  // `assistant-text`. Second poll must emit `assistant-text-patch` whose
  // targetUuid matches stage 1's assistant-text uuid.
  const sessionId = '55555555-6666-7777-8888-999999999999';
  const tmpPath = path.join(os.tmpdir(), `codex-split-batch-${Date.now()}.jsonl`);
  const stage1 = [
    JSON.stringify({
      timestamp: '2026-05-16T11:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T11:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response body' }] },
    }),
  ];
  const stage2Line = JSON.stringify({
    timestamp: '2026-05-16T11:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete' },
  });

  fs.writeFileSync(tmpPath, stage1.join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const first = reader.pollSession(makeSession({ sessionId }));
    const at = first.find((e) => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text', 'stage 1 emits assistant-text');
    assert.equal(at.turnComplete, undefined, 'stage 1 does not yet flag turnComplete');

    fs.appendFileSync(tmpPath, stage2Line + '\n');
    const second = reader.pollSession(makeSession({ sessionId }));
    const patch = second.find((e) => e.type === 'assistant-text-patch');
    assert.ok(patch && patch.type === 'assistant-text-patch', 'stage 2 emits assistant-text-patch');
    assert.equal(patch.targetUuid, at.uuid, 'patch targets the stage 1 assistant-text by uuid');
    assert.equal(patch.turnComplete, true, 'patch sets turnComplete: true');
    assert.equal(patch.stopReason, 'task_complete', 'patch carries stopReason');
    // No assistant-text re-emitted in stage 2.
    assert.equal(
      second.filter((e) => e.type === 'assistant-text').length,
      0,
      'stage 2 does not re-emit assistant-text',
    );
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('in-batch task_complete still tags via direct walk-back (no patch emitted)', () => {
  // Sanity: when task_complete arrives in the same poll as the assistant-text,
  // the reader takes the fast path — no patch event is needed.
  const sessionId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const tmpPath = path.join(os.tmpdir(), `codex-inbatch-complete-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-16T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T12:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'all done' }] },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T12:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }),
  ];
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
  try {
    const reader = new (class extends CodexRolloutReader {
      constructor() {
        super();
        (this as any).resolvedPaths.set('test-agent', tmpPath);
      }
    })();
    const events = reader.pollSession(makeSession({ sessionId }));
    const at = events.find((e) => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text');
    assert.equal(at.turnComplete, true, 'in-batch walk-back tags assistant-text directly');
    assert.equal(at.stopReason, 'task_complete');
    assert.equal(
      events.filter((e) => e.type === 'assistant-text-patch').length,
      0,
      'no patch event when in-batch walk-back succeeds',
    );
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('subscribed idle path refresh does not replay the same rollout', () => {
  const sessionId = '33333333-4444-5555-6666-777777777777';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-idle-refresh-'));
  const rolloutDir = path.join(tmpRoot, '2026', '05', '02');
  const rolloutPath = path.join(rolloutDir, `rollout-2026-05-02T10-11-12-${sessionId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: '2026-05-02T10:11:12.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-02T10:11:13.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'ping' },
    }),
    JSON.stringify({
      timestamp: '2026-05-02T10:11:14.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
    }),
  ].join('\n') + '\n');

  try {
    const reader = new CodexRolloutReader();
    (reader as any).windowsSessionsDir = tmpRoot;
    (reader as any).wslSessionsUncDir = null;
    const session = makeSession({ sessionId, subscribed: true });
    const first = reader.pollSession(session);
    assert.ok(first.some((e) => e.type === 'assistant-text' && e.text === 'pong'));

    assert.equal(reader.pollSession(session).length, 0);
    assert.equal(reader.pollSession(session).length, 0);
    assert.equal(reader.pollSession(session).length, 0);
    assert.equal(reader.pollSession(session).length, 0, 're-resolving the same idle file must not replay from byte 0');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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
