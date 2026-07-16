// Reusable PDF backing-pixel / fit-width metrics (plan Part 1.1).
//
// Hoisted verbatim out of components/fileviewer/PdfRenderer.tsx so BOTH the
// WASM raster path (Candidate A) and the pdf.js text/fallback path apply the
// identical 4 MP backing-pixel budget and DPR ≤ 2 cap. PdfRenderer.tsx re-
// exports these names, so existing imports and PdfRenderer.test.tsx stay green.
//
// Pure math — no React, no pdf.js, no DOM.

const VIEWER_GUTTER_PX = 16;
const MIN_PAGE_WIDTH_PX = 240;

/** Never let a page's full backing canvas exceed 4 megapixels. */
export const MAX_PDF_BACKING_PIXELS = 4_000_000;

/** Retain crispness up to 2× device pixel ratio, but no further. */
export const MAX_PDF_DEVICE_PIXEL_RATIO = 2;

/** CSS width of a page at fit-to-width for the given viewport, or null when the
 *  viewport is too small / not measurable. */
export function fitPageWidth(viewportWidth: number): number | null {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= VIEWER_GUTTER_PX * 2) return null;
  return Math.max(MIN_PAGE_WIDTH_PX, Math.floor(viewportWidth - VIEWER_GUTTER_PX * 2));
}

/** Keep the complete backing canvas within budget while retaining up to 2× DPR. */
export function boundedPdfDevicePixelRatio(
  cssWidth: number,
  pageAspectRatio: number,
  devicePixelRatio: number,
  maxBackingPixels = MAX_PDF_BACKING_PIXELS,
): number {
  const cappedDeviceDpr = Math.min(
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
    MAX_PDF_DEVICE_PIXEL_RATIO,
  );
  if (
    !Number.isFinite(cssWidth) || cssWidth <= 0
    || !Number.isFinite(pageAspectRatio) || pageAspectRatio <= 0
    || !Number.isFinite(maxBackingPixels) || maxBackingPixels <= 0
  ) return cappedDeviceDpr;

  const cssPixels = cssWidth * (cssWidth * pageAspectRatio);
  return Math.min(cappedDeviceDpr, Math.sqrt(maxBackingPixels / cssPixels));
}
