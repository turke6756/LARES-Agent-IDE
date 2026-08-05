// WP-P8F — readiness-gated, repeatable DROP migration for the six retired legacy
// plan-provenance / snapshot tables (A2 terminal DDL exception).
//
// Exercises `dropRetiredPlanProvenanceTablesIfReady` against ISOLATED sql.js
// fixture handles — NEVER the live %APPDATA% dashboard.db. Fixtures:
//   (a) ready       — zero active html rows            → dropped once, marker set,
//                                                         second run a no-op
//   (b) not-ready   — html rows in an available ws     → blocked, tables intact,
//                                                         re-checks (repeatable)
//   (c) unavailable — html rows in an unavailable ws   → blocked (clause B)
// plus orphan-row, soft-delete, mixed, and default-probe coverage.
//
// better-sqlite3's native binding won't load under the system Node that
// `npm run test:*` uses, so this injects a sql.js (wasm SQLite) stand-in into
// require.cache BEFORE requiring ./database (precedent: the retired
// plans-provenance-db.test.ts harness).
//
//   npm run build:main
//   node dist/main/main/plans-legacy-drop-migration.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors the retired provenance harness) ─

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;

type FakeHandle = {
  exec(sql: string): FakeHandle;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  transaction<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => unknown;
  pragma(s: string): unknown;
  close(): void;
};

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  private dbPath: string;
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
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
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

// ── module under test ─────────────────────────────────────────────────────────

type DropResult = {
  dropped: boolean;
  alreadyDropped: boolean;
  ready: boolean;
  reason: 'dropped' | 'already-dropped' | 'active-html-rows' | 'unavailable-workspace-pending';
  htmlRowsAvailable: number;
  htmlRowsUnavailable: number;
};
type Probe = (ws: { id: string; path: string; pathType: string }) => boolean;
type DbModule = {
  initDatabase(): void;
  closeDatabaseForTests(): void;
  dropRetiredPlanProvenanceTablesIfReady(database: unknown, isAvailable?: Probe): DropResult;
  RETIRED_PLAN_PROVENANCE_TABLES: readonly string[];
  LEGACY_PLAN_PROVENANCE_DROP_MARKER: string;
};
let dbm: DbModule;

const SIX = [
  'plan_snapshots', 'plan_snapshot_blobs', 'plan_section_touches',
  'plan_section_changes', 'plan_events', 'plan_sections',
];

let dbSeq = 0;
/** A fresh, isolated fixture handle with the two source tables the readiness
 *  check reads (`workspaces`, `plans`) + the six retired tables present. */
function freshDb(): FakeHandle {
  const h = new FakeBetterSqlite(`:memory:p8f-${++dbSeq}`) as unknown as FakeHandle;
  h.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL, path_type TEXT NOT NULL DEFAULT 'windows')`);
  h.exec(`CREATE TABLE plans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL, format TEXT NOT NULL, deleted_at TEXT)`);
  for (const t of SIX) h.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
  return h;
}

let wsSeq = 0;
function addWorkspace(h: FakeHandle, wsPath: string): string {
  const id = `ws-${++wsSeq}`;
  h.prepare(`INSERT INTO workspaces (id, path, path_type) VALUES (?, ?, 'windows')`).run(id, wsPath);
  return id;
}

let planSeq = 0;
function addPlan(h: FakeHandle, workspaceId: string, format: string, deletedAt: string | null = null): string {
  const id = `plan-${++planSeq}`;
  h.prepare(`INSERT INTO plans (id, workspace_id, path, format, deleted_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, workspaceId, `/p/${id}.html`, format, deletedAt);
  return id;
}

function presentTables(h: FakeHandle): string[] {
  const placeholders = SIX.map(() => '?').join(',');
  return h.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
  ).all(...SIX).map((r) => String(r.name)).sort();
}

