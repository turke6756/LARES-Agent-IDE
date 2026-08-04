// WP-P2L-proj acceptance — ledger/orchestration/disk-derived intent read model.
//   npm run build:main
//   node dist/main/main/plans/plan-intent-proj.test.js
// Not registered here: the P2LZ stage gate owns scripts/run-main-tests.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrchestrationRun } from '../orchestration/types';

interface TestCase { name: string; run(): void | Promise<void>; }
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

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'p2l-proj-appdata-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2l-proj-ws-'));
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
  const ipc = require('./plan-ipc') as typeof import('./plan-ipc');

  const workspace = db.createWorkspace({ title: 'P2L projection', path: workspaceRoot, pathType: 'windows' });
  const artifactId = 'plan_projection_fixture';
  const folderRelPath = '.lares/plans/projection-fixture';
  const folderAbs = path.join(workspaceRoot, '.lares', 'plans', 'projection-fixture');
  fs.mkdirSync(path.join(folderAbs, 'deliberations'), { recursive: true });
  fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({
    schema_version: 1,
    plan_artifact_id: artifactId,
    confidence: { satisfied: true }, // untrusted/self-asserted: must never affect the readout
  }));

  const marker = (intentId: string, supersedes?: string) => `<!--PLAN-INTENT\n${JSON.stringify({
    intent_id: intentId,
    part: 'hardening',
    kind: 'groupthink-serial',
    targets: [{ provider: 'claude', model: 'test' }],
    reason: 'projection fixture',
    ...(supersedes ? { supersedes_intent_id: supersedes } : {}),
  })}\n-->`;
  const integration = (intentId: string, output: string, changed: string) =>
    `<!--PLAN-INTEGRATION\n${JSON.stringify({
      intent_id: intentId, output_rel_path: output, disposition: 'active', changed,
    })}\n-->`;
  const output = (intentId: string, orchestrationId: string) =>
    `---\nplan_artifact_id: ${artifactId}\nintent_id: ${intentId}\norchestration_id: ${orchestrationId}\nkind: deliberation\n---\n# Result\n`;

  // First generation establishes two historical statuses that disappear/change later.
  fs.writeFileSync(path.join(folderAbs, 'plan.md'), [
    marker('intent_pending'), marker('intent_folded'), marker('intent_old'), marker('intent_withdrawn'),
  ].join('\n'));
  const adopted = db.adoptStructuredPlan({
    workspaceId: workspace.id, artifactId, folderRelPath,
    planPath: `${folderRelPath}/plan.md`, mtimeMs: 1, sizeBytes: 1,
  });
  const scan = () => ledger.scanPlanIntentLedger({
    workspaceId: workspace.id, workspaceRoot, planId: adopted.planId, folderAbs, folderRelPath,
  });
  assert.equal(scan().committed, true);

  fs.writeFileSync(path.join(folderAbs, 'deliberations', 'pending.md'), output('intent_pending', 'run-pending'));
  fs.writeFileSync(path.join(folderAbs, 'deliberations', 'rerun.md'), output('intent_pending', 'run-pending'));
  fs.writeFileSync(path.join(folderAbs, 'deliberations', 'folded.md'), output('intent_folded', 'run-folded'));
  fs.writeFileSync(path.join(folderAbs, 'plan.md'), [
    marker('intent_pending'), marker('intent_folded'), marker('intent_replacement', 'intent_old'),
    integration('intent_pending', 'deliberations/rerun.md', 'rerun adopted in analysis'),
    integration('intent_folded', 'deliberations/folded.md', 'folded into final plan'),
    '[rerun](deliberations/rerun.md)', '[folded](deliberations/folded.md)',
  ].join('\n'));
  assert.equal(scan().committed, true);

  const run = (runId: string, intentId: string): OrchestrationRun => ({
    runId, name: 'groupthink', mode: 'serial', status: 'complete',
    workspaceId: workspace.id, supervisorId: 'supervisor-fixture', topic: 'fixture',
    planPath: path.join(folderAbs, 'plan.md'), planId: adopted.planId,
    planningIntentId: intentId, planBindingMode: 'explicit',
    leadProvider: 'claude', reviewerProvider: 'codex', turnTimeoutMs: 1,
    lastRelayedTs: {}, startedAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:01.000Z',
  });
  db.insertOrchestration(run('run-pending', 'intent_pending'));
  db.insertOrchestration(run('run-folded', 'intent_folded'));

  test('projects independent output history, rung, integration note, and open state', () => {
    const result = ledger.getPlanIntentsProjection(adopted.planId)!;
    const pending = result.intents.find((intent) => intent.intentId === 'intent_pending')!;
    assert.equal(pending.rung, 'returned');
    assert.equal(pending.open, true, 'one unfolded active output keeps the intent open');
    assert.equal(pending.fullyFoldedIn, false);
    assert.equal(pending.integrationNote, 'rerun adopted in analysis');
    assert.deepEqual(pending.outputs.map((item) => ({ path: item.relPath, folded: item.foldedIn })), [
      { path: 'deliberations/pending.md', folded: false },
      { path: 'deliberations/rerun.md', folded: true },
    ], 'a folded rerun does not collapse or hide the pending output');

    const folded = result.intents.find((intent) => intent.intentId === 'intent_folded')!;
    assert.equal(folded.rung, 'folded-in');
    assert.equal(folded.fullyFoldedIn, true);
    assert.equal(folded.open, false);
  });

  test('surfaces withdrawn/superseded history and derives confidence', () => {
    const result = ledger.getPlanIntentsProjection(adopted.planId)!;
    const withdrawn = result.intents.find((intent) => intent.intentId === 'intent_withdrawn')!;
    const superseded = result.intents.find((intent) => intent.intentId === 'intent_old')!;
    assert.deepEqual({ status: withdrawn.status, flag: withdrawn.withdrawn }, { status: 'withdrawn', flag: true });
    assert.deepEqual({ status: superseded.status, flag: superseded.superseded }, { status: 'superseded', flag: true });
    assert.deepEqual(result.confidence, {
      markedIntents: 3,
      satisfiedIntents: 1,
      openIntents: 2,
      deliberationsRun: 2,
      finalPlanExists: true,
    });
  });

  test('ignores self-asserted confidence/run state and observes final-plan disk truth', () => {
    const before = ledger.getPlanIntentsProjection(adopted.planId)!;
    db.getDb().prepare(`UPDATE plans SET run_state = 'self-asserted-complete' WHERE id = ?`).run(adopted.planId);
    const asserted = ledger.getPlanIntentsProjection(adopted.planId)!;
    assert.deepEqual(asserted.confidence, before.confidence, 'self-asserted DB state changes nothing');
    fs.rmSync(path.join(folderAbs, 'plan.md'));
    const absent = ledger.getPlanIntentsProjection(adopted.planId)!;
    assert.equal(absent.confidence.finalPlanExists, false);
    assert.deepEqual(absent.intents, before.intents, 'disk absence does not rewrite ledger history');
  });

  test('IPC validates input and exposes the injectable derived projection seam', () => {
    const expected = ledger.getPlanIntentsProjection(adopted.planId);
    let observed = '';
    const deps: import('./plan-ipc').PlanIntentsIpcDeps = {
      getProjection(planId) { observed = planId; return expected; },
    };
    assert.equal(ipc.runPlanIntentsList('', deps), null);
    assert.equal(observed, '');
    assert.equal(ipc.runPlanIntentsList(adopted.planId, deps), expected);
    assert.equal(observed, adopted.planId);

    let channel = '';
    let handler: ((event: unknown, ...args: unknown[]) => unknown) | null = null;
    ipc.registerPlanIntentsIpc({ handle(name, listener) { channel = name; handler = listener; } }, deps);
    assert.equal(channel, 'plan:intents:list');
    assert.equal(handler!(null, adopted.planId), expected);
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
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
