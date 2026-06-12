// WP1-A task 4 (plans/embedded-browser-implementation-tasks.md) — thin
// Electron glue over browser-decisions.ts. All policy lives in the pure
// module (unit-tested); this file only applies it to real sessions/views.
// Mitigations wired here: M2 (loopback filter), M3 (hardened webPreferences),
// M4 (managed-contents seam), M5 (permission deny-all), M6 (nav gates +
// popup deny), M7 (downloads denied), M9 (debugger attach rule).

import { randomUUID } from 'crypto';
import path from 'path';
import { app, session, WebContentsView } from 'electron';
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
import { CdpDriver } from './cdp-driver';
import { buildA11ySnapshot, RefRegistry } from './a11y-snapshot';
import { ActionAudit, AUDIT_FILE_NAME, hashArgs } from './action-audit';
import {
  browserActionsEnabled,
  browserToolsEnabled,
  checkAction,
  checkNavigation,
  PolicyError,
  wrapUntrusted,
  type BrowserToolVerb,
} from './browser-policy';
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
  /** Phase 2: set for tabs created by agent tools so the UI can flash them. */
  openedByAgent: boolean;
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

export interface BrowserToolProvider {
  openUrl(url: string, opts: { forHuman?: boolean }): Promise<TabSnapshot>;
  listTabs(): TabInfo[];
  getPageText(tabId: string): Promise<string>;
  readPage(tabId: string): Promise<string>;
  screenshot(tabId: string): Promise<{ base64Png: string }>;
  click(tabId: string, ref: number): Promise<string>;
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
  /** Lazily-attached CDP drivers, persist:agent tabs only (M9). */
  private drivers = new Map<string, CdpDriver>();
  /** Per-tab a11y ref bookkeeping (WP2-A; stale refs → typed error). */
  private refRegistries = new Map<string, RefRegistry>();
  /** M16 audit writer — lazy so app.getPath is only touched when a tool runs. */
  private auditWriter: ActionAudit | null = null;
  private toolsFacade: BrowserToolProvider | null = null;

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

