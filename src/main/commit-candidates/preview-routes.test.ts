// SC-WP-W1 — production candidate-preview route composition.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/preview-routes.test.js
//
// Proves the bootstrap adapter that resolves a renderer selection into the full
// WP-3G `CandidateBuildContext`. The read-only 1G assembly seam is stubbed (the
// real-git 1G pipeline is covered by save-card-routes.test); this test drives the
// STITCHING that is unique to this module:
//   • ledger / pinned HEAD / index fingerprint / contractVersion are wired in;
//   • requested finalizations are resolved by id and back a real CommitCandidate;
//   • an unfinalized selection resolves NO temp-index reps (the reported "click
//     Save" path) yet still returns a real SelectionPreview;
//   • the plan lens defaults to the plan's OWN components when the request omits
//     them, so the reps it resolves match the members the assembler verifies.

import assert from 'node:assert/strict';

import { createPreviewRoutes, type PreviewRoutesDeps } from './preview-routes';
import { buildCandidate, computeCandidateTopologyDigest } from './candidate-service';
import type { CandidateInventoryRead } from './candidate-service';
import type {
  CommitCandidate,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  RepositoryIdentity,
  SelectionPreview,
} from '../../shared/commit-candidates';
import type { PackageFinalization } from '../database';
import type { GitCapability } from '../../shared/types';
import type { FrozenManifestMember } from './finalization-service';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const REPO_KEY = 'repo-key-1';
const OID = 'b'.repeat(40);
/** Canonical base64 path bytes so the REAL `readCurrentCommitRepresentation` (which
 *  round-trips path bytes through base64) matches the stubbed stage stream below. */
function b64(id: string): string { return Buffer.from(`src/${id}.ts`).toString('base64'); }
function encPath(id: string): EncodedGitPath {
  return { pathBytesBase64: b64(id), displayPath: `src/${id}.ts`, utf8Clean: true };
}

/** A NUL-delimited `ls-files --stage -z` stream with one present stage-0 record per
 *  id — enough for the fingerprint AND for a per-member temp-index rep read. */
function stageStream(ids: readonly string[]): Buffer {
  return Buffer.concat(ids.flatMap((id) => [
    Buffer.from(`100644 ${OID} 0\t`, 'ascii'),
    Buffer.from(`src/${id}.ts`, 'utf8'),
    Buffer.from([0]),
  ]));
}

