// Git-Native WP-A0 — turn_records + recovery_operations schema/accessors.
//
// Contract-level tests against the REAL schema (via the sql.js better-sqlite3
// stand-in, same precedent as database.active-agents.test.ts). Covers:
//   - atomic sequence allocation (no duplicate turn_seq) + retry-once on a
//     forced UNIQUE(workspace_id, turn_seq) collision
//   - illegal status transition rejected; terminal rows immutable
//   - idempotent close
//   - deleteAgent preserves turn_records + recovery_operations while purging
//     file_activities
//   - recordWitnessedActivity dedupes (turnId, path, op)
//   - the export projection omits compact_diff / touched / before_filtered_paths
//
//   npm run build:main
//   node dist/main/main/turn-records.test.js
//
// Note on "concurrency": better-sqlite3 (and this sql.js stand-in) run every
// transaction synchronously on one thread, so two allocations can never truly
// interleave. We prove the invariant the two ways that ARE observable: many
// sequential allocations yield a contiguous, duplicate-free seq set, and a
// deliberately-forced constraint violation is recovered by the retry.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.active-agents.test.ts) ────

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
  pragma(_s: string): unknown { return undefined; }
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

// ── module under test ────────────────────────────────────────────────────────

type TurnRecord = {
  id: string;
  workspaceId: string;
  turnSeq: number;
  agentId: string | null;
  status: string;
  endedAt: number | null;
  touched: { path: string; op: string }[] | null;
  compactDiff: string | null;
  beforeFilteredPaths: string[] | null;
};
type RecoveryOperation = { id: string; status: string };
type DbModule = {
  initDatabase(): void;
  getDb(): {
    prepare(sql: string): { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  };
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: Record<string, unknown>): { id: string };
  deleteAgent(id: string): void;
  addFileActivity(agentId: string, filePath: string, operation: string): unknown;
  getFileActivities(agentId: string): unknown[];
  allocateAndInsertTurn(workspaceId: string, fields?: Record<string, unknown>): TurnRecord;
  getTurnRecord(id: string): TurnRecord | null;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  closeTurn(id: string, status: string, extra?: Record<string, unknown>, endedAt?: number | null): TurnRecord | null;
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[];
  recordWitnessedActivity(turnId: string, filePath: string, op: string): boolean;
  exportTurnRecords(workspaceId: string, opts?: { agentId?: string }): Record<string, unknown>[];
  insertRecoveryOperation(workspaceId: string, fields: Record<string, unknown>): RecoveryOperation;
  getRecoveryOperation(id: string): RecoveryOperation | null;
  listRecoveryOperations(workspaceId: string, opts?: { sourceTurnId?: string }): RecoveryOperation[];
  updateRecoveryOperation(id: string, updates: Record<string, unknown>): RecoveryOperation | null;
};
let dbm: DbModule;
let wsSeq = 0;

/** A fresh workspace id per test so seq allocation starts clean. */
function freshWorkspace(): string {
  return dbm.createWorkspace({ title: `wp-a0-${++wsSeq}`, path: `C:\\tmp\\ws${wsSeq}`, pathType: 'windows' }).id;
}

let agentSeq = 0;
function makeAgent(wsId: string): string {
  return dbm.createAgent({
    workspaceId: wsId,
    title: `wp-a0-agent-${++agentSeq}`,
    roleDescription: '',
    workingDirectory: 'C:\\tmp',
    command: 'claude',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: `C:\\tmp\\agent-${agentSeq}.log`,
  }).id;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('allocateAndInsertTurn yields a contiguous, duplicate-free seq per workspace', () => {
  const ws = freshWorkspace();
  const N = 25;
  const seqs: number[] = [];
  for (let i = 0; i < N; i++) seqs.push(dbm.allocateAndInsertTurn(ws).turnSeq);
  assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1), 'seqs must be 1..N in order');
  assert.equal(new Set(seqs).size, N, 'no duplicate turn_seq');
  // Isolation across workspaces: a second workspace restarts at 1.
  const ws2 = freshWorkspace();
  assert.equal(dbm.allocateAndInsertTurn(ws2).turnSeq, 1);
});

