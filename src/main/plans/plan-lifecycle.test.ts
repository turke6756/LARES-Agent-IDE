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
}

type PlanWorkPackage = {
  id: string; workspaceId: string; planId: string; title: string;
  acceptanceCondition: string | null; state: string; assigneeAgentId: string | null;
  revision: number; createdAt: number; updatedAt: number;
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
  ): { ok: boolean; runState: string | null; failures: string[]; tabsMissingOverview: string[] };
};

let dbm: DbModule;
let svc: ServiceModule;

let seq = 0;
function makePackage(over: Partial<PlanWorkPackage> = {}): PlanWorkPackage {
  seq += 1;
  return {
    id: `wp-${seq}`, workspaceId: 'ws-1', planId: 'plan-1', title: 'WP',
    acceptanceCondition: null, state: 'ready', assigneeAgentId: null,
    revision: 1, createdAt: 1000, updatedAt: 1000, ...over,
  };
}

function setResponsibleSupervisor(planId: string, agentId: string | null): void {
  dbm.getDb().prepare('UPDATE plans SET responsible_supervisor_id = ? WHERE id = ?').run(agentId, planId);
}

// ── DB primitive: transition + ledger ─────────────────────────────────────────

test('a transition updates state and ledgers from/to/actor/ts atomically', () => {
  const pkg = makePackage({ state: 'ready' });
  dbm.upsertPlanWorkPackage(pkg);
  const ev = dbm.transitionPlanWorkPackageState({
    eventId: 'ev-1', packageId: pkg.id, toState: 'executing', actor: 'agent-x', reason: 'go', ts: 2000,
  });
  assert.equal(dbm.getPlanWorkPackage(pkg.id)?.state, 'executing');
  assert.deepEqual(
    { from: ev.fromState, to: ev.toState, actor: ev.actor, reason: ev.reason, ts: ev.ts },
    { from: 'ready', to: 'executing', actor: 'agent-x', reason: 'go', ts: 2000 },
  );
  assert.deepEqual(dbm.listPlanWpLifecycleEvents(pkg.id).map((e) => e.toState), ['executing']);
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
  return {
    listPackages: () => [makePackage({ state: 'ready' })],
    getPopulatedTabs: () => [],
    hasOverview: () => true,
    hasValidResponsibleSupervisor: () => true,
    ...over,
  };
}

test('Mark Ready flips hardening → ready when all conditions hold', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/ready', format: 'structured', runState: 'hardening' });
  const res = svc.markPlanReady({ planId: plan.id, actor: 'sup' }, markDeps());
  assert.deepEqual({ ok: res.ok, runState: res.runState, failures: res.failures }, { ok: true, runState: 'ready', failures: [] });
  assert.equal(dbm.getPlan(plan.id)?.runState, 'ready');
});

test('Mark Ready refuses a plan not in hardening and never flips run_state', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/exec', format: 'structured', runState: 'executing' });
  const res = svc.markPlanReady({ planId: plan.id, actor: 'sup' }, markDeps());
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('plan-not-hardening'));
  assert.equal(dbm.getPlan(plan.id)?.runState, 'executing');
});

test('Mark Ready refuses when no non-archived package exists', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/arc', format: 'structured', runState: 'hardening' });
  const res = svc.markPlanReady({ planId: plan.id, actor: 'sup' },
    markDeps({ listPackages: () => [makePackage({ state: 'archived' })] }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('no-active-package'));
  assert.equal(dbm.getPlan(plan.id)?.runState, 'hardening');
});

test('Mark Ready refuses a populated tab without an overview and reports the tab', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/tab', format: 'structured', runState: 'hardening' });
  const res = svc.markPlanReady({ planId: plan.id, actor: 'sup' },
    markDeps({ getPopulatedTabs: () => ['proposal', 'plan'], hasOverview: (_p: string, t: string) => t === 'proposal' }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('tab-overview-missing'));
  assert.deepEqual(res.tabsMissingOverview, ['plan']);
});

test('Mark Ready refuses without a valid responsible supervisor', () => {
  const ws = dbm.createWorkspace({ title: 'W', path: 'C:/w', pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({ workspaceId: ws.id, path: 'p/sup', format: 'structured', runState: 'hardening' });
  const res = svc.markPlanReady({ planId: plan.id, actor: 'sup' },
    markDeps({ hasValidResponsibleSupervisor: () => false }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.includes('no-valid-responsible-supervisor'));
  assert.equal(dbm.getPlan(plan.id)?.runState, 'hardening');
});

test('Mark Ready reports a missing plan without throwing', () => {
  const res = svc.markPlanReady({ planId: 'plan-nope', actor: 'sup' }, markDeps());
  assert.deepEqual({ ok: res.ok, failures: res.failures }, { ok: false, failures: ['plan-not-found'] });
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
