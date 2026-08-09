// Planning-surface WP-P5-archive — plan archive / resurrection / re-implement.
//
//   npm run build:main
//   node dist/main/main/plans/plan-archive.test.js
//
// Two layers:
//   • DB primitive (real sql.js-backed database): the atomic `archivePlanClosingRun`
//     txn — run closure (lifecycle_state active→archived) PAIRED with the plan flip
//     (run_state executing/ready→archived), the executing/ready guard, the retained
//     baseline ref (the closed run keeps its row + ref in the truth set), the null-run
//     case (a `ready` plan never Implemented), and the untouched package states.
//   • The service composition (injected seams): archivePlan / resurrectPlan guards and
//     structured refusals, and reimplementPlan — which resurrects then mints a BRAND-NEW
//     run via the P5C idiom, NEVER resurrecting the closed run's row, and leaves the
//     plan `ready` when Implement fails after resurrection.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

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
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
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
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
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
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

type ExecRun = {
  id: string; planId: string; baselineKind: string; baselineRef: string | null;
  lifecycleState: string;
};
type Pkg = { id: string; state: string };
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createOrRevivePlan(input: {
    workspaceId: string; path: string; format: string; runState?: string | null;
  }): { id: string; runState: string | null };
  getPlan(id: string): { id: string; runState: string | null } | null;
  updatePlan(id: string, updates: { runState?: string | null }): unknown;
  insertPlanExecutionRunActivating(input: {
    id: string; planId: string; baselineKind: string; baselineHeadOid?: string | null;
    baselineRef?: string | null; triggerSource: string; appUserId?: string | null; triggeredAt: number;
  }): ExecRun;
  getPlanExecutionRun(id: string): ExecRun | null;
  getActivePlanExecutionRun(planId: string): ExecRun | null;
  listAllPlanExecutionRunIds(): Set<string>;
  archivePlanClosingRun(planId: string): { plan: { runState: string | null }; closedRun: ExecRun | null };
  upsertPlanWorkPackage(pkg: {
    id: string; workspaceId: string; planId: string; title: string;
    acceptanceCondition: string | null; state: string; assigneeAgentId: string | null;
    revision: number; createdAt: number; updatedAt: number;
  }): void;
  getPlanWorkPackage(id: string): Pkg | null;
};
type SvcModule = typeof import('./plan-lifecycle');

let dbm: DbModule;
let svc: SvcModule;

function mkPlan(runState: string): { planId: string; workspaceId: string } {
  const ws = dbm.createWorkspace({ title: 'W', path: `C:/w/${Math.random()}`, pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: `p/${Math.random()}`, format: 'structured', runState });
  return { planId: plan.id, workspaceId: ws.id };
}

function mkRun(id: string, planId: string, triggeredAt: number): ExecRun {
  // Land as a `ready`-guarded activate, then leave it active for the archive to close.
  const cur = dbm.getPlan(planId)?.runState;
  if (cur !== 'ready') dbm.updatePlan(planId, { runState: 'ready' });
  return dbm.insertPlanExecutionRunActivating({
    id, planId, baselineKind: 'head', baselineHeadOid: 'a'.repeat(40),
    baselineRef: `refs/lares/plans/${id}/x`, triggerSource: 'renderer-user-action',
    appUserId: 'edward', triggeredAt,
  });
}

function mkPkg(workspaceId: string, planId: string, id: string, state: string): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId, planId, title: id, acceptanceCondition: null, state,
    assigneeAgentId: null, revision: 1, createdAt: 1, updatedAt: 1,
  });
}

// ── DB primitive: atomic archive (run closure + plan flip) ─────────────────────

test('archivePlanClosingRun closes the active run and flips executing→archived', () => {
  const { planId } = mkPlan('ready');
  mkRun('run-1', planId, 1000);                       // plan is now `executing`
  assert.equal(dbm.getPlan(planId)?.runState, 'executing');

  const res = dbm.archivePlanClosingRun(planId);
  assert.equal(res.plan.runState, 'archived');
  assert.equal(res.closedRun?.id, 'run-1');
  assert.equal(res.closedRun?.lifecycleState, 'archived');
  assert.equal(dbm.getPlanExecutionRun('run-1')?.lifecycleState, 'archived');
  assert.equal(dbm.getActivePlanExecutionRun(planId), null);
});

test('an archived run KEEPS its baseline ref + row for audit (still in the truth set)', () => {
  const { planId } = mkPlan('ready');
  mkRun('run-keep', planId, 1000);
  dbm.archivePlanClosingRun(planId);
  const row = dbm.getPlanExecutionRun('run-keep');
  assert.equal(row?.baselineRef, 'refs/lares/plans/run-keep/x');   // ref retained
  assert.ok(dbm.listAllPlanExecutionRunIds().has('run-keep'));      // row retained (not an orphan)
});

test('archiving a `ready` plan with no active run flips it with closedRun=null', () => {
  const { planId } = mkPlan('ready');                 // never Implemented → no run
  const res = dbm.archivePlanClosingRun(planId);
  assert.equal(res.plan.runState, 'archived');
  assert.equal(res.closedRun, null);
});

