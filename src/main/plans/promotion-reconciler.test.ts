// WP-P3-reconcile acceptance — pending-promotion startup reconstruction (§R-P3
// point 6). One fixture per crash-matrix row, driven by seeding real
// `promotion_requests` rows + a fake PromotionDeliveryInspector + a fake
// adoptPlanFolder + a fake enrich/dispatch, plus idempotent-across-repeated-boots
// and pending-latch-coalescing cases.
//
// Proves (mapping to the spec's Accept list):
//   - not-reserved (crash before Phase-1 commit) → claim + dispatch, no duplicate;
//   - reserved-unbound (crash inside/failing Phase-2a) → resumeDelivery on the SAME
//     orchestration (no duplicate orchestration);
//   - bound-undelivered (crash after Phase-2a, before attempt) → resumeDelivery
//     (full send once, same agent);
//   - submitted-unconfirmed (crash after attempt, before turn-start) →
//     resumeSubmitOnly, body NEVER retyped;
//   - delivered / crash-after-folder-adoption-before-enrichment → adoptPlanFolder +
//     enrich, NO second worker, no duplicate responsibility event;
//   - indeterminate → request stays pending with a diagnostic, NO dispatch;
//   - adopt only ever touches the request's own folder (unrelated dirs untouched);
//   - idempotent across repeated boots (enriched drops out; dispatched is not
//     re-dispatched);
//   - the pending latch is re-acquired so a concurrent live promote coalesces.
//
// It is INTENTIONALLY not registered in scripts/run-main-tests.mjs (P3Z owns that
// registry). Run the compiled test directly:
//   npm run build:main
//   node dist/main/main/plans/promotion-reconciler.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (promote-proposal.core.test precedent) ─
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
  pragma(_s: string): unknown { return undefined; }
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

// ── modules under test (loaded after cache injection) ────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
let dbm: any;
let promote: any;
let reconciler: any;
let watcher: any;
let wsId = '';

const PLANS_HOME = '.lares/plans';

let seq = 0;
/** Seed a real `promotion_requests` row; optionally bind an orchestration id so
 *  the reconciler classifies it via the (faked) inspector. */
function seedRequest(opts: { hex: string; orchestrationId?: string | null }): any {
  const hex = opts.hex;
  const proposalArtifactId = `prop_${hex}`;
  const planArtifactId = promote.derivePlanArtifactId(proposalArtifactId);
  const sku = `2026-08-03-feature-${hex}-${planArtifactId.slice('plan_'.length, 'plan_'.length + 8)}`;
  const { row } = dbm.insertOrReadPromotionRequest({
    id: `promreq_${hex}_${++seq}`,
    workspaceId: wsId,
    proposalId: `prop-row-${hex}`,
    proposalArtifactId,
    planArtifactId,
    targetFolderRelPath: `${PLANS_HOME}/${sku}`,
    supervisorId: 'sup-1',
  });
  if (opts.orchestrationId) {
    dbm.getDb().prepare('UPDATE promotion_requests SET orchestration_id = ? WHERE id = ?')
      .run(opts.orchestrationId, row.id);
  }
  return dbm.getPromotionRequestById(row.id);
}

/** Fake delivery oracle: a per-orchestration probe map + recorded resume calls. */
function makeFakeInspector(states: Record<string, any>) {
  const calls = { inspect: [] as string[], resumeDelivery: [] as string[], resumeSubmitOnly: [] as string[] };
  const inspector = {
    async inspectDelivery(orchestrationId: string) {
      calls.inspect.push(orchestrationId);
      return states[orchestrationId] ?? { state: 'not-reserved' };
    },
    async resumeDelivery(orchestrationId: string) { calls.resumeDelivery.push(orchestrationId); },
    async resumeSubmitOnly(orchestrationId: string) { calls.resumeSubmitOnly.push(orchestrationId); },
  };
  return { inspector, calls };
}

/** A deps builder scoped to exactly one seeded request (re-reads fresh state each
 *  boot, so an enriched/failed row correctly drops out of the pending scan). */