function repository(): RepositoryIdentity {
  return {
    repositoryKey: REPO_KEY,
    objectDatabaseKey: 'odb-1',
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}

function entry(id: string, over: Partial<DirtyEntry> = {}): DirtyEntry {
  return {
    entryId: id,
    path: encPath(id),
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: `raw-${id}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [encPath(id)],
    ...over,
  };
}

function component(
  componentId: string,
  entryIds: string[],
  planId: string | null = 'plan-A',
  planItemId: string | null = null,
): ConflictComponent {
  return {
    componentId,
    dirtyEntryIds: entryIds,
    associations: [{ planId, planItemId, contributingTurnIds: ['t1'], memberEntryIds: entryIds }],
    overlap: {
      componentId,
      contributingAgentCount: 1,
      mergedGroupCount: 1,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: `topo-${componentId}`,
  };
}

function inventory(entries: DirtyEntry[], unattributedEntryIds: string[] = []): DirtyInventory {
  return { repository: repository(), entries, unattributedEntryIds, topologyDigest: 'inv-topo' };
}

function read(over: Partial<CandidateInventoryRead> = {}): CandidateInventoryRead {
  return {
    inventory: inventory([entry('e1')]),
    components: [component('c1', ['e1'])],
    captureHealthByComponentId: {},
    unattributedCaptureHealth: {} as never,
    protectionByEntryId: {},
    planAttributionUnavailableTurnIds: new Set<string>(),
    quotaWeakening: null,
    ...over,
  };
}

function frozen(entryId: string): FrozenManifestMember {
  return {
    pathBytesBase64: b64(entryId),
    expectedState: 'present',
    rawBlobOid: `raw-${entryId}`,
    commitBlobOid: `commit-${entryId}`,
    commitMode: '100644',
  };
}

function finalization(over: Partial<PackageFinalization> = {}): PackageFinalization {
  return {
    id: 'fin-1', packageId: 'pkg-1', repositoryKey: REPO_KEY,
    finalizationKind: 'fleet-adhoc', planId: null, planItemId: null,
    packageRevision: 3, finalizedAt: 1, finalizedBy: 'human-ipc',
    checkpointTurnId: null, checkpointOid: 'boundary-oid', boundaryRef: 'refs/lares/fin-1',
    boundaryStatus: 'ready', lifecycleStatus: 'active', supersededByFinalizationId: null,
    releasedAt: null, memberManifestJson: JSON.stringify([frozen('e1')]),
    contractVersion: 1, failureReason: null, createdFromWorkspaceId: null,
    ...over,
  };
}

function capability(): GitCapability {
  return {
    resolution: {} as never,
    repoState: null,
    commonDir: '/repo/.git',
    commonDirQueueKey: 'repo',
    repoRoot: '/repo',
    workspacePrefix: '',
    protectedRoot: false,
    reason: 'ok' as never,
    detail: null,
  };
}

/** Base deps: 1G assembly stubbed; git seams answer HEAD, the index fingerprint,
 *  and any temp-index rep read (present stage-0 records for e1 + e2). `lsFiles`
 *  records every `ls-files --stage -z` invocation so a test can assert rep-skip. */
function baseDeps(over: Partial<PreviewRoutesDeps> = {}, lsFiles: string[] = []): PreviewRoutesDeps {
  return {
    gitExe: 'git',
    getWorkspaces: () => [{ id: 'ws-1', path: '/repo' }],
    probeWorkspaceGit: async () => capability(),
    realpath: (p) => p,
    assembleInventory: async () => read(),
    listRepoCommitPathLinks: () => [],
    getPackageFinalization: () => null,
    runGit: (async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
      // read-tree / add during a temp-index rep read — no-op success.
      return { code: 0, stdout: '', stderr: '' };
    }) as PreviewRoutesDeps['runGit'],
    runGitBytes: (async (_cwd, args) => {
      if (args[0] === 'ls-files') { lsFiles.push(args.join(' ')); return { code: 0, stdout: stageStream(['e1', 'e2']), stderr: '' }; }
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    }) as PreviewRoutesDeps['runGitBytes'],
    ...over,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('unfinalized save-lens selection → real SelectionPreview, NO temp-index reps', async () => {
  const lsFiles: string[] = [];
  const { saveCardPreviewRoutes } = createPreviewRoutes(baseDeps({}, lsFiles));

  const context = await saveCardPreviewRoutes.resolvePreviewContext({
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: [],
  });

  // Stitched, selection-independent context fields are wired from the real seams.
  assert.equal(context.repository.repositoryKey, REPO_KEY);
  assert.equal(context.pinnedHeadOid, 'a'.repeat(40));
  assert.equal(context.indexFingerprint.hasUnmerged, false);
  assert.equal(context.contractVersion, 1);
  assert.equal(context.currentCommitReps.size, 0);

  // No requested finalization ⇒ a previewable, never-committable SelectionPreview.
  const preview = buildCandidate(
    { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: [] },
    context,
  ) as SelectionPreview;
  assert.equal('candidateId' in preview, false);
  assert.equal(preview.eligibility.eligible, false);
  assert.equal(preview.members.length, 1);

  // The reps git-work is skipped entirely when no finalization is requested — only
  // the fingerprint's ls-files ran; there was NO per-member temp-index rep read.
  assert.equal(lsFiles.length, 1, 'exactly the fingerprint ls-files, no rep reads');
});

test('finalization-backed save-lens selection → a real CommitCandidate, reps resolved per member', async () => {
  const { saveCardPreviewRoutes } = createPreviewRoutes(baseDeps({
    getPackageFinalization: (id) => (id === 'fin-1' ? finalization() : null),
  }));

  const context = await saveCardPreviewRoutes.resolvePreviewContext({
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
  });

  assert.equal(context.finalizations.length, 1);
  assert.equal(context.finalizations[0].id, 'fin-1');
  // A rep was resolved for the single selected member (finalizationIds non-empty).
  assert.deepEqual([...context.currentCommitReps.keys()], ['e1']);

  const candidate = buildCandidate(
    { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] },
    context,
  ) as CommitCandidate;
  assert.equal('candidateId' in candidate, true);
  assert.equal(candidate.finalizations[0].packageId, 'pkg-1');
});

test('plan lens defaults to the plan-owned components when the request omits them', async () => {
  // c1 belongs to plan-A, c2 to plan-B. A plan-A preview with no explicit components
  // must resolve reps for c1's member (e1) only — never c2's (e2, a different plan).
  const { planPreviewRoutes } = createPreviewRoutes(baseDeps({
    assembleInventory: async () => read({
      inventory: inventory([entry('e1'), entry('e2')]),
      components: [component('c1', ['e1'], 'plan-A'), component('c2', ['e2'], 'plan-B')],
    }),
    getPackageFinalization: (id) => (id === 'fin-1' ? finalization() : null),
  }));

  const context = await planPreviewRoutes.resolvePreviewContext({
    workspaceId: 'ws-1',
    planId: 'plan-A',
    selectedComponentIds: [],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
  });

  // Both components stay in the context for the assembler; only plan-A's member got
  // a pre-resolved rep (proves the D-1 plan-owned default drove rep resolution).
  assert.equal(context.components.length, 2);
  assert.deepEqual([...context.currentCommitReps.keys()], ['e1']);
});

test('an unknown target workspace is rejected honestly', async () => {
  const { saveCardPreviewRoutes } = createPreviewRoutes(baseDeps({
    getWorkspaces: () => [{ id: 'other', path: '/elsewhere' }],
  }));
  await assert.rejects(
    () => saveCardPreviewRoutes.resolvePreviewContext({
      workspaceId: 'ws-1', selectedComponentIds: [], selectedUnattributedEntryIds: [], finalizationIds: [],
    }),
    /unknown workspace/i,
  );
});

test('fleet-adhoc resolver captures and returns the checkpoint engine boundary OID', async () => {
  const calls: Array<{ workspaceId: string; label: string }> = [];
  const boundaryOid = 'c'.repeat(40);
  const { saveCardFinalizeRoutes } = createPreviewRoutes(baseDeps({
    captureFinalizationBoundary: async (workspaceId, label) => {
      calls.push({ workspaceId, label });
      return { oid: boundaryOid, treeOid: 'd'.repeat(40) };
    },
  }));

  const context = await saveCardFinalizeRoutes.resolveBoundary({
    packageId: 'component:c1',
    targetWorkspaceId: 'ws-1',
  });
  assert.deepEqual(calls, [{ workspaceId: 'ws-1', label: 'lares:finalization:component:c1' }]);
  assert.equal(context.boundaryOid, boundaryOid, 'the fake engine OID is the durable boundary input');
  assert.equal(context.repositoryKey, REPO_KEY);
  assert.equal(context.members.length, 1);
  assert.equal(context.members[0].path.pathBytesBase64, b64('e1'));
});

test('fleet-adhoc resolver identifies a fake no-repo workspace as a typed refusal cause', async () => {
  const noRepo = capability();
  noRepo.repoState = 'non-repo';
  noRepo.repoRoot = null;
  noRepo.commonDir = null;
  noRepo.commonDirQueueKey = null;
  noRepo.workspacePrefix = null;
  const { saveCardFinalizeRoutes } = createPreviewRoutes(baseDeps({
    getWorkspaces: () => [{ id: '54ad9887', path: '/computer-root', title: 'Computer Root' }],
    probeWorkspaceGit: async () => noRepo,
    captureFinalizationBoundary: async () => { throw new Error('must not capture'); },
  }));

  await assert.rejects(
    () => saveCardFinalizeRoutes.resolveBoundary({
      packageId: 'component:proposal',
      targetWorkspaceId: '54ad9887',
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'SaveCardFinalizeRefusalError'
      && (error as Error & { code?: string }).code === 'save-card-no-repository'
      && error.message.includes("workspace 'Computer Root'"),
  );
});

// SC-WP-W5 — LIVE BLOCKER regression: a Save pane scoped to a real project repo
// must route a fleet-adhoc mark-done to THAT repo, even when a broad repo-less
// "Computer Root" workspace overlaps everything and is iterated first. The bug
// was that resolveFleetBoundary scanned every workspace and threw the moment it
// probed Computer Root (no repoRoot), poisoning EVERY save regardless of package.
test('fleet-adhoc routes by the pane workspace, not a repo-less overlapping workspace', async () => {
  const rootCap = capability();
  rootCap.repoState = 'non-repo';
  rootCap.repoRoot = null;
  rootCap.commonDir = null;
  rootCap.commonDirQueueKey = null;
  rootCap.workspacePrefix = null;
  const calls: Array<{ workspaceId: string; label: string }> = [];
  // Computer Root is registered FIRST and overlaps everything but has no repo of
  // its own; the project workspace carries the repo the package's files live in.
  const { saveCardFinalizeRoutes } = createPreviewRoutes(baseDeps({
    getWorkspaces: () => [
      { id: 'computer-root', path: '/', title: 'Computer Root' },
      { id: 'project', path: '/repo', title: 'Project' },
    ],
    probeWorkspaceGit: async (dir) => (dir === '/' ? rootCap : capability()),
    captureFinalizationBoundary: async (workspaceId, label) => {
      calls.push({ workspaceId, label });
      return { oid: 'c'.repeat(40), treeOid: 'd'.repeat(40) };
    },
  }));

  const context = await saveCardFinalizeRoutes.resolveBoundary({
    packageId: 'component:c1',
    targetWorkspaceId: 'project',
  });
  // The boundary is captured against the PANE's project workspace — Computer Root
  // is never assembled and never poisons the resolve.
  assert.deepEqual(calls, [{ workspaceId: 'project', label: 'lares:finalization:component:c1' }]);
  assert.equal(context.createdFromWorkspaceId, 'project');
  assert.equal(context.repositoryKey, REPO_KEY);
  assert.equal(context.repoRoot, '/repo');
  assert.equal(context.members.length, 1);
});

// The genuine no-repo case survives: when the PANE itself is the repo-less
// workspace, the finalize still refuses typed (never a silent success).
test('fleet-adhoc still refuses typed when the PANE workspace itself has no repo', async () => {
  const rootCap = capability();
  rootCap.repoState = 'non-repo';
  rootCap.repoRoot = null;
  rootCap.commonDir = null;
  rootCap.commonDirQueueKey = null;
  rootCap.workspacePrefix = null;
  const { saveCardFinalizeRoutes } = createPreviewRoutes(baseDeps({
    getWorkspaces: () => [
      { id: 'computer-root', path: '/', title: 'Computer Root' },
      { id: 'project', path: '/repo', title: 'Project' },
    ],
    probeWorkspaceGit: async (dir) => (dir === '/' ? rootCap : capability()),
    captureFinalizationBoundary: async () => { throw new Error('must not capture'); },
  }));

  await assert.rejects(
    () => saveCardFinalizeRoutes.resolveBoundary({
      packageId: 'component:c1',
      targetWorkspaceId: 'computer-root',
    }),
    (error: unknown) => error instanceof Error
      && error.name === 'SaveCardFinalizeRefusalError'
      && (error as Error & { code?: string }).code === 'save-card-no-repository'
      && error.message.includes("workspace 'Computer Root'"),
  );
});

test('plan done resolver enriches identity from package state and fake checkpoint engine', async () => {
  const captures: Array<{ workspaceId: string; label: string }> = [];
  const boundaryOid = 'd'.repeat(40);
  const { planPreviewRoutes } = createPreviewRoutes(baseDeps({
    getPlanWorkPackage: (id) => id === 'wp-1' ? {
      id, workspaceId: 'ws-1', planId: 'plan-A', title: 'Package',
      acceptanceCondition: null, state: 'executing', assigneeAgentId: null,
      revision: 1, createdAt: 1, updatedAt: 1,
    } : null,
    listPlanWorkPackagePaths: (id) => id === 'wp-1' ? [{
      packageId: id, workspaceId: 'ws-1', path: 'src/e2.ts', intentKind: null, createdAt: 1,
    }] : [],
    assembleInventory: async () => read({
      inventory: inventory([entry('e1'), entry('e2')], ['e2']),
      components: [component('c1', ['e1'], 'plan-A', 'wp-1')],
    }),
    captureFinalizationBoundary: async (workspaceId, label) => {
      captures.push({ workspaceId, label });
      return { oid: boundaryOid, treeOid: 'e'.repeat(40) };
    },
  }));

  assert.ok(planPreviewRoutes.resolveFinalizeRequest);
  const result = await planPreviewRoutes.resolveFinalizeRequest!('wp-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(captures, [{
    workspaceId: 'ws-1', label: 'lares:finalization:plan-package:wp-1',
  }]);
  assert.equal(result.request.repositoryKey, REPO_KEY);
  assert.equal(result.request.boundaryOid, boundaryOid);
  assert.equal(result.request.repoRoot, '/repo');
  assert.equal(result.request.pinnedHeadOid, 'a'.repeat(40));
  assert.deepEqual(
    result.request.members.map((candidate) => candidate.path.pathBytesBase64).sort(),
    [b64('e1'), b64('e2')].sort(),
  );
});

test('plan done resolver refuses unresolved members before calling checkpoint engine', async () => {
  let captureCalls = 0;
  const { planPreviewRoutes } = createPreviewRoutes(baseDeps({
    getPlanWorkPackage: () => ({
      id: 'wp-empty', workspaceId: 'ws-1', planId: 'plan-A', title: 'Empty',
      acceptanceCondition: null, state: 'executing', assigneeAgentId: null,
      revision: 1, createdAt: 1, updatedAt: 1,
    }),
    listPlanWorkPackagePaths: () => [],
    assembleInventory: async () => read({
      components: [component('c1', ['e1'], 'plan-A', null)],
    }),
    captureFinalizationBoundary: async () => {
      captureCalls++;
      return { oid: 'f'.repeat(40), treeOid: 'f'.repeat(40) };
    },
  }));

  const result = await planPreviewRoutes.resolveFinalizeRequest!('wp-empty');
  assert.deepEqual(result, {
    ok: false,
    reason: 'plan-finalize-members-unresolvable',
    message: 'Cannot mark wp-empty done because no concrete dirty members resolve from its package stamps or planned paths.',
  });
  assert.equal(captureCalls, 0, 'an unresolved package never reaches the checkpoint oracle');
});

test('production coordinator seams reassemble a minted snapshot from the shared resolver', async () => {
  const routes = createPreviewRoutes(baseDeps({
    getPackageFinalization: (id) => (id === 'fin-1' ? finalization({
      memberManifestJson: JSON.stringify([{
        ...frozen('e1'),
        commitBlobOid: OID,
      }]),
    }) : null),
  }));
  const request = {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
  };
  const context = await routes.saveCardPreviewRoutes.resolvePreviewContext(request);
  const topology = computeCandidateTopologyDigest(context, ['c1'], []);
  const minted = routes.productionSeams.candidateService.mintCandidateToken({
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
    acknowledgeTopologyDigest: topology,
    acknowledgeUnattributedEntryIds: [],
  }, context) as CommitCandidate;
  assert.ok(minted.token, 'the production token store is the coordinator token store');
  const snapshot = routes.productionSeams.candidateService.resolveCandidateToken(minted.token!.tokenId);
  assert.ok(snapshot);

  const live = await routes.productionSeams.reassemble(snapshot!);
  assert.equal(live.candidateId, minted.candidateId);
  assert.equal(live.componentTopologyDigest, topology);
  assert.equal(live.eligible, true);
  assert.deepEqual(live.members.map((member) => member.entryId), ['e1']);
  assert.deepEqual(routes.productionSeams.locateRepository(snapshot!), { repoRoot: '/repo', gitExe: 'git' });
  assert.deepEqual(routes.productionSeams.deriveTrailers(snapshot!), [
    `Lares-Candidate: ${minted.candidateId}`,
    'Lares-Turn: t1',
    'Lares-Plan: plan-A',
  ]);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} preview-routes tests passed`);
})();
