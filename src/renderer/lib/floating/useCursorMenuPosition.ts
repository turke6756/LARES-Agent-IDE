import { useLayoutEffect, useState, type RefObject } from 'react';
import { positionFloating, type Position, type Size } from './positionFloating';

interface CursorPoint {
  x: number;
  y: number;
}

/** Measure and flip/clamp a cursor-anchored fixed menu into the viewport. */
export function useCursorMenuPosition(
  menuRef: RefObject<HTMLElement | null>,
  point: CursorPoint | null,
  estimate: Size,
  layoutKey?: unknown,
): Position {
  const [position, setPosition] = useState<Position>({ left: point?.x ?? 8, top: point?.y ?? 8 });

  useLayoutEffect(() => {
    if (!point) return;

    const update = () => {
      const box = menuRef.current?.getBoundingClientRect();
      setPosition(positionFloating(
        { x: point.x, y: point.y, width: 0, height: 0 },
        { width: box?.width || estimate.width, height: box?.height || estimate.height },
        { width: window.innerWidth, height: window.innerHeight },
        { placement: 'below', gap: 0 },
      ));
    };

    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [menuRef, point?.x, point?.y, estimate.width, estimate.height, layoutKey]);

  return position;
}
