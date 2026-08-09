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
import { setContextGaugeCapResolver } from '../../context-gauge/context-gauge-cap';

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

test('Claude 2.1.225 real-schema shell results preserve tool names, command input, and is_error', () => {
  // Sanitized from real ~/.claude/projects JSONLs produced by Claude Code
  // 2.1.225. This pins the envelope that feeds ContextStatsMonitor: assistant
  // tool_use blocks followed by user tool_result blocks paired by tool_use_id.
  const tmpPath = writeFixture([
    {
      type: 'assistant', uuid: 'shell-use', timestamp: '2026-08-08T12:00:00.000Z', version: '2.1.225',
      message: {
        model: 'claude-opus-4-1', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'head -60 src/main.ts' } }],
      },
    },
    {
      type: 'user', uuid: 'shell-result', timestamp: '2026-08-08T12:00:01.000Z', version: '2.1.225',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'first sixty lines', is_error: false }] },
    },
    {
      type: 'assistant', uuid: 'ps-use', timestamp: '2026-08-08T12:00:02.000Z', version: '2.1.225',
      message: {
        model: 'claude-opus-4-1', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_ps', name: 'PowerShell', input: { command: "Set-Content -LiteralPath 'out.txt' -Value 'x'" } }],
      },
    },
    {
      type: 'user', uuid: 'ps-result', timestamp: '2026-08-08T12:00:03.000Z', version: '2.1.225',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ps', content: 'Exit code 1', is_error: true }] },
    },
  ]);
  try {
    const events = makeReader(tmpPath).pollSession(makeSession());
    const bashUse = events.find(e => e.type === 'tool-use' && e.toolUseId === 'toolu_bash');
    const bashResult = events.find(e => e.type === 'tool-result' && e.toolUseId === 'toolu_bash');
    const psUse = events.find(e => e.type === 'tool-use' && e.toolUseId === 'toolu_ps');
    const psResult = events.find(e => e.type === 'tool-result' && e.toolUseId === 'toolu_ps');
    assert.ok(bashUse && bashUse.type === 'tool-use');
    assert.equal(bashUse.toolName, 'Bash');
    assert.deepEqual(bashUse.input, { command: 'head -60 src/main.ts' });
    assert.ok(bashResult && bashResult.type === 'tool-result');
    assert.equal(bashResult.isError, false);
    assert.ok(psUse && psUse.type === 'tool-use');
    assert.equal(psUse.toolName, 'PowerShell');
    assert.ok(psResult && psResult.type === 'tool-result');
    assert.equal(psResult.isError, true, 'block.is_error is preserved for the monitor success gate');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

// ── /clear-rotation fixtures (validateClearSuccessor + EOF stale signal) ──
//
// validateClearSuccessor resolves base dirs via getWindowsProjectsDir() /
// getWslProjectsDir(); inject a tmp projects root by pinning the private cache
// fields. Use workingDirectory 'C:\\repo' → slug 'C--repo'.

const ROTATION_WORKDIR = 'C:\\repo';
const ROTATION_SLUG = 'C--repo';
// Mirror of the (un-exported) STALE_SIGNAL_REEMIT_MS constant in the source.
const STALE_SIGNAL_REEMIT_MS = 30_000;

function makeProjectsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
}

function makeRotationReader(root: string): ClaudeJsonlReader {
  const reader = new ClaudeJsonlReader();
  (reader as any).windowsProjectsDir = root;   // skip USERPROFILE lookup
  (reader as any).wslProjectsUncDir = null;     // pin WSL absent
  return reader;
}

/** Write `<root>/<slug>/<sessionId>.jsonl` with an explicit mtime (ms) so
 *  ordering is deterministic (don't rely on write order). Defaults to the
 *  ROTATION_SLUG; pass `slug` to place a file in a different project dir. */
function writeSlugFile(root: string, sessionId: string, lines: object[], mtimeMs: number, slug: string = ROTATION_SLUG): string {
  const slugDir = path.join(root, slug);
  fs.mkdirSync(slugDir, { recursive: true });
  const p = path.join(slugDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const secs = mtimeMs / 1000;
  fs.utimesSync(p, secs, secs);
  return p;
}

/** A valid /clear successor head bound to `sid`. */
function validClearHead(sid: string): object[] {
  return [
    { type: 'mode', parentUuid: null, sessionId: sid },
    { type: 'file-history-snapshot' },
    { type: 'user', isMeta: true, parentUuid: null, sessionId: sid, message: { content: '<local-command-caveat>caveat</local-command-caveat>' } },
    { type: 'user', parentUuid: null, sessionId: sid, message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } },
  ];
}

const BASE_MS = 1_700_000_000_000;

// ── Context Window Warning: per-role gauge cap in usage events ───────

