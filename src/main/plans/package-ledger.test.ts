// WP-D2 focused service suite.
//   npm run build:main
//   node dist/main/main/plans/package-ledger.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanWorkPackageState } from '../database';
import type { PlanPackageCommand } from './package-ledger';

interface TestCase { name: string; run(): void | Promise<void>; }
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
  pragma(_sql: string): undefined { return undefined; }
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
          while (stmt.step()) rows.push(stmt.getAsObject()); return rows;
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

type DbModule = typeof import('../database');
type ServiceModule = typeof import('./package-ledger');
let dbm: DbModule;
let service: ServiceModule;
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);
const WS = 'ws-ledger-service';
const PLAN = 'plan-ledger-service';
const ARTIFACT = 'plan_ce97b9ad';
const INTENT = 'int_d1d47a05';

function raw(sql: string, ...params: unknown[]): any {
  return dbm.getDb().prepare(sql).get(...params);
}

function seedPackage(id: string, state: PlanWorkPackageState = 'executing', revision = 1): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId: WS, planId: PLAN, intentId: INTENT,
    schemaVersion: 2, contentHash: `hash-${id}`, projectionStatus: 'synced',
    title: id, acceptanceCondition: 'witnessed', state, assigneeAgentId: 'agent-1',
    revision, createdAt: 10, updatedAt: 10,
  });
}

function identity(type: PlanPackageCommand['type'], packageId: string, key: string): any {
  return {
    type, idempotencyKey: key, workspaceId: WS, planId: PLAN,
    planArtifactId: ARTIFACT, intentId: INTENT, packageId, packageRevision: 1,
  };
}

function operator(at = 100) { return { kind: 'operator' as const, actor: 'supervisor', observedAt: at }; }
function completion(at = 200) { return { kind: 'completion' as const, actor: 'executor', observedAt: at }; }

let nextTurnSeq = 1;
function seedTurn(id: string, packageId: string, status = 'completed'): void {
  dbm.getDb().prepare(
    `INSERT INTO turn_records
       (id, workspace_id, turn_seq, agent_id, session_id, started_at, ended_at,
        status, plan_id, plan_item_id, plan_stamp_source, intent_id)
     VALUES (?, ?, ?, 'agent-1', 'session-1', 20, 30, ?, ?, ?, 'explicit', ?)`,
  ).run(id, WS, nextTurnSeq++, status, PLAN, packageId, INTENT);
}

function seedDispatch(packageId: string, id = `dispatch-${packageId}`, state = 'delivered'): void {
  dbm.getDb().prepare(
    `INSERT INTO plan_dispatch_attempts
       (id, package_id, plan_id, execution_run_id, target_agent_id,
        requested_plan_item_id, confirmed_turn_id, state, created_at, confirmed_at,
        package_revision, intent_id, target_session_id)
     VALUES (?, ?, ?, 'run-1', 'agent-1', ?, ?, ?, 10, 20, 1, ?, 'session-1')`,
  ).run(id, packageId, PLAN, packageId, `turn-${packageId}`, state, INTENT);
}

function recordCommit(packageId: string, oid = OID_A, key = `commits-${packageId}`): void {
  seedTurn(`turn-${packageId}`, packageId);
  service.transitionPlanPackage(identity('commits-observed', packageId, key), {
    kind: 'git', actor: 'git-observer', observedAt: 40, turnId: `turn-${packageId}`,
    commits: [{ repositoryKey: 'repo', commitOid: oid, parentOid: null,
      observedAt: 40, source: 'lares', pushedRemoteCount: 0, lastReconciledAt: 40 }],
  });
}

function passGate(packageId: string, gateKey: string, oid: string | null, key: string, evidence?: unknown): void {
  service.transitionPlanPackage({
    ...identity('gate-decided', packageId, key), gateKey, gateRevision: 1, attemptNo: 1,
  }, {
    kind: 'gate', actor: 'gate-runner', observedAt: 50, outcome: 'passed', evidence,
    verifiedCommits: oid ? [{ repositoryKey: 'repo', commitOid: oid }] : [],
  });
}

function seedFinalization(packageId: string, id = `fin-${packageId}`, lifecycleStatus: 'active' | 'committed' = 'active'): void {
  dbm.insertPackageFinalization({
    id, packageId, repositoryKey: 'repo', finalizationKind: 'plan-package',
    planId: PLAN, planItemId: packageId, packageRevision: 1, finalizedAt: 60,
    finalizedBy: 'finalizer', checkpointTurnId: null, checkpointOid: OID_A,
    boundaryRef: 'refs/lares/test', boundaryStatus: 'ready', lifecycleStatus,
    supersededByFinalizationId: null, releasedAt: lifecycleStatus === 'committed' ? 60 : null,
    memberManifestJson: '[]', contractVersion: 1, failureReason: null,
    createdFromWorkspaceId: WS,
  });
}

