import assert from 'node:assert/strict';
import { PROTECTION_RUNG_ORDER } from './commit-candidates';
import {
  BUNDLE_CONTRACT_VERSION,
  COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY,
  RETENTION_PIN_MAX_EXTENSION_MS,
  RETENTION_PIN_QUOTA_BYTES,
  SAVE_CARD_COMMIT_COORDINATOR_ENABLED,
} from './constants';
import type {
  BundleAssociation,
  BundleCaptureHealth,
  BundleOverlap,
  CandidateMember,
  CommitCandidate,
  CommitCandidateToken,
  CommitEligibility,
  CommitOutcome,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  FinalizationMemberDisposition,
  FinalizationRef,
  MintCandidateTokenRequest,
  PackageVerificationState,
  ProtectionRung,
  RepositoryIdentity,
  RequestedPlanBinding,
  ResolvedPlanStamp,
  SaveRefusal,
  SelectionPreview,
  TurnCaptureState,
} from './commit-candidates';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type ExportShapes = [
  Assert<Equal<RepositoryIdentity, {
    repositoryKey: string;
    objectDatabaseKey: string;
    gitObjectFormat: 'sha1' | 'sha256';
    bareRepo: false;
    workspaces: Array<{ workspaceId: string; workspacePrefix: string }>;
  }>>,
  Assert<Equal<EncodedGitPath, {
    pathBytesBase64: string;
    displayPath: string;
    utf8Clean: boolean;
  }>>,
  Assert<Equal<DirtyInventory, {
    repository: RepositoryIdentity;
    entries: DirtyEntry[];
    unattributedEntryIds: string[];
    topologyDigest: string;
  }>>,
  Assert<Equal<DirtyEntry, {
    entryId: string;
    path: EncodedGitPath;
    originalPath: EncodedGitPath | null;
    entryKind: 'ordinary' | 'rename-or-copy' | 'unmerged' | 'untracked';
    indexStatus: string;
    worktreeStatus: string;
    headMode: string | null;
    indexMode: string | null;
    worktreeMode: string | null;
    submoduleState: string | null;
    renameOrCopyScore: string | null;
    expectedWorktreeState: 'present' | 'absent';
    rawWorktreeBlobOid: string | null;
    gitLevelEligibility: 'supported' | 'unsupported-git-state';
    commitPathspecs: EncodedGitPath[];
  }>>,
  Assert<Equal<ConflictComponent, {
    componentId: string;
    dirtyEntryIds: string[];
    associations: BundleAssociation[];
    overlap: BundleOverlap;
    componentTopologyDigest: string;
  }>>,
  Assert<Equal<BundleAssociation, {
    planId: string | null;
    planItemId: string | null;
    contributingTurnIds: string[];
    memberEntryIds: string[];
  }>>,
  Assert<Equal<BundleOverlap, {
    componentId: string;
    contributingAgentCount: number;
    mergedGroupCount: number;
    perPathContributors: Record<string, {
      turnIds: string[];
      agentIds: string[];
      planIds: (string | null)[];
    }>;
    requiresOverlapAck: boolean;
  }>>,
  Assert<Equal<CommitCandidate, {
    candidateId: string;
    contractVersion: number;
    repository: RepositoryIdentity;
    componentIds: string[];
    selectedUnattributedEntryIds: string[];
    members: CandidateMember[];
    finalizations: FinalizationRef[];
    eligibility: CommitEligibility;
    token: CommitCandidateToken | null;
  }>>,
  Assert<Equal<SelectionPreview, {
    componentIds: string[];
    selectedUnattributedEntryIds: string[];
    members: CandidateMember[];
    eligibility: CommitEligibility;
  }>>,
  Assert<Equal<CandidateMember, {
    entryId: string;
    path: EncodedGitPath;
    expectedWorktreeState: 'present' | 'absent';
    rawWorktreeBlobOid: string | null;
    expectedCommitBlobOid: string | null;
    expectedCommitMode: string | null;
    checkpointMode: string | null;
    coveringFinalizationIds: string[];
    packageVerification: PackageVerificationState;
    protection: ProtectionRung;
  }>>,
  Assert<Equal<FinalizationRef, {
    finalizationId: string;
    packageId: string;
    packageRevision: number;
    boundaryStatus: string;
  }>>,
  Assert<Equal<PackageVerificationState,
    | 'verified-match' | 'verified-mismatch'
    | 'package-not-finalized' | 'final-checkpoint-unavailable' | 'unsupported-entry'>>,
  Assert<Equal<CommitEligibility,
    | { eligible: true }
    | {
        eligible: false;
        reason:
          'byte-mismatch' | 'package-not-finalized' | 'checkpoint-unavailable'
          | 'finalization-conflict' | 'component-subset-not-allowed' | 'extraneous-finalization'
          | 'unattributed-not-acknowledged' | 'overlap-not-acknowledged'
          | 'compose-in-flight' | 'unsupported-git-state';
      }>>,
  Assert<Equal<FinalizationMemberDisposition,
    | { state: 'selected-in-candidate'; entryId: string }
    | { state: 'already-locally-committed'; commitOid: string }>>,
  Assert<Equal<RequestedPlanBinding,
    | { mode: 'agent-default' }
    | { mode: 'explicit'; planId: string; planItemId: string | null }
    | { mode: 'none' }>>,
  Assert<Equal<ResolvedPlanStamp, {
    planId: string | null;
    planItemId: string | null;
    source: 'explicit' | 'agent-default' | 'fork-carry' | 'revive-carry'
      | 'continuation-carry' | 'explicit-none' | 'unbound-manual';
  }>>,
  Assert<Equal<TurnCaptureState, {
    turnId: string;
    beforeEdge: 'verified-live' | 'ready-hint-only' | 'pruned' | 'absent';
    afterEdge: 'verified-live' | 'ready-hint-only' | 'pruned' | 'absent';
    beforeQuality: 'guaranteed' | 'late' | 'degraded' | null;
    afterQuality: 'hook' | 'session-log' | 'terminal' | 'idle-fallback' | 'none' | null;
    failureClass: 'none' | 'overlap' | 'delivery-failed' | 'capture-outage' | 'skipped' | 'other';
  }>>,
  Assert<Equal<BundleCaptureHealth, {
    turns: TurnCaptureState[];
    captureOutage: boolean;
    pathsWithoutFinalizationEdge: string[];
  }>>,
  Assert<Equal<ProtectionRung,
    'unprotected' | 'checkpoint-protected' | 'locally-committed' | 'remote-reachable'>>,
  Assert<Equal<MintCandidateTokenRequest, {
    selectedComponentIds: string[];
    selectedUnattributedEntryIds: string[];
    finalizationIds: string[];
    acknowledgeTopologyDigest: string | null;
    acknowledgeUnattributedEntryIds: string[];
  }>>,
  Assert<Equal<CommitCandidateToken, {
    tokenId: string;
    candidateId: string;
    contractVersion: number;
    issuedAt: number;
    expiresAt: number;
  }>>,
  Assert<Equal<CommitOutcome,
    | {
        status: 'committed';
        commitOid: string;
        attemptId: string;
        indexIntegrity: 'verified' | 'mismatch' | 'unavailable';
        indexMismatchedPaths?: EncodedGitPath[];
        currentHeadDrift?: { resolvedHeadOid: string };
      }
    | {
        status: 'committed-integrity-mismatch';
        commitOid: string;
        attemptId: string;
        mismatchedPaths: EncodedGitPath[];
        indexIntegrity: 'verified' | 'mismatch' | 'unavailable';
        indexMismatchedPaths?: EncodedGitPath[];
        currentHeadDrift?: { resolvedHeadOid: string };
      }
    | {
        status: 'repository-state-uncertain';
        pinnedHeadOid: string;
        resolvedHeadOid: string;
        attemptId: string;
      }
    | { status: 'aborted-stale'; reason: string; attemptId: string }
    | { status: 'aborted-error'; reason: string; attemptId: string }>>,
];

assert.deepEqual(PROTECTION_RUNG_ORDER, {
  unprotected: 0,
  'checkpoint-protected': 1,
  'locally-committed': 2,
  'remote-reachable': 3,
});
const typedRefusal: SaveRefusal = {
  stage: 'reconciliation', code: 'ledger-write-failed', message: 'Reconciliation stage refused.', paths: ['cGF0aA=='],
};
assert.equal(typedRefusal.stage, 'reconciliation');
assert.equal(BUNDLE_CONTRACT_VERSION, 1);
assert.equal(COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY, 128);
assert.equal(RETENTION_PIN_QUOTA_BYTES, 536_870_912);
assert.equal(RETENTION_PIN_MAX_EXTENSION_MS, 2_592_000_000);
assert.equal(SAVE_CARD_COMMIT_COORDINATOR_ENABLED, true);

console.log('commit-candidates export shape: ok');