function usageFixtureLine(model: string): object {
  return {
    type: 'assistant',
    uuid: 'u-1',
    timestamp: '2026-07-21T10:00:00.000Z',
    message: {
      model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 50_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  };
}

function pollUsage(model: string, role?: ChatLogReaderSession['role']): { contextWindowMax: number; contextPercentage: number } {
  const tmpPath = writeFixture([usageFixtureLine(model)]);
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession({ role }));
    const usage = events.find(e => e.type === 'usage');
    assert.ok(usage && usage.type === 'usage');
    return { contextWindowMax: usage.contextWindowMax, contextPercentage: usage.contextPercentage };
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

test('gauge cap: no resolver installed → historical 200K cap on a 1M model', () => {
  setContextGaugeCapResolver(null);
  const { contextWindowMax, contextPercentage } = pollUsage('claude-opus-4-7');
  assert.equal(contextWindowMax, 200_000);
  assert.equal(contextPercentage, 25);
});

test('gauge cap: per-role resolver raises the window for that role only', () => {
  setContextGaugeCapResolver((role) => (role === 'supervisor' ? 500_000 : 200_000));
  try {
    const sup = pollUsage('claude-opus-4-7', 'supervisor');
    assert.equal(sup.contextWindowMax, 500_000);
    assert.equal(sup.contextPercentage, 10);
    const worker = pollUsage('claude-opus-4-7', 'worker');
    assert.equal(worker.contextWindowMax, 200_000);
    assert.equal(worker.contextPercentage, 25);
  } finally {
    setContextGaugeCapResolver(null);
  }
});

test('gauge cap: never exceeds the model’s real window (min with model window)', () => {
  setContextGaugeCapResolver(() => 1_000_000);
  try {
    // claude-sonnet-4-5 → 200K real window; a 1M cap must not widen it.
    const r = pollUsage('claude-sonnet-4-5', 'worker');
    assert.equal(r.contextWindowMax, 200_000);
  } finally {
    setContextGaugeCapResolver(null);
  }
});

test('gauge cap: absent session role → default 200K even with a resolver installed', () => {
  setContextGaugeCapResolver((role) => (role ? 900_000 : 200_000));
  try {
    const r = pollUsage('claude-opus-4-7');
    assert.equal(r.contextWindowMax, 200_000);
  } finally {
    setContextGaugeCapResolver(null);
  }
});

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

// ── validateClearSuccessor (exact agent-bound candidate validation) ───
//
// The candidate session id is ALWAYS supplied (it comes from the hook). The
// reader never discovers a successor by scanning — it only validates the one
// candidate it's handed, in the SAME project dir as the current session file.

test('1: accepts a valid /clear successor candidate', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  writeSlugFile(root, 'clearA', validClearHead('clearA'), BASE_MS + 10_000);
  const reader = makeRotationReader(root);
  const startedAt = new Date(BASE_MS - 10_000).toISOString();
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'clearA', startedAt), true);
});

test('2: with two valid successors, validating clearA accepts clearA and never adopts the newer clearB', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  writeSlugFile(root, 'clearA', validClearHead('clearA'), BASE_MS + 10_000);
  writeSlugFile(root, 'clearB', validClearHead('clearB'), BASE_MS + 20_000); // newer
  const reader = makeRotationReader(root);
  // Each candidate is validated on its own merits — there is no "pick newest".
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'clearA'), true, 'clearA validates');
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'clearB'), true, 'clearB also validates on its own');
  // The function returns a boolean for the given candidate; it can NEVER
  // return clearB when asked about clearA (it returns true/false, not an id).
});

test('3: rejects a candidate whose head references a different sessionId (foreign head)', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  // Filename stem is 'foreign' but the head entries claim sessionId 'other'.
  writeSlugFile(root, 'foreign', validClearHead('other'), BASE_MS + 10_000);
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'foreign'), false);
});

test('4: rejects a candidate with /clear deep in the file but not in the head', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  // Fresh root in head (line 0), then >8 filler lines, then the /clear command
  // on line index 9 — beyond CLEAR_SUCCESSOR_HEAD_LINES (8) → not counted.
  const deep: object[] = [{ type: 'mode', parentUuid: null, sessionId: 'deep' }];
  for (let i = 0; i < 8; i++) deep.push({ type: 'user', sessionId: 'deep', message: { content: `noise ${i}` } });
  deep.push({ type: 'user', parentUuid: null, sessionId: 'deep', message: { content: '<command-name>/clear</command-name>' } });
  writeSlugFile(root, 'deep', deep, BASE_MS + 10_000);
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'deep'), false);
});

test('5: rejects a fork/resume root without the /clear command marker', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  writeSlugFile(root, 'fork', [
    { type: 'mode', parentUuid: null, sessionId: 'fork' },
    { type: 'file-history-snapshot' },
    { type: 'user', parentUuid: null, sessionId: 'fork', message: { content: 'continue the prior work' } },
  ], BASE_MS + 10_000);
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'fork'), false);
});

test('6: rejects a candidate older than the current file', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  writeSlugFile(root, 'oldclear', validClearHead('oldclear'), BASE_MS - 10_000);
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'oldclear'), false);
});

