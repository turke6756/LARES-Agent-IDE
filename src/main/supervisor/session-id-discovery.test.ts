// Self-contained smoke tests for Codex session discovery.
//
// Compile via:
//   npm run build:main
//   node dist/main/main/supervisor/session-id-discovery.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverNewCodexSession,
  ensureCodexResumeSessionId,
  findCodexSessionIdByCwd,
  shouldDiscoverCodexSession,
  type CodexSessionSnapshot,
  type CodexStateDb,
  type CodexStateDbOpener,
} from './session-id-discovery';
import type { CodexRolloutFile, CodexSessionHome } from './log-readers/codex-rollout-reader';
import { serialLeadPrompt, serialReviewerKickoff } from '../orchestration/groupthink-v2-prompts';

// WP3: mirror groupthink-v2's kickoffPrefix so these tests lock the exact
// template↔discovery contract (CRLF→LF, cap 512, no trim/first-line cut).
function kickoffPrefix(s: string): string {
  return s.replace(/\r\n/g, '\n').slice(0, 512);
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

const SESSION_ID = '33333333-4444-5555-6666-777777777777';
const OTHER_ID = '44444444-5555-6666-7777-888888888888';

function makeRollout(root: string, sessionId: string, cwd: string, metaId = sessionId): CodexRolloutFile {
  const dir = path.join(root, '2026', '05', '02');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `rollout-2026-05-02T12-00-00-${sessionId}.jsonl`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify({
    timestamp: '2026-05-02T12:00:00.000Z',
    type: 'session_meta',
    payload: { id: metaId, cwd, model_provider: 'openai', cli_version: '0.128.0' },
  }) + '\n');
  return {
    path: filePath,
    filename,
    sessionId,
    home: 'windows',
    mtimeMs: fs.statSync(filePath).mtimeMs,
  };
}

function snapshot(home: CodexSessionHome, files: CodexRolloutFile[] = []): CodexSessionSnapshot {
  return { home, paths: new Set(files.map((f) => f.path)) };
}

