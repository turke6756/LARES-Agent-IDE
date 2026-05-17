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
} from './session-id-discovery';
import type { CodexRolloutFile, CodexSessionHome } from './log-readers/codex-rollout-reader';

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

// BUG-08: shouldDiscoverCodexSession gates the post-launch session-id discovery
// poll. Default behavior runs discovery for codex on a fresh launch (resume=false)
// so the new agent record is bound to the codex-minted session id. freshSession=true
// is the opt-out — when the workspace has had prior codex work and the caller wants
// a clean context.

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

test('shouldDiscoverCodexSession: codex fresh launch with freshSession=true → skip discovery', () => {
  assert.equal(
    shouldDiscoverCodexSession({ provider: 'codex', resume: false, freshSession: true }),
    false,
    'freshSession=true must skip the resume-session discovery on a codex fresh launch'
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
