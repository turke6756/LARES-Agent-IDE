import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean; step(): boolean;
    getAsObject(): Record<string, unknown>; free(): boolean;
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
  close(): void { /* persistent fixture */ }
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
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let dbm: any;
let drainMod: any;
let seq = 0;

function seedRequest(orchestrationId: string | null = null): any {
  const id = `legacy-${++seq}`;
  const { row } = dbm.insertOrReadPromotionRequest({
    id,
    workspaceId: 'ws-drain',
    proposalId: `proposal-${id}`,
    proposalArtifactId: `prop_${id}`,
    planArtifactId: `plan_${id}`,
    targetFolderRelPath: `.lares/plans/${id}`,
  });
  if (orchestrationId) {
    seedRun(orchestrationId, 'starting');
    dbm.repairLegacyPromotionRequestPointer(id, orchestrationId);
  }
  return dbm.getPromotionRequestById(id);
}

function seedRun(runId: string, status: string): void {
  dbm.insertOrchestration({
    runId, name: 'promotion', mode: 'serial', status,
    workspaceId: 'ws-drain', supervisorId: 'sup', topic: 'legacy', planPath: '.lares/plans/x',
    leadProvider: 'claude', reviewerProvider: 'claude', turnTimeoutMs: 1,
    lastRelayedTs: {}, startedAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
  });
}

function projection(status: 'synced' | 'invalid' = 'synced', responsibility = 'valid'): any {
  return {
    planId: 'plan-row', folderRelPath: '.lares/plans/claimed', intentLedger: { diagnostics: [] },
    sourceProposal: { status }, responsibility: { status: responsibility }, workPackages: {}, overview: {},
  };
}

function harness(request: any, state: any, over: Record<string, any> = {}) {
  const calls = { inspect: 0, submitOnly: 0, stop: 0, reconcile: 0, retire: 0 };
  let currentState = state;
  let agent = over.agent ?? (state.agentId ? { id: state.agentId, status: 'working' } : null);
  let runtime = over.runtime ?? !!agent;
  const inspector = {
    async inspectDelivery() { calls.inspect++; return currentState; },
    async resumeSubmitOnly() {
      calls.submitOnly++;
      currentState = over.afterSubmit ?? currentState;
    },
  };
  const deps = {
    inspector,
    listPending: () => [dbm.getPromotionRequestById(request.id)].filter(Boolean),
    scanClaims: async () => over.claim ?? { kind: 'none' },
    reconcileFolder: async () => { calls.reconcile++; return over.projection ?? projection(); },
    getWorkspace: () => ({ id: 'ws-drain', path: 'C:/ws', pathType: 'windows' }),
    getAgent: () => agent,
    hasLiveRuntime: () => runtime,
    stopAgent: async (agentId: string) => {
      calls.stop++;
      if (over.stopThrows) throw new Error('stop failed');
      if (over.stopUnverified) return { agentId, outcome: 'failed', killedRunner: false, reason: 'supervisor' };
      runtime = false;
      if (agent) agent = { ...agent, status: 'done' };
      return { agentId, outcome: 'stopped', killedRunner: true, reason: 'supervisor' };
    },
    retire: () => {
      calls.retire++;
      return { dropped: false, alreadyDropped: false, reason: 'pending-requests', pendingRequestIds: [],
        nonterminalRunIds: [], orphanNonterminalRunIds: [], pointerDisagreementRequestIds: [] };
    },
  };
  return { drain: new drainMod.LegacyPromotionDrain(deps), calls };
}

test('never-reserved fails deterministically and never dispatches or submits a body', async () => {
  const request = seedRequest();
  const { drain, calls } = harness(request, { state: 'not-reserved' });
  const report = await drain.drainAndRetire();
  assert.equal(report.entries[0].outcome, 'failed');
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-never-reserved');
  assert.equal(calls.submitOnly, 0);
});

test('one event-proven reservation repairs a missing request pointer atomically', async () => {
  const request = seedRequest();
  seedRun('run-repair', 'starting');
  dbm.insertOrchestrationEvent({
    runId: 'run-repair', ts: '2026-08-06T00:00:00.000Z',
    kind: 'promotion.reserved', payload: { requestId: request.id },
  });
  const { drain } = harness(request, { state: 'reserved-unbound' });
  await drain.drainAndRetire();
  const row = dbm.getPromotionRequestById(request.id);
  assert.equal(row.orchestrationId, 'run-repair');
  assert.equal(row.failureReason, 'legacy-not-delivered');
});

