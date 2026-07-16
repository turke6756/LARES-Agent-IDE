import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';
import { positionFloating, type Rect } from '../../lib/floating/positionFloating';
import AgentPickerDropdown from './AgentPickerDropdown';

// Comment-entry popover (WP-P5-B), used by both flows:
//  - mode 'send'  — universal one-shot "Comment & send…": type a comment,
//    pick an agent, the quote+comment go out as one [SELECTION COMMENT]
//    message (persisted first on comment-capable file surfaces; prompt-only
//    elsewhere).
//  - mode 'draft' — "Add comment…" on file surfaces: saves a draft row and
//    the user keeps reading/commenting.
//
// Click-away only closes while the textarea is empty — typed text must not
// be lost to a stray click. Escape always closes.

interface Props {
  /** Viewport rect of the selected text. The composer is placed to the LEFT or
   *  RIGHT of this (whichever has more room) so it never covers the anchored
   *  range (BUG-46). */
  anchorRect: Rect;
  quotedText: string;
  workspaceId: string;
  mode: 'draft' | 'send';
  /** Agent the user is working in (chat surface) — default picker target. */
  currentAgentId?: string;
  onClose: () => void;
  onSaveDraft?: (body: string) => void;
  onSend?: (target: SelectionAgentTarget, body: string) => void;
}

const POPOVER_WIDTH = 340;
// Fallback height before the box is measured; refined on the first layout pass.
const POPOVER_EST_HEIGHT = 220;

export default function AddCommentPopover({
  anchorRect, quotedText, workspaceId, mode, currentAgentId, onClose, onSaveDraft, onSend,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const canSubmit = body.trim().length > 0;

  // Auto-placed beside the selection until the user drags the composer, after
  // which `dragPos` pins it wherever they left it.
  const [pos, setPos] = useState<{ left: number; top: number }>(() =>
    positionFloating(
      anchorRect,
      { width: POPOVER_WIDTH, height: POPOVER_EST_HEIGHT },
      { width: window.innerWidth, height: window.innerHeight },
      { placement: 'side' },
    ),
  );
  const draggedRef = useRef(false);

  // Re-place using the composer's REAL measured height once mounted (and again
  // if it grows, e.g. the agent picker expands) — unless the user has dragged.
  useLayoutEffect(() => {
    if (draggedRef.current) return;
    const el = popoverRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos(
      positionFloating(
        anchorRect,
        { width: box.width || POPOVER_WIDTH, height: box.height || POPOVER_EST_HEIGHT },
        { width: window.innerWidth, height: window.innerHeight },
        { placement: 'side' },
      ),
    );
  }, [anchorRect, pickerOpen]);

  // Pointer-drag from the header moves the composer; clamped into the viewport
  // on release so it can't be stranded off-screen.
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = popoverRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const offsetX = e.clientX - box.left;
    const offsetY = e.clientY - box.top;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    draggedRef.current = true;
    const onMove = (ev: PointerEvent) => {
      const maxLeft = window.innerWidth - box.width - 8;
      const maxTop = window.innerHeight - box.height - 8;
      setPos({
        left: Math.max(8, Math.min(ev.clientX - offsetX, maxLeft)),
        top: Math.max(8, Math.min(ev.clientY - offsetY, maxTop)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        if (!textareaRef.current?.value.trim()) onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const submitDraft = () => {
    if (!canSubmit) return;
    onSaveDraft?.(body.trim());
    onClose();
  };

  const submitSend = (target: SelectionAgentTarget) => {
    if (!canSubmit) return;
    onSend?.(target, body.trim());
    onClose();
  };

  const quotePreview =
    quotedText.length > 160 ? `${quotedText.slice(0, 160)}…` : quotedText;

  return createPortal(
    <div
      ref={popoverRef}
      className="ui-menu fixed z-50 p-2 overflow-y-auto"
      style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH, maxHeight: 'calc(100vh - 16px)' }}
    >
      <div
        className="ui-menu-header cursor-move select-none"
        onPointerDown={onHeaderPointerDown}
        title="Drag to move"
      >
        {mode === 'draft' ? 'Add comment' : 'Comment & send'}
      </div>
      <div className="px-2 py-1 mb-1 border-l-2 border-accent-blue/50 text-[12px] text-gray-400 italic whitespace-pre-wrap max-h-20 overflow-hidden">
        {quotePreview}
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Draft mode is the quick-capture path (stage a comment, type the
          // next): plain Enter submits, Shift+Enter inserts a newline. Ctrl/Cmd
          // +Enter also submits for muscle-memory parity.
          if (e.key === 'Enter' && mode === 'draft' && (!e.shiftKey || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitDraft();
          }
        }}
        rows={3}
        placeholder={mode === 'draft' ? 'Comment, then Enter to stage (Shift+Enter for newline)…' : 'Comment to send with the quote…'}
        className="w-full resize-y rounded bg-surface-2 border border-white/10 px-2 py-1.5 text-[13px] text-gray-200 outline-none focus:border-accent-blue/60"
      />
      {mode === 'draft' ? (
        <div className="flex justify-end gap-2 mt-1.5">
          <button className="ui-btn text-[12px]" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ui-btn text-[12px]"
            disabled={!canSubmit}
            onClick={submitDraft}
            title="Save this comment (Enter)"
          >
            Save comment
          </button>
        </div>
      ) : (
        <div className="mt-1.5">
          <button
            className="ui-menu-item w-full text-left"
            disabled={!canSubmit}
            onClick={() => canSubmit && setPickerOpen((v) => !v)}
          >
            Send to agent&nbsp;▸
          </button>
          {pickerOpen && canSubmit && (
            <AgentPickerDropdown
              workspaceId={workspaceId}
              onPick={submitSend}
              currentAgentId={currentAgentId}
            />
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