test('discovers only new rollout matching cwd and filename/meta id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-good-'));
  try {
    const oldFile = makeRollout(root, OTHER_ID, 'C:\\Users\\fixture');
    const before = snapshot('windows', [oldFile]);
    const launchTime = Date.now() - 1;
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: launchTime,
      timeoutMs: 700,
      listFiles: () => [oldFile, newFile],
    });
    assert.ok(result, 'expected discovery result');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.path, newFile.path);
    assert.equal(result.cwd, 'C:\\Users\\fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects concurrent new rollout with mismatched cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-cwd-'));
  try {
    const before = snapshot('windows');
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Other\\Repo');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Date.now() - 1,
      timeoutMs: 700,
      listFiles: () => [newFile],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects filename/session_meta id mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-id-'));
  try {
    const before = snapshot('windows');
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture', OTHER_ID);
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Date.now() - 1,
      timeoutMs: 700,
      listFiles: () => [newFile],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findCodexSessionIdByCwd picks newest cwd-match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recover-good-'));
  try {
    const older = makeRollout(root, OTHER_ID, 'C:\\Users\\fixture');
    // Force a distinct, newer mtime even if the second file lands within the
    // same FS tick as the first.
    const newer = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture');
    fs.utimesSync(newer.path, new Date(), new Date(older.mtimeMs + 1_000));
    newer.mtimeMs = fs.statSync(newer.path).mtimeMs;
    const result = findCodexSessionIdByCwd({
      home: 'windows',
      workingDirectory: 'C:\\Users\\fixture',
      listFiles: () => [older, newer],
    });
    assert.ok(result, 'expected recovery result');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.path, newer.path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findCodexSessionIdByCwd returns null when no cwd matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recover-nomatch-'));
  try {
    const file = makeRollout(root, SESSION_ID, 'C:\\Other\\Repo');
    const result = findCodexSessionIdByCwd({
      home: 'windows',
      workingDirectory: 'C:\\Users\\fixture',
      listFiles: () => [file],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findCodexSessionIdByCwd rejects filename/meta id mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recover-id-'));
  try {
    const file = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture', OTHER_ID);
    const result = findCodexSessionIdByCwd({
      home: 'windows',
      workingDirectory: 'C:\\Users\\fixture',
      listFiles: () => [file],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureCodexResumeSessionId returns persisted sid without invoking fallback', () => {
  let recoverCalls = 0;
  const result = ensureCodexResumeSessionId({
    current: SESSION_ID,
    recover: () => {
      recoverCalls += 1;
      return OTHER_ID;
    },
  });
  assert.equal(result, SESSION_ID);
  assert.equal(recoverCalls, 0, 'recovery must not run when sid already persisted');
});

test('ensureCodexResumeSessionId fires fallback when sid is null and returns recovered id', () => {
  let recoverCalls = 0;
  const result = ensureCodexResumeSessionId({
    current: null,
    recover: () => {
      recoverCalls += 1;
      return SESSION_ID;
    },
  });
  assert.equal(result, SESSION_ID);
  assert.equal(recoverCalls, 1, 'recovery must run exactly once when sid is null');
});

test('ensureCodexResumeSessionId fires fallback when sid is empty string', () => {
  // BUG-04 nuance: gotcha #5 notes codex chat events arrive with sessionId: ""
  // before the persisted record is healed. An empty string must also trigger
  // recovery, not be treated as a valid sid.
  let recoverCalls = 0;
  const result = ensureCodexResumeSessionId({
    current: '',
    recover: () => {
      recoverCalls += 1;
      return SESSION_ID;
    },
  });
  assert.equal(result, SESSION_ID);
  assert.equal(recoverCalls, 1);
});

test('ensureCodexResumeSessionId returns null when both persistence and recovery fail', () => {
  // The hard-error path: discovery missed AND no cwd-matching rollout on disk.
  // Callers (launchWindowsAgent / launchWslAgent) translate this into the
  // "Cannot resume … no cwd-matching rollout found" exception.
  const result = ensureCodexResumeSessionId({
    current: null,
    recover: () => null,
  });
  assert.equal(result, null);
});

// BUG-08 / BUG-26: shouldDiscoverCodexSession gates the post-launch session-id
// discovery poll. Discovery runs on every non-resume codex launch, including
// freshSession=true. The pre-BUG-26 skip-on-freshSession behavior left
// resumeSessionId null and forced CodexRolloutReader to fall back to
// cwd-as-identity proxy — mis-attributing events under concurrent same-cwd
// launches. The race-resistant SQLite path (cwd + created_at + prompt prefix)
// is correct for fresh launches too.

test('shouldDiscoverCodexSession: codex fresh launch with no flag → discover (default unchanged)', () => {
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: false }),
    true,
    'default behavior (no freshSession) must continue to run discovery'
  );
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: false, freshSession: false }),
    true,
    'explicit freshSession=false is identical to default'
  );
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: false, freshSession: undefined }),
    true,
    'explicit freshSession=undefined is identical to default'
  );
});

test('shouldDiscoverCodexSession: BUG-26 — freshSession=true STILL runs discovery', () => {
  // Pre-BUG-26 expectation (inverted): freshSession=true used to skip
  // discovery, which left resumeSessionId null and forced the reader to
  // mis-attribute by cwd. Post-fix, discovery runs and binds the
  // codex-minted session id via the SQLite path's prompt-prefix tiebreaker.
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: false, freshSession: true }),
    true,
    'BUG-26: freshSession=true must NOT skip discovery — the SQLite path is race-resistant'
  );
});

test('shouldDiscoverCodexSession: resume=true never discovers (codex resume uses explicit sid)', () => {
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: true }),
    false
  );
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: true, freshSession: true }),
    false,
    'freshSession is ignored when resume=true — resume path uses an explicit sid already'
  );
});

test('shouldDiscoverCodexSession: non-codex providers never discover regardless of flags', () => {
  for (const provider of ['claude', 'gemini']) {
    assert.equal(
      shouldDiscoverCodexSession({ provider, resume: false }),
      false,
      `${provider} must not trigger codex discovery on fresh launch`
    );
    assert.equal(
      shouldDiscoverCodexSession({ provider, resume: false, freshSession: true }),
      false,
      `${provider} with freshSession=true is a no-op (codex-only flag)`
    );
    assert.equal(
      shouldDiscoverCodexSession({ provider, resume: true }),
      false
    );
  }
});

