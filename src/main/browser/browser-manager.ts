// WP1-A task 4 (plans/embedded-browser-implementation-tasks.md) — thin
// Electron glue over browser-decisions.ts. All policy lives in the pure
// module (unit-tested); this file only applies it to real sessions/views.
// Mitigations wired here: M2 (loopback filter), M3 (hardened webPreferences),
// M4 (managed-contents seam), M5 (permission deny-all), M6 (nav gates +
// popup deny), M7 (downloads denied), M9 (debugger attach rule).

import { randomUUID } from 'crypto';
import path from 'path';
import { app, Menu, session, shell, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, Event as ElectronEvent, Session, WebContents } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { setManagedWebContentsCheck } from '../security/webcontents-guard';
import { WS_PORT, JUPYTER_BASE_PORT, JUPYTER_PORT_RETRIES } from '../control-ports';
import {
  buildBrowserWebPreferences,
  buildChromeUA,
  decideLoopbackBlock,
  decideNavigation,
  uaForUrl,
  type ControlPorts,
} from './browser-decisions';
import { CdpDriver, KEYBOARD_DROPDOWN_GUIDANCE } from './cdp-driver';
import { resolveKey, SUPPORTED_BROWSER_KEYS } from './key-map';
import { buildA11ySnapshot, RefRegistry } from './a11y-snapshot';
import { ActionAudit, AUDIT_FILE_NAME, hashArgs, type AuditEntry } from './action-audit';
import {
  assertAllowed,
  browserToolsEnabled,
  checkAction,
  checkAgentVisit,
  checkNavigation,
  checkSignedInDrive,
  EXPOSURE_REDUCING_VERBS,
  isSensitiveOrigin,
  getRuntimeActionsEnabled,
  getAgentActionsState,
  setAgentActionsState,
  PolicyError,
  wrapUntrusted,
  type AgentActionsCommand,
  type AgentActionsState,
  type BrowserToolVerb,
  type CompiledRule,
} from './browser-policy';
import {
  BROWSER_CHANNELS,
  type AccessHandoffResult,
  type AccessRequest,
  type AccessRequestDecision,
  type AccessRequestInput,
  type AccessRule,
  type AccessRuleInput,
  type Bookmark,
  type BookmarkPatch,
  type BrowserAuditEntry,
  type BrowserBounds,
  type BrowserContextMenuParams,
  type BrowserCreateTabOptions,
  type BrowserDownload,
  type BrowserDownloadPrompt,
  type BrowserDownloadState,
  type BrowserFindOptions,
  type BrowserPartition,
  type BrowserShortcut,
  type BrowserTabSnapshotEntry,
  type BrowserTabState,
  type HandedTabInfo,
  type HistoryEntry,
  type HistoryQuery,
  type OmniboxSuggestion,
  type ReaderArticle,
  type SharedAgentSessions,
} from '../../shared/browser';
import {
  deleteBookmark,
  insertBookmark,
  listBookmarks,
  reorderBookmarks,
  updateBookmark,
} from './bookmarks-store';
import {
  decideRequest,
  deleteRule,
  getRule,
  insertRequest,
  insertRule,
  listRequests,
  listRequestsByAgent,
  listRules,
  listSharedSignedInOrigins,
  listSignedInOrigins,
  rowAppliesToWorkspace,
  touchSignedInOrigin,
  updateRule,
  upsertSignedInOrigin,
  type InsertRequestInput,
} from './access-policy-store';
import {
  clearHistory,
  deleteHistory,
  listHistory,
  recordVisit,
  searchHistoryRanked,
  topSites,
} from './history-store';
import { buildContextMenuTemplate } from './context-menu';
import { extractReaderArticle } from './reader-extract';
import {
  configureOmniboxSources,
  suggest as omniboxSuggestRanked,
  type OmniboxOpenTab,
} from './omnibox-suggest';
import {
  loadSession,
  replaceSession,
  pushClosedTab,
  popClosedTab,
  peekNewestClosedAt,
  type SessionTabRow,
} from './session-store';
import {
  getDownload,
  insertDownload,
  isPathWithinDir,
  listDownloads,
  normalizeDownloadFilename,
  removeDownload,
  setDownloadState,
  updateDownloadProgress,
} from './downloads-store';
import {
  getZoom as getStoredZoom,
  setZoom as setStoredZoom,
  clearZoom as clearStoredZoom,
} from './zoom-store';

/** Clamp helper for zoom factor (and any other bounded numeric). */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Slice 15: the persist key for per-site zoom — the http(s) origin of a
 *  committed URL, or null for anything that should NOT carry a saved zoom (NTP,
 *  about:blank, non-http schemes, unparseable). PURE so the manager never
 *  fabricates a 'null'-origin row. */
function zoomOriginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

// ── Slice 10/11: session-restore + frozen/discarded tab model constants ───────
const DISCARD_SWEEP_MS = 60_000; // idle-sweep interval
/** Default idle threshold before a hidden user tab is discarded. MUTABLE
 *  module-level value (the §11 setter writes it; each sweep reads it). null =
 *  Never (idle discard disabled; the hard live-view cap still applies). */
let DISCARD_IDLE_MS: number | null = 30 * 60_000;
const MAX_LIVE_USER_VIEWS = 12; // hard live-view cap (LRU discard beyond this)
const SCROLL_CAPTURE_TIMEOUT_MS = 150; // fail-open bound for scroll capture (§8)
const SESSION_WRITE_DEBOUNCE_MS = 500; // debounced persistence after tab churn

/** Test/back-compat reader for the mutable idle threshold. */
export function __getDiscardIdleMsForTests(): number | null {
  return DISCARD_IDLE_MS;
}

/**
 * Slice-1 (premium browser) connection-security indicator from a committed URL.
 * `https:` → 'secure', `http:` → 'insecure', and everything else (NTP, empty,
 * about:blank, non-http internal pages, unparseable) → 'internal'. PURE +
 * exported so the unit tests can assert scheme→state without a live view.
 */
export function secureStateForUrl(url: string | undefined): 'secure' | 'insecure' | 'internal' {
  if (!url) return 'internal';
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'https:') return 'secure';
    if (protocol === 'http:') return 'insecure';
    return 'internal';
  } catch {
    return 'internal';
  }
}

/**
 * Structural shape of the subset of `Electron.Input` that `mapChord` reads.
 * Kept local + minimal so the helper is unit-testable under plain node
 * (no Electron runtime needed) — `Electron.Input` is structurally assignable.
 */
export interface ChordInput {
  type?: string;
  key?: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * PURE keyboard-chord → BrowserShortcut mapper (WP6-KEYS). Returns null for any
 * input that is not a recognized browser chord, so the caller only
 * `preventDefault`s handled chords. Ctrl (Win/Linux) OR Cmd/meta (macOS) is the
 * primary modifier; Alt-bearing combos are never claimed. F5 is the one
 * modifier-less chord (bare reload). Unit-tested in manager-shortcuts.test.ts.
 */
export function mapChord(input: ChordInput): BrowserShortcut | null {
  // Only act on key-down (ignore key-up / autorepeat 'keyUp').
  if (input.type && input.type !== 'keyDown') return null;

  const key = (input.key ?? '').toLowerCase();

  // F5 — bare reload, no modifier (and must not carry one).
  if (key === 'f5' && !input.control && !input.meta && !input.alt && !input.shift) {
    return 'reload';
  }

  const mod = Boolean(input.control || input.meta);
  if (!mod) return null;
  // Alt-bearing combos belong to the OS / page, never to us.
  if (input.alt) return null;

  const shift = Boolean(input.shift);
  switch (key) {
    case 't':
      return shift ? 'reopen-closed' : 'new-tab';
    case 'w':
      return shift ? null : 'close-tab';
    case 'l':
      return 'focus-address';
    case 'r':
      return 'reload';
    case 'f':
      return 'find';
    case 'h':
      return 'history';
    case 'd':
      return 'bookmark';
    case 'tab':
      return shift ? 'cycle-prev' : 'cycle-next';
    // Zoom: '+'/'=' share a physical key; '-'/'_' likewise. Shift-agnostic.
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case '0':
      return 'zoom-reset';
    default:
      return null;
  }
}

interface TabEntry {
  id: string;
  view: WebContentsView;
  partition: BrowserPartition;
  /** CANONICAL policy partition string ('persist:user' | 'persist:agent') —
   *  what checkAction() / audit records compare against. NOT the Electron session
   *  partition (that is workspace-scoped — see sessionPartition). */
  partitionFull: string;
  /** Slice-4: the workspace-scoped Electron *session* partition this tab's
   *  WebContentsView actually lives on — 'persist:user' (shared) for human tabs,
   *  'persist:agent:<workspaceId>' for agent tabs. This is the cookie/storage
   *  isolation boundary. Optional only so the test harness's fabricated tabs
   *  (which do not call createTab) may omit it. */
  sessionPartition?: string;
  /** Per-workspace isolation: the workspace this tab belongs to. Stamped at
   *  createTab time (the human's current workspace for UI-/main-initiated tabs;
   *  the agent's workspace for openUrl tabs). The renderer shows a tab only when
   *  its workspaceId matches the selected workspace, exactly like file-viewer
   *  tabs. null = unscoped (pre-workspace-selection / back-compat). */
  workspaceId: string | null;
  /** Phase 2: set for tabs created by agent tools so the UI can flash them. */
  openedByAgent: boolean;
  /** Website-allowlist §12-A (Mechanism A): RUNTIME, NON-PERSISTED. While true,
   *  this visible agent-partition login tab is QUARANTINED from all agent tools
   *  (the human is typing credentials). Set ONLY by access-handoff-signin,
   *  cleared ONLY by access-handoff-ready — never by the agent or page content. */
  signinPending?: boolean;
  /** The List-A rule this sign-in quarantine is for (so handoff-ready can upsert
   *  the committed origin into browser_access_signed_in_origins). */
  signinRuleId?: string;
  /** Website-allowlist §12-B (Mechanism B): RUNTIME, NON-PERSISTED. While true,
   *  the agent driver may attach to this (normally persist:user) tab — but ONLY
   *  while its committed origin is still an allow_signed_in List-A rule
   *  (isAgentDrivable re-checks every attach/gate). Set ONLY by the trusted
   *  tab-hand-to-agent gesture; cleared on return/close/off-origin auto-revoke.
   *  Never set by the agent or page content. */
  handedToAgent?: boolean;
  /** Slice-1 (premium browser): connection-security indicator computed on
   *  did-navigate from the committed URL scheme. Surfaced via sendTabState
   *  (also recomputed there from the live URL, so it is never stale). */
  secureState?: 'secure' | 'insecure' | 'internal';
  /** Slice-1: last main-frame load failure / renderer crash for the trusted
   *  error panel. NEVER page content — Electron error code/description + the
   *  validated URL only. Set on did-fail-load / render-process-gone; cleared
   *  on did-start-loading / successful did-navigate. */
  lastError?: { code: string; description: string; url: string } | null;
  /** Slice-1: transient renderer-unresponsive flag. LOCAL, not persisted, not
   *  on the wire contract — tracked so unresponsive/responsive can push fresh
   *  tab state to the chrome. */
  unresponsive?: boolean;
  /** Slice-2: agent identity, stamped once at createTab from the trusted API
   *  layer (resolved from the agent registry — never the agent's tool args).
   *  Surfaced via sendTabState for the "Opened by <title>" tooltip + attribution. */
  openedByAgentId?: string;
  openedByAgentTitle?: string;
  /** Slice-2: authoritative attention model. Set ONCE when an agent opens/raises
   *  this tab (with a fresh `lastAttentionAt` stamp). Main never loops/re-pulses;
   *  the renderer flashes briefly and clears its own attention on select. */
  needsHumanAttention?: boolean;
  lastAttentionAt?: number;
  /** Slice 10/11: wall-clock ms this live view was created (createTab /
   *  hydrateFrozenTab). The idle-sweep LRU falls back to this when the tab has
   *  never been the active tab (no lastActiveAt entry). */
  createdAt?: number;
  /** Slice 15: per-tab find-in-page state. `query` + `matchCase` are the latest
   *  search this tab is running (so findNext/findPrev reuse them immediately and
   *  a tab switch can re-run the query); `activeMatchOrdinal`/`total` mirror the
   *  last native found-in-page result for restore. Absent = no active find.
   *  RUNTIME ONLY — never persisted (find is ephemeral, not session state). */
  findState?: { query: string; matchCase: boolean; activeMatchOrdinal: number; total: number };
}

/** Slice 10/11: a snapshot-backed tab with NO WebContentsView — either restored
 *  on startup (origin 'restored') or idle/cap-discarded (origin 'discarded').
 *  USER PARTITION ONLY by construction. Its id also lives in tabOrder/pinnedTabs
 *  so the strip renders it inline with live tabs. */
interface FrozenTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  partition: 'user';
  workspaceId: string | null;
  pinned: boolean;
  sortOrder: number;
  groupId: string | null;
  scrollY?: number;
  /** 'restored' (startup) vs 'discarded' (idle/cap sweep) → drives `discarded`. */
  origin: 'restored' | 'discarded';
}

// ── WP2 frozen provider contract (WP2-B injects browserManager.tools into
//    ApiServer and codes against these shapes structurally) ─────────────────

export interface TabSnapshot {
  tabId: string;
  url: string;
  partition: BrowserPartition;
  /** Wrapped (untrusted-framed) a11y snapshot — present for agent-partition
   *  opens only. ABSENT on forHuman opens: that path gives no readback (M9). */
  pageSnapshot?: string;
}

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  partition: BrowserPartition;
  openedByAgent: boolean;
}

/** Result of closeTab: the closed tab is gone, so there is no post-action
 *  snapshot — the updated agent tab list is returned instead. */
export interface CloseTabResult {
  closed: boolean;
  tabs: TabInfo[];
}

/** Result of waitFor: a server-side bounded poll; `snapshot` present only when
 *  the awaited text appeared before the budget elapsed. */
export interface WaitForResult {
  found: boolean;
  elapsedMs: number;
  snapshot?: string;
}

export interface BrowserToolProvider {
  openUrl(
    url: string,
    opts: {
      forHuman?: boolean;
      workspaceId?: string | null;
      /** Slice-2: identity of the calling agent, resolved by the trusted API
       *  layer from the agent registry (never the agent's own tool args).
       *  Stamped onto the tab for the "Opened by <title>" tooltip + attention. */
      agentId?: string;
      agentTitle?: string;
    },
  ): Promise<TabSnapshot>;
  listTabs(): TabInfo[];
  getPageText(tabId: string): Promise<string>;
  readPage(tabId: string): Promise<string>;
  screenshot(tabId: string): Promise<{ base64Png: string }>;
  click(tabId: string, ref: number): Promise<string>;
  type(tabId: string, ref: number, text: string): Promise<string>;
  pressKey(tabId: string, key: string): Promise<string>;
  selectOption(tabId: string, ref: number, value: string): Promise<string>;
  scroll(tabId: string, opts: { ref?: number; dy?: number }): Promise<string>;
  goBack(tabId: string): Promise<string>;
  goForward(tabId: string): Promise<string>;
  reload(tabId: string): Promise<string>;
  waitFor(tabId: string, input: { text: string; timeoutMs?: number }): Promise<WaitForResult>;
  closeTab(tabId: string): Promise<CloseTabResult>;
  /** §18 — agent-initiated access request. Inert: writes a pending request for a
   *  human to approve; grants zero access. requestedBy/Title are stamped by the
   *  trusted API layer, not the agent's tool args. */
  requestSiteAccess(input: AccessRequestInput & {
    requestedBy: string;
    requestedByTitle?: string;
    /** Slice-4: the requesting agent's workspace, resolved trust-side by the API
     *  layer from the agent registry (never the agent's tool args). The created
     *  rule on approval inherits it, so a request approved for workspace A
     *  authorizes ONLY workspace A's agent. */
    workspaceId?: string | null;
  }): { requestId: string; status: AccessRequest['status'] };
  /** §18 — a single agent's own requests + statuses. */
  listMyAccessRequests(agentId: string): AccessRequest[];
}

/** Canonical POLICY partition strings. These are the values checkAction() /
 *  audit records compare against — they MUST stay exactly 'persist:user' /
 *  'persist:agent' (the pure policy module string-matches them). The per-tab
 *  Electron *session* partition is workspace-scoped separately (Slice-4) via
 *  agentPartitionForWorkspace(); only that diverges per workspace, never the
 *  policy string. */
const PARTITION_FULL: Record<BrowserPartition, string> = {
  user: 'persist:user',
  agent: 'persist:agent',
};

/** Slice-4: per-workspace access-cache map key for the NULL (legacy default)
 *  workspace. Real workspace ids are keyed as `ws:${id}`, so this sentinel can
 *  never collide with a real id — even one literally named "null". */
const NULL_WS_CACHE_KEY = 'null-ws';

