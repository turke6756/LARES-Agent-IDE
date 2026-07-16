import React, { useEffect, useMemo, useState } from 'react';
import type { DetachableView, PlanListItem } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import FileViewerPanel from '../fileviewer/FileViewerPanel';
import BrowserPanel from '../browser/BrowserPanel';
import PlanSurfaceContainer from '../plan/PlanSurfaceContainer';
import { planLabel } from '../plan/PlanCard';

// Full-window shell for a torn-off top-level VIEW (view-detach sibling of
// DetachedFileView). Same renderer bundle, no Sidebar / Terminal / DetailPanel —
// just the one center view this window owns, hydrated from the shared store and
// kept live off the main-process broadcast feeds (see `emit` in ipc-handlers.ts,
// which fans agent status/deletions/context-stats/heat out to detached views).
//
// Renders all four detachable views full-window: `dashboard` (AgentGrid), `files`
// (FileViewerPanel), `plans` (a plan gallery + PlanSurfaceContainer) and `browser`
// (BrowserPanel). `plans`/`browser` composite a main-process WebContentsView that
// main re-parents INTO this window on detach (onViewWindowReady → manager
// reparentTo) and back on close — so the same show/setBounds IPC the main shell
// uses now drives this window's contentView.
interface Props {
  params: URLSearchParams;
}

const VIEW_LABELS: Record<DetachableView, string> = {
  dashboard: 'Dashboard',
  files: 'Files',
  plans: 'Plans',
  browser: 'Browser',
};

// The detached Plans window: a compact gallery of the workspace's plan surfaces
// plus the selected plan rendered through the SAME PlanSurfaceContainer the main
// shell uses (its native pane now paints in this window). Mirrors PlansMenu's
// gallery, but always-open in a left rail rather than a dropdown.
function DetachedPlansView({ workspaceId }: { workspaceId: string }) {
  const [plans, setPlans] = useState<PlanListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.plans
      .list(workspaceId || undefined)
      .then((rows) => {
        if (cancelled) return;
        const surfaces = rows.filter((p) => p.format === 'html');
        setPlans(surfaces);
        // Auto-open the first surface so the window isn't empty on first paint.
        setSelected((cur) => cur ?? surfaces[0]?.id ?? null);
      })
      .catch(() => { if (!cancelled) setError('Could not load plans'); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      <div className="w-64 shrink-0 border-r dark:border-white/10 light:border-black/10 overflow-y-auto scrollbar-thin p-2">
        {error ? (
          <div className="px-2 py-2 text-[12px] text-accent-red">{error}</div>
        ) : plans === null ? (
          <div className="px-2 py-2 text-[12px] text-gray-400">Loading…</div>
        ) : plans.length === 0 ? (
          <div className="px-2 py-2 text-[12px] text-gray-400">No plan surfaces in this workspace</div>
        ) : (
          plans.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-[13px] truncate mb-0.5 ${
                selected === p.id ? 'ui-btn-success is-active' : 'hover:bg-white/5'
              }`}
              title={planLabel(p)}
            >
              {planLabel(p)}
            </button>
          ))
        )}
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        {selected ? (
          <PlanSurfaceContainer planId={selected} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            Select a plan surface
          </div>
        )}
      </div>
    </div>
  );
}

export default function DetachedViewShell({ params }: Props) {
  const meta = useMemo(() => {
    return {
      view: (params.get('view') as DetachableView) || 'dashboard',
      workspaceId: params.get('workspaceId') ?? '',
      label: params.get('label') ?? '',
    };
  }, [params]);

  // Hydrate the shared store for this window: select the workspace (loads its
  // agents + lands on dashboard mode), then keep it live via the same broadcast
  // subscriptions AppInner uses. selectWorkspace already sets
  // fileViewerOpen/browserOpen:false, so AgentGrid renders directly.
  useEffect(() => {
    if (meta.label) document.title = meta.label;
    const store = useDashboardStore.getState();
    store.loadWorkspaces()
      .then(() => {
        if (!meta.workspaceId) return;
        const s = useDashboardStore.getState();
        s.selectWorkspace(meta.workspaceId);
        // Files: land on the file viewer (opens the workspace tree; the detached
        // window starts with NO open file tabs — see patch summary). Dashboard:
        // selectWorkspace already lands on the grid. Plans/Browser self-manage.
        if (meta.view === 'files') s.showFileViewer();
      })
      .catch(() => { /* best effort — status broadcasts repopulate the grid */ });

    const unsubStatus = window.api.onAgentStatusChanged(({ agent, source }) => {
      if (!agent) return;
      const s = useDashboardStore.getState();
      s.updateAgentStatusSnapshot(agent);
      s.updateAgent(agent);
      s.applyTransferSignal({ agentId: agent.id, status: agent.status, source });
    });
    const unsubDeleted = window.api.onAgentDeleted(({ agentId }) => {
      useDashboardStore.getState().removeAgent(agentId);
    });
    const unsubContext = window.api.agents.onContextStatsChanged((stats) => {
      useDashboardStore.getState().updateContextStats(stats);
    });

    return () => {
      unsubStatus();
      unsubDeleted();
      unsubContext();
    };
  }, [meta]);

  const workspace = useDashboardStore((s) => s.workspaces.find((w) => w.id === meta.workspaceId));

  const title = workspace?.title ?? meta.label;

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-gray-100 overflow-hidden grid-bg">
      <div className="panel-header h-12 px-4 flex items-center shrink-0">
        <h2 className="text-[15px] font-bold text-gray-100 truncate">
          {title} — {VIEW_LABELS[meta.view] ?? meta.view}
        </h2>
      </div>
      {meta.view === 'files' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileViewerPanel />
        </div>
      ) : meta.view === 'browser' ? (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <BrowserPanel />
        </div>
      ) : meta.view === 'plans' ? (
        <DetachedPlansView workspaceId={meta.workspaceId} />
      ) : (
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          <AgentGrid />
        </div>
      )}
    </div>
  );
}
