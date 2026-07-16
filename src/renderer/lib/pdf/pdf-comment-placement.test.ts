// Phase 3.4 — persisted rows → reattached, per-page paint geometry.
//
// These tests cover the policy that decides what the overlay paints AND what
// gets written back on open. The write policy matters as much as the geometry: a
// reader that rewrites rows on every open would thrash the DB and fight the send
// machine, and one that never writes would never record a reattach verdict.

import { describe, it, expect } from 'vitest';
import type { SelectionComment, SelectionCommentStatus } from '../../../shared/types';
import type { PdfSelectionAnchorV1 } from '../../../shared/pdf-annotations';
import { normalizePageTextContent } from './pdf-text-geometry';
import type { NormalizedPageText } from './pdf-text-geometry';
import type { LiveDocument } from './pdf-comment-anchors';
import { capturePdfAnchor, captureCoordinateOnlyAnchor } from './pdf-comment-anchors';
import {
  groupPlacementsByPage,
  isPdfCommentRow,
  pagesToWarm,
  placePdfComments,
} from './pdf-comment-placement';

const FP = 'fingerprint-original';

function page(pageIndex: number, strs: string[]): NormalizedPageText {
  return normalizePageTextContent(
    pageIndex,
    strs.map((str, i) => ({
      str,
      transform: [10, 0, 0, 10, 20, 700 - i * 14],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      hasEOL: true,
    })),
    612,
    792,
  );
}

function liveDoc(pages: NormalizedPageText[], fingerprint: string, pageCount = 10): LiveDocument {
  const byIndex = new Map(pages.map((p) => [p.pageIndex, p]));
  return { fingerprint, pageCount, getPageText: (i) => byIndex.get(i) ?? null };
}

function row(
  overrides: Partial<SelectionComment> & { pdfAnchor: PdfSelectionAnchorV1; quotedText: string },
): SelectionComment {
  return {
    id: 'c1',
    workspaceId: 'w1',
    filePath: '/docs/paper.pdf',
    kind: 'comment',
    quotedText: overrides.quotedText,
    body: 'a note',
    status: 'draft' as SelectionCommentStatus,
    createdAt: '2026-01-01T00:00:00Z',
    anchorType: 'pdf',
    ...overrides,
  } as SelectionComment;
}

/** Capture a real anchor over `pageText`, the way the reader does. */
function anchorOver(pageText: NormalizedPageText, itemIndex: number, from: number, to: number) {
  return capturePdfAnchor({
    fingerprint: FP,
    start: { pageIndex: pageText.pageIndex, itemIndex, charOffset: from },
    end: { pageIndex: pageText.pageIndex, itemIndex, charOffset: to },
    pages: [pageText],
  });
}

describe('isPdfCommentRow', () => {
  it('keeps only PDF-anchored rows — markdown rows stay the gutter’s business', () => {
    const p = page(0, ['hello world']);
    const { anchor } = anchorOver(p, 0, 0, 5);
    expect(isPdfCommentRow(row({ pdfAnchor: anchor, quotedText: 'hello' }))).toBe(true);
    expect(
      isPdfCommentRow(row({ pdfAnchor: anchor, quotedText: 'x', anchorType: 'text' })),
    ).toBe(false);
    expect(
      isPdfCommentRow(row({ pdfAnchor: null as never, quotedText: 'x' })),
    ).toBe(false);
  });
});

describe('pagesToWarm', () => {
  it('warms only the anchored pages when the document is unchanged', () => {
    const p = page(5, ['alpha beta']);
    const { anchor } = anchorOver(p, 0, 0, 5);
    expect(pagesToWarm([row({ pdfAnchor: anchor, quotedText: 'alpha' })], FP, 10)).toEqual([5]);
  });

  it('warms the ±2 relocation sweep when the fingerprint changed', () => {
    const p = page(5, ['alpha beta']);
    const { anchor } = anchorOver(p, 0, 0, 5);
    expect(pagesToWarm([row({ pdfAnchor: anchor, quotedText: 'alpha' })], 'other-fp', 10)).toEqual([
      3, 4, 5, 6, 7,
    ]);
  });

  it('never warms a page outside the document', () => {
    const p = page(0, ['alpha beta']);
    const { anchor } = anchorOver(p, 0, 0, 5);
    expect(pagesToWarm([row({ pdfAnchor: anchor, quotedText: 'alpha' })], 'other-fp', 2)).toEqual([
      0, 1,
    ]);
  });
});

