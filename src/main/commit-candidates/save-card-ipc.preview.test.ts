// SC-WP-3H — Save-lens candidate preview IPC contract.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/save-card-ipc.preview.test.js
//
// Covers: request validation (bad workspaceId / non-array selection fields);
// unavailable-until-injected honesty; the handler wires the pure WP-3G
// `buildCandidate` over a route-resolved context; an unfinalized selection yields
// a previewable-never-committable `SelectionPreview`; a finalization-backed,
// verified selection yields an eligible `CommitCandidate`; and the READ-ONLY
// server `Lares-*` trailer previews are derived from the immutable snapshot
// (turns / plans / finalizations), never renderer input.

import assert from 'node:assert/strict';

import {
  registerSaveCardPreviewIpc,
  type IpcLike,
  type SaveCardPreviewRoutes,
} from './save-card-ipc';
import { SAVECARD_PREVIEW_CHANNEL, type SaveCardPreviewResponse } from '../../shared/types';
import type {
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  RepositoryIdentity,
  SelectionPreview,
  CommitCandidate,
} from '../../shared/commit-candidates';
import {
  CommitCandidateService,
  type CandidateBuildContext,
  type CandidateServiceDeps,
} from './candidate-service';
import type { CommitRepresentation } from './commit-representation';
import type { PackageFinalization } from '../database';
import type { FrozenManifestMember } from './finalization-service';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const REPO_KEY = 'repo-key-1';

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
    path: { pathBytesBase64: `b64-${id}`, displayPath: `src/${id}.ts`, utf8Clean: true },
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
    commitPathspecs: [],
    ...over,
  };
}

function component(componentId: string, entryIds: string[], over: Partial<ConflictComponent> = {}): ConflictComponent {
  return {
    componentId,
    dirtyEntryIds: entryIds,
    associations: [{ planId: 'plan-A', planItemId: null, contributingTurnIds: ['t1', 't2'], memberEntryIds: entryIds }],
    overlap: {
      componentId,
      contributingAgentCount: 1,
      mergedGroupCount: 1,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: `topo-${componentId}`,
    ...over,
  };
}

function inventory(entries: DirtyEntry[], unattributedEntryIds: string[] = []): DirtyInventory {
  return { repository: repository(), entries, unattributedEntryIds, topologyDigest: 'inv-topo' };
}

function baseContext(over: Partial<CandidateBuildContext> = {}): CandidateBuildContext {
  const e1 = entry('e1');
  return {
    repository: repository(),
    inventory: inventory([e1]),
    components: [component('c1', ['e1'])],
    finalizations: [],
    currentCommitReps: new Map<string, CommitRepresentation>(),
    ledger: [],
    pinnedHeadOid: 'HEAD-OID',
    indexFingerprint: { fingerprint: 'fp-1', entries: [], hasUnmerged: false, writeTreeOid: null },
    contractVersion: 1,
    ...over,
  };
}

function frozen(entryId: string): FrozenManifestMember {
  return {
    pathBytesBase64: `b64-${entryId}`,
    expectedState: 'present',
    rawBlobOid: `raw-${entryId}`,
    commitBlobOid: `commit-${entryId}`,
    commitMode: '100644',
  };
}

function finalization(over: Partial<PackageFinalization> = {}): PackageFinalization {
  return {
    id: 'fin-1',
    packageId: 'pkg-1',
    repositoryKey: REPO_KEY,
    finalizationKind: 'fleet-adhoc',
    planId: null,
    planItemId: null,
    packageRevision: 3,
    finalizedAt: 1,
    finalizedBy: 'human-ipc',
    checkpointTurnId: null,
    checkpointOid: 'boundary-oid',
    boundaryRef: 'refs/lares/fin-1',
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify([frozen('e1')]),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: null,
    ...over,
  };
}

function routesFor(context: CandidateBuildContext): SaveCardPreviewRoutes {
  return { resolvePreviewContext: async () => context };
}

// ── tests ───────────────────────────────────────────────────────────────────

test('an unwired preview engine answers unavailable honestly', async () => {
  const ipc = new FakeIpc();
  registerSaveCardPreviewIpc(ipc, () => null);
  await assert.rejects(
    () => ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
      workspaceId: 'ws-1', selectedComponentIds: [], selectedUnattributedEntryIds: [], finalizationIds: [],
    }),
    /save-card preview engine unavailable|bootstrapping/i,
  );
});

