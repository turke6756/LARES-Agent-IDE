// WP-B: companion schema, runtime ownership, and atomic disk reconciliation.
//
//   npm run build:main
//   node dist/main/main/database.planWorkPackageReconciliation.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean; step(): boolean;
    getAsObject(): Record<string, unknown>; free(): boolean;
  };
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
  pragma(_sql: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params); const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

type PackageInput = {
  id: string; sourceLocalId: string; title: string; acceptanceCondition: string | null;
  declaredState: 'ready' | 'blocked'; contentHash: string; sortOrder: number;
  paths: { path: string; intentKind?: string | null }[];
};
type MutationStage = 'plan-demotion' | 'packages' | 'paths' | 'layout' | 'lifecycle'
  | 'sources' | 'projection-state';
type DbModule = typeof import('./database');
let dbm: DbModule;
let seq = 0;

function context(runState = 'hardening') {
  seq += 1;
  const workspace = dbm.createWorkspace({
    title: `ws-${seq}`, path: `C:/wp-reconcile-${seq}`, pathType: 'windows',
  });
  const plan = dbm.createOrRevivePlan({ workspaceId: workspace.id,
    path: `.lares/plans/plan-${seq}`, format: 'structured', runState });
  return { workspaceId: workspace.id, planId: plan.id };
}

function pkg(over: Partial<PackageInput> = {}): PackageInput {
  return {
    id: `pkg-${seq}-a`, sourceLocalId: 'WP-A', title: 'Package A',
    acceptanceCondition: 'A passes', declaredState: 'ready', contentHash: 'hash-a-v1',
    sortOrder: 0, paths: [{ path: 'src/a.ts', intentKind: 'edit' }], ...over,
  };
}

function apply(ctx: ReturnType<typeof context>, packages: PackageInput[], over: Record<string, unknown> = {}) {
  return dbm.applyPlanWorkPackageSnapshot({ workspaceId: ctx.workspaceId, planId: ctx.planId,
    sourceRelPath: 'supplements/work-packages.md', projectionHash: 'projection-1',
    packages, reconciledAt: 1000 + seq, ...over });
}

function rawRows(sql: string, params: unknown[] = []): unknown[] {
  return dbm.getDb().prepare(sql).all(...params) as unknown[];
}

function snapshot(planId: string): string {
  const packageIds = rawRows('SELECT id FROM plan_work_packages WHERE plan_id = ? ORDER BY id', [planId])
    .map((row) => (row as { id: string }).id);
  const marks = packageIds.map(() => '?').join(',');
  const byPackages = (table: string, order: string) => packageIds.length === 0 ? []
    : rawRows(`SELECT * FROM ${table} WHERE package_id IN (${marks}) ORDER BY ${order}`, packageIds);
  return JSON.stringify({
    plan: rawRows('SELECT id, run_state FROM plans WHERE id = ?', [planId]),
    packages: rawRows('SELECT * FROM plan_work_packages WHERE plan_id = ? ORDER BY id', [planId]),
    layout: byPackages('plan_work_package_layout', 'package_id'),
    paths: byPackages('plan_work_package_paths', 'package_id, path'),
    lifecycle: byPackages('plan_wp_lifecycle_events', 'package_id, ts, id'),
    sources: rawRows('SELECT * FROM plan_work_package_sources WHERE plan_id = ? ORDER BY package_id', [planId]),
    projection: rawRows('SELECT * FROM plan_folder_projection_state WHERE plan_id = ?', [planId]),
  });
}

test('schema adds both companions and overview columns without changing the frozen package shape', () => {
  const columns = (table: string) => rawRows(`PRAGMA table_info(${table})`)
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(columns('plan_work_packages'), [
    'id', 'workspace_id', 'plan_id', 'title', 'acceptance_condition', 'state',
    'assignee_agent_id', 'revision', 'created_at', 'updated_at',
  ]);
  assert.deepEqual(columns('plan_work_package_sources'), [
    'package_id', 'workspace_id', 'plan_id', 'source_rel_path', 'source_local_id',
    'source_format', 'applied_hash', 'observed_hash', 'applied_order', 'observed_order',
    'declared_state', 'reconcile_state', 'present', 'tombstoned_at', 'first_seen_at',
    'last_seen_at',
  ]);
  const projection = columns('plan_folder_projection_state');
  for (const name of ['overview_status', 'overview_source_hash', 'overview_diagnostics_json',
    'overview_reconciled_at', 'overview_adoption_state']) assert.ok(projection.includes(name), name);
});

