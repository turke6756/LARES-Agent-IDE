// WP-Z: fixture-driven proposal -> promotion prompt -> folder watcher -> Implement gate.
// Runs the real proposal watcher, plan-folder watcher/reconciler, readiness evaluator,
// lifecycle CAS, and execution-run insert against a sql.js-backed database.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  getRowsModified(): number;
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
  close(): void { /* stores intentionally survive close, matching an on-disk DB */ }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => {
        inner.run(sql, params);
        return { changes: inner.getRowsModified() };
      },
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
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-z-proposal-implement-'));
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-z-appdata-'));
process.env.APPDATA = appData;

function packageDocument(artifactId: string): string {
  const packages = [
    {
      id: 'WP-A', order: 10, title: 'Ready leaf', initial_state: 'ready',
      acceptance_conditions: ['Ready work is actionable.'],
      paths: [{ path: 'src/ready.ts', intent_kind: 'edit' }], depends_on: [],
      reachability: { kind: 'none', rationale: 'Fixture package has no independently reachable behavior.' },
    },
    {
      id: 'WP-B', order: 20, title: 'Blocked leaf', initial_state: 'blocked',
      acceptance_conditions: ['Blocked work stays blocked.'],
      paths: [{ path: 'src/blocked.ts', intent_kind: 'edit' }], depends_on: ['WP-A'],
      reachability: { kind: 'none', rationale: 'Fixture package has no independently reachable behavior.' },
    },
  ];
  return `---\nplan_artifact_id: ${artifactId}\nkind: work-packages\n---\n\n`
    + `<!--PLAN-WORK-PACKAGES:v2\n${JSON.stringify({
      schema_version: 2, plan_artifact_id: artifactId, packages,
    }, null, 2)}\n-->\n\n`
    + '## WP-A - Ready leaf\n\n**Accept**\n- Ready work is actionable.\n\n'
    + '## WP-B - Blocked leaf\n\n**Accept**\n- Blocked work stays blocked.\n';
}

function overviewDocument(artifactId: string, complete: boolean): string {
  const sections = complete
    ? [
      { tab: 'overview', heading: 'What changes' },
      { tab: 'packages', heading: 'Work packages' },
    ]
    : [{ tab: 'overview', heading: 'What changes' }];
  return `---\nplan_artifact_id: ${artifactId}\nkind: human-overview\nschema_version: 1\n---\n\n`
    + `<!--PLAN-TAB-OVERVIEWS:v1\n${JSON.stringify({
      schema_version: 1, plan_artifact_id: artifactId, sections,
    }, null, 2)}\n-->\n\n`
    + '<!--PLAN-TAB-SECTION:overview:BEGIN-->\n## What changes\n\nFixture overview.\n'
    + '<!--PLAN-TAB-SECTION:overview:END-->\n'
    + (complete
      ? '\n<!--PLAN-TAB-SECTION:packages:BEGIN-->\n## Work packages\n\nFixture packages.\n<!--PLAN-TAB-SECTION:packages:END-->\n'
      : '');
}

function scaffoldSidecarPath(workspaceRoot: string, rel: string): string {
  return path.join(workspaceRoot, ...rel.split('/'));
}

function findBackups(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes('.bak.')) found.push(full);
    }
  };
  walk(rootDir);
  return found;
}

