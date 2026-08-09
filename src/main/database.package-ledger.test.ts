// Planning-surface mechanics WP-D1: schema, migration, append-only evidence,
// full-OID validation, and DB-only projections.
//
//   npm run build:main
//   node dist/main/main/database.package-ledger.test.js

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

type DbModule = typeof import('./database');
let dbm: DbModule;
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function tableColumns(table: string): string[] {
  return (dbm.getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function tableSql(table: string): string {
  return (dbm.getDb().prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { sql: string }).sql;
}

function seedPackage(id = 'pkg-ledger', revision = 2): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId: 'ws-ledger', planId: 'plan-ledger', intentId: 'int_12345678',
    title: 'Ledger package', acceptanceCondition: 'evidence exists', state: 'executing',
    assigneeAgentId: 'agent-ledger', revision, createdAt: 100, updatedAt: 100,
  });
}

test('four evidence tables have the deliberated columns, indexes, checks, and no FKs', () => {
  assert.deepEqual(tableColumns('plan_package_gate_attempts'), [
    'id', 'workspace_id', 'plan_id', 'plan_artifact_id', 'intent_id', 'package_id',
    'package_revision', 'gate_key', 'gate_revision', 'attempt_no', 'outcome',
    'finalization_id', 'witness_agent_id', 'witness_session_id', 'witness_turn_id',
    'evidence_json', 'decided_at', 'created_at',
  ]);
  assert.deepEqual(tableColumns('plan_package_gate_commit_links'), [
    'gate_attempt_id', 'repository_key', 'commit_oid', 'created_at',
  ]);
  assert.deepEqual(tableColumns('plan_package_deployment_events'), [
    'id', 'workspace_id', 'plan_id', 'package_id', 'package_revision', 'environment',
    'state', 'repository_key', 'commit_oid', 'witness_agent_id', 'witness_session_id',
    'detail_json', 'occurred_at',
  ]);
  assert.deepEqual(tableColumns('continuation_handoff_result_events'), [
    'id', 'handoff_attempt_id', 'result_kind', 'outcome', 'dashboard_agent_id',
    'generation', 'brick_id', 'source_session_id', 'successor_session_id',
    'kickoff_turn_id', 'completion_quality', 'detail_json', 'witnessed_at',
  ]);

  for (const table of [
    'plan_package_gate_attempts', 'plan_package_gate_commit_links',
    'plan_package_deployment_events', 'continuation_handoff_result_events',
  ]) {
    assert.deepEqual(dbm.getDb().prepare(`PRAGMA foreign_key_list(${table})`).all(), [], table);
  }
  const indexes = dbm.getDb().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN
      ('idx_gate_attempts_pkg','idx_deploy_events_pkg','idx_handoff_results_attempt')
     ORDER BY name`,
  ).all() as Array<{ name: string }>;
  assert.deepEqual(indexes.map((row) => row.name), [
    'idx_deploy_events_pkg', 'idx_gate_attempts_pkg', 'idx_handoff_results_attempt',
  ]);
  assert.match(tableSql('plan_package_gate_attempts'), /pending.*passed.*failed.*cancelled/s);
  assert.match(tableSql('plan_package_deployment_events'), /not_required.*rolled_back/s);
  assert.match(tableSql('continuation_handoff_result_events'), /brick_saved.*successor_oriented/s);
});

test('guarded extensions exist and new dispatch rows freeze the package revision', () => {
  assert.ok(tableColumns('plan_work_packages').includes('intent_id'));
  for (const column of ['package_revision', 'orchestration_id', 'target_session_id']) {
    assert.ok(tableColumns('plan_dispatch_attempts').includes(column), column);
  }
  seedPackage('pkg-dispatch-revision', 7);
  dbm.getDb().prepare(
    `UPDATE plan_work_packages SET state = 'ready' WHERE id = 'pkg-dispatch-revision'`,
  ).run();
  dbm.getDb().prepare(
    `INSERT INTO plan_execution_runs
       (id, plan_id, baseline_kind, trigger_source, triggered_at, lifecycle_state)
     VALUES ('run-ledger', 'plan-ledger', 'unborn', 'renderer-user-action', 1, 'active')`,
  ).run();
  const row = dbm.insertPlanDispatchAttempt({
    id: 'dispatch-ledger', packageId: 'pkg-dispatch-revision', planId: 'plan-ledger',
    executionRunId: 'run-ledger', targetAgentId: 'agent-ledger',
    requestedPlanItemId: 'pkg-dispatch-revision', createdAt: 2,
    orchestrationId: 'orch-ledger', targetSessionId: 'session-ledger',
  });
  assert.equal(row.packageRevision, 7);
  assert.equal(row.orchestrationId, 'orch-ledger');
  assert.equal(row.targetSessionId, 'session-ledger');

  dbm.getDb().prepare(
    `INSERT INTO plan_intents
       (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind,
        source_doc_rel_path, first_seen_at, updated_at, last_scanned_at)
     VALUES ('intent-row', 'ws-ledger', 'plan-ledger', 'plan_12345678',
             'int_12345678', 'research', 'deliberation.md', 1, 1, 1)`,
  ).run();
  dbm.getDb().prepare(
    `INSERT INTO orchestrations
       (run_id, name, mode, status, workspace_id, supervisor_id, plan_id,
        planning_intent_id)
     VALUES ('orch-ledger', 'ledger', 'serial', 'complete', 'ws-ledger',
             'supervisor', 'plan-ledger', 'int_12345678')`,
  ).run();
  dbm.getDb().prepare(
    `UPDATE plan_dispatch_attempts SET package_revision = NULL
      WHERE id = 'dispatch-ledger'`,
  ).run();
  dbm.getDb().prepare(
    `UPDATE plan_work_packages SET intent_id = NULL
      WHERE id = 'pkg-dispatch-revision'`,
  ).run();
  dbm.initDatabase();
  assert.equal(dbm.getPlanDispatchAttempt('dispatch-ledger')?.packageRevision, 7);
  assert.equal(dbm.getPlanWorkPackage('pkg-dispatch-revision')?.intentId, 'int_12345678');
  assert.equal(dbm.getPlanWorkPackage('legacy-pkg')?.intentId, null,
    'legacy rows without an explicit key chain remain unbound');
});

test('gate retries remain append-only and latest-gate projection does not erase failure', () => {
  seedPackage();
  const base = {
    workspaceId: 'ws-ledger', planId: 'plan-ledger', planArtifactId: 'plan_12345678',
    intentId: 'int_12345678', packageId: 'pkg-ledger', packageRevision: 2,
    gateKey: 'production-entry', gateRevision: 1, finalizationId: null,
    witnessAgentId: 'agent-ledger', witnessSessionId: 'session-ledger',
    witnessTurnId: null, evidenceJson: '{}',
  } as const;
  dbm.insertPlanPackageGateAttempt({
    ...base, id: 'gate-failed', attemptNo: 1, outcome: 'failed', decidedAt: 20, createdAt: 10,
  });
  dbm.insertPlanPackageGateAttempt({
    ...base, id: 'gate-passed', attemptNo: 2, outcome: 'passed', decidedAt: 40, createdAt: 30,
  });
  assert.deepEqual(
    dbm.listPlanPackageGateAttempts('pkg-ledger', 2).map((row) => row.outcome),
    ['failed', 'passed'],
  );
  assert.equal(dbm.listLatestPlanPackageGateAttempts('pkg-ledger', 2)[0]?.outcome, 'passed');
  assert.throws(() => dbm.insertPlanPackageGateAttempt({
    ...base, id: 'gate-duplicate-number', attemptNo: 2, outcome: 'passed',
    decidedAt: 50, createdAt: 50,
  }));
});

test('gate/deployment accessors reject non-40-hex OIDs and round-trip full OIDs', () => {
  dbm.insertPlanPackageGateCommitLink({
    gateAttemptId: 'gate-passed', repositoryKey: 'repo', commitOid: OID_A, createdAt: 50,
  });
  assert.equal(dbm.listPlanPackageGateCommitLinks('gate-passed')[0]?.commitOid, OID_A);
  for (const invalid of ['abc', 'g'.repeat(40), `${'a'.repeat(39)}z`]) {
    assert.throws(() => dbm.insertPlanPackageGateCommitLink({
      gateAttemptId: 'gate-passed', repositoryKey: 'repo', commitOid: invalid, createdAt: 51,
    }), /40-hex/);
  }

  const deploymentBase = {
    workspaceId: 'ws-ledger', planId: 'plan-ledger', packageId: 'pkg-ledger',
    packageRevision: 2, environment: 'production', repositoryKey: 'repo',
    witnessAgentId: 'agent-ledger', witnessSessionId: 'session-ledger', detailJson: null,
  } as const;
  dbm.insertPlanPackageDeploymentEvent({
    ...deploymentBase, id: 'deploy-none', state: 'not_deployed', commitOid: OID_A, occurredAt: 60,
  });
  dbm.insertPlanPackageDeploymentEvent({
    ...deploymentBase, id: 'deploy-done', state: 'deployed', commitOid: OID_B, occurredAt: 70,
  });
  assert.equal(dbm.listLatestPlanPackageDeploymentEvents('pkg-ledger', 2)[0]?.state, 'deployed');
  assert.throws(() => dbm.insertPlanPackageDeploymentEvent({
    ...deploymentBase, id: 'deploy-bad', state: 'failed', commitOid: 'f'.repeat(39), occurredAt: 80,
  }), /40-hex/);
});

test('DB-only evidence projection returns dispatch, complete history, and current states', () => {
  const projected = dbm.getPlanPackageEvidenceProjection('pkg-ledger', 2);
  assert.ok(projected);
  assert.equal(projected.package.intentId, 'int_12345678');
  assert.deepEqual(projected.gateAttempts.map((row) => row.id), ['gate-failed', 'gate-passed']);
  assert.deepEqual(projected.latestGateAttempts.map((row) => row.id), ['gate-passed']);
  assert.deepEqual(projected.gateCommitLinks.map((row) => row.commitOid), [OID_A]);
  assert.deepEqual(projected.deploymentEvents.map((row) => row.state), ['not_deployed', 'deployed']);
  assert.deepEqual(projected.latestDeploymentEvents.map((row) => row.state), ['deployed']);
  assert.equal(dbm.getPlanPackageEvidenceProjection('missing'), null);
});

test('handoff results append timeout then success without touching source rows', () => {
  const base = {
    handoffAttemptId: 'handoff-1', resultKind: 'successor_oriented' as const,
    dashboardAgentId: 'agent-1', generation: 2, brickId: null,
    sourceSessionId: 'source', successorSessionId: 'successor', kickoffTurnId: 'turn',
    completionQuality: null, detailJson: null,
  };
  dbm.insertContinuationHandoffResultEvent({
    ...base, id: 'handoff-timeout', outcome: 'timed_out', witnessedAt: 90,
  });
  dbm.insertContinuationHandoffResultEvent({
    ...base, id: 'handoff-success', outcome: 'succeeded', witnessedAt: 100,
  });
  assert.deepEqual(
    dbm.listContinuationHandoffResultEvents('handoff-1').map((row) => row.outcome),
    ['timed_out', 'succeeded'],
  );
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'package-ledger-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  // Seed a legacy P5B database before loading database.ts. Its live lifecycle
  // rows must survive the done-CHECK rebuild.
  const dbFile = path.join(tmpAppData, 'AgentDashboard', 'dashboard.db');
  const legacy = new FakeBetterSqlite(dbFile);
  legacy.exec(`
    CREATE TABLE plan_work_packages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
      title TEXT NOT NULL, acceptance_condition TEXT, state TEXT NOT NULL,
      assignee_agent_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK (state IN ('ready','executing','blocked','done','archived')),
      CHECK (revision > 0)
    );
    INSERT INTO plan_work_packages VALUES
      ('legacy-pkg','legacy-ws','legacy-plan','Legacy',NULL,'blocked',NULL,3,1,2);
    CREATE TABLE plan_wp_lifecycle_events (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES plan_work_packages(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
      actor TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL,
      CHECK (to_state IN ('ready','executing','blocked','archived'))
    );
    INSERT INTO plan_wp_lifecycle_events VALUES
      ('legacy-event','legacy-pkg','legacy-plan','ready','blocked','legacy','why',2);
  `);

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  test('legacy done-CHECK rebuild preserves rows and is idempotent', () => {
    assert.deepEqual(dbm.listPlanWpLifecycleEvents('legacy-pkg').map((row) => row.id), ['legacy-event']);
    dbm.getDb().prepare(
      `INSERT INTO plan_wp_lifecycle_events
         (id, package_id, plan_id, from_state, to_state, actor, reason, ts)
       VALUES ('done-event','legacy-pkg','legacy-plan','blocked','done','test',NULL,3)`,
    ).run();
    dbm.getDb().exec(`
      CREATE TRIGGER lifecycle_rebuild_sentinel AFTER INSERT ON plan_wp_lifecycle_events
      BEGIN SELECT 1; END
    `);
    dbm.initDatabase();
    assert.deepEqual(
      dbm.listPlanWpLifecycleEvents('legacy-pkg').map((row) => row.id),
      ['legacy-event', 'done-event'],
    );
    const sentinel = dbm.getDb().prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'lifecycle_rebuild_sentinel'`,
    ).get() as { name: string } | undefined;
    assert.equal(sentinel?.name, 'lifecycle_rebuild_sentinel', 'second init did not rebuild');
  });

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
