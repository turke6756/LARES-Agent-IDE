// Idle-agent lifecycle §B2/§B3 — migration + atomic status-transition writer.
//
// Covers:
//   - the additive migration adds all four columns and backfills them
//     (status_changed_at = COALESCE(updated_at, migratedAt); idle_since =
//     migratedAt for `idle` rows ONLY, NULL for everything else);
//   - the migration is idempotent — a second pass adds nothing and, crucially,
//     does NOT re-stamp a live idle clock;
//   - applyStatusTransition returns {prior, current} from an in-transaction
//     read, and null for an unknown agent;
//   - an invalid stop reason is rejected BEFORE anything is persisted;
//   - the projection-only 'receiving' status is rejected at RUNTIME (the
//     PersistedAgentStatus parameter type covers compile time);
//   - idle → idle preserves idle_since; leaving idle clears it;
//   - a reasoned stop sets stopped_at/last_stop_reason, a genuine reasonless
//     status change clears them, and a REDUNDANT reasonless done → done write
//     PRESERVES them (a second Stop click must not erase "Stopped manually");
//   - rowToAgent projects the four fields, coalescing statusChangedAt and
//     parsing an unmapped last_stop_reason down to null.
//
// better-sqlite3's native binding is built against Electron's ABI and won't
// load under the system Node that `npm run test:supervisor` uses, so this test
// injects a sql.js (wasm SQLite) stand-in into require.cache BEFORE requiring
// ../database (same precedent as database.test.ts).
//
//   npm run build:main
//   node dist/main/main/lifecycle-transition.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, AgentStatus } from '../shared/types';

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
let liveDb: FakeBetterSqlite | null = null;

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
    liveDb = this;
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

type DbModule = {
  initDatabase(): void;
  migrateLifecycleColumns(database: unknown): void;
  applyStatusTransition(
    id: string,
    status: Exclude<AgentStatus, 'receiving'>,
    opts?: { stopReason?: string },
  ): { prior: AgentStatus; current: AgentStatus } | null;
  updateAgentStatus(id: string, status: Exclude<AgentStatus, 'receiving'>): void;
  createAgent(data: Record<string, unknown>): Agent;
  getAgent(id: string): Agent | null;
};
let dbm: DbModule;
/** The handle the database module itself opened (captured before any test
 *  constructs its own isolated FakeBetterSqlite and steals `liveDb`). */
let moduleDb: FakeBetterSqlite;

let agentSeq = 0;
function makeAgentRow(over: Record<string, unknown> = {}): Agent {
  return dbm.createAgent({
    workspaceId: `ws-life-${++agentSeq}`,
    title: 'worker',
    roleDescription: '',
    workingDirectory: 'C:\\repo',
    command: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: 'C:\\repo\\a.log',
    ...over,
  });
}

function rawRow(id: string): Record<string, unknown> {
  return moduleDb.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Record<string, unknown>;
}

function setRaw(id: string, col: string, value: unknown): void {
  // Column names here are test-authored literals, never user input.
  moduleDb.prepare(`UPDATE agents SET ${col} = ? WHERE id = ?`).run(value, id);
}

// ── §B2 migration (isolated handle, pre-migration schema) ─────────────────────

/** A stand-in `agents` table shaped like the pre-migration schema. */
function freshLegacyDb(name: string): FakeBetterSqlite {
  const d = new FakeBetterSqlite(name);
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id         TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'launching',
      created_at TEXT,
      updated_at TEXT
    )
  `);
  return d;
}

function columnsOf(d: FakeBetterSqlite): string[] {
  return (d.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name);
}

test('§B2 migration adds all four lifecycle columns', () => {
  const d = freshLegacyDb('mig-add');
  dbm.migrateLifecycleColumns(d);
  const cols = columnsOf(d);
  for (const c of ['status_changed_at', 'idle_since', 'stopped_at', 'last_stop_reason']) {
    assert.ok(cols.includes(c), `expected column ${c}`);
  }
});

test('§B2 backfill: status_changed_at = updated_at when present, else migratedAt', () => {
  const d = freshLegacyDb('mig-scat');
  d.prepare(`INSERT INTO agents (id, status, created_at, updated_at) VALUES (?,?,?,?)`)
    .run('a-has-updated', 'working', '2020-01-01 00:00:00', '2021-06-06 06:06:06');
  d.prepare(`INSERT INTO agents (id, status, created_at, updated_at) VALUES (?,?,?,?)`)
    .run('a-null-updated', 'working', '2020-01-01 00:00:00', null);
  dbm.migrateLifecycleColumns(d);
  const get = (id: string) =>
    (d.prepare(`SELECT status_changed_at AS v FROM agents WHERE id = ?`).get(id) as { v: string | null }).v;
  assert.equal(get('a-has-updated'), '2021-06-06 06:06:06', 'COALESCE prefers updated_at');
  assert.ok(get('a-null-updated'), 'a NULL updated_at falls back to the captured migratedAt');
  assert.notEqual(get('a-null-updated'), null);
});

test('§B2 backfill: idle_since is stamped for idle rows ONLY', () => {
  const d = freshLegacyDb('mig-idle');
  for (const [id, status] of [['i1', 'idle'], ['w1', 'working'], ['d1', 'done'], ['c1', 'crashed']]) {
    d.prepare(`INSERT INTO agents (id, status, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(id, status, '2020-01-01 00:00:00', '2020-01-01 00:00:00');
  }
  dbm.migrateLifecycleColumns(d);
  const idleSince = (id: string) =>
    (d.prepare(`SELECT idle_since AS v FROM agents WHERE id = ?`).get(id) as { v: string | null }).v;
  assert.ok(idleSince('i1'), 'an already-idle row gets the migration instant as its clock');
  assert.equal(idleSince('w1'), null);
  assert.equal(idleSince('d1'), null);
  assert.equal(idleSince('c1'), null, 'non-idle rows must never carry a fabricated idle age');
});

