// PDF selection adapter for the z1 text layer (plan Part 2.4 / Phase 3.1).
//
// This is the PDF-SPECIFIC replacement for markdown's SelectionSurface document-
// range path. A browser Selection over the transparent text layer lands in DOM
// text nodes that have no idea what a PDF page or text item is; this module maps
// those DOM endpoints back onto the {pageIndex, itemIndex, charOffset} model that
// `pdf-comment-anchors.capturePdfAnchor` consumes.
//
// Why not reuse SelectionSurface (plan Part 2.4): markdown resolves a selection
// against ONE linear source string. A PDF selection resolves against per-page
// item geometry, may cross virtualized page boundaries (where the intervening
// pages are not even mounted), and its Ranges are invalidated by every zoom
// re-render. The bridge is the two data attributes the text layer stamps on each
// span — they are the ONLY contract between the DOM and the anchor model.
//
// Everything here is pure w.r.t. app state (it reads DOM nodes but mutates
// nothing), so it is unit-tested directly under jsdom.

import type { PdfRect, ViewerPageBox } from '../../../shared/pdf-annotations';
import {
  MAX_PDF_ANCHOR_PAGES,
  normalizeRotation,
  rotateNormalizedPdfRect,
} from '../../../shared/pdf-annotations';
import { clampNormalizedRect } from './pdf-text-geometry';
import type { NormalizedPageText } from './pdf-text-geometry';
import { capturePdfAnchor } from './pdf-comment-anchors';
import type { CapturedPdfSelection, PdfSelectionEndpoint } from './pdf-comment-anchors';

/** Stamped by PdfTextLayer on every item span — the DOM↔anchor contract. */
export const PDF_PAGE_ATTR = 'data-pdf-page-index';
export const PDF_ITEM_ATTR = 'data-pdf-item-index';

const TEXT_NODE = 3;

/** The nearest ancestor span that carries the page/item stamps. */
function itemElementFor(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const start: Element | null =
    node.nodeType === TEXT_NODE ? node.parentElement : (node as Element);
  if (!start || typeof start.closest !== 'function') return null;
  return start.closest<HTMLElement>(`[${PDF_ITEM_ATTR}][${PDF_PAGE_ATTR}]`);
}

