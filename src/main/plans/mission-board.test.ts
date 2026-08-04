// WP-P6B-query — real-SQL acceptance tests for mission-board card reads.
//
//   npm run build:main
//   node dist/main/main/plans/mission-board.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PlanWorkPackageState } from '../database';

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
let listMissionBoardCards: typeof import('./mission-board')['listMissionBoardCards'];
let listMissionBoardTimeline: typeof import('./mission-board')['listMissionBoardTimeline'];

function createPlan(label: string) {
  const workspaceId = dbm.createWorkspace({
    title: label, path: `C:/mission-board-query/${label}-${Math.random()}`, pathType: 'windows',
  }).id;
  const timestamp = Date.now();
  const plan = dbm.createOrRevivePlan({
    workspaceId, path: `.lares/plans/${label}/plan.md`, slug: label,
    format: 'structured', runState: 'executing', mtimeMs: timestamp, sizeBytes: 1,
  });
  return { workspaceId, planId: plan.id, timestamp };
}

function addPackage(
  fixture: ReturnType<typeof createPlan>,
  id: string,
  state: PlanWorkPackageState,
): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId: fixture.workspaceId, planId: fixture.planId, title: `Package ${id}`,
    acceptanceCondition: 'Tests pass', state, assigneeAgentId: null, revision: 3,
    createdAt: fixture.timestamp, updatedAt: fixture.timestamp,
  });
  dbm.setPlanWorkPackagePaths(
    id,
    fixture.workspaceId,
    [{ path: `src/${id}.ts`, intentKind: 'edit' }],
    fixture.timestamp,
  );
}

