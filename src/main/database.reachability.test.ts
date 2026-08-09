// Planning-surface mechanics WP-B2: v1 cutoff, reachability persistence, and
// code-state-bound evidence freshness.
//
//   npm run build:main
//   node dist/main/main/database.reachability.test.js

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
          stmt.bind(params); const rows: Record<string, unknown>[] = [];
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

type DbModule = typeof import('./database');
let dbm: DbModule;
let seq = 0;
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

function context() {
  seq += 1;
  const workspace = dbm.createWorkspace({
    title: `reachability-${seq}`, path: `C:/reachability-${seq}`, pathType: 'windows',
  });
  const plan = dbm.createOrRevivePlan({ workspaceId: workspace.id,
    path: `.lares/plans/reachability-${seq}`, format: 'structured', runState: 'hardening' });
  return { workspaceId: workspace.id, planId: plan.id };
}

function packageInput(ctx: ReturnType<typeof context>, over: Record<string, unknown> = {}) {
  return {
    id: `wp:plan_${seq}:wp-a`, sourceLocalId: 'WP-A', title: 'Reachable package',
    acceptanceCondition: 'entry is reachable', declaredState: 'ready' as const,
    contentHash: `hash-${seq}-a`, sortOrder: 0, schemaVersion: 2 as const,
    paths: [{ path: 'src/main/entry.ts', intentKind: 'edit' }],
    reachability: {
      kind: 'behavior' as const,
      entry_seam_links: [{ seam_kind: 'ipc', path: 'src/main/entry.ts', symbol: 'registerEntry',
        entering_test: 'src/main/entry.test.ts', mutation: 'reachability-mutations/entry.patch',
        verification: { target: 'entry-target', expect_failure: 'REACHABILITY:entry' } }],
      production_constructs: [{ name: 'candidate token', producer_path: 'src/main/token.ts',
        producer_symbol: 'mintToken', consumer_path: 'src/main/entry.ts',
        entering_test: 'src/main/entry.test.ts', mutation: 'reachability-mutations/token.patch',
        verification: { target: 'token-target', expect_failure: 'REACHABILITY:token' } }],
    },
    ...over,
  };
}

function apply(ctx: ReturnType<typeof context>, packages: ReturnType<typeof packageInput>[], over: Record<string, unknown> = {}) {
  return dbm.applyPlanWorkPackageSnapshot({ workspaceId: ctx.workspaceId, planId: ctx.planId,
    sourceRelPath: 'supplements/work-packages.md', projectionHash: `projection-${seq}`,
    packages, reconciledAt: 1000 + seq, ...over });
}

function count(sql: string, params: unknown[] = []): number {
  return Number((dbm.getDb().prepare(sql).get(...params) as { count: number }).count);
}

test('migration snapshots the exact existing v1 population and quarantines revised/new v1', () => {
  const ctx = context();
  const grandfathered = packageInput(ctx, { id: `wp:legacy-${seq}:wp-old`, sourceLocalId: 'WP-OLD',
    schemaVersion: 1, contentHash: `legacy-hash-${seq}`, reachability: undefined });

  // Recreate the pre-WP-B2 migration instant: an already-managed structured-v1
  // row exists before the one-time marker is written.
  dbm.getDb().prepare(`DELETE FROM applied_migrations WHERE name = 'wp_b2_v1_grandfather_snapshot'`).run();
  dbm.upsertPlanWorkPackage({ id: grandfathered.id, workspaceId: ctx.workspaceId,
    planId: ctx.planId, title: grandfathered.title, acceptanceCondition: grandfathered.acceptanceCondition,
    state: 'ready', assigneeAgentId: null, revision: 1, createdAt: 1, updatedAt: 1 });
  dbm.getDb().prepare(`INSERT INTO plan_work_package_sources
    (package_id, workspace_id, plan_id, source_rel_path, source_local_id, source_format,
     applied_hash, observed_hash, applied_order, observed_order, declared_state,
     reconcile_state, present, tombstoned_at, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 'supplements/work-packages.md', ?, 'structured-v1', ?, ?, 0, 0,
            'ready', 'synced', 1, NULL, 1, 1)`).run(
    grandfathered.id, ctx.workspaceId, ctx.planId, grandfathered.sourceLocalId,
    grandfathered.contentHash, grandfathered.contentHash,
  );
  dbm.initDatabase();

  assert.equal(count(`SELECT COUNT(*) AS count FROM plan_wp_legacy_grandfathers
    WHERE package_id = ? AND content_hash = ? AND schema_version = 1`,
  [grandfathered.id, grandfathered.contentHash]), 1);
  assert.equal(apply(ctx, [grandfathered]).status, 'applied');
  assert.equal(dbm.getPlanWorkPackage(grandfathered.id)?.projectionStatus, 'synced');

  const revised = { ...grandfathered, title: 'Revised legacy package',
    contentHash: `${grandfathered.contentHash}-revised` };
  const revisedResult = apply(ctx, [revised], { projectionHash: `revised-${seq}` });
  assert.equal(revisedResult.status, 'legacy-unmigrated');
  assert.deepEqual(revisedResult.quarantinedPackageIds, [grandfathered.id]);
  assert.equal(dbm.getPlanWorkPackage(grandfathered.id)?.projectionStatus, 'legacy-unmigrated');
  assert.equal(dbm.getPlanFolderProjectionState(ctx.planId)?.wpStatus, 'legacy-unmigrated');

  const fresh = context();
  const newV1 = packageInput(fresh, { id: `wp:new-v1-${seq}:wp-new`, sourceLocalId: 'WP-NEW',
    schemaVersion: 1, reachability: undefined });
  assert.equal(apply(fresh, [newV1]).status, 'legacy-unmigrated');
});

