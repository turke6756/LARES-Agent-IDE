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
import type { PlanListItem, PathType } from '../../shared/types';
import { getPlans, getPlanWorkPackage as dbGetPlanWorkPackage } from '../database';
import type { PlanWorkPackage } from '../database';
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
