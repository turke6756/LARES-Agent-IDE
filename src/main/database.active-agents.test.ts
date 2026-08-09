// DB-level contract test — getActiveAgents() IS the live-agent registry
// (System-Memory polish Part 2.3).
//
// The System-Memory view's "Live agents" count and the sampler's
// getLiveAgentCount both consume getActiveAgents(); a sampler test only proves
// an injected number is copied — the SQL predicate is the contract. Asserted
// here against the REAL schema: every non-terminal status IS returned, the two
// terminal statuses ('done', 'crashed') are NOT.
//
// better-sqlite3's native binding is built against Electron's ABI, so this
// injects the sql.js stand-in into require.cache BEFORE requiring ./database
// (same precedent as continuation-lifecycle.test.ts / database.test.ts).
//
//   npm run build:main
//   node dist/main/main/database.active-agents.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.test.ts precedent) ───────

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

type DbAgentRow = { id: string; status: string };
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string; path: string };
  createAgent(data: Record<string, unknown>): DbAgentRow;
  updateAgentStatus(id: string, status: string): void;
  getActiveAgents(): DbAgentRow[];
  saveAgentContextStats(stats: Record<string, unknown>): void;
  getAgentContextStats(agentId: string): Record<string, unknown> | null;
  deleteAgent(id: string): void;
};
let dbm: DbModule;
let wsId = '';
let agentSeq = 0;

function makeAgent(status: string): DbAgentRow {
  const a = dbm.createAgent({
    workspaceId: wsId,
    title: `active-agents-${status}-${++agentSeq}`,
    roleDescription: '',
    workingDirectory: 'C:\\tmp',
    command: 'claude',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: `C:\\tmp\\agent-${agentSeq}.log`,
  });
  dbm.updateAgentStatus(a.id, status);
  return a;
}

// ── the predicate ─────────────────────────────────────────────────────────────

const LIVE_STATUSES = ['launching', 'working', 'idle', 'waiting', 'restarting'] as const;
const TERMINAL_STATUSES = ['done', 'crashed'] as const;

test('every non-terminal status IS returned by getActiveAgents()', () => {
  const made = LIVE_STATUSES.map((s) => ({ status: s, id: makeAgent(s).id }));
  const activeIds = new Set(dbm.getActiveAgents().map((a) => a.id));
  for (const m of made) {
    assert.ok(activeIds.has(m.id), `status '${m.status}' must be in the live registry`);
  }
});

test("terminal statuses ('done', 'crashed') are NOT returned", () => {
  const made = TERMINAL_STATUSES.map((s) => ({ status: s, id: makeAgent(s).id }));
  const activeIds = new Set(dbm.getActiveAgents().map((a) => a.id));
  for (const m of made) {
    assert.ok(!activeIds.has(m.id), `status '${m.status}' must be excluded from the live registry`);
  }
});

test('a live agent leaves the registry the moment it goes terminal', () => {
  const a = makeAgent('idle');
  assert.ok(dbm.getActiveAgents().some((r) => r.id === a.id));
  dbm.updateAgentStatus(a.id, 'done');
  assert.ok(!dbm.getActiveAgents().some((r) => r.id === a.id));
});

test('last context snapshot remains readable after an agent goes terminal', () => {
  const a = makeAgent('idle');
  dbm.saveAgentContextStats({
    agentId: a.id,
    sessionId: 'session-1',
    model: 'claude-sonnet-4-5',
    inputTokens: 80_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1_000,
    totalOutputTokens: 2_000,
    totalContextTokens: 84_000,
    contextWindowMax: 200_000,
    contextPercentage: 42,
    turnCount: 7,
    lastUpdatedAt: '2026-08-03T12:00:00.000Z',
  });
  dbm.updateAgentStatus(a.id, 'done');

  assert.equal(dbm.getAgentContextStats(a.id)?.contextPercentage, 42);
  dbm.deleteAgent(a.id);
  assert.equal(dbm.getAgentContextStats(a.id), null, 'deleting the card also deletes its snapshot');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile.
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'active-agents-'));
  process.env.APPDATA = tmpAppData;

  // sql.js init is async; resolve the wasm module first, then inject the
  // stand-in and load ./database.
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
  wsId = dbm.createWorkspace({ title: 'active-agents-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

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
