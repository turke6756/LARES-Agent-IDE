// Main-process IPC surface for plans and proposals.

import { ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import type {
  PlanListItem,
  PathType,
  Plan,
  Agent,
  PromoteProposalResult,
  PromotionStatus,
  PlanIntentsProjection,
  PlanTabKey,
  PlanTabOverview,
  PromotedPlanFolder,
  PromotedPlanFolderListResult,
  MissionBoardCard,
  MissionBoardPackageTimeline,
  BlameToIntentRequest,
  BlameToIntentResult,
  PlanReviewProjection,
  PlanReviewProjectionRequest,
  SaveCardBundle,
  Workspace,
  ObservedOverviewSourceToken,
} from '../../shared/types';
import {
  hasSupervisorPrivilege,
  isPlanTabKey,
  PLAN_TAB_KEYS,
  PLAN_REVIEW_PROJECTION_CHANNEL,
} from '../../shared/types';
import {
  getPlans,
  getPlanWorkPackage as dbGetPlanWorkPackage,
  getAgent as dbGetAgent,
  getPlan as dbGetPlan,
  getPlanByWorkspaceArtifactId as dbGetPlanByWorkspaceArtifactId,
  getPromotionRequestById as dbGetPromotionRequestById,
  getPlanTabOverview as dbGetPlanTabOverview,
  setPlanTabOverview as dbSetPlanTabOverview,
  getDb,
  getPlanFolderProjectionState,
  listPlanTabOverviewSources,
  recordPlanOverviewProjectionStatus,
  getActivePlanExecutionRun,
  getWorkspace,
  listPlanWorkPackagePaths,
  listPlanWorkPackagesOrdered,
  listRecoveryOperations,
  listTurnRecords,
} from '../database';
import type { PlanWorkPackage, StructuredPlanRow, PromotionRequestRow } from '../database';
import type { PromoteResult, ProposalRef } from './promote-proposal';
import { listPlanningEntries, readPlanningDocument } from './planning-reader';
import { buildPlanGallery, readProposalDocument } from './plan-gallery';
import type { PlanGalleryOptions } from '../../shared/types';
import {
  finalizePackage,
  type FinalizePackageResult,
} from '../commit-candidates/finalization-service';
import type { CommitRepresentationEntry } from '../commit-candidates/commit-representation';
import {
  buildCandidate,
  type CandidateBuildContext,
  type CandidateSelectionRequest,
} from '../commit-candidates/candidate-service';
import {
  PLAN_PREVIEW_CHANNEL,
  type PlanCandidatePreviewRequest,
  type PlanCandidatePreviewResponse,
} from '../../shared/types';
import { getPlanIntentsProjection } from './plan-intent-ledger';
import { buildPlanDocuments, readPlanDocument, type PlanDocumentsDeps } from './plan-documents';
import {
  createPlanComment,
  answerPlanComment,
  listPlanComments,
  defaultListPlanCommentsDeps,
  type CreatePlanCommentDeps,
  type AnswerPlanCommentDeps,
  type ListPlanCommentsDeps,
} from './plan-comments';
import { registerPlanImplementIpc } from './plan-implement';
import { workspaceStateDir, workspaceStateDirName } from '../workspace-state-dir';
import { listMissionBoardCards, listMissionBoardTimeline } from './mission-board';
import { queryBlameToIntent } from './blame-to-intent';
import { projectPlanReview, type PlanReviewProjectionInput } from './plan-review-projection';
import { projectMissionBoardEvidence } from './mission-board-evidence';
import { projectDurableStampedTrail, projectLiveStampedActivity } from './stamped-evidence-projection';
import { probeWorkspaceGit } from '../git/git-runtime';
import { computeBundleCaptureHealth } from '../commit-candidates/capture-health';
import { projectWorkBundles } from '../commit-candidates/work-bundle';
import { runGit } from '../git-checkpoints/git-command';
import { observeOverviewSource, parsePlanHumanOverview,
  type OverviewSourceObservation } from './plan-human-overview';
import { parseStrictJson } from './strict-json';
import { reconcilePlanFolderProjections } from './plan-folder-reconciler';

const MAX_PROMOTED_PLAN_JSON_BYTES = 256_000;
const ARCHIVED_PLAN_STATUSES = new Set(['archived', 'superseded', 'cancelled', 'canceled']);

function manifestString(manifest: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = manifest[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function manifestOwner(manifest: Record<string, unknown>): PromotedPlanFolder['responsibleSupervisor'] {
  const events = manifest.responsibility_events;
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event || typeof event !== 'object' || (event as Record<string, unknown>).event !== 'assigned') continue;
    const row = event as Record<string, unknown>;
    return {
      display: typeof row.display === 'string' ? row.display : null,
      agentId: typeof row.agent_id === 'string' ? row.agent_id : null,
      source: typeof row.source === 'string' ? row.source : null,
    };
  }
  return null;
}

/** Filesystem-first plan-folder projection. The state-dir helper preserves the
 * `.dashboard` fallback; no renderer or IPC caller constructs that path. */
export function listPromotedPlanFolders(
  workspaceId: string,
  workspaceRoot: string,
  pathType: PathType = 'windows',
  resolvePlanId: (workspaceId: string, artifactId: string) => string | null =
    (wsId, artifactId) => dbGetPlanByWorkspaceArtifactId(wsId, artifactId)?.id ?? null,
): PromotedPlanFolderListResult {
  const plans: PromotedPlanFolder[] = [];
  const warnings: string[] = [];
  if (!workspaceId || !workspaceRoot) return { plans, warnings: ['workspace is required'] };
  const plansRoot = path.join(workspaceStateDir(workspaceRoot, pathType), 'plans');
  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(plansRoot, { withFileTypes: true });
  } catch {
    return { plans, warnings };
  }
  for (const folder of folders.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = path.join(plansRoot, folder.name, 'plan.json');
    try {
      const stat = fs.lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROMOTED_PLAN_JSON_BYTES) {
        warnings.push(`skipped ${folder.name}: invalid plan.json`);
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const planArtifactId = manifestString(manifest, 'plan_artifact_id');
      if (!planArtifactId) {
        warnings.push(`skipped ${folder.name}: plan.json has no plan_artifact_id`);
        continue;
      }
      const status = manifestString(manifest, 'status', 'run_state', 'phase') ?? 'promoted';
      plans.push({
        planArtifactId,
        planId: resolvePlanId(workspaceId, planArtifactId) ?? planArtifactId,
        folderName: folder.name,
        title: manifestString(manifest, 'title', 'plan_title', 'plan_sku') ?? folder.name,
        status,
        archived: manifest.archived === true || ARCHIVED_PLAN_STATUSES.has(status.toLowerCase()),
        updatedAt: typeof manifest.updated_at === 'string' || typeof manifest.updated_at === 'number'
          ? manifest.updated_at
          : null,
        responsibleSupervisor: manifestOwner(manifest),
      });
    } catch {
      warnings.push(`skipped ${folder.name}: unreadable plan.json`);
    }
  }
  plans.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  return { plans, warnings };
}

// ── Save-card SC-WP-3D — plan-package `done` finalization wiring ──────────────
//
// An explicit plan-item `done` transition mints a `finalization_kind='plan-package'`
// finalization via the WP-3C service. The service does the crash-safe work: it
// freezes the member manifest, force-creates the durable boundary ref, records the
// `package_finalizations` row, AND flips `plan_work_packages.state='done'` inside the
// SAME SQLite txn — so `done` never appears without a `ready` finalization. This is
// the ONLY producer of a plan-package boundary; it is never auto-derived from
// `accepted`. WP-3D is wiring only: the caller (WP-3G candidate assembly) supplies the
// already-computed boundary OID and the members to freeze — this layer forwards them,
// it never computes eligibility.

/** Stable package identity for a plan work package's finalization boundary. The WP-3C
 *  service keys revisions and the durable ref on `packageId`, so it MUST be a pure
 *  function of the item id — never the workspace, the boundary oid, or a timestamp —
 *  so re-finalizing the same item resolves to the same package and bumps a revision. */
export function planPackageId(planItemId: string): string {
  return `plan-package:${planItemId}`;
}

export interface FinalizePlanItemDoneRequest {
  /** The plan work package being marked done. Its row supplies planId + workspace. */
  planItemId: string;
  repositoryKey: string;
  /** The computed boundary OID (`checkpoint_oid`) + the members to freeze — supplied
   *  by the caller (WP-3G); WP-3D forwards, it never computes them. */
  boundaryOid: string;
  members: CommitRepresentationEntry[];
  checkpointTurnId: string | null;
  finalizedBy: string;
  /** Overrides the work package's own workspace as the finalize provenance; null ⇒
   *  the work package's `workspaceId` is used. */
  createdFromWorkspaceId?: string | null;
  contractVersion: number;
  // ── freeze inputs (temp-index base + git seam) ──
  repoRoot: string;
  pinnedHeadOid: string | null;
  gitExe?: string;
  deadlineAt?: number;
}

