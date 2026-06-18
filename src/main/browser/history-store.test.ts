// Slice-8 history-store acceptance tests (plans/premium-browser-experience.md
// §"Slice 8 — History upgrade").
//
// Covers the DB-side contract the slice adds:
//   - topSites(limit) orders by FREQUENCY (visit_count DESC) then RECENCY
//     (visited_at DESC), and honors the limit;
//   - recordVisit caches a favicon and COALESCE-preserves it across a later
//     favicon-less visit (so a transient nav event can't blank a known icon);
//   - clearHistory empties the table.
//
// (The "agent visits never appear" required test lives in browser-manager.test.ts
//  — the partition gate is in the manager's recordVisitIfUser, not this store.)
//
// better-sqlite3's native binding is built against Electron's ABI and won't load
// under the system Node that `npm run test:supervisor` uses, so this test injects
// a sql.js (wasm SQLite) stand-in into require.cache BEFORE requiring ../database
// (same precedent as access-policy-store.test.ts / selection-comments-db.test.ts).
//
//   npm run build:main
//   node dist/main/main/browser/history-store.test.js

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

type StoreModule = typeof import('./history-store');
type DbModule = typeof import('../database');
let store: StoreModule;
let db: DbModule;

/** Insert a history row with an explicit visit_count + visited_at so ordering is
 *  deterministic (recordVisit always stamps Date.now(), which can't express a
 *  controlled recency tie). */
function seed(id: string, url: string, visitCount: number, visitedAt: number): void {
  db.getDb()
    .prepare(
      'INSERT INTO browser_history (id, url, title, visited_at, visit_count, favicon) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, url, url, visitedAt, visitCount, null);
}

// ── REQUIRED: top sites ordered by frequency then recency ─────────────────────

test('REQUIRED: topSites orders by visit_count DESC, then visited_at DESC', () => {
  store.clearHistory();
  seed('h-high', 'https://high.test/', 10, 1_000);
  seed('h-mid-recent', 'https://mid-recent.test/', 5, 9_000);
  seed('h-mid-old', 'https://mid-old.test/', 5, 2_000);
  seed('h-low', 'https://low.test/', 1, 9_999);

  const top = store.topSites(10);
  assert.deepEqual(
    top.map((e) => e.url),
    [
      'https://high.test/',       // highest frequency
      'https://mid-recent.test/', // tie at 5 → more recent first
      'https://mid-old.test/',    // tie at 5 → older second
      'https://low.test/',        // lowest frequency last
    ],
  );
});

test('topSites honors the limit', () => {
  store.clearHistory();
  for (let i = 0; i < 12; i++) seed(`t-${i}`, `https://site${i}.test/`, 12 - i, i);
  assert.equal(store.topSites(5).length, 5);
  assert.equal(store.topSites(5)[0].url, 'https://site0.test/', 'highest count first');
});

// ── favicon caching + COALESCE preservation ───────────────────────────────────

test('recordVisit stores a favicon and bumps visit_count on a repeat visit', () => {
  store.clearHistory();
  store.recordVisit('https://fav.test/', 'Fav', 'https://fav.test/icon.png');
  let row = store.topSites(10).find((e) => e.url === 'https://fav.test/');
  assert.equal(row?.favicon, 'https://fav.test/icon.png');
  assert.equal(row?.visitCount, 1);

  // A second visit with no favicon must NOT blank the cached one (COALESCE).
  store.recordVisit('https://fav.test/', 'Fav 2', undefined);
  row = store.topSites(10).find((e) => e.url === 'https://fav.test/');
  assert.equal(row?.favicon, 'https://fav.test/icon.png', 'favicon preserved across a favicon-less visit');
  assert.equal(row?.visitCount, 2, 'visit_count bumped');
  assert.equal(row?.title, 'Fav 2', 'title refreshed');
});

test('clearHistory empties the table', () => {
  store.recordVisit('https://x.test/', 'X');
  assert.ok(store.topSites(10).length > 0);
  store.clearHistory();
  assert.equal(store.topSites(10).length, 0);
});

// ── Run ───────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'history-store-'));
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
  store = require('./history-store') as StoreModule;

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
