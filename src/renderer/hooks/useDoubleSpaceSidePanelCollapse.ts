import { useEffect } from 'react';
import { useDashboardStore } from '../stores/dashboard-store';
import { useTreeHoverStore } from '../stores/tree-hover-store';

export const DOUBLE_SPACE_WINDOW_MS = 350;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    'input, textarea, select, button, a[href], [contenteditable="true"], [role="textbox"]',
  ));
}

/** Bind the app-wide double-Space shortcut. Exported separately for focused DOM tests. */
export function bindDoubleSpaceSidePanelCollapse(
  target: Window,
  collapse: () => void,
  now: () => number = Date.now,
): () => void {
  let lastSpaceAt = 0;

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.code !== 'Space' ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      isEditableTarget(event.target) ||
      useTreeHoverStore.getState().hovered
    ) {
      lastSpaceAt = 0;
      return;
    }

    const pressedAt = now();
    if (lastSpaceAt > 0 && pressedAt - lastSpaceAt <= DOUBLE_SPACE_WINDOW_MS) {
      lastSpaceAt = 0;
      event.preventDefault();
      collapse();
      return;
    }
    lastSpaceAt = pressedAt;
  };

  target.addEventListener('keydown', onKeyDown, true);
  return () => target.removeEventListener('keydown', onKeyDown, true);
}

export function useDoubleSpaceSidePanelCollapse(): void {
  useEffect(() => bindDoubleSpaceSidePanelCollapse(
    window,
    () => useDashboardStore.getState().toggleSidePanels(),
  ), []);
}