test('rejects files older than launch start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-time-'));
  try {
    const before = snapshot('windows');
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: newFile.mtimeMs + 10_000,
      timeoutMs: 700,
      listFiles: () => [newFile],
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== T1-C: state_5.sqlite-based discovery =====

interface FakeThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  created_at: number;
  first_user_message: string;
  cli_version?: string | null;
}

interface FakeQuery {
  sql: string;
  params: unknown[];
}

function makeFakeDb(rows: FakeThreadRow[], opts: {
  failOpen?: 'cantopen' | 'other';
  failPrepare?: 'no-such-column' | 'no-such-table' | 'other';
  capture?: FakeQuery[];
} = {}): { opener: CodexStateDbOpener; closed: { count: number } } {
  const closed = { count: 0 };
  const opener: CodexStateDbOpener = () => {
    if (opts.failOpen === 'cantopen') {
      const e: any = new Error('unable to open database file');
      e.code = 'SQLITE_CANTOPEN';
      throw e;
    }
    if (opts.failOpen === 'other') {
      throw new Error('disk I/O error');
    }
    const db: CodexStateDb = {
      prepare(sql: string) {
        if (opts.failPrepare === 'no-such-column') throw new Error('no such column: first_user_message');
        if (opts.failPrepare === 'no-such-table') throw new Error('no such table: threads');
        if (opts.failPrepare === 'other') throw new Error('database is locked');
        return {
          get(...params: unknown[]) {
            if (opts.capture) opts.capture.push({ sql, params });
            // Mimic the production query semantics on the in-memory rows.
            // WP3: the prompt prefix is now bound TWICE (substr length + equality),
            // so the query passes FOUR params. Both prefix binds are identical.
            const [cwdLike, afterSec, prefixForLength, prefixForEquality] =
              params as [string, number, string, string];
            const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
            // substr(first_user_message, 1, length(prefix)) = prefix is exact
            // starts-with — no wildcard interpretation of the prefix.
            const candidates = rows
              .filter((r) => norm(r.cwd).includes(cwdLike))
              .filter((r) => r.created_at >= afterSec)
              .filter((r) => r.first_user_message.substr(0, prefixForLength.length) === prefixForEquality)
              .sort((a, b) => a.created_at - b.created_at);
            if (!candidates.length) return undefined;
            const r = candidates[0];
            return {
              id: r.id,
              rollout_path: r.rollout_path,
              cwd: r.cwd,
              cli_version: r.cli_version ?? null,
            };
          },
        };
      },
      close() { closed.count += 1; },
    };
    return db;
  };
  return { opener, closed };
}

test('T1-C: SQL hit returns DiscoveryResult derived from threads row', async () => {
  const warnings: string[] = [];
  const { opener, closed } = makeFakeDb([{
    id: '019e55c0-661a-7983-a9d7-13e5565a89c3',
    rollout_path: 'C:\\Users\\turke\\.codex\\sessions\\2026\\05\\23\\rollout-...-019e55c0-661a-7983-a9d7-13e5565a89c3.jsonl',
    cwd: '\\\\?\\C:\\Users\\turke\\Projects\\Fixture',
    created_at: 1_779_000_000,
    first_user_message: 'Spell agent backwards. Reply with one word.',
    cli_version: '0.133.0',
  }]);
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\turke\\Projects\\Fixture',
    launchedAfterMs: 1_779_000_000 * 1000 - 5000,
    firstUserMessagePrefix: 'Spell agent backwards',
    openSqliteDb: opener,
    timeoutMs: 700,
    warn: (m) => warnings.push(m),
  });
  assert.ok(result, 'expected SQL hit');
  assert.equal(result.sessionId, '019e55c0-661a-7983-a9d7-13e5565a89c3');
  assert.equal(result.cliVersion, '0.133.0');
  assert.equal(result.filename, 'rollout-...-019e55c0-661a-7983-a9d7-13e5565a89c3.jsonl');
  assert.equal(result.cwd.includes('Fixture'), true);
  assert.equal(closed.count, 1, 'opener must close db after the query');
  assert.equal(warnings.length, 0, 'hit path must not warn');
});

