// Planning-surface WP-P3A′ — responsibility + doc-link + tab-overview schema.
// FK-behavior + shape proofs for plans.responsible_supervisor_id (ON DELETE SET
// NULL), supervisor_active_plan (both cascades), supervisor_focus (existing
// cascade preserved), plan_tab_overviews (revisioned round-trip, PK), and
// plan_documents (rel-path-only, no body column, doc_kind CHECK). DDL-only WP:
// raw inserts exercise the schema (no accessors exist yet).
//
//   npm run build:main
//   node dist/main/main/database.responsibility.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

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

// Same FakeBetterSqlite shim the sibling database.*.test.ts files use: a sql.js
// store behind the better-sqlite3 surface database.ts calls. pragma() is a
// deliberate no-op, so database.ts's `db.pragma('foreign_keys = ON')` does NOT
// reach sql.js — the FK-cascade tests enable it directly via rawExec.
class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  static lastPath = '';
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    FakeBetterSqlite.lastPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }

  pragma(_sql: string): unknown { return undefined; }
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

  private static store(): SqlJsDatabase {
    const s = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath);
    if (!s) throw new Error('no store for last path');
    return s;
  }
  static rawExec(sql: string): void { FakeBetterSqlite.store().exec(sql); }
  static rawRun(sql: string, params: unknown[] = []): void { FakeBetterSqlite.store().run(sql, params); }
  static rawAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = FakeBetterSqlite.store().prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }
}

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
};

let dbm: DbModule;

// Raw fixtures — DDL-only WP, so we drive the real schema directly. FK enforcement
// is enabled once here so the SET NULL / CASCADE actions actually fire under delete.
function enableFk(): void { FakeBetterSqlite.rawExec('PRAGMA foreign_keys = ON'); }

function rawInsertWorkspace(id: string): void {
  FakeBetterSqlite.rawRun(
    `INSERT OR IGNORE INTO workspaces (id, title, path, path_type) VALUES (?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 'local'],
  );
}

function rawInsertAgent(id: string, workspaceId = 'ws-r'): void {
  FakeBetterSqlite.rawRun(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, id, id, `/tmp/${id}`, 'claude'],
  );
}

function rawInsertPlan(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, workspace_id: 'ws-r', path: `.lares/plans/${id}/plan.md`,
    format: 'structured', run_state: 'hardening', mtime_ms: 1, size_bytes: 1,
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO plans (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

test('plans carries responsible_supervisor_id and the three P3A tables exist', () => {
  const planCols = FakeBetterSqlite.rawAll(`PRAGMA table_info(plans)`).map((r) => String(r.name));
  assert.ok(planCols.includes('responsible_supervisor_id'),
    'plans must carry responsible_supervisor_id (P3A inline FK)');
  const tables = FakeBetterSqlite.rawAll(
    `SELECT name FROM sqlite_master WHERE type='table'`).map((r) => String(r.name));
  for (const t of ['supervisor_active_plan', 'plan_documents', 'plan_tab_overviews']) {
    assert.ok(tables.includes(t), `${t} table must exist`);
  }
});

test('deleting the responsible supervisor nulls plans.responsible_supervisor_id (ON DELETE SET NULL)', () => {
  enableFk();
  rawInsertWorkspace('ws-r');
  rawInsertAgent('sup-null', 'ws-r');
  rawInsertPlan('plan-null', { responsible_supervisor_id: 'sup-null' });
  assert.equal(
    FakeBetterSqlite.rawAll(`SELECT responsible_supervisor_id AS s FROM plans WHERE id='plan-null'`)[0].s,
    'sup-null');
  FakeBetterSqlite.rawRun(`DELETE FROM agents WHERE id=?`, ['sup-null']);
  // The plan survives; only its responsibility pointer is nulled.
  const rows = FakeBetterSqlite.rawAll(`SELECT responsible_supervisor_id AS s FROM plans WHERE id='plan-null'`);
  assert.equal(rows.length, 1, 'the plan row itself must survive the supervisor delete');
  assert.equal(rows[0].s, null, 'responsible_supervisor_id must be nulled, not left dangling');
});

test('supervisor_active_plan cascades on BOTH the supervisor and the plan delete', () => {
  enableFk();
  rawInsertWorkspace('ws-r');
  rawInsertAgent('sup-ap', 'ws-r');
  rawInsertPlan('plan-ap');
  FakeBetterSqlite.rawRun(
    `INSERT INTO supervisor_active_plan (supervisor_id, plan_id) VALUES (?, ?)`, ['sup-ap', 'plan-ap']);
  assert.equal(FakeBetterSqlite.rawAll(`SELECT COUNT(*) AS n FROM supervisor_active_plan`)[0].n, 1);
  // Supervisor delete → active-plan row cascades away.
  FakeBetterSqlite.rawRun(`DELETE FROM agents WHERE id=?`, ['sup-ap']);
  assert.equal(FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM supervisor_active_plan WHERE supervisor_id='sup-ap'`)[0].n, 0,
    'supervisor delete must cascade the active-plan row');

  // Now the plan-side cascade: re-add and delete the plan instead.
  rawInsertAgent('sup-ap2', 'ws-r');
  FakeBetterSqlite.rawRun(
    `INSERT INTO supervisor_active_plan (supervisor_id, plan_id) VALUES (?, ?)`, ['sup-ap2', 'plan-ap']);
  FakeBetterSqlite.rawRun(`DELETE FROM plans WHERE id=?`, ['plan-ap']);
  assert.equal(FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM supervisor_active_plan WHERE plan_id='plan-ap'`)[0].n, 0,
    'plan delete must cascade the active-plan row');
});

test('supervisor_focus keeps its existing cascade on supervisor and plan delete', () => {
  enableFk();
  rawInsertWorkspace('ws-r');
  rawInsertAgent('sup-f', 'ws-r');
  rawInsertPlan('plan-f');
  FakeBetterSqlite.rawRun(
    `INSERT INTO supervisor_focus (supervisor_id, plan_id) VALUES (?, ?)`, ['sup-f', 'plan-f']);
  FakeBetterSqlite.rawRun(`DELETE FROM agents WHERE id=?`, ['sup-f']);
  assert.equal(FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM supervisor_focus WHERE supervisor_id='sup-f'`)[0].n, 0,
    'supervisor delete must cascade supervisor_focus (unchanged existing behavior)');

  rawInsertAgent('sup-f2', 'ws-r');
  FakeBetterSqlite.rawRun(
    `INSERT INTO supervisor_focus (supervisor_id, plan_id) VALUES (?, ?)`, ['sup-f2', 'plan-f']);
  FakeBetterSqlite.rawRun(`DELETE FROM plans WHERE id=?`, ['plan-f']);
  assert.equal(FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM supervisor_focus WHERE plan_id='plan-f'`)[0].n, 0,
    'plan delete must cascade supervisor_focus');
});

test('plan_tab_overviews round-trips with a revision; PK(plan_id, tab) rejects a duplicate', () => {
  enableFk();
  rawInsertWorkspace('ws-r');
  rawInsertPlan('plan-ov');
  FakeBetterSqlite.rawRun(
    `INSERT INTO plan_tab_overviews (plan_id, tab, body, revision, updated_by)
     VALUES (?, ?, ?, ?, ?)`, ['plan-ov', 'overview', 'first body', 3, 'sup-x']);
  const row = FakeBetterSqlite.rawAll(
    `SELECT body, revision FROM plan_tab_overviews WHERE plan_id='plan-ov' AND tab='overview'`)[0];
  assert.equal(row.body, 'first body');
  assert.equal(Number(row.revision), 3, 'the revision must round-trip');
  // Same (plan_id, tab) → PK rejects a second row.
  assert.throws(() => FakeBetterSqlite.rawRun(
    `INSERT INTO plan_tab_overviews (plan_id, tab, body) VALUES (?, ?, ?)`,
    ['plan-ov', 'overview', 'dup']), 'PK(plan_id, tab) must reject a duplicate');
  // A different tab under the same plan → allowed.
  FakeBetterSqlite.rawRun(
    `INSERT INTO plan_tab_overviews (plan_id, tab, body) VALUES (?, ?, ?)`,
    ['plan-ov', 'design', 'design body']);
  assert.equal(FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM plan_tab_overviews WHERE plan_id='plan-ov'`)[0].n, 2);
});

