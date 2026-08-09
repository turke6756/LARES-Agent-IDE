// WP-P2L-runs — server-witnessed planning intent/orchestration correlation.
//   npm run build:main
//   node dist/main/main/plans/plan-intent-runs.test.js
// Not registered here: the P2L stage gate owns scripts/run-main-tests.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedPlanStamp } from '../../shared/commit-candidates';
import type { DashboardClient, OrchestrationRunner } from '../orchestration/types';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _ResolvedPlanStampStayedUnchanged = Assert<Equal<ResolvedPlanStamp, {
  planId: string | null;
  planItemId: string | null;
  source: 'explicit' | 'agent-default' | 'fork-carry' | 'revive-carry'
    | 'continuation-carry' | 'explicit-none' | 'unbound-manual';
}>>;

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

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
  private db = new sqlJsCtor();
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
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
  close(): void {}
}

function makeClient(): DashboardClient {
  return {
    launchAgent: async () => ({ id: 'unused' } as never),
    getAgent: () => null,
    getMessages: async () => [],
    recoverChatBinding: () => {},
    sendInput: async () => {},
    sendInputConfirmed: async () => ({ delivered: true, confirmed: true, mode: 'hook' }),
    resubmitEnter: () => {},
    isInputInFlight: () => false,
    stopAgent: async () => {},
  };
}

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'p2l-runs-appdata-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2l-runs-ws-'));
  process.env.APPDATA = appData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const sqlitePath = require.resolve('better-sqlite3');
  require.cache[sqlitePath] = {
    id: sqlitePath, filename: sqlitePath, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as typeof import('../database');
  db.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ledger = require('./plan-intent-ledger') as typeof import('./plan-intent-ledger');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OrchestrationService } = require('../orchestration/service') as typeof import('../orchestration/service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getOrchestrationDispatch } = require('../orchestration/groupthink-v2') as typeof import('../orchestration/groupthink-v2');

  const workspace = db.createWorkspace({ title: 'P2L runs', path: workspaceRoot, pathType: 'windows' });
  let fixtureSeq = 0;
  function planFixture(intentId: string) {
    const seq = ++fixtureSeq;
    const artifactHex = seq.toString(16).padStart(8, '0');
    const artifactId = `plan_${artifactHex}`;
    const folderRelPath = `.lares/plans/p2l-runs-${seq}`;
    const folderAbs = path.join(workspaceRoot, '.lares', 'plans', `p2l-runs-${seq}`);
    fs.mkdirSync(folderAbs, { recursive: true });
    fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({
      schema_version: 1, plan_artifact_id: artifactId, plan_sku: `p2l-runs-${seq}`,
      source_proposal: { artifact_id: `prop_${artifactHex}`, rel_path: `.lares/proposals/${seq}.md` },
    }));
    const marker = `<!--PLAN-INTENT\n${JSON.stringify({
      intent_id: intentId, part: 'hardening', kind: 'groupthink-serial',
      targets: [{ provider: 'claude', model: 'test' }], reason: 'fixture',
    })}\n-->`;
    fs.writeFileSync(path.join(folderAbs, 'plan.md'), marker);
    const plan = db.adoptStructuredPlan({
      workspaceId: workspace.id, artifactId, folderRelPath,
      planPath: `${folderRelPath}/plan.md`, mtimeMs: 1, sizeBytes: Buffer.byteLength(marker),
    });
    const scan = () => ledger.scanPlanIntentLedger({
      workspaceId: workspace.id, workspaceRoot, planId: plan.planId,
      folderAbs, folderRelPath,
    });
    scan();
    return { intentId, artifactId, folderAbs, folderRelPath, planId: plan.planId, scan };
  }

  const neverFinishes: OrchestrationRunner = async () => { await new Promise<void>(() => {}); };
  const service = new OrchestrationService(
    makeClient(), async () => ({ ok: true }),
    { serial: neverFinishes, parallel: neverFinishes },
  );

  test('launch validates same-plan active intent, stamps the row, and projects RUNNING', () => {
    const fixture = planFixture('int_11111111');
    const started = service.start_run({
      name: 'groupthink', workspaceId: workspace.id, supervisorId: 'supervisor-fixture',
      mode: 'serial', planId: fixture.planId, planningIntentId: fixture.intentId,
    });
    const run = db.getOrchestrationRun(started.runId)!;
    assert.equal(run.planningIntentId, fixture.intentId);
    assert.equal(run.planId, fixture.planId);
    assert.equal(run.status, 'running');

    const intent = ledger.getPlanIntentLedgerProjection(fixture.planId)[0];
    assert.equal(intent.ran, true);
    assert.deepEqual(intent.runs.map((item) => ({ id: item.orchestrationId, state: item.state })), [
      { id: started.runId, state: 'running' },
    ]);

    const indexPlan = db.getDb().prepare(
      `EXPLAIN QUERY PLAN SELECT pi.intent_id FROM plan_intents pi
       JOIN orchestrations o ON o.plan_id = pi.plan_id AND o.planning_intent_id = pi.intent_id
       WHERE pi.plan_id = ?`,
    ).all(fixture.planId) as Array<{ detail: string }>;
    assert.ok(indexPlan.some((row) => row.detail.includes('idx_orchestrations_plan_intent')),
      'composite ran join uses idx_orchestrations_plan_intent');
  });

  test('inactive and foreign intents are rejected before an orchestration row exists', () => {
    const inactive = planFixture('int_22222222');
    db.getDb().prepare(`UPDATE plan_intents SET status = 'withdrawn' WHERE plan_id = ? AND intent_id = ?`)
      .run(inactive.planId, inactive.intentId);
    const foreign = planFixture('int_33333333');
    const target = planFixture('int_44444444');
    const before = db.listOrchestrationRuns().length;
    assert.throws(() => service.start_run({
      name: 'groupthink', workspaceId: workspace.id, supervisorId: 'supervisor-fixture',
      planId: inactive.planId, planningIntentId: inactive.intentId,
    }), /not active in the requested plan/);
    assert.throws(() => service.start_run({
      name: 'groupthink', workspaceId: workspace.id, supervisorId: 'supervisor-fixture',
      planId: target.planId, planningIntentId: foreign.intentId,
    }), /not active in the requested plan/);
    assert.equal(db.listOrchestrationRuns().length, before, 'rejection creates no run row');
  });

  test('follow-ups retain the frozen association and ResolvedPlanStamp stays intent-free', () => {
    const running = db.listOrchestrationRuns().find((run) => run.planningIntentId === 'int_11111111')!;
    const first = getOrchestrationDispatch(running);
    const second = getOrchestrationDispatch(running);
    assert.equal(first, second, 'follow-up dispatches reuse the run-frozen context');
    assert.ok(!('planningIntentId' in first), 'intent binding is not added to DispatchContext');
    running.updatedAt = new Date().toISOString();
    db.updateOrchestration(running);
    assert.equal(db.getOrchestrationRun(running.runId)!.planningIntentId, 'int_11111111');
    db.updateOrchestration({ ...running, planningIntentId: null });
    assert.equal(db.getOrchestrationRun(running.runId)!.planningIntentId, 'int_11111111',
      'generic follow-up persistence cannot clear the frozen association');
    db.updateOrchestration({ ...running, planningIntentId: 'int_66666666' });
    assert.equal(db.getOrchestrationRun(running.runId)!.planningIntentId, 'int_11111111',
      'generic follow-up persistence cannot replace the frozen association');
  });

  test('returned state uses current output presence; legacy unstamped runs degrade disk-only', () => {
    const running = db.listOrchestrationRuns().find((run) => run.planningIntentId === 'int_11111111')!;
    const runningPlan = db.getPlan(running.planId!)!;
    const runningFolder = path.join(workspaceRoot, path.dirname(runningPlan.path));
    const outputRel = 'deliberations/result.md';
    fs.mkdirSync(path.join(runningFolder, 'deliberations'), { recursive: true });
    fs.writeFileSync(path.join(runningFolder, outputRel),
      `---\nplan_artifact_id: plan_00000001\nintent_id: int_11111111\norchestration_id: ${running.runId}\nkind: deliberation\n---\n# Result\n`);
    ledger.scanPlanIntentLedger({
      workspaceId: workspace.id, workspaceRoot, planId: running.planId!,
      folderAbs: runningFolder, folderRelPath: path.dirname(runningPlan.path).replace(/\\/g, '/'),
    });
    let intent = ledger.getPlanIntentLedgerProjection(running.planId!)[0];
    assert.equal(intent.runs[0].state, 'returned');
    assert.equal(intent.runs[0].returnedOutputExists, true);

    const legacy = planFixture('int_55555555');
    fs.mkdirSync(path.join(legacy.folderAbs, 'research'), { recursive: true });
    fs.writeFileSync(path.join(legacy.folderAbs, 'research', 'legacy.md'),
      `---\nplan_artifact_id: ${legacy.artifactId}\nintent_id: ${legacy.intentId}\norchestration_id: old-unstamped-run\nkind: research\n---\n# Legacy result\n`);
    intent = legacy.scan().intents[0];
    assert.equal(intent.returned, true, 'disk output still supplies the returned rung');
    assert.equal(intent.ran, false, 'self-declared orchestration id cannot manufacture ran');
    assert.deepEqual(intent.runs, []);
  });

  let passed = 0;
  let failed = 0;
  for (const fixture of tests) {
    try { await fixture.run(); console.log(`  ok  ${fixture.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${fixture.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  try { db.closeDatabase(); } catch { /* best effort */ }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
