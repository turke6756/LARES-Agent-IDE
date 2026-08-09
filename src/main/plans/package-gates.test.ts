// WP-D4 focused ingestion suite.
//   npm run build:main
//   node dist/main/main/plans/package-gates.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanWorkPackageState } from '../database';

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
type GateModule = typeof import('./package-gates');
type DeploymentModule = typeof import('./package-deployments');
let dbm: DbModule;
let gates: GateModule;
let deployments: DeploymentModule;

const WS = 'ws-gate-ingestion';
const PLAN = 'plan-gate-ingestion';
const ARTIFACT = 'plan_ce97b9ad';
const INTENT = 'int_d1d47a05';
const OID = 'a'.repeat(40);

function seedPackage(id: string, state: PlanWorkPackageState = 'executing'): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId: WS, planId: PLAN, intentId: INTENT,
    schemaVersion: 2, contentHash: `hash-${id}`, projectionStatus: 'synced',
    title: id, acceptanceCondition: 'witnessed', state, assigneeAgentId: 'agent-1',
    revision: 1, createdAt: 10, updatedAt: 10,
  });
}

function request(packageId: string, idempotencyKey: string) {
  return {
    idempotencyKey, workspaceId: WS, planId: PLAN, planArtifactId: ARTIFACT,
    intentId: INTENT, packageId, packageRevision: 1,
  };
}

function seedObservedCommit(packageId: string): void {
  dbm.getDb().prepare(
    `INSERT INTO turn_records
       (id, workspace_id, turn_seq, agent_id, session_id, started_at, ended_at,
        status, plan_id, plan_item_id, plan_stamp_source, intent_id)
     VALUES (?, ?, 1, 'agent-1', 'session-1', 20, 30,
        'completed', ?, ?, 'explicit', ?)`,
  ).run(`turn-${packageId}`, WS, PLAN, packageId, INTENT);
  // Route commit observation through the sole transition service as production does.
  const ledger = require('./package-ledger') as typeof import('./package-ledger');
  ledger.transitionPlanPackage({
    ...request(packageId, `commit-${packageId}`), type: 'commits-observed',
  }, {
    kind: 'git', actor: 'git-observer', observedAt: 30, turnId: `turn-${packageId}`,
    commits: [{ repositoryKey: 'repo', commitOid: OID, parentOid: null,
      observedAt: 30, source: 'lares', pushedRemoteCount: 0, lastReconciledAt: 30 }],
  });
}

test('absent gate and deployment evidence remains explicitly unknown', () => {
  seedPackage('pkg-unknown');
  assert.deepEqual(gates.readGateStatus('pkg-unknown', 1, 'acceptance'), {
    state: 'unknown', attempt: null,
  });
  assert.deepEqual(deployments.readDeploymentStatus('pkg-unknown', 1, 'production'), {
    state: 'unknown', event: null,
  });
});

test('gate outcome comes from the main-process witness and retry history is retained', async () => {
  seedPackage('pkg-retry');
  seedObservedCommit('pkg-retry');
  const seenRequests: Array<Record<string, unknown>> = [];
  await gates.ingestGateAttempt({
    ...request('pkg-retry', 'production-entry-1'), gateKey: 'production-entry',
    gateRevision: 1, attemptNo: 1,
  }, { observe(observedRequest) {
    seenRequests.push(observedRequest as unknown as Record<string, unknown>);
    return { outcome: 'failed', actor: 'reachability-runner', observedAt: 40,
      evidence: { classification: 'missing-registration' },
      verifiedCommits: [{ repositoryKey: 'repo', commitOid: OID }] };
  } });
  assert.equal(dbm.getPlanWorkPackage('pkg-retry')?.state, 'blocked');

  // A retry first re-enters execution through the sole state transition service.
  const ledger = require('./package-ledger') as typeof import('./package-ledger');
  ledger.transitionPlanPackage({
    ...request('pkg-retry', 'retry-unblock'), type: 'unblock', reason: 'corrected seam',
  }, { kind: 'operator', actor: 'supervisor', observedAt: 45 });
  await gates.ingestGateAttempt({
    ...request('pkg-retry', 'production-entry-2'), gateKey: 'production-entry',
    gateRevision: 1, attemptNo: 2,
  }, { observe: () => ({ outcome: 'passed', actor: 'reachability-runner', observedAt: 50,
    evidence: { classification: 'refuted' },
    verifiedCommits: [{ repositoryKey: 'repo', commitOid: OID }] }) });

  assert.equal('outcome' in seenRequests[0], false, 'ingestion request must not carry a trusted outcome');
  assert.deepEqual(
    dbm.listPlanPackageGateAttempts('pkg-retry', 1).map((row) => [row.attemptNo, row.outcome]),
    [[1, 'failed'], [2, 'passed']],
  );
  assert.equal(gates.readGateStatus('pkg-retry', 1, 'production-entry').attempt?.outcome, 'passed');
});

