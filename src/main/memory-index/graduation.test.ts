// graduation.test.ts — WP-F2 propose_graduation recording.
//
// Covers the WP-F2 acceptance criteria at the graduation layer:
//   - a `.lares/**` target (and any target other than CLAUDE.md/AGENTS.md) is
//     rejected with NO row written;
//   - a missing target records the explicit ABSENT sentinel;
//   - an existing target records its content hash;
//   - the { proposalId, status:'pending' } result shape is returned and a durable
//     row is persisted.
//
// The store touches the shared better-sqlite3 handle, so this injects a sql.js
// stand-in into require.cache BEFORE requiring ../database (same precedent as
// publisher.test.ts). Filesystem is real against a temp workspace root.
//   npm run build:main
//   node dist/main/main/memory-index/graduation.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors publisher.test.ts) ──
type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; };
};
let sqlJsCtor: new () => SqlJsDatabase;
class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); const rows: Record<string, unknown>[] = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => { this.db.exec('BEGIN'); try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (err) { this.db.exec('ROLLBACK'); throw err; } };
  }
}

type GradModule = typeof import('./graduation');
type StoreModule = typeof import('./review-store');
let grad: GradModule;
let store: StoreModule;

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function mkRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'graduation-')); }

// ── .lares/** target is rejected ────────────────────────────────────────────
test('a `.lares/**` target is rejected with NO row written', () => {
  const ws = 'ws-lares', root = mkRoot();
  const res = grad.proposeGraduation(ws, root, { target: '.lares/supervisor/CLAUDE.md', text: 't', rationale: 'r' }, 'sup-1');
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'invalid_target');
  assert.equal(store.listGraduations(ws).length, 0, 'no proposal row for a rejected target');
});

test('an arbitrary/escaping target is rejected', () => {
  const ws = 'ws-escape', root = mkRoot();
  for (const target of ['../CLAUDE.md', 'secrets.md', 'CLAUDE.md.bak', 'sub/CLAUDE.md']) {
    const res = grad.proposeGraduation(ws, root, { target, text: 't', rationale: 'r' }, null);
    assert.equal(res.ok, false, `${target} must be rejected`);
    assert.equal((res as { code: string }).code, 'invalid_target');
  }
  assert.equal(store.listGraduations(ws).length, 0);
});

// ── missing target → ABSENT sentinel ────────────────────────────────────────
test('a missing target records the ABSENT sentinel and returns pending', () => {
  const ws = 'ws-absent', root = mkRoot(); // no CLAUDE.md on disk
  const res = grad.proposeGraduation(ws, root, { target: 'CLAUDE.md', text: 'always true', rationale: 'r' }, 'sup-2');
  assert.equal(res.ok, true);
  assert.equal((res as { status: string }).status, 'pending');
  const rows = store.listGraduations(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, 'CLAUDE.md');
  assert.equal(rows[0].targetHashAtProposal, grad.ABSENT_TARGET_SENTINEL);
  assert.equal(rows[0].status, 'pending');
});

// ── existing target → content hash captured ─────────────────────────────────
test('an existing target records its content hash', () => {
  const ws = 'ws-present', root = mkRoot();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'existing content\n', 'utf8');
  const res = grad.proposeGraduation(ws, root, { target: 'AGENTS.md', text: 'add me', rationale: 'r' }, 'sup-3');
  assert.equal(res.ok, true);
  const rows = store.listGraduations(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetHashAtProposal, sha('existing content\n'), 'captures the live target hash');
  assert.ok((res as { proposalId: string }).proposalId.startsWith('grad-'), 'proposal id is returned');
});

// ── empty text rejected ──────────────────────────────────────────────────────
test('empty graduation text is rejected', () => {
  const ws = 'ws-notext', root = mkRoot();
  const res = grad.proposeGraduation(ws, root, { target: 'CLAUDE.md', text: '   ', rationale: 'r' }, null);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'invalid_text');
  assert.equal(store.listGraduations(ws).length, 0);
});

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'graduation-appdata-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbm = require('../database') as { initDatabase(): void };
  dbm.initDatabase();
  store = require('./review-store') as StoreModule;
  grad = require('./graduation') as GradModule;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