test('T1-C: SQL miss falls back to filesystem AND emits warn(empty-result)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-t1c-fallback-'));
  try {
    const warnings: string[] = [];
    const { opener } = makeFakeDb([]); // empty DB -> miss
    const before = snapshot('windows');
    // BUG-26: fallback now also validates `firstUserMessagePrefix` when one
    // is supplied — so this test doesn't supply one. With no prefix the
    // fallback is back-compat cwd-only and the empty-result warning still
    // fires, which is what the test is actually asserting.
    const newFile = makeRollout(root, SESSION_ID, 'C:\\Users\\fixture');
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: newFile.mtimeMs - 1,
      openSqliteDb: opener,
      timeoutMs: 700,
      listFiles: () => [newFile],
      warn: (m) => warnings.push(m),
    });
    assert.ok(result, 'fallback must recover via filesystem snapshot');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(warnings.length, 1, 'one warning must be emitted on fallback');
    assert.match(warnings[0], /state\.sqlite discovery fell back to file poll/);
    assert.match(warnings[0], /reason: empty-result/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T1-C: schema-mismatch warns with schema-mismatch reason', async () => {
  const warnings: string[] = [];
  const { opener } = makeFakeDb([], { failPrepare: 'no-such-column' });
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: Date.now() - 1000,
    firstUserMessagePrefix: '',
    openSqliteDb: opener,
    timeoutMs: 400,
    listFiles: () => [],
    warn: (m) => warnings.push(m),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reason: schema-mismatch/);
});

test('T1-C: open failure (SQLITE_CANTOPEN) warns with sqlite-error reason', async () => {
  const warnings: string[] = [];
  const { opener } = makeFakeDb([], { failOpen: 'cantopen' });
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: Date.now() - 1000,
    firstUserMessagePrefix: '',
    openSqliteDb: opener,
    timeoutMs: 400,
    listFiles: () => [],
    warn: (m) => warnings.push(m),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reason: sqlite-error/);
});

test('T1-C: cwd LIKE matches Windows \\\\?\\ prefix + mixed slashes + drive-letter case', async () => {
  const captured: FakeQuery[] = [];
  const rows: FakeThreadRow[] = [{
    id: 'sid-abc',
    rollout_path: '/some/path.jsonl',
    cwd: '\\\\?\\C:\\Users\\turke\\Projects\\AgentDashboard',
    created_at: 1_000_000,
    first_user_message: '',
  }];
  const { opener } = makeFakeDb(rows, { capture: captured });
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\turke\\Projects\\AgentDashboard',
    launchedAfterMs: 999_000 * 1000,
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(result, 'should match even with \\\\?\\ prefix on the DB side');
  assert.equal(result.sessionId, 'sid-abc');
  assert.ok(captured.length >= 1, 'query must have been issued');
  const params = captured[0].params;
  // Param 0 is the normalized cwd substring; lowercased + forward-slashed.
  assert.equal(typeof params[0], 'string');
  assert.equal((params[0] as string).includes('agentdashboard'), true);
  assert.equal((params[0] as string).includes('\\'), false, 'no backslashes in the LIKE param');
  // Param 1 is created_at in SECONDS (not ms).
  assert.equal(typeof params[1], 'number');
  assert.ok((params[1] as number) < 2_000_000_000, 'created_at param must be in seconds');
});

test('T1-C: empty firstUserMessagePrefix matches all (no-op tiebreaker)', async () => {
  const rows: FakeThreadRow[] = [{
    id: 'sid-empty-prefix',
    rollout_path: '/a/b.jsonl',
    cwd: 'C:\\Users\\fixture',
    created_at: 1_000_000,
    first_user_message: '',
  }];
  const { opener } = makeFakeDb(rows);
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 0,
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(result);
  assert.equal(result.sessionId, 'sid-empty-prefix');
});

test('T1-C: prompt prefix disambiguates concurrent same-cwd threads', async () => {
  const rows: FakeThreadRow[] = [
    {
      id: 'sid-A',
      rollout_path: '/a.jsonl',
      cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000,
      first_user_message: 'What is the capital of France?',
    },
    {
      id: 'sid-B',
      rollout_path: '/b.jsonl',
      cwd: 'C:\\Users\\fixture',
      created_at: 1_000_001,
      first_user_message: 'Name a primary color.',
    },
  ];
  const { opener } = makeFakeDb(rows);
  const resultB = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: 'Name a primary',
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(resultB);
  assert.equal(resultB.sessionId, 'sid-B', 'prompt prefix must select sid-B over sid-A');
});

