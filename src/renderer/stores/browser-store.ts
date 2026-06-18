import { create } from 'zustand';
import { useDashboardStore } from './dashboard-store';
import type {
  AccessHandoffResult,
  AccessRequest,
  AccessRequestDecision,
  AccessRule,
  AccessRuleInput,
  BrowserAuditEntry,
} from '../../shared/browser';
// Slice-3: the PURE policy module (no Electron) is the single source of truth for
// denial copy/remediation — shared by the toast + drawer + this store's dedupe.
import { denialCopyForOutcome, type DenialCode } from '../../main/browser/browser-policy';

// Re-export the frozen website-access shapes so renderer components import them
// from one place (the store) rather than reaching into src/shared directly.
export type {
  AccessHandoffResult,
  AccessRequest,
  AccessRequestDecision,
  AccessRule,
  AccessRuleInput,
  BrowserAuditEntry,
};

// ── Frozen WP1-A IPC contract, renderer-local mirror ─────────────────────────
// `window.api` is typed as IpcApi in src/shared/types.ts; WP1-A extends it with
// the `browser` namespace. WP1-B must not edit src/shared/ or src/preload/, so
// the contract is mirrored here and reached through a null-tolerant accessor:
// until WP1-A merges, getBrowserApi() returns null and the pane renders an
// explanatory empty state instead of crashing.
//
// Any change to these shapes requires BOTH workers + a progress-log note
// (plans/embedded-browser-implementation-tasks.md).

export type BrowserPartition = 'user' | 'agent';