function depsFor(req: any, over: Partial<any> = {}): any {
  const adoptCalls: string[] = [];
  const enrichCalls: any[] = [];
  const dispatchCalls: string[] = [];
  const diags: any[] = [];
  const base: any = {
    listPending: () => {
      const r = dbm.getPromotionRequestById(req.id);
      return r && r.state === 'pending' ? [r] : [];
    },
    inspector: makeFakeInspector({}).inspector,
    adoptPlanFolder: async () => ({ adopted: false, reason: 'absent' }),
    enrichAdoptedPlan: async (input: any) => { enrichCalls.push(input); return { planId: input.planId }; },
    dispatchFresh: async (r: any) => { dispatchCalls.push(r.id); },
    onDiagnostic: (d: any) => diags.push(d),
    ...over,
  };
  // Wrap the resolved adoptPlanFolder (base or overridden) so adopt calls are
  // always recorded regardless of which result the case wants back.
  const innerAdopt = base.adoptPlanFolder;
  base.adoptPlanFolder = async (r: any) => { adoptCalls.push(r.targetFolderRelPath); return innerAdopt(r); };
  return { deps: base, adoptCalls, enrichCalls, dispatchCalls, diags };
}

// ── cases ────────────────────────────────────────────────────────────────────

test('crash before Phase-1 commit (not-reserved) → claim + dispatch, no duplicate', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'notres1', orchestrationId: null });
  const { deps, dispatchCalls } = depsFor(req);
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].outcome, 'dispatched');
  assert.equal(report.entries[0].probeState, 'not-reserved');
  assert.deepEqual(dispatchCalls, [req.id], 'dispatchFresh called exactly once for the request');
});

test('not-reserved but no dispatch runtime wired → left pending, diagnostic, NO mis-dispatch', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'nowire1', orchestrationId: null });
  const { deps, diags } = depsFor(req, { dispatchFresh: undefined });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'left-pending');
  assert.ok(diags.some((d: any) => /not wired/i.test(d.detail)), 'diagnostic explains the unwired dispatch');
});

test('crash inside/failing Phase-2a (reserved-unbound) → resumeDelivery, SAME orchestration, no duplicate', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'resunb1', orchestrationId: 'run-resunb1' });
  const { inspector, calls } = makeFakeInspector({ 'run-resunb1': { state: 'reserved-unbound' } });
  const { deps, dispatchCalls } = depsFor(req, { inspector });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'resumed-deliver');
  assert.deepEqual(calls.resumeDelivery, ['run-resunb1'], 'resumeDelivery on the existing orchestration');
  assert.deepEqual(dispatchCalls, [], 'no fresh dispatch — no duplicate orchestration');
});

test('crash after Phase-2a, before attempt (bound-undelivered) → resumeDelivery full send once, same agent', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'bound1', orchestrationId: 'run-bound1' });
  const { inspector, calls } = makeFakeInspector({ 'run-bound1': { state: 'bound-undelivered', agentId: 'agent-b1' } });
  const { deps } = depsFor(req, { inspector });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'resumed-deliver');
  assert.deepEqual(calls.resumeDelivery, ['run-bound1']);
  assert.deepEqual(calls.resumeSubmitOnly, [], 'a body send, not a submit-only re-press');
});

test('crash after attempt, before turn-start (submitted-unconfirmed) → resumeSubmitOnly, body never retyped', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'submit1', orchestrationId: 'run-submit1' });
  const { inspector, calls } = makeFakeInspector({ 'run-submit1': { state: 'submitted-unconfirmed', agentId: 'agent-s1' } });
  const { deps } = depsFor(req, { inspector });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'resumed-submit');
  assert.deepEqual(calls.resumeSubmitOnly, ['run-submit1'], 'submit-only recovery');
  assert.deepEqual(calls.resumeDelivery, [], 'the full body is NEVER retyped');
});

test('delivered → adoptPlanFolder + enrich, NO second worker', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'deliv1', orchestrationId: 'run-deliv1' });
  const { inspector } = makeFakeInspector({ 'run-deliv1': { state: 'delivered', agentId: 'agent-d1' } });
  const { deps, adoptCalls, enrichCalls, dispatchCalls } = depsFor(req, {
    inspector,
    adoptPlanFolder: async () => ({ adopted: true, planId: 'plan-row-d1', change: 'adopted' }),
  });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'enriched');
  assert.deepEqual(adoptCalls, [req.targetFolderRelPath], 'adopt targeted only the request folder');
  assert.equal(enrichCalls.length, 1, 'enriched exactly once — no second worker');
  assert.equal(enrichCalls[0].planId, 'plan-row-d1', 'enriched the adopted plans row');
  assert.equal(enrichCalls[0].responsibilityEventId, promote.deriveResponsibilityEventId(req.id),
    'observes the deterministic responsibility event_id (no duplicate)');
  assert.deepEqual(dispatchCalls, [], 'no dispatch on a delivered request');
});

