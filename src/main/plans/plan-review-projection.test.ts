// WP-P7A-proj acceptance tests.
//   npm run build:main
//   node dist/main/main/plans/plan-review-projection.test.js

import assert from 'node:assert/strict';
import type { PlanExecutionRun } from '../database';
import type { RunGitLike } from '../git-checkpoints/checkpoint-service';
import type {
  BundleCaptureHealth,
  CandidateMember,
  CommitCandidate,
  ConflictComponent,
  DirtyEntry,
  SelectionPreview,
} from '../../shared/commit-candidates';
import type { SaveCardBundle } from '../../shared/types';
import type { MissionBoardPlanEvidence } from './mission-board-evidence';
import { projectPlanReview, readPlanReviewBaselineDiff } from './plan-review-projection';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const oid = 'a'.repeat(40);
const emptyTreeOid = 'b'.repeat(40);

function path(displayPath: string) {
  return {
    displayPath,
    pathBytesBase64: Buffer.from(displayPath).toString('base64'),
    utf8Clean: true,
  };
}

function entry(entryId: string, displayPath: string, entryKind: DirtyEntry['entryKind']): DirtyEntry {
  return {
    entryId,
    path: path(displayPath),
    originalPath: null,
    entryKind,
    indexStatus: entryKind === 'untracked' ? '?' : '.',
    worktreeStatus: entryKind === 'untracked' ? '?' : 'M',
    headMode: entryKind === 'untracked' ? null : '100644',
    indexMode: entryKind === 'untracked' ? null : '100644',
    worktreeMode: entryKind === 'untracked' ? null : '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: oid,
    gitLevelEligibility: 'supported',
    commitPathspecs: [path(displayPath)],
  };
}

function member(value: DirtyEntry): CandidateMember {
  return {
    entryId: value.entryId,
    path: value.path,
    expectedWorktreeState: value.expectedWorktreeState,
    rawWorktreeBlobOid: value.rawWorktreeBlobOid,
    expectedCommitBlobOid: oid,
    expectedCommitMode: '100644',
    checkpointMode: '100644',
    coveringFinalizationIds: ['fin-1'],
    packageVerification: 'verified-match',
    protection: 'checkpoint-protected',
  };
}

const cleanHealth: BundleCaptureHealth = {
  turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [],
};

function componentBundle(
  componentId: string,
  entries: DirtyEntry[],
  captureHealth: BundleCaptureHealth = cleanHealth,
): SaveCardBundle {
  const component: ConflictComponent = {
    componentId,
    dirtyEntryIds: entries.map((value) => value.entryId),
    associations: [
      { planId: 'plan-a', planItemId: 'pkg-a', contributingTurnIds: ['turn-plan'], memberEntryIds: ['e1'] },
      { planId: 'plan-b', planItemId: 'pkg-b', contributingTurnIds: ['turn-other'], memberEntryIds: ['e2'] },
    ],
    overlap: {
      componentId,
      contributingAgentCount: 2,
      mergedGroupCount: 1,
      perPathContributors: {},
      requiresOverlapAck: true,
    },
    componentTopologyDigest: 'topology-1',
  };
  return {
    bundleId: componentId,
    kind: 'component',
    label: 'cross-plan',
    labels: ['Plan plan-a', 'Plan plan-b'],
    repositoryKey: 'repo-1',
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: 'pkg' }],
    component,
    members: entries.map((value) => ({ entry: value, protection: 'checkpoint-protected' })),
    captureHealth,
    weakestProtection: 'checkpoint-protected',
    identity: null,
  };
}

function run(baselineKind: PlanExecutionRun['baselineKind'] = 'head'): PlanExecutionRun {
  return {
    id: 'run-1', planId: 'plan-a', repositoryKey: 'repo-1', baselineKind,
    baselineHeadOid: baselineKind === 'head' ? oid : null,
    baselineRef: baselineKind === 'head' ? 'refs/lares/plans/plan-a/run-1' : null,
    triggerSource: 'renderer-user-action', appUserId: null, triggeredAt: 1,
    lifecycleState: 'active',
  };
}