export interface BrowserTabState {
  tabId: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  partition: BrowserPartition;
  /** Per-workspace isolation: the workspace this tab belongs to. The strip /
   *  pane only show tabs whose workspaceId matches the selected workspace
   *  (mirrors the file-viewer tabs). Additive/optional — missing = unscoped. */
  workspaceId?: string | null;
  /** Set by Phase 2 (WP2) for tabs opened by agent tools — additive, optional. */
  openedByAgent?: boolean;
  /** Overhaul (WP5) current zoom factor (1 = 100%) — additive, optional. */
  zoomFactor?: number;
  /** Overhaul (WP2) true for a URL-less New Tab page — additive, optional. */
  isNewTab?: boolean;
  /** Website-allowlist §12-B (F4): main pushes the authoritative Mechanism-B
   *  handed flag so the "Agent driving" badge is driven by truth, not a local
   *  URL-drift heuristic. Additive/optional — missing = false. */
  handedToAgent?: boolean;
  /** Website-allowlist §12-A (F4): main pushes the authoritative sign-in
   *  quarantine flag. Additive/optional — missing = false. */
  signinPending?: boolean;
  /** Slice-1 (premium browser): connection-security indicator from the committed
   *  URL scheme — 'secure' (https) / 'insecure' (http) / 'internal' (NTP/empty).
   *  Drives the address-bar lock glyph. Additive/optional — missing = internal. */
  secureState?: 'secure' | 'insecure' | 'internal';
  /** Slice-1: last main-frame load failure / renderer crash for the trusted-chrome
   *  error panel. NEVER page content — only code/description/url shell strings.
   *  Cleared (null) on the next load start / successful navigation. Additive. */
  lastError?: { code: string; description: string; url: string } | null;
  /** Slice-2 (premium browser): identity of the agent that opened this tab —
   *  drives the "Opened by <title>" tab tooltip. Additive/optional — absent for
   *  human-opened tabs. */
  openedByAgentId?: string;
  openedByAgentTitle?: string;
  /** Slice-2: authoritative attention model. Main SETS this once (with a fresh
   *  `lastAttentionAt`) when an agent opens/raises the tab; the renderer flashes
   *  the tab briefly and clears its LOCAL attention on select. `lastAttentionAt`
   *  only advances on a new open/raise, so the store distinguishes a fresh
   *  attention event from an unrelated tab-state push. Additive/optional. */
  needsHumanAttention?: boolean;
  lastAttentionAt?: number;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Denied window.open payload. WP1-A emits `{ tabId, url }` (tabId = the tab
 * whose page requested the popup — see the progress log); we only need `url`,
 * and defensively also accept a bare URL string. */
export type BrowserOpenRequest = { tabId?: string; url: string } | string;

// ── Overhaul (WP0) shared shapes — renderer mirror (keep in sync with
//    src/shared/browser.ts). Mirror only; feature logic lands in later WPs. ──
export interface BrowserTabSnapshotEntry {
  tabId: string;
  order: number;
  pinned: boolean;
  partition: BrowserPartition;
}

export interface BrowserFindResult {
  tabId: string;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface BrowserContextMenuParams {
  tabId: string;
  /** view-relative DIP */
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  selectionText: string;
  isEditable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  mediaType: 'none' | 'image' | 'video' | 'audio' | 'canvas' | 'file' | 'plugin';
}

export type BrowserShortcut =
  | 'new-tab'
  | 'close-tab'
  | 'focus-address'
  | 'reload'
  | 'cycle-next'
  | 'cycle-prev'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'reopen-closed'
  | 'history'
  | 'bookmark';

/** USER-PARTITION ONLY (agent URLs never persisted/exposed). */
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  sortOrder: number;
}

/** USER-PARTITION ONLY (agent navigations never recorded/listed). */
export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

export interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface BrowserApi {
  createTab(opts: { partition: BrowserPartition; url?: string; workspaceId?: string | null }): Promise<{ tabId: string }>;
  closeTab(tabId: string): unknown;
  navigate(tabId: string, url: string): unknown;
  goBack(tabId: string): unknown;
  goForward(tabId: string): unknown;
  reload(tabId: string): unknown;
  stop(tabId: string): unknown;
  /** null = hide all views */
  setActiveTab(tabId: string | null): unknown;
  /** Per-workspace isolation: tell main which workspace the human is viewing. */
  setActiveWorkspace(workspaceId: string | null): unknown;
  /** DIP, window-content-relative */
  setBounds(bounds: BrowserBounds): unknown;
  /** Pane suspension for renderer overlays (WebContentsView paints above DOM). */
  setVisible(visible: boolean): unknown;
  /** M12 coarse act-tier gate (dashboard-global runtime flag). Not persisted. */
  getActionsEnabled(): Promise<boolean>;
  setActionsEnabled(enabled: boolean): Promise<boolean>;
  onTabState(cb: (state: BrowserTabState) => void): () => void;
  onOpenRequest(cb: (req: BrowserOpenRequest) => void): () => void;

  // ── Overhaul (WP0) — additive plumbing (mirror only). ──────────────────────
  reorderTab(tabId: string, toOrder: number): unknown;
  setTabPinned(tabId: string, pinned: boolean): unknown;
  reopenClosedTab(): Promise<{ tabId: string } | null>;
  findInPage(tabId: string, text: string, opts?: { forward?: boolean; findNext?: boolean }): unknown;
  stopFindInPage(tabId: string): unknown;
  setZoom(tabId: string, zoomFactor: number): unknown;
  contextMenuRequest(tabId: string, params: BrowserContextMenuParams): unknown;
  /** USER-PARTITION ONLY. */
  bookmarkList(): Promise<Bookmark[]>;
  bookmarkAdd(input: { title: string; url: string }): Promise<Bookmark>;
  bookmarkRemove(id: string): unknown;
  bookmarkReorder(orderedIds: string[]): unknown;
  /** USER-PARTITION ONLY. */
  historyList(query?: HistoryQuery): Promise<HistoryEntry[]>;
  historyDelete(id: string): unknown;
  historyClear(): unknown;
  onTabsSnapshot(cb: (entries: BrowserTabSnapshotEntry[]) => void): () => void;
  onShortcutCommand(cb: (shortcut: BrowserShortcut, ctx: { tabId: string }) => void): () => void;
  onFoundInPage(cb: (result: BrowserFindResult) => void): () => void;
  onContextMenuCommand(cb: (action: string, params: BrowserContextMenuParams) => void): () => void;
  onBookmarksChanged(cb: (bookmarks: Bookmark[]) => void): () => void;

  // ── Slice-3: denial toasts + live Activity/Audit drawer (trusted chrome). ──
  auditRecent(limit?: number): Promise<BrowserAuditEntry[]>;
  onAuditEvent(cb: (entry: BrowserAuditEntry) => void): () => void;

  // ── Website-access policy (plans/website-allowlist-design.md). Trusted shell
  //    chrome only — the renderer reaches the frozen window.api.browser.access
  //    surface (src/preload). add/update re-normalize the hostname server-side
  //    and THROW on `*`/unparseable — those rejections surface in the add form. ─
  access: {
    list(): Promise<AccessRule[]>;
    add(input: AccessRuleInput): Promise<AccessRule>;
    update(id: string, patch: Partial<AccessRuleInput> & { enabled?: boolean }): Promise<AccessRule>;
    remove(id: string): Promise<void>;
    onChanged(cb: () => void): () => void;
    requestList(): Promise<AccessRequest[]>;
    requestDecide(id: string, decision: AccessRequestDecision): Promise<void>;
    onRequestsChanged(cb: () => void): () => void;
    handoffSignin(ruleId: string): Promise<AccessHandoffResult>;
    handoffReady(tabId: string): Promise<void>;
    tabHandToAgent(tabId: string): Promise<void>;
    tabReturnToHuman(tabId: string): Promise<void>;
    clearSiteSession(ruleId: string): Promise<void>;
  };
}

/** Per-workspace isolation: the subset of tabs belonging to the workspace the
 *  human is currently viewing. Mirrors the file viewer's per-workspace tab
 *  filter (a tab with no workspaceId matches the "no workspace selected" state).
 *  Components read this instead of the raw `tabs` list. */
export function selectVisibleTabs(state: {
  tabs: BrowserTabState[];
  selectedWorkspaceId: string | null;
}): BrowserTabState[] {
  return state.tabs.filter((t) => (t.workspaceId ?? null) === state.selectedWorkspaceId);
}

/** Slice-3: best-effort hostname from an audit row's url for the drawer's "host"
 *  column, the "This host" filter, and the toast dedupe key. Empty string for a
 *  non-parseable / empty url (NTP, about:blank) so callers compare safely. */
export function auditHost(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Slice-3: audit rows scoped to the workspace the human is viewing — mirrors
 *  selectVisibleTabs exactly (a row with no workspaceId matches the "no workspace
 *  selected" state). The drawer, unread-denial badge, and toast all derive from
 *  this so they never leak another workspace's agent activity. */
export function selectVisibleAuditEvents(state: {
  auditEvents: BrowserAuditEntry[];
  selectedWorkspaceId: string | null;
}): BrowserAuditEntry[] {
  return state.auditEvents.filter(
    (e) => (e.workspaceId ?? null) === state.selectedWorkspaceId,
  );
}

/** Slice-3: a live denial toast. `key` is the host+code dedupe key; `id` is
 *  unique per surfaced toast (so re-surfacing after the 10s window gets a fresh
 *  timer + DOM node). */
export interface DenialToast {
  id: string;
  key: string;
  code: DenialCode;
  title: string;
  body: string;
  action: 'none' | 'open-access-settings' | 'enable-actions';
  host: string;
  /** epoch ms the toast was surfaced — drives both the 6s auto-dismiss and the
   *  10s dedupe window. */
  shownAt: number;
}

const AUDIT_RING_CAP = 200;
const TOAST_DEDUPE_MS = 10_000;

export function getBrowserApi(): BrowserApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { api?: { browser?: BrowserApi } }).api;
  return api?.browser ?? null;
}

// ── Address-bar URL normalization (pure — unit-tested) ───────────────────────
// Bare hosts get the https:// default scheme. Inputs that already carry a
// scheme pass through untouched: the main process (WP1-A M6 gates) is the
// enforcement point for scheme policy, not the address bar.
export function normalizeAddressInput(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  // Protocol-relative ("//host/path") — pick the default scheme.
  if (input.startsWith('//')) return `https:${input}`;
  return `https://${input}`;
}

// ── Website-access rule matching (pure — advisory UI gating only) ────────────
// Mirrors the §4 matchesRule semantics so the tab-strip "Hand to agent" item
// can grey itself out when the committed origin is NOT an allow-signed-in agent
// rule. The MAIN process is the enforcement point and revalidates/refuses every
// handoff — this is purely so the UI doesn't offer an action that would bounce.
export function matchesAccessRule(
  url: string,
  rule: { hostname: string; includeSubdomains: boolean; scheme: 'https' | 'http' | 'any'; pathPrefix?: string },
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // scheme: 'any' still requires the http(s) floor; otherwise exact match.
  if (rule.scheme === 'any') {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  } else if (u.protocol !== `${rule.scheme}:`) {
    return false;
  }
  // hostname: strip trailing dot; the '.' + host guard blocks evilgithub.com.
  const host = u.hostname.replace(/\.$/, '');
  const hostOk = rule.includeSubdomains
    ? host === rule.hostname || host.endsWith(`.${rule.hostname}`)
    : host === rule.hostname;
  if (!hostOk) return false;
  // pathPrefix: when set and not '/', require a path-segment boundary match so
  // /app does not match /apple.
  if (rule.pathPrefix && rule.pathPrefix !== '/') {
    const prefix = rule.pathPrefix.endsWith('/') ? rule.pathPrefix : `${rule.pathPrefix}/`;
    if (u.pathname !== rule.pathPrefix && !u.pathname.startsWith(prefix)) return false;
  }
  return true;
}

/** The enabled, allow-signed-in agent rule whose origin a URL falls under (if
 *  any). Used to gate the tab-strip hand-off item; null when none matches. */
export function agentSignedInRuleForUrl(url: string, rules: AccessRule[]): AccessRule | null {
  return (
    rules.find((r) => r.enabled && r.allowSignedIn && matchesAccessRule(url, r)) ?? null
  );
}

// Find-in-page debounce — module-level so closeFind() can cancel a pending run.
const FIND_DEBOUNCE_MS = 180;
let findDebounceTimer: number | null = null;

function openRequestUrl(req: BrowserOpenRequest): string | null {
  if (typeof req === 'string') return req || null;
  if (req && typeof req.url === 'string' && req.url) return req.url;
  return null;
}

// ── Store ────────────────────────────────────────────────────────────────────

interface BrowserStoreState {
  /** Ordered tab list — order is the strip order. Holds tabs across ALL
   *  workspaces; the UI filters to `selectedWorkspaceId` (see visibleTabs). */
  tabs: BrowserTabState[];
  activeTabId: string | null;
  /** Per-workspace isolation: the workspace the human is currently viewing.
   *  Mirrors useDashboardStore.selectedWorkspaceId (synced by the bridge). The
   *  strip / pane show only tabs whose workspaceId matches this. */
  selectedWorkspaceId: string | null;
  /** Tabs pulsing for attention (agent-opened, plan §4 UX). */
  attentionTabIds: Record<string, true>;
  /** Entry-button pulse when an agent tab arrives while the pane is hidden
   * and the file viewer holds the center (file viewer wins precedence). */
  paneAttention: boolean;
  /** Denied window.open surfaced by main — offered as "open in new tab". */
  pendingOpenUrl: string | null;
  /** M12 coarse act-tier gate (dashboard-global). Mirror of the main-process
   *  runtime flag; loaded on mount, flipped by the chrome toggle. Not persisted
   *  — each app launch re-seeds from AGENT_BROWSER_ACTIONS (default OFF). */
  actionsEnabled: boolean;

