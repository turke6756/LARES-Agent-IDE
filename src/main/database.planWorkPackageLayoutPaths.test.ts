// Planning-surface WP-P5A — work-package layout companion + planned-path store.
// Covers plan_work_package_layout ordering + same-workspace assignee validation
// (WP-P5A-schema) and plan_work_package_paths populate/read (WP-P5A-paths).
//
//   npm run build:main
//   node dist/main/main/database.planWorkPackageLayoutPaths.test.js

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
  title: string;
  acceptanceCondition: string | null;
  state: string;
  assigneeAgentId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
type PlanWorkPackagePath = {
  packageId: string;
  workspaceId: string;
  path: string;
  intentKind: string | null;
  createdAt: number;
};
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: {
    workspaceId: string; title: string; roleDescription: string;
    workingDirectory: string; command: string; tmuxSessionName: string | null;
    autoRestartEnabled: boolean; logPath: string;
  }): { id: string };
  upsertPlanWorkPackage(pkg: PlanWorkPackage): void;
  getPlanWorkPackage(id: string): PlanWorkPackage | null;
  setPlanWorkPackageLayout(packageId: string, sortOrder: number): void;
  getPlanWorkPackageLayoutOrder(packageId: string): number | null;
  reorderPlanWorkPackages(planId: string, orderedPackageIds: string[]): void;
  listPlanWorkPackagesOrdered(planId: string): PlanWorkPackage[];
  assignPlanWorkPackage(packageId: string, agentId: string | null, updatedAt: number): void;
  setPlanWorkPackagePaths(
    packageId: string, workspaceId: string,
    entries: { path: string; intentKind?: string | null }[], createdAt: number,
  ): void;
  listPlanWorkPackagePaths(packageId: string): PlanWorkPackagePath[];
};

let dbm: DbModule;

let seq = 0;
function makePackage(over: Partial<PlanWorkPackage> = {}): PlanWorkPackage {
  seq += 1;
  return {
    id: `wp-${seq}`, workspaceId: 'ws-1', planId: 'plan-1', title: 'Work package',
    acceptanceCondition: null, state: 'ready', assigneeAgentId: null,
    revision: 1, createdAt: 1000, updatedAt: 1000,
    ...over,
  };
}

// ── plan_work_package_layout (WP-P5A-schema) ──────────────────────────────────

test('reorder writes a dense 0..n-1 sort_order and listOrdered honours it', () => {
  const plan = 'plan-order';
  const a = makePackage({ planId: plan, createdAt: 100 });
  const b = makePackage({ planId: plan, createdAt: 200 });
  const c = makePackage({ planId: plan, createdAt: 300 });
  [a, b, c].forEach(dbm.upsertPlanWorkPackage);
  // Requested order is the reverse of creation order.
  dbm.reorderPlanWorkPackages(plan, [c.id, b.id, a.id]);
  assert.deepEqual(
    [dbm.getPlanWorkPackageLayoutOrder(c.id), dbm.getPlanWorkPackageLayoutOrder(b.id), dbm.getPlanWorkPackageLayoutOrder(a.id)],
    [0, 1, 2],
  );
  assert.deepEqual(dbm.listPlanWorkPackagesOrdered(plan).map((p) => p.id), [c.id, b.id, a.id]);
});

test('a package with no layout row sorts after laid-out ones, by created_at', () => {
  const plan = 'plan-mixed';
  const laid = makePackage({ planId: plan, createdAt: 500 });
  const bare1 = makePackage({ planId: plan, createdAt: 100 });
  const bare2 = makePackage({ planId: plan, createdAt: 200 });
  [laid, bare1, bare2].forEach(dbm.upsertPlanWorkPackage);
  dbm.setPlanWorkPackageLayout(laid.id, 0);
  // laid first (explicit slot), then the two bare rows by created_at ascending.
  assert.deepEqual(
    dbm.listPlanWorkPackagesOrdered(plan).map((p) => p.id),
    [laid.id, bare1.id, bare2.id],
  );
});

test('reorder ignores an id that does not belong to the plan (no reparent)', () => {
  const mine = makePackage({ planId: 'plan-mine', createdAt: 100 });
  const foreign = makePackage({ planId: 'plan-other', createdAt: 100 });
  [mine, foreign].forEach(dbm.upsertPlanWorkPackage);
  dbm.reorderPlanWorkPackages('plan-mine', [foreign.id, mine.id]);
  // Foreign id skipped → mine takes slot 0; foreign never gets a layout row.
  assert.equal(dbm.getPlanWorkPackageLayoutOrder(mine.id), 0);
  assert.equal(dbm.getPlanWorkPackageLayoutOrder(foreign.id), null);
});

test('setPlanWorkPackageLayout upserts the slot in place', () => {
  const pkg = makePackage();
  dbm.upsertPlanWorkPackage(pkg);
  dbm.setPlanWorkPackageLayout(pkg.id, 7);
  assert.equal(dbm.getPlanWorkPackageLayoutOrder(pkg.id), 7);
  dbm.setPlanWorkPackageLayout(pkg.id, 3);
  assert.equal(dbm.getPlanWorkPackageLayoutOrder(pkg.id), 3);
});

