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
import { getPlans } from '../database';
import { resolvePlanProjection, buildPlanActivityProjection } from '../api-server';
import { derivePlanSnippet } from './plan-snippet';
import { listPlanningEntries, readPlanningDocument } from './planning-reader';
import { buildPlanGallery, readProposalDocument } from './plan-gallery';
import type { PlanGalleryOptions } from '../../shared/types';

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