  createTab: (partition?: BrowserPartition, url?: string) => Promise<string | null>;
  closeTab: (tabId: string) => void;
  selectTab: (tabId: string) => void;
  /** Per-workspace isolation: the human switched workspaces. Re-point the active
   *  tab at one in the new workspace and tell main to re-scope (mirror of the
   *  file-viewer's selectWorkspace active-tab re-point). */
  handleWorkspaceChange: (workspaceId: string | null) => void;
  navigate: (tabId: string, rawInput: string) => void;
  goBack: (tabId: string) => void;
  goForward: (tabId: string) => void;
  reload: (tabId: string) => void;
  stop: (tabId: string) => void;

  loadActionsEnabled: () => Promise<void>;
  setActionsEnabled: (enabled: boolean) => Promise<void>;

  handleTabState: (state: BrowserTabState) => void;
  handleOpenRequest: (req: BrowserOpenRequest) => void;
  acceptOpenRequest: () => Promise<void>;
  dismissOpenRequest: () => void;
  clearPaneAttention: () => void;

  // ── Overhaul feature slices (WP3 bookmarks · WP4 history · WP5 find/zoom ·
  //    WP7 tab snapshot) — additive. Every navigation/open still routes through
  //    the existing navigate/createTab actions (→ main M6 gate); nothing here
  //    constructs a WebContentsView or bypasses it. ──────────────────────────

  // Bookmarks (USER-PARTITION ONLY — backend never persists/exposes agent URLs).
  bookmarks: Bookmark[];
  bookmarkBarVisible: boolean;
  /** StarMenu watches this; the 'bookmark' shortcut bumps it to pop the editor. */
  bookmarkTick: number;
  loadBookmarks: () => Promise<void>;
  addBookmark: (input: { title: string; url: string }) => Promise<void>;
  removeBookmark: (id: string) => void;
  reorderBookmark: (orderedIds: string[]) => void;
  toggleBookmarkBar: () => void;

  // History (USER-PARTITION ONLY).
  historyViewOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  fetchHistory: (query?: string) => Promise<HistoryEntry[]>;
  deleteHistory: (id: string) => void;
  clearHistory: () => void;

  // Find-in-page (counts only ever cross the wire — never page text).
  findOpen: boolean;
  findState: { activeMatchOrdinal: number; matches: number };
  openFind: () => void;
  closeFind: () => void;
  runFind: (text: string, opts?: { forward?: boolean; findNext?: boolean }) => void;

  // Zoom — zoomFactor echoes back via the existing onTabState payload.
  setZoom: (tabId: string, factor: number) => void;

  // Main-authoritative tab order/pin snapshot + intents.
  snapshot: BrowserTabSnapshotEntry[];
  reorderTab: (tabId: string, toOrder: number) => void;
  setTabPinned: (tabId: string, pinned: boolean) => void;
  reopenClosedTab: () => Promise<void>;

  // ── Tab groups (renderer-derived UI state; see components/browser/tab-groups.ts) ──
  // Collapse/expand is pure UI — grouping is derived from `partition`, so no
  // IPC change. Agent tabs start collapsed (the pile-up we're taming); the
  // human's own tabs start expanded. `openGroupId` is the group whose dropdown
  // list popover is currently open (null = none).
  groupCollapsed: Record<'agent' | 'user', boolean>;
  openGroupId: 'agent' | 'user' | null;
  toggleGroupCollapsed: (id: 'agent' | 'user') => void;
  openGroupDropdown: (id: 'agent' | 'user' | null) => void;

  // UI-reaction ticks pushed by main-side keyboard shortcuts.
  /** AddressBar focuses its field when this changes. */
  focusAddressTick: number;

