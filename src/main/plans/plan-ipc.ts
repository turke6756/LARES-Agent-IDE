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
import type { PlanListItem } from '../../shared/types';
import { getPlans } from '../database';
import { resolvePlanProjection, buildPlanActivityProjection } from '../api-server';
import { derivePlanSnippet } from './plan-snippet';

export function registerPlanIpc(manager: PlanPaneManager): void {
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
