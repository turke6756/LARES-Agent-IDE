// WP-D8 ledger acceptance.
//
// Historical fixture provenance (reviewed, never inferred from git adjacency):
// - .lares/plans/2026-08-06-save-card-streamlining-one-gesture-no-ceremony-5b3ea7d1/ARC.md
//   supplies the eleven package groupings, the ordered thirteen implementation
//   abbreviations, and the WP-6 failed-production-entry / WP-6b correction story.
// - plan_ce97b9ad deliberation 2026-08-08-int_d1d47a05-ledger-and-versioning.md
//   section 7 supplies the synthetic and historical acceptance boundaries.
// Every abbreviation is resolved by git rev-parse in this test. Missing,
// ambiguous, abbreviated, duplicate, or non-commit results fail the fixture.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

type DbModule = typeof import('../database');
type LedgerModule = typeof import('./package-ledger');
type GateModule = typeof import('./package-gates');
type DeploymentModule = typeof import('./package-deployments');
type ProjectionModule = typeof import('./plan-ledger-projection');
let dbm: DbModule;
let ledger: LedgerModule;
let gates: GateModule;
let deployments: DeploymentModule;
let projection: ProjectionModule;

const REPOSITORY = 'repo';
const FULL_OID = /^[0-9a-f]{40}$/;

function resolveCommit(abbreviation: string): string {
  assert.match(abbreviation, /^[0-9a-f]{7,39}$/, `fixture abbreviation rejected: ${abbreviation}`);
  let output: string;
  try {
    output = execFileSync('git', ['rev-parse', '--verify', `${abbreviation}^{commit}`], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`historical fixture commit is missing or ambiguous: ${abbreviation}`, { cause: error });
  }
  const matches = output.split(/\r?\n/).filter(Boolean);
  assert.equal(matches.length, 1, `ambiguous historical fixture commit: ${abbreviation}`);
  assert.match(matches[0], FULL_OID, `git returned a non-full OID for ${abbreviation}`);
  return matches[0];
}

function insertWorkspacePlan(
  workspaceId: string, planId: string, artifactId: string, intentId: string,
  sourceProposal = true,
): void {
  const db = dbm.getDb();
  db.prepare(`INSERT INTO workspaces (id, title, path, path_type) VALUES (?, ?, ?, 'windows')`)
    .run(workspaceId, workspaceId, `C:/${workspaceId}`);
  let proposalId: string | null = null;
  if (sourceProposal) {
    proposalId = `proposal-${planId}`;
    db.prepare(
      `INSERT INTO proposals (id, workspace_id, path, artifact_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, 'prop_5b3ea7d1', 'Historical proposal', 'promoted', 1, 1)`,
    ).run(proposalId, workspaceId, `.lares/proposals/${planId}.md`);
  }
  db.prepare(
    `INSERT INTO plans
       (id, workspace_id, path, format, run_state, mtime_ms, size_bytes, artifact_id, source_proposal_id)
     VALUES (?, ?, ?, 'structured', 'complete', 0, 0, ?, ?)`,
  ).run(planId, workspaceId, `.lares/plans/${planId}`, artifactId, proposalId);
  db.prepare(
    `INSERT INTO plan_intents
       (id, workspace_id, plan_id, plan_artifact_id, intent_id, kind,
        source_doc_rel_path, status, first_seen_at, updated_at, last_scanned_at)
     VALUES (?, ?, ?, ?, ?, 'research', 'plan.md', 'active', 1, 1, 1)`,
  ).run(`intent-row-${planId}`, workspaceId, planId, artifactId, intentId);
}

function seedPackage(
  workspaceId: string, planId: string, intentId: string | null,
  id: string, state: 'executing' | 'blocked', order: number,
): void {
  dbm.upsertPlanWorkPackage({
    id, workspaceId, planId, intentId, schemaVersion: 2,
    contentHash: `hash-${id}`, projectionStatus: 'synced', title: id,
    acceptanceCondition: `accept ${id}`, state, assigneeAgentId: 'agent-ledger',
    revision: 1, createdAt: order, updatedAt: order,
  });
  dbm.getDb().prepare(
    `INSERT INTO plan_work_package_layout (package_id, sort_order) VALUES (?, ?)`,
  ).run(id, order);
}