export type PlanFinalizeRefusalReason =
  | 'plan-finalize-enrichment-unavailable'
  | 'plan-finalize-item-not-found'
  | 'plan-finalize-repository-unavailable'
  | 'plan-finalize-members-unresolvable'
  | 'plan-finalize-boundary-unavailable';

export class PlanFinalizeError extends Error {
  constructor(message: string, readonly code: PlanFinalizeRefusalReason) {
    super(message);
    this.name = 'PlanFinalizeError';
  }
}

export type PlanFinalizeEnrichmentResult =
  | { ok: true; request: FinalizePlanItemDoneRequest }
  | { ok: false; reason: Exclude<PlanFinalizeRefusalReason, 'plan-finalize-enrichment-unavailable'>; message: string };

export interface PlanFinalizeRoutes {
  resolveFinalizeRequest(planItemId: string): Promise<PlanFinalizeEnrichmentResult>;
}

export interface FinalizePlanItemDoneDeps {
  getPlanWorkPackage?: (id: string) => PlanWorkPackage | null;
  finalize?: (
    ...args: Parameters<typeof finalizePackage>
  ) => ReturnType<typeof finalizePackage>;
}

/**
 * Explicit plan-item `done` transition → a `plan-package` finalization via WP-3C.
 * Looks up the work package to derive its `planId` (and default workspace), then calls
 * the finalization service with `finalizationKind='plan-package'`. Throws if the item
 * does not exist — a `done` transition on an unknown package is a caller bug, and the
 * work-package flip to `done` happens INSIDE the service's txn, not here.
 */
export async function finalizePlanItemDone(
  request: FinalizePlanItemDoneRequest,
  deps: FinalizePlanItemDoneDeps = {},
): Promise<FinalizePackageResult> {
  const getPkg = deps.getPlanWorkPackage ?? dbGetPlanWorkPackage;
  const finalize = deps.finalize ?? finalizePackage;

  const pkg = getPkg(request.planItemId);
  if (!pkg) {
    throw new Error(
      `cannot finalize plan-package done: no plan work package ${request.planItemId}`,
    );
  }

  return finalize({
    packageId: planPackageId(pkg.id),
    repositoryKey: request.repositoryKey,
    finalizationKind: 'plan-package',
    planId: pkg.planId,
    planItemId: pkg.id,
    finalizedBy: request.finalizedBy,
    checkpointTurnId: request.checkpointTurnId,
    boundaryOid: request.boundaryOid,
    contractVersion: request.contractVersion,
    createdFromWorkspaceId: request.createdFromWorkspaceId ?? pkg.workspaceId,
    members: request.members,
    repoRoot: request.repoRoot,
    pinnedHeadOid: request.pinnedHeadOid,
    gitExe: request.gitExe,
    deadlineAt: request.deadlineAt,
  });
}

// ── SC-WP-3I — plan-lens candidate preview channel ────────────────────────────
//
// The plan lens's own read-only preview transport. It resolves a plan-scoped
// selection into the full WP-3G `CandidateBuildContext` (inventory, components,
// requested finalizations, temp-index reps, ledger, fingerprint, pinned HEAD) via an
// injected route, then calls the SAME pure `buildCandidate` assembler the save lens
// uses. Consequences (contract §14 / D-1):
//   • the assembled `candidateId` + member verdicts are IDENTICAL to the save lens
//     for the same effective selection — identity/topology live ONLY in the 3G
//     service, never recomputed here;
//   • the lens only FILTERS / ANNOTATES whole components — it forwards whole
//     component ids (defaulting to the plan's own components when the request omits
//     them) and never carves a sub-candidate, and `buildCandidate` itself rejects a
//     smuggled component subset (`component-subset-not-allowed`), so a component that
//     connects to OTHER plans can never be split by this lens.
// Read-only: nothing here touches the worktree, index, or refs.

/** Minimal `ipcMain.handle` shape so the channel is testable without a live main. */
export interface PlanIpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

// ── WP-P4A: folder-native tab model + guarded body reads ──

export function runPlanDocumentsList(rawPlanId: unknown, deps: PlanDocumentsDeps = {}) {
  if (typeof rawPlanId !== 'string' || rawPlanId === '') return null;
  return buildPlanDocuments(rawPlanId, deps);
}

export function runPlanDocumentRead(
  rawPlanId: unknown,
  rawRef: unknown,
  deps: PlanDocumentsDeps = {},
) {
  if (typeof rawPlanId !== 'string' || rawPlanId === '') return { error: 'missing plan id' };
  return readPlanDocument(rawPlanId, rawRef, deps);
}

export function registerPlanDocumentsIpc(
  ipc: PlanIpcLike,
  deps: PlanDocumentsDeps = {},
): void {
  ipc.handle('plan:documents', (_event, rawPlanId: unknown) =>
    runPlanDocumentsList(rawPlanId, deps));
  ipc.handle('plan:document:read', (_event, rawPlanId: unknown, rawRef: unknown) =>
    runPlanDocumentRead(rawPlanId, rawRef, deps));
}

// ── WP-P2L-proj — ledger + derived confidence read ──────────────────────────

export interface PlanIntentsIpcDeps {
  getProjection: (planId: string) => PlanIntentsProjection | null;
}

const defaultPlanIntentsIpcDeps: PlanIntentsIpcDeps = {
  getProjection: getPlanIntentsProjection,
};

/** Pure handler core. The caller supplies only an opaque plan id; all confidence
 * fields are computed below the IPC boundary from ledger/orchestration/disk truth. */
export function runPlanIntentsList(
  rawPlanId: unknown,
  deps: PlanIntentsIpcDeps = defaultPlanIntentsIpcDeps,
): PlanIntentsProjection | null {
  if (typeof rawPlanId !== 'string' || rawPlanId === '') return null;
  return deps.getProjection(rawPlanId);
}

export function registerPlanIntentsIpc(
  ipc: PlanIpcLike,
  deps: PlanIntentsIpcDeps = defaultPlanIntentsIpcDeps,
): void {
  ipc.handle('plan:intents:list', (_event, rawPlanId: unknown) =>
    runPlanIntentsList(rawPlanId, deps),
  );
}

/** The main-process seam the plan-lens preview channel drives. `resolvePreviewContext`
 *  maps a renderer plan selection to the full WP-3G build context; the handler then
 *  calls the pure `buildCandidate` assembler. Left unset in this WP — a later
 *  bootstrap injects the production resolver via `providePlanPreviewRoutes`. */
export interface PlanCandidatePreviewRoutes {
  resolvePreviewContext(req: PlanCandidatePreviewRequest): Promise<CandidateBuildContext>;
  /** Main-only identity enrichment for Mission Board Done. Optional so preview-only
   *  tests/injections remain honest: omission means Done is unavailable, never that
   *  the IPC layer fabricates freeze inputs. */
  resolveFinalizeRequest?: PlanFinalizeRoutes['resolveFinalizeRequest'];
}

class PlanPreviewError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PlanPreviewError';
  }
}

/** Injected production route, evaluated per invocation so the channel can register
 *  before the candidate engine finishes bootstrapping. Null ⇒ answer "unavailable"
 *  honestly (mirrors the save-lens channel's null-route pattern). */
let planPreviewRoutes: PlanCandidatePreviewRoutes | null = null;
let planFinalizeRoutes: PlanFinalizeRoutes | null = null;

/** Inject (or clear) the production plan-lens preview route once the candidate
 *  engine has bootstrapped. Until wired, `PLAN_PREVIEW_CHANNEL` rejects honestly. */
export function providePlanPreviewRoutes(routes: PlanCandidatePreviewRoutes | null): void {
  planPreviewRoutes = routes;
  planFinalizeRoutes = routes?.resolveFinalizeRequest
    ? { resolveFinalizeRequest: routes.resolveFinalizeRequest.bind(routes) }
    : null;
}

function isFullFinalizePlanItemDoneRequest(raw: unknown): raw is FinalizePlanItemDoneRequest {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return typeof r.planItemId === 'string'
    && typeof r.repositoryKey === 'string'
    && typeof r.boundaryOid === 'string'
    && Array.isArray(r.members)
    && (typeof r.checkpointTurnId === 'string' || r.checkpointTurnId === null)
    && typeof r.finalizedBy === 'string'
    && typeof r.contractVersion === 'number'
    && typeof r.repoRoot === 'string'
    && (typeof r.pinnedHeadOid === 'string' || r.pinnedHeadOid === null);
}

/** Identity-only renderer requests are enriched below the trust boundary. Already-full
 *  main-side callers retain the WP-3D pass-through contract unchanged. */
