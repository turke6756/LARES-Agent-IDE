// Save-card SC-WP-2A — immutable turn plan-stamp schema + accessor contract.
//
//   npm run build:main
//   node dist/main/main/database.turnStamp.test.js

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

type TurnRecord = {
  id: string;
  planId: string | null;
  planItemId: string | null;
  planStampSource: string;
  intentId: string | null;
  intentStampSource: string | null;
};
type DbModule = {
  initDatabase(): void;
  getDb(): {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): Record<string, unknown>[];
    };
  };
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(input: Record<string, unknown>): { id: string };
  deleteAgent(id: string): void;
  allocateAndInsertTurn(workspaceId: string, fields?: Record<string, unknown>): TurnRecord;
  getTurnRecord(id: string): TurnRecord | null;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  createContinuationHandoffAttempt(agentId: string): { id: string };
  freezeContinuationAttemptBinding(attemptId: string, binding: Record<string, unknown>): Record<string, unknown>;
  getContinuationAttemptBinding(attemptId: string): Record<string, unknown> | null;
  recordCommitLedger(write: Record<string, unknown>): void;
  getCommitRecord(repositoryKey: string, commitOid: string): Record<string, unknown> | null;
  listCommitTurnLinks(repositoryKey: string, commitOid: string): Record<string, unknown>[];
  listCommitPathLinks(repositoryKey: string, paths?: readonly string[]): Record<string, unknown>[];
  createNamedSaveSet(input: Record<string, unknown>): { id: string; title: string };
  listNamedSaveSetMembers(repositoryKey: string): Array<{
    intentId: string; entryId: string; pathBytesBase64: string; inventoryDigest: string; createdAt: number;
  }>;
};

let dbm: DbModule;
let workspaceSeq = 0;
function freshWorkspace(): string {
  workspaceSeq += 1;
  return dbm.createWorkspace({
    title: `turn-stamp-${workspaceSeq}`,
    path: `C:\\tmp\\turn-stamp-${workspaceSeq}`,
    pathType: 'windows',
  }).id;
}

test('schema creates workspace-leading indexes and the immutable trigger', () => {
  const rows = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master
     WHERE name IN (?, ?, ?)
     ORDER BY name`,
  ).all(
    'idx_turn_records_ws_plan_seq',
    'idx_turn_records_ws_plan_item_seq',
    'turn_records_plan_stamp_immutable',
  );
  assert.deepEqual(rows, [
    { type: 'index', name: 'idx_turn_records_ws_plan_item_seq' },
    { type: 'index', name: 'idx_turn_records_ws_plan_seq' },
    { type: 'trigger', name: 'turn_records_plan_stamp_immutable' },
  ]);
});

test('WP-1 migration registers save_intents, intent columns, indexes, and immutable triggers', () => {
  const schema = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master
      WHERE name IN (?, ?, ?, ?, ?, ?) ORDER BY name`,
  ).all(
    'save_intents', 'idx_save_intents_plan_item', 'idx_save_intents_run_state',
    'turn_records_intent_stamp_immutable', 'plan_dispatch_attempts_intent_immutable',
    'continuation_attempts_intent_immutable',
  );
  assert.deepEqual(schema, [
    { type: 'trigger', name: 'continuation_attempts_intent_immutable' },
    { type: 'index', name: 'idx_save_intents_plan_item' },
    { type: 'index', name: 'idx_save_intents_run_state' },
    { type: 'trigger', name: 'plan_dispatch_attempts_intent_immutable' },
    { type: 'table', name: 'save_intents' },
    { type: 'trigger', name: 'turn_records_intent_stamp_immutable' },
  ]);
  for (const [table, columns] of [
    ['turn_records', ['intent_id', 'intent_stamp_source']],
    ['plan_dispatch_attempts', ['intent_id']],
    ['continuation_handoff_attempts', ['intent_id']],
  ] as const) {
    const actual = dbm.getDb().prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => row.name);
    for (const column of columns) assert.ok(actual.includes(column), `${table}.${column}`);
  }
});

test('WP-2 migration creates byte-addressed named save-set membership', () => {
  const schema = dbm.getDb().prepare(
    `SELECT type, name FROM sqlite_master
      WHERE name IN (?, ?) ORDER BY name`,
  ).all('named_save_set_members', 'idx_named_save_set_members_digest');
  assert.deepEqual(schema, [
    { type: 'index', name: 'idx_named_save_set_members_digest' },
    { type: 'table', name: 'named_save_set_members' },
  ]);
  const ws = freshWorkspace();
  const created = dbm.createNamedSaveSet({
    id: 'named-baseline', workspaceId: ws, repositoryKey: 'repo-named',
    title: 'Baseline 2026-08-09', inventoryDigest: 'digest-a', createdAt: 123,
    members: [
      { entryId: 'entry-a', pathBytesBase64: 'YS50cw==' },
      { entryId: 'entry-b', pathBytesBase64: 'Yi50cw==' },
    ],
  });
  assert.equal(created.id, 'named-baseline');
  assert.deepEqual(dbm.listNamedSaveSetMembers('repo-named'), [
    { intentId: 'named-baseline', entryId: 'entry-a', pathBytesBase64: 'YS50cw==', inventoryDigest: 'digest-a', createdAt: 123 },
    { intentId: 'named-baseline', entryId: 'entry-b', pathBytesBase64: 'Yi50cw==', inventoryDigest: 'digest-a', createdAt: 123 },
  ]);
});

