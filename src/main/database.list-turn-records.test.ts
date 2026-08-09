// Checkpoint Surface Hardening WP4 — listTurnRecords filters + bounds.
//
// SQL-semantics contract against the REAL schema (via the sql.js better-sqlite3
// stand-in, same precedent as database.file-activity-ingress.test.ts):
//   - the `file` JSON1 predicate is applied BEFORE `LIMIT` (an older matching turn
//     beyond the newest-N window is still found);
//   - `since` is an EXCLUSIVE turn_seq lower bound (the paging cursor);
//   - `sinceTime` is a SEPARATE coarse `started_at >=` filter, never the cursor;
//   - default limit is 50; an explicit limit bounds the newest-N window;
//   - rows come back ascending by turn_seq (DESC LIMIT then reversed);
//   - `touched IS NULL` rows never error the JSON1 predicate and never match.
//
//   npm run build:main
//   node dist/main/main/database.list-turn-records.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (turn-records.test.ts) ──────────────

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

// ── module under test ─────────────────────────────────────────────────────────

interface TurnRecord {
  id: string;
  turnSeq: number;
  startedAt: number | null;
  touched: { path: string; op: string }[] | null;
}
interface ListOpts { agentId?: string; since?: number; sinceTime?: number; limit?: number; file?: string; }
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  allocateAndInsertTurn(workspaceId: string, fields: Record<string, unknown>): TurnRecord;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  listTurnRecords(workspaceId: string, opts?: ListOpts): TurnRecord[];
  listOpenTurnRecords(workspaceId: string): TurnRecord[];
};
let dbm: DbModule;

let wsSeq = 0;
function freshWorkspace(): string {
  return dbm.createWorkspace({ title: `wp4-${++wsSeq}`, path: `C:\\tmp\\ws${wsSeq}`, pathType: 'windows' }).id;
}

/** Insert a turn (auto turn_seq = MAX+1) with a startedAt and optional touched set. */
function seedTurn(wsId: string, startedAt: number, touched: { path: string; op: string }[] | null): TurnRecord {
  const rec = dbm.allocateAndInsertTurn(wsId, { agentId: 'a1', startedAt });
  if (touched !== null) dbm.updateTurnRecord(rec.id, { touched });
  return dbm.listTurnRecords(wsId).find((t) => t.id === rec.id)!;
}

const seqs = (rows: TurnRecord[]): number[] => rows.map((r) => r.turnSeq);

// ── tests ───────────────────────────────────────────────────────────────────

test('file predicate is applied BEFORE LIMIT — an older match beyond the window is still found', () => {
  const ws = freshWorkspace();
  // Oldest turn (turn_seq 1) is the ONLY one touching target.txt.
  seedTurn(ws, 1000, [{ path: 'src/target.txt', op: 'write' }]);
  // 9 newer turns touch something else, so target.txt is far outside a limit-3 window.
  for (let i = 0; i < 9; i++) seedTurn(ws, 2000 + i, [{ path: 'src/other.txt', op: 'write' }]);

  const rows = dbm.listTurnRecords(ws, { file: 'src/target.txt', limit: 3 });
  assert.deepEqual(seqs(rows), [1], 'the oldest matching turn is returned despite limit 3');
  // Sanity: without the predicate, limit 3 returns only the newest three.
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { limit: 3 })), [8, 9, 10]);
});

test('file predicate is op-agnostic (path presence) and NULL touched never errors / matches', () => {
  const ws = freshWorkspace();
  seedTurn(ws, 1, [{ path: 'a.txt', op: 'create' }]); // create, not write
  seedTurn(ws, 2, null);                               // touched IS NULL
  seedTurn(ws, 3, [{ path: 'b.txt', op: 'write' }]);
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { file: 'a.txt' })), [1], 'matches a create entry');
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { file: 'missing.txt' })), [], 'no match → empty, NULL row does not error');
});

test('since is an EXCLUSIVE turn_seq lower bound (the cursor)', () => {
  const ws = freshWorkspace();
  for (let i = 0; i < 5; i++) seedTurn(ws, 100 + i, [{ path: 'x', op: 'write' }]); // seq 1..5
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { since: 3 })), [4, 5], 'turn_seq > 3 (3 itself excluded)');
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { since: 5 })), [], 'since == max → empty');
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { since: 0 })), [1, 2, 3, 4, 5], 'since 0 → all');
});

test('sinceTime is a SEPARATE coarse started_at >= filter, not the cursor', () => {
  const ws = freshWorkspace();
  seedTurn(ws, 1000, [{ path: 'x', op: 'write' }]); // seq 1
  seedTurn(ws, 2000, [{ path: 'x', op: 'write' }]); // seq 2
  seedTurn(ws, 3000, [{ path: 'x', op: 'write' }]); // seq 3
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { sinceTime: 2000 })), [2, 3], 'started_at >= 2000 is inclusive');
  // since (cursor) and sinceTime (time) are independent AND-ed filters.
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { sinceTime: 2000, since: 2 })), [3], 'both filters applied');
});

test('default limit is 50; rows come back ascending by turn_seq', () => {
  const ws = freshWorkspace();
  for (let i = 0; i < 60; i++) seedTurn(ws, i, [{ path: 'x', op: 'write' }]); // seq 1..60
  const def = dbm.listTurnRecords(ws);
  assert.equal(def.length, 50, 'default cap is 50');
  assert.deepEqual(def[0].turnSeq, 11, 'newest 50 window starts at seq 11');
  assert.deepEqual(def[def.length - 1].turnSeq, 60, 'ascending — last row is the newest');
  // Explicit small limit bounds the newest-N window, still ascending.
  assert.deepEqual(seqs(dbm.listTurnRecords(ws, { limit: 3 })), [58, 59, 60]);
});

test('listOpenTurnRecords is unbounded for startup reconciliation', () => {
  const ws = freshWorkspace();
  for (let i = 0; i < 60; i++) seedTurn(ws, i, null);
  assert.equal(dbm.listTurnRecords(ws).length, 50, 'control: ordinary accessor is paged');
  const open = dbm.listOpenTurnRecords(ws);
  assert.equal(open.length, 60, 'every dangling row is enumerated, including the oldest');
  assert.deepEqual(seqs(open).slice(0, 2), [1, 2]);
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp4-list-'));
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