  // Event handlers wired by ensureBrowserBridge (mirror of handleTabState etc.).
  handleTabsSnapshot: (entries: BrowserTabSnapshotEntry[]) => void;
  handleFoundInPage: (result: BrowserFindResult) => void;
  handleShortcutCommand: (shortcut: BrowserShortcut, ctx: { tabId: string }) => void;
  handleContextMenuCommand: (action: string, params: BrowserContextMenuParams) => void;

  // ── Slice-3: denial toasts + live Activity/Audit drawer ────────────────────
  // The M16 action-audit feed surfaced to trusted chrome. `auditEvents` is a raw
  // ring buffer (cap 200) across workspaces; components filter to the selected
  // workspace via selectVisibleAuditEvents (mirrors selectVisibleTabs). The
  // unread-denial badge counts denials seen since the drawer was last opened;
  // opening the drawer resets it. `denialToasts` are surfaced on each denied
  // event for the active workspace, deduped by host+code within 10s.
  auditEvents: BrowserAuditEntry[];
  auditDrawerOpen: boolean;
  /** Newest-first denials surfaced since the drawer was last opened, for the
   *  AddressBar "Activity" badge. Reset by openAuditDrawer(). */
  auditUnreadDenials: number;
  denialToasts: DenialToast[];
  /** Prime the drawer with the JSONL tail (oldest→newest); called on bridge init. */
  loadRecentAudit: () => Promise<void>;
  /** Ring-buffer push + denial toast/unread bookkeeping (wired to onAuditEvent). */
  handleAuditEvent: (entry: BrowserAuditEntry) => void;
  openAuditDrawer: () => void;
  closeAuditDrawer: () => void;
  dismissDenialToast: (id: string) => void;

  // ── Website-access policy (plans/website-allowlist-simplification.md) ───────
  // Full-pane overlay (modeled on HistoryView) + the single agent allowlist,
  // the agent-request inbox (pending-approval box), and the authenticated-drive
  // hand-off actions. Enforcement is keyed to the Agent Actions toggle — there
  // is no per-list mode. All mutations refetch via the onChanged /
  // onRequestsChanged events (mirror of how bookmarks refresh through
  // onBookmarksChanged).
  accessViewOpen: boolean;
  accessRules: AccessRule[];
  accessRequests: AccessRequest[];
  /** Mechanism-A sign-in handoff in flight (§12-A/§15). While set, a visible
   *  quarantined agent-partition login tab is open and the four-point consent
   *  banner is shown in the browser chrome (NOT in the pane-suspending overlay,
   *  which would hide the very tab the human must type into). null = idle. */
  signinHandoff: { tabId: string; ruleId: string; hostname: string } | null;
  /** Surfaced in the banner when "Hand to agent" is refused (tab wandered off
   *  the allow-signed-in origin — §12-A step 4). */
  signinHandoffError: string | null;
  /** Tabs the human handed to the agent (Mechanism B). Runtime-only mirror —
   *  the frozen tab-state contract carries no handedToAgent flag, so the badge
   *  + "Return tab to me" item track it here, set on tabHandToAgent and cleared
   *  on return/close or when the tab navigates off the allow-signed-in origin
   *  (mirrors the main-side off-origin auto-revoke, §12-B). */
  handedTabIds: Record<string, true>;

  openAccessView: () => void;
  closeAccessView: () => void;
  loadAccessRules: () => Promise<void>;
  /** Throws on a server-side rejection (`*`/unparseable hostname) — the add
   *  form awaits and surfaces the message. */
  addAccessRule: (input: AccessRuleInput) => Promise<AccessRule>;
  /** Throws on a server-side rejection (re-normalized hostname) — callers that
   *  edit the hostname must surface it; flag/enable toggles cannot fail this way. */
  updateAccessRule: (id: string, patch: Partial<AccessRuleInput> & { enabled?: boolean }) => Promise<void>;
  removeAccessRule: (id: string) => Promise<void>;
  loadAccessRequests: () => Promise<void>;
  decideAccessRequest: (id: string, decision: AccessRequestDecision) => Promise<void>;
  handoffSignin: (ruleId: string) => Promise<AccessHandoffResult | null>;
  handoffReady: (tabId: string) => Promise<void>;
  /** Mechanism-A: open the quarantined visible login tab and raise the consent
   *  banner; closes the overlay so the tab is visible. */
  beginSigninHandoff: (rule: AccessRule) => Promise<void>;
  /** Mechanism-A: the human finished typing → revalidate + clear quarantine. */
  completeSigninHandoff: () => Promise<void>;
  /** Abandon the sign-in: close the quarantined tab + clear banner state. */
  cancelSigninHandoff: () => void;
  tabHandToAgent: (tabId: string) => Promise<boolean>;
  tabReturnToHuman: (tabId: string) => Promise<void>;
  clearSiteSession: (ruleId: string) => Promise<void>;
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  selectedWorkspaceId: null,
  attentionTabIds: {},
  paneAttention: false,
  pendingOpenUrl: null,
  actionsEnabled: false,

  // Overhaul feature-slice initial state.
  bookmarks: [],
  bookmarkBarVisible: true,
  bookmarkTick: 0,
  historyViewOpen: false,
  findOpen: false,
  findState: { activeMatchOrdinal: 0, matches: 0 },
  snapshot: [],
  groupCollapsed: { agent: true, user: false },
  openGroupId: null,
  focusAddressTick: 0,

  // Slice-3 — denial toasts + Activity/Audit drawer initial state.
  auditEvents: [],
  auditDrawerOpen: false,
  auditUnreadDenials: 0,
  denialToasts: [],

  // Website-access policy initial state (single agent allowlist).
  accessViewOpen: false,
  accessRules: [],
  accessRequests: [],
  handedTabIds: {},
  signinHandoff: null,
  signinHandoffError: null,

  createTab: async (partition = 'user', url?) => {
    const api = getBrowserApi();
    if (!api) return null;
    // Per-workspace isolation: stamp the human's current workspace so the new
    // tab belongs to (and only shows in) the workspace they're viewing.
    const workspaceId = get().selectedWorkspaceId;
    try {
      const { tabId } = await api.createTab({ partition, url, workspaceId });
      set((s) => ({
        // onTabState may have raced us — don't duplicate.
        tabs: s.tabs.some((t) => t.tabId === tabId)
          ? s.tabs
          : [
              ...s.tabs,
              {
                tabId,
                url: url ?? '',
                title: '',
                loading: Boolean(url),
                canGoBack: false,
                canGoForward: false,
                partition,
                workspaceId,
              },
            ],
        activeTabId: tabId,
      }));
      return tabId;
    } catch (err) {
      console.error('browser.createTab failed:', err);
      return null;
    }
  },

