import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SelectionComment } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { findQuoteInDom } from '../../lib/selection/comment-anchors';
import {
  sendPersistedComments,
  resolveComment,
  deleteComment,
  setCommentStatus,
} from '../../lib/selection/comment-actions';
import { onCommentsChanged } from '../../lib/selection/comment-events';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';
import AgentPickerDropdown from './AgentPickerDropdown';

// Comment marker column for file surfaces (WP-P5-B). Mounts as an absolute
// overlay over the surface's scroll container: one marker per non-resolved
// comment, vertical position from reattaching the stored quote to the live
// DOM (whitespace-tolerant text search by quote + prefix/suffix). A marker
// expands into a card with the body and Send / Send all / Resolve / Delete.
//
// Reattach ladder per measure pass: quote found → positioned (fuzzy match =
// needs-attention tint); not found while the doc has text → the row is
// flipped to `orphaned` (and back to `draft` if the text returns). Orphans
// stack at the top of the column — visible, never crashing.

interface Props {
  /** File tab whose comments to show; the tab carries filePath/workspace. */
  tabId?: string;
  /** The surface's scrolling element — measure target and scroll source. */
  scrollRef: React.RefObject<HTMLElement | null>;
}

interface MarkerPosition {
  top: number;
  /** x of the marker = just past the right edge of the commented text. */
  left: number;
  fuzzy: boolean;
}

// Standing underline+tint on every anchored comment so commented text is
// visibly delineated even with no card open; the expanded one gets a stronger
// fill on top (higher priority).
const HL_ANCHORED = 'selection-comment-anchored';
const HL_ACTIVE = 'selection-comment-active';
// Plain user highlights (kind === 'highlight') — a solid yellow wash, no
// underline, so they read as a marker pen rather than a commented span.
const HL_USER = 'selection-user-highlight';
const MARKER_SIZE = 12;
/** Gap between the end of the commented text and its marker dot. */
const MARKER_GAP = 6;
const CARD_WIDTH = 300;
/** Right margin the expanded card is pinned to. */
const CARD_RIGHT = 10;

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightInstance = { priority?: number };

function highlightApi(): {
  registry: HighlightRegistry;
  make: (...ranges: Range[]) => HighlightInstance;
} | null {
  if (typeof CSS === 'undefined') return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => HighlightInstance })
    .Highlight;
  if (!registry || !HighlightCtor) return null; // jsdom / old chromium — highlight is cosmetic
  return { registry, make: (...ranges) => new HighlightCtor(...ranges) };
}

