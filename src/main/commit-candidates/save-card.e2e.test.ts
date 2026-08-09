import assert from 'node:assert/strict';
import * as path from 'node:path';

import type { PlanningActivityWorktree, SaveIntent } from '../database';
import type { DirtyEntry, EncodedGitPath } from '../../shared/commit-candidates';
import type { SaveCardPlanningActivityDto } from '../../shared/types';
import { classifyPathConcurrency, projectConcurrencyActions, type PathIntentObservation } from '../git-checkpoints/concurrency-policy';
import { reconcilePlanningActivityWorktrees } from '../git-checkpoints/planning-worktree-reconciler';
import { assembleConflictComponents } from './component-assembler';
import { projectIntentUnits, type NamedSaveSetMember } from './intent-assembler';
import type { ProjectedWitness } from './witness-projection';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const repository = {
  repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1' as const,
  bareRepo: false as const, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
};

function encoded(displayPath: string): EncodedGitPath {
  return { displayPath, pathBytesBase64: Buffer.from(displayPath).toString('base64'), utf8Clean: true };
}

function entry(entryId: string, displayPath: string): DirtyEntry {
  return {
    entryId, path: encoded(displayPath), originalPath: null, entryKind: 'ordinary',
    indexStatus: '.', worktreeStatus: 'M', headMode: '100644', indexMode: '100644',
    worktreeMode: '100644', submoduleState: null, renameOrCopyScore: null,
    expectedWorktreeState: 'present', rawWorktreeBlobOid: `blob-${entryId}`,
    gitLevelEligibility: 'supported', commitPathspecs: [encoded(displayPath)],
  };
}

function intent(id: string, title = id, planId = 'plan-1', planItemId = 'item-1'): SaveIntent {
  return {
    id, workspaceId: 'ws-1', executionRunId: 'run-1', repositoryKey: 'repo-1',
    kind: 'task', planId, planItemId, title, briefDigest: `digest-${id}`,
    dispatchAttemptId: `attempt-${id}`, createdBy: 'task-dispatch', createdById: null,
    state: 'open', revision: 1, createdAt: 1, readyAt: null, committedAt: null,
  };
}

function witness(entryId: string, turnId: string, agentId: string, intentId: string | null): ProjectedWitness {
  return {
    entryId, workspaceId: 'ws-1', turnId, agentId, ownerAgentId: null,
    ownerBrickGeneration: null, planId: 'plan-1', planItemId: 'item-1', intentId,
    planAttributionAvailable: true,
  };
}

function assembly(entries: DirtyEntry[], witnesses: ProjectedWitness[], intents: SaveIntent[], namedMembers: NamedSaveSetMember[] = []) {
  const topology = assembleConflictComponents({ repository, entries }, witnesses);
  return projectIntentUnits({ inventory: topology.inventory, witnesses, intents, namedMembers, topology });
}

function observation(over: Partial<PathIntentObservation>): PathIntentObservation {
  return {
    repositoryKey: 'repo-1', path: encoded('shared.ts'), intentId: 'intent-a', turnId: 'turn-a',
    agentId: 'agent-a', beforeCommitOid: 'commit-before-a', afterCommitOid: 'commit-after-a',
    beforeBlobOid: 'base', afterBlobOid: 'after-a', finalBlobOid: 'final-b',
    startedAt: 1, endedAt: 2, evidenceQuality: 'complete', ...over,
  };
}

test('scenario 1: two agents, one file, same task => one silent intent and one commit unit', () => {
  const entries = [entry('shared', 'shared.ts')];
  const result = assembly(entries, [
    witness('shared', 'turn-a', 'agent-a', 'intent-a'),
    witness('shared', 'turn-b', 'agent-b', 'intent-a'),
  ], [intent('intent-a')]);
  assert.equal(result.intentUnits.length, 1);
  assert.deepEqual(result.intentUnits[0].contributingAgentIds, ['agent-a', 'agent-b']);
  assert.deepEqual(result.intentUnits[0].memberEntryIds, ['shared']);
});

