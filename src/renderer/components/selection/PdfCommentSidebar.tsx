// PDF comment sidebar (plan §1.10).
//
// The PDF analogue of FileCommentGutter. Where the gutter measures DOM ranges to
// place markers, the sidebar takes page/rectangle locations from the PDF RUNTIME
// (Part 2's PdfRenderer, injected here so this trunk piece is engine-independent
// and testable without a live viewer). It reuses the shared CommentCard and the
// exact send/resolve/delete dispatch, so text and PDF comments share one stack.
//
// Interactions (plan §1.10): clicking a card or its pin navigates the viewer to
// the anchored page and flashes its rects (delegated to the runtime); the pin is
// the click target the overlay layer (Part 2.4 / z2) drives.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SelectionComment } from '../../../shared/types';
import { onCommentsChanged } from '../../lib/selection/comment-events';
import { deleteComment, resolveComment, sendPersistedComments } from '../../lib/selection/comment-actions';
import type { SelectionAgentTarget } from '../../lib/selection/selection-types';
import CommentCard from './CommentCard';

/** Where a comment sits in the sidebar, derived by the PDF runtime from the
 *  anchor's page + rects (NOT from DOM measurement). */
export interface PdfCommentLocation {
  pageIndex: number;
  pageLabel?: string;
  /** Vertical offset (px) in the sidebar's scroll space. */
  top: number;
}

/** The slice of the Part 2 PDF viewer the sidebar depends on. Kept minimal so
 *  the sidebar is built and unit-tested ahead of the raster engine. */
export interface PdfSidebarRuntime {
  /** Location for a comment, or null when its page isn't laid out yet. */
  locationFor(comment: SelectionComment): PdfCommentLocation | null;
  /** Scroll the viewer to the comment's anchored page and flash its rects. */
  navigateToComment(comment: SelectionComment): void;
}

interface Props {
  workspaceId: string;
  filePath: string;
  runtime: PdfSidebarRuntime;
  /** PHASE-3 SEAM (optional): rows supplied by the host. When present the
   *  sidebar renders these instead of loading + subscribing itself — the PDF
   *  reader already loads and REATTACHES the rows (usePdfComments), so a second
   *  independent load would both duplicate the IPC and paint stale geometry.
   *  Omitted (the Phase-1 standalone shape) it stays self-loading. */
  comments?: SelectionComment[];
  /** Controlled open card, so an overlay pin (z2) can open the sidebar's card
   *  (plan §1.10). Uncontrolled when omitted. */
  expandedId?: string | null;
  onExpandedChange?: (id: string | null) => void;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  queued: 'Sending…',
  sent: 'Sent',
  send_failed: 'Send failed',
  'needs-review': 'Needs review',
  orphaned: 'Orphaned',
};

const SENDABLE = new Set(['draft', 'send_failed', 'orphaned', 'needs-review']);

const CARD_WIDTH = 300;
/** Shared by the card element and the click-away test — keep them from drifting. */
const CARD_TESTID = 'pdf-comment-card';
const PIN_SIZE = 12;

