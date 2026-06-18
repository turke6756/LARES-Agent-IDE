// Slice 10/11 session-store acceptance tests
// (plans/premium-browser-frozen-tab-model.md §12).
//
// Covers the DB-side contract the slice adds:
//   - loadSession / replaceSession round-trip incl. nullable workspace_id /
//     group_id / scroll_y;
//   - pushClosedTab evicts the oldest beyond 25 PER WORKSPACE (two workspaces do
//     not cross-evict);
//   - popClosedTab returns the newest then deletes it; empty -> null;
//   - peekNewestClosedAt reflects the stack without mutating it;
//   - the partition CHECK rejects a non-'user' insert (DiD atop the manager gate).
//
// better-sqlite3's native binding is built against Electron's ABI and won't load
// under the system Node that `npm run test:supervisor` uses, so this test injects
// a sql.js (wasm SQLite) stand-in into require.cache BEFORE requiring ../database
// (same precedent as history-store.test.ts / access-policy-store.test.ts).
//
//   npm run build:main
//   node dist/main/main/browser/session-store.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in ─────────────────────────────────────

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

// ── modules under test (loaded after the cache injection) ─────────────────────

type StoreModule = typeof import('./session-store');
type DbModule = typeof import('../database');
let store: StoreModule;
let db: DbModule;

function tab(over: Partial<import('./session-store').SessionTabRow> & { tabId: string; sortOrder: number }): import('./session-store').SessionTabRow {
  return {
    workspaceId: null,
    url: `https://${over.tabId}.test/`,
    title: over.tabId,
    pinned: false,
    groupId: null,
    active: false,
    ...over,
  };
}

// ── REQUIRED: round-trip incl. nullable columns ───────────────────────────────

test('REQUIRED: loadSession/replaceSession round-trip incl. nullable workspace/group/scroll', () => {
  store.clearSession();
  store.replaceSession([
    tab({ tabId: 't-a', sortOrder: 0, workspaceId: 'ws-1', pinned: true, active: true, scrollY: 420, favicon: 'https://a.test/i.png' }),
    tab({ tabId: 't-b', sortOrder: 1, workspaceId: null, groupId: null }), // null workspace + null scroll
  ]);
  const rows = store.loadSession();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.tabId), ['t-a', 't-b'], 'ORDER BY sort_order ASC');
  const a = rows[0];
  assert.equal(a.workspaceId, 'ws-1');
  assert.equal(a.pinned, true);
  assert.equal(a.active, true);
  assert.equal(a.scrollY, 420);
  assert.equal(a.favicon, 'https://a.test/i.png');
  const b = rows[1];
  assert.equal(b.workspaceId, null, 'nullable workspace round-trips');
  assert.equal(b.groupId, null, 'nullable group round-trips');
  assert.equal(b.scrollY, undefined, 'null scroll_y -> undefined');
  assert.equal(b.favicon, undefined, 'null favicon -> undefined');
});

test('replaceSession is a full rewrite (prior rows gone)', () => {
  store.clearSession();
  store.replaceSession([tab({ tabId: 'old', sortOrder: 0 })]);
  store.replaceSession([tab({ tabId: 'new', sortOrder: 0 })]);
  assert.deepEqual(store.loadSession().map((r) => r.tabId), ['new']);
});

// ── REQUIRED: closed-tab eviction per workspace ───────────────────────────────

test('REQUIRED: pushClosedTab evicts the oldest beyond 25 per workspace; workspaces do not cross-evict', () => {
  store.clearSession();
  // 30 closes in workspace A — only the newest 25 survive.
  for (let i = 0; i < 30; i++) {
    store.pushClosedTab({ workspaceId: 'A', url: `https://a${i}.test/`, title: `A${i}`, groupId: null, closedAt: 1000 + i });
  }
  // A handful in workspace B — untouched by A's eviction.
  for (let i = 0; i < 3; i++) {
    store.pushClosedTab({ workspaceId: 'B', url: `https://b${i}.test/`, title: `B${i}`, groupId: null, closedAt: 5000 + i });
  }

  // Drain A and count.
  const aUrls: string[] = [];
  for (;;) {
    const r = store.popClosedTab('A');
    if (!r) break;
    aUrls.push(r.url);
  }
  assert.equal(aUrls.length, 25, 'A capped at 25');
  assert.equal(aUrls[0], 'https://a29.test/', 'newest first');
  assert.ok(!aUrls.includes('https://a4.test/'), 'a4 (oldest beyond cap) evicted');
  assert.ok(aUrls.includes('https://a5.test/'), 'a5 retained (boundary of the 25)');

  // B is intact.
  let bCount = 0;
  while (store.popClosedTab('B')) bCount++;
  assert.equal(bCount, 3, 'workspace B untouched by A eviction');
});

test('popClosedTab returns newest then deletes; empty -> null', () => {
  store.clearSession();
  store.pushClosedTab({ workspaceId: null, url: 'https://one.test/', title: '1', groupId: null, closedAt: 10 });
  store.pushClosedTab({ workspaceId: null, url: 'https://two.test/', title: '2', groupId: null, closedAt: 20 });
  assert.equal(store.peekNewestClosedAt(null), 20, 'peek sees newest without mutating');
  const first = store.popClosedTab(null);
  assert.equal(first?.url, 'https://two.test/', 'newest popped first');
  assert.equal(store.peekNewestClosedAt(null), 10, 'peek now sees the remaining');
  const second = store.popClosedTab(null);
  assert.equal(second?.url, 'https://one.test/');
  assert.equal(store.popClosedTab(null), null, 'empty -> null');
  assert.equal(store.peekNewestClosedAt(null), null, 'peek empty -> null');
});

// ── REQUIRED: partition CHECK rejects a non-'user' insert (DiD) ────────────────

test('REQUIRED: the partition CHECK rejects a non-user session insert', () => {
  store.clearSession();
  assert.throws(
    () => db.getDb().prepare(
      `INSERT INTO browser_session (tab_id, url, partition, sort_order, updated_at) VALUES ('x', 'https://x.test/', 'agent', 0, 0)`,
    ).run(),
    /CHECK|constraint/i,
    'agent partition is a hard DB error',
  );
});

// ── Run ───────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  db = require('../database') as DbModule;
  db.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  store = require('./session-store') as StoreModule;

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