test('the executing/ready guard rejects a non-archivable plan (no flip, no closure)', () => {
  const hardening = mkPlan('hardening').planId;
  assert.throws(() => dbm.archivePlanClosingRun(hardening), /not executing\/ready/);
  assert.equal(dbm.getPlan(hardening)?.runState, 'hardening');

  const { planId } = mkPlan('ready');
  mkRun('run-g', planId, 1000);
  dbm.archivePlanClosingRun(planId);                  // now archived
  assert.throws(() => dbm.archivePlanClosingRun(planId), /not executing\/ready/);
  assert.equal(dbm.getPlanExecutionRun('run-g')?.lifecycleState, 'archived'); // unchanged
});

test('package states are NOT touched by archive (no content rollback)', () => {
  const { planId, workspaceId } = mkPlan('ready');
  mkPkg(workspaceId, planId, 'wp-done', 'done');
  mkPkg(workspaceId, planId, 'wp-ready', 'ready');
  mkRun('run-p', planId, 1000);
  dbm.archivePlanClosingRun(planId);
  assert.equal(dbm.getPlanWorkPackage('wp-done')?.state, 'done');
  assert.equal(dbm.getPlanWorkPackage('wp-ready')?.state, 'ready');
});

// ── service: archivePlan / resurrectPlan guards (injected seams) ───────────────

test('archivePlan refuses plan-not-found and plan-not-archivable without archiving', () => {
  let archiveCalls = 0;
  const archive = (planId: string) => { archiveCalls++; return { plan: { id: planId, runState: 'archived' } as any, closedRun: null }; };

  const notFound = svc.archivePlan({ planId: 'x', actor: 'e' }, { getPlan: () => null, archive });
  assert.equal(notFound.ok, false);
  assert.deepEqual(notFound.failures, ['plan-not-found']);

  const hardening = svc.archivePlan({ planId: 'x', actor: 'e' },
    { getPlan: () => ({ runState: 'hardening' } as any), archive });
  assert.equal(hardening.ok, false);
  assert.deepEqual(hardening.failures, ['plan-not-archivable']);
  assert.equal(hardening.runState, 'hardening');
  assert.equal(archiveCalls, 0);                      // guard short-circuits the write
});

test('archivePlan on an executing plan archives and reports the closed run id', () => {
  const res = svc.archivePlan({ planId: 'p', actor: 'e' }, {
    getPlan: () => ({ runState: 'executing' } as any),
    archive: () => ({ plan: { runState: 'archived' } as any, closedRun: { id: 'run-9' } as any }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.runState, 'archived');
  assert.equal(res.closedRunId, 'run-9');
});

test('resurrectPlan flips archived→ready and refuses anything else', () => {
  let ran: string | null = null;
  const setRunState = (_p: string, s: string) => { ran = s; };

  const ok = svc.resurrectPlan({ planId: 'p', actor: 'e' },
    { getPlan: () => ({ runState: 'archived' } as any), setRunState });
  assert.equal(ok.ok, true);
  assert.equal(ok.runState, 'ready');
  assert.equal(ran, 'ready');

  ran = null;
  const notArchived = svc.resurrectPlan({ planId: 'p', actor: 'e' },
    { getPlan: () => ({ runState: 'executing' } as any), setRunState });
  assert.equal(notArchived.ok, false);
  assert.deepEqual(notArchived.failures, ['plan-not-archived']);
  assert.equal(ran, null);                            // no flip on refusal

  const notFound = svc.resurrectPlan({ planId: 'p', actor: 'e' },
    { getPlan: () => null, setRunState });
  assert.equal(notFound.ok, false);
  assert.deepEqual(notFound.failures, ['plan-not-found']);
});

// ── service: reimplementPlan composition (injected implement) ──────────────────

test('reimplementPlan resurrects then mints a FRESH run (never the closed row)', async () => {
  const calls: string[] = [];
  const res = await svc.reimplementPlan({ planId: 'p', appUserId: 'edward' }, {
    getPlan: () => ({ runState: 'archived' } as any),
    setRunState: (_p, s) => { calls.push(`resurrect:${s}`); },
    implementPlan: async (input) => {
      calls.push(`implement:${input.appUserId}`);
      return { ok: true, run: { id: 'run-NEW' } as any, failures: [], tabsMissingOverview: [] };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.resurrected, true);
  assert.equal(res.run?.id, 'run-NEW');               // fresh run, not the archived one
  assert.deepEqual(calls, ['resurrect:ready', 'implement:edward']); // resurrect BEFORE implement
});

test('reimplementPlan short-circuits when the plan is not archived (no implement)', async () => {
  let implemented = false;
  const res = await svc.reimplementPlan({ planId: 'p', appUserId: 'e' }, {
    getPlan: () => ({ runState: 'executing' } as any),
    implementPlan: async () => { implemented = true; return { ok: true, run: null, failures: [], tabsMissingOverview: [] }; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.resurrected, false);
  assert.deepEqual(res.failures, ['plan-not-archived']);
  assert.equal(implemented, false);
});

test('reimplementPlan leaves the plan `ready` (resurrected) when Implement fails after resurrection', async () => {
  const res = await svc.reimplementPlan({ planId: 'p', appUserId: 'e' }, {
    getPlan: () => ({ runState: 'archived' } as any),
    setRunState: () => { /* flipped to ready */ },
    implementPlan: async () => ({ ok: false, run: null, failures: ['baseline-ref-failed'], tabsMissingOverview: [] }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.resurrected, true);                // resurrection stands; plan sits `ready`
  assert.deepEqual(res.failures, ['baseline-ref-failed']);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-archive-'));
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
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  svc = require('./plan-lifecycle') as SvcModule;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
