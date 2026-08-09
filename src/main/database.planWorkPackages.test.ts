// Save-card SC-WP-3A — plan_work_packages schema + CRUD + item-validity accessor.
//
//   npm run build:main
//   node dist/main/main/database.planWorkPackages.test.js

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

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
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
}

type PlanWorkPackage = {
  id: string;
  workspaceId: string;
  planId: string;
  intentId: string | null;
  title: string;
  acceptanceCondition: string | null;
  state: string;
  assigneeAgentId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  upsertPlanWorkPackage(pkg: PlanWorkPackage): void;
  getPlanWorkPackage(id: string): PlanWorkPackage | null;
  listPlanWorkPackages(planId: string): PlanWorkPackage[];
  planItemInPlan(workspaceId: string, planId: string, planItemId: string): boolean;
};

let dbm: DbModule;

function makePackage(over: Partial<PlanWorkPackage> = {}): PlanWorkPackage {
  return {
    id: 'wp-1', workspaceId: 'ws-1', planId: 'plan-1', intentId: null, title: 'Work package',
    acceptanceCondition: 'tests pass', state: 'ready', assigneeAgentId: null,
    revision: 1, createdAt: 1000, updatedAt: 1000,
    ...over,
  };
}

test('CRUD round-trips a package and lists it under its plan', () => {
  const pkg = makePackage({ id: 'wp-crud', planId: 'plan-crud' });
  dbm.upsertPlanWorkPackage(pkg);
  assert.deepEqual(dbm.getPlanWorkPackage('wp-crud'), pkg);
  assert.deepEqual(dbm.listPlanWorkPackages('plan-crud'), [pkg]);
  assert.deepEqual(dbm.listPlanWorkPackages('plan-none'), []);
});

test('upsert updates mutable fields in place and never duplicates the row', () => {
  const pkg = makePackage({ id: 'wp-upsert', planId: 'plan-upsert' });
  dbm.upsertPlanWorkPackage(pkg);
  dbm.upsertPlanWorkPackage({
    ...pkg, title: 'renamed', state: 'executing', assigneeAgentId: 'agent-x',
    revision: 2, updatedAt: 2000,
  });
  const after = dbm.getPlanWorkPackage('wp-upsert');
  assert.deepEqual(
    { title: after?.title, state: after?.state, assigneeAgentId: after?.assigneeAgentId, revision: after?.revision },
    { title: 'renamed', state: 'executing', assigneeAgentId: 'agent-x', revision: 2 },
  );
  assert.equal(dbm.listPlanWorkPackages('plan-upsert').length, 1);
});

test('planItemInPlan validates against the full (workspace_id, plan_id, id) tuple', () => {
  dbm.upsertPlanWorkPackage(makePackage({ id: 'wp-valid', workspaceId: 'ws-9', planId: 'plan-9' }));
  assert.equal(dbm.planItemInPlan('ws-9', 'plan-9', 'wp-valid'), true);
  // Any single axis mismatch is a miss — never an always-true seam.
  assert.equal(dbm.planItemInPlan('ws-other', 'plan-9', 'wp-valid'), false, 'wrong workspace');
  assert.equal(dbm.planItemInPlan('ws-9', 'plan-other', 'wp-valid'), false, 'wrong plan');
  assert.equal(dbm.planItemInPlan('ws-9', 'plan-9', 'wp-missing'), false, 'missing id');
});

test('an archived package is still a valid stamp target', () => {
  dbm.upsertPlanWorkPackage(makePackage({ id: 'wp-archived', workspaceId: 'ws-a', planId: 'plan-a', state: 'archived' }));
  assert.equal(dbm.planItemInPlan('ws-a', 'plan-a', 'wp-archived'), true);
});

test('the state CHECK rejects an unknown lifecycle state with no row', () => {
  assert.throws(() => dbm.upsertPlanWorkPackage(makePackage({ id: 'wp-badstate', state: 'in-progress' })));
  assert.equal(dbm.getPlanWorkPackage('wp-badstate'), null);
});

test('the revision CHECK rejects a non-positive revision with no row', () => {
  assert.throws(() => dbm.upsertPlanWorkPackage(makePackage({ id: 'wp-badrev', revision: 0 })));
  assert.equal(dbm.getPlanWorkPackage('wp-badrev'), null);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-wp-'));
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
