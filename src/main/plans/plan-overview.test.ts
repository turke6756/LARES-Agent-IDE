// WP-P4C-backend acceptance — per-tab overview accessors + IPC.
//
//   npm run build:main
//   node dist/main/main/plans/plan-overview.test.js
//
// Proves (mapping to the WP Accept list):
//   • get/set ROUND-TRIP on the folder-native `PlanTabKey` keys (real DB accessors);
//   • `revision` BUMPS on every rewrite of the same (plan_id, tab) key;
//   • WRITE is REJECTED server-side for a non-supervisor / cross-workspace /
//     unknown agent or plan (nothing stored) — mirrors the promotion IPC gate;
//   • GET on an unset key (or a malformed / invalid-tab request) returns `null`
//     cleanly, never throws.
//
// The DB round-trip runs against the same sql.js-behind-better-sqlite3 shim the
// sibling database.*.test.ts files use; the privilege-gate tests are pure handler
// tests with injected deps (no electron, no DB needed for the reject paths).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Agent, Plan, PlanTabOverview } from '../../shared/types';
import type { PlanOverviewIpcDeps } from './plan-ipc';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-behind-better-sqlite3 shim (same shape as database.responsibility.test.ts) ──

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

  private static store(): SqlJsDatabase {
    const s = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath);
    if (!s) throw new Error('no store for last path');
    return s;
  }
  static rawRun(sql: string, params: unknown[] = []): void { FakeBetterSqlite.store().run(sql, params); }
}

// ── module handles (required lazily in the runner, AFTER the cache override) ──

type DbModule = {
  initDatabase(): void;
  getPlanTabOverview(planId: string, tab: string): PlanTabOverview | null;
  setPlanTabOverview(input: {
    planId: string; tab: string; body: string | null; updatedBy: string;
  }): PlanTabOverview;
};

type IpcModule = typeof import('./plan-ipc');

let dbm: DbModule;
let ipc: IpcModule;

// ── fixtures ─────────────────────────────────────────────────────────────────

const WS = 'ws-ov';

function agent(over: Partial<Agent> = {}): Agent {
  // Only hasSupervisorPrivilege + the workspace check read these fields.
  return { id: 'sup-1', workspaceId: WS, isSupervisor: true, ...over } as Agent;
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-ov', workspaceId: WS, path: '.lares/plans/plan-ov/plan.md', slug: null,
    format: 'structured', runState: 'hardening', mtimeMs: 0, sizeBytes: 0,
    createdAt: '', updatedAt: '', deletedAt: null, ...over,
  } as Plan;
}

/** Deps that wire the real DB accessors behind the injected getAgent/getPlan. */
function dbBackedDeps(over: Partial<PlanOverviewIpcDeps> = {}): PlanOverviewIpcDeps {
  return {
    getAgent: () => agent(),
    getPlan: () => plan(),
    getOverview: dbm.getPlanTabOverview,
    setOverview: dbm.setPlanTabOverview,
    ...over,
  } as PlanOverviewIpcDeps;
}

/** Deps with pure-fake accessors that record calls — for the reject-path proofs
 *  (a rejected write must NEVER reach setOverview). */
function fakeDeps(over: Partial<PlanOverviewIpcDeps> = {}): {
  deps: PlanOverviewIpcDeps; calls: { set: number };
} {
  const calls = { set: 0 };
  const deps = {
    getAgent: () => agent(),
    getPlan: () => plan(),
    getOverview: () => null,
    setOverview: (input: { planId: string; tab: string; body: string | null; updatedBy: string }) => {
      calls.set++;
      return {
        planId: input.planId, tab: input.tab as PlanTabOverview['tab'], body: input.body,
        revision: 1, updatedBy: input.updatedBy, createdAt: 'now', updatedAt: 'now',
      } as PlanTabOverview;
    },
    ...over,
  } as PlanOverviewIpcDeps;
  return { deps, calls };
}

