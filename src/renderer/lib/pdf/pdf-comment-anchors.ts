// PDF comment anchor capture + reattachment (plan Part 1.9).
//
// PDF gets its OWN adapter rather than forcing the markdown document-range code
// (`selection/comment-anchors.ts`) to grow page geometry. But it REUSES that
// module's whitespace-tolerant matching primitive (`findBestMatch`) so the two
// systems agree on what "the same quote" means — we do not fork the matcher.
//
// Everything here is PURE: it consumes already-resolved text endpoints plus the
// paint-disabled page-text model (`pdf-text-geometry`), and produces / relocates
// the durable `PdfSelectionAnchorV1` contract (`shared/pdf-annotations`). No DOM,
// no pdf.js runtime, no Electron — so it is unit-tested directly under node.
//
// Two invariants from the plan:
//   • Scroll/zoom NEVER mutate a stored anchor — only projection into the current
//     viewer rectangle changes (that is `projectNormalizedPdfRect`, elsewhere).
//   • Reattach NEVER silently moves a comment to an ambiguous match. The ladder
//     degrades to `needs-review` or `orphaned` rather than guess.

import type {
  PdfPageAnchor,
  PdfRect,
  PdfSelectionAnchorV1,
  PdfTextPosition,
} from '../../../shared/pdf-annotations';
import { clampNormalizedRect } from './pdf-text-geometry';
import type { NormalizedPageText, NormalizedTextItem } from './pdf-text-geometry';
import { ANCHOR_CONTEXT_CHARS, findBestMatch } from '../selection/comment-anchors';

// ── Endpoints (input to capture) ─────────────────────────────────────────────

/** A selection endpoint resolved off the text layer: which page, which text
 *  item, and the char offset INTO that item's own string. */
export interface PdfSelectionEndpoint {
  pageIndex: number;
  itemIndex: number;
  /** Offset within the item's `str` (0..str.length). */
  charOffset: number;
}

export interface CapturePdfAnchorParams {
  fingerprint: string;
  start: PdfSelectionEndpoint;
  end: PdfSelectionEndpoint;
  /** Normalized text for EVERY physical page the selection touches, ascending
   *  and contiguous from `start.pageIndex` to `end.pageIndex`. */
  pages: NormalizedPageText[];
  /** Descriptive labels indexed by physical page (optional). */
  pageLabels?: readonly (string | null | undefined)[] | null;
}

/** What capture produces beyond the durable anchor: the quote text (which lives
 *  on the comment row, not inside the anchor JSON). */
