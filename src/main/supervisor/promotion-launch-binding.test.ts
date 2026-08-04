// WP-P3B-core — the crash/fault-boundary matrix for the two-phase
// bind-before-deliver promotion lifecycle, plus the boot-reconciliation guard.
//
// Recovery must be deterministic at each labeled boundary, driven ONLY by
// durable evidence:
//   before Phase-1 commit                                 → not-reserved
//   inside the Phase-2a agent/member/event txn (fault)    → rolls back atomically
//                                                            (no unbound orphan) → reserved-unbound
//   after Phase-2a commit, before delivery_attempt        → bound-undelivered (safe full send once)
//   after delivery_attempt, turn start unconfirmed        → submitted-unconfirmed (submit-only recovery)
//   turn start confirmed, delivered not yet written       → delivered (marker + turn-start)
//   after promotion.delivered                             → delivered
// Recovery never resends a body blindly and never launches a second worker.
// Also: name='promotion' rows are EXCLUDED by markActiveRunsAborted's SQL and
// survive boot.
//
//   npm run build:main
//   node dist/main/main/supervisor/promotion-launch-binding.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in ────────────────────────────────────
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

/* eslint-disable @typescript-eslint/no-explicit-any */
let dbm: any;
let dispatchMod: any;
let wsId = '';
let runSeq = 0;

function newRunId(): string { return `promrun-${++runSeq}`; }

function makePromotionRun(runId: string): any {
  const iso = new Date().toISOString();
  return {
    runId, name: 'promotion', mode: 'serial', status: 'starting',
    workspaceId: wsId, supervisorId: 'sup-1', topic: 'promote:x', planPath: '.lares/plans/x',
    leadProvider: 'claude', reviewerProvider: 'claude', turnTimeoutMs: 1, lastRelayedTs: {},
    startedAt: iso, updatedAt: iso, planBindingMode: 'agent-default',
  };
}

/** Seed a fresh promotion request + reserve Phase 1 (orchestration bound). */
function reservedRequest(tag: string): { requestId: string; runId: string } {
  const { row } = dbm.insertOrReadPromotionRequest({
    id: `promreq-${tag}`, workspaceId: wsId, proposalId: `p-${tag}`,
    proposalArtifactId: `prop_${tag}`, planArtifactId: `plan_${tag}`,
    targetFolderRelPath: `.lares/plans/${tag}`, supervisorId: 'sup-1',
  });
  const runId = newRunId();
  dbm.reservePromotionOrchestration({ requestId: row.id, run: makePromotionRun(runId), ts: new Date().toISOString(), incrementAttempt: false });
  return { requestId: row.id, runId };
}

function bindAgent(runId: string): any {
  return dbm.bindPromotionAgentAtomic(
    {
      workspaceId: wsId, title: `promote-${runId}`, roleDescription: '',
      workingDirectory: 'C:\\tmp\\ws', command: 'claude', provider: 'claude',
      isWorker: true, tmuxSessionName: null, autoRestartEnabled: false,
      logPath: `C:\\tmp\\${runId}.log`,
    },
    { runId, ts: new Date().toISOString() },
  );
}

function agentCount(): number {
  return (dbm.getDb().prepare('SELECT COUNT(*) AS n FROM agents').get() as any).n;
}

function orchestrationCount(): number {
  return (dbm.getDb().prepare('SELECT COUNT(*) AS n FROM orchestrations').get() as any).n;
}

function makeInspector(opts: { turnStarted?: boolean; deliverer?: any } = {}) {
  const deliverer = opts.deliverer ?? {
    async launchAgent() { throw new Error('unused'); },
    async sendInputConfirmed() { return { delivered: true, confirmed: true, mode: 'hook' as const }; },
    resubmitEnter() { /* spy set per-case */ },
  };
  const witness = () => opts.turnStarted ?? false;
  const promptFactory = (_req: any) => ({ prompt: 'FULL BODY', marker: 'promotion:x' });
  return new dispatchMod.PromotionDeliveryInspectorImpl(deliverer, witness, promptFactory);
}

// ── cases ────────────────────────────────────────────────────────────────────

