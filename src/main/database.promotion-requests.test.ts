// Planning-surface WP-P3A′ — promotion_requests DDL (§R-A2, frozen). Proves:
// idempotent create, UNIQUE(workspace_id, proposal_artifact_id) de-dup key,
// CHECK(state) bounds the lifecycle set, the frozen column shape, and double-init
// idempotency. DDL-only WP: raw inserts drive the schema (no accessors yet).
//
//   npm run build:main
//   node dist/main/main/database.promotion-requests.test.js

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
  close(): void { /* persisted store intentionally retained across boot fixtures */ }
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
  closeDatabaseForTests(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  insertOrchestration(run: Record<string, unknown>): void;
  getOrchestrationRun(runId: string): Record<string, unknown> | null;
  updateOrchestration(run: Record<string, unknown>): void;
  dropLegacyPromotionRequestsIfReady(input: {
    activeDrain: boolean; unverifiedLiveBoundAgentIds: readonly string[];
  }): { dropped: boolean; reason: string; orphanNonterminalRunIds: string[] };
  LEGACY_PROMOTION_REQUESTS_DROP_MARKER: string;
};

let dbm: DbModule;

// Raw insert of a promotion_requests row (no accessor exists — DDL-only WP).
function rawInsertPromotion(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'pr-1', workspace_id: 'ws-1', proposal_id: 'prop-1',
    proposal_artifact_id: 'prop_art_1', plan_artifact_id: 'plan_art_1',
    target_folder_rel_path: '.lares/plans/x/', supervisor_id: 'sup-1',
    orchestration_id: null, state: 'pending', attempt_count: 0,
    failure_reason: null, created_at: 1000, updated_at: 1000,
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO promotion_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

test('promotion_requests exists with exactly the §R-A2 frozen columns', () => {
  const tables = FakeBetterSqlite.rawAll(
    `SELECT name FROM sqlite_master WHERE type='table'`).map((r) => String(r.name));
  assert.ok(tables.includes('promotion_requests'), 'promotion_requests table must exist');
  const cols = FakeBetterSqlite.rawAll(`PRAGMA table_info(promotion_requests)`).map((r) => String(r.name)).sort();
  const expected = [
    'attempt_count', 'created_at', 'failure_reason', 'id', 'orchestration_id',
    'plan_artifact_id', 'proposal_artifact_id', 'proposal_id', 'state',
    'supervisor_id', 'target_folder_rel_path', 'updated_at', 'workspace_id',
  ].sort();
  assert.deepEqual(cols, expected, 'promotion_requests must carry exactly the frozen §R-A2 columns');
});

test('a promotion_requests row round-trips (create + read)', () => {
  rawInsertPromotion({ id: 'pr-rt', workspace_id: 'ws-rt', proposal_artifact_id: 'prop_rt' });
  const row = FakeBetterSqlite.rawAll(
    `SELECT * FROM promotion_requests WHERE id='pr-rt'`)[0];
  assert.equal(row.state, 'pending');
  assert.equal(Number(row.attempt_count), 0);
  assert.equal(row.plan_artifact_id, 'plan_art_1');
});

test('UNIQUE(workspace_id, proposal_artifact_id) rejects a second row for one proposal', () => {
  rawInsertPromotion({ id: 'pr-u1', workspace_id: 'ws-u', proposal_artifact_id: 'prop_dup' });
  // Same (workspace_id, proposal_artifact_id) → rejected even with a distinct id.
  assert.throws(() => rawInsertPromotion(
    { id: 'pr-u2', workspace_id: 'ws-u', proposal_artifact_id: 'prop_dup' }),
    'the de-dup key must reject a second request for the same proposal');
  // Same proposal_artifact_id in a DIFFERENT workspace → allowed (key is per-workspace).
  rawInsertPromotion({ id: 'pr-u3', workspace_id: 'ws-other', proposal_artifact_id: 'prop_dup' });
});

test('CHECK(state) rejects an out-of-set value and accepts the three allowed states', () => {
  assert.throws(() => rawInsertPromotion(
    { id: 'pr-bad', workspace_id: 'ws-c', proposal_artifact_id: 'prop_bad', state: 'delivering' }),
    'CHECK(state) must reject an out-of-set value');
  // No row was written for the rejected state.
  assert.equal(FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM promotion_requests WHERE id='pr-bad'`)[0].n, 0);
  for (const s of ['pending', 'adopted', 'failed']) {
    rawInsertPromotion({ id: `pr-ok-${s}`, workspace_id: 'ws-c', proposal_artifact_id: `prop_${s}`, state: s });
  }
});

test('the DDL is idempotent — CREATE TABLE IF NOT EXISTS never throws or drops data on re-init', () => {
  rawInsertPromotion({ id: 'pr-idem', workspace_id: 'ws-idem', proposal_artifact_id: 'prop_idem' });
  const before = FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM promotion_requests WHERE id='pr-idem'`)[0].n;
  dbm.initDatabase();
  const after = FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM promotion_requests WHERE id='pr-idem'`)[0].n;
  assert.equal(after, before, 'a second migration pass must not throw or drop data');
});

test('one orphan nonterminal promotion run blocks retirement', () => {
  dbm.insertOrchestration({
    runId: 'orphan-promotion', name: 'promotion', mode: 'serial', status: 'starting',
    workspaceId: 'ws-1', supervisorId: 'sup-1', topic: 'legacy', planPath: '.lares/plans/x',
    leadProvider: 'claude', reviewerProvider: 'claude', turnTimeoutMs: 1,
    lastRelayedTs: {}, startedAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
  });
  const pending = dbm.dropLegacyPromotionRequestsIfReady({
    activeDrain: false, unverifiedLiveBoundAgentIds: [],
  });
  assert.equal(pending.dropped, false);
  assert.equal(pending.reason, 'pending-requests', 'pending rows fail closed before other blockers');
  FakeBetterSqlite.rawExec(`UPDATE promotion_requests SET state='failed' WHERE state='pending'`);
  const orphan = dbm.dropLegacyPromotionRequestsIfReady({
    activeDrain: false, unverifiedLiveBoundAgentIds: [],
  });
  assert.equal(orphan.reason, 'nonterminal-promotion-runs');
  assert.deepEqual(orphan.orphanNonterminalRunIds, ['orphan-promotion']);
});

test('active drain and unverified live bound agent independently block retirement', () => {
  const run = dbm.getOrchestrationRun('orphan-promotion')!;
  dbm.updateOrchestration({ ...run, status: 'aborted' });
  assert.equal(
    dbm.dropLegacyPromotionRequestsIfReady({ activeDrain: true, unverifiedLiveBoundAgentIds: [] }).reason,
    'active-drain',
  );
  assert.equal(
    dbm.dropLegacyPromotionRequestsIfReady({ activeDrain: false, unverifiedLiveBoundAgentIds: ['agent-live'] }).reason,
    'unverified-live-bound-agent',
  );
});

test('clean awaited retirement drops once and boot 2 never recreates promotion_requests', () => {
  const first = dbm.dropLegacyPromotionRequestsIfReady({
    activeDrain: false, unverifiedLiveBoundAgentIds: [],
  });
  assert.equal(first.dropped, true);
  assert.equal(first.reason, 'dropped');
  assert.equal(
    FakeBetterSqlite.rawAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='promotion_requests'`).length,
    0,
  );
  const marker = FakeBetterSqlite.rawAll(
    `SELECT name FROM applied_migrations WHERE name=?`,
    [dbm.LEGACY_PROMOTION_REQUESTS_DROP_MARKER],
  );
  assert.equal(marker.length, 1);

  dbm.closeDatabaseForTests();
  dbm.initDatabase();
  assert.equal(
    FakeBetterSqlite.rawAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='promotion_requests'`).length,
    0,
    'boot 2 skips CREATE after the retirement marker',
  );
  const again = dbm.dropLegacyPromotionRequestsIfReady({
    activeDrain: false, unverifiedLiveBoundAgentIds: [],
  });
  assert.equal(again.reason, 'already-dropped');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-requests-'));
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
