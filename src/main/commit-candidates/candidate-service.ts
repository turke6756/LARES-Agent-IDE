// SC-WP-1G — read-only CommitCandidateService facade.
//
// Every external effect is an injected read seam. The service discovers all
// workspace aliases of one worktree, unions their scoped porcelain inventories,
// projects witnesses across that whole repository identity, and invokes the
// canonical component assembler exactly once.

import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

import type {
  BundleCaptureHealth,
  BundleAssociation,
  CandidateMember,
  CommitCandidate,
  CommitCandidateToken,
  CommitEligibility,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  FinalizationRef,
  PackageVerificationState,
  ProtectionRung,
  RepositoryIdentity,
  SelectionPreview,
  SaveCardQuotaWeakening,
  MintCandidateTokenRequest,
  NormalizedCommitEffect,
  AttributionContributor,
  ReviewChallengeAtom,
  ReviewedAttributionTopology,
  ReviewedClosureObligation,
  ReviewedFinalizationIntent,
  ReviewedSemanticManifest,
} from '../../shared/commit-candidates';
import {
  REVIEW_CHALLENGE_VERSION,
  REVIEWED_SEMANTIC_MANIFEST_VERSION,
  canonicalizeReviewedSemanticManifest,
  normalizeCommitEffects,
  normalizeReviewedSemanticManifest,
} from '../../shared/commit-candidates';
import { COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY } from '../../shared/constants';
import { canonicalize } from './jcs';
import type { CommitRepresentation } from './commit-representation';
import type { FrozenManifestMember } from './finalization-service';
import type { IndexFingerprintResult } from './index-fingerprint';
import {
  listPlanningActivityWorktrees,
  type PackageFinalization,
  type PlanningActivityWorktree,
} from '../database';
import type { GitCapability } from '../../shared/types';
import type { RunGit } from '../git/git-runtime';
import {
  type RunGitBytesLike,
  type RunGitTextLike,
  produceDirtyInventory,
} from './dirty-inventory';
import {
  discoverScopeForWorkspace,
  enumeratePlanningActivityScopeInputs,
  type ScopeDiscoveryDeps,
  type WorkspaceScopeInput,
} from './scope-discovery';
import {
  projectWitnesses,
  type TurnWitnessReader,
  type WitnessStampSource,
} from './witness-projection';
import {
  assembleConflictComponents,
  type ComponentAssembly,
} from './component-assembler';
import {
  computeBundleCaptureHealth,
  type CaptureHealthTurn,
} from './capture-health';
import {
  evaluateCheckpointProtection,
  type CommitPathLinkReader,
  type ProtectionCheckpointEdge,
  type RunProtectionGitBytes,
} from './protection-read';
import {
  projectWorkBundles,
  type WorkBundle,
} from './work-bundle';
import { ComposeLockRegistry } from './compose-lock-registry';
import {
  parseFinalizationManifest,
  resolvePinnedSelectionDrift,
} from './pinned-selection-drift';

const DEFAULT_CANDIDATE_TOKEN_TTL_MS = 5 * 60 * 1000;
const REVIEWED_MANIFEST_REGISTRY_CAP = 512;

const assemblyByInventory = new WeakMap<DirtyInventory, ComponentAssembly>();
const reviewedManifestByDigest = new Map<string, ReviewedSemanticManifest>();
const dischargedPathsByDigest = new Map<string, Set<string>>();
const carryVerdictByCandidate = new WeakMap<object, ReviewCarryVerdict>();

export type CandidateTokenState = 'issued' | 'consuming' | 'consumed';

export interface CandidateTokenSnapshot {
  readonly token: CommitCandidateToken;
  readonly candidate: CommitCandidate;
  readonly repositoryKey: string;
  readonly normalizedRequest: MintCandidateTokenRequest;
  readonly componentTopologyDigest: string;
  readonly pinnedHeadOid: string | null;
  readonly indexFingerprint: string;
  readonly indexWriteTreeOid: string | null;
  /** Present on every token minted by this service. Optional only so persisted or
   *  test-constructed pre-WP-3 snapshots remain structurally readable. */
  readonly commitEffects?: readonly NormalizedCommitEffect[];
  readonly finalizationManifests: readonly {
    readonly finalizationId: string;
    readonly memberManifestJson: string;
  }[];
  readonly associations: readonly BundleAssociation[];
}

interface CandidateTokenRecord {
  snapshot: CandidateTokenSnapshot;
  state: CandidateTokenState;
  lastAccessedAt: number;
  sequence: number;
}

export interface CandidateTokenStoreOptions {
  composeLocks?: ComposeLockRegistry;
  now?: () => number;
  randomTokenBytes?: () => Buffer;
  tokenTtlMs?: number;
  tokenCapPerRepository?: number;
}

export interface CandidateWorkspaceInput extends WorkspaceScopeInput {
  capability: Pick<
    GitCapability,
    'commonDirQueueKey' | 'workspacePrefix' | 'repoRoot'
  >;
  /** Internal Git executable selected by the capability probe. */
  gitExe?: string;
}

export interface CandidateReadRequest {
  targetWorkspaceId: string;
  workspaces: readonly CandidateWorkspaceInput[];
}

export type CaptureTurnReader = (
  workspaceId: string,
) => readonly CaptureHealthTurn[];

export interface CandidateServiceDeps {
  runGit: RunGitTextLike;
  runGitBytes: RunGitBytesLike;
  readTurnWitnesses: TurnWitnessReader;
  /** Immutable turn-row attribution. Null/omitted preserves Stage ① behavior. */
  stampSource?: WitnessStampSource | null;
  readCaptureTurns: CaptureTurnReader;
  readCommitPathLinks?: CommitPathLinkReader;
  readActiveFinalizations?: (repositoryKey: string) => readonly PackageFinalization[];
  /**
   * SC-WP-2L — latest retention pin quota-weakening warning for a repository,
   * produced by the WP-2K retention pass. Null/omitted ⇒ no banner is surfaced.
   * The service treats it as an opaque, already-renderer-safe read seam.
   */
  readQuotaWeakening?: (repositoryKey: string) => SaveCardQuotaWeakening | null;
  platform?: NodeJS.Platform;
  realpath?(path: string): string;
  fileExists?(path: string): boolean;
  tokenStore?: CandidateTokenStoreOptions;
  /** WP-5 inventory roots. These are physical worktrees, not workspace rows. */
  readActivePlanningWorktrees?: () => readonly PlanningActivityWorktree[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export interface CandidateInventoryRead {
  inventory: DirtyInventory;
  components: ConflictComponent[];
  captureHealthByComponentId: Record<string, BundleCaptureHealth>;
  unattributedCaptureHealth: BundleCaptureHealth;
  protectionByEntryId: Record<string, ProtectionRung>;
  /** Turn IDs whose immutable stamp was legacy/missing, for honest UI labeling. */
  planAttributionUnavailableTurnIds: Set<string>;
  /** SC-WP-2L — retention quota-weakening warning; null unless a still-dirty edge is released. */
  quotaWeakening: SaveCardQuotaWeakening | null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueScopePrefixes(
  workspaces: readonly { workspacePrefix: string }[],
): string[] {
  const prefixes = [...new Set(workspaces.map((workspace) => workspace.workspacePrefix))];
  // A root workspace already covers every nested alias in the same worktree.
  return prefixes.includes('') ? [''] : prefixes.sort(compareStrings);
}

function dedupeEntries(entries: readonly DirtyEntry[]): DirtyEntry[] {
  const byId = new Map<string, DirtyEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.entryId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`inconsistent dirty entry across workspace scopes: ${entry.entryId}`);
    }
    byId.set(entry.entryId, entry);
  }
  return [...byId.values()].sort((left, right) =>
    compareStrings(left.path.pathBytesBase64, right.path.pathBytesBase64)
    || compareStrings(left.entryId, right.entryId),
  );
}

function contributingTurnIds(component: ConflictComponent): Set<string> {
  return new Set(
    component.associations.flatMap((association) => association.contributingTurnIds),
  );
}

function checkpointEdges(turns: readonly CaptureHealthTurn[]): ProtectionCheckpointEdge[] {
  return turns.flatMap((turn) => [
    { ref: turn.beforeRef, oid: turn.beforeOid },
    { ref: turn.afterRef, oid: turn.afterOid },
  ]);
}

function gitExeFor(workspace: CandidateWorkspaceInput): string | undefined {
  return workspace.gitExe;
}

export class CommitCandidateService {
  private readonly deps: Required<
    Pick<CandidateServiceDeps, 'platform' | 'realpath' | 'fileExists'>
  > & Omit<CandidateServiceDeps, 'platform' | 'realpath' | 'fileExists'>;
  private readonly composeLocks: ComposeLockRegistry;
  private readonly now: () => number;
  private readonly randomTokenBytes: () => Buffer;
  private readonly tokenTtlMs: number;
  private readonly tokenCapPerRepository: number;
  private readonly tokens = new Map<string, CandidateTokenRecord>();
  private tokenSequence = 0;

