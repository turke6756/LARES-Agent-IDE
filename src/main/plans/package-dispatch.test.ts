// WP-P5-dispatch — durable package send/confirmation/reconciliation.
//
//   npm run build:main
//   node dist/main/main/plans/package-dispatch.test.js

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
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

type WorkPackage = {
  id: string; workspaceId: string; planId: string; title: string;
  acceptanceCondition: string | null;
  state: 'ready' | 'executing' | 'blocked' | 'done' | 'archived';
  assigneeAgentId: string | null;
  revision: number; createdAt: number; updatedAt: number;
};
type DbModule = typeof import('../database');
type ServiceModule = typeof import('./plan-lifecycle');
let dbm: DbModule;
let svc: ServiceModule;
let serial = 0;

function seed(activeRun = true): {
  workspaceId: string; planId: string; packageId: string; agentId: string; runId: string;
} {
  serial += 1;
  const ws = dbm.createWorkspace({ title: `W${serial}`, path: `C:/w${serial}`, pathType: 'windows' });
  const plan = dbm.createOrRevivePlan({
    workspaceId: ws.id, path: `p/${serial}`, format: 'structured',
    runState: activeRun ? 'executing' : 'ready',
  });
  const agent = dbm.createAgent({
    workspaceId: ws.id, title: `worker-${serial}`, roleDescription: '',
    workingDirectory: `C:/w${serial}`, command: 'x', tmuxSessionName: null,
    autoRestartEnabled: false, logPath: `log-${serial}`, isWorker: true,
  });
  const packageId = `pkg-${serial}`;
  dbm.upsertPlanWorkPackage({
    id: packageId, workspaceId: ws.id, planId: plan.id, title: `Package ${serial}`,
    acceptanceCondition: null, state: 'ready', assigneeAgentId: agent.id,
    revision: 1, createdAt: 1000 + serial, updatedAt: 1000 + serial,
  } as WorkPackage);
  const runId = `run-${serial}`;
  if (activeRun) {
    dbm.getDb().prepare(
      `INSERT INTO plan_execution_runs
         (id, plan_id, repository_key, baseline_kind, baseline_head_oid, baseline_ref,
          trigger_source, app_user_id, triggered_at, lifecycle_state)
       VALUES (?, ?, NULL, 'unborn', NULL, NULL, 'renderer-user-action', NULL, ?, 'active')`,
    ).run(runId, plan.id, 1000);
  }
  return { workspaceId: ws.id, planId: plan.id, packageId, agentId: agent.id, runId };
}

function openStampedTurn(
  s: ReturnType<typeof seed>, id: string, startedAt: number,
  intent?: { intentId: string; source: string },
): void {
  dbm.allocateAndInsertTurn(s.workspaceId, {
    id, agentId: s.agentId, planId: s.planId, planItemId: s.packageId,
    planStampSource: 'explicit', startedAt, status: 'open',
    intentId: intent?.intentId ?? null, intentStampSource: intent?.source ?? null,
  });
}

test('schema has the exact dispatch-attempt columns and bounded states', () => {
  const rows = dbm.getDb().prepare('PRAGMA table_info(plan_dispatch_attempts)').all() as Array<{ name: string }>;
  assert.deepEqual(rows.map((r) => r.name), [
    'id', 'package_id', 'plan_id', 'execution_run_id', 'target_agent_id',
    'requested_plan_item_id', 'confirmed_turn_id', 'state', 'created_at',
    'confirmed_at', 'reconciled_at', 'intent_id', 'package_revision',
    'orchestration_id', 'target_session_id',
  ]);
});