function identity(
  type: PlanPackageCommand['type'], workspaceId: string, planId: string,
  artifactId: string, intentId: string, packageId: string, idempotencyKey: string,
): any {
  return {
    type, idempotencyKey, workspaceId, planId, planArtifactId: artifactId,
    intentId, packageId, packageRevision: 1,
  };
}

let turnSequence = 1;
function seedTurn(
  workspaceId: string, planId: string, intentId: string, packageId: string,
  turnId: string, sessionId: string, status = 'accepted',
): void {
  dbm.getDb().prepare(
    `INSERT INTO turn_records
       (id, workspace_id, turn_seq, agent_id, session_id, started_at, ended_at,
        status, plan_id, plan_item_id, plan_stamp_source, intent_id)
     VALUES (?, ?, ?, 'agent-ledger', ?, 1, 2, ?, ?, ?, 'explicit', ?)`,
  ).run(turnId, workspaceId, turnSequence++, sessionId, status, planId, packageId, intentId);
}

function seedFinalization(
  workspaceId: string, planId: string, packageId: string, oid: string,
): void {
  dbm.insertPackageFinalization({
    id: `finalization-${packageId}`, packageId, repositoryKey: REPOSITORY,
    finalizationKind: 'plan-package', planId, planItemId: packageId,
    packageRevision: 1, finalizedAt: 500, finalizedBy: 'fixture-reviewer',
    checkpointTurnId: null, checkpointOid: oid, boundaryRef: `refs/lares/${packageId}`,
    boundaryStatus: 'ready', lifecycleStatus: 'active',
    supersededByFinalizationId: null, releasedAt: null, memberManifestJson: '[]',
    contractVersion: 1, failureReason: null, createdFromWorkspaceId: workspaceId,
  });
}

async function observeCommitsAndGate(args: {
  workspaceId: string; planId: string; artifactId: string; intentId: string;
  packageId: string; commits: string[]; time: number; gateEvidence?: unknown;
}): Promise<void> {
  const turnId = `turn-${args.packageId}`;
  seedTurn(args.workspaceId, args.planId, args.intentId, args.packageId, turnId, `session-${args.packageId}`);
  ledger.transitionPlanPackage(
    identity('commits-observed', args.workspaceId, args.planId, args.artifactId,
      args.intentId, args.packageId, `commits-${args.packageId}`),
    {
      kind: 'git', actor: 'fixture-git-observer', observedAt: args.time, turnId,
      commits: args.commits.map((commitOid, index) => ({
        repositoryKey: REPOSITORY, commitOid, parentOid: null,
        observedAt: args.time + index, source: 'lares',
        pushedRemoteCount: 0, lastReconciledAt: args.time + index,
      })),
    },
  );
  await gates.ingestGateAttempt({
    ...identity('gate-decided', args.workspaceId, args.planId, args.artifactId,
      args.intentId, args.packageId, `gate-pass-${args.packageId}`),
    gateKey: 'production-entry', gateRevision: 1, attemptNo: 2,
  }, { observe: () => ({
    outcome: 'passed', actor: 'fixture-reviewer', observedAt: args.time + 20,
    evidence: args.gateEvidence ?? { verdict: 'pass', provenance: 'reviewed ARC gate evidence' },
    verifiedCommits: args.commits.map((commitOid) => ({ repositoryKey: REPOSITORY, commitOid })),
  }) });
}

