// SC-WP-1A — query-only turn witness reads (bundle contract §3).
//
//   npm run build:main
//   node dist/main/main/database.turn-witness-reads.test.js
//
// Contract against the REAL schema via the sql.js better-sqlite3 stand-in (same
// precedent as database.list-turn-records.test.ts). Proves getTurnWitnessReads:
//   - projects id / agent_id / owner_agent_id / owner_brick_generation / touched;
//   - filters `touched[]` to write/create ops only (contract §3);
//   - is ascending by turn_seq and workspace-scoped;
//   - NEVER exposes a `planId` field (no agents.plan_id read).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.list-turn-records.test.ts) ─

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

interface TurnWitnessRead {
  turnId: string;
  agentId: string | null;
  ownerAgentId: string | null;
  ownerBrickGeneration: number | null;
  touched: { path: string; op: string }[];
}
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  allocateAndInsertTurn(workspaceId: string, fields: Record<string, unknown>): { id: string };
  updateTurnRecord(id: string, updates: Record<string, unknown>): unknown;
  getTurnWitnessReads(workspaceId: string): TurnWitnessRead[];
};
let dbm: DbModule;

let wsSeq = 0;
function freshWorkspace(): string {
  return dbm.createWorkspace({ title: `sc1a-${++wsSeq}`, path: `C:\\tmp\\ws${wsSeq}`, pathType: 'windows' }).id;
}

// ── tests ───────────────────────────────────────────────────────────────────

test('projects identity + owner attribution; ascending by turn_seq', () => {
  const ws = freshWorkspace();
  const a = dbm.allocateAndInsertTurn(ws, { agentId: 'agent-1', ownerAgentId: 'sup-1', ownerBrickGeneration: 7 });
  dbm.updateTurnRecord(a.id, { touched: [{ path: 'src/a.ts', op: 'write' }] });
  const b = dbm.allocateAndInsertTurn(ws, { agentId: 'agent-2' });
  dbm.updateTurnRecord(b.id, { touched: [{ path: 'src/b.ts', op: 'create' }] });

  const reads = dbm.getTurnWitnessReads(ws);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map((r) => r.turnId), [a.id, b.id], 'ascending by turn_seq');
  assert.deepEqual(reads[0], {
    turnId: a.id,
    agentId: 'agent-1',
    ownerAgentId: 'sup-1',
    ownerBrickGeneration: 7,
    touched: [{ path: 'src/a.ts', op: 'write' }],
  });
  assert.equal(reads[1].ownerAgentId, null, 'no owner frozen → null');
  assert.equal(reads[1].ownerBrickGeneration, null);
});

test('touched[] is filtered to write/create ops only', () => {
  const ws = freshWorkspace();
  const t = dbm.allocateAndInsertTurn(ws, { agentId: 'a' });
  dbm.updateTurnRecord(t.id, {
    touched: [
      { path: 'w.ts', op: 'write' },
      { path: 'c.ts', op: 'create' },
      { path: 'r.ts', op: 'read' },
      { path: 'x.ts', op: 'rename' },
    ],
  });
  const [read] = dbm.getTurnWitnessReads(ws);
  assert.deepEqual(
    read.touched.map((e) => e.path).sort(),
    ['c.ts', 'w.ts'],
    'read/rename dropped; only write/create witness a member',
  );
});

test('NULL touched → empty array, never throws', () => {
  const ws = freshWorkspace();
  dbm.allocateAndInsertTurn(ws, { agentId: 'a' }); // never sets touched
  const [read] = dbm.getTurnWitnessReads(ws);
  assert.deepEqual(read.touched, []);
});

test('workspace-scoped: another workspace never leaks', () => {
  const ws1 = freshWorkspace();
  const ws2 = freshWorkspace();
  dbm.allocateAndInsertTurn(ws1, { agentId: 'a1' });
  dbm.allocateAndInsertTurn(ws2, { agentId: 'a2' });
  assert.equal(dbm.getTurnWitnessReads(ws1).length, 1);
  assert.equal(dbm.getTurnWitnessReads(ws2).length, 1);
  assert.equal(dbm.getTurnWitnessReads(ws1)[0].agentId, 'a1');
});

test('never exposes a planId field (no agents.plan_id read)', () => {
  const ws = freshWorkspace();
  dbm.allocateAndInsertTurn(ws, { agentId: 'a' });
  const [read] = dbm.getTurnWitnessReads(ws);
  assert.deepEqual(
    Object.keys(read).sort(),
    ['agentId', 'ownerAgentId', 'ownerBrickGeneration', 'touched', 'turnId'],
    'projection carries no plan attribution',
  );
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'sc1a-witness-'));
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
