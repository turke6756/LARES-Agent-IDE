import React, { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  LAUNCHABLE_AGENT_PROVIDERS,
  type LaunchableAgentProvider,
  type OrchestrationProviderSettings,
} from '../../../shared/types';
import { DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS } from '../../../shared/constants';

function isStillSelected(workspaceId: string): boolean {
  return useDashboardStore.getState().selectedWorkspaceId === workspaceId;
}

export default function GroupThinkProvidersPanel() {
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const [settings, setSettings] = useState<OrchestrationProviderSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyForWorkspace = useCallback((workspaceId: string, next: OrchestrationProviderSettings) => {
    if (isStillSelected(workspaceId)) setSettings(next);
  }, []);

  useEffect(() => {
    setSettings(null);
    setSaving(false);
    setError(null);
    if (!selectedWorkspaceId) return;

    const requestWorkspaceId = selectedWorkspaceId;
    window.api.orchestrationProviderSettings.get(requestWorkspaceId)
      .then((loaded) => applyForWorkspace(requestWorkspaceId, loaded))
      .catch((cause) => {
        if (isStillSelected(requestWorkspaceId)) setError(String(cause?.message ?? cause));
      });
  }, [applyForWorkspace, selectedWorkspaceId]);

  useEffect(() => window.api.orchestrationProviderSettings.onChanged((event) => {
    const currentWorkspaceId = useDashboardStore.getState().selectedWorkspaceId;
    if (!currentWorkspaceId || event.workspaceId !== currentWorkspaceId) return;
    setSettings(event.settings);
    setError(null);
  }), []);

  const updateField = useCallback((field: 'defaultLeadProvider' | 'defaultReviewerProvider', value: string) => {
    setSettings((current) => current ? {
      groupthink: { ...current.groupthink, [field]: value as LaunchableAgentProvider },
    } : current);
  }, []);

  const persist = useCallback(async (next: OrchestrationProviderSettings) => {
    const workspaceId = useDashboardStore.getState().selectedWorkspaceId;
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await window.api.orchestrationProviderSettings.update(workspaceId, next);
      applyForWorkspace(workspaceId, saved);
    } catch (cause) {
      if (isStillSelected(workspaceId)) setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (isStillSelected(workspaceId)) setSaving(false);
    }
  }, [applyForWorkspace]);

  return (
    <div className="h-full overflow-y-auto p-6 text-gray-200">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <Users size={18} className="text-blue-400" />
          <h2 className="text-[15px] font-semibold text-gray-100">GroupThink Providers</h2>
        </div>
        <p className="text-[12px] text-gray-500 mb-5">
          Choose the workspace defaults for the writer and reviewer in new GroupThink runs.
          A run can still explicitly override either preference.
        </p>

        {error && (
          <div role="alert" className="mb-4 text-[12px] text-red-400 border border-red-900/50 rounded px-3 py-2">
            {error}
          </div>
        )}

        {!selectedWorkspaceId ? (
          <div className="text-[12px] text-gray-500">Select a workspace to configure GroupThink providers.</div>
        ) : !settings ? (
          <div className="text-[12px] text-gray-500">Loading settings…</div>
        ) : (
          <div className="space-y-4">
            <label className="block">
              <span className="block text-[13px] font-medium text-gray-100 mb-1">Lead / Synthesizer</span>
              <span className="block text-[11px] text-gray-500 mb-2">Writes the final GroupThink deliverable.</span>
              <select
                aria-label="Default GroupThink lead provider"
                value={settings.groupthink.defaultLeadProvider}
                onChange={(event) => updateField('defaultLeadProvider', event.target.value)}
                className="ui-input w-full px-3 py-2 text-[13px]"
              >
                {LAUNCHABLE_AGENT_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>{provider}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[13px] font-medium text-gray-100 mb-1">Reviewer / Peer</span>
              <span className="block text-[11px] text-gray-500 mb-2">Reviews and challenges the lead&apos;s work.</span>
              <select
                aria-label="Default GroupThink reviewer provider"
                value={settings.groupthink.defaultReviewerProvider}
                onChange={(event) => updateField('defaultReviewerProvider', event.target.value)}
                className="ui-input w-full px-3 py-2 text-[13px]"
              >
                {LAUNCHABLE_AGENT_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>{provider}</option>
                ))}
              </select>
            </label>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                className="ui-btn ui-btn-primary px-4 py-1.5 text-[13px]"
                disabled={saving}
                onClick={() => void persist(settings)}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="ui-btn px-4 py-1.5 text-[13px]"
                disabled={saving}
                onClick={() => void persist(DEFAULT_ORCHESTRATION_PROVIDER_SETTINGS)}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