test('multiple event-proven reservations remain pending as inconsistent', async () => {
  const request = seedRequest();
  for (const runId of ['run-multi-a', 'run-multi-b']) {
    seedRun(runId, 'starting');
    dbm.insertOrchestrationEvent({
      runId, ts: '2026-08-06T00:00:00.000Z',
      kind: 'promotion.reserved', payload: { requestId: request.id },
    });
  }
  const { drain, calls } = harness(request, { state: 'reserved-unbound' });
  await drain.drainAndRetire();
  const row = dbm.getPromotionRequestById(request.id);
  assert.equal(row.state, 'pending');
  assert.match(row.failureReason, /legacy-reservation-inconsistent/);
  assert.equal(calls.inspect, 0, 'ambiguous evidence is never redriven');
});

test('reserved-unbound aborts as legacy-not-delivered without launching or delivering', async () => {
  const request = seedRequest('run-unbound');
  const { drain, calls } = harness(request, { state: 'reserved-unbound' });
  await drain.drainAndRetire();
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-not-delivered');
  assert.equal(dbm.getOrchestrationRun('run-unbound').status, 'aborted');
  assert.equal(calls.stop, 0);
  assert.equal(calls.submitOnly, 0);
});

test('bound-undelivered verifies stop before legacy-not-delivered terminalization', async () => {
  const request = seedRequest('run-bound');
  const { drain, calls } = harness(request, { state: 'bound-undelivered', agentId: 'agent-bound' });
  await drain.drainAndRetire();
  assert.equal(calls.stop, 1);
  assert.equal(calls.submitOnly, 0, 'no undelivered attempt receives any input');
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-not-delivered');
});

test('bound-undelivered unverifiable stop stays pending', async () => {
  const request = seedRequest('run-unverified');
  const { drain, calls } = harness(
    request,
    { state: 'bound-undelivered', agentId: 'agent-unverified' },
    { stopUnverified: true },
  );
  await drain.drainAndRetire();
  const row = dbm.getPromotionRequestById(request.id);
  assert.equal(row.state, 'pending');
  assert.equal(row.failureReason, 'legacy-bound-agent-stop-unconfirmed');
  assert.equal(calls.submitOnly, 0);
});

test('submitted-unconfirmed live attempt performs submit-only recovery, never a body send', async () => {
  const request = seedRequest('run-submit');
  const { drain, calls } = harness(
    request,
    { state: 'submitted-unconfirmed', agentId: 'agent-submit' },
    { afterSubmit: { state: 'delivered', agentId: 'agent-submit' } },
  );
  const report = await drain.drainAndRetire();
  assert.equal(report.entries[0].outcome, 'submit-only-recovery');
  assert.equal(calls.submitOnly, 1);
  assert.equal(dbm.getPromotionRequestById(request.id).state, 'pending');
});

test('submitted-unconfirmed terminal agent fails without pressing submit', async () => {
  const request = seedRequest('run-submit-terminal');
  const { drain, calls } = harness(
    request,
    { state: 'submitted-unconfirmed', agentId: 'agent-terminal' },
    { agent: { id: 'agent-terminal', status: 'done' }, runtime: false },
  );
  await drain.drainAndRetire();
  assert.equal(calls.submitOnly, 0);
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-submitted-unconfirmed-terminal');
});

test('submitted-unconfirmed terminal run stops and verifies its live agent before failure', async () => {
  const request = seedRequest('run-submit-stop');
  const run = dbm.getOrchestrationRun('run-submit-stop');
  dbm.updateOrchestration({ ...run, status: 'error' });
  const { drain, calls } = harness(
    request,
    { state: 'submitted-unconfirmed', agentId: 'agent-submit-stop' },
  );
  await drain.drainAndRetire();
  assert.equal(calls.submitOnly, 0);
  assert.equal(calls.stop, 1);
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-submitted-unconfirmed-terminal');
});

test('indeterminate delivery evidence remains pending and never redrives', async () => {
  const request = seedRequest('run-indeterminate');
  const { drain, calls } = harness(request, {
    state: 'indeterminate', boundAgentId: 'agent-indeterminate', diagnostic: 'witness unavailable',
  });
  await drain.drainAndRetire();
  const row = dbm.getPromotionRequestById(request.id);
  assert.equal(row.state, 'pending');
  assert.match(row.failureReason, /legacy-delivery-evidence-unreadable/);
  assert.equal(calls.submitOnly, 0);
  assert.equal(calls.stop, 0);
});