export async function runFinalizePlanItemDoneRequest(
  raw: unknown,
  getRoutes: () => PlanFinalizeRoutes | null = () => planFinalizeRoutes,
  finalize: (request: FinalizePlanItemDoneRequest) => Promise<FinalizePackageResult> = finalizePlanItemDone,
): Promise<FinalizePackageResult> {
  if (!raw || typeof raw !== 'object'
      || typeof (raw as Record<string, unknown>).planItemId !== 'string'
      || (raw as Record<string, unknown>).planItemId === '') {
    throw new PlanFinalizeError('missing plan item id', 'plan-finalize-item-not-found');
  }
  if (isFullFinalizePlanItemDoneRequest(raw)) return finalize(raw);

  const routes = getRoutes();
  if (!routes) {
    throw new PlanFinalizeError(
      'Cannot mark this package done because finalization enrichment is unavailable.',
      'plan-finalize-enrichment-unavailable',
    );
  }
  const enriched = await routes.resolveFinalizeRequest(
    (raw as { planItemId: string }).planItemId,
  );
  if (!enriched.ok) throw new PlanFinalizeError(enriched.message, enriched.reason);
  return finalize(enriched.request);
}

function requirePlanPreviewRequest(raw: unknown): PlanCandidatePreviewRequest {
  if (!raw || typeof raw !== 'object') {
    throw new PlanPreviewError(
      'a plan preview request with a non-empty workspaceId + planId is required',
      'plan-preview-bad-request',
    );
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.workspaceId !== 'string' || record.workspaceId === '') {
    throw new PlanPreviewError('a non-empty workspaceId is required', 'plan-preview-bad-request');
  }
  if (typeof record.planId !== 'string' || record.planId === '') {
    throw new PlanPreviewError('a non-empty planId is required', 'plan-preview-bad-request');
  }
  const asStringArray = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new PlanPreviewError(`${field} must be an array of strings`, 'plan-preview-bad-request');
    }
    return value as string[];
  };
  return {
    workspaceId: record.workspaceId,
    planId: record.planId,
    selectedComponentIds: asStringArray(record.selectedComponentIds, 'selectedComponentIds'),
    selectedUnattributedEntryIds: asStringArray(
      record.selectedUnattributedEntryIds,
      'selectedUnattributedEntryIds',
    ),
    finalizationIds: asStringArray(record.finalizationIds, 'finalizationIds'),
  };
}

/**
 * The pure plan-lens preview core: resolve the D-1 whole-component selection and run
 * the shared WP-3G `buildCandidate`. Component ids are forwarded verbatim (whole
 * components); when the request omits them the plan's OWN components — every
 * component with an association to `planId` — are selected whole. The lens never
 * carves a subset: `buildCandidate` alone owns identity/topology, so a component that
 * also connects to other plans is included whole (annotated), never split.
 */
export function buildPlanCandidatePreview(
  request: PlanCandidatePreviewRequest,
  context: CandidateBuildContext,
): PlanCandidatePreviewResponse {
  const planOwnedComponentIds = context.components
    .filter((component) =>
      component.associations.some((association) => association.planId === request.planId),
    )
    .map((component) => component.componentId);
  const selectedComponentIds = request.selectedComponentIds.length > 0
    ? [...request.selectedComponentIds]
    : planOwnedComponentIds;

  const selection: CandidateSelectionRequest = {
    selectedComponentIds,
    selectedUnattributedEntryIds: request.selectedUnattributedEntryIds,
    finalizationIds: request.finalizationIds,
  };
  const candidate = buildCandidate(selection, context);
  return {
    candidate,
    isCandidate: 'candidateId' in candidate,
    selection: {
      selectedComponentIds: [...selectedComponentIds],
      selectedUnattributedEntryIds: [...request.selectedUnattributedEntryIds],
      finalizationIds: [...request.finalizationIds],
    },
  };
}

/**
 * Register the read-only plan-lens preview channel. Mirrors the save-lens handler:
 * validate → resolve context via the injected route → run the pure `buildCandidate`
 * assembler → return the candidate + the echoed D-1 selection. `getRoutes` is
 * evaluated per invocation so registration can precede the engine's route injection.
 */
export function registerPlanCandidatePreviewIpc(
  ipc: PlanIpcLike,
  getRoutes: () => PlanCandidatePreviewRoutes | null,
): void {
  ipc.handle(
    PLAN_PREVIEW_CHANNEL,
    async (_event, raw: unknown): Promise<PlanCandidatePreviewResponse> => {
      const routes = getRoutes();
      if (!routes) {
        throw new PlanPreviewError(
          'Plan preview engine unavailable (the engine has not finished bootstrapping)',
          'plan-preview-engine-unavailable',
        );
      }
      const request = requirePlanPreviewRequest(raw);
      const context = await routes.resolvePreviewContext(request);
      return buildPlanCandidatePreview(request, context);
    },
  );
}

