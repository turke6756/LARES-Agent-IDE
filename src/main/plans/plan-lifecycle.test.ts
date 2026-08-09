// WP-P5B — plan lifecycle-event service + Mark-Ready.
// Exercises the DB-layer transition/ledger primitives (atomic state+ledger write,
// `done` rejection, terminal-package guard, valid-supervisor SQL) through the real
// sql.js-backed database, and the service composition (archive delegation +
// Mark-Ready's four-condition gate) via injected deps.
//
//   npm run build:main
//   node dist/main/main/plans/plan-lifecycle.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  getRowsModified(): number;
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
  private transactionSerial = 0;

  constructor(dbPath = ':memory:') {
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
      run: (...params: unknown[]) => {
        inner.run(sql, params);
        return { changes: inner.getRowsModified() };
      },
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
      const savepoint = `fake_transaction_${++this.transactionSerial}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn(...args);
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
        throw err;
      }
    };
  }
}

type PlanWorkPackage = {
  id: string; workspaceId: string; planId: string; title: string;
  acceptanceCondition: string | null; state: string; assigneeAgentId: string | null;
  revision: number; createdAt: number; updatedAt: number; intentId?: string | null;
  schemaVersion?: number | null; contentHash?: string | null;
  projectionStatus?: 'synced' | 'legacy-unmigrated' | null;
};
type LifecycleEvent = {
  id: string; packageId: string; planId: string; fromState: string;
  toState: string; actor: string; reason: string | null; ts: number;
};
type DbModule = {
  initDatabase(): void;
  getDb(): { prepare(sql: string): { run(...p: unknown[]): unknown } };
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: {
    workspaceId: string; title: string; roleDescription: string; workingDirectory: string;
    command: string; tmuxSessionName: string | null; autoRestartEnabled: boolean;
    logPath: string; isSupervisor?: boolean;
  }): { id: string };
  createOrRevivePlan(input: {
    workspaceId: string; path: string; format: string; runState?: string | null;
  }): { id: string; runState: string | null };
  getPlan(id: string): { id: string; runState: string | null } | null;
  upsertPlanWorkPackage(pkg: PlanWorkPackage): void;
  getPlanWorkPackage(id: string): PlanWorkPackage | null;
  transitionPlanWorkPackageState(input: {
    eventId: string; packageId: string; toState: string; actor: string;
    reason?: string | null; ts: number;
  }): LifecycleEvent;
  listPlanWpLifecycleEvents(packageId: string): LifecycleEvent[];
  planHasValidResponsibleSupervisor(planId: string): boolean;
};
type ServiceModule = {
  archivePackage(
    input: { eventId: string; packageId: string; actor: string; reason?: string | null; ts: number },
  ): LifecycleEvent;
  markPlanReady(
    input: { planId: string; actor: string },
    deps?: Record<string, unknown>,
  ): Promise<{ ok: boolean; runState: string | null; failures: string[]; tabsMissingOverview: string[] }>;
};

let dbm: DbModule;
let svc: ServiceModule;

let seq = 0;
function makePackage(over: Partial<PlanWorkPackage> = {}): PlanWorkPackage {
  seq += 1;
  return {
    id: `wp-${seq}`, workspaceId: 'ws-1', planId: 'plan-1', title: 'WP',
    acceptanceCondition: null, state: 'ready', assigneeAgentId: null,
    revision: 1, createdAt: 1000, updatedAt: 1000, intentId: 'int_00000001',
    schemaVersion: 2, contentHash: `hash-${seq}`, projectionStatus: 'synced', ...over,
  };
}

function setResponsibleSupervisor(planId: string, agentId: string | null): void {
  dbm.getDb().prepare('UPDATE plans SET responsible_supervisor_id = ? WHERE id = ?').run(agentId, planId);
}

// ── DB primitive: transition + ledger ─────────────────────────────────────────

test('direct ready to executing is refused because dispatch confirmation owns that ledger edge', () => {
  const pkg = makePackage({ state: 'ready' });
  dbm.upsertPlanWorkPackage(pkg);
  assert.throws(() => dbm.transitionPlanWorkPackageState({
    eventId: 'ev-1', packageId: pkg.id, toState: 'executing', actor: 'agent-x', reason: 'go', ts: 2000,
  }), /witnessed package-ledger command/);
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.state, 'ready');
  assert.deepEqual(dbm.listPlanWpLifecycleEvents(pkg.id), []);
});

test('a `done` target is rejected — no state change, no ledger row', () => {
  const pkg = makePackage({ state: 'ready' });
  dbm.upsertPlanWorkPackage(pkg);
  assert.throws(() => dbm.transitionPlanWorkPackageState({
    eventId: 'ev-done', packageId: pkg.id, toState: 'done', actor: 'a', ts: 3000,
  }), /done/);
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.state, 'ready');
  assert.equal(dbm.listPlanWpLifecycleEvents(pkg.id).length, 0);
});

test('a `done` package is terminal — no transition off it, and its row is untouched', () => {
  const pkg = makePackage({ state: 'done' });
  dbm.upsertPlanWorkPackage(pkg);
  assert.throws(() => dbm.transitionPlanWorkPackageState({
    eventId: 'ev-term', packageId: pkg.id, toState: 'executing', actor: 'a', ts: 3000,
  }), /done/);
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.state, 'done');
  assert.equal(dbm.listPlanWpLifecycleEvents(pkg.id).length, 0);
});

test('archivePackage delegates to the transition and ledgers `archived`', () => {
  const pkg = makePackage({ state: 'blocked' });
  dbm.upsertPlanWorkPackage(pkg);
  const ev = svc.archivePackage({ eventId: 'ev-arc', packageId: pkg.id, actor: 'sup', ts: 4000 });
  assert.equal(ev.toState, 'archived');
  assert.equal(ev.fromState, 'blocked');
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.state, 'archived');
});

// ── DB primitive: valid responsible supervisor ────────────────────────────────

test('planHasValidResponsibleSupervisor accepts only a same-workspace supervisor', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const other = dbm.createWorkspace({ title: 'O', path: 'C:/o', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/a', format: 'structured', runState: 'hardening' });
  const mkAgent = (wsId: string, isSup: boolean) => dbm.createAgent({
    workspaceId: wsId, title: 'A', roleDescription: '', workingDirectory: 'C:/w',
    command: 'x', tmuxSessionName: null, autoRestartEnabled: false, logPath: 'l', isSupervisor: isSup,
  });
  // null pointer → invalid
  assert.equal(dbm.planHasValidResponsibleSupervisor(plan.id), false, 'null pointer');
  // non-supervisor same-workspace agent → invalid
  setResponsibleSupervisor(plan.id, mkAgent(ws.id, false).id);
  assert.equal(dbm.planHasValidResponsibleSupervisor(plan.id), false, 'non-supervisor');
  // supervisor in a DIFFERENT workspace → invalid
  setResponsibleSupervisor(plan.id, mkAgent(other.id, true).id);
  assert.equal(dbm.planHasValidResponsibleSupervisor(plan.id), false, 'cross-workspace');
  // supervisor in the plan's own workspace → valid
  setResponsibleSupervisor(plan.id, mkAgent(ws.id, true).id);
  assert.equal(dbm.planHasValidResponsibleSupervisor(plan.id), true, 'valid');
});

// ── service: Mark Ready ───────────────────────────────────────────────────────

function markDeps(over: Record<string, unknown> = {}): Record<string, unknown> {
  const planId = typeof over.planId === 'string' ? over.planId : null;
  const runState = planId ? dbm.getPlan(planId)?.runState ?? null : 'hardening';
  const readiness = {
    planId: planId ?? 'plan-1', runState,
    packageCounts: { ready: 1, blocked: 0, executing: 0, done: 0, archived: 0 },
    wpStatus: 'synced', responsibilityStatus: 'valid', overviewStatus: 'synced',
    supervisorValid: true, tabsMissingOverview: [], packageConflicts: [],
    wpDiagnostics: [], overviewDiagnostics: [], refreshError: null, failures: [],
    canMarkReady: runState === 'hardening', canImplement: runState === 'ready',
    ...(over.readiness as Record<string, unknown> | undefined),
  };
  return {
    refreshAndGetReadiness: async () => readiness,
  };
}

test('Mark Ready flips hardening → ready when all conditions hold', async () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/ready', format: 'structured', runState: 'hardening' });
  const res = await svc.markPlanReady({ planId: plan.id, actor: 'sup' }, markDeps({ planId: plan.id }));
  assert.deepEqual({ ok: res.ok, runState: res.runState, failures: res.failures }, { ok: true, runState: 'ready', failures: [] });
  assert.equal(dbm.getPlan(plan.id)?.runState, 'ready');
});

test('Mark Ready refuses a plan not in hardening and never flips run_state', async () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/exec', format: 'structured', runState: 'executing' });
  const res = await svc.markPlanReady({ planId: plan.id, actor: 'sup' }, markDeps({ planId: plan.id }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('plan-not-hardening'));
  assert.equal(dbm.getPlan(plan.id)?.runState, 'executing');
});

test('Mark Ready refuses when only blocked packages exist', async () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/arc', format: 'structured', runState: 'hardening' });
  const res = await svc.markPlanReady({ planId: plan.id, actor: 'sup' },
    markDeps({ planId: plan.id, readiness: {
      packageCounts: { ready: 0, blocked: 1, executing: 0, done: 0, archived: 0 },
      failures: ['no-ready-package'], canMarkReady: false,
    } }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('no-ready-package'));
  assert.equal(dbm.getPlan(plan.id)?.runState, 'hardening');
});

test('Mark Ready refuses a populated tab without an overview and reports the tab', async () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/tab', format: 'structured', runState: 'hardening' });
  const res = await svc.markPlanReady({ planId: plan.id, actor: 'sup' },
    markDeps({ planId: plan.id, readiness: {
      tabsMissingOverview: ['plan'], failures: ['tab-overview-missing'], canMarkReady: false,
    } }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('tab-overview-missing'));
  assert.deepEqual(res.tabsMissingOverview, ['plan']);
});

test('Mark Ready refuses without a valid responsible supervisor', async () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/sup', format: 'structured', runState: 'hardening' });
  const res = await svc.markPlanReady({ planId: plan.id, actor: 'sup' },
    markDeps({ planId: plan.id, readiness: {
      responsibilityStatus: 'invalid', supervisorValid: false,
      failures: ['no-valid-responsible-supervisor'], canMarkReady: false,
    } }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('no-valid-responsible-supervisor'));
  assert.equal(dbm.getPlan(plan.id)?.runState, 'hardening');
});

test('Mark Ready reports a missing plan without throwing', async () => {
  const res = await svc.markPlanReady({ planId: 'plan-nope', actor: 'sup' }, markDeps({ readiness: {
    runState: null, failures: ['plan-not-found'], canMarkReady: false,
  } }));
  assert.deepEqual({ ok: res.ok, failures: res.failures }, { ok: false, failures: ['plan-not-found'] });
});

test('Mark Ready uses compare-and-set and refuses a raced hardening state', async () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/race', format: 'structured', runState: 'hardening' });
  const res = await svc.markPlanReady({ planId: plan.id, actor: 'sup' }, {
    ...markDeps({ planId: plan.id }),
    compareAndSetReady: () => false,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures, ['plan-not-hardening']);
  assert.equal(dbm.getPlan(plan.id)?.runState, 'hardening');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-lifecycle-'));
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
  dbm.getDb().prepare(
    `INSERT INTO workspaces (id, title, path, path_type) VALUES ('ws-1', 'fixture', 'C:/fixture', 'windows')`,
  ).run();
  dbm.getDb().prepare(
    `INSERT INTO plans (id, workspace_id, path, format, mtime_ms, size_bytes, artifact_id)
     VALUES ('plan-1', 'ws-1', '.lares/plans/fixture', 'structured', 0, 0, 'plan_00000001')`,
  ).run();
  dbm.getDb().prepare(
    `INSERT INTO plan_intents
       (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind,
        source_doc_rel_path, status, first_seen_at, updated_at, last_scanned_at)
     VALUES ('intent-row-fixture', 'ws-1', 'plan-1', 'plan_00000001', 'int_00000001',
             'research', 'plan.md', 'active', 1, 1, 1)`,
  ).run();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  svc = require('./plan-lifecycle') as ServiceModule;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
