// pdf-comment-anchors tests (plan Part 1.9). Node-env vitest — the module is
// pure (no pdf.js/DOM), so we drive it with hand-built NormalizedPageText.
//
// Covers: capture (single/multi-page, prefix/suffix, rects, hashes, validates),
// coordinate-only notes, and the full reattach ladder — same-fingerprint trust,
// exact relocation, unique ±2 move, ambiguous NON-move, fuzzy needs-review, and
// orphaning — plus that stored geometry survives zoom/rotation via projection.
import { describe, expect, it } from 'vitest';
import {
  capturePdfAnchor,
  captureCoordinateOnlyAnchor,
  coordinateOnlyQuote,
  hashPageText,
  isCoordinateOnly,
  locateQuoteOnPage,
  reattachPdfAnchor,
  rectsForCharRange,
  type LiveDocument,
} from './pdf-comment-anchors';
import type { NormalizedPageText, NormalizedTextItem } from './pdf-text-geometry';
import {
  projectNormalizedPdfRect,
  validatePdfSelectionAnchor,
} from '../../../shared/pdf-annotations';

// Build a page whose text is a sequence of word items laid out top-to-bottom.
// Each word is one text item; the concatenated `text` has single spaces between.
function buildPage(pageIndex: number, words: string[]): NormalizedPageText {
  const items: NormalizedTextItem[] = [];
  let text = '';
  const n = words.length;
  words.forEach((w, i) => {
    const charStart = text.length;
    text += w;
    const charEnd = text.length;
    if (i < n - 1) text += ' ';
    items.push({
      itemIndex: i,
      str: w,
      charStart,
      charEnd,
      rect: { x: 0.1, y: i / n, width: Math.min(0.8, w.length * 0.05), height: 1 / n },
      dir: 'ltr',
      hasEOL: false,
    });
  });
  return { pageIndex, text, items };
}

// Build a page whose items are RUNS — the shape pdf.js actually emits.
//
// `buildPage` above gives every item exactly ONE word. That makes "select a
// word" indistinguishable from "select the whole item", so nothing built on it
// can express a sub-item selection and rect clipping is a no-op under it — the
// reason a 14-test suite stayed green while a 4-char selection painted a whole
// line. A real text item is a RUN of glyphs, commonly a whole line ("cial soil
// moisture"), and a selection routinely covers only part of one.
//
// Every run advances at a uniform CHAR_W per char from a shared left edge, so a
// clipped rect has an exact expected value rather than an approximate one.
const RUN_X = 0.1;
const CHAR_W = 0.02;

function buildRunPage(pageIndex: number, runs: string[], dir = 'ltr'): NormalizedPageText {
  const items: NormalizedTextItem[] = [];
  let text = '';
  const n = runs.length;
  runs.forEach((run, i) => {
    const charStart = text.length;
    text += run;
    const charEnd = text.length;
    if (i < n - 1) text += '\n';
    items.push({
      itemIndex: i,
      str: run,
      charStart,
      charEnd,
      rect: { x: RUN_X, y: i / n, width: run.length * CHAR_W, height: 1 / n },
      dir,
      hasEOL: true,
    });
  });
  return { pageIndex, text, items };
}

function liveDoc(pages: NormalizedPageText[], fingerprint: string, pageCount = pages.length): LiveDocument {
  const map = new Map(pages.map((p) => [p.pageIndex, p]));
  return { fingerprint, pageCount, getPageText: (i) => map.get(i) ?? null };
}

// Resolve an endpoint from (word index, offset-in-word) for readable tests.
function ep(pageIndex: number, itemIndex: number, charOffset: number) {
  return { pageIndex, itemIndex, charOffset };
}

