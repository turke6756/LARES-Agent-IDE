// Shared edge-aware placement for floating popups (context menus, comment
// composers) rendered into a fixed portal over the app.
//
// Two failure modes this fixes:
//  - BUG-45: a context menu opened near the bottom of the document rendered
//    below the cursor and ran off the app edge, its lower items unreachable.
//  - BUG-46: the comment composer opened directly on top of the selected text
//    it was commenting on, hiding it.
//
// The function is pure (no DOM, no React) so the flip/clamp logic is unit
// tested in isolation; callers measure the real popup box and viewport and pass
// them in.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Position {
  left: number;
  top: number;
}

export type FloatingPlacement =
  // Drop the popup below the anchor, flipping ABOVE when there is more room up
  // than down. For a cursor-anchored menu pass a zero-size anchor at the click
  // point. (BUG-45)
  | 'below'
  // Place the popup to the LEFT or RIGHT of the anchor — whichever side has
  // more room — so it never covers the anchored range. (BUG-46)
  | 'side';

export interface PositionOptions {
  placement?: FloatingPlacement;
  /** Gap between the anchor edge and the popup. */
  gap?: number;
  /** Minimum distance the popup keeps from every viewport edge. */
  margin?: number;
}

function clamp(value: number, min: number, max: number): number {
  // When the popup is larger than the available span (max < min) the clamp
  // window inverts; pin to `min` (the top/left margin) so it stays anchored to
  // a visible edge rather than snapping off the far side.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute a viewport-clamped {left, top} for a floating popup.
 *
 * The result always keeps the popup inside `[margin, viewport - margin]` on
 * both axes (or pinned to the near margin if the popup is bigger than the
 * viewport). For `placement: 'side'` the popup is pushed clear of the anchor on
 * the side with more free space; for `'below'` it drops under the anchor and
 * flips above when the space below can't hold it.
 */
export function positionFloating(
  anchor: Rect,
  popup: Size,
  viewport: Viewport,
  options: PositionOptions = {},
): Position {
  const { placement = 'below', gap = 6, margin = 8 } = options;

  const minLeft = margin;
  const maxLeft = viewport.width - margin - popup.width;
  const minTop = margin;
  const maxTop = viewport.height - margin - popup.height;

  if (placement === 'side') {
    const roomRight = viewport.width - margin - (anchor.x + anchor.width);
    const roomLeft = anchor.x - margin;
    const fitsRight = popup.width + gap <= roomRight;
    const fitsLeft = popup.width + gap <= roomLeft;

    let side: 'right' | 'left';
    if (fitsRight && !fitsLeft) side = 'right';
    else if (fitsLeft && !fitsRight) side = 'left';
    else side = roomRight >= roomLeft ? 'right' : 'left';

    const rawLeft =
      side === 'right'
        ? anchor.x + anchor.width + gap
        : anchor.x - gap - popup.width;

    // Keep the popup vertically near the selection, clamped fully on-screen.
    return {
      left: clamp(rawLeft, minLeft, maxLeft),
      top: clamp(anchor.y, minTop, maxTop),
    };
  }

  // placement === 'below'
  const roomBelow = viewport.height - margin - (anchor.y + anchor.height);
  const roomAbove = anchor.y - margin;
  const fitsBelow = popup.height + gap <= roomBelow;

  const rawTop =
    fitsBelow || roomBelow >= roomAbove
      ? anchor.y + anchor.height + gap
      : anchor.y - gap - popup.height;

  return {
    left: clamp(anchor.x, minLeft, maxLeft),
    top: clamp(rawTop, minTop, maxTop),
  };
}