function evidence(): MissionBoardPlanEvidence {
  const live = {
    turnId: 'turn-plan', workspaceId: 'ws-1', turnSeq: 1, agentId: 'agent-1',
    taskLabel: 'work', startedAt: 1,
    touched: [{ path: 'src/a.ts', op: 'write' as const }, { path: 'src/new.ts', op: 'create' as const }],
    planId: 'plan-a', planItemId: 'pkg-a', planStampSource: 'explicit' as const,
    planStampStatus: 'verified' as const, isActive: true, association: 'package-stamp' as const,
  };
  return {
    workspaceId: 'ws-1', planId: 'plan-a',
    packages: [{ packageId: 'pkg-a', liveActivity: [live], durableTurns: [], recoveryOperations: [] }],
    unassignedLiveActivity: [], unassignedDurableTurns: [],
    stampAnnotations: [{
      turnId: 'turn-gap', phase: 'live', planStampStatus: 'unstamped',
      planStampSource: 'explicit-none', agentId: 'agent-gap', taskLabel: null, attributed: false,
    }],
  };
}

function candidate(entries: DirtyEntry[]): CommitCandidate {
  return {
    candidateId: 'candidate-from-sc-only',
    contractVersion: 1,
    repository: {
      repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1', bareRepo: false,
      workspaces: [{ workspaceId: 'ws-1', workspacePrefix: 'pkg' }],
    },
    componentIds: ['c-cross'], selectedUnattributedEntryIds: [], members: entries.map(member),
    finalizations: [{ finalizationId: 'fin-1', packageId: 'pkg-a', packageRevision: 1, boundaryStatus: 'ready' }],
    eligibility: { eligible: true }, token: null,
  };
}

function gitFake(calls: string[][]): RunGitLike {
  return async (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'hash-object') return { code: 0, stdout: `${emptyTreeOid}\n`, stderr: '' };
    if (args.includes('--no-index')) return { code: 1, stdout: 'untracked patch\n', stderr: '' };
    return { code: 0, stdout: 'tracked patch\n', stderr: '' };
  };
}

test('embeds the unchanged SC candidate, renders baseline diff + honest annotations, and keeps ids separate', async () => {
  const entries = [entry('e1', 'pkg/src/a.ts', 'ordinary'), entry('e2', 'pkg/src/new.ts', 'untracked')];
  const captureHealth: BundleCaptureHealth = {
    turns: [{
      turnId: 'turn-plan', beforeEdge: 'verified-live', afterEdge: 'absent',
      beforeQuality: 'guaranteed', afterQuality: 'none', failureClass: 'capture-outage',
    }],
    captureOutage: true,
    pathsWithoutFinalizationEdge: ['e2'],
  };
  const bundle = componentBundle('c-cross', entries, captureHealth);
  const scObject = candidate(entries);
  const calls: string[][] = [];
  const projection = await projectPlanReview({
    workspaceId: 'ws-1', planId: 'plan-a', repoRoot: 'C:/repo', workspacePrefix: 'pkg',
    executionRun: run(), evidence: evidence(), scObject, scBundles: [bundle],
  }, { runGit: gitFake(calls) });

  assert.strictEqual(projection.scObject, scObject, 'the SC object is embedded verbatim');
  assert.equal(Object.hasOwn(projection, 'candidateId'), false, 'projection is not a candidate');
  assert.equal((JSON.stringify(projection).match(/candidateId/g) ?? []).length, 1,
    'only the embedded SC candidate carries candidateId');
  assert.deepEqual(projection.baselineDiff.baseline, {
    kind: 'head', ref: 'refs/lares/plans/plan-a/run-1', headOid: oid,
  });
  assert.deepEqual(projection.baselineDiff.repositoryPaths, ['pkg/src/a.ts', 'pkg/src/new.ts']);
  assert.equal(projection.baselineDiff.patch, 'tracked patch\n\nuntracked patch\n');
  assert.ok(calls[0].includes('refs/lares/plans/plan-a/run-1'), 'diff uses the durable baseline ref');
  assert.ok(calls[0].includes(':(top,literal)pkg/src/a.ts'));
  assert.ok(calls[1].includes('--no-index'), 'witnessed raw-status untracked member is rendered too');
  assert.deepEqual(projection.annotations.mixedAuthorship[0], {
    componentId: 'c-cross', planIds: ['plan-a', 'plan-b'], otherPlanIds: ['plan-b'],
    contributingTurnIds: ['turn-other', 'turn-plan'],
    reasons: ['multiple-plans', 'multiple-agents'], currentBytesMayContainMixedAuthorship: true,
  });
  assert.deepEqual(projection.annotations.captureGaps.map((gap) => gap.reasons), [
    ['capture-outage', 'incomplete-edge'], ['unstamped-turn'],
  ]);
  assert.equal(projection.evidenceSemantics, 'activity-only-never-completion');
  // Membership remains auditable to SC's porcelain-v2-derived entry path; the
  // baseline path list is deliberately a separate value, never an identity claim.
  assert.equal(projection.scObject.members[1].path.pathBytesBase64,
    Buffer.from('pkg/src/new.ts').toString('base64'));
  assert.notStrictEqual(projection.baselineDiff.repositoryPaths, projection.scObject.members);
});

