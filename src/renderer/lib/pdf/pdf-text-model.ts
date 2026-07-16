// Paint-disabled pdf.js text model (plan Part 1.6).
//
// Opens the SAME media:// source as the raster path, but SOLELY for structure +
// text: fingerprint, page count, labels, per-page unrotated crop-box dims and
// rotation, and `getTextContent()` for the pages the viewer actually needs
// (current / adjacent / anchored / find-hit). It NEVER calls getOperatorList(),
// never creates a canvas, and never mounts a react-pdf <Page> — so it never
// pays pdf.js's paint tax (the diagnosed 15 s bottleneck).
//
// All geometry is normalized 0..1 in the UNROTATED crop box (matching the
// pdf-annotations contract); rotation is applied only at projection time by the
// overlay, never baked into the stored text model.

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { fetchPdfBytes, releasePdfBytes } from './pdf-bytes';
import { PdfTextCache } from './pdf-text-cache';
import { normalizePageTextContent } from './pdf-text-geometry';
import type { NormalizedPageText } from './pdf-text-geometry';

// Re-export the pure geometry core so callers see one text-model surface.
export {
  clampNormalizedRect,
  normalizePageTextContent,
  textItemToNormalizedRect,
} from './pdf-text-geometry';
export type { NormalizedPageText, NormalizedTextItem } from './pdf-text-geometry';

// The renderer's raster path (PdfRenderer.tsx) already points pdf.js at the
// Vite-bundled worker; set it here too so this model works even if it loads
// first. Idempotent — assigning the same URL twice is harmless.
if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface PdfPageInfo {
  pageIndex: number;
  /** UNROTATED crop-box width/height in PDF points. */
  cropWidth: number;
  cropHeight: number;
  /** Page /Rotate in degrees, clockwise. */
  rotation: number;
}

export interface PdfDocMeta {
  fingerprint: string;
  pageCount: number;
  /** Descriptive page labels (may equal the physical numbers). */
  pageLabels: string[] | null;
}

// ── The model ───────────────────────────────────────────────────────────────

/**
 * A live text-only handle over one PDF document. Construct via
 * `openPdfTextModel`; call `destroy()` (or let the tab close) to cancel and free
 * the pdf.js document + cached text.
 */
export class PdfTextModel {
  private meta: PdfDocMeta | null = null;
  private readonly pageInfo = new Map<number, PdfPageInfo>();
  private readonly cache = new PdfTextCache();
  private destroyed = false;

  private constructor(
    private readonly filePath: string,
    private readonly doc: PDFDocumentProxy,
  ) {
    const fp = doc.fingerprints?.[0] ?? '';
    this.meta = { fingerprint: fp, pageCount: doc.numPages, pageLabels: null };
  }

  static async open(filePath: string): Promise<PdfTextModel> {
    const bytes = await fetchPdfBytes(filePath);
    // pdf.js may transfer/detach the buffer it is handed — give it a private copy
    // so the shared cache buffer stays intact for the raster engine (plan 1.2).
    const task = pdfjs.getDocument({ data: bytes.slice(0) });
    const doc = await task.promise;
    const model = new PdfTextModel(filePath, doc);
    try {
      const labels = await doc.getPageLabels();
      if (model.meta) model.meta.pageLabels = labels;
    } catch { /* labels are optional */ }
    return model;
  }

  getMeta(): PdfDocMeta {
    if (!this.meta) throw new Error('PdfTextModel: no metadata');
    return this.meta;
  }

  get fingerprint(): string {
    return this.meta?.fingerprint ?? '';
  }

  /** Lightweight per-page metadata (getPage only — never getOperatorList). */
  async getPageInfo(pageIndex: number): Promise<PdfPageInfo> {
    const cached = this.pageInfo.get(pageIndex);
    if (cached) return cached;
    const page: PDFPageProxy = await this.doc.getPage(pageIndex + 1);
    const [x0, y0, x1, y1] = page.view; // unrotated crop box
    const info: PdfPageInfo = {
      pageIndex,
      cropWidth: Math.abs(x1 - x0),
      cropHeight: Math.abs(y1 - y0),
      rotation: page.rotate,
    };
    this.pageInfo.set(pageIndex, info);
    return info;
  }

  /**
   * Extract (and cache) normalized text for one page. Only call this for pages
   * the viewer needs — current, visible-adjacent, anchored, or find hits.
   */
  async getPageText(pageIndex: number): Promise<NormalizedPageText> {
    const fp = this.fingerprint;
    const cached = this.cache.get(fp, pageIndex);
    if (cached) return cached;

    const info = await this.getPageInfo(pageIndex);
    const page = await this.doc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    if (this.destroyed) return { pageIndex, text: '', items: [] };
    const normalized = normalizePageTextContent(pageIndex, content.items, info.cropWidth, info.cropHeight);
    this.cache.set(fp, pageIndex, normalized);
    return normalized;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const fp = this.fingerprint;
    this.cache.evictDocument(fp);
    this.pageInfo.clear();
    releasePdfBytes(this.filePath);
    void this.doc.destroy();
  }
}

export async function openPdfTextModel(filePath: string): Promise<PdfTextModel> {
  return PdfTextModel.open(filePath);
}
