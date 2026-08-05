import assert from 'node:assert/strict';

import {
  COMMIT_CANDIDATE_MINT_CHANNEL,
  SAVECARD_PREVIEW_CHANNEL,
  type SaveCardMintRequest,
  type SaveCardMintResponse,
} from '../../shared/types';
import type {
  CommitCandidate,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  RepositoryIdentity,
} from '../../shared/commit-candidates';
import type { PackageFinalization } from '../database';
import type { FrozenManifestMember } from './finalization-service';
import type { CommitRepresentation } from './commit-representation';
import {
  CommitCandidateService,
  buildCandidate,
  computeCandidateTopologyDigest,
  type CandidateBuildContext,
  type CandidateServiceDeps,
} from './candidate-service';
import { ComposeLockRegistry } from './compose-lock-registry';
import {
  registerSaveCardMintIpc,
  registerSaveCardPreviewIpc,
  type IpcLike,
  type SaveCardMintRoutes,
  type SaveCardPreviewRoutes,
} from './save-card-ipc';

type Handler = (_event: unknown, ...args: unknown[]) => unknown;
class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke(channel: string, request: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, request);
  }
}

const REPOSITORY_KEY = 'repo-key';
function repository(): RepositoryIdentity {
  return {
    repositoryKey: REPOSITORY_KEY,
    objectDatabaseKey: 'odb-key',
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}
function entry(id: string): DirtyEntry {
  return {
    entryId: id,
    path: { pathBytesBase64: `path-${id}`, displayPath: `${id}.txt`, utf8Clean: true },
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
  };
}
function component(member: DirtyEntry): ConflictComponent {
  return {
    componentId: 'component-1',
    dirtyEntryIds: [member.entryId],
    associations: [{
      planId: 'plan-1',
      planItemId: null,
      contributingTurnIds: ['turn-1'],
      memberEntryIds: [member.entryId],
    }],
    overlap: {
      componentId: 'component-1',
      contributingAgentCount: 1,
      mergedGroupCount: 1,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: 'component-topology',
  };
}
function frozen(member: DirtyEntry): FrozenManifestMember {
  return {
    pathBytesBase64: member.path.pathBytesBase64,
    expectedState: 'present',
    rawBlobOid: member.rawWorktreeBlobOid,
    commitBlobOid: `commit-${member.entryId}`,
    commitMode: '100644',
  };
}
function finalization(member: DirtyEntry): PackageFinalization {
  return {
    id: 'fin-1', packageId: 'pkg-1', repositoryKey: REPOSITORY_KEY,
    finalizationKind: 'fleet-adhoc', planId: null, planItemId: null,
    packageRevision: 1, finalizedAt: 1, finalizedBy: 'human-ipc',
    checkpointTurnId: null, checkpointOid: 'boundary', boundaryRef: 'refs/lares/fin-1',
    boundaryStatus: 'ready', lifecycleStatus: 'active', supersededByFinalizationId: null,
    releasedAt: null, memberManifestJson: JSON.stringify([frozen(member)]), contractVersion: 1,
    failureReason: null, createdFromWorkspaceId: 'ws-1',
  };
}
function context(unattributed = false): CandidateBuildContext {
  const member = entry('entry-1');
  const inventory: DirtyInventory = {
    repository: repository(), entries: [member],
    unattributedEntryIds: unattributed ? [member.entryId] : [], topologyDigest: 'inventory-topology',
  };
  return {
    repository: repository(), inventory,
    components: unattributed ? [] : [component(member)],
    finalizations: [finalization(member)],
    currentCommitReps: new Map<string, CommitRepresentation>([[member.entryId, {
      expectedState: 'present', rawBlobOid: member.rawWorktreeBlobOid,
      commitBlobOid: `commit-${member.entryId}`, commitMode: '100644',
    }]]),
    ledger: [], pinnedHeadOid: 'head',
    indexFingerprint: { fingerprint: 'fingerprint', entries: [], hasUnmerged: false, writeTreeOid: null },
    contractVersion: 1,
  };
}

function harness(
  ctx: CandidateBuildContext,
  composeLocks = new ComposeLockRegistry(),
  telemetry?: (event: { stage: import('../../shared/commit-candidates').SaveRefusalStage; code: string }) => void,
) {
  const service = new CommitCandidateService({ tokenStore: { composeLocks } } as CandidateServiceDeps);
  const routes: SaveCardMintRoutes = {
    mintCandidate: async (req) => ({
      candidate: service.mintCandidateToken({
        selectedComponentIds: req.selectedComponentIds,
        selectedUnattributedEntryIds: req.selectedUnattributedEntryIds,
        finalizationIds: req.finalizationIds,
        acknowledgeTopologyDigest: req.acknowledgeTopologyDigest,
        acknowledgeUnattributedEntryIds: req.acknowledgeUnattributedEntryIds,
      }, ctx),
      context: ctx,
    }),
  };
  const ipc = new FakeIpc();
  registerSaveCardMintIpc(ipc, () => routes, telemetry);
  return { ipc, service };
}

function overlapContext(changedTopology = false): CandidateBuildContext {
  const members = [entry('entry-1'), entry('entry-2'), entry('entry-3')];
  const components = members.map((member, index) => {
    const value = component(member);
    const componentId = `component-${index + 1}`;
    return {
      ...value,
      componentId,
      overlap: { ...value.overlap, componentId, requiresOverlapAck: true, contributingAgentCount: 2 },
      componentTopologyDigest: changedTopology && index === 1 ? 'topology-moved' : `topology-${index + 1}`,
    };
  });
  const finalizations = members.map((member, index) => ({
    ...finalization(member), id: `fin-${index + 1}`, packageId: `pkg-${index + 1}`,
    boundaryRef: `refs/lares/fin-${index + 1}`,
  }));
  const base = context();
  return {
    ...base,
    inventory: { ...base.inventory, entries: members },
    components,
    finalizations,
    currentCommitReps: new Map(members.map((member) => [member.entryId, {
      expectedState: 'present' as const,
      rawBlobOid: member.rawWorktreeBlobOid,
      commitBlobOid: `commit-${member.entryId}`,
      commitMode: '100644',
    }])),
  };
}

function overlapHarness(previewCtx: CandidateBuildContext, mintCtx: CandidateBuildContext) {
  const service = new CommitCandidateService({ tokenStore: {} } as CandidateServiceDeps);
  const previewRoutes: SaveCardPreviewRoutes = {
    resolvePreviewContext: async () => previewCtx,
  };
  const mintRoutes: SaveCardMintRoutes = {
    mintCandidate: async (req) => ({
      candidate: service.mintCandidateToken({
        selectedComponentIds: req.selectedComponentIds,
        selectedUnattributedEntryIds: req.selectedUnattributedEntryIds,
        finalizationIds: req.finalizationIds,
        acknowledgeTopologyDigest: req.acknowledgeTopologyDigest,
        acknowledgeUnattributedEntryIds: req.acknowledgeUnattributedEntryIds,
      }, mintCtx),
      context: mintCtx,
    }),
  };
  const ipc = new FakeIpc();
  registerSaveCardPreviewIpc(ipc, () => previewRoutes, () => undefined);
  registerSaveCardMintIpc(ipc, () => mintRoutes, () => undefined);
  return ipc;
}
function request(ctx: CandidateBuildContext, unattributed = false): SaveCardMintRequest {
  const selectedComponentIds = unattributed ? [] : ['component-1'];
  const selectedUnattributedEntryIds = unattributed ? ['entry-1'] : [];
  return {
    workspaceId: 'ws-1', selectedComponentIds, selectedUnattributedEntryIds,
    finalizationIds: ['fin-1'],
    acknowledgeTopologyDigest: computeCandidateTopologyDigest(
      ctx, selectedComponentIds,
      ctx.inventory.entries.filter((item) => selectedUnattributedEntryIds.includes(item.entryId)),
    ),
    acknowledgeUnattributedEntryIds: selectedUnattributedEntryIds,
  };
}
function candidate(response: SaveCardMintResponse): CommitCandidate {
  assert.equal(response.isCandidate, true);
  assert.ok('candidateId' in response.candidate);
  return response.candidate;
}

async function mint(ipc: FakeIpc, req: SaveCardMintRequest): Promise<SaveCardMintResponse> {
  return ipc.invoke(COMMIT_CANDIDATE_MINT_CHANNEL, req) as Promise<SaveCardMintResponse>;
}

(async () => {
  const ctx = context();
  const { ipc, service } = harness(ctx);
  const response = await mint(ipc, request(ctx));
  const minted = candidate(response);
  assert.equal(minted.eligibility.eligible, true);
  assert.ok(minted.token);
  const previewed = buildCandidate({
    selectedComponentIds: request(ctx).selectedComponentIds,
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1'],
  }, ctx) as CommitCandidate;
  assert.equal(minted.candidateId, previewed.candidateId);
  assert.equal(response.componentTopologyDigest, request(ctx).acknowledgeTopologyDigest);
  assert.equal(service.resolveCandidateToken(minted.token!.tokenId)?.candidate.candidateId, minted.candidateId);

  const telemetry: Array<{ stage: string; code: string }> = [];
  const telemetryHarness = harness(ctx, new ComposeLockRegistry(), (event) => telemetry.push(event));
  await mint(telemetryHarness.ipc, request(ctx));
  assert.deepEqual(telemetry, [{ stage: 'mint', code: 'mint-token-issued' }]);
  assert.deepEqual(Object.keys(telemetry[0]).sort(), ['code', 'stage']);

  const staleResponse = await mint(ipc, { ...request(ctx), acknowledgeTopologyDigest: 'stale' });
  const stale = candidate(staleResponse);
  assert.deepEqual(stale.eligibility, { eligible: false, reason: 'overlap-not-acknowledged' });
  assert.equal(stale.token, null);
  assert.equal(staleResponse.refusal?.stage, 'mint');
  assert.equal(staleResponse.refusal?.code, 'acknowledgement-stale');
  const missing = candidate(await mint(ipc, { ...request(ctx), acknowledgeTopologyDigest: null }));
  assert.deepEqual(missing.eligibility, { eligible: false, reason: 'overlap-not-acknowledged' });
  assert.equal(missing.token, null);

  const unattributed = context(true);
  const unattributedHarness = harness(unattributed);
  const missingAckResponse = await mint(unattributedHarness.ipc, {
    ...request(unattributed, true), acknowledgeUnattributedEntryIds: [],
  });
  const missingAck = candidate(missingAckResponse);
  assert.deepEqual(missingAck.eligibility, { eligible: false, reason: 'unattributed-not-acknowledged' });
  assert.equal(missingAck.token, null);
  assert.equal(missingAckResponse.refusal?.code, 'acknowledgement-stale');

  const locks = new ComposeLockRegistry();
  const lease = locks.tryAcquire(REPOSITORY_KEY);
  assert.ok(lease);
  const lockedHarness = harness(ctx, locks);
  const lockedResponse = await mint(lockedHarness.ipc, request(ctx));
  const locked = candidate(lockedResponse);
  assert.deepEqual(locked.eligibility, { eligible: false, reason: 'compose-in-flight' });
  assert.equal(locked.token, null);
  assert.equal(lockedResponse.refusal?.code, 'mint-refused');
  lease!.release();

  await assert.rejects(
    () => ipc.invoke(COMMIT_CANDIDATE_MINT_CHANNEL, { ...request(ctx), tokenId: 'renderer-token' }),
    /unexpected mint request field/i,
  );

  const overlapSelection = {
    workspaceId: 'ws-1',
    selectedComponentIds: ['component-1', 'component-2', 'component-3'],
    selectedUnattributedEntryIds: [],
    finalizationIds: ['fin-1', 'fin-2', 'fin-3'],
  };
  const stableIpc = overlapHarness(overlapContext(), overlapContext());
  const overlapPreview = await stableIpc.invoke(SAVECARD_PREVIEW_CHANNEL, overlapSelection) as import('../../shared/types').SaveCardPreviewResponse;
  assert.equal(overlapPreview.requiresOverlapAck, true);
  const overlapMint = await mint(stableIpc, {
    ...overlapSelection,
    acknowledgeTopologyDigest: overlapPreview.componentTopologyDigest,
    acknowledgeUnattributedEntryIds: overlapPreview.unacknowledgedUnattributedEntryIds,
  });
  assert.ok(candidate(overlapMint).token, 'preview challenge echoed through a separate context mints');
  assert.deepEqual(overlapMint.unacknowledgedUnattributedEntryIds, overlapPreview.unacknowledgedUnattributedEntryIds);

  const movedIpc = overlapHarness(overlapContext(), overlapContext(true));
  const beforeMove = await movedIpc.invoke(SAVECARD_PREVIEW_CHANNEL, overlapSelection) as import('../../shared/types').SaveCardPreviewResponse;
  const moved = await mint(movedIpc, {
    ...overlapSelection,
    acknowledgeTopologyDigest: beforeMove.componentTopologyDigest,
    acknowledgeUnattributedEntryIds: beforeMove.unacknowledgedUnattributedEntryIds,
  });
  assert.equal(moved.refusal?.code, 'acknowledgement-stale');
  assert.deepEqual(candidate(moved).eligibility, { eligible: false, reason: 'overlap-not-acknowledged' });
  assert.equal(candidate(moved).token, null);
  console.log('All save-card mint IPC tests passed');
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
