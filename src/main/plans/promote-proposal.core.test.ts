// WP-P3B-core acceptance — the live-process front half of promotion.
//
// Proves (mapping to the spec's Accept list): claim-scan precedes identity and a
// manual folder's existing identity is retained (not overwritten with the
// deterministic one); concurrent promote → ONE promotion_requests row (loser
// reads the winner's); Phase 1 binds orchestration_id BEFORE any launchAgent
// call; the latch is held until the request is terminal (adopted/failed), not on
// folder adoption; adoption/enrichment keys on plan_artifact_id (NOT private
// dispatch metadata, ruling 25); no HTML / no execution worker / no document
// list, and promotionRequestId rides the dispatch bootstrap; failed → pending
// retry is atomic + bind-before-deliver; a pending+bound (possibly-delivered)
// attempt is NOT redriven.
//
//   npm run build:main
//   node dist/main/main/plans/promote-proposal.core.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.test.ts precedent) ───────

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

// ── module under test (loaded after cache injection) ─────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
let dbm: any;
let promote: any;
let dispatchMod: any;
let wsId = '';

const PLANS_HOME = '.lares/plans';

function seedProposal(artifactHex: string): { proposalId: string; artifactId: string; relPath: string; workspaceId: string } {
  return {
    proposalId: `prop-row-${artifactHex}`,
    artifactId: `prop_${artifactHex}`,
    relPath: `.lares/proposals/2026-08-03-feature-${artifactHex}.md`,
    workspaceId: wsId,
  };
}

/** A deliverer whose launchAgent + sendInputConfirmed are recorded. */
function makeFakeDeliverer(opts: { confirmed?: boolean; onLaunch?: (runId: string) => void } = {}) {
  const calls = { launch: [] as any[], send: [] as any[] };
  let seq = 0;
  const deliverer = {
    async launchAgent(input: any, internal: any) {
      calls.launch.push({ input, internal });
      opts.onLaunch?.(internal.orchestrationBinding.runId);
      // Emulate Phase 2a: bind the worker agent atomically (as the real
      // launchAgent does via bindPromotionAgentAtomic).
      return dbm.bindPromotionAgentAtomic(
        {
          workspaceId: input.workspaceId, title: input.title, roleDescription: '',
          workingDirectory: 'C:\\tmp\\ws', command: 'claude', provider: 'claude',
          isWorker: true, tmuxSessionName: null, autoRestartEnabled: false,
          logPath: `C:\\tmp\\agent-${++seq}.log`,
        },
        { runId: internal.orchestrationBinding.runId, ts: new Date().toISOString() },
      );
    },
    async sendInputConfirmed(agentId: string, text: string) {
      calls.send.push({ agentId, text });
      return { delivered: true, confirmed: opts.confirmed ?? true, mode: 'hook' as const };
    },
  };
  return { deliverer, calls };
}

function baseDeps(over: Partial<any> = {}): any {
  const { deliverer } = makeFakeDeliverer();
  return {
    resolveProposal: (_id: string) => over.__proposal ?? null,
    scanClaims: () => ({ kind: 'none' as const }),
    deliverer,
    enrichAdoptedPlan: async ({ planId }: any) => ({ planId }),
    plansHomeRelPath: PLANS_HOME,
    ...over,
  };
}

// ── cases ────────────────────────────────────────────────────────────────────

test('claim-scan precedes identity: a manual folder\'s existing identity is retained, not overwritten', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('aaa1');
  const MANUAL_ID = 'plan_manualXYZ';
  const MANUAL_FOLDER = '.lares/plans/2020-01-01-hand-made-manualXY';
  const deps = baseDeps({
    __proposal: proposal,
    resolveProposal: () => proposal,
    scanClaims: () => ({ kind: 'claimed', planArtifactId: MANUAL_ID, folderRelPath: MANUAL_FOLDER }),
    // Never dispatched in this case (no adopted row → pending path would dispatch),
    // so stub dispatch to a no-op that must NOT change identity.
    dispatch: async () => ({ runId: 'run-x', agentId: 'agent-x', delivered: false }),
  });
  const res = await promote.promoteProposal({ proposalId: proposal.proposalId, supervisorId: 'sup-1' }, deps);
  assert.equal(res.status, 'promotion-pending');
  assert.equal(res.planArtifactId, MANUAL_ID, 'retains the manual folder identity');

  const row = dbm.getPromotionRequestByProposal(wsId, proposal.artifactId);
  assert.equal(row.planArtifactId, MANUAL_ID, 'request row persisted the retained identity');
  assert.equal(row.targetFolderRelPath, MANUAL_FOLDER, 'request row persisted the retained folder');
  assert.notEqual(row.planArtifactId, promote.derivePlanArtifactId(proposal.artifactId),
    'the deterministic identity must NOT have replaced the manual one');
});

