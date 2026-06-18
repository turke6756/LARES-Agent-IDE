import { app, BrowserWindow, crashReporter, dialog, protocol, net, session, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs';
import { loadPersistedTheme } from './theme-persistence';
import { initDatabase, getWorkspaces } from './database';
import { validateAndRepairClaudeJson, validateAndRepairWslClaudeJson } from './claude-config-repair';
import { checkManagedWebContents } from './security/webcontents-guard';
import { resolveConfined } from './security/path-confinement';
import { AgentSupervisor } from './supervisor';
import { registerIpcHandlers } from './ipc-handlers';
import { installExternalNavHandlers, forceCloseAllDetached, type DetachedWindowDeps } from './detached-windows';
import { WsServer } from './ws-server';
import { ApiServer, type BrowserToolProvider } from './api-server';
import { OrchestrationService } from './orchestration/service';
import { createDashboardClient } from './orchestration/dashboard-client';
import { pathToFileURL } from 'url';
import { wslToWindowsPath } from './path-utils';
import { shutdownJupyterServer } from './jupyter-server';
import { disposeKernelClient } from './jupyter-kernel-client';
import { closeAllWatchers as closeAllFsWatchers } from './fs-watcher';
import { JUPYTER_BASE_PORT, JUPYTER_PORT_RETRIES } from './control-ports';
import { buildChromeUA } from './browser/browser-decisions';
import { BrowserManager } from './browser/browser-manager';
import { registerBrowserIpc } from './browser/browser-ipc';
import { stripClaudeChildEnvInPlace } from './supervisor/env-sanitize';

// First executable statement of the main process, before any supervisor /
// runner construction: strip Claude Code child-session markers inherited when
// the app is launched from inside a claude terminal. Spawned claude.exe agents
// would otherwise behave as nested child sessions and stop persisting their
// transcripts (docs/BUG_claude-child-session-env-poisoning.md). The runners
// re-sanitize their spawn envs too (defense in depth).
const strippedClaudeEnvKeys = stripClaudeChildEnvInPlace(process.env);
if (strippedClaudeEnvKeys.length > 0) {
  console.warn(
    `[startup] dashboard appears to have been launched from inside a Claude Code session — ` +
    `sanitized spawn environment (removed: ${strippedClaudeEnvKeys.join(', ')})`
  );
}

// Crash visibility (2026-06-12): the main process died abruptly twice with no
// stack in the launch terminal, no Crashpad dump, and no WER entry — i.e. a
// native-level kill (suspected ConPTY). Two layers so the next crash leaves an
// artifact regardless of which side (native vs JS) it dies on.
//
// Layer 1: Crashpad minidumps for native crashes. Must be called before app
// ready; without it Electron writes no dump at all for a main-process native
// crash. Dumps land in %APPDATA%/agent-dashboard/Crashpad/reports.
crashReporter.start({ uploadToServer: false });

// Layer 2: JS-side last-gasp log. The terminal scrollback is the only place an
// uncaught exception is visible today, and it vanishes when the window closes.
// Append (never truncate) so a crash loop preserves history. Sync write — the
// process is about to die, there is no later flush.
const CRASH_LOG_PATH = path.join(app.getAppPath(), '.dashboard', 'main-crash.log');
function logCrash(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      CRASH_LOG_PATH,
      `\n[${new Date().toISOString()}] ${kind} (pid ${process.pid})\n${detail}\n`
    );
  } catch {
    // Logging must never make the crash worse.
  }
  console.error(`[${kind}]`, detail);
}
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  // Mirror Node's default behavior: an uncaught exception leaves the process
  // in an undefined state — exit rather than limp on with 20 live agents.
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  // Log only — unhandled rejections are survivable and killing the process
  // for one would turn a missing .catch() into a full dashboard outage.
  logCrash('unhandledRejection', reason);
});

// Prevent EPIPE crashes when stdout/stderr pipe is closed (e.g. parent shell exits)
process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

// Electron 41/Chromium 130+ blocks file://→http://127.0.0.1 iframe loads via
// Private Network Access preflights. Disable PNA and insecure-loopback checks
// for our locally-spawned Jupyter server embed. Must run before app.ready.
app.commandLine.appendSwitch(
  'disable-features',
  'PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks',
);