test('one reconciliation migrates an exact v3-era workspace and provisions the post-split lanes', () => {
  const supervisorModule = require('../supervisor') as typeof import('../supervisor');
  const constants = require('../../shared/constants') as typeof import('../../shared/constants');
  const old: typeof import('../supervisor/proposal-to-plan-old-body-fixtures') =
    require('../supervisor/proposal-to-plan-old-body-fixtures');
  const workspaceRoot = path.join(root, 'v3-era-workspace');
  const sidecarRel = supervisorModule.SCAFFOLD_SIDECAR_REL;
  const oldFiles = [
    ['SKILL.md', old.PROPOSAL_TO_PLAN_SKILL_MD_V2, 2],
    ['references/activities/promote.md', old.PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2, 2],
    ['scripts/plan-manifest.mjs', old.PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3, 3],
    ['references/activities/capture.md', old.PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3, 3],
  ] as const;
  const roots = [
    '.lares/workers/codex/.agents/skills/proposal-to-plan',
    '.lares/workers/claude/.claude/skills/proposal-to-plan',
  ];
  const sidecar: Record<string, number> = {};
  for (const skillRoot of roots) {
    for (const [rel, body, version] of oldFiles) {
      const full = path.join(workspaceRoot, ...skillRoot.split('/'), ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
      sidecar[`${skillRoot.replace(/^\.lares\//, '')}/${rel}`] = version;
    }
  }
  const sidecarPath = scaffoldSidecarPath(workspaceRoot, sidecarRel);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');

  const raw = new supervisorModule.AgentSupervisor();
  (raw as unknown as { writeAgentRegistry(): void }).writeAgentRegistry = () => {};
  const scaffold = raw as unknown as {
    ensureSupervisorScaffold(workDir: string, pathType: string): void;
    ensureWorkerScaffold(workDir: string, provider: string, pathType: string): void;
    ensureResearcherScaffold(workDir: string, pathType: string): void;
  };
  scaffold.ensureSupervisorScaffold(workspaceRoot, 'windows');
  scaffold.ensureWorkerScaffold(workspaceRoot, 'claude', 'windows');
  scaffold.ensureWorkerScaffold(workspaceRoot, 'codex', 'windows');
  scaffold.ensureResearcherScaffold(workspaceRoot, 'windows');

  for (const skillRoot of roots) {
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, ...skillRoot.split('/'), 'SKILL.md'), 'utf8'),
      constants.PROPOSAL_TO_PLAN_SKILL_MD,
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, ...skillRoot.split('/'), 'references/activities/promote.md'), 'utf8'),
      constants.PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD,
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, ...skillRoot.split('/'), 'scripts/plan-manifest.mjs'), 'utf8'),
      constants.PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS,
    );
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, ...skillRoot.split('/'), 'references/activities/capture.md')),
      false,
      'the retired capture playbook must not remain readable on disk',
    );
  }
  assert.deepEqual(findBackups(path.join(workspaceRoot, '.lares')), [],
    'the pristine v3-era chain must not enter the user-modified backup path');

  const provisioned = [
    '.lares/supervisor/.claude/skills/write-proposal/SKILL.md',
    '.lares/supervisor/.agents/skills/write-proposal/SKILL.md',
    '.lares/workers/claude/.claude/skills/write-proposal/SKILL.md',
    '.lares/workers/codex/.agents/skills/write-proposal/SKILL.md',
    '.lares/researcher/.claude/skills/write-proposal/SKILL.md',
    '.lares/supervisor/.claude/skills/read-planning-surface/SKILL.md',
    '.lares/supervisor/.agents/skills/read-planning-surface/SKILL.md',
    '.lares/workers/claude/.claude/skills/read-planning-surface/SKILL.md',
    '.lares/workers/codex/.agents/skills/read-planning-surface/SKILL.md',
    '.lares/researcher/.claude/skills/read-planning-surface/SKILL.md',
  ];
  for (const rel of provisioned) assert.ok(fs.existsSync(path.join(workspaceRoot, ...rel.split('/'))), rel);

  const finalSkill = constants.PROPOSAL_TO_PLAN_SKILL_MD;
  assert.match(finalSkill, /## Hardening continuity/);
  assert.match(finalSkill, /scope → promote → deliberate → integrate → package/);
  assert.match(finalSkill, /one built-in stop is \*\*after `package`\*\*/);
  assert.match(constants.PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD,
    /responsibility\.md` §Determination\. If another supervisor is responsible/);
  assert.match(constants.PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD, /## Determination/);
  assert.match(constants.READ_PLANNING_SURFACE_SKILL_MD, /never appends `assigned`/);

  const migratedSidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<string, number>;
  for (const skillRoot of roots) {
    const keyRoot = skillRoot.replace(/^\.lares\//, '');
    assert.equal(migratedSidecar[`${keyRoot}/SKILL.md`], 4);
    assert.equal(migratedSidecar[`${keyRoot}/references/activities/promote.md`], 4);
    assert.equal(migratedSidecar[`${keyRoot}/scripts/plan-manifest.mjs`], 4);
    assert.equal(migratedSidecar[`${keyRoot}/references/activities/capture.md`], 4,
      'sidecar must durably record capture retirement');
  }

  const before = fs.readFileSync(sidecarPath, 'utf8');
  scaffold.ensureSupervisorScaffold(workspaceRoot, 'windows');
  scaffold.ensureWorkerScaffold(workspaceRoot, 'claude', 'windows');
  scaffold.ensureWorkerScaffold(workspaceRoot, 'codex', 'windows');
  scaffold.ensureResearcherScaffold(workspaceRoot, 'windows');
  assert.equal(fs.readFileSync(sidecarPath, 'utf8'), before, 're-running reconciliation is idempotent');
  assert.deepEqual(findBackups(path.join(workspaceRoot, '.lares')), []);

  const editedRoot = path.join(root, 'v3-era-edited-capture');
  const editedRel = '.lares/workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md';
  const editedPath = path.join(editedRoot, ...editedRel.split('/'));
  const editedBody = old.PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3 + '\n<!-- user edit -->\n';
  fs.mkdirSync(path.dirname(editedPath), { recursive: true });
  fs.writeFileSync(editedPath, editedBody, 'utf8');
  const editedSidecarPath = scaffoldSidecarPath(editedRoot, sidecarRel);
  fs.mkdirSync(path.dirname(editedSidecarPath), { recursive: true });
  fs.writeFileSync(editedSidecarPath, JSON.stringify({
    'workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md': 3,
  }, null, 2) + '\n', 'utf8');
  scaffold.ensureWorkerScaffold(editedRoot, 'codex', 'windows');
  assert.equal(fs.existsSync(editedPath), false);
  const backups = fs.readdirSync(path.dirname(editedPath)).filter((name) => name.startsWith('capture.md.bak.'));
  assert.equal(backups.length, 1, 'a user-modified retired capture is backed up exactly once');
  assert.equal(fs.readFileSync(path.join(path.dirname(editedPath), backups[0]), 'utf8'), editedBody);
  assert.equal((JSON.parse(fs.readFileSync(editedSidecarPath, 'utf8')) as Record<string, number>)[
    'workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md'
  ], 4);
});

test('post-split promotion fixture reaches exactly one Implement run through real reconciliation', async () => {
  const db = require('../database') as typeof import('../database');
  const { ProposalsWatcher } = require('../proposals-watcher') as typeof import('../proposals-watcher');
  const { PlanFolderWatcher } = require('./plan-folder-watcher') as typeof import('./plan-folder-watcher');
  const { listPlanningEntries, resetPlanningReaderRegistryForTests } =
    require('./planning-reader') as typeof import('./planning-reader');
  const { runPromotionPreflight, PromotionPreflightError } =
    require('./promotion-preflight') as typeof import('./promotion-preflight');
  const { buildProposalToPlanInstruction }: typeof import('../../renderer/components/plan/promotion-dispatch') =
    require('../../renderer/components/plan/promotion-dispatch');
  const { refreshAndGetPlanReadiness, implementPlan } =
    require('./plan-implement') as typeof import('./plan-implement');
  const { markPlanReady } = require('./plan-lifecycle') as typeof import('./plan-lifecycle');

  const workspaceRoot = path.join(root, 'workspace');
  const proposalsHome = path.join(workspaceRoot, '.lares', 'proposals');
  fs.mkdirSync(proposalsHome, { recursive: true });
  const workspace = db.createWorkspace({ title: 'WP-Z', path: workspaceRoot, pathType: 'windows' });
  const supervisor = db.createAgent({
    workspaceId: workspace.id, title: 'Planning supervisor', roleDescription: 'fixture owner',
    workingDirectory: workspaceRoot, command: 'fixture', isSupervisor: true,
    tmuxSessionName: null, autoRestartEnabled: false, logPath: path.join(root, 'supervisor.log'),
  });

  const proposalName = 'filename-deliberately-differs.md';
  const proposalRelPath = `.lares/proposals/${proposalName}`;
  fs.writeFileSync(path.join(proposalsHome, proposalName), [
    '---',
    'artifact_id: prop_1234abcd',
    'title: Canonical Fixture Plan',
    'author: "WP-Z worker"',
    'author_agent_id: wp-z-fixture',
    'author_role: worker',
    'authored_at: 2026-08-06T12:00:00Z',
    '---',
    '',
    '## In plain terms',
    '',
    'Fixture proposal authored under the post-split write-proposal contract.',
    '',
  ].join('\n'), 'utf8');

  const proposalWatcher = new ProposalsWatcher();
  const proposalResult = proposalWatcher.reconcileWorkspace(workspace);
  assert.equal(proposalResult.registered.length, 1, 'real proposal watcher registers the authored fixture');
  resetPlanningReaderRegistryForTests();
  const listing = listPlanningEntries(workspaceRoot, { pathType: 'windows' });
  const proposalDoc = listing.entries
    .find((entry) => entry.kind === 'proposal')!.documents
    .find((document) => document.name === proposalName)!;

  const allowed = await runPromotionPreflight({
    workspaceId: workspace.id,
    proposalDocumentId: proposalDoc.docId,
    artifactIdCrossCheck: 'prop_1234abcd',
  });
  assert.deepEqual(allowed, {
    status: 'allowed',
    proposalRelPath,
    planArtifactId: 'plan_1234abcd',
    targetFolderRelPath: '.lares/plans/2026-08-06-canonical-fixture-plan-1234abcd',
  });

  await assert.rejects(
    runPromotionPreflight({
      workspaceId: workspace.id,
      proposalDocumentId: proposalDoc.docId,
      artifactIdCrossCheck: 'prop_deadbeef',
    }),
    (error: unknown) => error instanceof PromotionPreflightError
      && error.code === 'preflight-artifact-cross-check-rejected',
  );
  fs.writeFileSync(path.join(proposalsHome, 'different-selection.md'), [
    '---',
    'artifact_id: prop_8765dcba',
    'title: Different Selection',
    'author: "WP-Z worker"',
    'author_agent_id: wp-z-fixture',
    'author_role: worker',
    'authored_at: 2026-08-06T12:01:00Z',
    '---',
    '',
    '# Different selection',
    '',
  ].join('\n'), 'utf8');
  proposalWatcher.reconcileWorkspace(workspace);
  resetPlanningReaderRegistryForTests();
  const changedListing = listPlanningEntries(workspaceRoot, { pathType: 'windows' });
  const changedSelection = changedListing.entries
    .find((entry) => entry.kind === 'proposal')!.documents
    .find((document) => document.name === 'different-selection.md')!;
  await assert.rejects(
    runPromotionPreflight({
      workspaceId: workspace.id,
      proposalDocumentId: changedSelection.docId,
      artifactIdCrossCheck: 'prop_1234abcd',
    }),
    (error: unknown) => error instanceof PromotionPreflightError
      && error.code === 'preflight-artifact-cross-check-rejected',
  );

  assert.equal(allowed.status, 'allowed');
  const instruction = buildProposalToPlanInstruction(allowed.proposalRelPath, 'prop_1234abcd');
  assert.match(instruction, /Do NOT run capture/);
  assert.match(instruction, /scope -> promote -> deliberate -> integrate -> package/);
  assert.match(instruction, /Proposal artifact_id: prop_1234abcd/);
  assert.match(instruction, /\.lares\/proposals\/filename-deliberately-differs\.md/);

  const folderRelPath = allowed.targetFolderRelPath;
  const folderAbs = path.join(workspaceRoot, ...folderRelPath.split('/'));
  fs.mkdirSync(path.join(folderAbs, 'supplements'), { recursive: true });
  fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({
    schema_version: 1,
    plan_artifact_id: allowed.planArtifactId,
    plan_sku: path.posix.basename(folderRelPath),
    created_at: 1_775_649_600_000,
    source_proposal: { artifact_id: 'prop_1234abcd', rel_path: allowed.proposalRelPath },
    responsibility_events: [{ event_id: 'assign-fixture', event: 'assigned', agent_id: supervisor.id }],
  }, null, 2));
  fs.writeFileSync(path.join(folderAbs, 'plan.md'), '# Canonical Fixture Plan\n');
  fs.writeFileSync(path.join(folderAbs, 'ARC.md'), '# ARC\n');
  fs.writeFileSync(path.join(folderAbs, 'supplements', 'work-packages.md'), packageDocument(allowed.planArtifactId));
  fs.writeFileSync(path.join(folderAbs, 'OVERVIEW.md'), overviewDocument(allowed.planArtifactId, false));

  const watcher = new PlanFolderWatcher();
  const adopted = await watcher.reconcileWorkspace(workspace, true);
  assert.equal(adopted.settled.length, 1);
  const planId = adopted.settled[0].planId;
  const plan = db.getPlan(planId)!;
  assert.equal(plan.runState, 'hardening');
  assert.equal((db.getDb().prepare('SELECT responsible_supervisor_id FROM plans WHERE id = ?')
    .get(planId) as { responsible_supervisor_id: string }).responsible_supervisor_id, supervisor.id);
  const ordered = db.listPlanWorkPackagesOrdered(planId);
  assert.deepEqual(ordered.map((pkg) => [pkg.title, pkg.state]), [
    ['Ready leaf', 'ready'],
    ['Blocked leaf', 'blocked'],
  ]);
  assert.equal(db.getPlanSourceProposalProjectionState(planId)?.status, 'synced');
  assert.equal((db.getDb().prepare('SELECT COUNT(*) AS n FROM supervisor_active_plan WHERE plan_id = ?')
    .get(planId) as { n: number }).n, 0, 'responsibility projection never steals active-plan attention');

  const tabs = (): Array<'overview' | 'packages'> => ['overview', 'packages'];
  const readiness = () => refreshAndGetPlanReadiness(planId, { getPopulatedTabs: tabs });
  const missing = await markPlanReady({ planId, actor: 'human-fixture' }, {
    refreshAndGetReadiness: readiness,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.tabsMissingOverview, ['packages']);
  assert.equal(db.getPlan(planId)?.runState, 'hardening');

  fs.writeFileSync(path.join(folderAbs, 'OVERVIEW.md'), overviewDocument(allowed.planArtifactId, true));
  await watcher.reconcileWorkspace(workspace, false);
  const beforeRevision = db.listPlanWorkPackagesOrdered(planId).map((pkg) => pkg.revision);
  await watcher.reconcileWorkspace(workspace, false);
  const restartedWatcher = new PlanFolderWatcher();
  await restartedWatcher.reconcileWorkspace(workspace, true);
  assert.deepEqual(db.listPlanWorkPackagesOrdered(planId).map((pkg) => pkg.revision), beforeRevision,
    'repeated refresh and boot reconciliation are semantically idempotent');

  const beforeMark = await readiness();
  const marked = await markPlanReady({ planId, actor: 'human-fixture' }, {
    refreshAndGetReadiness: readiness,
  });
  assert.equal(marked.ok, true, JSON.stringify({ marked, beforeMark }));
  assert.equal(db.getPlan(planId)?.runState, 'ready');

  const implemented = await implementPlan({ planId, appUserId: 'workspace-owner' }, {
    refreshAndGetReadiness: readiness,
    resolveRepoContext: async () => ({ repoRoot: workspaceRoot, repositoryKey: 'fixture-repo' }),
    probeBaseline: async () => ({ ok: true, kind: 'unborn' }),
    newRunId: () => 'run-wp-z-fixture',
    now: () => 1_775_649_700_000,
  });
  assert.equal(implemented.ok, true, JSON.stringify(implemented));
  assert.equal(db.getPlan(planId)?.runState, 'executing');
  assert.equal(db.getActivePlanExecutionRun(planId)?.id, 'run-wp-z-fixture');
  const second = await implementPlan({ planId, appUserId: 'workspace-owner' }, {
    refreshAndGetReadiness: readiness,
    resolveRepoContext: async () => ({ repoRoot: workspaceRoot, repositoryKey: 'fixture-repo' }),
    probeBaseline: async () => ({ ok: true, kind: 'unborn' }),
    newRunId: () => 'run-wp-z-duplicate',
  });
  assert.equal(second.ok, false);
  assert.equal((db.getDb().prepare('SELECT COUNT(*) AS n FROM plan_execution_runs WHERE plan_id = ?')
    .get(planId) as { n: number }).n, 1, 'Implement creates exactly one active execution run');
});

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  const db = require('../database') as typeof import('../database');
  db.initDatabase();

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (error) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
