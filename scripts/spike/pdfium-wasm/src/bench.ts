/*
 * Phase 0 Candidate A benchmark driver (renderer side).
 *
 * Mounts a Vite `?worker` hosting PDFium-WASM, fetches the PDF over the real
 * confined media:// transport, and measures the full cold path for the
 * pathological page 3 at the production 4 MP / DPR<=2 backing budget.
 *
 * The fit-width + backing-pixel math below is copied VERBATIM from
 * src/renderer/components/fileviewer/PdfRenderer.tsx so the spike honors the
 * exact production budget the plan mandates (`boundedPdfDevicePixelRatio`).
 */
import PdfiumWorker from './pdfium.worker.ts?worker';

// ---- verbatim from PdfRenderer.tsx ----------------------------------------
const VIEWER_GUTTER_PX = 16;
const MIN_PAGE_WIDTH_PX = 240;
const MAX_PDF_BACKING_PIXELS = 4_000_000;
const MAX_PDF_DEVICE_PIXEL_RATIO = 2;

function fitPageWidth(viewportWidth: number): number | null {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= VIEWER_GUTTER_PX * 2) return null;
  return Math.max(MIN_PAGE_WIDTH_PX, Math.floor(viewportWidth - VIEWER_GUTTER_PX * 2));
}

function boundedPdfDevicePixelRatio(
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
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const PDF_PATH = params.get('pdf') || '';
const round = (n: number) => Math.round(n * 10) / 10;

const worker = new PdfiumWorker();
let reqSeq = 0;
const pending = new Map<number, (v: any) => void>();
worker.addEventListener('message', (ev: MessageEvent<any>) => {
  const m = ev.data;
  if (m.type === 'error') {
    const r = pending.get(m.reqId);
    if (r) r(Promise.reject(new Error(m.message + (m.stack ? '\n' + m.stack : ''))));
    return;
  }
  const r = pending.get(m.reqId);
  if (r) { pending.delete(m.reqId); r(m); }
});
function call(msg: any, transfer: Transferable[] = []): Promise<any> {
  const reqId = ++reqSeq;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    worker.postMessage({ ...msg, reqId }, transfer);
  });
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

/** Draw a transferred ImageBitmap and resolve after the first composited frame. */
function paintAndWaitFrame(bitmap: ImageBitmap, cssWidth: number, cssHeight: number): Promise<number> {
  return new Promise((resolve) => {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    const t0 = performance.now();
    ctx.drawImage(bitmap, 0, 0);
    // rAF fires just before the browser composites; the callback timestamp is
    // the moment the painted frame is about to be presented = "first visible".
    requestAnimationFrame(() => resolve(performance.now() - t0));
  });
}

async function fetchBytes(path: string): Promise<{ bytes: ArrayBuffer; fetchMs: number; status: number; ranged: string | null }> {
  const url = 'media://file/' + encodeURIComponent(path);
  const t0 = performance.now();
  const res = await fetch(url);
  const bytes = await res.arrayBuffer();
  return {
    bytes,
    fetchMs: performance.now() - t0,
    status: res.status,
    ranged: res.headers.get('content-range'),
  };
}

async function renderPage(label: string, pageIndex: number, cssWidth: number) {
  const size = await call({ type: 'size', pageIndex });
  const aspect = size.originalHeight / size.originalWidth; // height/width
  const dpr = boundedPdfDevicePixelRatio(cssWidth, aspect, window.devicePixelRatio);
  const cssHeight = cssWidth * aspect;
  const backingWidth = Math.floor(cssWidth * dpr);
  const backingHeight = Math.floor(cssHeight * dpr);

  const tStart = performance.now();
  const r = await call({ type: 'render', pageIndex, backingWidth, backingHeight });
  const workerRoundTripMs = performance.now() - tStart; // includes render+convert+transfer
  const paintMs = await paintAndWaitFrame(r.bitmap, cssWidth, cssHeight);
  const totalToVisibleMs = performance.now() - tStart;

  return {
    label,
    pageIndex,
    cssWidth: round(cssWidth),
    cssHeight: round(cssHeight),
    backingWidth,
    backingHeight,
    backingMegapixels: round((backingWidth * backingHeight) / 1e6),
    effectiveDpr: round(dpr),
    renderMs: round(r.renderMs),           // pure PDFium rasterization in worker
    convertMs: round(r.convertMs),         // BGRA->RGBA + createImageBitmap
    workerRoundTripMs: round(workerRoundTripMs), // render+convert+ImageBitmap transfer to main
    paintMs: round(paintMs),               // drawImage -> first composited frame
    totalToVisibleMs: round(totalToVisibleMs),
  };
}

async function main() {
  const result: any = {
    candidate: 'A (PDFium-WASM)',
    pdfPath: PDF_PATH,
    devicePixelRatio: window.devicePixelRatio,
    chrome: (navigator as any).userAgentData?.brands?.map((b: any) => `${b.brand} ${b.version}`).join(', ') || navigator.userAgent,
    steps: {},
  };

  try {
    // Cold library init (WASM compile + instantiate).
    const init = await call({ type: 'init' });
    result.steps.coldInitMs = round(init.initMs);
    result.wasmUrl = init.wasmUrl;

    // Cold document fetch over confined media:// + PDFium loadDocument.
    const fetched = await fetchBytes(PDF_PATH);
    result.steps.fetchMs = round(fetched.fetchMs);
    result.mediaStatus = fetched.status;
    result.mediaContentRange = fetched.ranged;
    result.docBytes = fetched.bytes.byteLength;
    const loaded = await call({ type: 'load', bytes: fetched.bytes }, [fetched.bytes]);
    result.steps.coldLoadMs = round(loaded.loadMs);
    result.pageCount = loaded.pageCount;

    // Fit-width from the actual viewport (production ResizeObserver math).
    const cssWidth = fitPageWidth(document.getElementById('viewport')!.clientWidth) || MIN_PAGE_WIDTH_PX;
    result.fitWidthCss = cssWidth;

    // Cold page 1 (0-based index 0) and the pathological page 3 (index 2).
    result.page1 = await renderPage('page1-cold', 0, cssWidth);
    result.page3 = await renderPage('page3-cold', 2, cssWidth);

    // Warm re-render of page 3 (same width) — cache-independent raster cost.
    result.page3Warm = await renderPage('page3-warm', 2, cssWidth);

    // Zoom re-render of page 3 at ~150% (new backing width, new raster).
    result.page3Zoom = await renderPage('page3-zoom150', 2, Math.floor(cssWidth * 1.5));

    // "Time to visible" headline: cold fetch+load+page3 render+paint from
    // the moment bytes start arriving. Sum of the independently-measured legs
    // that a user waits through on first open of the pathological page.
    result.headline = {
      coldPage3TimeToVisibleMs: round(
        result.steps.coldInitMs +
        result.steps.fetchMs +
        result.steps.coldLoadMs +
        result.page3.totalToVisibleMs,
      ),
      coldPage3RenderPlusPaintMs: round(result.page3.totalToVisibleMs),
      note: 'coldPage3TimeToVisible = coldInit + fetch + coldLoad + page3(render+convert+transfer+paint)',
    };

    result.ok = true;
  } catch (err: any) {
    result.ok = false;
    result.error = err?.message || String(err);
    result.stack = err?.stack;
  }

  (window as any).__BENCH_RESULT = result;
  // Sentinel the Electron main greps out of the console stream.
  console.log('[BENCH_RESULT]' + JSON.stringify(result));
  const pre = document.getElementById('out')!;
  pre.textContent = JSON.stringify(result, null, 2);
}

main();