// G1 fail ladder round 2 (2026-06-11): Electron defaults
// `navigator.webdriver === true`, which is the highest-signal automation tell
// for Google's BotGuard sign-in check (slayzone 2026 Electron-migration notes:
// their #1 fix). This global switch's ONLY effect is flipping that flag to
// false — it removes the Blink AutomationControlled feature, attaches nothing,
// exposes nothing, and weakens no mitigation (M1–M16 untouched). Must run
// before app ready, like the disable-features switch above.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// WP1-A task 2: present as Chrome-stable everywhere, set before ANY window or
// session exists. Derived from the real engine version (buildChromeUA) so the
// UA can never drift from the running Chromium — Google sign-in inside the
// pane gates on the exact byte shape (Ferdium lesson; human gate G1).
// G1 fail ladder (2026-06-11): this fallback alone did NOT pass the Google
// sign-in gate — BrowserManager.hardenSession() now additionally sets the UA
// per pane session (#47979 hedge), and round 2 flips to a version-stripped UA
// on accounts.google.com via did-navigate (uaForUrl; Ferdium tactic). The
// fallback stays as the baseline for everything else.
app.userAgentFallback = buildChromeUA(process.versions.chrome);

let mainWindow: BrowserWindow | null = null;
// True only while `new BrowserWindow()` for the shell runs. The shell's
// 'web-contents-created' event fires synchronously inside that constructor,
// before `mainWindow` is assigned, so the `contents === mainWindow.webContents`
// identity check can't recognize it yet. This flag lets the M4 guard exempt the
// shell during its own construction (needed since the shell now runs
// sandbox:false, which otherwise trips the insecure-contents log).
let constructingShell = false;
// Trusted preload-bearing contexts beyond the shell — detached file-tab
// windows (detachable-file-tabs-plan §4 1.3). A detached BrowserWindow's
// 'web-contents-created' fires synchronously inside its constructor (before any
// post-construction add can run), so `constructingDetached` exempts it during
// its own construction exactly like `constructingShell` does for the shell;
// trustedContents then holds it after load (added BEFORE load, removed on close).
const trustedContents = new Set<Electron.WebContents>();
let constructingDetached = false;
// Resolved Vite dev-server origin (e.g. http://localhost:5173) once discovered
// in createWindow(), else null (packaged / no dev server → detached windows
// loadFile the built index.html). Threaded into the detached-window deps so a
// tear-off window loads from the same place the shell did.
let devServerUrl: string | null = null;
let supervisor: AgentSupervisor | null = null;
let wsServer: WsServer | null = null;
let apiServer: ApiServer | null = null;
let orchestration: OrchestrationService | null = null;
let browserManager: BrowserManager | null = null;

// Single-instance lock — prevent duplicate windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Another instance is already running — exiting.');
  app.quit();
}
app.on('second-instance', () => {
  // Focus the existing window when a second instance tries to launch
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Register media protocol before app is ready.
// WP0.3 / M8 (plans/embedded-browser-safety-deepdive.md): no `bypassCSP` —
// media:// content must obey page CSPs like any other resource.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// ── M4 global web-contents invariant guard (WP0.3, safety spec §3 M4) ──────
// Backstop, not policy: every webContents created in this process gets
// deny-by-default popups + webview attach. The shell re-registers its own
// setWindowOpenHandler in createWindow() (last registration wins) and stays
// authoritative; WP1-A's per-view handlers will do the same for browser tabs.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (e) => e.preventDefault());

  const isShell =
    constructingShell || constructingDetached ||
    (mainWindow !== null && contents === mainWindow.webContents) ||
    trustedContents.has(contents);
  if (isShell) return; // the shell / detached windows legitimately carry the dashboard preload

  // getLastWebPreferences() is not in the TS types — deliberate cast (see the
  // anchors table in plans/embedded-browser-implementation-tasks.md).
  const wp = (contents as unknown as {
    getLastWebPreferences?: () => Electron.WebPreferences | null;
  }).getLastWebPreferences?.();
  // getLastWebPreferences() returns null (not just undefined) for contents
  // whose prefs aren't available yet — e.g. during early construction. Use a
  // loose null check so a null return can't fall through to the wp.* deref
  // below (was `=== undefined`, which crashed with "Cannot read properties of
  // null (reading 'nodeIntegration')" on those contents).
  if (wp == null) {
    // Identity-tracking fallback: anything that is neither the shell nor a
    // manager-registered view (webcontents-guard seam) is unknown — loud-log.
    if (!checkManagedWebContents(contents)) {
      console.error(
        `[security] unknown web-contents created (type=${contents.getType()}, url=${contents.getURL() || '<none>'})`,
      );
    }
    return;
  }
  // Belt-and-suspenders: any non-shell view must be sandboxed, node-free,
  // and free of the dashboard preload. Log loudly on violation.
  if (wp.nodeIntegration || wp.sandbox === false || wp.preload) {
    console.error('[security] insecure web-contents created:', {
      type: contents.getType(),
      url: contents.getURL() || '<none>',
      nodeIntegration: wp.nodeIntegration,
      sandbox: wp.sandbox,
      preload: wp.preload,
    });
  }
});

