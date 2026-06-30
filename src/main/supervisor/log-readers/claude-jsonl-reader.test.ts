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
