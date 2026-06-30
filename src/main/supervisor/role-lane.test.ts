// Researcher role-lane tests — plans/groupthink/foundation-and-role-lane.md STEP 0.
//
// Covers the Step-0 plumbing:
//   1. roleLaneOf() returns the correct AgentRoleLane for each flag combo
//      (precedence: supervisor > researcher > worker > legacy).
//   2. isResearcher round-trips through createAgent → getAgent (DB column
//      is_researcher persists and rehydrates as a boolean; absent → false).
//
// better-sqlite3's native binding is built against Electron's ABI and won't
// load under the system Node that `npm run test:supervisor` uses, so this test
// injects a sql.js (wasm SQLite) stand-in with the same Database surface into
// require.cache BEFORE requiring ../database (mirrors selection-comments-db.test).
// Real SQL still executes — the ALTER TABLE migration + INSERT + SELECT all run
// on wasm. roleLaneOf is likewise required after injection so importing ./index
// (which transitively pulls ../database) doesn't capture the real native addon.
//
//   npm run build:main
//   node dist/main/main/supervisor/role-lane.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, AgentRoleLane } from '../../shared/types';
// Pure, Electron-free + DB-free — safe to import statically (no require.cache dance).
import { toolsetsForLane } from './mcp-config-builder';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (copied from selection-comments-db.test) ──

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

// Modules under test, loaded after the cache injection.
type DbModule = {
  initDatabase(): void;
  createAgent(data: Record<string, unknown>): Agent;
  getAgent(id: string): Agent | null;
};
type IndexModule = {
  roleLaneOf(a: {
    isSupervisor?: boolean; isResearcher?: boolean;
    isSupervised?: boolean; isWorker?: boolean;
    privilegeLane?: 'supervisor'; persona?: string;
  }): AgentRoleLane;
  isCodexHookPersona(a: { provider?: string; wantsCodexHooks?: boolean }): boolean;
};
let dbm: DbModule;
let roleLaneOf: IndexModule['roleLaneOf'];
let isCodexHookPersona: IndexModule['isCodexHookPersona'];

// ── roleLaneOf ───────────────────────────────────────────────────────

test('roleLaneOf: supervisor flag wins over every other lane', () => {
  assert.equal(roleLaneOf({ isSupervisor: true }), 'supervisor');
  assert.equal(
    roleLaneOf({ isSupervisor: true, isResearcher: true, isWorker: true, isSupervised: true }),
    'supervisor',
  );
});

test('roleLaneOf: researcher flag maps to the researcher lane (below supervisor)', () => {
  assert.equal(roleLaneOf({ isResearcher: true }), 'researcher');
  assert.equal(roleLaneOf({ isResearcher: true, isWorker: true, isSupervised: true }), 'researcher');
});

test('roleLaneOf: worker and supervised both map to the worker lane', () => {
  assert.equal(roleLaneOf({ isWorker: true }), 'worker');
  assert.equal(roleLaneOf({ isSupervised: true }), 'worker');
  assert.equal(roleLaneOf({ isWorker: true, isSupervised: true }), 'worker');
});

test('roleLaneOf: no lane flags (incl. a bare persona) falls back to legacy', () => {
  assert.equal(roleLaneOf({}), 'legacy');
  assert.equal(roleLaneOf({ persona: 'some-persona' }), 'legacy');
});

test('roleLaneOf: privilegeLane grants the supervisor lane without isSupervisor (#19)', () => {
  // A persona on the supervisor privilege lane: NOT the structural supervisor
  // (isSupervisor false → renders as its own card), but resolves to the
  // supervisor role-lane so it receives the supervisor-tier MCP toolset.
  assert.equal(roleLaneOf({ privilegeLane: 'supervisor' }), 'supervisor');
  assert.equal(
    toolsetsForLane(roleLaneOf({ privilegeLane: 'supervisor' })),
    'orchestration,teams,comms,observability,browser-present',
    'elevated persona must receive the supervisor MCP grant',
  );
  // A real isSupervisor still wins, and privilegeLane sits above researcher/worker.
  assert.equal(roleLaneOf({ isSupervisor: true, privilegeLane: 'supervisor' }), 'supervisor');
  assert.equal(roleLaneOf({ privilegeLane: 'supervisor', isResearcher: true, isWorker: true }), 'supervisor');
});

// ── isResearcher DB round-trip ───────────────────────────────────────

