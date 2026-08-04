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

function component(componentId: string, entryIds: string[], planId: string | null = 'plan-A'): ConflictComponent {
  return {
    componentId,
    dirtyEntryIds: entryIds,
    associations: [{ planId, planItemId: null, contributingTurnIds: ['t1'], memberEntryIds: entryIds }],
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
    /unknown target workspace/i,
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

  const context = await saveCardFinalizeRoutes.resolveBoundary({ packageId: 'component:c1' });
  assert.deepEqual(calls, [{ workspaceId: 'ws-1', label: 'lares:finalization:component:c1' }]);
  assert.equal(context.boundaryOid, boundaryOid, 'the fake engine OID is the durable boundary input');
  assert.equal(context.repositoryKey, REPO_KEY);
  assert.equal(context.members.length, 1);
  assert.equal(context.members[0].path.pathBytesBase64, b64('e1'));
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
