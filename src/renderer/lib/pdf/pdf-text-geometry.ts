// Pure text-geometry core for the paint-disabled model (plan Part 1.6).
//
// Split out of pdf-text-model.ts so it carries NO pdf.js import — importing
// pdfjs-dist pulls in canvas.js (DOMMatrix), which cannot load in a bare node
// test env. Everything here is pure math/string work and unit-tested directly.
// pdf-text-model.ts re-exports these names so callers see one module surface.

import type { PdfRect } from '../../../shared/pdf-annotations';

export interface NormalizedTextItem {
  /** Index into the page's `getTextContent().items` (identity for anchors). */
  itemIndex: number;
  str: string;
  /** Char offsets into the concatenated page text (`NormalizedPageText.text`). */
  charStart: number;
  charEnd: number;
  /** Bounding box, normalized 0..1 in the UNROTATED crop box, origin top-left. */
  rect: PdfRect;
  /** Writing direction from pdf.js ('ltr' | 'rtl' | 'ttb'). */
  dir: string;
  hasEOL: boolean;
}

export interface NormalizedPageText {
  pageIndex: number;
  /** Concatenated item strings (EOL items add a newline) — the search space. */
  text: string;
  items: NormalizedTextItem[];
}

// A structural subset of pdf.js `TextItem` — enough for normalization, without
// importing the pdfjs types (which would drag in the runtime).
interface RawTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  dir: string;
  hasEOL: boolean;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Clamp a normalized rect fully inside the unit crop box. */
export function clampNormalizedRect(rect: PdfRect): PdfRect {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  return {
    x,
    y,
    width: clamp01(Math.max(0, rect.width) + x) - x,
    height: clamp01(Math.max(0, rect.height) + y) - y,
  };
}

/**
 * Map a pdf.js text-item transform + advance into a normalized unrotated-crop-
 * box rect. pdf.js item transforms live in the page's default (unrotated) user
 * space, origin BOTTOM-left, y up; we flip to origin top-left, y down, and
 * divide by the crop-box dims so the result is rotation-independent.
 */
export function textItemToNormalizedRect(
  transform: number[],
  width: number,
  height: number,
  cropWidth: number,
  cropHeight: number,
): PdfRect {
  if (!(cropWidth > 0) || !(cropHeight > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const e = transform[4] ?? 0;
  const f = transform[5] ?? 0;
  // Fall back to the transform's vertical scale when the reported height is 0.
  const h = height > 0 ? height : Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
  const topCrop = f + h; // ascent edge in y-up crop coords
  return clampNormalizedRect({
    x: e / cropWidth,
    y: 1 - topCrop / cropHeight,
    width: width / cropWidth,
    height: h / cropHeight,
  });
}

function isTextItem(item: unknown): item is RawTextItemLike {
  return typeof item === 'object' && item !== null && typeof (item as RawTextItemLike).str === 'string';
}

/**
 * Normalize a raw pdf.js text-content item list into the searchable page model:
 * a concatenated page string plus per-item char ranges and normalized rects.
 * Marked-content items (no `str`) are skipped but still consume an item index,
 * so `itemIndex` stays aligned with the raw `getTextContent().items` array.
 */
export function normalizePageTextContent(
  pageIndex: number,
  items: readonly unknown[],
  cropWidth: number,
  cropHeight: number,
): NormalizedPageText {
  const out: NormalizedTextItem[] = [];
  let text = '';
  let itemIndex = 0;
  for (const raw of items) {
    if (!isTextItem(raw)) { itemIndex++; continue; }
    const charStart = text.length;
    text += raw.str;
    const charEnd = text.length;
    if (raw.hasEOL) text += '\n';
    out.push({
      itemIndex,
      str: raw.str,
      charStart,
      charEnd,
      rect: textItemToNormalizedRect(raw.transform, raw.width, raw.height, cropWidth, cropHeight),
      dir: raw.dir,
      hasEOL: raw.hasEOL,
    });
    itemIndex++;
  }
  return { pageIndex, text, items: out };
}