test('7a synthetic a1bacc4a shape refuses incomplete WP6-8, then renders all eleven done from DB only', async () => {
  const workspaceId = 'ws-synthetic';
  const planId = 'plan-synthetic-a1bacc4a';
  const artifactId = 'plan_a1bacc4a';
  const intentId = 'int_a1bacc4a';
  insertWorkspacePlan(workspaceId, planId, artifactId, intentId);
  const packageIds = Array.from({ length: 11 }, (_, index) => `synthetic-wp-${index + 1}`);

  for (let index = 0; index < packageIds.length; index += 1) {
    const number = index + 1;
    const nullBound = number >= 6 && number <= 8;
    seedPackage(workspaceId, planId, nullBound ? null : intentId, packageIds[index],
      nullBound ? 'blocked' : 'executing', number);
  }

  for (const packageId of packageIds.slice(5, 8)) {
    const declaration = {
      kind: 'code' as const, requiredGateKeys: ['production-entry'],
      implementationCommits: [{ repositoryKey: REPOSITORY, commitOid: 'a'.repeat(40) }],
      boundary: 'ready' as const, deploymentEnvironments: ['production'], behavior: true,
    };
    assert.throws(() => ledger.transitionPlanPackage({
      ...identity('complete', workspaceId, planId, artifactId, intentId, packageId, `premature-${packageId}`),
      declaration,
    }, { kind: 'completion', actor: 'fixture', observedAt: 10 }), /identity|illegal complete/);
  }

  // The historical null binding is explicitly repaired before new ledger writes;
  // it is never guessed from the a1bacc4a orchestration.
  dbm.getDb().prepare(
    `UPDATE plan_work_packages SET intent_id = ?, state = 'executing' WHERE plan_id = ? AND intent_id IS NULL`,
  ).run(intentId, planId);

  for (let index = 0; index < packageIds.length; index += 1) {
    const packageId = packageIds[index];
    const oid = (index + 1).toString(16).padStart(40, '0');
    const declaration = {
      kind: 'code' as const, requiredGateKeys: ['production-entry'],
      implementationCommits: [{ repositoryKey: REPOSITORY, commitOid: oid }],
      boundary: 'ready' as const, deploymentEnvironments: ['production'],
      requireDispatch: false, behavior: true,
    };
    if (index >= 5 && index <= 7) {
      assert.throws(() => ledger.transitionPlanPackage({
        ...identity('complete', workspaceId, planId, artifactId, intentId, packageId, `missing-${packageId}`),
        declaration,
      }, { kind: 'completion', actor: 'fixture', observedAt: 20 }), /required gate/);
    }
    if (index === 5) {
      await gates.ingestGateAttempt({
        ...identity('gate-decided', workspaceId, planId, artifactId,
          intentId, packageId, `gate-failed-${packageId}`),
        gateKey: 'production-entry', gateRevision: 1, attemptNo: 1,
      }, { observe: () => ({
        outcome: 'failed', actor: 'fixture-reviewer', observedAt: 990,
        evidence: { finding: 'synthetic failed production-entry proof' },
      }) });
    }
    await observeCommitsAndGate({
      workspaceId, planId, artifactId, intentId, packageId, commits: [oid], time: 1000 + index * 50,
    });
    seedFinalization(workspaceId, planId, packageId, oid);
    await deployments.recordDeploymentNotRequired({
      ...identity('deployment-observed', workspaceId, planId, artifactId,
        intentId, packageId, `deployment-${packageId}`), environment: 'production',
    }, { actor: 'fixture-reviewer', observedAt: 1030 + index * 50,
      rationale: 'Synthetic acceptance has no deployment contract.' });
    if (index === 5) {
      ledger.transitionPlanPackage({
        ...identity('unblock', workspaceId, planId, artifactId,
          intentId, packageId, `unblock-${packageId}`), reason: 'passed retry',
      }, { kind: 'operator', actor: 'fixture-reviewer', observedAt: 1035 + index * 50 });
    }
    ledger.transitionPlanPackage({
      ...identity('complete', workspaceId, planId, artifactId, intentId, packageId, `complete-${packageId}`),
      declaration,
    }, { kind: 'completion', actor: 'fixture-reviewer', observedAt: 1040 + index * 50 });
  }
  const rendered = projection.renderPlanFromLedger(planId);
  assert.ok(rendered);
  assert.equal(rendered.packages.length, 11);
  assert.ok(rendered.packages.every((pkg) => pkg.state === 'done'));
  assert.ok(rendered.packages.every((pkg) => pkg.commitChain.length === 1));
  assert.ok(rendered.packages.every((pkg) => pkg.bindingState === 'bound'));
  assert.ok(rendered.packages.every((pkg) =>
    pkg.deploymentState.some((state) => state.state === 'not_required')));
  assert.deepEqual(rendered.packages[5].gateAttempts.map((gate) => gate.outcome), ['failed', 'passed']);
});