describe('capture', () => {
  const page = buildPage(2, ['The', 'quick', 'brown', 'fox', 'jumps', 'over']);

  it('captures a single-page selection with quote, context, rects and hash', () => {
    // Select "quick brown fox": item1 start .. item3 end
    const { anchor, quote } = capturePdfAnchor({
      fingerprint: 'fp-A',
      start: ep(2, 1, 0),
      end: ep(2, 3, 3),
      pages: [page],
      pageLabels: [undefined, undefined, 'S3'],
    });
    expect(quote).toBe('quick brown fox');
    expect(anchor.pages).toHaveLength(1);
    expect(anchor.pages[0].pageIndex).toBe(2);
    expect(anchor.pages[0].pageLabel).toBe('S3');
    expect(anchor.prefix).toBe('The ');
    expect(anchor.suffix).toBe(' jumps over');
    // rects: one per contributing item (quick, brown, fox).
    expect(anchor.pages[0].rects).toHaveLength(3);
    expect(anchor.pageTextHashes?.[2]).toBe(hashPageText(page.text));
    expect(validatePdfSelectionAnchor(anchor).ok).toBe(true);
  });

  it('produces geometry that survives zoom + rotation via projection', () => {
    const { anchor } = capturePdfAnchor({
      fingerprint: 'fp-A',
      start: ep(2, 1, 0),
      end: ep(2, 1, 5),
      pages: [page],
    });
    const rect = anchor.pages[0].rects[0];
    // Same normalized rect projects consistently at two zooms (pure scale).
    const small = projectNormalizedPdfRect(rect, { width: 100, height: 200 }, 0);
    const big = projectNormalizedPdfRect(rect, { width: 200, height: 400 }, 0);
    expect(big.x).toBeCloseTo(small.x * 2);
    expect(big.width).toBeCloseTo(small.width * 2);
    // Rotation is applied only at projection; the stored rect is unchanged.
    const rotated = projectNormalizedPdfRect(rect, { width: 200, height: 100 }, 90);
    expect(rotated.width).toBeGreaterThan(0);
    expect(anchor.pages[0].rects[0]).toEqual(rect); // stored geometry untouched
  });

  it('captures a multi-page selection with ascending pages', () => {
    const p2 = buildPage(2, ['alpha', 'beta', 'gamma']);
    const p3 = buildPage(3, ['delta', 'epsilon', 'zeta']);
    const { anchor, quote } = capturePdfAnchor({
      fingerprint: 'fp-M',
      start: ep(2, 1, 0), // "beta"
      end: ep(3, 1, 7), // through "epsilon"
      pages: [p2, p3],
    });
    expect(anchor.pages.map((p) => p.pageIndex)).toEqual([2, 3]);
    expect(quote).toBe('beta gamma\ndelta epsilon');
    expect(validatePdfSelectionAnchor(anchor).ok).toBe(true);
  });
});

describe('coordinate-only notes', () => {
  it('captures a region note with a synthetic quote and no text endpoints', () => {
    const { anchor, quote } = captureCoordinateOnlyAnchor({
      fingerprint: 'fp-scan',
      pageIndex: 3,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
    });
    expect(quote).toBe('[Area on PDF page 4]');
    expect(isCoordinateOnly(anchor)).toBe(true);
    expect(validatePdfSelectionAnchor(anchor).ok).toBe(true);
  });

  it('includes a differing label in the synthetic quote', () => {
    expect(coordinateOnlyQuote(2, 'iii')).toBe('[Area on PDF page 3 (iii)]');
    expect(coordinateOnlyQuote(2, '3')).toBe('[Area on PDF page 3]');
  });

  it('reattaches a coordinate-only note by re-projecting stored rects', () => {
    const { anchor } = captureCoordinateOnlyAnchor({
      fingerprint: 'fp-scan',
      pageIndex: 3,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
    });
    const res = reattachPdfAnchor(anchor, '[Area on PDF page 4]', liveDoc([], 'fp-scan', 5));
    expect(res.status).toBe('coordinate-only');
    expect(res.pageIndex).toBe(3);
    expect(res.rects).toEqual(anchor.pages[0].rects);
  });
});