export default function PdfCommentSidebar({
  workspaceId, filePath, runtime, comments: fedComments, expandedId: controlledId, onExpandedChange,
}: Props) {
  const [loadedComments, setLoadedComments] = useState<SelectionComment[]>([]);
  const [uncontrolledId, setUncontrolledId] = useState<string | null>(null);

  const hostDriven = fedComments !== undefined;
  const comments = fedComments ?? loadedComments;
  const expandedId = controlledId !== undefined ? controlledId : uncontrolledId;
  const setExpandedId = useCallback(
    (next: string | null) => {
      if (onExpandedChange) onExpandedChange(next);
      if (controlledId === undefined) setUncontrolledId(next);
    },
    [onExpandedChange, controlledId],
  );

  const reload = useCallback(async () => {
    if (!workspaceId || !filePath) return;
    try {
      const rows = await window.api.comments.list(workspaceId, filePath);
      setLoadedComments(rows.filter((c) => c.anchorType === 'pdf'));
    } catch (err) {
      console.error('[PdfCommentSidebar] failed to load comments', err);
    }
  }, [workspaceId, filePath]);

  useEffect(() => {
    // Host-driven: the reader owns loading + reattachment; don't double-subscribe.
    if (hostDriven || !workspaceId || !filePath) return;
    void reload();
    const offLocal = onCommentsChanged(filePath, () => void reload());
    const offMain = window.api.comments.onChanged(({ comments: changed }) => {
      if (changed.some((c) => c.filePath === filePath)) void reload();
    });
    return () => {
      offLocal();
      offMain();
    };
  }, [hostDriven, workspaceId, filePath, reload]);

  // Comments with a body (sendable cards) vs. plain highlights (pin only).
  const cards = useMemo(
    () => comments.filter((c) => c.kind !== 'highlight' && c.status !== 'resolved'),
    [comments],
  );

  const draftIds = useMemo(
    () =>
      cards
        .filter((c) => c.status === 'draft')
        .sort((a, b) => {
          const la = runtime.locationFor(a)?.top ?? Number.MAX_SAFE_INTEGER;
          const lb = runtime.locationFor(b)?.top ?? Number.MAX_SAFE_INTEGER;
          return la !== lb ? la - lb : a.createdAt.localeCompare(b.createdAt);
        })
        .map((c) => c.id),
    [cards, runtime],
  );

  const expanded = expandedId ? cards.find((c) => c.id === expandedId) ?? null : null;

  const open = (comment: SelectionComment) => {
    setExpandedId(expandedId === comment.id ? null : comment.id);
    runtime.navigateToComment(comment);
  };

  // Dismissal. The ✕ in the card header was the ONLY way out, and a small
  // unlabelled glyph is not discoverable — an open card read as "stuck", with
  // the tab itself the only escape. The two gestures people actually reach for
  // (Escape, click away) now both close it. Scoped to this PDF sidebar on
  // purpose: CommentCard is shared with the markdown gutter, which is untouched.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedId(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // Inside the card: not "away".
      if (t.closest(`[data-testid="${CARD_TESTID}"]`)) return;
      // A pin already TOGGLES. Closing here too would close-then-reopen, so the
      // dot would appear dead — the very bug this is fixing.
      if (t.closest('[data-testid^="pdf-comment-pin-"], [data-testid^="pdf-overlay-pin-"]')) return;
      setExpandedId(null);
    };
    document.addEventListener('keydown', onKey);
    // Capture: close before the reader's own mouseup/selection handling runs.
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [expanded, setExpandedId]);

  const sendOne = (comment: SelectionComment, target: SelectionAgentTarget) => {
    setExpandedId(null);
    void sendPersistedComments([comment.id], target, filePath);
  };
  const sendAll = (target: SelectionAgentTarget) => {
    setExpandedId(null);
    if (draftIds.length > 0) void sendPersistedComments(draftIds, target, filePath);
  };

  const pageLabelFor = (comment: SelectionComment): string => {
    const loc = runtime.locationFor(comment);
    const page = loc ? loc.pageIndex : comment.pdfAnchor?.pages[0]?.pageIndex ?? 0;
    const label = loc?.pageLabel;
    return label && label !== String(page + 1) ? `Page ${page + 1} (${label})` : `Page ${page + 1}`;
  };

  return (
    <div data-testid="pdf-comment-sidebar" className="pointer-events-none absolute inset-0">
      {cards.map((c) => {
        const loc = runtime.locationFor(c);
        if (!loc) return null;
        return (
          <button
            key={c.id}
            data-testid={`pdf-comment-pin-${c.id}`}
            data-status={c.status}
            title={`${STATUS_LABEL[c.status] ?? c.status}: ${c.body.slice(0, 80)}`}
            onClick={() => open(c)}
            className={`pointer-events-auto absolute rounded-sm border border-black/40 shadow-sm bg-accent-blue hover:scale-125 transition-transform ${
              expandedId === c.id ? 'scale-125 ring-2 ring-accent-blue/70' : ''
            }`}
            style={{ top: loc.top + 3, right: 10, width: PIN_SIZE, height: PIN_SIZE }}
          />
        );
      })}

      {expanded && (
        <CommentCard
          comment={expanded}
          workspaceId={workspaceId}
          statusLabel={STATUS_LABEL[expanded.status] ?? expanded.status}
          sendable={SENDABLE.has(expanded.status)}
          draftCount={draftIds.length}
          locationLabel={pageLabelFor(expanded)}
          style={{
            right: 26,
            top: Math.max(4, runtime.locationFor(expanded)?.top ?? 4),
            width: CARD_WIDTH,
          }}
          testId={CARD_TESTID}
          onClose={() => setExpandedId(null)}
          onSendOne={(target) => sendOne(expanded, target)}
          onSendAll={(target) => sendAll(target)}
          onResolve={() => void resolveComment(expanded.id, filePath)}
          onDelete={() => void deleteComment(expanded.id, filePath)}
        />
      )}
    </div>
  );
}