async function resolvePlanReviewProjectionInput(
  request: PlanReviewProjectionRequest,
  routes: PlanCandidatePreviewRoutes,
): Promise<PlanReviewProjectionInput> {
  const plan = dbGetPlan(request.planId);
  if (!plan || plan.workspaceId !== request.workspaceId) {
    throw new Error('the requested plan does not belong to this workspace');
  }
  const executionRun = getActivePlanExecutionRun(request.planId);
  if (!executionRun) {
    throw new Error('no work packages implemented yet — pull Implement to begin');
  }

  const workspace = getWorkspace(request.workspaceId);
  if (!workspace) throw new Error('workspace not found');
  const capability = await probeWorkspaceGit(workspace.path);
  if (!capability.repoRoot) throw new Error('workspace has no repository root');

  const previewRequest: PlanCandidatePreviewRequest = {
    workspaceId: request.workspaceId,
    planId: request.planId,
    selectedComponentIds: [],
    selectedUnattributedEntryIds: [],
    finalizationIds: [],
  };
  const context = await routes.resolvePreviewContext(previewRequest);
  const scObject = buildPlanCandidatePreview(previewRequest, context).candidate;

  const packages = listPlanWorkPackagesOrdered(request.planId)
    .filter((pkg) => pkg.workspaceId === request.workspaceId);
  const plannedPaths = packages.flatMap((pkg) => listPlanWorkPackagePaths(pkg.id))
    .filter((entry) => entry.workspaceId === request.workspaceId);
  const planTurns = listTurnRecords(request.workspaceId, { limit: 200 });
  const evidence = projectMissionBoardEvidence({
    workspaceId: request.workspaceId,
    planId: request.planId,
    packages,
    plannedPaths,
    liveActivity: projectLiveStampedActivity(planTurns),
    durableTrail: projectDurableStampedTrail(planTurns, listRecoveryOperations(request.workspaceId)),
  });

  const repositoryTurns = context.repository.workspaces.flatMap((entry) =>
    listTurnRecords(entry.workspaceId, { limit: 200 }));
  const turnsById = new Map(repositoryTurns.map((turn) => [turn.id, turn]));
  const entriesById = new Map(context.inventory.entries.map((entry) => [entry.entryId, entry]));
  const captureEntries = await Promise.all(context.components.map(async (component) => {
    const contributingTurnIds = new Set(
      component.associations.flatMap((association) => association.contributingTurnIds),
    );
    const turns = [...contributingTurnIds]
      .map((turnId) => turnsById.get(turnId))
      .filter((turn): turn is NonNullable<typeof turn> => turn !== undefined);
    const dirtyEntries = component.dirtyEntryIds
      .map((entryId) => entriesById.get(entryId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    return [component.componentId, await computeBundleCaptureHealth({
      repoRoot: capability.repoRoot!, turns, dirtyEntries, runGit,
    })] as const;
  }));
  const unattributedEntries = context.inventory.unattributedEntryIds
    .map((entryId) => entriesById.get(entryId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const unattributedCaptureHealth = await computeBundleCaptureHealth({
    repoRoot: capability.repoRoot, turns: [], dirtyEntries: unattributedEntries, runGit,
  });
  const scBundles = projectWorkBundles({
    inventory: context.inventory,
    components: context.components,
    captureHealthByComponentId: Object.fromEntries(captureEntries),
    unattributedCaptureHealth,
    protectionByEntryId: context.protectionByEntryId ?? {},
  }) as SaveCardBundle[];
  const workspacePrefix = context.repository.workspaces
    .find((entry) => entry.workspaceId === request.workspaceId)?.workspacePrefix;
  if (workspacePrefix === undefined) throw new Error('workspace is outside the candidate repository');

  return {
    workspaceId: request.workspaceId,
    planId: request.planId,
    repoRoot: capability.repoRoot,
    workspacePrefix,
    executionRun,
    evidence,
    scObject,
    scBundles,
  };
}

export function registerPlanReviewProjectionIpc(
  ipc: PlanIpcLike,
  getRoutes: () => PlanCandidatePreviewRoutes | null,
): void {
  ipc.handle(PLAN_REVIEW_PROJECTION_CHANNEL, async (_event, raw: unknown): Promise<PlanReviewProjection> => {
    const request = raw as PlanReviewProjectionRequest;
    if (!request || typeof request.workspaceId !== 'string' || !request.workspaceId
        || typeof request.planId !== 'string' || !request.planId) {
      throw new Error('a non-empty workspaceId and planId are required');
    }
    const routes = getRoutes();
    if (!routes) throw new Error('plan review engine unavailable');
    return projectPlanReview(await resolvePlanReviewProjectionInput(request, routes));
  });
}

// ── WP-P3C′ — proposal-promotion IPC (`proposal:promote`, `proposal:promotionStatus`) ──
//
// Two thin handlers over the WP-P3B-core/enrich promotion service. This layer owns
// NO promotion business logic (§P3-GAP: no document selection anywhere) — it does
// exactly three things the renderer cannot:
//   1. SERVER-side re-validate the picked supervisor — the client may only OFFER a
//      privileged same-workspace agent; the server independently rejects anything
//      else via hasSupervisorPrivilege + same-workspace membership.
//   2. Drive the deps-bound WP-P3B-core `promoteProposal` (resolveProposal /
//      scanClaims / deliverer / enrich all injected by the wiring lane) and map its
//      internal `PromoteResult` down to the renderer-facing discriminated
//      `PromoteProposalResult` — returning PROMPTLY, never blocking on the watcher.
//   3. Expose the durable status read (`promotion_requests` + the adopted `plans`
//      row) the dialog polls to resolve a `promotion-pending` result.
//
// The production service is injected by the wiring lane via
// `providePromotionService` (mirrors `providePlanPreviewRoutes`); until wired, both
// handlers reject honestly. This keeps the full core-deps wiring in the wiring
// lane's file, not here.

/** The deps-bound promotion seam the wiring lane injects. `promote` is
 *  WP-P3B-core `promoteProposal` with all of its production deps bound;
 *  `resolveProposal` is the SAME proposal resolver, exposed so the handler can
 *  read the proposal's workspace for server-side supervisor revalidation before
 *  minting anything. */
export interface PromotionService {
  promote(input: { proposalId: string; supervisorId: string }): Promise<PromoteResult>;
  resolveProposal(proposalId: string): ProposalRef | null | Promise<ProposalRef | null>;
}

let promotionService: PromotionService | null = null;

/** Inject (or clear) the production promotion service once the WP-P3B core/enrich
 *  deps are wired. Until wired, `proposal:promote` / `proposal:promotionStatus`
 *  reject honestly (the dialog surfaces "promotion unavailable"). */
export function providePromotionService(service: PromotionService | null): void {
  promotionService = service;
}

class PromoteError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PromoteError';
  }
}

/** Injectable seams for the two handlers — defaults to the real service + db
 *  accessors; overridden wholesale in `proposal-promote-ipc.test.ts`. */
export interface PromoteIpcDeps {
  service: PromotionService | null;
  getAgent: (id: string) => Agent | null;
  getPlan: (id: string) => Plan | null;
  getPlanByWorkspaceArtifactId: (workspaceId: string, artifactId: string) => StructuredPlanRow | null;
  getPromotionRequestById: (id: string) => PromotionRequestRow | null;
}

function defaultPromoteIpcDeps(): PromoteIpcDeps {
  return {
    service: promotionService,
    getAgent: dbGetAgent,
    getPlan: dbGetPlan,
    getPlanByWorkspaceArtifactId: dbGetPlanByWorkspaceArtifactId,
    getPromotionRequestById: dbGetPromotionRequestById,
  };
}

function requireStringField(raw: unknown, field: string): string {
  const record = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : null;
  const value = record?.[field];
  if (typeof value !== 'string' || value === '') {
    throw new PromoteError(`a non-empty ${field} is required`, 'promote-bad-request');
  }
  return value;
}

/** Resolve the adopted plan row (full shared `Plan`) for a workspace + plan
 *  artifact id, or null when no `plans` row exists yet. */
function resolveAdoptedPlan(deps: PromoteIpcDeps, workspaceId: string, planArtifactId: string): Plan | null {
  const row = deps.getPlanByWorkspaceArtifactId(workspaceId, planArtifactId);
  if (!row) return null;
  return deps.getPlan(row.id);
}

/**
 * `proposal:promote` core. Server-side revalidates the picked supervisor, drives the
 * deps-bound WP-P3B-core promote, and maps its `PromoteResult` to the renderer
 * `PromoteProposalResult`. Rejecting outcomes (non-supervisor, duplicate, foreign,
 * launch-failed) throw — they are never a silent status. Returns PROMPTLY (the core
 * never blocks on the watcher); a repeat call on a pending/adopted proposal reflects
 * the existing operation and mints nothing new (WP-P3B-core idempotency).
 */
export async function runPromoteProposal(
  raw: unknown,
  deps: PromoteIpcDeps,
): Promise<PromoteProposalResult> {
  const proposalId = requireStringField(raw, 'proposalId');
  const supervisorId = requireStringField(raw, 'supervisorId');

  const service = deps.service;
  if (!service) {
    throw new PromoteError(
      'Promotion is unavailable (the promotion service has not finished bootstrapping)',
      'promotion-service-unavailable',
    );
  }

  // Resolve the proposal FIRST — its workspace bounds the supervisor revalidation.
  const proposal = await service.resolveProposal(proposalId);
  if (!proposal) {
    throw new PromoteError(`proposal not found: ${proposalId}`, 'promote-proposal-not-found');
  }

  // ── Server-side supervisor revalidation (never trust the client's filter). ──
  const agent = deps.getAgent(supervisorId);
  if (!agent || !hasSupervisorPrivilege(agent) || agent.workspaceId !== proposal.workspaceId) {
    throw new PromoteError(
      `not an eligible supervisor for this workspace: ${supervisorId}`,
      'promote-supervisor-rejected',
    );
  }

  const result = await service.promote({ proposalId, supervisorId });

  switch (result.status) {
    case 'adopted': {
      const plan = resolveAdoptedPlan(deps, proposal.workspaceId, result.planArtifactId);
      if (!plan) {
        throw new PromoteError(
          `promotion adopted but no plan row for ${result.planArtifactId}`,
          'promote-adopted-plan-missing',
        );
      }
      return { status: 'adopted', plan };
    }
    case 'promotion-pending':
      return {
        status: 'promotion-pending',
        promotionRequestId: result.requestId,
        planArtifactId: result.planArtifactId,
      };
    case 'duplicate-blocked':
      throw new PromoteError(result.diagnostic, 'promote-duplicate-blocked');
    case 'rejected-foreign':
      throw new PromoteError(result.diagnostic, 'promote-rejected-foreign');
    case 'failed':
      throw new PromoteError(result.reason, 'promote-failed');
    default: {
      // Exhaustiveness guard — a new PromoteResult variant must be mapped here.
      const _never: never = result;
      throw new PromoteError('unhandled promote result', 'promote-unhandled');
    }
  }
}

/**
 * `proposal:promotionStatus` core. A runtime read over the durable
 * `promotion_requests` row (+ the adopted `plans` row once enrichment surfaces it) —
 * NOT a private durable skill format. The dialog polls this with bounded backoff to
 * resolve a `promotion-pending` result to its plan.
 */
export function runPromotionStatus(raw: unknown, deps: PromoteIpcDeps): PromotionStatus {
  const promotionRequestId = requireStringField(raw, 'promotionRequestId');
  const request = deps.getPromotionRequestById(promotionRequestId);
  if (!request) {
    throw new PromoteError(`unknown promotion request: ${promotionRequestId}`, 'promotion-status-unknown');
  }
  const plan = request.state === 'adopted'
    ? resolveAdoptedPlan(deps, request.workspaceId, request.planArtifactId)
    : null;
  return {
    promotionRequestId: request.id,
    state: request.state,
    planArtifactId: request.planArtifactId,
    plan,
    failureReason: request.failureReason,
    attemptCount: request.attemptCount,
  };
}

/** Register the two WP-P3C′ promotion channels on the given ipc surface. Split from
 *  `registerPlanIpc` so the ipc test can drive registration against a fake ipcMain. */
export function registerPromotionIpc(ipc: PlanIpcLike): void {
  ipc.handle('proposal:promote', (_event, raw: unknown) =>
    runPromoteProposal(raw, defaultPromoteIpcDeps()),
  );
  ipc.handle('proposal:promotionStatus', (_event, raw: unknown) =>
    runPromotionStatus(raw, defaultPromoteIpcDeps()),
  );
}

// ── WP-P4C-backend — per-tab supervisor overview (`plan:getOverview` / `plan:setOverview`) ──
//
// Two thin handlers over the P3A `plan_tab_overviews` accessors. READS are open
// (any renderer): the overview is durable, non-secret plan content. WRITES are
// supervisor-privileged and revalidated SERVER-side exactly like the promotion IPC
// — the client may only OFFER a supervisor; the server independently rejects a
// non-privileged agent, an agent from a DIFFERENT workspace than the plan, or an
// unknown plan/agent via `hasSupervisorPrivilege` + same-workspace membership. The
// stored row is keyed by the stable `PlanTabKey` domain (validated here), never a
// free-text tab from the renderer. The `overview` key holds the plain-language
// summary rendered above `ARC.md`; ARC itself remains the overview tab's document.

class PlanOverviewError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PlanOverviewError';
  }
}

/** Injectable seams for the two overview handlers — defaults to the real db
 *  accessors; overridden wholesale in `plan-overview.test.ts` so the pure handler
 *  cores are testable without a live DB or electron. */
