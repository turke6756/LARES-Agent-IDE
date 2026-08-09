// Planning-surface WP-P5C — plan_execution_runs primitives + the Implement service.
//
//   npm run build:main
//   node dist/main/main/plans/plan-implement.test.js
//
// Two layers:
//   • DB primitives (real sql.js-backed database): the atomic "activate" txn
//     (insert run + flip run_state ready→executing), the `ready`-guard, the active-run
//     read, the run-id truth set, and the schema CHECK that makes unborn an explicit
//     marker (no bare nullable OID).
//   • The Implement service (fully injected git/db seams — no real git, no DB): the
//     eligibility gate, the ref-BEFORE-row ordering, the failure ordering (ref created
//     but row insert fails ⇒ orphan ref), unborn handling, truthful trigger fields, and
//     the agent-caller refusal (no proven appUserId).

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
  id: string; planId: string; repositoryKey: string | null; baselineKind: string;
  baselineHeadOid: string | null; baselineRef: string | null; triggerSource: string;
  appUserId: string | null; triggeredAt: number; lifecycleState: string;
};
type DbModule = {
  initDatabase(): void;
  getDb(): { prepare(sql: string): { run(...p: unknown[]): unknown } };
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createOrRevivePlan(input: {
    workspaceId: string; path: string; format: string; runState?: string | null;
  }): { id: string; runState: string | null };
  getPlan(id: string): { id: string; runState: string | null } | null;
  insertPlanExecutionRunActivating(input: {
    id: string; planId: string; repositoryKey?: string | null; baselineKind: string;
    baselineHeadOid?: string | null; baselineRef?: string | null; triggerSource: string;
    appUserId?: string | null; triggeredAt: number;
  }): ExecRun;
  getPlanExecutionRun(id: string): ExecRun | null;
  getActivePlanExecutionRun(planId: string): ExecRun | null;
  listAllPlanExecutionRunIds(): Set<string>;
};
type SvcModule = typeof import('./plan-implement');

let dbm: DbModule;
let svc: SvcModule;

function mkPlan(runState: string): string {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: `p/${Math.random()}`, format: 'structured', runState });
  return plan.id;
}

// ── DB primitive: activate txn + guard + reads ────────────────────────────────

test('insertPlanExecutionRunActivating inserts the run and flips ready→executing', () => {
  const planId = mkPlan('ready');
  const runa = dbm.insertPlanExecutionRunActivating({
    id: 'run-1', planId, baselineKind: 'head', baselineHeadOid: 'a'.repeat(40),
    baselineRef: 'refs/lares/plans/x/y', triggerSource: 'renderer-user-action',
    appUserId: 'edward', triggeredAt: 1000,
  });
  assert.equal(runa.lifecycleState, 'active');
  assert.equal(dbm.getPlan(planId)?.runState, 'executing');
  assert.equal(dbm.getPlanExecutionRun('run-1')?.baselineRef, 'refs/lares/plans/x/y');
  assert.equal(dbm.getActivePlanExecutionRun(planId)?.id, 'run-1');
});

test('insertPlanExecutionRunActivating refuses a plan that is not ready — no row, no flip', () => {
  const planId = mkPlan('hardening');
  assert.throws(() => dbm.insertPlanExecutionRunActivating({
    id: 'run-x', planId, baselineKind: 'unborn', triggerSource: 'renderer-user-action',
    appUserId: 'e', triggeredAt: 1,
  }), /not 'ready'/);
  assert.equal(dbm.getPlan(planId)?.runState, 'hardening');
  assert.equal(dbm.getPlanExecutionRun('run-x'), null);
});

test('an archived run leaves the active gate empty but stays in the run-id truth set', () => {
  const planId = mkPlan('ready');
  dbm.insertPlanExecutionRunActivating({
    id: 'run-arc', planId, baselineKind: 'unborn', triggerSource: 'renderer-user-action',
    appUserId: 'e', triggeredAt: 2000,
  });
  dbm.getDb().prepare(`UPDATE plan_execution_runs SET lifecycle_state = 'archived' WHERE id = ?`).run('run-arc');
  assert.equal(dbm.getActivePlanExecutionRun(planId), null);
  assert.ok(dbm.listAllPlanExecutionRunIds().has('run-arc'));
});

