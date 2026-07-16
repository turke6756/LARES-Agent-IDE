// @vitest-environment jsdom
//
// PdfPageSlot tests (plan Part 2.4): the three stacked layers of one continuous-
// reader page. Covers the read-only overlay projection, the transparent text
// layer, virtualization (off-screen slots mount nothing heavy), and the
// pathological-page error state that must offer retry / open-externally and
// NEVER silently swap to the pdf.js canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SelectionComment } from '../../../shared/types';
import type { PdfSelectionAnchorV1 } from '../../../shared/pdf-annotations';

const engineMock = vi.hoisted(() => ({ renderPage: vi.fn() }));
vi.mock('../../lib/pdf/pdfium-engine', () => ({ pdfiumEngine: engineMock }));

import PdfPageSlot, { PdfTextLayer, PdfOverlayLayer } from './PdfPageSlot';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  engineMock.renderPage.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makePdfComment(overrides: Partial<SelectionComment> & { anchor: PdfSelectionAnchorV1 }): SelectionComment {
  const { anchor, ...rest } = overrides;
  return {
    id: 'c1', workspaceId: 'ws', targetType: 'file', kind: 'comment', anchorType: 'pdf',
    pdfAnchor: anchor, filePath: 'a.pdf', pathType: 'windows', rootDirectory: 'C:\\ws',
    docHash: 'fp', anchorStart: null, anchorEnd: null, lineStart: null, lineEnd: null,
    prefix: null, suffix: null, quotedText: 'q', body: 'a note', status: 'draft',
    sentToAgentId: null, createdAt: '', updatedAt: '', sentAt: null, resolvedAt: null,
    ...rest,
  };
}

function anchorOnPage(pageIndex: number): PdfSelectionAnchorV1 {
  return {
    version: 1, fingerprint: 'fp',
    pages: [{
      pageIndex,
      start: { itemIndex: 0, charOffset: 0 },
      end: { itemIndex: 1, charOffset: 3 },
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
    }],
    prefix: '', suffix: '',
  };
}

const textModelStub = (items: Array<{ itemIndex: number; str: string; rect: { x: number; y: number; width: number; height: number } }>) => ({
  getPageText: vi.fn(async (pageIndex: number) => ({
    pageIndex,
    text: items.map((i) => i.str).join(''),
    items: items.map((i) => ({ ...i, charStart: 0, charEnd: i.str.length, dir: 'ltr', hasEOL: false })),
  })),
});

describe('PdfOverlayLayer (read-only projection, plan 2.4 z2)', () => {
  it('paints this page\'s highlight rects + a pin, filters other pages, and never captures pointer events', () => {
    const onPage = makePdfComment({ id: 'here', anchor: anchorOnPage(0) });
    const elsewhere = makePdfComment({ id: 'other', anchor: anchorOnPage(1) });

    act(() => {
      root.render(
        <PdfOverlayLayer comments={[onPage, elsewhere]} pageIndex={0} cssWidth={500} cssHeight={600} rotation={0} />,
      );
    });

    const layer = container.querySelector('[data-testid="pdf-overlay-layer"]') as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.style.pointerEvents).toBe('none');
    expect(container.querySelector('[data-testid="pdf-highlight-here"]')).not.toBeNull();
    // Comment (has a body) → gets a pin; the other page is filtered out entirely.
    expect(container.querySelector('[data-testid="pdf-overlay-pin-here"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pdf-highlight-other"]')).toBeNull();

    // Projected rect: x = 0.1 * 500 = 50, width = 0.2 * 500 = 100.
    const rect = container.querySelector('[data-testid="pdf-highlight-here"]') as HTMLElement;
    expect(rect.style.left).toBe('50px');
    expect(rect.style.width).toBe('100px');
  });

  it('a plain highlight (no body) paints its rect but no pin', () => {
    const hl = makePdfComment({ id: 'hl', kind: 'highlight', body: '', anchor: anchorOnPage(0) });
    act(() => {
      root.render(<PdfOverlayLayer comments={[hl]} pageIndex={0} cssWidth={400} cssHeight={500} rotation={0} />);
    });
    expect(container.querySelector('[data-testid="pdf-highlight-hl"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pdf-overlay-pin-hl"]')).toBeNull();
  });

  it('renders nothing when no comment anchors this page', () => {
    const elsewhere = makePdfComment({ id: 'x', anchor: anchorOnPage(2) });
    act(() => {
      root.render(<PdfOverlayLayer comments={[elsewhere]} pageIndex={0} cssWidth={400} cssHeight={500} rotation={0} />);
    });
    expect(container.querySelector('[data-testid="pdf-overlay-layer"]')).toBeNull();
  });
});

