import React, { useEffect, useRef } from 'react';
import StatusBadge from '../agent/StatusBadge';
import type { Agent } from '../../../shared/types';

// Presentational dropdown for the "@"-mention autocomplete in ChatInputBar.
// ALL state (catalog, active workspace, query, highlight, open/closed,
// positioning) lives in ChatInputBar — this component only renders. It has two
// panes (WP5.2): a LEFT workspace rail and a RIGHT agent pane for the active
// rail workspace. Row markup mirrors AgentPickerDropdown (ui-menu-item, truncate
// title + StatusBadge, ui-menu-item-active highlight), but it deliberately does
// NOT register a document keydown listener: all keyboard nav is owned by
// ChatInputBar's onKeyDown (↑/↓ agents, ←/→/Tab workspaces, Enter commits).

export interface MentionRailWorkspace {
  id: string;
  title: string;
  agentCount: number;
  matchCount: number;
}

export interface Props {
  workspaces: MentionRailWorkspace[];
  activeWorkspaceId: string | null;
  // The app-wide selected workspace, tracked separately from activeWorkspaceId
  // (the rail selection). Used to label FOREIGN agent rows for disambiguation.
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  candidates: Agent[]; // all agents in the active workspace matching the query
  highlighted: number;
  loading: boolean; // catalog is (re)loading
  activeWorkspaceHasAgents: boolean; // distinguishes empty-workspace from no-match
  onPick: (agent: Agent) => void;
  onHover: (index: number) => void;
  position: { left: number; top: number; maxHeight?: number } | null; // from Slice D; null → corner fallback
}

export default function AtMentionDropdown({
  workspaces,
  activeWorkspaceId,
  selectedWorkspaceId,
  onSelectWorkspace,
  candidates,
  highlighted,
  loading,
  activeWorkspaceHasAgents,
  onPick,
  onHover,
  position,
}: Props) {
  const highlightedOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    highlightedOptionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);

  // Nothing to render only when the catalog is empty AND not loading — the
  // parent already gates on an active mention, so loading/empty/no-match all
  // render below.
  if (!loading && workspaces.length === 0 && candidates.length === 0) return null;

  // A foreign active workspace (not the app-selected one) labels its agent rows
  // with the workspace title so duplicate agent titles disambiguate (WP5.2).
  const activeIsForeign = activeWorkspaceId != null && activeWorkspaceId !== selectedWorkspaceId;
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);

  // Anchor: caret coordinates when available, else the input-bar top-left
  // corner. Either way we open UPWARD — the chat input sits at the pane bottom —
  // by pinning the dropdown's bottom edge to the anchor's top.
  const style: React.CSSProperties = position
    ? {
        left: position.left,
        bottom: `calc(100% - ${position.top}px)`,
        maxHeight: position.maxHeight,
      }
    : { left: 0, bottom: '100%' };

  return (
    <div
      className="ui-menu absolute z-50 flex w-[360px] max-w-[calc(100%-16px)] max-h-60 overflow-hidden rounded-md shadow-lg"
      style={style}
      role="listbox"
      aria-label="Mention an agent"
    >
      {/* Left: workspace rail — always visible, even at zero matches. */}
      <div
        className="w-[130px] shrink-0 overflow-y-auto border-r border-surface-3 py-1"
        role="tablist"
        aria-label="Workspaces"
      >
        {workspaces.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-fg-muted cursor-default">No workspaces</div>
        ) : (
          workspaces.map((w) => {
            const active = w.id === activeWorkspaceId;
            return (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={w.title}
                className={`ui-menu-item flex w-full items-center gap-1.5 text-left${active ? ' ui-menu-item-active' : ''}`}
                // Select on mousedown (NOT click) with preventDefault so it
                // fires before the textarea's blur closes the dropdown.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectWorkspace(w.id);
                }}
              >
                <span className="flex-1 truncate">{w.title}</span>
                <span
                  className={`text-[10px] tabular-nums text-fg-muted${w.matchCount === 0 ? ' opacity-40' : ''}`}
                >
                  {w.matchCount}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Right: agent pane for the active rail workspace. */}
      <div className="min-w-0 flex-1 overflow-y-auto py-1">
        {activeIsForeign && activeWs && (
          <div
            className="truncate px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
            title={activeWs.title}
          >
            {activeWs.title}
          </div>
        )}
        {candidates.length > 0 ? (
          // Cached candidates win over the loading flag so a refresh of an
          // already-populated catalog doesn't flash "Loading…" over the list.
          candidates.map((agent, i) => (
            <button
              key={agent.id}
              ref={highlighted === i ? highlightedOptionRef : undefined}
              type="button"
              role="option"
              aria-selected={highlighted === i}
              className={`ui-menu-item w-full text-left${highlighted === i ? ' ui-menu-item-active' : ''}`}
              // Pick on mousedown (NOT click) with preventDefault so the selection
              // fires before the textarea's blur — focus stays in the textarea and
              // the pick beats the blur-driven dropdown close.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(agent);
              }}
              onMouseEnter={() => onHover(i)}
            >
              <span className="inline-flex max-w-full items-center gap-2">
                <span className="truncate">{agent.title}</span>
                <StatusBadge status={agent.status} />
              </span>
            </button>
          ))
        ) : loading ? (
          <div className="px-3 py-1.5 text-[13px] text-fg-muted cursor-default" role="status">
            Loading agents…
          </div>
        ) : !activeWorkspaceHasAgents ? (
          // empty-workspace: the active workspace has no agents at all.
          <div className="px-3 py-1.5 text-[13px] text-fg-muted cursor-default">
            No agents in this workspace
          </div>
        ) : (
          // no-match: the workspace has agents, but none match the query.
          <div className="px-3 py-1.5 text-[13px] text-fg-muted cursor-default">No agents match</div>
        )}
      </div>
    </div>
  );
}