test('assignment, execution transition, and dispatch refuse quarantined v1 packages', () => {
  const ctx = context();
  const legacy = packageInput(ctx, { schemaVersion: 1, reachability: undefined });
  apply(ctx, [legacy]);
  assert.throws(() => dbm.assignPlanWorkPackage(legacy.id, 'agent-any', 2), /legacy-unmigrated/);
  assert.throws(() => dbm.transitionPlanWorkPackageState({ eventId: `event-${seq}`,
    packageId: legacy.id, toState: 'executing', actor: 'test', ts: 2 }),
  /package lacks portable plan\/intent identity/);
  assert.throws(() => dbm.insertPlanDispatchAttempt({ id: `dispatch-${seq}`,
    packageId: legacy.id, planId: ctx.planId, executionRunId: `run-${seq}`,
    targetAgentId: null, requestedPlanItemId: legacy.id, createdAt: 3 }), /legacy-unmigrated/);
});

test('snapshot persists normalized obligations atomically with schema and content hash', () => {
  const ctx = context();
  const pkg = packageInput(ctx);
  assert.equal(apply(ctx, [pkg]).status, 'applied');
  const stored = dbm.getPlanWorkPackage(pkg.id)!;
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.contentHash, pkg.contentHash);
  const obligations = dbm.listPlanWpReachabilityObligations(pkg.id);
  assert.deepEqual(obligations.map((row) => [row.obligationKind, row.ordinal,
    row.mutationPath, row.verificationTarget, row.expectFailureId]), [
    ['construct', 0, 'reachability-mutations/token.patch', 'token-target', 'REACHABILITY:token'],
    ['entry-link', 0, 'reachability-mutations/entry.patch', 'entry-target', 'REACHABILITY:entry'],
  ]);
  assert.equal(JSON.parse(obligations[1].declaredJson).symbol, 'registerEntry');

  const failed = context();
  const failedPkg = packageInput(failed);
  assert.throws(() => apply(failed, [failedPkg], {
    afterMutationStage: (stage: string) => { if (stage === 'obligations') throw new Error('fault:obligations'); },
  }), /fault:obligations/);
  assert.equal(dbm.getPlanWorkPackage(failedPkg.id), null);
  assert.equal(dbm.listPlanWpReachabilityObligations(failedPkg.id, failedPkg.contentHash).length, 0);
});

test('evidence writes are atomic and §4.6 rejects candidate-tree and content-hash mismatch', () => {
  const ctx = context();
  const pkg = packageInput(ctx);
  apply(ctx, [pkg]);
  const obligations = dbm.listPlanWpReachabilityObligations(pkg.id);
  const evidence = obligations.map((obligation, index) => ({
    id: `evidence-${seq}-${index}`, obligationId: obligation.id,
    packageContentHash: pkg.contentHash, specimenBaseOid: OID_A,
    specimenTreeOid: OID_B, mutationBlobOid: OID_C,
    baselineResult: '{"exit":0}', mutatedResult: '{"exit":1}',
    failureClassification: 'expected-marker', verdict: 'pass' as const,
    verificationTargetVersion: 'registry-v1', verifiedAt: 2000 + index,
  }));
  dbm.insertPlanWpReachabilityEvidenceBatch(evidence);
  assert.equal(dbm.listPlanWpReachabilityEvidence(obligations[0].id).length, 1);
  assert.equal(dbm.isPlanWpReachabilityObligationCleared({ obligationId: obligations[0].id,
    packageContentHash: pkg.contentHash, candidateTreeOid: OID_B,
    mutationBlobOid: OID_C, verificationTargetVersion: 'registry-v1' }), true);
  assert.equal(dbm.isPlanWpReachabilityObligationCleared({ obligationId: obligations[0].id,
    packageContentHash: pkg.contentHash, candidateTreeOid: OID_A,
    mutationBlobOid: OID_C, verificationTargetVersion: 'registry-v1' }), false);
  assert.equal(dbm.isPlanWpReachabilityObligationCleared({ obligationId: obligations[0].id,
    packageContentHash: 'revised-content-hash', candidateTreeOid: OID_B,
    mutationBlobOid: OID_C, verificationTargetVersion: 'registry-v1' }), false);

  const blobs = Object.fromEntries(obligations.map((obligation) => [obligation.id, OID_C]));
  assert.equal(dbm.getPlanWpReachabilityClearance({ packageId: pkg.id,
    candidateTreeOid: OID_B, verificationTargetVersion: 'registry-v1',
    mutationBlobOidByObligationId: blobs }).cleared, true);
  assert.equal(dbm.getPlanWpReachabilityClearance({ packageId: pkg.id,
    candidateTreeOid: OID_A, verificationTargetVersion: 'registry-v1',
    mutationBlobOidByObligationId: blobs }).cleared, false);

  const before = count(`SELECT COUNT(*) AS count FROM plan_wp_reachability_evidence`);
  assert.throws(() => dbm.insertPlanWpReachabilityEvidenceBatch([
    { ...evidence[0], id: `atomic-valid-${seq}` },
    { ...evidence[1], id: `atomic-invalid-${seq}`, specimenTreeOid: 'short' },
  ]), /full 40-hex git OID/);
  assert.equal(count(`SELECT COUNT(*) AS count FROM plan_wp_reachability_evidence`), before);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'database-reachability-'));
  process.env.APPDATA = tmpAppData;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
    exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  let passed = 0; let failed = 0;
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