test('rejects malformed preview requests before resolving context', async () => {
  const ipc = new FakeIpc();
  let resolved = 0;
  registerSaveCardPreviewIpc(ipc, () => ({
    resolvePreviewContext: async () => { resolved++; return baseContext(); },
  }));

  await assert.rejects(() => ipc.invoke(SAVECARD_PREVIEW_CHANNEL, null), /non-empty workspaceId/i);
  await assert.rejects(() => ipc.invoke(SAVECARD_PREVIEW_CHANNEL, { workspaceId: '' }), /non-empty workspaceId/i);
  await assert.rejects(
    () => ipc.invoke(SAVECARD_PREVIEW_CHANNEL, { workspaceId: 'ws-1', selectedComponentIds: 'c1' }),
    /must be an array of strings/i,
  );
  assert.equal(resolved, 0);
});

test('unfinalized selection yields a previewable, never-committable SelectionPreview', async () => {
  const ipc = new FakeIpc();
  registerSaveCardPreviewIpc(ipc, () => routesFor(baseContext()));

  const response = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: [],
  })) as SaveCardPreviewResponse;

  assert.equal(response.isCandidate, false);
  const preview = response.candidate as SelectionPreview;
  assert.equal(preview.eligibility.eligible, false);
  assert.equal(preview.members.length, 1);
  assert.equal(preview.members[0].packageVerification, 'package-not-finalized');
  // Server-derived read-only trailers from the immutable snapshot: turns + plan.
  assert.deepEqual(response.laresTrailers, ['Lares-Turns: 2', 'Lares-Plan: plan-A']);
});

test('finalization-backed, verified selection yields an eligible CommitCandidate + finalization trailer', async () => {
  const ipc = new FakeIpc();
  const context = baseContext({
    finalizations: [finalization()],
    currentCommitReps: new Map<string, CommitRepresentation>([
      ['e1', { expectedState: 'present', rawBlobOid: 'raw-e1', commitBlobOid: 'commit-e1', commitMode: '100644' }],
    ]),
  });
  registerSaveCardPreviewIpc(ipc, () => routesFor(context));

  const response = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
  })) as SaveCardPreviewResponse;

  assert.equal(response.isCandidate, true);
  const candidate = response.candidate as CommitCandidate;
  assert.equal(candidate.eligibility.eligible, true);
  assert.equal(candidate.members[0].packageVerification, 'verified-match');
  assert.ok(typeof candidate.candidateId === 'string' && candidate.candidateId.length > 0);
  assert.deepEqual(response.laresTrailers, [
    'Lares-Turns: 2', 'Lares-Plan: plan-A', 'Lares-Finalization: pkg-1@3',
  ]);
  assert.equal(response.requiresOverlapAck, false);
  assert.deepEqual(response.unacknowledgedUnattributedEntryIds, []);
});

test('overlap component + selected unattributed entry surface the acknowledgement gates', async () => {
  const ipc = new FakeIpc();
  const e1 = entry('e1');
  const eu = entry('eu');
  const overlapComponent = component('c1', ['e1'], {
    overlap: {
      componentId: 'c1', contributingAgentCount: 2, mergedGroupCount: 2,
      perPathContributors: {}, requiresOverlapAck: true,
    },
  });
  const context = baseContext({
    inventory: inventory([e1, eu], ['eu']),
    components: [overlapComponent],
  });
  registerSaveCardPreviewIpc(ipc, () => routesFor(context));

  const response = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: ['eu'],
    finalizationIds: [],
  })) as SaveCardPreviewResponse;

  assert.equal(response.requiresOverlapAck, true);
  assert.deepEqual(response.unacknowledgedUnattributedEntryIds, ['eu']);
});

// ── SC-WP-W6 — mint the commit token on the preview leg ───────────────────────
//
// LIVE BLOCKER regression. After W5 removed the "Computer Root has no repository"
// refusal, a pinned, byte-verified package (e.g. 15 untracked-but-not-ignored
// proposal files in the pane's real repo) reached the preview leg and STILL
// refused with the generic "did not produce a committable candidate". Root cause:
// the production preview called `buildCandidate` (which always returns
// `token: null`) and NEVER minted — but the renderer's decisive submit requires
// `candidate.token`. `mintCandidateToken` existed but was dead code, wired to no
// IPC, so the commit-coordinator token store was always empty. These tests lock
// the preview leg minting an eligible package's token (so submit can consume it)
// while staying read-only for a display-only preview and preserving the human
// acknowledgement gates.

function serviceBackedRoutes(context: CandidateBuildContext): {
  routes: SaveCardPreviewRoutes;
  service: CommitCandidateService;
} {
  const service = new CommitCandidateService({ tokenStore: {} } as unknown as CandidateServiceDeps);
  return {
    service,
    routes: {
      resolvePreviewContext: async () => context,
      mintCandidateToken: (request, ctx) => service.mintCandidateToken(request, ctx),
    },
  };
}