  constructor(deps: CandidateServiceDeps) {
    this.deps = {
      ...deps,
      platform: deps.platform ?? process.platform,
      realpath: deps.realpath ?? ((path) => fs.realpathSync.native(path)),
      fileExists: deps.fileExists ?? ((path) => fs.existsSync(path)),
    };
    this.composeLocks = deps.tokenStore?.composeLocks ?? new ComposeLockRegistry();
    this.now = deps.tokenStore?.now ?? (() => Date.now());
    this.randomTokenBytes = deps.tokenStore?.randomTokenBytes ?? (() => randomBytes(32));
    this.tokenTtlMs = deps.tokenStore?.tokenTtlMs ?? DEFAULT_CANDIDATE_TOKEN_TTL_MS;
    this.tokenCapPerRepository = deps.tokenStore?.tokenCapPerRepository
      ?? COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY;
  }

  /** Build from fresh server state, validate acknowledgements, and mint an opaque token. */
  mintCandidateToken(
    request: MintCandidateTokenRequest & ReviewCarryEvidence,
    context: CandidateBuildContext,
  ): CommitCandidate | SelectionPreview {
    const normalizedRequest: MintCandidateTokenRequest = {
      selectedComponentIds: [...new Set(request.selectedComponentIds)].sort(compareBase64),
      selectedUnattributedEntryIds: [...new Set(request.selectedUnattributedEntryIds)].sort(compareBase64),
      finalizationIds: [...new Set(request.finalizationIds)].sort(compareBase64),
      acknowledgeTopologyDigest: request.acknowledgeTopologyDigest,
      acknowledgeUnattributedEntryIds:
        [...new Set(request.acknowledgeUnattributedEntryIds)].sort(compareBase64),
    };
    const built = buildCandidate(normalizedRequest, context);
    if (!('candidateId' in built) || !built.eligibility.eligible) return built;
    let reviewCarried = false;

    if (request.reviewedManifestDigest !== undefined) {
      const reviewed = reviewedManifestByDigest.get(request.reviewedManifestDigest);
      if (!reviewed) {
        const verdict: ReviewCarryVerdict = {
          carried: false,
          reviewedManifestDigest: request.reviewedManifestDigest,
          reason: 'review-manifest-unknown',
        };
        const refused = {
          ...built,
          eligibility: { eligible: false, reason: 'byte-mismatch' as const },
        };
        carryVerdictByCandidate.set(refused, verdict);
        return refused;
      }
      const freshManifest = buildReviewedSemanticManifest(built, context);
      const verdict = evaluateReviewedManifestCarry(
        reviewed,
        freshManifest,
        request.acknowledgedChallengeAtoms ?? [],
        context,
        built.eligibility,
        dischargedPathsByDigest.get(request.reviewedManifestDigest) ?? new Set(),
      );
      if (!verdict.carried) {
        const acknowledgement = verdict.reason === 'challenge-not-covered';
        const refused = {
          ...built,
          eligibility: {
            eligible: false,
            reason: acknowledgement
              ? ('overlap-not-acknowledged' as const)
              : ('byte-mismatch' as const),
          },
        };
        carryVerdictByCandidate.set(refused, verdict);
        return refused;
      }
      const discharged = dischargedPathsByDigest.get(request.reviewedManifestDigest) ?? new Set<string>();
      for (const path of verdict.dischargedPathBytesBase64) discharged.add(path);
      dischargedPathsByDigest.set(request.reviewedManifestDigest, discharged);
      carryVerdictByCandidate.set(built, verdict);
      reviewCarried = true;
    }

    // The acknowledgement is evidence about the RESOLVED candidate — the same
    // `buildCandidate` output the preview surfaced its digest / unattributed set
    // from — NOT the raw request. Validate against exactly what preview showed.
    const selectedUnattributed = context.inventory.entries.filter((entry) =>
      built.selectedUnattributedEntryIds.includes(entry.entryId));
    const topologyDigest = computeCandidateTopologyDigest(
      context,
      built.componentIds,
      selectedUnattributed,
    );
    if (!reviewCarried && normalizedRequest.acknowledgeTopologyDigest !== topologyDigest) {
      return { ...built, eligibility: { eligible: false, reason: 'overlap-not-acknowledged' } };
    }
    if (!reviewCarried && !sameStrings(
      built.selectedUnattributedEntryIds,
      normalizedRequest.acknowledgeUnattributedEntryIds,
    )) {
      return { ...built, eligibility: { eligible: false, reason: 'unattributed-not-acknowledged' } };
    }
    if (this.composeLocks.isHeld(context.repository.repositoryKey)) {
      return { ...built, eligibility: { eligible: false, reason: 'compose-in-flight' } };
    }

    const now = this.now();
    this.pruneExpired(now);
    this.makeRoom(context.repository.repositoryKey);

    let tokenId: string;
    do tokenId = this.randomTokenBytes().toString('base64url');
    while (this.tokens.has(tokenId));
    const token: CommitCandidateToken = {
      tokenId,
      candidateId: built.candidateId,
      contractVersion: built.contractVersion,
      issuedAt: now,
      expiresAt: now + this.tokenTtlMs,
    };
    const candidate = cloneAndFreeze({ ...built, token });
    const carryVerdict = carryVerdictByCandidate.get(built);
    if (carryVerdict) carryVerdictByCandidate.set(candidate, carryVerdict);
    const selectedComponents = context.components.filter((component) =>
      built.componentIds.includes(component.componentId));
    const commitEffects = candidateCommitEffects(built.members, context.inventory.entries, context);
    const snapshot = cloneAndFreeze<CandidateTokenSnapshot>({
      token,
      candidate,
      repositoryKey: context.repository.repositoryKey,
      normalizedRequest,
      componentTopologyDigest: topologyDigest,
      pinnedHeadOid: context.pinnedHeadOid,
      indexFingerprint: context.indexFingerprint.fingerprint,
      indexWriteTreeOid: context.indexFingerprint.writeTreeOid,
      commitEffects,
      finalizationManifests: context.finalizations
        .filter((finalization) => normalizedRequest.finalizationIds.includes(finalization.id))
        .map((finalization) => ({
          finalizationId: finalization.id,
          memberManifestJson: finalization.memberManifestJson,
        })),
      associations: selectedComponents.flatMap((component) => component.associations),
    });
    this.tokens.set(tokenId, {
      snapshot,
      state: 'issued',
      lastAccessedAt: now,
      sequence: this.tokenSequence++,
    });
    return candidate;
  }

  /** Read-only resolution used before 4D acquires the compose lock; never consumes. */
  resolveCandidateToken(tokenId: string): CandidateTokenSnapshot | null {
    const record = this.liveIssuedRecord(tokenId);
    if (!record) return null;
    record.lastAccessedAt = this.now();
    record.sequence = this.tokenSequence++;
    return record.snapshot;
  }

  /** Atomic compare-and-set. WP-4D calls this only after acquiring the compose lock. */
  tryMarkTokenConsuming(tokenId: string): CandidateTokenSnapshot | null {
    const record = this.liveIssuedRecord(tokenId);
    if (!record) return null;
    record.state = 'consuming';
    record.lastAccessedAt = this.now();
    record.sequence = this.tokenSequence++;
    return record.snapshot;
  }

  markTokenConsumed(tokenId: string): boolean {
    const record = this.tokens.get(tokenId);
    if (!record || record.state !== 'consuming') return false;
    record.state = 'consumed';
    // A consumed token is invalidated immediately. Keeping the terminal assignment
    // explicit documents the state-machine edge while bounding the in-memory map.
    this.tokens.delete(tokenId);
    return true;
  }

  tokenState(tokenId: string): CandidateTokenState | null {
    const record = this.tokens.get(tokenId);
    if (!record) return null;
    if (record.state === 'issued' && record.snapshot.token.expiresAt <= this.now()) {
      this.tokens.delete(tokenId);
      return null;
    }
    return record.state;
  }

  private liveIssuedRecord(tokenId: string): CandidateTokenRecord | null {
    const record = this.tokens.get(tokenId);
    if (!record || record.state !== 'issued') return null;
    if (record.snapshot.token.expiresAt <= this.now()) {
      this.tokens.delete(tokenId);
      return null;
    }
    return record;
  }

  private pruneExpired(now: number): void {
    for (const [tokenId, record] of this.tokens) {
      if (record.state === 'issued' && record.snapshot.token.expiresAt <= now) {
        this.tokens.delete(tokenId);
      }
    }
  }

  private makeRoom(repositoryKey: string): void {
    const repositoryRecords = [...this.tokens.entries()]
      .filter(([, record]) => record.snapshot.repositoryKey === repositoryKey);
    while (repositoryRecords.length >= this.tokenCapPerRepository) {
      const oldestIssued = repositoryRecords
        .filter(([, record]) => record.state === 'issued')
        .sort((left, right) => left[1].sequence - right[1].sequence)[0];
      if (!oldestIssued) break;
      this.tokens.delete(oldestIssued[0]);
      repositoryRecords.splice(repositoryRecords.findIndex(([id]) => id === oldestIssued[0]), 1);
    }
  }

