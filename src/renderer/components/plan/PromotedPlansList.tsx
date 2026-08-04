import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import type { PromotedPlanFolder } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

export default function PromotedPlansList(): React.ReactElement {
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspace = useDashboardStore((state) => state.workspaces.find((item) => item.id === selectedWorkspaceId));
  const openPlanTab = useDashboardStore((state) => state.openPlanTab);
  const [plans, setPlans] = useState<PromotedPlanFolder[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setPlans(null);
    if (!workspace) {
      setPlans([]);
      return;
    }
    try {
      const result = await window.api.plans.listPromotedFolders(workspace.id, workspace.path, workspace.pathType);
      setPlans(result.plans);
    } catch {
      setError('Could not load promoted plans.');
      setPlans([]);
    }
  }, [workspace]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setShowArchived(false); }, [workspace?.id]);

  const archivedCount = plans?.filter((plan) => plan.archived).length ?? 0;
  const visiblePlans = useMemo(
    () => plans?.filter((plan) => showArchived || !plan.archived) ?? [],
    [plans, showArchived],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-surface-1" data-testid="plans-promoted-region">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-4">
        <Icons.Map className="h-4 w-4 text-accent-green" />
        <h2 className="text-[13px] font-semibold text-gray-200">Promoted plans</h2>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-[11px] text-gray-400" data-testid="promoted-history-toggle">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.currentTarget.checked)} />
          Show archived{archivedCount ? ` (${archivedCount})` : ''}
        </label>
        <button type="button" onClick={() => void load()} className="ui-btn p-1" aria-label="Refresh promoted plans">
          <Icons.RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {error ? (
        <div className="p-6 text-center text-[12px] text-accent-red">{error}</div>
      ) : plans === null ? (
        <div className="p-6 text-center text-[12px] text-gray-500">Loading promoted plans…</div>
      ) : visiblePlans.length === 0 ? (
        <div className="p-6 text-center text-[12px] text-gray-500">{workspace ? 'No promoted plans yet.' : 'Select a workspace to view plans.'}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
          {visiblePlans.map((plan) => (
            <button
              key={plan.folderName}
              type="button"
              onDoubleClick={() => workspace && openPlanTab(plan.planId, plan.title, workspace.id)}
              className="mb-1 flex w-full items-center gap-3 rounded border border-transparent px-3 py-2 text-left hover:border-white/10 hover:bg-white/5"
              data-testid="promoted-plan-row"
              data-archived={plan.archived ? 'true' : 'false'}
              title="Double-click to open the full planning surface"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-gray-100">{plan.title}</div>
                {plan.responsibleSupervisor && (
                  <div className="truncate text-[11px] text-gray-500" data-testid="promoted-plan-owner">
                    Responsible: {plan.responsibleSupervisor.display ?? plan.responsibleSupervisor.agentId ?? 'unknown'}
                  </div>
                )}
              </div>
              <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400" data-testid="promoted-plan-status">
                {plan.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
