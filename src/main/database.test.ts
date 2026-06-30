// Data-hygiene migration test — normalizeLegacyChromeDefaultCommands.
//
// Covers the legacy `--chrome` default_command cleanup:
//   - legacy framework default `claude --dangerously-skip-permissions --chrome`
//     is rewritten to DEFAULT_COMMAND;
//   - the WSL legacy default `ccode --dangerously-skip-permissions --chrome`
//     is rewritten to DEFAULT_COMMAND_WSL;
//   - a genuinely-custom command that merely CONTAINS `--chrome`
//     (e.g. with an extra flag) is left untouched;
//   - a row already on the framework default is untouched;
//   - the migration is idempotent (running twice changes nothing further).
//
// better-sqlite3's native binding is built against Electron's ABI and won't load
// under the system Node that `npm run test:supervisor` uses, so this test injects
// a sql.js (wasm SQLite) stand-in into require.cache BEFORE requiring ../database
// (same precedent as selection-comments-db.test.ts / history-store.test.ts).
//
//   npm run build:main
//   node dist/main/main/database.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL } from '../shared/constants';

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

// ── database module under test (loaded after the cache injection) ─────────────

type DbAgent = {
  id: string;
  workspaceId: string;
  status: string;
  isSupervisor: boolean;
  isSupervised: boolean;
  ownerAgentId: string | null;
  notifyOwner?: boolean;
};
type CreateAgentData = {
  workspaceId: string;
  title: string;
  roleDescription: string;
  workingDirectory: string;
  command: string;
  isSupervisor?: boolean;
  isSupervised?: boolean;
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  logPath: string;
  ownerAgentId?: string | null;
  notifyOwner?: boolean;
};
type DbModule = {
  initDatabase(): void;
  normalizeLegacyChromeDefaultCommands(database: unknown): void;
  createAgent(data: CreateAgentData): DbAgent;
  getAgent(id: string): DbAgent | null;
  getSupervisorAgent(workspaceId: string): DbAgent | null;
  getOwnerForWorker(worker: DbAgent): DbAgent | null;
  updateAgentStatus(id: string, status: string): void;
  deleteAgent(id: string): void;
};
let dbm: DbModule;