test('createAgent: isResearcher=true round-trips through getAgent as a boolean', () => {
  const agent = dbm.createAgent({
    workspaceId: 'ws-researcher',
    title: 'Researcher round-trip',
    roleDescription: '',
    workingDirectory: '/tmp/research',
    command: 'claude',
    provider: 'claude',
    isResearcher: true,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: '/tmp/research.log',
  });
  assert.equal(agent.isResearcher, true, 'createAgent return value should carry isResearcher=true');

  const fetched = dbm.getAgent(agent.id);
  assert.ok(fetched, 'agent should be retrievable');
  assert.equal(fetched!.isResearcher, true, 'is_researcher must rehydrate as true');
  // Mutually-exclusive lane flags stay off.
  assert.equal(fetched!.isSupervisor, false);
  assert.equal(fetched!.isWorker, false);
});

test('createAgent: omitting isResearcher defaults to false (column default 0)', () => {
  const agent = dbm.createAgent({
    workspaceId: 'ws-default',
    title: 'Default lane',
    roleDescription: '',
    workingDirectory: '/tmp/default',
    command: 'claude',
    provider: 'claude',
    // isResearcher intentionally omitted
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: '/tmp/default.log',
  });
  assert.equal(agent.isResearcher, false, 'absent isResearcher should default to false');

  const fetched = dbm.getAgent(agent.id);
  assert.ok(fetched);
  assert.equal(fetched!.isResearcher, false, 'is_researcher should rehydrate as false when unset');
});

// ── Bug 2 / Edit 2.6 — isCodexHookPersona helper ─────────────────────

test('isCodexHookPersona: true only for a codex agent with wantsCodexHooks set', () => {
  assert.equal(isCodexHookPersona({ provider: 'codex', wantsCodexHooks: true }), true,
    'codex + wantsCodexHooks → the runner env gate escape applies');
  assert.equal(isCodexHookPersona({ provider: 'codex', wantsCodexHooks: false }), false,
    'codex without the persisted flag → no escape (stays legacy)');
  assert.equal(isCodexHookPersona({ provider: 'codex' }), false,
    'codex with undefined flag → false');
  assert.equal(isCodexHookPersona({ provider: 'claude', wantsCodexHooks: true }), false,
    'claude never qualifies, even if the flag were somehow set');
  assert.equal(isCodexHookPersona({}), false, 'empty → false');
});

// ── Bug 2 / Edit 2.6 — wantsCodexHooks DB round-trip ─────────────────

test('createAgent: wantsCodexHooks=true round-trips through getAgent as a boolean', () => {
  const agent = dbm.createAgent({
    workspaceId: 'ws-codex-hooks',
    title: 'Codex persona round-trip',
    roleDescription: '',
    workingDirectory: '/tmp/codex-persona',
    command: 'codex --profile dashboard-worker --dangerously-bypass-hook-trust',
    provider: 'codex',
    wantsCodexHooks: true,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: '/tmp/codex-persona.log',
  });
  assert.equal(agent.wantsCodexHooks, true, 'createAgent return value should carry wantsCodexHooks=true');

  const fetched = dbm.getAgent(agent.id);
  assert.ok(fetched, 'agent should be retrievable');
  assert.equal(fetched!.wantsCodexHooks, true, 'wants_codex_hooks must rehydrate as true');
  // The persisted row is enough to re-derive the runner env gate on reconcile.
  assert.equal(isCodexHookPersona(fetched!), true,
    'a rehydrated codex persona row must satisfy the env-gate escape');
});

test('createAgent: omitting wantsCodexHooks defaults to false (column default 0)', () => {
  const agent = dbm.createAgent({
    workspaceId: 'ws-codex-default',
    title: 'Codex default',
    roleDescription: '',
    workingDirectory: '/tmp/codex-default',
    command: 'codex',
    provider: 'codex',
    // wantsCodexHooks intentionally omitted
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: '/tmp/codex-default.log',
  });
  assert.equal(agent.wantsCodexHooks, false, 'absent wantsCodexHooks should default to false');

  const fetched = dbm.getAgent(agent.id);
  assert.ok(fetched);
  assert.equal(fetched!.wantsCodexHooks, false, 'wants_codex_hooks should rehydrate as false when unset');
  assert.equal(isCodexHookPersona(fetched!), false,
    'a codex row without the flag must NOT satisfy the env-gate escape');
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile.
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdash-rolelane-'));
  process.env.APPDATA = tmpAppData;

  // sql.js init is async; the fake constructor is sync, so resolve the wasm
  // module first, then inject the stand-in and load the modules under test.
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
  dbm = require('../database') as DbModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  roleLaneOf = (require('./index') as IndexModule).roleLaneOf;
  isCodexHookPersona = (require('./index') as IndexModule).isCodexHookPersona;
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