test('before Phase-1 commit → not-reserved (request has no orchestration; a missing run reads not-reserved)', async () => {
  const { row } = dbm.insertOrReadPromotionRequest({
    id: 'promreq-nr', workspaceId: wsId, proposalId: 'p-nr', proposalArtifactId: 'prop_nr',
    planArtifactId: 'plan_nr', targetFolderRelPath: '.lares/plans/nr', supervisorId: 'sup-1',
  });
  assert.equal(row.orchestrationId, null, 'no orchestration bound before Phase 1');
  const probe = await makeInspector().inspectDelivery('no-such-run');
  assert.equal(probe.state, 'not-reserved');
});

test('Phase-1 committed, Phase-2a never ran → reserved-unbound', async () => {
  const { runId } = reservedRequest('ru');
  const probe = await makeInspector().inspectDelivery(runId);
  assert.equal(probe.state, 'reserved-unbound', 'no worker member → provably reserved-unbound');
});

test('a fault INSIDE the Phase-2a txn rolls back atomically — no unbound orphan agent → reserved-unbound', async () => {
  const { runId } = reservedRequest('rollback');
  const before = agentCount();
  // Inject a fault at the member-insert step (after the agent row is created) via
  // a trigger that aborts. Real SQLite semantics: the whole txn unwinds.
  dbm.getDb().exec(`CREATE TRIGGER test_fault_member BEFORE INSERT ON orchestration_members
    BEGIN SELECT RAISE(ABORT, 'injected-fault'); END;`);
  let threw = false;
  try { bindAgent(runId); } catch { threw = true; }
  dbm.getDb().exec('DROP TRIGGER test_fault_member');
  assert.ok(threw, 'the injected fault propagated');
  assert.equal(agentCount(), before, 'the agent row was rolled back (no unbound orphan)');
  assert.equal(dbm.getPromotionWorkerMember(runId), null, 'no worker member persisted');
  const probe = await makeInspector().inspectDelivery(runId);
  assert.equal(probe.state, 'reserved-unbound');
});

test('Phase-2a commits agent + worker member + promotion.agent_bound atomically → bound-undelivered', async () => {
  const { runId } = reservedRequest('bu');
  const before = agentCount();
  const agent = bindAgent(runId);
  assert.equal(agentCount(), before + 1, 'exactly one agent row created');
  assert.equal(dbm.getPromotionWorkerMember(runId), agent.id, 'bound as the worker member');
  assert.ok(dbm.hasOrchestrationEvent(runId, 'promotion.agent_bound'), 'agent_bound event persisted');
  // Status stays 'starting' after the bind (never a new status).
  assert.equal(dbm.getOrchestrationRun(runId).status, 'starting');
  const probe = await makeInspector().inspectDelivery(runId);
  assert.deepEqual(probe, { state: 'bound-undelivered', agentId: agent.id });
});

test('after delivery_attempt, turn start unconfirmed → submitted-unconfirmed (never delivered on submission)', async () => {
  const { runId } = reservedRequest('su');
  const agent = bindAgent(runId);
  dbm.recordPromotionDeliveryAttempt(runId, new Date().toISOString(), `promotion:promreq-su`);
  const probe = await makeInspector({ turnStarted: false }).inspectDelivery(runId);
  assert.deepEqual(probe, { state: 'submitted-unconfirmed', agentId: agent.id });
});

test('turn start confirmed but promotion.delivered not yet written → delivered (marker + turn-start prove it)', async () => {
  const { runId } = reservedRequest('ts');
  const agent = bindAgent(runId);
  dbm.recordPromotionDeliveryAttempt(runId, new Date().toISOString(), `promotion:promreq-ts`);
  const probe = await makeInspector({ turnStarted: true }).inspectDelivery(runId);
  assert.deepEqual(probe, { state: 'delivered', agentId: agent.id });
});

test('after promotion.delivered → delivered (durable stamp; run flipped to running)', async () => {
  const { runId } = reservedRequest('dv');
  const agent = bindAgent(runId);
  dbm.recordPromotionDeliveryAttempt(runId, new Date().toISOString(), `promotion:promreq-dv`);
  dbm.recordPromotionDelivered(runId, new Date().toISOString());
  assert.equal(dbm.getOrchestrationRun(runId).status, 'running', 'delivered flips the run to running');
  const probe = await makeInspector({ turnStarted: false }).inspectDelivery(runId);
  assert.deepEqual(probe, { state: 'delivered', agentId: agent.id }, 'the delivered stamp wins even if the live witness says no');
});