function seedPlan(id: string): void {
  FakeBetterSqlite.rawRun(
    `INSERT OR IGNORE INTO workspaces (id, title, path, path_type) VALUES (?, ?, ?, ?)`,
    [WS, WS, `/tmp/${WS}`, 'local'],
  );
  FakeBetterSqlite.rawRun(
    `INSERT INTO plans (id, workspace_id, path, format, run_state, mtime_ms, size_bytes)
     VALUES (?, ?, ?, 'structured', 'hardening', 1, 1)`,
    [id, WS, `.lares/plans/${id}/plan.md`],
  );
}

async function rejects(fn: () => unknown, matcher: RegExp): Promise<void> {
  await assert.rejects(async () => fn(), (err: unknown) => {
    assert.ok(err instanceof Error && matcher.test(err.message),
      `expected /${matcher.source}/, got: ${String(err)}`);
    return true;
  });
}

// ── DB accessor round-trip + revision bump ───────────────────────────────────

test('get on an UNSET key returns null cleanly (no throw)', () => {
  seedPlan('plan-unset');
  assert.equal(dbm.getPlanTabOverview('plan-unset', 'overview'), null);
});

test('set → get ROUND-TRIPS on a folder-native PlanTabKey; first write is revision 1', () => {
  seedPlan('plan-rt');
  const stored = dbm.setPlanTabOverview({
    planId: 'plan-rt', tab: 'plan', body: 'the plan summary', updatedBy: 'sup-1',
  });
  assert.equal(stored.revision, 1, 'a first write lands revision 1');
  assert.equal(stored.updatedBy, 'sup-1', 'the writer is recorded');
  const read = dbm.getPlanTabOverview('plan-rt', 'plan');
  assert.ok(read);
  assert.equal(read.body, 'the plan summary');
  assert.equal(read.tab, 'plan');
  assert.equal(read.planId, 'plan-rt');
  assert.equal(read.revision, 1);
});

test('rewrite of the SAME (plan_id, tab) key BUMPS revision and updates the body', () => {
  seedPlan('plan-rev');
  dbm.setPlanTabOverview({ planId: 'plan-rev', tab: 'overview', body: 'v1', updatedBy: 'sup-1' });
  const r2 = dbm.setPlanTabOverview({ planId: 'plan-rev', tab: 'overview', body: 'v2', updatedBy: 'sup-2' });
  assert.equal(r2.revision, 2, 'a rewrite bumps revision to 2');
  assert.equal(r2.body, 'v2');
  assert.equal(r2.updatedBy, 'sup-2');
  const r3 = dbm.setPlanTabOverview({ planId: 'plan-rev', tab: 'overview', body: 'v3', updatedBy: 'sup-1' });
  assert.equal(r3.revision, 3, 'each rewrite bumps by exactly one');
  // A DIFFERENT tab under the same plan is an independent key at revision 1.
  const other = dbm.setPlanTabOverview({ planId: 'plan-rev', tab: 'research', body: 'r1', updatedBy: 'sup-1' });
  assert.equal(other.revision, 1, 'a distinct tab key starts its own revision line');
  assert.equal(dbm.getPlanTabOverview('plan-rev', 'overview')!.revision, 3,
    'the other tab rewrite did not disturb the overview key');
});

test('a null body round-trips (an overview may be explicitly cleared)', () => {
  seedPlan('plan-null');
  const stored = dbm.setPlanTabOverview({ planId: 'plan-null', tab: 'deliberations', body: null, updatedBy: 'sup-1' });
  assert.equal(stored.body, null);
  assert.equal(dbm.getPlanTabOverview('plan-null', 'deliberations')!.body, null);
});

// ── IPC: open read ────────────────────────────────────────────────────────────

test('runGetOverview reads the stored row through the handler (open read)', () => {
  seedPlan('plan-get');
  dbm.setPlanTabOverview({ planId: 'plan-get', tab: 'supplements', body: 'supp', updatedBy: 'sup-1' });
  const res = ipc.runGetOverview({ planId: 'plan-get', tab: 'supplements' }, dbBackedDeps());
  assert.ok(res);
  assert.equal(res.body, 'supp');
});