test('§B2 backfill uses ONE migratedAt for every row (no smear)', () => {
  const d = freshLegacyDb('mig-single-stamp');
  for (const id of ['x1', 'x2', 'x3']) {
    d.prepare(`INSERT INTO agents (id, status, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(id, 'idle', '2020-01-01 00:00:00', null);
  }
  dbm.migrateLifecycleColumns(d);
  const stamps = (d.prepare(`SELECT DISTINCT idle_since AS v FROM agents`).all() as { v: string }[]);
  assert.equal(stamps.length, 1, 'all backfilled rows share one instant');
});

test('§B2 migration is idempotent — a second pass is a no-op and never re-stamps idle_since', () => {
  const d = freshLegacyDb('mig-idem');
  d.prepare(`INSERT INTO agents (id, status, created_at, updated_at) VALUES (?,?,?,?)`)
    .run('a1', 'idle', '2020-01-01 00:00:00', '2020-01-01 00:00:00');
  dbm.migrateLifecycleColumns(d);
  const first = d.prepare(`SELECT idle_since AS v FROM agents WHERE id = 'a1'`).get() as { v: string };
  // Age the clock, then re-run: an idempotent migration must not touch it.
  d.prepare(`UPDATE agents SET idle_since = ? WHERE id = 'a1'`).run('2019-01-01 00:00:00');
  assert.doesNotThrow(() => dbm.migrateLifecycleColumns(d), 'second pass must not throw');
  const second = d.prepare(`SELECT idle_since AS v FROM agents WHERE id = 'a1'`).get() as { v: string };
  assert.equal(second.v, '2019-01-01 00:00:00', 'a live idle clock survives re-running the migration');
  assert.ok(first.v, 'sanity: the first pass did stamp it');
  assert.equal(columnsOf(d).filter((c) => c === 'idle_since').length, 1, 'no duplicate column');
});

// ── §B3 applyStatusTransition ─────────────────────────────────────────────────

test('applyStatusTransition returns {prior, current} from the in-transaction read', () => {
  const a = makeAgentRow(); // createAgent defaults to 'launching'
  const t = dbm.applyStatusTransition(a.id, 'working');
  assert.deepEqual(t, { prior: 'launching', current: 'working' });
  assert.equal(dbm.getAgent(a.id)!.status, 'working');
});

test('applyStatusTransition returns null for an unknown agent', () => {
  assert.equal(dbm.applyStatusTransition('no-such-agent', 'done'), null);
});

test('applyStatusTransition REJECTS an invalid stop reason before persisting anything', () => {
  const a = makeAgentRow();
  assert.throws(
    () => dbm.applyStatusTransition(a.id, 'done', { stopReason: 'because-i-said-so' }),
    /invalid stop reason/,
  );
  assert.equal(dbm.getAgent(a.id)!.status, 'launching', 'the status write did not happen');
  assert.equal(rawRow(a.id).last_stop_reason ?? null, null);
});

test("applyStatusTransition REJECTS 'receiving' at runtime (projection-only status)", () => {
  const a = makeAgentRow();
  assert.throws(
    () => dbm.applyStatusTransition(a.id, 'receiving' as Exclude<AgentStatus, 'receiving'>),
    /projection-only/,
  );
  assert.equal(dbm.getAgent(a.id)!.status, 'launching', 'nothing persisted');
});

test('entering idle stamps idle_since; idle → idle keeps it STABLE', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'idle');
  const stamped = rawRow(a.id).idle_since as string;
  assert.ok(stamped, 'idle_since stamped on entering idle');
  // Age it so a re-stamp would be unmistakable.
  setRaw(a.id, 'idle_since', '2019-05-05 05:05:05');
  dbm.applyStatusTransition(a.id, 'idle');
  assert.equal(rawRow(a.id).idle_since, '2019-05-05 05:05:05', 'a redundant idle write must not reset the clock');
});

test('leaving idle CLEARS idle_since', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'idle');
  assert.ok(rawRow(a.id).idle_since);
  dbm.applyStatusTransition(a.id, 'working');
  assert.equal(rawRow(a.id).idle_since ?? null, null);
});

test('status_changed_at moves only on a genuine status CHANGE', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'working');
  setRaw(a.id, 'status_changed_at', '2019-01-01 00:00:00');
  dbm.applyStatusTransition(a.id, 'working'); // redundant
  assert.equal(rawRow(a.id).status_changed_at, '2019-01-01 00:00:00', 'no change → not touched');
  dbm.applyStatusTransition(a.id, 'idle'); // genuine
  assert.notEqual(rawRow(a.id).status_changed_at, '2019-01-01 00:00:00');
});

test('a reasoned stop sets stopped_at + last_stop_reason', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'done', { stopReason: 'manual-card' });
  const row = rawRow(a.id);
  assert.ok(row.stopped_at, 'stopped_at stamped');
  assert.equal(row.last_stop_reason, 'manual-card');
  assert.equal(dbm.getAgent(a.id)!.lastStopReason, 'manual-card');
});

test('a REDUNDANT reasonless done → done write PRESERVES stopped_at / last_stop_reason', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'done', { stopReason: 'manual-card' });
  const stoppedAt = rawRow(a.id).stopped_at as string;
  // The second Stop click / an idempotent re-write must not erase the badge.
  dbm.applyStatusTransition(a.id, 'done');
  const row = rawRow(a.id);
  assert.equal(row.stopped_at, stoppedAt, 'stopped_at preserved');
  assert.equal(row.last_stop_reason, 'manual-card', 'last_stop_reason preserved');
});

test('a genuine reasonless status CHANGE clears the stop metadata', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'done', { stopReason: 'manual-card' });
  dbm.applyStatusTransition(a.id, 'restarting'); // restart: no longer stopped
  const row = rawRow(a.id);
  assert.equal(row.stopped_at ?? null, null);
  assert.equal(row.last_stop_reason ?? null, null);
});

test('a natural exit (reasonless done) leaves the stop metadata NULL', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'working');
  dbm.applyStatusTransition(a.id, 'done'); // runner-exit path, no stop reason
  const row = rawRow(a.id);
  assert.equal(row.stopped_at ?? null, null, 'a crash/natural exit is not a "stop"');
  assert.equal(row.last_stop_reason ?? null, null);
});

test('updateAgentStatus is a shim over the transition writer (bookkeeping still maintained)', () => {
  const a = makeAgentRow();
  dbm.updateAgentStatus(a.id, 'idle');
  assert.ok(rawRow(a.id).idle_since, 'the shim maintains idle_since too');
  dbm.updateAgentStatus(a.id, 'working');
  assert.equal(rawRow(a.id).idle_since ?? null, null);
});

// ── §B3.1 field plumbing ──────────────────────────────────────────────────────

test('rowToAgent projects the four lifecycle fields', () => {
  const a = makeAgentRow();
  dbm.applyStatusTransition(a.id, 'idle');
  const projected = dbm.getAgent(a.id)!;
  assert.ok(projected.statusChangedAt, 'statusChangedAt non-null at the TS boundary');
  assert.ok(projected.idleSince, 'idleSince exposed');
  assert.equal(projected.stoppedAt, null);
  assert.equal(projected.lastStopReason, null);
});

test('rowToAgent coalesces statusChangedAt when the column is NULL', () => {
  const a = makeAgentRow();
  setRaw(a.id, 'status_changed_at', null);
  const projected = dbm.getAgent(a.id)!;
  assert.ok(projected.statusChangedAt, 'falls back to updated_at ?? created_at');
});

test('rowToAgent maps an unmapped last_stop_reason to null (parseStopReason)', () => {
  const a = makeAgentRow();
  setRaw(a.id, 'last_stop_reason', 'reason-from-a-future-version');
  assert.equal(dbm.getAgent(a.id)!.lastStopReason, null, 'garbage never leaks into the UI');
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-transition-'));
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
  moduleDb = liveDb!; // capture BEFORE any test opens its own isolated handle

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