/**
 * Slice-4 (premium browser — workspace-scoped agent partitions): derive the
 * Electron *session* partition for an agent tab in a given workspace. The agent
 * session is per-workspace — `persist:agent:<workspaceId>` (fallback
 * `persist:agent:default` for null) — so an agent's cookies / localStorage /
 * signed-in sessions in workspace A live in a different Electron session than in
 * workspace B and are invisible across the boundary. The human's own
 * `persist:user` browsing is shared and untouched (handled by partitionFor).
 *
 * PURE + exported so the unit tests can assert isolation (A ≠ B, null → default)
 * without a live Chromium. The workspace id is sanitized to a partition-safe
 * token (Electron persists each partition to its own on-disk directory) while
 * preserving distinctness: the raw id is appended after a stable hash-free
 * lowercasing of safe chars, and any unsafe run collapses to '_' — but two
 * different ids can never collide because the FULL raw id (URI-encoded) is what
 * is used; see below.
 */
export function agentPartitionForWorkspace(workspaceId: string | null | undefined): string {
  if (workspaceId == null || workspaceId === '') return 'persist:agent:default';
  // encodeURIComponent keeps every distinct id distinct (no lossy collapse) and
  // yields only partition/path-safe characters except for '%', which is itself
  // safe in a partition name. This makes the partition string a 1:1 function of
  // the workspace id.
  return `persist:agent:${encodeURIComponent(workspaceId)}`;
}

/** Slice-4: full Electron session partition for a (policy partition, workspace).
 *  The human partition is shared across workspaces; the agent partition is
 *  per-workspace. */
function partitionFor(partition: BrowserPartition, workspaceId: string | null | undefined): string {
  return partition === 'user' ? 'persist:user' : agentPartitionForWorkspace(workspaceId);
}

/** ARIA roles a select_option target may expose as a choosable option. Native
 *  <select> popups are OS-rendered and absent from the AX tree, so they never
 *  match — toolSelectOption throws a readable native-<select> error instead. */
const SELECTABLE_OPTION_ROLES = new Set<string>([
  'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox',
]);

export class BrowserManager {
  private tabs = new Map<string, TabEntry>();
  /** Latest favicon URL per tab (page-favicon-updated has no getter to re-read). */
  private tabFavicons = new Map<string, string | undefined>();
  private activeTabId: string | null = null;
  /** Per-workspace isolation: the workspace the human is currently viewing
   *  (pushed from the renderer on every workspace switch via setActiveWorkspace).
   *  New UI-/main-initiated tabs stamp this; the tab strip, view visibility, and
   *  Ctrl+Tab cycling are all scoped to it. null until the renderer first syncs. */
  private currentWorkspaceId: string | null = null;
  /** Pane suspension (z-order hazard: a WebContentsView always paints above
   *  renderer DOM, so renderer modals must be able to hide the pane). */
  private paneVisible = true;
  private lastBounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private controlPorts: ControlPorts;
  /** Lazily-attached CDP drivers, persist:agent tabs only (M9). */
  private drivers = new Map<string, CdpDriver>();
  /** Per-tab a11y ref bookkeeping (WP2-A; stale refs → typed error). */
  private refRegistries = new Map<string, RefRegistry>();
  /** M16 audit writer — lazy so app.getPath is only touched when a tool runs. */
  private auditWriter: ActionAudit | null = null;
  private toolsFacade: BrowserToolProvider | null = null;

  // ── Overhaul (WP7) — main is authoritative for tab order / pin / closed stack ──
  /** Display order of live tabIds. Normalized so pinned tabs cluster left. */
  private tabOrder: string[] = [];
  /** Pinned tabIds (cluster to the left of unpinned in the strip). */
  private pinnedTabs = new Set<string>();
  /** LIFO of recently-closed AGENT-partition tabs for Ctrl+Shift+T. In-memory
   *  only (never persisted — no agent URL touches disk). USER closes go to the
   *  persistent SQLite reopen stack instead (session-store); `pushedAt` lets the
   *  reopen merge pick whichever side was closed more recently (Slice 10). */
  private closedTabStack: Array<{ url: string; partition: BrowserPartition; title: string; pushedAt: number }> = [];

  // ── Slice 10/11: frozen/discarded tab model + session persistence ───────────
  /** Snapshot-backed tabs with NO WebContentsView (restored-on-startup or
   *  idle-discarded). USER PARTITION ONLY. Their ids also live in
   *  tabOrder/pinnedTabs; they are NEVER in `this.tabs`. */
  private frozenTabs = new Map<string, FrozenTab>();
  /** Last wall-clock ms a live tab was the active tab (idle sweep + LRU cap). */
  private lastActiveAt = new Map<string, number>();
  /** Best-effort last-known scrollY per live user tab (eventually consistent §8). */
  private lastScrollY = new Map<string, number>();
  /** Ids being deliberately discarded — the `destroyed` handler must NOT tear
   *  down their frozen metadata (Fix A). */
  private discardingTabs = new Set<string>();
  /** Idempotency latch: sessionRestore re-materializes the persisted tabs once. */
  private sessionRestored = false;
  private sessionWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private discardSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Slice 12: fires when a time-boxed arming window elapses, so the renderer
   *  sees the auto-flip to `disabled` even with no IPC traffic. Cleared/rescheduled
   *  on every setAgentActionsState. */
  private actionsExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Website-access policy (plans/website-allowlist-simplification.md §5) ────
  /** Synchronously-readable memo of the compiled agent allowlist rules. MUST be
   *  sync: the will-navigate/will-redirect chokepoints call event.preventDefault()
   *  inline and cannot await before deciding. better-sqlite3 is fully synchronous,
   *  so the cache loads on first access (and the next access after invalidate)
   *  via a plain sync read — never a Promise. Cleared by invalidateAccessCache(),
   *  called by every access mutation. Enforcement is keyed to the Agent Actions
   *  toggle (no per-list mode dimension). */
  // Slice-4: the access cache is keyed PER WORKSPACE — the agent allowlist is
  // workspace-scoped, so a tab in workspace A is gated against A's rules only.
  // The key is the workspace id, or DEFAULT_WS_CACHE_KEY for the null (legacy
  // default) workspace. Every access mutation clears the whole map.
  private accessCache = new Map<string, { agentRules: CompiledRule[] }>();
  /** Slice-4: Electron session partitions already hardened (hardenSession is
   *  idempotent but the underlying webRequest handlers should be installed once).
   *  persist:user is hardened up-front; each workspace's agent session is
   *  hardened lazily on first createTab. */
  private hardenedSessions = new Set<string>();

  // ── Slice 13: user-only downloads (decision gate + app-managed dir) ──────────
  /** USER-partition downloads blocked awaiting a trusted-chrome confirmation,
   *  keyed by the one-shot prompt token. confirmDownload(token) re-initiates the
   *  download via session.downloadURL and registers it in approvedDownloadUrls so
   *  the re-fired will-download is allowed through (never auto-allowed). */
  private pendingDownloadConfirms = new Map<
    string,
    { url: string; filename: string; origin: string; workspaceId: string | null; sessionPartition: string }
  >();
  /** Human-approved USER downloads keyed by URL — set by confirmDownload just
   *  before re-initiating, consumed (one-shot) by the re-fired will-download. */
  private approvedDownloadUrls = new Map<string, { workspaceId: string | null }>();

  constructor(
    private getMainWindow: () => BrowserWindow | null,
    apiPort: number,
  ) {
    // M2 ports: apiPort is the ACTUAL bound port from the awaited
    // ApiServer.start() (WP0.1) — survives EADDRINUSE auto-increment.
    this.controlPorts = {
      apiPort,
      wsPort: WS_PORT,
      jupyterBase: JUPYTER_BASE_PORT,
      jupyterRetries: JUPYTER_PORT_RETRIES,
    };

    // Harden the human partition up-front (M2 + M5 + M7), before any view can
    // exist on it. Slice-4: the agent partition is now per-workspace
    // (persist:agent:<workspaceId>), so each workspace's agent session is
    // hardened lazily on its first createTab via ensureSessionHardened().
    this.ensureSessionHardened('persist:user');

    // M4 hookup: register into WP0's webcontents-guard seam so the global
    // invariant guard recognizes pane views as deliberately managed.
    setManagedWebContentsCheck((wc) => this.isManaged(wc));

    // Slice-6 omnibox: wire the suggester's USER-PARTITION sources. The provider
    // feeds ONLY user tabs (the suggester independently drops non-user tabs too,
    // defense-in-depth) plus the persisted user-partition bookmark/history
    // stores. The history source uses an indexed LIKE ranked by frequency.
    configureOmniboxSources((query) => ({
      openTabs: this.omniboxOpenTabs(),
      bookmarks: listBookmarks(),
      history: searchHistoryRanked(query, 30),
    }));

    // Slice-11: start the idle-discard + hard-cap sweep (USER tabs only).
    this.startDiscardSweep();
  }