test('pending precedes send; open turn confirmation moves ready→executing atomically', async () => {
  const s = seed();
  let sawPendingBeforeSend = false;
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'Implement package',
    createdAt: 2000,
  }, {
    intentPackaging: true,
    deliver: async ({ dispatch }) => {
      const row = dbm.getPlanDispatchAttempt(`attempt-${serial}`);
      sawPendingBeforeSend = row?.state === 'pending'
        && dbm.getPlanWorkPackage(s.packageId)?.state === 'ready';
      const ctx = await import('../git-checkpoints/dispatch-context').then((m) =>
        m.buildDispatchTurnContext({
          getAgent: (id) => id === s.agentId
            ? { workspaceId: s.workspaceId, title: 'worker' } : null,
          resolveCapability: async () => ({
            resolution: { agentShell: { source: null, note: '' }, internal: null },
            repoState: 'repo', commonDir: '/r/.git', commonDirQueueKey: '/r',
            repoRoot: '/r', workspacePrefix: '', protectedRoot: false,
            reason: 'ok', detail: null,
          }),
          planImplementGate: () => ({ isStructured: true, hasActiveExecutionRun: false }),
        }, s.agentId, dispatch));
      assert.deepEqual(ctx?.planStamp, {
        planId: s.planId, planItemId: s.packageId, source: 'explicit',
      }, 'the already-gated internal dispatch retains the explicit item stamp');
      assert.equal(ctx?.intentStamp?.intentId, row?.intentId);
      assert.equal(ctx?.intentStamp?.source, 'task-dispatch');
      openStampedTurn(s, `turn-${serial}`, 2100, ctx?.intentStamp);
      return { disposition: 'confirmed', confirmedTurnId: `turn-${serial}`, confirmedAt: 2100 };
    },
  });
  assert.equal(sawPendingBeforeSend, true);
  assert.equal(result.ok, true);
  assert.equal(result.attempt?.state, 'delivered');
  assert.equal(result.attempt?.confirmedTurnId, `turn-${serial}`);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
  assert.deepEqual(dbm.listPlanWpLifecycleEvents(s.packageId).map((e) => e.toState), ['executing']);
  assert.equal(dbm.getTurnRecord(`turn-${serial}`)?.status, 'open',
    'terminal accepted is not required for executing');
});

test('intent get-or-create is keyed by dispatch attempt while separate briefs mint separately', async () => {
  const s = seed();
  const seen: string[] = [];
  const input = {
    attemptId: `attempt-retry-${serial}`, lifecycleEventId: `event-retry-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: 'supervisor-1',
    promptText: 'Implement\r\nthis package', createdAt: 2150,
  };
  const deliver = async ({ dispatch }: {
    dispatch: import('../git-checkpoints/dispatch-context').DispatchContext;
  }) => {
    const ctx = await import('../git-checkpoints/dispatch-context').then((m) =>
      m.buildDispatchTurnContext({
        getAgent: (id) => id === s.agentId
          ? { workspaceId: s.workspaceId, title: 'worker' } : null,
        resolveCapability: async () => ({
          resolution: { agentShell: { source: null, note: '' }, internal: null },
          repoState: 'repo', commonDir: '/r/.git', commonDirQueueKey: '/r',
          repoRoot: '/r', workspacePrefix: '', protectedRoot: false,
          reason: 'ok', detail: null,
        }),
      }, s.agentId, dispatch));
    assert.ok(ctx?.intentStamp?.intentId);
    seen.push(ctx.intentStamp.intentId);
    return { disposition: 'delivered-unconfirmed' as const };
  };
  await svc.dispatchPlanPackage(input, { intentPackaging: true, deliver });
  await svc.dispatchPlanPackage(input, { intentPackaging: true, deliver });
  await svc.dispatchPlanPackage({
    ...input, attemptId: `attempt-second-${serial}`, promptText: 'A second brief',
  }, { intentPackaging: true, deliver });

  assert.equal(seen[0], seen[1], 'one dispatch retry reuses one intent');
  assert.notEqual(seen[0], seen[2], 'two briefs under one item mint two intents');
  const first = dbm.getSaveIntentByDispatchAttempt(input.attemptId);
  assert.equal(first?.id, seen[0]);
  assert.equal(first?.executionRunId, null, 'WP-1 ships execution_run_id nullable and unused');
  assert.equal(first?.briefDigest?.length, 64);
});

test('failed send marks the attempt failed and leaves the package ready', async () => {
  const s = seed();
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2200,
  }, { deliver: async () => ({ disposition: 'failed', reason: 'runner gone' }) });
  assert.equal(result.failure, 'send-failed');
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'failed');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'ready');
  assert.equal(dbm.listPlanWpLifecycleEvents(s.packageId).length, 0);
});

test('pre-Implement package send is refused before attempt insertion or delivery', async () => {
  const s = seed(false);
  let delivered = false;
  const result = await svc.dispatchPlanPackage({
    attemptId: `attempt-${serial}`, lifecycleEventId: `event-${serial}`,
    packageId: s.packageId, planId: s.planId, planItemId: s.packageId,
    targetAgentId: s.agentId, ownerAgentId: null, promptText: 'go', createdAt: 2300,
  }, { deliver: async () => { delivered = true; return { disposition: 'failed' }; } });
  assert.equal(result.failure, 'structured-plan-not-implemented');
  assert.equal(delivered, false);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`), null);
});

