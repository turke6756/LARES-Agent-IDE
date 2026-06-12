// Surface-side hook for the select-text → right-click → "Send to agent"
// primitive. A surface attaches this to its scroll/content container and
// renders the returned `menuElement`; everything else (menu, picker,
// dispatch) lives inside this package.
//
// plans/selection-to-agent-primitive-plan.md §7 WP-P1.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import SelectionActionMenu from '../../components/selection/SelectionActionMenu';
import { sendSelectionToAgent } from './selection-dispatch';
import type { SelectionAgentTarget, SelectionContext } from './selection-types';

export interface UseSelectionActionsOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  getContext: () => Omit<SelectionContext, 'quotedText'>;
}

interface OpenMenuState {
  x: number;
  y: number;
  context: SelectionContext;
}

export interface UseSelectionActionsResult {
  menu: OpenMenuState | null;
  closeMenu: () => void;
  // Fully wired portal menu — render this anywhere in the surface's tree.
  menuElement: React.ReactNode;
}

export function useSelectionActions({
  containerRef,
  getContext,
}: UseSelectionActionsOptions): UseSelectionActionsResult {
  const [menu, setMenu] = useState<OpenMenuState | null>(null);

  // Surfaces pass inline closures over per-render values (agent id, file
  // path…). The contextmenu listener below mounts once, so it must read the
  // CURRENT render's closure through a ref, not the mount-time one.
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;

  const closeMenu = useCallback(() => setMenu(null), []);

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
      setMenu({
        x: e.clientX,
        y: e.clientY,
        context: { ...getContextRef.current(), quotedText: text },
      });
    };

    container.addEventListener('contextmenu', onContextMenu);
    return () => container.removeEventListener('contextmenu', onContextMenu);
  }, [containerRef]);

  // While open: close on scroll/resize/Escape. Click-away is handled by the
  // menu component itself (it knows its own bounds).
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

  const menuElement = menu
    ? React.createElement(SelectionActionMenu, {
        x: menu.x,
        y: menu.y,
        context: menu.context,
        onClose: closeMenu,
        onPickAgent: handlePickAgent,
      })
    : null;

  return { menu, closeMenu, menuElement };
}