  async assembleInventory(request: CandidateReadRequest): Promise<CandidateInventoryRead> {
    const target = request.workspaces.find(
      (workspace) => workspace.workspaceId === request.targetWorkspaceId,
    );
    if (!target) {
      throw new Error(`unknown target workspace: ${request.targetWorkspaceId}`);
    }

    const primaryInputs = request.workspaces.map((workspace): WorkspaceScopeInput => ({
      workspaceId: workspace.workspaceId,
      workspaceDir: workspace.workspaceDir,
      capability: workspace.capability,
    }));
    const activityRows = this.deps.readActivePlanningWorktrees
      ? this.deps.readActivePlanningWorktrees()
      : process.env.LARES_INTENT_PACKAGING === '1'
        ? listPlanningActivityWorktrees(['active'])
        : [];
    const inputs = enumeratePlanningActivityScopeInputs(primaryInputs, activityRows.map((row) => ({
      executionRunId: row.executionRunId,
      logicalWorkspaceId: row.logicalWorkspaceId,
      path: row.path,
      repositoryKey: row.activityRepositoryKey,
      objectDatabaseKey: row.objectDatabaseKey,
    })));
    const workspaceByDir = new Map<string, CandidateWorkspaceInput | undefined>(
      request.workspaces.map((workspace) => [workspace.workspaceDir, workspace]),
    );
    for (const row of activityRows) workspaceByDir.set(row.path, undefined);
    // Request-local only: discoverScopeForWorkspace probes the target once to
    // identify its repository, then probes every input (including that target)
    // to assemble aliases. Share identical reads within this assembly without
    // carrying potentially stale repository state across separate requests.
    const scopeGitReads = new Map<string, ReturnType<RunGit>>();
    const scopeDeps: ScopeDiscoveryDeps = {
      platform: this.deps.platform,
      realpath: this.deps.realpath,
      fileExists: this.deps.fileExists,
      runGitFor: (workspaceDir): RunGit => {
        const workspace = workspaceByDir.get(workspaceDir);
        return (args) => {
          const key = JSON.stringify([workspaceDir, args]);
          let read = scopeGitReads.get(key);
          if (!read) {
            read = (async () => {
              try {
                return await this.deps.runGit(workspaceDir, args, {
                  gitExe: workspace ? gitExeFor(workspace) : undefined,
                  allowNonzero: true,
                  timeoutMs: 10_000,
                  maxBytes: 1 << 20,
                });
              } catch (error) {
                return {
                  code: 1,
                  stdout: '',
                  stderr: error instanceof Error ? error.message : String(error),
                };
              }
            })();
            scopeGitReads.set(key, read);
          }
          return read;
        };
      },
    };

    const repository = await discoverScopeForWorkspace(
      request.targetWorkspaceId,
      inputs,
      scopeDeps,
    );
    if (!repository) {
      throw new Error(`workspace is not in an assemblable repository: ${request.targetWorkspaceId}`);
    }
    if (!target.capability.repoRoot) {
      throw new Error(`workspace has no repository root: ${request.targetWorkspaceId}`);
    }

    const scopedWorkspaces = repository.workspaces.map((identityWorkspace) => {
      const workspace = request.workspaces.find(
        (candidate) => candidate.workspaceId === identityWorkspace.workspaceId,
      );
      if (!workspace) {
        throw new Error(`repository scope references unknown workspace: ${identityWorkspace.workspaceId}`);
      }
      return workspace;
    });
    const gitExe = gitExeFor(target);
    const drafts = await Promise.all(
      uniqueScopePrefixes(repository.workspaces).map((workspacePrefix) =>
        produceDirtyInventory({
          repoRoot: target.capability.repoRoot!,
          workspacePrefix,
          repository,
          runGitBytes: this.deps.runGitBytes,
          runGit: this.deps.runGit,
          gitExe,
        }),
      ),
    );
    const draft = {
      repository,
      entries: dedupeEntries(drafts.flatMap((item) => item.entries)),
    };

    const witnesses = projectWitnesses(
      repository,
      draft.entries,
      this.deps.readTurnWitnesses,
      this.deps.stampSource ?? null,
    );
    const assembly = assembleConflictComponents(draft, witnesses);
    // Keep the structured WP-2 topology paired with the exact inventory object.
    // Preview routing preserves that object when it spreads the scope context, so
    // review construction never has to reverse-engineer contributor tuples from
    // renderer ids or an opaque topology digest.
    assemblyByInventory.set(assembly.inventory, assembly);
    const planAttributionUnavailableTurnIds = new Set(
      witnesses
        .filter((witness) => !witness.planAttributionAvailable)
        .map((witness) => witness.turnId),
    );

    const allTurns = scopedWorkspaces.flatMap(
      (workspace) => [...this.deps.readCaptureTurns(workspace.workspaceId)],
    );
    const turnsById = new Map(allTurns.map((turn) => [turn.id, turn]));
    let activeFinalizations: readonly PackageFinalization[] = [];
    try {
      activeFinalizations = this.deps.readActiveFinalizations?.(repository.repositoryKey) ?? [];
    } catch {
      // Protection is evidence, never an availability gate. A database read
      // failure cannot invent a durable edge, so continue with no coverage.
      activeFinalizations = [];
    }
    const protectionByEntryId: Record<string, ProtectionRung> = {};
    let finalizationCoveredPathBytes: ReadonlySet<string> = new Set();
    if (assembly.inventory.entries.length > 0) {
      const protection = await evaluateCheckpointProtection({
        repoRoot: target.capability.repoRoot,
        members: assembly.inventory.entries,
        checkpointEdges: checkpointEdges(allTurns),
        finalizations: activeFinalizations,
        repositoryKey: repository.repositoryKey,
        readCommitPathLinks: this.deps.readCommitPathLinks,
        runGit: this.deps.runGit,
        runGitBytes: this.deps.runGitBytes as RunProtectionGitBytes,
        platform: this.deps.platform,
        gitExe,
      });
      finalizationCoveredPathBytes = protection.finalizationCoveredPathBytes;
      for (const member of protection.members) {
        protectionByEntryId[member.entryId] = member.protection;
      }
    }

    const captureHealthByComponentId: Record<string, BundleCaptureHealth> = {};
    for (const component of assembly.components) {
      const turns = [...contributingTurnIds(component)]
        .map((turnId) => turnsById.get(turnId))
        .filter((turn): turn is CaptureHealthTurn => turn !== undefined);
      const entries = component.dirtyEntryIds.map(
        (entryId) => assembly.inventory.entries.find((entry) => entry.entryId === entryId)!,
      );
      captureHealthByComponentId[component.componentId] =
        await computeBundleCaptureHealth({
          repoRoot: target.capability.repoRoot,
          turns,
          dirtyEntries: entries,
          finalizationCoveredPathBytes,
          runGit: this.deps.runGit,
          gitExe,
        });
    }

    const unattributedEntries = assembly.inventory.unattributedEntryIds.map(
      (entryId) => assembly.inventory.entries.find((entry) => entry.entryId === entryId)!,
    );
    const unattributedCaptureHealth = await computeBundleCaptureHealth({
      repoRoot: target.capability.repoRoot,
      turns: [],
      dirtyEntries: unattributedEntries,
      finalizationCoveredPathBytes,
      runGit: this.deps.runGit,
      gitExe,
    });

    return {
      inventory: assembly.inventory,
      components: assembly.components,
      captureHealthByComponentId,
      unattributedCaptureHealth,
      protectionByEntryId,
      planAttributionUnavailableTurnIds,
      quotaWeakening: this.deps.readQuotaWeakening?.(repository.repositoryKey) ?? null,
    };
  }

  async listWorkBundles(request: CandidateReadRequest): Promise<WorkBundle[]> {
    return projectWorkBundles(await this.assembleInventory(request));
  }