test('delivered terminal run with no folder fails deterministically', async () => {
  const request = seedRequest('run-delivered');
  const run = dbm.getOrchestrationRun('run-delivered');
  dbm.updateOrchestration({ ...run, status: 'complete' });
  const { drain } = harness(
    request,
    { state: 'delivered', agentId: 'agent-delivered' },
    { agent: { id: 'agent-delivered', status: 'done' }, runtime: false },
  );
  await drain.drainAndRetire();
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-delivered-no-folder');
});

test('delivered run with no folder stops and verifies its live worker before failure', async () => {
  const request = seedRequest('run-delivered-live');
  const run = dbm.getOrchestrationRun('run-delivered-live');
  dbm.updateOrchestration({ ...run, status: 'complete' });
  const { drain, calls } = harness(
    request,
    { state: 'delivered', agentId: 'agent-delivered-live' },
  );
  await drain.drainAndRetire();
  assert.equal(calls.stop, 1);
  assert.equal(dbm.getPromotionRequestById(request.id).failureReason, 'legacy-delivered-no-folder');
});

test('delivered run with an unverifiable live worker remains pending', async () => {
  const request = seedRequest('run-delivered-unverified');
  const run = dbm.getOrchestrationRun('run-delivered-unverified');
  dbm.updateOrchestration({ ...run, status: 'complete' });
  const { drain, calls } = harness(
    request,
    { state: 'delivered', agentId: 'agent-delivered-unverified' },
    { stopUnverified: true },
  );
  await drain.drainAndRetire();
  assert.equal(calls.stop, 1);
  const row = dbm.getPromotionRequestById(request.id);
  assert.equal(row.state, 'pending');
  assert.equal(row.failureReason, 'legacy-bound-agent-stop-unconfirmed');
});

test('matching folder awaits coordinator convergence before adoption', async () => {
  const request = seedRequest('run-folder');
  let release!: (value: any) => void;
  const gate = new Promise<any>((resolve) => { release = resolve; });
  const { drain } = harness(
    request,
    { state: 'delivered', agentId: 'agent-folder' },
    { claim: { kind: 'claimed', planArtifactId: request.planArtifactId, folderRelPath: '.lares/plans/claimed' }, projection: undefined },
  );
  (drain as any).deps.reconcileFolder = () => gate;
  const running = drain.drainAndRetire();
  await Promise.resolve();
  assert.equal(dbm.getPromotionRequestById(request.id).state, 'pending', 'not adopted before coordinator settles');
  release(projection());
  const report = await running;
  assert.equal(report.entries[0].outcome, 'adopted', JSON.stringify(report.entries[0]));
  assert.equal(dbm.getPromotionRequestById(request.id).state, 'adopted');
});

test('duplicate claimant folders remain pending with a queryable diagnostic', async () => {
  const request = seedRequest('run-duplicate');
  const { drain } = harness(request, { state: 'delivered', agentId: 'agent-dup' }, {
    claim: { kind: 'duplicate', folderRelPaths: ['a', 'b'], diagnostic: 'two claimants' },
  });
  await drain.drainAndRetire();
  const row = dbm.getPromotionRequestById(request.id);
  assert.equal(row.state, 'pending');
  assert.match(row.failureReason, /legacy-duplicate-folders/);
});

test('drainAndRetire is single-flight and calls retirement only after sweep is inactive', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let retireActive: boolean | null = null;
  const drain = new drainMod.LegacyPromotionDrain({
    inspector: { inspectDelivery: async () => ({ state: 'not-reserved' }), resumeSubmitOnly: async () => {} },
    scanClaims: async () => { await gate; return { kind: 'none' }; },
    listPending: () => [],
    hasLiveRuntime: () => false,
    stopAgent: async () => ({ outcome: 'not_found' }),
    retire: (input: any) => {
      retireActive = input.activeDrain;
      return { dropped: true, alreadyDropped: false, reason: 'dropped', pendingRequestIds: [],
        nonterminalRunIds: [], orphanNonterminalRunIds: [], pointerDisagreementRequestIds: [] };
    },
  });
  const first = drain.drainAndRetire();
  const second = drain.drainAndRetire();
  assert.equal(first, second, 'concurrent callers join one operation');
  release();
  await first;
  assert.equal(retireActive, false, 'retirement observes a fully settled drain');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-promotion-drain-'));
  process.env.APPDATA = tmpAppData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  dbm = require('../database');
  drainMod = require('./legacy-promotion-drain');
  dbm.initDatabase();

  let passed = 0, failed = 0;
  for (const item of tests) {
    try { await item.run(); console.log(`  ok  ${item.name}`); passed++; }
    catch (error) {
      console.error(`  FAIL ${item.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed++;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