const HISTORICAL_ABBREVIATIONS = [
  'c26fa62b', '386b37e7', 'edf72436', '218b4bf1', 'fe743334', '5a121843',
  '9080f53d', 'e52ad5fb', 'b4617499', 'f6bb12a3', '885edc25', 'deefad3c', '8b2af592',
] as const;

test('7b reviewed plan_5b3ea7d1 fixture exactly preserves history and renders DB-only', async () => {
  const expectedChain = HISTORICAL_ABBREVIATIONS.map(resolveCommit);
  assert.equal(new Set(expectedChain).size, 13, 'historical chain contains a duplicate object');
  const workspaceId = 'ws-historical';
  const planId = 'plan-historical-5b3ea7d1';
  const artifactId = 'plan_5b3ea7d1';
  const intentId = 'int_7c1e94af';
  insertWorkspacePlan(workspaceId, planId, artifactId, intentId);

  const groups: Array<[string, string[]]> = [
    ['WP-1', [expectedChain[0]]], ['WP-2', [expectedChain[1]]],
    ['WP-3', [expectedChain[2]]], ['WP-4', [expectedChain[3]]],
    ['WP-5', expectedChain.slice(4, 7)], ['WP-6', [expectedChain[7]]],
    ['WP-6b', [expectedChain[8]]], ['WP-7', [expectedChain[9]]],
    ['WP-8', [expectedChain[10]]], ['WP-9', [expectedChain[11]]],
    ['WP-10', [expectedChain[12]]],
  ];
  for (let index = 0; index < groups.length; index += 1) {
    const [packageId, commits] = groups[index];
    seedPackage(workspaceId, planId, intentId, packageId, 'executing', index + 1);
    if (packageId === 'WP-6') {
      await observeCommitsAndGate({
        workspaceId, planId, artifactId, intentId, packageId, commits, time: 3000 + index * 100,
        gateEvidence: { verdict: 'pass', finding: 'service behavior accepted; production entry still incomplete' },
      });
      await gates.ingestGateAttempt({
        ...identity('gate-decided', workspaceId, planId, artifactId, intentId, packageId, 'wp6-failed-production-entry'),
        gateKey: 'production-entry-proof', gateRevision: 1, attemptNo: 1,
      }, { observe: () => ({
        outcome: 'failed', actor: 'historical-gate-reviewer', observedAt: 3990,
        evidence: { finding: 'failed/incomplete production-entry proof', commit: commits[0] },
        verifiedCommits: [{ repositoryKey: REPOSITORY, commitOid: commits[0] }],
      }) });
    } else {
      await observeCommitsAndGate({
        workspaceId, planId, artifactId, intentId, packageId, commits, time: 3000 + index * 100,
        gateEvidence: packageId === 'WP-6b'
          ? { verdict: 'pass', finding: 'correcting production-entry gate and commit evidence' }
          : undefined,
      });
    }
    await deployments.recordNotDeployed({
      ...identity('deployment-observed', workspaceId, planId, artifactId,
        intentId, packageId, `not-deployed-${packageId}`), environment: 'production',
    }, { actor: 'historical-reviewer', observedAt: 3050 + index * 100,
      rationale: 'ARC close-out says every implementation commit is local and unpushed.' });
    // Reviewed import boundary: completion is historical fact from the ARC, not
    // inferred from the explicit not_deployed event (which is intentionally non-terminal).
    dbm.getDb().prepare(
      `INSERT INTO plan_wp_lifecycle_events
         (id, package_id, plan_id, from_state, to_state, actor, reason, ts)
       VALUES (?, ?, ?, ?, 'done', 'reviewed-historical-import', 'ARC: landed + gated', ?)`,
    ).run(`historical-done-${packageId}`, packageId, planId,
      packageId === 'WP-6' ? 'blocked' : 'executing', 3070 + index * 100);
    dbm.getDb().prepare(`UPDATE plan_work_packages SET state = 'done' WHERE id = ?`).run(packageId);
  }

  dbm.getDb().prepare(
    `INSERT INTO orchestrations
       (run_id, name, mode, status, workspace_id, supervisor_id, plan_id,
        plan_item_id, plan_binding_mode, planning_intent_id)
     VALUES ('a1bacc4a', 'historical deliberation', 'parallel', 'complete', ?,
             'historical-supervisor', NULL, NULL, 'agent-default', NULL)`,
  ).run(workspaceId);

  const nodeFs = require('node:fs') as Record<string, unknown>;
  const forbidden = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync'] as const;
  const originals = new Map<string, unknown>();
  for (const name of forbidden) {
    originals.set(name, nodeFs[name]);
    nodeFs[name] = () => { throw new Error(`filesystem read forbidden: ${name}`); };
  }
  let rendered;
  try { rendered = projection.renderPlanFromLedger(planId); }
  finally { for (const [name, original] of originals) nodeFs[name] = original; }
  assert.ok(rendered);
  assert.equal(rendered.packages.length, 11);
  assert.ok(rendered.packages.every((pkg) => pkg.state === 'done'));
  assert.deepEqual(rendered.packages.flatMap((pkg) => pkg.commitChain.map((commit) => commit.commitOid)), expectedChain);
  for (const pkg of rendered.packages) {
    const gatesById = new Map(pkg.gateAttempts.map((gate) => [gate.id, gate]));
    for (const commit of pkg.commitChain) {
      assert.ok(commit.gateAttemptIds.some((gateId) => {
        const gate = gatesById.get(gateId);
        return gate?.gateKey === 'production-entry' && gate.outcome === 'passed';
      }), `implementation commit ${commit.commitOid} lacks passed required-gate coverage`);
    }
  }
  assert.ok(rendered.packages.every((pkg) =>
    pkg.deploymentState.some((state) => state.environment === 'production' && state.state === 'not_deployed')));

  const wp6 = rendered.packages.find((pkg) => pkg.id === 'WP-6');
  const wp6b = rendered.packages.find((pkg) => pkg.id === 'WP-6b');
  assert.ok(wp6?.commitChain.some((commit) => commit.commitOid === resolveCommit('e52ad5fb')));
  assert.ok(wp6?.gateAttempts.some((gate) => gate.outcome === 'failed'
    && String(gate.evidence).includes('failed/incomplete production-entry proof')));
  assert.ok(wp6b?.commitChain.some((commit) => commit.commitOid === resolveCommit('b4617499')));
  assert.ok(wp6b?.gateAttempts.some((gate) => gate.outcome === 'passed'
    && String(gate.evidence).includes('correcting production-entry gate')));
  const unbound = dbm.getDb().prepare(
    `SELECT plan_id, planning_intent_id FROM orchestrations WHERE run_id = 'a1bacc4a'`,
  ).get() as { plan_id: string | null; planning_intent_id: string | null };
  assert.deepEqual(unbound, { plan_id: null, planning_intent_id: null });
});

