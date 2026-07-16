// pdf.js single-page canvas renderer (plan Part 2.3) — formerly PdfRenderer.tsx,
// preserved VERBATIM as the automatic fallback. PdfRenderer.tsx is now the
// PDFium-WASM continuous-scroll orchestrator; when the fast path cannot render a
// document it drops to THIS component (ordinary-page pdf.js canvas is acceptable;
// the pathological 17 s page is the one case the orchestrator must NOT silently
// route here). Metric re-exports below keep `./PdfRenderer` and this module
// interchangeable for importers.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import * as Icons from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Keep this assignment in the module that renders <Document>/<Page>. Vite emits
// the matching pdfjs-dist worker as a local build asset, so PDF rendering neither
// depends on a CDN nor silently changes worker versions.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// Backing-pixel budget + fit-width math now live in lib/pdf/pdf-metrics.ts so
// the WASM raster path shares them (plan Part 1.1). Re-exported here so existing
// imports (and PdfRenderer.test.tsx) keep resolving them from this module.
import {
  boundedPdfDevicePixelRatio,
  fitPageWidth,
  MAX_PDF_BACKING_PIXELS,
  MAX_PDF_DEVICE_PIXEL_RATIO,
} from '../../lib/pdf/pdf-metrics';
export { boundedPdfDevicePixelRatio, fitPageWidth, MAX_PDF_BACKING_PIXELS, MAX_PDF_DEVICE_PIXEL_RATIO };

type WorkerKind = 'real' | 'fake' | 'unknown';

type PageMetrics = {
  pageNumber: number;
  renderKey: string;
  pageLoadMs?: number;
  getPageMs?: number;
  operatorListMs?: number;
  canvasMs?: number;
  paintMs?: number;
  textMs?: number;
  cssWidth?: number;
  cssHeight?: number;
  backingWidth?: number;
  backingHeight?: number;
  effectiveDpr?: number;
};

type PreparedPage = {
  pageNumber: number;
  aspectRatio: number;
  getPageMs: number;
  operatorListMs: number;
  pipelineStartedAt: number;
  paintStartedAt: number;
};

type PdfLoadingTaskWithWorker = {
  _worker?: { port?: unknown };
};