test('confirmed-id reconciliation moves only to executing and marks reconciled', () => {
  const s = seed();
  dbm.insertPlanDispatchAttempt({
    id: `attempt-${serial}`, packageId: s.packageId, planId: s.planId,
    executionRunId: s.runId, targetAgentId: s.agentId,
    requestedPlanItemId: s.packageId, createdAt: 2400,
  });
  openStampedTurn(s, `turn-${serial}`, 2450);
  // Simulate confirmation persisted before a crash prevented the package txn.
  dbm.getDb().prepare(
    `UPDATE plan_dispatch_attempts
        SET state = 'delivered', confirmed_turn_id = ?, confirmed_at = ? WHERE id = ?`,
  ).run(`turn-${serial}`, 2450, `attempt-${serial}`);
  const result = svc.reconcilePackageDispatches(2500);
  assert.deepEqual(result.reconciledAttemptIds, [`attempt-${serial}`]);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'reconciled');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
  assert.notEqual(dbm.getPlanWorkPackage(s.packageId)?.state, 'done');
});

test('fallback resolves one matching stamped turn after created_at', () => {
  const s = seed();
  dbm.insertPlanDispatchAttempt({
    id: `attempt-${serial}`, packageId: s.packageId, planId: s.planId,
    executionRunId: s.runId, targetAgentId: s.agentId,
    requestedPlanItemId: s.packageId, createdAt: 2600,
  });
  openStampedTurn(s, `turn-${serial}`, 2610);
  const result = svc.reconcilePackageDispatches(2700);
  assert.deepEqual(result.reconciledAttemptIds, [`attempt-${serial}`]);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.confirmedTurnId, `turn-${serial}`);
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'executing');
});

test('ambiguous fallback stays pending and surfaces a diagnostic', () => {
  const s = seed();
  dbm.insertPlanDispatchAttempt({
    id: `attempt-${serial}`, packageId: s.packageId, planId: s.planId,
    executionRunId: s.runId, targetAgentId: s.agentId,
    requestedPlanItemId: s.packageId, createdAt: 2800,
  });
  openStampedTurn(s, `turn-${serial}-a`, 2810);
  openStampedTurn(s, `turn-${serial}-b`, 2820);
  const result = svc.reconcilePackageDispatches(2900);
  assert.deepEqual(result.reconciledAttemptIds, []);
  assert.match(result.diagnostics.join('\n'), /2 matching stamped turns.*left pending/);
  assert.equal(dbm.getPlanDispatchAttempt(`attempt-${serial}`)?.state, 'pending');
  assert.equal(dbm.getPlanWorkPackage(s.packageId)?.state, 'ready');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'package-dispatch-'));
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

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