  /**
   * SC-WP-2L — the full read-only inventory view: renderer bundles plus the
   * retention quota-weakening warning attached to the same assembly.
   */
  async listInventoryView(
    request: CandidateReadRequest,
  ): Promise<{ bundles: WorkBundle[]; quotaWeakening: SaveCardQuotaWeakening | null }> {
    const read = await this.assembleInventory(request);
    return { bundles: projectWorkBundles(read), quotaWeakening: read.quotaWeakening };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SC-WP-3G — canonical candidate assembly + verification + identity.
//
// A candidate is a UNION of atomic units: whole witnessed components (never a
// proper subset in v1) + independently-selected unattributed entries, backed by
// finalization coverage. A selection WITHOUT finalization is a `SelectionPreview`,
// not a candidate (contract §4/§4.1/§4.2, §5.1).
//
// These are PURE functions over an already-resolved context so both lenses (fleet
// / plan) produce an identical `candidateId`: the identity inputs (§4.2) are lens-
// independent, and the assembler never re-computes topology or splits a component.
// ─────────────────────────────────────────────────────────────────────────────

/** The explicit selection request (component ids expand server-side to ALL their
 *  entries; unattributed entries are independent atoms; finalizations are the
 *  requested coverage set). Empty `finalizationIds` ⇒ preview, never a candidate. */
export interface CandidateSelectionRequest {
  selectedComponentIds: readonly string[];
  selectedUnattributedEntryIds: readonly string[];
  finalizationIds: readonly string[];
}

/** The minimal `commit_path_links` shape the prior-exact-commit closure proof needs
 *  (structurally satisfied by `database.CommitPathLink`). A member is proven
 *  `already-locally-committed` ONLY by an EXACT frozen commit-entry match. */
export interface CandidateLedgerLink {
  /** Reconciliation-ledger commit that established this exact path state. */
  commitOid?: string;
  pathBytesBase64: string;
  expectedState: 'present' | 'absent';
  rawBlobOidAtCommit?: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

export interface ReviewCarryEvidence {
  /** Digest of the immutable manifest actually reviewed by the human. */
  reviewedManifestDigest?: string;
  /** Exact independently comparable atoms shown and acknowledged. */
  acknowledgedChallengeAtoms?: readonly ReviewChallengeAtom[];
}

export interface FreshHeadEntry {
  expectedState: 'present' | 'absent';
  commitBlobOid: string | null;
  commitMode: string | null;
}

export type ReviewCarryRefusalReason =
  | 'review-manifest-unknown'
  | 'contract-or-repository-changed'
  | 'durable-intent-changed'
  | 'reviewed-universe-changed'
  | 'pending-effect-changed'
  | 'discharge-unproven'
  | 'attribution-changed'
  | 'challenge-not-covered'
  | 'fresh-eligibility-failed'
  | 'fresh-closure-unproven';

export type ReviewCarryVerdict =
  | {
      carried: true;
      reviewedManifestDigest: string;
      pendingPathBytesBase64: string[];
      dischargedPathBytesBase64: string[];
    }
  | {
      carried: false;
      reviewedManifestDigest: string;
      reason: ReviewCarryRefusalReason;
      paths?: string[];
    };

/** Everything the pure assembler reads. Production callers resolve these from the
 *  read facade + WP-3B accessors + WP-2J temp-index reads + WP-3G fingerprint;
 *  tests inject fakes and one real-git case drives the genuine `.gitattributes`
 *  clean-filter divergence. */
export interface CandidateBuildContext {
  repository: RepositoryIdentity;
  inventory: DirtyInventory;
  components: readonly ConflictComponent[];
  /** Every finalization the request may reference (requested coverage set). Only
   *  `lifecycle_status='active'` rows actually cover a path. */
  finalizations: readonly PackageFinalization[];
  /** CURRENT temp-index commit representation per selected entryId (WP-2J), used to
   *  detect a post-finalization clean-filter divergence. Absent ⇒ treated as no
   *  current commit entry (null blob/mode). */
  currentCommitReps: ReadonlyMap<string, CommitRepresentation>;
  /** Repository-scoped exact commit ledger for the prior-exact-commit closure. */
  ledger: readonly CandidateLedgerLink[];
  /** Optional fresh reachability batch supplied by a sweep iteration. A ledger
   * row equal to pinned HEAD is reachable without appearing here. */
  reachableCommitOids?: ReadonlySet<string>;
  /** Fresh current-HEAD tree entries for discharged/closure paths. */
  currentHeadEntriesByPath?: ReadonlyMap<string, FreshHeadEntry>;
  /** Explicit test/alternate-assembly seam. Production normally obtains these
   * structures from the exact ComponentAssembly cached for `inventory`. */
  reviewedAttributionTopology?: ReviewedAttributionTopology;
  reviewChallengeAtoms?: readonly ReviewChallengeAtom[];
  protectionByEntryId?: Readonly<Record<string, ProtectionRung>>;
  pinnedHeadOid: string | null;
  indexFingerprint: IndexFingerprintResult;
  contractVersion: number;
}

function compareBase64(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function ownershipGroupKey(contributor: AttributionContributor): string {
  return canonicalize([
    contributor.ownerAgentId ?? contributor.agentId,
    contributor.planId,
    contributor.planItemId,
  ]);
}

function sortedUniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareBase64);
}

function projectTopology(
  topology: ReviewedAttributionTopology,
  retainedMemberPaths: ReadonlySet<string>,
): ReviewedAttributionTopology {
  const originalMemberPaths = new Set(topology.componentPathSets.flat());
  for (const path of topology.selectedUnattributedPathBytesBase64) originalMemberPaths.add(path);
  if (originalMemberPaths.size === retainedMemberPaths.size
      && [...originalMemberPaths].every((path) => retainedMemberPaths.has(path))) {
    return structuredClone(topology);
  }
  const componentPathSets = topology.componentPathSets
    .map((paths) => paths.filter((path) => retainedMemberPaths.has(path)).sort(compareBase64))
    .filter((paths) => paths.length > 0)
    .sort((left, right) => compareBase64(canonicalize(left), canonicalize(right)));
  const contributors = topology.contributors
    .filter((contributor) => retainedMemberPaths.has(contributor.pathBytesBase64));
  // Typed contributors let us project ordinary groups precisely. WP-2 also
  // retains owner-less group keys whose contributor cannot inhabit the shared
  // AttributionContributor type; conservatively retain those opaque groups while
  // any component remains rather than silently dropping an obligation.
  const typedOriginalGroups = new Set(topology.contributors.map(ownershipGroupKey));
  const opaqueOriginalGroups = topology.ownershipGroupKeys.filter((key) => !typedOriginalGroups.has(key));
  const ownershipGroupKeys = sortedUniqueStrings([
    ...contributors.map(ownershipGroupKey),
    ...(componentPathSets.length > 0 ? opaqueOriginalGroups : []),
  ]);
  const componentEdges = topology.componentEdges.filter((edge) =>
    retainedMemberPaths.has(edge.leftPathBytesBase64)
    && retainedMemberPaths.has(edge.rightPathBytesBase64));
  const selectedUnattributedPathBytesBase64 = topology.selectedUnattributedPathBytesBase64
    .filter((path) => retainedMemberPaths.has(path));
  const requiresOverlapAck = ownershipGroupKeys.length >= 2 || componentPathSets.some((paths) => {
    const pathSet = new Set(paths);
    return new Set(
      contributors
        .filter((contributor) => pathSet.has(contributor.pathBytesBase64))
        .map(ownershipGroupKey),
    ).size >= 2;
  });
  return {
    componentPathSets,
    contributors,
    ownershipGroupKeys,
    componentEdges,
    requiresOverlapAck,
    selectedUnattributedPathBytesBase64,
  };
}

function selectedTopologyEvidence(
  candidate: CommitCandidate,
  context: CandidateBuildContext,
): { topology: ReviewedAttributionTopology; overlapAtoms: ReviewChallengeAtom[] } {
  const selectedMemberPaths = new Set(candidate.members.map((member) => member.path.pathBytesBase64));
  const assembly = assemblyByInventory.get(context.inventory);
  const topology = context.reviewedAttributionTopology ?? assembly?.selectedTopology;
  const atoms = context.reviewChallengeAtoms ?? assembly?.overlapChallengeAtoms;
  if (topology && atoms) {
    return {
      topology: projectTopology(topology, selectedMemberPaths),
      overlapAtoms: atoms.filter((atom) =>
        atom.kind === 'overlap'
        && atom.memberPathBytesBase64.every((path) => selectedMemberPaths.has(path))),
    };
  }

  // Compatibility for directly-constructed, non-overlapping unit contexts. A
  // carry-capable overlapping context must supply WP-2's structured evidence;
  // an opaque digest is deliberately never promoted into review identity.
  const selectedComponents = context.components.filter((component) =>
    candidate.componentIds.includes(component.componentId));
  if (selectedComponents.some((component) => component.overlap.requiresOverlapAck)) {
    throw new Error('Structured overlap topology is unavailable for reviewed-manifest construction.');
  }
  const entryById = new Map(context.inventory.entries.map((entry) => [entry.entryId, entry]));
  const componentPathSets = selectedComponents.map((component) => component.dirtyEntryIds
    .map((entryId) => entryById.get(entryId)?.path.pathBytesBase64)
    .filter((path): path is string => path !== undefined)
    .sort(compareBase64));
  return {
    topology: {
      componentPathSets,
      contributors: [],
      ownershipGroupKeys: [],
      componentEdges: [],
      requiresOverlapAck: false,
      selectedUnattributedPathBytesBase64: candidate.selectedUnattributedEntryIds
        .map((entryId) => entryById.get(entryId)?.path.pathBytesBase64)
        .filter((path): path is string => path !== undefined)
        .sort(compareBase64),
    },
    overlapAtoms: [],
  };
}

function reviewedFrozenMembers(finalization: PackageFinalization) {
  return parseFinalizationManifest(finalization)
    .map((member) => ({
      pathBytesBase64: member.pathBytesBase64,
      expectedState: member.expectedState,
      rawBlobOid: member.rawBlobOid,
      commitBlobOid: member.commitBlobOid,
      commitMode: member.commitMode,
    }))
    .sort((left, right) => compareBase64(left.pathBytesBase64, right.pathBytesBase64));
}

/** Build review identity from fresh main-owned state. Operational HEAD/index and
 * candidate/token ids are intentionally absent. */
export function buildReviewedSemanticManifest(
  candidate: CommitCandidate,
  context: CandidateBuildContext,
): ReviewedSemanticManifest {
  const entryById = new Map(context.inventory.entries.map((entry) => [entry.entryId, entry]));
  const members = candidate.members.map((member) => {
    const entry = entryById.get(member.entryId);
    if (!entry) throw new Error(`Reviewed candidate member is absent from inventory: ${member.entryId}`);
    return {
      finalPathBytesBase64: member.path.pathBytesBase64,
      expectedState: member.expectedWorktreeState,
      rawBlobOid: member.rawWorktreeBlobOid,
      commitBlobOid: member.expectedCommitBlobOid,
      commitMode: member.expectedCommitMode,
      coveringFinalizationIds: [...member.coveringFinalizationIds],
      commitEffects: memberCommitEffects(member, entry, context),
    };
  });
  const selectedFinalizationIds = new Set(candidate.finalizations.map((ref) => ref.finalizationId));
  const selectedFinalizations = context.finalizations.filter((row) => selectedFinalizationIds.has(row.id));
  const finalizations: ReviewedFinalizationIntent[] = selectedFinalizations.map((row) => {
    if (row.boundaryStatus !== 'ready') {
      throw new Error(`Finalization ${row.id} is not ready for semantic review.`);
    }
    const frozenMembers = reviewedFrozenMembers(row);
    return {
      finalizationId: row.id,
      packageId: row.packageId,
      packageRevision: row.packageRevision,
      boundaryStatus: 'ready',
      frozenMemberManifestDigest: sha256Hex(canonicalize(frozenMembers)),
      frozenMembers,
    };
  });
  const selectedLogicalPaths = new Set(members.map((member) => member.finalPathBytesBase64));
  const closureObligations: ReviewedClosureObligation[] = finalizations.flatMap((intent) =>
    intent.frozenMembers
      .filter((member) => !selectedLogicalPaths.has(member.pathBytesBase64))
      .map((member) => ({
        finalizationId: intent.finalizationId,
        pathBytesBase64: member.pathBytesBase64,
        expectedState: member.expectedState,
        commitBlobOid: member.commitBlobOid,
        commitMode: member.commitMode,
      })));
  const topologyEvidence = selectedTopologyEvidence(candidate, context);
  const unattributedPaths = new Set(
    topologyEvidence.topology.selectedUnattributedPathBytesBase64,
  );
  const unattributedAtoms: ReviewChallengeAtom[] = members
    .filter((member) => unattributedPaths.has(member.finalPathBytesBase64))
    .map((member) => {
      const memberEffectDigest = sha256Hex(canonicalize(member));
      const body = { pathBytesBase64: member.finalPathBytesBase64, memberEffectDigest };
      return {
        kind: 'unattributed',
        atomId: `unattributed:${sha256Hex(member.finalPathBytesBase64)}`,
        digest: sha256Hex(canonicalize(body)),
        ...body,
      };
    });
  return normalizeReviewedSemanticManifest({
    manifestVersion: REVIEWED_SEMANTIC_MANIFEST_VERSION,
    candidateContractVersion: context.contractVersion,
    repositoryKey: context.repository.repositoryKey,
    objectDatabaseKey: context.repository.objectDatabaseKey,
    gitObjectFormat: context.repository.gitObjectFormat,
    finalizations,
    members,
    attributionTopology: topologyEvidence.topology,
    closureObligations,
    challengeVersion: REVIEW_CHALLENGE_VERSION,
    challengeAtoms: [...topologyEvidence.overlapAtoms, ...unattributedAtoms],
  });
}

export function reviewedSemanticManifestDigest(manifest: ReviewedSemanticManifest): string {
  return sha256Hex(canonicalizeReviewedSemanticManifest(manifest));
}

/** Retain only manifests actually emitted by main. A renderer digest can select
 * one of these records but can never manufacture semantic equivalence. */
export function rememberReviewedSemanticManifest(manifest: ReviewedSemanticManifest): string {
  const normalized = cloneAndFreeze(normalizeReviewedSemanticManifest(manifest));
  const digest = reviewedSemanticManifestDigest(normalized);
  reviewedManifestByDigest.delete(digest);
  reviewedManifestByDigest.set(digest, normalized);
  if (!dischargedPathsByDigest.has(digest)) dischargedPathsByDigest.set(digest, new Set());
  while (reviewedManifestByDigest.size > REVIEWED_MANIFEST_REGISTRY_CAP) {
    const oldest = reviewedManifestByDigest.keys().next().value as string | undefined;
    if (!oldest) break;
    reviewedManifestByDigest.delete(oldest);
    dischargedPathsByDigest.delete(oldest);
  }
  return digest;
}

export function reviewCarryVerdictFor(
  candidate: CommitCandidate | SelectionPreview,
): ReviewCarryVerdict | null {
  return carryVerdictByCandidate.get(candidate) ?? null;
}

function effectMap(manifest: ReviewedSemanticManifest): Map<string, NormalizedCommitEffect> {
  const result = new Map<string, NormalizedCommitEffect>();
  for (const member of manifest.members) {
    for (const effect of member.commitEffects) {
      const prior = result.get(effect.pathBytesBase64);
      if (prior && !canonicalEqual(prior, effect)) {
        throw new Error(`Conflicting reviewed effects for ${effect.pathBytesBase64}.`);
      }
      result.set(effect.pathBytesBase64, effect);
    }
  }
  return result;
}

function exactLedgerLink(
  expected: Pick<NormalizedCommitEffect, 'pathBytesBase64' | 'expectedState' | 'rawBlobOid' | 'commitBlobOid' | 'commitMode'>,
  context: CandidateBuildContext,
): CandidateLedgerLink | null {
  return context.ledger.find((link) =>
    typeof link.commitOid === 'string'
    && link.pathBytesBase64 === expected.pathBytesBase64
    && link.expectedState === expected.expectedState
    && link.commitBlobOid === expected.commitBlobOid
    && link.commitMode === expected.commitMode
    && (link.rawBlobOidAtCommit === undefined || link.rawBlobOidAtCommit === expected.rawBlobOid)
    && (link.commitOid === context.pinnedHeadOid
      || context.reachableCommitOids?.has(link.commitOid))) ?? null;
}

function currentHeadMatches(
  expected: Pick<NormalizedCommitEffect, 'pathBytesBase64' | 'expectedState' | 'commitBlobOid' | 'commitMode'>,
  link: CandidateLedgerLink,
  context: CandidateBuildContext,
): boolean {
  if (link.commitOid === context.pinnedHeadOid) return true;
  const head = context.currentHeadEntriesByPath?.get(expected.pathBytesBase64);
  return !!head
    && head.expectedState === expected.expectedState
    && head.commitBlobOid === expected.commitBlobOid
    && head.commitMode === expected.commitMode;
}

function exactDischargeProof(effect: NormalizedCommitEffect, context: CandidateBuildContext): boolean {
  const link = exactLedgerLink(effect, context);
  return link !== null && currentHeadMatches(effect, link, context);
}

function freshClosureProven(manifest: ReviewedSemanticManifest, context: CandidateBuildContext): boolean {
  return manifest.closureObligations.every((obligation) => {
    const asEffect: NormalizedCommitEffect = {
      pathBytesBase64: obligation.pathBytesBase64,
      operation: obligation.expectedState === 'absent' ? 'delete' : 'retain',
      expectedState: obligation.expectedState,
      rawBlobOid: null,
      commitBlobOid: obligation.commitBlobOid,
      commitMode: obligation.commitMode,
    };
    const link = context.ledger.find((candidate) =>
      typeof candidate.commitOid === 'string'
      && candidate.pathBytesBase64 === obligation.pathBytesBase64
      && candidate.expectedState === obligation.expectedState
      && candidate.commitBlobOid === obligation.commitBlobOid
      && candidate.commitMode === obligation.commitMode
      && (candidate.commitOid === context.pinnedHeadOid
        || context.reachableCommitOids?.has(candidate.commitOid))) ?? null;
    return link !== null && currentHeadMatches(asEffect, link, context);
  });
}

function atomsCovered(
  current: readonly ReviewChallengeAtom[],
  acknowledged: readonly ReviewChallengeAtom[],
): boolean {
  const acknowledgedCanonical = new Set(acknowledged.map((atom) => canonicalize(atom)));
  return current.every((atom) => acknowledgedCanonical.has(canonicalize(atom)));
}

function challengeMatchesTopology(manifest: ReviewedSemanticManifest): boolean {
  const unattributedAtoms = new Set(manifest.challengeAtoms
    .filter((atom): atom is Extract<ReviewChallengeAtom, { kind: 'unattributed' }> =>
      atom.kind === 'unattributed')
    .map((atom) => atom.pathBytesBase64));
  if (!manifest.attributionTopology.selectedUnattributedPathBytesBase64.every((path) =>
    unattributedAtoms.has(path))) return false;
  return !manifest.attributionTopology.requiresOverlapAck
    || manifest.challengeAtoms.some((atom) => atom.kind === 'overlap');
}

/** Adopted carry predicate: equality of the reviewed universe with the sole
 * proof-bearing asymmetry that an exact reviewed effect may be discharged. */
export function evaluateReviewedManifestCarry(
  reviewed: ReviewedSemanticManifest,
  fresh: ReviewedSemanticManifest,
  acknowledgedAtoms: readonly ReviewChallengeAtom[],
  context: CandidateBuildContext,
  freshEligibility: CommitEligibility,
  previouslyDischargedPaths: ReadonlySet<string> = new Set(),
): ReviewCarryVerdict {
  const reviewedDigest = reviewedSemanticManifestDigest(reviewed);
  const refuse = (reason: ReviewCarryRefusalReason, paths?: string[]): ReviewCarryVerdict => ({
    carried: false,
    reviewedManifestDigest: reviewedDigest,
    reason,
    ...(paths && paths.length > 0 ? { paths: sortedUniqueStrings(paths) } : {}),
  });
  if (reviewed.manifestVersion !== fresh.manifestVersion
      || reviewed.candidateContractVersion !== fresh.candidateContractVersion
      || reviewed.repositoryKey !== fresh.repositoryKey
      || reviewed.objectDatabaseKey !== fresh.objectDatabaseKey
      || reviewed.gitObjectFormat !== fresh.gitObjectFormat) {
    return refuse('contract-or-repository-changed');
  }
  if (!canonicalEqual(reviewed.finalizations, fresh.finalizations)) {
    return refuse('durable-intent-changed');
  }
  if (!freshEligibility.eligible || context.indexFingerprint.hasUnmerged) {
    return refuse('fresh-eligibility-failed');
  }
  const reviewedEffects = effectMap(reviewed);
  const pendingEffects = effectMap(fresh);
  const outside = [...pendingEffects.keys()].filter((path) => !reviewedEffects.has(path));
  if (outside.length > 0) return refuse('reviewed-universe-changed', outside);
  const reintroduced = [...pendingEffects.keys()].filter((path) => previouslyDischargedPaths.has(path));
  if (reintroduced.length > 0) return refuse('reviewed-universe-changed', reintroduced);
  const pending: string[] = [];
  const discharged: string[] = [];
  for (const [path, effect] of reviewedEffects) {
    const current = pendingEffects.get(path);
    if (current) {
      if (!canonicalEqual(effect, current)) return refuse('pending-effect-changed', [path]);
      pending.push(path);
    } else {
      if (!exactDischargeProof(effect, context)) return refuse('discharge-unproven', [path]);
      discharged.push(path);
    }
  }
  if (pending.length + discharged.length !== reviewedEffects.size) {
    return refuse('reviewed-universe-changed');
  }

  const pendingSet = new Set(pending);
  const expectedClosure = [...reviewed.closureObligations];
  for (const member of reviewed.members) {
    if (member.commitEffects.some((effect) => pendingSet.has(effect.pathBytesBase64))) continue;
    for (const finalizationId of member.coveringFinalizationIds) {
      expectedClosure.push({
        finalizationId,
        pathBytesBase64: member.finalPathBytesBase64,
        expectedState: member.expectedState,
        commitBlobOid: member.commitBlobOid,
        commitMode: member.commitMode,
      });
    }
  }
  if (!canonicalEqual(
    normalizeReviewedSemanticManifest({ ...reviewed, closureObligations: expectedClosure }).closureObligations,
    fresh.closureObligations,
  ) || !freshClosureProven(fresh, context)) {
    return refuse('fresh-closure-unproven');
  }

  const retainedLogicalPaths = new Set(reviewed.members
    .filter((member) => member.commitEffects.some((effect) => pendingSet.has(effect.pathBytesBase64)))
    .map((member) => member.finalPathBytesBase64));
  const expectedTopology = projectTopology(reviewed.attributionTopology, retainedLogicalPaths);
  if (!canonicalEqual(expectedTopology, fresh.attributionTopology)) {
    return refuse('attribution-changed');
  }
  if (!challengeMatchesTopology(fresh)
      || (discharged.length === 0 && !canonicalEqual(reviewed.challengeAtoms, fresh.challengeAtoms))) {
    return refuse('challenge-not-covered');
  }
  if (!atomsCovered(fresh.challengeAtoms, acknowledgedAtoms)) {
    return refuse('challenge-not-covered');
  }
  return {
    carried: true,
    reviewedManifestDigest: reviewedDigest,
    pendingPathBytesBase64: pending.sort(compareBase64),
    dischargedPathBytesBase64: discharged.sort(compareBase64),
  };
}

function retainedEffect(
  pathBytesBase64: string,
  context: CandidateBuildContext,
): NormalizedCommitEffect {
  const staged = context.indexFingerprint.entries.find((entry) =>
    entry.pathBytesBase64 === pathBytesBase64 && entry.stage === '0');
  if (!staged) {
    throw new Error(`Missing stage-0 representation for retained commit pathspec ${pathBytesBase64}.`);
  }
  return {
    pathBytesBase64,
    operation: 'retain',
    expectedState: 'present',
    // A retained path is sourced from the pinned index rather than re-read from
    // the worktree. Bind that exact object as both representations so identity
    // changes if the source/pathspec object or mode changes.
    rawBlobOid: staged.oid,
    commitBlobOid: staged.oid,
    commitMode: staged.mode,
  };
}

function isCanonicalGitPath(pathBytesBase64: string): boolean {
  const bytes = Buffer.from(pathBytesBase64, 'base64');
  return bytes.length > 0
    && !bytes.includes(0)
    && bytes.toString('base64') === pathBytesBase64;
}

function memberCommitEffects(
  member: CandidateMember,
  entry: DirtyEntry,
  context: CandidateBuildContext,
): NormalizedCommitEffect[] {
  const finalPath = entry.path.pathBytesBase64;
  const originalPath = entry.originalPath?.pathBytesBase64;
  const isCopy = entry.entryKind === 'rename-or-copy'
    && (entry.indexStatus === 'C' || entry.worktreeStatus === 'C');
  const changeKind = entry.expectedWorktreeState === 'absent'
    ? 'delete'
    : entry.entryKind === 'rename-or-copy'
      ? (isCopy ? 'copy' : 'rename')
      : entry.headMode !== null && entry.worktreeMode !== null && entry.headMode !== entry.worktreeMode
        ? 'mode-change'
        : 'write';
  const representedPaths = new Set([finalPath, ...(originalPath ? [originalPath] : [])]);
  const additionalPathspecEffects = entry.commitPathspecs
    .map((path) => path.pathBytesBase64)
    .filter((path) => !representedPaths.has(path))
    .map((path) => retainedEffect(path, context));
  const originalRepresentation = isCopy && originalPath
    ? retainedEffect(originalPath, context)
    : undefined;

  return normalizeCommitEffects({
    changeKind,
    finalPathBytesBase64: finalPath,
    finalRepresentation: {
      rawBlobOid: member.rawWorktreeBlobOid,
      commitBlobOid: member.expectedCommitBlobOid,
      commitMode: member.expectedCommitMode,
    },
    ...(originalPath ? { originalPathBytesBase64: originalPath } : {}),
    ...(originalRepresentation ? { originalRepresentation } : {}),
    commitPathspecs: entry.commitPathspecs.map((path) => path.pathBytesBase64),
    ...(additionalPathspecEffects.length > 0 ? { additionalPathspecEffects } : {}),
  });
}

function candidateCommitEffects(
  members: readonly CandidateMember[],
  entries: readonly DirtyEntry[],
  context: CandidateBuildContext,
): NormalizedCommitEffect[] {
  const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
  const byPath = new Map<string, NormalizedCommitEffect>();
  for (const member of members) {
    const entry = entriesById.get(member.entryId);
    if (!entry) throw new Error(`Candidate member is absent from inventory: ${member.entryId}`);
    // Some older unit fixtures use labels such as "b64-entry" in place of the
    // authoritative base64 path transport. Production inventory can never emit
    // these; preserve fixture compatibility without bypassing WP-1 normalization
    // for any real Git path.
    const effectPaths = [entry.path, ...(entry.originalPath ? [entry.originalPath] : []), ...entry.commitPathspecs];
    if (effectPaths.some((path) => !isCanonicalGitPath(path.pathBytesBase64))) return [];
    for (const effect of memberCommitEffects(member, entry, context)) {
      const existing = byPath.get(effect.pathBytesBase64);
      if (existing && canonicalize(existing) !== canonicalize(effect)) {
        throw new Error(`Conflicting candidate commit effects for ${effect.pathBytesBase64}.`);
      }
      byPath.set(effect.pathBytesBase64, effect);
    }
  }
  return [...byPath.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.pathBytesBase64, 'base64'), Buffer.from(right.pathBytesBase64, 'base64')));
}

