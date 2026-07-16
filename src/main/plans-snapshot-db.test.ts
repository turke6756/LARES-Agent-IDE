// WP4 — DB-layer test for snapshot history (§F-B) + plan_sections helpers.
//
// Covers: consecutive-dedup, A→B→A content-addressed blob REUSE (A stored once),
// recordPlanSnapshot transaction atomicity (blob + reference land together),
// getPlanSnapshotStats, getLatestPlanSnapshotHtml reconstruction source, and the
// plan_sections insert / soft-archive / un-archive helpers.
//
// Injects a sql.js (wasm) better-sqlite3 stand-in (mirrors
// plans-provenance-db.test.ts) since the native binding won't load under the
// system Node the test runner uses.
//
//   npm run build:main
//   node dist/main/main/plans-snapshot-db.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in ─────────────────────────────────────
type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; };
};
let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  private dbPath: string;
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  close(): void { FakeBetterSqlite.stores.delete(this.dbPath); }
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
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

// ── module under test ─────────────────────────────────────────────────────────
type DbModule = {
  initDatabase(): void;
  getDb(): { prepare(sql: string): { get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): Record<string, unknown>[] } };
  hashPlanHtml(html: string): string;
  recordPlanSnapshot(planId: string, html: string, createdAt?: string): string | null;
  getLatestPlanSnapshotHtml(planId: string): string | null;
  getPlanSnapshotStats(planId?: string): { snapshotRows: number; blobRows: number; totalBlobBytes: number };
  insertPlanSection(input: { planId: string; anchor: string; parentSectionId?: string | null; createdAt?: string }): string;
  archivePlanSection(planId: string, anchor: string, archivedAt?: string): void;
  getPlanSections(planId: string, opts?: { includeArchived?: boolean }): { anchor: string; archivedAt: string | null }[];
  getPlanSectionByAnchor(planId: string, anchor: string): { id: string; anchor: string; archivedAt: string | null } | null;
  closeDatabaseForTests(): void;
};
let dbm: DbModule;
const T = (n: number) => `2026-07-05T00:00:0${n}.000Z`;

// ── snapshot dedupe / blob reuse ──────────────────────────────────────────────

test('consecutive-dedup — recording the same HTML twice in a row is a no-op the 2nd time', () => {
  const id1 = dbm.recordPlanSnapshot('plan-dd', '<p>A</p>', T(0));
  const id2 = dbm.recordPlanSnapshot('plan-dd', '<p>A</p>', T(1));
  assert.ok(id1, 'first snapshot inserted');
  assert.equal(id2, null, 'identical consecutive hash → dedup skip (no history row)');
  const stats = dbm.getPlanSnapshotStats('plan-dd');
  assert.equal(stats.snapshotRows, 1);
});

test('A→B→A reuses A\'s blob (content-addressed): 3 history rows, 2 blobs', () => {
  const p = 'plan-aba';
  dbm.recordPlanSnapshot(p, '<p>A</p>', T(0));
  dbm.recordPlanSnapshot(p, '<p>B</p>', T(1));
  dbm.recordPlanSnapshot(p, '<p>A</p>', T(2)); // back to A — not a consecutive dup (B was between)
  const stats = dbm.getPlanSnapshotStats(p);
  assert.equal(stats.snapshotRows, 3, 'three ordered reference rows');
  // A stored exactly once, ever: the blob table holds A + B (2 distinct blobs).
  const hashA = dbm.hashPlanHtml('<p>A</p>');
  const blobRowsForA = dbm.getDb().prepare('SELECT COUNT(*) AS c FROM plan_snapshot_blobs WHERE content_hash = ?').get(hashA)!;
  assert.equal(Number(blobRowsForA.c), 1, 'A\'s blob stored exactly once despite two references');
});

test('recordPlanSnapshot is atomic — blob + reference land together in one transaction', () => {
  const p = 'plan-atomic';
  const id = dbm.recordPlanSnapshot(p, '<p>unique-atomic</p>', T(0));
  const hash = dbm.hashPlanHtml('<p>unique-atomic</p>');
  const ref = dbm.getDb().prepare('SELECT * FROM plan_snapshots WHERE id = ?').get(id)!;
  const blob = dbm.getDb().prepare('SELECT * FROM plan_snapshot_blobs WHERE content_hash = ?').get(hash)!;
  assert.ok(ref, 'reference row exists');
  assert.ok(blob, 'blob row exists');
  assert.equal(ref.content_hash, hash, 'reference points at the blob');
  assert.equal(Number(blob.byte_size), Buffer.byteLength('<p>unique-atomic</p>', 'utf8'), 'byte_size via Buffer.byteLength');
});

test('getLatestPlanSnapshotHtml returns the newest reference\'s blob HTML (reconstruction source)', () => {
  const p = 'plan-latest';
  dbm.recordPlanSnapshot(p, '<p>old</p>', T(0));
  dbm.recordPlanSnapshot(p, '<p>new</p>', T(5));
  assert.equal(dbm.getLatestPlanSnapshotHtml(p), '<p>new</p>');
  assert.equal(dbm.getLatestPlanSnapshotHtml('plan-none'), null);
});

test('getPlanSnapshotStats — per-plan rows, global blob bytes', () => {
  const stats = dbm.getPlanSnapshotStats();
  assert.ok(stats.blobRows >= 1);
  assert.ok(stats.totalBlobBytes > 0);
  assert.ok(stats.snapshotRows >= 1);
});

// ── plan_sections helpers ─────────────────────────────────────────────────────

test('insertPlanSection is idempotent on (plan, anchor)', () => {
  const a = dbm.insertPlanSection({ planId: 'plan-sec', anchor: 'sec_aaa111', createdAt: T(0) });
  const b = dbm.insertPlanSection({ planId: 'plan-sec', anchor: 'sec_aaa111', createdAt: T(1) });
  assert.equal(a, b, 're-insert returns the same row id, no duplicate');
});

test('archivePlanSection sets archived_at without deleting; reappearance un-archives', () => {
  dbm.insertPlanSection({ planId: 'plan-arch', anchor: 'sec_bbb222', createdAt: T(0) });
  dbm.archivePlanSection('plan-arch', 'sec_bbb222', T(1));
  let row = dbm.getPlanSectionByAnchor('plan-arch', 'sec_bbb222')!;
  assert.ok(row, 'row NOT deleted');
  assert.ok(row.archivedAt, 'archived_at set');
  // Live-only listing excludes it; full listing keeps it (orphan-event resolution).
  assert.equal(dbm.getPlanSections('plan-arch', { includeArchived: false }).length, 0);
  assert.equal(dbm.getPlanSections('plan-arch').length, 1, 'archived row still present for named resolution');
  // Reappear → un-archive.
  dbm.insertPlanSection({ planId: 'plan-arch', anchor: 'sec_bbb222', createdAt: T(2) });
  row = dbm.getPlanSectionByAnchor('plan-arch', 'sec_bbb222')!;
  assert.equal(row.archivedAt, null, 'un-archived on reappearance');
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-snapshot-db-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { dbm.closeDatabaseForTests(); } catch { /* best-effort */ }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
