import { create } from 'zustand';
import { useDashboardStore } from './dashboard-store';

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
  /** Set by Phase 2 (WP2) for tabs opened by agent tools — additive, optional. */
  openedByAgent?: boolean;
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

export interface BrowserApi {
  createTab(opts: { partition: BrowserPartition; url?: string }): Promise<{ tabId: string }>;
  closeTab(tabId: string): unknown;
  navigate(tabId: string, url: string): unknown;
  goBack(tabId: string): unknown;
  goForward(tabId: string): unknown;
  reload(tabId: string): unknown;
  stop(tabId: string): unknown;
  /** null = hide all views */
  setActiveTab(tabId: string | null): unknown;
  /** DIP, window-content-relative */
  setBounds(bounds: BrowserBounds): unknown;
  /** Pane suspension for renderer overlays (WebContentsView paints above DOM). */
  setVisible(visible: boolean): unknown;
  onTabState(cb: (state: BrowserTabState) => void): () => void;
  onOpenRequest(cb: (req: BrowserOpenRequest) => void): () => void;
}

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

function openRequestUrl(req: BrowserOpenRequest): string | null {
  if (typeof req === 'string') return req || null;
  if (req && typeof req.url === 'string' && req.url) return req.url;
  return null;
}

// ── Store ────────────────────────────────────────────────────────────────────

interface BrowserStoreState {
  /** Ordered tab list — order is the strip order. */
  tabs: BrowserTabState[];
  activeTabId: string | null;
  /** Tabs pulsing for attention (agent-opened, plan §4 UX). */
  attentionTabIds: Record<string, true>;
  /** Entry-button pulse when an agent tab arrives while the pane is hidden
   * and the file viewer holds the center (file viewer wins precedence). */
  paneAttention: boolean;
  /** Denied window.open surfaced by main — offered as "open in new tab". */
  pendingOpenUrl: string | null;

  createTab: (partition?: BrowserPartition, url?: string) => Promise<string | null>;
  closeTab: (tabId: string) => void;
  selectTab: (tabId: string) => void;
  navigate: (tabId: string, rawInput: string) => void;
  goBack: (tabId: string) => void;
  goForward: (tabId: string) => void;
  reload: (tabId: string) => void;
  stop: (tabId: string) => void;

  handleTabState: (state: BrowserTabState) => void;
  handleOpenRequest: (req: BrowserOpenRequest) => void;
  acceptOpenRequest: () => Promise<void>;
  dismissOpenRequest: () => void;
  clearPaneAttention: () => void;
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  attentionTabIds: {},
  paneAttention: false,
  pendingOpenUrl: null,

  createTab: async (partition = 'user', url?) => {
    const api = getBrowserApi();
    if (!api) return null;
    try {
      const { tabId } = await api.createTab({ partition, url });
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
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      let activeTabId = s.activeTabId;
      if (activeTabId === tabId) {
        // Activate neighbor (same rule as the file-viewer tabs).
        activeTabId = tabs.length === 0 ? null : tabs[Math.min(idx, tabs.length - 1)].tabId;
      }
      const { [tabId]: _gone, ...attentionTabIds } = s.attentionTabIds;
      return { tabs, activeTabId, attentionTabIds };
    });
  },

  selectTab: (tabId) => {
    set((s) => {
      if (!s.tabs.some((t) => t.tabId === tabId)) return s;
      const { [tabId]: _seen, ...attentionTabIds } = s.attentionTabIds;
      return { activeTabId: tabId, attentionTabIds };
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

      // Agent-attention flash (plan §4 UX): a tab we didn't create locally on
      // the agent partition, or the Phase-2 openedByAgent flag turning on.
      const agentArrival =
        (!known && (incoming.partition === 'agent' || Boolean(incoming.openedByAgent))) ||
        (Boolean(incoming.openedByAgent) && !prev?.openedByAgent);

      let { attentionTabIds, paneAttention, activeTabId } = s;
      if (agentArrival) {
        attentionTabIds = { ...attentionTabIds, [incoming.tabId]: true };
        const dash = useDashboardStore.getState();
        if (!dash.browserOpen) {
          if (!dash.fileViewerOpen) {
            // Center pane is free — focus the browser so the human notices.
            dash.showBrowser();
          } else {
            // File viewer wins precedence; pulse the entry button instead.
            paneAttention = true;
          }
        }
        if (activeTabId === null) activeTabId = incoming.tabId;
      }
      return { tabs, attentionTabIds, paneAttention, activeTabId };
    });
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
  return true;
}

export function __resetBrowserBridgeForTests(): void {
  bridgeStarted = false;
}
