// Turn persisted PDF comment rows into paintable, per-page geometry (Phase 3.4).
//
// This is the pure half of the reader's comment pipeline: it runs the Phase-1
// reattach ladder (`pdf-comment-anchors.reattachPdfAnchor`) over every stored row
// and reports (a) what to paint on which page and (b) whether the durable row
// should be rewritten. It performs NO IO — the caller (usePdfComments) warms the
// page text, then hands in a synchronous lookup — so the whole ladder-to-overlay
// path is unit-testable under node.
//
// Two rules from the plan carry through here:
//   • Scroll/zoom never mutate a stored anchor (plan §1.9). Re-derived rects on
//     the SAME fingerprint are display-only and are never written back.
//   • A degraded verdict is SURFACED, never silently applied to geometry: a
//     'needs-review' / 'orphaned' row flips status but keeps its stored rects as
//     the historical location.

import type { SelectionComment, SelectionCommentStatus } from '../../../shared/types';
import type { PdfRect, PdfSelectionAnchorV1 } from '../../../shared/pdf-annotations';
import { reattachPdfAnchor } from './pdf-comment-anchors';
import type { LiveDocument, ReattachStatus } from './pdf-comment-anchors';

/** How far the ladder may search for a relocated quote — mirrors the
 *  RELOCATE_RADIUS the anchor module walks, so we warm exactly what it reads. */
const RELOCATE_RADIUS = 2;

export interface PdfCommentPlacement {
  /** The persisted row — the AUTHORITY for send/resolve/delete (plan §1.8). */
  row: SelectionComment;
  /** A display copy whose anchor carries the reattached page + rects, so the
   *  read-only overlay (Part 2.4 / z2) paints live geometry without knowing the
   *  ladder exists. Never persisted unless `write` below says so. */
  display: SelectionComment;
  status: ReattachStatus;
  pageIndex: number;
  rects: PdfRect[];
}

/** A durable rewrite the ladder concluded is warranted. Empty for the common
 *  same-document reopen, so a plain open performs zero writes. */
export interface PdfCommentWrite {
  id: string;
  anchor: PdfSelectionAnchorV1;
  status: SelectionCommentStatus;
}

/** Rows in these states are mid-flight or closed; the ladder reports on them but
 *  must not rewrite them out from under the send machine / the user. */
const UNWRITABLE_STATUSES = new Set<SelectionCommentStatus>(['queued', 'sent', 'resolved']);

/** Only PDF-anchored rows participate; markdown rows are the gutter's business. */
export function isPdfCommentRow(row: SelectionComment): boolean {
  return row.anchorType === 'pdf' && row.pdfAnchor !== null;
}

/**
 * Which physical pages the ladder will read for these rows. The caller awaits
 * `getPageText` for exactly these before calling `placePdfComments`, so the
 * ladder's synchronous lookup never misses a page it needed (a miss would
 * silently degrade a good comment to 'orphaned').
 */
export function pagesToWarm(
  rows: readonly SelectionComment[],
  liveFingerprint: string,
  pageCount: number,
): number[] {
  const wanted = new Set<number>();
  for (const row of rows) {
    const anchor = row.pdfAnchor;
    if (!anchor) continue;
    for (const page of anchor.pages) {
      if (page.pageIndex >= 0 && page.pageIndex < pageCount) wanted.add(page.pageIndex);
    }
    // The ±2 relocation sweep only runs when the document actually changed.
    if (liveFingerprint && liveFingerprint !== anchor.fingerprint) {
      const primary = anchor.pages[0];
      if (!primary) continue;
      for (let d = 1; d <= RELOCATE_RADIUS; d++) {
        for (const cand of [primary.pageIndex - d, primary.pageIndex + d]) {
          if (cand >= 0 && cand < pageCount) wanted.add(cand);
        }
      }
    }
  }
  return [...wanted].sort((a, b) => a - b);
}

