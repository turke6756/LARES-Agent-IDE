// Unit tests for reclaimAgentLogFiles (WP-1 (C) delete-time disk reclamation).
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/reclaim-log-files.test.js
//
// The reclaim helper imports `getAllAgents` from '../../database'. Loading the
// real database module drags in better-sqlite3 and needs an initialized DB, so
// we seed `require.cache` with a fake database module BEFORE requiring the
// reclaim helper. These are plain statements (NOT ESM imports), so tsc keeps
// them in source order — the seed runs before the reclaim require below.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

declare const require: any;

// ── Fake database module (seeded into require.cache) ─────────────────
let agentRows: Array<{ id: string; logPath: string | null }> = [];
const fakeDatabase = { getAllAgents: () => agentRows };

const dbResolved = require.resolve('../../database');
require.cache[dbResolved] = {
  id: dbResolved,
  filename: dbResolved,
  loaded: true,
  exports: fakeDatabase,
};

const { reclaimAgentLogFiles }: typeof import('./reclaim-log-files') = require('./reclaim-log-files');

// ── Minimal test harness ─────────────────────────────────────────────
import assert from 'node:assert/strict';
interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

function freshLogsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-logs-'));
}

/** Create `<dir>/<name>.log` plus the listed sidecars ('' = the .log itself). */
function seedFiles(dir: string, name: string, sidecars: string[]): string {
  const logPath = path.join(dir, `${name}.log`);
  for (const s of sidecars) fs.writeFileSync(logPath + s, `content${s}`);
  return logPath;
}

/** Capture console.warn / console.error calls for the duration of `fn`. */
function withCapturedConsole(fn: () => void): { warns: string[]; errors: string[] } {
  const warns: string[] = []; const errors: string[] = [];
  const origWarn = console.warn; const origError = console.error;
  console.warn = (...a: any[]) => { warns.push(a.join(' ')); };
  console.error = (...a: any[]) => { errors.push(a.join(' ')); };
  try { fn(); } finally { console.warn = origWarn; console.error = origError; }
  return { warns, errors };
}

// ── Tests ─────────────────────────────────────────────────────────────

test('unlinks .log + .scrollback + .checkpoint + .checkpoint.tmp; missing sidecar (ENOENT) does not throw', () => {
  const dir = freshLogsDir();
  // Seed everything EXCEPT .checkpoint.tmp so that sidecar hits ENOENT.
  const logPath = seedFiles(dir, 'agent1', ['', '.scrollback', '.checkpoint']);
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), 'precondition: no .checkpoint.tmp');
  agentRows = [{ id: 'agent1', logPath }]; // only the target row present

  const { errors } = withCapturedConsole(() => {
    reclaimAgentLogFiles(logPath, 'agent1', dir);
  });

  assert.ok(!fs.existsSync(logPath), '.log unlinked');
  assert.ok(!fs.existsSync(logPath + '.scrollback'), '.scrollback unlinked');
  assert.ok(!fs.existsSync(logPath + '.checkpoint'), '.checkpoint unlinked');
  assert.equal(errors.length, 0, 'ENOENT sidecar produced no error log');
});

test('refuses a path whose dirname != approved logs dir (no unlink + warning)', () => {
  const approvedDir = freshLogsDir();
  const outsideDir = freshLogsDir(); // a DIFFERENT directory
  const logPath = seedFiles(outsideDir, 'stray', ['', '.scrollback']);
  agentRows = [{ id: 'stray', logPath }];

  const { warns } = withCapturedConsole(() => {
    reclaimAgentLogFiles(logPath, 'stray', approvedDir);
  });

  assert.ok(fs.existsSync(logPath), 'out-of-scope .log NOT unlinked');
  assert.ok(fs.existsSync(logPath + '.scrollback'), 'out-of-scope .scrollback NOT unlinked');
  assert.ok(warns.some(w => w.includes('out-of-scope')), 'warned about out-of-scope path');
});

test('refuses when another agent row shares the normalized path (case-insensitive on win32)', () => {
  const dir = freshLogsDir();
  const logPath = seedFiles(dir, 'shared', ['', '.scrollback']);
  // A SECOND agent points at the same normalized path. On win32 exercise the
  // case-insensitive normalization; elsewhere the identical string still shares.
  const otherPath = process.platform === 'win32' ? logPath.toUpperCase() : logPath;
  agentRows = [
    { id: 'target', logPath },
    { id: 'other', logPath: otherPath },
  ];

  const { warns } = withCapturedConsole(() => {
    reclaimAgentLogFiles(logPath, 'target', dir);
  });

  assert.ok(fs.existsSync(logPath), 'shared .log NOT unlinked');
  assert.ok(fs.existsSync(logPath + '.scrollback'), 'shared .scrollback NOT unlinked');
  assert.ok(warns.some(w => w.includes('still referenced')), 'warned about shared reference');
});

test('runs while the target row is still present and excludes it by id (detects only OTHER references)', () => {
  const dir = freshLogsDir();
  const logPath = seedFiles(dir, 'live', ['', '.scrollback', '.checkpoint', '.checkpoint.tmp']);
  // The target row is present (as at real call time) alongside an unrelated
  // agent with a DIFFERENT path. Only the target references this path, so the
  // self-exclusion means reclaim proceeds.
  const otherLog = path.join(dir, 'unrelated.log');
  agentRows = [
    { id: 'live', logPath },
    { id: 'unrelated', logPath: otherLog },
  ];

  const { warns, errors } = withCapturedConsole(() => {
    reclaimAgentLogFiles(logPath, 'live', dir);
  });

  assert.ok(!fs.existsSync(logPath), '.log unlinked (self-reference excluded)');
  assert.ok(!fs.existsSync(logPath + '.scrollback'), '.scrollback unlinked');
  assert.ok(!fs.existsSync(logPath + '.checkpoint'), '.checkpoint unlinked');
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), '.checkpoint.tmp unlinked');
  assert.equal(warns.length, 0, 'no refusal warning when only the target references the path');
  assert.equal(errors.length, 0, 'no unlink errors');
});

// ── Runner ────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
