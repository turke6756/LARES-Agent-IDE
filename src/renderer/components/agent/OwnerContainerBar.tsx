import React, { useEffect, useState, useRef } from 'react';
import type { Agent } from '../../../shared/types';
import StatusBadge from './StatusBadge';
import { RoleChips, ContextStatsBar, HooksOffBadge } from './agent-card-bits';
import ContinuationSplitButton from './ContinuationSplitButton';
import { isContinuationEligible } from './continuation-controls';
import { PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';
import { isActivePhase } from './continuation-phase-view';
import { useCursorMenuPosition } from '../../lib/floating/useCursorMenuPosition';

// The header bar for an owner-container: a horizontal, full-width band (gold top
// accent + thick blue fill) standing in for the vertical AgentCard when an agent
// owns ≥1 other agent. It reuses AgentCard's StatusBadge / RoleChips /
// ContextStatsBar subexpressions (plan §2.3) but on the horizontal axis.
//
// Click isolation (plan §1): this component owns the *selectable* region's
// onClick; the collapse toggle is a sibling with its own handler; the wrapper has
// no ancestor onClick. Drag is deliberately NOT enabled — a thick bar dragged
// into a chat input is confusing.
export default function OwnerContainerBar({
  agent,
  childCount,
  expanded,
  onToggle,
  depth,
  unread = false,
  multiSelected = false,
  childrenActive = false,
  onCardClick,
  onDeleteCascade,
  cascadeCount = 1,
}: {
  agent: Agent;
  childCount: number;
  expanded: boolean;
  onToggle: () => void;
  /** Nesting depth — 0 is a top-level band; deeper bands attenuate the accents. */
  depth: number;
  unread?: boolean;
  multiSelected?: boolean;
  /** True when ≥1 owned agent (any depth) is actively working — drives the
   *  pulsing border so a busy cohort is visible even while this owner is idle. */
  childrenActive?: boolean;
  onCardClick?: (agentId: string, shiftKey: boolean) => void;
  /** Cascade-delete this supervisor AND every agent it owns. */
  onDeleteCascade?: () => void | Promise<void>;
  /** Total agents removed by the cascade (this supervisor + all owned). */
  cascadeCount?: number;
}) {
  const isSelected = useDashboardStore((s) => s.selectedAgentId === agent.id);
  const isTerminalActive = useDashboardStore((s) => s.terminalAgentId === agent.id);
  const cs = useDashboardStore((s) => s.contextStats[agent.id] ?? null);
  // Gold "snake" border while this supervisor is mid context-brick continuation transfer.
  const transferring = useDashboardStore((s) => isActivePhase(s.continuationPhases[agent.id]?.phase));
  const selectAgent = useDashboardStore((s) => s.selectAgent);
  const setTerminalAgent = useDashboardStore((s) => s.setTerminalAgent);

  // Right-click / shift+click delete menu. Two-step confirm because the action
  // is destructive — it removes the supervisor and every agent it owns.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPosition = useCursorMenuPosition(menuRef, contextMenu, { width: 260, height: 85 }, confirmDelete);

  // Dismiss the menu on any outside click (mirrors AgentCard's context menu).
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setConfirmDelete(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const openDeleteMenu = (x: number, y: number) => {
    setConfirmDelete(false);
    setContextMenu({ x, y });
  };

  // Seed this owner's context stats on mount, mirroring AgentCard's fetch.
  // Live updates arrive globally via onContextStatsChanged (App.tsx), but an
  // idle supervisor whose workers are busy never emits a fresh stats event of
  // its own — without this initial fetch its context bar would stay hidden.
  useEffect(() => {
    window.api.agents.getContextStats(agent.id).then((stats) => {
      if (stats) {
        useDashboardStore.getState().updateContextStats(stats);
      }
    });
  }, [agent.id]);

  const meta = PROVIDER_META[agent.provider || 'claude'];
  const nested = depth > 0;

  // Attenuate the blue fill / gold accent the deeper a sub-band sits, so nesting
  // reads as recession rather than a wall of identical bars.
  const fill = nested ? 'bg-accent-blue/[0.07]' : 'bg-accent-blue/[0.13]';
  const accent = nested ? 'border-t-2 border-amber-400/40' : 'border-t-2 border-amber-400';

  // A selected (chat-attached) bar gets the dedicated `owner-bar-selected` class
  // (strong blue wash + bright left rail + glow) instead of the subtle ring it
  // used to share with the unread/multi-select states — so "which bar am I on?"
  // is unmistakable. Those secondary halos only show when NOT selected.
  const ring = isSelected
    ? ''
    : multiSelected
      ? 'ring-1 ring-accent-purple'
      : unread
        ? 'ring-1 ring-accent-blue/60'
        : '';

  return (
    <div
      className={`relative ${accent} ${isSelected ? 'owner-bar-selected' : fill} border border-surface-3
        ${expanded ? 'rounded-t border-b-0' : 'rounded'}
        ${!isSelected && isTerminalActive ? 'bg-accent-blue/[0.18]' : ''} ${ring}
        ${childrenActive ? 'owner-active-pulse' : ''} ${transferring ? 'agent-transfer-glow' : ''}`}
      title={childrenActive ? 'An agent owned by this one is working' : undefined}
      onContextMenu={(e) => {
        // Right-click anywhere on the bar → cascade-delete menu.
        e.preventDefault();
        e.stopPropagation();
        openDeleteMenu(e.clientX, e.clientY);
      }}
    >
      <div className="flex items-stretch">
        {/* Collapse toggle — sibling of the selectable region, its own handler. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex items-center px-2 text-gray-400 hover:text-gray-100 shrink-0"
          title={expanded ? 'Collapse owned agents' : 'Expand owned agents'}
          aria-expanded={expanded}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M4 2L8 6L4 10" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Selectable region — single-click selects (chat-attach halo), double
            click opens the terminal, shift+click toggles multi-selection. */}
        <div
          className="flex-1 min-w-0 flex items-center gap-3 py-2 pr-3 cursor-pointer"
          onMouseDown={(e) => {
            // Shift+click opens the cascade-delete menu — a fast way to tear down
            // a whole supervisor cohort without reaching for the right mouse button.
            if (e.shiftKey && e.button === 0) {
              e.preventDefault();
              e.stopPropagation();
              openDeleteMenu(e.clientX, e.clientY);
            }
          }}
          onClick={(e) => {
            if (e.shiftKey) return;
            onCardClick?.(agent.id, false);
            selectAgent(agent.id);
          }}
          onDoubleClick={() => setTerminalAgent(agent.id)}
        >
          {/* Identity: id + provider + title + role chips. */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] text-gray-500 font-mono shrink-0">#{agent.id.substring(0, 6)}</span>
            <span className={`text-[11px] font-semibold px-1.5 py-0.5 shrink-0 ${meta.bgClass} ${meta.textClass}`}>
              {meta.label}
            </span>
            <h4
              className={`font-semibold text-[13px] truncate ${isSelected ? 'text-accent-blue' : 'text-gray-100'}`}
              title={agent.title}
            >
              {agent.title}
            </h4>
            <RoleChips agent={agent} />
            <span className="text-[11px] text-gray-400 bg-surface-3/70 px-1.5 py-0.5 shrink-0 whitespace-nowrap" title="Agents owned by this one">
              {childCount} owned
            </span>
          </div>

          {/* Context bar — fixed slice on the right so the bar stays horizontal. */}
          {cs && (
            <div className="hidden md:block w-44 shrink-0">
              <ContextStatsBar cs={cs} className="" />
            </div>
          )}

          <div className="ml-auto shrink-0 flex items-center gap-2">
            {/* Context-brick continuation control — claude-provider supervisors only. */}
            {isContinuationEligible(agent) && <ContinuationSplitButton agent={agent} />}
            {/* WP2 — hook-health badge, orthogonal to (and never replacing) the operational status. */}
            <HooksOffBadge agent={agent} />
            <StatusBadge status={agent.status} />
          </div>
        </div>
      </div>

      {/* Cascade-delete menu (right-click or shift+click). Deleting the bar
          deletes the supervisor AND every agent it owns — so a two-step confirm
          guards the whole cohort. */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="ui-menu fixed z-50"
          style={{ left: menuPosition.left, top: menuPosition.top, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}
        >
          <div className="ui-menu-header">Supervisor</div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              setContextMenu(null);
              setConfirmDelete(false);
              onDeleteCascade?.();
            }}
            className="ui-menu-item text-accent-red"
          >
            {(() => {
              const owned = Math.max(0, cascadeCount - 1);
              const label = `supervisor + ${owned} owned agent${owned === 1 ? '' : 's'}`;
              return confirmDelete ? `Confirm — delete ${label}` : `Delete ${label}`;
            })()}
          </button>
        </div>
      )}
    </div>
  );
}
