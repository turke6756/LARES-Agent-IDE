// Planning-surface WP-P2L-schema — planning-intent LEDGER DDL: plan_intents +
// plan_intent_outputs (observation-only) + orchestrations.planning_intent_id link.
// DDL idempotency + constraint proofs (identity, composite same-plan FK, guarded
// column/index, no run-state / author duplication).
//
//   npm run build:main
//   node dist/main/main/plan-intents.schema.test.js

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
// store behind the better-sqlite3 surface database.ts calls. NOTE: pragma() is a
// deliberate no-op here, so database.ts's `db.pragma('foreign_keys = ON')` does
// NOT reach sql.js — the FK-enforcement test enables it directly via rawExec.
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

  // Raw access to the live store for schema-level assertions + inserts the accessor
  // layer does not surface (WP-P2L-schema is DDL-only: no ingest, no accessors).
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

// Raw insert of a plan_intents row (no accessor exists — that is WP-P2L-ingest).
function rawInsertIntent(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'pi-1', workspace_id: 'ws-1', plan_id: 'plan-1', plan_artifact_id: 'art-1',
    intent_id: 'intent-1', part_slug: null, kind: 'groupthink-serial', targets_json: null,
    reason: null, source_doc_rel_path: '.lares/plans/x/plan.md', status: 'active',
    supersedes_intent_id: null, integration_note: null,
    first_seen_at: 1000, updated_at: 1000, last_scanned_at: 1000,
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO plan_intents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

// Raw insert of a plan_intent_outputs observation row.
function rawInsertOutput(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    plan_id: 'plan-1', intent_id: 'intent-1', rel_path: '.lares/plans/x/out.md',
    orchestration_id: null, present_on_disk: 1, disposition: 'active', folded_in: 0,
    first_seen_at: 1000, last_present_at: 1000, last_scanned_at: 1000,
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO plan_intent_outputs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

test('plan_intents + plan_intent_outputs tables and the orchestration index exist', () => {
  const tables = FakeBetterSqlite.rawAll(
    `SELECT name FROM sqlite_master WHERE type='table'`).map((r) => String(r.name));
  assert.ok(tables.includes('plan_intents'), 'plan_intents table must exist');
  assert.ok(tables.includes('plan_intent_outputs'), 'plan_intent_outputs table must exist');
  const indexes = FakeBetterSqlite.rawAll(
    `SELECT name FROM sqlite_master WHERE type='index'`).map((r) => String(r.name));
  assert.ok(indexes.includes('idx_orchestrations_plan_intent'),
    'idx_orchestrations_plan_intent must exist');
});

test('orchestrations carries the guarded planning_intent_id column + composite index', () => {
  const cols = FakeBetterSqlite.rawAll(`PRAGMA table_info(orchestrations)`).map((r) => String(r.name));
  assert.ok(cols.includes('planning_intent_id'), 'orchestrations must have planning_intent_id');
  // The `ran` join is on BOTH columns — index must be over (plan_id, planning_intent_id).
  const idxCols = FakeBetterSqlite.rawAll(`PRAGMA index_info(idx_orchestrations_plan_intent)`)
    .map((r) => String(r.name));
  assert.deepEqual(idxCols, ['plan_id', 'planning_intent_id'],
    'index must be over (plan_id, planning_intent_id) in order');
});

test('identity is UNIQUE(plan_id, intent_id) — same pair rejected, same intent_id in another plan allowed', () => {
  rawInsertIntent({ id: 'pi-id-1', plan_id: 'plan-A', intent_id: 'i1' });
  // Same (plan_id, intent_id) → rejected even with a distinct primary-key id.
  assert.throws(() => rawInsertIntent({ id: 'pi-id-2', plan_id: 'plan-A', intent_id: 'i1' }));
  // Same intent_id under a DIFFERENT plan → allowed (intent_id is unique only within a plan).
  rawInsertIntent({ id: 'pi-id-3', plan_id: 'plan-B', intent_id: 'i1' });
});

test('composite FK is same-plan only — a cross-plan output insert is rejected', () => {
  // pragma() is a no-op through the fake, so enable FK enforcement on the raw store.
  FakeBetterSqlite.rawExec(`PRAGMA foreign_keys = ON`);
  rawInsertIntent({ id: 'pi-fk-1', plan_id: 'plan-FK', intent_id: 'ifk' });
  // Same-plan output → parent (plan-FK, ifk) exists → accepted.
  rawInsertOutput({ plan_id: 'plan-FK', intent_id: 'ifk', rel_path: 'out-ok.md' });
  // Cross-plan: intent_id matches but plan_id does not → no matching parent → rejected.
  assert.throws(() => rawInsertOutput({ plan_id: 'plan-OTHER', intent_id: 'ifk', rel_path: 'out-bad.md' }));
});

test('CHECK constraints reject bad kind / status / boolean-domain values', () => {
  assert.throws(() => rawInsertIntent({ id: 'pi-bk', plan_id: 'plan-chk', intent_id: 'k', kind: 'execution' }));
  assert.throws(() => rawInsertIntent({ id: 'pi-bs', plan_id: 'plan-chk', intent_id: 's', status: 'complete' }));
  rawInsertIntent({ id: 'pi-okc', plan_id: 'plan-chk', intent_id: 'ok', kind: 'research', status: 'withdrawn' });
  // Output-side domain CHECKs.
  assert.throws(() => rawInsertOutput({ plan_id: 'plan-chk', intent_id: 'ok', rel_path: 'a.md', present_on_disk: 2 }));
  assert.throws(() => rawInsertOutput({ plan_id: 'plan-chk', intent_id: 'ok', rel_path: 'b.md', folded_in: 5 }));
  assert.throws(() => rawInsertOutput({ plan_id: 'plan-chk', intent_id: 'ok', rel_path: 'c.md', disposition: 'merged' }));
});

test('the ledger duplicates NO author attribution and NO orchestration run-state', () => {
  const intentCols = FakeBetterSqlite.rawAll(`PRAGMA table_info(plan_intents)`).map((r) => String(r.name));
  const outputCols = FakeBetterSqlite.rawAll(`PRAGMA table_info(plan_intent_outputs)`).map((r) => String(r.name));
  // Authorship stays the proposal record's — never copied into the ledger.
  for (const c of ['author_agent_id', 'author_role', 'author_display']) {
    assert.equal(intentCols.includes(c), false, `plan_intents must not carry ${c}`);
    assert.equal(outputCols.includes(c), false, `plan_intent_outputs must not carry ${c}`);
  }
  // Single run-state authority is `orchestrations` — no mutable run-state is copied.
  // (orchestration_id on outputs is an ALLOWED self-declared cross-check, not run-state.)
  for (const c of ['run_state', 'dispatched', 'running', 'abandoned', 'status_live', 'plan_binding_mode']) {
    assert.equal(outputCols.includes(c), false, `plan_intent_outputs must not copy run-state column ${c}`);
  }
  assert.ok(outputCols.includes('orchestration_id'),
    'plan_intent_outputs keeps orchestration_id as a self-declared cross-check');
  // plan_id is NOT NULL — P2L depends on P2 folder adoption producing the plans row.
  const planIdCol = FakeBetterSqlite.rawAll(`PRAGMA table_info(plan_intents)`)
    .find((r) => String(r.name) === 'plan_id');
  assert.equal(Number(planIdCol?.notnull), 1, 'plan_intents.plan_id must be NOT NULL');
});

test('re-running initDatabase is idempotent (tables + indexes + data survive a double run)', () => {
  rawInsertIntent({ id: 'pi-idem', plan_id: 'plan-idem', intent_id: 'idem' });
  const before = FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM plan_intents WHERE id='pi-idem'`)[0].n;
  dbm.initDatabase();
  const after = FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM plan_intents WHERE id='pi-idem'`)[0].n;
  assert.equal(after, before, 'a second migration pass must not throw or drop data');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-intents-'));
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

  try { dbm.createWorkspace({ title: 'ws-1', path: tmpAppData, pathType: 'local' }); } catch { /* best-effort */ }

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
