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

test('usage events read 0.128 nested shape (info.last_token_usage)', () => {
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

test('usage reads last_token_usage (single call), not total_token_usage (cumulative)', () => {
  // Real-shaped event from a long-running session: total_token_usage is
  // cumulative across calls and far exceeds the window, while
  // last_token_usage is the latest call's actual size and fits well within.
  // Pre-fix behavior clamped to 100%; post-fix should reflect last call.
  const sessionId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const tmpPath = path.join(os.tmpdir(), `codex-last-vs-total-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-18T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-18T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', model_context_window: 258_400 },
    }),
    JSON.stringify({
      timestamp: '2026-05-18T10:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          // Cumulative across many calls — would show as 585% with the old code.
          total_token_usage: {
            input_tokens: 1_502_799,
            cached_input_tokens: 1_361_024,
            output_tokens: 10_070,
            reasoning_output_tokens: 4_892,
            total_tokens: 1_512_869,
          },
          // The most recent call — actual current context occupancy.
          last_token_usage: {
            input_tokens: 144_194,
            cached_input_tokens: 142_208,
            output_tokens: 3_752,
            reasoning_output_tokens: 2_062,
            total_tokens: 147_946,
          },
          model_context_window: 258_400,
        },
      },
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
    const usage = events.find((e) => e.type === 'usage');
    assert.ok(usage && usage.type === 'usage');
    // Should reflect last_token_usage, not total_token_usage.
    assert.equal(usage.inputTokens, 144_194);
    assert.equal(usage.outputTokens, 3_752);
    assert.equal(usage.totalTokens, 147_946);
    assert.equal(usage.cumulativeContextTokens, 147_946);
    // Gauge policy caps the rollout-reported 258_400 window at 200K.
    assert.equal(usage.contextWindowMax, 200_000);
    // 147946 / 200000 = 74% — emphatically not 100% (cumulative would be 585%).
    assert.equal(usage.contextPercentage, 74);
  } finally {
    fs.unlinkSync(tmpPath);
  }
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

test('P2-01: endsWithQuestion set when in-batch task_complete tags a ?-ending text', () => {
  const sessionId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  const tmpPath = path.join(os.tmpdir(), `codex-q-inbatch-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-16T13:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T13:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Should I proceed?' }] },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T13:00:02.000Z',
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
    assert.equal(at.turnComplete, true);
    assert.equal(at.endsWithQuestion, true, 'P2-01: trailing ? sets endsWithQuestion=true');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('P2-01: endsWithQuestion=false when assistant-text does not end with ?', () => {
  const sessionId = '88888888-9999-aaaa-bbbb-cccccccccccc';
  const tmpPath = path.join(os.tmpdir(), `codex-q-not-${Date.now()}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-16T13:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T13:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T13:00:02.000Z',
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
    assert.equal(at.turnComplete, true);
    assert.equal(at.endsWithQuestion, false, 'P2-01: no trailing ? → endsWithQuestion=false');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('P2-01: split-batch patch carries endsWithQuestion through to ring mutation source', () => {
  // The patch event itself must carry endsWithQuestion derived from the prior
  // assistant-text's body, so the dispatcher can mutate the ring event in place.
  const sessionId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const tmpPath = path.join(os.tmpdir(), `codex-q-split-${Date.now()}.jsonl`);
  const stage1 = [
    JSON.stringify({
      timestamp: '2026-05-16T13:10:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'C:\\Users\\fixture', model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-16T13:10:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Want me to continue?' }] },
    }),
  ];
  const stage2Line = JSON.stringify({
    timestamp: '2026-05-16T13:10:02.000Z',
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
    reader.pollSession(makeSession({ sessionId }));
    fs.appendFileSync(tmpPath, stage2Line + '\n');
    const second = reader.pollSession(makeSession({ sessionId }));
    const patch = second.find((e) => e.type === 'assistant-text-patch');
    assert.ok(patch && patch.type === 'assistant-text-patch');
    assert.equal(patch.turnComplete, true);
    assert.equal(patch.endsWithQuestion, true, 'patch carries endsWithQuestion=true');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

// BUG-26 regressions: an unbound agent (session.sessionId === '') must NOT
// resolve a rollout via cwd fallback. Pre-fix, two failure modes triggered:
//   (1) concurrent same-cwd launches — newest mtime won for whichever rollout
//       flushed session_meta first, so events from both files cross-mixed.
//   (2) stale prior-day match — when today's rollout hadn't yet flushed
//       session_meta, the cwd walker grabbed yesterday's same-cwd rollout.
// Post-fix the reader returns 0 events; recovery is the supervisor's job.

test('BUG-26: unbound agent (sessionId="") emits no events when two same-cwd rollouts exist', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bug26-concurrent-'));
  const dayDir = path.join(tmpRoot, '2026', '05', '24');
  fs.mkdirSync(dayDir, { recursive: true });
  const peerId1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const peerId2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const cwd = 'C:\\Users\\fixture\\sharedcwd';
  for (const sid of [peerId1, peerId2]) {
    const filePath = path.join(dayDir, `rollout-2026-05-24T10-00-00-${sid}.jsonl`);
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-05-24T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sid, cwd, model_provider: 'openai', cli_version: '0.128.0' },
      }),
      JSON.stringify({
        timestamp: '2026-05-24T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: `prompt for ${sid}` },
      }),
      JSON.stringify({
        timestamp: '2026-05-24T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply from ${sid}` }] },
      }),
    ].join('\n') + '\n');
  }
  try {
    const reader = new CodexRolloutReader();
    (reader as any).windowsSessionsDir = tmpRoot;
    (reader as any).wslSessionsUncDir = null;
    // Pre-fix this would pick newest-mtime rollout by cwd and stream its
    // events under the agentId. Post-fix: 0 events.
    const events = reader.pollSession(makeSession({ sessionId: '', workingDirectory: cwd }));
    assert.equal(
      events.length,
      0,
      `unbound agent must emit 0 events; got ${events.length} (cwd fallback would mis-attribute)`
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('BUG-26: unbound agent (sessionId="") does NOT pick up a stale prior-day same-cwd rollout', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bug26-stale-'));
  const priorDay = path.join(tmpRoot, '2026', '05', '23');
  fs.mkdirSync(priorDay, { recursive: true });
  const cwd = 'C:\\Users\\fixture\\sharedcwd';
  const staleSid = 'cccccccc-dddd-eeee-ffff-000000000000';
  // Yesterday's rollout — perfectly valid session_meta + cwd matches.
  fs.writeFileSync(
    path.join(priorDay, `rollout-2026-05-23T08-00-00-${staleSid}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-05-23T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: staleSid, cwd, model_provider: 'openai', cli_version: '0.128.0' },
      }),
      JSON.stringify({
        timestamp: '2026-05-23T08:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Name a primary color.' },
      }),
      JSON.stringify({
        timestamp: '2026-05-23T08:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Red.' }] },
      }),
    ].join('\n') + '\n'
  );
  // Today's rollout exists but its session_meta hasn't flushed yet — pre-fix
  // the walker found today's file with cwd:null and walked back to yesterday.
  const today = path.join(tmpRoot, '2026', '05', '24');
  fs.mkdirSync(today, { recursive: true });
  const todaySid = 'dddddddd-eeee-ffff-0000-111111111111';
  fs.writeFileSync(
    path.join(today, `rollout-2026-05-24T10-00-00-${todaySid}.jsonl`),
    '' // empty — no session_meta yet
  );
  try {
    const reader = new CodexRolloutReader();
    (reader as any).windowsSessionsDir = tmpRoot;
    (reader as any).wslSessionsUncDir = null;
    const events = reader.pollSession(makeSession({ sessionId: '', workingDirectory: cwd }));
    assert.equal(
      events.length,
      0,
      'unbound agent must NOT inherit yesterday\'s same-cwd rollout (was the BUG-26 stale-prior-day failure)'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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

// ── Phase 2: one-shot prior-session disk reader ──────────────────────
//
// readSessionEventsOnce is a PURE read: it must parse a prior session's rollout
// straight from disk WITHOUT touching the per-agent maps of any live agent that
// shares the same working directory (many agents share one cwd by design), and
// WITHOUT advancing tail offsets or writing the resolved-path cache.

const P2_CWD = 'C:\\Users\\fixture\\priorsess';

/** Write a rollout under a temp `<root>/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl`
 *  tree so resolution goes through the reader's real base-dir walk. */
function writeRollout(root: string, sessionId: string, entries: unknown[]): string {
  const dir = path.join(root, '2026', '07', '01');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-01T09-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function makeP2Reader(root: string): CodexRolloutReader {
  const reader = new CodexRolloutReader();
  (reader as any).windowsSessionsDir = root;
  (reader as any).wslSessionsUncDir = null;
  return reader;
}

function p2Entries(sessionId: string) {
  return [
    {
      timestamp: '2026-07-01T09:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: P2_CWD, model_provider: 'openai', cli_version: '0.128.0' },
    },
    {
      timestamp: '2026-07-01T09:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'hello from the past' },
    },
    {
      timestamp: '2026-07-01T09:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a prior reply' }] },
    },
    {
      timestamp: '2026-07-01T09:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call_p2', name: 'shell', arguments: '{"command":"ls"}' },
    },
    {
      timestamp: '2026-07-01T09:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_p2', output: 'a.txt' },
    },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ];
}

test('P2: readSessionEventsOnce parses a prior session from disk (located by session id)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p2-parse-'));
  const sid = 'aaaa1111-2222-3333-4444-555555555555';
  writeRollout(root, sid, p2Entries(sid));
  try {
    const reader = makeP2Reader(root);
    const events = reader.readSessionEventsOnce(P2_CWD, sid);
    assert.ok(events, 'located + parsed');

    const kinds = events!.map((e) => e.type);
    assert.ok(kinds.includes('system-init'), 'has system-init');
    assert.ok(kinds.includes('user-text'), 'has the user turn');
    assert.ok(kinds.includes('assistant-text'), 'has the assistant turn');
    assert.ok(kinds.includes('tool-use'), 'has the tool call');
    assert.ok(kinds.includes('tool-result'), 'has the tool result');

    const user = events!.find((e) => e.type === 'user-text');
    assert.ok(user && user.type === 'user-text');
    assert.equal(user.text, 'hello from the past');

    // Shape-identical to the live tail path: same events, same order, same
    // turn-completion tagging (only the synthetic agentId differs).
    const live = makeP2Reader(root).pollSession(makeSession({ sessionId: sid, workingDirectory: P2_CWD }));
    assert.deepEqual(
      events!.map((e) => ({ ...e, agentId: 'X' })),
      live.map((e) => ({ ...e, agentId: 'X' })),
      'one-shot read must produce the same SessionEvent[] as the live tail',
    );
    const at = events!.find((e) => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text');
    assert.equal(at.turnComplete, true, 'task_complete walk-back still tags the turn');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P2: readSessionEventsOnce returns null for a missing/pruned session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p2-missing-'));
  try {
    const reader = makeP2Reader(root);
    assert.equal(reader.readSessionEventsOnce(P2_CWD, 'ffffffff-0000-1111-2222-333333333333'), null);
    // An empty session id is "cannot locate", not "found it, it was empty".
    assert.equal(reader.readSessionEventsOnce(P2_CWD, ''), null);

    // A located-but-empty rollout returns [] — distinct from null.
    const emptySid = 'bbbb1111-2222-3333-4444-555555555555';
    writeRollout(root, emptySid, []);
    assert.deepEqual(reader.readSessionEventsOnce(P2_CWD, emptySid), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P2: readSessionEventsOnce leaves NO residue in per-agent maps (shared-cwd purity)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p2-purity-'));
  const sid = 'cccc1111-2222-3333-4444-555555555555';
  writeRollout(root, sid, p2Entries(sid));
  try {
    const reader = makeP2Reader(root);
    // A LIVE agent sharing this cwd is already tailing its own rollout.
    const liveSid = 'dddd1111-2222-3333-4444-555555555555';
    writeRollout(root, liveSid, p2Entries(liveSid));
    reader.pollSession(makeSession({ sessionId: liveSid, workingDirectory: P2_CWD }));

    const snapshot = () => ({
      init: (reader as any).emittedSystemInit.size,
      model: (reader as any).currentModel.size,
      window: (reader as any).modelContextWindow.size,
      lastAt: (reader as any).lastAssistantTextEvent.size,
      eof: (reader as any).eofStreak.size,
      toolLocs: (reader as any).toolResultLocations.size,
      resolved: (reader as any).resolvedPaths.size,
    });
    const before = snapshot();
    reader.readSessionEventsOnce(P2_CWD, sid);
    assert.deepEqual(snapshot(), before, 'ephemeral parse scope fully cleaned up');
    // And the live agent's own state is intact: its next poll is still a no-op
    // (offset preserved), not a replay from byte 0.
    assert.equal(
      reader.pollSession(makeSession({ sessionId: liveSid, workingDirectory: P2_CWD })).length,
      0,
      'live agent unaffected by the concurrent one-shot read',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P2: readSessionEventsOnce does not advance tail offsets (no subscription/offset cache)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p2-offsets-'));
  const sid = 'eeee1111-2222-3333-4444-555555555555';
  writeRollout(root, sid, p2Entries(sid));
  try {
    const reader = makeP2Reader(root);
    const events = reader.readSessionEventsOnce(P2_CWD, sid);
    assert.ok(events && events.length > 0);
    assert.equal((reader as any).fileOffsets.size, 0, 'no fileOffsets written');
    assert.equal((reader as any).partialLines.size, 0, 'no partialLines written');
    assert.equal((reader as any).resolvedPaths.size, 0, 'no resolved-path cache written');

    // A subsequent live tail of the SAME session still replays from byte 0 —
    // the one-shot read consumed nothing.
    const live = reader.pollSession(makeSession({ sessionId: sid, workingDirectory: P2_CWD }));
    assert.equal(live.length, events!.length, 'live tail still sees the whole file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
