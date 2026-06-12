// In-window change signal for external prompt-staging writes.
//
// selection-dispatch appends notes to an agent's staging directly in
// localStorage. A mounted PromptStaging panel holds its own React copy and
// persists it on every change, so without a signal it would clobber the
// appended note on its next save. The browser 'storage' event does NOT fire
// for same-document writes, hence this explicit CustomEvent.

export const STAGING_EXTERNAL_CHANGE_EVENT = 'prompt-staging:external-change';

export interface StagingExternalChangeDetail {
  agentId: string;
}

export function notifyStagingExternalChange(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent<StagingExternalChangeDetail>(STAGING_EXTERNAL_CHANGE_EVENT, {
      detail: { agentId },
    }),
  );
}

export function onStagingExternalChange(
  agentId: string,
  callback: () => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<StagingExternalChangeDetail>).detail;
    if (detail?.agentId === agentId) callback();
  };
  window.addEventListener(STAGING_EXTERNAL_CHANGE_EVENT, handler);
  return () => window.removeEventListener(STAGING_EXTERNAL_CHANGE_EVENT, handler);
}