test('scenario 2: one task across disconnected directories => one intent and one commit unit', () => {
  const entries = [entry('a', 'src/a.ts'), entry('b', 'docs/b.md')];
  const witnesses = [
    witness('a', 'turn-a', 'agent-a', 'intent-a'),
    witness('b', 'turn-b', 'agent-a', 'intent-a'),
  ];
  const topology = assembleConflictComponents({ repository, entries }, witnesses);
  const template = topology.components[0];
  topology.components = entries.map((value, index) => ({
    ...template, componentId: `disconnected-${index + 1}`, dirtyEntryIds: [value.entryId],
    componentTopologyDigest: `topology-${index + 1}`,
  }));
  const result = projectIntentUnits({
    inventory: topology.inventory, witnesses, intents: [intent('intent-a')], namedMembers: [], topology,
  });
  assert.equal(result.intentUnits.length, 1);
  assert.deepEqual(result.intentUnits[0].memberEntryIds, ['a', 'b']);
  assert.equal(result.intentUnits[0].topologyComponentIds.length, 2);
});

test('scenario 3: two briefs under one plan item => two task cards', () => {
  const entries = [entry('a', 'a.ts'), entry('b', 'b.ts')];
  const result = assembly(entries, [
    witness('a', 'turn-a', 'agent-a', 'intent-a'),
    witness('b', 'turn-b', 'agent-a', 'intent-b'),
  ], [intent('intent-a', 'Brief A'), intent('intent-b', 'Brief B')]);
  assert.deepEqual(result.intentUnits.map((unit) => unit.intent.id), ['intent-a', 'intent-b']);
});

test('scenario 4: different-file plans remain separate and both report promoted', () => {
  const activities: SaveCardPlanningActivityDto[] = [
    { executionRunId: 'run-a', planId: 'plan-a', planTitle: 'A', status: 'promoted', promotedHeadOid: 'head-a', latestAttemptId: 'merge-a', conflicts: [], failureCode: null },
    { executionRunId: 'run-b', planId: 'plan-b', planTitle: 'B', status: 'promoted', promotedHeadOid: 'head-b', latestAttemptId: 'merge-b', conflicts: [], failureCode: null },
  ];
  assert.deepEqual(activities.map((item) => item.executionRunId), ['run-a', 'run-b']);
  assert.equal(activities.every((item) => item.status === 'promoted' && item.conflicts.length === 0), true);
});

test('scenario 5: compatible same-file plans surface the second as cleanly promoted', () => {
  const second: SaveCardPlanningActivityDto = {
    executionRunId: 'run-b', planId: 'plan-b', planTitle: 'B', status: 'promoted',
    promotedHeadOid: 'merged-head', latestAttemptId: 'merge-b', conflicts: [], failureCode: null,
  };
  assert.equal(second.status, 'promoted');
  assert.equal(second.conflicts.length, 0);
});

test('scenario 6: incompatible same-file plans preserve the activity commit and conflict UI evidence', () => {
  const second: SaveCardPlanningActivityDto = {
    executionRunId: 'run-b', planId: 'plan-b', planTitle: 'B', status: 'merge-conflicted',
    promotedHeadOid: null, latestAttemptId: 'merge-b', failureCode: null,
    conflicts: [{ pathBytesBase64: encoded('shared.ts').pathBytesBase64, displayPath: 'shared.ts',
      baseBlobOid: 'base', primaryBlobOid: 'primary', activityBlobOid: 'activity', resolution: null }],
  };
  assert.equal(second.status, 'merge-conflicted');
  assert.equal(second.promotedHeadOid, null);
  assert.equal(second.conflicts[0].activityBlobOid, 'activity');
});

