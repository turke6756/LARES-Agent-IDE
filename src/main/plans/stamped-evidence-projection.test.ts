// WP-SEP — pure stamped-evidence projection acceptance tests.
//
//   npm run build:main
//   node dist/main/main/plans/stamped-evidence-projection.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  projectDurableStampedTrail,
  projectLiveStampedActivity,
} from './stamped-evidence-projection';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
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
        const statement = inner.prepare(sql);
        try {
          statement.bind(params);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally { statement.free(); }
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
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }
}

type DbModule = typeof import('../database');
let dbm: DbModule;

function freshWorkspace(label: string): string {
  return dbm.createWorkspace({
    title: label,
    path: `C:/stamped-evidence/${label}-${Math.random()}`,
    pathType: 'windows',
  }).id;
}

test('live activity comes only from open, verified plan-stamped turns and carries witnessed touches', () => {
  const workspaceId = freshWorkspace('live');
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'live-stamped', agentId: 'agent-a', planId: 'plan-a', planItemId: 'pkg-a',
    planStampSource: 'explicit', taskLabel: 'Implement A', startedAt: 10,
  });
  dbm.updateTurnRecord('live-stamped', {
    touched: [
      { path: 'src/a.ts', op: 'write' },
      { path: 'src/ignored.ts', op: 'read' },
    ],
  });
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'live-no-touch', planId: 'plan-a', planStampSource: 'agent-default',
  });
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'live-explicit-none', planStampSource: 'explicit-none',
  });
  dbm.updateTurnRecord('live-explicit-none', {
    touched: [{ path: 'src/unbound.ts', op: 'create' }],
  });
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'live-unverified', planId: 'plan-a', planStampSource: 'unbound-manual',
  });
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'terminal-accepted', planId: 'plan-a', planStampSource: 'explicit',
  });
  dbm.closeTurn('terminal-accepted', 'accepted', {
    touched: [{ path: 'src/done.ts', op: 'write' }],
  }, 20);

  // Real legacy row: migration default is the annotation authority.
  dbm.getDb().prepare(
    `INSERT INTO turn_records (id, workspace_id, turn_seq, status, touched)
     VALUES (?, ?, ?, 'open', ?)`,
  ).run('live-legacy', workspaceId, 100, JSON.stringify([{ path: 'src/legacy.ts', op: 'write' }]));

  const live = projectLiveStampedActivity(dbm.listTurnRecords(workspaceId, { limit: 200 }));
  assert.deepEqual(live.map((entry) => ({
    id: entry.turnId,
    status: entry.planStampStatus,
    source: entry.planStampSource,
    isActive: entry.isActive,
    touched: entry.touched.map((touch) => touch.path),
  })), [
    { id: 'live-stamped', status: 'verified', source: 'explicit', isActive: true, touched: ['src/a.ts'] },
    { id: 'live-no-touch', status: 'verified', source: 'agent-default', isActive: true, touched: [] },
    { id: 'live-explicit-none', status: 'unstamped', source: 'explicit-none', isActive: false, touched: ['src/unbound.ts'] },
    { id: 'live-unverified', status: 'unverified', source: 'unbound-manual', isActive: false, touched: [] },
    { id: 'live-legacy', status: 'unstamped', source: 'legacy-unstamped', isActive: false, touched: ['src/legacy.ts'] },
  ]);
  assert.equal(live.some((entry) => entry.turnId === 'terminal-accepted'), false);
  for (const entry of live) {
    assert.equal('completion' in entry, false);
    assert.equal('done' in entry, false);
  }
});