interface ResolvedSelection {
  componentIds: string[];
  unattributedEntryIds: string[];
  memberEntries: DirtyEntry[];
  /** A selected "unattributed" entry that actually belongs to a witnessed component
   *  is a smuggled proper-subset of that component — never allowed (contract §4). */
  subsetViolation: boolean;
  blockingDrift: boolean;
}

/** Expand the request into its concrete member entries and detect a component
 *  proper-subset. Component ids expand to ALL their entries; unattributed entries
 *  are added independently. Unknown ids are caller bugs (throw). */
function resolveSelection(
  request: CandidateSelectionRequest,
  context: CandidateBuildContext,
): ResolvedSelection {
  const requestedIds = new Set(request.finalizationIds);
  const requestedFinalizations = context.finalizations.filter((row) => requestedIds.has(row.id));
  // Fleet-adhoc unattributed packages are the unstable live-membership case WP-3
  // addresses. Other package kinds retain whole-component expansion and closure
  // semantics; their finalization producers already own a stable package model.
  if (requestedFinalizations.length > 0
    && requestedFinalizations.every((row) => row.packageId.startsWith('unattributed:'))) {
    const resolved = resolvePinnedSelectionDrift({
      repositoryKey: context.repository.repositoryKey,
      inventory: context.inventory,
      components: context.components,
      finalizations: requestedFinalizations,
      requestedComponentIds: request.selectedComponentIds,
      requestedUnattributedEntryIds: request.selectedUnattributedEntryIds,
    });
    const componentEntryIds = new Set(context.components.flatMap((component) => component.dirtyEntryIds));
    return {
      componentIds: resolved.pinnedSelection.selectedComponentIds,
      unattributedEntryIds: resolved.pinnedSelection.selectedUnattributedEntryIds,
      memberEntries: resolved.frozenEntries,
      subsetViolation: request.selectedUnattributedEntryIds.some((entryId) => componentEntryIds.has(entryId)),
      // Missing frozen paths continue through the established closure proof:
      // an exact ledger link may mean that member was already committed. Byte
      // movement and re-attribution have no such safe closure escape hatch.
      blockingDrift: resolved.drift.byteMoved.length > 0 || resolved.drift.reAttributed.length > 0,
    };
  }
  const entriesById = new Map(context.inventory.entries.map((entry) => [entry.entryId, entry]));
  const componentById = new Map(context.components.map((component) => [component.componentId, component]));
  const allComponentEntryIds = new Set<string>();
  for (const component of context.components) {
    for (const entryId of component.dirtyEntryIds) allComponentEntryIds.add(entryId);
  }

  const memberIds = new Set<string>();
  const componentIds = [...new Set(request.selectedComponentIds)].sort(compareBase64);
  for (const componentId of componentIds) {
    const component = componentById.get(componentId);
    if (!component) throw new Error(`unknown component in selection: ${componentId}`);
    for (const entryId of component.dirtyEntryIds) memberIds.add(entryId);
  }

  let subsetViolation = false;
  const unattributedEntryIds = [...new Set(request.selectedUnattributedEntryIds)].sort(compareBase64);
  for (const entryId of unattributedEntryIds) {
    if (!entriesById.has(entryId)) throw new Error(`unknown unattributed entry in selection: ${entryId}`);
    // Selecting a component's entry AS an independent unattributed atom would carve
    // a proper subset out of that component — reject it (component atomicity).
    if (allComponentEntryIds.has(entryId)) subsetViolation = true;
    memberIds.add(entryId);
  }

  const memberEntries = [...memberIds]
    .map((entryId) => entriesById.get(entryId)!)
    .sort((left, right) => compareBase64(left.path.pathBytesBase64, right.path.pathBytesBase64));

  return { componentIds, unattributedEntryIds, memberEntries, subsetViolation, blockingDrift: false };
}