test('turn allocation writes an immutable intent stamp and raw mutation is rejected', () => {
  const ws = freshWorkspace();
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'intent-stamped-turn',
    intentId: 'svi_original',
    intentStampSource: 'task-dispatch',
  });
  assert.deepEqual(
    { intentId: turn.intentId, intentStampSource: turn.intentStampSource },
    { intentId: 'svi_original', intentStampSource: 'task-dispatch' },
  );
  assert.throws(
    () => dbm.getDb().prepare(
      'UPDATE turn_records SET intent_id = ? WHERE id = ?',
    ).run('svi_forged', turn.id),
    /turn intent stamp is immutable/,
  );
  assert.equal(dbm.getTurnRecord(turn.id)?.intentId, 'svi_original');
});

test('continuation freeze carries the latest immutable turn intent and retries cannot replace it', () => {
  const ws = freshWorkspace();
  const agent = dbm.createAgent({
    workspaceId: ws, title: 'continuation-intent', roleDescription: '',
    workingDirectory: 'C:\\tmp', command: 'claude', provider: 'claude',
    tmuxSessionName: null, autoRestartEnabled: false, logPath: 'C:\\tmp\\intent.log',
  });
  dbm.allocateAndInsertTurn(ws, {
    id: 'continuation-source-turn', agentId: agent.id, planId: 'plan-intent',
    planItemId: 'item-intent', planStampSource: 'explicit',
    intentId: 'svi_continuation', intentStampSource: 'task-dispatch',
  });
  const attempt = dbm.createContinuationHandoffAttempt(agent.id);
  const first = dbm.freezeContinuationAttemptBinding(attempt.id, {
    planId: 'plan-intent', planItemId: null, source: 'continuation-carry',
  });
  assert.deepEqual((first as { intentStamp?: unknown }).intentStamp, {
    intentId: 'svi_continuation', kind: 'task', executionRunId: null,
    planId: 'plan-intent', planItemId: null, source: 'continuation-carry',
  });

  dbm.allocateAndInsertTurn(ws, {
    id: 'later-unrelated-turn', agentId: agent.id, planStampSource: 'explicit-none',
    intentId: 'svi_other', intentStampSource: 'task-dispatch',
  });
  const retry = dbm.freezeContinuationAttemptBinding(attempt.id, {
    planId: null, planItemId: null, source: 'continuation-carry',
  });
  assert.equal(
    ((retry as { intentStamp?: { intentId: string } }).intentStamp)?.intentId,
    'svi_continuation',
  );
  assert.deepEqual(dbm.getContinuationAttemptBinding(attempt.id), retry,
    'restart rehydrates only the attempt-frozen carry');
});

test('commit protection ledger schema and CRUD round-trip exact evidence atomically', () => {
  const commitOid = 'a'.repeat(40);
  const encoded = Buffer.from('filtered.txt').toString('base64');
  dbm.recordCommitLedger({
    record: {
      repositoryKey: 'repo-ledger', commitOid, parentOid: null, observedAt: 100,
      source: 'lares', pushedRemoteCount: 1, lastReconciledAt: 110,
    },
    turnLinks: [{
      repositoryKey: 'repo-ledger', commitOid, turnId: 'turn-ledger',
      planId: 'plan-ledger', planItemId: null, relation: 'exact_path_match',
      captureQuality: 'hook',
    }],
    pathLinks: [{
      repositoryKey: 'repo-ledger', commitOid, pathBytesBase64: encoded,
      expectedState: 'present', rawBlobOidAtCommit: 'b'.repeat(40),
      commitBlobOid: 'c'.repeat(40), commitMode: '100644',
      contributingTurnIds: ['turn-ledger'], overlapCount: 1,
    }],
  });
  assert.deepEqual(dbm.getCommitRecord('repo-ledger', commitOid), {
    repositoryKey: 'repo-ledger', commitOid, parentOid: null, observedAt: 100,
    source: 'lares', pushedRemoteCount: 1, lastReconciledAt: 110,
  });
  assert.equal(dbm.listCommitTurnLinks('repo-ledger', commitOid)[0].relation, 'exact_path_match');
  assert.deepEqual(dbm.listCommitPathLinks('repo-ledger', [encoded])[0].contributingTurnIds, ['turn-ledger']);
  assert.deepEqual(dbm.listCommitPathLinks('repo-ledger', []), []);
});