test('7: rejects a candidate newer than current but older than startedAt', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  writeSlugFile(root, 'midclear', validClearHead('midclear'), BASE_MS + 5_000);
  const reader = makeRotationReader(root);
  const startedAfter = new Date(BASE_MS + 8_000).toISOString();
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'midclear', startedAfter), false);
});

test('8: rejects a same-named valid candidate that lives in a DIFFERENT slug dir', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], BASE_MS);
  // A perfectly valid /clear file named 'clearX' exists — but only under a
  // different project slug. validateClearSuccessor only looks in the current
  // file's dir, so it must NOT be adopted.
  writeSlugFile(root, 'clearX', validClearHead('clearX'), BASE_MS + 10_000, 'C--other');
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'clearX'), false);
});

test('9: rejects when candidate equals the current session id', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'cur', validClearHead('cur'), BASE_MS);
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'cur'), false);
});

test('10: rejects when the current session file does not exist', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'clearA', validClearHead('clearA'), BASE_MS + 10_000);
  const reader = makeRotationReader(root);
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'missing-cur', 'clearA'), false);
});

// ── EOF stale signal (session-pinned drainStaleSignals) ──────────────

function eofSession(agentId: string, sessionId: string, subscribed: boolean): ChatLogReaderSession {
  return {
    agentId,
    sessionId,
    workingDirectory: ROTATION_WORKDIR,
    provider: 'claude',
    subscribed,
  };
}

test('11: EOF stale drain returns a session-pinned record (subscribed agent)', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'sess11', [{ type: 'system', uuid: 'sys11', model: 'm' }], BASE_MS);
  const reader = makeRotationReader(root);
  const session = eofSession('agent11', 'sess11', true);
  reader.pollSession(session); // consume
  reader.pollSession(session); // EOF streak 1
  reader.pollSession(session); // EOF streak 2
  reader.pollSession(session); // EOF streak 3 → record
  const drained = reader.drainStaleSignals();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].agentId, 'agent11');
  assert.equal(drained[0].staleSessionId, 'sess11', 'pinned to the tailed session id');
  assert.equal(drained[0].workingDirectory, ROTATION_WORKDIR);
  assert.equal(typeof drained[0].observedAt, 'number');
});

test('12: EOF stale drain fires for an unsubscribed agent too (Decision 1)', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'sess12', [{ type: 'system', uuid: 'sys12', model: 'm' }], BASE_MS);
  const reader = makeRotationReader(root);
  const session = eofSession('agent12', 'sess12', false);
  reader.pollSession(session); // consume
  reader.pollSession(session);
  reader.pollSession(session);
  reader.pollSession(session); // streak 3 → record
  const drained = reader.drainStaleSignals();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].agentId, 'agent12');
  assert.equal(drained[0].staleSessionId, 'sess12');
});

test('13: throttle suppresses re-add within the window, then re-fires after it lapses', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'sess13', [{ type: 'system', uuid: 'sys13', model: 'm' }], BASE_MS);
  const reader = makeRotationReader(root);
  const session = eofSession('agent13', 'sess13', false); // unsubscribed re-arms streak to 0
  reader.pollSession(session); // consume
  reader.pollSession(session);
  reader.pollSession(session);
  reader.pollSession(session); // streak 3 → record (first fire)
  assert.equal(reader.drainStaleSignals().length, 1);

  reader.pollSession(session);
  reader.pollSession(session);
  reader.pollSession(session); // streak 3 → throttled, no add
  assert.deepEqual(reader.drainStaleSignals(), [], 'throttled within window');

  (reader as any).lastStaleEmitAt.set('agent13', Date.now() - STALE_SIGNAL_REEMIT_MS - 1);
  reader.pollSession(session);
  reader.pollSession(session);
  reader.pollSession(session); // streak 3 → record again
  assert.equal(reader.drainStaleSignals().length, 1, 're-fires after window lapses');
});

test('14: invalidatePath clears the pending stale record and the throttle clock', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'sess14', [{ type: 'system', uuid: 'sys14', model: 'm' }], BASE_MS);
  const reader = makeRotationReader(root);
  const session = eofSession('agent14', 'sess14', false);
  reader.pollSession(session);
  reader.pollSession(session);
  reader.pollSession(session);
  reader.pollSession(session); // streak 3 → record pending
  assert.equal((reader as any).pendingStale.has('agent14'), true, 'pre-condition: pending record');

  reader.invalidatePath('agent14');
  assert.equal((reader as any).pendingStale.has('agent14'), false, 'pending stale record cleared');
  assert.equal((reader as any).lastStaleEmitAt.has('agent14'), false, 'throttle clock cleared');
  assert.deepEqual(reader.drainStaleSignals(), [], 'nothing left to drain');
});

