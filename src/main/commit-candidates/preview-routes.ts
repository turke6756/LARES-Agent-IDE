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

import type { GitCapability, SaveCardPreviewRequest } from '../../shared/types';
import type { PlanCandidatePreviewRequest } from '../../shared/types';
import type { DirtyEntry } from '../../shared/commit-candidates';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import {
  getWorkspaces as dbGetWorkspaces,
  getTurnRecord as dbGetTurnRecord,
  getTurnWitnessReads as dbGetTurnWitnessReads,
  getPackageFinalization as dbGetPackageFinalization,
  listCommitPathLinks as dbListCommitPathLinks,
  listTurnRecords as dbListTurnRecords,
  type PackageFinalization,
} from '../database';
import { probeWorkspaceGit as realProbeWorkspaceGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import {
  CommitCandidateService,
  type CandidateBuildContext,
  type CandidateInventoryRead,
  type CandidateLedgerLink,
  type CandidateReadRequest,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from './candidate-service';
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
import type { SaveCardPreviewRoutes } from './save-card-ipc';
import type { PlanCandidatePreviewRoutes } from '../plans/plan-ipc';

const OID_RE = /^[0-9a-f]{40,64}$/;
const HEAD_TIMEOUT_MS = 10_000;

/** Injected seams. Production passes only `gitExe` (the engine's already-resolved
 *  internal Git); the rest default to the live database / git runtime. Tests
 *  override every seam with in-memory fakes. Mirrors `SaveCardRoutesDeps`. */
export interface PreviewRoutesDeps {
  /** The internal Git exe already resolved by the checkpoint engine bootstrap. */
  gitExe: string;
  getWorkspaces?: () => ReadonlyArray<{ id: string; path: string }>;
  probeWorkspaceGit?: (canonicalWorkspaceDir: string) => Promise<GitCapability>;
  readTurnWitnesses?: TurnWitnessReader;
  readTurnRecord?: TurnStampRecordReader;
  readCaptureTurns?: CaptureTurnReader;
  readCommitPathLinks?: CommitPathLinkReader;
  /** Whole-repository commit ledger for the prior-exact-commit closure (unfiltered,
   *  unlike the path-scoped `readCommitPathLinks` the service uses internally). */
  listRepoCommitPathLinks?: (repositoryKey: string) => readonly CandidateLedgerLink[];
  getPackageFinalization?: (id: string) => PackageFinalization | null;
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
  planPreviewRoutes: PlanCandidatePreviewRoutes;
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
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const realpath = deps.realpath ?? ((p) => fs.realpathSync.native(p));
  const contractVersion = deps.contractVersion ?? BUNDLE_CONTRACT_VERSION;

  const service = new CommitCandidateService({
    runGit,
    runGitBytes,
    readTurnWitnesses,
    stampSource: createTurnStampSource(readTurnRecord),
    readCaptureTurns,
    readCommitPathLinks,
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
    const workspaces: CandidateWorkspaceInput[] = await Promise.all(
      getWorkspaces().map(async (ws): Promise<CandidateWorkspaceInput> => {
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
    if (!target) throw new Error(`unknown target workspace: ${workspaceId}`);
    const repoRoot = target.capability.repoRoot;
    if (!repoRoot) throw new Error(`workspace has no repository root: ${workspaceId}`);

    const read = await assembleInventory({
      targetWorkspaceId: workspaceId,
      workspaces,
    });

    const repository = read.inventory.repository;
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
    const currentCommitReps = finalizationIds.length === 0
      ? new Map<string, CommitRepresentation>()
      : await resolveReps(
          scope,
          selectionMembers(scope, selectedComponentIds, selectedUnattributedEntryIds),
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
  };

  return { saveCardPreviewRoutes, planPreviewRoutes };
}