async function run(): Promise<void> {
  const temporaryAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-board-query-'));
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
  // Load the query only after replacing the native database module for this
  // real-SQL fixture.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  listMissionBoardCards = require('./mission-board').listMissionBoardCards;
  listMissionBoardTimeline = require('./mission-board').listMissionBoardTimeline;

  try {
    const fixture = createPlan('separation');
    addPackage(fixture, 'blocked-package', 'blocked');

    const before = listMissionBoardCards(fixture.planId);
    assert.equal(before.length, 1);
    assert.equal(before[0]?.state, 'blocked');
    assert.deepEqual(before[0]?.liveActivity, []);

    dbm.allocateAndInsertTurn(fixture.workspaceId, {
      id: 'fresh-live-turn', planId: fixture.planId, planItemId: 'blocked-package',
      planStampSource: 'explicit', taskLabel: 'fresh touch',
    });
    dbm.updateTurnRecord('fresh-live-turn', {
      touched: [{ path: 'src/blocked-package.ts', op: 'write' }],
    });

    // A second query sees the fresh open-turn touch, while structured state is
    // still exactly the non-done value stored before the activity appeared.
    const after = listMissionBoardCards(fixture.planId);
    assert.equal(after[0]?.state, 'blocked');
    assert.equal(dbm.getPlanWorkPackage('blocked-package')?.state, 'blocked');
    assert.deepEqual(after[0]?.liveActivity.map((activity) => ({
      turnId: activity.turnId,
      isActive: activity.isActive,
      paths: activity.touched.map((touch) => touch.path),
    })), [{ turnId: 'fresh-live-turn', isActive: true, paths: ['src/blocked-package.ts'] }]);
    assert.equal(Object.hasOwn(after[0]?.liveActivity[0] ?? {}, 'state'), false);
    assert.equal(JSON.stringify(after[0]?.liveActivity).includes('done'), false);
    console.log('  ok  fresh touches tick in without changing structured package state');

    // The IPC owns exactly one read handler. It adds no timer, subscription, or
    // write channel; those remain outside WP-P6B-query.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerMissionBoardIpc } = require('./plan-ipc') as typeof import('./plan-ipc');
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerMissionBoardIpc({
      handle: (channel, listener) => { handlers.set(channel, listener); },
    }, listMissionBoardCards, listMissionBoardTimeline);
    assert.deepEqual([...handlers.keys()], ['plan:board:list', 'plan:board:timeline']);
    const ipcResult = handlers.get('plan:board:list')?.({}, fixture.planId);
    assert.equal(Array.isArray(ipcResult), true);
    assert.equal((ipcResult as ReturnType<typeof listMissionBoardCards>)[0]?.state, 'blocked');
    assert.equal(handlers.get('plan:board:list')?.({}, ''), null);
    console.log('  ok  plan:board:list exposes the one-shot card query');

    dbm.transitionPlanWorkPackageState({
      eventId: 'lifecycle-executing', packageId: 'blocked-package',
      toState: 'executing', actor: 'supervisor', reason: 'dispatch confirmed',
      ts: fixture.timestamp + 30,
    });
    dbm.transitionPlanWorkPackageState({
      eventId: 'lifecycle-blocked', packageId: 'blocked-package',
      toState: 'blocked', actor: 'worker', reason: 'needs input',
      ts: fixture.timestamp + 40,
    });
    dbm.insertPackageFinalization({
      id: 'finalization-done', packageId: 'plan-package:blocked-package',
      repositoryKey: 'repo-1', finalizationKind: 'plan-package',
      planId: fixture.planId, planItemId: 'blocked-package', packageRevision: 1,
      finalizedAt: fixture.timestamp + 50, finalizedBy: 'supervisor',
      checkpointTurnId: 'fresh-live-turn', checkpointOid: 'a'.repeat(40),
      boundaryRef: 'refs/lares/finalizations/blocked-package/1', boundaryStatus: 'ready',
      lifecycleStatus: 'active', supersededByFinalizationId: null, releasedAt: null,
      memberManifestJson: '[]', contractVersion: 1, failureReason: null,
      createdFromWorkspaceId: fixture.workspaceId,
    });
    // A failed finalization attempt is durable audit data, but it never flipped
    // the package to done and must not be projected as a completion event.
    dbm.insertPackageFinalization({
      id: 'abandoned-finalization', packageId: 'plan-package:blocked-package',
      repositoryKey: 'repo-1', finalizationKind: 'plan-package',
      planId: fixture.planId, planItemId: 'blocked-package', packageRevision: 2,
      finalizedAt: fixture.timestamp + 45, finalizedBy: 'supervisor',
      checkpointTurnId: null, checkpointOid: 'b'.repeat(40), boundaryRef: null,
      boundaryStatus: 'unavailable', lifecycleStatus: 'abandoned',
      supersededByFinalizationId: null, releasedAt: null, memberManifestJson: '[]',
      contractVersion: 1, failureReason: 'ref failed', createdFromWorkspaceId: fixture.workspaceId,
    });

    const timeline = listMissionBoardTimeline(fixture.planId);
    assert.deepEqual(timeline.map((entry) => entry.packageId), ['blocked-package']);
    assert.deepEqual(timeline[0]?.events.map((event) => ({
      source: event.source, eventId: event.eventId, toState: event.toState,
    })), [
      { source: 'lifecycle', eventId: 'lifecycle-executing', toState: 'executing' },
      { source: 'lifecycle', eventId: 'lifecycle-blocked', toState: 'blocked' },
      { source: 'finalization', eventId: 'finalization-done', toState: 'done' },
    ]);
    assert.equal(dbm.getPlanWorkPackage('blocked-package')?.state, 'blocked');
    assert.deepEqual(handlers.get('plan:board:timeline')?.({}, fixture.planId), timeline);
    assert.equal(handlers.get('plan:board:timeline')?.({}, ''), null);
    console.log('  ok  timeline IPC orders lifecycle events before authoritative finalization-done');

    dbm.closeTurn('fresh-live-turn', 'accepted', {
      touched: [{ path: 'src/blocked-package.ts', op: 'write' }],
      diffStats: { witnessed: { files: 1 } },
      compactDiff: 'diff --git a/src/blocked-package.ts b/src/blocked-package.ts',
      compactDiffProvenance: 'witnessed',
    }, fixture.timestamp + 10);
    dbm.insertRecoveryOperation(fixture.workspaceId, {
      id: 'restore-live-turn', kind: 'restore_paths', actor: 'supervisor',
      sourceTurnId: 'fresh-live-turn', requestedPaths: ['src/blocked-package.ts'],
      completedPaths: ['src/blocked-package.ts'], status: 'completed',
      createdAt: fixture.timestamp + 20,
    });
    const durable = listMissionBoardCards(fixture.planId)[0];
    assert.deepEqual(durable?.liveActivity, []);
    assert.equal(durable?.state, 'blocked');
    assert.equal(durable?.durableTurns[0]?.turnId, 'fresh-live-turn');
    assert.equal(durable?.durableTurns[0]?.compactDiffProvenance, 'witnessed');
    assert.equal(durable?.recoveryOperations[0]?.operationId, 'restore-live-turn');
    console.log('  ok  durable P6A evidence is carried without becoming lifecycle state');

    const missing = listMissionBoardCards('missing-plan');
    assert.deepEqual(missing, []);
    console.log('  ok  missing plans produce an empty read-only board');
  } finally {
    const resolvedTemp = path.resolve(temporaryAppData);
    if (!resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error('refusing to remove non-temp fixture');
    }
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