test('15: subscribed re-resolution preserved — resolved-path cache dropped at streak 3', () => {
  const root = makeProjectsRoot();
  writeSlugFile(root, 'sess15', [{ type: 'system', uuid: 'sys15', model: 'm' }], BASE_MS);
  const reader = makeRotationReader(root);
  const session = eofSession('agent15', 'sess15', true);
  reader.pollSession(session); // consume → resolvedPaths populated
  assert.equal((reader as any).resolvedPaths.has('agent15'), true, 'resolved after consume');
  reader.pollSession(session); // EOF streak 1
  reader.pollSession(session); // EOF streak 2
  reader.pollSession(session); // EOF streak 3 → forgetResolvedPath (subscribed)
  assert.equal((reader as any).resolvedPaths.has('agent15'), false, 'resolved-path cache dropped');
});

test('tz: SQLite-form startedAt does not reject a successor created just after launch', () => {
  const root = makeProjectsRoot();
  // Correct UTC interpretation of the SQLite space-form launch time.
  const correctStartedMs = Date.UTC(2026, 5, 20, 9, 0, 0);
  const startedAtSqlite = '2026-06-20 09:00:00'; // UTC wall-clock, no zone marker

  // current session predates launch; candidate is 60s after the CORRECT launch.
  writeSlugFile(root, 'cur', [{ type: 'mode', parentUuid: null, sessionId: 'cur' }], correctStartedMs - 60_000);
  writeSlugFile(root, 'clearA', validClearHead('clearA'), correctStartedMs + 60_000);

  const reader = makeRotationReader(root);
  // Old code: Date.parse('2026-06-20 09:00:00') reads LOCAL; on a west-of-UTC
  // machine (e.g. the dev's UTC-7) startedAtMs inflates by the offset, pushing
  // the floor hours past the candidate's mtime -> wrongly returns false. With
  // parseSqliteUtcMs the floor is the true UTC instant and the candidate (+60s)
  // validates. On a UTC runner both parsers agree (test still passes).
  assert.equal(reader.validateClearSuccessor(ROTATION_WORKDIR, 'cur', 'clearA', startedAtSqlite), true);
});

// ── Phase 2: one-shot prior-session disk reader ──────────────────────
//
// readSessionEventsOnce is a PURE read: it must parse a prior session's JSONL
// straight from disk WITHOUT touching the per-agent dedup maps of any live
// agent that shares the same cwd/slug, and WITHOUT advancing tail offsets.

test('P2: readSessionEventsOnce parses a prior session from disk (located by slug)', () => {
  const root = makeProjectsRoot();
  const sid = 'prior-sess-1';
  writeSlugFile(root, sid, [
    { type: 'system', uuid: 's-0', timestamp: '2026-07-01T10:00:00.000Z', model: 'claude-opus' },
    { type: 'user', uuid: 'u-1', timestamp: '2026-07-01T10:00:01.000Z', message: { content: 'hello from the past' } },
    {
      type: 'assistant', uuid: 'a-1', timestamp: '2026-07-01T10:00:02.000Z',
      message: { model: 'claude-opus', stop_reason: 'end_turn', content: [{ type: 'text', text: 'a prior reply' }] },
    },
  ], BASE_MS);
  const reader = makeRotationReader(root);

  const events = reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  assert.ok(events, 'located + parsed');
  const kinds = events!.map(e => e.type);
  assert.ok(kinds.includes('user-text'), 'has the user turn');
  assert.ok(kinds.includes('assistant-text'), 'has the assistant turn');
  const user = events!.find(e => e.type === 'user-text') as any;
  assert.equal(user.text, 'hello from the past');
});

test('P2: readSessionEventsOnce returns null for a missing/pruned session', () => {
  const root = makeProjectsRoot();
  const reader = makeRotationReader(root);
  assert.equal(reader.readSessionEventsOnce(ROTATION_WORKDIR, 'never-written'), null);
});

test('P2: readSessionEventsOnce leaves NO residue in per-agent dedup maps (shared-cwd purity)', () => {
  const root = makeProjectsRoot();
  const sid = 'prior-sess-2';
  writeSlugFile(root, sid, [
    { type: 'system', uuid: 's-1', timestamp: '2026-07-01T10:00:00.000Z', model: 'claude-opus' },
    { type: 'user', uuid: 'u-9', timestamp: '2026-07-01T10:00:01.000Z', message: { content: 'past turn' } },
  ], BASE_MS);
  const reader = makeRotationReader(root);

  const before = (reader as any).seenEntryUuids.size;
  const beforeInit = (reader as any).emittedSystemInit.size;
  reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  // The ephemeral parse scope must be cleaned up: no live agent's dedup state
  // (seenEntryUuids / emittedSystemInit) is left behind.
  assert.equal((reader as any).seenEntryUuids.size, before, 'seenEntryUuids left clean');
  assert.equal((reader as any).emittedSystemInit.size, beforeInit, 'emittedSystemInit left clean');
});

