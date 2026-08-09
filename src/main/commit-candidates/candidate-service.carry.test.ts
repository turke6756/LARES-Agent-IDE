import assert from 'node:assert/strict';

import {
  REVIEW_CHALLENGE_VERSION,
  REVIEWED_SEMANTIC_MANIFEST_VERSION,
  normalizeReviewedSemanticManifest,
  type NormalizedCommitEffect,
  type ReviewChallengeAtom,
  type ReviewedSemanticManifest,
} from '../../shared/commit-candidates';
import {
  evaluateReviewedManifestCarry,
  reviewedSemanticManifestDigest,
  type CandidateBuildContext,
  type CandidateLedgerLink,
} from './candidate-service';

const path64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const A = path64('new-name.ts');
const B = path64('old-name.ts');
const C = path64('other-source.ts');
const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);

const writeA: NormalizedCommitEffect = {
  pathBytesBase64: A,
  operation: 'write',
  expectedState: 'present',
  rawBlobOid: 'raw-a',
  commitBlobOid: 'clean-a',
  commitMode: '100644',
};
const deleteB: NormalizedCommitEffect = {
  pathBytesBase64: B,
  operation: 'delete',
  expectedState: 'absent',
  rawBlobOid: null,
  commitBlobOid: null,
  commitMode: null,
};
const contributor = {
  pathBytesBase64: A,
  turnId: 'turn-1',
  agentId: 'agent-1',
  ownerAgentId: 'owner-1',
  planId: 'plan-1',
  planItemId: 'item-1',
};

function atom(path = A, digest = 'atom-digest'): ReviewChallengeAtom {
  return {
    kind: 'unattributed',
    atomId: `unattributed:${path}`,
    digest,
    pathBytesBase64: path,
    memberEffectDigest: `member:${digest}`,
  };
}

function manifest(): ReviewedSemanticManifest {
  const frozenMembers = [{
    pathBytesBase64: A,
    expectedState: 'present' as const,
    rawBlobOid: 'raw-a',
    commitBlobOid: 'clean-a',
    commitMode: '100644',
  }];
  return normalizeReviewedSemanticManifest({
    manifestVersion: REVIEWED_SEMANTIC_MANIFEST_VERSION,
    candidateContractVersion: 7,
    repositoryKey: 'repo-key',
    objectDatabaseKey: 'object-db',
    gitObjectFormat: 'sha1',
    finalizations: [{
      finalizationId: 'fin-1',
      packageId: 'pkg-1',
      packageRevision: 3,
      boundaryStatus: 'ready',
      frozenMemberManifestDigest: 'frozen-digest',
      frozenMembers,
    }],
    members: [{
      finalPathBytesBase64: A,
      expectedState: 'present',
      rawBlobOid: 'raw-a',
      commitBlobOid: 'clean-a',
      commitMode: '100644',
      coveringFinalizationIds: ['fin-1'],
      commitEffects: [writeA, deleteB],
    }],
    attributionTopology: {
      componentPathSets: [[A]],
      contributors: [contributor],
      ownershipGroupKeys: ['["owner-1","plan-1","item-1"]'],
      componentEdges: [],
      selectedUnattributedPathBytesBase64: [],
    },
    closureObligations: [],
    challengeVersion: REVIEW_CHALLENGE_VERSION,
    challengeAtoms: [],
  });
}

function context(overrides: Partial<CandidateBuildContext> = {}): CandidateBuildContext {
  return {
    pinnedHeadOid: HEAD_2,
    ledger: [],
    indexFingerprint: { fingerprint: 'fresh-index', entries: [], hasUnmerged: false, writeTreeOid: null },
    ...overrides,
  } as CandidateBuildContext;
}

function verdict(
  reviewed: ReviewedSemanticManifest,
  fresh: ReviewedSemanticManifest,
  ctx = context(),
  acknowledged: readonly ReviewChallengeAtom[] = fresh.challengeAtoms,
  discharged: ReadonlySet<string> = new Set(),
) {
  return evaluateReviewedManifestCarry(
    reviewed,
    fresh,
    acknowledged,
    ctx,
    { eligible: true },
    discharged,
  );
}

{
  const reviewed = manifest();
  const fresh = structuredClone(reviewed);
  const result = verdict(reviewed, fresh, context({ pinnedHeadOid: HEAD_2 }));
  assert.equal(result.carried, true, 'HEAD movement alone must carry');
  assert.equal(reviewedSemanticManifestDigest(reviewed), reviewedSemanticManifestDigest(fresh));
}

