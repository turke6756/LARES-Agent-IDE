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
  type AgentActionsCommand,
  type AccessRuleInput,
  type BookmarkPatch,
  type BrowserBounds,
  type BrowserContextMenuParams,
  type BrowserCreateTabOptions,
  type BrowserFindOptions,
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

  // ── Slice 12: armed-state agent-actions gate ───────────────────────────────
  // Richer state than the boolean above: disabled | armed + armedUntil +
  // lastChangedAt. The manager owns the auto-expiry timer + the change broadcast.
  ipcMain.handle(BROWSER_CHANNELS.getActionsState, () => manager.getAgentActionsState());
  ipcMain.handle(BROWSER_CHANNELS.setActionsState, (_e, cmd: AgentActionsCommand) =>
    manager.setAgentActionsState(cmd),
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

  // Slice 10/11 — session restore + idle-discard threshold. sessionRestore is a
  // PULL the renderer issues once (idempotent; second call → []). The threshold
  // setter writes the mutable idle-discard bound (null = Never).
  ipcMain.handle(BROWSER_CHANNELS.sessionRestore, () => manager.restoreSession());
  ipcMain.handle(BROWSER_CHANNELS.browserDiscardThreshold, (_e, ms: number | null) =>
    manager.setDiscardThreshold(ms),
  );

  // Find-in-page + zoom (WP5) — native WebContents APIs only.
  ipcMain.handle(
    BROWSER_CHANNELS.findInPage,
    (_e, tabId: string, text: string, opts?: { forward?: boolean; findNext?: boolean }) =>
      manager.findInPage(tabId, text, opts),
  );
  ipcMain.handle(BROWSER_CHANNELS.stopFindInPage, (_e, tabId: string) =>
    manager.stopFindInPage(tabId),
  );
  // Slice 15: stateful find — per-tab query/state, immediate next/prev, restore.
  ipcMain.handle(
    BROWSER_CHANNELS.find,
    (_e, tabId: string, query: string, opts?: BrowserFindOptions) =>
      manager.find(tabId, query, opts),
  );
  ipcMain.handle(BROWSER_CHANNELS.findNext, (_e, tabId: string) => manager.findNext(tabId));
  ipcMain.handle(BROWSER_CHANNELS.findPrev, (_e, tabId: string) => manager.findPrev(tabId));
  ipcMain.handle(BROWSER_CHANNELS.stopFind, (_e, tabId: string) => manager.stopFind(tabId));
  ipcMain.handle(BROWSER_CHANNELS.setZoom, (_e, tabId: string, zoomFactor: number) =>
    manager.setZoom(tabId, zoomFactor),
  );
  // Slice 15: reset zoom to 100% AND clear the persisted per-origin row (USER).
  ipcMain.handle(BROWSER_CHANNELS.resetZoomForOrigin, (_e, tabId: string) =>
    manager.resetZoomForOrigin(tabId),
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
  // Slice-7 — edit title/favicon/folder; preserves id + sort order.
  ipcMain.handle(BROWSER_CHANNELS.bookmarkUpdate, (_e, id: string, patch: BookmarkPatch) =>
    manager.bookmarkUpdate(id, patch),
  );
  ipcMain.handle(BROWSER_CHANNELS.bookmarkReorder, (_e, orderedIds: string[]) =>
    manager.bookmarkReorder(orderedIds),
  );

  // Omnibox suggestions (Slice-6) — TRUSTED CHROME ONLY. USER-PARTITION ranked
  // + de-duped suggestions; agent URLs are never surfaced (manager-side guard).
  ipcMain.handle(BROWSER_CHANNELS.omniboxSuggest, (_e, query: string) =>
    manager.omniboxSuggest(query),
  );

  // History (WP4) — USER-PARTITION ONLY.
  ipcMain.handle(BROWSER_CHANNELS.historyList, (_e, query?: HistoryQuery) =>
    manager.historyList(query),
  );
  ipcMain.handle(BROWSER_CHANNELS.historyDelete, (_e, id: string) => manager.historyDelete(id));
  ipcMain.handle(BROWSER_CHANNELS.historyClear, () => manager.historyClear());
  ipcMain.handle(BROWSER_CHANNELS.historyTopSites, (_e, limit?: number) =>
    manager.historyTopSites(limit),
  );

  // ── Slice-3: denial toasts + live Activity/Audit drawer ────────────────────
  // TRUSTED CHROME ONLY. auditRecent primes the drawer with the JSONL tail; the
  // matching auditEvent push (BROWSER_CHANNELS.auditEvent) is a main → renderer
  // send emitted by the manager's ActionAudit tap and is NOT registered here.
  ipcMain.handle(BROWSER_CHANNELS.auditRecent, (_e, limit?: number) =>
    manager.getRecentAudit(typeof limit === 'number' ? limit : undefined),
  );

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

  // Slice 12 (handoff / session center): the "Sessions shared with agents"
  // snapshot — live handed tabs + persisted signed-in origins. Trusted chrome
  // only; the agentDrivingRevoked event is pushed from the manager directly.
  ipcMain.handle(BROWSER_CHANNELS.getSharedSessions, () => manager.getSharedSessions());

  // Slice 13 (user-only downloads): the lifecycle events (downloadStarted/
  // Progress/Done/Failed) and the downloadPrompt confirm request are pushed
  // main → renderer from the manager directly. These invokes are the
  // trusted-chrome control surface for the shelf. downloadConfirm approves a
  // pending USER download (downloadPrompt token); the rest manage records.
  ipcMain.handle(BROWSER_CHANNELS.downloadList, () => manager.listDownloads());
  ipcMain.handle(BROWSER_CHANNELS.downloadConfirm, (_e, id: string) => manager.confirmDownload(id));
  ipcMain.handle(BROWSER_CHANNELS.downloadOpenFile, (_e, id: string) => manager.openDownloadFile(id));
  ipcMain.handle(BROWSER_CHANNELS.downloadShowInFolder, (_e, id: string) =>
    manager.showDownloadInFolder(id),
  );
  ipcMain.handle(BROWSER_CHANNELS.downloadRetry, (_e, id: string) => manager.retryDownload(id));
  ipcMain.handle(BROWSER_CHANNELS.downloadRemove, (_e, id: string) =>
    manager.removeDownloadRecord(id),
  );

  // ── Slice 14: reading mode ─────────────────────────────────────────────────
  // TRUSTED CHROME ONLY. Extract + sanitize the live article of an http(s) USER
  // tab in main. The manager self-gates to user/http(s) tabs and never routes
  // this through agent tools or the CDP attach path.
  ipcMain.handle(BROWSER_CHANNELS.enterReadingMode, (_e, tabId: string) =>
    manager.enterReadingMode(tabId),
  );
}
