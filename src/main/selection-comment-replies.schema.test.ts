// Planning-surface WP-P4D-reply (DDL) — selection_comment_replies companion table.
// DDL idempotency + constraint proofs: double-init survives data, reply round-trips
// with author + time, the comment_id FK rejects an orphan reply, the question row is
// byte-untouched by a reply insert, and NO additive answer columns land on
// selection_comments. DDL-only slot: no accessor layer yet (that is P4D-create/reply
// service), so rows are inserted through the raw store.
//
//   npm run build:main
//   node dist/main/main/selection-comment-replies.schema.test.js

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

// Same FakeBetterSqlite shim the sibling database.*.test.ts / plan-intents.schema.test.ts
// files use: a sql.js store behind the better-sqlite3 surface database.ts calls. NOTE:
// pragma() is a deliberate no-op here, so database.ts's `db.pragma('foreign_keys = ON')`
// does NOT reach sql.js — the FK-enforcement test enables it directly via rawExec.
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

  // Raw access to the live store for schema-level assertions + inserts the accessor
  // layer does not surface (WP-P4D-reply DDL slot: no ingest, no accessors).
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
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
};

let dbm: DbModule;

// Raw insert of a selection_comments (question) row. Only the NOT NULL / CHECK-bound
// columns are supplied; the rest default. No accessor is used — the create service is
// deferred (WP-P4D-create).
function rawInsertComment(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'sc-1', workspace_id: 'ws-1', target_type: 'file',
    file_path: '/x/plan.md', quoted_text: 'q', body: 'question body',
    status: 'sent',
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO selection_comments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

// Raw insert of a selection_comment_replies (companion) row.
function rawInsertReply(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'rep-1', comment_id: 'sc-1', body: 'answer body',
    author_agent_id: 'sup-7', created_at: 1000,
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO selection_comment_replies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

test('selection_comment_replies table + comment_id index exist', () => {
  const tables = FakeBetterSqlite.rawAll(
    `SELECT name FROM sqlite_master WHERE type='table'`).map((r) => String(r.name));
  assert.ok(tables.includes('selection_comment_replies'),
    'selection_comment_replies table must exist');
  const indexes = FakeBetterSqlite.rawAll(
    `SELECT name FROM sqlite_master WHERE type='index'`).map((r) => String(r.name));
  assert.ok(indexes.includes('idx_selcomment_replies_comment'),
    'idx_selcomment_replies_comment must exist');
});

test('a reply row round-trips with its author + creation time', () => {
  rawInsertComment({ id: 'sc-rt', body: 'q-rt' });
  rawInsertReply({ id: 'rep-rt', comment_id: 'sc-rt', body: 'the answer', author_agent_id: 'sup-42', created_at: 1717000000 });
  const rows = FakeBetterSqlite.rawAll(
    `SELECT id, comment_id, body, author_agent_id, created_at FROM selection_comment_replies WHERE id='rep-rt'`);
  assert.equal(rows.length, 1, 'exactly one reply row');
  const r = rows[0];
  assert.equal(r.comment_id, 'sc-rt');
  assert.equal(r.body, 'the answer');
  assert.equal(r.author_agent_id, 'sup-42', 'author survives the round-trip');
  assert.equal(Number(r.created_at), 1717000000, 'created_at survives as an INTEGER epoch');
});

test('author_agent_id is nullable — a system/undeclared reply persists', () => {
  rawInsertComment({ id: 'sc-null', body: 'q-null' });
  rawInsertReply({ id: 'rep-null', comment_id: 'sc-null', author_agent_id: null });
  const r = FakeBetterSqlite.rawAll(
    `SELECT author_agent_id FROM selection_comment_replies WHERE id='rep-null'`)[0];
  assert.equal(r.author_agent_id, null, 'a null author is stored, not rejected');
});

test('the comment_id FK rejects a reply for a nonexistent comment', () => {
  // pragma() is a no-op through the fake, so enable FK enforcement on the raw store.
  FakeBetterSqlite.rawExec(`PRAGMA foreign_keys = ON`);
  rawInsertComment({ id: 'sc-fk', body: 'q-fk' });
  // Parent exists → accepted.
  rawInsertReply({ id: 'rep-fk-ok', comment_id: 'sc-fk' });
  // No such parent comment → rejected.
  assert.throws(() => rawInsertReply({ id: 'rep-fk-bad', comment_id: 'sc-does-not-exist' }));
});

test('the question row is byte-untouched by a reply insert', () => {
  rawInsertComment({ id: 'sc-immut', body: 'the original question', status: 'sent' });
  const before = FakeBetterSqlite.rawAll(`SELECT * FROM selection_comments WHERE id='sc-immut'`)[0];
  rawInsertReply({ id: 'rep-immut', comment_id: 'sc-immut', body: 'an answer that must not bleed into the question' });
  const after = FakeBetterSqlite.rawAll(`SELECT * FROM selection_comments WHERE id='sc-immut'`)[0];
  assert.deepEqual(after, before, 'inserting a reply must not mutate the question row (body or status)');
  assert.equal(after.body, 'the original question', 'body unchanged');
  assert.equal(after.status, 'sent', 'delivery-status machine untouched');
});

test('no additive answer columns landed on selection_comments', () => {
  const cols = FakeBetterSqlite.rawAll(`PRAGMA table_info(selection_comments)`).map((r) => String(r.name));
  for (const c of ['answer', 'answer_body', 'answered_at', 'answered_by', 'reply', 'reply_body', 'reply_count']) {
    assert.equal(cols.includes(c), false, `selection_comments must not carry additive answer column ${c}`);
  }
});

test('re-running initDatabase is idempotent (table + index + data survive a double run)', () => {
  rawInsertComment({ id: 'sc-idem', body: 'q-idem' });
  rawInsertReply({ id: 'rep-idem', comment_id: 'sc-idem' });
  const before = FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM selection_comment_replies WHERE id='rep-idem'`)[0].n;
  dbm.initDatabase();
  const after = FakeBetterSqlite.rawAll(
    `SELECT COUNT(*) AS n FROM selection_comment_replies WHERE id='rep-idem'`)[0].n;
  assert.equal(after, before, 'a second migration pass must not throw or drop data');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'selcomment-replies-'));
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
