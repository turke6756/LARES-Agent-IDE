// @vitest-environment jsdom
//
// Phase 3.1 — the z1 selection adapter: DOM Range → PDF anchor endpoints, and
// the inverse projection that keeps coordinate-only region notes pinned.
// Needs jsdom: the adapter's whole job is resolving real DOM Ranges.

import { describe, it, expect } from 'vitest';
import { projectNormalizedPdfRect } from '../../../shared/pdf-annotations';
import type { PdfRect } from '../../../shared/pdf-annotations';
import {
  buildPdfSelectionCapture,
  compareEndpoints,
  isMeaningfulRegionDrag,
  PDF_ITEM_ATTR,
  PDF_PAGE_ATTR,
  rectFromDragPoints,
  resolvePdfEndpoint,
  resolvePdfSelectionRange,
  unprojectPxRect,
  unrotateNormalizedPdfRect,
} from './pdf-selection-capture';
import { normalizePageTextContent } from './pdf-text-geometry';
import type { NormalizedPageText } from './pdf-text-geometry';

// ── A minimal stand-in for the rendered text layer ───────────────────────────

/** Build spans carrying the same two stamps PdfTextLayer emits. */
function mountTextLayer(pageIndex: number, items: { itemIndex: number; str: string }[]): HTMLElement {
  const host = document.createElement('div');
  for (const it of items) {
    const span = document.createElement('span');
    span.setAttribute(PDF_PAGE_ATTR, String(pageIndex));
    span.setAttribute(PDF_ITEM_ATTR, String(it.itemIndex));
    span.textContent = it.str;
    host.appendChild(span);
  }
  document.body.appendChild(host);
  return host;
}

function rangeOver(
  startSpan: Element,
  startOffset: number,
  endSpan: Element,
  endOffset: number,
): Range {
  const range = document.createRange();
  range.setStart(startSpan.firstChild!, startOffset);
  range.setEnd(endSpan.firstChild!, endOffset);
  return range;
}

describe('resolvePdfEndpoint', () => {
  it('maps a text node offset onto {page, item, charOffset}', () => {
    const host = mountTextLayer(4, [{ itemIndex: 7, str: 'Hello world' }]);
    const span = host.querySelector('span')!;
    expect(resolvePdfEndpoint(span.firstChild, 6)).toEqual({
      pageIndex: 4,
      itemIndex: 7,
      charOffset: 6,
    });
  });

  it('clamps an offset past the item text', () => {
    const host = mountTextLayer(0, [{ itemIndex: 1, str: 'abc' }]);
    const span = host.querySelector('span')!;
    expect(resolvePdfEndpoint(span.firstChild, 99)?.charOffset).toBe(3);
  });

  it('collapses an element-level offset to the item start or end', () => {
    const host = mountTextLayer(0, [{ itemIndex: 2, str: 'abcd' }]);
    const span = host.querySelector('span')!;
    expect(resolvePdfEndpoint(span, 0)?.charOffset).toBe(0);
    expect(resolvePdfEndpoint(span, 1)?.charOffset).toBe(4);
  });

  it('returns null outside the text layer — a selection on chrome is not an anchor', () => {
    const stray = document.createElement('div');
    stray.textContent = 'toolbar';
    document.body.appendChild(stray);
    expect(resolvePdfEndpoint(stray.firstChild, 1)).toBeNull();
    expect(resolvePdfEndpoint(null, 0)).toBeNull();
  });
});

describe('compareEndpoints', () => {
  it('orders by page, then item, then char', () => {
    const a = { pageIndex: 1, itemIndex: 0, charOffset: 5 };
    expect(compareEndpoints(a, { pageIndex: 2, itemIndex: 0, charOffset: 0 })).toBeLessThan(0);
    expect(compareEndpoints(a, { pageIndex: 1, itemIndex: 1, charOffset: 0 })).toBeLessThan(0);
    expect(compareEndpoints(a, { pageIndex: 1, itemIndex: 0, charOffset: 9 })).toBeLessThan(0);
    expect(compareEndpoints(a, { ...a })).toBe(0);
  });
});