test('scenario 7: cross-intent divergence blocks only on the attribution picker', () => {
  const cases = classifyPathConcurrency([
    observation({ intentId: 'intent-a', turnId: 'turn-a', beforeBlobOid: 'base-a', afterBlobOid: 'after-a', endedAt: 2 }),
    observation({ intentId: 'intent-b', turnId: 'turn-b', beforeBlobOid: 'base-b', afterBlobOid: 'after-b', finalBlobOid: 'after-b', startedAt: 3 }),
  ]);
  const actions = projectConcurrencyActions(cases);
  assert.equal(cases[0].classification, 'cross-intent-suspected-lost-update');
  assert.equal(actions.blockingAtoms.length, 1);
  assert.equal(actions.blockingAtoms[0].kind, 'cross-intent');
});

test('scenario 8: lost-work restore is an explicit supervisor resolution and never an implicit commit', () => {
  const [atom] = projectConcurrencyActions(classifyPathConcurrency([
    observation({ intentId: 'intent-a', turnId: 'turn-a', beforeBlobOid: 'base-a', afterBlobOid: 'after-a', endedAt: 2 }),
    observation({ intentId: 'intent-b', turnId: 'turn-b', beforeBlobOid: 'base-b', afterBlobOid: 'after-b', finalBlobOid: 'after-b', startedAt: 3 }),
  ])).blockingAtoms;
  assert.equal(atom.kind, 'cross-intent');
  if (atom.kind !== 'cross-intent') throw new Error('expected cross-intent picker');
  assert.equal(atom.resolution, null);
  assert.equal(atom.evidenceDigest.length, 64);
});

test('scenario 9: human edits remain unwitnessed until an authoritative named set adopts them', () => {
  const entries = [entry('human', 'human.txt')];
  const before = assembly(entries, [], []);
  assert.deepEqual(before.unwitnessedEntryIds, ['human']);
  const named = { ...intent('named', 'Baseline'), kind: 'named-save-set' as const,
    planId: null, planItemId: null, dispatchAttemptId: null, createdBy: 'human-save-card' as const };
  const topology = assembleConflictComponents({ repository, entries }, []);
  const after = projectIntentUnits({
    inventory: topology.inventory, witnesses: [], intents: [named], topology,
    namedMembers: [{ intentId: 'named', entryId: 'human',
      pathBytesBase64: entries[0].path.pathBytesBase64, inventoryDigest: topology.inventory.topologyDigest }],
  });
  assert.deepEqual(after.unwitnessedEntryIds, []);
  assert.deepEqual(after.intentUnits[0].memberEntryIds, ['human']);
});

test('scenario 10: crash recovery is idempotent and missing work is never deleted', async () => {
  let row: PlanningActivityWorktree = {
    executionRunId: 'run-crash', planId: 'plan-crash', logicalWorkspaceId: 'ws-1',
    objectDatabaseKey: 'odb', activityRepositoryKey: 'activity-repo', primaryRepositoryKey: 'primary-repo',
    path: path.join(process.cwd(), '.missing-activity-worktree'), baselineOid: 'base',
    activityHeadRef: 'refs/lares/activities/run-crash/head', promotedHeadOid: null,
    state: 'provisioning', failureCode: null, createdAt: 1, updatedAt: 1,
  };
  const deps = {
    listActivities: () => [row], resolvePrimaryPath: () => process.cwd(),
    updateActivity: (input: Partial<PlanningActivityWorktree> & { executionRunId: string }) => {
      row = { ...row, ...input };
      return row;
    },
    runGit: async () => ({ code: 1, stdout: '', stderr: 'missing' }),
    now: () => 2,
  };
  const first = await reconcilePlanningActivityWorktrees(deps);
  const second = await reconcilePlanningActivityWorktrees(deps);
  assert.deepEqual(first, [{ executionRunId: 'run-crash', disposition: 'quarantined', failureCode: 'activity-path-and-ref-missing' }]);
  assert.deepEqual(second, []);
  assert.equal(row.state, 'recovery-required');
});

(async () => {
  let failures = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`ok - ${current.name}`); }
    catch (error) { failures += 1; console.error(`not ok - ${current.name}`); console.error(error); }
  }
  if (failures > 0) process.exitCode = 1;
})();