interface CoveringFrozen {
  finalization: PackageFinalization;
  frozen: FrozenManifestMember;
}

/** Index active finalizations by the path bytes their frozen manifest covers. */
function coveringByPath(
  finalizations: readonly PackageFinalization[],
): Map<string, CoveringFrozen[]> {
  const byPath = new Map<string, CoveringFrozen[]>();
  for (const finalization of finalizations) {
    if (finalization.lifecycleStatus !== 'active') continue;
    for (const frozen of parseFinalizationManifest(finalization)) {
      const list = byPath.get(frozen.pathBytesBase64) ?? [];
      list.push({ finalization, frozen });
      byPath.set(frozen.pathBytesBase64, list);
    }
  }
  return byPath;
}

function frozenAgree(a: FrozenManifestMember, b: FrozenManifestMember): boolean {
  return a.expectedState === b.expectedState
    && a.rawBlobOid === b.rawBlobOid
    && a.commitBlobOid === b.commitBlobOid
    && a.commitMode === b.commitMode;
}

interface MemberVerification {
  member: CandidateMember;
  conflict: boolean;
  usedFinalizationIds: string[];
}

function verifyMember(
  entry: DirtyEntry,
  covering: readonly CoveringFrozen[],
  context: CandidateBuildContext,
): MemberVerification {
  const protection = context.protectionByEntryId?.[entry.entryId] ?? 'unprotected';
  const base = {
    entryId: entry.entryId,
    path: entry.path,
    expectedWorktreeState: entry.expectedWorktreeState,
    rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
    protection,
  };

  if (covering.length === 0) {
    const verification: PackageVerificationState =
      entry.gitLevelEligibility === 'unsupported-git-state' ? 'unsupported-entry' : 'package-not-finalized';
    return {
      member: {
        ...base,
        expectedCommitBlobOid: null,
        expectedCommitMode: null,
        checkpointMode: null,
        coveringFinalizationIds: [],
        packageVerification: verification,
      },
      conflict: false,
      usedFinalizationIds: [],
    };
  }

  const coveringFinalizationIds = [...new Set(covering.map((c) => c.finalization.id))].sort(compareBase64);
  const frozen = covering[0].frozen;
  const conflict = covering.some((c) => !frozenAgree(c.frozen, frozen));
  const expectedCommitBlobOid = frozen.commitBlobOid;
  const expectedCommitMode = frozen.commitMode;

  let verification: PackageVerificationState;
  if (entry.gitLevelEligibility === 'unsupported-git-state') {
    verification = 'unsupported-entry';
  } else if (covering.some((c) => c.finalization.boundaryStatus !== 'ready')) {
    verification = 'final-checkpoint-unavailable';
  } else if (conflict) {
    // No single trustworthy expectation; eligibility carries the finalization-conflict.
    verification = 'verified-mismatch';
  } else {
    const rawMatch =
      entry.rawWorktreeBlobOid === frozen.rawBlobOid
      && entry.expectedWorktreeState === frozen.expectedState;
    const currentRep = context.currentCommitReps.get(entry.entryId);
    const currentCommitBlobOid = currentRep ? currentRep.commitBlobOid : null;
    const currentCommitMode = currentRep ? currentRep.commitMode : null;
    const commitMatch =
      currentCommitBlobOid === expectedCommitBlobOid && currentCommitMode === expectedCommitMode;
    verification = rawMatch && commitMatch ? 'verified-match' : 'verified-mismatch';
  }

  return {
    member: {
      ...base,
      expectedCommitBlobOid,
      expectedCommitMode,
      // Raw + commit modes coincide in v1; the field is retained for the case where
      // raw checkpoint semantics diverge from the clean-filtered commit entry.
      checkpointMode: expectedCommitMode,
      coveringFinalizationIds,
      packageVerification: verification,
    },
    conflict,
    usedFinalizationIds: coveringFinalizationIds,
  };
}