export interface PlanOverviewIpcDeps {
  getAgent: (id: string) => Agent | null;
  getPlan: (id: string) => Plan | null;
  getOverview: (planId: string, tab: string) => PlanTabOverview | null;
  setOverview: (input: {
    planId: string;
    tab: string;
    body: string | null;
    updatedBy: string;
  }) => PlanTabOverview;
  getStructuredContext?: (planId: string) => StructuredOverviewContext | null;
  getProjectionState?: typeof getPlanFolderProjectionState;
  listOverviewSources?: typeof listPlanTabOverviewSources;
  observe?: (folderAbs: string) => OverviewSourceObservation;
  replaceFile?: typeof replaceOverviewFile;
  reconcile?: typeof reconcilePlanFolderProjections;
  afterTempSync?: (input: { planId: string; tempAbs: string; destinationAbs: string }) => Promise<void> | void;
  now?: () => number;
}

function defaultPlanOverviewIpcDeps(): PlanOverviewIpcDeps {
  return {
    getAgent: dbGetAgent,
    getPlan: dbGetPlan,
    getOverview: dbGetPlanTabOverview,
    setOverview: dbSetPlanTabOverview,
    getStructuredContext: defaultStructuredContext,
    getProjectionState: getPlanFolderProjectionState,
    listOverviewSources: listPlanTabOverviewSources,
    observe: observeOverviewSource,
    replaceFile: replaceOverviewFile,
    reconcile: reconcilePlanFolderProjections,
  };
}

function overviewDeps(deps: PlanOverviewIpcDeps) {
  return {
    ...deps,
    getStructuredContext: deps.getStructuredContext ?? defaultStructuredContext,
    getProjectionState: deps.getProjectionState ?? getPlanFolderProjectionState,
    listOverviewSources: deps.listOverviewSources ?? listPlanTabOverviewSources,
    observe: deps.observe ?? observeOverviewSource,
    replaceFile: deps.replaceFile ?? replaceOverviewFile,
    reconcile: deps.reconcile ?? reconcilePlanFolderProjections,
    now: deps.now ?? Date.now,
  };
}

/** Validate + narrow the (planId, tab) pair shared by both handlers. Returns null
 *  when the request is not a well-formed read of a valid `PlanTabKey` — the read
 *  handler degrades to `null`, the write handler throws (a write is a command). */
function readPlanTabRequest(raw: unknown): { planId: string; tab: PlanTabKey } | null {
  const record = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : null;
  const planId = record?.planId;
  const tab = record?.tab;
  if (typeof planId !== 'string' || planId === '') return null;
  if (!isPlanTabKey(tab)) return null;
  return { planId, tab };
}

function parseDiagnosticMessages(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.map((item) => item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).detail === 'string'
      ? (item as Record<string, unknown>).detail as string : String(item));
  } catch { return []; }
}

type OverviewEditAction = 'save' | 'remove';
interface OverviewEditRequest {
  planId: string;
  tab: PlanTabKey;
  action: OverviewEditAction;
  body: string | null;
  expectedSourceHash: ObservedOverviewSourceToken;
}

function readOverviewEditRequest(raw: unknown): OverviewEditRequest {
  const req = readPlanTabRequest(raw);
  if (!req) throw new PlanOverviewError(
    'a non-empty planId and a valid tab key are required', 'overview-bad-request',
  );
  const record = raw as Record<string, unknown>;
  const action = record.action === 'remove' || record.body === null ? 'remove' : 'save';
  const body = record.body;
  if (action === 'save' && (typeof body !== 'string' || body.trim() === '')) {
    throw new PlanOverviewError('an overview body is required; use Remove to delete a section', 'overview-empty-body');
  }
  if (body !== null && body !== undefined && typeof body !== 'string') {
    throw new PlanOverviewError('body must be a string or null', 'overview-bad-request');
  }
  const token = record.expectedSourceHash;
  if (typeof token !== 'string' || !/^(?:absent|unsafe|unreadable|sha256:[a-f0-9]{64})$/.test(token)) {
    throw new PlanOverviewError('expectedSourceHash is required', 'overview-bad-request');
  }
  return { ...req, action, body: typeof body === 'string' ? body : null,
    expectedSourceHash: token as ObservedOverviewSourceToken };
}

const OVERVIEW_HEADINGS: Record<PlanTabKey, string> = {
  overview: 'Overview', proposal: 'Proposal', plan: 'Plan', deliberations: 'Deliberations',
  research: 'Research', supplements: 'Supplements', packages: 'Packages', 'legacy-html': 'Legacy',
};

interface LocatedOverviewSection {
  tab: PlanTabKey; heading: string; beginStart: number; beginEnd: number; endStart: number; endEnd: number;
}

function outsideMarkdownFenceComments(source: string): Array<{ start: number; end: number; inner: string }> {
  const normalized = source.replace(/\r\n/g, '\n');
  const fenceRanges: Array<{ start: number; end: number }> = [];
  let active: { char: string; length: number; start: number } | null = null;
  let offset = 0;
  for (const lineWithBreak of normalized.match(/.*(?:\n|$)/g) ?? []) {
    if (lineWithBreak === '') continue;
    const line = lineWithBreak.endsWith('\n') ? lineWithBreak.slice(0, -1) : lineWithBreak;
    if (!active) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) active = { char: open[1][0], length: open[1].length, start: offset };
    } else {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === active.char && close[1].length >= active.length) {
        fenceRanges.push({ start: active.start, end: offset + lineWithBreak.length });
        active = null;
      }
    }
    offset += lineWithBreak.length;
  }
  if (active) fenceRanges.push({ start: active.start, end: normalized.length });
  const comments: Array<{ start: number; end: number; inner: string }> = [];
  for (const match of normalized.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (match.index === undefined || fenceRanges.some((range) => match.index! >= range.start && match.index! < range.end)) continue;
    comments.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }
  if (!source.includes('\r\n')) return comments;
  const originalOffset = (at: number) => at + (normalized.slice(0, at).match(/\n/g)?.length ?? 0);
  return comments.map((comment) => ({ start: originalOffset(comment.start), end: originalOffset(comment.end), inner: comment.inner }));
}

function locateOverviewSections(source: string, artifactId: string): {
  newline: '\n' | '\r\n'; indexStart: number; indexEnd: number; entries: LocatedOverviewSection[];
} {
  const parsed = parsePlanHumanOverview(source, artifactId);
  if (!parsed.ok) throw new PlanOverviewError(
    'OVERVIEW.md is invalid; repair it in a file editor before section editing', 'overview-source-invalid',
  );
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const comments = outsideMarkdownFenceComments(source);
  const index = comments.find((comment) => /^PLAN-TAB-OVERVIEWS:v1(?:\s|$)/.test(comment.inner));
  if (!index) throw new PlanOverviewError('overview index is missing', 'overview-source-invalid');
  const raw = parseStrictJson(index.inner.replace(/^PLAN-TAB-OVERVIEWS:v1\s*/, '')) as {
    sections: Array<{ tab: PlanTabKey; heading: string }>;
  };
  const entries = raw.sections.map((entry) => {
    const begin = comments.find((comment) => comment.inner.trim() === `PLAN-TAB-SECTION:${entry.tab}:BEGIN`)!;
    const end = comments.find((comment) => comment.inner.trim() === `PLAN-TAB-SECTION:${entry.tab}:END`)!;
    return { ...entry, beginStart: begin.start, beginEnd: begin.end, endStart: end.start, endEnd: end.end };
  });
  return { newline, indexStart: index.start, indexEnd: index.end, entries };
}

function canonicalOverviewIndex(artifactId: string,
  entries: ReadonlyArray<{ tab: PlanTabKey; heading: string }>, newline: string): string {
  const ordered = PLAN_TAB_KEYS.flatMap((tab) => {
    const entry = entries.find((candidate) => candidate.tab === tab);
    return entry ? [{ tab: entry.tab, heading: entry.heading }] : [];
  });
  const json = JSON.stringify({ schema_version: 1, plan_artifact_id: artifactId, sections: ordered }, null, 2)
    .replace(/\n/g, newline);
  return `<!--PLAN-TAB-OVERVIEWS:v1${newline}${json}${newline}-->`;
}

function sectionBlock(tab: PlanTabKey, heading: string, body: string, newline: string): string {
  const normalizedBody = body.replace(/\r\n?/g, '\n').replace(/\n/g, newline);
  return `<!--PLAN-TAB-SECTION:${tab}:BEGIN-->${newline}${newline}## ${heading}${newline}${newline}${normalizedBody}${newline}${newline}<!--PLAN-TAB-SECTION:${tab}:END-->`;
}

