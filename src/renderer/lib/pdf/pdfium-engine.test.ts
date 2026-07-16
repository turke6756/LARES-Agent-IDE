import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BitmapLruCache,
  PdfiumEngine,
  __setPdfiumWorkerFactory,
  bitmapCacheKey,
  computeBackingSize,
  quantizeDpr,
  quantizeRasterWidth,
  type PdfiumRequest,
  type WorkerLike,
} from './pdfium-engine';
import { clearPdfBytesCache } from './pdf-bytes';

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('pdfium-engine pure helpers', () => {
  it('snaps raster widths to a coarse grid so near-identical zooms share a bitmap', () => {
    expect(quantizeRasterWidth(968)).toBe(quantizeRasterWidth(970));
    expect(quantizeRasterWidth(968)).toBe(976);
    expect(quantizeRasterWidth(0)).toBe(16);
    expect(quantizeRasterWidth(-5)).toBe(16);
    expect(quantizeRasterWidth(8)).toBe(16); // never below one quantum
  });

  it('quantizes DPR to two decimals', () => {
    expect(quantizeDpr(1.23456)).toBe(1.23);
    expect(quantizeDpr(0)).toBe(1);
    expect(quantizeDpr(Number.NaN)).toBe(1);
  });

  it('honors the 4 MP / DPR<=2 budget when sizing the backing store', () => {
    const small = computeBackingSize(500, 2, 1.3);
    expect(small.effectiveDpr).toBe(2);
    expect(small.backingWidth).toBe(1000);
    expect(small.backingHeight).toBe(Math.floor(500 * 1.3 * 2));

    // A large page must be pulled below DPR 2 to stay within 4 MP.
    const big = computeBackingSize(2000, 2, 1.5);
    expect(big.effectiveDpr).toBeLessThan(2);
    expect(big.backingWidth * big.backingHeight).toBeLessThanOrEqual(4_000_000 + 2000);
  });
});

// ── LRU bitmap cache ─────────────────────────────────────────────────────────

function fakeBitmap(width = 10, height = 10) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