test('P2: readSessionEventsOnce does not advance tail offsets (no subscription/offset cache)', () => {
  const root = makeProjectsRoot();
  const sid = 'prior-sess-3';
  writeSlugFile(root, sid, [
    { type: 'user', uuid: 'u-3', timestamp: '2026-07-01T10:00:01.000Z', message: { content: 'x' } },
  ], BASE_MS);
  const reader = makeRotationReader(root);

  reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  assert.equal((reader as any).fileOffsets.size, 0, 'no fileOffsets written');
  assert.equal((reader as any).partialLines.size, 0, 'no partialLines written');
});

// ── Fix 2: bounded session-log reads ─────────────────────────────────
//
// See docs/internal/SESSION_LOG_READ_FIX_PROPOSAL.md. 2a (seek-to-tail + chunk
// cap in pollSession), 2b (tail-bounded readSessionEventsOnce + preview cache),
// 2c (session-id-first resolution, never a wrong sibling in a shared slug dir).

const MAX_POLL_READ_BYTES = 4 * 1024 * 1024;   // mirror of the source constant
const OFFSET_CATCHUP_BYTES = 256 * 1024;        // mirror of the source constant
const MAX_TERMINAL_READ_BYTES = 2 * 1024 * 1024; // mirror of the source constant

function assistantLine(uuid: string, text: string): object {
  return {
    type: 'assistant', uuid, timestamp: '2026-07-25T00:00:00.000Z',
    message: { model: 'claude-opus', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  };
}

/** Write `head` lines, then ignorable filler until the file reaches ~`targetBytes`,
 *  then `tail` lines. Filler is valid JSON of an unknown type (emits no events),
 *  so any event in the parse came from head or tail — letting a test prove which
 *  region was actually read. Returns the path (caller unlinks). */
function writeSizedFixture(head: object[], targetBytes: number, tail: object[]): string {
  const tmpPath = path.join(os.tmpdir(), `claude-jsonl-big-${Date.now()}-${Math.random()}.jsonl`);
  const headText = head.map(l => JSON.stringify(l)).join('\n') + '\n';
  const tailText = tail.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(tmpPath, headText);
  const fillerLine = JSON.stringify({ type: 'filler', pad: 'x'.repeat(240) }) + '\n';
  const fillerBytes = Buffer.byteLength(fillerLine);
  const budget = targetBytes - Buffer.byteLength(headText) - Buffer.byteLength(tailText);
  const count = Math.max(0, Math.ceil(budget / fillerBytes));
  fs.appendFileSync(tmpPath, fillerLine.repeat(count));
  fs.appendFileSync(tmpPath, tailText);
  return tmpPath;
}

test('2a: lost/absent offset resumes at the tail — no from-zero replay of old history', () => {
  // File larger than the catch-up window with an OLD marker at byte 0 and a NEW
  // marker in the last window. A fresh poll (no stored offset) must surface only
  // NEW; the whole-file-from-zero read would have surfaced OLD too.
  const tmpPath = writeSizedFixture(
    [assistantLine('old-1', 'OLD_MARKER')],
    OFFSET_CATCHUP_BYTES * 2,
    [assistantLine('new-1', 'NEW_MARKER')],
  );
  try {
    const reader = makeReader(tmpPath);
    const events = reader.pollSession(makeSession());
    const texts = events.filter(e => e.type === 'assistant-text').map((e: any) => e.text);
    assert.ok(texts.includes('NEW_MARKER'), 'tail event surfaced');
    assert.ok(!texts.includes('OLD_MARKER'), 'byte-0 history NOT replayed');
    // Offset seeded near the tail, not 0.
    const off = (reader as any).fileOffsets.get(tmpPath);
    assert.ok(off >= fs.statSync(tmpPath).size - OFFSET_CATCHUP_BYTES, 'offset seeded at tail window');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('2a: invalidatePath then re-poll resumes at tail (rebind does not gulp history)', () => {
  const tmpPath = writeSizedFixture(
    [assistantLine('old-2', 'OLD_MARKER')],
    OFFSET_CATCHUP_BYTES * 2,
    [assistantLine('new-2', 'NEW_MARKER')],
  );
  try {
    const reader = makeReader(tmpPath);
    reader.pollSession(makeSession());        // initial tail bind
    reader.invalidatePath('test-agent');       // rebind / /clear / continuation
    // Re-seed resolvedPaths (invalidatePath dropped it) the way a live rebind
    // would re-resolve, then poll again.
    (reader as any).resolvedPaths.set('test-agent', tmpPath);
    const events = reader.pollSession(makeSession());
    const texts = events.filter(e => e.type === 'assistant-text').map((e: any) => e.text);
    assert.ok(!texts.includes('OLD_MARKER'), 'post-rebind poll does not re-read byte-0 history');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('2a: a single poll read is capped at MAX_POLL_READ_BYTES; catch-up spans ticks', () => {
  // A >4 MiB backlog with a stored offset of 0 (simulating a genuinely-behind
  // tailer). One poll advances by at most the cap, not to EOF.
  const tmpPath = writeSizedFixture(
    [assistantLine('h-1', 'HEAD')],
    MAX_POLL_READ_BYTES + 512 * 1024,
    [assistantLine('t-1', 'TAIL')],
  );
  try {
    const fileSize = fs.statSync(tmpPath).size;
    assert.ok(fileSize > MAX_POLL_READ_BYTES, 'precondition: backlog exceeds the cap');
    const reader = makeReader(tmpPath);
    (reader as any).fileOffsets.set(tmpPath, 0); // stored (not absent) → no tail-seek

    reader.pollSession(makeSession());
    const afterFirst = (reader as any).fileOffsets.get(tmpPath);
    assert.equal(afterFirst, MAX_POLL_READ_BYTES, 'first poll advanced by exactly the cap');
    assert.ok(afterFirst < fileSize, 'still behind after one poll');

    reader.pollSession(makeSession());
    const afterSecond = (reader as any).fileOffsets.get(tmpPath);
    assert.equal(afterSecond, fileSize, 'second poll consumed the remainder');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('2b: readSessionEventsOnce reads only the tail of a large prior session', () => {
  const root = makeProjectsRoot();
  const sid = 'big-prior';
  const slugDir = path.join(root, ROTATION_SLUG);
  fs.mkdirSync(slugDir, { recursive: true });
  const p = path.join(slugDir, `${sid}.jsonl`);
  // Build directly at this path so locateSessionFile finds it by slug.
  const built = writeSizedFixture(
    [assistantLine('old-b', 'OLD_MARKER')],
    MAX_TERMINAL_READ_BYTES + 512 * 1024,
    [assistantLine('new-b', 'NEW_MARKER')],
  );
  fs.copyFileSync(built, p);
  fs.unlinkSync(built);
  try {
    const reader = makeRotationReader(root);
    const events = reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
    assert.ok(events, 'located + parsed');
    const texts = events!.filter(e => e.type === 'assistant-text').map((e: any) => e.text);
    assert.ok(texts.includes('NEW_MARKER'), 'tail event present');
    assert.ok(!texts.includes('OLD_MARKER'), 'head beyond the tail window not read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('2b: preview cache hit — repeated read of a frozen file returns the cached parse, no re-parse', () => {
  const root = makeProjectsRoot();
  const sid = 'cached-prior';
  writeSlugFile(root, sid, [
    assistantLine('c-1', 'CACHED_REPLY'),
  ], BASE_MS);
  const reader = makeRotationReader(root);

  const first = reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  assert.ok(first && first.length > 0, 'first read parsed');
  const second = reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  // A re-parse would allocate a fresh array; identical reference proves the
  // (size,mtime) cache short-circuited the read + parse.
  assert.strictEqual(second, first, 'same (size,mtime) → cached array returned, not re-parsed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('2b: preview cache re-reads when the file grows (size/mtime signature changes)', () => {
  const root = makeProjectsRoot();
  const sid = 'growing-prior';
  const p = writeSlugFile(root, sid, [assistantLine('g-1', 'FIRST')], BASE_MS);
  const reader = makeRotationReader(root);

  const first = reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  assert.ok(first!.some((e: any) => e.type === 'assistant-text' && e.text === 'FIRST'));

  // Append a new turn and bump mtime so the (size,mtime) signature differs.
  fs.appendFileSync(p, JSON.stringify(assistantLine('g-2', 'SECOND')) + '\n');
  const bump = (BASE_MS + 60_000) / 1000;
  fs.utimesSync(p, bump, bump);

  const second = reader.readSessionEventsOnce(ROTATION_WORKDIR, sid);
  const texts = second!.filter(e => e.type === 'assistant-text').map((e: any) => e.text);
  assert.ok(texts.includes('SECOND'), 'grown content re-read, not served stale from cache');
  fs.rmSync(root, { recursive: true, force: true });
});

test('2c: fresh worker binds to its OWN session file, never a large sibling in the shared slug', () => {
  const root = makeProjectsRoot();
  const ownSid = 'own-fresh';
  const siblingSid = 'sibling-huge';
  // The shared slug dir holds the fresh worker's own (empty-ish) file AND a
  // large sibling belonging to another agent in the same cwd (shared-cwd
  // invariant). Resolution must pick the id-named own file.
  writeSlugFile(root, ownSid, [{ type: 'system', uuid: 'own-sys', model: 'm' }], BASE_MS);
  const built = writeSizedFixture(
    [assistantLine('sib-1', 'SIBLING_DATA')],
    MAX_TERMINAL_READ_BYTES + 256 * 1024,
    [assistantLine('sib-2', 'SIBLING_TAIL')],
  );
  const siblingPath = path.join(root, ROTATION_SLUG, `${siblingSid}.jsonl`);
  fs.copyFileSync(built, siblingPath);
  fs.unlinkSync(built);

  const reader = makeRotationReader(root);
  const events = reader.pollSession(eofSession('fresh-agent', ownSid, true));
  const resolved = (reader as any).resolvedPaths.get('fresh-agent') as string;
  assert.ok(resolved.endsWith(`${ownSid}.jsonl`), `bound own file, got ${resolved}`);
  // Its own file has only a system entry → no assistant text from the sibling.
  const texts = events.filter(e => e.type === 'assistant-text').map((e: any) => e.text);
  assert.ok(!texts.includes('SIBLING_DATA') && !texts.includes('SIBLING_TAIL'), 'no sibling content bled in');
  fs.rmSync(root, { recursive: true, force: true });
});

test('2c: an empty session id does not bind any file (no guess in a shared slug dir)', () => {
  const root = makeProjectsRoot();
  // A file exists in the slug dir, but the agent has no session id yet.
  writeSlugFile(root, 'someone-else', [assistantLine('x-1', 'NOT_MINE')], BASE_MS);
  const reader = makeRotationReader(root);
  const events = reader.pollSession(eofSession('idless-agent', '', true));
  assert.deepEqual(events, [], 'no id → no events');
  assert.equal((reader as any).resolvedPaths.has('idless-agent'), false, 'no path bound');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── WP-1a: cap grow-forever per-agent structures + invalidatePath cleanup ──
//
// The reader accretes per-agent dedup/location state (seenEntryUuids,
// toolResultLocations/toolResultOrder, emittedSystemInit) that previously grew
// forever and was never released on terminal. These caps bound it and
// invalidatePath (the only path forgetAgent reaches the reader by) clears it.

const SEEN_ENTRY_UUID_MAX = 6000;                 // mirror of the source constant
const TOOL_RESULT_LOCATIONS_MAX_PER_AGENT = 2000; // mirror of the source constant

/** Feed one entry through the (private) parseEntry with byte offsets. */
function feed(reader: ClaudeJsonlReader, session: ChatLogReaderSession, jsonlPath: string,
             entry: object, startOffset: number, endOffset: number): any[] {
  const out: any[] = [];
  (reader as any).parseEntry(session, jsonlPath, entry, startOffset, endOffset, out);
  return out;
}

function userEntry(uuid: string, text: string): object {
  return { type: 'user', uuid, message: { content: text } };
}

function toolResultEntry(uuid: string, toolUseId: string, content: string): object {
  return { type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } };
}

test('WP-1a: seenEntryUuids caps at 6,000 (newest retained, oldest evicted)', () => {
  const reader = new ClaudeJsonlReader();
  const session = makeSession();
  for (let n = 0; n < SEEN_ENTRY_UUID_MAX + 5; n++) {
    feed(reader, session, 'p.jsonl', userEntry(`u-${n}`, 'x'), 0, 1);
  }
  const seen = (reader as any).seenEntryUuids.get('test-agent') as Set<string>;
  assert.equal(seen.size, SEEN_ENTRY_UUID_MAX, 'capped at the max');
  assert.ok(!seen.has('u-0'), 'oldest UUID evicted');
  assert.ok(!seen.has('u-4'), 'the 5 oldest evicted');
  assert.ok(seen.has(`u-${SEEN_ENTRY_UUID_MAX + 4}`), 'newest UUID retained');
});

test('WP-1a: toolResultLocations per-agent cap ≤ 2,000; a second agent unaffected (per-agent, not global)', () => {
  const reader = new ClaudeJsonlReader();
  const a1 = makeSession({ agentId: 'agent-1' });
  const a2 = makeSession({ agentId: 'agent-2' });
  const over = TOOL_RESULT_LOCATIONS_MAX_PER_AGENT + 50;
  for (let n = 0; n < over; n++) {
    feed(reader, a1, 'p.jsonl', toolResultEntry(`a1-u-${n}`, `a1-tu-${n}`, 'r'), 0, 1);
  }
  // A handful for a second agent in the same reader.
  for (let n = 0; n < 5; n++) {
    feed(reader, a2, 'p.jsonl', toolResultEntry(`a2-u-${n}`, `a2-tu-${n}`, 'r'), 0, 1);
  }
  const order1 = (reader as any).toolResultOrder.get('agent-1') as Set<string>;
  const order2 = (reader as any).toolResultOrder.get('agent-2') as Set<string>;
  assert.equal(order1.size, TOOL_RESULT_LOCATIONS_MAX_PER_AGENT, 'agent-1 order capped');

  const locs = (reader as any).toolResultLocations as Map<string, unknown>;
  const a1Keys = [...locs.keys()].filter(k => k.startsWith('agent-1:'));
  const a2Keys = [...locs.keys()].filter(k => k.startsWith('agent-2:'));
  assert.equal(a1Keys.length, TOOL_RESULT_LOCATIONS_MAX_PER_AGENT, 'agent-1 locations capped');
  assert.equal(order2.size, 5, 'agent-2 order untouched by agent-1 eviction');
  assert.equal(a2Keys.length, 5, 'agent-2 locations untouched (per-agent, not global)');
  // The oldest agent-1 anchors are the ones evicted.
  assert.ok(!locs.has('agent-1:a1-tu-0'), 'oldest agent-1 anchor evicted');
  assert.ok(locs.has(`agent-1:a1-tu-${over - 1}`), 'newest agent-1 anchor retained');
});

test('WP-1a: anchor recency refresh keeps the live value retrievable through eviction', async () => {
  const cap = TOOL_RESULT_LOCATIONS_MAX_PER_AGENT;
  // Write a real one-line fixture for the KEPT anchor so getFullToolResult can
  // read it back from disk at offsets [0, lineBytes).
  const keepLine = JSON.stringify(toolResultEntry('keep-u', 'tu-KEEP', 'KEPT_RESULT'));
  const tmpPath = path.join(os.tmpdir(), `claude-jsonl-refresh-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(tmpPath, keepLine + '\n');
  const keepBytes = Buffer.byteLength(keepLine, 'utf-8');
  try {
    const reader = new ClaudeJsonlReader();
    const session = makeSession();
    const keepEntry = JSON.parse(keepLine);

    // 1) Insert KEEP (oldest), then cap-1 fillers → order full, KEEP is oldest.
    feed(reader, session, tmpPath, { ...keepEntry, uuid: 'keep-0' }, 0, keepBytes);
    for (let n = 0; n < cap - 1; n++) {
      feed(reader, session, 'other.jsonl', toolResultEntry(`f1-u-${n}`, `f1-tu-${n}`, 'r'), 0, 1);
    }
    // 2) Refresh KEEP with a fresh entry uuid (same tool_use_id) → moves it to newest.
    feed(reader, session, tmpPath, { ...keepEntry, uuid: 'keep-1' }, 0, keepBytes);
    // 3) Push cap-1 more distinct fillers → evicts the pre-refresh fillers, not KEEP.
    for (let n = 0; n < cap - 1; n++) {
      feed(reader, session, 'other.jsonl', toolResultEntry(`f2-u-${n}`, `f2-tu-${n}`, 'r'), 0, 1);
    }

    const locs = (reader as any).toolResultLocations as Map<string, unknown>;
    assert.ok(locs.has('test-agent:tu-KEEP'), 'refreshed anchor survived eviction');
    const result = await reader.getFullToolResult('test-agent', 'tu-KEEP');
    assert.equal(result, 'KEPT_RESULT', 'live value still retrievable (no premature deletion)');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('WP-1a: rebind correctness — after invalidatePath a reused UUID is emitted again (not suppressed)', () => {
  const reader = new ClaudeJsonlReader();
  const session = makeSession();
  const first = feed(reader, session, 'p.jsonl', userEntry('dup', 'hello'), 0, 1);
  assert.equal(first.filter(e => e.type === 'user-text').length, 1, 'first emit');
  const again = feed(reader, session, 'p.jsonl', userEntry('dup', 'hello'), 0, 1);
  assert.equal(again.length, 0, 'same UUID suppressed within the window');

  reader.invalidatePath('test-agent');
  const afterRebind = feed(reader, session, 'p.jsonl', userEntry('dup', 'hello'), 0, 1);
  assert.equal(afterRebind.filter(e => e.type === 'user-text').length, 1,
    'reused UUID re-emitted after invalidatePath (rebound rollout not UUID-suppressed)');
});

test('WP-1a: terminal release — invalidatePath empties every agent-owned map (assert private maps directly)', () => {
  const reader = new ClaudeJsonlReader();
  const session = makeSession();
  feed(reader, session, 'p.jsonl', { type: 'system', uuid: 's-0', model: 'm' }, 0, 1);
  feed(reader, session, 'p.jsonl', toolResultEntry('u-0', 'tu-0', 'r'), 0, 1);
  feed(reader, session, 'p.jsonl', userEntry('u-1', 'hi'), 0, 1);

  // Pre-condition: every agent-owned map carries this agent (read the raw stores,
  // WB-20 — no allocating accessor manufactures the state).
  assert.ok((reader as any).seenEntryUuids.has('test-agent'), 'pre: seenEntryUuids');
  assert.ok((reader as any).emittedSystemInit.has('test-agent'), 'pre: emittedSystemInit');
  assert.ok((reader as any).toolResultOrder.has('test-agent'), 'pre: toolResultOrder');
  assert.ok([...(reader as any).toolResultLocations.keys()].some((k: string) => k.startsWith('test-agent:')),
    'pre: toolResultLocations');

  reader.invalidatePath('test-agent');

  assert.equal((reader as any).seenEntryUuids.has('test-agent'), false, 'seenEntryUuids cleared');
  assert.equal((reader as any).emittedSystemInit.has('test-agent'), false, 'emittedSystemInit cleared');
  assert.equal((reader as any).toolResultOrder.has('test-agent'), false, 'toolResultOrder cleared');
  assert.equal([...(reader as any).toolResultLocations.keys()].filter((k: string) => k.startsWith('test-agent:')).length, 0,
    'agent-prefixed toolResultLocations cleared');
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