export interface CapturedPdfSelection {
  anchor: PdfSelectionAnchorV1;
  /** Concatenated selected text across pages (page breaks joined by '\n'). */
  quote: string;
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Deterministic, dependency-free 32-bit string hash (djb2, hex). Used for the
 *  supplementary `pageTextHashes` reattach signal — not a security primitive. */
export function hashPageText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function itemByIndex(page: NormalizedPageText, itemIndex: number): NormalizedTextItem | null {
  // items are pushed in ascending itemIndex order but marked-content gaps mean
  // itemIndex !== array position, so search rather than index directly.
  for (const it of page.items) if (it.itemIndex === itemIndex) return it;
  return null;
}

/** Absolute char offset in the page string for an endpoint on THIS page. */
function charOffsetOf(page: NormalizedPageText, ep: PdfSelectionEndpoint): number {
  const it = itemByIndex(page, ep.itemIndex);
  if (!it) return 0;
  return it.charStart + Math.max(0, Math.min(ep.charOffset, it.str.length));
}

/** Reconstruct a semantic {itemIndex, charOffset} from an absolute char offset. */
function positionForChar(page: NormalizedPageText, char: number): PdfTextPosition {
  for (const it of page.items) {
    if (char >= it.charStart && char <= it.charEnd) {
      return { itemIndex: it.itemIndex, charOffset: char - it.charStart };
    }
  }
  const last = page.items[page.items.length - 1];
  return last ? { itemIndex: last.itemIndex, charOffset: last.str.length } : { itemIndex: 0, charOffset: 0 };
}

/**
 * Clip one item's rect to the sub-range [lo, hi) of the page text, expressed in
 * the item's own coordinate space.
 *
 * A pdf.js text item is a RUN, not a word — commonly a whole line ("cial soil
 * moisture"). Painting `it.rect` whenever the run merely OVERLAPS the selection
 * is what made highlighting a single word light up the entire line. We have no
 * per-glyph advances here (the model is deliberately DOM-free and pdf.js-free,
 * so it can be unit-tested and re-run on reattach where no DOM exists), so the
 * clip interpolates along the run proportionally to char offsets.
 *
 * That assumes a uniform advance per char, so on a proportional font the edge
 * lands within roughly a glyph of the true boundary — visibly correct, unlike a
 * whole-line rect. A fully-covered run returns its rect UNCHANGED (identity), so
 * the common multi-item selection keeps exact geometry and only the first/last
 * partial run is ever approximated.
 */
function clipItemRect(it: NormalizedTextItem, lo: number, hi: number): PdfRect {
  const len = it.str.length;
  const from = Math.max(0, lo - it.charStart);
  const to = Math.min(len, hi - it.charStart);
  // Fully covered (or nothing to interpolate against) → exact stored geometry.
  if (len <= 0 || (from <= 0 && to >= len)) return it.rect;
  if (to <= from) return it.rect;

  const startFrac = from / len;
  const endFrac = to / len;
  // 'ttb' runs advance DOWN the page, so the char range clips y, not x.
  if (it.dir === 'ttb') {
    return {
      x: it.rect.x,
      y: it.rect.y + it.rect.height * startFrac,
      width: it.rect.width,
      height: it.rect.height * (endFrac - startFrac),
    };
  }
  // 'rtl' runs advance right-to-left: char 0 sits at the run's RIGHT edge, so
  // the fractions mirror about the rect's far edge.
  const leftFrac = it.dir === 'rtl' ? 1 - endFrac : startFrac;
  const rightFrac = it.dir === 'rtl' ? 1 - startFrac : endFrac;
  return {
    x: it.rect.x + it.rect.width * leftFrac,
    y: it.rect.y,
    width: it.rect.width * (rightFrac - leftFrac),
    height: it.rect.height,
  };
}

/** The normalized rects covering [start, end) on a page: one rect per
 *  contributing item — natural multi-line paint geometry — with the first/last
 *  item CLIPPED to the chars actually selected (see clipItemRect). */
export function rectsForCharRange(page: NormalizedPageText, start: number, end: number): PdfRect[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const rects: PdfRect[] = [];
  for (const it of page.items) {
    if (it.charEnd <= lo || it.charStart >= hi) continue; // no overlap
    rects.push(clampNormalizedRect(clipItemRect(it, lo, hi)));
  }
  return rects;
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Build a durable anchor from a resolved text selection. Records per-page
 * item/char endpoints, normalized paint rects, quote, 32-char prefix/suffix,
 * page labels, per-page text hashes, and the document fingerprint. The result
 * validates against `validatePdfSelectionAnchor` so the DB write path accepts it.
 */
export function capturePdfAnchor(params: CapturePdfAnchorParams): CapturedPdfSelection {
  const { fingerprint, start, end, pages, pageLabels } = params;
  const byIndex = new Map<number, NormalizedPageText>();
  for (const p of pages) byIndex.set(p.pageIndex, p);

  const first = start.pageIndex;
  const last = end.pageIndex;
  const anchorPages: PdfPageAnchor[] = [];
  const pageTextHashes: Record<number, string> = {};
  const quoteParts: string[] = [];

  for (let pageIndex = first; pageIndex <= last; pageIndex++) {
    const page = byIndex.get(pageIndex);
    if (!page) continue;
    const rangeStart = pageIndex === first ? charOffsetOf(page, start) : 0;
    const rangeEnd = pageIndex === last ? charOffsetOf(page, end) : page.text.length;
    const lo = Math.min(rangeStart, rangeEnd);
    const hi = Math.max(rangeStart, rangeEnd);

    quoteParts.push(page.text.slice(lo, hi));
    pageTextHashes[pageIndex] = hashPageText(page.text);

    const label = pageLabels?.[pageIndex];
    const pageAnchor: PdfPageAnchor = {
      pageIndex,
      start: positionForChar(page, lo),
      end: positionForChar(page, hi),
      rects: rectsForCharRange(page, lo, hi),
    };
    if (typeof label === 'string' && label.length > 0) pageAnchor.pageLabel = label;
    anchorPages.push(pageAnchor);
  }

  const startPage = byIndex.get(first);
  const endPage = byIndex.get(last);
  const startChar = startPage ? charOffsetOf(startPage, start) : 0;
  const endChar = endPage ? charOffsetOf(endPage, end) : 0;
  const prefix = startPage ? startPage.text.slice(Math.max(0, startChar - ANCHOR_CONTEXT_CHARS), startChar) : '';
  const suffix = endPage ? endPage.text.slice(endChar, endChar + ANCHOR_CONTEXT_CHARS) : '';

  const anchor: PdfSelectionAnchorV1 = {
    version: 1,
    fingerprint,
    pages: anchorPages,
    pageTextHashes,
    prefix,
    suffix,
  };
  return { anchor, quote: quoteParts.join('\n') };
}

/** The synthetic quote a coordinate-only (scanned/image) region note carries,
 *  since there is no extractable text. 1-based page for humans. */
export function coordinateOnlyQuote(pageIndex: number, pageLabel?: string): string {
  const label = pageLabel && pageLabel !== String(pageIndex + 1) ? ` (${pageLabel})` : '';
  return `[Area on PDF page ${pageIndex + 1}${label}]`;
}

/**
 * Capture a region note on a page with no extractable text (scanned/image-only).
 * There is no quote or text endpoint — just page + rects. OCR is out of scope.
 */
export function captureCoordinateOnlyAnchor(params: {
  fingerprint: string;
  pageIndex: number;
  rects: PdfRect[];
  pageLabel?: string;
}): CapturedPdfSelection {
  const { fingerprint, pageIndex, rects, pageLabel } = params;
  const page: PdfPageAnchor = {
    pageIndex,
    start: { itemIndex: 0, charOffset: 0 },
    end: { itemIndex: 0, charOffset: 0 },
    rects: rects.map(clampNormalizedRect),
  };
  if (pageLabel) page.pageLabel = pageLabel;
  return {
    anchor: { version: 1, fingerprint, pages: [page], prefix: '', suffix: '' },
    quote: coordinateOnlyQuote(pageIndex, pageLabel),
  };
}

/** True when an anchor carries no text endpoints (a coordinate-only region). */
export function isCoordinateOnly(anchor: PdfSelectionAnchorV1): boolean {
  return anchor.pages.every(
    (p) => p.start.itemIndex === p.end.itemIndex && p.start.charOffset === p.end.charOffset,
  );
}

// ── Reattach ladder ──────────────────────────────────────────────────────────

export type ReattachStatus =
  | 'reopened' // same fingerprint — semantic positions trusted
  | 'exact' // fingerprint changed but quote+context matched on the original page
  | 'moved' // relocated to a UNIQUE match within ±2 pages
  | 'needs-review' // only a fuzzy / low-confidence match — surfaced, not moved
  | 'orphaned' // no confident match — stored rects kept as historical location
  | 'coordinate-only'; // region note; nothing to text-match

export interface ReattachResult {
  status: ReattachStatus;
  /** Resolved physical page (may differ from the stored one after a 'moved'). */
  pageIndex: number;
  /** Normalized rects to paint — live-derived when matched, else the stored rects. */
  rects: PdfRect[];
  /** Live semantic endpoints when re-derived from a match. */
  start?: PdfTextPosition;
  end?: PdfTextPosition;
  fuzzy: boolean;
}

/** A page-text lookup over the live document (returns null when a page has no
 *  extracted text yet). Mirrors `PdfTextModel.getPageText` shape, sync for tests. */
export type PageTextLookup = (pageIndex: number) => NormalizedPageText | null;

export interface LiveDocument {
  fingerprint: string;
  pageCount: number;
  getPageText: PageTextLookup;
}

interface PageMatch {
  charStart: number;
  charEnd: number;
  fuzzy: boolean;
  ambiguous: boolean;
}

const RELOCATE_RADIUS = 2;
const AMBIGUITY_SENTINEL = ' ';

/**
 * Locate a quote on one page's text. Returns the char range plus two flags the
 * ladder needs: `fuzzy` (matched via prefix/suffix bridge, quote text changed)
 * and `ambiguous` (a second non-fuzzy occurrence exists — do not silently move).
 */
export function locateQuoteOnPage(
  page: NormalizedPageText,
  quote: string,
  prefix: string,
  suffix: string,
): PageMatch | null {
  const match = findBestMatch(page.text, quote, prefix, suffix);
  if (!match) return null;

  let ambiguous = false;
  if (!match.fuzzy) {
    // Blank out the chosen span and re-search; a second non-fuzzy hit ⇒ ambiguous.
    const masked =
      page.text.slice(0, match.start) +
      AMBIGUITY_SENTINEL.repeat(Math.max(0, match.end - match.start)) +
      page.text.slice(match.end);
    const second = findBestMatch(masked, quote, prefix, suffix);
    ambiguous = !!second && !second.fuzzy;
  }
  return { charStart: match.start, charEnd: match.end, fuzzy: match.fuzzy, ambiguous };
}

function resultFromMatch(
  page: NormalizedPageText,
  m: PageMatch,
  status: ReattachStatus,
): ReattachResult {
  return {
    status,
    pageIndex: page.pageIndex,
    rects: rectsForCharRange(page, m.charStart, m.charEnd),
    start: positionForChar(page, m.charStart),
    end: positionForChar(page, m.charEnd),
    fuzzy: m.fuzzy,
  };
}

function orphaned(anchor: PdfSelectionAnchorV1): ReattachResult {
  const primary = anchor.pages[0];
  return { status: 'orphaned', pageIndex: primary.pageIndex, rects: primary.rects, fuzzy: false };
}

/**
 * Reattach a stored anchor to the live document, running the plan's ladder:
 *
 *  same fingerprint         → trust semantic positions ('reopened'); re-derive
 *                             paint rects from the live match so zoom/rotate stay
 *                             exact, else keep stored rects.
 *  fingerprint mismatch:
 *    exact quote+context on original page → 'exact'
 *    quote alone on original page         → 'exact'
 *    UNIQUE match within ±2 pages          → 'moved'
 *    fuzzy / ambiguous only                → 'needs-review'
 *    nothing                               → 'orphaned' (stored rects kept)
 *
 * A coordinate-only region note never text-matches; it re-projects stored rects.
 * The stored anchor is never mutated here — the result is advisory geometry.
 */
export function reattachPdfAnchor(
  anchor: PdfSelectionAnchorV1,
  quote: string,
  live: LiveDocument,
): ReattachResult {
  const primary = anchor.pages[0];
  if (!primary) return { status: 'orphaned', pageIndex: 0, rects: [], fuzzy: false };

  if (isCoordinateOnly(anchor)) {
    return { status: 'coordinate-only', pageIndex: primary.pageIndex, rects: primary.rects, fuzzy: false };
  }

  const samePage = live.getPageText(primary.pageIndex);

  // Same document: trust the stored semantic positions; re-derive rects when the
  // live text still holds the quote so zoom/rotate paint stays exact.
  if (live.fingerprint && live.fingerprint === anchor.fingerprint) {
    if (samePage) {
      const m = locateQuoteOnPage(samePage, quote, anchor.prefix, anchor.suffix);
      if (m && !m.fuzzy) return resultFromMatch(samePage, m, 'reopened');
    }
    return { status: 'reopened', pageIndex: primary.pageIndex, rects: primary.rects, fuzzy: false };
  }

  // Fingerprint mismatch — walk the confidence ladder.
  let fuzzyCandidate: ReattachResult | null = null;

  if (samePage) {
    const m = locateQuoteOnPage(samePage, quote, anchor.prefix, anchor.suffix);
    if (m && !m.fuzzy) return resultFromMatch(samePage, m, 'exact');
    if (m && m.fuzzy) fuzzyCandidate = resultFromMatch(samePage, m, 'needs-review');
  }

  // Relocate: search outward ±RELOCATE_RADIUS pages for a UNIQUE, non-fuzzy hit.
  for (let d = 1; d <= RELOCATE_RADIUS; d++) {
    for (const cand of [primary.pageIndex - d, primary.pageIndex + d]) {
      if (cand < 0 || cand >= live.pageCount) continue;
      const page = live.getPageText(cand);
      if (!page) continue;
      const m = locateQuoteOnPage(page, quote, anchor.prefix, anchor.suffix);
      if (!m) continue;
      if (!m.fuzzy && !m.ambiguous) return resultFromMatch(page, m, 'moved');
      // Ambiguous or fuzzy relocation is never trusted silently — remember the
      // best fuzzy option as a needs-review fallback but keep looking for exact.
      if (!fuzzyCandidate && m.fuzzy) fuzzyCandidate = resultFromMatch(page, m, 'needs-review');
    }
  }

  return fuzzyCandidate ?? orphaned(anchor);
}
