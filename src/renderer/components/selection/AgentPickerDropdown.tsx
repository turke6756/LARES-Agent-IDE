import React, { useEffect, useMemo, useState } from 'react';
import StatusBadge from '../agent/StatusBadge';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';

// Agent destination picker, rendered inline inside SelectionActionMenu when
// "Send to agent ▸" expands. Plan §1.4: "New agent" is the first, default
// option; below it the workspace's existing agents with status badges
// (modeled on the AgentStrip cards).

interface Props {
  workspaceId: string;
  onPick: (target: SelectionAgentTarget) => void;
}

export default function AgentPickerDropdown({ workspaceId, onPick }: Props) {
  const allAgents = useDashboardStore((s) => s.agents);
  const agents = useMemo(
    () => allAgents.filter((a) => a.workspaceId === workspaceId),
    [allAgents, workspaceId],
  );

  // Row 0 = "New agent" (the default); rows 1..n = existing agents.
  const [highlighted, setHighlighted] = useState(0);
  const rowCount = agents.length + 1;

  const pickRow = (idx: number) => {
    if (idx === 0) onPick({ kind: 'new' });
    else onPick({ kind: 'existing', agentId: agents[idx - 1].id });
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never steal keys from a text field (AddCommentPopover renders this
      // picker beneath a live textarea).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % rowCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + rowCount) % rowCount);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pickRow(highlighted);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowCount, highlighted, agents]);

  const rowClass = (idx: number) =>
    `ui-menu-item w-full text-left${highlighted === idx ? ' bg-white/10' : ''}`;

  return (
    <div className="border-l border-white/10 ml-2">
      <button
        className={rowClass(0)}
        onClick={() => pickRow(0)}
        onMouseEnter={() => setHighlighted(0)}
      >
        ✦ New agent
      </button>
      {agents.map((agent, i) => (
        <button
          key={agent.id}
          className={rowClass(i + 1)}
          onClick={() => pickRow(i + 1)}
          onMouseEnter={() => setHighlighted(i + 1)}
        >
          <span className="inline-flex items-center gap-2 max-w-[260px]">
            <span className="truncate">{agent.title}</span>
            <StatusBadge status={agent.status} />
          </span>
        </button>
      ))}
    </div>
  );
}