test('resumeSubmitOnly on a submitted-unconfirmed attempt re-presses submit, never retypes a body', async () => {
  const { runId } = reservedRequest('rso');
  const agent = bindAgent(runId);
  dbm.recordPromotionDeliveryAttempt(runId, new Date().toISOString(), `promotion:promreq-rso`);
  let resubmits = 0; let bodySends = 0;
  // The turn is NOT observed at inspect time (→ submitted-unconfirmed); the
  // re-press is what makes it start. A stateful witness flips only after the
  // submit re-press, so inspectDelivery reads unconfirmed and resumeSubmitOnly
  // proceeds.
  const deliverer = {
    async launchAgent() { throw new Error('unused'); },
    async sendInputConfirmed() { bodySends++; return { delivered: true, confirmed: true, mode: 'hook' as const }; },
    resubmitEnter(_id: string) { resubmits++; },
  };
  const witness = () => resubmits > 0;
  const promptFactory = (_req: any) => ({ prompt: 'FULL BODY', marker: 'promotion:x' });
  const inspector = new dispatchMod.PromotionDeliveryInspectorImpl(deliverer, witness, promptFactory);
  await inspector.resumeSubmitOnly(runId);
  assert.equal(resubmits, 1, 're-pressed submit exactly once');
  assert.equal(bodySends, 0, 'NEVER retyped the body');
  assert.ok(dbm.hasOrchestrationEvent(runId, 'promotion.delivered'), 'confirmed turn start → delivered');
  void agent;
});

test('resumeDelivery on a bound-undelivered attempt sends the full body once; no new worker', async () => {
  const { runId } = reservedRequest('rd');
  const agent = bindAgent(runId);
  const before = agentCount();
  let bodySends = 0; let launches = 0;
  const deliverer = {
    async launchAgent() { launches++; throw new Error('must not launch'); },
    async sendInputConfirmed(_id: string, _t: string) { bodySends++; return { delivered: true, confirmed: true, mode: 'hook' as const }; },
    resubmitEnter() { /* n/a */ },
  };
  await makeInspector({ deliverer }).resumeDelivery(runId);
  assert.equal(bodySends, 1, 'full body sent exactly once');
  assert.equal(launches, 0, 'no second worker launched');
  assert.equal(agentCount(), before, 'no new agent row');
  assert.ok(dbm.hasOrchestrationEvent(runId, 'promotion.delivered'), 'confirmed → delivered');
  assert.equal(dbm.getPromotionWorkerMember(runId), agent.id, 'still the exact bound agent');
});

