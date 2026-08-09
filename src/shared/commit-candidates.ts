import { Buffer } from 'node:buffer';

import { canonicalize } from '../main/commit-candidates/jcs';

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

/** Schema versions for the main-owned review contract and its challenge atoms. */
export const REVIEWED_SEMANTIC_MANIFEST_VERSION = 1 as const;
export const REVIEW_CHALLENGE_VERSION = 1 as const;

export interface ReviewedFrozenMember {
  pathBytesBase64: string;
  expectedState: 'present' | 'absent';
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

export interface ReviewedFinalizationIntent {
  finalizationId: string;
  packageId: string;
  packageRevision: number;
  boundaryStatus: 'ready';
  frozenMemberManifestDigest: string;
  frozenMembers: ReviewedFrozenMember[];
}

export type CommitEffectOperation = 'write' | 'delete' | 'retain';

/** One path in the complete pathspec closure of a reviewed logical member. */
export interface NormalizedCommitEffect {
  pathBytesBase64: string;
  operation: CommitEffectOperation;
  expectedState: 'present' | 'absent';
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

export interface ReviewedSemanticMember {
  finalPathBytesBase64: string;
  expectedState: 'present' | 'absent';
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
  coveringFinalizationIds: string[];
  commitEffects: NormalizedCommitEffect[];
}

export interface AttributionContributor {
  pathBytesBase64: string;
  turnId: string;
  agentId: string;
  ownerAgentId: string | null;
  planId: string | null;
  planItemId: string | null;
}

export interface AttributionComponentEdge {
  leftPathBytesBase64: string;
  rightPathBytesBase64: string;
}

export interface ReviewedAttributionTopology {
  componentPathSets: string[][];
  contributors: AttributionContributor[];
  ownershipGroupKeys: string[];
  componentEdges: AttributionComponentEdge[];
  requiresOverlapAck: boolean;
  selectedUnattributedPathBytesBase64: string[];
}

export interface ReviewedClosureObligation {
  finalizationId: string;
  pathBytesBase64: string;
  expectedState: 'present' | 'absent';
  commitBlobOid: string | null;
  commitMode: string | null;
}

export type CrossIntentResolution =
  | 'commit-together'
  | 'superseded-intentionally'
  | 'restore-lost-work';

/** Versioned, evidence-bound blocker: exactly one per path + intent pair. */
export interface CrossIntentChallengeAtom {
  kind: 'cross-intent';
  atomId: string;
  digest: string;
  reasonVersion: 1;
  pathBytesBase64: string;
  displayPath: string;
  earlierIntentId: string;
  laterIntentId: string;
  evidenceDigest: string;
  resolution: CrossIntentResolution | null;
}

export type ReviewChallengeAtom =
  | {
      kind: 'unattributed';
      atomId: string;
      digest: string;
      pathBytesBase64: string;
      memberEffectDigest: string;
    }
  | {
      kind: 'overlap';
      atomId: string;
      digest: string;
      reasonVersion: 1;
      memberPathBytesBase64: string[];
      contributors: AttributionContributor[];
      ownershipGroupKeys: string[];
    }
  | CrossIntentChallengeAtom;

/**
 * Main-process-only review contract. It deliberately excludes operational
 * candidate/token identity (HEAD, index fingerprint, candidate id and token id).
 */
export interface ReviewedSemanticManifest {
  manifestVersion: typeof REVIEWED_SEMANTIC_MANIFEST_VERSION;
  candidateContractVersion: number;
  repositoryKey: string;
  objectDatabaseKey: string;
  gitObjectFormat: 'sha1' | 'sha256';
  finalizations: ReviewedFinalizationIntent[];
  members: ReviewedSemanticMember[];
  attributionTopology: ReviewedAttributionTopology;
  closureObligations: ReviewedClosureObligation[];
  challengeVersion: typeof REVIEW_CHALLENGE_VERSION;
  challengeAtoms: ReviewChallengeAtom[];
}

export type CommitEffectChangeKind = 'write' | 'delete' | 'rename' | 'copy' | 'mode-change';

export interface CommitEffectRepresentation {
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

/** Inputs are already derived main-side from authoritative Git path bytes. */
export interface NormalizeCommitEffectsInput {
  changeKind: CommitEffectChangeKind;
  finalPathBytesBase64: string;
  finalRepresentation: CommitEffectRepresentation;
  originalPathBytesBase64?: string;
  /** Required for copy: the retained source can differ from the destination. */
  originalRepresentation?: CommitEffectRepresentation;
  commitPathspecs: string[];
  /** Exact post-commit effects for pathspecs other than final/original paths. */
  additionalPathspecEffects?: NormalizedCommitEffect[];
}

function comparePathBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'base64'), Buffer.from(b, 'base64'));
}

function assertCanonicalPathBytes(value: string): void {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.includes(0) || bytes.toString('base64') !== value) {
    throw new Error('Commit-effect paths must be canonical base64, non-empty, and contain no NUL.');
  }
}

function effectFor(
  pathBytesBase64: string,
  operation: CommitEffectOperation,
  representation: CommitEffectRepresentation,
): NormalizedCommitEffect {
  const expectedState = operation === 'delete' ? 'absent' : 'present';
  if (expectedState === 'absent') {
    return { pathBytesBase64, operation, expectedState, rawBlobOid: null, commitBlobOid: null, commitMode: null };
  }
  if (!representation.rawBlobOid || !representation.commitBlobOid || !representation.commitMode) {
    throw new Error(`A present commit effect requires raw, commit-blob, and mode evidence for ${pathBytesBase64}.`);
  }
  return { pathBytesBase64, operation, expectedState, ...representation };
}