export function editPlanHumanOverview(source: string, artifactId: string, tab: PlanTabKey,
  action: OverviewEditAction, body: string | null): string {
  const located = locateOverviewSections(source, artifactId);
  const current = located.entries.find((entry) => entry.tab === tab);
  if (action === 'remove') {
    if (!current) throw new PlanOverviewError('overview section is already absent', 'overview-section-absent');
    let start = current.beginStart;
    let end = current.endEnd;
    if (source.slice(end, end + located.newline.length) === located.newline) end += located.newline.length;
    else if (source.slice(start - located.newline.length, start) === located.newline) start -= located.newline.length;
    const without = source.slice(0, start) + source.slice(end);
    const index = canonicalOverviewIndex(artifactId, located.entries.filter((entry) => entry.tab !== tab), located.newline);
    const removedBeforeIndex = start < located.indexStart ? end - start : 0;
    const indexStart = located.indexStart - removedBeforeIndex;
    const indexEnd = located.indexEnd - removedBeforeIndex;
    return without.slice(0, indexStart) + index + without.slice(indexEnd);
  }
  if (!body || body.trim() === '') throw new PlanOverviewError('overview body is empty', 'overview-empty-body');
  const heading = current?.heading ?? OVERVIEW_HEADINGS[tab];
  const block = sectionBlock(tab, heading, body, located.newline);
  if (current) return source.slice(0, current.beginStart) + block + source.slice(current.endEnd);
  const rewrittenIndex = canonicalOverviewIndex(artifactId, [...located.entries, { tab, heading }], located.newline);
  const withIndex = source.slice(0, located.indexStart) + rewrittenIndex + source.slice(located.indexEnd);
  const delta = rewrittenIndex.length - (located.indexEnd - located.indexStart);
  const following = located.entries.filter((entry) => PLAN_TAB_KEYS.indexOf(entry.tab) > PLAN_TAB_KEYS.indexOf(tab))
    .sort((a, b) => PLAN_TAB_KEYS.indexOf(a.tab) - PLAN_TAB_KEYS.indexOf(b.tab))[0];
  const insertAt = following ? following.beginStart + delta : withIndex.length;
  const before = withIndex.slice(0, insertAt);
  const after = withIndex.slice(insertAt);
  const separator = before.endsWith(located.newline + located.newline) ? '' : located.newline;
  const suffix = after === '' || after.startsWith(located.newline) ? '' : located.newline;
  return before + separator + block + suffix + after;
}

function buildOverviewFile(artifactId: string, bodies: ReadonlyMap<PlanTabKey, string>, newline = '\n'): string {
  const entries = PLAN_TAB_KEYS.filter((tab) => Boolean(bodies.get(tab)?.trim()))
    .map((tab) => ({ tab, heading: OVERVIEW_HEADINGS[tab] }));
  const frontmatter = `---${newline}plan_artifact_id: ${artifactId}${newline}kind: human-overview${newline}schema_version: 1${newline}---`;
  const sections = entries.map((entry) => sectionBlock(entry.tab, entry.heading, bodies.get(entry.tab)!, newline))
    .join(newline + newline);
  return `${frontmatter}${newline}${newline}${canonicalOverviewIndex(artifactId, entries, newline)}${sections ? newline + newline + sections : ''}${newline}`;
}

function verifyStructuredContext(context: StructuredOverviewContext): void {
  let manifest: unknown;
  try {
    const folder = fs.lstatSync(context.folderAbs);
    const manifestAbs = path.join(context.folderAbs, 'plan.json');
    const stat = fs.lstatSync(manifestAbs);
    if (!folder.isDirectory() || folder.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe');
    manifest = parseStrictJson(fs.readFileSync(manifestAbs, 'utf8'));
  } catch {
    throw new PlanOverviewError('the structured plan folder is unsafe or unreadable', 'overview-folder-unsafe');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || (manifest as Record<string, unknown>).plan_artifact_id !== context.artifactId) {
    throw new PlanOverviewError('plan.json identity changed', 'overview-identity-mismatch');
  }
}

function isTransientOverviewFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Retried sibling-temp rename. A failure never deletes or rewrites the destination;
 * the caller owns cleanup of the still-separate temp. */
export async function replaceOverviewFile(tempAbs: string, destinationAbs: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (process.platform === 'win32') {
        try { const stat = fs.lstatSync(destinationAbs); fs.chmodSync(destinationAbs, stat.mode | 0o200); } catch { /* absent/unsupported */ }
      }
      fs.renameSync(tempAbs, destinationAbs);
      return;
    } catch (err) {
      if (attempt >= 4 || !isTransientOverviewFsError(err)) throw err;
      await delay(20 * (attempt + 1));
    }
  }
}

async function writeOverviewReplacement(input: {
  req: OverviewEditRequest;
  context: StructuredOverviewContext;
  next: Buffer;
  expectedFinalToken: ObservedOverviewSourceToken;
  deps: ReturnType<typeof overviewDeps>;
}): Promise<ObservedOverviewSourceToken> {
  const destinationAbs = path.join(input.context.folderAbs, 'OVERVIEW.md');
  const tempAbs = `${destinationAbs}.tmp-${randomBytes(16).toString('hex')}`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempAbs, 'wx');
    await handle.writeFile(input.next);
    await handle.sync();
    await handle.close();
    handle = null;
    await input.deps.afterTempSync?.({ planId: input.req.planId, tempAbs, destinationAbs });
    verifyStructuredContext(input.context);
    const finalObservation = input.deps.observe(input.context.folderAbs);
    if (finalObservation.token !== input.expectedFinalToken) {
      throw new PlanOverviewError('the overview changed on disk while editing', 'overview-source-stale');
    }
    // This last observation narrows the external-writer window but the filesystem
    // offers no indivisible compare-and-replace primitive. An editor outside Lares
    // can still write between this observation and rename; later reconciliation
    // faithfully projects whichever bytes are actually present.
    await input.deps.replaceFile(tempAbs, destinationAbs);
    try {
      const parent = await fs.promises.open(input.context.folderAbs, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch { /* directory sync is unsupported on some platforms */ }
    return input.deps.observe(input.context.folderAbs).token;
  } finally {
    if (handle) try { await handle.close(); } catch { /* best effort */ }
    try { await fs.promises.unlink(tempAbs); } catch { /* absent or best-effort cleanup */ }
  }
}

const overviewWriteTails = new Map<string, Promise<void>>();
async function serializedOverviewWrite<T>(planId: string, operation: () => Promise<T>): Promise<T> {
  const prior = overviewWriteTails.get(planId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.catch(() => undefined).then(() => gate);
  overviewWriteTails.set(planId, queued);
  await prior.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (overviewWriteTails.get(planId) === queued) overviewWriteTails.delete(planId);
  }
}

async function runStructuredSetOverview(req: OverviewEditRequest, context: StructuredOverviewContext,
  deps: ReturnType<typeof overviewDeps>): Promise<PlanOverviewSaveResult> {
  return serializedOverviewWrite(req.planId, async () => {
    verifyStructuredContext(context);
    const responsible = context.responsibleSupervisorId ? deps.getAgent(context.responsibleSupervisorId) : null;
    if (!responsible || !hasSupervisorPrivilege(responsible) || responsible.workspaceId !== context.workspace.id) {
      throw new PlanOverviewError('the plan has no valid responsible supervisor', 'overview-supervisor-rejected');
    }
    const first = deps.observe(context.folderAbs);
    if (first.token !== req.expectedSourceHash) {
      throw new PlanOverviewError('the overview changed on disk while editing', 'overview-source-stale');
    }
    if (first.present && (!first.safeRegularFile || first.oversized || !first.bytes)) {
      throw new PlanOverviewError('OVERVIEW.md must be repaired in a file editor', 'overview-source-invalid');
    }
    let next: string;
    if (first.bytes) {
      next = editPlanHumanOverview(first.bytes.toString('utf8'), context.artifactId, req.tab, req.action, req.body);
    } else {
      if (req.action === 'remove') throw new PlanOverviewError('overview section is already absent', 'overview-section-absent');
      const bodies = new Map<PlanTabKey, string>();
      const state = deps.getProjectionState(req.planId);
      if (state?.overviewAdoptionState === 'never-seen' && deps.listOverviewSources(req.planId).length === 0) {
        for (const tab of PLAN_TAB_KEYS) {
          const stored = deps.getOverview(req.planId, tab)?.body;
          if (stored?.trim()) bodies.set(tab, stored);
        }
      }
      bodies.set(req.tab, req.body!);
      next = buildOverviewFile(context.artifactId, bodies);
    }
    const parsedNext = parsePlanHumanOverview(next, context.artifactId);
    if (!parsedNext.ok) throw new PlanOverviewError('the edited overview did not validate', 'overview-edit-invalid');
    const savedToken = await writeOverviewReplacement({
      req, context, next: Buffer.from(next, 'utf8'), expectedFinalToken: first.token, deps,
    });
    let outcome: PlanOverviewSaveResult['outcome'] = 'overview-saved';
    try {
      await deps.reconcile({ workspace: context.workspace, planFolderRelPath: context.folderRelPath, changeKind: 'manual' });
    } catch (err) {
      outcome = 'overview-saved-projection-pending';
      try {
        recordPlanOverviewProjectionStatus({
          workspaceId: context.workspace.id, planId: req.planId, status: 'apply-error',
          sourceHash: savedToken.startsWith('sha256:') ? savedToken : null,
          diagnostics: [{ code: 'overview-apply-failed', detail: err instanceof Error ? err.message : String(err) }],
          reconciledAt: deps.now(), observedPresent: true,
        });
      } catch { /* durable disk write remains authoritative; reconciliation retries */ }
    }
    const stored = deps.getOverview(req.planId, req.tab);
    const stamp = new Date(deps.now()).toISOString();
    return {
      planId: req.planId, tab: req.tab,
      body: stored?.body ?? (req.action === 'remove' ? null : req.body),
      revision: stored?.revision ?? 0, updatedBy: stored?.updatedBy ?? responsible.id,
      createdAt: stored?.createdAt ?? stamp, updatedAt: stored?.updatedAt ?? stamp,
      outcome, loadedSourceHash: savedToken,
    };
  });
}

