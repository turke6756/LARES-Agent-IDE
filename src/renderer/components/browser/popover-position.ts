// ── Shared collision-aware popover positioning (Slice 16) ────────────────────
// One helper so every browser-chrome popover (StarMenu / omnibox suggestions /
// tab context-menu) clamps and flips against the viewport instead of each
// reimplementing it (or rendering partly off-screen). Pure math + a measure
// hook; no DOM writes here. The returned `origin` feeds the popover scale-in
// animation's transform-origin so it grows from the anchored corner.

import { useLayoutEffect, useState, type RefObject } from 'react';

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** True when an anchored popover was flipped to sit ABOVE its trigger. */
  placedAbove: boolean;
  /** CSS transform-origin (e.g. "top left") for the scale-in animation. */
  origin: string;
}

export function getViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 1024, height: 768 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Clamp a popover of the given size so it stays fully on-screen. For
 * cursor-anchored menus (right-click): the desired point is the menu's
 * top-left; we shift it left/up only as far as needed to keep it in view.
 */
export function clampToViewport(
  desired: { x: number; y: number },
  size: { width: number; height: number },
  opts: { margin?: number; viewport?: Viewport } = {},
): Placement {
  const margin = opts.margin ?? 4;
  const vp = opts.viewport ?? getViewport();
  const maxLeft = Math.max(margin, vp.width - size.width - margin);
  const maxTop = Math.max(margin, vp.height - size.height - margin);
  const left = Math.min(Math.max(margin, desired.x), maxLeft);
  const top = Math.min(Math.max(margin, desired.y), maxTop);
  // If we had to pull the box back, it grows toward the anchor (opposite edge).
  const originX = left < desired.x ? 'right' : 'left';
  const originY = top < desired.y ? 'bottom' : 'top';
  return { left, top, placedAbove: false, origin: `${originY} ${originX}` };
}

/**
 * Place a popover anchored to a trigger rect. Prefers BELOW the trigger; flips
 * ABOVE when it would overflow the bottom and there's more room above. Aligns to
 * the trigger's start (left) or end (right) edge, then clamps horizontally to the
 * viewport. Coordinates are viewport-relative (use with position: fixed).
 */
export function placeAnchored(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  opts: { margin?: number; gap?: number; viewport?: Viewport; align?: 'start' | 'end' } = {},
): Placement {
  const margin = opts.margin ?? 4;
  const gap = opts.gap ?? 4;
  const vp = opts.viewport ?? getViewport();
  const align = opts.align ?? 'start';

  const spaceBelow = vp.height - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;
  const placedAbove = size.height + gap > spaceBelow && spaceAbove > spaceBelow;
  let top = placedAbove ? anchor.top - gap - size.height : anchor.bottom + gap;
  top = Math.min(Math.max(margin, top), Math.max(margin, vp.height - size.height - margin));

  let left = align === 'end' ? anchor.right - size.width : anchor.left;
  left = Math.min(Math.max(margin, left), Math.max(margin, vp.width - size.width - margin));

  const origin = `${placedAbove ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`;
  return { left, top, placedAbove, origin };
}

/**
 * Measure a mounted popover and an anchor element after layout, returning a
 * clamped/flipped fixed-position placement. `null` until both refs resolve.
 * Recomputes when `deps` change (e.g. the open flag, content length).
 */
export function useAnchoredPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  opts: { align?: 'start' | 'end'; gap?: number; margin?: number } = {},
  deps: unknown[] = [],
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const pop = popoverRef.current;
    if (!anchor || !pop) return;
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const next = placeAnchored(
      { left: a.left, right: a.right, top: a.top, bottom: a.bottom },
      { width: p.width, height: p.height },
      opts,
    );
    setPlacement((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.placedAbove === next.placedAbove
        ? prev
        : next,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return placement;
}
