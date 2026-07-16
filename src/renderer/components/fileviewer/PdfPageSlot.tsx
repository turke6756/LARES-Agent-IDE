// One page of the continuous PDFium reader (plan Part 2.4).
//
// Three stacked layers inside a single positioned box whose height is reserved
// from lightweight page metadata (so the scrollbar is stable before any raster):
//
//   z0  <canvas>   — the PDFium ImageBitmap for this page (transferred, never a
//                    PNG/JPEG). Displayed at the CSS width; when the bitmap was
//                    rastered at a debounced width it is simply CSS-scaled until
//                    the crisp re-raster lands.
//   z1  text layer — the paint-disabled pdf.js text model rendered as transparent,
//                    selectable spans. A PDF-SPECIFIC adapter (page/item/rect
//                    geometry from pdf-text-model), not markdown's document-range
//                    SelectionSurface — transparent-text alignment, ligatures,
//                    rotated crop boxes and zoom re-render all need PDF geometry.
//   z2  overlay    — persisted highlight rects + comment pins, re-projected on
//                    zoom/rotate via projectNormalizedPdfRect. SCOPE (Phase 2):
//                    read-only PROJECT + PAINT of persisted anchors. The capture/
//                    create UX + sidebar wiring is Phase 3 — this keeps that seam.
//
// Off-screen slots (virtualized out) keep their reserved height but mount none of
// the three layers.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import type { SelectionComment } from '../../../shared/types';
import { projectNormalizedPdfRect } from '../../../shared/pdf-annotations';
import type { PdfRect, PxRect } from '../../../shared/pdf-annotations';
import { pdfiumEngine } from '../../lib/pdf/pdfium-engine';
import type { PdfTextModel } from '../../lib/pdf/pdf-text-model';
import type { NormalizedPageText } from '../../lib/pdf/pdf-text-geometry';
import {
  isMeaningfulRegionDrag,
  PDF_ITEM_ATTR,
  PDF_PAGE_ATTR,
  rectFromDragPoints,
  unprojectPxRect,
} from '../../lib/pdf/pdf-selection-capture';

export interface PdfPageSlotProps {
  docId: number;
  pageIndex: number;
  pageLabel?: string;
  rotation: number;
  /** Display aspect (height / width) for the reserved-height spacer. */
  reservedAspect: number;
  /** Display width in CSS px (layout + on-screen size of the bitmap). */
  cssWidth: number;
  /** Width to raster at (debounced during a zoom gesture). */
  rasterCssWidth: number;
  dpr: number;
  /** Within ~1 viewport — raster + text + overlay only when true. */
  active: boolean;
  textModel: PdfTextModel;
  /** Persisted PDF comments/highlights already filtered to THIS page. */
  comments: SelectionComment[];
  onPageError: (pageIndex: number, err: Error) => void;
  onOpenExternally: () => void;
  registerRef: (pageIndex: number, el: HTMLElement | null) => void;
  // ── Phase 3 (capture + interaction) ──
  /** Region-note mode is armed: mount the rubber-band layer, mute z1 text. */
  regionMode?: boolean;
  onRegion?: (pageIndex: number, rect: PdfRect, pxRect: PxRect) => void;
  onPinClick?: (comment: SelectionComment) => void;
  flashCommentId?: string | null;
}

type RasterState =
  | { kind: 'idle' }
  | { kind: 'rendering' }
  | { kind: 'ready'; cssHeight: number }
  | { kind: 'error'; message: string };

