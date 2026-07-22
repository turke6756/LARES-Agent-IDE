/**
 * Renderer side of the main-window/app close flush handshake (edit-loss plan
 * §4.3). Main intercepts the shell close and asks every editing renderer —
 * the main window and each detached file window — to drive its dirty tabs to
 * disk; this bridge answers those requests with `saveCoordinator.flushAll`
 * outcomes so main can decide close vs dialog.
 *
 * Registered once from the renderer entry (main.tsx) so it exists in BOTH
 * window flavors regardless of which components are mounted. Tolerates an
 * absent preload surface (unit tests, older preload) by no-opping.
 */
import { flushAll } from './saveCoordinator';
import type { FlushReplyPayload, FlushRequestPayload } from '../../../shared/types';

interface FlushBridgeApi {
  tabs?: {
    onFlushRequest?: (cb: (req: FlushRequestPayload) => void) => () => void;
    flushReply?: (payload: FlushReplyPayload) => Promise<void>;
  };
}

export function initCloseFlushBridge(): () => void {
  const api = (window as unknown as { api?: FlushBridgeApi }).api;
  if (!api?.tabs?.onFlushRequest || !api.tabs.flushReply) return () => {};
  const reply = api.tabs.flushReply;
  return api.tabs.onFlushRequest((req) => {
    void flushAll(req.deadlineMs, { action: req.action, tabIds: req.tabIds })
      .then((results) => reply({ requestId: req.requestId, results }))
      .catch((err) =>
        // A reply must always go back — an unanswered request reads as a
        // whole-window timeout on the main side. Report a synthetic error row
        // (not an empty list, which would read as "nothing to save") so the
        // dialog surfaces the failure instead of closing over it.
        reply({
          requestId: req.requestId,
          results: [{
            tabId: 'window:flush-failed',
            fileName: 'this window',
            outcome: 'error',
            error: err instanceof Error ? err.message : 'flush failed',
          }],
        }),
      );
  });
}
