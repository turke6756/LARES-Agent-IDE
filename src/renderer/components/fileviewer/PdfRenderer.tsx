// Continuous-scroll PDFium reader — the ORCHESTRATOR (plan Part 2.3).
//
// This is Candidate A's fast reader. It replaces the old react-pdf
// <Document>/<Page> implementation, which now lives verbatim in
// PdfJsFallbackRenderer.tsx as the automatic whole-document fallback.
//
// Responsibilities:
//   • open the PDFium document (pdfium-engine) AND the paint-disabled pdf.js
//     text model (pdf-text-model) for the same media:// source;
//   • render a vertical stack of PdfPageSlot, each slot's height RESERVED from
//     lightweight page metadata so the scrollbar is stable before any raster;
//   • VIRTUALIZE via IntersectionObserver — only pages within ~1 viewport get a
//     raster + text layer; off-screen slots keep their reserved height;
//   • own `scale`: toolbar +/- and a horizontal-wheel gesture (capture,
//     non-passive) that zooms only when |deltaX| dominates |deltaY|, applies at
//     most one update per frame, clamps 25 %–500 %, and preventDefault()s ONLY
//     the recognized horizontal gesture (vertical scroll stays native). During a
//     gesture the current bitmap is CSS-scaled immediately; the hi-res re-raster
//     is debounced until the gesture settles;
//   • open at fit-width (ResizeObserver + fitPageWidth), themed toolbar, page
//     indicator = top-most visible slot;
//   • on a whole-document open failure fall back to PdfJsFallbackRenderer (never
//     a blank surface). A single PATHOLOGICAL page's PDFium error is handled
//     inside PdfPageSlot with a retry / open-externally state — it is NEVER
//     silently swapped to the pdf.js canvas that caused the original 17 s hang.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import type { PathType, SelectionComment } from '../../../shared/types';

// Backing-pixel budget + fit-width math live in lib/pdf/pdf-metrics.ts so the
// WASM raster path and the pdf.js text/fallback path apply them identically
// (plan Part 1.1). Re-exported here so Phase-1 consumers and PdfRenderer.test.tsx
// keep resolving them from this module.
import {
  boundedPdfDevicePixelRatio,
  fitPageWidth,
  MAX_PDF_BACKING_PIXELS,
  MAX_PDF_DEVICE_PIXEL_RATIO,
} from '../../lib/pdf/pdf-metrics';
export { boundedPdfDevicePixelRatio, fitPageWidth, MAX_PDF_BACKING_PIXELS, MAX_PDF_DEVICE_PIXEL_RATIO };

import { pdfiumEngine } from '../../lib/pdf/pdfium-engine';
import { openPdfTextModel, type PdfTextModel } from '../../lib/pdf/pdf-text-model';
import PdfPageSlot from './PdfPageSlot';
import PdfJsFallbackRenderer from './PdfJsFallbackRenderer';

// ── Phase 3: capture → persist → render → send ───────────────────────────────
import type { PdfRect, PxRect } from '../../../shared/pdf-annotations';
import { projectNormalizedPdfRect } from '../../../shared/pdf-annotations';
import {
  buildPdfSelectionCapture,
  resolveCurrentPdfSelection,
  type ResolvedPdfSelection,
} from '../../lib/pdf/pdf-selection-capture';
import { captureCoordinateOnlyAnchor, coordinateOnlyQuote } from '../../lib/pdf/pdf-comment-anchors';
import type { CapturedPdfSelection } from '../../lib/pdf/pdf-comment-anchors';
import { createPdfComment, sendPersistedComments } from '../../lib/selection/comment-actions';
import { showSelectionToast } from '../../lib/selection/selection-toast';
import type { SelectionAgentTarget, SelectionContext } from '../../lib/selection/selection-types';
import SelectionActionMenu from '../selection/SelectionActionMenu';
import AddCommentPopover from '../selection/AddCommentPopover';
import PdfCommentSidebar, { type PdfSidebarRuntime } from '../selection/PdfCommentSidebar';
import { usePdfComments } from './usePdfComments';

interface Props {
  filePath: string;
  pathType: PathType;
  // Wired by the host (plan 2.5). Phase 2 only reads filePath/pathType for the
  // reader itself; tabId/workspaceId/rootDirectory ride through for the Phase-3
  // comment persistence seam.
  tabId?: string;
  workspaceId?: string;
  rootDirectory?: string;
}