test('a foreign-claimed folder is rejected; duplicates block enrichment', async () => {
  promote._resetPromotionLatchesForTests();
  const p1 = seedProposal('foreign1');
  const foreign = await promote.promoteProposal(
    { proposalId: p1.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => p1, scanClaims: () => ({ kind: 'foreign', folderRelPath: '.lares/plans/x', diagnostic: 'claimed by prop_other' }) }),
  );
  assert.equal(foreign.status, 'rejected-foreign');

  const p2 = seedProposal('dup1');
  const dup = await promote.promoteProposal(
    { proposalId: p2.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => p2, scanClaims: () => ({ kind: 'duplicate', folderRelPaths: ['a', 'b'], diagnostic: '2 claimants' }) }),
  );
  assert.equal(dup.status, 'duplicate-blocked');

  // Neither rejection minted a promotion_requests row.
  assert.equal(dbm.getPromotionRequestByProposal(wsId, p1.artifactId), null);
  assert.equal(dbm.getPromotionRequestByProposal(wsId, p2.artifactId), null);
});

test('concurrent promote → ONE promotion_requests row (loser reads the winner)', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('conc1');
  const mk = () => promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => proposal, dispatch: async () => ({ runId: 'r', agentId: 'a', delivered: false }) }),
  );
  const [r1, r2] = await Promise.all([mk(), mk()]);
  assert.equal(r1.requestId, r2.requestId, 'both promotes converge on one request id');
  // Exactly one row for the proposal.
  const all = dbm.getDb().prepare('SELECT COUNT(*) AS n FROM promotion_requests WHERE workspace_id = ? AND proposal_artifact_id = ?')
    .get(wsId, proposal.artifactId);
  assert.equal(all.n, 1, 'the UNIQUE constraint kept it to one row');
});

test('Phase 1 binds orchestration_id BEFORE any launchAgent call', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('phase1');
  let boundAtLaunch: string | null = null;
  const { deliverer } = makeFakeDeliverer({
    onLaunch: () => {
      // At the moment launchAgent is invoked, the request must already carry a
      // bound orchestration_id (Phase 1 committed before delivery).
      const row = dbm.getPromotionRequestByProposal(wsId, proposal.artifactId);
      boundAtLaunch = row.orchestrationId;
    },
  });
  const res = await promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => proposal, deliverer }),  // real dispatchPromotion
  );
  assert.equal(res.status, 'promotion-pending');
  assert.ok(boundAtLaunch, 'orchestration_id was already bound when launchAgent was called');
  assert.equal(boundAtLaunch, res.runId, 'the bound id is the reserved run');
});

test('the dispatch bootstrap carries promotionRequestId + marker, and NO document list / no HTML', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('boot1');
  let capturedPrompt = '';
  const res = await promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({
      resolveProposal: () => proposal,
      dispatch: async (input: any) => { capturedPrompt = input.prompt; return { runId: 'r', agentId: 'a', delivered: false }; },
    }),
  );
  assert.equal(res.status, 'promotion-pending');
  assert.ok(capturedPrompt.includes(`promotionRequestId: ${res.requestId}`), 'promotionRequestId in bootstrap');
  assert.ok(capturedPrompt.includes(`promotion:${res.requestId}`), 'stable marker in bootstrap');
  assert.ok(!/<[a-z]+[\s>]/i.test(capturedPrompt), 'no HTML tags in the bootstrap');
  // §P3-GAP: the forbidden selection field must never appear, and the folder is
  // affirmed as the document set (no promote-time document list).
  assert.ok(!/selectedDocRelPaths/i.test(capturedPrompt), 'no selectedDocRelPaths (§P3-GAP)');
  assert.ok(/IS\s+the\s+document\s+set/i.test(capturedPrompt), 'affirms the folder is the document set');
});

test('latch is held until the request is terminal (adopted), not on folder adoption; keys on plan_artifact_id', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('latch1');
  // First promote: no folder → dispatch → pending → latch held.
  const r1 = await promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => proposal }),
  );
  assert.equal(r1.status, 'promotion-pending');
  assert.ok(promote.isPromotionLatched(wsId, proposal.artifactId), 'latch held while pending');

  // Simulate the watcher adopting the folder (a plans row for the deterministic
  // plan_artifact_id) — but enrichment has NOT completed. Latch must STAY held.
  const planArtifactId = promote.derivePlanArtifactId(proposal.artifactId);
  const sku = promote.derivePlanSku(proposal.relPath, planArtifactId);
  const folderRel = `${PLANS_HOME}/${sku}`;
  const adopt = dbm.adoptStructuredPlan({
    workspaceId: wsId, artifactId: planArtifactId, folderRelPath: folderRel,
    planPath: `${folderRel}/plan.md`, mtimeMs: 1, sizeBytes: 10,
  });
  const seededPlanId = adopt.planId;
  assert.ok(promote.isPromotionLatched(wsId, proposal.artifactId), 'folder adoption alone does NOT release the latch');

  // Second promote: adopted plans row present → enrich (keyed on plan_artifact_id)
  // → adopted → latch released.
  let enrichPlanId: string | null = null;
  const r2 = await promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({
      resolveProposal: () => proposal,
      enrichAdoptedPlan: async ({ planId }: any) => { enrichPlanId = planId; return { planId }; },
    }),
  );
  assert.equal(r2.status, 'adopted');
  assert.equal(r2.planId, seededPlanId, 'returned plan is the adopted row');
  assert.equal(enrichPlanId, seededPlanId, 'enrichment keyed on the plans row for plan_artifact_id (ruling 25)');
  assert.ok(!promote.isPromotionLatched(wsId, proposal.artifactId), 'latch released only on request-terminal (adopted)');
});

