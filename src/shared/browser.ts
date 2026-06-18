// WP1-A (plans/embedded-browser-implementation-tasks.md) — shared types and
// IPC channel names for the embedded browser pane.
//
// This file carries the FROZEN WP1 contract between the main process
// (browser-ipc.ts implements) and the renderer (WP1-B consumes via
// window.api.browser). Any change to the shapes below requires BOTH workers
// plus a note in the plans-doc progress log.

/** Renderer-facing partition label. Maps to Electron session partitions
 *  'persist:user' / 'persist:agent' inside the browser manager — the
 *  renderer never sees the persist: prefix. */
export type BrowserPartition = 'user' | 'agent';

export interface BrowserCreateTabOptions {
  partition: BrowserPartition;
  /** Optional initial URL. Must pass the M6 scheme gate (http/https) or
   *  createTab rejects. Omit to create an empty tab. */
  url?: string;
  /** Per-workspace isolation: the workspace this tab belongs to. Renderer-
   *  initiated tabs pass the human's selected workspace; agent-initiated opens
   *  pass the agent's workspace. Omitted → main stamps the current workspace.
   *  null = unscoped (visible only when no workspace is selected). */
  workspaceId?: string | null;
}

/** DIP, relative to the window's content area (mainWindow.contentView). */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pushed main → renderer on every navigation/title/favicon/loading change. */
export interface BrowserTabState {
  tabId: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  partition: BrowserPartition;
  /** Per-workspace isolation: the workspace this tab belongs to. The renderer
   *  shows a tab only when its workspaceId matches the selected workspace
   *  (mirrors the file-viewer's per-workspace tab filtering). null/absent =
   *  unscoped. */
  workspaceId?: string | null;
  /** Phase 2 (WP2-A) sets this for agent-opened tabs so the UI can flash
   *  the tab. Absent in Phase 1 — renderer treats missing as false. */
  openedByAgent?: boolean;
  /** Overhaul (WP5): current zoom factor (1 = 100%). Additive/optional —
   *  sendTabState includes it once setZoom/zoom wiring lands. */
  zoomFactor?: number;
  /** Overhaul (WP2): true on a URL-less ("New Tab") create; flips false after
   *  the first COMMITTED navigation (did-navigate), so a denied/failed nav
   *  leaves it true. Additive/optional — renderer treats missing as false. */
  isNewTab?: boolean;
  /** Website-allowlist §12-B (Mechanism B): RUNTIME, non-persisted. The agent is
   *  driving this (normally persist:user) tab via the right-click handoff. The
   *  tab strip shows an "Agent driving" badge + a "Return tab to me" menu item.
   *  Additive/optional — renderer treats missing as false. */
  handedToAgent?: boolean;
  /** Website-allowlist §12-A (Mechanism A): RUNTIME, non-persisted. This visible
   *  agent-partition tab is in the sign-in quarantine (the human is typing
   *  credentials; ALL agent tools are denied against it). The chrome shows the
   *  four-point sign-in banner + a "Hand to agent" action. Missing = false. */
  signinPending?: boolean;
  /** Slice-1 (premium browser): connection-security indicator derived from the
   *  COMMITTED URL scheme — `'secure'` (https), `'insecure'` (http), `'internal'`
   *  (NTP / empty / about:blank / non-http). Drives the address-bar lock glyph.
   *  Additive/optional — renderer treats missing as `'internal'`. */
  secureState?: 'secure' | 'insecure' | 'internal';
  /** Slice-1: the last main-frame load failure or renderer crash, for the
   *  trusted-chrome error panel. NEVER carries page content — only the Electron
   *  error code, its description, and the validated URL (all shell-side strings).
   *  Set on did-fail-load / render-process-gone; cleared (null) on the next
   *  did-start-loading / successful did-navigate. Additive/optional —
   *  null/absent = no error. */
  lastError?: { code: string; description: string; url: string } | null;
  /** Slice-2 (premium browser): identity of the agent that opened this tab. Set
   *  once at createTab time from the trusted API layer (resolved from the agent
   *  registry — never the agent's own tool args). Drives the "Opened by <title>"
   *  tab tooltip + audit attribution (Slice 3). Additive/optional — absent for
   *  human-opened tabs. */
  openedByAgentId?: string;
  openedByAgentTitle?: string;
  /** Slice-2: authoritative attention model. SET once (with a fresh
   *  `lastAttentionAt` stamp) when an agent opens/raises this tab; the renderer
   *  flashes the tab briefly and clears its local attention on select. Main does
   *  NOT loop or re-pulse — `lastAttentionAt` only advances on a new open/raise,
   *  so the renderer can tell a fresh attention event from an unrelated tab-state
   *  push. Additive/optional — missing = no attention. */
  needsHumanAttention?: boolean;
  lastAttentionAt?: number;
}

