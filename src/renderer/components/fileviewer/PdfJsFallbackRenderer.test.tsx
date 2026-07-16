// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const reactPdfMock = vi.hoisted(() => ({
  pageProps: [] as Array<Record<string, unknown>>,
  workerOptions: { workerSrc: '' },
}));

vi.mock('react-pdf', async () => {
  const ReactModule = await import('react');
  return {
    pdfjs: {
      GlobalWorkerOptions: reactPdfMock.workerOptions,
      version: 'test',
    },
    Document: ({ children, file, onSourceSuccess, onLoadSuccess }: any) => {
      ReactModule.useEffect(() => {
        onSourceSuccess?.();
        onLoadSuccess?.({
          numPages: 3,
          loadingTask: { _worker: { port: new Worker('pdf.worker.mjs') } },
          getPage: async (pageNumber: number) => ({
            pageNumber,
            getViewport: () => ({ width: 612, height: 792 }),
            getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
          }),
        });
        // The real React-PDF Document reloads only when its source changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [file]);
      return ReactModule.createElement('div', { 'data-testid': 'document' }, children);
    },
    Page: (props: any) => {
      reactPdfMock.pageProps.push(props);
      ReactModule.useEffect(() => {
        props.onLoadSuccess?.({
          pageNumber: props.pageNumber,
          getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
        });
        props.onRenderSuccess?.({ pageNumber: props.pageNumber });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.pageNumber, props.width, props.scale]);
      ReactModule.useEffect(() => {
        if (props.renderTextLayer) props.onRenderTextLayerSuccess?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.renderTextLayer]);
      return ReactModule.createElement('div', {
        'data-testid': 'page',
        'data-page': props.pageNumber,
        'data-width': props.width,
        'data-text': props.renderTextLayer,
      });
    },
  };
});

import PdfJsFallbackRenderer, {
  boundedPdfDevicePixelRatio,
  classifyPdfWorker,
  fitPageWidth,
  MAX_PDF_BACKING_PIXELS,
} from './PdfJsFallbackRenderer';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class TestWorker {
  constructor(public readonly url: string) {}
}

class LoopbackPort {}

class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() { this.callback([], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;
let clientWidthSpy: ReturnType<typeof vi.spyOn>;

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  reactPdfMock.pageProps.length = 0;
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
  clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
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

describe('PdfJsFallbackRenderer quick performance improvements', () => {
  it('uses a local worker URL instead of a CDN', () => {
    expect(reactPdfMock.workerOptions.workerSrc).toContain('pdf.worker.min.mjs');
    expect(reactPdfMock.workerOptions.workerSrc).not.toContain('unpkg.com');
  });

  it('classifies native and loopback pdf.js worker ports', () => {
    const real = {
      loadingTask: { _worker: { port: new Worker('real-worker.mjs') } },
    } as unknown as PDFDocumentProxy;
    const fake = {
      loadingTask: { _worker: { port: new LoopbackPort() } },
    } as unknown as PDFDocumentProxy;

    expect(classifyPdfWorker(real)).toBe('real');
    expect(classifyPdfWorker(fake)).toBe('fake');
    expect(classifyPdfWorker({ loadingTask: {} } as unknown as PDFDocumentProxy)).toBe('unknown');
  });

  it('computes fit width from the viewport gutter', () => {
    expect(fitPageWidth(1000)).toBe(968);
    expect(fitPageWidth(32)).toBeNull();
    expect(fitPageWidth(Number.NaN)).toBeNull();
  });

  it('caps DPR at 2 and enforces the total backing-pixel budget', () => {
    expect(boundedPdfDevicePixelRatio(500, 1.3, 3)).toBe(2);
    const bounded = boundedPdfDevicePixelRatio(2000, 1.5, 2);
    const backingPixels = (2000 * bounded) * (3000 * bounded);
    expect(backingPixels).toBeCloseTo(MAX_PDF_BACKING_PIXELS, 5);
    expect(bounded).toBeLessThan(2);
  });

  it('opens at fit width and mounts the text layer only after canvas success', async () => {
    await act(async () => {
      root.render(React.createElement(PdfJsFallbackRenderer, {
        filePath: 'C:\\workspace\\sample.pdf',
        pathType: 'windows',
      }));
    });
    await flush();

    const pageOneRenders = reactPdfMock.pageProps.filter((props) => props.pageNumber === 1);
    expect(pageOneRenders.length).toBeGreaterThanOrEqual(2);
    expect(pageOneRenders[0]).toMatchObject({
      width: 968,
      scale: 1,
      devicePixelRatio: expect.any(Number),
      renderTextLayer: false,
    });
    expect(pageOneRenders.at(-1)).toMatchObject({ width: 968, scale: 1, renderTextLayer: true });
    expect(container.querySelector('[data-testid="pdf-telemetry"]')?.textContent).toContain('worker real');
    expect(container.querySelector('[data-testid="pdf-telemetry"]')?.textContent).toContain('canvas');
    expect(container.querySelector('[data-testid="pdf-telemetry"]')?.textContent).toContain('text');
  });
});