export default function PdfPageSlot(props: PdfPageSlotProps) {
  const {
    docId, pageIndex, rotation, reservedAspect, cssWidth, rasterCssWidth, dpr,
    active, textModel, comments, onPageError, onOpenExternally, registerRef,
    regionMode = false, onRegion, onPinClick, flashCommentId,
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [raster, setRaster] = useState<RasterState>({ kind: 'idle' });
  const [pageText, setPageText] = useState<NormalizedPageText | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // Register for the orchestrator's IntersectionObserver.
  useEffect(() => {
    registerRef(pageIndex, wrapRef.current);
    return () => registerRef(pageIndex, null);
  }, [pageIndex, registerRef]);

  // z0 — raster. Cancels a stale render (width/zoom change or unmount) via the
  // AbortSignal so the worker drops the superseded job.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let disposed = false;
    setRaster((prev) => (prev.kind === 'ready' ? prev : { kind: 'rendering' }));
    pdfiumEngine
      .renderPage(docId, pageIndex, rasterCssWidth, dpr, controller.signal)
      .then((rendered) => {
        if (disposed) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = rendered.backingWidth;
        canvas.height = rendered.backingHeight;
        const gtx = canvas.getContext('2d');
        if (gtx) gtx.drawImage(rendered.bitmap, 0, 0);
        setRaster({ kind: 'ready', cssHeight: rendered.cssHeight });
      })
      .catch((err: unknown) => {
        if (disposed || controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : String(err);
        setRaster({ kind: 'error', message });
        onPageError(pageIndex, err instanceof Error ? err : new Error(message));
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [active, docId, pageIndex, rasterCssWidth, dpr, retryToken, onPageError]);

  // z1 — text model for this page (only while active).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    textModel
      .getPageText(pageIndex)
      .then((t) => { if (!cancelled) setPageText(t); })
      .catch(() => { /* text layer is best-effort; the reader still paints */ });
    return () => { cancelled = true; };
  }, [active, pageIndex, textModel]);

  // Height: reserved from metadata until the raster reports its exact CSS height.
  const reservedHeight = cssWidth * reservedAspect;
  const displayHeight = raster.kind === 'ready' ? raster.cssHeight : reservedHeight;

  return (
    <div
      ref={wrapRef}
      data-testid={`pdf-page-slot-${pageIndex}`}
      data-page-index={pageIndex}
      className="relative mx-auto shadow-lg bg-white"
      style={{ width: cssWidth, height: displayHeight }}
    >
      {active && raster.kind !== 'error' && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0"
          style={{ width: cssWidth, height: displayHeight, zIndex: 0 }}
        />
      )}

      {active && raster.kind === 'rendering' && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 0 }}>
          <Icons.Loader2 className="w-5 h-5 animate-spin text-gray-400" />
        </div>
      )}

      {active && raster.kind === 'error' && (
        <PageErrorState
          pageIndex={pageIndex}
          message={raster.message}
          onRetry={() => { setRaster({ kind: 'idle' }); setRetryToken((n) => n + 1); }}
          onOpenExternally={onOpenExternally}
        />
      )}

      {active && pageText && raster.kind !== 'error' && (
        <PdfTextLayer
          pageText={pageText}
          cssWidth={cssWidth}
          cssHeight={displayHeight}
          rotation={rotation}
          interactive={!regionMode}
        />
      )}

      {active && raster.kind !== 'error' && (
        <PdfOverlayLayer
          comments={comments}
          pageIndex={pageIndex}
          cssWidth={cssWidth}
          cssHeight={displayHeight}
          rotation={rotation}
          onPinClick={onPinClick}
          flashCommentId={flashCommentId}
        />
      )}

      {active && regionMode && onRegion && raster.kind !== 'error' && (
        <PdfRegionCaptureLayer
          pageIndex={pageIndex}
          cssWidth={cssWidth}
          cssHeight={displayHeight}
          rotation={rotation}
          onRegion={onRegion}
        />
      )}
    </div>
  );
}

// ── z0 error state — NEVER an automatic pdf.js swap on the pathological page ──

function PageErrorState({
  pageIndex, message, onRetry, onOpenExternally,
}: {
  pageIndex: number;
  message: string;
  onRetry: () => void;
  onOpenExternally: () => void;
}) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#f3f3f3] text-center p-6"
      style={{ zIndex: 3 }}
    >
      <Icons.FileWarning className="w-8 h-8 text-gray-400" />
      <div className="text-[13px] font-sans text-gray-600 max-w-xs break-words">
        Couldn&apos;t render page {pageIndex + 1}.
      </div>
      <div className="text-[11px] font-mono text-gray-400 max-w-xs break-all">{message}</div>
      <div className="flex items-center gap-2">
        <button onClick={onRetry} className="px-3 py-1 text-[12px] font-sans text-accent-blue border border-accent-blue/40 hover:bg-accent-blue/10 rounded transition-colors">
          Retry
        </button>
        <button onClick={onOpenExternally} className="px-3 py-1 text-[12px] font-sans text-gray-600 border border-gray-400/40 hover:bg-black/5 rounded transition-colors">
          Open externally
        </button>
      </div>
    </div>
  );
}

