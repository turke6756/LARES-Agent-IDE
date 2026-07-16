// PDFium-WASM render worker (plan Part 2.1). Vite `?worker`.
//
// Hosts ONE PDFium-WASM library instance app-wide plus a serial render queue.
// The renderer-side facade (pdfium-engine.ts) drives it over the shared
// PdfiumRequest/PdfiumResponse protocol. This file lifts the proven approach
// from the Phase-0 spike (scripts/spike/pdfium-wasm/src/pdfium.worker.ts):
// `@hyzyla/pdfium@2.1.13`, the Vite-resolved .wasm URL, BGRA→RGBA, and a
// transferred ImageBitmap (never a PNG/JPEG encode).
//
// What it adds over the spike, per the plan:
//   • many documents keyed by docId, not one global `doc`;
//   • a render QUEUE with CANCELLATION so a stale width/zoom render is dropped
//     rather than raced to the screen;
//   • the shared 4 MP / DPR ≤ 2 budget (computeBackingSize) applied worker-side
//     as a hard backstop even if a caller asks for more;
//   • document-count / total-byte memory ceilings so an oversized or runaway
//     workspace cannot exhaust worker memory.

import { PDFiumLibrary } from '@hyzyla/pdfium';
// Vite emits pdfium.wasm as a fingerprinted build asset and hands us its URL —
// the exact packaged-asset resolution path the production worker needs.
import wasmUrl from '@hyzyla/pdfium/pdfium.wasm?url';
import { computeBackingSize } from './pdfium-engine';
import type { PdfiumRequest } from './pdfium-engine';

type PDFiumLibraryInstance = Awaited<ReturnType<typeof PDFiumLibrary.init>>;
type PDFiumDoc = Awaited<ReturnType<PDFiumLibraryInstance['loadDocument']>>;

// ── Memory ceilings ──────────────────────────────────────────────────────────

/** Never keep more than this many PDFium documents resident at once. */
const MAX_OPEN_DOCS = 8;
/** Sum of all resident document byte sizes — a coarse worker-memory backstop. */
const MAX_TOTAL_DOC_BYTES = 1024 * 1024 * 1024; // 1 GiB

// ── State ────────────────────────────────────────────────────────────────────

let library: PDFiumLibraryInstance | null = null;
let nextDocId = 1;
let totalDocBytes = 0;

interface DocEntry {
  doc: PDFiumDoc;
  bytes: number;
}
const docs = new Map<number, DocEntry>();

interface RenderJob {
  id: number;
  docId: number;
  pageIndex: number;
  cssWidth: number;
  dpr: number;
}
const renderQueue: RenderJob[] = [];
const cancelled = new Set<number>();
let draining = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ctx = self as unknown as Worker;

function post(message: unknown, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

function fail(id: number, err: unknown): void {
  post({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
}

/** Swap BGRA (PDFium) → RGBA (ImageData). Same per-pixel cost the spike measured. */
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

// ── Render queue ─────────────────────────────────────────────────────────────
// PDFium-WASM is single-threaded; render one page at a time. Between jobs we
// drop any that were cancelled (superseded by a newer width/zoom) so the worker
// never spends time rasterizing a bitmap nobody will show.

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (renderQueue.length > 0) {
      const job = renderQueue.shift()!;
      if (cancelled.delete(job.id)) continue; // dropped before it ran
      try {
        await runRender(job);
      } catch (err) {
        fail(job.id, err);
      }
    }
  } finally {
    draining = false;
  }
}

async function runRender(job: RenderJob): Promise<void> {
  const entry = docs.get(job.docId);
  if (!entry) throw new Error(`render: document ${job.docId} is not open`);
  const page = entry.doc.getPage(job.pageIndex);
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const aspect = originalWidth > 0 ? originalHeight / originalWidth : 1;

  // Worker-side budget backstop: clamp to 4 MP / DPR ≤ 2 no matter what was asked.
  const { backingWidth, backingHeight, cssHeight } = computeBackingSize(job.cssWidth, job.dpr, aspect);

  const result = await page.render({
    width: backingWidth,
    height: backingHeight,
    render: 'bitmap',
  });

  // A cancel that arrived while rendering: throw the pixels away, produce nothing.
  if (cancelled.delete(job.id)) return;

  const rgba = bgraToRgba(result.data);
  const imageData = new ImageData(rgba, result.width, result.height);
  const bitmap = await createImageBitmap(imageData);

  if (cancelled.delete(job.id)) {
    bitmap.close();
    return;
  }

  post(
    {
      id: job.id,
      ok: true,
      op: 'render',
      bitmap,
      backingWidth: result.width,
      backingHeight: result.height,
      cssWidth: job.cssWidth,
      cssHeight,
      aspect,
    },
    [bitmap],
  );
}

// ── Message dispatch ─────────────────────────────────────────────────────────

async function handle(msg: PdfiumRequest): Promise<void> {
  if (msg.op === 'cancel') {
    for (const id of msg.ids) cancelled.add(id);
    return;
  }

  switch (msg.op) {
    case 'init': {
      if (!library) library = await PDFiumLibrary.init({ wasmUrl });
      post({ id: msg.id, ok: true, op: 'init' });
      return;
    }
    case 'load': {
      if (!library) throw new Error('load: library not initialized');
      const byteLength = msg.bytes.byteLength;
      if (docs.size >= MAX_OPEN_DOCS) {
        throw new Error(`load: too many open documents (${docs.size} >= ${MAX_OPEN_DOCS})`);
      }
      if (totalDocBytes + byteLength > MAX_TOTAL_DOC_BYTES) {
        throw new Error('load: worker document-memory ceiling exceeded');
      }
      const doc = await library.loadDocument(new Uint8Array(msg.bytes));
      const docId = nextDocId++;
      docs.set(docId, { doc, bytes: byteLength });
      totalDocBytes += byteLength;
      post({ id: msg.id, ok: true, op: 'load', docId, pageCount: doc.getPageCount() });
      return;
    }
    case 'size': {
      const entry = docs.get(msg.docId);
      if (!entry) throw new Error(`size: document ${msg.docId} is not open`);
      const { originalWidth, originalHeight } = entry.doc.getPage(msg.pageIndex).getOriginalSize();
      post({ id: msg.id, ok: true, op: 'size', width: originalWidth, height: originalHeight });
      return;
    }
    case 'render': {
      renderQueue.push({
        id: msg.id,
        docId: msg.docId,
        pageIndex: msg.pageIndex,
        cssWidth: msg.cssWidth,
        dpr: msg.dpr,
      });
      void drainQueue();
      return;
    }
    case 'close': {
      const entry = docs.get(msg.docId);
      if (entry) {
        docs.delete(msg.docId);
        totalDocBytes -= entry.bytes;
        // Drop any queued renders for a document we're about to destroy.
        for (const job of renderQueue) if (job.docId === msg.docId) cancelled.add(job.id);
        try {
          entry.doc.destroy();
        } catch {
          /* already destroyed */
        }
      }
      post({ id: msg.id, ok: true, op: 'close' });
      return;
    }
  }
}

ctx.onmessage = (ev: MessageEvent<PdfiumRequest>) => {
  const msg = ev.data;
  void handle(msg).catch((err) => {
    if ('id' in msg && typeof msg.id === 'number') fail(msg.id, err);
  });
};