interface Props {
  filePath: string;
  pathType: 'windows' | 'wsl';
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function elapsedSince(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

function emitPdfTelemetry(
  filePath: string,
  event: string,
  details: Record<string, unknown> = {},
): void {
  console.info('[pdf-perf]', { event, filePath, ...details });
}

/** Public for focused unit coverage; fake workers use pdf.js's LoopbackPort. */
export function classifyPdfWorker(pdf: PDFDocumentProxy): WorkerKind {
  const task = pdf.loadingTask as unknown as PdfLoadingTaskWithWorker;
  const port = task._worker?.port;
  if (!port) return 'unknown';
  if (typeof Worker !== 'undefined' && port instanceof Worker) return 'real';
  if ((port as { constructor?: { name?: string } }).constructor?.name === 'LoopbackPort') return 'fake';
  return 'unknown';
}

function TimedPdfPage({
  filePath,
  pageNumber,
  width,
  scale,
  renderKey,
  preparedPage,
  onMetric,
}: {
  filePath: string;
  pageNumber: number;
  width: number;
  scale: number;
  renderKey: string;
  preparedPage: PreparedPage;
  onMetric: (metric: PageMetrics) => void;
}) {
  const renderStartedAt = useRef(preparedPage.pipelineStartedAt);
  const canvasRenderedAt = useRef<number | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const cssWidth = width * scale;
  const cssHeight = cssWidth * preparedPage.aspectRatio;
  const effectiveDpr = boundedPdfDevicePixelRatio(
    cssWidth,
    preparedPage.aspectRatio,
    window.devicePixelRatio,
  );
  const backingWidth = Math.floor(cssWidth * effectiveDpr);
  const backingHeight = Math.floor(cssHeight * effectiveDpr);

  useEffect(() => {
    emitPdfTelemetry(filePath, 'page-render-start', {
      pageNumber,
      width,
      scale,
      getPageMs: preparedPage.getPageMs,
      operatorListMs: preparedPage.operatorListMs,
      cssWidth,
      cssHeight,
      backingWidth,
      backingHeight,
      effectiveDpr,
      maxBackingPixels: MAX_PDF_BACKING_PIXELS,
    });
  }, [backingHeight, backingWidth, cssHeight, cssWidth, effectiveDpr, filePath, pageNumber, preparedPage.getPageMs, preparedPage.operatorListMs, scale, width]);

  const recordMetric = useCallback((patch: Partial<PageMetrics>) => {
    onMetric({ pageNumber, renderKey, ...patch });
  }, [onMetric, pageNumber, renderKey]);

  return (
    <Page
      pageNumber={pageNumber}
      width={width}
      scale={scale}
      devicePixelRatio={effectiveDpr}
      renderTextLayer={canvasReady}
      renderAnnotationLayer={canvasReady}
      onLoadSuccess={(_page: PDFPageProxy) => {
        const pageLoadMs = elapsedSince(renderStartedAt.current);
        emitPdfTelemetry(filePath, 'page-load-success', { pageNumber, elapsedMs: pageLoadMs });
        recordMetric({
          pageLoadMs,
          getPageMs: preparedPage.getPageMs,
          operatorListMs: preparedPage.operatorListMs,
          cssWidth,
          cssHeight,
          backingWidth,
          backingHeight,
          effectiveDpr,
        });

      }}
      onRenderSuccess={() => {
        canvasRenderedAt.current = nowMs();
        const canvasMs = elapsedSince(renderStartedAt.current);
        const paintMs = elapsedSince(preparedPage.paintStartedAt);
        emitPdfTelemetry(filePath, 'page-canvas-render-success', {
          pageNumber,
          elapsedMs: canvasMs,
          paintAfterOperatorListMs: paintMs,
          width,
          scale,
          cssWidth,
          cssHeight,
          backingWidth,
          backingHeight,
          effectiveDpr,
        });
        recordMetric({ canvasMs, paintMs, operatorListMs: preparedPage.operatorListMs });
        // Canvas first: only ask pdf.js for selectable text and annotations after
        // the visible bitmap has completed and React-PDF has made it visible.
        setCanvasReady(true);
      }}
      onRenderTextLayerSuccess={() => {
        const textMs = elapsedSince(renderStartedAt.current);
        const afterCanvasMs = canvasRenderedAt.current === null
          ? undefined
          : elapsedSince(canvasRenderedAt.current);
        emitPdfTelemetry(filePath, 'page-text-layer-render-success', {
          pageNumber,
          elapsedMs: textMs,
          afterCanvasMs,
        });
        recordMetric({ textMs });
      }}
      className="shadow-lg"
    />
  );
}

function PdfRendererSession({ filePath, pathType }: Props) {
  const src = `media://file/${encodeURIComponent(filePath)}`;
  const documentStartedAt = useRef(nowMs());
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workerKind, setWorkerKind] = useState<WorkerKind>('unknown');
  const [documentLoadMs, setDocumentLoadMs] = useState<number | null>(null);
  const [pageMetrics, setPageMetrics] = useState<PageMetrics | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [preparedPage, setPreparedPage] = useState<PreparedPage | null>(null);

  useEffect(() => {
    emitPdfTelemetry(filePath, 'document-load-start', { workerSrc: pdfjs.GlobalWorkerOptions.workerSrc });
  }, [filePath]);

  useLayoutEffect(() => {
    const viewport = viewerRef.current;
    if (!viewport) return;

    const measure = () => {
      const nextWidth = fitPageWidth(viewport.clientWidth);
      if (nextWidth !== null) setFitWidth((current) => current === nextWidth ? current : nextWidth);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (!pdfDocument) return;
    let cancelled = false;
    const pipelineStartedAt = nowMs();
    setPreparedPage(null);
    setPageMetrics(null);
    pdfDocument.getPage(pageNumber).then(async (page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1 });
      const getPageMs = elapsedSince(pipelineStartedAt);
      const operatorListStartedAt = nowMs();
      await page.getOperatorList();
      if (cancelled) return;
      const operatorListMs = elapsedSince(operatorListStartedAt);
      const paintStartedAt = nowMs();
      setPreparedPage({
        pageNumber,
        aspectRatio: viewport.height / viewport.width,
        getPageMs,
        operatorListMs,
        pipelineStartedAt,
        paintStartedAt,
      });
      emitPdfTelemetry(filePath, 'page-get-success', {
        pageNumber,
        elapsedMs: getPageMs,
        pageWidth: viewport.width,
        pageHeight: viewport.height,
      });
      emitPdfTelemetry(filePath, 'page-operator-list-success', {
        pageNumber,
        elapsedMs: operatorListMs,
        getPageMs,
      });
    }).catch((err: Error) => {
      if (!cancelled) {
        emitPdfTelemetry(filePath, 'page-get-error', { pageNumber, message: err.message });
      }
    });
    return () => { cancelled = true; };
  }, [filePath, pageNumber, pdfDocument]);