describe('resolvePdfSelectionRange', () => {
  it('resolves a single-page selection and lists the one page', () => {
    const host = mountTextLayer(2, [
      { itemIndex: 0, str: 'The quick ' },
      { itemIndex: 1, str: 'brown fox' },
    ]);
    const spans = host.querySelectorAll('span');
    const resolved = resolvePdfSelectionRange(rangeOver(spans[0], 4, spans[1], 5));
    expect(resolved).not.toBeNull();
    expect(resolved!.start).toEqual({ pageIndex: 2, itemIndex: 0, charOffset: 4 });
    expect(resolved!.end).toEqual({ pageIndex: 2, itemIndex: 1, charOffset: 5 });
    expect(resolved!.pageIndices).toEqual([2]);
  });

  it('enumerates every page a cross-page selection spans, contiguously', () => {
    const p3 = mountTextLayer(3, [{ itemIndex: 0, str: 'end of three' }]);
    const p5 = mountTextLayer(5, [{ itemIndex: 0, str: 'start of five' }]);
    const resolved = resolvePdfSelectionRange(
      rangeOver(p3.querySelector('span')!, 0, p5.querySelector('span')!, 5),
    );
    // 4 is included even though it was virtualized out of the DOM — capture must
    // walk the whole physical span, not just the mounted pages.
    expect(resolved!.pageIndices).toEqual([3, 4, 5]);
  });

  it('rejects a collapsed range — a caret is not a selection', () => {
    const host = mountTextLayer(0, [{ itemIndex: 0, str: 'abc' }]);
    const span = host.querySelector('span')!;
    expect(resolvePdfSelectionRange(rangeOver(span, 1, span, 1))).toBeNull();
    expect(resolvePdfSelectionRange(null)).toBeNull();
  });

  it('rejects a range whose endpoint escapes the text layer', () => {
    const host = mountTextLayer(0, [{ itemIndex: 0, str: 'abc' }]);
    const outside = document.createElement('div');
    outside.textContent = 'xyz';
    document.body.appendChild(outside);
    const range = document.createRange();
    range.setStart(host.querySelector('span')!.firstChild!, 0);
    range.setEnd(outside.firstChild!, 2);
    expect(resolvePdfSelectionRange(range)).toBeNull();
  });
});

// ── Coordinate-only geometry ─────────────────────────────────────────────────

describe('unprojectPxRect / unrotateNormalizedPdfRect', () => {
  const box = { width: 800, height: 1000 };
  const rect: PdfRect = { x: 0.2, y: 0.3, width: 0.25, height: 0.1 };

  for (const rotation of [0, 90, 180, 270]) {
    it(`round-trips project → unproject at rotation ${rotation}`, () => {
      const px = projectNormalizedPdfRect(rect, box, rotation);
      const back = unprojectPxRect(px, box, rotation);
      expect(back.x).toBeCloseTo(rect.x, 6);
      expect(back.y).toBeCloseTo(rect.y, 6);
      expect(back.width).toBeCloseTo(rect.width, 6);
      expect(back.height).toBeCloseTo(rect.height, 6);
    });
  }

  it('unrotate is the inverse of rotate for all four quarter-turns', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const round = unrotateNormalizedPdfRect(
        // rotate then unrotate
        { ...projectNormalizedPdfRect(rect, { width: 1, height: 1 }, rotation) },
        rotation,
      );
      expect(round.x).toBeCloseTo(rect.x, 6);
      expect(round.y).toBeCloseTo(rect.y, 6);
    }
  });

  it('degenerate boxes never produce NaN geometry', () => {
    const out = unprojectPxRect({ x: 5, y: 5, width: 10, height: 10 }, { width: 0, height: 0 }, 0);
    expect(out).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('honors the page box offset', () => {
    const px = projectNormalizedPdfRect(rect, { ...box, x: 40, y: 12 }, 0);
    const back = unprojectPxRect(px, { ...box, x: 40, y: 12 }, 0);
    expect(back.x).toBeCloseTo(rect.x, 6);
    expect(back.y).toBeCloseTo(rect.y, 6);
  });
});