// ── same-workspace assignee validation (WP-P5A-schema) ────────────────────────

test('assign accepts a same-workspace agent and clears with null', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const agent = dbm.createAgent({
    workspaceId: ws.id, title: 'A', roleDescription: '', workingDirectory: 'C:/w',
    command: 'x', tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l',
  });
  const pkg = makePackage({ workspaceId: ws.id });
  dbm.upsertPlanWorkPackage(pkg);
  dbm.assignPlanWorkPackage(pkg.id, agent.id, 2000);
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.assigneeAgentId, agent.id);
  dbm.assignPlanWorkPackage(pkg.id, null, 3000);
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.assigneeAgentId, null);
});

test('assign rejects a cross-workspace agent and leaves the package unchanged', () => {
  const wsA = dbm.createWorkspace({ title: 'A', path: 'C:/a', pathType: 'windows' });
  const wsB = dbm.createWorkspace({ title: 'B', path: 'C:/b', pathType: 'windows' });
  const foreignAgent = dbm.createAgent({
    workspaceId: wsB.id, title: 'B', roleDescription: '', workingDirectory: 'C:/b',
    command: 'x', tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l',
  });
  const pkg = makePackage({ workspaceId: wsA.id });
  dbm.upsertPlanWorkPackage(pkg);
  assert.throws(() => dbm.assignPlanWorkPackage(pkg.id, foreignAgent.id, 2000));
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.assigneeAgentId, null);
});

test('assign throws for a missing package', () => {
  assert.throws(() => dbm.assignPlanWorkPackage('wp-nope', null, 2000));
});

// ── plan_work_package_paths (WP-P5A-paths) ────────────────────────────────────

test('set + list round-trips workspace-relative planned paths', () => {
  const pkg = makePackage({ workspaceId: 'ws-paths' });
  dbm.upsertPlanWorkPackage(pkg);
  dbm.setPlanWorkPackagePaths(pkg.id, 'ws-paths', [
    { path: 'src/main/foo.ts', intentKind: 'edit' },
    { path: 'src/main/bar.ts' },
  ], 1000);
  // Deterministic order is (created_at, path); equal created_at ⇒ path ascending.
  assert.deepEqual(dbm.listPlanWorkPackagePaths(pkg.id), [
    { packageId: pkg.id, workspaceId: 'ws-paths', path: 'src/main/bar.ts', intentKind: null, createdAt: 1000 },
    { packageId: pkg.id, workspaceId: 'ws-paths', path: 'src/main/foo.ts', intentKind: 'edit', createdAt: 1000 },
  ]);
});

test('populate is replace-semantics — a re-save clears prior rows', () => {
  const pkg = makePackage({ workspaceId: 'ws-rep' });
  dbm.upsertPlanWorkPackage(pkg);
  dbm.setPlanWorkPackagePaths(pkg.id, 'ws-rep', [{ path: 'a.ts' }, { path: 'b.ts' }], 1000);
  dbm.setPlanWorkPackagePaths(pkg.id, 'ws-rep', [{ path: 'c.ts' }], 2000);
  assert.deepEqual(dbm.listPlanWorkPackagePaths(pkg.id).map((p) => p.path), ['c.ts']);
});

test('an absolute or traversing path throws and rolls the whole populate back', () => {
  const pkg = makePackage({ workspaceId: 'ws-bad' });
  dbm.upsertPlanWorkPackage(pkg);
  dbm.setPlanWorkPackagePaths(pkg.id, 'ws-bad', [{ path: 'keep.ts' }], 500);
  for (const bad of ['/etc/passwd', 'C:/abs/x.ts', '..\\up.ts', '../up.ts', 'a\\b.ts', '']) {
    assert.throws(
      () => dbm.setPlanWorkPackagePaths(pkg.id, 'ws-bad', [{ path: 'ok.ts' }, { path: bad }], 600),
      new RegExp('workspace-relative'),
      `expected reject for ${JSON.stringify(bad)}`,
    );
  }
  // The failed populate never touched the prior row (transaction rollback).
  assert.deepEqual(dbm.listPlanWorkPackagePaths(pkg.id).map((p) => p.path), ['keep.ts']);
});

test('a duplicate path in one populate collapses to the last entry', () => {
  const pkg = makePackage({ workspaceId: 'ws-dup' });
  dbm.upsertPlanWorkPackage(pkg);
  dbm.setPlanWorkPackagePaths(pkg.id, 'ws-dup', [
    { path: 'dup.ts', intentKind: 'create' },
    { path: 'dup.ts', intentKind: 'delete' },
  ], 1000);
  assert.deepEqual(dbm.listPlanWorkPackagePaths(pkg.id), [
    { packageId: pkg.id, workspaceId: 'ws-dup', path: 'dup.ts', intentKind: 'delete', createdAt: 1000 },
  ]);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-wp-p5a-'));
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