test('the schema CHECK rejects an unborn run carrying an oid (explicit marker, not a bare nullable OID)', () => {
  const planId = mkPlan('ready');
  assert.throws(() => dbm.getDb().prepare(
    `INSERT INTO plan_execution_runs
       (id, plan_id, baseline_kind, baseline_head_oid, baseline_ref, trigger_source, triggered_at, lifecycle_state)
     VALUES (?, ?, 'unborn', ?, NULL, 'renderer-user-action', 1, 'active')`,
  ).run('run-bad', planId, 'a'.repeat(40)));
});

// ── service: eligibility + ordering + failure modes (injected seams) ──────────

type SpyLog = string[];
function svcDeps(over: Record<string, unknown> = {}, log: SpyLog = []): any {
  const deps: any = {
    getPlan: () => ({ id: 'plan-1', workspaceId: 'ws-1', format: 'structured', runState: 'ready' }),
    listPackages: () => [{ id: 'wp', state: 'ready' }],
    getPopulatedTabs: () => [],
    hasOverview: () => true,
    hasValidResponsibleSupervisor: () => true,
    resolveRepoContext: async () => ({ repoRoot: 'C:/w', gitExe: 'git', repositoryKey: 'rk' }),
    probeBaseline: async () => ({ ok: true, kind: 'head', headOid: 'b'.repeat(40) }),
    createBaselineRef: async (_ctx: unknown, ref: string) => { log.push(`ref:${ref}`); return { ok: true }; },
    insertRun: (input: any) => { log.push('row'); return { ...input, lifecycleState: 'active' }; },
    newRunId: () => 'run-fixed',
    now: () => 4242,
  };
  Object.assign(deps, over);
  if (!Object.hasOwn(over, 'refreshAndGetReadiness')) {
    deps.refreshAndGetReadiness = async (planId: string) => {
      const plan = deps.getPlan(planId);
      const packages = plan ? deps.listPackages(planId) : [];
      const tabs = plan ? deps.getPopulatedTabs(planId) : [];
      const tabsMissingOverview = tabs.filter((tab: string) => !deps.hasOverview(planId, tab));
      const supervisorValid = !!plan && deps.hasValidResponsibleSupervisor(planId);
      const failures: string[] = [];
      if (!plan) failures.push('plan-not-found');
      else if (plan.format !== 'structured') failures.push('plan-not-structured');
      if (plan && !packages.some((pkg: { state: string }) => pkg.state === 'ready')) {
        failures.push('no-ready-package');
      }
      if (tabsMissingOverview.length > 0) failures.push('tab-overview-missing');
      if (plan && !supervisorValid) failures.push('no-valid-responsible-supervisor');
      return {
        planId, runState: plan?.runState ?? null,
        packageCounts: { ready: packages.filter((p: { state: string }) => p.state === 'ready').length,
          blocked: 0, executing: 0, done: 0, archived: 0 },
        wpStatus: plan ? 'synced' : null,
        responsibilityStatus: supervisorValid ? 'valid' : plan ? 'invalid' : null,
        overviewStatus: plan ? 'synced' : null,
        supervisorValid, tabsMissingOverview, packageConflicts: [], wpDiagnostics: [],
        overviewDiagnostics: [], refreshError: null, failures,
        canMarkReady: failures.length === 0 && plan?.runState === 'hardening',
        canImplement: failures.length === 0 && plan?.runState === 'ready',
      };
    };
  }
  return deps;
}

test('the shared evaluator awaits coordinator refresh before reading every gate', async () => {
  const log: string[] = [];
  const plan = { id: 'plan-1', workspaceId: 'ws-1', path: '.lares/plans/p/plan.md',
    format: 'structured', runState: 'hardening' } as any;
  const readiness = await svc.refreshAndGetPlanReadiness('plan-1', {
    getPlan: () => { log.push('plan'); return plan; },
    getWorkspace: () => ({ id: 'ws-1', path: 'C:/w', pathType: 'windows' } as any),
    reconcileFolder: async () => { log.push('refresh'); return { planId: 'plan-1' } as any; },
    getProjectionState: () => { log.push('projection'); return {
      wpStatus: 'synced', responsibilityStatus: 'valid', overviewStatus: 'synced',
      wpDiagnosticsJson: '[]', overviewDiagnosticsJson: '[]',
    } as any; },
    listPackages: () => [{ state: 'ready' } as any],
    listManagedPackages: () => [],
    getPopulatedTabs: () => ['packages'],
    hasOverview: () => true,
    hasValidResponsibleSupervisor: () => true,
  });
  assert.equal(readiness.canMarkReady, true);
  assert.ok(log.indexOf('refresh') < log.indexOf('projection'), log.join(','));
});

