import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SelectionAgentTarget, SelectionContext } from '../../lib/selection/selection-types';
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

export default function SelectionActionMenu({
  x, y, context, onClose, onPickAgent, onAddComment, onCommentAndSend, onHighlight,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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
      className="ui-menu fixed z-50"
      style={{ left: x, top: y }}
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