test('durable trail reads accepted retention fields verbatim and recovery ledger rows', () => {
  const workspaceId = freshWorkspace('durable');
  const diffStats = {
    witnessed: { files: 1, insertions: 4, deletions: 2, binaryFiles: 0 },
    window: { files: 2, insertions: 8, deletions: 3, binaryFiles: 0 },
    compactDiffTruncated: false,
  };
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'durable-accepted', agentId: 'agent-b', planId: 'plan-b', planItemId: 'pkg-b',
    planStampSource: 'continuation-carry', startedAt: 30,
  });
  dbm.closeTurn('durable-accepted', 'accepted', {
    touched: [{ path: 'src/b.ts', op: 'create' }],
    diffStats,
    compactDiff: 'diff --git a/src/b.ts b/src/b.ts',
    compactDiffProvenance: 'witnessed',
  }, 40);
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'durable-stopped', planId: 'plan-b', planStampSource: 'explicit',
  });
  dbm.closeTurn('durable-stopped', 'stopped', undefined, 41);
  dbm.allocateAndInsertTurn(workspaceId, {
    id: 'durable-open', planId: 'plan-b', planStampSource: 'explicit',
  });
  dbm.getDb().prepare(
    `INSERT INTO turn_records (id, workspace_id, turn_seq, status, ended_at)
     VALUES (?, ?, ?, 'accepted', ?)`,
  ).run('durable-legacy', workspaceId, 100, 45);

  dbm.insertRecoveryOperation(workspaceId, {
    id: 'restore-1', kind: 'restore_paths', actor: 'supervisor',
    sourceTurnId: 'durable-accepted', status: 'completed',
    requestedPaths: ['src/b.ts'], completedPaths: ['src/b.ts'],
    result: 'restored', createdAt: 50,
  });
  dbm.insertRecoveryOperation(workspaceId, {
    id: 'revert-1', kind: 'revert_turn', actor: 'human-ipc',
    sourceTurnId: 'durable-accepted', status: 'failed',
    failureReason: 'drift', createdAt: 60,
  });
  dbm.insertRecoveryOperation(workspaceId, {
    id: 'whole-tree-ignored', kind: 'whole_tree', actor: 'human-ipc',
    status: 'completed', createdAt: 70,
  });

  const trail = projectDurableStampedTrail(
    dbm.listTurnRecords(workspaceId, { limit: 200 }),
    dbm.listRecoveryOperations(workspaceId),
  );
  assert.equal(trail.acceptedTurns.length, 2, 'both accepted fixtures are retained');
  const accepted = trail.acceptedTurns.find((entry) => entry.turnId === 'durable-accepted');
  assert.ok(accepted);
  assert.deepEqual(accepted.diffStats, diffStats);
  assert.equal(accepted.compactDiff, 'diff --git a/src/b.ts b/src/b.ts');
  assert.equal(accepted.compactDiffProvenance, 'witnessed');
  assert.equal(accepted.planStampStatus, 'verified');
  const legacy = trail.acceptedTurns.find((entry) => entry.turnId === 'durable-legacy');
  assert.ok(legacy);
  assert.equal(legacy.planStampSource, 'legacy-unstamped');
  assert.equal(legacy.planStampStatus, 'unstamped');
  assert.equal(legacy.planId, null);
  assert.equal(trail.acceptedTurns.some((entry) => entry.turnId === 'durable-stopped'), false);
  assert.equal(trail.acceptedTurns.some((entry) => entry.turnId === 'durable-open'), false);
  assert.deepEqual(trail.recoveryOperations.map((operation) => ({
    id: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    sourceTurnId: operation.sourceTurnId,
  })), [
    { id: 'restore-1', kind: 'restore_paths', status: 'completed', sourceTurnId: 'durable-accepted' },
    { id: 'revert-1', kind: 'revert_turn', status: 'failed', sourceTurnId: 'durable-accepted' },
  ]);
  assert.equal(JSON.stringify(trail).includes('whole-tree-ignored'), false);
  assert.equal('completion' in accepted, false);
  assert.equal('done' in accepted, false);
});

test('malformed stamp shapes fail closed without inventing attribution', () => {
  const workspaceId = freshWorkspace('malformed');
  const base = dbm.allocateAndInsertTurn(workspaceId, {
    id: 'shape-base', planId: 'plan-safe', planStampSource: 'explicit',
  });
  const malformed = [
    { ...base, id: 'unknown-source', planStampSource: 'forged' as never },
    { ...base, id: 'orphan-item', planId: null, planItemId: 'pkg-orphan' },
    { ...base, id: 'none-with-id', planStampSource: 'explicit-none' as const },
  ];
  const projected = projectLiveStampedActivity(malformed);
  assert.deepEqual(projected.map((entry) => ({
    id: entry.turnId, planId: entry.planId, planItemId: entry.planItemId,
    status: entry.planStampStatus, active: entry.isActive,
  })), [
    { id: 'unknown-source', planId: null, planItemId: null, status: 'unverified', active: false },
    { id: 'orphan-item', planId: null, planItemId: null, status: 'unverified', active: false },
    { id: 'none-with-id', planId: null, planItemId: null, status: 'unverified', active: false },
  ]);
});

(async () => {
  const temporaryAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'stamped-evidence-'));
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
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  try { fs.rmSync(temporaryAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