  closeTab: (tabId) => {
    try {
      getBrowserApi()?.closeTab(tabId);
    } catch (err) {
      console.error('browser.closeTab failed:', err);
    }
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.tabId === tabId);
      if (idx === -1) return s;
      const closedWs = s.tabs[idx].workspaceId ?? null;
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      let activeTabId = s.activeTabId;
      if (activeTabId === tabId) {
        // Activate a neighbor IN THE SAME WORKSPACE (a cross-workspace tab is
        // hidden, so picking one would blank the pane). Falls back to null when
        // the workspace has no other tabs.
        const sameWs = tabs.filter((t) => (t.workspaceId ?? null) === closedWs);
        activeTabId = sameWs.length === 0 ? null : sameWs[Math.min(idx, sameWs.length - 1)].tabId;
      }
      const { [tabId]: _gone, ...attentionTabIds } = s.attentionTabIds;
      const { [tabId]: _unhanded, ...handedTabIds } = s.handedTabIds;
      return { tabs, activeTabId, attentionTabIds, handedTabIds };
    });
  },

  selectTab: (tabId) => {
    set((s) => {
      if (!s.tabs.some((t) => t.tabId === tabId)) return s;
      const { [tabId]: _seen, ...attentionTabIds } = s.attentionTabIds;
      return { activeTabId: tabId, attentionTabIds };
    });
  },

  handleWorkspaceChange: (workspaceId) => {
    // Tell main first so its snapshot/visibility/new-tab stamping re-scope.
    try {
      getBrowserApi()?.setActiveWorkspace(workspaceId);
    } catch (err) {
      console.error('browser.setActiveWorkspace failed:', err);
    }
    set((s) => {
      // Re-point the active tab at one that belongs to the new workspace —
      // without this, activeTabId can stay on the previous workspace's tab and
      // the pane would render a hidden/foreign tab (mirror of the file viewer's
      // selectWorkspace re-point).
      const active = s.tabs.find((t) => t.tabId === s.activeTabId);
      const activeBelongs = (active?.workspaceId ?? null) === workspaceId;
      const activeTabId = activeBelongs
        ? s.activeTabId
        : s.tabs.find((t) => (t.workspaceId ?? null) === workspaceId)?.tabId ?? null;
      return { selectedWorkspaceId: workspaceId, activeTabId };
    });
  },

  navigate: (tabId, rawInput) => {
    const url = normalizeAddressInput(rawInput);
    if (!url) return;
    try {
      getBrowserApi()?.navigate(tabId, url);
    } catch (err) {
      console.error('browser.navigate failed:', err);
      return;
    }
    // Optimistic; onTabState is the source of truth and will correct us.
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, url, loading: true } : t)),
    }));
  },

  goBack: (tabId) => void getBrowserApi()?.goBack(tabId),
  goForward: (tabId) => void getBrowserApi()?.goForward(tabId),
  reload: (tabId) => void getBrowserApi()?.reload(tabId),
  stop: (tabId) => void getBrowserApi()?.stop(tabId),

  handleTabState: (incoming) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.tabId === incoming.tabId);
      const known = idx !== -1;
      const prev = known ? s.tabs[idx] : undefined;
      const tabs = known
        ? s.tabs.map((t) => (t.tabId === incoming.tabId ? { ...t, ...incoming } : t))
        : [...s.tabs, incoming];

      // Agent-attention flash (Slice-2 authoritative model): a tab we didn't
      // create locally on the agent partition, the Phase-2 openedByAgent flag
      // turning on, OR main re-raising attention on a KNOWN tab (a fresh
      // `lastAttentionAt` stamp on `needsHumanAttention`). Keying the re-raise off
      // the advancing timestamp — not the steady `needsHumanAttention` bit — means
      // an unrelated tab-state push (loading/title) after the human has selected
      // the tab never re-flashes it: main sets attention ONCE, the renderer clears
      // its local mark on select, and the same stamp is ignored thereafter.
      const attentionRaised =
        (!known && (incoming.partition === 'agent' || Boolean(incoming.openedByAgent))) ||
        (Boolean(incoming.openedByAgent) && !prev?.openedByAgent) ||
        (known &&
          Boolean(incoming.needsHumanAttention) &&
          incoming.lastAttentionAt !== undefined &&
          incoming.lastAttentionAt !== prev?.lastAttentionAt);

      let { attentionTabIds, paneAttention, activeTabId } = s;
      if (attentionRaised) {
        attentionTabIds = { ...attentionTabIds, [incoming.tabId]: true };
        const dash = useDashboardStore.getState();
        // Agent browser activity must NEVER auto-open or switch the view — that
        // yanks the user away from what they're doing. Keep the attention signals
        // (tab mark above + entry-button pulse below) so the activity is still
        // noticed, but leave it to the human to open the pane. A HUMAN-initiated
        // for_human_action open is partition 'user' / openedByAgent:false and so
        // never reaches this branch.
        if (!dash.browserOpen) {
          paneAttention = true;
        }
        // Only adopt the arriving tab as active if it belongs to the workspace
        // the human is viewing — a cross-workspace agent tab is hidden, so
        // making it active would blank the pane (per-workspace isolation).
        if (activeTabId === null && (incoming.workspaceId ?? null) === s.selectedWorkspaceId) {
          activeTabId = incoming.tabId;
        }
      }

      // §12-B (F4) Mechanism-B badge upkeep: the "Agent driving" badge and the
      // "Return tab to me" affordance are driven by the AUTHORITATIVE
      // handedToAgent flag that main pushes on every tabState — NOT a local
      // URL-drift heuristic. Main is the single source of truth: it auto-revokes
      // off-origin (did-navigate, §12-B/F2) and on rule mutation (F3), detaches
      // the driver, and pushes fresh state. The renderer just mirrors it, so the
      // badge can never disagree with the actual capability state in main.
      let handedTabIds = s.handedTabIds;
      const mainHanded = Boolean(incoming.handedToAgent);
      if (mainHanded && !handedTabIds[incoming.tabId]) {
        handedTabIds = { ...handedTabIds, [incoming.tabId]: true };
      } else if (!mainHanded && handedTabIds[incoming.tabId]) {
        const { [incoming.tabId]: _revoked, ...rest } = handedTabIds;
        handedTabIds = rest;
      }
      return { tabs, attentionTabIds, paneAttention, activeTabId, handedTabIds };
    });
  },

  // ── M12 coarse act-tier gate (dashboard-global runtime flag) ───────────────
  loadActionsEnabled: async () => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      set({ actionsEnabled: Boolean(await api.getActionsEnabled()) });
    } catch (err) {
      console.error('browser.getActionsEnabled failed:', err);
    }
  },

  setActionsEnabled: async (enabled) => {
    const api = getBrowserApi();
    if (!api) return;
    // Optimistic; reconcile to the main-process echo (authoritative).
    set({ actionsEnabled: enabled });
    try {
      const result = await api.setActionsEnabled(enabled);
      set({ actionsEnabled: Boolean(result) });
    } catch (err) {
      console.error('browser.setActionsEnabled failed:', err);
      // Re-sync from main on failure so the UI never lies about the gate.
      void get().loadActionsEnabled();
    }
  },

  handleOpenRequest: (req) => {
    const url = openRequestUrl(req);
    if (!url) return;
    set({ pendingOpenUrl: url });
  },

  acceptOpenRequest: async () => {
    const url = get().pendingOpenUrl;
    set({ pendingOpenUrl: null });
    if (url) await get().createTab('user', url);
  },

  dismissOpenRequest: () => set({ pendingOpenUrl: null }),

  clearPaneAttention: () => set({ paneAttention: false }),

  // ── Bookmarks ────────────────────────────────────────────────────────────
  loadBookmarks: async () => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      const list = await api.bookmarkList();
      set({ bookmarks: Array.isArray(list) ? list : [] });
    } catch (err) {
      console.error('browser.bookmarkList failed:', err);
    }
  },

  addBookmark: async ({ title, url }) => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      // onBookmarksChanged is the source of truth and will refresh the slice;
      // the manager validates the scheme (defense-in-depth) and stores it.
      await api.bookmarkAdd({ title, url });
    } catch (err) {
      console.error('browser.bookmarkAdd failed:', err);
    }
  },

  removeBookmark: (id) => {
    try {
      getBrowserApi()?.bookmarkRemove(id);
    } catch (err) {
      console.error('browser.bookmarkRemove failed:', err);
    }
  },

  reorderBookmark: (orderedIds) => {
    try {
      getBrowserApi()?.bookmarkReorder(orderedIds);
    } catch (err) {
      console.error('browser.bookmarkReorder failed:', err);
    }
  },

  toggleBookmarkBar: () => set((s) => ({ bookmarkBarVisible: !s.bookmarkBarVisible })),

  // ── History ──────────────────────────────────────────────────────────────
  openHistory: () => set({ historyViewOpen: true }),
  closeHistory: () => set({ historyViewOpen: false }),

  fetchHistory: async (query) => {
    const api = getBrowserApi();
    if (!api) return [];
    try {
      const rows = await api.historyList(query ? { query } : undefined);
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.error('browser.historyList failed:', err);
      return [];
    }
  },

  deleteHistory: (id) => {
    try {
      getBrowserApi()?.historyDelete(id);
    } catch (err) {
      console.error('browser.historyDelete failed:', err);
    }
  },

  clearHistory: () => {
    try {
      getBrowserApi()?.historyClear();
    } catch (err) {
      console.error('browser.historyClear failed:', err);
    }
  },

  // ── Find-in-page ───────────────────────────────────────────────────────────
  openFind: () => set({ findOpen: true }),

  closeFind: () => {
    const { activeTabId } = get();
    if (findDebounceTimer !== null) {
      clearTimeout(findDebounceTimer);
      findDebounceTimer = null;
    }
    if (activeTabId) {
      try {
        getBrowserApi()?.stopFindInPage(activeTabId);
      } catch (err) {
        console.error('browser.stopFindInPage failed:', err);
      }
    }
    set({ findOpen: false, findState: { activeMatchOrdinal: 0, matches: 0 } });
  },

  runFind: (text, opts) => {
    if (findDebounceTimer !== null) clearTimeout(findDebounceTimer);
    const { activeTabId } = get();
    if (!activeTabId) return;
    const trimmed = text;
    // An empty query clears the highlight rather than searching for "".
    if (!trimmed) {
      findDebounceTimer = null;
      try {
        getBrowserApi()?.stopFindInPage(activeTabId);
      } catch (err) {
        console.error('browser.stopFindInPage failed:', err);
      }
      set({ findState: { activeMatchOrdinal: 0, matches: 0 } });
      return;
    }
    findDebounceTimer = (typeof window !== 'undefined' ? window.setTimeout : setTimeout)(() => {
      findDebounceTimer = null;
      try {
        getBrowserApi()?.findInPage(activeTabId, trimmed, opts);
      } catch (err) {
        console.error('browser.findInPage failed:', err);
      }
    }, FIND_DEBOUNCE_MS) as unknown as number;
  },

  // ── Zoom (zoomFactor arrives back via onTabState — no extra plumbing) ──────
  setZoom: (tabId, factor) => {
    try {
      getBrowserApi()?.setZoom(tabId, factor);
    } catch (err) {
      console.error('browser.setZoom failed:', err);
    }
  },

  // ── Tab snapshot intents (main is authoritative; renderer sends intents) ───
  reorderTab: (tabId, toOrder) => {
    try {
      getBrowserApi()?.reorderTab(tabId, toOrder);
    } catch (err) {
      console.error('browser.reorderTab failed:', err);
    }
  },

  setTabPinned: (tabId, pinned) => {
    try {
      getBrowserApi()?.setTabPinned(tabId, pinned);
    } catch (err) {
      console.error('browser.setTabPinned failed:', err);
    }
  },

  reopenClosedTab: async () => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      await api.reopenClosedTab();
    } catch (err) {
      console.error('browser.reopenClosedTab failed:', err);
    }
  },

  // ── Tab groups (UI-only; no main round-trip) ───────────────────────────────
  toggleGroupCollapsed: (id) =>
    set((s) => {
      const collapsed = !s.groupCollapsed[id];
      return {
        groupCollapsed: { ...s.groupCollapsed, [id]: collapsed },
        // Expanding inline and keeping the dropdown open would double-show the
        // members — close the dropdown for this group when it expands.
        openGroupId: !collapsed && s.openGroupId === id ? null : s.openGroupId,
      };
    }),

  openGroupDropdown: (id) => set((s) => ({ openGroupId: s.openGroupId === id ? null : id })),

  // ── Event handlers (wired by ensureBrowserBridge) ──────────────────────────
  handleTabsSnapshot: (entries) => set({ snapshot: Array.isArray(entries) ? entries : [] }),

  handleFoundInPage: (result) => {
    // Only the active tab's counts matter to the FindBar; ignore stragglers.
    const { activeTabId } = get();
    if (result.tabId !== activeTabId) return;
    set({
      findState: {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      },
    });
  },

  handleShortcutCommand: (shortcut) => {
    // Structural chords (new-tab/close/reload/cycle/zoom/reopen) are handled in
    // main; only the UI-reaction chords surface here.
    switch (shortcut) {
      case 'find':
        get().openFind();
        break;
      case 'focus-address':
        set((s) => ({ focusAddressTick: s.focusAddressTick + 1 }));
        break;
      case 'history':
        get().openHistory();
        break;
      case 'bookmark':
        set((s) => ({ bookmarkTick: s.bookmarkTick + 1 }));
        break;
      default:
        break;
    }
  },

  handleContextMenuCommand: (action, params) => {
    const { tabs, activeTabId } = get();
    const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;
    switch (action) {
      case 'copy-link':
        if (params.linkURL && typeof navigator !== 'undefined' && navigator.clipboard) {
          void navigator.clipboard.writeText(params.linkURL).catch((err) => {
            console.error('clipboard.writeText failed:', err);
          });
        }
        break;
      case 'search-selection':
        if (params.selectionText && activeTab) {
          // Inherit the source tab's partition (agent links never escalate).
          void get().createTab(
            activeTab.partition,
            `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`,
          );
        }
        break;
      case 'bookmark-page':
        // Main gates this item to user tabs; bookmark the active page.
        if (activeTab && activeTab.url) {
          void get().addBookmark({ title: activeTab.title || activeTab.url, url: activeTab.url });
        }
        break;
      default:
        break;
    }
  },

  // ── Slice-3: denial toasts + live Activity/Audit drawer ────────────────────
  loadRecentAudit: async () => {
    const api = getBrowserApi();
    if (!api?.auditRecent) return;
    try {
      const entries = await api.auditRecent(AUDIT_RING_CAP);
      // getRecent returns oldest→newest; the ring buffer keeps that order and the
      // drawer renders newest-first by reversing at render time.
      set({ auditEvents: Array.isArray(entries) ? entries.slice(-AUDIT_RING_CAP) : [] });
    } catch (err) {
      console.error('[browser] auditRecent failed:', err);
    }
  },

  handleAuditEvent: (entry) => {
    if (!entry || typeof entry.ts !== 'string') return;
    set((s) => {
      const auditEvents = [...s.auditEvents, entry].slice(-AUDIT_RING_CAP);

      // Toast + unread bookkeeping fire ONLY for denials in the workspace the
      // human is currently viewing (per-workspace isolation — mirrors
      // selectVisibleAuditEvents). A denial in another workspace still lands in
      // the ring buffer (so its drawer shows it on switch) but never interrupts.
      const denial = denialCopyForOutcome(entry.outcome);
      const inWorkspace = (entry.workspaceId ?? null) === s.selectedWorkspaceId;
      if (!denial || !inWorkspace) return { auditEvents };

      const host = auditHost(entry.url);
      const key = `${host}|${denial.code}`;
      const shownAt = Date.now();
      // Dedupe identical host+code within 10s: refresh the existing toast in
      // place (no duplicate node, no reset stampede) instead of stacking.
      const fresh = s.denialToasts.filter((t) => shownAt - t.shownAt < TOAST_DEDUPE_MS);
      if (fresh.some((t) => t.key === key)) {
        return { auditEvents, auditUnreadDenials: s.auditUnreadDenials + 1 };
      }
      const toast: DenialToast = {
        id: `${key}@${shownAt}`,
        key,
        code: denial.code,
        title: denial.copy.title,
        body: denial.copy.body,
        action: denial.copy.action,
        host,
        shownAt,
      };
      return {
        auditEvents,
        auditUnreadDenials: s.auditUnreadDenials + 1,
        denialToasts: [...fresh, toast],
      };
    });
  },

  openAuditDrawer: () => set({ auditDrawerOpen: true, auditUnreadDenials: 0 }),
  closeAuditDrawer: () => set({ auditDrawerOpen: false }),
  dismissDenialToast: (id) =>
    set((s) => ({ denialToasts: s.denialToasts.filter((t) => t.id !== id) })),

  // ── Website-access policy ──────────────────────────────────────────────────
  openAccessView: () => set({ accessViewOpen: true }),
  closeAccessView: () => set({ accessViewOpen: false }),

  loadAccessRules: async () => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      const rows = await api.access.list();
      set({ accessRules: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      console.error('browser.access.list failed:', err);
    }
  },

  addAccessRule: async (input) => {
    const api = getBrowserApi();
    if (!api) throw new Error('Browser backend not available.');
    // Let the rejection propagate — the add form catches and shows the message
    // (main re-normalizes the hostname and throws on `*`/unparseable).
    const rule = await api.access.add(input);
    // onChanged refreshes the slice; reload now for immediacy.
    void get().loadAccessRules();
    return rule;
  },

  updateAccessRule: async (id, patch) => {
    const api = getBrowserApi();
    if (!api) throw new Error('Browser backend not available.');
    await api.access.update(id, patch);
    void get().loadAccessRules();
  },

  removeAccessRule: async (id) => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      await api.access.remove(id);
      void get().loadAccessRules();
    } catch (err) {
      console.error('browser.access.remove failed:', err);
    }
  },

  loadAccessRequests: async () => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      const rows = await api.access.requestList();
      set({ accessRequests: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      console.error('browser.access.requestList failed:', err);
    }
  },

  decideAccessRequest: async (id, decision) => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      await api.access.requestDecide(id, decision);
      // accessChanged + accessRequestsChanged refresh rules + the inbox; reload
      // now for immediacy (approve creates a live rule).
      void get().loadAccessRequests();
      void get().loadAccessRules();
    } catch (err) {
      console.error('browser.access.requestDecide failed:', err);
    }
  },

  handoffSignin: async (ruleId) => {
    const api = getBrowserApi();
    if (!api) return null;
    try {
      return await api.access.handoffSignin(ruleId);
    } catch (err) {
      console.error('browser.access.handoffSignin failed:', err);
      return null;
    }
  },

  handoffReady: async (tabId) => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      await api.access.handoffReady(tabId);
    } catch (err) {
      console.error('browser.access.handoffReady failed:', err);
    }
  },

  beginSigninHandoff: async (rule) => {
    const api = getBrowserApi();
    if (!api) return;
    let result: AccessHandoffResult | null = null;
    try {
      result = await api.access.handoffSignin(rule.id);
    } catch (err) {
      console.error('browser.access.handoffSignin failed:', err);
    }
    if (!result?.tabId) return;
    // Close the overlay so the pane resumes and the visible quarantined login
    // tab is shown; the four-point consent banner takes over in the chrome.
    set({
      accessViewOpen: false,
      signinHandoff: { tabId: result.tabId, ruleId: rule.id, hostname: rule.hostname },
      signinHandoffError: null,
    });
  },

  completeSigninHandoff: async () => {
    const api = getBrowserApi();
    const handoff = get().signinHandoff;
    if (!api || !handoff) return;
    try {
      await api.access.handoffReady(handoff.tabId);
      set({ signinHandoff: null, signinHandoffError: null });
    } catch (err) {
      console.error('browser.access.handoffReady failed:', err);
      set({
        signinHandoffError:
          'Could not hand this tab to the agent — make sure the tab is still on the ' +
          'site you signed in to, then try again.',
      });
    }
  },

  cancelSigninHandoff: () => {
    const handoff = get().signinHandoff;
    if (handoff) {
      // Trusted chrome may close the quarantined tab (manager closeTab is not
      // tool-gated); drop our local tab entry too.
      get().closeTab(handoff.tabId);
    }
    set({ signinHandoff: null, signinHandoffError: null });
  },

  tabHandToAgent: async (tabId) => {
    const api = getBrowserApi();
    if (!api) return false;
    try {
      await api.access.tabHandToAgent(tabId);
      set((s) => ({ handedTabIds: { ...s.handedTabIds, [tabId]: true } }));
      return true;
    } catch (err) {
      // Main refuses when the committed origin is not an allow-signed-in rule.
      console.error('browser.access.tabHandToAgent failed:', err);
      return false;
    }
  },

  tabReturnToHuman: async (tabId) => {
    const api = getBrowserApi();
    if (!api) return;
    // Optimistic — clear the badge immediately; main detaches the driver.
    set((s) => {
      const { [tabId]: _gone, ...handedTabIds } = s.handedTabIds;
      return { handedTabIds };
    });
    try {
      await api.access.tabReturnToHuman(tabId);
    } catch (err) {
      console.error('browser.access.tabReturnToHuman failed:', err);
    }
  },

  clearSiteSession: async (ruleId) => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      await api.access.clearSiteSession(ruleId);
    } catch (err) {
      console.error('browser.access.clearSiteSession failed:', err);
    }
  },
}));