// ── z1 — selectable transparent text layer (PDF-specific adapter) ─────────────

export function PdfTextLayer({
  pageText, cssWidth, cssHeight, rotation, interactive = true,
}: {
  pageText: NormalizedPageText;
  cssWidth: number;
  cssHeight: number;
  rotation: number;
  /** False while a region drag owns the pointer — the transparent text must not
   *  swallow the drag or start a text selection under the rubber band. */
  interactive?: boolean;
}) {
  const box = { width: cssWidth, height: cssHeight };
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Width-normalize every span to the width the PDF DECLARES for that item.
  //
  // A span is positioned at the item's projected origin and sized only by
  // `fontSize: px.height`, so its glyphs advance at the WEB font's natural
  // widths — which are not the embedded PDF font's. Measured live on a real
  // journal PDF the layer ran ~6.5 % narrow, so each span's glyphs drifted
  // progressively left of the canvas glyphs beneath them: the "same text,
  // slightly shifted" ghost, and a selection band that never lines up with the
  // word under it. pdf.js solves this the same way — squeeze/stretch the span
  // horizontally onto the declared advance width.
  //
  // Runs in layout (before paint, so no flicker) and re-runs whenever geometry
  // changes. Reads/writes are BATCHED — clear every transform, then measure
  // every width, then write every transform — so N spans cost one reflow rather
  // than N. `transform` never affects layout, hence the clear-before-measure.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const spans = Array.from(
      host.querySelectorAll<HTMLElement>(`[${PDF_ITEM_ATTR}]`),
    );
    for (const el of spans) el.style.transform = '';
    const natural = spans.map((el) => el.getBoundingClientRect().width);
    spans.forEach((el, i) => {
      const declared = Number(el.dataset.pdfDeclaredWidth);
      const measured = natural[i];
      // A zero/absent measurement (font not yet resolved, empty run) must leave
      // the span alone rather than collapse it to scaleX(0).
      el.style.transform =
        declared > 0 && measured > 0 ? `scaleX(${declared / measured})` : '';
    });
  }, [pageText, cssWidth, cssHeight, rotation]);

  return (
    <div
      ref={hostRef}
      data-testid="pdf-text-layer"
      className="pdf-text-layer absolute inset-0 select-text"
      style={{
        zIndex: 1,
        lineHeight: 1,
        color: 'transparent',
        cursor: 'text',
        pointerEvents: interactive ? 'auto' : 'none',
      }}
    >
      {pageText.items.map((item) => {
        if (!item.str) return null;
        const px = projectNormalizedPdfRect(item.rect, box, rotation);
        if (px.width <= 0 || px.height <= 0) return null;
        return (
          <span
            key={item.itemIndex}
            className="absolute whitespace-pre"
            // PHASE-3 SEAM: these two stamps are the ONLY contract between the DOM
            // and the anchor model — pdf-selection-capture resolves a browser
            // Range back to {pageIndex, itemIndex, charOffset} through them.
            // Renaming either attribute breaks selection capture.
            {...{ [PDF_PAGE_ATTR]: pageText.pageIndex, [PDF_ITEM_ATTR]: item.itemIndex }}
            // The width the PDF declares for this run. Read back by the
            // layout-effect above to derive scaleX; NOT part of the anchor
            // contract (the two attrs above are), so it is free to change.
            data-pdf-declared-width={px.width}
            style={{
              left: px.x,
              top: px.y,
              height: px.height,
              fontSize: px.height,
              // Squeeze toward the item's own origin, so x stays put.
              transformOrigin: '0 0',
            }}
          >
            {item.str}
          </span>
        );
      })}
    </div>
  );
}

// ── z2 — region-note capture (coordinate-only notes on scanned/image pages) ───

/**
 * A rubber-band drag surface for pages with no extractable text (plan §1.9's
 * coordinate-only notes). Mounted above the text layer ONLY while region mode is
 * armed, so ordinary reading and text selection are never intercepted.
 */
