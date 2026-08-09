import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  getRowsModified(): number;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let SqlDatabase: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private readonly db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new SqlDatabase();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }

  pragma(_sql: string): undefined { return undefined; }
  close(): void { /* sql.js memory store is released with the test process */ }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const db = this.db;
    return {
      run: (...params: unknown[]) => {
        db.run(sql, params);
        return { changes: db.getRowsModified() };
      },
      get: (...params: unknown[]) => {
        const statement = db.prepare(sql);
        try {
          statement.bind(params);
          return statement.step() ? statement.getAsObject() : undefined;
        } finally { statement.free(); }
      },
      all: (...params: unknown[]) => {
        const statement = db.prepare(sql);
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

type DatabaseModule = typeof import('./database');

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-ledger-db-'));
  const priorAppData = process.env.APPDATA;
  process.env.APPDATA = scratch;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    SqlDatabase = SQL.Database;
    const sqlitePath = require.resolve('better-sqlite3');
    require.cache[sqlitePath] = {
      id: sqlitePath, filename: sqlitePath, loaded: true, exports: FakeBetterSqlite,
    } as unknown as NodeModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const db = require('./database') as DatabaseModule;
    db.initDatabase();

    const workspace = db.createWorkspace({ title: 'ledger', path: scratch, pathType: 'windows' });
    const repositoryKey = 'repo-intent-ledger';
    const first = db.createNamedSaveSet({
      id: 'intent-1', workspaceId: workspace.id, repositoryKey, title: 'First task',
      inventoryDigest: 'inventory-1', members: [{ entryId: 'entry-1', pathBytesBase64: 'YS50cw==' }],
      createdAt: 1,
    });
    db.createNamedSaveSet({
      id: 'intent-2', workspaceId: workspace.id, repositoryKey, title: 'Second task',
      inventoryDigest: 'inventory-1', members: [{ entryId: 'entry-1', pathBytesBase64: 'YS50cw==' }],
      createdAt: 2,
    });
    db.insertAttributionResolution({
      id: 'resolution-1', repositoryKey, pathBytesBase64: 'YS50cw==', evidenceDigest: 'evidence-1',
      earlierIntentId: first.id, laterIntentId: 'intent-2', resolution: 'commit-together',
      chosenByAppUserId: 'local-app-user', chosenAt: 3, supersededIntentId: null,
      restoreTurnId: null, consumedByCandidateId: null,
    });
    db.insertSaveIntentFinalization({
      id: 'finalization-1', saveUnitId: first.id, saveUnitKind: 'named-save-set', revision: 1,
      repositoryKey, memberManifestJson: '[]', checkpointOid: 'a'.repeat(40),
      boundaryRef: 'refs/lares/finalizations/intent-1/1', boundaryStatus: 'ready',
      lifecycleStatus: 'active', finalizedAt: 4, finalizedBy: 'tester',
      supersededByFinalizationId: null, failureReason: null,
    });

    const record = {
      repositoryKey, commitOid: 'b'.repeat(40), parentOid: 'a'.repeat(40), observedAt: 5,
      source: 'lares' as const, pushedRemoteCount: 0, lastReconciledAt: 5,
    };
    assert.throws(() => db.writeIntentCommitLedger({
      record,
      intentLinks: [{ repositoryKey, commitOid: record.commitOid, intentId: first.id,
        disposition: 'committed', resolutionId: 'resolution-1', createdAt: 5 }],
      consumedResolutions: [
        { id: 'resolution-1', evidenceDigest: 'evidence-1', candidateId: 'candidate-1' },
        { id: 'missing-resolution', evidenceDigest: 'missing', candidateId: 'candidate-1' },
      ],
      finalizationIds: ['finalization-1'],
    }), /stale attribution resolution/);
    assert.deepEqual(db.listCommitIntentLinks(repositoryKey, record.commitOid), [], 'link insert rolled back');
    assert.equal(db.getSaveIntent(first.id)?.state, 'open', 'intent transition rolled back');
    assert.equal(db.getAttributionResolution('resolution-1')?.consumedByCandidateId, null,
      'resolution consumption rolled back');
    assert.equal(db.getSaveIntentFinalization('finalization-1')?.lifecycleStatus, 'active',
      'finalization transition rolled back');

    db.writeIntentCommitLedger({
      record,
      intentLinks: [{ repositoryKey, commitOid: record.commitOid, intentId: first.id,
        disposition: 'committed', resolutionId: 'resolution-1', createdAt: 5 }],
      consumedResolutions: [
        { id: 'resolution-1', evidenceDigest: 'evidence-1', candidateId: 'candidate-1' },
      ],
      finalizationIds: ['finalization-1'],
    });
    assert.equal(db.listCommitIntentLinks(repositoryKey, record.commitOid).length, 1);
    assert.equal(db.getSaveIntent(first.id)?.state, 'committed');
    assert.equal(db.getAttributionResolution('resolution-1')?.consumedByCandidateId, 'candidate-1');
    assert.equal(db.getSaveIntentFinalization('finalization-1')?.lifecycleStatus, 'committed');
    const turn = db.allocateAndInsertTurn(workspace.id, { id: 'turn-promoted' });
    db.updateTurnRecord(turn.id, {
      beforeRef: 'refs/lares/checkpoints/ws/turn-promoted/before', beforeOid: 'c'.repeat(40), beforeReady: true,
      afterRef: 'refs/lares/checkpoints/ws/turn-promoted/after', afterOid: 'd'.repeat(40), afterReady: true,
    });
    db.upsertCommitTurnLink({
      repositoryKey: 'activity-repo', commitOid: 'e'.repeat(40), turnId: turn.id,
      planId: null, planItemId: null, relation: 'candidate_member', captureQuality: null,
    });
    const promoted = db.recordPromotedCheckpointRefs({
      primaryRepositoryKey: repositoryKey, promotedCommitOid: 'f'.repeat(40),
      sourceRepositoryKey: 'activity-repo', sourceCommitOids: ['e'.repeat(40)], createdAt: 6,
    });
    assert.deepEqual(promoted.map((row) => [row.edge, row.checkpointRef]), [
      ['before', 'refs/lares/checkpoints/ws/turn-promoted/before'],
      ['after', 'refs/lares/checkpoints/ws/turn-promoted/after'],
    ]);
    assert.equal(db.listPromotedCheckpointRefsForWorkspace(workspace.id).length, 2);
    console.log('database intent-ledger migration + transaction rollback: passed');
    db.closeDatabaseForTests();
  } finally {
    if (priorAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = priorAppData;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
