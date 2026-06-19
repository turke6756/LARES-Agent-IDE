import { create } from 'zustand';
import { useDashboardStore } from './dashboard-store';
import type {
  AccessHandoffResult,
  AccessRequest,
  AccessRequestDecision,
  AccessRule,
  AccessRuleInput,
  AgentActionsCommand,
  AgentActionsState,
  AgentDrivingRevoked,
  BrowserAuditEntry,
  BrowserDownload,
  BrowserDownloadPrompt,
  BrowserDownloadState,
  HandedTabInfo,
  OmniboxSuggestion,
  SharedAgentSessions,
  SignedInOrigin,
} from '../../shared/browser';
import { resolveBrowserInput } from '../../shared/browser-input';
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
  AgentActionsCommand,
  AgentActionsState,
  AgentDrivingRevoked,
  BrowserAuditEntry,
  BrowserDownload,
  BrowserDownloadPrompt,
  BrowserDownloadState,
  HandedTabInfo,
  OmniboxSuggestion,
  SharedAgentSessions,
  SignedInOrigin,
};
export { resolveBrowserInput };

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
  /** Slice 10/11: this tab has NO live WebContentsView — its url/title/favicon
   *  come from a persisted snapshot. True for a restored-on-startup tab not yet
   *  activated, OR an idle-discarded tab. Activating it lazily hydrates in main.
   *  Additive/optional — missing = live. */
  frozen?: boolean;
  /** Slice 11: this frozen tab was discarded by the idle/cap memory sweep (vs
   *  restored on startup). Implies frozen. Drives the MoonStar "suspended to
   *  save memory" treatment. Additive/optional — missing = not memory-discarded. */
  discarded?: boolean;
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
  /** Slice-7: cached favicon URL captured at add time (user tab only). */
  favicon?: string;
  /** Slice-7: one-level folder name; null/absent = top-level bar chip. */
  folder?: string | null;
  /** Slice-7: epoch-ms of the last edit; absent if never edited. */
  updatedAt?: number;
}

/** Slice-7: patch for an in-place bookmark edit (preserves id + sort order). */
export interface BookmarkPatch {
  title?: string;
  favicon?: string | null;
  folder?: string | null;
}