{
  const reviewed = manifest();
  const mutations: Array<[string, (fresh: ReviewedSemanticManifest) => void]> = [
    ['clean-filtered blob', (fresh) => { fresh.members[0].commitEffects[0].commitBlobOid = 'changed-clean'; }],
    ['mode', (fresh) => { fresh.members[0].commitEffects[0].commitMode = '100755'; }],
    ['expected state', (fresh) => {
      Object.assign(fresh.members[0].commitEffects[0], {
        operation: 'delete', expectedState: 'absent', rawBlobOid: null, commitBlobOid: null, commitMode: null,
      });
    }],
    ['rename source/pathspec closure', (fresh) => { fresh.members[0].commitEffects[1].pathBytesBase64 = C; }],
    ['finalization revision', (fresh) => { fresh.finalizations[0].packageRevision++; }],
    ['contributor tuple', (fresh) => { fresh.attributionTopology.contributors[0].turnId = 'turn-2'; }],
    ['ownerAgentId', (fresh) => { fresh.attributionTopology.contributors[0].ownerAgentId = 'owner-2'; }],
    ['component partition', (fresh) => { fresh.attributionTopology.componentPathSets = [[A, B]]; }],
    ['overlap group', (fresh) => { fresh.attributionTopology.ownershipGroupKeys = ['changed-group']; }],
    ['unattributed set', (fresh) => { fresh.attributionTopology.selectedUnattributedPathBytesBase64 = [A]; }],
    ['new selected path', (fresh) => { fresh.members[0].commitEffects.push({ ...deleteB, pathBytesBase64: C }); }],
  ];
  for (const [name, mutate] of mutations) {
    const fresh = structuredClone(reviewed);
    mutate(fresh);
    assert.equal(verdict(reviewed, fresh).carried, false, `${name} must refuse`);
  }
}

{
  const reviewed = manifest();
  const fresh = structuredClone(reviewed);
  fresh.members[0].commitEffects = [writeA];
  const exactLink: CandidateLedgerLink = {
    commitOid: HEAD_2,
    pathBytesBase64: B,
    expectedState: 'absent',
    rawBlobOidAtCommit: null,
    commitBlobOid: null,
    commitMode: null,
  };
  const carried = verdict(reviewed, fresh, context({ ledger: [exactLink] }));
  assert.equal(carried.carried, true, 'exact current-HEAD ledger proof discharges one reviewed effect');
  assert.deepEqual(carried.carried ? carried.dischargedPathBytesBase64 : [], [B]);
  assert.equal(verdict(reviewed, fresh).carried, false, 'missing dirty entry alone is not proof');

  const ancestor = { ...exactLink, commitOid: HEAD_1 };
  assert.equal(verdict(reviewed, fresh, context({
    ledger: [ancestor],
    reachableCommitOids: new Set([HEAD_1]),
    currentHeadEntriesByPath: new Map([[B, {
      expectedState: 'absent', commitBlobOid: null, commitMode: null,
    }]]),
  })).carried, true, 'reachable ledger link plus exact current-HEAD entry proves discharge');

  assert.equal(
    verdict(reviewed, reviewed, context(), [], new Set([B])).carried,
    false,
    'a discharged path may never be reintroduced as pending',
  );
}

{
  const reviewed = manifest();
  reviewed.challengeAtoms = [atom(A, 'one'), atom(B, 'two')];
  const fresh = structuredClone(reviewed);
  fresh.members[0].commitEffects = [writeA];
  fresh.challengeAtoms = [atom(A, 'one')];
  const dischargeLink: CandidateLedgerLink = {
    commitOid: HEAD_2, pathBytesBase64: B, expectedState: 'absent',
    rawBlobOidAtCommit: null, commitBlobOid: null, commitMode: null,
  };
  assert.equal(verdict(reviewed, fresh, context({ ledger: [dischargeLink] }), reviewed.challengeAtoms).carried, true,
    'a discharged challenge subset remains covered');
  fresh.challengeAtoms = [atom(A, 'changed')];
  assert.equal(verdict(reviewed, fresh, context({ ledger: [dischargeLink] }), reviewed.challengeAtoms).carried, false,
    'a changed atom is not covered by an earlier acknowledgement');
}

{
  const reviewed = manifest();
  reviewed.closureObligations = [{
    finalizationId: 'fin-1', pathBytesBase64: C, expectedState: 'present',
    commitBlobOid: 'closed-blob', commitMode: '100644',
  }];
  const fresh = structuredClone(reviewed);
  const closureLink: CandidateLedgerLink = {
    commitOid: HEAD_2, pathBytesBase64: C, expectedState: 'present',
    commitBlobOid: 'closed-blob', commitMode: '100644',
  };
  assert.equal(verdict(reviewed, fresh, context({ ledger: [closureLink] })).carried, true);
  assert.equal(verdict(reviewed, fresh, context({ ledger: [{ ...closureLink, commitOid: undefined }] })).carried, false,
    'opening-preview closure state is never carried without a fresh reachable proof');
}

console.log('All reviewed-manifest carry tests passed');
