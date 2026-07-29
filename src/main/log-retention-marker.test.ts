// Terminal-log retention WP-1 — the reclaimed-marker column: an idempotent
// PRAGMA-guarded migration, the WHERE-guarded write that preserves the FIRST
// value and touches only its own column, and the rowToAgent NULL→null mapping.
//
// better-sqlite3's native binding is built against Electron's ABI, so this
// injects the sql.js stand-in into require.cache BEFORE requiring ./database
// (same precedent as database.active-agents.test.ts / database.test.ts).
//
//   npm run build:main
//   node dist/main/main/log-retention-marker.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.active-agents.test.ts precedent) ──

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

// ── module under test (loaded in the runner, after the cache injection) ──────

type Agent = { id: string; terminalHistoryReclaimedAt: string | null; [k: string]: unknown };
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: Record<string, unknown>): { id: string };
  getAgent(id: string): Agent | null;
  markAgentTerminalHistoryReclaimed(agentId: string, iso: string): void;
  migrateTerminalHistoryReclaimedColumn(database: unknown): void;
};
let dbm: DbModule;
let wsId = '';
let agentSeq = 0;

function makeAgent(): string {
  const a = dbm.createAgent({
    workspaceId: wsId,
    title: `retention-marker-${++agentSeq}`,
    roleDescription: '',
    workingDirectory: 'C:\\tmp',
    command: 'claude',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: `C:\\tmp\\agent-${agentSeq}.log`,
  });
  return a.id;
}

// ── migration idempotency (raw handle, minimal agents table) ─────────────────

test('migrateTerminalHistoryReclaimedColumn is idempotent: run twice, no throw, column present', () => {
  const raw = new FakeBetterSqlite('retention-migration-idempotency');
  raw.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)');

  const colPresent = (): boolean => {
    const cols = raw.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
    return cols.some((c) => c.name === 'terminal_history_reclaimed_at');
  };

  assert.equal(colPresent(), false, 'column absent before migration');
  // First pass adds the column; second pass must be a no-op (the guarded ALTER
  // would throw "duplicate column" if it ran again).
  dbm.migrateTerminalHistoryReclaimedColumn(raw);
  assert.equal(colPresent(), true, 'column present after first migration');
  assert.doesNotThrow(() => dbm.migrateTerminalHistoryReclaimedColumn(raw), 'second pass is a no-op');
  assert.equal(colPresent(), true, 'column still present after second migration');
});

// ── rowToAgent NULL→null ─────────────────────────────────────────────────────

test('rowToAgent maps a NULL terminal_history_reclaimed_at to null', () => {
  const id = makeAgent();
  const a = dbm.getAgent(id)!;
  assert.strictEqual(a.terminalHistoryReclaimedAt, null, 'a never-reclaimed agent reads back null');
});

// ── the WHERE-guarded write ──────────────────────────────────────────────────

test('markAgentTerminalHistoryReclaimed sets the ISO value and changes NO other column', () => {
  const id = makeAgent();
  const before = dbm.getAgent(id)!;
  assert.strictEqual(before.terminalHistoryReclaimedAt, null);

  const iso1 = '2026-07-27T10:00:00.000Z';
  dbm.markAgentTerminalHistoryReclaimed(id, iso1);
  const after = dbm.getAgent(id)!;
  assert.strictEqual(after.terminalHistoryReclaimedAt, iso1, 'marker is the exact ISO string');

  // Only terminal_history_reclaimed_at moved — status, updated_at, everything
  // else must be byte-identical (the writer touches solely its own column).
  assert.deepEqual(
    { ...after, terminalHistoryReclaimedAt: before.terminalHistoryReclaimedAt },
    before,
    'no sibling column (status/updated_at/…) was disturbed',
  );
});

test('the write is idempotent: a second call is a no-op — the FIRST value is preserved', () => {
  const id = makeAgent();
  const iso1 = '2026-07-27T10:00:00.000Z';
  const iso2 = '2026-07-28T22:33:44.000Z';
  dbm.markAgentTerminalHistoryReclaimed(id, iso1);
  const first = dbm.getAgent(id)!;
  assert.strictEqual(first.terminalHistoryReclaimedAt, iso1);

  // The AND terminal_history_reclaimed_at IS NULL guard makes this a no-op —
  // the marker must survive revival and never be re-stamped.
  dbm.markAgentTerminalHistoryReclaimed(id, iso2);
  const second = dbm.getAgent(id)!;
  assert.strictEqual(second.terminalHistoryReclaimedAt, iso1, 'original value preserved, not overwritten');
  assert.deepEqual(second, first, 'the second call changed nothing at all');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile.
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-marker-'));
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
  wsId = dbm.createWorkspace({ title: 'retention-marker-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

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
