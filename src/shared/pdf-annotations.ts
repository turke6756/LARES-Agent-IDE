// Durable PDF selection-anchor contract (plan Part 1.3).
//
// A PDF comment anchor is a TYPED, VERSIONED, MULTI-PAGE payload — chosen over
// PDF-specific nullable columns because browser-style selections cross pages and
// the schema must not need a re-migration when multi-page markup ships. It is
// stored as JSON in `selection_comments.anchor_json` (see database.ts 1.4) and
// carried on `SelectionComment.pdfAnchor` (types.ts 1.5).
//
// Coordinate convention (invariant): every `PdfRect` is normalized 0..1 in the
// page's UNROTATED crop box, origin top-left, x rightward, y downward. Page
// `/Rotate` is applied ONLY at projection time (`projectNormalizedPdfRect`), so
// the stored geometry survives a viewer that rotates, and re-projection at any
// zoom is a pure scale. The physical (0-based) page index is IDENTITY; the
// `pageLabel` is descriptive only and never used to locate a page.
//
// Everything here is pure and unit-tested (pdf-annotations.test.ts) — no DOM, no
// pdf.js, no Electron — so it compiles into both the main and renderer bundles.

// ── Payload shape ──────────────────────────────────────────────────────────

/** Normalized (0..1) rectangle in the UNROTATED crop box, origin top-left. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A semantic endpoint: which text item on the page, and the char offset into
 *  that item's string. `itemIndex` refers to pdf.js `getTextContent().items`. */
export interface PdfTextPosition {
  itemIndex: number;
  charOffset: number;
}

/** The portion of a selection that falls on ONE physical page. */
export interface PdfPageAnchor {
  /** 0-based PHYSICAL page — identity, never a display label. */
  pageIndex: number;
  /** Descriptive only (e.g. "iv", "S3"); never used to locate the page. */
  pageLabel?: string;
  start: PdfTextPosition;
  end: PdfTextPosition;
  /** Multi-line / per-page paint geometry, normalized in the unrotated box. */
  rects: PdfRect[];
}

export interface PdfSelectionAnchorV1 {
  version: 1;
  /** `pdfDocument.fingerprints[0]` — do NOT hash the whole file. */
  fingerprint: string;
  /** One entry per physical page the selection touches, ascending. */
  pages: PdfPageAnchor[];
  /** Supplementary reattach signal: per physical page, a hash of its text. */
  pageTextHashes?: Record<number, string>;
  /** ~32 chars of context before the selection (semantic reattach anchor). */
  prefix: string;
  /** ~32 chars of context after the selection. */
  suffix: string;
}

export type SelectionAnchorType = 'text' | 'pdf';

// ── Resource caps (plan 1.3) ────────────────────────────────────────────────

export const MAX_PDF_ANCHOR_PAGES = 20;
export const MAX_PDF_ANCHOR_RECTS = 2000; // total across all pages
export const MAX_PDF_ANCHOR_JSON_BYTES = 256 * 1024; // 256 KiB serialized

// A tiny slack for floating-point round-trips through normalize/scale math so a
// rect that is mathematically flush with the crop-box edge is not rejected.
const BOUNDS_EPSILON = 1e-6;

// ── Rotation ────────────────────────────────────────────────────────────────

export type PdfRotation = 0 | 90 | 180 | 270;

/** Coerce any degrees value (negative, >360, non-multiple-of-90) into the four
 *  canonical rotations; anything not a clean quarter-turn falls back to 0. */