test('closed command union covers the nine supported command names', () => {
  const names: PlanPackageCommand['type'][] = [
    'dispatch-confirmed', 'block', 'unblock', 'gate-decided', 'commits-observed',
    'deployment-observed', 'complete', 'reopen', 'archive',
  ];
  assert.equal(new Set(names).size, 9);
});

test('identity and legal-edge failures roll back without lifecycle evidence', () => {
  seedPackage('pkg-edge', 'ready');
  assert.throws(() => service.transitionPlanPackage({
    ...identity('block', 'pkg-edge', 'bad-edge'), reason: 'no',
  }, operator()), /illegal block edge/);
  assert.throws(() => service.transitionPlanPackage({
    ...identity('archive', 'pkg-edge', 'bad-identity'), planArtifactId: 'plan_wrong', reason: 'no',
  }, operator()), /artifact identity/);
  assert.equal(dbm.listPlanWpLifecycleEvents('pkg-edge').length, 0);
});

test('dispatch-confirmed validates the matching turn and writes exactly one state event', () => {
  seedPackage('pkg-dispatch', 'ready');
  seedTurn('turn-dispatch', 'pkg-dispatch');
  seedDispatch('pkg-dispatch', 'dispatch-confirm', 'pending');
  const result = service.transitionPlanPackage({
    ...identity('dispatch-confirmed', 'pkg-dispatch', 'dispatch-key'),
    dispatchAttemptId: 'dispatch-confirm',
  }, { kind: 'dispatch', actor: 'delivery', observedAt: 70, confirmedTurnId: 'turn-dispatch' });
  assert.equal(result.stateAfter, 'executing');
  assert.equal(dbm.listPlanWpLifecycleEvents('pkg-dispatch').length, 1);
  assert.equal(dbm.getPlanDispatchAttempt('dispatch-confirm')?.confirmedTurnId, 'turn-dispatch');
});

test('failed gate blocks; passed retry preserves the failed row and is idempotent', () => {
  seedPackage('pkg-retry');
  const failed = {
    ...identity('gate-decided', 'pkg-retry', 'gate-fail'),
    gateKey: 'acceptance', gateRevision: 1, attemptNo: 1,
  } as const;
  const failedWitness = { kind: 'gate' as const, actor: 'gate', observedAt: 80, outcome: 'failed' as const };
  const first = service.transitionPlanPackage(failed, failedWitness);
  const replay = service.transitionPlanPackage(failed, { ...failedWitness, observedAt: 999 });
  assert.equal(first.stateAfter, 'blocked');
  assert.equal(replay.replayed, true);
  service.transitionPlanPackage({
    ...identity('gate-decided', 'pkg-retry', 'gate-pass'),
    gateKey: 'acceptance', gateRevision: 1, attemptNo: 2,
  }, { kind: 'gate', actor: 'gate', observedAt: 90, outcome: 'passed' });
  assert.deepEqual(dbm.listPlanPackageGateAttempts('pkg-retry', 1).map((row) => row.outcome), ['failed', 'passed']);
  assert.equal(dbm.getPlanWorkPackage('pkg-retry')?.state, 'blocked');
  assert.throws(() => service.transitionPlanPackage({ ...failed, gateKey: 'other' }, failedWitness), /conflicting idempotency/);
});

test('code completion refuses missing evidence, then requires gate-covered commit, boundary, deployment, and freshness', () => {
  seedPackage('pkg-code');
  const declaration = {
    kind: 'code' as const, requiredGateKeys: ['production-entry'],
    implementationCommits: [{ repositoryKey: 'repo', commitOid: OID_A }],
    boundary: 'ready' as const, deploymentEnvironments: ['production'], behavior: true,
  };
  const command = { ...identity('complete', 'pkg-code', 'complete-code'), declaration };
  assert.throws(() => service.transitionPlanPackage(command, completion()), /required gate/);
  recordCommit('pkg-code');
  passGate('pkg-code', 'production-entry', OID_A, 'gate-code');
  seedDispatch('pkg-code');
  seedFinalization('pkg-code');
  service.transitionPlanPackage(identity('deployment-observed', 'pkg-code', 'deploy-code'), {
    kind: 'deployment', actor: 'deployer', observedAt: 70, environment: 'production',
    state: 'deployed', repositoryKey: 'repo', commitOid: OID_A,
  });
  dbm.getDb().prepare(
    `INSERT INTO plan_wp_reachability_obligations
       (id, package_id, package_content_hash, schema_version, obligation_kind,
        ordinal, declared_json, mutation_path, verification_target, expect_failure_id)
     VALUES ('ob-code', 'pkg-code', 'hash-pkg-code', 2, 'entry-link', 0,
             '{}', 'mutation.patch', 'target', 'failure')`,
  ).run();
  assert.throws(() => service.transitionPlanPackage(command, completion()), /reachability freshness/);
  dbm.insertPlanWpReachabilityEvidenceBatch([{
    id: 'reach-code', obligationId: 'ob-code', packageContentHash: 'hash-pkg-code',
    specimenBaseOid: OID_B, specimenTreeOid: OID_C, mutationBlobOid: OID_B,
    baselineResult: 'pass', mutatedResult: 'fail', failureClassification: 'expected',
    verdict: 'pass', verificationTargetVersion: 'v1', verifiedAt: 80,
  }]);
  const witness = {
    ...completion(100), candidateTreeOid: OID_C, verificationTargetVersion: 'v1',
    mutationBlobOidByObligationId: { 'ob-code': OID_B },
  };
  const done = service.transitionPlanPackage(command, witness);
  const replay = service.transitionPlanPackage(command, { ...witness, observedAt: 999 });
  assert.equal(done.stateAfter, 'done');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.evidenceIds, done.evidenceIds);
  assert.equal(dbm.listPlanWpLifecycleEvents('pkg-code').filter((row) => (row.toState as string) === 'done').length, 1);
});