describe('reattach ladder', () => {
  const words = ['Lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur'];
  const capture = () =>
    capturePdfAnchor({
      fingerprint: 'fp-1',
      start: ep(1, 2, 0), // "dolor"
      end: ep(1, 4, 4), // through "amet"
      pages: [buildPage(1, words)],
    });

  it('same fingerprint → reopened, rects re-derived from the live match', () => {
    const { anchor, quote } = capture();
    const live = liveDoc([buildPage(1, words)], 'fp-1');
    const res = reattachPdfAnchor(anchor, quote, live);
    expect(res.status).toBe('reopened');
    expect(res.rects.length).toBeGreaterThan(0);
    expect(res.fuzzy).toBe(false);
  });

  it('fingerprint changed but quote intact on same page → exact', () => {
    const { anchor, quote } = capture();
    const live = liveDoc([buildPage(1, words)], 'fp-2-changed');
    const res = reattachPdfAnchor(anchor, quote, live);
    expect(res.status).toBe('exact');
    expect(res.pageIndex).toBe(1);
  });

  it('quote relocated to a UNIQUE nearby page → moved', () => {
    const { anchor, quote } = capture();
    // Original page 1 no longer holds the quote; page 2 (within ±2) does.
    const shifted = liveDoc(
      [buildPage(1, ['unrelated', 'text', 'here']), buildPage(2, words)],
      'fp-2-changed',
      3,
    );
    const res = reattachPdfAnchor(anchor, quote, shifted);
    expect(res.status).toBe('moved');
    expect(res.pageIndex).toBe(2);
  });

  it('ambiguous duplicate quote is NEVER silently moved', () => {
    const { anchor, quote } = capture();
    // Two identical "dolor sit amet" runs on a nearby page → ambiguous relocation.
    const dupWords = ['dolor', 'sit', 'amet', 'x', 'dolor', 'sit', 'amet'];
    const live = liveDoc(
      [buildPage(1, ['nothing', 'matching']), buildPage(2, dupWords)],
      'fp-2-changed',
      2,
    );
    const res = reattachPdfAnchor(anchor, quote, live);
    expect(res.status).not.toBe('moved');
    expect(['needs-review', 'orphaned']).toContain(res.status);
  });

  it('only a fuzzy prefix/suffix bridge → needs-review', () => {
    const { anchor } = capture();
    // Keep the context words but mutate the quote body so only the bridge matches.
    const fuzzyWords = ['Lorem', 'ipsum', 'REPLACED', 'amet', 'consectetur'];
    const live = liveDoc([buildPage(1, fuzzyWords)], 'fp-2-changed');
    const res = reattachPdfAnchor(anchor, 'dolor sit', live);
    expect(res.status).toBe('needs-review');
    expect(res.fuzzy).toBe(true);
  });

  it('no match anywhere → orphaned, stored rects kept as historical', () => {
    const { anchor, quote } = capture();
    const live = liveDoc([buildPage(1, ['completely', 'different', 'words'])], 'fp-2-changed');
    const res = reattachPdfAnchor(anchor, quote, live);
    expect(res.status).toBe('orphaned');
    expect(res.rects).toEqual(anchor.pages[0].rects);
  });
});

describe('rectsForCharRange', () => {
  it('returns only items overlapping the range', () => {
    const page = buildPage(0, ['aa', 'bb', 'cc', 'dd']);
    // "aa bb cc dd" → select chars covering bb..cc (indices 3..8).
    const rects = rectsForCharRange(page, 3, 8);
    expect(rects).toHaveLength(2);
  });

  it('locateQuoteOnPage flags a second occurrence as ambiguous', () => {
    const page = buildPage(0, ['cat', 'dog', 'cat', 'dog']);
    const m = locateQuoteOnPage(page, 'cat dog', '', '');
    expect(m?.ambiguous).toBe(true);
  });
});