// BUG-26 / Risk 3: when SQL returns more than one row matching
// cwd+prefix+window, discovery must DECLINE to bind rather than picking the
// older row silently (pre-BUG-26 LIMIT 1 behavior). A new opener that
// returns multi-row results from `.all(...)` exercises the new ambiguity
// path; the helper above only returns one row from `.get(...)` so we build
// a tiny multi-row opener inline.
function makeMultiRowDb(rows: FakeThreadRow[]): CodexStateDbOpener {
  return () => ({
    prepare(_sql: string) {
      return {
        get(): unknown {
          return rows[0] ? {
            id: rows[0].id,
            rollout_path: rows[0].rollout_path,
            cwd: rows[0].cwd,
            cli_version: rows[0].cli_version ?? null,
          } : undefined;
        },
        all(...params: unknown[]): unknown[] {
          // WP3: FOUR params — prefix bound twice (substr length + equality).
          const [cwdLike, afterSec, prefixForLength, prefixForEquality] =
            params as [string, number, string, string];
          const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
          return rows
            .filter((r) => norm(r.cwd).includes(cwdLike))
            .filter((r) => r.created_at >= afterSec)
            .filter((r) => r.first_user_message.substr(0, prefixForLength.length) === prefixForEquality)
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, 2)
            .map((r) => ({
              id: r.id,
              rollout_path: r.rollout_path,
              cwd: r.cwd,
              cli_version: r.cli_version ?? null,
            }));
        },
      };
    },
    close() {},
  } as CodexStateDb);
}

test('BUG-26: concurrent same-cwd + same-prefix rows → discovery DECLINES (no silent older-wins)', async () => {
  const warnings: string[] = [];
  const rows: FakeThreadRow[] = [
    {
      id: 'sid-OLDER',
      rollout_path: '/older.jsonl',
      cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000,
      first_user_message: 'Spell agent backwards.',
    },
    {
      id: 'sid-NEWER',
      rollout_path: '/newer.jsonl',
      cwd: 'C:\\Users\\fixture',
      created_at: 1_000_001,
      first_user_message: 'Spell agent backwards.',
    },
  ];
  const opener = makeMultiRowDb(rows);
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: 'Spell agent',
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: (m) => warnings.push(m),
  });
  assert.equal(result, null, 'two ambiguous rows must return null instead of picking sid-OLDER');
  assert.ok(warnings.length >= 1, 'ambiguity must emit a warning');
  assert.ok(
    warnings.some((w) => /declined.*ambiguous/i.test(w)),
    `expected a "declined ... ambiguous" warning, got: ${JSON.stringify(warnings)}`
  );
});

test('BUG-26: concurrent same-cwd + distinct prefixes → SQL still binds the matching row', async () => {
  // Sanity counterpoint to the ambiguity test: when prefixes differ, the
  // SQL filter narrows to one row and discovery proceeds normally.
  const rows: FakeThreadRow[] = [
    {
      id: 'sid-A',
      rollout_path: '/a.jsonl',
      cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000,
      first_user_message: 'Spell agent backwards.',
    },
    {
      id: 'sid-B',
      rollout_path: '/b.jsonl',
      cwd: 'C:\\Users\\fixture',
      created_at: 1_000_001,
      first_user_message: 'Name a primary color.',
    },
  ];
  const opener = makeMultiRowDb(rows);
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: 'Name a primary',
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(result);
  assert.equal(result.sessionId, 'sid-B');
});

