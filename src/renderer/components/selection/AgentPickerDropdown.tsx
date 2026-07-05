import React, { useEffect, useMemo, useState } from 'react';
import StatusBadge from '../agent/StatusBadge';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';

// Agent destination picker, rendered inline inside SelectionActionMenu when
// "Send to agent ▸" expands, and inside AddCommentPopover's send mode.
//
// Ordering (WP-P5 UX fix): the agent you're working in (currentAgentId, from a
// chat surface) is the first row and the default highlight; then the
// workspace's supervisors; then the remaining agents; "New agent" lands last.
// The list is height-capped + scrollable so it never runs off the bottom of
// the screen when the menu opens low in the viewport.

interface Props {
  workspaceId: string;
  onPick: (target: SelectionAgentTarget) => void;
  /** The agent the user is currently viewing (chat surface). Becomes the
   *  first row and the default highlight when present in this workspace. */
  currentAgentId?: string;
}

interface Row {
  key: string;
  target: SelectionAgentTarget;
  render: React.ReactNode;
}

export default function AgentPickerDropdown({ workspaceId, onPick, currentAgentId }: Props) {
  const allAgents = useDashboardStore((s) => s.agents);

  const rows = useMemo<Row[]>(() => {
    const inWorkspace = allAgents.filter((a) => a.workspaceId === workspaceId);
    const current = currentAgentId
      ? inWorkspace.find((a) => a.id === currentAgentId)
      : undefined;
    const rest = inWorkspace.filter((a) => a.id !== current?.id);
    // Supervisors first among the remainder, each group stable otherwise.
    const supervisors = rest.filter((a) => a.isSupervisor);
    const others = rest.filter((a) => !a.isSupervisor);
    const ordered = [
      ...(current ? [current] : []),
      ...supervisors,
      ...others,
    ];

    const agentRows: Row[] = ordered.map((agent) => ({
      key: agent.id,
      target: { kind: 'existing', agentId: agent.id },
      render: (
        <span className="inline-flex items-center gap-2 max-w-[260px]">
          <span className="truncate">{agent.title}</span>
          {agent.id === current?.id && (
            <span className="text-[10px] uppercase tracking-wide text-accent-blue/80">
              current
            </span>
          )}
          {agent.isSupervisor && agent.id !== current?.id && (
            <span className="text-[10px] uppercase tracking-wide text-gray-500">
              supervisor
            </span>
          )}
          <StatusBadge status={agent.status} />
        </span>
      ),
    }));

    return [
      ...agentRows,
      { key: '__new__', target: { kind: 'new' }, render: <>✦ New agent</> },
    ];
  }, [allAgents, workspaceId, currentAgentId]);

  // Default highlight = the current agent when present (row 0), else row 0
  // (first supervisor / first agent / "New agent" on an empty workspace).
  const [highlighted, setHighlighted] = useState(0);
  useEffect(() => {
    setHighlighted(0);
  }, [rows.length]);

  const rowCount = rows.length;

  const pickRow = (idx: number) => {
    const row = rows[idx];
    if (row) onPick(row.target);
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
  }, [rowCount, highlighted, rows]);

  const rowClass = (idx: number) =>
    `ui-menu-item w-full text-left${highlighted === idx ? ' bg-white/10' : ''}`;

  return (
    <div className="border-l border-white/10 ml-2 max-h-[40vh] overflow-y-auto">
      {rows.map((row, idx) => (
        <button
          key={row.key}
          className={rowClass(idx)}
          onClick={() => pickRow(idx)}
          onMouseEnter={() => setHighlighted(idx)}
        >
          {row.render}
        </button>
      ))}
    </div>
  );
}