describe('rectsForCharRange — sub-item (run) clipping', () => {
  // The reported bug: selecting "oil " — 4 chars inside the 18-char run "cial
  // soil moisture" — painted a highlight across the ENTIRE run. Measured live
  // before the fix: x=1420.6 w=424.5, i.e. exactly the run's own origin and
  // full width. These tests are stated in the run's coordinate space, so they
  // fail the moment an item's rect is pushed unclipped.
  const REAL_RUN = 'cial soil moisture'; // 18 chars, one pdf.js text item
  const RUN_W = REAL_RUN.length * CHAR_W; // 0.36

  it('clips a run to the selected chars instead of painting the whole run', () => {
    const page = buildRunPage(0, [REAL_RUN]);
    const rects = rectsForCharRange(page, 6, 10); // "oil "
    expect(rects).toHaveLength(1);
    // 6/18 of the way in, 4/18 wide — NOT the run's {x: 0.1, width: 0.36}.
    expect(rects[0].x).toBeCloseTo(0.22);
    expect(rects[0].width).toBeCloseTo(0.08);
    // The regression, stated directly: a 4-char paint is not a whole-run paint.
    expect(rects[0].width).toBeLessThan(RUN_W);
  });

  it('leaves a fully covered run at its exact stored geometry', () => {
    const page = buildRunPage(0, [REAL_RUN]);
    const rects = rectsForCharRange(page, 0, REAL_RUN.length);
    // Identity, not a re-interpolation: whole-run selections keep exact PDF
    // geometry, so only a partial first/last run is ever approximated.
    expect(rects[0]).toEqual({ x: RUN_X, y: 0, width: RUN_W, height: 1 });
  });

  it('clips only the first and last run of a multi-run selection', () => {
    // "alpha beta\ngamma delta\nepsilon zeta" — runs at 0..10, 11..22, 23..35.
    const page = buildRunPage(0, ['alpha beta', 'gamma delta', 'epsilon zeta']);
    const rects = rectsForCharRange(page, 6, 30); // "beta" .. "epsilon"
    expect(rects).toHaveLength(3);
    // First run: clipped from "beta" to its end.
    expect(rects[0].x).toBeCloseTo(0.22);
    expect(rects[0].width).toBeCloseTo(0.08);
    // Middle run: fully covered → untouched.
    expect(rects[1]).toEqual({ x: RUN_X, y: 1 / 3, width: 11 * CHAR_W, height: 1 / 3 });
    // Last run: clipped at "epsilon"'s end (7 of 12 chars).
    expect(rects[2].x).toBeCloseTo(RUN_X);
    expect(rects[2].width).toBeCloseTo(12 * CHAR_W * (7 / 12));
  });

  it('mirrors the clip for an rtl run (char 0 sits at the right edge)', () => {
    const page = buildRunPage(0, ['abcd'], 'rtl');
    const rects = rectsForCharRange(page, 0, 1); // leading char
    // Leading char of an rtl run paints at the run's RIGHT edge, not its left.
    expect(rects[0].x).toBeCloseTo(0.16);
    expect(rects[0].width).toBeCloseTo(0.02);
  });

  it('clips a ttb run along y, leaving x and width alone', () => {
    const page: NormalizedPageText = {
      pageIndex: 0,
      text: 'abcd',
      items: [{
        itemIndex: 0,
        str: 'abcd',
        charStart: 0,
        charEnd: 4,
        rect: { x: 0.1, y: 0.2, width: 0.05, height: 0.4 },
        dir: 'ttb',
        hasEOL: false,
      }],
    };
    const rects = rectsForCharRange(page, 0, 2); // top half of a vertical run
    expect(rects[0].y).toBeCloseTo(0.2);
    expect(rects[0].height).toBeCloseTo(0.2);
    expect(rects[0].x).toBeCloseTo(0.1);
    expect(rects[0].width).toBeCloseTo(0.05);
  });

  it('capturePdfAnchor stores a clipped rect for a sub-item selection', () => {
    // The path that actually paints: capture → anchor.rects → overlay layer.
    const page = buildRunPage(2, [REAL_RUN]);
    const { anchor, quote } = capturePdfAnchor({
      fingerprint: 'fp-run',
      start: ep(2, 0, 6),
      end: ep(2, 0, 10),
      pages: [page],
    });
    expect(quote).toBe('oil ');
    expect(anchor.pages[0].rects).toHaveLength(1);
    expect(anchor.pages[0].rects[0].x).toBeCloseTo(0.22);
    expect(anchor.pages[0].rects[0].width).toBeCloseTo(0.08);
    expect(validatePdfSelectionAnchor(anchor).ok).toBe(true);
  });
});