/** Build the display copy: the stored anchor repointed at the reattached page +
 *  live rects, leaving every other row field untouched. */
function displayCopy(
  row: SelectionComment,
  anchor: PdfSelectionAnchorV1,
  pageIndex: number,
  rects: PdfRect[],
  liveFingerprint: string,
): SelectionComment {
  const stored = anchor.pages.find((p) => p.pageIndex === pageIndex) ?? anchor.pages[0];
  const nextAnchor: PdfSelectionAnchorV1 = {
    ...anchor,
    fingerprint: liveFingerprint || anchor.fingerprint,
    pages: [{ ...stored, pageIndex, rects }],
  };
  return { ...row, pdfAnchor: nextAnchor };
}

export interface PlacementOutcome {
  placements: PdfCommentPlacement[];
  /** Durable rewrites to apply via `updatePdfAnchor`. Converges: after applying
   *  these, a second run over the same document yields an empty list. */
  writes: PdfCommentWrite[];
}

/**
 * Run the ladder over every PDF row against the live document.
 *
 * Write policy (kept narrow on purpose — an open must not thrash the DB):
 *   • same fingerprint ('reopened' / 'coordinate-only')  → never write;
 *   • fingerprint changed but the quote was found ('exact' / 'moved') → repoint
 *     the durable anchor onto the new fingerprint/page/rects, KEEPING the row's
 *     status (a sent comment stays sent, it just knows where it lives now);
 *   • 'needs-review' / 'orphaned' → flip status only, geometry untouched.
 */
export function placePdfComments(
  rows: readonly SelectionComment[],
  live: LiveDocument,
): PlacementOutcome {
  const placements: PdfCommentPlacement[] = [];
  const writes: PdfCommentWrite[] = [];

  for (const row of rows) {
    const anchor = row.pdfAnchor;
    if (!anchor || row.anchorType !== 'pdf') continue;

    const result = reattachPdfAnchor(anchor, row.quotedText, live);
    const { status, pageIndex, rects } = result;

    placements.push({
      row,
      display: displayCopy(row, anchor, pageIndex, rects, live.fingerprint),
      status,
      pageIndex,
      rects,
    });

    if (UNWRITABLE_STATUSES.has(row.status) && (status === 'needs-review' || status === 'orphaned')) {
      // Report it in the UI via the placement, but never restate a mid-flight
      // or resolved row's status.
      continue;
    }

    if (status === 'exact' || status === 'moved') {
      const repointed: PdfSelectionAnchorV1 = {
        ...anchor,
        fingerprint: live.fingerprint,
        pages: [
          {
            ...(anchor.pages.find((p) => p.pageIndex === result.pageIndex) ?? anchor.pages[0]),
            pageIndex,
            rects,
            ...(result.start ? { start: result.start } : {}),
            ...(result.end ? { end: result.end } : {}),
          },
        ],
      };
      if (!UNWRITABLE_STATUSES.has(row.status)) {
        writes.push({ id: row.id, anchor: repointed, status: row.status });
      }
    } else if (status === 'needs-review' && row.status !== 'needs-review') {
      writes.push({ id: row.id, anchor, status: 'needs-review' });
    } else if (status === 'orphaned' && row.status !== 'orphaned') {
      writes.push({ id: row.id, anchor, status: 'orphaned' });
    }
  }

  return { placements, writes };
}

/** Group display copies by the page they paint on — the shape PdfPageSlot's
 *  overlay consumes (`commentsByPage` in PdfRenderer). */
export function groupPlacementsByPage(
  placements: readonly PdfCommentPlacement[],
): Map<number, SelectionComment[]> {
  const byPage = new Map<number, SelectionComment[]>();
  for (const p of placements) {
    const list = byPage.get(p.pageIndex);
    if (list) list.push(p.display);
    else byPage.set(p.pageIndex, [p.display]);
  }
  return byPage;
}
