type HorizontalWheelEventLike = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  preventDefault?: () => void;
};

type HorizontalScrollableLike = {
  clientWidth: number;
  scrollWidth: number;
  scrollLeft: number;
};

export type HorizontalWheelOptions = {
  /**
   * Translate an unmodified vertical wheel gesture by default. Pass false to
   * require horizontal or Shift+wheel input.
   */
  translateVerticalWheel?: boolean;
};

export const WHEEL_DELTA_PIXEL = 0;
export const WHEEL_DELTA_LINE = 1;
export const WHEEL_DELTA_PAGE = 2;

const DEFAULT_LINE_SIZE_PX = 16;

export function getHorizontalWheelDelta(
  event: HorizontalWheelEventLike,
  pageSizePx: number,
  lineSizePx = DEFAULT_LINE_SIZE_PX,
  options: HorizontalWheelOptions = {},
): number {
  let delta = event.deltaX;

  // Shift+wheel always maps horizontally; unmodified vertical wheel does too
  // unless a consumer explicitly opts out.
  if (delta === 0 && (event.shiftKey || options.translateVerticalWheel !== false)) {
    delta = event.deltaY;
  }

  if (delta === 0) return 0;

  switch (event.deltaMode) {
    case WHEEL_DELTA_LINE:
      return delta * lineSizePx;
    case WHEEL_DELTA_PAGE:
      return delta * pageSizePx;
    default:
      return delta;
  }
}

export function applyHorizontalWheelScroll(
  element: HorizontalScrollableLike,
  event: HorizontalWheelEventLike,
  options: HorizontalWheelOptions = {},
): boolean {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  if (maxScrollLeft <= 0) return false;

  const delta = getHorizontalWheelDelta(event, element.clientWidth, DEFAULT_LINE_SIZE_PX, options);
  if (delta === 0) return false;

  const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, element.scrollLeft + delta));
  if (nextScrollLeft === element.scrollLeft) return false;

  element.scrollLeft = nextScrollLeft;
  event.preventDefault?.();
  return true;
}

/**
 * React's delegated wheel handler may be passive in Electron/Chromium. Install
 * this at the element so preventDefault is legal when we translate wheel
 * gestures into horizontal scrolling. Plain vertical wheel translation is on
 * by default; pass `{ translateVerticalWheel: false }` to opt out.
 */
export function installHorizontalWheelScroll(
  element: HTMLElement,
  options: HorizontalWheelOptions = {},
): () => void {
  const onWheel = (event: WheelEvent) => {
    applyHorizontalWheelScroll(element, event, options);
  };
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => element.removeEventListener('wheel', onWheel);
}