// ── Overhaul (WP0) shared shapes ─────────────────────────────────────────────
// Additive contract for the embedded-browser visual+feature overhaul. Pure data
// + channel plumbing; no behavior is implied here. Pin/order live on the
// snapshot (main is authoritative), NOT on per-tab BrowserTabState.

/** One row of the main-authoritative tab order/pin snapshot. Pushed on the
 *  tabsSnapshot event; the renderer renders strip order from this. */
export interface BrowserTabSnapshotEntry {
  tabId: string;
  order: number;
  pinned: boolean;
  partition: BrowserPartition;
}

/** Counts-only find-in-page progress (foundInPage event). Never carries page
 *  text — only ordinals/totals (security: no page content crosses the wire). */
export interface BrowserFindResult {
  tabId: string;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

/** Native context-menu request payload (renderer → main via contextMenuRequest).
 *  Carries only link/src/selection strings + capability flags — no DOM dump. */
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

/** Keyboard-shortcut commands routed main → renderer (shortcutCommand event)
 *  for UI reactions. Structural chords are handled wholly in main. */
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

/** A persisted bookmark. USER-PARTITION ONLY — the manager never records or
 *  exposes agent-partition URLs here (persistence half of M9 discipline). */
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  sortOrder: number;
  /** Slice-7 (premium browser): cached favicon URL of the active USER tab at
   *  add time. NEVER an agent-partition favicon (cross-cutting rule #1 —
   *  bookmarkAdd rejects agent tabs and only records a user tab's favicon).
   *  Additive/optional — absent on legacy rows. */
  favicon?: string;
  /** Slice-7: ONE-level folder name this bookmark lives in. null/absent =
   *  top-level (rendered directly on the bookmarks bar). Additive/optional. */
  folder?: string | null;
  /** Slice-7: epoch-ms of the last updateBookmark edit; absent on legacy rows
   *  never edited. id + sortOrder are preserved across edits. */
  updatedAt?: number;
}

/** Slice-7: additive patch for bookmarkUpdate. id + url + sortOrder are NOT
 *  patchable — an edit preserves a bookmark's identity and bar position. Only
 *  the display title, the cached favicon, and the (one-level) folder move. */
export interface BookmarkPatch {
  title?: string;
  favicon?: string | null;
  folder?: string | null;
}

/** A persisted history visit. USER-PARTITION ONLY — agent navigations are
 *  never recorded or enumerated here (persistence half of M9 discipline). */
export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
  /** Slice-8: cached page favicon URL (user-partition only). Null/absent for
   *  legacy rows recorded before the column existed. */
  favicon?: string | null;
}

/** Query options for historyList. */
export interface HistoryQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

/** Slice-6 (premium browser): one ranked omnibox suggestion row. Computed in
 *  main by `suggest()` (src/main/browser/omnibox-suggest.ts) over USER-PARTITION
 *  sources ONLY — open visible user tabs, bookmarks, history — plus the trailing
 *  search + direct-URL fallback. Agent-partition URLs are NEVER surfaced here.
 *  `display` is the scheme-stripped completion string (drives inline completion);
 *  `url` is the full target handed to navigate/createTab (the M6 gate has final
 *  say); `score` is the rank key (higher = first). Additive contract — returned
 *  by the omniboxSuggest invoke channel. */
export interface OmniboxSuggestion {
  kind: 'tab' | 'bookmark' | 'history' | 'search' | 'url';
  title: string;
  url: string;
  display: string;
  score: number;
}

