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
  /** Phase 2 (WP2-A) sets this for agent-opened tabs so the UI can flash
   *  the tab. Absent in Phase 1 — renderer treats missing as false. */
  openedByAgent?: boolean;
}

/** Pushed main → renderer when a page's window.open / target=_blank popup is
 *  denied (M6) — the UI may offer "open as new tab" instead. */
export interface BrowserOpenRequest {
  /** Tab whose page requested the popup. */
  tabId: string;
  url: string;
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
  /** main → renderer event channel (BrowserTabState payload) */
  tabState: 'browser:tab-state',
  /** main → renderer event channel (BrowserOpenRequest payload) */
  openRequest: 'browser:open-request',
} as const;