/**
 * `plan:getOverview` core. Open read: returns the stored per-tab overview or a
 * clean `null` when the key is unset OR the request is malformed / not a valid
 * `PlanTabKey`. Never throws for a caller — a missing overview and a bad key both
 * degrade to `null` (the renderer shows "overview pending").
 */
export function runGetOverview(
  raw: unknown,
  deps: PlanOverviewIpcDeps = defaultPlanOverviewIpcDeps(),
): PlanOverviewRead | PlanTabOverview | null {
  const req = readPlanTabRequest(raw);
  if (!req) return null;
  const resolved = overviewDeps(deps);
  const context = resolved.getStructuredContext(req.planId);
  const stored = resolved.getOverview(req.planId, req.tab);
  if (!context) return stored;
  const observation = resolved.observe(context.folderAbs);
  const state = resolved.getProjectionState(req.planId);
  const stamp = new Date(0).toISOString();
  return {
    planId: req.planId, tab: req.tab, body: stored?.body ?? null,
    revision: stored?.revision ?? 0, updatedBy: stored?.updatedBy ?? null,
    createdAt: stored?.createdAt ?? stamp, updatedAt: stored?.updatedAt ?? stamp,
    loadedSourceHash: observation.token,
    sourceStatus: state?.overviewStatus ?? (observation.present ? 'invalid' : 'absent'),
    sourceDiagnostics: state ? parseDiagnosticMessages(state.overviewDiagnosticsJson) : [],
    diskBacked: true,
  };
}

/**
 * `plan:setOverview` core. Supervisor-privileged, revision-bumping write. Mirrors
 * the promotion IPC's server-side revalidation: resolve the plan (its workspace
 * bounds the check), then reject anything that is not a privileged agent in the
 * plan's OWN workspace. A malformed request / invalid tab, an unknown plan, or an
 * ineligible supervisor all THROW — a rejected write is never a silent no-op.
 */
export function runSetOverview(
  raw: unknown,
  deps?: PlanOverviewIpcDeps,
): PlanTabOverview | PlanOverviewSaveResult;
export function runSetOverview(
  raw: unknown,
  deps: PlanOverviewIpcDeps = defaultPlanOverviewIpcDeps(),
): PlanTabOverview | Promise<PlanOverviewSaveResult> {
  const req = readPlanTabRequest(raw);
  if (!req) {
    throw new PlanOverviewError(
      'a non-empty planId and a valid tab key are required',
      'overview-bad-request',
    );
  }
  const resolved = overviewDeps(deps);
  const structured = resolved.getStructuredContext(req.planId);
  if (structured) return runStructuredSetOverview(readOverviewEditRequest(raw), structured, resolved);

  // Legacy/non-folder rows retain the direct DB behavior and the old explicit
  // supervisor authorization contract.
  const record = raw as Record<string, unknown>;
  const supervisorId = record.supervisorId;
  if (typeof supervisorId !== 'string' || supervisorId === '') {
    throw new PlanOverviewError('a non-empty supervisorId is required', 'overview-bad-request');
  }
  const body = record.body;
  if (body !== null && body !== undefined && typeof body !== 'string') {
    throw new PlanOverviewError('body must be a string or null', 'overview-bad-request');
  }

  // The plan's workspace bounds the supervisor revalidation.
  const plan = deps.getPlan(req.planId);
  if (!plan) {
    throw new PlanOverviewError(`plan not found: ${req.planId}`, 'overview-plan-not-found');
  }

  // ── Server-side supervisor revalidation (never trust the client's filter). ──
  const agent = deps.getAgent(supervisorId);
  if (!agent || !hasSupervisorPrivilege(agent) || agent.workspaceId !== plan.workspaceId) {
    throw new PlanOverviewError(
      `not an eligible supervisor for this workspace: ${supervisorId}`,
      'overview-supervisor-rejected',
    );
  }

  return deps.setOverview({
    planId: req.planId,
    tab: req.tab,
    body: (body ?? null) as string | null,
    updatedBy: supervisorId,
  });
}

/** Register the two WP-P4C-backend overview channels. Split from `registerPlanIpc`
 *  so the ipc test can drive registration against a fake ipcMain. */
export function registerPlanOverviewIpc(
  ipc: PlanIpcLike,
  deps: PlanOverviewIpcDeps = defaultPlanOverviewIpcDeps(),
): void {
  ipc.handle('plan:getOverview', (_event, raw: unknown) => runGetOverview(raw, deps));
  ipc.handle('plan:setOverview', (_event, raw: unknown) => runSetOverview(raw, deps));
}

// ── WP-P4D-create — plan-comment create + routing ─────────────────────────────
//
// A thin registrar over the `plan-comments.ts` create service. The deps (db
// accessors + the plan-aware send/notification route) are supplied by the
// ipc-handlers seam, which owns the supervisor + `comments:send` path this
// channel routes through. Split out (like `registerPlanOverviewIpc`) so the ipc
// test can drive registration against a fake ipcMain.

export function registerPlanCommentIpc(ipc: PlanIpcLike, deps: CreatePlanCommentDeps): void {
  ipc.handle('plan:comment:create', (_event, raw: unknown) => createPlanComment(raw, deps));
}

// ── WP-P4D-reply — plan-comment answer (companion reply) ──────────────────────
//
// Thin registrar over the `plan-comments.ts` answer service, sibling to
// `registerPlanCommentIpc`. The answer writes a COMPANION reply row and never
// mutates the question comment. The caller identity (`callerAgentId`) is
// established by the wiring seam and independently revalidated below the IPC
// boundary against the plan's durable responsible supervisor — a self-asserted
// non-responsible id is rejected (mirrors `plan:setOverview`'s server-side
// supervisor revalidation).

export function registerPlanCommentReplyIpc(ipc: PlanIpcLike, deps: AnswerPlanCommentDeps): void {
  ipc.handle('plan:comment:reply', (_event, raw: unknown) => answerPlanComment(raw, deps));
}

// ── WP-P4D-proj — plan-comment projection (`plan:comment:list`) ────────────────
//
// The read surface the comments rail consumes. Every dep has a DB default (there
// is no send/route seam to inject, unlike create/reply), so this channel is
// registered directly by `registerPlanIpc` — a sibling of `registerPlanOverviewIpc`
// / `registerPlanIntentsIpc`. The pure core takes only an opaque plan id; all
// dual-source membership + logical-key resolution happens below the IPC boundary.

/** Pure handler core. A malformed / empty plan id degrades to `null` (the rail
 *  renders nothing); a missing workspace returns an empty projection with a
 *  warning below in the service. */
export function runPlanCommentList(
  rawPlanId: unknown,
  deps: ListPlanCommentsDeps = defaultListPlanCommentsDeps(),
) {
  if (typeof rawPlanId !== 'string' || rawPlanId === '') return null;
  return listPlanComments(rawPlanId, deps);
}

export function registerPlanCommentListIpc(
  ipc: PlanIpcLike,
  deps: ListPlanCommentsDeps = defaultListPlanCommentsDeps(),
): void {
  ipc.handle('plan:comment:list', (_event, rawPlanId: unknown) => runPlanCommentList(rawPlanId, deps));
}

interface StructuredOverviewContext {
  planId: string;
  artifactId: string;
  folderRelPath: string;
  folderAbs: string;
  workspace: Workspace;
  responsibleSupervisorId: string | null;
}

export interface PlanOverviewRead extends PlanTabOverview {
  loadedSourceHash: ObservedOverviewSourceToken;
  sourceStatus: 'absent' | 'synced' | 'invalid' | 'apply-error';
  sourceDiagnostics: string[];
  diskBacked: boolean;
}

export interface PlanOverviewSaveResult extends PlanTabOverview {
  outcome: 'overview-saved' | 'overview-saved-projection-pending';
  loadedSourceHash: ObservedOverviewSourceToken;
}