  createTab(
    opts: BrowserCreateTabOptions,
    internal?: { openedByAgent?: boolean },
  ): { tabId: string } {
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
    const tab: TabEntry = {
      id: tabId,
      view,
      partition: opts.partition,
      partitionFull,
      openedByAgent: internal?.openedByAgent === true,
    };
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
    this.drivers.delete(tabId);
    this.refRegistries.delete(tabId);
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
        listTabs: () => this.toolListTabs(),
        getPageText: (tabId) => this.toolGetPageText(tabId),
        readPage: (tabId) => this.toolReadPage(tabId),
        screenshot: (tabId) => this.toolScreenshot(tabId),
        click: (tabId, ref) => this.toolClick(tabId, ref),
      };
    }
    return this.toolsFacade;
  }

  private get audit(): ActionAudit {
    if (!this.auditWriter) {
      this.auditWriter = new ActionAudit(() =>
        path.join(app.getPath('userData'), AUDIT_FILE_NAME),
      );
    }
    return this.auditWriter;
  }

  private auditRecord(
    partition: string,
    url: string,
    verb: string,
    args: unknown,
    outcome: string,
  ): void {
    this.audit.record({ partition, url, verb, argsHash: hashArgs(args), outcome });
  }

  /** Kill-switch + checkAction gate shared by every tool verb. Denials are
   *  audited (M16) and thrown as PolicyError (WP2-B maps name → 403). */
  private gate(
    verb: BrowserToolVerb,
    partitionFull: string,
    url: string | undefined,
    args: unknown,
  ): void {
    if (!browserToolsEnabled(process.env)) {
      this.auditRecord(partitionFull, url ?? '', verb, args, 'denied:tools-disabled');
      throw new PolicyError(
        'tools-disabled',
        'browser tools are disabled by the kill-switch (AGENT_BROWSER_TOOLS_DISABLED=1)',
      );
    }
    const decision = checkAction(verb, partitionFull, url, browserActionsEnabled(process.env));
    if (!decision.allow) {
      this.auditRecord(partitionFull, url ?? '', verb, args, `denied:${decision.code}`);
      throw new PolicyError(decision.code, decision.reason);
    }
  }

  private async toolOpenUrl(url: string, opts: { forHuman?: boolean }): Promise<TabSnapshot> {
    const forHuman = opts.forHuman === true;
    const verb: BrowserToolVerb = forHuman ? 'openUrlForHuman' : 'openUrl';
    const partitionFull = forHuman ? 'persist:user' : 'persist:agent';
    const args = { url, forHuman };

    // M11 applies to EVERY navigation, forHuman handoffs included.
    const nav = checkNavigation(url, { apiPort: this.controlPorts.apiPort });
    if (!nav.allow) {
      this.auditRecord(partitionFull, url, verb, args, `denied:${nav.code}`);
      throw new PolicyError(nav.code, nav.reason);
    }
    this.gate(verb, partitionFull, url, args);

    if (forHuman) {
      // M9 openUrlForHumanAction: a visible persist:user tab, focused in the
      // pane, URL rendered by the WP1-B address bar (shell chrome — model
      // output can't spoof it). NEVER attaches CDP; returns no page content.
      const { tabId } = this.createTab({ partition: 'user', url }, { openedByAgent: true });
      this.setActiveTab(tabId);
      this.auditRecord(partitionFull, url, verb, args, 'ok');
      return { tabId, url, partition: 'user' };
    }

    // Agent-partition browse (only reachable with the M12 toggle on): the tab
    // is created empty and navigated through the driver so the page-ready
    // wait lives here, not in the proxy scripts.
    const { tabId } = this.createTab({ partition: 'agent' }, { openedByAgent: true });
    try {
      await this.driver(tabId).navigateAndWait(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(partitionFull, url, verb, args, `error:${msg}`);
      throw err;
    }
    this.auditRecord(partitionFull, url, verb, args, 'ok');
    const snapshot = await this.snapshotTab(tabId);
    return {
      tabId,
      url: this.mustGet(tabId).view.webContents.getURL(),
      partition: 'agent',
      pageSnapshot: wrapUntrusted(snapshot),
    };
  }

  /** M9: lists persist:agent tabs ONLY — the human's tabs (URLs, titles) are
   *  never enumerable by tools. */
  private toolListTabs(): TabInfo[] {
    this.gate('listTabs', 'persist:agent', undefined, {});
    return [...this.tabs.values()]
      .filter((t) => t.partition === 'agent')
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
    this.gate('getPageText', tab.partitionFull, tab.view.webContents.getURL(), { tabId });
    const text = await this.driver(tabId).getText();
    return wrapUntrusted(text);
  }

  private async toolReadPage(tabId: string): Promise<string> {
    const tab = this.mustGet(tabId);
    this.gate('readPage', tab.partitionFull, tab.view.webContents.getURL(), { tabId });
    const snapshot = await this.snapshotTab(tabId);
    return (
      'Accessibility snapshot. Interactable elements are marked [n] — pass n as `ref` to click.\n' +
      wrapUntrusted(snapshot)
    );
  }

  private async toolScreenshot(tabId: string): Promise<{ base64Png: string }> {
    const tab = this.mustGet(tabId);
    this.gate('screenshot', tab.partitionFull, tab.view.webContents.getURL(), { tabId });
    return { base64Png: await this.driver(tabId).captureScreenshot() };
  }

  private async toolClick(tabId: string, ref: number): Promise<string> {
    const tab = this.mustGet(tabId);
    const url = tab.view.webContents.getURL();
    const args = { tabId, ref };
    this.gate('click', tab.partitionFull, url, args);

    const registry = this.refRegistries.get(tabId);
    if (!registry) {
      throw new Error('no snapshot exists for this tab — call readPage first to get refs');
    }
    const backendNodeId = registry.resolve(ref); // StaleRefError / UnknownRefError
    try {
      await this.driver(tabId).click(backendNodeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditRecord(tab.partitionFull, url, 'click', args, `error:${msg}`);
      throw err;
    }
    this.auditRecord(tab.partitionFull, url, 'click', args, 'ok');

    // Plan §5c: every action returns a fresh snapshot. Let the page react
    // (and any click-triggered navigation settle) before re-reading.
    await this.settleAfterAction(tab.view.webContents);
    const snapshot = await this.snapshotTab(tabId);
    return wrapUntrusted(snapshot);
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
      this.drivers.delete(tab.id);
      this.refRegistries.delete(tab.id);
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
      // Phase-1 shape kept intact: field absent (not false) for human tabs.
      ...(tab.openedByAgent ? { openedByAgent: true } : {}),
    };
    win.webContents.send(BROWSER_CHANNELS.tabState, state);
  }
}
