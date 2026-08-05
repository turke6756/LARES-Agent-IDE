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
} from '../../shared/commit-candidates';
import { COMMIT_CANDIDATE_TOKEN_CAP_PER_REPOSITORY } from '../../shared/constants';
import { canonicalize } from './jcs';
import type { CommitRepresentation } from './commit-representation';
import type { FrozenManifestMember } from './finalization-service';
import type { IndexFingerprintResult } from './index-fingerprint';
import type { PackageFinalization } from '../database';
import type { GitCapability } from '../../shared/types';
import type { RunGit } from '../git/git-runtime';
import {
  type RunGitBytesLike,
  type RunGitTextLike,
  produceDirtyInventory,
} from './dirty-inventory';
import {
  discoverScopeForWorkspace,
  type ScopeDiscoveryDeps,
  type WorkspaceScopeInput,
} from './scope-discovery';
import {
  projectWitnesses,
  type TurnWitnessReader,
  type WitnessStampSource,
} from './witness-projection';
import { assembleConflictComponents } from './component-assembler';
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
    request: MintCandidateTokenRequest,
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
    if (normalizedRequest.acknowledgeTopologyDigest !== topologyDigest) {
      return { ...built, eligibility: { eligible: false, reason: 'overlap-not-acknowledged' } };
    }
    if (!sameStrings(
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
    const selectedComponents = context.components.filter((component) =>
      built.componentIds.includes(component.componentId));
    const snapshot = cloneAndFreeze<CandidateTokenSnapshot>({
      token,
      candidate,
      repositoryKey: context.repository.repositoryKey,
      normalizedRequest,
      componentTopologyDigest: topologyDigest,
      pinnedHeadOid: context.pinnedHeadOid,
      indexFingerprint: context.indexFingerprint.fingerprint,
      indexWriteTreeOid: context.indexFingerprint.writeTreeOid,
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

    const inputs = request.workspaces.map((workspace): WorkspaceScopeInput => ({
      workspaceId: workspace.workspaceId,
      workspaceDir: workspace.workspaceDir,
      capability: workspace.capability,
    }));
    const workspaceByDir = new Map(
      request.workspaces.map((workspace) => [workspace.workspaceDir, workspace]),
    );
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
  pathBytesBase64: string;
  expectedState: 'present' | 'absent';
  commitBlobOid: string | null;
  commitMode: string | null;
}

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