/** Slice-3 (premium browser): one row of the action-audit feed surfaced to the
 *  trusted-chrome Activity/Audit drawer + denial toasts. Mirrors the durable
 *  JSONL `AuditEntry` (src/main/browser/action-audit.ts) MINUS argsHash, which
 *  never crosses to the renderer. `outcome` is the same tagged string the JSONL
 *  carries: 'ok' | 'ok:authenticated' | 'denied:<DenialCode>' | 'error:<msg>'.
 *  Additive contract — emitted on the auditEvent push + returned by auditRecent. */
export interface BrowserAuditEntry {
  /** ISO-8601 timestamp (parse for the relative "x ago" label). */
  ts: string;
  verb: string;
  /** Full Electron partition string ('persist:user' | 'persist:agent' | ''). */
  partition: string;
  url: string;
  outcome: string;
  /** Present where resolvable (per-workspace isolation + Slice-2 identity). */
  workspaceId?: string | null;
  tabId?: string;
  agentId?: string;
  agentTitle?: string;
}

/** Pushed main → renderer when a page's window.open / target=_blank popup is
 *  denied (M6) — the UI may offer "open as new tab" instead. */
export interface BrowserOpenRequest {
  /** Tab whose page requested the popup. */
  tabId: string;
  url: string;
}

// ── Website-access policy (plans/website-allowlist-simplification.md) ─────────
// ONE human-curated agent allowlist layered on the global Agent Actions toggle +
// scheme/SSRF floor. Enforcement is keyed SOLELY to Agent Actions: ON ⇒ the
// allowlist is always enforced (default-deny — the agent may visit/drive only
// allowlisted origins); OFF ⇒ the agent cannot act in its partition at all.
// There is no second "human hand-off" list and no per-list off/enforce mode.
// The per-row `allowSignedIn` flag opts an origin into the authenticated-drive
// tier (§11–§14). Opening a page FOR the human (for_human_action) is OUTSIDE
// this entirely — scheme/SSRF floor only, never the allowlist.

export interface AccessRule {
  id: string;
  /** Normalized via new URL().hostname (lowercased, punycode, no trailing dot,
   *  no wildcard). */
  hostname: string;
  includeSubdomains: boolean;
  scheme: 'https' | 'http' | 'any';
  /** Optional; starts with '/'; absent = whole host. */
  pathPrefix?: string;
  note?: string;
  /** §13: per-row "allow while signed in" (authenticated-drive). */
  allowSignedIn: boolean;
  enabled: boolean;
  createdAt: number;
  /** Slice-4 (premium browser): the workspace whose agent partition this rule
   *  governs. A rule authorizes ONLY agents in its workspace (plus, for
   *  back-compat, NULL = legacy default applying to every workspace). Stamped
   *  trust-side from the human's selected workspace on a manual add, or inherited
   *  from the request's workspace on an approval — never from agent tool args.
   *  Additive/optional — absent/null = the legacy default. */
  workspaceId?: string | null;
}

export interface AccessRuleInput {
  hostname: string;
  includeSubdomains: boolean;
  scheme: 'https' | 'http' | 'any';
  pathPrefix?: string;
  note?: string;
  /** Optional; defaults false. */
  allowSignedIn?: boolean;
  /** Slice-4: the workspace to scope this rule to. Set trust-side (the manager
   *  stamps the human's selected workspace); the renderer never sends it. */
  workspaceId?: string | null;
}

/** §18: an agent-initiated access request awaiting human approval. Inert —
 *  grants ZERO access until a human approval creates a real rule. */
export type AccessRequestStatus = 'pending' | 'approved' | 'denied';
export type AccessRequestDecision = 'approve' | 'approve_signed_in' | 'deny';

export interface AccessRequest {
  id: string;
  /** Normalized server-side (the agent's raw string is untrusted). */
  hostname: string;
  includeSubdomains: boolean;
  scheme: 'https' | 'http' | 'any';
  pathPrefix?: string;
  /** Agent asked for authenticated-drive (allow_signed_in) too. */
  wantSignedIn: boolean;
  /** Requesting agent id. */
  requestedBy: string;
  /** Agent title at request time (display only). */
  requestedByTitle?: string;
  /** UNTRUSTED free text; render escaped, attributed to the agent. */
  reason?: string;
  status: AccessRequestStatus;
  createdAt: number;
  decidedAt?: number;
  /** Slice-4 (premium browser): the workspace of the agent that filed this
   *  request, resolved trust-side from the agent registry (never the agent's tool
   *  args). On approval the created rule inherits this, so a request approved for
   *  workspace A authorizes ONLY workspace A's agent. Additive/optional —
   *  absent/null = the legacy default. */
  workspaceId?: string | null;
}

