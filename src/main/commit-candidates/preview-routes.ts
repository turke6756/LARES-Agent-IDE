// SC-WP-W1 — production candidate-preview routes (read-only, both lenses).
//
// This is the bootstrap-side adapter that resolves a renderer selection into the
// full WP-3G `CandidateBuildContext`, so the pure `buildCandidate` assembler (the
// SAME one both the save lens and the plan lens run) can produce real
// `SelectionPreview` / `CommitCandidate` verdicts. It mirrors the SC-WP-1J
// read-only inventory adapter (`createSaveCardRoutes`): it owns NO assembly logic —
// it composes the already-committed read seams:
//
//   • inventory + components + protection  ← SC-WP-1G `CommitCandidateService.assembleInventory`
//   • ledger (prior-exact-commit closure)  ← SC-WP-3B `listCommitPathLinks`
//   • index fingerprint / hasUnmerged      ← SC-WP-3G `computeIndexFingerprint`
//   • pinned HEAD                          ← `git rev-parse --verify HEAD`
//   • current temp-index reps (per member) ← SC-WP-2J `readCurrentCommitRepresentation`
//   • requested finalizations              ← SC-WP-3A `getPackageFinalization`
//
// Read-only invariant: every Git seam here is a read (status / rev-parse /
// ls-files / hash-object). `readCurrentCommitRepresentation` self-guards by
// re-reading the real index before and after and throwing if it moved. Nothing
// here mutates the worktree, the index, or any ref.
//
// Repository-scope honesty (architectural invariant "agents share a working
// directory"): like the inventory adapter, the assembly probes EVERY registered
// workspace and unions the aliases that share the target's worktree, so a sibling
// lane's dirty file in the same folder is never silently dropped from the preview.

import * as fs from 'node:fs';

