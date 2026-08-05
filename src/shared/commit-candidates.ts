export interface RepositoryIdentity {
  repositoryKey: string;
  objectDatabaseKey: string;
  gitObjectFormat: 'sha1' | 'sha256';
  bareRepo: false;
  workspaces: Array<{ workspaceId: string; workspacePrefix: string }>;
}

export type SaveRefusalStage =
  | 'saveability'
  | 'boundary-capture'
  | 'freeze'
  | 'preview-verify'
  | 'mint'
  | 'token-consume'
  | 'commit'
  | 'reconciliation';

/** Renderer-safe, pipeline-wide refusal. `paths` contains authoritative Git
 * path bytes (base64), never renderer-derived membership. */
export interface SaveRefusal {
  stage: SaveRefusalStage;
  code: string;
  message: string;
  paths?: string[];
}

export interface EncodedGitPath {
  pathBytesBase64: string;
  displayPath: string;
  utf8Clean: boolean;
}

export interface DirtyInventory {
  repository: RepositoryIdentity;
  entries: DirtyEntry[];
  unattributedEntryIds: string[];
  topologyDigest: string;
}

export interface DirtyEntry {
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
}

export interface ConflictComponent {
  componentId: string;
  dirtyEntryIds: string[];
  associations: BundleAssociation[];
  overlap: BundleOverlap;
  componentTopologyDigest: string;
}

export interface BundleAssociation {
  planId: string | null;
  planItemId: string | null;
  contributingTurnIds: string[];
  memberEntryIds: string[];
}

export interface BundleOverlap {
  componentId: string;
  contributingAgentCount: number;
  mergedGroupCount: number;
  perPathContributors: Record<string, {
    turnIds: string[];
    agentIds: string[];
    planIds: (string | null)[];
  }>;
  requiresOverlapAck: boolean;
}

export interface CommitCandidate {
  candidateId: string;
  contractVersion: number;
  repository: RepositoryIdentity;
  componentIds: string[];
  selectedUnattributedEntryIds: string[];
  members: CandidateMember[];
  finalizations: FinalizationRef[];
  eligibility: CommitEligibility;
  token: CommitCandidateToken | null;
}

export interface SelectionPreview {
  componentIds: string[];
  selectedUnattributedEntryIds: string[];
  members: CandidateMember[];
  eligibility: CommitEligibility;
}

export interface CandidateMember {
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
}

export interface FinalizationRef {
  finalizationId: string;
  packageId: string;
  packageRevision: number;
  boundaryStatus: string;
}

export type PackageVerificationState =
  | 'verified-match' | 'verified-mismatch'
  | 'package-not-finalized' | 'final-checkpoint-unavailable' | 'unsupported-entry';

export type CommitEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        'byte-mismatch' | 'package-not-finalized' | 'checkpoint-unavailable'
        | 'finalization-conflict' | 'component-subset-not-allowed' | 'extraneous-finalization'
        | 'unattributed-not-acknowledged' | 'overlap-not-acknowledged'
        | 'compose-in-flight' | 'unsupported-git-state';
    };

export type FinalizationMemberDisposition =
  | { state: 'selected-in-candidate'; entryId: string }
  | { state: 'already-locally-committed'; commitOid: string };

export type RequestedPlanBinding =
  | { mode: 'agent-default' }
  | { mode: 'explicit'; planId: string; planItemId: string | null }
  | { mode: 'none' };

export interface ResolvedPlanStamp {
  planId: string | null;
  planItemId: string | null;
  source: 'explicit' | 'agent-default' | 'fork-carry' | 'revive-carry'
        | 'continuation-carry' | 'explicit-none' | 'unbound-manual';
}

export interface TurnCaptureState {
  turnId: string;
  beforeEdge: 'verified-live' | 'ready-hint-only' | 'pruned' | 'absent';
  afterEdge: 'verified-live' | 'ready-hint-only' | 'pruned' | 'absent';
  beforeQuality: 'guaranteed' | 'late' | 'degraded' | null;
  afterQuality: 'hook' | 'session-log' | 'terminal' | 'idle-fallback' | 'none' | null;
  failureClass: 'none' | 'overlap' | 'delivery-failed' | 'capture-outage' | 'skipped' | 'other';
}

export interface BundleCaptureHealth {
  turns: TurnCaptureState[];
  captureOutage: boolean;
  pathsWithoutFinalizationEdge: string[];
}

export type ProtectionRung = 'unprotected' | 'checkpoint-protected' | 'locally-committed' | 'remote-reachable';
export const PROTECTION_RUNG_ORDER: Record<ProtectionRung, number> =
  { 'unprotected': 0, 'checkpoint-protected': 1, 'locally-committed': 2, 'remote-reachable': 3 };

export interface MintCandidateTokenRequest {
  selectedComponentIds: string[];
  selectedUnattributedEntryIds: string[];
  finalizationIds: string[];
  acknowledgeTopologyDigest: string | null;
  acknowledgeUnattributedEntryIds: string[];
}

export interface CommitCandidateToken {
  tokenId: string;
  candidateId: string;
  contractVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export type CommitOutcome =
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
  | { status: 'aborted-error'; reason: string; attemptId: string };

/**
 * SC-WP-2L — renderer-safe quota-weakening warning surfaced on the Save card.
 *
 * Structurally mirrors the retention pin policy's `RetentionPinWeakeningWarning`
 * (`src/main/git-checkpoints/protection-policy.ts`) so the WP-2K pass result can
 * be threaded through the Save-card inventory response without re-shaping. It is
 * populated only when the retention pin quota (or max-extension) forces the
 * release of at least one still-dirty recovery edge. `willWeakenPaths` and
 * `releasedEdges` carry dirty-entry / turn identities only — NEVER raw paths.
 */
export interface SaveCardQuotaWeakening {
  quotaBytes: number;
  usedBytes: number;
  releasedEdges: Array<{ turnId: string; edge: 'before' | 'after' }>;
  willWeakenPaths: string[];
}
