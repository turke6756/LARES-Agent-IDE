// @vitest-environment jsdom
//
// Orchestrator tests (plan Part 2.3). The old react-pdf <Document>/<Page>
// behaviour is now PdfJsFallbackRenderer's — covered by its own test. Here we
// exercise the continuous-scroll shell: it opens the PDFium doc + text model,
// stacks one PdfPageSlot per page at fit-width, owns zoom, and falls back to the
// pdf.js renderer on a whole-document open failure. The engine, text model, slot
// and fallback are mocked so the shell is tested in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const engineMock = vi.hoisted(() => ({
  openDocument: vi.fn(),
  closeDocument: vi.fn(async () => {}),
}));
vi.mock('../../lib/pdf/pdfium-engine', () => ({ pdfiumEngine: engineMock }));

const textModelMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../lib/pdf/pdf-text-model', () => ({
  openPdfTextModel: (filePath: string) => textModelMock.open(filePath),
}));

const slotMock = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('./PdfPageSlot', async () => {
  const ReactModule = await import('react');
  return {
    default: (props: Record<string, unknown>) => {
      slotMock.props.push(props);
      return ReactModule.createElement('div', {
        'data-testid': `slot-${props.pageIndex}`,
        'data-css-width': String(props.cssWidth),
        'data-active': String(props.active),
      });
    },
  };
});

vi.mock('./PdfJsFallbackRenderer', async () => {
  const ReactModule = await import('react');
  return {
    default: () => ReactModule.createElement('div', { 'data-testid': 'pdfjs-fallback' }, 'fallback'),
  };
});

import PdfRenderer, {
  boundedPdfDevicePixelRatio,
  fitPageWidth,
  MAX_PDF_BACKING_PIXELS,
  MAX_PDF_DEVICE_PIXEL_RATIO,
} from './PdfRenderer';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() { this.callback([], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}

class NoopIntersectionObserver {
  constructor(_cb: unknown) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeTextModel() {
  return {
    getMeta: () => ({ fingerprint: 'fp', pageCount: 3, pageLabels: null }),
    getPageInfo: vi.fn(async (pageIndex: number) => ({
      pageIndex, cropWidth: 612, cropHeight: 792, rotation: 0,
    })),
    getPageText: vi.fn(async (pageIndex: number) => ({ pageIndex, text: '', items: [] })),
    destroy: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;
let clientWidthSpy: ReturnType<typeof vi.spyOn>;
let openFile: ReturnType<typeof vi.fn>;

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  slotMock.props.length = 0;
  engineMock.openDocument.mockReset();
  engineMock.closeDocument.mockClear();
  textModelMock.open.mockReset();
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
  clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  openFile = vi.fn();
  (window as unknown as { api: unknown }).api = { system: { openFile } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  clientWidthSpy.mockRestore();
  vi.unstubAllGlobals();
  container.remove();
});

async function mountReader() {
  engineMock.openDocument.mockResolvedValue({ docId: 7, pageCount: 3, sizes: new Map() });
  textModelMock.open.mockResolvedValue(makeTextModel());
  await act(async () => {
    root.render(React.createElement(PdfRenderer, {
      filePath: 'C:\\workspace\\paper.pdf',
      pathType: 'windows',
    }));
  });
  await flush();
}

describe('PdfRenderer orchestrator', () => {
  it('re-exports the shared metric seam Phase-1 consumers import from this module', () => {
    expect(fitPageWidth(1000)).toBe(968);
    expect(MAX_PDF_BACKING_PIXELS).toBe(4_000_000);
    expect(MAX_PDF_DEVICE_PIXEL_RATIO).toBe(2);
    expect(boundedPdfDevicePixelRatio(500, 1.3, 3)).toBe(2);
  });

  it('opens the PDFium doc + text model and stacks one slot per page at fit-width', async () => {
    await mountReader();

    expect(engineMock.openDocument).toHaveBeenCalledWith('C:\\workspace\\paper.pdf');
    expect(textModelMock.open).toHaveBeenCalledWith('C:\\workspace\\paper.pdf');

    const slots = container.querySelectorAll('[data-testid^="slot-"]');
    expect(slots.length).toBe(3);
    // Opens at fit-width: scale 100 %, cssWidth == fitPageWidth(1000) == 968.
    expect(slots[0].getAttribute('data-css-width')).toBe('968');
    expect(container.querySelector('[data-testid="pdf-page-indicator"]')?.textContent).toBe('1 / 3');
    expect(container.textContent).toContain('100%');
  });

  it('owns zoom — the toolbar + button widens the page and updates the percentage', async () => {
    await mountReader();
    const zoomIn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Zoom PDF in')!;

    await act(async () => { zoomIn.click(); });
    await flush();

    expect(container.textContent).toContain('125%');
    // 100 % → 125 %: the display width scales immediately (CSS-scale before the
    // debounced re-raster). round(968 * 1.25) == 1210.
    const firstSlot = container.querySelector('[data-testid="slot-0"]');
    expect(firstSlot?.getAttribute('data-css-width')).toBe('1210');
  });

  it('falls back to the pdf.js renderer when the PDFium document fails to open', async () => {
    engineMock.openDocument.mockRejectedValue(new Error('wasm boom'));
    textModelMock.open.mockResolvedValue(makeTextModel());
    await act(async () => {
      root.render(React.createElement(PdfRenderer, {
        filePath: 'C:\\workspace\\broken.pdf',
        pathType: 'windows',
      }));
    });
    await flush();

    expect(container.querySelector('[data-testid="pdfjs-fallback"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="slot-"]').length).toBe(0);
  });

  it('the toolbar Open-externally control routes to the system viewer', async () => {
    await mountReader();
    const openBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Open externally')!;
    await act(async () => { openBtn.click(); });
    expect(openFile).toHaveBeenCalledWith('C:\\workspace\\paper.pdf', 'windows');
  });
});