describe('PdfTextLayer (transparent selectable spans, plan 2.4 z1)', () => {
  it('renders one positioned span per non-empty text item and stays transparent', () => {
    const pageText = {
      pageIndex: 0,
      text: 'Hi',
      items: [
        { itemIndex: 0, str: 'Hi', charStart: 0, charEnd: 2, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, dir: 'ltr', hasEOL: false },
        { itemIndex: 1, str: '', charStart: 2, charEnd: 2, rect: { x: 0, y: 0, width: 0, height: 0 }, dir: 'ltr', hasEOL: false },
      ],
    };
    act(() => {
      root.render(<PdfTextLayer pageText={pageText} cssWidth={500} cssHeight={600} rotation={0} />);
    });
    const layer = container.querySelector('[data-testid="pdf-text-layer"]') as HTMLElement;
    expect(layer.style.color).toBe('transparent');
    const spans = container.querySelectorAll('[data-testid="pdf-text-layer"] span');
    // The empty item is skipped.
    expect(spans.length).toBe(1);
    expect((spans[0] as HTMLElement).textContent).toBe('Hi');
    expect((spans[0] as HTMLElement).style.left).toBe('50px'); // 0.1 * 500
  });
});

describe('PdfPageSlot', () => {
  const baseProps = {
    docId: 1, pageIndex: 0, rotation: 0, reservedAspect: 792 / 612,
    cssWidth: 500, rasterCssWidth: 500, dpr: 2,
    comments: [] as SelectionComment[],
    onPageError: vi.fn(), onOpenExternally: vi.fn(), registerRef: vi.fn(),
  };

  it('an inactive (virtualized-out) slot reserves height but mounts no canvas/text/overlay', () => {
    act(() => {
      root.render(
        <PdfPageSlot {...baseProps} active={false} textModel={textModelStub([]) as never} />,
      );
    });
    const slot = container.querySelector('[data-testid="pdf-page-slot-0"]') as HTMLElement;
    expect(slot).not.toBeNull();
    // Reserved height = cssWidth * reservedAspect = 500 * (792/612) ≈ 647px.
    expect(slot.style.height).toBe(`${500 * (792 / 612)}px`);
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('[data-testid="pdf-text-layer"]')).toBeNull();
    expect(engineMock.renderPage).not.toHaveBeenCalled();
  });

  it('an active slot rasters the page via the engine and mounts the canvas', async () => {
    engineMock.renderPage.mockResolvedValue({
      bitmap: { close: vi.fn() }, backingWidth: 1000, backingHeight: 1294,
      cssWidth: 500, cssHeight: 647, aspect: 792 / 612,
    });
    act(() => {
      root.render(
        <PdfPageSlot {...baseProps} active textModel={textModelStub([{ itemIndex: 0, str: 'x', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.05 } }]) as never} />,
      );
    });
    await flush();
    expect(engineMock.renderPage).toHaveBeenCalledWith(1, 0, 500, 2, expect.anything());
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('a pathological-page render error shows retry + open-externally and NEVER swaps to pdf.js', async () => {
    const onPageError = vi.fn();
    engineMock.renderPage.mockRejectedValue(new Error('constructPath exploded'));
    act(() => {
      root.render(
        <PdfPageSlot {...baseProps} active onPageError={onPageError} textModel={textModelStub([]) as never} />,
      );
    });
    await flush();

    expect(onPageError).toHaveBeenCalledWith(0, expect.any(Error));
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Retry');
    expect(buttons).toContain('Open externally');
    // The error state replaces the canvas — there is no pdf.js canvas swap.
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.textContent).toContain("Couldn't render page 1");
  });
});