test('initial apply creates managed packages, paths and order with synced provenance', () => {
  const ctx = context();
  const a = pkg();
  const b = pkg({ id: `pkg-${seq}-b`, sourceLocalId: 'WP-B', title: 'Package B',
    contentHash: 'hash-b-v1', sortOrder: 1, declaredState: 'blocked',
    paths: [{ path: 'src/b.ts', intentKind: 'create' }] });
  assert.deepEqual(apply(ctx, [a, b]), { status: 'applied', diagnostics: [], demotedToHardening: false });
  assert.deepEqual(dbm.listManagedPlanWorkPackages(ctx.planId).map((entry) => ({
    id: entry.package.id, state: entry.package.state, revision: entry.package.revision,
    order: entry.source.appliedOrder, present: entry.source.present,
  })), [
    { id: a.id, state: 'ready', revision: 1, order: 0, present: true },
    { id: b.id, state: 'blocked', revision: 1, order: 1, present: true },
  ]);
  assert.deepEqual(dbm.listPlanWorkPackagePaths(a.id).map((entry) => entry.path), ['src/a.ts']);
  assert.equal(dbm.getPlanFolderProjectionState(ctx.planId)?.wpStatus, 'synced');
});

test('order-only drift updates layout and provenance without incrementing revision', () => {
  const ctx = context();
  const a = pkg();
  const b = pkg({ id: `pkg-${seq}-b`, sourceLocalId: 'WP-B', contentHash: 'hash-b', sortOrder: 1 });
  apply(ctx, [a, b]);
  apply(ctx, [{ ...a, sortOrder: 1 }, { ...b, sortOrder: 0 }], { projectionHash: 'projection-2' });
  assert.equal(dbm.getPlanWorkPackage(a.id)?.revision, 1);
  assert.equal(dbm.getPlanWorkPackage(b.id)?.revision, 1);
  assert.deepEqual(dbm.listPlanWorkPackagesOrdered(ctx.planId).map((entry) => entry.id), [b.id, a.id]);
});

test('semantic state change uses the disk lifecycle ledger and increments revision once', () => {
  const ctx = context();
  const a = pkg();
  apply(ctx, [a]);
  apply(ctx, [{ ...a, title: 'Package A revised', declaredState: 'blocked',
    contentHash: 'hash-a-v2' }], { projectionHash: 'projection-2' });
  assert.equal(dbm.getPlanWorkPackage(a.id)?.revision, 2);
  assert.equal(dbm.getPlanWorkPackage(a.id)?.state, 'blocked');
  assert.deepEqual(dbm.listPlanWpLifecycleEvents(a.id).map((event) =>
    ({ actor: event.actor, from: event.fromState, to: event.toState })),
  [{ actor: 'disk-reconciler', from: 'ready', to: 'blocked' }]);
});

test('valid omission tombstones without deleting and a pristine reappearance restores', () => {
  const ctx = context();
  const a = pkg();
  apply(ctx, [a]);
  apply(ctx, [], { projectionHash: 'projection-empty', reconciledAt: 2000 + seq });
  assert.equal(dbm.getPlanWorkPackage(a.id)?.state, 'archived');
  assert.deepEqual(dbm.listManagedPlanWorkPackages(ctx.planId).map((entry) => ({
    present: entry.source.present, state: entry.source.reconcileState,
  })), [{ present: false, state: 'missing-pristine' }]);
  apply(ctx, [a], { projectionHash: 'projection-restored', reconciledAt: 3000 + seq });
  assert.equal(dbm.getPlanWorkPackage(a.id)?.state, 'ready');
  assert.equal(dbm.getPlanWorkPackage(a.id)?.revision, 1);
  assert.equal(dbm.listPlanWpLifecycleEvents(a.id).length, 2);
});

test('safe ready-plan change applies atomically and demotes to hardening', () => {
  const ctx = context();
  const a = pkg();
  apply(ctx, [a]);
  dbm.updatePlan(ctx.planId, { runState: 'ready' });
  const result = apply(ctx, [{ ...a, contentHash: 'hash-a-v2', title: 'Changed' }],
    { projectionHash: 'projection-2' });
  assert.equal(result.demotedToHardening, true);
  assert.equal(dbm.getPlan(ctx.planId)?.runState, 'hardening');
});

