import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import type { Agent, Workspace } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  dispatchProposalPromotion,
  isValidProposalArtifactId,
  NEW_SUPERVISOR_ID,
  TERMINAL_AGENT_STATUSES,
  type PromotionDispatchResult,
} from './promotion-dispatch';

interface Props {
  workspace: Workspace;
  proposalFilePath: string;
  proposalArtifactId?: string | null;
  onClose: () => void;
}

function isEligibleSupervisor(agent: Agent | null, workspaceId: string): agent is Agent {
  return Boolean(agent?.isSupervisor && agent.workspaceId === workspaceId);
}

export default function PromoteToPlanPanel({
  workspace,
  proposalFilePath,
  proposalArtifactId,
  onClose,
}: Props): React.ReactElement {
  const agents = useDashboardStore((state) => state.agents);
  const loadAgents = useDashboardStore((state) => state.loadAgents);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(NEW_SUPERVISOR_ID);
  const [resolvedDefault, setResolvedDefault] = useState<Agent | null>();
  const [newTitle, setNewTitle] = useState('Planning supervisor');
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PromotionDispatchResult | null>(null);
  const hasUserSelectedRef = useRef(false);
  const normalizedArtifactId = proposalArtifactId?.trim() ?? '';
  const artifactIdValid = isValidProposalArtifactId(normalizedArtifactId);

  useEffect(() => {
    let cancelled = false;
    hasUserSelectedRef.current = false;
    setSelectedId(NEW_SUPERVISOR_ID);
    setResolvedDefault(undefined);

    void window.api.agents.getSupervisor(workspace.id).then((agent) => {
      if (cancelled) return;
      const eligibleDefault = isEligibleSupervisor(agent, workspace.id) ? agent : null;
      setResolvedDefault(eligibleDefault);
      if (!hasUserSelectedRef.current) {
        setSelectedId(eligibleDefault?.id ?? NEW_SUPERVISOR_ID);
      }
    }).catch(() => {
      if (cancelled) return;
      setResolvedDefault(null);
      if (!hasUserSelectedRef.current) setSelectedId(NEW_SUPERVISOR_ID);
    });

    return () => { cancelled = true; };
  }, [workspace.id]);

  const availableSupervisors = useMemo(() => {
    const workspaceSupervisors = agents.filter((agent) =>
      isEligibleSupervisor(agent, workspace.id),
    );
    if (!resolvedDefault || workspaceSupervisors.some((agent) => agent.id === resolvedDefault.id)) {
      return workspaceSupervisors;
    }
    return [resolvedDefault, ...workspaceSupervisors];
  }, [agents, resolvedDefault, workspace.id]);

  const supervisors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return availableSupervisors.filter((agent) =>
      !needle || agent.title.toLowerCase().includes(needle),
    );
  }, [availableSupervisors, query]);
  const selectedAgent: Agent | null = supervisors.find((agent) => agent.id === selectedId)
    ?? availableSupervisors.find((agent) => agent.id === selectedId)
    ?? null;

  const dispatch = async (): Promise<void> => {
    setDispatching(true);
    setError(null);
    try {
      const result = await dispatchProposalPromotion({
        workspace,
        proposalFilePath,
        proposalArtifactId: normalizedArtifactId,
        selectedAgent: selectedId === NEW_SUPERVISOR_ID ? null : selectedAgent,
        newSupervisorTitle: newTitle,
      });
      setConfirmation(result);
      await loadAgents(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not dispatch promotion.');
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-accent-blue/30 bg-accent-blue/5 p-4" data-testid="promote-plan-panel">
      <div className="flex items-center gap-2">
        <Icons.ArrowUpCircle className="h-4 w-4 text-accent-blue" />
        <h3 className="text-[13px] font-semibold text-gray-100">Promote to plan</h3>
        <button type="button" onClick={onClose} className="ui-btn ml-auto p-1" aria-label="Close promotion panel">
          <Icons.X className="h-4 w-4" />
        </button>
      </div>

      {confirmation ? (
        <div className="mt-3 rounded border border-accent-green/30 bg-accent-green/10 p-3" data-testid="promote-confirmation">
          <div className="flex items-center gap-2 text-[12px] font-medium text-accent-green">
            <Icons.CheckCircle2 className="h-4 w-4" />
            Sent to {confirmation.supervisorTitle} ({confirmation.path}).
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-gray-300">{confirmation.instruction}</pre>
        </div>
      ) : (
        <>
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search supervisors"
            className="mt-3 w-full rounded border border-white/10 bg-surface-0 px-3 py-2 text-[12px] text-gray-200"
            data-testid="promote-supervisor-search"
          />
          <div className="mt-2 max-h-36 space-y-1 overflow-y-auto scrollbar-thin" data-testid="promote-supervisor-list">
            <button
              type="button"
              onClick={() => { hasUserSelectedRef.current = true; setSelectedId(NEW_SUPERVISOR_ID); }}
              className={`flex w-full items-center rounded px-3 py-2 text-left text-[12px] ${selectedId === NEW_SUPERVISOR_ID ? 'bg-accent-blue/15 text-gray-100' : 'text-gray-300 hover:bg-white/5'}`}
              data-testid="promote-new-supervisor-option"
              aria-pressed={selectedId === NEW_SUPERVISOR_ID}
            >
              <Icons.Plus className="mr-2 h-3.5 w-3.5" /> New supervisor
            </button>
            {supervisors.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => { hasUserSelectedRef.current = true; setSelectedId(agent.id); }}
                className={`flex w-full items-center rounded px-3 py-2 text-left text-[12px] ${selectedId === agent.id ? 'bg-accent-blue/15 text-gray-100' : 'text-gray-300 hover:bg-white/5'}`}
                data-testid="promote-supervisor-option"
                data-agent-status={agent.status}
                aria-pressed={selectedId === agent.id}
              >
                <span className="min-w-0 flex-1 truncate">{agent.title}</span>
                <span className="ml-2 text-[10px] uppercase text-gray-500">
                  {TERMINAL_AGENT_STATUSES.has(agent.status) ? `${agent.status} · revive` : agent.status}
                </span>
              </button>
            ))}
          </div>
          {selectedId === NEW_SUPERVISOR_ID && (
            <input
              value={newTitle}
              onChange={(event) => { hasUserSelectedRef.current = true; setNewTitle(event.currentTarget.value); }}
              className="mt-2 w-full rounded border border-white/10 bg-surface-0 px-3 py-2 text-[12px] text-gray-200"
              aria-label="New supervisor title"
              data-testid="promote-new-supervisor-title"
            />
          )}
          {!artifactIdValid && (
            <p className="mt-2 text-[11px] text-accent-red" role="alert">
              Cannot promote: add a valid artifact_id (expected prop_########) to the proposal frontmatter.
            </p>
          )}
          {error && <p className="mt-2 text-[11px] text-accent-red" role="alert">{error}</p>}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => void dispatch()}
              disabled={dispatching || !artifactIdValid || (selectedId !== NEW_SUPERVISOR_ID && !selectedAgent)}
              className="ui-btn ui-btn-primary px-3 py-1.5 text-[12px] disabled:opacity-50"
              data-testid="promote-dispatch"
            >
              {dispatching ? <Icons.Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icons.Send className="h-3.5 w-3.5" />}
              Dispatch
            </button>
          </div>
        </>
      )}
    </div>
  );
}
