import { describe, it, expect } from 'vitest';
import { positionFloating, type Rect, type Size, type Viewport } from './positionFloating';

const VIEWPORT: Viewport = { width: 1000, height: 800 };

// A zero-size anchor at a cursor point (the context-menu case).
const cursor = (x: number, y: number): Rect => ({ x, y, width: 0, height: 0 });

describe('positionFloating — below (context menu / BUG-45)', () => {
  const menu: Size = { width: 300, height: 200 };

  it('drops below-right of the cursor when there is room', () => {
    const pos = positionFloating(cursor(100, 100), menu, VIEWPORT, { placement: 'below' });
    expect(pos.left).toBe(100);
    expect(pos.top).toBe(106); // y + gap(6)
  });

  it('flips ABOVE the cursor when there is no room below', () => {
    // Cursor near the bottom edge — 780 of 800; a 200px menu would overflow.
    const pos = positionFloating(cursor(100, 780), menu, VIEWPORT, { placement: 'below' });
    // Flipped up: top = y - gap - height = 780 - 6 - 200 = 574
    expect(pos.top).toBe(574);
    expect(pos.top + menu.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
  });

  it('clamps horizontally so the menu never runs off the right edge', () => {
    const pos = positionFloating(cursor(950, 100), menu, VIEWPORT, { placement: 'below' });
    expect(pos.left).toBe(VIEWPORT.width - 8 - menu.width); // 692
    expect(pos.left + menu.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it('clamps to the top margin when a tall menu cannot fit either way', () => {
    const tall: Size = { width: 300, height: 900 };
    const pos = positionFloating(cursor(100, 700), tall, VIEWPORT, { placement: 'below' });
    expect(pos.top).toBe(8); // pinned to top margin
  });
});

describe('positionFloating — side (comment composer / BUG-46)', () => {
  const composer: Size = { width: 340, height: 240 };

  it('places to the RIGHT of the selection when the right has more room', () => {
    // Selection on the left third of the viewport.
    const anchor: Rect = { x: 100, y: 400, width: 200, height: 40 };
    const pos = positionFloating(anchor, composer, VIEWPORT, { placement: 'side' });
    expect(pos.left).toBe(anchor.x + anchor.width + 6); // 306, clear of the anchor
    // Never covers the anchor's horizontal span.
    expect(pos.left).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  });

  it('places to the LEFT of the selection when the right is cramped', () => {
    // Selection hugging the right edge — no room on the right.
    const anchor: Rect = { x: 800, y: 400, width: 150, height: 40 };
    const pos = positionFloating(anchor, composer, VIEWPORT, { placement: 'side' });
    // Left of the anchor: left = anchor.x - gap - width = 800 - 6 - 340 = 454
    expect(pos.left).toBe(454);
    expect(pos.left + composer.width).toBeLessThanOrEqual(anchor.x);
  });

  it('does not cover a selection near the bottom — clamps vertically on-screen', () => {
    // The BUG-46 repro: selecting text near the bottom of the document.
    const anchor: Rect = { x: 100, y: 780, width: 200, height: 30 };
    const pos = positionFloating(anchor, composer, VIEWPORT, { placement: 'side' });
    // Beside (not over) the selection, fully within the viewport.
    expect(pos.left).toBe(306);
    expect(pos.top + composer.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
    expect(pos.top).toBe(VIEWPORT.height - 8 - composer.height); // 552
  });

  it('picks the side with more room when neither side fully fits, staying on-screen', () => {
    // Wide selection spanning most of the viewport; right room (small) > left room (tiny).
    const anchor: Rect = { x: 40, y: 400, width: 800, height: 40 };
    const pos = positionFloating(anchor, composer, VIEWPORT, { placement: 'side' });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + composer.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });
});