/** A frozen manifest member NOT selected in the candidate is only acceptable when
 *  it is EXACTLY locally committed already (contract §5.1) — raw match alone never
 *  suffices. Returns true when an exact commit-ledger proof exists. */
function ledgerProves(frozen: FrozenManifestMember, ledger: readonly CandidateLedgerLink[]): boolean {
  return ledger.some((link) =>
    link.pathBytesBase64 === frozen.pathBytesBase64
    && link.expectedState === frozen.expectedState
    && link.commitBlobOid === frozen.commitBlobOid
    && link.commitMode === frozen.commitMode,
  );
}

export function computeCandidateTopologyDigest(
  context: CandidateBuildContext,
  componentIds: readonly string[],
  unattributedEntries: readonly DirtyEntry[],
): string {
  const componentById = new Map(context.components.map((component) => [component.componentId, component]));
  // Each per-component `componentTopologyDigest` already binds that component's full
  // §3.2 per-entry contributor graph; composing the selected components' digests +
  // the selected unattributed atoms' path bytes yields a deterministic union digest
  // that is identical across both lenses and changes when the selected set changes.
  const componentDigests = componentIds
    .map((componentId) => componentById.get(componentId)!.componentTopologyDigest)
    .sort(compareBase64);
  const unattributedPaths = unattributedEntries
    .map((entry) => entry.path.pathBytesBase64)
    .sort(compareBase64);
  return sha256Hex(canonicalize({
    repositoryKey: context.repository.repositoryKey,
    components: componentDigests,
    unattributed: unattributedPaths,
  }));
}