function seedHandoffAttempt(id: string): void {
  dbm.getDb().prepare(
    `INSERT INTO continuation_handoff_attempts
       (id, dashboard_agent_id, generation, started_at, status)
     VALUES (?, 'handoff-agent', 2, '2026-08-08 00:00:00.000', 'open')`,
  ).run(id);
}

function seedBrick(id: string, attemptId: string): void {
  dbm.getDb().prepare(
    `INSERT INTO continuation_bricks
       (id, dashboard_agent_id, handoff_attempt_id, generation, note,
        note_source, byte_len, written_at)
     VALUES (?, 'handoff-agent', ?, 2, 'note', 'assistant', 4, '2026-08-08 00:00:01.000')`,
  ).run(id, attemptId);
}

test('D3 handoff results keep accepted note turns independent and preserve every partial boundary', () => {
  const workspaceId = 'ws-handoff';
  const planId = 'plan-handoff';
  const artifactId = 'plan_1234abcd';
  const intentId = 'int_1234abcd';
  insertWorkspacePlan(workspaceId, planId, artifactId, intentId, false);
  seedHandoffAttempt('handoff-complete');
  seedBrick('brick-complete', 'handoff-complete');
  seedTurn(workspaceId, planId, intentId, 'WP-D3', 'note-turn', 'successor-session', 'accepted');
  ledger.recordHandoffResult({
    idempotencyKey: 'brick', handoffAttemptId: 'handoff-complete', resultKind: 'brick_saved',
    brickId: 'brick-complete', sourceSessionId: 'source-session',
  }, { outcome: 'succeeded', witnessedAt: 10 });
  ledger.recordHandoffResult({
    idempotencyKey: 'started', handoffAttemptId: 'handoff-complete', resultKind: 'successor_started',
    successorSessionId: 'successor-session',
  }, { outcome: 'succeeded', witnessedAt: 20 });
  ledger.recordHandoffResult({
    idempotencyKey: 'oriented', handoffAttemptId: 'handoff-complete', resultKind: 'successor_oriented',
    successorSessionId: 'successor-session', kickoffTurnId: 'note-turn',
  }, { outcome: 'succeeded', witnessedAt: 30 });
  assert.deepEqual(dbm.listContinuationHandoffResultEvents('handoff-complete')
    .map((event) => [event.resultKind, event.outcome]), [
    ['brick_saved', 'succeeded'], ['successor_started', 'succeeded'], ['successor_oriented', 'succeeded'],
  ]);
  assert.equal((dbm.getDb().prepare(`SELECT status FROM turn_records WHERE id = 'note-turn'`).get() as any).status,
    'accepted');

  const failureCases = [
    { id: 'partial-brick', fail: 'brick_saved' as const },
    { id: 'partial-start', fail: 'successor_started' as const },
    { id: 'partial-orient', fail: 'successor_oriented' as const },
  ];
  for (const item of failureCases) {
    seedHandoffAttempt(item.id);
    if (item.fail !== 'brick_saved') {
      const brickId = `brick-${item.id}`;
      seedBrick(brickId, item.id);
      ledger.recordHandoffResult({ idempotencyKey: 'brick-ok', handoffAttemptId: item.id,
        resultKind: 'brick_saved', brickId }, { outcome: 'succeeded', witnessedAt: 40 });
    }
    if (item.fail === 'successor_oriented') {
      ledger.recordHandoffResult({ idempotencyKey: 'start-ok', handoffAttemptId: item.id,
        resultKind: 'successor_started', successorSessionId: 'partial-session' },
      { outcome: 'succeeded', witnessedAt: 50 });
    }
    ledger.recordHandoffResult({ idempotencyKey: 'boundary-failed', handoffAttemptId: item.id,
      resultKind: item.fail }, { outcome: 'failed', witnessedAt: 60,
      detail: { boundary: item.fail, partial: true } });
    const events = dbm.listContinuationHandoffResultEvents(item.id);
    assert.equal(events.at(-1)?.resultKind, item.fail);
    assert.equal(events.at(-1)?.outcome, 'failed');
  }
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'package-ledger-acceptance-'));
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
  ledger = require('./package-ledger') as LedgerModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  gates = require('./package-gates') as GateModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  deployments = require('./package-deployments') as DeploymentModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  projection = require('./plan-ledger-projection') as ProjectionModule;

  let passed = 0, failed = 0;
  for (const item of tests) {
    try { await item.run(); console.log(`  ok  ${item.name}`); passed += 1; }
    catch (error) {
      console.error(`  FAIL ${item.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
