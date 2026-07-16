// The reader's comment pipeline (Phase 3.4): persisted rows → reattached, live
// per-page geometry, kept fresh by the shared comment-events bus.
//
// This is the IO half; every decision it makes lives in the pure
// `lib/pdf/pdf-comment-placement` module, which is where the ladder policy and
// the write policy are tested. The hook only:
//   1. loads the rows for this file and keeps the PDF-anchored ones;
//   2. WARMS exactly the pages the ladder will read (a page the ladder wanted but
//      could not see would degrade a perfectly good comment to 'orphaned', so the
//      warm set is computed from the same radius the ladder walks);
//   3. runs the ladder synchronously over that warmed snapshot;
//   4. applies any durable rewrites the ladder concluded (converges — the
//      resulting reload produces no further writes);
//   5. re-runs on local mutations (comment-events) and on main-side status
//      transitions (api.comments.onChanged), so the overlay updates live.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SelectionComment } from '../../../shared/types';
import type { NormalizedPageText } from '../../lib/pdf/pdf-text-geometry';
import type { PdfTextModel } from '../../lib/pdf/pdf-text-model';
import type { LiveDocument } from '../../lib/pdf/pdf-comment-anchors';
import {
  groupPlacementsByPage,
  isPdfCommentRow,
  pagesToWarm,
  placePdfComments,
} from '../../lib/pdf/pdf-comment-placement';
import type { PdfCommentPlacement } from '../../lib/pdf/pdf-comment-placement';
import { onCommentsChanged } from '../../lib/selection/comment-events';
import { updatePdfAnchor } from '../../lib/selection/comment-actions';

export interface UsePdfCommentsParams {
  workspaceId?: string;
  filePath: string;
  /** Null until the document opens; the hook idles until then. */
  textModel: PdfTextModel | null;
  pageCount: number;
}

export interface UsePdfCommentsResult {
  placements: PdfCommentPlacement[];
  /** Display copies grouped by the page they paint on — PdfPageSlot's input. */
  commentsByPage: Map<number, SelectionComment[]>;
  reload: () => void;
}

const EMPTY_BY_PAGE: Map<number, SelectionComment[]> = new Map();

export function usePdfComments({
  workspaceId,
  filePath,
  textModel,
  pageCount,
}: UsePdfCommentsParams): UsePdfCommentsResult {
  const [placements, setPlacements] = useState<PdfCommentPlacement[]>([]);
  // Monotonic token: an in-flight load whose token is stale (file switched, or a
  // newer reload started) must never write its result into state.
  const tokenRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++tokenRef.current;
    if (!workspaceId || !filePath || !textModel) {
      setPlacements([]);
      return;
    }
    try {
      const rows = await window.api.comments.list(workspaceId, filePath);
      if (token !== tokenRef.current) return;
      const pdfRows = rows.filter(isPdfCommentRow);
      if (pdfRows.length === 0) {
        setPlacements([]);
        return;
      }

      const fingerprint = textModel.fingerprint;
      const warm = pagesToWarm(pdfRows, fingerprint, pageCount);
      const texts = new Map<number, NormalizedPageText>();
      await Promise.all(
        warm.map(async (pageIndex) => {
          try {
            texts.set(pageIndex, await textModel.getPageText(pageIndex));
          } catch {
            // A page whose text can't be extracted (scanned/broken) simply isn't
            // in the lookup; the ladder treats it as "no text here", which is the
            // truth, and coordinate-only notes are unaffected.
          }
        }),
      );
      if (token !== tokenRef.current) return;

      const live: LiveDocument = {
        fingerprint,
        pageCount,
        getPageText: (pageIndex) => texts.get(pageIndex) ?? null,
      };
      const { placements: next, writes } = placePdfComments(pdfRows, live);
      setPlacements(next);

      // Durable ladder outcomes. Each write notifies comment-events, which
      // re-enters this loader; the second pass yields no writes, so it settles.
      for (const w of writes) {
        try {
          await updatePdfAnchor(w.id, w.anchor, w.status, filePath);
        } catch (err) {
          console.error('[pdf] failed to persist reattach outcome', err);
        }
      }
    } catch (err) {
      console.error('[pdf] failed to load comments', err);
    }
  }, [workspaceId, filePath, textModel, pageCount]);

  const reload = useCallback(() => void load(), [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!workspaceId || !filePath) return;
    const offLocal = onCommentsChanged(filePath, () => void load());
    const offMain = window.api.comments.onChanged(({ comments: changed }) => {
      if (changed.some((c) => c.filePath === filePath)) void load();
    });
    return () => {
      offLocal();
      offMain();
    };
  }, [workspaceId, filePath, load]);

  // Invalidate the token on unmount so a late resolve can't set state.
  useEffect(() => () => { tokenRef.current++; }, []);

  const commentsByPage = useMemo(
    () => (placements.length === 0 ? EMPTY_BY_PAGE : groupPlacementsByPage(placements)),
    [placements],
  );

  return { placements, commentsByPage, reload };
}
