/*
 * Phase 0 Candidate A spike worker — hosts one PDFium-WASM instance.
 *
 * Mirrors the plan's src/renderer/lib/pdf/pdfium.worker.ts contract closely
 * enough to measure the real costs: cold WASM init (compile + instantiate),
 * loadDocument, renderPage -> ImageBitmap (transferred, never PNG). The .wasm
 * URL is resolved by Vite's `?url` so this also proves packaged asset
 * resolution under `?worker` + `vite build`.
 */
import { PDFiumLibrary } from '@hyzyla/pdfium';
// Vite emits pdfium.wasm as a fingerprinted build asset and hands us its URL.
// This is the exact "packaged .wasm resolution" path a production worker uses.
import wasmUrl from '@hyzyla/pdfium/pdfium.wasm?url';

type PDFiumLibraryInstance = Awaited<ReturnType<typeof PDFiumLibrary.init>>;
type PDFiumDoc = Awaited<ReturnType<PDFiumLibraryInstance['loadDocument']>>;

let library: PDFiumLibraryInstance | null = null;
let doc: PDFiumDoc | null = null;

function now(): number {
  return performance.now();
}

/** Swap BGRA (PDFium) -> RGBA (ImageData/ImageBitmap). Part of the real cost. */
function bgraToRgba(src: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i];
    out[i + 3] = src[i + 3];
  }
  return out;
}

interface RenderMsg {
  type: 'render';
  reqId: number;
  pageIndex: number; // 0-based
  backingWidth: number;
  backingHeight: number;
}
type InMsg =
  | { type: 'init'; reqId: number }
  | { type: 'load'; reqId: number; bytes: ArrayBuffer }
  | { type: 'size'; reqId: number; pageIndex: number }
  | RenderMsg;

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const t0 = now();
      library = await PDFiumLibrary.init({ wasmUrl });
      (self as unknown as Worker).postMessage({
        type: 'init:done',
        reqId: msg.reqId,
        wasmUrl,
        initMs: now() - t0,
      });
      return;
    }

    if (msg.type === 'load') {
      if (!library) throw new Error('library not initialized');
      const t0 = now();
      doc = await library.loadDocument(new Uint8Array(msg.bytes));
      const loadMs = now() - t0;
      (self as unknown as Worker).postMessage({
        type: 'load:done',
        reqId: msg.reqId,
        loadMs,
        pageCount: doc.getPageCount(),
      });
      return;
    }

    if (msg.type === 'size') {
      if (!doc) throw new Error('document not loaded');
      const { originalWidth, originalHeight } = doc.getPage(msg.pageIndex).getOriginalSize();
      (self as unknown as Worker).postMessage({
        type: 'size:done',
        reqId: msg.reqId,
        pageIndex: msg.pageIndex,
        originalWidth,
        originalHeight,
      });
      return;
    }

    if (msg.type === 'render') {
      if (!doc) throw new Error('document not loaded');
      const page = doc.getPage(msg.pageIndex);
      const { originalWidth, originalHeight } = page.getOriginalSize();

      const tRender0 = now();
      // Render at exact backing pixels. render:"bitmap" returns raw BGRA bytes
      // (no PNG/JPEG encode) — the ImageBitmap path the plan mandates.
      const result = await page.render({
        width: msg.backingWidth,
        height: msg.backingHeight,
        render: 'bitmap',
      });
      const renderMs = now() - tRender0;

      const tConv0 = now();
      const rgba = bgraToRgba(result.data);
      const imageData = new ImageData(rgba, result.width, result.height);
      const bitmap = await createImageBitmap(imageData);
      const convertMs = now() - tConv0;

      (self as unknown as Worker).postMessage(
        {
          type: 'render:done',
          reqId: msg.reqId,
          pageIndex: msg.pageIndex,
          bitmap,
          width: result.width,
          height: result.height,
          originalWidth,
          originalHeight,
          renderMs,
          convertMs,
          postedAt: now(),
        },
        { transfer: [bitmap] },
      );
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      reqId: (msg as { reqId?: number }).reqId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
};