  /** Slice-6: snapshot of the OPEN USER tabs for the omnibox (switch-to-tab
   *  source). Agent tabs are excluded here — their URLs must never reach the
   *  trusted-chrome omnibox (cross-cutting rule #1). The suggester then scopes
   *  these to the requested workspace and re-checks the partition. */
  private omniboxOpenTabs(): OmniboxOpenTab[] {
    const out: OmniboxOpenTab[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.partition !== 'user') continue;
      const url = tab.view.webContents.getURL();
      if (!url) continue;
      out.push({
        tabId: tab.id,
        url,
        title: tab.view.webContents.getTitle(),
        partition: 'user',
        workspaceId: tab.workspaceId,
      });
    }
    return out;
  }

  /** Slice-6: ranked omnibox suggestions for the human's CURRENT workspace.
   *  Trusted-chrome only — never callable from agent tools. */
  omniboxSuggest(query: string): OmniboxSuggestion[] {
    if (typeof query !== 'string') return [];
    return omniboxSuggestRanked(query, this.currentWorkspaceId);
  }

  /** M2 + M5 + M7 + Chrome presentation (G1 fail ladder), per partition session. */
  private hardenSession(ses: Session): void {
    // G1 fail ladder step 1 (2026-06-11 Google sign-in FAIL): set the UA
    // directly on each pane session. app.userAgentFallback alone is known to
    // silently miss WebContentsView in some Electron versions (#47979); the
    // session-level override is authoritative for every webContents created
    // on this session afterwards — and all pane views are (constructor runs
    // before any createTab).
    ses.setUserAgent(buildChromeUA(process.versions.chrome));

    // G1 fail ladder round 2: round 1's Sec-CH-UA* "Google Chrome" brand
    // forgery (onBeforeSendHeaders rewrite) is REMOVED — httpbin proved the
    // forged headers byte-perfect yet Google still blocked, and forged
    // brands are themselves a detectable mismatch against the JS-side
    // navigator.userAgentData (Chromium-only, no non-CDP override). Genuine
    // Chromium hints now flow unmodified, matching what Ferdium ships.
    // Rationale + sources in browser-decisions.ts.

    // M2: pane content must never reach the dashboard control plane on
    // loopback (the global PNA disable at index.ts:30 lowered that shield).
    ses.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, cb) => {
        if (decideLoopbackBlock(details.url, this.controlPorts)) {
          cb({ cancel: true });
          return;
        }
        cb({});
      },
    );

    // M5: deny-by-default permissions — Electron auto-APPROVES everything
    // (camera, mic, geolocation, clipboard-read, hid, …) when no handler is
    // set. Deny all, no exceptions, both partitions.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);

    // Slice 13 (supersedes the day-one M7 deny-all): downloads are now gated by
    // the decision gate — agent downloads only from allowlisted (non-sensitive)
    // origins; user downloads only after a trusted-chrome confirmation; ALL
    // accepted downloads are confined to the app-managed dir with a normalized,
    // traversal-proof filename. The session-level listener fires for every pane
    // on this partition, so handleWillDownload resolves the originating tab.
    ses.on('will-download', (event, item, webContents) => {
      this.handleWillDownload(event, item, webContents);
    });
  }

  /** Slice-4: harden an Electron session partition exactly once. Called for
   *  persist:user at construction and for each workspace's agent partition
   *  (persist:agent:<workspaceId>) on its first createTab. */
  private ensureSessionHardened(partitionFull: string): void {
    if (this.hardenedSessions.has(partitionFull)) return;
    this.hardenSession(session.fromPartition(partitionFull));
    this.hardenedSessions.add(partitionFull);
  }

  // ── Tab lifecycle ──────────────────────────────────────────────────────────

  createTab(
    opts: BrowserCreateTabOptions,
    internal?: {
      openedByAgent?: boolean;
      /** Slice-2: trusted agent identity (resolved by the API layer from the
       *  agent registry). Present only on agent-tool opens. */
      openedByAgentId?: string;
      openedByAgentTitle?: string;
    },
  ): { tabId: string } {
    const partitionFull = PARTITION_FULL[opts.partition];
    if (!partitionFull) throw new Error(`unknown partition: ${String(opts.partition)}`);

    // Per-workspace isolation: an explicit workspaceId (renderer-initiated tab
    // for the human's selected workspace, or agent openUrl for the agent's
    // workspace) wins; otherwise stamp the workspace main currently tracks.
    const workspaceId = opts.workspaceId !== undefined ? opts.workspaceId : this.currentWorkspaceId;
    // Slice-4: the Electron *session* partition is workspace-scoped for agent
    // tabs (persist:agent:<workspaceId>); the human partition is shared. This is
    // the boundary that makes an agent's signed-in cookies in workspace A
    // invisible in workspace B. `partitionFull` stays the canonical policy string.
    const sessionPartition = partitionFor(opts.partition, workspaceId);

    // loadURL bypasses will-navigate, so the M6 gate must run here too.
    if (opts.url !== undefined) {
      const nav = decideNavigation(opts.url, opts.partition);
      if (!nav.allow) throw new Error(`navigation denied: ${nav.reason}`);
    }

    // Harden the (possibly brand-new, per-workspace) agent session before any
    // content can load on it.
    this.ensureSessionHardened(sessionPartition);
    const view = new WebContentsView({
      webPreferences: {
        // M3: every field explicit from the pure builder — a pane view must
        // never inherit the shell's webSecurity:false / preload.
        ...buildBrowserWebPreferences(opts.partition),
        session: session.fromPartition(sessionPartition),
      },
    });

    const tabId = randomUUID();
    const tab: TabEntry = {
      id: tabId,
      view,
      partition: opts.partition,
      partitionFull,
      sessionPartition,
      workspaceId,
      openedByAgent: internal?.openedByAgent === true,
      // Slice-2: stamp agent identity + raise the authoritative attention flag
      // ONCE for agent-tool opens. Main does not loop/re-pulse — the renderer
      // flashes briefly and clears its local attention on select.
      openedByAgentId: internal?.openedByAgentId,
      openedByAgentTitle: internal?.openedByAgentTitle,
      needsHumanAttention: internal?.openedByAgent === true ? true : undefined,
      lastAttentionAt: internal?.openedByAgent === true ? Date.now() : undefined,
      createdAt: Date.now(),
    };
    this.tabs.set(tabId, tab);
    this.lastActiveAt.set(tabId, tab.createdAt ?? Date.now());
    this.tabOrder.push(tabId); // new tabs append (unpinned → right cluster)
    this.wireViewEvents(tab);

    const win = this.getMainWindow();
    if (win) {
      win.contentView.addChildView(view);
      view.setBounds(this.lastBounds);
      view.setVisible(false); // hidden until setActiveTab selects it
    }

    if (opts.url !== undefined) {
      void view.webContents.loadURL(opts.url);
    }
    this.sendTabState(tab);
    this.emitTabsSnapshot(); // membership changed
    if (opts.partition === 'user') this.schedulePersist(); // Slice-10 session
    return { tabId };
  }

  closeTab(tabId: string): void {
    // Slice-10: closing a FROZEN tab (restored/discarded, never hydrated) — there
    // is no live view to tear down. Push its snapshot onto the persistent (USER)
    // reopen stack and drop it from the order.
    const frozen = this.frozenTabs.get(tabId);
    if (frozen) {
      this.frozenTabs.delete(tabId);
      this.forgetTabOrder(tabId);
      pushClosedTab({
        workspaceId: frozen.workspaceId,
        url: frozen.url,
        title: frozen.title,
        favicon: frozen.favicon,
        groupId: frozen.groupId,
        closedAt: Date.now(),
      });
      this.emitTabsSnapshot();
      this.schedulePersist();
      return;
    }
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    // Push to the reopen stack BEFORE closing. Skip empty / about:blank tabs —
    // there is nothing useful to reopen.
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) {
      const url = wc.getURL();
      if (url && url !== 'about:blank') {
        if (this.isPersistableUserTab(tab) && decideNavigation(url, 'user').allow) {
          // Slice-10: a USER close goes to the PERSISTENT SQLite reopen stack so
          // Ctrl+Shift+T survives a restart. Agent URLs never touch disk.
          pushClosedTab({
            workspaceId: tab.workspaceId,
            url,
            title: wc.getTitle(),
            favicon: this.tabFavicons.get(tab.id),
            groupId: null,
            closedAt: Date.now(),
          });
        } else {
          // AGENT (and signin/handed quarantine) close → in-memory LIFO only
          // (partition preserved so an agent tab reopens as agent, never promoted).
          this.closedTabStack.push({
            url,
            partition: tab.partition,
            title: wc.getTitle(),
            pushedAt: Date.now(),
          });
        }
      }
    }
    this.tabs.delete(tabId);
    this.drivers.delete(tabId);
    this.refRegistries.delete(tabId);
    this.lastActiveAt.delete(tabId);
    this.lastScrollY.delete(tabId);
    this.forgetTabOrder(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
    this.getMainWindow()?.contentView.removeChildView(tab.view);
    wc.close();
    this.emitTabsSnapshot(); // membership changed
    this.schedulePersist();
  }

  navigate(tabId: string, url: string): void {
    const tab = this.mustGet(tabId);
    // loadURL bypasses will-navigate — gate here (M6).
    const nav = decideNavigation(url, tab.partition);
    if (!nav.allow) throw new Error(`navigation denied: ${nav.reason}`);
    void tab.view.webContents.loadURL(url);
  }

  goBack(tabId: string): void {
    this.mustGet(tabId).view.webContents.navigationHistory.goBack();
  }

  goForward(tabId: string): void {
    this.mustGet(tabId).view.webContents.navigationHistory.goForward();
  }

  reload(tabId: string): void {
    this.mustGet(tabId).view.webContents.reload();
  }

  stop(tabId: string): void {
    this.mustGet(tabId).view.webContents.stop();
  }

  // ── Layout / visibility (driven by WP1-B's BrowserViewHost) ───────────────

  setActiveTab(tabId: string | null): void {
    if (tabId !== null && !this.tabs.has(tabId)) {
      // Slice-10/11: first activation of a frozen (restored/discarded) tab lazily
      // materializes its WebContentsView + navigates to the stored URL.
      if (this.frozenTabs.has(tabId)) this.hydrateFrozenTab(tabId);
      else throw new Error(`unknown tab: ${tabId}`);
    }
    this.activeTabId = tabId;
    const active = tabId === null ? null : this.tabs.get(tabId)!;
    if (active) {
      this.lastActiveAt.set(active.id, Date.now()); // idle-sweep / LRU recency
      const win = this.getMainWindow();
      // Re-adding an existing child raises it to the top of the view stack.
      win?.contentView.addChildView(active.view);
      active.view.setBounds(this.lastBounds);
      // Slice 15: restore this tab's find — re-run the stored query so its native
      // highlight + counter come back exactly where the FindBar left them. The
      // foundInPage event re-fires, refreshing the renderer's counter.
      this.restoreFind(active);
    }
    this.applyVisibility();
    this.emitTabsSnapshot(); // active changed
    this.schedulePersist();
  }

  setBounds(bounds: BrowserBounds): void {
    this.lastBounds = bounds;
    if (this.activeTabId !== null) {
      this.tabs.get(this.activeTabId)?.view.setBounds(bounds);
    }
  }

  /** Pane suspension: hide/show without losing the active tab. Renderer
   *  overlays (dialogs, menus) call setVisible(false) so they aren't painted
   *  over by the view. */
  setVisible(visible: boolean): void {
    this.paneVisible = visible;
    this.applyVisibility();
  }

  /** Per-workspace isolation: the human switched workspaces. Re-scope the tab
   *  strip (snapshot), view visibility, and subsequent new-tab stamping to the
   *  new workspace. A tab belonging to another workspace can never paint while
   *  this is set (applyVisibility gates on workspace match), so even a stale
   *  activeTabId from the previous workspace stays hidden. */
  setActiveWorkspace(workspaceId: string | null): void {
    if (workspaceId === this.currentWorkspaceId) return;
    this.currentWorkspaceId = workspaceId;
    this.applyVisibility();
    this.emitTabsSnapshot();
  }

  private applyVisibility(): void {
    for (const tab of this.tabs.values()) {
      tab.view.setVisible(
        this.paneVisible &&
          tab.id === this.activeTabId &&
          tab.workspaceId === this.currentWorkspaceId,
      );
    }
  }

  // ── M4 seam ────────────────────────────────────────────────────────────────

  isManaged(wc: WebContents): boolean {
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents === wc) return true;
    }
    return false;
  }

  // ── M9: debugger discipline (Phase 2 builds on this helper) ───────────────

  /**
   * Attach the CDP debugger to a tab. Throws unless the tab lives on
   * `persist:agent` (M9): persist:user carries the human's signed-in
   * sessions — automation there is never allowed. Also: never auto-open
   * DevTools on agent tabs (it detaches the debugger); no code path in this
   * manager calls openDevTools.
   */
  attachDebugger(tabId: string): Electron.Debugger {
    const tab = this.mustGet(tabId);
    // Website-allowlist §12-B/§14: the single source of truth for "may the agent
    // drive this tab" is isAgentDrivable — NOT mayAttachDebugger(partition). It
    // covers ordinary persist:agent tabs AND a handed persist:user tab whose
    // committed origin is still an allow_signed_in List-A rule (and refuses a
    // quarantined sign-in tab). This is the M9 relaxation, centralized.
    if (!this.isAgentDrivable(tab)) {
      throw new Error(
        `M9: debugger attach refused on tab ${tabId} (partition ${tab.partitionFull}; ` +
          `not an agent tab and not a handed allow_signed_in tab)`,
      );
    }
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg;
  }

  // ── Website-access policy: synchronously-readable cache + drive predicate ──
  // (plans/website-allowlist-design.md §5/§12/§14)

  /** Load (and memoize) the compiled agent allowlist rules FOR ONE WORKSPACE.
   *  SYNCHRONOUS — the will-navigate/will-redirect chokepoints cannot await.
   *  better-sqlite3 is fully synchronous, so this is a plain sync read on first
   *  access (per workspace) and on the next access after invalidateAccessCache().
   *  Only ENABLED rules that apply to `workspaceId` are compiled — Slice-4: a
   *  rule scoped to another workspace grants nothing here; a NULL-workspace
   *  (legacy default) rule applies to every workspace (see rowAppliesToWorkspace).
   *  A disabled rule grants nothing either way. */
  private getAccessCache(workspaceId: string | null | undefined): {
    agentRules: CompiledRule[];
  } {
    const key = workspaceId == null ? NULL_WS_CACHE_KEY : `ws:${workspaceId}`;
    let cached = this.accessCache.get(key);
    if (!cached) {
      const compile = (rule: AccessRule): CompiledRule => ({
        hostname: rule.hostname,
        includeSubdomains: rule.includeSubdomains,
        scheme: rule.scheme,
        pathPrefix: rule.pathPrefix,
        allowSignedIn: rule.allowSignedIn,
      });
      cached = {
        agentRules: listRules()
          .filter((r) => r.enabled && rowAppliesToWorkspace(r.workspaceId, workspaceId))
          .map(compile),
      };
      this.accessCache.set(key, cached);
    }
    return cached;
  }

  /** Agent allowlist context for checkAgentVisit / checkSignedInDrive, scoped to
   *  the tab's / request's workspace (Slice-4). */
  private agentCtx(workspaceId: string | null | undefined): { rules: CompiledRule[] } {
    return { rules: this.getAccessCache(workspaceId).agentRules };
  }

  /** Drop the memoized access cache (all workspaces); the next gate/chokepoint
   *  re-reads the DB. Called by every access mutation (rule add/update/remove,
   *  request decision) via the IPC layer (§6). */
  invalidateAccessCache(): void {
    this.accessCache.clear();
  }

  // ── Website-access policy: IPC pass-throughs (§6/§14/§18) ──────────────────
  // ORDER MATTERS (§6): every mutation invalidates the synchronously-readable
  // access cache FIRST, so the next gate/chokepoint re-reads the DB, THEN emits
  // accessChanged so the renderer refetches. Request decisions ALSO emit
  // accessRequestsChanged. These methods are reachable ONLY from trusted chrome
  // (browser-ipc.ts registers them); never from agent tools or page content.

  /** Slice-4: the trusted-chrome rule list is scoped to the human's SELECTED
   *  workspace — its own rules plus the legacy NULL-workspace defaults. So the
   *  "shared by every agent in this workspace" copy is true by construction, and
   *  another workspace's rules never appear in this workspace's settings. */
  accessRuleList(): AccessRule[] {
    return listRules().filter((r) => rowAppliesToWorkspace(r.workspaceId, this.currentWorkspaceId));
  }

  accessRuleAdd(input: AccessRuleInput): AccessRule {
    // Slice-4: a manual add is stamped with the human's selected workspace (the
    // renderer never sends workspaceId — trust-side scoping). An explicit
    // input.workspaceId (internal callers) still wins.
    const rule = insertRule({
      ...input,
      workspaceId: input.workspaceId !== undefined ? input.workspaceId : this.currentWorkspaceId,
    });
    this.invalidateAccessCache();
    this.emitAccessChanged();
    return rule;
  }

  accessRuleUpdate(
    id: string,
    patch: Partial<AccessRuleInput> & { enabled?: boolean },
  ): AccessRule {
    const rule = updateRule(id, patch);
    this.invalidateAccessCache();
    this.revokeNonDrivableHandedTabs();
    this.emitAccessChanged();
    return rule;
  }

  accessRuleRemove(id: string): void {
    // §14: deleting a List-A rule clears that rule's agent site session (cookies
    // + origin storage) before the row — and its tracked known-origins rows —
    // are gone, so clearAgentSiteData can still resolve the union of origins.
    const rule = getRule(id);
    if (rule) void this.clearAgentSiteData(rule, rule.workspaceId ?? null);
    deleteRule(id);
    this.invalidateAccessCache();
    this.revokeNonDrivableHandedTabs();
    this.emitAccessChanged();
  }

  /** Slice-4: scoped to the human's selected workspace (its requests + legacy
   *  NULL-workspace defaults), mirroring accessRuleList. */
  accessRequestList(): AccessRequest[] {
    return listRequests().filter((r) => rowAppliesToWorkspace(r.workspaceId, this.currentWorkspaceId));
  }

  accessRequestDecide(id: string, decision: AccessRequestDecision): void {
    // decideRequest creates the real rule (in a txn) on approve — so a new rule
    // can go live immediately: invalidate the cache + emit accessChanged, and
    // emit accessRequestsChanged so the requests list refreshes (§18.4).
    decideRequest(id, decision);
    this.invalidateAccessCache();
    this.emitAccessChanged();
    this.emitAccessRequestsChanged();
  }

  private emitAccessChanged(): void {
    this.send(BROWSER_CHANNELS.accessChanged, undefined);
  }

  private emitAccessRequestsChanged(): void {
    this.send(BROWSER_CHANNELS.accessRequestsChanged, undefined);
  }

  // ── Slice 12: armed-state agent-actions gate ───────────────────────────────

  /** Full runtime armed state (post-expiry). Reading also applies a lazy expiry
   *  flip in the policy module; we (re)sync the timer so the renderer is told. */
  getAgentActionsState(): AgentActionsState {
    const state = getAgentActionsState();
    this.scheduleActionsExpiry(state);
    return state;
  }

  /** Apply a popover command (Enable 15 min / until restart / Disable now),
   *  (re)arm the expiry timer, broadcast the new state, and echo it back. */
  setAgentActionsState(cmd: AgentActionsCommand): AgentActionsState {
    const state = setAgentActionsState(cmd);
    this.scheduleActionsExpiry(state);
    this.send(BROWSER_CHANNELS.actionsStateChanged, state);
    return state;
  }

  /** (Re)schedule the single auto-expiry timer. When a finite armed window is
   *  active, fire just after it elapses to push the disabled state to the
   *  renderer; otherwise clear any pending timer (disabled / until-restart). */
  private scheduleActionsExpiry(state: AgentActionsState): void {
    if (this.actionsExpiryTimer) {
      clearTimeout(this.actionsExpiryTimer);
      this.actionsExpiryTimer = null;
    }
    if (state.mode !== 'armed' || state.armedUntil === null) return;
    const delay = Math.max(0, state.armedUntil - Date.now()) + 50;
    this.actionsExpiryTimer = setTimeout(() => {
      this.actionsExpiryTimer = null;
      // Reading applies the lazy expiry flip; broadcast whatever it resolves to.
      this.send(BROWSER_CHANNELS.actionsStateChanged, getAgentActionsState());
    }, delay);
  }

  // ── Five trusted-chrome-only authenticated-drive IPCs (§12/§14) ────────────

  /** Mechanism A, §12-A step 1: open a VISIBLE, quarantined agent-partition
   *  login tab on the rule's origin. signinPending/signinRuleId are RUNTIME,
   *  NON-PERSISTED, and set ONLY here — every agent tool verb against the tab is
   *  refused (gate quarantine) until access-handoff-ready clears it. */
  accessHandoffSignin(ruleId: string): AccessHandoffResult {
    const rule = getRule(ruleId);
    if (!rule) {
      throw new Error(`access-handoff-signin: unknown rule ${ruleId}`);
    }
    if (!rule.allowSignedIn) {
      throw new Error(`access-handoff-signin: rule ${ruleId} is not allow_signed_in`);
    }
    const scheme = rule.scheme === 'any' ? 'https' : rule.scheme;
    const url = `${scheme}://${rule.hostname}${rule.pathPrefix ?? ''}`;
    // Slice-4: open the quarantined sign-in tab in the RULE's workspace, so the
    // credentials the human enters land in that workspace's agent session
    // (persist:agent:<workspaceId>) — the same session clearAgentSiteData clears.
    const { tabId } = this.createTab({ partition: 'agent', url, workspaceId: rule.workspaceId ?? null });
    const tab = this.mustGet(tabId);
    tab.signinPending = true;
    tab.signinRuleId = ruleId;
    this.setActiveTab(tabId);
    this.sendTabState(tab);
    return { tabId };
  }

  /** Mechanism A, §12-A step 4: the human finished signing in. Revalidate the
   *  committed URL against checkSignedInDrive (refuse if it drifted off the
   *  allow_signed_in origin), clear the quarantine, and upsert the committed
   *  origin into browser_access_signed_in_origins (§13) so revocation can later
   *  clear it. */
  accessHandoffReady(tabId: string): void {
    const tab = this.mustGet(tabId);
    if (!tab.signinPending) return; // not quarantined — nothing to release
    const wc = tab.view.webContents;
    const url = wc.isDestroyed() ? '' : wc.getURL();
    if (!checkSignedInDrive(url, this.agentCtx(tab.workspaceId)).allow) {
      throw new Error(
        `access-handoff-ready: tab ${tabId} committed URL is not an allow_signed_in origin`,
      );
    }
    if (tab.signinRuleId) {
      try {
        // Slice 12: stamp the session age — a successful hand-off-ready commit is
        // both the most-recent sign-in AND a verification of the live session.
        const now = Date.now();
        upsertSignedInOrigin(tab.signinRuleId, new URL(url).origin, tab.workspaceId, {
          signedInAt: now,
          verifiedAt: now,
        });
      } catch {
        /* unparseable — already guarded by checkSignedInDrive, defensive only */
      }
    }
    tab.signinPending = false;
    tab.signinRuleId = undefined;
    this.sendTabState(tab);
    // Slice 12: the session center's list just changed (a new/refreshed origin).
    this.send(BROWSER_CHANNELS.accessChanged, undefined);
  }

  /** Mechanism B, §12-B: hand the human's live signed-in tab to the agent.
   *  Refuses unless the tab's COMMITTED origin is an allow_signed_in List-A rule
   *  (re-checked on every attach via isAgentDrivable). handedToAgent is RUNTIME,
   *  NON-PERSISTED, set ONLY here. */
  accessTabHandToAgent(tabId: string): void {
    const tab = this.mustGet(tabId);
    const wc = tab.view.webContents;
    const url = wc.isDestroyed() ? '' : wc.getURL();
    if (!checkSignedInDrive(url, this.agentCtx(tab.workspaceId)).allow) {
      throw new Error(
        `tab-hand-to-agent: tab ${tabId} is not on an allow_signed_in origin`,
      );
    }
    tab.handedToAgent = true;
    this.sendTabState(tab);
  }

  /** Mechanism B revoke (§12-B): detach the driver and clear handedToAgent. */
  accessTabReturnToHuman(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.detachAndClearHanded(tab);
  }

  /** Per-row "Clear agent session" (§14): clear the agent-partition site data
   *  for a rule's origins without deleting the rule. */
  async accessClearSiteSession(ruleId: string): Promise<void> {
    const rule = getRule(ruleId);
    if (rule) await this.clearAgentSiteData(rule, rule.workspaceId ?? null);
    // Slice 12: clearing a session drops it from the "Sessions shared with
    // agents" center — refresh the trusted chrome.
    this.send(BROWSER_CHANNELS.accessChanged, undefined);
  }

  /** Slice 12 (handoff/session center): the "Sessions shared with agents"
   *  snapshot for the active workspace — the live handed tabs (Mechanism B, still
   *  drivable) plus the persisted signed-in agent origins (Mechanism A, with
   *  session-age + stale flags). Trusted-chrome only; never reaches an agent. */
  getSharedSessions(): SharedAgentSessions {
    const ws = this.currentWorkspaceId;
    const handedTabs: HandedTabInfo[] = [];
    for (const tab of this.tabs.values()) {
      if (!tab.handedToAgent) continue;
      if ((tab.workspaceId ?? null) !== (ws ?? null)) continue;
      const wc = tab.view.webContents;
      handedTabs.push({
        tabId: tab.id,
        url: wc.isDestroyed() ? '' : wc.getURL(),
        title: wc.isDestroyed() ? '' : wc.getTitle(),
        workspaceId: tab.workspaceId ?? null,
      });
    }
    return { handedTabs, signedInOrigins: listSharedSignedInOrigins(ws ?? null) };
  }

  /** §14 — REQUIRED revocation breadth. Clear agent-partition site data for the
   *  resolved origin set: for an AccessRule, the union of its tracked
   *  signed-in origins PLUS the pattern-derived origins (https→https://host;
   *  http→http://host; any→BOTH). Origin storage is cleared per-origin;
   *  cookies are cleared separately because Electron scopes cookies by domain,
   *  not origin. Named "clear agent site session/data," not "cookies." */
  private async clearAgentSiteData(
    target: AccessRule | { url: string },
    workspaceId: string | null | undefined,
  ): Promise<void> {
    // Slice-4: clear ONLY the target workspace's agent session
    // (persist:agent:<workspaceId>). Clearing the global partition would either
    // wipe nothing (agent data now lives per-workspace) or, pre-fix, wipe every
    // workspace's data — both wrong. A rule's workspace is the one whose handed-
    // off credentials it governs.
    const ses = session.fromPartition(agentPartitionForWorkspace(workspaceId));
    const origins = new Set<string>();
    let hostname: string | undefined;

    if ('url' in target) {
      try {
        const u = new URL(target.url);
        origins.add(u.origin);
        hostname = u.hostname;
      } catch {
        return; // unparseable — nothing to clear
      }
    } else {
      hostname = target.hostname;
      for (const o of listSignedInOrigins(target.id)) origins.add(o);
      if (target.scheme === 'https' || target.scheme === 'any') {
        origins.add(`https://${target.hostname}`);
      }
      if (target.scheme === 'http' || target.scheme === 'any') {
        origins.add(`http://${target.hostname}`);
      }
    }

    // Origin-scoped storage (localStorage/IndexedDB/cache/service-workers).
    for (const origin of origins) {
      try {
        await ses.clearStorageData({
          origin,
          storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
        });
      } catch (err) {
        console.warn(`[browser] clearAgentSiteData storage clear failed for ${origin}:`, err);
      }
    }

    // Cookies are domain-scoped in Electron — enumerate by domain and remove
    // each by a URL reconstructed from the cookie's own fields.
    if (hostname) {
      try {
        const cookies = await ses.cookies.get({ domain: hostname });
        for (const cookie of cookies) {
          const cookieDomain = cookie.domain?.replace(/^\./, '') ?? hostname;
          const removalUrl = `${cookie.secure ? 'https' : 'http'}://${cookieDomain}${cookie.path ?? '/'}`;
          try {
            await ses.cookies.remove(removalUrl, cookie.name);
          } catch (err) {
            console.warn(`[browser] clearAgentSiteData cookie remove failed (${cookie.name}):`, err);
          }
        }
      } catch (err) {
        console.warn(`[browser] clearAgentSiteData cookie enumerate failed for ${hostname}:`, err);
      }
    }
  }

  /**
   * §12-B/§14 — the SINGLE SOURCE OF TRUTH for "may the agent driver attach to
   * and drive this tab." Routed through attachDebugger, driver(), and gate().
   *  - a quarantined sign-in tab (§12-A) is NEVER drivable (the human is typing
   *    credentials), even though it lives on persist:agent;
   *  - an ordinary persist:agent tab is always drivable (M9 baseline);
   *  - a handed persist:user tab (Mechanism B) is drivable ONLY while its
   *    committed origin is still an allow_signed_in List-A rule (re-checked on
   *    EVERY call, so a rule delete / toggle-OFF / off-origin nav fails instantly).
   *  Un-handed persist:user tabs are never drivable — M9 intact for them.
   */
  private isAgentDrivable(tab: TabEntry): boolean {
    if (tab.signinPending) return false;
    if (tab.partition === 'agent') return true;
    if (!tab.handedToAgent) return false;
    const url = tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL();
    return checkSignedInDrive(url, this.agentCtx(tab.workspaceId)).allow;
  }

  /** Outcome tag for a successful verb: 'ok:authenticated' when the committed
   *  origin is an allow_signed_in List-A rule (§14 — authenticated access is
   *  logged), else 'ok'. */
  private authedOutcome(
    url: string | undefined,
    workspaceId: string | null | undefined,
  ): 'ok' | 'ok:authenticated' {
    return typeof url === 'string' &&
      /^https?:/i.test(url) &&
      checkSignedInDrive(url, this.agentCtx(workspaceId)).allow
      ? 'ok:authenticated'
      : 'ok';
  }

  /** §14: log a read-tier success ONLY when the origin is authenticated
   *  (allow_signed_in). Non-authenticated reads keep current behavior (no
   *  blanket read auditing). */
  private auditAuthedRead(tab: TabEntry, verb: string, args: unknown): void {
    const url = tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL();
    if (this.authedOutcome(url, tab.workspaceId) === 'ok:authenticated') {
      this.auditRecord(tab.partitionFull, url, verb, args, 'ok:authenticated', { tab });
    }
  }

  /** §12-B Mechanism-B auto-revoke: the instant a handed tab navigates OFF an
   *  allow_signed_in origin, detach the driver and clear handedToAgent. Defense
   *  in depth atop the §5 existing-tab gate. No-op for un-handed tabs and for a
   *  target that is still an allow_signed_in origin. */
  private autoRevokeIfOffOrigin(tab: TabEntry, url: string): void {
    if (!tab.handedToAgent) return;
    if (checkSignedInDrive(url, this.agentCtx(tab.workspaceId)).allow) return;
    this.detachAndClearHanded(tab);
    console.warn(`[browser] Mechanism-B auto-revoke (tab ${tab.id}): navigated off allow_signed_in origin`);
    // Slice 12: surface the auto-revoke as a small trusted notification — the
    // human handed this tab over and it just lost its driver out from under them.
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      /* unparseable target — leave hostname empty */
    }
    this.send(BROWSER_CHANNELS.agentDrivingRevoked, { tabId: tab.id, url: url ?? '', hostname });
  }

  /** §12-B revocation (F3): after an access-rule mutation, drop the handoff on
   *  every handed tab that is no longer drivable (rule deleted/disabled/edited
   *  or allowSignedIn toggled off). Must run AFTER invalidateAccessCache() so
   *  isAgentDrivable re-reads fresh rules. Defense in depth atop the per-verb
   *  gate. */
  private revokeNonDrivableHandedTabs(): void {
    for (const tab of this.tabs.values()) {
      if (tab.handedToAgent && !this.isAgentDrivable(tab)) this.detachAndClearHanded(tab);
    }
  }

  /** Detach the CDP driver from a tab and clear the Mechanism-B handed flag.
   *  Idempotent; pushes fresh tab state so the "Agent driving" badge clears. */
  private detachAndClearHanded(tab: TabEntry): void {
    tab.handedToAgent = false;
    this.drivers.delete(tab.id);
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) {
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        /* already detached / destroyed */
      }
    }
    this.sendTabState(tab);
  }

  // ── WP2-A: CDP driver accessor + agent tool facade ─────────────────────────
  //
  // Implements the frozen BrowserToolProvider contract (WP2-B injects
  // `browserManager.tools` into ApiServer). Every entry point: M16 kill-switch
  // → M11 checkNavigation (URL-bearing verbs) → M9/M10/M12 checkAction; every
  // act-tier call and every denial writes an audit line (M16). All page-derived
  // returns pass through wrapUntrusted (M12).

  /** Lazily create/reuse the CDP driver for an agent tab. M9: construction
   *  and every re-attach route through attachDebugger, which throws on
   *  persist:user — there is no other path to CDP. */
  private driver(tabId: string): CdpDriver {
    const tab = this.mustGet(tabId);
    let drv = this.drivers.get(tabId);
    if (!drv) {
      this.attachDebugger(tabId); // probe the M9 rule now, not on first command
      drv = new CdpDriver(tab.view.webContents, () => this.attachDebugger(tabId));
      this.drivers.set(tabId, drv);
    }
    return drv;
  }

  get tools(): BrowserToolProvider {
    if (!this.toolsFacade) {
      this.toolsFacade = {
        openUrl: (url, opts) => this.toolOpenUrl(url, opts ?? {}),
        // (opts carries workspaceId + agent id/title resolved by the API layer
        //  from the agent — never the agent's own tool args.)
        listTabs: () => this.toolListTabs(),
        getPageText: (tabId) => this.toolGetPageText(tabId),
        readPage: (tabId) => this.toolReadPage(tabId),
        screenshot: (tabId) => this.toolScreenshot(tabId),
        click: (tabId, ref) => this.toolClick(tabId, ref),
        type: (tabId, ref, text) => this.toolType(tabId, ref, text),
        pressKey: (tabId, key) => this.toolPressKey(tabId, key),
        selectOption: (tabId, ref, value) => this.toolSelectOption(tabId, ref, value),
        scroll: (tabId, opts) => this.toolScroll(tabId, opts),
        goBack: (tabId) => this.toolGoBack(tabId),
        goForward: (tabId) => this.toolGoForward(tabId),
        reload: (tabId) => this.toolReload(tabId),
        waitFor: (tabId, input) => this.toolWaitFor(tabId, input),
        closeTab: (tabId) => this.toolCloseTab(tabId),
        requestSiteAccess: (input) => this.toolRequestSiteAccess(input),
        listMyAccessRequests: (agentId) => listRequestsByAgent(agentId),
      };
    }
    return this.toolsFacade;
  }

  /** §18.3 — insert an inert agent access request. Normalization, same-origin
   *  dedup, and the per-agent pending cap live in the store (insertRequest); it
   *  throws on '*'/unparseable hostnames or 'too-many-pending'. Emits
   *  accessRequestsChanged so the approval UI refreshes. Grants ZERO access. */
  private toolRequestSiteAccess(
    input: AccessRequestInput & {
      requestedBy: string;
      requestedByTitle?: string;
      workspaceId?: string | null;
    },
  ): { requestId: string; status: AccessRequest['status'] } {
    const request = insertRequest({
      hostname: input.hostname,
      scheme: input.scheme,
      includeSubdomains: input.includeSubdomains,
      pathPrefix: input.pathPrefix,
      reason: input.reason,
      wantSignedIn: input.wantSignedIn,
      requestedBy: input.requestedBy,
      requestedByTitle: input.requestedByTitle,
      // Slice-4: stamp the requesting agent's workspace (trust-side, from the API
      // layer) so the rule created on approval is scoped to that workspace.
      workspaceId: input.workspaceId ?? null,
    });
    this.emitAccessRequestsChanged();
    return { requestId: request.id, status: request.status };
  }

  private get audit(): ActionAudit {
    if (!this.auditWriter) {
      this.auditWriter = new ActionAudit(
        () => path.join(app.getPath('userData'), AUDIT_FILE_NAME),
        // Slice-3: forward every recorded entry to the renderer's Activity drawer
        // + denial toasts on the auditEvent push channel.
        (entry) => this.forwardAudit(entry),
      );
    }
    return this.auditWriter;
  }

  /**
   * Slice-3: record an audit entry, enriching it with workspace/tab/agent
   * identity where available. `ctx.tab` supplies tabId + (as a fallback)
   * workspaceId + the Slice-2 openedByAgentId/Title; explicit ctx fields win
   * (the openUrl path knows its agent/workspace before a tab exists). Every
   * existing 5-arg call site keeps working — ctx is optional and additive.
   */
  private auditRecord(
    partition: string,
    url: string,
    verb: string,
    args: unknown,
    outcome: string,
    ctx?: { tab?: TabEntry; workspaceId?: string | null; agentId?: string; agentTitle?: string },
  ): void {
    const tab = ctx?.tab;
    const workspaceId = ctx?.workspaceId ?? tab?.workspaceId ?? undefined;
    const agentId = ctx?.agentId ?? tab?.openedByAgentId;
    const agentTitle = ctx?.agentTitle ?? tab?.openedByAgentTitle;
    this.audit.record({
      partition,
      url,
      verb,
      argsHash: hashArgs(args),
      outcome,
      ...(tab ? { tabId: tab.id } : {}),
      ...(workspaceId != null ? { workspaceId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentTitle ? { agentTitle } : {}),
    });

    // Slice 12: every authenticated agent drive (read OR act — both funnel
    // through here with the 'ok:authenticated' outcome) refreshes the origin's
    // last_used_at so the session center can show "last used Nh ago". Best-effort
    // and display-only — never gates access. Guarded against an unparseable URL.
    if (outcome === 'ok:authenticated' && typeof url === 'string' && url) {
      try {
        touchSignedInOrigin(new URL(url).origin, workspaceId ?? null, Date.now());
      } catch {
        /* unparseable URL — nothing to touch */
      }
    }
  }

  /** Slice-3: map a durable AuditEntry → the renderer-facing BrowserAuditEntry
   *  (drops argsHash; argsHash never crosses to the renderer). */
  private toBrowserAuditEntry(entry: AuditEntry): BrowserAuditEntry {
    return {
      ts: entry.ts,
      verb: entry.verb,
      partition: entry.partition,
      url: entry.url,
      outcome: entry.outcome,
      ...(entry.workspaceId !== undefined ? { workspaceId: entry.workspaceId } : {}),
      ...(entry.tabId !== undefined ? { tabId: entry.tabId } : {}),
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
      ...(entry.agentTitle !== undefined ? { agentTitle: entry.agentTitle } : {}),
    };
  }

  /** Slice-3: forward a fresh audit record to the renderer (guarded send). */
  private forwardAudit(entry: AuditEntry): void {
    this.send(BROWSER_CHANNELS.auditEvent, this.toBrowserAuditEntry(entry));
  }

  /** Slice-3: tail of the action-audit feed for the Activity drawer's first
   *  paint (invoke channel auditRecent). Trusted-chrome only. */
  getRecentAudit(limit = 200): BrowserAuditEntry[] {
    return this.audit.getRecent(limit).map((e) => this.toBrowserAuditEntry(e));
  }

  // ── Slice 13: user-only downloads ───────────────────────────────────────────

  /** App-managed downloads directory (created on demand). Every accepted
   *  download is confined here; nothing is ever written to the OS default
   *  Downloads folder. */
  private downloadsDir(): string {
    const dir = path.join(app.getPath('userData'), 'browser-downloads');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** new URL(url).origin or '' (matches BrowserDownload.origin's contract). */
  private safeOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  /** Resolve the owning pane for a webContents the session handed us. */
  private tabForWebContents(wc: WebContents | null | undefined): TabEntry | undefined {
    if (!wc) return undefined;
    for (const tab of this.tabs.values()) {
      const tw = tab.view.webContents;
      if (tw === wc) return tab;
      try {
        if (!tw.isDestroyed() && tw.id === wc.id) return tab;
      } catch {
        /* destroyed mid-iteration — skip */
      }
    }
    return undefined;
  }

  /**
   * The download decision gate (Slice 13), separated as a PURE-ish predicate so
   * it is unit-testable through the manager fakes without a real DownloadItem:
   *   - agent partition: allowed ONLY from an allowlisted, non-sensitive origin
   *     (M12 sensitive-origin discipline still applies — a sign-in/payment page
   *     download is denied even if the origin is allowlisted). Otherwise DENY.
   *   - user partition: never auto-allowed → 'confirm' (trusted-chrome gate).
   */
  private decideDownload(
    partition: BrowserPartition,
    url: string,
    workspaceId: string | null | undefined,
  ): { action: 'allow' | 'confirm' | 'deny'; code?: string } {
    if (partition === 'agent') {
      if (isSensitiveOrigin(url)) return { action: 'deny', code: 'sensitive-origin-denied' };
      const visit = checkAgentVisit(url, this.agentCtx(workspaceId));
      return visit.allow ? { action: 'allow' } : { action: 'deny', code: visit.code };
    }
    return { action: 'confirm' };
  }

  /** Pick a non-colliding basename inside `dir` (append " (n)" before the ext).
   *  The input is already normalized; this only avoids clobbering an existing
   *  file. Bounded scan — falls back to a uuid-suffixed name if exhausted. */
  private uniqueDownloadName(dir: string, filename: string): string {
    if (!existsSync(path.join(dir, filename))) return filename;
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!existsSync(path.join(dir, candidate))) return candidate;
    }
    return `${stem}-${randomUUID()}${ext}`;
  }

  /** Session-level will-download handler (wired once per partition in
   *  hardenSession). Resolves the originating tab, runs the decision gate, and
   *  either confines+records the accept, emits a confirm prompt (user), or
   *  prevents+audits the deny (NO db record on a deny). */
  private handleWillDownload(
    event: ElectronEvent,
    item: DownloadItem,
    webContents: WebContents | null | undefined,
  ): void {
    const url = item.getURL();
    const origin = this.safeOrigin(url);

    // Re-initiated, human-approved USER download (downloadConfirm) → allow once.
    const approved = this.approvedDownloadUrls.get(url);
    if (approved) {
      this.approvedDownloadUrls.delete(url);
      this.beginDownload(item, {
        url,
        origin,
        partition: 'user',
        partitionFull: 'persist:user',
        workspaceId: approved.workspaceId,
      });
      return;
    }

    const tab = this.tabForWebContents(webContents);
    if (!tab) {
      // No owning pane and not a pre-approved re-init → deny (defense in depth).
      event.preventDefault();
      this.auditRecord('unknown', url, 'download', { url }, 'denied:unknown-source');
      return;
    }

    const decision = this.decideDownload(tab.partition, url, tab.workspaceId);

    if (decision.action === 'deny') {
      // DENY → preventDefault + audit ONLY. No db record is ever created.
      event.preventDefault();
      this.auditRecord(tab.partitionFull, url, 'download', { url }, `denied:${decision.code}`, { tab });
      return;
    }

    if (decision.action === 'confirm') {
      // USER download: cancel this attempt and surface a trusted-chrome confirm.
      event.preventDefault();
      const id = randomUUID();
      const filename = normalizeDownloadFilename(item.getFilename());
      this.pendingDownloadConfirms.set(id, {
        url,
        filename,
        origin,
        workspaceId: tab.workspaceId ?? null,
        sessionPartition: tab.sessionPartition ?? 'persist:user',
      });
      this.auditRecord(tab.partitionFull, url, 'download', { url }, 'pending:user-confirm', { tab });
      const prompt: BrowserDownloadPrompt = {
        id,
        url,
        filename,
        origin,
        workspaceId: tab.workspaceId ?? null,
      };
      this.send(BROWSER_CHANNELS.downloadPrompt, prompt);
      return;
    }

    // ALLOW (agent, allowlisted non-sensitive origin).
    this.beginDownload(
      item,
      {
        url,
        origin,
        partition: tab.partition,
        partitionFull: tab.partitionFull,
        workspaceId: tab.workspaceId ?? null,
      },
      tab,
    );
  }

  /** Confine an accepted download to the app dir, record it, wire its lifecycle
   *  to the store + renderer events. Shared by the agent-allow and user-confirm
   *  paths. */
  private beginDownload(
    item: DownloadItem,
    meta: {
      url: string;
      origin: string;
      partition: BrowserPartition;
      partitionFull: string;
      workspaceId: string | null;
    },
    tab?: TabEntry,
  ): void {
    const dir = this.downloadsDir();
    const filename = this.uniqueDownloadName(dir, normalizeDownloadFilename(item.getFilename()));
    const savePath = path.join(dir, filename);
    // Belt-and-braces atop normalizeDownloadFilename — a save path must never
    // escape the app-managed dir.
    if (!isPathWithinDir(savePath, dir)) {
      item.cancel();
      this.auditRecord(meta.partitionFull, meta.url, 'download', { url: meta.url }, 'denied:path-traversal', { tab });
      return;
    }
    item.setSavePath(savePath);

    const id = randomUUID();
    const rec = insertDownload({
      id,
      url: meta.url,
      filename,
      savePath,
      partition: meta.partition,
      workspaceId: meta.workspaceId,
      origin: meta.origin,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    });
    this.auditRecord(meta.partitionFull, meta.url, 'download', { url: meta.url, filename }, 'ok:download', { tab });
    this.send(BROWSER_CHANNELS.downloadStarted, rec);

    item.on('updated', () => {
      const updated = updateDownloadProgress(id, item.getReceivedBytes(), item.getTotalBytes());
      if (updated) this.send(BROWSER_CHANNELS.downloadProgress, updated);
    });
    item.once('done', (_e, state) => {
      const finalState: BrowserDownloadState =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';
      const done = setDownloadState(id, finalState, Date.now());
      if (done) {
        this.send(
          finalState === 'completed' ? BROWSER_CHANNELS.downloadDone : BROWSER_CHANNELS.downloadFailed,
          done,
        );
      }
    });
  }

  /** Trusted-chrome confirm of a pending USER download (downloadConfirm token).
   *  Re-initiates the download on its session; the re-fired will-download is
   *  allowed through via approvedDownloadUrls. No-op on an unknown/expired token. */
  confirmDownload(id: string): void {
    const pending = this.pendingDownloadConfirms.get(id);
    if (!pending) return;
    this.pendingDownloadConfirms.delete(id);
    this.approvedDownloadUrls.set(pending.url, { workspaceId: pending.workspaceId });
    this.auditRecord('persist:user', pending.url, 'download', { url: pending.url }, 'ok:user-confirmed');
    try {
      session.fromPartition(pending.sessionPartition).downloadURL(pending.url);
    } catch (err) {
      this.approvedDownloadUrls.delete(pending.url);
      console.warn(`[browser] downloadConfirm re-initiate failed: ${String(err)}`);
    }
  }

  /** Shelf first-paint list (newest first). Trusted-chrome only. */
  listDownloads(): BrowserDownload[] {
    return listDownloads();
  }

  /** Open a completed download via the OS. Returns false if the record is
   *  unknown or the OS reported an error. Trusted-chrome only. */
  async openDownloadFile(id: string): Promise<boolean> {
    const rec = getDownload(id);
    if (!rec) return false;
    const err = await shell.openPath(rec.savePath);
    return err === '';
  }

  /** Reveal a download in the OS file manager. Trusted-chrome only. */
  showDownloadInFolder(id: string): void {
    const rec = getDownload(id);
    if (rec) shell.showItemInFolder(rec.savePath);
  }

  /** Re-initiate a failed/cancelled download — re-runs the decision gate by
   *  re-firing will-download on the original session. Trusted-chrome only. */
  retryDownload(id: string): void {
    const rec = getDownload(id);
    if (!rec) return;
    const sessionPartition = partitionFor(rec.partition, rec.workspaceId);
    try {
      session.fromPartition(sessionPartition).downloadURL(rec.url);
    } catch (err) {
      console.warn(`[browser] downloadRetry failed: ${String(err)}`);
    }
  }

  /** Remove a download record from the shelf (does NOT delete the saved file).
   *  Trusted-chrome only. */
  removeDownloadRecord(id: string): void {
    removeDownload(id);
  }

  /** Kill-switch + checkAction gate shared by every tool verb. Denials are
   *  audited (M16) and thrown as PolicyError (WP2-B maps name → 403). */
  private gate(
    verb: BrowserToolVerb,
    partitionFull: string,
    url: string | undefined,
    args: unknown,
    tab?: TabEntry,
  ): void {
    if (!browserToolsEnabled(process.env)) {
      this.auditRecord(partitionFull, url ?? '', verb, args, 'denied:tools-disabled', { tab });
      throw new PolicyError(
        'tools-disabled',
        'browser tools are disabled by the kill-switch (AGENT_BROWSER_TOOLS_DISABLED=1)',
      );
    }

    // §12-A sign-in quarantine: while signinPending, EVERY agent-tool verb is
    // denied against the tab — no read/act/CDP path can touch the human's
    // in-progress credential entry. Only trusted-chrome closeTab (the manager
    // method, not tool-gated) may remove it.
    if (tab?.signinPending) {
      this.auditRecord(partitionFull, url ?? '', verb, args, 'denied:signin-pending', { tab });
      throw new PolicyError(
        'signin-pending',
        `tab ${tab.id} is in the sign-in quarantine — agent tools are denied until the human hands it over.`,
      );
    }

    // §12-B Mechanism B: a handed persist:user tab whose origin is still
    // allow_signed_in is agent-drivable, so checkAction must see the EFFECTIVE
    // (agent) partition rather than 'persist:user' (which would deny). For a
    // handed tab that wandered off-origin, isAgentDrivable is false → the
    // literal persist:user partition flows through → user-partition-denied
    // (defense in depth atop the off-origin auto-revoke).
    const effectivePartition = tab && this.isAgentDrivable(tab) ? 'persist:agent' : partitionFull;
    const decision = checkAction(verb, effectivePartition, url, getRuntimeActionsEnabled());
    if (!decision.allow) {
      this.auditRecord(partitionFull, url ?? '', verb, args, `denied:${decision.code}`, { tab });
      throw new PolicyError(decision.code, decision.reason);
    }

    // §5 existing-tab allowlist gate (the SECOND allowlist gate). Re-check the
    // tab's COMMITTED url against the agent allowlist so a tab stranded on a
    // now-disallowed origin (rule removed/toggled, pre-policy tab, missed nav)
    // can be neither read nor driven. Enforcement is keyed to the Agent Actions
    // toggle: only enforce when actions are ON (OFF ⇒ the agent can't act in its
    // partition at all, and reads on an already-open agent tab aren't gated by
    // the allowlist). Agent-partition tabs only — handed persist:user tabs are
    // gated by checkSignedInDrive via isAgentDrivable above. Escape/cleanup
    // verbs (closeTab/goBack/goForward) are exempt so the agent can always
    // recover; a non-http(s) / empty committed URL (about:blank, brand-new tab)
    // is exempt — the next real nav re-enters the navigation gate.
    if (
      tab &&
      tab.partition === 'agent' &&
      getRuntimeActionsEnabled() &&
      typeof url === 'string' &&
      /^https?:/i.test(url) &&
      !EXPOSURE_REDUCING_VERBS.has(verb)
    ) {
      const visit = checkAgentVisit(url, this.agentCtx(tab.workspaceId));
      if (!visit.allow) {
        this.auditRecord(partitionFull, url, verb, args, `denied:${visit.code}`, { tab });
        throw new PolicyError(visit.code, visit.reason);
      }
    }
  }

  private async toolOpenUrl(
    url: string,
    opts: {
      forHuman?: boolean;
      workspaceId?: string | null;
      agentId?: string;
      agentTitle?: string;
    },
  ): Promise<TabSnapshot> {
    const forHuman = opts.forHuman === true;
    // Slice-2: trusted agent identity threaded from the API layer → stamped on
    // the created tab for the "Opened by <title>" tooltip + attention attribution.
    const agentIdentity = {
      openedByAgent: true,
      openedByAgentId: opts.agentId,
      openedByAgentTitle: opts.agentTitle,
    };
    // Per-workspace isolation: stamp the agent's workspace (resolved by the API
    // layer from the calling agent) so the tab lands in the right workspace's
    // strip rather than leaking into whichever workspace the human is viewing.
    // Falls back to the current workspace when the caller didn't resolve one.
    const workspaceId = opts.workspaceId ?? this.currentWorkspaceId;
    const verb: BrowserToolVerb = forHuman ? 'openUrlForHuman' : 'openUrl';
    const partitionFull = forHuman ? 'persist:user' : 'persist:agent';
    const args = { url, forHuman };
    // Slice-3: no tab exists yet on the open path, so carry the resolved
    // workspace/agent identity explicitly into pre-creation audit records.
    const openCtx = { workspaceId, agentId: opts.agentId, agentTitle: opts.agentTitle };

    // M11 applies to EVERY navigation, forHuman handoffs included.
    const nav = checkNavigation(url, { apiPort: this.controlPorts.apiPort });
    if (!nav.allow) {
      this.auditRecord(partitionFull, url, verb, args, `denied:${nav.code}`, openCtx);
      throw new PolicyError(nav.code, nav.reason);
    }
    this.gate(verb, partitionFull, url, args);

    // Website-allowlist §2/§5: agent-partition browse is allowlist-gated (a clean
    // 403 instead of a silent nav-prevent). The forHuman open is OUTSIDE the
    // allowlist entirely (§2: scheme/SSRF floor only, already applied above) —
    // it is never gated by the allowlist or the Agent Actions toggle. Reaching
    // the agent branch here implies actions are ON (gate() denied otherwise via
    // checkAction), so the allowlist is enforced: deny-by-default.
    if (!forHuman) {
      const av = checkAgentVisit(url, this.agentCtx(workspaceId));
      if (!av.allow) {
        this.auditRecord(partitionFull, url, verb, args, `denied:${av.code}`, openCtx);
        throw new PolicyError(av.code, av.reason);
      }
    }

    if (forHuman) {
      // M9 openUrlForHumanAction: a visible persist:user tab, focused in the
      // pane, URL rendered by the WP1-B address bar (shell chrome — model
      // output can't spoof it). NEVER attaches CDP; returns no page content.
      const { tabId } = this.createTab({ partition: 'user', url, workspaceId }, agentIdentity);
      this.setActiveTab(tabId);
      this.auditRecord(partitionFull, url, verb, args, 'ok', { tab: this.tabs.get(tabId), ...openCtx });
      return { tabId, url, partition: 'user' };
    }

    // Agent-partition browse (only reachable with the M12 toggle on): the tab
    // is created empty and navigated through the driver so the page-ready
    // wait lives here, not in the proxy scripts.
    const { tabId } = this.createTab({ partition: 'agent', workspaceId }, agentIdentity);
    try {
      await this.driver(tabId).navigateAndWait(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(partitionFull, url, verb, args, `error:${msg}`, { tab: this.tabs.get(tabId), ...openCtx });
      throw err;
    }
    this.auditRecord(partitionFull, url, verb, args, 'ok', { tab: this.tabs.get(tabId), ...openCtx });
    const snapshot = await this.snapshotTab(tabId);
    return {
      tabId,
      url: this.mustGet(tabId).view.webContents.getURL(),
      partition: 'agent',
      pageSnapshot: wrapUntrusted(snapshot),
    };
  }

  /** M9: lists persist:agent tabs (plus Mechanism-B handed user tabs, §17) —
   *  the human's own tabs (URLs, titles) are never enumerable by tools. A
   *  signinPending agent tab is OMITTED while quarantined (§12-A): its URL is
   *  the origin the human is signing into and must stay invisible to the agent. */
  private toolListTabs(): TabInfo[] {
    this.gate('listTabs', 'persist:agent', undefined, {});
    return [...this.tabs.values()]
      .filter((t) => this.isAgentDrivable(t))
      .map((t) => ({
        tabId: t.id,
        url: t.view.webContents.getURL(),
        title: t.view.webContents.getTitle(),
        partition: t.partition,
        openedByAgent: t.openedByAgent,
      }));
  }

  private async toolGetPageText(tabId: string): Promise<string> {
    const tab = this.mustGet(tabId);
    this.gate('getPageText', tab.partitionFull, tab.view.webContents.getURL(), { tabId }, tab);
    const text = await this.driver(tabId).getText();
    this.auditAuthedRead(tab, 'getPageText', { tabId });
    return wrapUntrusted(text);
  }

  private async toolReadPage(tabId: string): Promise<string> {
    const tab = this.mustGet(tabId);
    this.gate('readPage', tab.partitionFull, tab.view.webContents.getURL(), { tabId }, tab);
    const snapshot = await this.snapshotTab(tabId);
    this.auditAuthedRead(tab, 'readPage', { tabId });
    return (
      'Accessibility snapshot. Interactable elements are marked [n] — pass n as `ref` to click.\n' +
      wrapUntrusted(snapshot)
    );
  }

  private async toolScreenshot(tabId: string): Promise<{ base64Png: string }> {
    const tab = this.mustGet(tabId);
    this.gate('screenshot', tab.partitionFull, tab.view.webContents.getURL(), { tabId }, tab);
    const result = { base64Png: await this.driver(tabId).captureScreenshot() };
    this.auditAuthedRead(tab, 'screenshot', { tabId });
    return result;
  }

  private async toolClick(tabId: string, ref: number): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId, ref };
    this.gate('click', tab.partitionFull, url, args, tab);

    const registry = this.refRegistries.get(tabId);
    if (!registry) {
      throw new Error('no snapshot exists for this tab — call readPage first to get refs');
    }
    const backendNodeId = registry.resolve(ref); // StaleRefError / UnknownRefError
    try {
      await this.driver(tabId).click(backendNodeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'click', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'click', args, this.authedOutcome(url, tab.workspaceId), { tab });

    // Plan §5c: every action returns a fresh snapshot.
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** Shared act-verb tail: let the page react (and any nav settle), then
   *  return a fresh untrusted-framed a11y snapshot. */
  private async snapshotAfterAction(tabId: string, wc: WebContents): Promise<string> {
    await this.settleAfterAction(wc);
    return wrapUntrusted(await this.snapshotTab(tabId));
  }

  /** type() REPLACES the field by default (focus → Ctrl+A → insertText). */
  private async toolType(tabId: string, ref: number, text: string): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId, ref };
    this.gate('type', tab.partitionFull, url, args, tab);

    const registry = this.refRegistries.get(tabId);
    if (!registry) {
      throw new Error('no snapshot exists for this tab — call readPage first to get refs');
    }
    const backendNodeId = registry.resolve(ref); // StaleRefError / UnknownRefError
    try {
      await this.driver(tabId).typeText(backendNodeId, text, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'type', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'type', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** press_key acts on the focused element (no ref). */
  private async toolPressKey(tabId: string, key: string): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId, key };
    this.gate('pressKey', tab.partitionFull, url, args, tab);

    const k = resolveKey(key);
    if (!k) {
      throw new Error(`unsupported key: ${key}; supported: ${SUPPORTED_BROWSER_KEYS.join(', ')}`);
    }
    try {
      await this.driver(tabId).pressKey(k);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'pressKey', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'pressKey', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** scroll: exactly one of { ref, dy } (the route enforces 400; this is DiD). */
  private async toolScroll(tabId: string, opts: { ref?: number; dy?: number }): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId, ...opts };
    this.gate('scroll', tab.partitionFull, url, args, tab);

    const hasRef = opts.ref !== undefined;
    const hasDy = opts.dy !== undefined;
    if (hasRef === hasDy) {
      throw new Error('scroll requires exactly one of { ref, dy }');
    }
    let backendNodeId: number | undefined;
    if (hasRef) {
      const registry = this.refRegistries.get(tabId);
      if (!registry) {
        throw new Error('no snapshot exists for this tab — call readPage first to get refs');
      }
      backendNodeId = registry.resolve(opts.ref!); // StaleRefError / UnknownRefError
    }
    try {
      if (hasRef) await this.driver(tabId).scrollIntoView(backendNodeId!);
      else await this.driver(tabId).scrollByDelta(opts.dy!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'scroll', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'scroll', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** select_option: ARIA-only. Opens the control, then clicks the matching
   *  ARIA option; a native <select> (no DOM option to click) gets a readable
   *  error pointing at press_key. NEVER Runtime.evaluate (M10). */
  private async toolSelectOption(tabId: string, ref: number, value: string): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId, ref, value };
    this.gate('selectOption', tab.partitionFull, url, args, tab);

    const registry = this.refRegistries.get(tabId);
    if (!registry) {
      throw new Error('no snapshot exists for this tab — call readPage first to get refs');
    }
    const comboboxBackendNode = registry.resolve(ref); // StaleRefError / UnknownRefError
    try {
      const driver = this.driver(tabId);
      // Refuse keyboard-only dropdowns up front with actionable guidance (M10:
      // no eval, so we can't script the option list):
      //  1. a native <select> — its popup is browser-chrome (describeNode).
      //  2. a select2-style wrapper that hides a 0×0 native <select>, or any
      //     off-layout ARIA combobox — clicking it would hit getContentQuads on
      //     a zero-area node and surface the misleading "no visible geometry"
      //     error. hasGeometry catches these BEFORE click().
      await driver.refuseNativeSelect(comboboxBackendNode);
      if (!(await driver.hasGeometry(comboboxBackendNode))) {
        throw new Error(KEYBOARD_DROPDOWN_GUIDANCE);
      }
      await driver.click(comboboxBackendNode);
      await this.settleAfterAction(tab.view.webContents);
      const nodes = await driver.getFullAXTree();
      const found = nodes.find((n) => {
        const role = String(n.role?.value ?? '').toLowerCase();
        if (!SELECTABLE_OPTION_ROLES.has(role)) return false;
        if (n.backendDOMNodeId === undefined) return false;
        const name = String(n.name?.value ?? '');
        const val = String(n.value?.value ?? '');
        return name === value || val === value;
      });
      if (!found) {
        // No clickable ARIA <option> exposed (e.g. aria-activedescendant
        // combobox whose options are JS-injected) — same keyboard guidance.
        throw new Error(KEYBOARD_DROPDOWN_GUIDANCE);
      }
      await driver.click(found.backendDOMNodeId!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'selectOption', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'selectOption', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** go_back: act-tier, but NAV_AWAY-exempt from the sensitive-origin denial
   *  (see browser-policy). Separate from the un-gated UI goBack above. */
  private async toolGoBack(tabId: string): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId };
    this.gate('goBack', tab.partitionFull, url, args, tab);
    try {
      tab.view.webContents.navigationHistory.goBack();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'goBack', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'goBack', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** go_forward: act-tier, NAV_AWAY-exempt. */
  private async toolGoForward(tabId: string): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId };
    this.gate('goForward', tab.partitionFull, url, args, tab);
    try {
      tab.view.webContents.navigationHistory.goForward();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'goForward', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'goForward', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** reload: act-tier; stays denied on sensitive origins (no nav-away exempt). */
  private async toolReload(tabId: string): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId };
    this.gate('reload', tab.partitionFull, url, args, tab);
    try {
      tab.view.webContents.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'reload', args, `error:${msg}`, { tab });
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'reload', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return this.snapshotAfterAction(tabId, tab.view.webContents);
  }

  /** wait_for: read-tier server-side bounded poll. Substring-only, appears-only,
   *  250ms poll, default 5s, clamp 30s. The MCP proxy never polls. */
  private async toolWaitFor(
    tabId: string,
    input: { text: string; timeoutMs?: number },
  ): Promise<WaitForResult> {
    const tab = this.mustGet(tabId);
    this.gate('waitFor', tab.partitionFull, tab.view.webContents.getURL(), { tabId, ...input }, tab);
    const budget = Math.min(Math.max(input.timeoutMs ?? 5_000, 0), 30_000);
    const start = Date.now();
    const wc = tab.view.webContents;
    for (;;) {
      if (wc.isDestroyed()) return { found: false, elapsedMs: Date.now() - start };
      const text = await this.driver(tabId).getText();
      if (text.includes(input.text)) {
        this.auditAuthedRead(tab, 'waitFor', { tabId, ...input });
        return {
          found: true,
          elapsedMs: Date.now() - start,
          snapshot: wrapUntrusted(await this.snapshotTab(tabId)),
        };
      }
      if (Date.now() - start >= budget) return { found: false, elapsedMs: Date.now() - start };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** close_tab: act-tier. Rejects non-agent tabs (the gate already denies them
   *  via user-partition-denied; this is belt-and-braces for any other
   *  partition). Returns the UPDATED agent tab list — the closed tab is gone,
   *  so a fresh page snapshot is impossible. */
  private async toolCloseTab(tabId: string): Promise<CloseTabResult> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId };
    this.gate('closeTab', tab.partitionFull, url, args, tab);
    if (tab.partition !== 'agent') {
      throw new Error(`closeTab refused: tab ${tabId} is not an agent-partition tab`);
    }
    this.closeTab(tabId); // the existing manager method
    this.auditRecord(tab.partitionFull, url, 'closeTab', args, this.authedOutcome(url, tab.workspaceId), { tab });
    return { closed: true, tabs: this.toolListTabs() };
  }

  /** Fresh a11y snapshot; rolls the tab's ref generation (old refs go stale). */
  private async snapshotTab(tabId: string): Promise<string> {
    let registry = this.refRegistries.get(tabId);
    if (!registry) {
      registry = new RefRegistry();
      this.refRegistries.set(tabId, registry);
    }
    const nodes = await this.driver(tabId).getFullAXTree();
    return buildA11ySnapshot(nodes, registry);
  }

  private async settleAfterAction(wc: WebContents): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
    if (wc.isDestroyed() || !wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wc.off('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, 5_000);
      wc.on('did-stop-loading', done);
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private mustGet(tabId: string): TabEntry {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`unknown tab: ${tabId}`);
    return tab;
  }

  private wireViewEvents(tab: TabEntry): void {
    const wc = tab.view.webContents;

    // M6: navigation scheme gates, every frame (decideNavigation is the
    // tested policy; will-navigate/will-redirect cover the top level,
    // will-frame-navigate covers subframes).
    wc.on('will-navigate', (event, url) => {
      const nav = decideNavigation(url, tab.partition);
      if (!nav.allow) {
        console.warn(`[browser] M6 nav denied (tab ${tab.id}): ${nav.reason}`);
        event.preventDefault();
        return;
      }
      // §12-B (F2): navigation ALLOWED to commit — if this carries a handed tab
      // off its allow_signed_in origin, detach the driver + clear handedToAgent.
      // Only on the allowed path: a denied nav is preventDefault'd above and
      // never commits, so it must NOT trigger revocation.
      this.autoRevokeIfOffOrigin(tab, url);
    });
    wc.on('will-redirect', (event, url) => {
      const nav = decideNavigation(url, tab.partition);
      if (!nav.allow) {
        console.warn(`[browser] M6 redirect denied (tab ${tab.id}): ${nav.reason}`);
        event.preventDefault();
        return;
      }
      // §12-B (F2): same as will-navigate — revoke only on the allowed path.
      this.autoRevokeIfOffOrigin(tab, url);
    });
    wc.on('will-frame-navigate', (details) => {
      const nav = decideNavigation(details.url, tab.partition);
      if (!nav.allow) {
        console.warn(`[browser] M6 frame nav denied (tab ${tab.id}): ${nav.reason}`);
        details.preventDefault();
      }
      // §12-B (F2): deliberately NO autoRevokeIfOffOrigin here. A subframe
      // navigation does not change the tab's top-level committed origin
      // (getURL()); revoking on a legitimate embedded third-party frame would
      // break handed pages. Subframe content read under CDP is inside the
      // accepted residual risk for the M9 relaxation.
    });

    // M6: popups denied; the denied URL is surfaced to the renderer so the
    // UI can offer open-as-new-tab (which re-enters the M6 gate).
    wc.setWindowOpenHandler(({ url }) => {
      this.getMainWindow()?.webContents.send(BROWSER_CHANNELS.openRequest, {
        tabId: tab.id,
        url,
      });
      return { action: 'deny' };
    });

    // G1 fail ladder round 2 (Ferdium tactic, their PR #2360): flip this
    // view's UA to the version-stripped Chrome UA on accounts.google.com and
    // restore the full UA on navigation away. Deliberately `did-navigate`,
    // NOT will-navigate — swapping the UA mid-navigation cancels redirects
    // and POSTs (Ferdium's UserAgent.ts L62-90 lesson). The override applies
    // to subsequent requests from the committed page (BotGuard's XHRs).
    wc.on('did-navigate', (_event, url) => {
      wc.setUserAgent(uaForUrl(url, process.versions.chrome));
    });

    // §12-B (F2): authoritative off-origin auto-revoke on the COMMITTED URL.
    // did-navigate fires after the top-level navigation commits, covering
    // redirect-chain landings and address-bar navigations that will-navigate/
    // will-redirect may miss. Defense in depth atop the per-verb gate.
    wc.on('did-navigate', (_e, url) => {
      this.autoRevokeIfOffOrigin(tab, url);
    });

    // ── Slice-1 (premium browser) — clear any prior load error BEFORE the push
    //    listeners below run, so the pushed state already reflects the cleared
    //    error (no error panel outliving a fresh load / successful commit). These
    //    are registered ahead of `push` on purpose: same-event listeners fire in
    //    registration order. did-navigate also refreshes secureState; sendTabState
    //    recomputes it from the live URL too, so order can never strand it. ──
    wc.on('did-start-loading', () => {
      tab.lastError = null;
    });
    wc.on('did-navigate', (_e, url) => {
      tab.secureState = secureStateForUrl(url);
      tab.lastError = null;
      // Slice-10: a committed USER navigation changes the persisted snapshot.
      if (tab.partition === 'user') this.schedulePersist();
      // Slice 15: apply the persisted per-origin zoom for USER tabs (fallback
      // 100%). Runs BEFORE the `push` listener below (same-event, registration
      // order), so the tab-state pushed for this navigation already carries the
      // restored zoomFactor. Agent zoom stays per-tab — never read/applied here.
      if (tab.partition === 'user') this.applyPersistedZoom(tab, url);
    });

    // Tab-state push (frozen contract: onTabState).
    const push = () => this.sendTabState(tab);
    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('did-navigate', push);
    wc.on('did-navigate-in-page', push);
    wc.on('page-title-updated', push);
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.tabFavicons.set(tab.id, favicons[0]);
      // Slice-8: favicons usually resolve after did-navigate, so persist the
      // freshly-cached icon onto the existing user-partition history row.
      this.recordVisitIfUser(tab, wc.getURL());
      push();
    });

    // ── Slice-1 — trusted error / crash / unresponsive states ────────────────
    // We record ONLY shell-side strings (Electron error code, its description,
    // the validated URL); NEVER page content — the error panel is trusted chrome.
    // No load percentage is fabricated: the UI drives its progress bar off the
    // existing `loading` boolean (Electron exposes no real percentage).
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Subframe failures don't blank the tab — only main-frame loads matter.
      if (isMainFrame === false) return;
      // errorCode -3 is ERR_ABORTED — the normal "navigated away / stopped"
      // signal, not a real failure.
      if (errorCode === -3) return;
      tab.lastError = {
        code: String(errorCode),
        description: errorDescription || 'The page could not be loaded.',
        url: validatedURL || '',
      };
      push();
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.lastError = {
        code: 'crashed',
        description: (details && details.reason) || 'render process gone',
        url: wc.isDestroyed() ? '' : wc.getURL(),
      };
      push();
    });
    wc.on('unresponsive', () => {
      tab.unresponsive = true;
      push();
    });
    wc.on('responsive', () => {
      tab.unresponsive = false;
      push();
    });

    // ── Overhaul (WP4) — history recording, USER PARTITION ONLY ──────────────
    // Hard gate: agent navigations are NEVER recorded (persistence half of M9).
    // `did-navigate` records the committed URL; `page-title-updated` refreshes
    // the title once it resolves (recordVisit dedupes by URL). Public getURL/
    // getTitle only — no CDP.
    wc.on('did-navigate', (_e, url) => {
      this.recordVisitIfUser(tab, url);
    });
    wc.on('page-title-updated', () => {
      this.recordVisitIfUser(tab, wc.getURL());
    });

    // ── Overhaul (WP5) — find-in-page progress (counts only, never page text) ─
    // Slice 15: also stamp the per-tab find state so a tab switch can restore the
    // counter (and findNext/findPrev have a fresh ordinal to step from).
    wc.on('found-in-page', (_e, result) => {
      if (tab.findState) {
        tab.findState.activeMatchOrdinal = result.activeMatchOrdinal;
        tab.findState.total = result.matches;
      }
      this.send(BROWSER_CHANNELS.foundInPage, {
        tabId: tab.id,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
    });

    // ── Overhaul (WP6-CTX) — native right-click menu, popped in main ─────────
    wc.on('context-menu', (_e, p) => {
      const params: BrowserContextMenuParams = {
        tabId: tab.id,
        x: p.x,
        y: p.y,
        linkURL: p.linkURL,
        srcURL: p.srcURL,
        selectionText: p.selectionText,
        isEditable: p.isEditable,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        mediaType: p.mediaType as BrowserContextMenuParams['mediaType'],
      };
      const template = buildContextMenuTemplate(params, { partition: tab.partition });
      for (const item of template) {
        switch (item.id) {
          // Items fully handled in main (no renderer round-trip).
          case 'nav-back':
            item.click = () => {
              if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
            };
            break;
          case 'nav-forward':
            item.click = () => {
              if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
            };
            break;
          case 'reload':
            item.click = () => wc.reload();
            break;
          case 'copy':
            item.click = () => wc.copy();
            break;
          // Open link: act directly, INHERITING the source tab's partition
          // (agent links never escalate to user). createTab re-enters the M6
          // gate; a non-http link (mailto:, etc.) is rejected there.
          case 'open-link-new-tab':
            item.click = () => {
              if (!params.linkURL) return;
              try {
                this.createTab({ partition: tab.partition, url: params.linkURL });
              } catch (err) {
                console.warn(`[browser] open-link-new-tab denied: ${String(err)}`);
              }
            };
            break;
          // Renderer-side actions → contextMenuCommand event (clipboard write,
          // search, star). The renderer routes URL opens back through navigate/
          // createTab → M6.
          case 'copy-link':
          case 'search-selection':
          case 'bookmark-page':
            item.click = () => {
              this.send(BROWSER_CHANNELS.contextMenuCommand, { action: item.id, params });
            };
            break;
          // Slice 13: Save link/image as… — USER partition only (builder omits
          // these on agent tabs). downloadURL re-enters will-download on the
          // user session → the decision gate raises a trusted-chrome confirm
          // (never auto-allowed). Belt-and-braces partition check.
          case 'save-link-as':
          case 'save-image-as':
            item.click = () => {
              if (tab.partition !== 'user') return;
              const target = item.id === 'save-image-as' ? params.srcURL : params.linkURL;
              if (target) wc.downloadURL(target);
            };
            break;
          // M9: DevTools only on the user partition — openDevTools detaches a
          // CDP debugger, which must never happen on persist:agent. The builder
          // already omits 'inspect' on agent tabs; this is belt-and-braces.
          case 'inspect':
            item.click = () => {
              if (tab.partition === 'user') wc.openDevTools();
            };
            break;
          default:
            break;
        }
      }
      const win = this.getMainWindow();
      Menu.buildFromTemplate(template).popup(win ? { window: win } : undefined);
    });

    // ── Overhaul (WP6-KEYS) — main-side keyboard shortcuts ───────────────────
    // Fires even when focus is inside the page. preventDefault ONLY on handled
    // chords; the listener is detached on `destroyed` (leak guard).
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      const cmd = mapChord(input);
      if (!cmd) return;
      event.preventDefault();
      this.routeShortcut(cmd, tab.id);
    };
    wc.on('before-input-event', beforeInput);

    wc.once('destroyed', () => {
      wc.removeListener('before-input-event', beforeInput); // leak guard
      // Slice-11 (Fix A): a DELIBERATE discard tears down the live view but keeps
      // the tab in tabOrder/pinnedTabs as a frozen snapshot. discardTab already
      // moved that bookkeeping, so do NOT forget its order or clear active here.
      if (this.discardingTabs.has(tab.id)) {
        this.discardingTabs.delete(tab.id);
        return;
      }
      this.tabFavicons.delete(tab.id);
      this.tabs.delete(tab.id);
      this.drivers.delete(tab.id);
      this.refRegistries.delete(tab.id);
      this.lastActiveAt.delete(tab.id);
      this.lastScrollY.delete(tab.id);
      this.forgetTabOrder(tab.id);
      if (this.activeTabId === tab.id) this.activeTabId = null;
      this.emitTabsSnapshot();
    });
  }

  /** Record a user-partition visit if the URL passes the M6 gate. Agent
   *  navigations and empty/about:blank URLs are skipped. */
  private recordVisitIfUser(tab: TabEntry, url: string): void {
    if (tab.partition !== 'user') return;
    if (!url || url === 'about:blank') return;
    if (!decideNavigation(url, 'user').allow) return;
    // Slice-8: persist the latest cached favicon alongside the visit (COALESCE
    // in the store keeps a prior favicon when this event carries none).
    recordVisit(url, tab.view.webContents.getTitle(), this.tabFavicons.get(tab.id) ?? null);
  }

  /** Route a mapped shortcut. Structural chords act in main; UI-reaction chords
   *  push a `shortcutCommand` event to the renderer. */
  private routeShortcut(cmd: BrowserShortcut, tabId: string): void {
    switch (cmd) {
      case 'new-tab':
        // Ctrl+T defaults to a user tab (plan WP6-KEYS).
        this.createTab({ partition: 'user' });
        break;
      case 'close-tab':
        this.closeTab(this.activeTabId ?? tabId);
        break;
      case 'reload':
        this.tabs.get(tabId)?.view.webContents.reload();
        break;
      case 'cycle-next':
        this.cycleActiveTab(1);
        break;
      case 'cycle-prev':
        this.cycleActiveTab(-1);
        break;
      case 'reopen-closed':
        this.reopenClosedTab();
        break;
      case 'zoom-in': {
        const wc = this.tabs.get(tabId)?.view.webContents;
        if (wc) this.setZoom(tabId, wc.getZoomFactor() + 0.1);
        break;
      }
      case 'zoom-out': {
        const wc = this.tabs.get(tabId)?.view.webContents;
        if (wc) this.setZoom(tabId, wc.getZoomFactor() - 0.1);
        break;
      }
      case 'zoom-reset':
        // Slice 15: reset clears the persisted origin row (→ 100% on future
        // visits), not just the live factor.
        if (this.tabs.has(tabId)) this.resetZoomForOrigin(tabId);
        break;
      // UI-reaction chords — the renderer focuses the address bar, opens the
      // find bar / history view, or triggers the star menu.
      case 'focus-address':
      case 'find':
      case 'history':
      case 'bookmark':
        this.send(BROWSER_CHANNELS.shortcutCommand, { shortcut: cmd, tabId });
        break;
      default:
        break;
    }
  }

  /** Move active selection to a neighbor in display order (Ctrl+Tab cycling).
   *  Scoped to the current workspace so cycling never lands on a hidden tab. */
  private cycleActiveTab(dir: 1 | -1): void {
    const order = this.currentWorkspaceTabIds();
    if (order.length === 0) return;
    const cur = this.activeTabId ? order.indexOf(this.activeTabId) : -1;
    const base = cur === -1 ? 0 : cur;
    const next = (base + dir + order.length) % order.length;
    this.setActiveTab(order[next]);
  }

  private sendTabState(tab: TabEntry): void {
    const win = this.getMainWindow();
    if (!win) return;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const state: BrowserTabState = {
      tabId: tab.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      favicon: this.tabFavicons.get(tab.id),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      partition: tab.partition,
      // Per-workspace isolation: the renderer filters its tab list on this.
      workspaceId: tab.workspaceId,
      // Overhaul (WP5): surface the live zoom factor so the UI indicator
      // reflects setZoom and Ctrl +/−/0.
      zoomFactor: wc.getZoomFactor(),
      // Slice-1 (premium browser): connection-security glyph state. Recomputed
      // from the LIVE committed URL here so it is always fresh regardless of
      // which event triggered this push.
      secureState: secureStateForUrl(wc.getURL()),
      // Slice-1: the trusted-error-panel state. ALWAYS sent (null when clear) so
      // the renderer's snapshot merge clears a stale error — never the additive
      // "field absent" idiom, which would let an old error linger.
      lastError: tab.lastError ?? null,
      // Phase-1 shape kept intact: field absent (not false) for human tabs.
      ...(tab.openedByAgent ? { openedByAgent: true } : {}),
      // Slice-2: agent identity + authoritative attention. Additive idiom (field
      // absent, not falsy) — main sets these ONCE at open; it never re-pulses, so
      // lastAttentionAt is a stable marker the renderer keys a one-shot flash off.
      ...(tab.openedByAgentId ? { openedByAgentId: tab.openedByAgentId } : {}),
      ...(tab.openedByAgentTitle ? { openedByAgentTitle: tab.openedByAgentTitle } : {}),
      ...(tab.needsHumanAttention ? { needsHumanAttention: true } : {}),
      ...(tab.lastAttentionAt ? { lastAttentionAt: tab.lastAttentionAt } : {}),
      // §12-B (F4): make the renderer's "Agent driving" badge authoritative —
      // push the live handed/quarantine flags (additive idiom: field absent,
      // not false, so the renderer treats missing as false).
      ...(tab.handedToAgent ? { handedToAgent: true } : {}),
      ...(tab.signinPending ? { signinPending: true } : {}),
    };
    win.webContents.send(BROWSER_CHANNELS.tabState, state);
  }

  // ── OVERHAUL impl (WP3–WP7) ──────────────────────────────────────────────
  // Owner protocol unchanged: edit one method body at a time. NONE of these
  // touch a security path (decideNavigation / hardenSession /
  // buildBrowserWebPreferences / debugger) except as explicit defense-in-depth.
  // Bookmarks/history are USER-PARTITION ONLY by contract.

  /** Send an event to the renderer, guarding against a torn-down window. */
  private send(channel: string, payload: unknown): void {
    const win = this.getMainWindow();
    if (!win || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  // WP5 — find-in-page (native WebContents.findInPage; counts via foundInPage).
  // Slice 15 layers a per-tab find state on top: `find` starts a fresh search and
  // remembers the query+opts; `findNext`/`findPrev` reuse the stored query so
  // they step IMMEDIATELY (no debounce wait); a tab switch re-runs the query
  // (restoreFind); `stopFind` clears the stored query + the active tab's highlight.

  /** Slice 15: start (or update) the active find for a tab. Stores the latest
   *  query+options so subsequent next/prev reuse them with no debounce. Empty
   *  query clears find for the tab. */
  find(tabId: string, query: string, opts?: BrowserFindOptions): void {
    const tab = this.mustGet(tabId);
    const wc = tab.view.webContents;
    if (!query) {
      // Electron throws on an empty query — treat empty as "clear this tab".
      tab.findState = undefined;
      wc.stopFindInPage('clearSelection');
      return;
    }
    const matchCase = !!opts?.matchCase;
    tab.findState = { query, matchCase, activeMatchOrdinal: 0, total: 0 };
    // Fresh search (findNext omitted/false): Electron moves to the first match.
    wc.findInPage(query, { matchCase });
  }

  /** Slice 15: advance to the next match using the tab's stored query+opts. */
  findNext(tabId: string): void {
    this.stepFind(tabId, true);
  }

  /** Slice 15: go to the previous match using the tab's stored query+opts. */
  findPrev(tabId: string): void {
    this.stepFind(tabId, false);
  }

  /** Step next/prev off the stored query IMMEDIATELY — the renderer's debounce
   *  applies only to live-typing `find`; next/prev always use the latest query. */
  private stepFind(tabId: string, forward: boolean): void {
    const tab = this.mustGet(tabId);
    const st = tab.findState;
    if (!st || !st.query) return; // nothing to step through
    tab.view.webContents.findInPage(st.query, {
      forward,
      findNext: true,
      matchCase: st.matchCase,
    });
  }

  /** Slice 15: re-run a tab's stored query on (re)activation so its native
   *  highlight + counter are restored. No-op when the tab has no active find. */
  private restoreFind(tab: TabEntry): void {
    const st = tab.findState;
    if (!st || !st.query) return;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    wc.findInPage(st.query, { matchCase: st.matchCase });
  }

  /** Slice 15: close find for a tab — clear the stored query and the native
   *  highlight. The renderer calls this for the ACTIVE tab only, so other tabs
   *  keep their stored query and re-highlight when switched back. */
  stopFind(tabId: string): void {
    const tab = this.mustGet(tabId);
    tab.findState = undefined;
    tab.view.webContents.stopFindInPage('clearSelection');
  }

  /** Legacy WP5 find entry (kept for back-compat with the pre-Slice-15 chrome).
   *  Routes through the stateful API so old + new callers never desync. */
  findInPage(tabId: string, text: string, opts?: { forward?: boolean; findNext?: boolean }): void {
    if (opts?.findNext) {
      if (opts.forward === false) this.findPrev(tabId);
      else this.findNext(tabId);
      return;
    }
    this.find(tabId, text, {});
  }

  /** Legacy WP5 stop (kept for back-compat). */
  stopFindInPage(tabId: string): void {
    this.stopFind(tabId);
  }

  // WP5 — zoom (native WebContents.setZoomFactor; clamped to a sane range).
  // Slice 15: a USER tab's zoom is persisted by origin (per-site zoom); agent
  // zoom stays per-tab and is NEVER written.
  setZoom(tabId: string, zoomFactor: number): void {
    const tab = this.mustGet(tabId);
    const clamped = clamp(zoomFactor, 0.25, 5);
    tab.view.webContents.setZoomFactor(clamped);
    if (tab.partition === 'user') {
      const origin = zoomOriginOf(tab.view.webContents.getURL());
      if (origin) setStoredZoom(origin, clamped);
    }
    this.sendTabState(tab); // push the new zoomFactor to the UI indicator
  }

  /** Slice 15: reset a tab to 100% AND clear its persisted origin row so the
   *  origin reverts to default on future visits ("Reset"). Agent tabs just snap
   *  back to 100% (nothing persisted to clear). */
  resetZoomForOrigin(tabId: string): void {
    const tab = this.mustGet(tabId);
    tab.view.webContents.setZoomFactor(1);
    if (tab.partition === 'user') {
      const origin = zoomOriginOf(tab.view.webContents.getURL());
      if (origin) clearStoredZoom(origin);
    }
    this.sendTabState(tab);
  }

  /** Slice 15: apply the persisted per-origin zoom for a USER tab on committed
   *  navigation (fallback 100% when no row). Does NOT persist — read-only path. */
  private applyPersistedZoom(tab: TabEntry, url: string): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const origin = zoomOriginOf(url);
    const stored = origin ? getStoredZoom(origin) : undefined;
    wc.setZoomFactor(stored !== undefined ? clamp(stored, 0.25, 5) : 1);
  }

  // ── Slice 14: reading mode ─────────────────────────────────────────────────
  // TRUSTED CHROME ONLY. Deliberately a plain manager method (like setZoom), NOT
  // a member of the `tools` BrowserToolProvider facade — agents have no verb that
  // reaches this, and there is no policy READ_VERB for it. Self-gated to http(s)
  // USER tabs (mirrors ZoomControl / bookmarks / history user-only features): an
  // agent-partition or non-http(s) tab is rejected outright, so extraction is
  // never reachable from agent-driven state. We read the live page HTML through
  // the trusted main-side WebContents.executeJavaScript path (the same primitive
  // the scroll restore uses) — NOT through any agent-reachable CDP read — then
  // hand it to the pure extract+sanitize routine. We do NOT attach/leave a
  // debugger on the tab, so the agent CDP attach discipline is untouched.
  async enterReadingMode(tabId: string): Promise<ReaderArticle> {
    const tab = this.mustGet(tabId);
    if (tab.partition !== 'user') {
      throw new Error('reading mode is available only for user tabs');
    }
    const wc = tab.view.webContents;
    const url = wc.getURL();
    if (secureStateForUrl(url) === 'internal') {
      throw new Error('reading mode is available only for http(s) pages');
    }
    if (wc.isDestroyed() || typeof wc.executeJavaScript !== 'function') {
      throw new Error('cannot read this tab');
    }
    // Trusted main-side live-HTML read (untrusted RESULT — sanitized below).
    const rawHtml = (await wc.executeJavaScript(
      'document.documentElement.outerHTML',
      true,
    )) as string;
    return extractReaderArticle(typeof rawHtml === 'string' ? rawHtml : '', url);
  }

  // WP6 — native context menu is popped directly in the `context-menu` event
  // handler (see wireViewEvents); the renderer does NOT round-trip a request.
  // Kept as a harmless no-op so the channel stays wired without a second path.
  contextMenuRequest(_tabId: string, _params: BrowserContextMenuParams): void {
    return;
  }

  // WP3 — bookmarks (USER-PARTITION ONLY; manager validates scheme as DiD).
  bookmarkList(): Bookmark[] {
    return listBookmarks();
  }

  bookmarkAdd(input: { title: string; url: string }): Bookmark {
    // Defense-in-depth: reject any URL the M6 gate would deny (non-http/https).
    // The UI already gates the star to user tabs; this is the second wall.
    if (!decideNavigation(input.url, 'user').allow) {
      throw new Error(`bookmark rejected: ${input.url} is not an allowed http/https URL`);
    }
    // Slice-7 — USER-PARTITION ONLY (cross-cutting rule #1). Resolve the open
    // tab(s) whose live committed URL is the one being bookmarked. If the URL is
    // open ONLY in an agent-partition tab, REJECT here — even if the renderer
    // (or a compromised one) calls this IPC directly. A user tab match wins and
    // contributes its favicon; a URL open in no tab (e.g. from history) is fine.
    const matches = [...this.tabs.values()].filter(
      (t) => t.view.webContents.getURL() === input.url,
    );
    const userMatch = matches.find((t) => t.partition === 'user');
    if (!userMatch && matches.some((t) => t.partition === 'agent')) {
      throw new Error('bookmark rejected: agent-partition URLs are never bookmarkable');
    }
    // Persist the active USER tab's favicon (never an agent favicon).
    const favicon = userMatch ? this.tabFavicons.get(userMatch.id) : undefined;
    const bookmark = insertBookmark({ title: input.title, url: input.url, favicon });
    this.emitBookmarksChanged();
    return bookmark;
  }

  /** Slice-7: edit a bookmark's title/favicon/folder. Preserves id + sort order
   *  (bookmarks-store never touches them). USER-PARTITION ONLY by contract — the
   *  edited row was created through bookmarkAdd, which already rejected agent
   *  URLs; the patch carries no URL, so no origin can be smuggled in. */
  bookmarkUpdate(id: string, patch: BookmarkPatch): Bookmark {
    const bookmark = updateBookmark(id, patch);
    this.emitBookmarksChanged();
    return bookmark;
  }

  bookmarkRemove(id: string): void {
    deleteBookmark(id);
    this.emitBookmarksChanged();
  }

  bookmarkReorder(orderedIds: string[]): void {
    reorderBookmarks(orderedIds);
    this.emitBookmarksChanged();
  }

  private emitBookmarksChanged(): void {
    this.send(BROWSER_CHANNELS.bookmarksChanged, listBookmarks());
  }

  // WP4 — history (USER-PARTITION ONLY; recording gated on tab.partition in
  // wireViewEvents → recordVisitIfUser). These are read/delete passthroughs.
  historyList(query?: HistoryQuery): HistoryEntry[] {
    return listHistory(query ?? {});
  }

  historyDelete(id: string): void {
    deleteHistory(id);
  }

  historyClear(): void {
    clearHistory();
  }

  /** Slice-8: most-visited user sites for the NTP top-sites grid (Slice-9).
   *  USER-PARTITION ONLY by construction (agent visits are never recorded). */
  historyTopSites(limit?: number): HistoryEntry[] {
    return topSites(limit ?? 8);
  }

  // ── WP7 — tab management (main authoritative for order/pin/closed stack) ──

  /** Live tabIds in display order, pinned clustered left (relative order
   *  within each cluster preserved). Stale ids are dropped defensively. */
  private orderedTabIds(): string[] {
    // Slice-10/11: a frozen tab's id stays in tabOrder/pinnedTabs (it renders in
    // the strip inline with live tabs), so accept both live and frozen ids.
    const live = this.tabOrder.filter((id) => this.tabs.has(id) || this.frozenTabs.has(id));
    const pinned = live.filter((id) => this.pinnedTabs.has(id));
    const rest = live.filter((id) => !this.pinnedTabs.has(id));
    return [...pinned, ...rest];
  }

  /** The workspace a (live or frozen) tab belongs to. */
  private workspaceOf(id: string): string | null {
    const tab = this.tabs.get(id);
    if (tab) return tab.workspaceId;
    return this.frozenTabs.get(id)?.workspaceId ?? null;
  }

  /** Per-workspace isolation: ordered tabIds belonging to the current
   *  workspace. Drives the tab strip snapshot and Ctrl+Tab cycling so neither
   *  ever crosses into another workspace's tabs. */
  private currentWorkspaceTabIds(): string[] {
    return this.orderedTabIds().filter(
      (id) => this.workspaceOf(id) === this.currentWorkspaceId,
    );
  }

  /** Drop a tab from the order list + pin set (idempotent). */
  private forgetTabOrder(tabId: string): void {
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId);
    this.pinnedTabs.delete(tabId);
  }

  private emitTabsSnapshot(): void {
    // Persist the normalized (pinned-left) order so indices are stable.
    this.tabOrder = this.orderedTabIds();
    this.send(BROWSER_CHANNELS.tabsSnapshot, this.getTabsSnapshot());
  }

  reorderTab(tabId: string, toOrder: number): void {
    if (!this.tabs.has(tabId) && !this.frozenTabs.has(tabId)) return;
    const order = this.orderedTabIds();
    const from = order.indexOf(tabId);
    if (from === -1) return;
    order.splice(from, 1);
    const clamped = clamp(Math.trunc(toOrder), 0, order.length);
    order.splice(clamped, 0, tabId);
    this.tabOrder = order;
    // emitTabsSnapshot re-clusters pinned-left, so a drop across the pinned/
    // unpinned boundary is clamped back into the correct cluster.
    this.emitTabsSnapshot();
    this.schedulePersist(); // Slice-10: order is part of the persisted session
  }

  setTabPinned(tabId: string, pinned: boolean): void {
    // Slice-10/11: pin/unpin works on a frozen tab too (its id is in tabOrder).
    if (!this.tabs.has(tabId) && !this.frozenTabs.has(tabId)) return;
    if (pinned) this.pinnedTabs.add(tabId);
    else this.pinnedTabs.delete(tabId);
    const frozen = this.frozenTabs.get(tabId);
    if (frozen) frozen.pinned = pinned;
    this.emitTabsSnapshot();
    this.schedulePersist();
  }

  reopenClosedTab(): { tabId: string } | null {
    // Slice-10: two reopen stacks — the PERSISTENT SQLite stack (USER closes,
    // scoped to the current workspace) and the in-memory LIFO (AGENT closes).
    // Pop whichever side was closed more recently so Ctrl+Shift+T is intuitive
    // regardless of partition. createTab re-enters the M6 gate + emits snapshots.
    const ws = this.currentWorkspaceId;
    const userNewest = peekNewestClosedAt(ws);
    const agentTop = this.closedTabStack[this.closedTabStack.length - 1];
    const useUser =
      userNewest !== null && (agentTop === undefined || userNewest >= agentTop.pushedAt);
    if (useUser) {
      const row = popClosedTab(ws);
      if (row) return this.createTab({ partition: 'user', url: row.url, workspaceId: row.workspaceId });
    }
    const entry = this.closedTabStack.pop();
    if (entry) {
      // Partition preserved — an agent tab reopens as agent (no promotion).
      return this.createTab({ partition: entry.partition, url: entry.url });
    }
    // Agent stack empty; fall back to the user stack (covers the userNewest-null
    // race where a USER close landed between the peek and here).
    const row = popClosedTab(ws);
    if (row) return this.createTab({ partition: 'user', url: row.url, workspaceId: row.workspaceId });
    return null;
  }

  // ── Slice 10/11 — session restore + frozen/discarded tab model ─────────────

  /** True for a PLAIN user tab whose URL/favicon may be persisted or moved to a
   *  frozen snapshot. Agent / signin-quarantine / handed tabs are NEVER
   *  persisted or discarded (cross-cutting rule #1). */
  private isPersistableUserTab(tab: TabEntry): boolean {
    return (
      tab.partition === 'user' &&
      !tab.openedByAgent &&
      !tab.signinPending &&
      !tab.handedToAgent
    );
  }

  /** Debounced (~500ms) session persistence. Coalesces a burst of
   *  create/close/navigate/reorder/pin churn into one replaceSession write. */
  private schedulePersist(): void {
    if (this.sessionWriteTimer) return; // a write is already pending — coalesce
    this.sessionWriteTimer = setTimeout(() => {
      this.sessionWriteTimer = null;
      try {
        this.persistSession();
      } catch (err) {
        console.error('browser.persistSession failed:', err);
      }
    }, SESSION_WRITE_DEBOUNCE_MS);
    if (typeof this.sessionWriteTimer.unref === 'function') this.sessionWriteTimer.unref();
  }

  /** Snapshot the live USER tabs + the frozen tabs (in display order) and rewrite
   *  the persisted session. USER PARTITION ONLY — agent/signin/handed tabs and
   *  their URLs/favicons never reach SQLite. */
  private persistSession(): void {
    const rows: SessionTabRow[] = [];
    let order = 0;
    for (const id of this.orderedTabIds()) {
      const frozen = this.frozenTabs.get(id);
      if (frozen) {
        rows.push({
          tabId: frozen.id,
          workspaceId: frozen.workspaceId,
          url: frozen.url,
          title: frozen.title,
          favicon: frozen.favicon,
          pinned: frozen.pinned,
          sortOrder: order++,
          groupId: frozen.groupId,
          active: false, // a frozen tab is never the live active tab
          scrollY: frozen.scrollY,
        });
        continue;
      }
      const tab = this.tabs.get(id);
      if (!tab || !this.isPersistableUserTab(tab)) continue;
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) continue;
      const url = wc.getURL();
      if (!url || url === 'about:blank') continue;
      if (!decideNavigation(url, 'user').allow) continue; // defense in depth
      rows.push({
        tabId: tab.id,
        workspaceId: tab.workspaceId,
        url,
        title: wc.getTitle(),
        favicon: this.tabFavicons.get(tab.id),
        pinned: this.pinnedTabs.has(tab.id),
        sortOrder: order++,
        groupId: null,
        active: tab.id === this.activeTabId,
        scrollY: this.lastScrollY.get(tab.id),
      });
    }
    replaceSession(rows);
  }

  /** Build the renderer-facing state for a frozen (snapshot-backed) tab. No live
   *  WebContents exists — url/title/favicon come straight from the snapshot. */
  private frozenTabState(frozen: FrozenTab): BrowserTabState {
    return {
      tabId: frozen.id,
      url: frozen.url,
      title: frozen.title,
      favicon: frozen.favicon,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      partition: 'user',
      workspaceId: frozen.workspaceId,
      secureState: secureStateForUrl(frozen.url),
      lastError: null,
      frozen: true,
      // origin 'discarded' → the memory-saver MoonStar treatment; 'restored' is
      // a plain frozen tab (renderer dims both, marks discarded distinctly).
      ...(frozen.origin === 'discarded' ? { discarded: true } : {}),
    };
  }

  /** Push the frozen tab's state so the renderer can dim/mark it. */
  private sendFrozenTabState(frozen: FrozenTab): void {
    this.send(BROWSER_CHANNELS.tabState, this.frozenTabState(frozen));
  }

  /** Slice-10: re-materialize the prior USER-PARTITION session as FROZEN tabs
   *  (no WebContentsView until first activation). Idempotent — gated on the
   *  sessionRestored latch so a second pull returns []. Returns the frozen states
   *  the renderer renders (it filters them to the selected workspace). */
  restoreSession(): BrowserTabState[] {
    if (this.sessionRestored) return [];
    this.sessionRestored = true;
    const states: BrowserTabState[] = [];
    for (const row of loadSession()) {
      // Defense in depth: never restore an empty / non-http(s) / denied URL.
      if (!row.url || row.url === 'about:blank') continue;
      if (!decideNavigation(row.url, 'user').allow) continue;
      const frozen: FrozenTab = {
        id: row.tabId,
        url: row.url,
        title: row.title,
        favicon: row.favicon,
        partition: 'user',
        workspaceId: row.workspaceId,
        pinned: row.pinned,
        sortOrder: row.sortOrder,
        groupId: row.groupId,
        scrollY: row.scrollY,
        origin: 'restored',
      };
      this.frozenTabs.set(frozen.id, frozen);
      this.tabOrder.push(frozen.id); // joins the order (orderedTabIds accepts frozen)
      if (frozen.pinned) this.pinnedTabs.add(frozen.id);
      states.push(this.frozenTabState(frozen));
    }
    this.emitTabsSnapshot();
    return states;
  }

  /** Slice-10/11: lazily materialize a frozen tab's live view on first
   *  activation and navigate to the stored URL. Keeps the tab's id/order/pin —
   *  only the missing WebContentsView is created. Best-effort scroll restore. */
  private hydrateFrozenTab(tabId: string): void {
    const frozen = this.frozenTabs.get(tabId);
    if (!frozen) return;
    this.frozenTabs.delete(tabId);

    const sessionPartition = partitionFor('user', frozen.workspaceId);
    this.ensureSessionHardened(sessionPartition);
    const view = new WebContentsView({
      webPreferences: {
        ...buildBrowserWebPreferences('user'),
        session: session.fromPartition(sessionPartition),
      },
    });
    const now = Date.now();
    const tab: TabEntry = {
      id: tabId,
      view,
      partition: 'user',
      partitionFull: PARTITION_FULL.user,
      sessionPartition,
      workspaceId: frozen.workspaceId,
      openedByAgent: false,
      createdAt: now,
    };
    this.tabs.set(tabId, tab);
    this.lastActiveAt.set(tabId, now);
    this.wireViewEvents(tab);

    const win = this.getMainWindow();
    if (win) {
      win.contentView.addChildView(view);
      view.setBounds(this.lastBounds);
      view.setVisible(false); // setActiveTab raises + shows it after hydration
    }

    // Restore scroll once the page has loaded (best-effort; never blocks).
    if (frozen.scrollY && frozen.scrollY > 0) {
      const targetY = frozen.scrollY;
      view.webContents.once('did-finish-load', () => this.restoreScroll(tab, targetY));
    }
    void view.webContents.loadURL(frozen.url);
    this.sendTabState(tab);
  }

  /** Best-effort scroll restore via page-context JS (trusted-chrome initiated,
   *  not an agent action). Fail-open — a refused/failed eval is ignored. */
  private restoreScroll(tab: TabEntry, y: number): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || typeof wc.executeJavaScript !== 'function') return;
    wc.executeJavaScript(`window.scrollTo(0, ${Math.trunc(y)});`, true).catch(() => {});
  }

  /** Best-effort capture of the live scrollY into lastScrollY, bounded by
   *  SCROLL_CAPTURE_TIMEOUT_MS so a hung renderer never stalls a sweep (§8). */
  private async captureScrollY(tab: TabEntry): Promise<void> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || typeof wc.executeJavaScript !== 'function') return;
    try {
      const y = await Promise.race([
        wc.executeJavaScript('window.scrollY', true) as Promise<number>,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('scroll-capture-timeout')), SCROLL_CAPTURE_TIMEOUT_MS),
        ),
      ]);
      if (typeof y === 'number' && y >= 0) this.lastScrollY.set(tab.id, y);
    } catch {
      /* fail-open: keep whatever lastScrollY we already had */
    }
  }

  /** Slice-11: discard a live USER tab — tear down its WebContentsView but keep
   *  a FrozenTab snapshot (origin 'discarded') in its place. Never the active
   *  tab; never an agent / signin / handed tab. */
  discardTab(tabId: string): void {
    if (tabId === this.activeTabId) return; // never discard the active tab
    const tab = this.tabs.get(tabId);
    if (!tab || !this.isPersistableUserTab(tab)) return;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const url = wc.getURL();
    if (!url || url === 'about:blank') return;
    if (!decideNavigation(url, 'user').allow) return;

    const frozen: FrozenTab = {
      id: tab.id,
      url,
      title: wc.getTitle(),
      favicon: this.tabFavicons.get(tab.id),
      partition: 'user',
      workspaceId: tab.workspaceId,
      pinned: this.pinnedTabs.has(tab.id),
      sortOrder: this.orderedTabIds().indexOf(tab.id),
      groupId: null,
      scrollY: this.lastScrollY.get(tab.id),
      origin: 'discarded',
    };
    // Mark BEFORE close so the `destroyed` handler skips order/active teardown.
    this.discardingTabs.add(tab.id);
    this.frozenTabs.set(tab.id, frozen);
    this.tabs.delete(tab.id);
    this.drivers.delete(tab.id);
    this.refRegistries.delete(tab.id);
    this.tabFavicons.delete(tab.id);
    this.lastActiveAt.delete(tab.id);
    this.lastScrollY.delete(tab.id);
    this.getMainWindow()?.contentView.removeChildView(tab.view);
    wc.close(); // → destroyed handler (guarded by discardingTabs)

    this.sendFrozenTabState(frozen);
    this.emitTabsSnapshot();
    this.schedulePersist();
  }

  /** Slice-11 setter (browserDiscardThreshold IPC): idle-discard threshold in ms,
   *  or null = Never (idle discard off; the hard live-view cap still applies). */
  setDiscardThreshold(ms: number | null): void {
    DISCARD_IDLE_MS = ms === null ? null : Math.max(0, Math.trunc(ms));
  }

  /** Slice-11: start the ~60s idle-discard + hard-cap memory sweep (USER tabs). */
  private startDiscardSweep(): void {
    if (this.discardSweepTimer) return;
    this.discardSweepTimer = setInterval(() => {
      void this.runDiscardSweep();
    }, DISCARD_SWEEP_MS);
    if (typeof this.discardSweepTimer.unref === 'function') this.discardSweepTimer.unref();
  }

  /** A live USER tab eligible for the idle/cap sweep. EXEMPT: the active tab,
   *  pinned tabs, agent-partition / agent-opened tabs, and signin/handed tabs. */
  private isDiscardEligible(tab: TabEntry): boolean {
    if (tab.partition !== 'user') return false;
    if (tab.id === this.activeTabId) return false;
    if (this.pinnedTabs.has(tab.id)) return false;
    return this.isPersistableUserTab(tab);
  }

  /** One sweep pass: throttle hidden views, idle-discard past the threshold, then
   *  enforce the hard live-view cap by discarding the least-recently-active. */
  private async runDiscardSweep(): Promise<void> {
    const now = Date.now();
    // Enable Chromium background throttling on every hidden USER view (the active
    // tab stays unthrottled so it remains responsive).
    for (const tab of this.tabs.values()) {
      if (tab.partition !== 'user') continue;
      const wc = tab.view.webContents;
      if (wc.isDestroyed() || typeof wc.setBackgroundThrottling !== 'function') continue;
      wc.setBackgroundThrottling(tab.id !== this.activeTabId);
    }

    // 1) Idle-threshold discard (skipped entirely when the threshold is Never).
    if (DISCARD_IDLE_MS !== null) {
      const threshold = DISCARD_IDLE_MS;
      const idle = [...this.tabs.values()].filter((t) => {
        if (!this.isDiscardEligible(t)) return false;
        const since = this.lastActiveAt.get(t.id) ?? t.createdAt ?? now;
        return now - since >= threshold;
      });
      for (const tab of idle) {
        await this.captureScrollY(tab);
        this.discardTab(tab.id);
      }
    }

    // 2) Hard live-view cap — discard LRU eligible views beyond the cap.
    const liveEligible = [...this.tabs.values()].filter((t) => this.isDiscardEligible(t));
    if (liveEligible.length > MAX_LIVE_USER_VIEWS) {
      liveEligible.sort(
        (a, b) =>
          (this.lastActiveAt.get(a.id) ?? a.createdAt ?? 0) -
          (this.lastActiveAt.get(b.id) ?? b.createdAt ?? 0),
      );
      const overflow = liveEligible.length - MAX_LIVE_USER_VIEWS;
      for (let i = 0; i < overflow; i++) {
        await this.captureScrollY(liveEligible[i]);
        this.discardTab(liveEligible[i].id);
      }
    }
  }

  getTabsSnapshot(): BrowserTabSnapshotEntry[] {
    // Per-workspace isolation: the strip only ever sees the current workspace's
    // tabs (order indices are dense within that scope).
    return this.currentWorkspaceTabIds().map((id, index) => ({
      tabId: id,
      order: index,
      pinned: this.pinnedTabs.has(id),
      // Frozen tabs are USER-partition by construction (never in this.tabs).
      partition: this.tabs.get(id)?.partition ?? 'user',
    }));
  }
}
