import React from 'react';
import StatusBadge from '../agent/StatusBadge';
import type { Agent } from '../../../shared/types';

// Presentational dropdown for the "@"-mention autocomplete in ChatInputBar.
// ALL state (candidates, query, highlight, open/closed, positioning) lives in
// ChatInputBar (Slice B) — this component only renders. Row markup mirrors
// AgentPickerDropdown (ui-menu-item, truncate title + StatusBadge, bg-white/10
// highlight), but it deliberately does NOT register a document keydown listener:
// that listener ignores TEXTAREA targets, so it cannot drive an in-textarea
// dropdown. All keyboard nav is owned by ChatInputBar's onKeyDown.

export interface Props {
  candidates: Agent[];
  query: string; // for no-match derivation
  highlighted: number;
  onPick: (agent: Agent) => void;
  onHover: (index: number) => void;
  position: { left: number; top: number } | null; // from Slice D; null → corner fallback
}

export default function AtMentionDropdown({
  candidates,
  query,
  highlighted,
  onPick,
  onHover,
  position,
}: Props) {
  const showNoMatch = query.length > 0 && candidates.length === 0;

  // Nothing to render unless there are candidates or an active (non-empty) query.
  if (candidates.length === 0 && !showNoMatch) return null;

  // Anchor: caret coordinates when available, else the input-bar top-left
  // corner. Either way we open UPWARD — the chat input sits at the pane bottom —
  // by pinning the dropdown's bottom edge to the anchor's top.
  const style: React.CSSProperties = position
    ? { left: position.left, bottom: `calc(100% - ${position.top}px)` }
    : { left: 0, bottom: '100%' };

  return (
    <div
      className="ui-menu absolute z-50 max-h-60 max-w-[280px] overflow-y-auto rounded-md shadow-lg py-1"
      style={style}
      role="listbox"
    >
      {showNoMatch ? (
        // Non-interactive: a plain div (no ui-menu-item :hover accent), so the
        // row never looks selectable.
        <div className="px-3 py-1.5 text-[13px] text-fg-muted cursor-default">
          No agents match
        </div>
      ) : (
        candidates.map((agent, i) => (
          <button
            key={agent.id}
            type="button"
            role="option"
            aria-selected={highlighted === i}
            className={`ui-menu-item w-full text-left${highlighted === i ? ' bg-white/10' : ''}`}
            // Pick on mousedown (NOT click) with preventDefault so the selection
            // fires before the textarea's blur — focus stays in the textarea and
            // the pick beats the blur-driven dropdown close.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(agent);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <span className="inline-flex items-center gap-2 max-w-[260px]">
              <span className="truncate">{agent.title}</span>
              <StatusBadge status={agent.status} />
            </span>
          </button>
        ))
      )}
    </div>
  );
}
