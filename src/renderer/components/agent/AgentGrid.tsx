import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentCard from './AgentCard';
import TeamDialog from '../team/TeamDialog';

export default function AgentGrid() {
  const { agents, selectedWorkspaceId } = useDashboardStore();
  const deleteAgent = useDashboardStore((s) => s.deleteAgent);
  const [teamDialogAgentId, setTeamDialogAgentId] = useState<string | null>(null);
  // Agents that finished (working→idle) and haven't been clicked yet.
  // Local to this always-mounted container — intentionally NOT in the store.
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  // Shift+click multi-selection, also local.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  // Detect working→idle transitions and mark those agents unread.
  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = new Map<string, string>();
    const finished: string[] = [];
    for (const a of agents) {
      next.set(a.id, a.status);
      if (prev.get(a.id) === 'working' && a.status === 'idle') finished.push(a.id);
    }
    prevStatusRef.current = next;

    // Prune ids for agents that no longer exist, and add newly finished ones.
    const liveIds = new Set(agents.map((a) => a.id));
    setUnreadIds((cur) => {
      let changed = false;
      const out = new Set<string>();
      for (const id of cur) {
        if (liveIds.has(id)) out.add(id);
        else changed = true;
      }
      for (const id of finished) {
        if (!out.has(id)) {
          out.add(id);
          changed = true;
        }
      }
      return changed ? out : cur;
    });
    setSelectedIds((cur) => {
      let changed = false;
      const out = new Set<string>();
      for (const id of cur) {
        if (liveIds.has(id)) out.add(id);
        else changed = true;
      }
      return changed ? out : cur;
    });
  }, [agents]);

  const handleCardClick = useCallback((agentId: string, shiftKey: boolean) => {
    if (shiftKey) {
      // Toggle membership in the multi-selection.
      setSelectedIds((cur) => {
        const out = new Set(cur);
        if (out.has(agentId)) out.delete(agentId);
        else out.add(agentId);
        return out;
      });
      return;
    }
    // Plain click: the card has been "read" — clear its unread ring,
    // and drop any in-progress multi-selection.
    setUnreadIds((cur) => {
      if (!cur.has(agentId)) return cur;
      const out = new Set(cur);
      out.delete(agentId);
      return out;
    });
    setSelectedIds((cur) => (cur.size > 0 ? new Set<string>() : cur));
  }, []);

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    // Same store action the single-card delete button uses.
    for (const id of ids) {
      await deleteAgent(id);
    }
  }, [selectedIds, deleteAgent]);

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <div className="text-center">
          <div className="text-2xl mb-2">No agents running</div>
          <div className="text-sm">Click "Launch Agent" to start one</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <AnimatePresence>
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onTeam={(agentId) => setTeamDialogAgentId(agentId)}
              unread={unreadIds.has(agent.id)}
              multiSelected={selectedIds.has(agent.id)}
              selectionCount={selectedIds.size}
              onCardClick={handleCardClick}
              onDeleteSelected={handleDeleteSelected}
            />
          ))}
        </AnimatePresence>
      </div>
      {teamDialogAgentId && selectedWorkspaceId && (
        <TeamDialog
          workspaceId={selectedWorkspaceId}
          agents={agents}
          preSelectedAgentId={teamDialogAgentId}
          onClose={() => setTeamDialogAgentId(null)}
        />
      )}
    </>
  );
}