describe('placePdfComments — reopen on the same document', () => {
  it('reattaches with live rects and writes NOTHING', () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 0, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote });

    const { placements, writes } = placePdfComments([r], liveDoc([p], FP));
    expect(placements).toHaveLength(1);
    expect(placements[0].status).toBe('reopened');
    expect(placements[0].pageIndex).toBe(3);
    expect(placements[0].rects.length).toBeGreaterThan(0);
    // A plain open must be read-only (plan §1.9: zoom/scroll never mutate anchors).
    expect(writes).toEqual([]);
  });

  it('exposes the display copy repointed at the live page, leaving the row intact', () => {
    const p = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(p, 0, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote });

    const { placements } = placePdfComments([r], liveDoc([p], FP));
    expect(placements[0].display.pdfAnchor!.pages).toHaveLength(1);
    expect(placements[0].display.pdfAnchor!.pages[0].pageIndex).toBe(3);
    // The row object handed to send/resolve/delete is untouched.
    expect(placements[0].row).toBe(r);
  });
});

describe('placePdfComments — the fingerprint-mismatch ladder', () => {
  it('“exact”: same page, quote still there → repoints onto the new fingerprint', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote });

    // Same text, new fingerprint (document re-saved).
    const { placements, writes } = placePdfComments([r], liveDoc([original], 'fp-v2'));
    expect(placements[0].status).toBe('exact');
    expect(writes).toHaveLength(1);
    expect(writes[0].anchor.fingerprint).toBe('fp-v2');
    expect(writes[0].status).toBe('draft'); // status preserved, only geometry repointed
  });

  it('“moved”: relocates to a unique match within ±2 pages', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote });

    // The content shifted to page 4; page 3 now holds something else.
    const live = liveDoc([page(3, ['unrelated preamble']), page(4, ['The quick brown fox jumps'])], 'fp-v2');
    const { placements, writes } = placePdfComments([r], live);
    expect(placements[0].status).toBe('moved');
    expect(placements[0].pageIndex).toBe(4);
    expect(writes[0].anchor.pages[0].pageIndex).toBe(4);
  });

  it('“orphaned”: no match anywhere → flips status, KEEPS the stored rects', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote });

    const live = liveDoc([page(3, ['entirely different content now'])], 'fp-v2');
    const { placements, writes } = placePdfComments([r], live);
    expect(placements[0].status).toBe('orphaned');
    // Historical location preserved rather than a guess (plan §1.9).
    expect(placements[0].rects).toEqual(anchor.pages[0].rects);
    expect(writes).toEqual([{ id: 'c1', anchor, status: 'orphaned' }]);
  });

  it('an already-orphaned row is not rewritten — the ladder converges', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const r = row({ pdfAnchor: anchor, quotedText: quote, status: 'orphaned' });

    const live = liveDoc([page(3, ['entirely different content now'])], 'fp-v2');
    const { writes } = placePdfComments([r], live);
    expect(writes).toEqual([]);
  });

  it('a repointed row settles: re-running against the new document writes nothing', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const first = placePdfComments([row({ pdfAnchor: anchor, quotedText: quote })], liveDoc([original], 'fp-v2'));
    expect(first.writes).toHaveLength(1);

    // Apply the write, then reopen the same (now-current) document.
    const applied = row({ pdfAnchor: first.writes[0].anchor, quotedText: quote, status: first.writes[0].status });
    const second = placePdfComments([applied], liveDoc([original], 'fp-v2'));
    expect(second.placements[0].status).toBe('reopened');
    expect(second.writes).toEqual([]);
  });
});

describe('placePdfComments — mid-flight and closed rows', () => {
  it('never restates a queued/sent/resolved row’s status on a degraded verdict', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const live = liveDoc([page(3, ['entirely different content now'])], 'fp-v2');

    for (const status of ['queued', 'sent', 'resolved'] as SelectionCommentStatus[]) {
      const { placements, writes } = placePdfComments(
        [row({ pdfAnchor: anchor, quotedText: quote, status })],
        live,
      );
      // The verdict is still SURFACED to the UI…
      expect(placements[0].status).toBe('orphaned');
      // …but the durable row is left alone.
      expect(writes).toEqual([]);
    }
  });

  it('does not repoint a sent row’s anchor either', () => {
    const original = page(3, ['The quick brown fox jumps']);
    const { anchor, quote } = anchorOver(original, 0, 4, 15);
    const { placements, writes } = placePdfComments(
      [row({ pdfAnchor: anchor, quotedText: quote, status: 'sent' })],
      liveDoc([original], 'fp-v2'),
    );
    expect(placements[0].status).toBe('exact');
    expect(writes).toEqual([]);
  });
});