test('allocateAndInsertTurn retries once on a forced UNIQUE(workspace_id, turn_seq) collision', () => {
  const ws = freshWorkspace();
  dbm.allocateAndInsertTurn(ws); // seq 1
  dbm.allocateAndInsertTurn(ws); // seq 2
  dbm.allocateAndInsertTurn(ws); // seq 3 → real MAX is 3, next should be 4

  // Simulate a lost race: make the FIRST MAX read inside the next allocation
  // return a stale value (2) so the INSERT collides with the existing seq-2 row.
  // The retry re-reads a fresh MAX (3) and lands seq 4.
  const handle = dbm.getDb();
  const origPrepare = handle.prepare.bind(handle);
  let poisoned = true;
  (handle as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql) as { get(...p: unknown[]): unknown; run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
    if (poisoned && /MAX\(turn_seq\)/.test(sql)) {
      poisoned = false;
      return { ...stmt, get: () => ({ next: 2 }) };
    }
    return stmt;
  };
  try {
    const rec = dbm.allocateAndInsertTurn(ws);
    assert.equal(poisoned, false, 'the poisoned MAX read must have been consumed');
    assert.equal(rec.turnSeq, 4, 'retry must land the fresh next seq (4), not the stale 2');
  } finally {
    (handle as { prepare: unknown }).prepare = origPrepare;
  }
  const all = dbm.listTurnRecords(ws).map((r) => r.turnSeq);
  assert.deepEqual(all, [1, 2, 3, 4]);
  assert.equal(new Set(all).size, 4, 'no duplicate seq after a retried collision');
});

test('illegal status transitions are rejected; legal open→terminal allowed', () => {
  const ws = freshWorkspace();
  const t = dbm.allocateAndInsertTurn(ws);
  assert.equal(t.status, 'open');

  // Bogus target out of open → throws.
  assert.throws(() => dbm.updateTurnRecord(t.id, { status: 'nonsense' }), /illegal turn transition/);

  // Legal transition.
  const accepted = dbm.updateTurnRecord(t.id, { status: 'accepted' });
  assert.equal(accepted?.status, 'accepted');

  // Terminal is immutable — any further update throws, including a re-transition.
  assert.throws(() => dbm.updateTurnRecord(t.id, { status: 'reverted' }), /terminal/);
  assert.throws(() => dbm.updateTurnRecord(t.id, { afterOid: 'deadbeef' }), /terminal/);
});

test('closeTurn is idempotent', () => {
  const ws = freshWorkspace();
  const t = dbm.allocateAndInsertTurn(ws);
  const first = dbm.closeTurn(t.id, 'stopped', {}, 111);
  assert.equal(first?.status, 'stopped');
  assert.equal(first?.endedAt, 111);
  // Second close is a no-op: status + ended_at unchanged, no throw.
  const second = dbm.closeTurn(t.id, 'crashed', {}, 999);
  assert.equal(second?.status, 'stopped', 'idempotent close must not re-transition');
  assert.equal(second?.endedAt, 111, 'idempotent close must not restamp ended_at');
});

test('deleteAgent preserves turn_records + recovery_operations while purging file_activities', () => {
  const ws = freshWorkspace();
  const agentId = makeAgent(ws);

  dbm.addFileActivity(agentId, 'C:\\tmp\\ws\\foo.ts', 'edit');
  assert.ok(dbm.getFileActivities(agentId).length >= 1, 'precondition: an activity exists');

  const turn = dbm.allocateAndInsertTurn(ws, { agentId, agentTitle: 'doomed agent' });
  const op = dbm.insertRecoveryOperation(ws, { kind: 'restore_paths', actor: agentId, sourceTurnId: turn.id, status: 'pending' });

  dbm.deleteAgent(agentId);

  assert.equal(dbm.getFileActivities(agentId).length, 0, 'file_activities purged');
  assert.ok(dbm.getTurnRecord(turn.id), 'turn_records row must SURVIVE deleteAgent');
  assert.equal(dbm.getTurnRecord(turn.id)?.agentId, agentId, 'agent_id retained as a plain attribute');
  assert.ok(dbm.getRecoveryOperation(op.id), 'recovery_operations row must SURVIVE deleteAgent');
});