export function PdfRegionCaptureLayer({
  pageIndex, cssWidth, cssHeight, rotation, onRegion,
}: {
  pageIndex: number;
  cssWidth: number;
  cssHeight: number;
  rotation: number;
  onRegion: (pageIndex: number, rect: PdfRect, pxRect: PxRect) => void;
}) {
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const pointFor = (e: React.PointerEvent): { x: number; y: number } => {
    const box = hostRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  return (
    <div
      ref={hostRef}
      data-testid={`pdf-region-capture-${pageIndex}`}
      className="absolute inset-0"
      style={{ zIndex: 3, cursor: 'crosshair' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const p = pointFor(e);
        setDrag({ from: p, to: p });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        setDrag({ from: drag.from, to: pointFor(e) });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const px = rectFromDragPoints(drag.from, pointFor(e));
        setDrag(null);
        if (!isMeaningfulRegionDrag(px)) return; // a stray click is not a region
        const rect = unprojectPxRect(px, { width: cssWidth, height: cssHeight }, rotation);
        onRegion(pageIndex, rect, px);
      }}
    >
      {drag && (
        <div
          data-testid="pdf-region-band"
          className="absolute border-2 border-accent-blue bg-accent-blue/20"
          style={rectFromDragPoints(drag.from, drag.to)}
        />
      )}
    </div>
  );
}

// ── z2 — persisted highlight rects + comment pins (read-only in Phase 2) ──────

export function PdfOverlayLayer({
  comments, pageIndex, cssWidth, cssHeight, rotation, onPinClick, flashCommentId,
}: {
  comments: SelectionComment[];
  pageIndex: number;
  cssWidth: number;
  cssHeight: number;
  rotation: number;
  /** Phase 3: clicking a pin opens its sidebar card (plan §1.10). */
  onPinClick?: (comment: SelectionComment) => void;
  /** Comment whose rects are flashing after a sidebar navigate. */
  flashCommentId?: string | null;
}) {
  const box = { width: cssWidth, height: cssHeight };

  // Flatten this page's persisted anchors into paint rects + a single pin anchor
  // per comment (the top-most rect on this page).
  const painted = comments
    .map((comment) => {
      const anchor = comment.pdfAnchor;
      if (!anchor) return null;
      const page = anchor.pages.find((p) => p.pageIndex === pageIndex);
      if (!page || page.rects.length === 0) return null;
      const rects = page.rects.map((r: PdfRect) => projectNormalizedPdfRect(r, box, rotation));
      const pin = rects.reduce((top, r) => (r.y < top.y ? r : top), rects[0]);
      return { comment, rects, pin };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (painted.length === 0) return null;

  return (
    <div data-testid="pdf-overlay-layer" className="absolute inset-0" style={{ zIndex: 2, pointerEvents: 'none' }}>
      {painted.map(({ comment, rects, pin }) => {
        const flashing = flashCommentId === comment.id;
        // A degraded row keeps its stored rects as a HISTORICAL location — paint
        // it differently so a reattach verdict is visible, never a silent move.
        const tone =
          comment.status === 'orphaned'
            ? 'bg-gray-400/30'
            : comment.status === 'needs-review'
              ? 'bg-orange-300/40'
              : 'bg-yellow-300/30';
        return (
          <React.Fragment key={comment.id}>
            {rects.map((r, i) => (
              <div
                key={i}
                data-testid={`pdf-highlight-${comment.id}`}
                data-status={comment.status}
                className={`absolute transition-shadow ${tone} ${
                  flashing ? 'ring-2 ring-accent-blue shadow-[0_0_0_4px_rgba(59,130,246,0.35)]' : ''
                }`}
                style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
              />
            ))}
            {comment.kind !== 'highlight' && (
              <button
                type="button"
                data-testid={`pdf-overlay-pin-${comment.id}`}
                title={comment.body.slice(0, 120)}
                onClick={() => onPinClick?.(comment)}
                className={`absolute rounded-sm border border-black/40 shadow-sm bg-accent-blue hover:scale-125 transition-transform ${
                  flashing ? 'scale-125 ring-2 ring-accent-blue/70' : ''
                }`}
                // Pins remain the ONLY pointer-interactive element on z2 (plan
                // §2.4) — the rest of the overlay stays pointer-events:none so
                // text selection on z1 underneath is unaffected.
                style={{ left: Math.max(0, pin.x - 12), top: pin.y, width: 10, height: 10, pointerEvents: 'auto' }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