test('Implement refuses unborn HEAD before provisioning', async () => {
  let provisioned = false;
  const res = await svc.implementPlan({ planId: 'plan-1', appUserId: 'e' }, svcDeps({
    probeBaseline: async () => ({ ok: true, kind: 'unborn' }),
    provisionActivity: async () => { provisioned = true; return { ok: false, reason: 'worktree-provision-failed' }; },
  }));
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures, ['worktree-requires-initial-commit']);
  assert.equal(provisioned, false);
});

test('Implement activates the run through the provisioned activity binding', async () => {
  const log: SpyLog = [];
  const activity = {
    executionRunId: 'run-fixed', planId: 'plan-1', logicalWorkspaceId: 'ws-1',
    objectDatabaseKey: 'objects', activityRepositoryKey: 'activity-key', primaryRepositoryKey: 'primary-key',
    path: 'C:/app/planning-worktrees/ws/run', baselineOid: 'b'.repeat(40),
    activityHeadRef: 'refs/lares/activities/cnVuLWZpeGVk/head', promotedHeadOid: null,
    state: 'active' as const, failureCode: null, createdAt: 4242, updatedAt: 4242,
  };
  const res = await svc.implementPlan({ planId: 'plan-1', appUserId: 'e' }, svcDeps({
    appUserDataPath: 'C:/app',
    provisionActivity: async (_input: unknown, deps: { activate: (row: typeof activity) => void }) => {
      log.push('provision');
      deps.activate(activity);
      return { ok: true, activity };
    },
  }, log));
  assert.equal(res.ok, true);
  assert.deepEqual(log, ['provision', 'row']);
  assert.equal(res.run?.repositoryKey, 'primary-key');
  assert.equal(res.run?.baselineRef, activity.activityHeadRef);
});

test('an agent caller (no proven appUserId) is refused before any git/db touch', async () => {
  const log: SpyLog = [];
  const res = await svc.implementPlan({ planId: 'plan-1', appUserId: null }, svcDeps({}, log));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('no-app-user'));
  assert.deepEqual(log, []); // nothing pinned, nothing inserted
});

test('ineligible plans are refused with the right failure and touch no git', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ getPlan: () => null }, 'plan-not-found'],
    [{ getPlan: () => ({ id: 'p', workspaceId: 'w', format: 'html', runState: 'ready' }) }, 'plan-not-structured'],
    [{ getPlan: () => ({ id: 'p', workspaceId: 'w', format: 'structured', runState: 'hardening' }) }, 'plan-not-ready'],
    [{ listPackages: () => [{ id: 'wp', state: 'blocked' }] }, 'no-ready-package'],
    [{ getPopulatedTabs: () => ['plan'], hasOverview: () => false }, 'tab-overview-missing'],
    [{ hasValidResponsibleSupervisor: () => false }, 'no-valid-responsible-supervisor'],
    [{ resolveRepoContext: async () => null }, 'not-a-repository'],
    [{ probeBaseline: async () => ({ ok: false, reason: 'bare-repo' }) }, 'bare-repository'],
    [{ probeBaseline: async () => ({ ok: false, reason: 'not-a-repo' }) }, 'not-a-repository'],
    [{ refreshAndGetReadiness: async () => ({
      planId: 'plan-1', runState: 'ready',
      packageCounts: { ready: 1, blocked: 0, executing: 0, done: 0, archived: 0 },
      wpStatus: 'invalid', responsibilityStatus: 'valid', overviewStatus: 'synced',
      supervisorValid: true, tabsMissingOverview: [], packageConflicts: [],
      wpDiagnostics: [{ code: 'source-raced' }], overviewDiagnostics: [],
      refreshError: null, failures: ['work-package-ingest-not-synced'],
      canMarkReady: false, canImplement: false,
    }) }, 'work-package-ingest-not-synced'],
  ];
  for (const [over, expected] of cases) {
    const log: SpyLog = [];
    const res = await svc.implementPlan({ planId: 'plan-1', appUserId: 'e' }, svcDeps(over, log));
    assert.equal(res.ok, false, expected);
    assert.ok(res.failures.includes(expected as any), `expected ${expected}, got ${res.failures.join(',')}`);
    assert.deepEqual(log, [], `${expected} must not create a ref or row`);
  }
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-implement-'));
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
  svc = require('./plan-implement') as SvcModule;

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
