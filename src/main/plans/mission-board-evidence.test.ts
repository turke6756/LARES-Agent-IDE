// WP-P6A — mission-board evidence projection acceptance tests.
//
//   npm run build:main
//   node dist/main/main/plans/mission-board-evidence.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { projectMissionBoardEvidence } from './mission-board-evidence';
import { projectDurableStampedTrail, projectLiveStampedActivity } from './stamped-evidence-projection';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

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
        const statement = inner.prepare(sql);
        try { statement.bind(params); return statement.step() ? statement.getAsObject() : undefined; }
        finally { statement.free(); }
      },
      all: (...params: unknown[]) => {
        const statement = inner.prepare(sql);
        try {
          statement.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally { statement.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
  }
}

type DbModule = typeof import('../database');
let dbm: DbModule;

function fixture(label: string) {
  const workspaceId = dbm.createWorkspace({
    title: label, path: `C:/mission-board/${label}-${Math.random()}`, pathType: 'windows',
  }).id;
  const planId = `plan-${label}`;
  const now = Date.now();
  for (const [id, title] of [['pkg-a', 'Package A'], ['pkg-b', 'Package B']] as const) {
    dbm.upsertPlanWorkPackage({
      id: `${label}-${id}`, workspaceId, planId, title, acceptanceCondition: null,
      state: 'ready', assigneeAgentId: null, revision: 1, createdAt: now, updatedAt: now,
    });
  }
  const pkgA = `${label}-pkg-a`;
  const pkgB = `${label}-pkg-b`;
  dbm.setPlanWorkPackagePaths(pkgA, workspaceId, [
    { path: 'src/a.ts', intentKind: 'edit' }, { path: 'src/shared.ts', intentKind: 'edit' },
  ], now);
  dbm.setPlanWorkPackagePaths(pkgB, workspaceId, [
    { path: 'src/b.ts', intentKind: 'create' }, { path: 'src/shared.ts', intentKind: 'edit' },
  ], now);
  return { workspaceId, planId, pkgA, pkgB };
}

function project(s: ReturnType<typeof fixture>) {
  const turns = dbm.listTurnRecords(s.workspaceId, { limit: 200 });
  return projectMissionBoardEvidence({
    workspaceId: s.workspaceId,
    planId: s.planId,
    packages: dbm.listPlanWorkPackagesOrdered(s.planId),
    plannedPaths: dbm.listPlanWorkPackagesOrdered(s.planId)
      .flatMap((pkg) => dbm.listPlanWorkPackagePaths(pkg.id)),
    liveActivity: projectLiveStampedActivity(turns),
    durableTrail: projectDurableStampedTrail(turns, dbm.listRecoveryOperations(s.workspaceId)),
  });
}

test('verified package stamps and plan-only path companions map live witnessed touches', () => {
  const s = fixture('live');
  dbm.allocateAndInsertTurn(s.workspaceId, {
    id: 'live-direct', planId: s.planId, planItemId: s.pkgA,
    planStampSource: 'explicit', taskLabel: 'direct',
  });
  dbm.updateTurnRecord('live-direct', { touched: [
    { path: 'src/a.ts', op: 'write' }, { path: 'outside.ts', op: 'create' },
  ] });
  dbm.allocateAndInsertTurn(s.workspaceId, {
    id: 'live-companion', planId: s.planId, planStampSource: 'agent-default',
  });
  dbm.updateTurnRecord('live-companion', { touched: [
    { path: 'src/b.ts', op: 'create' }, { path: 'src/shared.ts', op: 'write' },
  ] });
  dbm.allocateAndInsertTurn(s.workspaceId, {
    id: 'live-unassigned', planId: s.planId, planStampSource: 'explicit',
  });
  dbm.updateTurnRecord('live-unassigned', { touched: [{ path: 'unplanned.ts', op: 'write' }] });

  const result = project(s);
  const byId = new Map(result.packages.map((pkg) => [pkg.packageId, pkg]));
  assert.deepEqual(byId.get(s.pkgA)?.liveActivity.map((turn) => ({
    id: turn.turnId, association: turn.association, paths: turn.touched.map((touch) => touch.path),
  })), [
    { id: 'live-direct', association: 'package-stamp', paths: ['src/a.ts', 'outside.ts'] },
    { id: 'live-companion', association: 'planned-path', paths: ['src/shared.ts'] },
  ]);
  assert.deepEqual(byId.get(s.pkgB)?.liveActivity.map((turn) => ({
    id: turn.turnId, paths: turn.touched.map((touch) => touch.path),
  })), [{ id: 'live-companion', paths: ['src/b.ts', 'src/shared.ts'] }]);
  assert.deepEqual(result.unassignedLiveActivity.map((turn) => turn.turnId), ['live-unassigned']);
  assert.equal(JSON.stringify(result).includes('"done"'), false);
  assert.equal(JSON.stringify(result).includes('"completion"'), false);
});

test('accepted distilled evidence and recovery events follow the source turn package', () => {
  const s = fixture('durable');
  const diffStats = { witnessed: { files: 1, insertions: 3, deletions: 1, binaryFiles: 0 } };
  dbm.allocateAndInsertTurn(s.workspaceId, {
    id: 'accepted-a', planId: s.planId, planItemId: s.pkgA,
    planStampSource: 'continuation-carry',
  });
  dbm.closeTurn('accepted-a', 'accepted', {
    touched: [{ path: 'src/a.ts', op: 'write' }], diffStats,
    compactDiff: 'diff --git a/src/a.ts b/src/a.ts', compactDiffProvenance: 'witnessed',
  }, 20);
  dbm.insertRecoveryOperation(s.workspaceId, {
    id: 'restore-a', kind: 'restore_paths', actor: 'supervisor', sourceTurnId: 'accepted-a',
    requestedPaths: ['src/a.ts'], completedPaths: ['src/a.ts'], status: 'completed', createdAt: 30,
  });
  dbm.insertRecoveryOperation(s.workspaceId, {
    id: 'revert-a', kind: 'revert_turn', actor: 'human-ipc', sourceTurnId: 'accepted-a',
    requestedPaths: ['src/a.ts'], status: 'failed', failureReason: 'drift', createdAt: 31,
  });
  dbm.insertRecoveryOperation(s.workspaceId, {
    id: 'ignored-whole-tree', kind: 'whole_tree', actor: 'supervisor',
    sourceTurnId: 'accepted-a', status: 'completed', createdAt: 32,
  });

  const result = project(s);
  const pkg = result.packages.find((entry) => entry.packageId === s.pkgA);
  assert.ok(pkg);
  assert.deepEqual(pkg.durableTurns[0]?.diffStats, diffStats);
  assert.equal(pkg.durableTurns[0]?.compactDiff, 'diff --git a/src/a.ts b/src/a.ts');
  assert.deepEqual(pkg.recoveryOperations.map((operation) => ({
    id: operation.operationId, kind: operation.kind, association: operation.association,
  })), [
    { id: 'restore-a', kind: 'restore_paths', association: 'source-turn' },
    { id: 'revert-a', kind: 'revert_turn', association: 'source-turn' },
  ]);
  assert.equal(result.packages.find((entry) => entry.packageId === s.pkgB)?.recoveryOperations.length, 0);
});

test('unstamped and unverified turns are annotated but never attributed to packages', () => {
  const s = fixture('annotations');
  dbm.allocateAndInsertTurn(s.workspaceId, { id: 'unstamped', planStampSource: 'explicit-none' });
  dbm.updateTurnRecord('unstamped', { touched: [{ path: 'src/a.ts', op: 'write' }] });
  const base = dbm.allocateAndInsertTurn(s.workspaceId, {
    id: 'verified-base', planId: s.planId, planStampSource: 'explicit',
  });
  const live = projectLiveStampedActivity([
    ...dbm.listTurnRecords(s.workspaceId, { limit: 200 }),
    { ...base, id: 'unverified', planStampSource: 'forged' as never,
      touched: [{ path: 'src/b.ts', op: 'create' }] },
  ]);
  const result = projectMissionBoardEvidence({
    workspaceId: s.workspaceId, planId: s.planId,
    packages: dbm.listPlanWorkPackagesOrdered(s.planId),
    plannedPaths: [
      ...dbm.listPlanWorkPackagePaths(s.pkgA), ...dbm.listPlanWorkPackagePaths(s.pkgB),
    ],
    liveActivity: live,
    durableTrail: projectDurableStampedTrail([], []),
  });
  assert.deepEqual(result.stampAnnotations.map((entry) => ({
    id: entry.turnId, status: entry.planStampStatus, attributed: entry.attributed,
  })), [
    { id: 'unstamped', status: 'unstamped', attributed: false },
    { id: 'unverified', status: 'unverified', attributed: false },
  ]);
  for (const pkg of result.packages) {
    assert.equal(pkg.liveActivity.some((turn) => turn.turnId === 'unstamped' || turn.turnId === 'unverified'), false);
  }
});

(async () => {
  const temporaryAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-board-evidence-'));
  process.env.APPDATA = temporaryAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();

  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`  ok  ${current.name}`); passed += 1; }
    catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  try { fs.rmSync(temporaryAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