test('recordWitnessedActivity dedupes (turnId, path, op)', () => {
  const ws = freshWorkspace();
  const t = dbm.allocateAndInsertTurn(ws);

  assert.equal(dbm.recordWitnessedActivity(t.id, 'a.ts', 'write'), true, 'first insert appends');
  assert.equal(dbm.recordWitnessedActivity(t.id, 'a.ts', 'write'), false, 'exact dupe is a no-op');
  assert.equal(dbm.recordWitnessedActivity(t.id, 'a.ts', 'create'), true, 'same path, different op appends');
  assert.equal(dbm.recordWitnessedActivity(t.id, 'b.ts', 'write'), true, 'different path appends');

  const touched = dbm.getTurnRecord(t.id)?.touched ?? [];
  assert.equal(touched.length, 3, 'exactly three distinct (path, op) tuples');
  assert.equal(dbm.recordWitnessedActivity('no-such-turn', 'x', 'write'), false, 'unknown turn is a no-op');
});

test('exportTurnRecords omits compact_diff, touched, and before_filtered_paths', () => {
  const ws = freshWorkspace();
  const t = dbm.allocateAndInsertTurn(ws, { agentId: 'agent-x' });
  dbm.updateTurnRecord(t.id, {
    compactDiff: 'SECRET DIFF BYTES',
    beforeFilteredPaths: ['C:\\tmp\\ws\\secret.env'],
    touched: [{ path: 'a.ts', op: 'write' }],
    beforeOid: 'abc123',
    status: 'accepted',
  });

  const rows = dbm.exportTurnRecords(ws);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(!('compact_diff' in row), 'compact_diff must NOT be exported');
  assert.ok(!('touched' in row), 'touched must NOT be exported');
  assert.ok(!('before_filtered_paths' in row), 'before_filtered_paths must NOT be exported');
  // Allowlisted columns ARE present and carry no leaked bytes.
  assert.equal(row.before_oid, 'abc123');
  assert.equal(row.status, 'accepted');
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes('SECRET DIFF BYTES'), 'no diff bytes leak through export');
  assert.ok(!serialized.includes('secret.env'), 'no filtered-path bytes leak through export');

  // Filtered scope: exporting by agentId respects the filter.
  assert.equal(dbm.exportTurnRecords(ws, { agentId: 'nobody' }).length, 0);
  assert.equal(dbm.exportTurnRecords(ws, { agentId: 'agent-x' }).length, 1);
});

test('recovery_operations CRUD round-trips', () => {
  const ws = freshWorkspace();
  const op = dbm.insertRecoveryOperation(ws, {
    kind: 'restore_paths',
    actor: 'human-ipc',
    status: 'pending',
    requestedPaths: ['a.ts', 'b.ts'],
  });
  assert.equal(dbm.getRecoveryOperation(op.id)?.status, 'pending');

  dbm.updateRecoveryOperation(op.id, { status: 'completed', completedPaths: ['a.ts'], result: 'ok', endedAt: 42 });
  const after = dbm.getRecoveryOperation(op.id);
  assert.equal(after?.status, 'completed');
  assert.equal(dbm.listRecoveryOperations(ws).length, 1);
  assert.equal(dbm.listRecoveryOperations(ws, { sourceTurnId: 'none' }).length, 0);
  assert.equal(dbm.updateRecoveryOperation('missing-id', { status: 'failed' }), null);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-records-'));
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
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
