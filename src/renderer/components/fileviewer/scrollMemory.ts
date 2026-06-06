import { useCallback, useLayoutEffect, type RefObject } from 'react';

const tabScrollFractions = new Map<string, number>();

export function setTabScrollFraction(tabId: string, fraction: number): void {
  if (!tabId || !Number.isFinite(fraction)) return;
  const clamped = Math.max(0, Math.min(1, fraction));
  tabScrollFractions.set(tabId, clamped);
}

export function getTabScrollFraction(tabId: string): number {
  if (!tabId) return 0;
  return tabScrollFractions.get(tabId) ?? 0;
}

export function clearTabScrollFraction(tabId: string): void {
  tabScrollFractions.delete(tabId);
}

/**
 * Per-tab scroll persistence for a scrollable container.
 *
 * Restores the remembered scroll fraction whenever `tabId` changes (covers
 * both a fresh mount after a tab switch and the case where the renderer
 * component stays mounted while the tab — and therefore content — swaps
 * underneath it). Returns an onScroll handler that records the current
 * fraction.
 *
 * Content-only refreshes (e.g., the file changing on disk) re-render without
 * changing `tabId`, so the restore effect does not re-run and the container
 * keeps its current pixel scroll position — live refresh never snaps to top.
 */
export function useTabScrollMemory(
  tabId: string | undefined,
  ref: RefObject<HTMLElement | null>,
): () => void {
  useLayoutEffect(() => {
    if (!tabId) return;
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    // Apply even when the fraction is 0: a component reused across a tab
    // switch still carries the previous tab's scrollTop.
    el.scrollTop = max > 0 ? max * getTabScrollFraction(tabId) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return useCallback(() => {
    if (!tabId) return;
    const el = ref.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    setTabScrollFraction(tabId, el.scrollTop / max);
  }, [tabId, ref]);
}
