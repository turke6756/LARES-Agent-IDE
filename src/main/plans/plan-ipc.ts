// WP5 mount — IPC surface for the plan render pane + its data reads.
//
// Mirrors the browser pane's split (registerBrowserIpc): registered from
// index.ts with one call, kept deliberately OUT of ipc-handlers.ts to avoid
// file contention. The renderer has no loopback-HTTP path (every renderer read
// is IPC), so `plan:list` / `plan:projection` are thin in-process mirrors of the
// GET /api/plans and GET /api/plans/:id/projection?events=full routes — they
// call the SAME builders the HTTP routes use, so the two paths never drift.

import { ipcMain } from 'electron';
import type { Rectangle } from 'electron';
import type { PlanPaneManager } from './plan-pane-manager';
import type {
  PlanListItem,
  PathType,
  Plan,
  Agent,
  PromoteProposalResult,
  PromotionStatus,
  PlanIntentsProjection,
} from '../../shared/types';
import { hasSupervisorPrivilege } from '../../shared/types';
import {
  getPlans,
  getPlanWorkPackage as dbGetPlanWorkPackage,
  getAgent as dbGetAgent,
  getPlan as dbGetPlan,
  getPlanByWorkspaceArtifactId as dbGetPlanByWorkspaceArtifactId,
  getPromotionRequestById as dbGetPromotionRequestById,
} from '../database';
import type { PlanWorkPackage, StructuredPlanRow, PromotionRequestRow } from '../database';
import type { PromoteResult, ProposalRef } from './promote-proposal';
import { resolvePlanProjection, buildPlanActivityProjection } from '../api-server';
import { derivePlanSnippet } from './plan-snippet';
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

/** Inject (or clear) the production plan-lens preview route once the candidate
 *  engine has bootstrapped. Until wired, `PLAN_PREVIEW_CHANNEL` rejects honestly. */
export function providePlanPreviewRoutes(routes: PlanCandidatePreviewRoutes | null): void {
  planPreviewRoutes = routes;
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

export function registerPlanIpc(manager: PlanPaneManager): void {
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
  // The channel is a thin transport around `finalizePlanItemDone`; the boundary OID
  // and members are computed upstream (WP-3G) and carried in the request.
  ipcMain.handle('plan:finalizeItemDone', async (_e, request: FinalizePlanItemDoneRequest) => {
    if (!request || typeof request.planItemId !== 'string' || !request.planItemId) {
      return { error: 'missing plan item id' };
    }
    return finalizePlanItemDone(request);
  });

  // ── SC-WP-3I: plan-lens candidate preview (read-only) ───────────────────────
  // Sibling of the save-lens preview channel. Runs the SAME WP-3G `buildCandidate`
  // service over a route-resolved context, so both lenses yield an identical
  // `candidateId` + member verdicts. The route is injected via
  // `providePlanPreviewRoutes` once the candidate engine bootstraps; until then the
  // channel rejects honestly (the plan lens simply shows no preview).
  registerPlanCandidatePreviewIpc(ipcMain, () => planPreviewRoutes);

  // ── WP-P3C′: proposal promotion + concrete status poll ──────────────────────
  // The Promote dialog's supervisor-picker confirm (`proposal:promote`) and the
  // bounded status poll (`proposal:promotionStatus`) that resolves a
  // promotion-pending result. Both reject honestly until the wiring lane injects
  // the production service via `providePromotionService`.
  registerPromotionIpc(ipcMain);

  // WP-P2L-proj: mid-altitude intent history + confidence, derived from the
  // canonical ledger/orchestration join and current plan.md disk presence.
  registerPlanIntentsIpc(ipcMain);

  // Plan list for the "Plans" card gallery (workspace-scoped). Each row carries a
  // cheap description snippet derived from its already-served projection (or an
  // on-demand parse) — computed ONLY for `html` surfaces, since the gallery hides
  // markdown-adopted rows and only the surfaces render a summary zone.
  ipcMain.handle('plan:list', async (_e, workspaceId?: string): Promise<PlanListItem[]> => {
    const plans = getPlans({ workspaceId: workspaceId || undefined });
    return Promise.all(
      plans.map(async (plan): Promise<PlanListItem> => {
        if (plan.format !== 'html') return { ...plan, snippet: null };
        const resolved = await resolvePlanProjection(plan.id);
        return { ...plan, snippet: derivePlanSnippet(resolved?.projection) };
      }),
    );
  });

  // Full activity projection (sections + trusted event trail). Prefers WP4's
  // last-good in-memory projection, falls back to a fresh file parse — exactly
  // like the HTTP route. `null` for an unknown plan id.
  ipcMain.handle('plan:projection', async (_e, planId: string, opts?: { eventDetailId?: string }) => {
    const resolved = await resolvePlanProjection(planId);
    if (!resolved) return null;
    return buildPlanActivityProjection(resolved.plan.id, resolved.projection, {
      includeEvents: true,
      // Fix-4 Tier-3 — thread the renderer's on-expand drill-down id (undefined ⇒
      // no eventDetail key, unchanged behavior for the default projection read).
      eventDetailId: opts?.eventDetailId,
    });
  });

  // ── Sandboxed render-pane lifecycle ────────────────────────────────────────
  // Same handoff as the browser pane: the renderer streams the pane rectangle
  // (throttled, ~one per frame) and toggles show/hide as the plan tab gains and
  // loses focus; main owns the WebContentsView.
  ipcMain.handle('plan-pane:show', (_e, planId: string) => manager.show(planId));
  ipcMain.handle('plan-pane:hide', () => manager.hide());
  ipcMain.handle('plan-pane:setBounds', (_e, bounds: Rectangle) => manager.setBounds(bounds));
  ipcMain.handle('plan-pane:setVisible', (_e, visible: boolean) => manager.setPaneVisible(visible));
}
