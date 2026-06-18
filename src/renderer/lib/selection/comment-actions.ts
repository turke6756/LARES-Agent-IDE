// Renderer-side actions over WP-P5-A's `window.api.comments` IPC.
// Creation captures anchors here (the renderer owns the DOM/selection);
// sends run in MAIN (`comments:send` — status transitions live next to the
// DB, plan §1.8). The 'agent-busy' result carries the prompt main built, so
// the busy fallback is byte-identical to what would have been sent.

import type {
  PathType,
  SelectionComment,
  SelectionCommentSendTarget,
  SendSelectionCommentsResult,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { loadStaging, saveStaging, newNoteId } from '../prompt-staging';
import { notifyStagingExternalChange } from './staging-events';
import { showSelectionToast } from './selection-toast';
import { notifyCommentsChanged } from './comment-events';
import { computeSourceAnchor } from './comment-anchors';
// The one shared content hash (plan §6.3) — doc_hash must be byte-for-byte
// consistent with the canvas write-echo guard, never an inline reimplementation.
import { contentHash } from '../../components/fileviewer/markdownSplice';

export interface DraftCommentCapture {
  workspaceId: string;
  filePath: string;
  pathType?: PathType;
  rootDirectory?: string;
  quotedText: string;
  body: string;
  /** ~32 chars either side of the selection, captured at menu-open time. */
  prefix: string;
  suffix: string;
  /** Markdown source to anchor against; null = anchors omitted. */
  docText: string | null;
}

/** Persist a `draft` row, computing offsets/lines/doc_hash when the quote is
 * locatable in the source. Throws on IPC failure (callers toast). */
export async function createDraftComment(capture: DraftCommentCapture): Promise<SelectionComment> {
  const anchor =
    capture.docText != null
      ? computeSourceAnchor(capture.docText, capture.quotedText, capture.prefix, capture.suffix)
      : null;
  const comment = await window.api.comments.create({
    workspaceId: capture.workspaceId,
    filePath: capture.filePath,
    pathType: capture.pathType,
    rootDirectory: capture.rootDirectory,
    quotedText: capture.quotedText,
    body: capture.body,
    prefix: capture.prefix || undefined,
    suffix: capture.suffix || undefined,
    docHash: capture.docText != null ? contentHash(capture.docText) : undefined,
    anchorStart: anchor?.anchorStart,
    anchorEnd: anchor?.anchorEnd,
    lineStart: anchor?.lineStart,
    lineEnd: anchor?.lineEnd,
  });
  notifyCommentsChanged(capture.filePath);
  return comment;
}

/** Capture for a plain highlight — same anchors as a comment, but no body. */
export type HighlightCapture = Omit<DraftCommentCapture, 'body'>;

/** Persist a `highlight` row (empty body). Same anchor capture as a comment;
 * the gutter paints it yellow in both edit and view modes. Throws on IPC
 * failure (callers toast). */
export async function createHighlight(capture: HighlightCapture): Promise<SelectionComment> {
  const anchor =
    capture.docText != null
      ? computeSourceAnchor(capture.docText, capture.quotedText, capture.prefix, capture.suffix)
      : null;
  const highlight = await window.api.comments.create({
    workspaceId: capture.workspaceId,
    kind: 'highlight',
    filePath: capture.filePath,
    pathType: capture.pathType,
    rootDirectory: capture.rootDirectory,
    quotedText: capture.quotedText,
    body: '',
    prefix: capture.prefix || undefined,
    suffix: capture.suffix || undefined,
    docHash: capture.docText != null ? contentHash(capture.docText) : undefined,
    anchorStart: anchor?.anchorStart,
    anchorEnd: anchor?.anchorEnd,
    lineStart: anchor?.lineStart,
    lineEnd: anchor?.lineEnd,
  });
  notifyCommentsChanged(capture.filePath);
  return highlight;
}

/**
 * Send one or many persisted comments through main. Surfaces every outcome
 * as a toast; 'agent-busy' runs the slice-1 prompt-staging fallback with the
 * exact prompt main built (never reject-and-lose, plan §1.5).
 */
export async function sendPersistedComments(
  commentIds: string[],
  target: SelectionCommentSendTarget,
  filePath: string,
): Promise<SendSelectionCommentsResult> {
  let result: SendSelectionCommentsResult;
  try {
    result = await window.api.comments.send({ commentIds, target });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    showSelectionToast(`Failed to send comment: ${error}`, 'error');
    return { ok: false, code: 'invalid-request', error };
  }

  const agentTitle = (agentId: string): string =>
    useDashboardStore.getState().agents.find((a) => a.id === agentId)?.title ?? 'agent';

  if (result.ok) {
    showSelectionToast(
      result.launched
        ? 'Launching agent…'
        : `Sent ${commentIds.length > 1 ? `${commentIds.length} comments` : 'comment'} to "${agentTitle(result.agentId)}"`,
    );
  } else if (result.code === 'agent-busy' && target.kind === 'existing') {
    const staging = loadStaging(target.agentId);
    saveStaging(target.agentId, {
      ...staging,
      slots: [...staging.slots, { kind: 'note', id: newNoteId(), text: result.prompt }],
    });
    notifyStagingExternalChange(target.agentId);
    showSelectionToast(
      `Agent "${agentTitle(target.agentId)}" is busy — saved to its prompt staging`,
    );
  } else {
    showSelectionToast(`Failed to send comment: ${result.error}`, 'error');
  }

  notifyCommentsChanged(filePath);
  return result;
}

export async function resolveComment(id: string, filePath: string): Promise<void> {
  await window.api.comments.resolve(id);
  notifyCommentsChanged(filePath);
}

export async function deleteComment(id: string, filePath: string): Promise<void> {
  await window.api.comments.delete(id);
  notifyCommentsChanged(filePath);
}

/** Reattach bookkeeping from the gutter: draft ↔ orphaned flips. */
export async function setCommentStatus(
  id: string,
  status: 'draft' | 'orphaned',
  filePath: string,
): Promise<void> {
  await window.api.comments.update(id, { status });
  notifyCommentsChanged(filePath);
}