test('runtime-owned conflict preserves applied state and records only observed drift', () => {
  const ctx = context();
  const a = pkg();
  const b = pkg({ id: `pkg-${seq}-b`, sourceLocalId: 'WP-B', title: 'Package B',
    contentHash: 'hash-b', sortOrder: 1 });
  apply(ctx, [a, b]);
  const agent = dbm.createAgent({ workspaceId: ctx.workspaceId, title: 'A', roleDescription: '',
    workingDirectory: 'C:/w', command: 'x', tmuxSessionName: null,
    autoRestartEnabled: false, logPath: 'l' });
  dbm.assignPlanWorkPackage(a.id, agent.id, 1500);
  const before = {
    pkg: dbm.getPlanWorkPackage(a.id), paths: dbm.listPlanWorkPackagePaths(a.id),
    layout: dbm.getPlanWorkPackageLayoutOrder(a.id), lifecycle: dbm.listPlanWpLifecycleEvents(a.id),
    runState: dbm.getPlan(ctx.planId)?.runState,
  };
  const result = apply(ctx, [{ ...a, title: 'Hostile overwrite', declaredState: 'blocked',
    contentHash: 'hash-a-drift', sortOrder: 4, paths: [{ path: 'src/drift.ts' }] }, b],
    { projectionHash: 'projection-drift' });
  assert.equal(result.status, 'conflict');
  assert.ok(result.diagnostics.some((value) => value.startsWith('runtime-owned-change:')));
  assert.deepEqual({ pkg: dbm.getPlanWorkPackage(a.id), paths: dbm.listPlanWorkPackagePaths(a.id),
    layout: dbm.getPlanWorkPackageLayoutOrder(a.id), lifecycle: dbm.listPlanWpLifecycleEvents(a.id),
    runState: dbm.getPlan(ctx.planId)?.runState }, before);
  const managed = dbm.listManagedPlanWorkPackages(ctx.planId);
  const source = managed.find((entry) => entry.package.id === a.id)!.source;
  assert.equal(source.appliedHash, a.contentHash);
  assert.equal(source.observedHash, 'hash-a-drift');
  assert.equal(source.appliedOrder, 0);
  assert.equal(source.observedOrder, 4);
  assert.equal(source.reconcileState, 'drift-conflict');
  assert.equal(managed.find((entry) => entry.package.id === b.id)!.source.reconcileState, 'synced');
  assert.equal(dbm.getPlanFolderProjectionState(ctx.planId)?.wpStatus, 'conflict');
  assert.equal(dbm.getPlanFolderProjectionState(ctx.planId)?.wpProjectionHash, 'projection-1');
});

test('unmanaged package causes conflict and is never adopted or deleted', () => {
  const ctx = context();
  const a = pkg();
  dbm.upsertPlanWorkPackage({ id: `manual-${seq}`, workspaceId: ctx.workspaceId,
    planId: ctx.planId, title: 'Manual', acceptanceCondition: null, state: 'ready',
    assigneeAgentId: null, revision: 1, createdAt: 1, updatedAt: 1 });
  const result = apply(ctx, [a]);
  assert.equal(result.status, 'conflict');
  assert.equal(dbm.listUnmanagedPlanWorkPackages(ctx.planId).length, 1);
  assert.equal(dbm.getPlanWorkPackage(a.id), null);
});

test('runtime evidence ignores reconciler lifecycle but detects immutable package stamps', () => {
  const ctx = context();
  const a = pkg();
  apply(ctx, [a]);
  dbm.getDb().prepare(
    `INSERT INTO plan_wp_lifecycle_events
       (id, package_id, plan_id, from_state, to_state, actor, reason, ts)
     VALUES (?, ?, ?, 'ready', 'blocked', 'disk-reconciler', NULL, 1)`,
  ).run(`disk-event-${seq}`, a.id, ctx.planId);
  let evidence = dbm.getPlanWorkPackageRuntimeEvidence(a.id);
  assert.equal(evidence.nonReconcilerLifecycle, false);
  assert.equal(evidence.runtimeOwned, false);
  dbm.getDb().prepare(
    `INSERT INTO turn_records
       (id, workspace_id, turn_seq, status, plan_id, plan_item_id, plan_stamp_source)
     VALUES (?, ?, 1, 'open', ?, ?, 'explicit')`,
  ).run(`turn-${seq}`, ctx.workspaceId, ctx.planId, a.id);
  evidence = dbm.getPlanWorkPackageRuntimeEvidence(a.id);
  assert.equal(evidence.stampedTurn, true);
  assert.equal(evidence.runtimeOwned, true);
});

test('every mutation-stage fault rolls back the entire applied snapshot', () => {
  const stages: MutationStage[] = ['plan-demotion', 'packages', 'paths', 'layout',
    'lifecycle', 'sources', 'projection-state'];
  for (const stage of stages) {
    const ctx = context();
    const a = pkg();
    apply(ctx, [a]);
    dbm.updatePlan(ctx.planId, { runState: 'ready' });
    const before = snapshot(ctx.planId);
    assert.throws(() => apply(ctx, [{ ...a, title: 'Changed', declaredState: 'blocked',
      contentHash: 'hash-a-v2', sortOrder: 1, paths: [{ path: 'src/changed.ts' }] },
    pkg({ id: `pkg-${seq}-b`, sourceLocalId: 'WP-B', title: 'New', contentHash: 'hash-b',
      sortOrder: 0, paths: [{ path: 'src/b.ts' }] })], {
      projectionHash: 'projection-2', reconciledAt: 5000 + seq,
      afterMutationStage: (observed: MutationStage) => {
        if (observed === stage) throw new Error(`fault:${stage}`);
      },
    }), new RegExp(`fault:${stage}`));
    assert.equal(snapshot(ctx.planId), before, `rollback after ${stage}`);
  }
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-wp-reconcile-'));
  process.env.APPDATA = tmpAppData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
    exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
