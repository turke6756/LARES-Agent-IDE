// Surface-side hook for the select-text → right-click primitive. A surface
// attaches this to its scroll/content container and renders the returned
// `menuElement`; everything else (menu, picker, comment popover, dispatch)
// lives inside this package.
//
// plans/selection-to-agent-primitive-plan.md §7 WP-P1; WP-P5-B adds:
//  - "Comment & send…" on EVERY surface (user scope §1) — one-shot popover;
//    default delivery is the slice-1 renderer dispatch with a comment item
//    (no DB row). Surfaces with persistence override via onCommentAndSend.
//  - "Add comment…" on surfaces that pass onSaveComment AND set
//    capabilities.comment — saves a draft row, user keeps reading.
// Selection context (prefix/suffix ~32 chars) is captured at menu-open time:
// by the time the popover submits, the DOM selection is long gone.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import SelectionActionMenu from '../../components/selection/SelectionActionMenu';
import AddCommentPopover from '../../components/selection/AddCommentPopover';
import { sendSelectionToAgent } from './selection-dispatch';
import { captureSelectionDetail } from './comment-anchors';
import type { SelectionAgentTarget, SelectionContext } from './selection-types';

export interface SelectionCommentDetail {
  context: SelectionContext;
  body: string;
  /** ~32 chars either side of the selection at capture time. */
  prefix: string;
  suffix: string;
}

export interface UseSelectionActionsOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  getContext: () => Omit<SelectionContext, 'quotedText'>;
  /** Persist a draft comment (file surfaces, slice 2). Enables "Add comment…"
   * when the context also sets capabilities.comment. */
  onSaveComment?: (detail: SelectionCommentDetail) => void | Promise<void>;
  /** Override one-shot "Comment & send" delivery (file surfaces persist the
   * row first). Default: slice-1 dispatch with the comment riding the prompt. */
  onCommentAndSend?: (
    detail: SelectionCommentDetail,
    target: SelectionAgentTarget,
  ) => void | Promise<void>;
  /** Persist a plain highlight over the selection (file surfaces, no body).
   * Enables the "Highlight" item when the context sets capabilities.comment. */
  onHighlight?: (detail: SelectionCommentDetail) => void | Promise<void>;
}

interface OpenMenuState {
  x: number;
  y: number;
  context: SelectionContext;
  prefix: string;
  suffix: string;
}

interface OpenPopoverState extends OpenMenuState {
  mode: 'draft' | 'send';
}

export interface UseSelectionActionsResult {
  menu: OpenMenuState | null;
  closeMenu: () => void;
  // Fully wired portal menu + popover — render this anywhere in the surface's tree.
  menuElement: React.ReactNode;
}

export function useSelectionActions({
  containerRef,
  getContext,
  onSaveComment,
  onCommentAndSend,
  onHighlight,
}: UseSelectionActionsOptions): UseSelectionActionsResult {
  const [menu, setMenu] = useState<OpenMenuState | null>(null);
  const [popover, setPopover] = useState<OpenPopoverState | null>(null);

  // Surfaces pass inline closures over per-render values (agent id, file
  // path…). The contextmenu listener below mounts once, so it must read the
  // CURRENT render's closure through a ref, not the mount-time one.
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  const onSaveCommentRef = useRef(onSaveComment);
  onSaveCommentRef.current = onSaveComment;
  const onCommentAndSendRef = useRef(onCommentAndSend);
  onCommentAndSendRef.current = onCommentAndSend;
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;

  const closeMenu = useCallback(() => setMenu(null), []);
  const closePopover = useCallback(() => setPopover(null), []);

  // Open on contextmenu over a non-empty selection fully inside the container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onContextMenu = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString();
      if (!text.trim()) return;
      const range = sel.getRangeAt(0);
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        return;
      }
      e.preventDefault();
      const { prefix, suffix } = captureSelectionDetail(range, container);
      setMenu({
        x: e.clientX,
        y: e.clientY,
        context: { ...getContextRef.current(), quotedText: text },
        prefix,
        suffix,
      });
    };

    container.addEventListener('contextmenu', onContextMenu);
    return () => container.removeEventListener('contextmenu', onContextMenu);
  }, [containerRef]);

  // While the menu is open: close on scroll/resize/Escape. Click-away is
  // handled by the menu component itself (it knows its own bounds). The
  // popover deliberately survives scroll/resize — it holds typed text.
  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, closeMenu]);

  const handlePickAgent = useCallback(
    (target: SelectionAgentTarget) => {
      if (!menu) return;
      const { context } = menu;
      closeMenu();
      // Fire-and-forget: dispatch surfaces success/failure via toasts.
      void sendSelectionToAgent(target, context, [{ quote: context.quotedText }]);
    },
    [menu, closeMenu],
  );

  const openPopover = useCallback(
    (mode: 'draft' | 'send') => {
      if (!menu) return;
      setPopover({ ...menu, mode });
      closeMenu();
    },
    [menu, closeMenu],
  );

  const handleHighlight = useCallback(() => {
    if (!menu) return;
    // No body and no popover — a highlight is fire-and-forget over the
    // captured selection (quote + prefix/suffix anchors).
    void onHighlightRef.current?.({
      context: menu.context,
      body: '',
      prefix: menu.prefix,
      suffix: menu.suffix,
    });
    closeMenu();
  }, [menu, closeMenu]);

  const handleSaveDraft = useCallback(
    (body: string) => {
      if (!popover) return;
      void onSaveCommentRef.current?.({
        context: popover.context,
        body,
        prefix: popover.prefix,
        suffix: popover.suffix,
      });
    },
    [popover],
  );

  const handleOneShotSend = useCallback(
    (target: SelectionAgentTarget, body: string) => {
      if (!popover) return;
      const detail: SelectionCommentDetail = {
        context: popover.context,
        body,
        prefix: popover.prefix,
        suffix: popover.suffix,
      };
      if (onCommentAndSendRef.current) {
        void onCommentAndSendRef.current(detail, target);
      } else {
        void sendSelectionToAgent(target, detail.context, [
          { quote: detail.context.quotedText, comment: body },
        ]);
      }
    },
    [popover],
  );

  const menuElement = React.createElement(
    React.Fragment,
    null,
    menu
      ? React.createElement(SelectionActionMenu, {
          x: menu.x,
          y: menu.y,
          context: menu.context,
          onClose: closeMenu,
          onPickAgent: handlePickAgent,
          onCommentAndSend: () => openPopover('send'),
          onAddComment:
            onSaveComment && menu.context.capabilities.comment
              ? () => openPopover('draft')
              : undefined,
          onHighlight:
            onHighlight && menu.context.capabilities.comment ? handleHighlight : undefined,
        })
      : null,
    popover
      ? React.createElement(AddCommentPopover, {
          x: popover.x,
          y: popover.y,
          quotedText: popover.context.quotedText,
          workspaceId: popover.context.workspaceId,
          mode: popover.mode,
          currentAgentId: popover.context.chat?.agentId,
          onClose: closePopover,
          onSaveDraft: handleSaveDraft,
          onSend: handleOneShotSend,
        })
      : null,
  );

  return { menu, closeMenu, menuElement };
}
