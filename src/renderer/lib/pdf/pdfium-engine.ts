// Renderer-side PDFium-WASM facade (plan Part 2.2).
//
// A single app-wide worker (pdfium.worker.ts) hosts one PDFium-WASM instance and
// a render queue; this module is the renderer-side singleton that talks to it,
// hides the postMessage RPC behind promises, and caches the ImageBitmaps the
// worker transfers back.
//
// Two lifecycle concerns the plan mandates live here:
//   • an LRU bitmap cache keyed {docId, pageIndex, cssWidth, dpr} (cap ~12) that
//     explicitly close()s an ImageBitmap when it is evicted, and
//   • QUANTIZED raster widths — a small trackpad zoom nudges the CSS width by a
//     pixel or two, and without quantization every nudge would raster a fresh,
//     near-identical bitmap. We snap the raster width to a coarse grid and let
//     CSS scale the cached bitmap to the exact display size.
//
// The PDFium document is freed (worker-side destroy() + bitmap eviction) when a
// tab closes via closeDocument().
//
// Pure helpers (quantizeRasterWidth, computeBackingSize, BitmapLruCache) are
// exported and unit-tested directly; the worker import is DYNAMIC (inside init)
// so this module stays importable under node/vitest without spawning a worker.

import { boundedPdfDevicePixelRatio } from './pdf-metrics';
import { fetchPdfBytes, releasePdfBytes } from './pdf-bytes';

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Coarse grid the raster width is snapped to. A few px of trackpad-zoom drift
 *  reuses the same bitmap (scaled by CSS) instead of spawning a new raster. */
export const RASTER_WIDTH_QUANTUM = 16;

/** LRU capacity for decoded page bitmaps (plan: ~12 pages). */
export const BITMAP_CACHE_CAPACITY = 12;

/** Snap a CSS width to the raster grid so near-identical zooms share a bitmap.
 *  Never returns less than one quantum. */
export function quantizeRasterWidth(cssWidth: number, quantum = RASTER_WIDTH_QUANTUM): number {
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) return quantum;
  return Math.max(quantum, Math.round(cssWidth / quantum) * quantum);
}

/** Quantize the device-pixel ratio to 2 decimals so float noise in
 *  window.devicePixelRatio does not fragment the cache. */
export function quantizeDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.round(dpr * 100) / 100;
}

export interface BackingSize {
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  effectiveDpr: number;
}

/**
 * Resolve the integer backing-pixel dimensions for a page, honoring the shared
 * 4 MP / DPR ≤ 2 budget (`boundedPdfDevicePixelRatio`). `aspect` is height/width
 * of the (unrotated) page. Called in BOTH the worker (to size the raster) and
 * the engine (to key the cache) so the two never disagree.
 */
export function computeBackingSize(cssWidth: number, dpr: number, aspect: number): BackingSize {
  const effectiveDpr = boundedPdfDevicePixelRatio(cssWidth, aspect, dpr);
  const cssHeight = cssWidth * aspect;
  return {
    cssHeight,
    effectiveDpr,
    backingWidth: Math.max(1, Math.floor(cssWidth * effectiveDpr)),
    backingHeight: Math.max(1, Math.floor(cssHeight * effectiveDpr)),
  };
}

export function bitmapCacheKey(docId: number, pageIndex: number, qWidth: number, qDpr: number): string {
  return `${docId}|${pageIndex}|${qWidth}|${qDpr}`;
}

/** A minimal closeable — real ImageBitmaps and the test doubles both satisfy it. */
export interface Closeable {
  close(): void;
}

/**
 * Insertion-ordered LRU that close()s a bitmap the moment it is evicted, so the
 * GPU/decoder memory a page held is released deterministically rather than at the
 * next GC. `get` bumps to most-recently-used; overflow evicts least-recently-used.
 */