test('mapper returns explicit stamps and allocations never write legacy-unstamped', () => {
  const ws = freshWorkspace();
  const explicit = dbm.allocateAndInsertTurn(ws, {
    id: 'stamped-explicit',
    planId: 'plan-1',
    planStampSource: 'explicit',
  });
  assert.deepEqual(
    {
      planId: explicit.planId,
      planItemId: explicit.planItemId,
      planStampSource: explicit.planStampSource,
    },
    { planId: 'plan-1', planItemId: null, planStampSource: 'explicit' },
  );

  const compatibilityAllocation = dbm.allocateAndInsertTurn(ws, { id: 'stamped-default' });
  assert.equal(compatibilityAllocation.planStampSource, 'agent-default');
  assert.notEqual(compatibilityAllocation.planStampSource, 'legacy-unstamped');
});

test('legacy rows read legacy-unstamped through the mapper', () => {
  const ws = freshWorkspace();
  dbm.getDb().prepare(
    `INSERT INTO turn_records (id, workspace_id, turn_seq, status)
     VALUES (?, ?, ?, 'open')`,
  ).run('legacy-row', ws, 1);
  const legacy = dbm.getTurnRecord('legacy-row');
  assert.equal(legacy?.planId, null);
  assert.equal(legacy?.planItemId, null);
  assert.equal(legacy?.planStampSource, 'legacy-unstamped');
});

test('allocation enum validation rejects legacy and unknown sources without a row', () => {
  const ws = freshWorkspace();
  for (const source of ['legacy-unstamped', 'forged-source']) {
    assert.throws(
      () => dbm.allocateAndInsertTurn(ws, { id: `bad-${source}`, planStampSource: source }),
      /invalid turn plan stamp source/,
    );
    assert.equal(dbm.getTurnRecord(`bad-${source}`), null);
  }
});

test('SC-WP-3A: a resolved plan_item_id is stored now that plan_work_packages exists', () => {
  const ws = freshWorkspace();
  const stamped = dbm.allocateAndInsertTurn(ws, {
    id: 'stamped-item',
    planId: 'plan-1',
    planItemId: 'item-1',
    planStampSource: 'explicit',
  });
  assert.deepEqual(
    { planId: stamped.planId, planItemId: stamped.planItemId, planStampSource: stamped.planStampSource },
    { planId: 'plan-1', planItemId: 'item-1', planStampSource: 'explicit' },
  );
  assert.deepEqual(
    { planId: dbm.getTurnRecord('stamped-item')?.planId, planItemId: dbm.getTurnRecord('stamped-item')?.planItemId },
    { planId: 'plan-1', planItemId: 'item-1' },
  );
});

test('an item stamp without a plan is incoherent and is rejected with no row', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => dbm.allocateAndInsertTurn(ws, {
      id: 'orphan-item',
      planItemId: 'item-1',
      planStampSource: 'explicit',
    }),
    /plan_item_id requires a plan_id/,
  );
  assert.equal(dbm.getTurnRecord('orphan-item'), null);
});

test('update accessor cannot mutate any stamp column', () => {
  const ws = freshWorkspace();
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'accessor-immutable',
    planId: 'plan-original',
    planStampSource: 'explicit',
  });
  const after = dbm.updateTurnRecord(turn.id, {
    planId: 'plan-mutated',
    planItemId: 'item-mutated',
    planStampSource: 'revive-carry',
  });
  assert.deepEqual(
    { planId: after?.planId, planItemId: after?.planItemId, planStampSource: after?.planStampSource },
    { planId: 'plan-original', planItemId: null, planStampSource: 'explicit' },
  );
});

test('database trigger blocks raw mutation of every stamp column', () => {
  const ws = freshWorkspace();
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'trigger-immutable',
    planId: 'plan-original',
    planStampSource: 'explicit',
  });
  const raw = dbm.getDb();
  for (const [column, value] of [
    ['plan_id', 'plan-mutated'],
    ['plan_item_id', 'item-mutated'],
    ['plan_stamp_source', 'revive-carry'],
  ]) {
    assert.throws(
      () => raw.prepare(`UPDATE turn_records SET ${column} = ? WHERE id = ?`).run(value, turn.id),
      /turn plan stamp is immutable/,
    );
  }
  assert.deepEqual(
    dbm.getTurnRecord(turn.id),
    turn,
    'failed raw updates leave the entire mapped turn unchanged',
  );
});

test('deleting an agent preserves its frozen turn stamps', () => {
  const ws = freshWorkspace();
  const agent = dbm.createAgent({
    workspaceId: ws,
    title: 'stamp-owner',
    roleDescription: '',
    workingDirectory: 'C:\\tmp',
    command: 'claude',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: 'C:\\tmp\\stamp-owner.log',
  });
  const turn = dbm.allocateAndInsertTurn(ws, {
    id: 'deleted-agent-stamp',
    agentId: agent.id,
    planId: 'plan-survives',
    planStampSource: 'agent-default',
  });

  dbm.deleteAgent(agent.id);
  const preserved = dbm.getTurnRecord(turn.id);
  assert.equal(preserved?.planId, 'plan-survives');
  assert.equal(preserved?.planStampSource, 'agent-default');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-stamp-'));
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