/** Input for the agent tool browser_request_site_access (§18.3). */
export interface AccessRequestInput {
  hostname: string;
  scheme?: 'https' | 'http' | 'any';
  includeSubdomains?: boolean;
  pathPrefix?: string;
  reason?: string;
  wantSignedIn?: boolean;
}

/** Result of the access-handoff-signin IPC (§12-A step 1): the quarantined,
 *  visible agent-partition login tab that was opened. */
export interface AccessHandoffResult {
  tabId: string;
}

/** IPC channel names — single source so preload and main can't drift. */
export const BROWSER_CHANNELS = {
  createTab: 'browser:create-tab',
  closeTab: 'browser:close-tab',
  navigate: 'browser:navigate',
  goBack: 'browser:go-back',
  goForward: 'browser:go-forward',
  reload: 'browser:reload',
  stop: 'browser:stop',
  setActiveTab: 'browser:set-active-tab',
  setBounds: 'browser:set-bounds',
  setVisible: 'browser:set-visible',
  /** (workspaceId | null) — the human switched workspaces; main scopes the tab
   *  strip / visibility / new-tab stamping to it (per-workspace isolation). */
  setActiveWorkspace: 'browser:set-active-workspace',
  /** main → renderer event channel (BrowserTabState payload) */
  tabState: 'browser:tab-state',
  /** main → renderer event channel (BrowserOpenRequest payload) */
  openRequest: 'browser:open-request',

  // ── Slice-3: denial toasts + live Activity/Audit drawer ────────────────────
  // The M16 action-audit feed surfaced to trusted chrome. auditRecent primes the
  // drawer on mount; auditEvent pushes every fresh record (the manager forwards
  // ActionAudit.record()'s in-process tap). Both carry BrowserAuditEntry (never
  // argsHash). Trusted-chrome only — the agent never sees these.
  /** (limit?: number) → BrowserAuditEntry[] (tail of the JSONL, oldest→newest) */
  auditRecent: 'browser:audit-recent',
  /** event main→renderer (BrowserAuditEntry) — one fresh audit record */
  auditEvent: 'browser:audit-event',

  // ── M12 coarse act-tier gate (runtime toggle) ──────────────────────────────
  // Dashboard chrome flips the global "agent browser actions" runtime flag so
  // the human can enable act-tier verbs without relaunching with
  // AGENT_BROWSER_ACTIONS=1. Read-tier tools are unaffected. Not persisted.
  /** () → boolean — current runtime act-tier gate */
  getActionsEnabled: 'browser:get-actions-enabled',
  /** (enabled: boolean) → boolean — flip the gate; echoes the resulting state */
  setActionsEnabled: 'browser:set-actions-enabled',

  // ── Overhaul (WP0) channels ────────────────────────────────────────────────
  // Pure plumbing. Invoke unless marked `event` (main → renderer push).

  /** event main→renderer (BrowserTabSnapshotEntry[]) — authoritative tab order/pin */
  tabsSnapshot: 'browser:tabs-snapshot',
  /** (tabId, toOrder) */
  reorderTab: 'browser:reorder-tab',
  /** (tabId, pinned) */
  setTabPinned: 'browser:set-tab-pinned',
  /** () → {tabId} | null */
  reopenClosedTab: 'browser:reopen-closed-tab',
  /** event main→renderer (BrowserShortcut, {tabId}) — UI-reaction chords */
  shortcutCommand: 'browser:shortcut-command',
  /** (tabId, text, {forward,findNext}) */
  findInPage: 'browser:find-in-page',
  /** (tabId) */
  stopFindInPage: 'browser:stop-find-in-page',
  /** event main→renderer (BrowserFindResult) — counts only, never page text */
  foundInPage: 'browser:found-in-page',
  /** (tabId, zoomFactor) */
  setZoom: 'browser:set-zoom',
  /** (tabId, params) — renderer asks main to popup the native context menu */
  contextMenuRequest: 'browser:context-menu-request',
  /** event main→renderer (action, params) — renderer-side context-menu actions */
  contextMenuCommand: 'browser:context-menu-command',

  // Bookmarks — USER-PARTITION ONLY (agent URLs never persisted/exposed).
  /** () → Bookmark[] */
  bookmarkList: 'browser:bookmark-list',
  /** ({title,url}) → Bookmark */
  bookmarkAdd: 'browser:bookmark-add',
  /** (id) */
  bookmarkRemove: 'browser:bookmark-remove',
  /** Slice-7: (id, patch: BookmarkPatch) → Bookmark — edit title/favicon/folder.
   *  Preserves id + sort order. USER-PARTITION ONLY by contract. */
  bookmarkUpdate: 'browser:bookmark-update',
  /** (orderedIds[]) */
  bookmarkReorder: 'browser:bookmark-reorder',
  /** event main→renderer (Bookmark[]) */
  bookmarksChanged: 'browser:bookmarks-changed',

  // ── Slice-6: real omnibox (shared resolver + suggestions) ──────────────────
  // TRUSTED CHROME ONLY. Ranked + de-duped suggestions over USER-PARTITION
  // sources (open visible user tabs, bookmarks, history) + the trailing
  // search/direct-URL fallback. Agent-partition URLs are never surfaced.
  /** (query: string) → OmniboxSuggestion[] (ranked, capped) */
  omniboxSuggest: 'browser:omnibox-suggest',

  // History — USER-PARTITION ONLY (agent navigations never recorded/listed).
  /** ({query?,limit?,offset?}) → HistoryEntry[] */
  historyList: 'browser:history-list',
  /** (id) */
  historyDelete: 'browser:history-delete',
  /** () */
  historyClear: 'browser:history-clear',
  /** Slice-8: (limit?) → HistoryEntry[] — most-visited user sites
   *  (visit_count DESC, visited_at DESC). Consumed by the NTP (Slice-9). */
  historyTopSites: 'browser:history-top-sites',

  // ── Website-access policy (plans/website-allowlist-simplification.md) ────────
  // ONE agent allowlist. Enforcement is keyed SOLELY to the Agent Actions toggle
  // (no per-list off/enforce mode). Rule CRUD (§7).
  /** () → AccessRule[] */
  accessRuleList: 'browser:access-rule-list',
  /** (input: AccessRuleInput) → AccessRule */
  accessRuleAdd: 'browser:access-rule-add',
  /** (id, patch: Partial<AccessRuleInput> & {enabled?}) → AccessRule */
  accessRuleUpdate: 'browser:access-rule-update',
  /** (id: string) → void */
  accessRuleRemove: 'browser:access-rule-remove',
  /** event main→renderer (no payload) — rules changed; renderer refetches */
  accessChanged: 'browser:access-changed',

  // Agent-initiated access requests (§18.5). Renderer = trusted chrome only.
  /** () → AccessRequest[] (pending + recent) */
  accessRequestList: 'browser:access-request-list',
  /** (id, decision: AccessRequestDecision) → void */
  accessRequestDecide: 'browser:access-request-decide',
  /** event main→renderer (no payload) — request list changed; renderer refetches */
  accessRequestsChanged: 'browser:access-requests-changed',

  // Five trusted-chrome-only authenticated-drive IPCs (§14). Never callable
  // from agent tools or page content.
  /** (ruleId) → AccessHandoffResult — Mechanism A: open the visible, quarantined
   *  agent-partition login tab (§12-A step 1). */
  accessHandoffSignin: 'browser:access-handoff-signin',
  /** (tabId) → void — Mechanism A: revalidate committed URL, clear signinPending,
   *  upsert the committed origin (§12-A step 4). Throws on off-origin. */
  accessHandoffReady: 'browser:access-handoff-ready',
  /** (tabId) → void — Mechanism B: validate committed origin is an allow_signed_in
   *  rule (refuse otherwise), set handedToAgent (§12-B). */
  accessTabHandToAgent: 'browser:tab-hand-to-agent',
  /** (tabId) → void — Mechanism B revoke: detach driver, clear handedToAgent. */
  accessTabReturnToHuman: 'browser:tab-return-to-human',
  /** (ruleId) → void — per-row "Clear agent session" → clearAgentSiteData (§14). */
  accessClearSiteSession: 'browser:access-clear-site-session',
} as const;