/**
 * Produces a path-byte-sorted, duplicate-free pathspec closure. Rename sources
 * are deletions; copy sources are explicit retained effects and are never guessed.
 */
export function normalizeCommitEffects(input: NormalizeCommitEffectsInput): NormalizedCommitEffect[] {
  const requiredPaths = new Set(input.commitPathspecs);
  requiredPaths.add(input.finalPathBytesBase64);
  for (const path of requiredPaths) assertCanonicalPathBytes(path);

  const effects: NormalizedCommitEffect[] = [effectFor(
    input.finalPathBytesBase64,
    input.changeKind === 'delete' ? 'delete' : 'write',
    input.finalRepresentation,
  )];

  if (input.changeKind === 'rename' || input.changeKind === 'copy') {
    if (!input.originalPathBytesBase64) {
      throw new Error(`${input.changeKind} normalization requires an original path.`);
    }
    assertCanonicalPathBytes(input.originalPathBytesBase64);
    requiredPaths.add(input.originalPathBytesBase64);
    effects.push(effectFor(
      input.originalPathBytesBase64,
      input.changeKind === 'rename' ? 'delete' : 'retain',
      input.originalRepresentation ?? { rawBlobOid: null, commitBlobOid: null, commitMode: null },
    ));
  } else if (input.originalPathBytesBase64 || input.originalRepresentation) {
    throw new Error(`${input.changeKind} normalization cannot carry an original-path effect.`);
  }

  effects.push(...(input.additionalPathspecEffects ?? []));
  const byPath = new Map<string, NormalizedCommitEffect>();
  for (const effect of effects) {
    assertCanonicalPathBytes(effect.pathBytesBase64);
    const prior = byPath.get(effect.pathBytesBase64);
    if (prior && canonicalize(prior) !== canonicalize(effect)) {
      throw new Error(`Conflicting commit effects for ${effect.pathBytesBase64}.`);
    }
    byPath.set(effect.pathBytesBase64, effect);
  }
  for (const path of requiredPaths) {
    if (!byPath.has(path)) throw new Error(`Missing commit effect for pathspec ${path}.`);
  }
  for (const path of byPath.keys()) {
    if (!requiredPaths.has(path)) throw new Error(`Commit effect is outside the pathspec closure: ${path}.`);
  }

  const normalized = [...byPath.values()].sort((a, b) => comparePathBytes(a.pathBytesBase64, b.pathBytesBase64));
  canonicalize(normalized);
  return normalized;
}

function sortedStrings(values: string[]): string[] {
  return [...values].sort((a, b) => comparePathBytes(a, b));
}

function sortedByJcs<T>(values: T[]): T[] {
  return [...values].sort((a, b) => {
    const left = canonicalize(a);
    const right = canonicalize(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Sort every set-like collection before JCS encoding; input order is not identity. */
export function normalizeReviewedSemanticManifest(
  manifest: ReviewedSemanticManifest,
): ReviewedSemanticManifest {
  return {
    ...manifest,
    finalizations: sortedByJcs(manifest.finalizations.map((finalization) => ({
      ...finalization,
      frozenMembers: [...finalization.frozenMembers]
        .sort((a, b) => comparePathBytes(a.pathBytesBase64, b.pathBytesBase64)),
    }))),
    members: [...manifest.members]
      .map((member) => ({
        ...member,
        coveringFinalizationIds: [...member.coveringFinalizationIds].sort(),
        commitEffects: [...member.commitEffects]
          .sort((a, b) => comparePathBytes(a.pathBytesBase64, b.pathBytesBase64)),
      }))
      .sort((a, b) => comparePathBytes(a.finalPathBytesBase64, b.finalPathBytesBase64)),
    attributionTopology: {
      ...manifest.attributionTopology,
      componentPathSets: sortedByJcs(manifest.attributionTopology.componentPathSets.map(sortedStrings)),
      contributors: sortedByJcs(manifest.attributionTopology.contributors),
      ownershipGroupKeys: [...manifest.attributionTopology.ownershipGroupKeys].sort(),
      componentEdges: sortedByJcs(manifest.attributionTopology.componentEdges),
      selectedUnattributedPathBytesBase64:
        sortedStrings(manifest.attributionTopology.selectedUnattributedPathBytesBase64),
    },
    closureObligations: sortedByJcs(manifest.closureObligations),
    challengeAtoms: sortedByJcs(manifest.challengeAtoms.map((atom) => atom.kind === 'overlap'
      ? {
          ...atom,
          memberPathBytesBase64: sortedStrings(atom.memberPathBytesBase64),
          contributors: sortedByJcs(atom.contributors),
          ownershipGroupKeys: [...atom.ownershipGroupKeys].sort(),
        }
      : { ...atom })),
  };
}

/** JCS bytes used by main for a typed manifest comparison or SHA-256 digest. */
export function canonicalizeReviewedSemanticManifest(manifest: ReviewedSemanticManifest): string {
  return canonicalize(normalizeReviewedSemanticManifest(manifest));
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