test('production-entry result is derived from recorded prover evidence', async () => {
  seedPackage('pkg-production-entry');
  const proof = {
    packageId: 'pkg-production-entry', packageContentHash: 'hash-pkg-production-entry',
    verdict: 'pass' as const, registryVersion: 'registry-v1',
    specimen: { baseOid: OID, treeOid: OID, commitOid: OID, includedPaths: ['src/main/index.ts'],
      dirtyDeclaredPathStatus: [], packageExact: true, admittedForeignPaths: [] },
    obligations: [{ obligationId: 'obligation-1', kind: 'entry-link' as const, ordinal: 0,
      target: 'main-test', verdict: 'pass' as const, classification: 'expected-failure',
      mutationBlobOid: OID, baseline: null, mutated: null }],
    evidenceRecorded: true,
  };
  await gates.ingestProductionEntryGate({
    ...request('pkg-production-entry', 'proof-1'), gateRevision: 1, attemptNo: 1,
  }, {
    actor: 'reachability-prover', observedAt: () => 60, prove: () => proof,
  });
  assert.equal(gates.readGateStatus('pkg-production-entry', 1, 'production-entry').attempt?.outcome, 'passed');

  await assert.rejects(() => gates.ingestProductionEntryGate({
    ...request('pkg-production-entry', 'proof-unrecorded'), gateRevision: 1, attemptNo: 2,
  }, {
    actor: 'reachability-prover', observedAt: () => 61,
    prove: () => ({ ...proof, evidenceRecorded: false }),
  }), /evidence was not recorded/);
});

test('no-adapter deployment paths record only explicit states and never consult commits', async () => {
  seedPackage('pkg-deployment');
  await deployments.recordNotDeployed({
    ...request('pkg-deployment', 'deploy-none'), environment: 'production',
  }, { actor: 'release-coordinator', observedAt: 70, rationale: 'No deployment adapter exists.' });
  await deployments.recordDeploymentNotRequired({
    ...request('pkg-deployment', 'deploy-na'), environment: 'preview',
  }, { actor: 'release-coordinator', observedAt: 71, rationale: 'Preview is outside package scope.' });

  assert.equal(deployments.readDeploymentStatus('pkg-deployment', 1, 'production').event?.state, 'not_deployed');
  assert.equal(deployments.readDeploymentStatus('pkg-deployment', 1, 'preview').event?.state, 'not_required');
  assert.equal(dbm.listPlanPackageDeploymentEvents('pkg-deployment', 1)
    .every((event) => event.commitOid === null && event.repositoryKey === null), true);
});

test('invalid witness evidence is rejected before the transition service writes it', async () => {
  seedPackage('pkg-invalid');
  await assert.rejects(() => gates.ingestGateAttempt({
    ...request('pkg-invalid', 'invalid-gate'), gateKey: 'acceptance', gateRevision: 1, attemptNo: 1,
  }, { observe: () => ({ outcome: 'passed', actor: 'runner', observedAt: 80,
    verifiedCommits: [{ repositoryKey: 'repo', commitOid: 'abc' }] }) }), /full commit OID/);
  assert.deepEqual(dbm.listPlanPackageGateAttempts('pkg-invalid', 1), []);

  await assert.rejects(() => deployments.ingestDeploymentEvent({
    ...request('pkg-invalid', 'invalid-deploy'), environment: 'production',
  }, { observe: () => ({ state: 'deployed', actor: 'adapter', observedAt: 81,
    repositoryKey: 'repo', commitOid: 'abc' }) }), /full commit OID/);
  await assert.rejects(() => deployments.ingestDeploymentEvent({
    ...request('pkg-invalid', 'half-deploy'), environment: 'production',
  }, { observe: () => ({ state: 'deployed', actor: 'adapter', observedAt: 82,
    repositoryKey: 'repo' }) }), /must be supplied together/);
  assert.deepEqual(dbm.listPlanPackageDeploymentEvents('pkg-invalid', 1), []);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'package-gates-'));
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
  gates = require('./package-gates') as GateModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  deployments = require('./package-deployments') as DeploymentModule;

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