test('crash after folder adoption, before enrichment (row still pending) → enrich completes, no duplicate event', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'adopted1', orchestrationId: 'run-adopted1' });
  // The folder is already adopted → adoptPlanFolder is an idempotent no-op refresh.
  const { inspector } = makeFakeInspector({ 'run-adopted1': { state: 'delivered', agentId: 'agent-a1' } });
  const { deps, enrichCalls } = depsFor(req, {
    inspector,
    adoptPlanFolder: async () => ({ adopted: true, planId: 'plan-row-a1', change: 'unchanged' }),
  });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'enriched');
  assert.equal(enrichCalls.length, 1);
  assert.equal(enrichCalls[0].responsibilityEventId, promote.deriveResponsibilityEventId(req.id));
});

test('indeterminate → request stays pending with a diagnostic, NO dispatch', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'indet1', orchestrationId: 'run-indet1' });
  const { inspector, calls } = makeFakeInspector({
    'run-indet1': { state: 'indeterminate', boundAgentId: 'agent-i1', diagnostic: 'unreadable PTY' },
  });
  const { deps, dispatchCalls, enrichCalls, diags } = depsFor(req, { inspector });
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'left-pending');
  assert.deepEqual(dispatchCalls, [], 'no dispatch on uncertainty');
  assert.deepEqual(calls.resumeDelivery, []);
  assert.deepEqual(calls.resumeSubmitOnly, []);
  assert.equal(enrichCalls.length, 0);
  assert.ok(diags.some((d: any) => /indeterminate/i.test(d.detail)), 'emits an indeterminate diagnostic');
  // The row is untouched — still pending for the next boot.
  assert.equal(dbm.getPromotionRequestById(req.id).state, 'pending');
});

test('idempotent across repeated boots: a delivered request enriches once then drops out', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'idem1', orchestrationId: 'run-idem1' });
  const { inspector } = makeFakeInspector({ 'run-idem1': { state: 'delivered', agentId: 'agent-idem1' } });
  const enrichCalls: any[] = [];
  const deps = {
    listPending: () => {
      const r = dbm.getPromotionRequestById(req.id);
      return r && r.state === 'pending' ? [r] : [];
    },
    inspector,
    adoptPlanFolder: async () => ({ adopted: true, planId: 'plan-row-idem1', change: 'adopted' }),
    // A faithful enrich flips the request pending → adopted (the real DB step's
    // terminal effect), so a second boot no longer scans it.
    enrichAdoptedPlan: async (input: any) => {
      enrichCalls.push(input);
      dbm.getDb().prepare("UPDATE promotion_requests SET state = 'adopted' WHERE id = ?").run(req.id);
      return { planId: input.planId };
    },
    dispatchFresh: async () => { throw new Error('must not dispatch a delivered request'); },
  };
  const boot1 = await reconciler.reconcilePendingPromotions(deps);
  const boot2 = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(boot1.processed, 1, 'boot 1 processed the pending request');
  assert.equal(boot1.entries[0].outcome, 'enriched');
  assert.equal(boot2.processed, 0, 'boot 2 sees the adopted row drop out of the pending scan');
  assert.equal(enrichCalls.length, 1, 'enriched exactly once across two boots (idempotent)');
});

test('idempotent across boots: a dispatched request is not re-dispatched', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'idem2', orchestrationId: null });
  const dispatchCalls: string[] = [];
  const states: Record<string, any> = {};
  const { inspector } = makeFakeInspector(states);
  const deps = {
    listPending: () => {
      const r = dbm.getPromotionRequestById(req.id);
      return r && r.state === 'pending' ? [r] : [];
    },
    inspector,
    adoptPlanFolder: async () => ({ adopted: false, reason: 'absent' }),
    enrichAdoptedPlan: async (input: any) => ({ planId: input.planId }),
    // A faithful fresh dispatch reserves + binds an orchestration onto the request
    // (Phase 1) — so the NEXT boot reads a resumable state, not not-reserved.
    dispatchFresh: async (r: any) => {
      dispatchCalls.push(r.id);
      dbm.getDb().prepare('UPDATE promotion_requests SET orchestration_id = ? WHERE id = ?').run('run-idem2', r.id);
      states['run-idem2'] = { state: 'bound-undelivered', agentId: 'agent-idem2' };
    },
  };
  const boot1 = await reconciler.reconcilePendingPromotions(deps);
  const boot2 = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(boot1.entries[0].outcome, 'dispatched');
  assert.equal(boot2.entries[0].outcome, 'resumed-deliver', 'boot 2 resumes the bound attempt');
  assert.deepEqual(dispatchCalls, [req.id], 'dispatched exactly once — never a duplicate worker');
});

