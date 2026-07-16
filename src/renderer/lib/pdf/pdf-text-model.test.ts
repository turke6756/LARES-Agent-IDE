// pdf-text-model pure-geometry tests (plan Part 1.6). Node env vitest.
// The pdf.js orchestration (open/getPageText) is exercised at runtime; here we
// lock the pure normalization core: item→rect mapping and page-text assembly.
import { describe, expect, it } from 'vitest';
import {
  clampNormalizedRect,
  normalizePageTextContent,
  textItemToNormalizedRect,
} from './pdf-text-geometry';

// A minimal pdf.js TextItem shape for the pure functions.
function item(str: string, transform: number[], width: number, height: number, hasEOL = false) {
  return { str, transform, width, height, dir: 'ltr', fontName: 'g', hasEOL };
}

describe('textItemToNormalizedRect', () => {
  it('flips bottom-left y-up crop space into top-left y-down normalized space', () => {
    // crop box 200×400; a 40-wide, 10-tall glyph run with baseline at (20, 380).
    const r = textItemToNormalizedRect([1, 0, 0, 1, 20, 380], 40, 10, 200, 400);
    expect(r.x).toBeCloseTo(0.1, 6); // 20/200
    expect(r.width).toBeCloseTo(0.2, 6); // 40/200
    // top edge = f + h = 390 in y-up → 1 - 390/400 = 0.025
    expect(r.y).toBeCloseTo(0.025, 6);
    expect(r.height).toBeCloseTo(0.025, 6); // 10/400
  });

  it('falls back to the transform scale when height is 0', () => {
    const r = textItemToNormalizedRect([1, 0, 0, 12, 0, 0], 12, 0, 100, 100);
    expect(r.height).toBeCloseTo(0.12, 6); // sqrt(0^2 + 12^2)/100
  });

  it('returns a zero rect for a degenerate crop box', () => {
    expect(textItemToNormalizedRect([1, 0, 0, 1, 0, 0], 10, 10, 0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('clampNormalizedRect', () => {
  it('keeps a rect fully inside the unit box', () => {
    const r = clampNormalizedRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
    expect(r.x + r.width).toBeLessThanOrEqual(1);
    expect(r.y + r.height).toBeLessThanOrEqual(1);
  });

  it('clamps negatives to zero', () => {
    expect(clampNormalizedRect({ x: -0.2, y: -0.1, width: 0.3, height: 0.3 })).toEqual({
      x: 0, y: 0, width: 0.3, height: 0.3,
    });
  });
});

describe('normalizePageTextContent', () => {
  it('concatenates item strings and records char ranges + item indices', () => {
    const page = normalizePageTextContent(2, [
      item('Hello ', [1, 0, 0, 1, 0, 90], 30, 10),
      item('world', [1, 0, 0, 1, 30, 90], 25, 10, true),
    ], 100, 100);
    expect(page.pageIndex).toBe(2);
    expect(page.text).toBe('Hello world\n');
    expect(page.items[0]).toMatchObject({ itemIndex: 0, str: 'Hello ', charStart: 0, charEnd: 6 });
    expect(page.items[1]).toMatchObject({ itemIndex: 1, str: 'world', charStart: 6, charEnd: 11, hasEOL: true });
  });

  it('skips marked-content items but keeps their item index slot', () => {
    const page = normalizePageTextContent(0, [
      item('a', [1, 0, 0, 1, 0, 0], 5, 5),
      { type: 'beginMarkedContent' }, // no `str`
      item('b', [1, 0, 0, 1, 5, 0], 5, 5),
    ], 100, 100);
    expect(page.items.map((i) => i.itemIndex)).toEqual([0, 2]);
    expect(page.text).toBe('ab');
  });
});
