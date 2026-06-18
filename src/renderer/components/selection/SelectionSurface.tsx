// Thin selection-to-agent wrapper for read-mode surfaces (plan §7 WP-P4;
// WP-P5-B adds comment persistence). Owns the container ref +
// useSelectionActions so each renderer's diff is one import + one wrapping
// element. The `display: contents` wrapper adds no box, so the wrapped
// renderer's h-full/flex layout chain is untouched; contextmenu events from
// children still bubble through it.
//
// Two ways to provide the selection context:
//  - `tabId`  — file-viewer shorthand: derives a 'file' context from the open
//    tab in the dashboard store (renderers only receive tabId).
//  - `getContext` — explicit context for non-file-tab surfaces (notes, WP-P6).
//    Wins over tabId when both are set.
//
// Slice 2: markdown file tabs get capabilities.comment = true — "Add
// comment…" saves a draft row, and one-shot "Comment & send" persists the
// row before sending through main (`comments:send`). Non-persisting
// contexts fall back to the slice-1 renderer dispatch (comment rides the
// prompt, no DB row).

import React, { useCallback, useRef } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import {
  useSelectionActions,
  type SelectionCommentDetail,
} from '../../lib/selection/useSelectionActions';
import { sendSelectionToAgent } from '../../lib/selection/selection-dispatch';
import {
  createDraftComment,
  createHighlight,
  sendPersistedComments,
} from '../../lib/selection/comment-actions';
import { showSelectionToast } from '../../lib/selection/selection-toast';
import type { SelectionAgentTarget, SelectionContext } from '../../lib/selection/selection-types';
import { getCanvasEditorHandle } from '../fileviewer/MilkdownEditor';

export type SurfaceSelectionContext = Omit<SelectionContext, 'quotedText'>;

interface Props {
  tabId?: string;
  getContext?: () => SurfaceSelectionContext;
  /** Markdown source for anchor capture (read-mode renderers pass their
   * content prop). Fallback chain: this → canvas editor handle → tab edit
   * state → null (anchors omitted). */
  getDocText?: () => string | null;
  children: React.ReactNode;
}

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath);
}

// Pure derivation, exported for unit tests. The bare path goes into
// sourceLabel — buildQuotedPrompt prefixes `Source: file ` for file targets.
// Comment capability is markdown-only for now: those are the surfaces with a
// gutter to display the rows (canvas WYSIWYG + markdown read mode).
export function deriveFileSelectionContext(
  tab: { filePath: string; workspaceId?: string } | undefined,
  selectedWorkspaceId: string | null,
): SurfaceSelectionContext {
  const filePath = tab?.filePath ?? '';
  return {
    targetType: 'file',
    workspaceId: tab?.workspaceId ?? selectedWorkspaceId ?? '',
    sourceLabel: filePath,
    file: { filePath },
    capabilities: { comment: isMarkdownPath(filePath) },
  };
}

export default function SelectionSurface({ tabId, getContext, getDocText, children }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tab = useDashboardStore((s) =>
    tabId ? s.openTabs.find((t) => t.id === tabId) : undefined,
  );
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);

  const getDocTextRef = useRef(getDocText);
  getDocTextRef.current = getDocText;

  const resolveDocText = useCallback((): string | null => {
    const fromProp = getDocTextRef.current?.();
    if (fromProp != null) return fromProp;
    if (tabId) {
      const handle = getCanvasEditorHandle(tabId);
      if (handle) return handle.getMarkdown();
      const editState = useDashboardStore.getState().tabEditState[tabId];
      if (editState) return editState.originalContent;
    }
    return null;
  }, [tabId]);

  const persistDraft = useCallback(
    async (detail: SelectionCommentDetail) => {
      const filePath = detail.context.file?.filePath;
      if (!filePath) throw new Error('No file path for this surface');
      const currentTab = tabId
        ? useDashboardStore.getState().openTabs.find((t) => t.id === tabId)
        : undefined;
      return createDraftComment({
        workspaceId: detail.context.workspaceId,
        filePath,
        pathType: currentTab?.pathType,
        rootDirectory: currentTab?.rootDirectory,
        quotedText: detail.context.quotedText,
        body: detail.body,
        prefix: detail.prefix,
        suffix: detail.suffix,
        docText: resolveDocText(),
      });
    },
    [tabId, resolveDocText],
  );

  const handleSaveComment = useCallback(
    async (detail: SelectionCommentDetail) => {
      try {
        await persistDraft(detail);
        showSelectionToast('Comment saved');
      } catch (err) {
        showSelectionToast(
          `Failed to save comment: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
    [persistDraft],
  );

  const handleHighlight = useCallback(
    async (detail: SelectionCommentDetail) => {
      const filePath = detail.context.file?.filePath;
      if (!filePath) return;
      const currentTab = tabId
        ? useDashboardStore.getState().openTabs.find((t) => t.id === tabId)
        : undefined;
      try {
        await createHighlight({
          workspaceId: detail.context.workspaceId,
          filePath,
          pathType: currentTab?.pathType,
          rootDirectory: currentTab?.rootDirectory,
          quotedText: detail.context.quotedText,
          prefix: detail.prefix,
          suffix: detail.suffix,
          docText: resolveDocText(),
        });
      } catch (err) {
        showSelectionToast(
          `Failed to highlight: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
    [tabId, resolveDocText],
  );

  const handleCommentAndSend = useCallback(
    async (detail: SelectionCommentDetail, target: SelectionAgentTarget) => {
      const filePath = detail.context.file?.filePath;
      if (!detail.context.capabilities.comment || !filePath) {
        // Non-persisting context: slice-1 dispatch, comment rides the prompt.
        await sendSelectionToAgent(target, detail.context, [
          { quote: detail.context.quotedText, comment: detail.body },
        ]);
        return;
      }
      try {
        const row = await persistDraft(detail);
        await sendPersistedComments([row.id], target, filePath);
      } catch (err) {
        showSelectionToast(
          `Failed to send comment: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
    [persistDraft],
  );

  const { menuElement } = useSelectionActions({
    containerRef,
    getContext: getContext ?? (() => deriveFileSelectionContext(tab, selectedWorkspaceId)),
    onSaveComment: handleSaveComment,
    onCommentAndSend: handleCommentAndSend,
    onHighlight: handleHighlight,
  });

  return (
    <div ref={containerRef} className="contents">
      {children}
      {menuElement}
    </div>
  );
}