function intAttr(el: HTMLElement, attr: string): number | null {
  const raw = el.getAttribute(attr);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Resolve one DOM (node, offset) endpoint onto the PDF text model.
 *
 * `offset` semantics follow the DOM: inside a text node it is a char offset;
 * on an element it is a CHILD index, which we collapse to "start of item" (0)
 * or "end of item" (the item's full length) — the only two positions an element-
 * level offset can mean for a span holding a single text node.
 */
export function resolvePdfEndpoint(node: Node | null, offset: number): PdfSelectionEndpoint | null {
  const el = itemElementFor(node);
  if (!el) return null;
  const pageIndex = intAttr(el, PDF_PAGE_ATTR);
  const itemIndex = intAttr(el, PDF_ITEM_ATTR);
  if (pageIndex === null || itemIndex === null) return null;

  const len = (el.textContent ?? '').length;
  let charOffset: number;
  if (node && node.nodeType === TEXT_NODE) {
    charOffset = Math.max(0, Math.min(offset, len));
  } else {
    // Element-level offset: 0 ⇒ before the text, anything else ⇒ after it.
    charOffset = offset <= 0 ? 0 : len;
  }
  return { pageIndex, itemIndex, charOffset };
}

/** Document order comparison for two resolved endpoints. */
export function compareEndpoints(a: PdfSelectionEndpoint, b: PdfSelectionEndpoint): number {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
  return a.charOffset - b.charOffset;
}

export interface ResolvedPdfSelection {
  start: PdfSelectionEndpoint;
  end: PdfSelectionEndpoint;
  /** Every physical page the selection spans, ascending and contiguous — the
   *  shape `capturePdfAnchor` requires for its page walk. */
  pageIndices: number[];
}

/**
 * Resolve a DOM Range over the text layer into ordered PDF endpoints.
 *
 * Returns null when either endpoint falls outside the text layer (e.g. the user
 * dragged onto the toolbar) or when the range is collapsed — a caret is not a
 * selection and must never produce an anchor.
 */
export function resolvePdfSelectionRange(range: Range | null): ResolvedPdfSelection | null {
  if (!range || range.collapsed) return null;
  const a = resolvePdfEndpoint(range.startContainer, range.startOffset);
  const b = resolvePdfEndpoint(range.endContainer, range.endOffset);
  if (!a || !b) return null;

  // A Range is already in document order, but the text layer paints items in
  // PDF content order (which is document order here) — still, normalize rather
  // than trust, since a caller may hand us endpoints from a backwards selection.
  const [start, end] = compareEndpoints(a, b) <= 0 ? [a, b] : [b, a];
  if (compareEndpoints(start, end) === 0) return null;

  const pageIndices: number[] = [];
  for (let p = start.pageIndex; p <= end.pageIndex; p++) pageIndices.push(p);
  return { start, end, pageIndices };
}

/** Resolve the window's current selection. Convenience wrapper used by the
 *  reader's `selectionchange` / mouseup handler. */
export function resolveCurrentPdfSelection(sel: Selection | null): ResolvedPdfSelection | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  return resolvePdfSelectionRange(sel.getRangeAt(0));
}

// ── Coordinate-only geometry (region notes on scanned/image pages) ────────────

/**
 * Inverse of `rotateNormalizedPdfRect`: map a rect expressed in the ROTATED
 * page's normalized space back into the stored unrotated crop-box space. A
 * quarter-turn's inverse is its complement, so this is the same table run
 * backwards rather than a second hand-derived one.
 */
export function unrotateNormalizedPdfRect(rect: PdfRect, rotation: number): PdfRect {
  return rotateNormalizedPdfRect(rect, (360 - normalizeRotation(rotation)) % 360);
}

/**
 * Inverse of `projectNormalizedPdfRect`: turn a pixel rectangle the user dragged
 * on the overlay into the durable normalized, UNROTATED-crop-box rect the anchor
 * contract stores. Round-trips with `projectNormalizedPdfRect` for all four
 * rotations, which is what keeps a region note pinned across zoom and rotate.
 */
export function unprojectPxRect(
  px: { x: number; y: number; width: number; height: number },
  box: ViewerPageBox,
  rotation: number,
): PdfRect {
  if (!(box.width > 0) || !(box.height > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const ox = box.x ?? 0;
  const oy = box.y ?? 0;
  const rotated: PdfRect = {
    x: (px.x - ox) / box.width,
    y: (px.y - oy) / box.height,
    width: px.width / box.width,
    height: px.height / box.height,
  };
  return clampNormalizedRect(unrotateNormalizedPdfRect(rotated, rotation));
}

/** Normalize a drag (two arbitrary corners) into a positive-extent px rect. */
export function rectFromDragPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** A drag smaller than this (CSS px, either axis) is a stray click, not a region. */
export const MIN_REGION_DRAG_PX = 6;

export function isMeaningfulRegionDrag(px: { width: number; height: number }): boolean {
  return px.width >= MIN_REGION_DRAG_PX && px.height >= MIN_REGION_DRAG_PX;
}

// ── Selection → durable anchor ───────────────────────────────────────────────

/** The page-text source, injected rather than imported, so this module never
 *  pulls in the pdf.js runtime and stays unit-testable. Matches
 *  `PdfTextModel.getPageText`. */
export type PageTextFetcher = (pageIndex: number) => Promise<NormalizedPageText>;

/**
 * Build the durable anchor + quote for a resolved text selection.
 *
 * NOTE the quote: it comes from `capturePdfAnchor`'s walk over the NORMALIZED
 * page text, NOT from `Selection.toString()`. The reattach ladder matches the
 * stored `quotedText` against that same normalized page text, so storing the DOM
 * string instead would make a comment fail to reattach on its own document. The
 * DOM string is fine for previewing in the composer — never for persistence.
 *
 * Returns null when the selection spans more pages than the anchor contract
 * allows, or when no page text could be read (nothing to anchor to).
 */
export async function buildPdfSelectionCapture(
  resolved: ResolvedPdfSelection,
  getPageText: PageTextFetcher,
  fingerprint: string,
  pageLabels?: readonly (string | null | undefined)[] | null,
): Promise<CapturedPdfSelection | null> {
  if (resolved.pageIndices.length > MAX_PDF_ANCHOR_PAGES) return null;

  const pages: NormalizedPageText[] = [];
  for (const pageIndex of resolved.pageIndices) {
    try {
      pages.push(await getPageText(pageIndex));
    } catch {
      // A page we cannot read leaves a hole; capture walks what it has.
    }
  }
  if (pages.length === 0) return null;

  const captured = capturePdfAnchor({
    fingerprint,
    start: resolved.start,
    end: resolved.end,
    pages,
    pageLabels,
  });
  if (!captured.quote.trim()) return null; // nothing selectable was captured
  return captured;
}