function markerSet(h: FakeHandle): boolean {
  // applied_migrations is created lazily by the migration; tolerate its absence.
  const t = h.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='applied_migrations'`).get();
  if (!t) return false;
  const r = h.prepare(`SELECT 1 AS present FROM applied_migrations WHERE name = ?`)
    .get(dbm.LEGACY_PLAN_PROVENANCE_DROP_MARKER);
  return !!r;
}

const AVAILABLE: Probe = () => true;
const UNAVAILABLE: Probe = () => false;
const drop = (h: FakeHandle, probe?: Probe): DropResult =>
  dbm.dropRetiredPlanProvenanceTablesIfReady(h, probe);

// ── tests ─────────────────────────────────────────────────────────────────────

test('exported constants match the six retired tables + marker key', () => {
  assert.deepEqual([...dbm.RETIRED_PLAN_PROVENANCE_TABLES].sort(), [...SIX].sort());
  assert.equal(dbm.LEGACY_PLAN_PROVENANCE_DROP_MARKER, 'p8f_drop_legacy_plan_provenance');
});

test('ready fixture — zero html rows → tables dropped exactly once, marker set, second run no-ops', () => {
  const h = freshDb();
  const ws = addWorkspace(h, 'C:/ws/live');
  addPlan(h, ws, 'structured'); // a non-html plan never blocks the drop
  assert.equal(presentTables(h).length, 6, 'all six tables present before the drop');

  const first = drop(h, AVAILABLE);
  assert.equal(first.dropped, true);
  assert.equal(first.ready, true);
  assert.equal(first.reason, 'dropped');
  assert.deepEqual(presentTables(h), [], 'all six tables dropped');
  assert.ok(markerSet(h), 'migration marker recorded');

  const second = drop(h, AVAILABLE);
  assert.equal(second.dropped, false, 'second run does not drop again');
  assert.equal(second.alreadyDropped, true);
  assert.equal(second.reason, 'already-dropped');
  assert.deepEqual(presentTables(h), [], 'tables stay gone; no error re-dropping absent tables');
  assert.ok(markerSet(h), 'marker still present');
});

test('not-ready fixture — html rows in an AVAILABLE workspace → blocked (clause A), tables intact, no marker', () => {
  const h = freshDb();
  const ws = addWorkspace(h, 'C:/ws/legacy');
  addPlan(h, ws, 'html');

  const r = drop(h, AVAILABLE);
  assert.equal(r.dropped, false);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'active-html-rows');
  assert.equal(r.htmlRowsAvailable, 1);
  assert.equal(r.htmlRowsUnavailable, 0);
  assert.equal(presentTables(h).length, 6, 'tables stay inert but present');
  assert.equal(markerSet(h), false, 'no marker while deferred');
});

test('repeatable — a deferred DB that later becomes ready drops on the next check', () => {
  const h = freshDb();
  const ws = addWorkspace(h, 'C:/ws/legacy');
  const planId = addPlan(h, ws, 'html');

  assert.equal(drop(h, AVAILABLE).reason, 'active-html-rows', 'first launch: blocked');
  assert.equal(presentTables(h).length, 6);

  // Edward deletes the junk html rows at deploy → soft-delete here.
  h.prepare(`UPDATE plans SET deleted_at = ? WHERE id = ?`).run('2026-08-04T00:00:00.000Z', planId);

  const r = drop(h, AVAILABLE);
  assert.equal(r.dropped, true, 'next launch: readiness now holds → drop fires');
  assert.deepEqual(presentTables(h), []);
  assert.ok(markerSet(h));
});

test('unavailable-workspace fixture — pending html rows in an UNAVAILABLE workspace → blocked (clause B)', () => {
  const h = freshDb();
  const ws = addWorkspace(h, 'Z:/offline/ws');
  addPlan(h, ws, 'html');

  const r = drop(h, UNAVAILABLE);
  assert.equal(r.dropped, false);
  assert.equal(r.reason, 'unavailable-workspace-pending');
  assert.equal(r.htmlRowsUnavailable, 1);
  assert.equal(r.htmlRowsAvailable, 0);
  assert.equal(presentTables(h).length, 6, 'tables preserved while an unreachable ws may hold legacy rows');
  assert.equal(markerSet(h), false);
});

test('clause A precedes clause B — an available html row blocks even with an unavailable one present', () => {
  const h = freshDb();
  const wsA = addWorkspace(h, 'C:/ws/here');
  const wsB = addWorkspace(h, 'Z:/gone');
  addPlan(h, wsA, 'html');
  addPlan(h, wsB, 'html');
  const probe: Probe = (w) => w.path.startsWith('C:');

  const r = drop(h, probe);
  assert.equal(r.reason, 'active-html-rows');
  assert.equal(r.htmlRowsAvailable, 1);
  assert.equal(r.htmlRowsUnavailable, 1);
  assert.equal(presentTables(h).length, 6);
});

test('orphan html row (no workspace row) counts as pending under clause A', () => {
  const h = freshDb();
  addPlan(h, 'ws-does-not-exist', 'html');

  const r = drop(h, AVAILABLE);
  assert.equal(r.reason, 'active-html-rows');
  assert.equal(r.htmlRowsAvailable, 1, 'orphan rows are never silently ignored');
  assert.equal(presentTables(h).length, 6);
});

test('soft-deleted html rows do not count — deleted_at IS NULL is the active filter', () => {
  const h = freshDb();
  const ws = addWorkspace(h, 'C:/ws/live');
  addPlan(h, ws, 'html', '2026-01-01T00:00:00.000Z'); // already soft-deleted

  const r = drop(h, AVAILABLE);
  assert.equal(r.dropped, true, 'a soft-deleted html row is not an active legacy row');
  assert.deepEqual(presentTables(h), []);
});

test('default probe (fs.existsSync) — existing path is available (blocks), missing path is unavailable', () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8f-probe-'));
  try {
    const hHere = freshDb();
    const wsHere = addWorkspace(hHere, realDir);
    addPlan(hHere, wsHere, 'html');
    // No probe arg → the real defaultWorkspaceAvailable runs against the fs.
    const rHere = drop(hHere);
    assert.equal(rHere.reason, 'active-html-rows', 'an on-disk workspace is available → clause A');
    assert.equal(rHere.htmlRowsAvailable, 1);

    const hGone = freshDb();
    const wsGone = addWorkspace(hGone, path.join(realDir, 'definitely-not-here'));
    addPlan(hGone, wsGone, 'html');
    const rGone = drop(hGone);
    assert.equal(rGone.reason, 'unavailable-workspace-pending', 'a missing path is unavailable → clause B');
    assert.equal(rGone.htmlRowsUnavailable, 1);
  } finally {
    try { fs.rmSync(realDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-legacy-drop-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  // Smoke-test the init-time wiring: initDatabase now runs the readiness-gated
  // drop against its own (zero-html) handle and must complete without throwing.
  dbm.initDatabase();

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { dbm.closeDatabaseForTests(); } catch { /* best-effort */ }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