function eligibleContext(): CandidateBuildContext {
  return baseContext({
    finalizations: [finalization()],
    currentCommitReps: new Map<string, CommitRepresentation>([
      ['e1', { expectedState: 'present', rawBlobOid: 'raw-e1', commitBlobOid: 'commit-e1', commitMode: '100644' }],
    ]),
  });
}

test('mintIfEligible mints a commit token for an eligible, no-overlap package', async () => {
  const ipc = new FakeIpc();
  const { routes, service } = serviceBackedRoutes(eligibleContext());
  registerSaveCardPreviewIpc(ipc, () => routes);

  const response = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
    mintIfEligible: true,
  })) as SaveCardPreviewResponse;

  assert.equal(response.isCandidate, true);
  const candidate = response.candidate as CommitCandidate;
  assert.equal(candidate.eligibility.eligible, true);
  assert.ok(candidate.token, 'an eligible no-overlap package mints a token so submit can consume it');
  assert.ok(candidate.token && candidate.token.tokenId.length > 0);
  // Coordinator integrity: the minted token resolves in the same service store the
  // consume channel binds against — the commit path can actually find it.
  assert.ok(service.resolveCandidateToken(candidate.token!.tokenId));
  assert.equal(candidate.token!.candidateId, candidate.candidateId);
});

test('a display-only preview (no mintIfEligible) stays read-only — no token minted', async () => {
  const ipc = new FakeIpc();
  const { routes } = serviceBackedRoutes(eligibleContext());
  registerSaveCardPreviewIpc(ipc, () => routes);

  const response = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
  })) as SaveCardPreviewResponse;

  assert.equal(response.isCandidate, true);
  const candidate = response.candidate as CommitCandidate;
  assert.equal(candidate.eligibility.eligible, true);
  assert.equal(candidate.token, null);
});

test('minting preserves the human ack gate: a selected unattributed atom refuses typed', async () => {
  const ipc = new FakeIpc();
  const e1 = entry('e1');
  const eu = entry('eu');
  const context = baseContext({
    inventory: inventory([e1, eu], ['eu']),
    components: [component('c1', ['e1'])],
    finalizations: [finalization({ memberManifestJson: JSON.stringify([frozen('e1'), frozen('eu')]) })],
    currentCommitReps: new Map<string, CommitRepresentation>([
      ['e1', { expectedState: 'present', rawBlobOid: 'raw-e1', commitBlobOid: 'commit-e1', commitMode: '100644' }],
      ['eu', { expectedState: 'present', rawBlobOid: 'raw-eu', commitBlobOid: 'commit-eu', commitMode: '100644' }],
    ]),
  });
  const { routes } = serviceBackedRoutes(context);
  registerSaveCardPreviewIpc(ipc, () => routes);

  // Submit intent WITHOUT forwarding the unattributed acknowledgement: minting must
  // refuse typed with the specific reason, never auto-ack the human's behalf.
  const response = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: ['eu'],
    finalizationIds: ['fin-1'],
    mintIfEligible: true,
  })) as SaveCardPreviewResponse;

  const candidate = response.candidate as CommitCandidate;
  assert.equal(candidate.eligibility.eligible, false);
  assert.equal(
    candidate.eligibility.eligible === false ? candidate.eligibility.reason : null,
    'unattributed-not-acknowledged',
  );
  assert.equal(candidate.token, null);
  assert.deepEqual(response.unacknowledgedUnattributedEntryIds, ['eu']);

  // Forwarding the acknowledgement (the human checked the box) mints the token.
  const acked = (await ipc.invoke(SAVECARD_PREVIEW_CHANNEL, {
    workspaceId: 'ws-1',
    selectedComponentIds: ['c1'],
    selectedUnattributedEntryIds: ['eu'],
    finalizationIds: ['fin-1'],
    mintIfEligible: true,
    acknowledgeUnattributedEntryIds: ['eu'],
  })) as SaveCardPreviewResponse;
  const ackedCandidate = acked.candidate as CommitCandidate;
  assert.equal(ackedCandidate.eligibility.eligible, true);
  assert.ok(ackedCandidate.token, 'forwarding the unattributed ack lets the token mint');
});

(async () => {
  let failed = 0;
  for (const entryCase of tests) {
    try {
      await entryCase.run();
      console.log(`  ✓ ${entryCase.name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${entryCase.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} save-card-ipc preview tests passed`);
})();