test('resumeDelivery on a reserved-unbound attempt re-binds (Phase 2a) on the SAME orchestration then confirmed-delivers; no duplicate orchestration, no second body', async () => {
  const { requestId, runId } = reservedRequest('reru');
  const agentsBefore = agentCount();
  const runsBefore = orchestrationCount();
  // Precondition: reserved (Phase 1) but never bound (Phase 2a never committed).
  assert.equal(dbm.getPromotionWorkerMember(runId), null, 'no worker member → reserved-unbound');

  let launches = 0; let bodySends = 0; let resubmits = 0;
  const deliverer = {
    // The supervisor's launchAgent runs Phase 2a atomically INSIDE the launch — the
    // fake stands in for that by binding the worker onto the reserved runId it is
    // handed via the InternalLaunchContext (never a new orchestration).
    async launchAgent(_input: any, internal: any) {
      launches++;
      assert.equal(internal?.orchestrationBinding?.runId, runId, 're-bind targets the reserved run');
      assert.equal(internal?.orchestrationBinding?.evidenceKind, 'promotion');
      return bindAgent(internal.orchestrationBinding.runId);
    },
    async sendInputConfirmed(_id: string, _t: string) { bodySends++; return { delivered: true, confirmed: true, mode: 'hook' as const }; },
    resubmitEnter() { resubmits++; },
  };
  const witness = () => false;
  const promptFactory = (_req: any) => ({ prompt: 'FULL BODY', marker: `promotion:${requestId}` });
  const launchInputFactory = (_req: any) => ({ workspaceId: wsId, title: 'promote-reru', provider: 'claude', isWorker: true });
  const inspector = new dispatchMod.PromotionDeliveryInspectorImpl(
    deliverer, witness, promptFactory, () => new Date().toISOString(), launchInputFactory,
  );
  assert.equal((await inspector.inspectDelivery(runId)).state, 'reserved-unbound');

  await inspector.resumeDelivery(runId);

  assert.equal(launches, 1, 're-entered the launch/bind exactly once');
  assert.equal(bodySends, 1, 'the full marked body was delivered once after the re-bind');
  assert.equal(resubmits, 0, 'a body send, not a submit-only re-press');
  assert.equal(agentCount(), agentsBefore + 1, 'exactly one worker agent bound (no duplicate)');
  assert.equal(orchestrationCount(), runsBefore, 'NO duplicate orchestration reserved');
  const boundAgent = dbm.getPromotionWorkerMember(runId);
  assert.ok(boundAgent, 'the reserved orchestration now has a bound worker member');
  assert.ok(dbm.hasOrchestrationEvent(runId, 'promotion.agent_bound'), 'Phase 2a agent_bound event persisted');
  assert.ok(dbm.hasOrchestrationEvent(runId, 'promotion.delivered'), 'confirmed turn start → delivered');
  assert.deepEqual(await inspector.inspectDelivery(runId), { state: 'delivered', agentId: boundAgent },
    'the request now inspects as delivered');
});

test('resumeDelivery on a reserved-unbound attempt WITHOUT a launch-input factory is a safe no-op (no launch, request untouched)', async () => {
  const { runId } = reservedRequest('reru0');
  const agentsBefore = agentCount();
  let launches = 0; let bodySends = 0;
  const deliverer = {
    async launchAgent() { launches++; throw new Error('must not launch without a launch-input factory'); },
    async sendInputConfirmed() { bodySends++; return { delivered: true, confirmed: true, mode: 'hook' as const }; },
    resubmitEnter() {},
  };
  const witness = () => false;
  const promptFactory = (_req: any) => ({ prompt: 'FULL BODY', marker: 'promotion:x' });
  // No launchInputFactory (4-arg construction) → reserved-unbound cannot re-bind.
  const inspector = new dispatchMod.PromotionDeliveryInspectorImpl(deliverer, witness, promptFactory);
  await inspector.resumeDelivery(runId);
  assert.equal(launches, 0, 'never launched');
  assert.equal(bodySends, 0, 'never sent a body');
  assert.equal(agentCount(), agentsBefore, 'no agent bound');
  assert.equal(dbm.getPromotionWorkerMember(runId), null, 'still reserved-unbound (untouched)');
  assert.ok(!dbm.hasOrchestrationEvent(runId, 'promotion.delivery_attempt'), 'no attempt recorded');
});

test("markActiveRunsAborted EXCLUDES name='promotion' in SQL — promotion rows survive boot", () => {
  // A live promotion run (reserved/bound-unconfirmed) + a live groupthink run.
  const { runId: promoRun } = reservedRequest('boot');
  const gtId = `gt-${++runSeq}`;
  dbm.insertOrchestration({ ...makePromotionRun(gtId), name: 'groupthink', status: 'running' });
  const orphaned = dbm.markActiveRunsAborted('dashboard_restarted');
  const orphanIds = new Set(orphaned.map((r: any) => r.runId));
  assert.ok(orphanIds.has(gtId), 'the groupthink run was boot-aborted');
  assert.ok(!orphanIds.has(promoRun), 'the promotion run was NOT returned as orphaned');
  assert.equal(dbm.getOrchestrationRun(promoRun).status, 'starting', 'promotion row survives at starting');
  assert.equal(dbm.getOrchestrationRun(gtId).status, 'aborted', 'groupthink row aborted');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-binding-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database');
  dispatchMod = require('../plans/promotion-dispatch');
  dbm.initDatabase();
  wsId = dbm.createWorkspace({ title: 'promotion-binding-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