// BUG-26 / Risk 1: filesystem fallback must validate firstUserMessagePrefix
// when one is supplied. Pre-fix the fallback only checked cwd, which on the
// happy SQLite-miss path could pick a stale-mtime rollout that legitimately
// shared the cwd but was not the launched agent's.
function writeRolloutWithFirstMsg(
  dir: string,
  sessionId: string,
  cwd: string,
  firstUserMessage: string
): CodexRolloutFile {
  const dayDir = path.join(dir, '2026', '05', '02');
  fs.mkdirSync(dayDir, { recursive: true });
  const filename = `rollout-2026-05-02T12-00-00-${sessionId}.jsonl`;
  const filePath = path.join(dayDir, filename);
  const lines = [
    JSON.stringify({
      timestamp: '2026-05-02T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd, model_provider: 'openai', cli_version: '0.128.0' },
    }),
    JSON.stringify({
      timestamp: '2026-05-02T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: firstUserMessage },
    }),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return {
    path: filePath,
    filename,
    sessionId,
    home: 'windows',
    mtimeMs: fs.statSync(filePath).mtimeMs,
  };
}

test('BUG-26: filesystem fallback validates firstUserMessagePrefix (rejects cwd-only match)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fs-prefix-'));
  try {
    const warnings: string[] = [];
    const { opener } = makeFakeDb([]); // SQL miss → fallback
    const before = snapshot('windows');
    // Candidate matches cwd but its first user_message does NOT start with
    // the launch prefix — fallback must skip it.
    const wrongPrefix = writeRolloutWithFirstMsg(
      root,
      OTHER_ID,
      'C:\\Users\\fixture',
      'this is some other launch entirely'
    );
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: wrongPrefix.mtimeMs - 1,
      firstUserMessagePrefix: 'Spell agent',
      openSqliteDb: opener,
      timeoutMs: 400,
      listFiles: () => [wrongPrefix],
      warn: (m) => warnings.push(m),
    });
    assert.equal(result, null, 'filesystem fallback must reject prefix mismatch');
    assert.ok(warnings.some((w) => /fell back/.test(w)), 'fallback warning still emitted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-26: filesystem fallback accepts matching cwd + matching prefix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fs-prefix-ok-'));
  try {
    const { opener } = makeFakeDb([]); // SQL miss → fallback
    const before = snapshot('windows');
    const good = writeRolloutWithFirstMsg(
      root,
      SESSION_ID,
      'C:\\Users\\fixture',
      'Spell agent backwards. Reply one word.'
    );
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: good.mtimeMs - 1,
      firstUserMessagePrefix: 'Spell agent',
      openSqliteDb: opener,
      timeoutMs: 400,
      listFiles: () => [good],
      warn: () => {},
    });
    assert.ok(result, 'matching cwd + matching prefix must bind');
    assert.equal(result.sessionId, SESSION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-26 fail-loud-empty: empty prefix + multiple cwd-matching candidates → null + warn', async () => {
  // Pre-fix: walked candidates oldest-first, returned the first cwd-match —
  // silently picking one of N concurrent same-cwd launches and mis-attributing
  // events. Post-fix: refuses to guess when more than one candidate satisfies
  // (cwd-only validation because no prefix narrows the field). Emits a warn
  // so live runs surface the decline rather than dropping silently.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fs-multi-noprefix-'));
  try {
    const warnings: string[] = [];
    const { opener } = makeFakeDb([]); // SQL miss → fallback
    const before = snapshot('windows');
    const candA = writeRolloutWithFirstMsg(
      root,
      SESSION_ID,
      'C:\\Users\\fixture',
      'first concurrent launch'
    );
    const candB = writeRolloutWithFirstMsg(
      root,
      OTHER_ID,
      'C:\\Users\\fixture',
      'second concurrent launch'
    );
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Math.min(candA.mtimeMs, candB.mtimeMs) - 1,
      // No firstUserMessagePrefix — two cwd-matching candidates with nothing
      // to disambiguate. Default codex-launch case (prompt arrives via POST
      // /input post-launch). Must NOT silently pick one.
      openSqliteDb: opener,
      timeoutMs: 400,
      listFiles: () => [candA, candB],
      warn: (m) => warnings.push(m),
    });
    assert.equal(result, null, 'two ambiguous cwd-matches must return null instead of guessing');
    assert.ok(
      warnings.some((w) => /filesystem fallback declined/i.test(w)),
      `expected fail-loud-empty warning, got: ${JSON.stringify(warnings)}`
    );
    assert.ok(
      warnings.some((w) => /no prefix to disambiguate/i.test(w)),
      `expected reason to mention missing prefix, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-26 fail-loud-empty: non-empty prefix matching exactly one candidate → that one binds', async () => {
  // Counterpoint to the ambiguity test: when the launch-prompt prefix narrows
  // a multi-candidate field to exactly one match, that match binds. The
  // fail-loud rule only fires when no signal can disambiguate.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fs-prefix-one-'));
  try {
    const { opener } = makeFakeDb([]); // SQL miss → fallback
    const before = snapshot('windows');
    const a = writeRolloutWithFirstMsg(
      root,
      SESSION_ID,
      'C:\\Users\\fixture',
      'Spell agent backwards. Reply one word.'
    );
    const b = writeRolloutWithFirstMsg(
      root,
      OTHER_ID,
      'C:\\Users\\fixture',
      'Name a primary color.'
    );
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Math.min(a.mtimeMs, b.mtimeMs) - 1,
      firstUserMessagePrefix: 'Spell agent',
      openSqliteDb: opener,
      timeoutMs: 400,
      listFiles: () => [a, b],
      warn: () => {},
    });
    assert.ok(result, 'unambiguous prefix match must bind even with multiple cwd-matches');
    assert.equal(result.sessionId, SESSION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-26 fail-loud-empty: non-empty prefix matching NO candidate → null (do not fall through to cwd-only)', async () => {
  // Pre-fix: when a prefix was supplied but no rollout matched it, the loop
  // simply skipped them — and the next call after exhaustion returned null,
  // which happens to be correct. Post-fix the behavior is the same by design:
  // an explicit prefix means we have a launch-identity signal and refuse to
  // bind to anything that doesn't carry it. This test pins that invariant so
  // a future refactor doesn't reintroduce cwd-only fallback under a non-empty
  // prefix.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fs-prefix-none-'));
  try {
    const { opener } = makeFakeDb([]);
    const before = snapshot('windows');
    const a = writeRolloutWithFirstMsg(
      root,
      SESSION_ID,
      'C:\\Users\\fixture',
      'Something else entirely.'
    );
    const b = writeRolloutWithFirstMsg(
      root,
      OTHER_ID,
      'C:\\Users\\fixture',
      'A different unrelated prompt.'
    );
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: Math.min(a.mtimeMs, b.mtimeMs) - 1,
      firstUserMessagePrefix: 'Spell agent',
      openSqliteDb: opener,
      timeoutMs: 400,
      listFiles: () => [a, b],
      warn: () => {},
    });
    assert.equal(result, null, 'prefix supplied but no candidate matches → null');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-26: filesystem fallback with NO prefix supplied falls back to cwd-only (back-compat)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fs-noprefix-'));
  try {
    const { opener } = makeFakeDb([]);
    const before = snapshot('windows');
    const good = writeRolloutWithFirstMsg(
      root,
      SESSION_ID,
      'C:\\Users\\fixture',
      'anything goes when no prefix is supplied'
    );
    const result = await discoverNewCodexSession(before, {
      workingDirectory: 'C:\\Users\\fixture',
      launchedAfterMs: good.mtimeMs - 1,
      // No firstUserMessagePrefix — empty defaults preserve the legacy
      // cwd-only fallback for callers that don't know the launch prompt.
      openSqliteDb: opener,
      timeoutMs: 400,
      listFiles: () => [good],
      warn: () => {},
    });
    assert.ok(result, 'absent prefix must NOT block legacy cwd-only fallback');
    assert.equal(result.sessionId, SESSION_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== WP3: firstUserMessagePrefix threading + wildcard-safe prefix match =====

test('WP3(a): real serialLeadPrompt / serialReviewerKickoff outputs bind their own rows (template↔discovery lock)', async () => {
  // Two concurrent codex sessions in the SAME cwd within the SAME launch
  // window — a GroupThink Lead and Reviewer. Their first user messages are the
  // verbatim kickoff prompts. Discovery, handed each role's kickoffPrefix,
  // must bind that role's row and no other. A template edit that changes these
  // prompt shapes breaks THIS test, not live discovery.
  const topic = 'Should we adopt WASM for the plugin sandbox?';
  const leadMsg = serialLeadPrompt(topic, 'C:\\ws\\plans\\wasm.md');
  const reviewerMsg = serialReviewerKickoff(topic, 'Draft: use WASM with wasmtime.');
  const rows: FakeThreadRow[] = [
    { id: 'sid-lead', rollout_path: '/lead.jsonl', cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000, first_user_message: leadMsg },
    { id: 'sid-reviewer', rollout_path: '/reviewer.jsonl', cwd: 'C:\\Users\\fixture',
      created_at: 1_000_001, first_user_message: reviewerMsg },
  ];
  const { opener } = makeFakeDb(rows);
  const lead = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: kickoffPrefix(leadMsg),
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(lead, 'lead prefix must bind');
  assert.equal(lead.sessionId, 'sid-lead', 'lead kickoff prefix must select the lead row');

  const reviewer = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: kickoffPrefix(reviewerMsg),
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(reviewer, 'reviewer prefix must bind');
  assert.equal(reviewer.sessionId, 'sid-reviewer', 'reviewer kickoff prefix must select the reviewer row');
});

test('WP3(b): two same-cwd same-window rows with distinct role prefixes each bind correctly', async () => {
  const rows: FakeThreadRow[] = [
    { id: 'sid-role-A', rollout_path: '/a.jsonl', cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000, first_user_message: 'You are the Lead Planner. Topic: alpha' },
    { id: 'sid-role-B', rollout_path: '/b.jsonl', cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000, first_user_message: 'You are the Reviewer. Topic: alpha' },
  ];
  const { opener } = makeFakeDb(rows);
  const a = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: 'You are the Lead Planner.',
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.equal(a?.sessionId, 'sid-role-A');
  const b = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: 'You are the Reviewer.',
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.equal(b?.sessionId, 'sid-role-B');
});

test('WP3(c): literal %/_ prefix matches only true starts-with rows (no wildcard loosening) + SQL uses substr, not LIKE, + FOUR params', async () => {
  const captured: FakeQuery[] = [];
  const rows: FakeThreadRow[] = [
    // Literal match for the prefix "50%_d".
    { id: 'sid-literal', rollout_path: '/lit.jsonl', cwd: 'C:\\Users\\fixture',
      created_at: 1_000_000, first_user_message: '50%_done: ship the thing' },
    // A lookalike that ONLY a LIKE interpretation (`%`→any run, `_`→any single
    // char) of "50%_d%" would match — literal starts-with must reject it.
    { id: 'sid-lookalike', rollout_path: '/look.jsonl', cwd: 'C:\\Users\\fixture',
      created_at: 1_000_001, first_user_message: '50XYdone: something else' },
  ];
  const { opener } = makeFakeDb(rows, { capture: captured });
  const result = await discoverNewCodexSession(snapshot('windows'), {
    workingDirectory: 'C:\\Users\\fixture',
    launchedAfterMs: 999_999 * 1000,
    firstUserMessagePrefix: '50%_d',
    openSqliteDb: opener,
    timeoutMs: 400,
    warn: () => {},
  });
  assert.ok(result, 'literal-prefix row must bind');
  assert.equal(result.sessionId, 'sid-literal', 'only the literal starts-with row may match; a wildcard reading would also grab sid-lookalike');

  // The wildcard-safety guarantee lives in the SQL text: the fake stub can be
  // made to match either way, so pin the predicate itself.
  assert.ok(captured.length >= 1, 'a query must have been issued');
  const sql = captured[0].sql;
  assert.ok(/substr\(first_user_message, 1, length\(\?\)\) = \?/.test(sql),
    `query must use substr-equality prefix match; got: ${sql}`);
  assert.ok(!/first_user_message LIKE/.test(sql),
    `query must NOT use a LIKE prefix on first_user_message; got: ${sql}`);

  // WP3 Reviewer note: the prefix is bound TWICE → FOUR params total.
  const params = captured[0].params;
  assert.equal(params.length, 4, `query must bind exactly four params (cwdLike, afterSec, prefixForLength, prefixForEquality); got ${params.length}`);
  assert.equal(params[2], '50%_d', 'param 3 is the prefix (for length())');
  assert.equal(params[3], '50%_d', 'param 4 is the prefix (for equality) — same value, bound twice');
});

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