test('a pending + already-bound attempt is NOT redriven (no second worker)', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('nodrive1');
  // First promote dispatches and binds an orchestration.
  await promote.promoteProposal({ proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => proposal }));
  const row = dbm.getPromotionRequestByProposal(wsId, proposal.artifactId);
  assert.ok(row.orchestrationId, 'first promote bound an orchestration');

  // Second promote: pending + bound → must return the existing operation WITHOUT
  // calling dispatch again.
  let dispatched = false;
  const r2 = await promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({ resolveProposal: () => proposal, dispatch: async () => { dispatched = true; return { runId: 'x', agentId: 'y', delivered: false }; } }),
  );
  assert.equal(r2.status, 'promotion-pending');
  assert.equal(r2.runId, row.orchestrationId, 'returns the existing bound run');
  assert.equal(dispatched, false, 'a possibly-delivered attempt is never redriven');
});

test('failed → pending retry is atomic, increments attempt_count, and binds a NEW attempt before delivery', async () => {
  promote._resetPromotionLatchesForTests();
  const proposal = seedProposal('retry1');
  // Seed a request whose first attempt failed terminally.
  const { row: req } = dbm.insertOrReadPromotionRequest({
    id: 'promreq_retry1', workspaceId: wsId, proposalId: proposal.proposalId,
    proposalArtifactId: proposal.artifactId, planArtifactId: promote.derivePlanArtifactId(proposal.artifactId),
    targetFolderRelPath: `${PLANS_HOME}/x`, supervisorId: 'sup-1',
  });
  // Give it a prior reserved attempt, then mark failed.
  dbm.reservePromotionOrchestration({
    requestId: req.id,
    run: {
      runId: 'run-old', name: 'promotion', mode: 'serial', status: 'starting',
      workspaceId: wsId, supervisorId: 'sup-1', topic: 't', planPath: 'p',
      leadProvider: 'claude', reviewerProvider: 'claude', turnTimeoutMs: 1, lastRelayedTs: {},
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), planBindingMode: 'agent-default',
    },
    ts: new Date().toISOString(), incrementAttempt: false,
  });
  dbm.recordPromotionFailed({ requestId: req.id, runId: 'run-old', ts: new Date().toISOString(), reason: 'boom' });
  const failed = dbm.getPromotionRequestById(req.id);
  assert.equal(failed.state, 'failed');
  const attemptsBefore = failed.attemptCount;

  let retryFlag: boolean | null = null;
  let boundBeforeSend = false;
  const { deliverer } = makeFakeDeliverer({
    onLaunch: () => {
      const r = dbm.getPromotionRequestById(req.id);
      boundBeforeSend = !!r.orchestrationId && r.orchestrationId !== 'run-old';
    },
  });
  const res = await promote.promoteProposal(
    { proposalId: proposal.proposalId, supervisorId: 'sup-1' },
    baseDeps({
      resolveProposal: () => proposal,
      deliverer,
      dispatch: async (input: any) => {
        retryFlag = input.retry;
        return dispatchMod.dispatchPromotion(input);
      },
    }),
  );
  assert.equal(res.status, 'promotion-pending');
  assert.equal(retryFlag, true, 'dispatch invoked with retry=true');
  const after = dbm.getPromotionRequestById(req.id);
  assert.equal(after.state, 'pending', 'retry moved failed → pending');
  assert.equal(after.attemptCount, attemptsBefore + 1, 'attempt_count incremented');
  assert.equal(after.failureReason, null, 'failure_reason cleared');
  assert.notEqual(after.orchestrationId, 'run-old', 'a NEW attempt orchestration replaced the old');
  assert.ok(boundBeforeSend, 'the new attempt was bound before delivery');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-core-'));
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
  dispatchMod = require('./promotion-dispatch');
  dbm.initDatabase();
  wsId = dbm.createWorkspace({ title: 'promote-core-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