import type { GitCapability, SaveCardMintRequest, SaveCardPreviewRequest } from '../../shared/types';
import type { PlanCandidatePreviewRequest } from '../../shared/types';
import type { DirtyEntry } from '../../shared/commit-candidates';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import {
  getWorkspaces as dbGetWorkspaces,
  getTurnRecord as dbGetTurnRecord,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  getPackageFinalization as dbGetPackageFinalization,
  getPlanWorkPackage as dbGetPlanWorkPackage,
  listPlanWorkPackagePaths as dbListPlanWorkPackagePaths,
  listCommitPathLinks as dbListCommitPathLinks,
  listTurnRecords as dbListTurnRecords,
  listActivePackageFinalizationsForRepository as dbListActivePackageFinalizationsForRepository,
  type PackageFinalization,
  type PlanWorkPackage,
  type PlanWorkPackagePath,
} from '../database';
import { probeWorkspaceGit as realProbeWorkspaceGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  CommitCandidateService,
  computeCandidateTopologyDigest,
  buildCandidate,
  type CandidateTokenSnapshot,
  type CandidateBuildContext,
  type CandidateInventoryRead,
  type CandidateLedgerLink,
  type CandidateReadRequest,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from './candidate-service';
import { ComposeLockRegistry } from './compose-lock-registry';
import type {
  LiveReassembly,
  ReadMemberRepresentationInput,
  MemberRepresentation,
} from '../git-checkpoints/commit-coordinator';
import { CheckpointQueue } from '../git-checkpoints/checkpoint-queue';
import { computeIndexFingerprint } from './index-fingerprint';
import {
  readCurrentCommitRepresentation,
  type CommitRepresentation,
  type CommitRepresentationEntry,
} from './commit-representation';
import { createTurnStampSource, type TurnStampRecordReader } from './stamp-projection';
import type { RunGitBytesLike, RunGitTextLike } from './dirty-inventory';
import type { TurnWitnessReader } from './witness-projection';
import type { CommitPathLinkReader } from './protection-read';
import { SaveCardFinalizeRefusalError } from './save-card-ipc';
import type {
  FleetAdhocBoundaryContext,
  SaveCardFinalizeRoutes,
  SaveCardPreviewRoutes,
  SaveCardMintRoutes,
} from './save-card-ipc';
import { resolvePinnedSelectionDrift } from './pinned-selection-drift';
import type {
  FinalizePlanItemDoneRequest,
  PlanCandidatePreviewRoutes,
  PlanFinalizeEnrichmentResult,
} from '../plans/plan-ipc';

const OID_RE = /^[0-9a-f]{40,64}$/;
const HEAD_TIMEOUT_MS = 10_000;

/** Injected seams. Production passes only `gitExe` (the engine's already-resolved
 *  internal Git); the rest default to the live database / git runtime. Tests
 *  override every seam with in-memory fakes. Mirrors `SaveCardRoutesDeps`. */
export interface PreviewRoutesDeps {
  /** The internal Git exe already resolved by the checkpoint engine bootstrap. */
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string; title?: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readTurnRecord?: TurnStampRecordReader;
  readCaptureTurns?: CaptureTurnReader;
  readCommitPathLinks?: CommitPathLinkReader;
  /** Whole-repository commit ledger for the prior-exact-commit closure (unfiltered,
   *  unlike the path-scoped `readCommitPathLinks` the service uses internally). */
  listRepoCommitPathLinks?: (repositoryKey: string) => readonly CandidateLedgerLink[];
  readActiveFinalizations?: (repositoryKey: string) => readonly PackageFinalization[];
  getPackageFinalization?: (id: string) => PackageFinalization | null;
  getPlanWorkPackage?: (id: string) => PlanWorkPackage | null;
  listPlanWorkPackagePaths?: (id: string) => PlanWorkPackagePath[];
  runGit?: RunGitTextLike;
  runGitBytes?: RunGitBytesLike;
  /** Best-effort canonicalizer; defaults to `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
  contractVersion?: number;
  /** Read-only 1G assembly seam; defaults to the internal `CommitCandidateService`.
   *  Overridden in unit tests so the stitching (ledger / HEAD / fingerprint /
   *  finalizations / reps / plan-owned defaulting) is exercised without re-running
   *  the whole real-git 1G pipeline (already covered by save-card-routes.test). */
  assembleInventory?: (req: CandidateReadRequest) => Promise<CandidateInventoryRead>;
  /** Production uses the checkpoint engine's shared queue. */
  queue?: CheckpointQueue;
  /** Production checkpoint-native raw snapshot boundary; tests inject a fake. */
  captureFinalizationBoundary?: (
    workspaceId: string,
    label: string,
  ) => Promise<{ oid: string; treeOid: string }>;
  /** Shared with the CommitCoordinator and token store. */
  composeLocks?: ComposeLockRegistry;
}

/** The selection-independent portion of a preview assembly plus the resolved
 *  target-workspace git scope needed for the selection-dependent reads. */
interface PreviewScope {
  context: Omit<CandidateBuildContext, 'currentCommitReps' | 'finalizations'>;
  repoRoot: string;
  gitExe: string;
  pinnedHeadOid: string | null;
  runGit: RunGitTextLike;
  runGitBytes: RunGitBytesLike;
  /** Every dirty entry, keyed by id, so a selection can be expanded to members. */
  entriesById: ReadonlyMap<string, DirtyEntry>;
  /** Each component's member entry ids, so a whole-component selection expands. */
  componentEntryIds: ReadonlyMap<string, readonly string[]>;
}

export interface PreviewProductionSeams {
  candidateService: CommitCandidateService;
  composeLocks: ComposeLockRegistry;
  reassemble(snapshot: CandidateTokenSnapshot): Promise<LiveReassembly>;
  readMemberRepresentation(input: ReadMemberRepresentationInput): Promise<MemberRepresentation>;
  locateRepository(snapshot: CandidateTokenSnapshot): { repoRoot: string; gitExe?: string };
  deriveTrailers(snapshot: CandidateTokenSnapshot): string[];
}

function canonicalDir(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/**
 * Build the production preview routes for BOTH lenses. The two returned route
 * objects share ONE assembly path (`assembleScope` → `buildContext`); they differ
 * only in how the effective whole-component selection is derived (the save lens
 * takes the request's components verbatim; the plan lens defaults to the plan's own
 * components when the request omits them, matching `buildPlanCandidatePreview`).
 */
export function createPreviewRoutes(deps: PreviewRoutesDeps): {
  saveCardPreviewRoutes: SaveCardPreviewRoutes;
  saveCardMintRoutes: SaveCardMintRoutes;
  planPreviewRoutes: PlanCandidatePreviewRoutes;
  saveCardFinalizeRoutes: SaveCardFinalizeRoutes;
  productionSeams: PreviewProductionSeams;
} {
  const gitExe = deps.gitExe;
  const getWorkspaces = deps.getWorkspaces ?? dbGetWorkspaces;
  const probeWorkspaceGit = deps.probeWorkspaceGit ?? realProbeWorkspaceGit;
  const readTurnWitnesses = deps.readTurnWitnesses ?? dbGetTurnWitnessReads;
  const readTurnRecord = deps.readTurnRecord ?? dbGetTurnRecord;
  const readCaptureTurns: CaptureTurnReader =
    deps.readCaptureTurns ??
    ((workspaceId) => dbListTurnRecords(workspaceId, { limit: Number.MAX_SAFE_INTEGER }));
  const readCommitPathLinks = deps.readCommitPathLinks ?? dbListCommitPathLinks;
  const listRepoCommitPathLinks = deps.listRepoCommitPathLinks
    ?? ((repositoryKey: string) => dbListCommitPathLinks(repositoryKey));
  const getPackageFinalization = deps.getPackageFinalization ?? dbGetPackageFinalization;
  const getPlanWorkPackage = deps.getPlanWorkPackage ?? dbGetPlanWorkPackage;
  const listPlanWorkPackagePaths = deps.listPlanWorkPackagePaths ?? dbListPlanWorkPackagePaths;
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const realpath = deps.realpath ?? ((p) => fs.realpathSync.native(p));
  const contractVersion = deps.contractVersion ?? BUNDLE_CONTRACT_VERSION;
  const composeLocks = deps.composeLocks ?? new ComposeLockRegistry();
  const repositoryLocations = new Map<string, { repoRoot: string; gitExe?: string }>();

  const service = new CommitCandidateService({
    runGit,
    runGitBytes,
    readTurnWitnesses,
    stampSource: createTurnStampSource(readTurnRecord),
    readCaptureTurns,
    readCommitPathLinks,
    readActiveFinalizations: deps.readActiveFinalizations ?? dbListActivePackageFinalizationsForRepository,
    tokenStore: { composeLocks },
  });
  const assembleInventory = deps.assembleInventory
    ?? ((req: CandidateReadRequest) => service.assembleInventory(req));

  /** Resolve HEAD for the commit-representation base; null on an unborn HEAD. */
  async function resolvePinnedHead(repoRoot: string): Promise<string | null> {
    const result = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      gitExe,
      allowNonzero: true,
      timeoutMs: HEAD_TIMEOUT_MS,
      maxBytes: 4096,
    });
    const oid = result.stdout.trim();
    return result.code === 0 && OID_RE.test(oid) ? oid : null;
  }

  /** Assemble everything a context needs EXCEPT the selection-dependent temp-index
   *  reps and the requested finalizations. Probes every workspace (sibling union),
   *  runs the 1G facade, then reads the ledger / fingerprint / pinned HEAD. */
  async function assembleScope(workspaceId: string): Promise<PreviewScope> {
    const registeredWorkspaces = getWorkspaces();
    const workspaceRow = registeredWorkspaces.find((workspace) => workspace.id === workspaceId);
    if (!workspaceRow) {
      throw new SaveCardFinalizeRefusalError(
        `Cannot pin this package because it references an unknown workspace: ${workspaceId}.`,
        'save-card-unknown-workspace',
        workspaceId,
        workspaceId,
        'saveability',
      );
    }
    const workspaces: CandidateWorkspaceInput[] = await Promise.all(
      registeredWorkspaces.map(async (ws): Promise<CandidateWorkspaceInput> => {
        const workspaceDir = canonicalDir(realpath, ws.path);
        const capability = await probeWorkspaceGit(workspaceDir);
        return {
          workspaceId: ws.id,
          workspaceDir,
          capability: {
            commonDirQueueKey: capability.commonDirQueueKey,
            workspacePrefix: capability.workspacePrefix,
            repoRoot: capability.repoRoot,
          },
          gitExe,
        };
      }),
    );

    const target = workspaces.find((ws) => ws.workspaceId === workspaceId);
    if (!target) {
      throw new SaveCardFinalizeRefusalError(
        `Cannot pin this package because it references an unknown workspace: ${workspaceId}.`,
        'save-card-unknown-workspace',
        workspaceId,
        workspaceRow.title ?? workspaceId,
        'saveability',
      );
    }
    const repoRoot = target.capability.repoRoot;
    if (!repoRoot) {
      const workspaceTitle = workspaceRow.title ?? workspaceId;
      throw new SaveCardFinalizeRefusalError(
        `No git repository — cannot pin/commit from workspace '${workspaceTitle}'.`,
        'save-card-no-repository',
        workspaceId,
        workspaceTitle,
        'saveability',
      );
    }

    const read = await assembleInventory({
      targetWorkspaceId: workspaceId,
      workspaces,
    });

    const repository = read.inventory.repository;
    repositoryLocations.set(repository.repositoryKey, { repoRoot, gitExe });
    const [pinnedHeadOid, indexFingerprint] = await Promise.all([
      resolvePinnedHead(repoRoot),
      computeIndexFingerprint({ repoRoot, runGitBytes, runGit, gitExe }),
    ]);
    const ledger = listRepoCommitPathLinks(repository.repositoryKey);

    return {
      context: {
        repository,
        inventory: read.inventory,
        components: read.components,
        ledger,
        protectionByEntryId: read.protectionByEntryId,
        pinnedHeadOid,
        indexFingerprint,
        contractVersion,
      },
      repoRoot,
      gitExe,
      pinnedHeadOid,
      runGit,
      runGitBytes,
      entriesById: new Map(read.inventory.entries.map((entry) => [entry.entryId, entry])),
      componentEntryIds: new Map(read.components.map((c) => [c.componentId, c.dirtyEntryIds])),
    };
  }

  /** Expand a whole-component + unattributed selection to its concrete dirty
   *  entries (component ids → ALL their entries; unattributed entries as-is). */
  function selectionMembers(
    scope: PreviewScope,
    selectedComponentIds: readonly string[],
    selectedUnattributedEntryIds: readonly string[],
  ): DirtyEntry[] {
    const memberIds = new Set<string>();
    for (const componentId of selectedComponentIds) {
      for (const entryId of scope.componentEntryIds.get(componentId) ?? []) memberIds.add(entryId);
    }
    for (const entryId of selectedUnattributedEntryIds) memberIds.add(entryId);
    return [...memberIds]
      .map((entryId) => scope.entriesById.get(entryId))
      .filter((entry): entry is DirtyEntry => entry !== undefined);
  }

  /** Resolve the CURRENT temp-index commit representation per selected member.
   *  Only needed to VERIFY a finalization-backed candidate — a selection with no
   *  requested finalization degrades to a `SelectionPreview` that never reads the
   *  reps, so we skip the git work entirely in that (common) case. */
  async function resolveReps(
    scope: PreviewScope,
    members: readonly DirtyEntry[],
  ): Promise<Map<string, CommitRepresentation>> {
    const pairs = await Promise.all(
      members.map(async (entry): Promise<[string, CommitRepresentation]> => {
        const repEntry: CommitRepresentationEntry = {
          path: entry.path,
          commitPathspecs: entry.commitPathspecs,
          expectedWorktreeState: entry.expectedWorktreeState,
          rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
        };
        const rep = await readCurrentCommitRepresentation({
          repoRoot: scope.repoRoot,
          pinnedHeadOid: scope.pinnedHeadOid,
          entry: repEntry,
          gitExe: scope.gitExe,
          runGit: scope.runGit,
          runGitBytes: scope.runGitBytes,
          queue: deps.queue,
          commonDirQueueKey: deps.queue
            ? scope.context.repository.objectDatabaseKey
            : undefined,
        });
        return [entry.entryId, rep];
      }),
    );
    return new Map(pairs);
  }

  /** Complete a scope into a full build context for the given effective selection. */
  async function buildContext(
    scope: PreviewScope,
    selectedComponentIds: readonly string[],
    selectedUnattributedEntryIds: readonly string[],
    finalizationIds: readonly string[],
  ): Promise<CandidateBuildContext> {
    const finalizations = [...new Set(finalizationIds)]
      .map((id) => getPackageFinalization(id))
      .filter((f): f is PackageFinalization => f !== null);
    const effectiveMembers = finalizationIds.length === 0
      ? selectionMembers(scope, selectedComponentIds, selectedUnattributedEntryIds)
      : resolvePinnedSelectionDrift({
          repositoryKey: scope.context.repository.repositoryKey,
          inventory: scope.context.inventory,
          components: scope.context.components,
          finalizations,
          requestedComponentIds: selectedComponentIds,
          requestedUnattributedEntryIds: selectedUnattributedEntryIds,
        }).frozenEntries;
    const currentCommitReps = finalizationIds.length === 0
      ? new Map<string, CommitRepresentation>()
      : await resolveReps(
          scope,
          effectiveMembers,
        );
    return { ...scope.context, finalizations, currentCommitReps };
  }

  const saveCardPreviewRoutes: SaveCardPreviewRoutes = {
    async resolvePreviewContext(req: SaveCardPreviewRequest): Promise<CandidateBuildContext> {
      const scope = await assembleScope(req.workspaceId);
      return buildContext(
        scope,
        req.selectedComponentIds,
        req.selectedUnattributedEntryIds,
        req.finalizationIds,
      );
    },
  };
  const saveCardMintRoutes: SaveCardMintRoutes = {
    async mintCandidate(req: SaveCardMintRequest) {
      const scope = await assembleScope(req.workspaceId);
      const context = await buildContext(
        scope,
        req.selectedComponentIds,
        req.selectedUnattributedEntryIds,
        req.finalizationIds,
      );
      const candidate = service.mintCandidateToken({
        selectedComponentIds: req.selectedComponentIds,
        selectedUnattributedEntryIds: req.selectedUnattributedEntryIds,
        finalizationIds: req.finalizationIds,
        acknowledgeTopologyDigest: req.acknowledgeTopologyDigest,
        acknowledgeUnattributedEntryIds: req.acknowledgeUnattributedEntryIds,
        ...(req.reviewedManifestDigest !== undefined
          ? { reviewedManifestDigest: req.reviewedManifestDigest }
          : {}),
        ...(req.acknowledgedChallengeAtoms !== undefined
          ? { acknowledgedChallengeAtoms: req.acknowledgedChallengeAtoms }
          : {}),
      }, context);
      return { candidate, context };
    },
  };

  async function resolvePlanFinalizeRequest(
    planItemId: string,
  ): Promise<PlanFinalizeEnrichmentResult> {
    const pkg = getPlanWorkPackage(planItemId);
    if (!pkg) {
      return {
        ok: false,
        reason: 'plan-finalize-item-not-found',
        message: `Cannot mark ${planItemId} done because its work package no longer exists.`,
      };
    }

    let scope: PreviewScope;
    try {
      scope = await assembleScope(pkg.workspaceId);
    } catch (error) {
      return {
        ok: false,
        reason: 'plan-finalize-repository-unavailable',
        message: `Cannot mark ${planItemId} done because its repository is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // A member must come from concrete current inventory. Package-stamped turns are
    // authoritative; exact planned-path matches are the package's second durable
    // association rail. Neither rail invents a path or worktree representation.
    const memberIds = new Set<string>();
    for (const component of scope.context.components) {
      for (const association of component.associations) {
        if (association.planId === pkg.planId && association.planItemId === pkg.id) {
          for (const entryId of association.memberEntryIds) memberIds.add(entryId);
        }
      }
    }
    const plannedPaths = new Set(listPlanWorkPackagePaths(pkg.id).map((entry) => entry.path));
    for (const entry of scope.context.inventory.entries) {
      const current = entry.path.utf8Clean ? entry.path.displayPath : null;
      const original = entry.originalPath?.utf8Clean ? entry.originalPath.displayPath : null;
      if ((current && plannedPaths.has(current)) || (original && plannedPaths.has(original))) {
        memberIds.add(entry.entryId);
      }
    }
    const members = [...memberIds]
      .map((entryId) => scope.entriesById.get(entryId))
      .filter((entry): entry is DirtyEntry => entry !== undefined)
      .map((entry): CommitRepresentationEntry => ({
        path: entry.path,
        commitPathspecs: entry.commitPathspecs,
        expectedWorktreeState: entry.expectedWorktreeState,
        rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
      }));
    if (members.length === 0) {
      return {
        ok: false,
        reason: 'plan-finalize-members-unresolvable',
        message: `Cannot mark ${planItemId} done because no concrete dirty members resolve from its package stamps or planned paths.`,
      };
    }
    if (!deps.captureFinalizationBoundary) {
      return {
        ok: false,
        reason: 'plan-finalize-boundary-unavailable',
        message: `Cannot mark ${planItemId} done because checkpoint boundary capture is unavailable.`,
      };
    }

    let boundary: { oid: string; treeOid: string };
    try {
      boundary = await deps.captureFinalizationBoundary(
        pkg.workspaceId,
        `lares:finalization:plan-package:${planItemId}`,
      );
    } catch (error) {
      return {
        ok: false,
        reason: 'plan-finalize-boundary-unavailable',
        message: `Cannot mark ${planItemId} done because its checkpoint boundary could not be captured: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const request: FinalizePlanItemDoneRequest = {
      planItemId: pkg.id,
      repositoryKey: scope.context.repository.repositoryKey,
      boundaryOid: boundary.oid,
      members,
      checkpointTurnId: null,
      finalizedBy: 'human-ipc',
      createdFromWorkspaceId: pkg.workspaceId,
      contractVersion,
      repoRoot: scope.repoRoot,
      pinnedHeadOid: scope.pinnedHeadOid,
      gitExe,
    };
    return { ok: true, request };
  }

  const planPreviewRoutes: PlanCandidatePreviewRoutes = {
    async resolvePreviewContext(req: PlanCandidatePreviewRequest): Promise<CandidateBuildContext> {
      const scope = await assembleScope(req.workspaceId);
      // Mirror `buildPlanCandidatePreview`'s D-1 default: when the request omits
      // components, the plan's OWN components (every component with an association
      // to this plan) are selected whole — so the reps we resolve here match the
      // members the assembler will actually verify.
      const effectiveComponentIds = req.selectedComponentIds.length > 0
        ? req.selectedComponentIds
        : scope.context.components
            .filter((component) =>
              component.associations.some((association) => association.planId === req.planId),
            )
            .map((component) => component.componentId);
      return buildContext(
        scope,
        effectiveComponentIds,
        req.selectedUnattributedEntryIds,
        req.finalizationIds,
      );
    },
    resolveFinalizeRequest: resolvePlanFinalizeRequest,
  };

  async function reassemble(snapshot: CandidateTokenSnapshot): Promise<LiveReassembly> {
    const workspaceId = snapshot.candidate.repository.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error('candidate snapshot has no repository workspace');
    const scope = await assembleScope(workspaceId);
    const request = snapshot.normalizedRequest;
    const context = await buildContext(
      scope,
      request.selectedComponentIds,
      request.selectedUnattributedEntryIds,
      request.finalizationIds,
    );
    const rebuilt = buildCandidate(request, context);
    const entriesById = new Map(context.inventory.entries.map((entry) => [entry.entryId, entry]));
    const members = rebuilt.members.flatMap((member) => {
      const entry = entriesById.get(member.entryId);
      return entry ? [{
        entryId: entry.entryId,
        path: entry.path,
        commitPathspecs: entry.commitPathspecs,
        expectedWorktreeState: entry.expectedWorktreeState,
        rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
      }] : [];
    });
    const selectedUnattributed = context.inventory.entries.filter((entry) =>
      rebuilt.selectedUnattributedEntryIds.includes(entry.entryId),
    );
    return {
      candidateId: 'candidateId' in rebuilt ? rebuilt.candidateId : '',
      componentTopologyDigest: computeCandidateTopologyDigest(
        context,
        rebuilt.componentIds,
        selectedUnattributed,
      ),
      eligible: rebuilt.eligibility.eligible,
      ineligibleReason: rebuilt.eligibility.eligible ? null : rebuilt.eligibility.reason,
      members,
      pinnedHeadOid: context.pinnedHeadOid,
    };
  }

  async function readMemberRepresentation(
    input: ReadMemberRepresentationInput,
  ): Promise<MemberRepresentation> {
    return readCurrentCommitRepresentation({
      repoRoot: input.repoRoot,
      pinnedHeadOid: input.pinnedHeadOid,
      entry: {
        path: input.member.path,
        commitPathspecs: input.member.commitPathspecs,
        expectedWorktreeState: input.member.expectedWorktreeState,
        rawWorktreeBlobOid: input.member.rawWorktreeBlobOid,
      },
      gitExe: input.gitExe,
      runGit,
      runGitBytes,
    });
  }

  function locateRepository(
    snapshot: CandidateTokenSnapshot,
  ): { repoRoot: string; gitExe?: string } {
    const location = repositoryLocations.get(snapshot.repositoryKey);
    if (!location) throw new Error(`repository location unavailable for ${snapshot.repositoryKey}`);
    return location;
  }

  function deriveTrailers(snapshot: CandidateTokenSnapshot): string[] {
    const turnIds = new Set<string>();
    const planIds = new Set<string>();
    for (const association of snapshot.associations) {
      for (const turnId of association.contributingTurnIds) turnIds.add(turnId);
      if (association.planId) planIds.add(association.planId);
    }
    const trailers = [`Lares-Candidate: ${snapshot.candidate.candidateId}`];
    for (const turnId of [...turnIds].sort()) trailers.push(`Lares-Turn: ${turnId}`);
    for (const planId of [...planIds].sort()) trailers.push(`Lares-Plan: ${planId}`);
    return trailers;
  }

  // Route a fleet-adhoc mark-done by the REPOSITORY THE PANE IS SCOPED TO — the
  // same repository scope the inventory already used — NOT by scanning every
  // registered workspace. The package's files physically live in the pane's repo;
  // a contributing agent's home workspace (e.g. a broad "Computer Root" that
  // overlaps every repo and has no repoRoot of its own) is irrelevant to WHERE the
  // commit lands. `assembleScope(targetWorkspaceId)` throws the typed
  // `save-card-no-repository` / `save-card-unknown-workspace` refusals for the
  // genuine cases (the pane's OWN workspace has no repo, or is unregistered), so
  // an unrelated repo-less workspace can no longer poison every save.
  async function resolveFleetBoundary(
    packageId: string,
    targetWorkspaceId: string,
  ): Promise<FleetAdhocBoundaryContext> {
    if (!deps.captureFinalizationBoundary) {
      throw new SaveCardFinalizeRefusalError(
        'Boundary-capture stage refused because checkpoint capture is unavailable.',
        'boundary-capture-unavailable',
        targetWorkspaceId,
        targetWorkspaceId,
      );
    }
    const scope = await assembleScope(targetWorkspaceId);
    const repository = scope.context.repository;
    const componentId = packageId.startsWith('component:')
      ? packageId.slice('component:'.length)
      : packageId;
    const component = scope.context.components.find((candidate) => candidate.componentId === componentId);
    const entryIds = component
      ? component.dirtyEntryIds
      : packageId === `unattributed:${repository.repositoryKey}`
        ? scope.context.inventory.unattributedEntryIds
        : null;
    if (!entryIds) {
      throw new SaveCardFinalizeRefusalError(
        `Boundary-capture stage refused because the fleet-adhoc package is unknown: ${packageId}.`,
        'boundary-package-unknown',
        targetWorkspaceId,
        targetWorkspaceId,
      );
    }
    const entriesById = new Map(scope.context.inventory.entries.map((entry) => [entry.entryId, entry]));
    const members = entryIds
      .map((entryId) => entriesById.get(entryId))
      .filter((entry): entry is DirtyEntry => entry !== undefined)
      .map((entry): CommitRepresentationEntry => ({
        path: entry.path,
        commitPathspecs: entry.commitPathspecs,
        expectedWorktreeState: entry.expectedWorktreeState,
        rawWorktreeBlobOid: entry.rawWorktreeBlobOid,
      }));
    if (members.length === 0) {
      throw new SaveCardFinalizeRefusalError(
        `Boundary-capture stage refused because the package has no dirty members: ${packageId}.`,
        'boundary-package-empty',
        targetWorkspaceId,
        targetWorkspaceId,
      );
    }
    const boundary = await deps.captureFinalizationBoundary(
      targetWorkspaceId,
      `lares:finalization:${packageId}`,
    );
    return {
      packageId,
      repositoryKey: repository.repositoryKey,
      finalizedBy: 'human-ipc',
      checkpointTurnId: null,
      boundaryOid: boundary.oid,
      contractVersion,
      createdFromWorkspaceId: targetWorkspaceId,
      members,
      repoRoot: scope.repoRoot,
      pinnedHeadOid: scope.pinnedHeadOid,
      gitExe,
      runGit,
      runGitBytes,
      queue: deps.queue,
      commonDirQueueKey: deps.queue ? repository.objectDatabaseKey : undefined,
      pinnedSelection: {
        selectedComponentIds: component ? [component.componentId] : [],
        selectedUnattributedEntryIds: component ? [] : [...entryIds].sort(),
        frozenMemberCount: members.length,
      },
    };
  }

  const saveCardFinalizeRoutes: SaveCardFinalizeRoutes = {
    resolveBoundary: (request) => resolveFleetBoundary(request.packageId, request.targetWorkspaceId),
  };
  const productionSeams: PreviewProductionSeams = {
    candidateService: service,
    composeLocks,
    reassemble,
    readMemberRepresentation,
    locateRepository,
    deriveTrailers,
  };

  return { saveCardPreviewRoutes, saveCardMintRoutes, planPreviewRoutes, saveCardFinalizeRoutes, productionSeams };
}