describe('region drag helpers', () => {
  it('normalizes a drag made in any direction into a positive rect', () => {
    expect(rectFromDragPoints({ x: 90, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10, y: 20, width: 80, height: 60,
    });
  });

  it('rejects a stray click but accepts a real box', () => {
    expect(isMeaningfulRegionDrag({ width: 2, height: 40 })).toBe(false);
    expect(isMeaningfulRegionDrag({ width: 40, height: 2 })).toBe(false);
    expect(isMeaningfulRegionDrag({ width: 40, height: 40 })).toBe(true);
  });
});

// ── Selection → durable anchor ───────────────────────────────────────────────

function pageOf(pageIndex: number, strs: string[]): NormalizedPageText {
  return normalizePageTextContent(
    pageIndex,
    strs.map((str, i) => ({
      str,
      transform: [10, 0, 0, 10, i * 20, 700 - i * 12],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      hasEOL: false,
    })),
    612,
    792,
  );
}

describe('buildPdfSelectionCapture', () => {
  const fingerprint = 'fp-abc';

  it('persists the quote from NORMALIZED page text, not the DOM string', async () => {
    const page = pageOf(1, ['The quick ', 'brown fox']);
    const captured = await buildPdfSelectionCapture(
      {
        start: { pageIndex: 1, itemIndex: 0, charOffset: 4 },
        end: { pageIndex: 1, itemIndex: 1, charOffset: 5 },
        pageIndices: [1],
      },
      async () => page,
      fingerprint,
    );
    // The reattach ladder matches this string against page text — so it must be
    // the page-text slice ('quick brown'), never Selection.toString().
    expect(captured!.quote).toBe('quick brown');
    expect(captured!.anchor.fingerprint).toBe(fingerprint);
    expect(captured!.anchor.pages[0].pageIndex).toBe(1);
    expect(captured!.anchor.pages[0].rects.length).toBeGreaterThan(0);
  });

  it('attaches page labels when the document supplies them', async () => {
    const page = pageOf(2, ['Chapter text here']);
    const captured = await buildPdfSelectionCapture(
      {
        start: { pageIndex: 2, itemIndex: 0, charOffset: 0 },
        end: { pageIndex: 2, itemIndex: 0, charOffset: 7 },
        pageIndices: [2],
      },
      async () => page,
      fingerprint,
      [null, null, 'iii'],
    );
    expect(captured!.anchor.pages[0].pageLabel).toBe('iii');
  });

  it('returns null when no page text can be read', async () => {
    const captured = await buildPdfSelectionCapture(
      {
        start: { pageIndex: 0, itemIndex: 0, charOffset: 0 },
        end: { pageIndex: 0, itemIndex: 0, charOffset: 3 },
        pageIndices: [0],
      },
      async () => { throw new Error('scanned page, no text'); },
      fingerprint,
    );
    expect(captured).toBeNull();
  });

  it('returns null for a whitespace-only capture', async () => {
    const page = pageOf(0, ['   ']);
    const captured = await buildPdfSelectionCapture(
      {
        start: { pageIndex: 0, itemIndex: 0, charOffset: 0 },
        end: { pageIndex: 0, itemIndex: 0, charOffset: 3 },
        pageIndices: [0],
      },
      async () => page,
      fingerprint,
    );
    expect(captured).toBeNull();
  });

  it('refuses a selection spanning more pages than the anchor contract allows', async () => {
    const captured = await buildPdfSelectionCapture(
      {
        start: { pageIndex: 0, itemIndex: 0, charOffset: 0 },
        end: { pageIndex: 40, itemIndex: 0, charOffset: 1 },
        pageIndices: Array.from({ length: 41 }, (_, i) => i),
      },
      async (i) => pageOf(i, ['text']),
      fingerprint,
    );
    expect(captured).toBeNull();
  });
});