test('research and no-change completion refuse without their kind-specific evidence and succeed with it', () => {
  seedPackage('pkg-research');
  const research = {
    ...identity('complete', 'pkg-research', 'complete-research'),
    declaration: { kind: 'research' as const, requiredGateKeys: ['review'], outputFinalizationId: 'fin-research' },
  };
  assert.throws(() => service.transitionPlanPackage(research, completion()), /required gate/);
  passGate('pkg-research', 'review', null, 'gate-research');
  assert.throws(() => service.transitionPlanPackage(research, completion()), /durable research output/);
  seedFinalization('pkg-research', 'fin-research');
  assert.equal(service.transitionPlanPackage(research, completion()).stateAfter, 'done');

  seedPackage('pkg-no-change');
  const noChange = {
    ...identity('complete', 'pkg-no-change', 'complete-no-change'),
    declaration: { kind: 'no-change' as const, reviewGateKey: 'review' },
  };
  assert.throws(() => service.transitionPlanPackage(noChange, completion()), /reviewed justification/);
  passGate('pkg-no-change', 'review', null, 'gate-no-change', { reviewedJustification: 'Already satisfied by existing code.' });
  assert.equal(service.transitionPlanPackage(noChange, completion()).stateAfter, 'done');
});

test('handoff results use separate vocabulary, append timeout then success, and never touch turn status', () => {
  dbm.getDb().prepare(
    `INSERT INTO continuation_handoff_attempts
       (id, dashboard_agent_id, generation, started_at, status)
     VALUES ('handoff-1', 'agent-1', 2, '2026-08-08 00:00:00.000', 'open')`,
  ).run();
  seedTurn('turn-handoff', 'pkg-code', 'completed');
  const timeout = service.recordHandoffResult({
    idempotencyKey: 'handoff-timeout', handoffAttemptId: 'handoff-1',
    resultKind: 'successor_oriented', successorSessionId: 'session-1', kickoffTurnId: 'turn-handoff',
  }, { outcome: 'timed_out', witnessedAt: 100 });
  const success = service.recordHandoffResult({
    idempotencyKey: 'handoff-success', handoffAttemptId: 'handoff-1',
    resultKind: 'successor_oriented', successorSessionId: 'session-1', kickoffTurnId: 'turn-handoff',
  }, { outcome: 'succeeded', witnessedAt: 110 });
  assert.deepEqual([timeout.outcome, success.outcome], ['timed_out', 'succeeded']);
  assert.equal(raw('SELECT status FROM turn_records WHERE id = ?', 'turn-handoff').status, 'completed');
  assert.deepEqual(dbm.listContinuationHandoffResultEvents('handoff-1').map((row) => row.outcome), ['timed_out', 'succeeded']);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'package-ledger-service-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs(); sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  service = require('./package-ledger') as ServiceModule;

  dbm.getDb().prepare(
    `INSERT INTO workspaces (id, title, path, path_type) VALUES (?, 'W', 'C:/w', 'windows')`,
  ).run(WS);
  dbm.getDb().prepare(
    `INSERT INTO plans (id, workspace_id, path, format, mtime_ms, size_bytes, artifact_id)
     VALUES (?, ?, '.lares/plans/test', 'structured', 0, 0, ?)`,
  ).run(PLAN, WS, ARTIFACT);
  dbm.getDb().prepare(
    `INSERT INTO plan_intents
       (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind,
        source_doc_rel_path, first_seen_at, updated_at, last_scanned_at)
     VALUES ('intent-row', ?, ?, ?, ?, 'research', 'deliberation.md', 1, 1, 1)`,
  ).run(WS, PLAN, ARTIFACT, INTENT);

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