export class BitmapLruCache<V extends Closeable> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly capacity = BITMAP_CACHE_CAPACITY) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: V): void {
    const prior = this.entries.get(key);
    if (prior && prior !== value) safeClose(prior);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) safeClose(evicted);
    }
  }

  /** Evict + close every entry for one document (called on tab close). */
  evictDocument(docId: number): void {
    const prefix = `${docId}|`;
    for (const [key, value] of [...this.entries.entries()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        safeClose(value);
      }
    }
  }

  clear(): void {
    for (const value of this.entries.values()) safeClose(value);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function safeClose(c: Closeable): void {
  try {
    c.close();
  } catch {
    /* a double-close or a detached bitmap must never crash eviction */
  }
}

// ── Worker RPC protocol ──────────────────────────────────────────────────────
// Shared shape between this module and pdfium.worker.ts.

export type PdfiumRequest =
  | { id: number; op: 'init' }
  | { id: number; op: 'load'; bytes: ArrayBuffer }
  | { id: number; op: 'size'; docId: number; pageIndex: number }
  | { id: number; op: 'render'; docId: number; pageIndex: number; cssWidth: number; dpr: number }
  | { id: number; op: 'close'; docId: number }
  | { op: 'cancel'; ids: number[] };

export type PdfiumResponse =
  | { id: number; ok: true; op: 'init' }
  | { id: number; ok: true; op: 'load'; docId: number; pageCount: number }
  | { id: number; ok: true; op: 'size'; width: number; height: number }
  | {
      id: number;
      ok: true;
      op: 'render';
      bitmap: ImageBitmap;
      backingWidth: number;
      backingHeight: number;
      cssWidth: number;
      cssHeight: number;
      aspect: number;
    }
  | { id: number; ok: true; op: 'close' }
  | { id: number; ok: false; error: string };

/** A worker-like object — the real Vite `?worker` Worker, or a test double. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (ev: MessageEvent) => void): void;
  terminate(): void;
}

let workerFactory: (() => WorkerLike) | null = null;

/** Test seam: install a fake worker factory before the engine initializes. */
export function __setPdfiumWorkerFactory(factory: (() => WorkerLike) | null): void {
  workerFactory = factory;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface PdfPageSize {
  /** Unrotated page width in PDF points. */
  width: number;
  height: number;
}

export interface RenderedPage {
  bitmap: ImageBitmap;
  backingWidth: number;
  backingHeight: number;
  cssWidth: number;
  cssHeight: number;
  /** height / width of the unrotated page. */
  aspect: number;
}

interface DocHandle {
  docId: number;
  pageCount: number;
  /** Original page sizes (points), lazily filled from getPageSize. */
  readonly sizes: Map<number, PdfPageSize>;
}

export class PdfiumEngine {
  private worker: WorkerLike | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: PdfiumResponse) => void; reject: (e: Error) => void }>();
  private readonly cache = new BitmapLruCache<ImageBitmap>();
  /** One open document per file path (reopening a tab reuses it). */
  private readonly docsByPath = new Map<string, Promise<DocHandle>>();

  // ── init / RPC plumbing ────────────────────────────────────────────────────

  private async ensureWorker(): Promise<WorkerLike> {
    if (this.worker) return this.worker;
    if (!this.initPromise) {
      this.initPromise = this.spawnAndInit();
    }
    await this.initPromise;
    if (!this.worker) throw new Error('PdfiumEngine: worker failed to initialize');
    return this.worker;
  }

  private async spawnAndInit(): Promise<void> {
    if (!workerFactory) {
      // Dynamic import so this module never statically pulls the ?worker asset
      // (which spawns a real worker) into a node/vitest import graph.
      const mod = await import('./pdfium.worker?worker');
      workerFactory = () => new mod.default() as unknown as WorkerLike;
    }
    const worker = workerFactory();
    worker.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev.data as PdfiumResponse));
    worker.addEventListener('messageerror', () => {
      /* a structured-clone failure surfaces as a per-request timeout/reject path */
    });
    this.worker = worker;
    await this.request({ op: 'init' });
  }

  private onMessage(msg: PdfiumResponse): void {
    if (!msg || typeof (msg as { id?: number }).id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) {
      // No waiter: a cancelled render whose bitmap still arrived. Close it so a
      // superseded raster does not leak (plan: explicitly close evicted bitmaps).
      if (msg.ok && msg.op === 'render') safeClose(msg.bitmap);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error));
  }

  /** Send a request that expects a response, returning its resolved payload. */
  private request(req: Omit<PdfiumRequest, 'id'> & { op: Exclude<PdfiumRequest['op'], 'cancel'> }, transfer: Transferable[] = []): Promise<PdfiumResponse> {
    const id = this.nextId++;
    const full = { ...req, id } as PdfiumRequest;
    return new Promise<PdfiumResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // ensureWorker() has always been awaited by callers before request(),
      // except the init request itself which is posted after the worker exists.
      this.worker!.postMessage(full, transfer);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Lazily spawn + initialize the worker (idempotent). */
  async init(): Promise<void> {
    await this.ensureWorker();
  }

  /**
   * Open (or reuse) a document for `filePath`. Bytes come from the shared
   * media:// cache; the worker keeps the PDFium document and returns a docId.
   */
  async openDocument(filePath: string): Promise<DocHandle> {
    const existing = this.docsByPath.get(filePath);
    if (existing) return existing;

    const promise = (async () => {
      await this.ensureWorker();
      const bytes = await fetchPdfBytes(filePath);
      // Hand PDFium its own copy — pdf.js (the text model) may detach the shared
      // buffer, and the worker transfers the ArrayBuffer it is given.
      const copy = bytes.slice(0);
      const res = await this.request({ op: 'load', bytes: copy }, [copy]);
      if (res.ok && res.op === 'load') {
        return { docId: res.docId, pageCount: res.pageCount, sizes: new Map<number, PdfPageSize>() };
      }
      throw new Error('PdfiumEngine.openDocument: unexpected response');
    })();

    this.docsByPath.set(filePath, promise);
    // A failed load must not poison the cache — a retry should re-attempt.
    promise.catch(() => {
      if (this.docsByPath.get(filePath) === promise) this.docsByPath.delete(filePath);
    });
    return promise;
  }

  async getPageSize(docId: number, pageIndex: number): Promise<PdfPageSize> {
    const res = await this.request({ op: 'size', docId, pageIndex });
    if (res.ok && res.op === 'size') return { width: res.width, height: res.height };
    throw new Error('PdfiumEngine.getPageSize: unexpected response');
  }

  /**
   * Render a page to an ImageBitmap at (quantized) `cssWidth` × `dpr`, honoring
   * the shared backing-pixel budget. Cached by {docId, pageIndex, qWidth, qDpr}.
   * Pass `signal` to cancel a stale render when width/zoom changes — the worker
   * drops the queued job and any bitmap that still arrives is closed.
   */
  async renderPage(
    docId: number,
    pageIndex: number,
    cssWidth: number,
    dpr: number,
    signal?: AbortSignal,
  ): Promise<RenderedPage> {
    if (signal?.aborted) throw new DOMException('Render aborted', 'AbortError');
    await this.ensureWorker();

    const qWidth = quantizeRasterWidth(cssWidth);
    const qDpr = quantizeDpr(dpr);
    const key = bitmapCacheKey(docId, pageIndex, qWidth, qDpr);

    const cached = this.cache.get(key);
    if (cached) {
      const { width, height } = await this.pageSizeCached(docId, pageIndex);
      const aspect = width > 0 ? height / width : cached.height / Math.max(1, cached.width);
      return {
        bitmap: cached,
        backingWidth: cached.width,
        backingHeight: cached.height,
        cssWidth: qWidth,
        cssHeight: qWidth * aspect,
        aspect,
      };
    }

    const id = this.nextId++;
    const req = { id, op: 'render' as const, docId, pageIndex, cssWidth: qWidth, dpr: qDpr };
    const promise = new Promise<PdfiumResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.worker!.postMessage({ op: 'cancel', ids: [id] } satisfies PdfiumRequest);
        reject(new DOMException('Render aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.worker!.postMessage(req satisfies PdfiumRequest);
    });

    const res = await promise;
    if (!(res.ok && res.op === 'render')) throw new Error('PdfiumEngine.renderPage: unexpected response');
    // The caller may have aborted between the worker posting and us resolving.
    if (signal?.aborted) {
      safeClose(res.bitmap);
      throw new DOMException('Render aborted', 'AbortError');
    }
    this.cache.set(key, res.bitmap);
    return {
      bitmap: res.bitmap,
      backingWidth: res.backingWidth,
      backingHeight: res.backingHeight,
      cssWidth: res.cssWidth,
      cssHeight: res.cssHeight,
      aspect: res.aspect,
    };
  }

  private async pageSizeCached(docId: number, pageIndex: number): Promise<PdfPageSize> {
    const size = await this.getPageSize(docId, pageIndex);
    return size;
  }

  /** Free a document worker-side and evict its bitmaps (call on tab close). */
  async closeDocument(filePath: string): Promise<void> {
    const handlePromise = this.docsByPath.get(filePath);
    this.docsByPath.delete(filePath);
    releasePdfBytes(filePath);
    if (!handlePromise) return;
    let handle: DocHandle | null = null;
    try {
      handle = await handlePromise;
    } catch {
      return; // never opened
    }
    this.cache.evictDocument(handle.docId);
    try {
      await this.request({ op: 'close', docId: handle.docId });
    } catch {
      /* worker may already be gone */
    }
  }
}

// App-wide singleton facade.
export const pdfiumEngine = new PdfiumEngine();
export type { DocHandle };
