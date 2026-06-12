// WP1-A task 4 (plans/embedded-browser-implementation-tasks.md) — thin
// Electron glue over browser-decisions.ts. All policy lives in the pure
// module (unit-tested); this file only applies it to real sessions/views.
// Mitigations wired here: M2 (loopback filter), M3 (hardened webPreferences),
// M4 (managed-contents seam), M5 (permission deny-all), M6 (nav gates +
// popup deny), M7 (downloads denied), M9 (debugger attach rule).

import { randomUUID } from 'crypto';
import { session, WebContentsView } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { setManagedWebContentsCheck } from '../security/webcontents-guard';
import { WS_PORT, JUPYTER_BASE_PORT, JUPYTER_PORT_RETRIES } from '../control-ports';
import {
  buildBrowserWebPreferences,
  buildChromeUA,
  decideLoopbackBlock,
  decideNavigation,
  mayAttachDebugger,
  uaForUrl,
  type ControlPorts,
} from './browser-decisions';
import {
  BROWSER_CHANNELS,
  type BrowserBounds,
  type BrowserCreateTabOptions,
  type BrowserPartition,
  type BrowserTabState,
} from '../../shared/browser';

interface TabEntry {
  id: string;
  view: WebContentsView;
  partition: BrowserPartition;
  /** Full Electron partition string ('persist:user' | 'persist:agent'). */
  partitionFull: string;
}

const PARTITION_FULL: Record<BrowserPartition, string> = {
  user: 'persist:user',
  agent: 'persist:agent',
};

export class BrowserManager {
  private tabs = new Map<string, TabEntry>();
  /** Latest favicon URL per tab (page-favicon-updated has no getter to re-read). */
  private tabFavicons = new Map<string, string | undefined>();
  private activeTabId: string | null = null;
  /** Pane suspension (z-order hazard: a WebContentsView always paints above
   *  renderer DOM, so renderer modals must be able to hide the pane). */
  private paneVisible = true;
  private lastBounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private controlPorts: ControlPorts;

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

    // Harden both pane partitions up-front (M2 + M5 + M7), before any view
    // can exist on them.
    for (const partition of Object.values(PARTITION_FULL)) {
      this.hardenSession(session.fromPartition(partition));
    }

    // M4 hookup: register into WP0's webcontents-guard seam so the global
    // invariant guard recognizes pane views as deliberately managed.
    setManagedWebContentsCheck((wc) => this.isManaged(wc));
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

    // M7: downloads denied on BOTH partitions day-one. Spec M7 would allow
    // confine+confirm on persist:user, but no native-confirm UX exists until
    // WP3 — this is a deliberate tightening, tracked in the plans doc's open
    // items ("user downloads disabled entirely until further notice").
    ses.on('will-download', (event) => {
      event.preventDefault();
    });
  }

  // ── Tab lifecycle ──────────────────────────────────────────────────────────

  createTab(opts: BrowserCreateTabOptions): { tabId: string } {
    const partitionFull = PARTITION_FULL[opts.partition];
    if (!partitionFull) throw new Error(`unknown partition: ${String(opts.partition)}`);

    // loadURL bypasses will-navigate, so the M6 gate must run here too.
    if (opts.url !== undefined) {
      const nav = decideNavigation(opts.url, opts.partition);
      if (!nav.allow) throw new Error(`navigation denied: ${nav.reason}`);
    }

    const view = new WebContentsView({
      webPreferences: {
        // M3: every field explicit from the pure builder — a pane view must
        // never inherit the shell's webSecurity:false / preload.
        ...buildBrowserWebPreferences(opts.partition),
        session: session.fromPartition(partitionFull),
      },
    });

    const tabId = randomUUID();
    const tab: TabEntry = { id: tabId, view, partition: opts.partition, partitionFull };
    this.tabs.set(tabId, tab);
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
    return { tabId };
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
    this.getMainWindow()?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
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
    if (tabId !== null && !this.tabs.has(tabId)) throw new Error(`unknown tab: ${tabId}`);
    this.activeTabId = tabId;
    const active = tabId === null ? null : this.tabs.get(tabId)!;
    if (active) {
      const win = this.getMainWindow();
      // Re-adding an existing child raises it to the top of the view stack.
      win?.contentView.addChildView(active.view);
      active.view.setBounds(this.lastBounds);
    }
    this.applyVisibility();
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

  private applyVisibility(): void {
    for (const tab of this.tabs.values()) {
      tab.view.setVisible(this.paneVisible && tab.id === this.activeTabId);
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
    if (!mayAttachDebugger(tab.partitionFull)) {
      throw new Error(`M9: debugger attach refused on partition ${tab.partitionFull}`);
    }
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    return dbg;
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
      }
    });
    wc.on('will-redirect', (event, url) => {
      const nav = decideNavigation(url, tab.partition);
      if (!nav.allow) {
        console.warn(`[browser] M6 redirect denied (tab ${tab.id}): ${nav.reason}`);
        event.preventDefault();
      }
    });
    wc.on('will-frame-navigate', (details) => {
      const nav = decideNavigation(details.url, tab.partition);
      if (!nav.allow) {
        console.warn(`[browser] M6 frame nav denied (tab ${tab.id}): ${nav.reason}`);
        details.preventDefault();
      }
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

    // Tab-state push (frozen contract: onTabState).
    const push = () => this.sendTabState(tab);
    wc.on('did-start-loading', push);
    wc.on('did-stop-loading', push);
    wc.on('did-navigate', push);
    wc.on('did-navigate-in-page', push);
    wc.on('page-title-updated', push);
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.tabFavicons.set(tab.id, favicons[0]);
      push();
    });
    wc.once('destroyed', () => {
      this.tabFavicons.delete(tab.id);
      this.tabs.delete(tab.id);
      if (this.activeTabId === tab.id) this.activeTabId = null;
    });
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
    };
    win.webContents.send(BROWSER_CHANNELS.tabState, state);
  }
}
