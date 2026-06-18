// In-window change signal for selection-comment rows, mirroring
// staging-events.ts: the gutter holds its own loaded copy of a file's
// comments, and popover saves / sends / deletes happen elsewhere in the
// tree, so mutations announce themselves here. Async main-side transitions
// (queued → sent/send_failed) arrive separately via api.comments.onChanged.

export const SELECTION_COMMENTS_CHANGED_EVENT = 'selection-comments:changed';

export interface SelectionCommentsChangedDetail {
  filePath: string;
}

export function notifyCommentsChanged(filePath: string): void {
  window.dispatchEvent(
    new CustomEvent<SelectionCommentsChangedDetail>(SELECTION_COMMENTS_CHANGED_EVENT, {
      detail: { filePath },
    }),
  );
}

export function onCommentsChanged(filePath: string, callback: () => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<SelectionCommentsChangedDetail>).detail;
    if (detail?.filePath === filePath) callback();
  };
  window.addEventListener(SELECTION_COMMENTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SELECTION_COMMENTS_CHANGED_EVENT, handler);
}