// WP0.3 / M8 — workspace roots (Windows form) admitting media:// requests.
// WSL roots translate via wslpath (spawns wsl.exe for non-/mnt paths), so
// cache per workspace path; workspace roots don't move within a launch.
const wslRootWinCache = new Map<string, string>();
function getWorkspaceRootsWin(): string[] {
  const roots: string[] = [];
  for (const ws of getWorkspaces()) {
    if (ws.pathType === 'wsl') {
      let win = wslRootWinCache.get(ws.path);
      if (win === undefined) {
        win = wslToWindowsPath(ws.path);
        wslRootWinCache.set(ws.path, win);
      }
      roots.push(win);
    } else {
      roots.push(ws.path);
    }
  }
  return roots;
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.ico')
    : path.join(__dirname, '..', '..', '..', 'assets', 'icon.ico');

  const theme = loadPersistedTheme();
  nativeTheme.themeSource = theme;

  constructingShell = true;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    center: true,
    title: 'Agent Dashboard',
    icon: iconPath,
    // Hide the native title bar row ("Agent Dashboard") to reclaim vertical
    // space. The min/max/close buttons float top-right via the overlay, and
    // the menu bar (File / Edit / View / Help) becomes the top row.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: theme === 'light' ? '#f7f5f0' : '#1e1e1e',
      symbolColor: theme === 'light' ? '#1e1e1e' : '#f7f5f0',
      height: 32,
    },
    // Match the renderer surface-0 per theme — avoids a dark flash when
    // launching in light mode (and vice versa).
    backgroundColor: theme === 'light' ? '#f7f5f0' : '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // The shell is the one trusted preload-bearing context (see the
      // security guard ~L97: "any non-shell view must be sandboxed"). Electron
      // 20+ defaults renderers to sandbox:true, and a sandboxed preload can
      // only require('electron') + node builtins — NOT local modules. The WP1
      // browser pane made the preload import BROWSER_CHANNELS from
      // ../shared/browser (a runtime require), which a sandboxed preload
      // rejects, aborting before exposeInMainWorld('api') and leaving
      // window.api undefined. Disable sandbox for the shell so the trusted
      // preload can require shared modules; non-shell views stay sandboxed.
      sandbox: false,
      // Required so the file:// renderer can iframe-embed the locally-spawned
      // Jupyter server at http://127.0.0.1:<port>. Without this, Chromium
      // rejects the cross-origin iframe load with ERR_BLOCKED_BY_RESPONSE
      // before our webRequest header shim runs.
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  constructingShell = false;
  // The shell carries the dashboard preload — mark it trusted now that its
  // webContents exists (the constructingShell flag covered its construction).
  trustedContents.add(mainWindow.webContents);

  // Try Vite dev server first (check multiple ports), fall back to built files
  const builtFile = path.join(__dirname, '..', '..', 'renderer', 'index.html');

  if (process.env.NODE_ENV === 'production' || app.isPackaged) {
    mainWindow.loadFile(builtFile);
  } else {
    // Check if a Vite dev server is running before trying to connect
    const http = require('http');
    const tryPort = (port: number): Promise<boolean> =>
      new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => { req.destroy(); resolve(false); });
      });

    (async () => {
      for (const port of [5173, 5174, 5175]) {
        if (await tryPort(port)) {
          console.log(`Dev server found on port ${port}`);
          devServerUrl = `http://localhost:${port}`;
          mainWindow!.loadURL(devServerUrl);
          return;
        }
      }
      console.log('No dev server found, loading built files');
      mainWindow!.loadFile(builtFile);
    })();
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.error(`Page failed to load (mainFrame=${isMainFrame}): ${code} ${desc} url=${url}`);
  });

  // Externalize all link navigation. Without this, clicking an http(s) link
  // inside a markdown view replaces the dashboard with the external page and
  // there's no way back — closing the window to escape kills every agent.
  // Shared with detached windows (detachable-file-tabs-plan §4 1.3); the shell
  // behavior is unchanged by the extraction.
  installExternalNavHandlers(mainWindow);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  const shellContents = mainWindow.webContents;
  mainWindow.on('closed', () => {
    trustedContents.delete(shellContents);
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Strip any frame-blocking headers from Jupyter responses. Don't add CORS
  // headers here — `Access-Control-Allow-Origin: *` combined with
  // `Access-Control-Allow-Credentials: true` is an invalid pair that Chromium
  // rejects with ERR_BLOCKED_BY_RESPONSE. webSecurity:false on the window
  // already allows the cross-origin iframe load itself.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let isJupyter = false;
    try {
      const url = new URL(details.url);
      const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      const port = Number(url.port);
      isJupyter = isLoopback && Number.isInteger(port) && port >= JUPYTER_BASE_PORT && port <= JUPYTER_BASE_PORT + JUPYTER_PORT_RETRIES;
    } catch {
      isJupyter = false;
    }
    if (!isJupyter) return callback({});
    const headers: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      const key = k.toLowerCase();
      // Strip CSP and X-Frame-Options — the renderer is loaded from file://
      // (origin "null") and CSP `frame-ancestors *` per spec does NOT match
      // non-network schemes like file:/data:/blob:. Stripping lets the
      // file:// renderer iframe-embed Jupyter.
      if (key === 'x-frame-options') continue;
      if (key === 'content-security-policy') continue;
      if (key === 'content-security-policy-report-only') continue;
      headers[k] = Array.isArray(v) ? v : [String(v)];
    }
    callback({ responseHeaders: headers });
  });

  // Handle media:// protocol — URLs are media://file/<encodedPath>
  //
  // WP0.3 / M8 — SECURITY INVARIANTS, do not relax:
  //  1. Registered on the DEFAULT SESSION ONLY. ProtocolRequest exposes no
  //     sender frame, so per-request requester checks are impossible; session
  //     scoping is the gate. Browser partitions ('persist:user',
  //     'persist:agent') and the Phase-3 'surface' partition must NEVER get a
  //     media handler — there the scheme simply fails to resolve (and M6's
  //     scheme gates additionally deny media: navigations).
  //  2. The decoded path is confined to the open workspace roots via
  //     resolveConfined() (realpath: traversal and symlink escapes → 404).
  session.defaultSession.protocol.handle('media', async (request) => {
    const urlObj = new URL(request.url);
    // Path is /<encodedFilePath>, strip leading slash and decode
    const decodedUrl = decodeURIComponent(urlObj.pathname.slice(1));

    let filePath = decodedUrl;

    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = wslToWindowsPath(filePath);
    }

    const confined = resolveConfined(filePath, getWorkspaceRootsWin());
    if (confined === null) {
      console.warn(`[security] media:// request outside workspace roots rejected: ${request.url}`);
      return new Response('File not found', { status: 404 });
    }
    filePath = confined;

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(response.headers);
      
      // Explicitly set Content-Type based on extension if missing or generic
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.avif': 'image/avif',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
      };
      if (mimeMap[ext]) {
        headers.set('Content-Type', mimeMap[ext]);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      console.error('Failed to fetch media:', err);
      return new Response('File not found', { status: 404 });
    }
  });

  try {
    console.log('Initializing database...');
    initDatabase();
    console.log('Database initialized');

    // Validate + repair ~/.claude.json (Windows + WSL distro copies) BEFORE
    // the supervisor exists, i.e. before anything can spawn claude.exe — the
    // backstop for hard kills that bypass the shutdown drain. See
    // plans/claude-json-corruption-mitigation-v2.md Task 3.
    validateAndRepairClaudeJson();
    validateAndRepairWslClaudeJson();

    supervisor = new AgentSupervisor();
    createWindow();
    // Detached-window deps (detachable-file-tabs-plan §4 1.3/1.4). devServerUrl
    // and theme are read live via getters so a tear-off spawned long after
    // startup loads from the right origin and matches the current theme.
    const detachedWindowDeps: DetachedWindowDeps = {
      get devServerUrl() { return devServerUrl; },
      builtIndexHtml: path.join(__dirname, '..', '..', 'renderer', 'index.html'),
      get theme() { return loadPersistedTheme(); },
      trustedContents,
      setConstructingDetached: (v: boolean) => { constructingDetached = v; },
      getMainWindow: () => mainWindow,
    };
    registerIpcHandlers(supervisor, mainWindow!, detachedWindowDeps);
    supervisor.start();
    wsServer = new WsServer(supervisor);
    wsServer.start();
    // Construct the orchestration service in index.ts and inject it into
    // ApiServer (keeps AgentSupervisor free of orchestration concerns). The
    // deliver fn is the supervisor's in-process port of the script's
    // 409-retry [DASHBOARD EVENT] relay.
    orchestration = new OrchestrationService(
      createDashboardClient(supervisor),
      (supId, text) => supervisor!.deliverToSupervisor(supId, text),
    );
    apiServer = new ApiServer(supervisor, undefined, orchestration);
    // Class IV (plans/class-iv-worker-hook-scaffold.md): tell the supervisor the
    // port the API server actually bound to (handles EADDRINUSE auto-increment)
    // so supervised workers' Stop hooks POST to the right place. start()
    // resolves the bound port only once 'listening' fires (WP0.1), so this
    // can never observe a stale pre-retry port.
    const apiPort = await apiServer.start();
    supervisor.setApiServerPort(apiPort);
    // WP1-A: embedded browser pane (M2/M3/M5/M6/M7/M9-rule live in the
    // manager + browser-decisions). Constructed AFTER the awaited start() so
    // the M2 loopback filter blocks the ACTUAL bound API port, surviving the
    // EADDRINUSE auto-increment — never a hardcoded 24678.
    browserManager = new BrowserManager(() => mainWindow, apiPort);
    registerBrowserIpc(browserManager);
    // WP2-B ⇄ WP2-A seam: inject the Phase-2 browser-tool facade into the
    // API server. Setter, not constructor param, because the manager is
    // constructed AFTER the awaited apiServer.start() (its M2 filter needs
    // the bound port). Accessed structurally so this compiles before WP2-A's
    // `tools` facade lands on browser-manager; until then the optional read
    // is undefined and every /api/browser/* route answers 503 by design.
    const browserToolProvider = (browserManager as unknown as { tools?: BrowserToolProvider }).tools;
    if (browserToolProvider) apiServer.setBrowserTools(browserToolProvider);
    orchestration.start();                 // boot reconcile of orphaned runs
    supervisor.reconcile();
    console.log('App ready');
  } catch (err: any) {
    console.error('Startup error:', err);
    dialog.showErrorBox('Startup Error', err.message || String(err));
    app.quit();
  }
});