/** USER-PARTITION ONLY (agent navigations never recorded/listed). */
export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
  /** Slice-8: cached favicon URL (null/absent for legacy rows). */
  favicon?: string | null;
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
  /** Slice 12: armed-state agent-actions gate. */
  getActionsState?(): Promise<AgentActionsState>;
  setActionsState?(cmd: AgentActionsCommand): Promise<AgentActionsState>;
  onActionsStateChanged?(cb: (state: AgentActionsState) => void): () => void;
  onTabState(cb: (state: BrowserTabState) => void): () => void;
  onOpenRequest(cb: (req: BrowserOpenRequest) => void): () => void;

  // ── Overhaul (WP0) — additive plumbing (mirror only). ──────────────────────
  reorderTab(tabId: string, toOrder: number): unknown;
  setTabPinned(tabId: string, pinned: boolean): unknown;
  reopenClosedTab(): Promise<{ tabId: string } | null>;
  /** Slice 10/11: re-materialize the prior USER-PARTITION tabs as FROZEN
   *  snapshots (no live view until first activation). Idempotent — a second
   *  call returns []. Issued once from ensureBrowserBridge after the workspace
   *  is synced. */
  sessionRestore(): Promise<BrowserTabState[]>;
  /** Slice 11: idle-discard threshold in ms; null = "Never" (keeps the hard
   *  live-view cap but disables time-based discard). */
  setDiscardThreshold(ms: number | null): unknown;
  findInPage(tabId: string, text: string, opts?: { forward?: boolean; findNext?: boolean }): unknown;
  stopFindInPage(tabId: string): unknown;
  setZoom(tabId: string, zoomFactor: number): unknown;
  contextMenuRequest(tabId: string, params: BrowserContextMenuParams): unknown;
  /** USER-PARTITION ONLY. */
  bookmarkList(): Promise<Bookmark[]>;
  bookmarkAdd(input: { title: string; url: string }): Promise<Bookmark>;
  bookmarkRemove(id: string): unknown;
  /** Slice-7: edit title/favicon/folder; preserves id + sort order. */
  bookmarkUpdate(id: string, patch: BookmarkPatch): Promise<Bookmark>;
  bookmarkReorder(orderedIds: string[]): unknown;
  /** Slice-6: ranked omnibox suggestions (USER-PARTITION only). */
  omniboxSuggest(query: string): Promise<OmniboxSuggestion[]>;
  /** USER-PARTITION ONLY. */
  historyList(query?: HistoryQuery): Promise<HistoryEntry[]>;
  historyDelete(id: string): unknown;
  historyClear(): unknown;
  /** Slice-8: most-visited user sites (consumed by the NTP in Slice-9). */
  historyTopSites(limit?: number): Promise<HistoryEntry[]>;
  onTabsSnapshot(cb: (entries: BrowserTabSnapshotEntry[]) => void): () => void;
  onShortcutCommand(cb: (shortcut: BrowserShortcut, ctx: { tabId: string }) => void): () => void;
  onFoundInPage(cb: (result: BrowserFindResult) => void): () => void;
  onContextMenuCommand(cb: (action: string, params: BrowserContextMenuParams) => void): () => void;
  onBookmarksChanged(cb: (bookmarks: Bookmark[]) => void): () => void;

  // ── Slice-3: denial toasts + live Activity/Audit drawer (trusted chrome). ──
  auditRecent(limit?: number): Promise<BrowserAuditEntry[]>;
  onAuditEvent(cb: (entry: BrowserAuditEntry) => void): () => void;

  // ── Slice 12: handoff / session center. Optional + guarded so older/stubbed
  //    preload shapes without these channels don't crash the bridge. ───────────
  getSharedSessions?(): Promise<SharedAgentSessions>;
  onAgentDrivingRevoked?(cb: (payload: AgentDrivingRevoked) => void): () => void;

  // ── Slice 13: user-only downloads (the shelf). Trusted-chrome only. The five
  //    lifecycle/prompt events each return an unsubscribe fn; the invokes manage
  //    records + the user-download confirmation. Optional + guarded so older /
  //    stubbed preload shapes without these channels don't crash the bridge. ───
  downloadList?(): Promise<BrowserDownload[]>;
  /** `id` is the one-shot prompt token from onDownloadPrompt — NOT a record id. */
  downloadConfirm?(id: string): Promise<void>;
  downloadOpenFile?(id: string): Promise<boolean>;
  downloadShowInFolder?(id: string): Promise<void>;
  downloadRetry?(id: string): Promise<void>;
  downloadRemove?(id: string): Promise<void>;
  onDownloadStarted?(cb: (rec: BrowserDownload) => void): () => void;
  onDownloadProgress?(cb: (rec: BrowserDownload) => void): () => void;
  onDownloadDone?(cb: (rec: BrowserDownload) => void): () => void;
  onDownloadFailed?(cb: (rec: BrowserDownload) => void): () => void;
  onDownloadPrompt?(cb: (prompt: BrowserDownloadPrompt) => void): () => void;

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

// Slice-6: turn a main-side navigation rejection into a short inline message for
// the address bar. Main throws `navigation denied: <reason>` (M6 scheme/SSRF
// gate); the IPC wraps it, so we tease the reason back out when present.
export function navErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/navigation denied:\s*(.+?)\s*$/i);
  if (m) return `Can't open this address — ${m[1]}`;
  return "Can't open this address.";
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