describe('placePdfComments — coordinate-only region notes', () => {
  it('re-projects stored rects on a page with no text, and never writes', () => {
    const captured = captureCoordinateOnlyAnchor({
      fingerprint: FP,
      pageIndex: 2,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.25 }],
      pageLabel: 'ii',
    });
    const r = row({ pdfAnchor: captured.anchor, quotedText: captured.quote });

    // A scanned page: the live lookup has no text for page 2 at all.
    const { placements, writes } = placePdfComments([r], liveDoc([], FP));
    expect(placements[0].status).toBe('coordinate-only');
    expect(placements[0].pageIndex).toBe(2);
    // Stored rects survive the re-projection intact. The origin is exact —
    // clamp01 passes an in-range value straight through — while width/height go
    // through clampNormalizedRect's `clamp01(w + x) - x` round-trip and can land
    // 1 ULP off (0.3 -> 0.30000000000000004). That is a fixed point, not a drift:
    // re-clamping never moves it again, and a coordinate-only row is never
    // written back, so the stored value cannot accumulate error across reopens.
    // Asserted to 1e-15 — tight enough to catch a real regression, loose enough
    // to survive an exact-arithmetic refactor of the clamp.
    expect(placements[0].rects).toHaveLength(1);
    expect(placements[0].rects[0].x).toBe(0.1);
    expect(placements[0].rects[0].y).toBe(0.2);
    expect(placements[0].rects[0].width).toBeCloseTo(0.3, 15);
    expect(placements[0].rects[0].height).toBeCloseTo(0.25, 15);
    expect(writes).toEqual([]);
  });

  it('stays coordinate-only even when the document changed — there is nothing to match', () => {
    const captured = captureCoordinateOnlyAnchor({
      fingerprint: FP,
      pageIndex: 2,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.25 }],
    });
    const r = row({ pdfAnchor: captured.anchor, quotedText: captured.quote });
    const { placements, writes } = placePdfComments([r], liveDoc([], 'fp-v2'));
    expect(placements[0].status).toBe('coordinate-only');
    expect(writes).toEqual([]);
  });
});

describe('groupPlacementsByPage', () => {
  it('slices display copies onto the page they paint on', () => {
    const p3 = page(3, ['The quick brown fox jumps']);
    const p6 = page(6, ['Another line entirely here']);
    const a = anchorOver(p3, 0, 4, 15);
    const b = anchorOver(p6, 0, 0, 7);

    const { placements } = placePdfComments(
      [
        row({ id: 'c1', pdfAnchor: a.anchor, quotedText: a.quote }),
        row({ id: 'c2', pdfAnchor: b.anchor, quotedText: b.quote }),
      ],
      liveDoc([p3, p6], FP),
    );
    const byPage = groupPlacementsByPage(placements);
    expect([...byPage.keys()].sort((x, y) => x - y)).toEqual([3, 6]);
    expect(byPage.get(3)!.map((c) => c.id)).toEqual(['c1']);
    expect(byPage.get(6)!.map((c) => c.id)).toEqual(['c2']);
  });

  it('groups several comments on one page together', () => {
    const p = page(1, ['alpha beta gamma delta epsilon']);
    const a = anchorOver(p, 0, 0, 5);
    const b = anchorOver(p, 0, 12, 17);
    const { placements } = placePdfComments(
      [
        row({ id: 'c1', pdfAnchor: a.anchor, quotedText: a.quote }),
        row({ id: 'c2', pdfAnchor: b.anchor, quotedText: b.quote }),
      ],
      liveDoc([p], FP),
    );
    expect(groupPlacementsByPage(placements).get(1)).toHaveLength(2);
  });

  it('is empty for no placements', () => {
    expect(groupPlacementsByPage([]).size).toBe(0);
  });
});