function defaultStructuredContext(planId: string): StructuredOverviewContext | null {
  const row = getDb().prepare(
    `SELECT id, workspace_id, artifact_id, folder_rel_path, responsible_supervisor_id
       FROM plans WHERE id = ? AND deleted_at IS NULL`,
  ).get(planId) as {
    id: string; workspace_id: string; artifact_id: string | null;
    folder_rel_path: string | null; responsible_supervisor_id: string | null;
  } | undefined;
  if (!row?.artifact_id || !row.folder_rel_path) return null;
  const workspace = getWorkspace(row.workspace_id);
  if (!workspace) return null;
  const stateName = workspaceStateDirName(workspace.path, workspace.pathType);
  const parts = row.folder_rel_path.split('/');
  if (parts.length !== 3 || parts[0] !== stateName || parts[1] !== 'plans'
      || !parts[2] || parts[2] === '.' || parts[2] === '..') return null;
  return {
    planId: row.id, artifactId: row.artifact_id, folderRelPath: row.folder_rel_path,
    folderAbs: path.join(workspaceStateDir(workspace.path, workspace.pathType), 'plans', parts[2]),
    workspace, responsibleSupervisorId: row.responsible_supervisor_id,
  };
}

// WP-P6B-query — one-shot mission-board read. Polling cadence, cancellation,
// stale-response suppression, and preload transport belong to WP-P6B-transport.
export function runMissionBoardList(
  rawPlanId: unknown,
  listCards: (planId: string) => MissionBoardCard[] = listMissionBoardCards,
): MissionBoardCard[] | null {
  if (typeof rawPlanId !== 'string' || rawPlanId === '') return null;
  return listCards(rawPlanId);
}

export function registerMissionBoardIpc(
  ipc: PlanIpcLike,
  listCards: (planId: string) => MissionBoardCard[] = listMissionBoardCards,
  listTimeline: (planId: string) => MissionBoardPackageTimeline[] = listMissionBoardTimeline,
): void {
  ipc.handle('plan:board:list', (_event, rawPlanId: unknown) =>
    runMissionBoardList(rawPlanId, listCards));
  ipc.handle('plan:board:timeline', (_event, rawPlanId: unknown) =>
    runMissionBoardTimeline(rawPlanId, listTimeline));
}

export function runMissionBoardTimeline(
  rawPlanId: unknown,
  listTimeline: (planId: string) => MissionBoardPackageTimeline[] = listMissionBoardTimeline,
): MissionBoardPackageTimeline[] | null {
  if (typeof rawPlanId !== 'string' || rawPlanId === '') return null;
  return listTimeline(rawPlanId);
}

// WP-P7C — file-level contribution evidence. The main service resolves the
// workspace root and ledger capability; the renderer supplies no git paths or
// repository identity.
export function runBlameToIntent(
  rawRequest: unknown,
  query: (request: BlameToIntentRequest) => Promise<BlameToIntentResult | null> = queryBlameToIntent,
): Promise<BlameToIntentResult | null> | null {
  if (!rawRequest || typeof rawRequest !== 'object') return null;
  const request = rawRequest as Partial<BlameToIntentRequest>;
  if (typeof request.workspaceId !== 'string' || !request.workspaceId
      || typeof request.path !== 'string' || !request.path) return null;
  return query({ workspaceId: request.workspaceId, path: request.path });
}

export function registerBlameToIntentIpc(
  ipc: PlanIpcLike,
  query: (request: BlameToIntentRequest) => Promise<BlameToIntentResult | null> = queryBlameToIntent,
): void {
  ipc.handle('plan:blameToIntent', (_event, rawRequest: unknown) =>
    runBlameToIntent(rawRequest, query));
}

export function registerPlanIpc(): void {
  ipcMain.handle(
    'plan-folder:list',
    (_e, workspaceId: string, workspaceRoot: string, pathType?: PathType) =>
      listPromotedPlanFolders(workspaceId, workspaceRoot, pathType),
  );
  // ── WP-P1A: planning-reader (read-only fs enumeration + safe read) ──────────
  // Bounded enumeration of bare proposals + §R0 plan folders, and a
  // read-by-opaque-manifest-id read path. Purely read-only: NO demand-probe is
  // emitted here — `reader_open` is a user-gesture event stamped elsewhere, so
  // an initial render / refresh (which calls `planning-reader:list`) never
  // counts as an open. No DB is touched.
  ipcMain.handle(
    'planning-reader:list',
    (_e, workspaceRoot: string, pathType?: PathType) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot) {
        return { entries: [], warnings: ['no workspace root'] };
      }
      return listPlanningEntries(workspaceRoot, { pathType });
    },
  );

  registerPlanDocumentsIpc(ipcMain);
  ipcMain.handle(
    'planning-reader:read',
    (_e, docId: string, pathType?: PathType) => {
      if (typeof docId !== 'string' || !docId) {
        return { error: 'missing manifest document id' };
      }
      return readPlanningDocument(docId, { pathType });
    },
  );

  // ── WP-P2C: unified gallery projection + safe proposal read ─────────────────
  // `plan-gallery:list` unions proposals + structured (folder-per-plan) + legacy
  // HTML rows (md excluded) for the new Plans gallery; `proposal:read` fetches one
  // proposal's markdown by its proposals-row id with read-time containment +
  // byte-cap re-validation. Pure reads: no DB mutation, no demand-probe here.
  ipcMain.handle(
    'plan-gallery:list',
    (_e, workspaceId: string, opts?: PlanGalleryOptions) => {
      if (typeof workspaceId !== 'string' || !workspaceId) {
        return { rows: [], warnings: ['no workspace id'] };
      }
      return buildPlanGallery(workspaceId, opts ?? {});
    },
  );
  ipcMain.handle('proposal:read', (_e, proposalId: string) => {
    if (typeof proposalId !== 'string' || !proposalId) {
      return { error: 'missing proposal id' };
    }
    return readProposalDocument(proposalId);
  });

  // ── SC-WP-3D: plan-package `done` transition → finalization ─────────────────
  // The renderer's explicit `done` gesture mints a plan-package finalization through
  // the WP-3C service (which also flips the work package to `done` in the same txn).
  // Identity-only renderer requests are enriched through the engine-backed lazy route.
  // Full main-side WP-3D requests still pass through byte-for-byte unchanged.
  ipcMain.handle('plan:finalizeItemDone', async (_e, request: unknown) =>
    runFinalizePlanItemDoneRequest(request));

  // ── SC-WP-3I: plan-lens candidate preview (read-only) ───────────────────────
  // Sibling of the save-lens preview channel. Runs the SAME WP-3G `buildCandidate`
  // service over a route-resolved context, so both lenses yield an identical
  // `candidateId` + member verdicts. The route is injected via
  // `providePlanPreviewRoutes` once the candidate engine bootstraps; until then the
  // channel rejects honestly (the plan lens simply shows no preview).
  registerPlanCandidatePreviewIpc(ipcMain, () => planPreviewRoutes);
  registerPlanReviewProjectionIpc(ipcMain, () => planPreviewRoutes);

  // ── WP-P3C′: proposal promotion + concrete status poll ──────────────────────
  // The Promote dialog's supervisor-picker confirm (`proposal:promote`) and the
  // bounded status poll (`proposal:promotionStatus`) that resolves a
  // promotion-pending result. Both reject honestly until the wiring lane injects
  // the production service via `providePromotionService`.
  registerPromotionIpc(ipcMain);

  // WP-P2L-proj: mid-altitude intent history + confidence, derived from the
  // canonical ledger/orchestration join and current plan.md disk presence.
  registerPlanIntentsIpc(ipcMain);

  // WP-P4C-backend: per-tab supervisor overview. Open read (`plan:getOverview`);
  // supervisor-privileged, server-revalidated, revision-bumping write
  // (`plan:setOverview`). Keyed by the stable PlanTabKey domain.
  registerPlanOverviewIpc(ipcMain);

  // WP-P4D-proj: plan-comment projection (`plan:comment:list`). Open read that
  // rolls up a plan's comments across its registered external docs AND its
  // folder-doc logical targets, each folded with its reply thread. All deps have
  // DB defaults (no send/route seam), so it registers here directly.
  registerPlanCommentListIpc(ipcMain);

  // WP-P5C: the human Implement trigger (`plan:implement`). Renderer-only /
  // human-gesture — there is NO api-server route, so an agent cannot pull it, and
  // `app_user_id` is derived main-side (never from the renderer payload). Pins a
  // durable execution baseline and flips the plan `ready → executing`.
  registerPlanImplementIpc(ipcMain);

  // WP-P6B-query: read-only package cards with structured state and transient
  // open-turn activity kept in separate DTO fields. No polling or state writes.
  registerMissionBoardIpc(ipcMain);

  // WP-P7C: conservative file -> contributing turns/plans query.
  registerBlameToIntentIpc(ipcMain);

  // Workspace-scoped plan list. Legacy HTML summary extraction is retired.
  ipcMain.handle('plan:list', (_e, workspaceId?: string): PlanListItem[] =>
    getPlans({ workspaceId: workspaceId || undefined })
      .map((plan) => ({ ...plan, snippet: null })));

  // P8D: native pane and legacy projection IPC registrations are retired.
}
