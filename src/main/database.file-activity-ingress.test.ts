// Checkpoint Surface Hardening WP1 — addFileActivity ingress contract.
//
// Contract-level tests against the REAL schema (via the sql.js better-sqlite3
// stand-in, same precedent as turn-records.test.ts / database.active-agents.test.ts):
//   - an OSC-8 value whose recovery is AMBIGUOUS produces NO file_activities row
//     and NO witness observer call (dropped, never guessed);
//   - a clean value inserts an ABSOLUTE NATIVE path and fires the observer EXACTLY
//     ONCE, and the observer sits ABOVE the live-cache dedupe (a deduped second
//     write still witnesses even though it inserts no row);
//   - a relative value is canonicalized against the agent's working_directory.
//
//   npm run build:main
//   node dist/main/main/database.file-activity-ingress.test.js

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

type FileActivityRow = { filePath: string; operation: string } & Record<string, unknown>;
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: Record<string, unknown>): { id: string };
  addFileActivity(agentId: string, filePath: string, operation: string): unknown;
  getFileActivities(agentId: string): FileActivityRow[];
  setWitnessObserver(fn: ((agentId: string, filePath: string, op: string) => void) | null): void;
  clearWitnessObserver(): void;
};
let dbm: DbModule;

let wsSeq = 0;
function freshWorkspace(): string {
  return dbm.createWorkspace({ title: `wp1-${++wsSeq}`, path: `C:\\tmp\\ws${wsSeq}`, pathType: 'windows' }).id;
}

let agentSeq = 0;
function makeAgent(wsId: string, workingDirectory = 'C:\\repo'): string {
  return dbm.createAgent({
    workspaceId: wsId,
    title: `wp1-agent-${++agentSeq}`,
    roleDescription: '',
    workingDirectory,
    command: 'claude',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: `C:\\tmp\\agent-${agentSeq}.log`,
  }).id;
}

const ESC = '\x1b';
const ST = ESC + '\\';

// ── tests ───────────────────────────────────────────────────────────────────

test('ambiguous OSC-8 value → NO row and NO witness call (dropped, not guessed)', () => {
  const agent = makeAgent(freshWorkspace());
  const witnessed: Array<{ agentId: string; filePath: string; op: string }> = [];
  dbm.setWitnessObserver((agentId, filePath, op) => witnessed.push({ agentId, filePath, op }));
  try {
    // Nested / multiple links — ambiguous recovery.
    const raw =
      `${ESC}]8;id=1;file:///C:/a${ST}A${ESC}]8;id=2;file:///C:/b${ST}B${ESC}]8;;${ST}`;
    const result = dbm.addFileActivity(agent, raw, 'write');
    assert.equal(result, null, 'ambiguous value returns null');
    assert.equal(dbm.getFileActivities(agent).length, 0, 'no file_activities row inserted');
    assert.equal(witnessed.length, 0, 'witness observer must NOT fire for a dropped value');
  } finally {
    dbm.clearWitnessObserver();
  }
});

test('clean value → absolute native path stored + observer fires exactly once', () => {
  const agent = makeAgent(freshWorkspace());
  const witnessed: Array<{ agentId: string; filePath: string; op: string }> = [];
  dbm.setWitnessObserver((agentId, filePath, op) => witnessed.push({ agentId, filePath, op }));
  try {
    // OSC-8 intact-ST polluted value → clean absolute native path.
    const raw = `${ESC}]8;id=9;file:///C:/repo/src/main.ts${ST}C:\\repo\\src\\main.ts${ESC}]8;;${ST}`;
    const result = dbm.addFileActivity(agent, raw, 'write') as { filePath: string } | null;
    assert.ok(result, 'clean value inserts a row');
    assert.equal(result!.filePath, 'C:\\repo\\src\\main.ts', 'stored as absolute native path');

    const rows = dbm.getFileActivities(agent);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].filePath, 'C:\\repo\\src\\main.ts');

    assert.equal(witnessed.length, 1, 'observer fires exactly once');
    assert.equal(witnessed[0].filePath, 'C:\\repo\\src\\main.ts', 'observer sees the canonical path, not the raw pollution');
    assert.equal(witnessed[0].op, 'write');
  } finally {
    dbm.clearWitnessObserver();
  }
});

test('relative value is canonicalized against the agent working_directory', () => {
  const agent = makeAgent(freshWorkspace(), 'C:\\repo');
  const result = dbm.addFileActivity(agent, 'src/main.ts', 'write') as { filePath: string } | null;
  assert.ok(result);
  assert.equal(result!.filePath, 'C:\\repo\\src\\main.ts');
});

test('observer sits ABOVE the dedupe — a deduped repeat still witnesses', () => {
  const agent = makeAgent(freshWorkspace());
  const witnessed: string[] = [];
  dbm.setWitnessObserver((_a, filePath) => witnessed.push(filePath));
  try {
    const p = 'C:\\repo\\dup.ts';
    const first = dbm.addFileActivity(agent, p, 'write');
    const second = dbm.addFileActivity(agent, p, 'write'); // within the 5s window → deduped
    assert.ok(first, 'first write inserts');
    assert.equal(second, null, 'second identical write is deduped (no new row)');
    assert.equal(dbm.getFileActivities(agent).length, 1, 'exactly one row survives dedupe');
    assert.equal(witnessed.length, 2, 'BOTH writes witness — observer is above the dedupe');
  } finally {
    dbm.clearWitnessObserver();
  }
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ingress-'));
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