// Zoom is relative to fit-width; 100 % == fit-width. Clamp 25 %–500 % (plan 2.3).
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
// A horizontal wheel gesture must clearly dominate the vertical delta before we
// treat it as zoom, so ordinary vertical scrolling is never hijacked.
const WHEEL_HORIZONTAL_DEADZONE = 1.5;
// Default page aspect (US-Letter, height/width) used to reserve slot height
// before per-page metadata resolves — keeps the scrollbar from jumping.
const DEFAULT_PAGE_ASPECT = 11 / 8.5;
// How long the zoom gesture must be quiet before we spend a hi-res re-raster.
const RASTER_DEBOUNCE_MS = 140;

function clampScale(next: number): number {
  if (!Number.isFinite(next)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
}

interface PageMeta {
  /** Display aspect (height / width) accounting for page rotation. */
  aspect: number;
  /** Page /Rotate in degrees, clockwise (0 | 90 | 180 | 270). */
  rotation: number;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; docId: number; pageCount: number; textModel: PdfTextModel }
  // Whole-document failure → the pdf.js renderer takes over (automatic fallback).
  | { kind: 'fallback' };

/** What the user has selected/dragged and is about to comment on. `pending` is
 *  held INDEPENDENTLY of the live DOM Selection: the composer clears the
 *  selection when it takes focus, and a zoom re-render invalidates every Range,
 *  so the resolved endpoints (not the Range) are what we carry forward. */
type PendingCapture =
  | { kind: 'text'; resolved: ResolvedPdfSelection; preview: string; anchorRect: DomRect }
  | { kind: 'region'; pageIndex: number; rect: PdfRect; preview: string; anchorRect: DomRect };

interface DomRect { x: number; y: number; width: number; height: number }

const FLASH_MS = 1400;

function PdfRendererSession({ filePath, pathType, workspaceId, rootDirectory }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [pageMeta, setPageMeta] = useState<Map<number, PageMeta>>(new Map());
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [activePages, setActivePages] = useState<Set<number>>(new Set());
  const [topPage, setTopPage] = useState(0);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // ── Open the PDFium document + the paint-disabled pdf.js text model ─────────
  useEffect(() => {
    let cancelled = false;
    let openedTextModel: PdfTextModel | null = null;
    setLoad({ kind: 'loading' });
    setPageMeta(new Map());
    (async () => {
      try {
        const [handle, textModel] = await Promise.all([
          pdfiumEngine.openDocument(filePath),
          openPdfTextModel(filePath),
        ]);
        openedTextModel = textModel;
        if (cancelled) { textModel.destroy(); return; }
        setLoad({ kind: 'ready', docId: handle.docId, pageCount: handle.pageCount, textModel });
        // Fill per-page display metadata lazily (pdf.js getPage only — never
        // getOperatorList) so reserved heights sharpen without blocking paint.
        for (let i = 0; i < handle.pageCount; i++) {
          if (cancelled) return;
          try {
            const info = await textModel.getPageInfo(i);
            if (cancelled) return;
            const unrotated = info.cropWidth > 0 ? info.cropHeight / info.cropWidth : DEFAULT_PAGE_ASPECT;
            const rotated = info.rotation % 180 === 0 ? unrotated : 1 / unrotated;
            setPageMeta((prev) => {
              const next = new Map(prev);
              next.set(i, { aspect: rotated, rotation: info.rotation });
              return next;
            });
          } catch {
            /* leave the default reserve for this page */
          }
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[pdf] PDFium open failed, falling back to pdf.js:', err);
        setLoad({ kind: 'fallback' });
      }
    })();
    return () => {
      cancelled = true;
      openedTextModel?.destroy();
      void pdfiumEngine.closeDocument(filePath);
    };
  }, [filePath]);

  // ── Fit-width: measure the scroll viewport (ResizeObserver + window resize) ──
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const measure = () => {
      const next = fitPageWidth(root.clientWidth);
      if (next !== null) setFitWidth((cur) => (cur === next ? cur : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [load.kind]);

  // ── Virtualization: IntersectionObserver activates pages within ~1 viewport ──
  const slotEls = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const activeRef = useRef(activePages);
  activeRef.current = activePages;

  const registerRef = useCallback((pageIndex: number, el: HTMLElement | null) => {
    const io = observerRef.current;
    const prev = slotEls.current.get(pageIndex);
    if (prev && io) io.unobserve(prev);
    if (el) {
      slotEls.current.set(pageIndex, el);
      if (io) io.observe(el);
    } else {
      slotEls.current.delete(pageIndex);
    }
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const next = new Set(activeRef.current);
        let changed = false;
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (Number.isNaN(idx)) continue;
          if (entry.isIntersecting) {
            if (!next.has(idx)) { next.add(idx); changed = true; }
          } else if (next.has(idx)) {
            next.delete(idx); changed = true;
          }
        }
        if (changed) { activeRef.current = next; setActivePages(next); }
      },
      // ~1 viewport of pre-render margin above and below.
      { root, rootMargin: '100% 0px', threshold: 0 },
    );
    observerRef.current = io;
    for (const el of slotEls.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [load.kind]);

  // ── Page indicator: the top-most page currently touching the viewport top ───
  const scrollRafRef = useRef<number | null>(null);
  const recomputeTopPage = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    let best = 0;
    let bestFound = false;
    for (const [idx, el] of slotEls.current) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > rootTop + 4) {
        if (!bestFound || idx < best) { best = idx; bestFound = true; }
      }
    }
    setTopPage((cur) => (cur === best ? cur : best));
  }, []);

  const onScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      recomputeTopPage();
    });
  }, [recomputeTopPage]);

  // ── Horizontal-wheel zoom (capture, non-passive) ────────────────────────────
  const wheelAccum = useRef(0);
  const wheelRaf = useRef<number | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      // Zoom only for a clearly-horizontal gesture; leave vertical to the native
      // scroll container (do not preventDefault, do not consume).
      if (absX <= absY * WHEEL_HORIZONTAL_DEADZONE || absX < 1) return;
      e.preventDefault();
      wheelAccum.current += e.deltaX;
      if (wheelRaf.current !== null) return;
      wheelRaf.current = requestAnimationFrame(() => {
        wheelRaf.current = null;
        const delta = wheelAccum.current;
        wheelAccum.current = 0;
        // Rightward (positive deltaX) zooms in; exponential feels uniform.
        setScale((prev) => clampScale(prev * Math.exp(delta * 0.0015)));
      });
    };
    root.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      root.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      if (wheelRaf.current !== null) { cancelAnimationFrame(wheelRaf.current); wheelRaf.current = null; }
    };
  }, [load.kind]);

  // ── Display vs raster width — CSS-scale now, debounce the crisp re-raster ────
  const displayWidth = fitWidth !== null ? Math.max(1, Math.round(fitWidth * scale)) : null;
  const [rasterWidth, setRasterWidth] = useState<number | null>(null);
  useEffect(() => {
    if (displayWidth === null) return;
    // First paint (or after a resize with no prior raster) rasters immediately;
    // subsequent zoom steps debounce so a continuous gesture spends one re-raster.
    if (rasterWidth === null) { setRasterWidth(displayWidth); return; }
    const t = setTimeout(() => setRasterWidth(displayWidth), RASTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [displayWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleZoomIn = () => setScale((prev) => clampScale(prev + 0.25));
  const handleZoomOut = () => setScale((prev) => clampScale(prev - 0.25));

  const openExternally = useCallback(() => {
    window.api.system.openFile(filePath, pathType);
  }, [filePath, pathType]);

  const onPageError = useCallback((pageIndex: number, err: Error) => {
    console.error(`[pdf] page ${pageIndex + 1} render failed:`, err);
  }, []);

  // ── Phase 3: the Phase-2 seam, made real ────────────────────────────────────
  // Rows for this file, filtered to PDF anchors, reattached against the live
  // document (fingerprint ladder) and sliced per page. Subscribes to
  // comment-events internally, so the overlay updates live.
  const textModel = load.kind === 'ready' ? load.textModel : null;
  const livePageCount = load.kind === 'ready' ? load.pageCount : 0;
  const { commentsByPage, placements } = usePdfComments({
    workspaceId,
    filePath,
    textModel,
    pageCount: livePageCount,
  });

  // ── Capture UX ──────────────────────────────────────────────────────────────
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [composer, setComposer] = useState<'draft' | 'send' | null>(null);
  const [regionMode, setRegionMode] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  const dismissCapture = useCallback(() => {
    setPending(null);
    setMenuAt(null);
    setComposer(null);
  }, []);

  // Close the MENU ONLY — never the capture behind it.
  //
  // SelectionActionMenu's contract (see useSelectionActions, the markdown
  // surface): an item handler runs `onAddComment()` THEN `onClose()`, because
  // there `onClose` is `setMenu(null)` and the popover is separate state that
  // survives it. Passing `dismissCapture` as onClose broke that contract — the
  // onClose leg nulled the `composer` (and `pending`) that the onAddComment leg
  // had just set, both in one batched click, so the composer could never mount:
  // "Add comment…" and "Comment & send…" did nothing at all. (Highlight still
  // worked, because it persists through a closure that already captured
  // `pending` — which is exactly the reported symptom.)
  const closeMenuOnly = useCallback(() => setMenuAt(null), []);

  // A text selection over the z1 layer → resolved PDF endpoints + the action menu.
  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (regionMode || composer) return;
      // Let the browser finish committing the selection before reading it.
      requestAnimationFrame(() => {
        const sel = typeof window === 'undefined' ? null : window.getSelection();
        const resolved = resolveCurrentPdfSelection(sel);
        if (!resolved || !sel) {
          setPending(null);
          setMenuAt(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const box = range.getBoundingClientRect();
        setPending({
          kind: 'text',
          resolved,
          // DOM text is the composer PREVIEW only — the persisted quote comes
          // from the normalized page text (see buildPdfSelectionCapture).
          preview: sel.toString(),
          anchorRect: { x: box.left, y: box.top, width: box.width, height: box.height },
        });
        setMenuAt({ x: e.clientX, y: e.clientY });
      });
    },
    [regionMode, composer],
  );

  // A rubber-band drag on a page with no extractable text → coordinate-only note.
  const onRegion = useCallback(
    (pageIndex: number, rect: PdfRect, px: PxRect) => {
      const el = slotEls.current.get(pageIndex);
      const slotBox = el?.getBoundingClientRect();
      const anchorRect = {
        x: (slotBox?.left ?? 0) + px.x,
        y: (slotBox?.top ?? 0) + px.y,
        width: px.width,
        height: px.height,
      };
      const label = textModel?.getMeta().pageLabels?.[pageIndex] ?? undefined;
      setPending({
        kind: 'region',
        pageIndex,
        rect,
        preview: coordinateOnlyQuote(pageIndex, label),
        anchorRect,
      });
      setRegionMode(false);
      setMenuAt({ x: anchorRect.x + anchorRect.width, y: anchorRect.y + anchorRect.height });
    },
    [textModel],
  );

  /** Resolve the pending capture into a durable anchor + the quote to persist. */
  const resolveCapture = useCallback(async (): Promise<CapturedPdfSelection | null> => {
    if (!pending || !textModel) return null;
    const fingerprint = textModel.fingerprint;
    if (pending.kind === 'region') {
      const label = textModel.getMeta().pageLabels?.[pending.pageIndex] ?? undefined;
      return captureCoordinateOnlyAnchor({
        fingerprint,
        pageIndex: pending.pageIndex,
        rects: [pending.rect],
        pageLabel: label,
      });
    }
    return buildPdfSelectionCapture(
      pending.resolved,
      (pageIndex) => textModel.getPageText(pageIndex),
      fingerprint,
      textModel.getMeta().pageLabels,
    );
  }, [pending, textModel]);

  /** Persist the pending capture. Returns the row (send needs its id). */
  const persist = useCallback(
    async (body: string, kind: 'comment' | 'highlight'): Promise<SelectionComment | null> => {
      if (!workspaceId) {
        showSelectionToast('Cannot comment: no workspace for this file', 'error');
        return null;
      }
      try {
        const captured = await resolveCapture();
        if (!captured) {
          showSelectionToast('Could not anchor that selection', 'error');
          return null;
        }
        return await createPdfComment({
          workspaceId,
          filePath,
          pathType,
          rootDirectory,
          quotedText: captured.quote,
          body,
          anchor: captured.anchor,
          kind,
        });
      } catch (err) {
        showSelectionToast(
          `Failed to save comment: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        return null;
      }
    },
    [workspaceId, filePath, pathType, rootDirectory, resolveCapture],
  );

  const saveDraft = useCallback(
    async (body: string) => {
      dismissCapture();
      const row = await persist(body, 'comment');
      if (row) showSelectionToast('Comment saved');
    },
    [persist, dismissCapture],
  );

  const addHighlight = useCallback(async () => {
    dismissCapture();
    await persist('', 'highlight');
  }, [persist, dismissCapture]);

  // Send goes through the SAME main-side dispatch as markdown: persist first,
  // then `comments:send` builds the prompt from the ROW (plan §1.8 — persisted
  // rows, not renderer state, are the authority for page/quote context).
  const commentAndSend = useCallback(
    async (target: SelectionAgentTarget, body: string) => {
      dismissCapture();
      const row = await persist(body, 'comment');
      if (row) await sendPersistedComments([row.id], target, filePath);
    },
    [persist, dismissCapture, filePath],
  );

  const sendQuoteOnly = useCallback(
    async (target: SelectionAgentTarget) => {
      dismissCapture();
      const row = await persist('', 'comment');
      if (row) await sendPersistedComments([row.id], target, filePath);
    },
    [persist, dismissCapture, filePath],
  );

  // ── Sidebar runtime: page/rect locations from the PDF runtime, not the DOM ───
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const runtime = useMemo<PdfSidebarRuntime>(
    () => ({
      locationFor: (comment) => {
        const placed = placements.find((p) => p.row.id === comment.id);
        const pageIndex = placed?.pageIndex ?? comment.pdfAnchor?.pages[0]?.pageIndex;
        if (pageIndex === undefined) return null;
        const el = slotEls.current.get(pageIndex);
        if (!el) return null; // page not laid out yet
        const rects = placed?.rects ?? comment.pdfAnchor?.pages[0]?.rects ?? [];
        const rotation = pageMeta.get(pageIndex)?.rotation ?? 0;
        const box = { width: el.offsetWidth, height: el.offsetHeight };
        const top =
          rects.length > 0 ? projectNormalizedPdfRect(rects[0], box, rotation).y : 0;
        return {
          pageIndex,
          pageLabel: textModel?.getMeta().pageLabels?.[pageIndex] ?? undefined,
          top: el.offsetTop + top,
        };
      },
      navigateToComment: (comment) => {
        const placed = placements.find((p) => p.row.id === comment.id);
        const pageIndex = placed?.pageIndex ?? comment.pdfAnchor?.pages[0]?.pageIndex;
        if (pageIndex === undefined) return;
        slotEls.current.get(pageIndex)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlashId(comment.id);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashId(null), FLASH_MS);
      },
    }),
    // Re-derived when geometry changes so cards track zoom/resize.
    [placements, pageMeta, textModel, displayWidth, scale],
  );

  // The overlay pin sits ON the highlighted text, so it is the dot people
  // actually click — which means it also has to be the way back OUT. It used to
  // only ever open (`setOpenCardId(id)`), so clicking the same dot again did
  // nothing and the card read as stuck. The sidebar's own pin already toggled;
  // this makes the two agree.
  const onPinClick = useCallback(
    (comment: SelectionComment) => {
      if (openCardId === comment.id) {
        setOpenCardId(null);
        return; // closing — don't re-scroll the reader out from under the click
      }
      setOpenCardId(comment.id);
      runtime.navigateToComment(comment);
    },
    [openCardId, runtime],
  );

  const selectionContext = useMemo<SelectionContext | null>(() => {
    if (!workspaceId || !pending) return null;
    return {
      targetType: 'file',
      workspaceId,
      sourceLabel: filePath,
      quotedText: pending.preview,
      file: { filePath },
      capabilities: { comment: true },
    };
  }, [workspaceId, pending, filePath]);

  if (load.kind === 'fallback') {
    return <PdfJsFallbackRenderer filePath={filePath} pathType={pathType} />;
  }

  const pageCount = load.kind === 'ready' ? load.pageCount : 0;
  const ready = load.kind === 'ready' && fitWidth !== null && displayWidth !== null;

  return (
    <div className="flex flex-col h-full bg-[#525659] overflow-hidden">
      {/* Themed toolbar. */}
      <div className="flex items-center justify-between gap-4 px-4 py-2 bg-[#323639] text-gray-200 border-b border-black/20 shadow-sm shrink-0 z-10">
        <div className="flex items-center gap-4">
          <span className="px-1 text-[13px] font-sans min-w-[70px] text-center select-none" data-testid="pdf-page-indicator">
            {pageCount ? `${topPage + 1} / ${pageCount}` : '-- / --'}
          </span>

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

        <div className="flex items-center gap-4">
          {/* Coordinate-only region notes (plan §1.9) — the only way to annotate a
              scanned/image-only page, where there is no text to select. */}
          <button
            onClick={() => { setRegionMode((on) => !on); dismissCapture(); }}
            disabled={!workspaceId}
            aria-pressed={regionMode}
            data-testid="pdf-region-mode-toggle"
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[12px] font-sans transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              regionMode ? 'bg-accent-blue text-white' : 'text-gray-300 hover:bg-white/10'
            }`}
            title={
              workspaceId
                ? 'Drag a box on the page to note a figure or scan (no text needed)'
                : 'Commenting needs a workspace'
            }
          >
            <Icons.SquareDashedMousePointer className="w-3.5 h-3.5" />
            Region note
          </button>

          <button
            onClick={openExternally}
            className="text-[12px] font-sans text-gray-300 hover:text-white transition-colors"
            title="Open this PDF in the system viewer"
          >
            Open externally
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onMouseUp={onMouseUp}
        className="flex-1 overflow-auto p-4 bg-[#525659] relative"
        data-testid="pdf-scroll"
      >
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#525659] z-20">
            <div className="flex items-center gap-3 text-white/70">
              <Icons.Loader2 className="w-5 h-5 animate-spin" />
              <span className="font-sans text-sm">Loading PDF...</span>
            </div>
          </div>
        )}

        {ready && load.kind === 'ready' && (
          // `relative` makes this stack the offsetParent for every slot, so the
          // sidebar can position cards in SCROLL-CONTENT space (el.offsetTop) and
          // scroll with the pages, rather than being clipped to the viewport.
          <div className="relative flex flex-col items-center gap-4">
            {Array.from({ length: pageCount }, (_, pageIndex) => {
              const meta = pageMeta.get(pageIndex);
              return (
                <PdfPageSlot
                  key={pageIndex}
                  docId={load.docId}
                  pageIndex={pageIndex}
                  rotation={meta?.rotation ?? 0}
                  reservedAspect={meta?.aspect ?? DEFAULT_PAGE_ASPECT}
                  cssWidth={displayWidth}
                  rasterCssWidth={rasterWidth ?? displayWidth}
                  dpr={dpr}
                  active={activePages.has(pageIndex)}
                  textModel={load.textModel}
                  comments={commentsByPage.get(pageIndex) ?? EMPTY_COMMENTS}
                  onPageError={onPageError}
                  onOpenExternally={openExternally}
                  registerRef={registerRef}
                  regionMode={regionMode}
                  onRegion={onRegion}
                  onPinClick={onPinClick}
                  // While a card is OPEN its anchored text stays ringed, so the
                  // note is visibly tied to the words it is about. The flash is
                  // the transient nav cue; the open card is a sticky one, and it
                  // must not fade out from under a card the reader is still on.
                  flashCommentId={flashId ?? openCardId}
                />
              );
            })}

            {workspaceId && (
              <PdfCommentSidebar
                workspaceId={workspaceId}
                filePath={filePath}
                runtime={runtime}
                comments={placements.map((p) => p.row)}
                expandedId={openCardId}
                onExpandedChange={setOpenCardId}
              />
            )}
          </div>
        )}
      </div>

      {/* Capture UX. The menu is offered only where persistence is possible. */}
      {menuAt && pending && selectionContext && !composer && (
        <SelectionActionMenu
          x={menuAt.x}
          y={menuAt.y}
          context={selectionContext}
          onClose={closeMenuOnly}
          onPickAgent={(target) => void sendQuoteOnly(target)}
          onAddComment={() => { setMenuAt(null); setComposer('draft'); }}
          onCommentAndSend={() => { setMenuAt(null); setComposer('send'); }}
          // A region note has no text to highlight — only text selections do.
          onHighlight={pending.kind === 'text' ? () => void addHighlight() : undefined}
        />
      )}

      {composer && pending && workspaceId && (
        <AddCommentPopover
          anchorRect={pending.anchorRect}
          quotedText={pending.preview}
          workspaceId={workspaceId}
          mode={composer}
          onClose={dismissCapture}
          onSaveDraft={(body) => void saveDraft(body)}
          onSend={(target, body) => void commentAndSend(target, body)}
        />
      )}
    </div>
  );
}

// A stable empty array so slots with no comments don't re-render on identity.
const EMPTY_COMMENTS: SelectionComment[] = [];

export default function PdfRenderer(props: Props) {
  // FileContentArea is reused across tab switches; key the session on the file so
  // scroll, scale, virtualization and document handles cannot leak between PDFs.
  return <PdfRendererSession key={`${props.pathType}:${props.filePath}`} {...props} />;
}
