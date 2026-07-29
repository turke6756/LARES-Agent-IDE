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

/** Temporarily replace `fs.statSync` / `fs.unlinkSync` with a stub (used to
 *  induce non-ENOENT stat/unlink errors the real filesystem won't reliably
 *  produce cross-platform). The reclaim module reads `fs.statSync`/`fs.unlinkSync`
 *  at call time off this same module object, so the override is observed. */
// The reclaim module's `import * as fs` compiles to a `__importStar` namespace
// whose `statSync` is a live getter into the REAL `require('fs')` module. So to
// have the module observe a stub we patch the real module object (its props are
// writable), not our own frozen `import * as fs` namespace copy.
const realFs: typeof fs = require('fs');
function withStatSyncOverride(stub: typeof fs.statSync, fn: () => void): void {
  const orig = realFs.statSync;
  (realFs as any).statSync = stub;
  try { fn(); } finally { (realFs as any).statSync = orig; }
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

// ── WP-3: worklist-first, hook only when a file will actually be unlinked ──

test('WP-3: all four files absent → validated:true, hook NOT called, no marker', () => {
  const dir = freshLogsDir();
  const logPath = path.join(dir, 'ghost.log'); // nothing seeded
  agentRows = [{ id: 'ghost', logPath }];

  let hookCalls = 0;
  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  withCapturedConsole(() => {
    res = reclaimAgentLogFiles(logPath, 'ghost', dir, { beforeFirstUnlink: () => { hookCalls++; } });
  });

  assert.equal(res.validated, true, 'validated true (nothing to refuse)');
  assert.equal(hookCalls, 0, 'hook NOT called on an empty worklist');
  assert.equal(res.removed.length, 0, 'nothing removed');
  assert.equal(res.failed.length, 0, 'nothing failed (all ENOENT omitted)');
});

test('WP-3: only .checkpoint.tmp present → hook called once, that file removed', () => {
  const dir = freshLogsDir();
  const logPath = path.join(dir, 'partial.log');
  fs.writeFileSync(logPath + '.checkpoint.tmp', 'tmp-bytes');
  agentRows = [{ id: 'partial', logPath }];

  let hookCalls = 0;
  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  withCapturedConsole(() => {
    res = reclaimAgentLogFiles(logPath, 'partial', dir, { beforeFirstUnlink: () => { hookCalls++; } });
  });

  assert.equal(hookCalls, 1, 'hook called exactly once');
  assert.equal(res.validated, true);
  assert.deepEqual(res.removed.map(r => r.path), [logPath + '.checkpoint.tmp'], 'only the tmp removed');
  assert.ok(!fs.existsSync(logPath + '.checkpoint.tmp'), '.checkpoint.tmp unlinked');
  assert.equal(res.failed.length, 0);
});

test('WP-3: non-ENOENT stat error with no other existing file → failed populated, hook NOT called', () => {
  const dir = freshLogsDir();
  const logPath = path.join(dir, 'eacces.log');
  agentRows = [{ id: 'eacces', logPath }];

  let hookCalls = 0;
  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  const statStub = ((p: fs.PathLike, ...rest: any[]): fs.Stats => {
    if (String(p) === logPath) { const err: any = new Error('perm'); err.code = 'EACCES'; throw err; }
    const err: any = new Error('missing'); err.code = 'ENOENT'; throw err; // other three sidecars absent
  }) as unknown as typeof fs.statSync;

  withCapturedConsole(() => {
    withStatSyncOverride(statStub, () => {
      res = reclaimAgentLogFiles(logPath, 'eacces', dir, { beforeFirstUnlink: () => { hookCalls++; } });
    });
  });

  assert.equal(hookCalls, 0, 'hook NOT called (worklist empty after stat error omitted)');
  assert.equal(res.validated, true, 'validation passed; stat error is not a refusal');
  assert.deepEqual(res.failed.map(f => ({ path: f.path, code: f.code })), [{ path: logPath, code: 'EACCES' }]);
  assert.equal(res.removed.length, 0);
});

test('WP-3: hook fires AFTER validation and BEFORE any unlink', () => {
  const dir = freshLogsDir();
  const logPath = seedFiles(dir, 'order', ['', '.scrollback']);
  agentRows = [{ id: 'order', logPath }];

  // Validation runs before the hook (a bad path would refuse without firing it);
  // the hook runs before any unlink, so at hook time BOTH files still exist.
  let hookCalls = 0;
  let filesPresentAtHook = false;
  withCapturedConsole(() => {
    reclaimAgentLogFiles(logPath, 'order', dir, {
      beforeFirstUnlink: () => {
        hookCalls++;
        filesPresentAtHook = fs.existsSync(logPath) && fs.existsSync(logPath + '.scrollback');
      },
    });
  });

  assert.equal(hookCalls, 1, 'hook fired exactly once (after validation passed)');
  assert.ok(filesPresentAtHook, 'no file unlinked before the hook fired');
  assert.ok(!fs.existsSync(logPath) && !fs.existsSync(logPath + '.scrollback'), 'both unlinked after the hook');
});

test('WP-3: refusal (out-of-scope) → hook NOT called, validated:false, refusedReason', () => {
  const approvedDir = freshLogsDir();
  const outsideDir = freshLogsDir();
  const logPath = seedFiles(outsideDir, 'stray', ['', '.scrollback']);
  agentRows = [{ id: 'stray', logPath }];

  let hookCalls = 0;
  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  withCapturedConsole(() => {
    res = reclaimAgentLogFiles(logPath, 'stray', approvedDir, { beforeFirstUnlink: () => { hookCalls++; } });
  });

  assert.equal(res.validated, false);
  assert.equal(res.refusedReason, 'out-of-scope');
  assert.equal(hookCalls, 0, 'hook NOT called on refusal');
  assert.ok(fs.existsSync(logPath), 'out-of-scope file untouched');
});

test('WP-3: refusal (shared-reference) → hook NOT called, validated:false, refusedReason', () => {
  const dir = freshLogsDir();
  const logPath = seedFiles(dir, 'shared', ['', '.scrollback']);
  agentRows = [
    { id: 'target', logPath },
    { id: 'other', logPath: process.platform === 'win32' ? logPath.toUpperCase() : logPath },
  ];

  let hookCalls = 0;
  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  withCapturedConsole(() => {
    res = reclaimAgentLogFiles(logPath, 'target', dir, { beforeFirstUnlink: () => { hookCalls++; } });
  });

  assert.equal(res.validated, false);
  assert.equal(res.refusedReason, 'shared-reference');
  assert.equal(hookCalls, 0, 'hook NOT called on shared-reference refusal');
  assert.ok(fs.existsSync(logPath), 'shared file untouched');
});

test('WP-3: removed byte counts come from the pre-unlink stat', () => {
  const dir = freshLogsDir();
  const logPath = path.join(dir, 'bytes.log');
  fs.writeFileSync(logPath, 'A'.repeat(100));
  fs.writeFileSync(logPath + '.scrollback', 'B'.repeat(42));
  agentRows = [{ id: 'bytes', logPath }];

  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  withCapturedConsole(() => {
    res = reclaimAgentLogFiles(logPath, 'bytes', dir, { beforeFirstUnlink: () => {} });
  });

  const byPath = new Map(res.removed.map(r => [r.path, r.bytes]));
  assert.equal(byPath.get(logPath), 100, '.log byte count from stat');
  assert.equal(byPath.get(logPath + '.scrollback'), 42, '.scrollback byte count from stat');
  assert.ok(!fs.existsSync(logPath) && !fs.existsSync(logPath + '.scrollback'), 'both unlinked');
});

test('WP-3: removed reflects ACTUAL removals — a failed unlink lands in failed, not removed', () => {
  const dir = freshLogsDir();
  const logPath = seedFiles(dir, 'partialfail', ['']); // real .log file
  // Seed `.scrollback` as a NON-EMPTY DIRECTORY: statSync succeeds (so it enters
  // the worklist) but unlinkSync on it fails (EPERM on win32 / EISDIR on posix),
  // so it must land in `failed`, never in `removed`.
  const scrollback = logPath + '.scrollback';
  fs.mkdirSync(scrollback);
  fs.writeFileSync(path.join(scrollback, 'x'), 'keep');
  agentRows = [{ id: 'partialfail', logPath }];

  let res!: ReturnType<typeof reclaimAgentLogFiles>;
  withCapturedConsole(() => {
    res = reclaimAgentLogFiles(logPath, 'partialfail', dir, { beforeFirstUnlink: () => {} });
  });

  assert.deepEqual(res.removed.map(r => r.path), [logPath], 'only the .log actually removed');
  assert.deepEqual(res.failed.map(f => f.path), [scrollback], 'the un-unlinkable entry lands in failed');
  assert.ok(res.failed[0] && typeof res.failed[0].code === 'string' && res.failed[0].code.length > 0, 'failed carries an error code');
  assert.ok(!fs.existsSync(logPath), '.log actually gone');
  assert.ok(fs.existsSync(scrollback), '.scrollback dir remains (unlink failed)');
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