// Graceful shutdown: drain Windows claude.exe agents (/exit) before the app
// dies so their final ~/.claude.json flushes complete — see
// plans/claude-json-corruption-mitigation-v2.md Task 5. Known limitation:
// hard kills (`taskkill /F`, `concurrently -k` in `npm run dev`) bypass all
// in-process handlers; the startup validate+repair (Task 3) is the backstop
// for those paths.
let shutdownStarted = false;
let drainCompleted = false;
async function shutdownApp(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // Let any detached windows close without the dirty-on-close prompt so the
  // 'close' intercept can't deadlock quit (detachable-file-tabs-plan §2.2).
  forceCloseAllDetached();
  // Stop monitors BEFORE draining: a live StatusMonitor poll tick can infer
  // 'crashed' for a drained agent and auto-restart it mid-quit. (The
  // handleAutoRestart shuttingDown guard is the belt; this is the braces.)
  supervisor?.stop();
  try { await supervisor?.drainForShutdown(); }
  catch (err) { console.error('[shutdown] drain failed:', err); }
  drainCompleted = true;
  apiServer?.stop();
  wsServer?.stop();
  disposeKernelClient();
  void shutdownJupyterServer();
  closeAllFsWatchers();
  app.quit();
}

app.on('window-all-closed', () => { void shutdownApp(); });
app.on('before-quit', (e) => {
  // Gate on drainCompleted (not shutdownStarted): a quit fired mid-drain is
  // deferred until the drain finishes; shutdownApp's own reentrancy guard
  // prevents a second drain.
  if (!drainCompleted) { e.preventDefault(); void shutdownApp(); }
});

app.on('will-quit', () => {
  disposeKernelClient();
  void shutdownJupyterServer();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