test('the pending latch is re-acquired so a concurrent live promote coalesces', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'latch1', orchestrationId: 'run-latch1' });
  assert.ok(!promote.isPromotionLatched(wsId, req.proposalArtifactId), 'latch clear before reconcile');
  const { inspector } = makeFakeInspector({ 'run-latch1': { state: 'bound-undelivered', agentId: 'agent-l1' } });
  // Use the REAL default acquireLatch (module latch map) — no override.
  const deps = {
    listPending: () => {
      const r = dbm.getPromotionRequestById(req.id);
      return r && r.state === 'pending' ? [r] : [];
    },
    inspector,
    adoptPlanFolder: async () => ({ adopted: false, reason: 'absent' }),
    enrichAdoptedPlan: async (input: any) => ({ planId: input.planId }),
  };
  await reconciler.reconcilePendingPromotions(deps);
  assert.ok(promote.isPromotionLatched(wsId, req.proposalArtifactId),
    'still-open request re-acquired its pending latch → a live promote coalesces');
});

test('no delivery oracle wired → latch re-acquired + adopt ensured, delivery reconciliation deferred (no redrive)', async () => {
  promote._resetPromotionLatchesForTests();
  const req = seedRequest({ hex: 'nooracle1', orchestrationId: 'run-nooracle1' });
  const adoptCalls: string[] = [];
  const diags: any[] = [];
  const deps = {
    listPending: () => {
      const r = dbm.getPromotionRequestById(req.id);
      return r && r.state === 'pending' ? [r] : [];
    },
    // inspector deliberately omitted (promotion runtime not yet assembled).
    adoptPlanFolder: async (r: any) => { adoptCalls.push(r.targetFolderRelPath); return { adopted: false, reason: 'absent' }; },
    enrichAdoptedPlan: async (input: any) => ({ planId: input.planId }),
    onDiagnostic: (d: any) => diags.push(d),
  };
  const report = await reconciler.reconcilePendingPromotions(deps);
  assert.equal(report.entries[0].outcome, 'left-pending', 'bound request left pending without an oracle');
  assert.deepEqual(adoptCalls, [req.targetFolderRelPath], 'adopt still ensured (idempotent)');
  assert.ok(promote.isPromotionLatched(wsId, req.proposalArtifactId), 'latch still re-acquired for coalescing');
  assert.ok(diags.some((d: any) => /oracle not wired/i.test(d.detail)), 'diagnostic explains the deferral');
  assert.equal(dbm.getPromotionRequestById(req.id).state, 'pending', 'row untouched — no redrive');
});

test('real adoptPlanFolder export: idempotent single-folder adopt + absent handling', async () => {
  // A real on-disk workspace so workspaceStateDir resolves to a real `.lares`.
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-adopt-'));
  const ws = dbm.createWorkspace({ title: 'adopt-ws', path: wsRoot, pathType: 'windows' });
  const sku = '2026-08-03-real-adopt-realadop';
  const folderAbs = path.join(wsRoot, '.lares', 'plans', sku);
  fs.mkdirSync(folderAbs, { recursive: true });
  fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({ plan_artifact_id: 'plan_realadopt', plan_sku: sku }), 'utf8');
  fs.writeFileSync(path.join(folderAbs, 'plan.md'), '# real adopt', 'utf8');

  const relPath = `.lares/plans/${sku}`;
  const first = await watcher.adoptPlanFolder(ws, relPath);
  assert.equal(first.adopted, true, 'a valid §R0 folder adopts');
  assert.ok(first.planId, 'returns the plans row id');
  assert.equal(first.change, 'adopted');

  const second = await watcher.adoptPlanFolder(ws, relPath);
  assert.equal(second.adopted, true, 'a second adopt is an idempotent no-op refresh');
  assert.equal(second.planId, first.planId, 'same row (keyed on plan_artifact_id)');
  assert.equal(second.change, 'unchanged', 'idempotent: nothing changed on disk');

  const absent = await watcher.adoptPlanFolder(ws, '.lares/plans/does-not-exist');
  assert.equal(absent.adopted, false);
  assert.equal(absent.reason, 'absent', 'a missing folder is a clean absent, never a throw');

  try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-reconcile-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database');
  promote = require('./promote-proposal');
  reconciler = require('./promotion-reconciler');
  watcher = require('./plan-folder-watcher');
  dbm.initDatabase();
  wsId = dbm.createWorkspace({ title: 'promote-reconcile-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
