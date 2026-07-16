import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SelectionAgentTarget, SelectionContext } from '../../lib/selection/selection-types';
import { positionFloating } from '../../lib/floating/positionFloating';
import AgentPickerDropdown from './AgentPickerDropdown';

// Portal-rendered context menu for an active text selection.
// Style precedent: src/renderer/components/shared/FileContextMenu.tsx.
// "Comment & send…" is the universal one-shot flow (WP-P5 user scope §1):
// available on every surface, opens AddCommentPopover in send mode.
// "Add comment…" (staged draft) renders only on surfaces with persistence
// capability — file surfaces in slice 2.

interface Props {
  x: number;
  y: number;
  context: SelectionContext;
  onClose: () => void;
  onPickAgent: (target: SelectionAgentTarget) => void;
  onAddComment?: () => void;
  onCommentAndSend?: () => void;
  onHighlight?: () => void;
}

// Keep the menu fully on-screen: measure the real box and let the shared
// helper flip it above the cursor when there's no room below, then clamp both
// axes into the viewport (BUG-45). Width/est-height are the pre-measure budget.
const MENU_WIDTH = 300;
const MENU_EST_HEIGHT = 220;
const MENU_MARGIN = 8;

export default function SelectionActionMenu({
  x, y, context, onClose, onPickAgent, onAddComment, onCommentAndSend, onHighlight,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  // Cursor point is a zero-size anchor; 'below' drops the menu under it and
  // flips above near the bottom edge.
  const [pos, setPos] = useState(() =>
    positionFloating({ x, y, width: 0, height: 0 }, { width: MENU_WIDTH, height: MENU_EST_HEIGHT }, viewport, {
      placement: 'below',
      gap: 0,
    }),
  );

  // Reposition off the measured box (height changes when "Send to agent"
  // expands the picker), so a menu opened low still flips fully on-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos(
      positionFloating(
        { x, y, width: 0, height: 0 },
        { width: box.width || MENU_WIDTH, height: box.height || MENU_EST_HEIGHT },
        { width: window.innerWidth, height: window.innerHeight },
        { placement: 'below', gap: 0 },
      ),
    );
  }, [x, y, pickerOpen]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleCopy = () => {
    navigator.clipboard.writeText(context.quotedText);
    onClose();
  };

  const handleAddComment = () => {
    onAddComment?.();
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="ui-menu fixed z-50 overflow-y-auto"
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH, maxHeight: `calc(100vh - ${MENU_MARGIN * 2}px)` }}
      // Keep the user's text selection alive: a default mousedown inside the
      // menu would collapse the document selection before the action runs.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ui-menu-header">Selection</div>
      <button
        onClick={() => setPickerOpen((v) => !v)}
        className="ui-menu-item"
      >
        Send to agent&nbsp;▸
      </button>
      {pickerOpen && (
        <AgentPickerDropdown
          workspaceId={context.workspaceId}
          onPick={onPickAgent}
          currentAgentId={context.chat?.agentId}
        />
      )}
      {onCommentAndSend && (
        <button
          onClick={() => {
            onCommentAndSend();
            onClose();
          }}
          className="ui-menu-item"
        >
          Comment &amp; send…
        </button>
      )}
      {context.capabilities.comment && onAddComment && (
        <button onClick={handleAddComment} className="ui-menu-item">
          Add comment…
        </button>
      )}
      {context.capabilities.comment && onHighlight && (
        <button
          onClick={() => {
            onHighlight();
            onClose();
          }}
          className="ui-menu-item"
        >
          Highlight
        </button>
      )}
      <div className="ui-menu-divider" />
      <button onClick={handleCopy} className="ui-menu-item">
        Copy
      </button>
    </div>,
    document.body,
  );
}