// ::highlight() styling — injected once. The highlight pseudo supports
// background-color + text-decoration, so anchored comments read as an
// underlined tint and the active one as a solid fill.
function ensureHighlightStyle(): void {
  const id = 'selection-comment-highlight-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    ::highlight(${HL_ANCHORED}) {
      background-color: rgba(56, 139, 253, 0.13);
      text-decoration-line: underline;
      text-decoration-color: rgba(56, 139, 253, 0.6);
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
    }
    ::highlight(${HL_ACTIVE}) {
      background-color: rgba(56, 139, 253, 0.34);
    }
    ::highlight(${HL_USER}) {
      background-color: rgba(250, 204, 21, 0.32);
    }`;
  document.head.appendChild(style);
}

/** Standing highlight over every anchored comment's quote. */
function setAnchoredHighlights(ranges: Range[]): void {
  const api = highlightApi();
  if (!api) return;
  if (ranges.length === 0) {
    api.registry.delete(HL_ANCHORED);
    return;
  }
  ensureHighlightStyle();
  api.registry.set(HL_ANCHORED, api.make(...ranges));
}

/** Stronger fill over the expanded comment's quote (drawn above the standing
 * highlight via a higher priority). */
function setActiveHighlight(range: Range | null): void {
  const api = highlightApi();
  if (!api) return;
  if (!range) {
    api.registry.delete(HL_ACTIVE);
    return;
  }
  ensureHighlightStyle();
  const h = api.make(range);
  h.priority = 1;
  api.registry.set(HL_ACTIVE, h);
}

/** Standing yellow wash over every plain highlight's quote. */
function setUserHighlights(ranges: Range[]): void {
  const api = highlightApi();
  if (!api) return;
  if (ranges.length === 0) {
    api.registry.delete(HL_USER);
    return;
  }
  ensureHighlightStyle();
  api.registry.set(HL_USER, api.make(...ranges));
}

function clearAllHighlights(): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(HL_ANCHORED);
  api.registry.delete(HL_ACTIVE);
  api.registry.delete(HL_USER);
}

const STATUS_DOT_CLASS: Record<string, string> = {
  draft: 'bg-accent-blue',
  queued: 'bg-accent-blue animate-pulse',
  sent: 'bg-emerald-600/80',
  send_failed: 'bg-red-500',
  'needs-review': 'bg-amber-400',
  orphaned: 'bg-gray-500',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  queued: 'Sending…',
  sent: 'Sent',
  send_failed: 'Send failed',
  'needs-review': 'Needs review',
  orphaned: 'Orphaned',
};

const SENDABLE = new Set(['draft', 'send_failed', 'orphaned']);

export default function FileCommentGutter({ tabId, scrollRef }: Props) {
  const tab = useDashboardStore((s) =>
    tabId ? s.openTabs.find((t) => t.id === tabId) : undefined,
  );
  const filePath = tab?.filePath || '';
  const workspaceId = tab?.workspaceId || '';

  const [comments, setComments] = useState<SelectionComment[]>([]);
  const [positions, setPositions] = useState<Map<string, MarkerPosition | null>>(new Map());
  const [highlightPositions, setHighlightPositions] = useState<Map<string, MarkerPosition | null>>(
    new Map(),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedHighlightId, setExpandedHighlightId] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // Status flips already requested this generation — keeps the measure pass
  // from re-issuing draft↔orphaned updates while the refetch is in flight.
  const flipsInFlight = useRef(new Set<string>());

  // Comments (with a body, sendable) and plain highlights are rendered by
  // separate paths: the comment status machine below never touches highlights.
  const visible = useMemo(
    () => comments.filter((c) => c.kind !== 'highlight' && c.status !== 'resolved'),
    [comments],
  );
  const highlights = useMemo(
    () => comments.filter((c) => c.kind === 'highlight' && c.status !== 'resolved'),
    [comments],
  );

  // ── Row loading ──────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    if (!workspaceId || !filePath) return;
    try {
      const rows = await window.api.comments.list(workspaceId, filePath);
      flipsInFlight.current.clear();
      setComments(rows);
    } catch (err) {
      console.error('[FileCommentGutter] failed to load comments', err);
    }
  }, [workspaceId, filePath]);

  useEffect(() => {
    if (!workspaceId || !filePath) return;
    void reload();
    const offLocal = onCommentsChanged(filePath, () => void reload());
    const offMain = window.api.comments.onChanged(({ comments: changed }) => {
      if (changed.some((c) => c.filePath === filePath)) void reload();
    });
    return () => {
      offLocal();
      offMain();
    };
  }, [workspaceId, filePath, reload]);

  // ── Measurement: quote → DOM range → marker top ──────────────────────
  const measure = useCallback(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const hasText = (scrollEl.textContent ?? '').trim().length > 0;
    const next = new Map<string, MarkerPosition | null>();
    const anchoredRanges: Range[] = [];

    for (const c of visible) {
      const match = findQuoteInDom(scrollEl, c.quotedText, c.prefix ?? '', c.suffix ?? '');
      if (!match) {
        next.set(c.id, null);
        continue;
      }
      // jsdom Ranges have no layout — treat them as top-left of container.
      const rect =
        typeof match.range.getBoundingClientRect === 'function'
          ? match.range.getBoundingClientRect()
          : { top: containerRect.top };
      // Horizontal anchor: the right edge of the text COLUMN (the comment's
      // nearest block ancestor), not the selection's own right edge — so every
      // marker lines up in a neat rail hugging the text instead of landing
      // mid-paragraph after a short phrase.
      const columnRight = blockRightEdge(match.range.startContainer, scrollEl) ?? containerRect.right;
      next.set(c.id, {
        // Container-viewport-relative (the overlay doesn't scroll — it
        // remeasures on scroll), matching the prior positioning model.
        top: rect.top - containerRect.top,
        left: columnRight - containerRect.left + MARKER_GAP,
        fuzzy: match.fuzzy,
      });
      anchoredRanges.push(match.range);
    }
    setPositions(next);
    setAnchoredHighlights(anchoredRanges);

    // Plain highlights: same quote→range reattach, painted yellow. Each gets a
    // marker dot (the removal affordance); unreattached ones are dropped this
    // pass and reappear when their text returns.
    const nextHl = new Map<string, MarkerPosition | null>();
    const userRanges: Range[] = [];
    for (const h of highlights) {
      const match = findQuoteInDom(scrollEl, h.quotedText, h.prefix ?? '', h.suffix ?? '');
      if (!match) {
        nextHl.set(h.id, null);
        continue;
      }
      const rect =
        typeof match.range.getBoundingClientRect === 'function'
          ? match.range.getBoundingClientRect()
          : { top: containerRect.top };
      const columnRight = blockRightEdge(match.range.startContainer, scrollEl) ?? containerRect.right;
      nextHl.set(h.id, {
        top: rect.top - containerRect.top,
        left: columnRight - containerRect.left + MARKER_GAP,
        fuzzy: match.fuzzy,
      });
      userRanges.push(match.range);
    }
    setHighlightPositions(nextHl);
    setUserHighlights(userRanges);

    // Reattach bookkeeping — only against a doc that actually has text (an
    // editor still mounting must not orphan everything).
    if (hasText && filePath) {
      for (const c of visible) {
        if (flipsInFlight.current.has(c.id)) continue;
        const pos = next.get(c.id);
        if (!pos && c.status === 'draft') {
          flipsInFlight.current.add(c.id);
          void setCommentStatus(c.id, 'orphaned', filePath);
        } else if (pos && !pos.fuzzy && c.status === 'orphaned') {
          flipsInFlight.current.add(c.id);
          void setCommentStatus(c.id, 'draft', filePath);
        }
      }
    }
  }, [scrollRef, visible, highlights, filePath]);

  useEffect(() => {
    measure();
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let rafId = 0;
    const onScrollOrResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(measure);
    };
    scrollEl.addEventListener('scroll', onScrollOrResize, { passive: true });

    // jsdom has no ResizeObserver; the observer is a remeasure trigger only.
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScrollOrResize) : null;
    resizeObserver?.observe(scrollEl);

    // Canvas edits / markdown re-renders move the quotes around.
    let mutationTimer: ReturnType<typeof setTimeout> | undefined;
    const mutationObserver = new MutationObserver(() => {
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(measure, 300);
    });
    mutationObserver.observe(scrollEl, { childList: true, characterData: true, subtree: true });

    return () => {
      scrollEl.removeEventListener('scroll', onScrollOrResize);
      cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      clearTimeout(mutationTimer);
      clearAllHighlights();
    };
  }, [measure, scrollRef]);

  // ── Stronger fill over the expanded comment's quote ──────────────────
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!expandedId || !scrollEl) {
      setActiveHighlight(null);
      return;
    }
    const comment = visible.find((c) => c.id === expandedId);
    if (!comment) {
      setActiveHighlight(null);
      return;
    }
    const match = findQuoteInDom(
      scrollEl,
      comment.quotedText,
      comment.prefix ?? '',
      comment.suffix ?? '',
    );
    setActiveHighlight(match?.range ?? null);
    return () => setActiveHighlight(null);
  }, [expandedId, visible, scrollRef, positions]);

  if (!tabId || !filePath || !workspaceId || (visible.length === 0 && highlights.length === 0)) {
    return null;
  }

  // clientHeight/Width 0 = not laid out yet (or jsdom) — don't cull markers then.
  const containerHeight = scrollRef.current?.clientHeight || Number.POSITIVE_INFINITY;
  const containerWidth = scrollRef.current?.clientWidth || Number.POSITIVE_INFINITY;
  // Keep markers off the very edge and clear of the expanded card's column.
  const maxMarkerLeft = Number.isFinite(containerWidth)
    ? containerWidth - MARKER_SIZE - 4
    : Number.POSITIVE_INFINITY;

  // Orphans (and not-yet-measured rows) stack at the top-right of the surface.
  let orphanSlot = 0;
  const markerPos = (c: SelectionComment): { top: number; left: number; orphan: boolean } => {
    const pos = positions.get(c.id);
    if (pos) {
      return {
        top: Math.max(2, pos.top),
        left: Math.max(2, Math.min(pos.left, maxMarkerLeft)),
        orphan: false,
      };
    }
    return { top: 4 + orphanSlot++ * 16, left: maxMarkerLeft, orphan: true };
  };

  // Highlight markers sit on the LEFT rail (the comment dots own the right
  // rail), so the two never collide. Unreattached highlights stack at top-left.
  let hlOrphanSlot = 0;
  const hlMarkerPos = (h: SelectionComment): { top: number; left: number; orphan: boolean } => {
    const pos = highlightPositions.get(h.id);
    if (pos) return { top: Math.max(2, pos.top), left: 2, orphan: false };
    return { top: 4 + hlOrphanSlot++ * 16, left: 2, orphan: true };
  };

  const expanded = expandedId ? visible.find((c) => c.id === expandedId) : undefined;
  const highlightExpanded = expandedHighlightId
    ? highlights.find((h) => h.id === expandedHighlightId)
    : undefined;
  const draftIds = visible
    .filter((c) => c.status === 'draft')
    .sort((a, b) => {
      const pa = positions.get(a.id)?.top ?? Number.MAX_SAFE_INTEGER;
      const pb = positions.get(b.id)?.top ?? Number.MAX_SAFE_INTEGER;
      return pa !== pb ? pa - pb : a.createdAt.localeCompare(b.createdAt);
    })
    .map((c) => c.id);

  const sendOne = (comment: SelectionComment, target: SelectionAgentTarget) => {
    setPickerFor(null);
    setExpandedId(null);
    void sendPersistedComments([comment.id], target, filePath);
  };

  const sendAll = (target: SelectionAgentTarget) => {
    setPickerFor(null);
    setExpandedId(null);
    if (draftIds.length > 0) void sendPersistedComments(draftIds, target, filePath);
  };

  return (
    <div
      className="absolute inset-0 z-30 pointer-events-none"
      data-testid="file-comment-gutter"
    >
      {visible.map((c) => {
        const { top, left, orphan } = markerPos(c);
        if (!orphan && (top < 0 || top > containerHeight)) return null;
        const pos = positions.get(c.id);
        const status = orphan && c.status === 'draft' ? 'orphaned' : c.status;
        const isExpanded = expandedId === c.id;
        return (
          <button
            key={c.id}
            data-testid={`comment-marker-${c.id}`}
            data-status={status}
            title={`${STATUS_LABEL[status] ?? status}: ${c.body.slice(0, 80)}`}
            onClick={() => setExpandedId((id) => (id === c.id ? null : c.id))}
            className={`pointer-events-auto absolute rounded-full border border-black/40 shadow-sm hover:scale-125 transition-transform ${
              STATUS_DOT_CLASS[status] ?? 'bg-gray-500'
            } ${pos?.fuzzy ? 'ring-1 ring-amber-400' : ''} ${
              isExpanded ? 'scale-125 ring-2 ring-accent-blue/70' : ''
            }`}
            // Nudge down so the dot sits on the first line of the quote rather
            // than above its cap height.
            style={{ top: top + 3, left, width: MARKER_SIZE, height: MARKER_SIZE }}
          />
        );
      })}

      {expanded && (
        <div
          data-testid="comment-card"
          className="ui-menu pointer-events-auto absolute p-2"
          style={{
            right: CARD_RIGHT,
            top: Math.max(4, Math.min(markerCardTop(expanded, positions), containerHeight - 220)),
            width: CARD_WIDTH,
          }}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-400">
              {STATUS_LABEL[positions.get(expanded.id) ? expanded.status : 'orphaned'] ??
                expanded.status}
            </span>
            <button
              className="ui-btn text-[11px] px-1.5 py-0"
              onClick={() => setExpandedId(null)}
              title="Collapse"
            >
              ✕
            </button>
          </div>
          <div className="px-2 py-1 mb-1.5 border-l-2 border-accent-blue/50 text-[12px] text-gray-400 italic whitespace-pre-wrap max-h-24 overflow-auto">
            {expanded.quotedText}
          </div>
          <div className="text-[13px] text-gray-200 whitespace-pre-wrap max-h-40 overflow-auto mb-2">
            {expanded.body}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {SENDABLE.has(expanded.status) && (
              <button
                className="ui-btn text-[12px]"
                onClick={() => setPickerFor((v) => (v === 'one' ? null : 'one'))}
              >
                Send&nbsp;▸
              </button>
            )}
            {draftIds.length > 1 && (
              <button
                className="ui-btn text-[12px]"
                onClick={() => setPickerFor((v) => (v === 'all' ? null : 'all'))}
                title={`Send all ${draftIds.length} draft comments as one message`}
              >
                Send all ({draftIds.length})&nbsp;▸
              </button>
            )}
            <button
              className="ui-btn text-[12px]"
              onClick={() => {
                setExpandedId(null);
                void resolveComment(expanded.id, filePath);
              }}
            >
              Resolve
            </button>
            <button
              className="ui-btn text-[12px]"
              onClick={() => {
                setExpandedId(null);
                void deleteComment(expanded.id, filePath);
              }}
            >
              Delete
            </button>
          </div>
          {pickerFor && (
            <div className="mt-1.5">
              <AgentPickerDropdown
                workspaceId={workspaceId}
                onPick={(target) =>
                  pickerFor === 'all' ? sendAll(target) : sendOne(expanded, target)
                }
              />
            </div>
          )}
        </div>
      )}

      {highlights.map((h) => {
        const { top, left, orphan } = hlMarkerPos(h);
        if (!orphan && (top < 0 || top > containerHeight)) return null;
        const isExpanded = expandedHighlightId === h.id;
        return (
          <button
            key={h.id}
            data-testid={`highlight-marker-${h.id}`}
            title={`Highlight: ${h.quotedText.slice(0, 80)}`}
            onClick={() => setExpandedHighlightId((id) => (id === h.id ? null : h.id))}
            className={`pointer-events-auto absolute rounded-sm border border-black/40 shadow-sm bg-yellow-400 hover:scale-125 transition-transform ${
              isExpanded ? 'scale-125 ring-2 ring-yellow-300/80' : ''
            }`}
            style={{ top: top + 3, left, width: MARKER_SIZE, height: MARKER_SIZE }}
          />
        );
      })}

      {highlightExpanded && (
        <div
          data-testid="highlight-card"
          className="ui-menu pointer-events-auto absolute p-2"
          style={{
            left: CARD_RIGHT,
            top: Math.max(
              4,
              Math.min(highlightPositions.get(highlightExpanded.id)?.top ?? 4, containerHeight - 140),
            ),
            width: CARD_WIDTH,
          }}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-400">
              Highlight
            </span>
            <button
              className="ui-btn text-[11px] px-1.5 py-0"
              onClick={() => setExpandedHighlightId(null)}
              title="Collapse"
            >
              ✕
            </button>
          </div>
          <div className="px-2 py-1 mb-2 border-l-2 border-yellow-400/70 text-[12px] text-gray-400 italic whitespace-pre-wrap max-h-24 overflow-auto">
            {highlightExpanded.quotedText}
          </div>
          <button
            className="ui-btn text-[12px]"
            onClick={() => {
              setExpandedHighlightId(null);
              void deleteComment(highlightExpanded.id, filePath);
            }}
          >
            Remove highlight
          </button>
        </div>
      )}
    </div>
  );
}

function markerCardTop(
  comment: SelectionComment,
  positions: Map<string, MarkerPosition | null>,
): number {
  return positions.get(comment.id)?.top ?? 4;
}

/**
 * Right edge (viewport px) of the comment's text column — the nearest
 * non-inline block ancestor of `node`, which spans the full column width so
 * its right edge gives a consistent rail for all markers. Falls back to null
 * when layout is unavailable (jsdom) so the caller can use the container edge.
 */
function blockRightEdge(node: Node, container: HTMLElement): number | null {
  const view = container.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  while (el && el !== container) {
    const display = view.getComputedStyle(el).display;
    if (display && display !== 'inline' && display !== 'inline-block') {
      const right = el.getBoundingClientRect().right;
      // jsdom reports 0 for everything — treat as "no layout".
      return right > 0 ? right : null;
    }
    el = el.parentElement;
  }
  return null;
}
