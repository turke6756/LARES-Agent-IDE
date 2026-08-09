// SC-WP-4B — mint validation, immutable in-memory token store, CAS, TTL/LRU,
// restart invalidation, and compose-lock refusal while inventory reads remain live.

import assert from 'node:assert/strict';

import type { FrozenManifestMember } from './finalization-service';
import type { PackageFinalization } from '../database';
import type { CommitRepresentation } from './commit-representation';
import type { IndexFingerprintResult } from './index-fingerprint';
import type {
  CommitCandidate,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  MintCandidateTokenRequest,
  CrossIntentChallengeAtom,
  RepositoryIdentity,
} from '../../shared/commit-candidates';
import {
  CommitCandidateService,
  buildCandidate,
  type CandidateBuildContext,
  type CandidateServiceDeps,
  type CandidateTokenStoreOptions,
} from './candidate-service';
import { ComposeLockRegistry } from './compose-lock-registry';

const REPOSITORY_KEY = 'r'.repeat(64);
let componentSequence = 0;
let finalizationSequence = 0;

function pathOf(relative: string): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from(relative, 'utf8').toString('base64'),
    displayPath: relative,
    utf8Clean: true,
  };
}

function entry(relative: string): DirtyEntry {
  const path = pathOf(relative);
  return {
    entryId: `entry-${relative}`,
    path,
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
    rawWorktreeBlobOid: `raw-${relative}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [path],
  };
}

function repository(repositoryKey = REPOSITORY_KEY): RepositoryIdentity {
  return {
    repositoryKey,
    objectDatabaseKey: `odb-${repositoryKey}`,
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}

function inventory(repo: RepositoryIdentity, entries: DirtyEntry[], unattributed: string[]): DirtyInventory {
  return { repository: repo, entries, unattributedEntryIds: unattributed, topologyDigest: 'inventory-topology' };
}

function component(entries: DirtyEntry[], topology = `topology-${++componentSequence}`): ConflictComponent {
  const componentId = `component-${componentSequence}`;
  return {
    componentId,
    dirtyEntryIds: entries.map((item) => item.entryId),
    associations: [{
      planId: 'plan-1',
      planItemId: null,
      contributingTurnIds: ['turn-1'],
      memberEntryIds: entries.map((item) => item.entryId),
    }],
    overlap: {
      componentId,
      contributingAgentCount: 1,
      mergedGroupCount: 1,
      perPathContributors: {},
      requiresOverlapAck: false,
    },
    componentTopologyDigest: topology,
  };
}

function frozen(relative: string, commitBlobOid = `commit-${relative}`): FrozenManifestMember {
  return {
    pathBytesBase64: pathOf(relative).pathBytesBase64,
    expectedState: 'present',
    rawBlobOid: `raw-${relative}`,
    commitBlobOid,
    commitMode: '100644',
  };
}

function finalization(members: FrozenManifestMember[], id = `fin-${++finalizationSequence}`): PackageFinalization {
  return {
    id,
    packageId: `package-${id}`,
    repositoryKey: REPOSITORY_KEY,
    finalizationKind: 'fleet-adhoc',
    planId: null,
    planItemId: null,
    packageRevision: 1,
    finalizedAt: 100,
    finalizedBy: 'human-ipc',
    checkpointTurnId: null,
    checkpointOid: 'o'.repeat(40),
    boundaryRef: `refs/lares/finalizations/${id}/1`,
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify(members),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: 'ws-1',
  };
}

function representation(member: FrozenManifestMember): CommitRepresentation {
  return {
    expectedState: member.expectedState,
    rawBlobOid: member.rawBlobOid,
    commitBlobOid: member.commitBlobOid,
    commitMode: member.commitMode,
  };
}

function context(options: {
  entries?: DirtyEntry[];
  components?: ConflictComponent[];
  finalizations?: PackageFinalization[];
  unattributed?: string[];
  repository?: RepositoryIdentity;
} = {}): CandidateBuildContext {
  const repo = options.repository ?? repository();
  const entries = options.entries ?? [];
  const finalizations = options.finalizations ?? [];
  const frozenByPath = new Map<string, FrozenManifestMember>();
  for (const item of finalizations) {
    for (const member of JSON.parse(item.memberManifestJson) as FrozenManifestMember[]) {
      frozenByPath.set(member.pathBytesBase64, member);
    }
  }
  const reps = new Map<string, CommitRepresentation>();
  for (const item of entries) {
    const member = frozenByPath.get(item.path.pathBytesBase64);
    if (member) reps.set(item.entryId, representation(member));
  }
  const fingerprint: IndexFingerprintResult = {
    fingerprint: 'index-fingerprint-3g',
    entries: [],
    hasUnmerged: false,
    writeTreeOid: 't'.repeat(40),
  };
  return {
    repository: repo,
    inventory: inventory(repo, entries, options.unattributed ?? []),
    components: options.components ?? [],
    finalizations,
    currentCommitReps: reps,
    ledger: [],
    pinnedHeadOid: 'h'.repeat(40),
    indexFingerprint: fingerprint,
    contractVersion: 1,
  };
}

function service(tokenStore: CandidateTokenStoreOptions = {}): CommitCandidateService {
  return new CommitCandidateService({ tokenStore } as CandidateServiceDeps);
}

function requestFor(ctx: CandidateBuildContext, components: string[], unattributed: string[], fins: string[]): MintCandidateTokenRequest {
  return {
    selectedComponentIds: components,
    selectedUnattributedEntryIds: unattributed,
    finalizationIds: fins,
    acknowledgeUnattributedEntryIds: unattributed,
  };
}

function asCandidate(value: ReturnType<CommitCandidateService['mintCandidateToken']>): CommitCandidate {
  assert.ok('candidateId' in value);
  return value;
}

// 1–3: component expansion, full coverage, and manifest agreement are delegated
// to the canonical 3G assembler and must gate minting.
{
  const a = entry('a.ts');
  const b = entry('b.ts');
  const comp = component([a, b]);
  const fin = finalization([frozen('a.ts'), frozen('b.ts')]);
  const ctx = context({ entries: [a, b], components: [comp], finalizations: [fin] });
  const minted = asCandidate(service().mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  assert.deepEqual(minted.members.map((member) => member.entryId), [a.entryId, b.entryId]);
  assert.ok(minted.token, 'whole component expansion mints when fully covered');

  const partialFin = finalization([frozen('a.ts')]);
  const partialCtx = context({ entries: [a, b], components: [comp], finalizations: [partialFin] });
  const uncovered = asCandidate(service().mintCandidateToken(requestFor(partialCtx, [comp.componentId], [], [partialFin.id]), partialCtx));
  assert.deepEqual(uncovered.eligibility, { eligible: false, reason: 'package-not-finalized' });
  assert.equal(uncovered.token, null);

  const conflicting = finalization([frozen('a.ts', 'different'), frozen('b.ts')]);
  const conflictCtx = context({ entries: [a, b], components: [comp], finalizations: [fin, conflicting] });
  const conflict = asCandidate(service().mintCandidateToken(
    requestFor(conflictCtx, [comp.componentId], [], [fin.id, conflicting.id]), conflictCtx));
  assert.deepEqual(conflict.eligibility, { eligible: false, reason: 'finalization-conflict' });
  assert.equal(conflict.token, null);
}

// 4–6: unattributed acknowledgements are validated; legacy topology-digest ack
// keys are ignored compatibility fields (v2 resolution gating replaces topology
// acks; WP-7 removes the keys); duplicate ack values normalize before the
// immutable snapshot is stored.
{
  const loose = entry('loose.txt');
  const fin = finalization([frozen('loose.txt')]);
  const ctx = context({ entries: [loose], unattributed: [loose.entryId], finalizations: [fin] });
  const valid = requestFor(ctx, [], [loose.entryId], [fin.id]);

  const unacked = asCandidate(service().mintCandidateToken({ ...valid, acknowledgeUnattributedEntryIds: [] }, ctx));
  assert.deepEqual(unacked.eligibility, { eligible: false, reason: 'unattributed-not-acknowledged' });
  assert.equal(unacked.token, null);

  const store = service();
  const minted = asCandidate(store.mintCandidateToken({
    ...valid,
    selectedUnattributedEntryIds: [loose.entryId, loose.entryId],
    acknowledgeUnattributedEntryIds: [loose.entryId, loose.entryId],
  }, ctx));
  const snapshot = store.resolveCandidateToken(minted.token!.tokenId)!;
  const snapshotRequest = snapshot.normalizedRequest as MintCandidateTokenRequest;
  assert.deepEqual(snapshotRequest.selectedUnattributedEntryIds, [loose.entryId]);
  assert.deepEqual(snapshotRequest.acknowledgeUnattributedEntryIds, [loose.entryId]);
}

// 7–10: acknowledgement validation uses the resolved pin selection rather than
// the stale/raw forwarded set, while retaining both negative gates.
{
  const x = entry('x.txt');
  const y = entry('y.txt');
  const z = entry('z.txt');
  const fin = finalization([frozen('x.txt'), frozen('y.txt')]);
  fin.packageId = `unattributed:${REPOSITORY_KEY}`;
  const ctx = context({
    entries: [x, y, z],
    unattributed: [x.entryId, y.entryId, z.entryId],
    finalizations: [fin],
  });
  const rawIds = [x.entryId, y.entryId, z.entryId];
  const built = asCandidate(buildCandidate({
    selectedComponentIds: [], selectedUnattributedEntryIds: rawIds, finalizationIds: [fin.id],
  }, ctx));
  assert.deepEqual(built.selectedUnattributedEntryIds, [x.entryId, y.entryId]);
  const request: MintCandidateTokenRequest = {
    selectedComponentIds: [], selectedUnattributedEntryIds: rawIds, finalizationIds: [fin.id],
    acknowledgeUnattributedEntryIds: built.selectedUnattributedEntryIds,
  };
  const store = service();
  const minted = asCandidate(store.mintCandidateToken(request, ctx));
  assert.ok(minted.token, 'raw selection drift outside the frozen manifest still mints');
  assert.deepEqual(
    store.resolveCandidateToken(minted.token!.tokenId)!.normalizedRequest.acknowledgeUnattributedEntryIds,
    [x.entryId, y.entryId],
  );

  const clean = asCandidate(service().mintCandidateToken({
    ...request,
    selectedUnattributedEntryIds: built.selectedUnattributedEntryIds,
  }, ctx));
  assert.ok(clean.token, 'clean raw-equals-resolved pin still mints');

  const missingResolved = asCandidate(service().mintCandidateToken({
    ...request, acknowledgeUnattributedEntryIds: [x.entryId],
  }, ctx));
  assert.deepEqual(missingResolved.eligibility, { eligible: false, reason: 'unattributed-not-acknowledged' });
  assert.equal(missingResolved.token, null);
}

// 11: the server snapshot carries 3G's fingerprint/pin/manifests and is immutable.
{
  const a = entry('snapshot.ts');
  const comp = component([a]);
  const fin = finalization([frozen('snapshot.ts')]);
  const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
  const store = service();
  const minted = asCandidate(store.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  const snapshot = store.resolveCandidateToken(minted.token!.tokenId)!;
  assert.equal(snapshot.indexFingerprint, 'index-fingerprint-3g');
  assert.equal(snapshot.pinnedHeadOid, 'h'.repeat(40));
  assert.equal(snapshot.finalizationManifests[0].memberManifestJson, fin.memberManifestJson);
  assert.deepEqual(snapshot.commitEffects, [{
    pathBytesBase64: a.path.pathBytesBase64,
    operation: 'write',
    expectedState: 'present',
    rawBlobOid: 'raw-snapshot.ts',
    commitBlobOid: 'commit-snapshot.ts',
    commitMode: '100644',
  }]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.commitEffects), true);
  assert.equal(Object.isFrozen(snapshot.candidate.members), true);
}

// 8: default policy is five minutes and expiration invalidates an issued token.
{
  let now = 1_000;
  const a = entry('ttl.ts');
  const comp = component([a]);
  const fin = finalization([frozen('ttl.ts')]);
  const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
  const store = service({ now: () => now });
  const minted = asCandidate(store.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  assert.equal(minted.token!.expiresAt - minted.token!.issuedAt, 5 * 60 * 1000);
  now = minted.token!.expiresAt;
  assert.equal(store.resolveCandidateToken(minted.token!.tokenId), null);
}

// 9–10: CAS admits one consumer; arbitrary pre-CAS reads/transient failures leave issued.
{
  const a = entry('cas.ts');
  const comp = component([a]);
  const fin = finalization([frozen('cas.ts')]);
  const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
  const store = service();
  const first = asCandidate(store.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  assert.ok(store.resolveCandidateToken(first.token!.tokenId), 'pre-CAS resolution succeeds');
  assert.equal(store.tokenState(first.token!.tokenId), 'issued', 'pre-CAS transient does not consume');
  assert.ok(store.tryMarkTokenConsuming(first.token!.tokenId));
  assert.equal(store.tryMarkTokenConsuming(first.token!.tokenId), null);
  assert.equal(store.tokenState(first.token!.tokenId), 'consuming');
  assert.equal(store.markTokenConsumed(first.token!.tokenId), true);
  assert.equal(store.tokenState(first.token!.tokenId), null, 'consumed tokens are invalidated');
}

// 11: the production default enforces exactly 128 live tokens per repository.
{
  let tokenByte = 1;
  const store = service({ randomTokenBytes: () => Buffer.alloc(32, tokenByte++) });
  const tokenIds: string[] = [];
  for (let index = 0; index < 129; index += 1) {
    const name = `cap-${index}.ts`;
    const a = entry(name);
    const comp = component([a]);
    const fin = finalization([frozen(name)]);
    const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
    const minted = asCandidate(store.mintCandidateToken(
      requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
    tokenIds.push(minted.token!.tokenId);
  }
  assert.equal(store.tokenState(tokenIds[0]), null, 'token 129 evicts the oldest issued token');
  assert.equal(store.tokenState(tokenIds[1]), 'issued');
  assert.equal(store.tokenState(tokenIds[128]), 'issued');
}

// 12: repository LRU eviction never selects a consuming token.
{
  let tokenByte = 1;
  const store = service({
    tokenCapPerRepository: 2,
    randomTokenBytes: () => Buffer.alloc(32, tokenByte++),
  });
  const mintNamed = (name: string): CommitCandidate => {
    const a = entry(name);
    const comp = component([a]);
    const fin = finalization([frozen(name)]);
    const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
    return asCandidate(store.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  };
  const one = mintNamed('one.ts');
  const two = mintNamed('two.ts');
  assert.ok(store.tryMarkTokenConsuming(one.token!.tokenId));
  const three = mintNamed('three.ts');
  assert.equal(store.tokenState(one.token!.tokenId), 'consuming');
  assert.equal(store.tokenState(two.token!.tokenId), null, 'oldest issued token was evicted');
  assert.equal(store.tokenState(three.token!.tokenId), 'issued');
}

// 13: a new service (application restart) has no persisted token state.
{
  const a = entry('restart.ts');
  const comp = component([a]);
  const fin = finalization([frozen('restart.ts')]);
  const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
  const beforeRestart = service();
  const minted = asCandidate(beforeRestart.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  assert.equal(service().resolveCandidateToken(minted.token!.tokenId), null);
}

// 14: an active compose lease refuses mint without creating a token. The read API
// remains an independent method (the latch changes no inventory state).
{
  const locks = new ComposeLockRegistry();
  const a = entry('locked.ts');
  const comp = component([a]);
  const fin = finalization([frozen('locked.ts')]);
  const ctx = context({ entries: [a], components: [comp], finalizations: [fin] });
  const store = service({ composeLocks: locks });
  const inventoryBefore = structuredClone(ctx.inventory);
  const lease = locks.tryAcquire(REPOSITORY_KEY)!;
  const refused = asCandidate(store.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  assert.deepEqual(refused.eligibility, { eligible: false, reason: 'compose-in-flight' });
  assert.equal(refused.token, null);
  assert.deepEqual(refused.members.map((member) => member.entryId), [a.entryId],
    'refusal still returns the renderable candidate inventory');
  assert.deepEqual(ctx.inventory, inventoryBefore, 'refusal does not mutate inventory state');
  lease.release();
  const minted = asCandidate(store.mintCandidateToken(requestFor(ctx, [comp.componentId], [], [fin.id]), ctx));
  assert.ok(minted.token);
}

// WP-4 v2: intent documents and evidence-bound resolutions are required and
// become part of candidate identity/token state.
{
  const priorFlag = process.env.LARES_INTENT_PACKAGING;
  process.env.LARES_INTENT_PACKAGING = '1';
  const shared = entry('shared.ts');
  const one = finalization([frozen('shared.ts')], 'fin-intent-a');
  const two = finalization([frozen('shared.ts')], 'fin-intent-b');
  one.packageId = 'intent-a'; two.packageId = 'intent-b';
  one.contractVersion = 2; two.contractVersion = 2;
  const base = context({ entries: [shared], finalizations: [one, two] });
  const atom: CrossIntentChallengeAtom = {
    kind: 'cross-intent', atomId: 'cross:shared:a:b', digest: 'atom-digest', reasonVersion: 1,
    pathBytesBase64: shared.path.pathBytesBase64, displayPath: 'shared.ts',
    earlierIntentId: 'intent-a', laterIntentId: 'intent-b', evidenceDigest: 'evidence-v1',
    resolution: null,
  };
  const ctx: CandidateBuildContext = {
    ...base, contractVersion: 2,
    intentUnits: [
      { intentId: 'intent-a', kind: 'task', revision: 1, title: 'First task', planId: 'plan', planItemId: 'item-a', memberEntryIds: [shared.entryId] },
      { intentId: 'intent-b', kind: 'task', revision: 1, title: 'Second task', planId: 'plan', planItemId: 'item-b', memberEntryIds: [shared.entryId] },
    ],
    reviewChallengeAtoms: [atom],
    attributionResolutions: [{
      resolutionId: 'resolution-1', evidenceDigest: 'evidence-v1', resolution: 'commit-together',
      affectedPathBytesBase64: [shared.path.pathBytesBase64], intentIds: ['intent-a', 'intent-b'],
    }],
  };
  const request = {
    selectedIntentIds: ['intent-a', 'intent-b'], selectedNamedSaveSetIds: [],
    resolutionIds: [], finalizationIds: [one.id, two.id],
  };
  const missing = asCandidate(service().mintCandidateTokenV2(request, ctx));
  assert.deepEqual(missing.eligibility, { eligible: false, reason: 'resolution-required' });
  const minted = asCandidate(service().mintCandidateTokenV2({ ...request, resolutionIds: ['resolution-1'] }, ctx));
  assert.equal(minted.contractVersion, 2);
  assert.deepEqual(minted.saveIntentIds, ['intent-a', 'intent-b']);
  assert.ok(minted.token);
  if (priorFlag === undefined) delete process.env.LARES_INTENT_PACKAGING;
  else process.env.LARES_INTENT_PACKAGING = priorFlag;
}

console.log('candidate-service.mint: v1 refusals + v2 intent/resolution contract passed');