// Slice-6 omnibox debounce (~80ms). Module-level so clearOmnibox can cancel a
// pending fetch, and so a stale in-flight response can be discarded: each fetch
// bumps a token and only the latest applies (keystrokes can outpace the round-trip).
const OMNIBOX_DEBOUNCE_MS = 80;
let omniboxDebounceTimer: number | null = null;
let omniboxRequestToken = 0;

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
  /** Slice 12: full armed state mirror (disabled | armed + armedUntil +
   *  lastChangedAt). `actionsEnabled` above is kept as a derived convenience
   *  (mode === 'armed'). Loaded on mount, pushed live on flip OR auto-expiry. */
  actionsState: AgentActionsState;

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
  /** Slice 12: load + command the armed state; applyActionsState is the
   *  onActionsStateChanged handler (flip + auto-expiry push). */
  loadActionsState: () => Promise<void>;
  setAgentActionsState: (cmd: AgentActionsCommand) => Promise<void>;
  applyActionsState: (state: AgentActionsState) => void;

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
  /** Resolves to the created bookmark (or undefined on failure) so callers can
   *  chain a follow-up edit — e.g. undo re-adds then restores the folder. */
  addBookmark: (input: { title: string; url: string }) => Promise<Bookmark | undefined>;
  removeBookmark: (id: string) => void;
  /** Slice-7: edit a bookmark in place (title/favicon/folder); id + sort order
   *  are preserved. The onBookmarksChanged event refreshes the slice. */
  updateBookmark: (id: string, patch: BookmarkPatch) => Promise<void>;
  reorderBookmark: (orderedIds: string[]) => void;
  toggleBookmarkBar: () => void;

  // History (USER-PARTITION ONLY).
  historyViewOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  /** Slice-8: paginated fetch — pass {query, limit, offset} for infinite scroll. */
  fetchHistory: (opts?: { query?: string; limit?: number; offset?: number }) => Promise<HistoryEntry[]>;
  deleteHistory: (id: string) => void;
  clearHistory: () => void;

  // Find-in-page (counts only ever cross the wire — never page text).
  findOpen: boolean;
  findState: { activeMatchOrdinal: number; matches: number };
  openFind: () => void;
  closeFind: () => void;
  runFind: (text: string, opts?: { forward?: boolean; findNext?: boolean }) => void;

  // ── Slice-6: omnibox suggestions ───────────────────────────────────────────
  // The AddressBar dropdown reads these. `omniboxActiveIndex` of -1 means "no row
  // highlighted" — Enter then resolves the raw typed input. fetchOmnibox is
  // debounced (~80ms) and discards stale responses. `navError` surfaces a
  // navigation rejection inline in the bar (set by navigate(); cleared on edit).
  omniboxResults: OmniboxSuggestion[];
  omniboxActiveIndex: number;
  navError: string | null;
  fetchOmnibox: (query: string) => void;
  clearOmnibox: () => void;
  setOmniboxActiveIndex: (index: number) => void;
  clearNavError: () => void;

  // Zoom — zoomFactor echoes back via the existing onTabState payload.
  setZoom: (tabId: string, factor: number) => void;

  // Main-authoritative tab order/pin snapshot + intents.
  snapshot: BrowserTabSnapshotEntry[];
  reorderTab: (tabId: string, toOrder: number) => void;
  setTabPinned: (tabId: string, pinned: boolean) => void;
  reopenClosedTab: () => Promise<void>;

  // ── Slice 10/11: session restore + frozen/discarded tab model ──────────────
  // restoreSession PULLs the prior USER tabs back as FROZEN snapshots (no live
  // view until activated) and seeds them into the strip; restoredCount drives a
  // dismissible "Restored N tabs" note in the panel (0 = no note / dismissed).
  // discardThresholdMs mirrors the idle-discard setting (null = "Never"); the
  // settings control flips it through setDiscardThreshold.
  restoredCount: number;
  discardThresholdMs: number | null;
  restoreSession: () => Promise<void>;
  dismissRestoredNote: () => void;
  setDiscardThreshold: (ms: number | null) => void;

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

  // ── Slice 12: handoff / session center ─────────────────────────────────────
  /** Live handed tabs + persisted signed-in origins (with session-age + stale
   *  flags) for the "Sessions shared with agents" settings section. Loaded on
   *  demand (overlay open) and refreshed on the access-changed / driving-revoked
   *  events; empty shape until first load. */
  sharedSessions: SharedAgentSessions;
  loadSharedSessions: () => Promise<void>;
  /** Off-origin auto-revoke notices surfaced as transient toasts (newest last).
   *  handleAgentDrivingRevoked ALSO drops the "Agent driving" chip for the tab
   *  — main has already detached the driver; this mirrors it locally so the
   *  badge can't outlive the capability. */
  drivingRevoked: AgentDrivingRevoked[];
  handleAgentDrivingRevoked: (payload: AgentDrivingRevoked) => void;
  dismissDrivingRevoked: (tabId: string) => void;
  /** Transient success banner shown right after a sign-in hand-off completes
   *  (the agent now drives the signed-in session). null = idle. */
  signinHandoffDone: { hostname: string } | null;
  dismissSigninHandoffDone: () => void;

  // ── Slice 13: user-only downloads (the shelf) ──────────────────────────────
  // `downloads` is the newest-first record list (seeded from downloadList() on
  // bridge init, then upserted keyed by BrowserDownload.id from the five
  // lifecycle events). `pendingDownloadPrompt` holds the one-shot USER-download
  // confirm token (fed by onDownloadPrompt) — confirmDownload passes its `id`
  // straight to downloadConfirm. `downloadsShelfCollapsed` collapses the shelf
  // to a slim summary bar (the shelf hides entirely when there's nothing to
  // show). Main is authoritative for every record + the decision gate.
  downloads: BrowserDownload[];
  pendingDownloadPrompt: BrowserDownloadPrompt | null;
  downloadsShelfCollapsed: boolean;
  /** Seed the shelf from the newest-first list (called on bridge init). */
  loadDownloads: () => Promise<void>;
  /** Upsert a lifecycle record keyed by id (started → front; progress/done/failed
   *  → patch in place). Wired to all four lifecycle events. */
  handleDownloadEvent: (rec: BrowserDownload) => void;
  /** Stash the USER-download confirm prompt (onDownloadPrompt). */
  handleDownloadPrompt: (prompt: BrowserDownloadPrompt) => void;
  /** Human approved → pass the prompt token to downloadConfirm + clear the slot. */
  confirmDownload: () => void;
  /** Decline a pending USER download — clear the slot locally (main treats an
   *  un-confirmed prompt as declined; nothing is written). */
  dismissDownloadPrompt: () => void;
  openDownloadFile: (id: string) => void;
  showDownloadInFolder: (id: string) => void;
  retryDownload: (id: string) => void;
  removeDownload: (id: string) => void;
  toggleDownloadsShelf: () => void;
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  selectedWorkspaceId: null,
  attentionTabIds: {},
  paneAttention: false,
  pendingOpenUrl: null,
  actionsEnabled: false,
  actionsState: { mode: 'disabled', armedUntil: null, lastChangedAt: 0 },

  // Overhaul feature-slice initial state.
  bookmarks: [],
  bookmarkBarVisible: true,
  bookmarkTick: 0,
  historyViewOpen: false,
  findOpen: false,
  findState: { activeMatchOrdinal: 0, matches: 0 },
  omniboxResults: [],
  omniboxActiveIndex: -1,
  navError: null,
  snapshot: [],
  groupCollapsed: { agent: true, user: false },
  openGroupId: null,
  focusAddressTick: 0,

  // Slice 10/11 — session restore + idle-discard threshold. 30 min is the
  // displayed default for the discard setting (mirror — main is authoritative).
  restoredCount: 0,
  discardThresholdMs: 30 * 60 * 1000,

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

  // Slice 12 — handoff / session center.
  sharedSessions: { handedTabs: [], signedInOrigins: [] },
  drivingRevoked: [],
  signinHandoffDone: null,

  // Slice 13 — user-only downloads (the shelf).
  downloads: [],
  pendingDownloadPrompt: null,
  downloadsShelfCollapsed: false,

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
    // Slice-4: the agent allowlist + pending-request inbox are workspace-scoped
    // on the main side (filtered by the workspace we just selected via
    // setActiveWorkspace). Reload them so the settings overlay's list/add/decide
    // — and the hand-off gating + entry-button badge that read these slices —
    // reflect the NEW workspace's rules, not the previous one's. A bare
    // setActiveWorkspace re-scopes main but emits no accessChanged event, so
    // without this the slices would stay stale across a switch.
    void get().loadAccessRules();
    void get().loadAccessRequests();
  },

  navigate: (tabId, rawInput) => {
    // Slice-6: resolve through the SHARED resolver (url-vs-search + default
    // scheme), the same one the AddressBar/NTP use — no duplicated normalization.
    const resolved = resolveBrowserInput(rawInput);
    if (!resolved.display) return; // empty input
    const url = resolved.url;
    get().clearNavError();
    let result: unknown;
    try {
      result = getBrowserApi()?.navigate(tabId, url);
    } catch (err) {
      set({ navError: navErrorMessage(err) });
      return;
    }
    // The IPC is an invoke() promise; a main-side M6 denial rejects it. Surface
    // that inline (Slice-6) rather than only console.error, and undo the
    // optimistic loading state since navigation never started.
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).catch((err) => {
        set((s) => ({
          navError: navErrorMessage(err),
          tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, loading: false } : t)),
        }));
      });
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
    // Back-compat boolean flip → armed-until-restart / disabled command.
    await get().setAgentActionsState(
      enabled ? { mode: 'armed', durationMs: null } : { mode: 'disabled' },
    );
  },

  // ── Slice 12: armed-state agent-actions gate ───────────────────────────────
  loadActionsState: async () => {
    const api = getBrowserApi();
    if (!api?.getActionsState) {
      // Older preload: fall back to the boolean gate.
      void get().loadActionsEnabled();
      return;
    }
    try {
      get().applyActionsState(await api.getActionsState());
    } catch (err) {
      console.error('browser.getActionsState failed:', err);
    }
  },

  setAgentActionsState: async (cmd) => {
    const api = getBrowserApi();
    if (!api) return;
    if (!api.setActionsState) {
      // Older preload: degrade to the boolean setter.
      const enabled = cmd.mode === 'armed';
      set({ actionsEnabled: enabled });
      try {
        set({ actionsEnabled: Boolean(await api.setActionsEnabled(enabled)) });
      } catch (err) {
        console.error('browser.setActionsEnabled failed:', err);
        void get().loadActionsEnabled();
      }
      return;
    }
    // Optimistic local apply; reconcile to the main-process echo (authoritative).
    const optimistic: AgentActionsState =
      cmd.mode === 'disabled'
        ? { mode: 'disabled', armedUntil: null, lastChangedAt: Date.now() }
        : {
            mode: 'armed',
            armedUntil: cmd.durationMs === null ? null : Date.now() + cmd.durationMs,
            lastChangedAt: Date.now(),
          };
    get().applyActionsState(optimistic);
    try {
      get().applyActionsState(await api.setActionsState(cmd));
    } catch (err) {
      console.error('browser.setActionsState failed:', err);
      void get().loadActionsState();
    }
  },

  applyActionsState: (state) => {
    set({ actionsState: state, actionsEnabled: state.mode === 'armed' });
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
    if (!api) return undefined;
    try {
      // onBookmarksChanged is the source of truth and will refresh the slice;
      // the manager validates the scheme (defense-in-depth) + rejects agent
      // URLs and stores the active user tab's favicon. Returning the created
      // bookmark lets undo restore its folder via a follow-up updateBookmark.
      return await api.bookmarkAdd({ title, url });
    } catch (err) {
      console.error('browser.bookmarkAdd failed:', err);
      return undefined;
    }
  },

  removeBookmark: (id) => {
    try {
      getBrowserApi()?.bookmarkRemove(id);
    } catch (err) {
      console.error('browser.bookmarkRemove failed:', err);
    }
  },

  updateBookmark: async (id, patch) => {
    const api = getBrowserApi();
    if (!api) return;
    try {
      await api.bookmarkUpdate(id, patch);
    } catch (err) {
      console.error('browser.bookmarkUpdate failed:', err);
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

  fetchHistory: async (opts) => {
    const api = getBrowserApi();
    if (!api) return [];
    try {
      const q: HistoryQuery = {};
      if (opts?.query) q.query = opts.query;
      if (opts?.limit !== undefined) q.limit = opts.limit;
      if (opts?.offset !== undefined) q.offset = opts.offset;
      const rows = await api.historyList(Object.keys(q).length ? q : undefined);
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

  // ── Slice-6: omnibox suggestions ───────────────────────────────────────────
  fetchOmnibox: (query) => {
    if (omniboxDebounceTimer !== null) clearTimeout(omniboxDebounceTimer);
    const q = query.trim();
    if (!q) {
      get().clearOmnibox();
      return;
    }
    const token = ++omniboxRequestToken;
    omniboxDebounceTimer = (typeof window !== 'undefined' ? window.setTimeout : setTimeout)(
      () => {
        omniboxDebounceTimer = null;
        const api = getBrowserApi();
        if (!api?.omniboxSuggest) return;
        void api
          .omniboxSuggest(q)
          .then((results) => {
            // Discard a stale response: a newer keystroke already superseded it.
            if (token !== omniboxRequestToken) return;
            set({
              omniboxResults: Array.isArray(results) ? results : [],
              // Reset the highlight to "raw input" on every fresh result set so a
              // stale index never points past the new list.
              omniboxActiveIndex: -1,
            });
          })
          .catch((err) => {
            console.error('browser.omniboxSuggest failed:', err);
          });
      },
      OMNIBOX_DEBOUNCE_MS,
    ) as unknown as number;
  },

  clearOmnibox: () => {
    if (omniboxDebounceTimer !== null) {
      clearTimeout(omniboxDebounceTimer);
      omniboxDebounceTimer = null;
    }
    // Invalidate any in-flight response so it can't repopulate after close.
    omniboxRequestToken++;
    set({ omniboxResults: [], omniboxActiveIndex: -1 });
  },

  setOmniboxActiveIndex: (index) => set({ omniboxActiveIndex: index }),

  clearNavError: () => set((s) => (s.navError === null ? s : { navError: null })),

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

  // ── Slice 10/11: session restore + idle-discard threshold ──────────────────
  // PULL the prior USER tabs back as FROZEN snapshots and seed the strip. Merge
  // (don't blunt-replace) so an onTabState push that raced us isn't clobbered:
  // known tabs keep their slot with the snapshot fields layered on, unknown ones
  // append in restore order. restoredCount (>0) lights the dismissible note.
  restoreSession: async () => {
    const api = getBrowserApi();
    if (!api?.sessionRestore) return;
    try {
      const restored = await api.sessionRestore();
      if (!Array.isArray(restored) || restored.length === 0) return;
      set((s) => {
        const byId = new Map(s.tabs.map((t) => [t.tabId, t]));
        for (const r of restored) {
          const prev = byId.get(r.tabId);
          byId.set(r.tabId, prev ? { ...prev, ...r } : r);
        }
        return { tabs: [...byId.values()], restoredCount: restored.length };
      });
    } catch (err) {
      console.error('browser.sessionRestore failed:', err);
    }
  },

  dismissRestoredNote: () => set({ restoredCount: 0 }),

  setDiscardThreshold: (ms) => {
    // Optimistic local mirror so the settings control reflects the choice; main
    // is authoritative for the actual sweep timing.
    set({ discardThresholdMs: ms });
    try {
      getBrowserApi()?.setDiscardThreshold(ms);
    } catch (err) {
      console.error('browser.setDiscardThreshold failed:', err);
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
      // Clear the consent banner and flash a transient success state (the agent
      // now drives the signed-in session). Refresh the session center too so a
      // newly committed origin shows up immediately.
      set({
        signinHandoff: null,
        signinHandoffError: null,
        signinHandoffDone: { hostname: handoff.hostname },
      });
      void get().loadSharedSessions();
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
      // The cleared session changes the "Sessions shared with agents" picture —
      // refresh it so the row's age/stale state reflects the wipe.
      void get().loadSharedSessions();
    } catch (err) {
      console.error('browser.access.clearSiteSession failed:', err);
    }
  },

  // ── Slice 12: handoff / session center ─────────────────────────────────────
  loadSharedSessions: async () => {
    const api = getBrowserApi();
    if (!api?.getSharedSessions) return;
    try {
      const sessions = await api.getSharedSessions();
      set({
        sharedSessions: {
          handedTabs: Array.isArray(sessions?.handedTabs) ? sessions.handedTabs : [],
          signedInOrigins: Array.isArray(sessions?.signedInOrigins)
            ? sessions.signedInOrigins
            : [],
        },
      });
    } catch (err) {
      console.error('browser.getSharedSessions failed:', err);
    }
  },

  handleAgentDrivingRevoked: (payload) => {
    if (!payload || typeof payload.tabId !== 'string') return;
    set((s) => {
      // Drop the "Agent driving" chip — main has already detached the driver on
      // the off-origin navigation; this mirrors it so the badge can't linger.
      const { [payload.tabId]: _gone, ...handedTabIds } = s.handedTabIds;
      // Surface a transient toast; dedupe by tab so a noisy redirect chain that
      // fires repeatedly doesn't stack identical notices.
      const drivingRevoked = [
        ...s.drivingRevoked.filter((r) => r.tabId !== payload.tabId),
        payload,
      ];
      return { handedTabIds, drivingRevoked };
    });
    // Keep the session center fresh if it's open.
    void get().loadSharedSessions();
  },

  dismissDrivingRevoked: (tabId) =>
    set((s) => ({ drivingRevoked: s.drivingRevoked.filter((r) => r.tabId !== tabId) })),

  dismissSigninHandoffDone: () => set({ signinHandoffDone: null }),

  // ── Slice 13: user-only downloads (the shelf) ──────────────────────────────
  loadDownloads: async () => {
    const api = getBrowserApi();
    if (!api?.downloadList) return;
    try {
      const rows = await api.downloadList();
      set({ downloads: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      console.error('browser.downloadList failed:', err);
    }
  },

  handleDownloadEvent: (rec) => {
    if (!rec || typeof rec.id !== 'string') return;
    set((s) => {
      const idx = s.downloads.findIndex((d) => d.id === rec.id);
      if (idx === -1) {
        // A record we haven't seen (a fresh start, or a progress/done that raced
        // ahead of its start) → front, preserving newest-first ordering.
        return { downloads: [rec, ...s.downloads] };
      }
      const downloads = s.downloads.slice();
      downloads[idx] = { ...downloads[idx], ...rec };
      return { downloads };
    });
  },

  handleDownloadPrompt: (prompt) => {
    if (!prompt || typeof prompt.id !== 'string') return;
    set({ pendingDownloadPrompt: prompt, downloadsShelfCollapsed: false });
  },

  confirmDownload: () => {
    const prompt = get().pendingDownloadPrompt;
    if (!prompt) return;
    // One-shot token — clear the slot before calling so a double-click can't
    // re-confirm; main re-initiates + allows the write.
    set({ pendingDownloadPrompt: null });
    try {
      void getBrowserApi()?.downloadConfirm?.(prompt.id);
    } catch (err) {
      console.error('browser.downloadConfirm failed:', err);
    }
  },

  dismissDownloadPrompt: () => set({ pendingDownloadPrompt: null }),

  openDownloadFile: (id) => {
    try {
      void getBrowserApi()?.downloadOpenFile?.(id);
    } catch (err) {
      console.error('browser.downloadOpenFile failed:', err);
    }
  },

  showDownloadInFolder: (id) => {
    try {
      void getBrowserApi()?.downloadShowInFolder?.(id);
    } catch (err) {
      console.error('browser.downloadShowInFolder failed:', err);
    }
  },

  retryDownload: (id) => {
    try {
      void getBrowserApi()?.downloadRetry?.(id);
    } catch (err) {
      console.error('browser.downloadRetry failed:', err);
    }
  },

  removeDownload: (id) => {
    // Optimistic — drop the record locally (file is kept); main also forgets it.
    set((s) => ({ downloads: s.downloads.filter((d) => d.id !== id) }));
    try {
      void getBrowserApi()?.downloadRemove?.(id);
    } catch (err) {
      console.error('browser.downloadRemove failed:', err);
    }
  },

  toggleDownloadsShelf: () =>
    set((s) => ({ downloadsShelfCollapsed: !s.downloadsShelfCollapsed })),
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

  // ── Slice 12: armed-state agent-actions gate. Stream flips + auto-expiry, then
  //    prime the current state. Guarded for older preload shapes. ───────────────
  if (api.onActionsStateChanged) {
    api.onActionsStateChanged((state) =>
      useBrowserStore.getState().applyActionsState(state),
    );
  }
  void useBrowserStore.getState().loadActionsState();

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

  // ── Slice 10/11: session restore ───────────────────────────────────────────
  // PULL the prior USER tabs back as frozen snapshots AFTER the workspace is
  // synced above (main scopes restore to the active workspace). Idempotent on
  // the main side, so a re-entrant bridge start can't double-restore. Guarded so
  // older/stubbed preload shapes without the channel don't crash the bridge.
  if (api.sessionRestore) {
    void useBrowserStore.getState().restoreSession();
  }

  // ── Website-access policy — subscribe + prime. Guarded so older/stubbed
  //    preload shapes without the access namespace don't crash the bridge. The
  //    rules + pending requests are primed even while the overlay is closed
  //    because the tab-strip hand-off gating reads the rules and the
  //    entry-button badge reads the pending-request count. ─
  if (api.access) {
    api.access.onChanged(() => {
      void useBrowserStore.getState().loadAccessRules();
      // Rule mutations (disable signed-in, remove, ...) change the session
      // center — keep it in sync alongside the rules.
      void useBrowserStore.getState().loadSharedSessions();
    });
    api.access.onRequestsChanged(() => {
      void useBrowserStore.getState().loadAccessRequests();
    });
    const s = useBrowserStore.getState();
    void s.loadAccessRules();
    void s.loadAccessRequests();
  }

  // ── Slice 12: handoff / session center. Stream the off-origin auto-revoke
  //    notification (drops the driving chip + raises a transient toast). Guarded
  //    so older/stubbed preload shapes without the channel don't crash. ─────────
  if (api.onAgentDrivingRevoked) {
    api.onAgentDrivingRevoked((payload) =>
      useBrowserStore.getState().handleAgentDrivingRevoked(payload),
    );
  }

  // ── Slice 13: user-only downloads (the shelf). Subscribe to the five
  //    lifecycle/prompt pushes, then seed the shelf from the newest-first list.
  //    Each lifecycle event carries the FULL record, so the upsert needs no
  //    follow-up fetch. Guarded so older/stubbed preload shapes without these
  //    channels don't crash the bridge. ────────────────────────────────────────
  if (api.onDownloadStarted) {
    const onEvt = (rec: BrowserDownload) =>
      useBrowserStore.getState().handleDownloadEvent(rec);
    api.onDownloadStarted(onEvt);
    api.onDownloadProgress?.(onEvt);
    api.onDownloadDone?.(onEvt);
    api.onDownloadFailed?.(onEvt);
    api.onDownloadPrompt?.((prompt) =>
      useBrowserStore.getState().handleDownloadPrompt(prompt),
    );
    void useBrowserStore.getState().loadDownloads();
  }
  return true;
}

export function __resetBrowserBridgeForTests(): void {
  bridgeStarted = false;
}