let wsCounter = 0;
function insertWorkspace(defaultCommand: string): string {
  const id = `ws-${++wsCounter}`;
  liveDb!.prepare(
    `INSERT INTO workspaces (id, title, path, path_type, default_command)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, `title-${id}`, `C:\\repo\\${id}`, 'windows', defaultCommand);
  return id;
}
function commandOf(id: string): string {
  const row = liveDb!.prepare(`SELECT default_command FROM workspaces WHERE id = ?`).get(id) as
    | { default_command: string }
    | undefined;
  return row!.default_command;
}

// ── tests ─────────────────────────────────────────────────────────────────────

const LEGACY = `${DEFAULT_COMMAND} --chrome`;
const LEGACY_WSL = `${DEFAULT_COMMAND_WSL} --chrome`;

test('legacy claude default with trailing --chrome normalizes to DEFAULT_COMMAND', () => {
  const id = insertWorkspace(LEGACY);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(id), DEFAULT_COMMAND);
});

test('legacy WSL default with trailing --chrome normalizes to DEFAULT_COMMAND_WSL', () => {
  const id = insertWorkspace(LEGACY_WSL);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(id), DEFAULT_COMMAND_WSL);
});

test('genuinely-custom command containing --chrome is left untouched', () => {
  const custom = `${DEFAULT_COMMAND} --chrome --foo`;
  const id = insertWorkspace(custom);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(id), custom, 'extra flag means it is NOT a framework default modulo --chrome');
});

test('an unrelated custom command (no --chrome) is left untouched', () => {
  const custom = 'claude --resume --model opus';
  const id = insertWorkspace(custom);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(id), custom);
});

test('a row already on the framework default is untouched', () => {
  const id = insertWorkspace(DEFAULT_COMMAND);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(id), DEFAULT_COMMAND);
});

test('migration is idempotent — a second pass changes nothing', () => {
  const legacy = insertWorkspace(LEGACY);
  const custom = insertWorkspace(`${DEFAULT_COMMAND} --chrome --foo`);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  const afterFirstLegacy = commandOf(legacy);
  const afterFirstCustom = commandOf(custom);
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(legacy), afterFirstLegacy, 'legacy row stable on re-run');
  assert.equal(commandOf(legacy), DEFAULT_COMMAND);
  assert.equal(commandOf(custom), afterFirstCustom, 'custom row stable on re-run');
});

test('mixed batch: only legacy-default rows are normalized in one pass', () => {
  const a = insertWorkspace(LEGACY);
  const b = insertWorkspace(LEGACY_WSL);
  const c = insertWorkspace(`${DEFAULT_COMMAND} --chrome --extra`);
  const d = insertWorkspace('some-other-cli --flag');
  dbm.normalizeLegacyChromeDefaultCommands(liveDb);
  assert.equal(commandOf(a), DEFAULT_COMMAND);
  assert.equal(commandOf(b), DEFAULT_COMMAND_WSL);
  assert.equal(commandOf(c), `${DEFAULT_COMMAND} --chrome --extra`);
  assert.equal(commandOf(d), 'some-other-cli --flag');
});

// ── Agent-ownership primitive ────────────────────────────────────────────────

let agentWs = 0;
function makeAgentRow(over: Partial<CreateAgentData> = {}): DbAgent {
  const ws = over.workspaceId ?? `ws-own-${++agentWs}`;
  return dbm.createAgent({
    workspaceId: ws,
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

test('createAgent / rowToAgent round-trips ownerAgentId', () => {
  const owner = makeAgentRow({ workspaceId: 'ws-rt', isSupervisor: true });
  const child = makeAgentRow({ workspaceId: 'ws-rt', ownerAgentId: owner.id });
  assert.equal(child.ownerAgentId, owner.id);
  assert.equal(dbm.getAgent(child.id)!.ownerAgentId, owner.id);
});

test('createAgent defaults ownerAgentId to null when omitted', () => {
  const a = makeAgentRow();
  assert.equal(a.ownerAgentId, null);
  assert.equal(dbm.getAgent(a.id)!.ownerAgentId, null);
});

// ── notifyOwner mute round-trips ─────────────────────────────────────────────

test('createAgent defaults notifyOwner to true when omitted', () => {
  const a = makeAgentRow();
  assert.equal(a.notifyOwner, true, 'omitted → notify (default preserves prior behavior)');
  assert.equal(dbm.getAgent(a.id)!.notifyOwner, true);
});

test('createAgent / rowToAgent round-trips notifyOwner: false (muted but still owned)', () => {
  const owner = makeAgentRow({ workspaceId: 'ws-mute', isSupervisor: true });
  const muted = makeAgentRow({ workspaceId: 'ws-mute', ownerAgentId: owner.id, notifyOwner: false });
  // Muted does NOT mean unowned — the edge survives, only notification is off.
  assert.equal(muted.ownerAgentId, owner.id, 'ownership intact under mute');
  assert.equal(muted.notifyOwner, false);
  const reread = dbm.getAgent(muted.id)!;
  assert.equal(reread.ownerAgentId, owner.id);
  assert.equal(reread.notifyOwner, false, 'false survives the DB round-trip');
});

test('createAgent / rowToAgent round-trips notifyOwner: true explicitly', () => {
  const a = makeAgentRow({ notifyOwner: true });
  assert.equal(a.notifyOwner, true);
  assert.equal(dbm.getAgent(a.id)!.notifyOwner, true);
});

test('getOwnerForWorker (i) live owner → owner', () => {
  const ws = 'ws-resolver-i';
  const sup = makeAgentRow({ workspaceId: ws, isSupervisor: true });
  const owner = makeAgentRow({ workspaceId: ws, isSupervised: false });
  const worker = makeAgentRow({ workspaceId: ws, ownerAgentId: owner.id });
  void sup;
  // Owner is 'launching' (non-terminal) by default, so step 1 returns it directly.
  assert.equal(dbm.getOwnerForWorker(dbm.getAgent(worker.id)!)!.id, owner.id);
});

test('getOwnerForWorker (ii) terminal owner → structural supervisor', () => {
  const ws = 'ws-resolver-ii';
  const sup = makeAgentRow({ workspaceId: ws, isSupervisor: true });
  const owner = makeAgentRow({ workspaceId: ws });
  const worker = makeAgentRow({ workspaceId: ws, ownerAgentId: owner.id });
  dbm.updateAgentStatus(owner.id, 'done');
  const recipient = dbm.getOwnerForWorker(dbm.getAgent(worker.id)!);
  assert.equal(recipient!.id, sup.id, 'terminal owner falls back to structural supervisor');
});

test('getOwnerForWorker (iii) missing/deleted owner id → structural supervisor', () => {
  const ws = 'ws-resolver-iii';
  const sup = makeAgentRow({ workspaceId: ws, isSupervisor: true });
  const owner = makeAgentRow({ workspaceId: ws });
  const worker = makeAgentRow({ workspaceId: ws, ownerAgentId: owner.id });
  dbm.deleteAgent(owner.id);
  const recipient = dbm.getOwnerForWorker(dbm.getAgent(worker.id)!);
  assert.equal(recipient!.id, sup.id, 'missing owner falls back to structural supervisor');
});

test('getOwnerForWorker (ii/iii) terminal owner + NO supervisor → null (drop)', () => {
  const ws = 'ws-resolver-nosup';
  const owner = makeAgentRow({ workspaceId: ws });
  const worker = makeAgentRow({ workspaceId: ws, ownerAgentId: owner.id });
  dbm.updateAgentStatus(owner.id, 'crashed');
  assert.equal(dbm.getOwnerForWorker(dbm.getAgent(worker.id)!), null);
});

test('getOwnerForWorker (iv) unowned + supervised → structural supervisor (legacy)', () => {
  const ws = 'ws-resolver-iv';
  const sup = makeAgentRow({ workspaceId: ws, isSupervisor: true });
  const worker = makeAgentRow({ workspaceId: ws, isSupervised: true });
  assert.equal(dbm.getOwnerForWorker(dbm.getAgent(worker.id)!)!.id, sup.id);
});

test('getOwnerForWorker (v) unowned + unsupervised → null', () => {
  const ws = 'ws-resolver-v';
  makeAgentRow({ workspaceId: ws, isSupervisor: true });
  const worker = makeAgentRow({ workspaceId: ws, isSupervised: false });
  assert.equal(dbm.getOwnerForWorker(dbm.getAgent(worker.id)!), null);
});

test('getOwnerForWorker (vi) owned + supervised, owner ≠ supervisor → owner (step 1 beats step 3)', () => {
  const ws = 'ws-resolver-vi';
  const sup = makeAgentRow({ workspaceId: ws, isSupervisor: true });
  const owner = makeAgentRow({ workspaceId: ws, isSupervisor: false });
  const worker = makeAgentRow({ workspaceId: ws, isSupervised: true, ownerAgentId: owner.id });
  const recipient = dbm.getOwnerForWorker(dbm.getAgent(worker.id)!);
  assert.equal(recipient!.id, owner.id, 'explicit owner wins over legacy supervised fallback');
  assert.notEqual(recipient!.id, sup.id);
});

test('owner_agent_id migration is idempotent — re-running ALTER does not throw', () => {
  // initDatabase already ran once in the runner; running it again exercises the
  // try/catch around the ADD COLUMN (the column now exists).
  assert.doesNotThrow(() => dbm.initDatabase());
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile.
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-default-migration-'));
  process.env.APPDATA = tmpAppData;

  // sql.js init is async; the fake constructor is sync, so resolve the wasm
  // module first, then inject the stand-in and load ../database.
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