describe('BitmapLruCache', () => {
  it('evicts and closes the least-recently-used bitmap past capacity', () => {
    const cache = new BitmapLruCache<ImageBitmap>(2);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const c = fakeBitmap();
    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c); // evicts 'a'
    expect(cache.size).toBe(2);
    expect((a as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('get() bumps to most-recently-used so it survives the next eviction', () => {
    const cache = new BitmapLruCache<ImageBitmap>(2);
    const a = fakeBitmap();
    const b = fakeBitmap();
    const c = fakeBitmap();
    cache.set('a', a);
    cache.set('b', b);
    cache.get('a'); // 'a' is now MRU
    cache.set('c', c); // evicts 'b', not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect((b as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });

  it('evictDocument() closes every bitmap for one docId', () => {
    const cache = new BitmapLruCache<ImageBitmap>(12);
    const p0 = fakeBitmap();
    const p1 = fakeBitmap();
    const other = fakeBitmap();
    cache.set(bitmapCacheKey(1, 0, 976, 2), p0);
    cache.set(bitmapCacheKey(1, 1, 976, 2), p1);
    cache.set(bitmapCacheKey(2, 0, 976, 2), other);
    cache.evictDocument(1);
    expect(cache.size).toBe(1);
    expect((p0 as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect((p1 as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect((other as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });
});

// ── Engine ↔ worker RPC (fake worker) ────────────────────────────────────────

type Listener = (ev: { data: unknown }) => void;

interface FakeWorkerOptions {
  /** Delay (ticks of microtask flushing) before a render response is posted. */
  renderDelay?: boolean;
}

class FakeWorker implements WorkerLike {
  private listeners: Listener[] = [];
  readonly received: PdfiumRequest[] = [];
  readonly bitmaps: Array<ImageBitmap & { close: ReturnType<typeof vi.fn> }> = [];
  private deferredRenders: Array<() => void> = [];
  terminated = false;

  constructor(private readonly opts: FakeWorkerOptions = {}) {}

  addEventListener(type: 'message' | 'messageerror', listener: Listener): void {
    if (type === 'message') this.listeners.push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(msg: unknown): void {
    for (const l of this.listeners) l({ data: msg });
  }

  postMessage(message: unknown): void {
    const msg = message as PdfiumRequest;
    this.received.push(msg);
    if (msg.op === 'cancel') return;
    queueMicrotask(() => this.respond(msg));
  }

  private respond(msg: Exclude<PdfiumRequest, { op: 'cancel' }>): void {
    switch (msg.op) {
      case 'init':
        this.emit({ id: msg.id, ok: true, op: 'init' });
        return;
      case 'load':
        this.emit({ id: msg.id, ok: true, op: 'load', docId: 1, pageCount: 5 });
        return;
      case 'size':
        this.emit({ id: msg.id, ok: true, op: 'size', width: 612, height: 792 });
        return;
      case 'close':
        this.emit({ id: msg.id, ok: true, op: 'close' });
        return;
      case 'render': {
        const aspect = 792 / 612;
        const { backingWidth, backingHeight, cssHeight } = computeBackingSize(msg.cssWidth, msg.dpr, aspect);
        const bitmap = fakeBitmap(backingWidth, backingHeight);
        this.bitmaps.push(bitmap);
        const send = () =>
          this.emit({
            id: msg.id,
            ok: true,
            op: 'render',
            bitmap,
            backingWidth,
            backingHeight,
            cssWidth: msg.cssWidth,
            cssHeight,
            aspect,
          });
        if (this.opts.renderDelay) this.deferredRenders.push(send);
        else send();
        return;
      }
    }
  }

  /** Flush any render responses held back by renderDelay. */
  flushRenders(): void {
    const pending = this.deferredRenders;
    this.deferredRenders = [];
    for (const send of pending) send();
  }
}

describe('PdfiumEngine RPC', () => {
  beforeEach(() => {
    clearPdfBytesCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(2048),
    })));
  });

  afterEach(() => {
    __setPdfiumWorkerFactory(null);
    vi.unstubAllGlobals();
  });

  it('opens a document and reuses the same handle for the same path', async () => {
    const worker = new FakeWorker();
    __setPdfiumWorkerFactory(() => worker);
    const engine = new PdfiumEngine();

    const a = await engine.openDocument('C:/w/doc.pdf');
    const b = await engine.openDocument('C:/w/doc.pdf');
    expect(a.docId).toBe(b.docId);
    expect(a.pageCount).toBe(5);
    // Exactly one load RPC despite two openDocument calls.
    expect(worker.received.filter((m) => m.op === 'load')).toHaveLength(1);
  });

  it('quantizes so a tiny zoom delta reuses the cached bitmap (one render RPC)', async () => {
    const worker = new FakeWorker();
    __setPdfiumWorkerFactory(() => worker);
    const engine = new PdfiumEngine();
    const { docId } = await engine.openDocument('C:/w/doc.pdf');

    const first = await engine.renderPage(docId, 2, 968, 2);
    const second = await engine.renderPage(docId, 2, 970, 2); // same quantized width
    expect(second.bitmap).toBe(first.bitmap);
    expect(worker.received.filter((m) => m.op === 'render')).toHaveLength(1);
  });

  it('caps the bitmap cache and closes evicted bitmaps', async () => {
    const worker = new FakeWorker();
    __setPdfiumWorkerFactory(() => worker);
    const engine = new PdfiumEngine();
    const { docId } = await engine.openDocument('C:/w/doc.pdf');

    // 13 distinct pages at one width → capacity 12 → page 0's bitmap evicted.
    for (let p = 0; p < 13; p++) await engine.renderPage(docId, p, 968, 2);
    expect(worker.bitmaps[0].close).toHaveBeenCalledTimes(1);
    expect(worker.bitmaps[12].close).not.toHaveBeenCalled();
  });

  it('closeDocument frees the document worker-side and evicts its bitmaps', async () => {
    const worker = new FakeWorker();
    __setPdfiumWorkerFactory(() => worker);
    const engine = new PdfiumEngine();
    const { docId } = await engine.openDocument('C:/w/doc.pdf');
    const rendered = await engine.renderPage(docId, 0, 968, 2);

    await engine.closeDocument('C:/w/doc.pdf');
    expect(worker.received.some((m) => m.op === 'close' && m.docId === docId)).toBe(true);
    expect((rendered.bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });

  it('cancels a stale render on abort and closes a bitmap that still arrives', async () => {
    const worker = new FakeWorker({ renderDelay: true });
    __setPdfiumWorkerFactory(() => worker);
    const engine = new PdfiumEngine();
    const { docId } = await engine.openDocument('C:/w/doc.pdf');

    const controller = new AbortController();
    const promise = engine.renderPage(docId, 3, 968, 2, controller.signal);
    // Let the render request reach the worker (bitmap created, held back).
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // Engine posts a cancel for the aborted render id.
    expect(worker.received.some((m) => m.op === 'cancel')).toBe(true);

    // The delayed bitmap now arrives with no waiter — the engine must close it.
    worker.flushRenders();
    await Promise.resolve();
    expect(worker.bitmaps[0].close).toHaveBeenCalledTimes(1);
  });
});