  function onDocumentLoadSuccess(pdf: PDFDocumentProxy) {
    const elapsedMs = elapsedSince(documentStartedAt.current);
    const detectedWorker = classifyPdfWorker(pdf);
    setNumPages(pdf.numPages);
    setPdfDocument(pdf);
    setLoading(false);
    setError(null);
    setWorkerKind(detectedWorker);
    setDocumentLoadMs(elapsedMs);
    emitPdfTelemetry(filePath, 'document-load-success', {
      elapsedMs,
      numPages: pdf.numPages,
      worker: detectedWorker,
    });
    if (detectedWorker !== 'real') {
      console.error('[pdf-perf] Expected a real pdf.js Worker, received:', detectedWorker);
    }
  }

  function onDocumentLoadError(err: Error) {
    console.error('Error loading PDF:', err);
    emitPdfTelemetry(filePath, 'document-load-error', {
      elapsedMs: elapsedSince(documentStartedAt.current),
      message: err.message,
    });
    setLoading(false);
    setError(err.message || 'Failed to load PDF');
  }

  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.5));
  const handlePrevPage = () => setPageNumber(prev => Math.max(prev - 1, 1));
  const handleNextPage = () => setPageNumber(prev => Math.min(prev + 1, numPages || 1));
  const renderKey = `${pageNumber}:${fitWidth ?? 'measuring'}:${scale}`;

  const onPageMetric = useCallback((metric: PageMetrics) => {
    setPageMetrics((current) => {
      if (metric.renderKey !== renderKey) return current;
      const base = current?.renderKey === metric.renderKey
        ? current
        : { pageNumber: metric.pageNumber, renderKey: metric.renderKey };
      return { ...base, ...metric };
    });
  }, [renderKey]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-[#525659]">
        <div className="text-center p-8">
          <Icons.FileWarning className="w-10 h-10 text-gray-300 mx-auto mb-4" />
          <div className="text-gray-300 font-sans text-sm mb-2">Failed to load PDF</div>
          <div className="text-gray-300 font-sans text-[13px] mb-4 max-w-md break-all">{error}</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="px-4 py-2 text-[13px] font-sans text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open externally
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#525659] overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-2 bg-[#323639] text-gray-200 border-b border-black/20 shadow-sm shrink-0 z-10">
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-surface-0/20 rounded p-0.5">
            <button
              onClick={handlePrevPage}
              disabled={pageNumber <= 1}
              className="p-1 hover:bg-white/10 rounded disabled:opacity-30 transition-colors"
              aria-label="Previous PDF page"
            >
              <Icons.ChevronUp className="w-4 h-4" />
            </button>
            <span className="px-3 text-[13px] font-sans min-w-[60px] text-center select-none">
              {pageNumber} / {numPages || '--'}
            </span>
            <button
              onClick={handleNextPage}
              disabled={!numPages || pageNumber >= numPages}
              className="p-1 hover:bg-white/10 rounded disabled:opacity-30 transition-colors"
              aria-label="Next PDF page"
            >
              <Icons.ChevronDown className="w-4 h-4" />
            </button>
          </div>

          <div className="h-4 w-px bg-white/10" />

          <div className="flex items-center bg-surface-0/20 rounded p-0.5">
            <button
              onClick={handleZoomOut}
              className="p-1 hover:bg-white/10 rounded transition-colors"
              aria-label="Zoom PDF out"
            >
              <Icons.Minus className="w-4 h-4" />
            </button>
            <span className="px-3 text-[13px] font-sans min-w-[50px] text-center select-none" title="Relative to fit width">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="p-1 hover:bg-white/10 rounded transition-colors"
              aria-label="Zoom PDF in"
            >
              <Icons.Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div
          className="text-[11px] font-mono text-gray-400 truncate text-right"
          data-testid="pdf-telemetry"
          title={`Document ${documentLoadMs ?? '--'} ms; getPage ${pageMetrics?.getPageMs ?? '--'} ms; ops ${pageMetrics?.operatorListMs ?? '--'} ms; canvas ${pageMetrics?.canvasMs ?? '--'} ms; paint ${pageMetrics?.paintMs ?? '--'} ms; CSS ${pageMetrics?.cssWidth ?? '--'}x${pageMetrics?.cssHeight ?? '--'}; backing ${pageMetrics?.backingWidth ?? '--'}x${pageMetrics?.backingHeight ?? '--'}; DPR ${pageMetrics?.effectiveDpr ?? '--'}; text ${pageMetrics?.textMs ?? '--'} ms; worker ${workerKind}`}
        >
          worker {workerKind}
          {pageMetrics?.operatorListMs !== undefined && ` · ops ${pageMetrics.operatorListMs}ms`}
          {pageMetrics?.canvasMs !== undefined && ` · canvas ${pageMetrics.canvasMs}ms`}
          {pageMetrics?.paintMs !== undefined && ` · paint ${pageMetrics.paintMs}ms`}
          {pageMetrics?.textMs !== undefined && ` · text ${pageMetrics.textMs}ms`}
        </div>
      </div>

      <div ref={viewerRef} className="flex-1 overflow-auto flex justify-center p-4 bg-[#525659] relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#525659] z-20">
            <div className="flex items-center gap-3 text-white/70">
              <Icons.Loader2 className="w-5 h-5 animate-spin" />
              <span className="font-sans text-sm">Loading PDF...</span>
            </div>
          </div>
        )}

        <Document
          file={src}
          onSourceSuccess={() => emitPdfTelemetry(filePath, 'document-source-success', {
            elapsedMs: elapsedSince(documentStartedAt.current),
          })}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          className="shadow-2xl self-start"
          loading={null}
        >
          {fitWidth !== null && preparedPage?.pageNumber === pageNumber && (
            <TimedPdfPage
              key={renderKey}
              filePath={filePath}
              pageNumber={pageNumber}
              width={fitWidth}
              scale={scale}
              renderKey={renderKey}
              preparedPage={preparedPage}
              onMetric={onPageMetric}
            />
          )}
        </Document>
      </div>
    </div>
  );
}

export default function PdfJsFallbackRenderer(props: Props) {
  // FileContentArea is reused across tab switches. Key the session so page,
  // timing, fit, and worker state cannot leak from the previously viewed PDF.
  return <PdfRendererSession key={`${props.pathType}:${props.filePath}`} {...props} />;
}