test('an unborn run diffs from the empty tree and preserves a SelectionPreview with no id', async () => {
  const value = entry('e1', 'pkg/src/a.ts', 'ordinary');
  const preview: SelectionPreview = {
    componentIds: ['c-cross'], selectedUnattributedEntryIds: [],
    members: [{ ...member(value), expectedCommitBlobOid: null, expectedCommitMode: null,
      checkpointMode: null, coveringFinalizationIds: [], packageVerification: 'package-not-finalized' }],
    eligibility: { eligible: false, reason: 'package-not-finalized' },
  };
  const bundle = componentBundle('c-cross', [value]);
  // Keep this fixture single-plan so it describes a valid whole component.
  bundle.component!.associations = [bundle.component!.associations[0]];
  bundle.component!.overlap.contributingAgentCount = 1;
  const calls: string[][] = [];
  const diff = await readPlanReviewBaselineDiff({
    repoRoot: 'C:/repo', workspacePrefix: 'pkg', executionRun: run('unborn'),
    evidence: evidence(), scBundles: [bundle],
  }, { runGit: gitFake(calls) });
  assert.deepEqual(diff.baseline, { kind: 'unborn' });
  assert.deepEqual(calls[0], ['hash-object', '-t', 'tree', '--stdin']);
  assert.ok(calls[1].includes(emptyTreeOid));

  const projection = await projectPlanReview({
    workspaceId: 'ws-1', planId: 'plan-a', repoRoot: 'C:/repo', workspacePrefix: 'pkg',
    executionRun: run('unborn'), evidence: evidence(), scObject: preview, scBundles: [bundle],
  }, { runGit: gitFake([]) });
  assert.strictEqual(projection.scObject, preview);
  assert.equal('candidateId' in projection.scObject, false);
});

test('rejects a carved sub-candidate instead of splitting a cross-plan component', async () => {
  const entries = [entry('e1', 'pkg/src/a.ts', 'ordinary'), entry('e2', 'pkg/src/new.ts', 'untracked')];
  const carved = candidate(entries);
  carved.members = [member(entries[0])];
  await assert.rejects(() => projectPlanReview({
    workspaceId: 'ws-1', planId: 'plan-a', repoRoot: 'C:/repo', workspacePrefix: 'pkg',
    executionRun: run(), evidence: evidence(), scObject: carved,
    scBundles: [componentBundle('c-cross', entries)],
  }, { runGit: gitFake([]) }), /cannot split SC component 'c-cross'.*missing e2/);
});

async function main(): Promise<void> {
  let failed = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`ok - ${current.name}`); }
    catch (error) { failed += 1; console.error(`not ok - ${current.name}`); console.error(error); }
  }
  if (failed > 0) process.exitCode = 1;
}

void main();
