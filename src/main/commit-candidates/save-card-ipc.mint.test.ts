import assert from 'node:assert/strict';

import {
  COMMIT_CANDIDATE_MINT_CHANNEL,
  type SaveCardMintRequestV2,
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
  buildCandidateV2,
  type CandidateBuildContext,
  type CandidateServiceDeps,
} from './candidate-service';
import { ComposeLockRegistry } from './compose-lock-registry';
import {
  registerSaveCardMintIpc,
  type IpcLike,
  type SaveCardMintRoutes,
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
    repositoryKey: REPOSITORY_KEY, objectDatabaseKey: 'odb-key', gitObjectFormat: 'sha1',
    bareRepo: false, workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}
function entry(): DirtyEntry {
  const path = {
    pathBytesBase64: Buffer.from('entry-1.txt', 'utf8').toString('base64'),
    displayPath: 'entry-1.txt', utf8Clean: true,
  };
  return {
    entryId: 'entry-1', path, originalPath: null, entryKind: 'ordinary', indexStatus: '.',
    worktreeStatus: 'M', headMode: '100644', indexMode: '100644', worktreeMode: '100644',
    submoduleState: null, renameOrCopyScore: null, expectedWorktreeState: 'present',
    rawWorktreeBlobOid: 'raw-entry-1', gitLevelEligibility: 'supported', commitPathspecs: [path],
  };
}
function component(member: DirtyEntry): ConflictComponent {
  return {
    componentId: 'component-1', dirtyEntryIds: [member.entryId],
    associations: [{
      planId: 'plan-1', planItemId: 'item-1', contributingTurnIds: ['turn-1'],
      memberEntryIds: [member.entryId],
    }],
    overlap: {
      componentId: 'component-1', contributingAgentCount: 1, mergedGroupCount: 1,
      perPathContributors: {},
    },
    componentTopologyDigest: 'component-topology',
  };
}
function frozen(member: DirtyEntry): FrozenManifestMember {
  return {
    pathBytesBase64: member.path.pathBytesBase64, expectedState: 'present',
    rawBlobOid: member.rawWorktreeBlobOid, commitBlobOid: 'commit-entry-1', commitMode: '100644',
  };
}
function finalization(member: DirtyEntry): PackageFinalization {
  return {
    id: 'fin-1', packageId: 'intent-1', repositoryKey: REPOSITORY_KEY,
    finalizationKind: 'plan-package', planId: 'plan-1', planItemId: 'item-1',
    packageRevision: 1, finalizedAt: 1, finalizedBy: 'human-ipc', checkpointTurnId: null,
    checkpointOid: 'boundary', boundaryRef: 'refs/lares/fin-1', boundaryStatus: 'ready',
    lifecycleStatus: 'active', supersededByFinalizationId: null, releasedAt: null,
    memberManifestJson: JSON.stringify([frozen(member)]), contractVersion: 2,
    failureReason: null, createdFromWorkspaceId: 'ws-1',
  };
}
function context(): CandidateBuildContext {
  const member = entry();
  const inventory: DirtyInventory = {
    repository: repository(), entries: [member], unattributedEntryIds: [],
    topologyDigest: 'inventory-topology',
  };
  return {
    repository: repository(), inventory, components: [component(member)],
    finalizations: [finalization(member)],
    currentCommitReps: new Map<string, CommitRepresentation>([[member.entryId, {
      expectedState: 'present', rawBlobOid: member.rawWorktreeBlobOid,
      commitBlobOid: 'commit-entry-1', commitMode: '100644',
    }]]),
    ledger: [], pinnedHeadOid: 'head',
    indexFingerprint: { fingerprint: 'fingerprint', entries: [], hasUnmerged: false, writeTreeOid: null },
    contractVersion: 2,
    intentUnits: [{
      intentId: 'intent-1', kind: 'task', revision: 1, title: 'Task one',
      planId: 'plan-1', planItemId: 'item-1', memberEntryIds: [member.entryId],
      contributingTurnIds: ['turn-1'],
    }],
  };
}
function request(): SaveCardMintRequestV2 {
  return {
    workspaceId: 'ws-1', selectedIntentIds: ['intent-1'], selectedNamedSaveSetIds: [],
    resolutionIds: [], finalizationIds: ['fin-1'],
  };
}
function candidate(response: SaveCardMintResponse): CommitCandidate {
  assert.equal(response.isCandidate, true);
  assert.ok('candidateId' in response.candidate);
  return response.candidate;
}
function harness(composeLocks = new ComposeLockRegistry(), telemetry?: (event: { stage: import('../../shared/commit-candidates').SaveRefusalStage; code: string }) => void) {
  const ctx = context();
  const service = new CommitCandidateService({ tokenStore: { composeLocks } } as CandidateServiceDeps);
  const routes: SaveCardMintRoutes = {
    mintCandidate: async (req: SaveCardMintRequestV2) => ({
      candidate: service.mintCandidateTokenV2(req, ctx), context: ctx,
    }),
  };
  const ipc = new FakeIpc();
  registerSaveCardMintIpc(ipc, () => routes, telemetry);
  return { ipc, service, ctx };
}
async function mint(ipc: FakeIpc, req: SaveCardMintRequestV2): Promise<SaveCardMintResponse> {
  return ipc.invoke(COMMIT_CANDIDATE_MINT_CHANNEL, req) as Promise<SaveCardMintResponse>;
}

(async () => {
  const { ipc, service, ctx } = harness();
  const response = await mint(ipc, request());
  const minted = candidate(response);
  assert.equal(minted.contractVersion, 2);
  assert.deepEqual(minted.saveIntentIds, ['intent-1']);
  assert.ok(minted.token);
  const previewed = buildCandidateV2(request(), ctx) as CommitCandidate;
  assert.equal(minted.candidateId, previewed.candidateId);
  assert.equal(service.resolveCandidateToken(minted.token!.tokenId)?.candidate.candidateId, minted.candidateId);

  const telemetry: Array<{ stage: string; code: string }> = [];
  const observed = harness(new ComposeLockRegistry(), (event) => telemetry.push(event));
  await mint(observed.ipc, request());
  assert.deepEqual(telemetry, [{ stage: 'mint', code: 'mint-token-issued' }]);

  const locks = new ComposeLockRegistry();
  const lease = locks.tryAcquire(REPOSITORY_KEY);
  assert.ok(lease);
  const locked = candidate(await mint(harness(locks).ipc, request()));
  assert.deepEqual(locked.eligibility, { eligible: false, reason: 'compose-in-flight' });
  assert.equal(locked.token, null);
  lease!.release();

  await assert.rejects(
    () => ipc.invoke(COMMIT_CANDIDATE_MINT_CHANNEL, {
      ...request(), selectedComponentIds: ['component-1'],
    }),
    /unexpected mint request field/i,
  );
  console.log('All save-card mint IPC tests passed');
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