test('runGetOverview on an unset key / bad request / invalid tab → null (never throws)', () => {
  seedPlan('plan-getnull');
  assert.equal(ipc.runGetOverview({ planId: 'plan-getnull', tab: 'overview' }, dbBackedDeps()), null);
  assert.equal(ipc.runGetOverview({ planId: '', tab: 'overview' }, dbBackedDeps()), null);
  assert.equal(ipc.runGetOverview({ planId: 'plan-getnull', tab: 'not-a-tab' }, dbBackedDeps()), null);
  assert.equal(ipc.runGetOverview(null, dbBackedDeps()), null);
});

// ── IPC: privileged, server-revalidated write ────────────────────────────────

test('runSetOverview stores through the handler for a privileged same-workspace supervisor', () => {
  seedPlan('plan-set');
  const res = ipc.runSetOverview(
    { planId: 'plan-set', tab: 'overview', body: 'above the ARC', supervisorId: 'sup-1' },
    dbBackedDeps(),
  );
  assert.equal(res.body, 'above the ARC');
  assert.equal(res.updatedBy, 'sup-1', 'the revalidated supervisor is recorded as the writer');
  assert.equal(dbm.getPlanTabOverview('plan-set', 'overview')!.body, 'above the ARC');
});

test('runSetOverview accepts a privileged persona on the supervisor lane (isSupervisor=false)', () => {
  seedPlan('plan-lane');
  const res = ipc.runSetOverview(
    { planId: 'plan-lane', tab: 'plan', body: 'lane body', supervisorId: 'sup-1' },
    dbBackedDeps({ getAgent: () => agent({ isSupervisor: false, privilegeLane: 'supervisor' }) }),
  );
  assert.equal(res.body, 'lane body');
});

test('runSetOverview REJECTS a non-privileged agent server-side (nothing stored)', async () => {
  const { deps, calls } = fakeDeps({ getAgent: () => agent({ isSupervisor: false, privilegeLane: undefined }) });
  await rejects(
    () => ipc.runSetOverview({ planId: 'plan-x', tab: 'overview', body: 'b', supervisorId: 'sup-1' }, deps),
    /eligible supervisor/,
  );
  assert.equal(calls.set, 0, 'the write path (setOverview) was never reached');
});

test('runSetOverview REJECTS a supervisor from a DIFFERENT workspace', async () => {
  const { deps, calls } = fakeDeps({ getAgent: () => agent({ workspaceId: 'ws-other' }) });
  await rejects(
    () => ipc.runSetOverview({ planId: 'plan-x', tab: 'overview', body: 'b', supervisorId: 'sup-1' }, deps),
    /eligible supervisor/,
  );
  assert.equal(calls.set, 0);
});

test('runSetOverview REJECTS an unknown supervisor id', async () => {
  const { deps, calls } = fakeDeps({ getAgent: () => null });
  await rejects(
    () => ipc.runSetOverview({ planId: 'plan-x', tab: 'overview', body: 'b', supervisorId: 'ghost' }, deps),
    /eligible supervisor/,
  );
  assert.equal(calls.set, 0);
});

test('runSetOverview REJECTS an unknown plan (workspace cannot be bounded)', async () => {
  const { deps, calls } = fakeDeps({ getPlan: () => null });
  await rejects(
    () => ipc.runSetOverview({ planId: 'nope', tab: 'overview', body: 'b', supervisorId: 'sup-1' }, deps),
    /plan not found/,
  );
  assert.equal(calls.set, 0);
});

test('runSetOverview REJECTS a malformed request / invalid tab / missing supervisorId', async () => {
  const { deps, calls } = fakeDeps();
  await rejects(() => ipc.runSetOverview({ planId: '', tab: 'overview', supervisorId: 'sup-1' }, deps), /planId/);
  await rejects(() => ipc.runSetOverview({ planId: 'p', tab: 'not-a-tab', supervisorId: 'sup-1' }, deps), /tab key/);
  await rejects(() => ipc.runSetOverview({ planId: 'p', tab: 'overview', supervisorId: '' }, deps), /supervisorId/);
  await rejects(() => ipc.runSetOverview({ planId: 'p', tab: 'overview', supervisorId: 'sup-1', body: 42 }, deps), /body/);
  assert.equal(calls.set, 0);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-overview-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // Require AFTER the cache override so both modules bind the shimmed driver.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ipc = require('./plan-ipc') as IpcModule;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