export function normalizeRotation(rotation: number): PdfRotation {
  if (!Number.isFinite(rotation)) return 0;
  const r = ((Math.round(rotation) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/**
 * Rotate a normalized unrotated-crop-box rect into the rotated page's own
 * normalized (0..1) space. Clockwise, matching PDF `/Rotate`. Width/height swap
 * for 90/270. The result is still normalized in the (now rotated) box.
 */
export function rotateNormalizedPdfRect(rect: PdfRect, rotation: number): PdfRect {
  const { x, y, width: w, height: h } = rect;
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: 1 - (y + h), y: x, width: h, height: w };
    case 180:
      return { x: 1 - (x + w), y: 1 - (y + h), width: w, height: h };
    case 270:
      return { x: y, y: 1 - (x + w), width: h, height: w };
    default:
      return { x, y, width: w, height: h };
  }
}

/** A rendered page box in viewer (CSS px) space — the ALREADY-rotated box. */
export interface ViewerPageBox {
  /** Offset of the page box inside the scroll container; defaults to 0. */
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/** A projected rectangle in viewer pixel space. */
export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Project a stored (unrotated, normalized) rect into pixel coordinates within
 * the current viewer page box, applying page rotation. Pure scale + offset, so
 * it is re-run cheaply on every zoom/rotate without mutating the stored anchor.
 */
export function projectNormalizedPdfRect(
  rect: PdfRect,
  box: ViewerPageBox,
  rotation: number,
): PxRect {
  const r = rotateNormalizedPdfRect(rect, rotation);
  const ox = box.x ?? 0;
  const oy = box.y ?? 0;
  return {
    x: ox + r.x * box.width,
    y: oy + r.y * box.height,
    width: r.width * box.width,
    height: r.height * box.height,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export type PdfAnchorValidation = { ok: true } | { ok: false; error: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function inUnitRange(v: number): boolean {
  return v >= -BOUNDS_EPSILON && v <= 1 + BOUNDS_EPSILON;
}

function validateRect(rect: unknown, where: string): string | null {
  if (typeof rect !== 'object' || rect === null) return `${where}: rect must be an object`;
  const r = rect as Record<string, unknown>;
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (!isFiniteNumber(r[k])) return `${where}: rect.${k} must be a finite number`;
  }
  const { x, y, width, height } = r as unknown as PdfRect;
  if (width < -BOUNDS_EPSILON || height < -BOUNDS_EPSILON) return `${where}: rect width/height must be >= 0`;
  if (!inUnitRange(x) || !inUnitRange(y)) return `${where}: rect origin out of [0,1]`;
  if (x + width > 1 + BOUNDS_EPSILON || y + height > 1 + BOUNDS_EPSILON) {
    return `${where}: rect exceeds the unit crop box`;
  }
  return null;
}

function validatePosition(pos: unknown, where: string): string | null {
  if (typeof pos !== 'object' || pos === null) return `${where}: position must be an object`;
  const p = pos as Record<string, unknown>;
  if (!isNonNegInt(p.itemIndex)) return `${where}: itemIndex must be a non-negative integer`;
  if (!isNonNegInt(p.charOffset)) return `${where}: charOffset must be a non-negative integer`;
  return null;
}

/** True when `end` is at or after `start` in (itemIndex, charOffset) order. */
function positionOrdered(start: PdfTextPosition, end: PdfTextPosition): boolean {
  if (end.itemIndex !== start.itemIndex) return end.itemIndex > start.itemIndex;
  return end.charOffset >= start.charOffset;
}

/**
 * Structurally validate an arbitrary value as a `PdfSelectionAnchorV1`: finite
 * numbers, unit-box bounds, endpoint ordering, ascending distinct pages, the
 * page/rect caps, and the serialized byte ceiling. Returns a reason on failure
 * so callers (DB write path) can reject with context; never throws.
 */
export function validatePdfSelectionAnchor(value: unknown): PdfAnchorValidation {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'anchor must be an object' };
  const a = value as Record<string, unknown>;

  if (a.version !== 1) return { ok: false, error: 'unsupported anchor version' };
  if (typeof a.fingerprint !== 'string' || a.fingerprint.length === 0) {
    return { ok: false, error: 'fingerprint must be a non-empty string' };
  }
  if (typeof a.prefix !== 'string') return { ok: false, error: 'prefix must be a string' };
  if (typeof a.suffix !== 'string') return { ok: false, error: 'suffix must be a string' };

  if (!Array.isArray(a.pages)) return { ok: false, error: 'pages must be an array' };
  if (a.pages.length === 0) return { ok: false, error: 'pages must not be empty' };
  if (a.pages.length > MAX_PDF_ANCHOR_PAGES) {
    return { ok: false, error: `too many pages (> ${MAX_PDF_ANCHOR_PAGES})` };
  }

  let totalRects = 0;
  let prevPageIndex = -1;
  for (let i = 0; i < a.pages.length; i++) {
    const page = a.pages[i] as Record<string, unknown>;
    const where = `pages[${i}]`;
    if (typeof page !== 'object' || page === null) return { ok: false, error: `${where} must be an object` };
    if (!isNonNegInt(page.pageIndex)) return { ok: false, error: `${where}.pageIndex must be a non-negative integer` };
    if ((page.pageIndex as number) <= prevPageIndex) {
      return { ok: false, error: `${where}.pageIndex must be strictly ascending` };
    }
    prevPageIndex = page.pageIndex as number;
    if (page.pageLabel !== undefined && typeof page.pageLabel !== 'string') {
      return { ok: false, error: `${where}.pageLabel must be a string when present` };
    }

    const posErr = validatePosition(page.start, `${where}.start`) ?? validatePosition(page.end, `${where}.end`);
    if (posErr) return { ok: false, error: posErr };
    if (!positionOrdered(page.start as PdfTextPosition, page.end as PdfTextPosition)) {
      return { ok: false, error: `${where}: end precedes start` };
    }

    if (!Array.isArray(page.rects)) return { ok: false, error: `${where}.rects must be an array` };
    for (let j = 0; j < page.rects.length; j++) {
      const rectErr = validateRect(page.rects[j], `${where}.rects[${j}]`);
      if (rectErr) return { ok: false, error: rectErr };
    }
    totalRects += page.rects.length;
  }
  if (totalRects > MAX_PDF_ANCHOR_RECTS) {
    return { ok: false, error: `too many rects (> ${MAX_PDF_ANCHOR_RECTS})` };
  }

  if (a.pageTextHashes !== undefined) {
    if (typeof a.pageTextHashes !== 'object' || a.pageTextHashes === null || Array.isArray(a.pageTextHashes)) {
      return { ok: false, error: 'pageTextHashes must be an object' };
    }
    for (const [k, v] of Object.entries(a.pageTextHashes as Record<string, unknown>)) {
      if (!/^\d+$/.test(k)) return { ok: false, error: 'pageTextHashes keys must be page indices' };
      if (typeof v !== 'string') return { ok: false, error: 'pageTextHashes values must be strings' };
    }
  }

  // Serialized-size ceiling: compute on the exact bytes we would store.
  const bytes = byteLength(serializePdfSelectionAnchor(value as PdfSelectionAnchorV1));
  if (bytes > MAX_PDF_ANCHOR_JSON_BYTES) {
    return { ok: false, error: `serialized anchor too large (${bytes} > ${MAX_PDF_ANCHOR_JSON_BYTES} bytes)` };
  }

  return { ok: true };
}

// ── Serialize / parse ───────────────────────────────────────────────────────

/** Deterministic JSON serialization for storage. Pure — validation is the
 *  caller's responsibility (the DB write path validates first). */
export function serializePdfSelectionAnchor(anchor: PdfSelectionAnchorV1): string {
  return JSON.stringify(anchor);
}

/**
 * Parse a stored anchor string DEFENSIVELY: malformed JSON, wrong shape, or a
 * failed validation all yield `null` — never a throw. `rowToSelectionComment`
 * relies on this so a corrupt `anchor_json` degrades to "no anchor" instead of
 * crashing a whole comment list.
 */
export function parsePdfSelectionAnchor(json: string | null | undefined): PdfSelectionAnchorV1 | null {
  if (typeof json !== 'string' || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const validation = validatePdfSelectionAnchor(parsed);
  return validation.ok ? (parsed as PdfSelectionAnchorV1) : null;
}

/** UTF-8 byte length, without assuming a Node `Buffer` in the renderer bundle. */
function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  // Fallback (older environments): count UTF-8 bytes manually.
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
