// WP1-A task 5 (plans/embedded-browser-implementation-tasks.md) — IPC
// surface for the embedded browser pane. Implements the FROZEN WP1 contract
// (channel names + payload shapes in src/shared/browser.ts; renderer side is
// WP1-B's window.api.browser). Registered from index.ts with one call —
// deliberately kept OUT of ipc-handlers.ts to avoid file contention.

import { ipcMain } from 'electron';
import type { BrowserManager } from './browser-manager';
import { getRuntimeActionsEnabled, setRuntimeActionsEnabled } from './browser-policy';
import {
  BROWSER_CHANNELS,
  type AccessRequestDecision,
  type AccessRuleInput,
  type BrowserBounds,
  type BrowserContextMenuParams,
  type BrowserCreateTabOptions,
  type HistoryQuery,
} from '../../shared/browser';

export function registerBrowserIpc(manager: BrowserManager): void {
  ipcMain.handle(BROWSER_CHANNELS.createTab, (_e, opts: BrowserCreateTabOptions) =>
    manager.createTab(opts),
  );
  ipcMain.handle(BROWSER_CHANNELS.closeTab, (_e, tabId: string) => manager.closeTab(tabId));
  ipcMain.handle(BROWSER_CHANNELS.navigate, (_e, tabId: string, url: string) =>
    manager.navigate(tabId, url),
  );
  ipcMain.handle(BROWSER_CHANNELS.goBack, (_e, tabId: string) => manager.goBack(tabId));
  ipcMain.handle(BROWSER_CHANNELS.goForward, (_e, tabId: string) => manager.goForward(tabId));
  ipcMain.handle(BROWSER_CHANNELS.reload, (_e, tabId: string) => manager.reload(tabId));
  ipcMain.handle(BROWSER_CHANNELS.stop, (_e, tabId: string) => manager.stop(tabId));
  ipcMain.handle(BROWSER_CHANNELS.setActiveTab, (_e, tabId: string | null) =>
    manager.setActiveTab(tabId),
  );
  ipcMain.handle(BROWSER_CHANNELS.setBounds, (_e, bounds: BrowserBounds) =>
    manager.setBounds(bounds),
  );
  ipcMain.handle(BROWSER_CHANNELS.setVisible, (_e, visible: boolean) =>
    manager.setVisible(visible),
  );
  ipcMain.handle(BROWSER_CHANNELS.setActiveWorkspace, (_e, workspaceId: string | null) =>
    manager.setActiveWorkspace(workspaceId),
  );

  // ── M12 coarse act-tier gate (runtime toggle) ──────────────────────────────
  // Trusted-renderer chrome reads/flips the process-global runtime flag (the
  // gate in browser-manager consults it live). Coerce to boolean defensively —
  // the renderer is trusted, but the channel takes an arbitrary IPC arg.
  ipcMain.handle(BROWSER_CHANNELS.getActionsEnabled, () => getRuntimeActionsEnabled());
  ipcMain.handle(BROWSER_CHANNELS.setActionsEnabled, (_e, enabled: boolean) =>
    setRuntimeActionsEnabled(Boolean(enabled)),
  );

  // ── Overhaul (WP0) invoke channels → manager methods ───────────────────────
  // Pure plumbing. Event channels (tabsSnapshot / shortcutCommand / foundInPage
  // / contextMenuCommand / bookmarksChanged) are main → renderer sends and are
  // NOT registered here. Bookmarks/history are USER-PARTITION ONLY by contract.

  // Tab management (WP7) — main is authoritative for order/pin/closed-tab stack.
  ipcMain.handle(BROWSER_CHANNELS.reorderTab, (_e, tabId: string, toOrder: number) =>
    manager.reorderTab(tabId, toOrder),
  );
  ipcMain.handle(BROWSER_CHANNELS.setTabPinned, (_e, tabId: string, pinned: boolean) =>
    manager.setTabPinned(tabId, pinned),
  );
  ipcMain.handle(BROWSER_CHANNELS.reopenClosedTab, () => manager.reopenClosedTab());

  // Find-in-page + zoom (WP5) — native WebContents APIs only.
  ipcMain.handle(
    BROWSER_CHANNELS.findInPage,
    (_e, tabId: string, text: string, opts?: { forward?: boolean; findNext?: boolean }) =>
      manager.findInPage(tabId, text, opts),
  );
  ipcMain.handle(BROWSER_CHANNELS.stopFindInPage, (_e, tabId: string) =>
    manager.stopFindInPage(tabId),
  );
  ipcMain.handle(BROWSER_CHANNELS.setZoom, (_e, tabId: string, zoomFactor: number) =>
    manager.setZoom(tabId, zoomFactor),
  );

  // Native context menu (WP6) — renderer forwards coords; main pops the menu.
  ipcMain.handle(
    BROWSER_CHANNELS.contextMenuRequest,
    (_e, tabId: string, params: BrowserContextMenuParams) =>
      manager.contextMenuRequest(tabId, params),
  );

  // Bookmarks (WP3) — USER-PARTITION ONLY.
  ipcMain.handle(BROWSER_CHANNELS.bookmarkList, () => manager.bookmarkList());
  ipcMain.handle(BROWSER_CHANNELS.bookmarkAdd, (_e, input: { title: string; url: string }) =>
    manager.bookmarkAdd(input),
  );
  ipcMain.handle(BROWSER_CHANNELS.bookmarkRemove, (_e, id: string) => manager.bookmarkRemove(id));
  ipcMain.handle(BROWSER_CHANNELS.bookmarkReorder, (_e, orderedIds: string[]) =>
    manager.bookmarkReorder(orderedIds),
  );

  // History (WP4) — USER-PARTITION ONLY.
  ipcMain.handle(BROWSER_CHANNELS.historyList, (_e, query?: HistoryQuery) =>
    manager.historyList(query),
  );
  ipcMain.handle(BROWSER_CHANNELS.historyDelete, (_e, id: string) => manager.historyDelete(id));
  ipcMain.handle(BROWSER_CHANNELS.historyClear, () => manager.historyClear());

  // ── Website-access policy (plans/website-allowlist-simplification.md) ───────
  // TRUSTED CHROME ONLY. ONE agent allowlist; enforcement keyed to the Agent
  // Actions toggle (no per-list mode). Rule mutations and request decisions
  // invalidate the manager's sync access cache THEN emit accessChanged (request
  // decisions also emit accessRequestsChanged) — the manager owns that ordering.
  ipcMain.handle(BROWSER_CHANNELS.accessRuleList, () => manager.accessRuleList());
  ipcMain.handle(BROWSER_CHANNELS.accessRuleAdd, (_e, input: AccessRuleInput) =>
    manager.accessRuleAdd(input),
  );
  ipcMain.handle(
    BROWSER_CHANNELS.accessRuleUpdate,
    (_e, id: string, patch: Partial<AccessRuleInput> & { enabled?: boolean }) =>
      manager.accessRuleUpdate(id, patch),
  );
  ipcMain.handle(BROWSER_CHANNELS.accessRuleRemove, (_e, id: string) =>
    manager.accessRuleRemove(id),
  );

  // Agent-initiated access requests (§18) — list + human decision (trusted).
  ipcMain.handle(BROWSER_CHANNELS.accessRequestList, () => manager.accessRequestList());
  ipcMain.handle(
    BROWSER_CHANNELS.accessRequestDecide,
    (_e, id: string, decision: AccessRequestDecision) => manager.accessRequestDecide(id, decision),
  );

  // Five trusted-chrome-only authenticated-drive IPCs (§14). Never callable
  // from agent tools or page content.
  ipcMain.handle(BROWSER_CHANNELS.accessHandoffSignin, (_e, ruleId: string) =>
    manager.accessHandoffSignin(ruleId),
  );
  ipcMain.handle(BROWSER_CHANNELS.accessHandoffReady, (_e, tabId: string) =>
    manager.accessHandoffReady(tabId),
  );
  ipcMain.handle(BROWSER_CHANNELS.accessTabHandToAgent, (_e, tabId: string) =>
    manager.accessTabHandToAgent(tabId),
  );
  ipcMain.handle(BROWSER_CHANNELS.accessTabReturnToHuman, (_e, tabId: string) =>
    manager.accessTabReturnToHuman(tabId),
  );
  ipcMain.handle(BROWSER_CHANNELS.accessClearSiteSession, (_e, ruleId: string) =>
    manager.accessClearSiteSession(ruleId),
  );
}