/**
 * Assemble a `SelectionPreview` — a selection WITHOUT finalization coverage. Members
 * are listed with their git-level verification, but the preview is NEVER committable:
 * eligibility is always `package-not-finalized` (or `component-subset-not-allowed` if
 * the selection carves a proper subset of a witnessed component).
 */
export function buildSelectionPreview(
  request: CandidateSelectionRequest,
  context: CandidateBuildContext,
): SelectionPreview {
  const selection = resolveSelection(request, context);
  const members: CandidateMember[] = selection.memberEntries.map((entry) => {
    const protection = context.protectionByEntryId?.[entry.entryId] ?? 'unprotected';
    const verification: PackageVerificationState =
      entry.gitLevelEligibility === 'unsupported-git-state' ? 'unsupported-entry' : 'package-not-finalized';
    return {
      entryId: entry.entryId,
      path: entry.path,
      expectedWorktreeState: entry.expectedWorktreeState,
      rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
      expectedCommitBlobOid: null,
      expectedCommitMode: null,
      checkpointMode: null,
      coveringFinalizationIds: [],
      packageVerification: verification,
      protection,
    };
  });
  const eligibility: CommitEligibility = selection.subsetViolation
    ? { eligible: false, reason: 'component-subset-not-allowed' }
    : { eligible: false, reason: 'package-not-finalized' };
  return {
    componentIds: selection.componentIds,
    selectedUnattributedEntryIds: selection.unattributedEntryIds,
    members,
    eligibility,
  };
}

/**
 * Assemble a finalization-backed `CommitCandidate` (contract §4/§4.1/§4.2). With no
 * requested finalization this degrades to a `SelectionPreview`. Otherwise it enforces
 * component atomicity, finalization coverage + manifest agreement, the prior-exact-
 * commit closure, and per-member raw + clean-filtered verification, then derives the
 * lens-independent `candidateId`.
 */
export function buildCandidate(
  request: CandidateSelectionRequest,
  context: CandidateBuildContext,
): CommitCandidate | SelectionPreview {
  if (request.finalizationIds.length === 0) {
    return buildSelectionPreview(request, context);
  }

  const selection = resolveSelection(request, context);
  const requestedIds = new Set(request.finalizationIds);
  const requestedFinalizations = context.finalizations.filter((f) => requestedIds.has(f.id));
  const activeRequested = requestedFinalizations.filter((f) => f.lifecycleStatus === 'active');
  const byPath = coveringByPath(activeRequested);

  const selectedPaths = new Set(selection.memberEntries.map((entry) => entry.path.pathBytesBase64));

  const verifications = selection.memberEntries.map((entry) =>
    verifyMember(entry, byPath.get(entry.path.pathBytesBase64) ?? [], context),
  );
  const members = verifications.map((v) => v.member)
    .sort((left, right) => compareBase64(left.path.pathBytesBase64, right.path.pathBytesBase64));

  // Coverage set actually included: every active requested finalization that covers
  // at least one selected member. A requested finalization covering NO selected
  // member is extraneous (contract §4).
  const usedFinalizationIds = new Set(verifications.flatMap((v) => v.usedFinalizationIds));
  const extraneous = activeRequested.some((f) => !usedFinalizationIds.has(f.id));
  const includedFinalizations = activeRequested
    .filter((f) => usedFinalizationIds.has(f.id))
    .sort((left, right) => compareBase64(left.id, right.id));
  const finalizationRefs: FinalizationRef[] = includedFinalizations.map((f) => ({
    finalizationId: f.id,
    packageId: f.packageId,
    packageRevision: f.packageRevision,
    boundaryStatus: f.boundaryStatus,
  }));

  // Prior-exact-commit closure: every frozen manifest member of a USED finalization
  // that is NOT selected here must be exactly locally committed already, else the
  // package is not (yet) finalization-closed and the candidate is ineligible while
  // the finalization stays active.
  let closureUnproven = false;
  for (const finalization of includedFinalizations) {
    for (const frozen of parseFinalizationManifest(finalization)) {
      if (selectedPaths.has(frozen.pathBytesBase64)) continue;
      if (!ledgerProves(frozen, context.ledger)) closureUnproven = true;
    }
  }

  const eligibility = evaluateEligibility({
    subsetViolation: selection.subsetViolation,
    blockingDrift: selection.blockingDrift,
    extraneous,
    hasUnmerged: context.indexFingerprint.hasUnmerged,
    verifications,
    closureUnproven,
  });
  // Only an eligible candidate has complete verified representations. Ineligible
  // candidates remain renderable, but can never mint or reach the coordinator.
  const commitEffects = eligibility.eligible
    ? candidateCommitEffects(members, selection.memberEntries, context)
    : [];

  const identityDoc = {
    contractVersion: context.contractVersion,
    repositoryKey: context.repository.repositoryKey,
    gitObjectFormat: context.repository.gitObjectFormat,
    pinnedHeadOid: context.pinnedHeadOid,
    indexFingerprint: context.indexFingerprint.fingerprint,
    finalizations: finalizationRefs
      .map((ref) => ({
        finalizationId: ref.finalizationId,
        packageId: ref.packageId,
        packageRevision: ref.packageRevision,
      }))
      .sort((left, right) => compareBase64(left.finalizationId, right.finalizationId)),
    members: members.map((member) => ({
      pathBytesBase64: member.path.pathBytesBase64,
      rawWorktreeBlobOid: member.rawWorktreeBlobOid,
      expectedCommitBlobOid: member.expectedCommitBlobOid,
      expectedCommitMode: member.expectedCommitMode,
      expectedWorktreeState: member.expectedWorktreeState,
      coveringFinalizationIds: member.coveringFinalizationIds,
    })),
    commitEffects,
    componentTopologyDigest: computeCandidateTopologyDigest(
      context,
      selection.componentIds,
      selection.memberEntries.filter((entry) => selection.unattributedEntryIds.includes(entry.entryId)),
    ),
  };
  const candidateId = sha256Hex(canonicalize(identityDoc));

  return {
    candidateId,
    contractVersion: context.contractVersion,
    repository: context.repository,
    componentIds: selection.componentIds,
    selectedUnattributedEntryIds: selection.unattributedEntryIds,
    members,
    finalizations: finalizationRefs,
    eligibility,
    token: null,
  };
}

interface EligibilityInputs {
  subsetViolation: boolean;
  blockingDrift: boolean;
  extraneous: boolean;
  hasUnmerged: boolean;
  verifications: readonly MemberVerification[];
  closureUnproven: boolean;
}

/** Collapse the per-member verification states + structural checks into a single
 *  eligibility verdict, most-structural reason first (deterministic precedence). */
function evaluateEligibility(inputs: EligibilityInputs): CommitEligibility {
  if (inputs.subsetViolation) return { eligible: false, reason: 'component-subset-not-allowed' };
  if (inputs.extraneous) return { eligible: false, reason: 'extraneous-finalization' };
  if (inputs.blockingDrift) return { eligible: false, reason: 'byte-mismatch' };

  const states = inputs.verifications.map((v) => v.member.packageVerification);
  if (inputs.hasUnmerged || states.includes('unsupported-entry')) {
    return { eligible: false, reason: 'unsupported-git-state' };
  }
  if (inputs.verifications.some((v) => v.conflict)) {
    return { eligible: false, reason: 'finalization-conflict' };
  }
  if (states.includes('package-not-finalized') || inputs.closureUnproven) {
    return { eligible: false, reason: 'package-not-finalized' };
  }
  if (states.includes('final-checkpoint-unavailable')) {
    return { eligible: false, reason: 'checkpoint-unavailable' };
  }
  if (states.includes('verified-mismatch')) {
    return { eligible: false, reason: 'byte-mismatch' };
  }
  return { eligible: true };
}

// Kept structural and read-only for consumers that prefer a facade interface.
export interface CommitCandidateReadFacade {
  assembleInventory(request: CandidateReadRequest): Promise<CandidateInventoryRead>;
  listWorkBundles(request: CandidateReadRequest): Promise<WorkBundle[]>;
  listInventoryView(request: CandidateReadRequest): Promise<{
    bundles: WorkBundle[];
    quotaWeakening: SaveCardQuotaWeakening | null;
  }>;
}