test('plan_documents stores rel paths only (no body column) and CHECK bounds doc_kind', () => {
  enableFk();
  rawInsertWorkspace('ws-r');
  rawInsertPlan('plan-doc');
  const docCols = FakeBetterSqlite.rawAll(`PRAGMA table_info(plan_documents)`).map((r) => String(r.name));
  assert.ok(docCols.includes('rel_path'), 'plan_documents must store rel_path');
  assert.equal(docCols.includes('body'), false, 'plan_documents must NOT carry a body column');
  // The single §P3-GAP row shape — the source proposal.
  FakeBetterSqlite.rawRun(
    `INSERT INTO plan_documents (id, plan_id, workspace_id, doc_kind, rel_path)
     VALUES (?, ?, ?, ?, ?)`,
    ['doc-1', 'plan-doc', 'ws-r', 'proposal', '.lares/proposals/x.md']);
  // doc_kind CHECK rejects an out-of-set kind with no row.
  assert.throws(() => FakeBetterSqlite.rawRun(
    `INSERT INTO plan_documents (id, plan_id, workspace_id, doc_kind, rel_path)
     VALUES (?, ?, ?, ?, ?)`,
    ['doc-bad', 'plan-doc', 'ws-r', 'supplement', '.lares/x.md']),
    'CHECK(doc_kind) must reject an out-of-set value');
  // The three other allowed kinds are accepted.
  for (const k of ['deliberation', 'research', 'legacy-html']) {
    FakeBetterSqlite.rawRun(
      `INSERT INTO plan_documents (id, plan_id, workspace_id, doc_kind, rel_path)
       VALUES (?, ?, ?, ?, ?)`,
      [`doc-${k}`, 'plan-doc', 'ws-r', k, `.lares/x-${k}.md`]);
  }
});

test('re-running initDatabase is idempotent (P3A tables + column + data survive a double run)', () => {
  rawInsertWorkspace('ws-r');
  rawInsertPlan('plan-idem', { responsible_supervisor_id: null });
  const before = FakeBetterSqlite.rawAll(`SELECT COUNT(*) AS n FROM plans WHERE id='plan-idem'`)[0].n;
  dbm.initDatabase();
  const after = FakeBetterSqlite.rawAll(`SELECT COUNT(*) AS n FROM plans WHERE id='plan-idem'`)[0].n;
  assert.equal(after, before, 'a second migration pass must not throw (guarded ALTER) or drop data');
  // The column add is still single — the guarded ALTER did not duplicate it.
  const cols = FakeBetterSqlite.rawAll(`PRAGMA table_info(plans)`)
    .filter((r) => String(r.name) === 'responsible_supervisor_id');
  assert.equal(cols.length, 1, 'responsible_supervisor_id must exist exactly once after a double init');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'responsibility-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