// ── Event bridge ─────────────────────────────────────────────────────────────
// Subscribes the store to main-process tab-state / open-request events. Must
// run even while the pane is closed so agent-opened tabs can raise attention.
// Idempotent and retryable: returns false (and stays unsubscribed) while the
// preload namespace is absent, so callers can just invoke it on every render.

let bridgeStarted = false;

export function ensureBrowserBridge(): boolean {
  if (bridgeStarted) return true;
  const api = getBrowserApi();
  if (!api) return false;
  bridgeStarted = true;
  api.onTabState((state) => useBrowserStore.getState().handleTabState(state));
  api.onOpenRequest((req) => useBrowserStore.getState().handleOpenRequest(req));

  // ── Overhaul event subscriptions (each returns an unsubscribe fn we ignore —
  //    the bridge lives for the lifetime of the renderer, guarded idempotent). ─
  api.onBookmarksChanged((bookmarks) =>
    useBrowserStore.setState({ bookmarks: Array.isArray(bookmarks) ? bookmarks : [] }),
  );
  api.onFoundInPage((result) => useBrowserStore.getState().handleFoundInPage(result));
  api.onTabsSnapshot((entries) => useBrowserStore.getState().handleTabsSnapshot(entries));
  api.onShortcutCommand((shortcut, ctx) =>
    useBrowserStore.getState().handleShortcutCommand(shortcut, ctx),
  );
  api.onContextMenuCommand((action, params) =>
    useBrowserStore.getState().handleContextMenuCommand(action, params),
  );

  // ── Slice-3: denial toasts + live Activity/Audit drawer. Guarded so older /
  //    stubbed preload shapes without the audit channels don't crash the bridge.
  //    Prime the drawer with the JSONL tail, then stream fresh records. ─────────
  if (api.onAuditEvent) {
    api.onAuditEvent((entry) => useBrowserStore.getState().handleAuditEvent(entry));
    void useBrowserStore.getState().loadRecentAudit();
  }

  // ── Per-workspace isolation ────────────────────────────────────────────────
  // Track the dashboard's selected workspace so the strip/pane scope to it and
  // main re-scopes its snapshot/visibility/new-tab stamping. Sync once now (the
  // bridge can start after a workspace is already selected), then on every
  // change. Idempotent: handleWorkspaceChange early-returns inside the setState
  // when nothing relevant moved.
  useBrowserStore.getState().handleWorkspaceChange(
    useDashboardStore.getState().selectedWorkspaceId,
  );
  useDashboardStore.subscribe((state, prev) => {
    if (state.selectedWorkspaceId !== prev.selectedWorkspaceId) {
      useBrowserStore.getState().handleWorkspaceChange(state.selectedWorkspaceId);
    }
  });

  // Prime the bookmarks slice (subsequent edits arrive via onBookmarksChanged).
  void useBrowserStore.getState().loadBookmarks();

  // ── Website-access policy — subscribe + prime. Guarded so older/stubbed
  //    preload shapes without the access namespace don't crash the bridge. The
  //    rules + pending requests are primed even while the overlay is closed
  //    because the tab-strip hand-off gating reads the rules and the
  //    entry-button badge reads the pending-request count. ─
  if (api.access) {
    api.access.onChanged(() => {
      void useBrowserStore.getState().loadAccessRules();
    });
    api.access.onRequestsChanged(() => {
      void useBrowserStore.getState().loadAccessRequests();
    });
    const s = useBrowserStore.getState();
    void s.loadAccessRules();
    void s.loadAccessRequests();
  }
  return true;
}

export function __resetBrowserBridgeForTests(): void {
  bridgeStarted = false;
}
