import { app, BrowserWindow, crashReporter, dialog, protocol, session, nativeTheme, ipcMain } from 'electron';
import { powerMonitor } from 'electron';
import { registerLifecycleIpc, LIFECYCLE_CHANNELS, type BulkStopDeps } from './lifecycle/lifecycle-ipc';
import { loadLifecycleSettings, saveLifecycleSettings } from './lifecycle/lifecycle-settings';
import { IdleSweep } from './lifecycle/idle-sweep';
import path from 'path';
import fs from 'fs';
import { loadPersistedTheme } from './theme-persistence';
import {
  initDatabase, getWorkspaces, getActiveAgents,
  getPlan, getWorkspace, listOrchestrationRuns, getLiveRailAgentForPlan, getPlanEventsForRender,
} from './database';
import { createHash } from 'crypto';
import { readFileContents } from './file-reader';
import { getServedPlanProjection } from './plans/watch-plans';
import { trailMaterializer } from './plans/execution-trail-writer';
import { EXEC_TRAIL_MAX_ENTRIES, observedViaLabel, type TrailEntry } from './plans/execution-trail';
import { formatRepoDigest } from './plans/repo-activity';
import { validateAndRepairClaudeJson, validateAndRepairWslClaudeJson, startClaudeJsonRuntimeWatcher, stopClaudeJsonRuntimeWatcher } from './claude-config-repair';
import { checkManagedWebContents } from './security/webcontents-guard';
import { AgentSupervisor } from './supervisor';
import { startContinuationWatcher } from './supervisor/continuation-watcher-wiring';
import { registerIpcHandlers } from './ipc-handlers';
import { installExternalNavHandlers, forceCloseAllDetached, getDetachedEntries, type DetachedWindowDeps } from './detached-windows';
import { runCloseFlush, type FlushTarget } from './close-flush';
import { TAB_CHANNELS, type FlushRequestPayload } from '../shared/types';
import { WsServer } from './ws-server';
import { ApiServer, type BrowserToolProvider } from './api-server';
import { OrchestrationService } from './orchestration/service';
import { createDashboardClient } from './orchestration/dashboard-client';
import { wslToWindowsPath } from './path-utils';
import { registerMediaProtocol } from './media-protocol';
import { shutdownJupyterServer } from './jupyter-server';
import { disposeKernelClient } from './jupyter-kernel-client';
import { closeAllWatchers as closeAllFsWatchers } from './fs-watcher';
import { startPlansWatcher, PlansWatcher } from './plans-watcher';
import { configureReparser, reparsePlanFile } from './plans/watch-plans';
import { JUPYTER_BASE_PORT, JUPYTER_PORT_RETRIES } from './control-ports';
import { buildChromeUA } from './browser/browser-decisions';
import { BrowserManager } from './browser/browser-manager';
import { registerBrowserIpc } from './browser/browser-ipc';
import { PlanPaneManager } from './plans/plan-pane-manager';
import { registerPlanIpc } from './plans/plan-ipc';
import { stripClaudeChildEnvInPlace } from './supervisor/env-sanitize';
import { installShellSpellcheckContextMenu } from './spellcheck-context-menu';
import { MemorySampler } from './watchdog/memory-sampler';
import { createCommitReader, type NativeCommitProvider } from './watchdog/commit-reader';
import { RenderRecoveryPolicy } from './watchdog/render-recovery';
import type { MemorySnapshot, AdmissionDecision } from './watchdog/types';
// WAVE-4 full-D5: per-agent attribution + budgets service (owns the periodic
// process-memory snapshot, the cached rollup, and the budget/owned-cap admission
// helpers). Constructed at ready alongside the sampler.
import { AttributionService } from './watchdog/attribution-service';
import { parseAnalyticsSnapshotArgv, flushStdio } from './analytics-export/analytics-snapshot-argv';
import {
  listDetachedProcesses,
  detachedDirFor,
  defaultDetachedRegistryDeps,
} from './detached-process-registry';

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

/** Join a workspace-relative `plans/…` path onto the workspace root (host sep).
 *  Mirrors api-server.ts `absPlanPath` — kept local to avoid a cross-module import
 *  for the Execution-Trail materializer wiring. */
function planAbsPath(wsPath: string, relPath: string): string {
  const sep = wsPath.includes('\\') ? '\\' : '/';
  const base = wsPath.replace(/[\\/]+$/, '');
  return `${base}${sep}${relPath.replace(/\//g, sep)}`;
}
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

// ── WP1 (G1): headless analytics-snapshot CLI mode ──────────────────────────
// `<binary> --analytics-snapshot export --json …` runs the snapshot CLI inside
// this compiled app binary (asar-safe, packaged builds included) and exits.
// Evaluated BEFORE the single-instance lock, any BrowserWindow, and all
// supervisor construction: the export must run while a dashboard instance is
// open (no lock contention) and must never spawn UI. Exit codes pass through
// verbatim (0 ok / 2 partial / 4 cold index) via app.exit — app.quit() always
// exits 0 and would silently erase them.
const analyticsSnapshotArgv = parseAnalyticsSnapshotArgv(process.argv);
if (analyticsSnapshotArgv !== null) {
  const finishSnapshotCli = (code: number): void => {
    process.exitCode = code;
    void flushStdio().then(() => app.exit(code));
  };
  app.whenReady()
    .then(() => {
      // Lazy require so normal startup never pays for the exporter machinery
      // (and snapshot mode stays decoupled from the UI import graph above).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runSnapshotCli } = require('./analytics-export/analytics-snapshot-cli') as
        typeof import('./analytics-export/analytics-snapshot-cli');
      return runSnapshotCli(analyticsSnapshotArgv);
    })
    .then(finishSnapshotCli)
    .catch((err: Error) => {
      process.stderr.write(`analytics-snapshot: fatal: ${err.message}\n`);
      finishSnapshotCli(1);
    });
}

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
// Idle-agent lifecycle §B9 — the automatic stale-idle sweep. Armed after
// app.whenReady(); stopped (and drained) by shutdownApp.
let idleSweep: IdleSweep | null = null;
// D5-lite memory watchdog + D1 shell-crash recovery policy (incident-2026-07-11
// §5). Constructed at ready once the supervisor + browser manager exist (their
// counts feed the sampler); referenced lazily by the shell's render-process-gone
// handler installed in createWindow(). Null before ready / after teardown.
let memorySampler: MemorySampler | null = null;
let renderRecovery: RenderRecoveryPolicy | null = null;
// WAVE-4 full-D5: per-agent memory attribution + budget/owned-cap admission.
let attributionService: AttributionService | null = null;
// WP5 mount: the sandboxed plan render pane (one WebContentsView, driven by the
// renderer's plan-tab bounds handoff). Constructed once at ready.
let planPaneManager: PlanPaneManager | null = null;
// B2 D5: per-workspace `plans/` watcher (sole `plans/` fs subscription owner, F-C).
let plansWatcher: PlansWatcher | null = null;

// Single-instance lock — prevent duplicate windows. Skipped in analytics-
// snapshot mode (WP1): the headless CLI must neither steal the lock from a
// running dashboard nor be refused by it.
if (analyticsSnapshotArgv === null) {
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
}

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
      // surface-base, so the native caption buttons sit on the same shade as
      // the renderer title bar (TopBar uses .panel-header = surface-base).
      color: theme === 'light' ? '#edeae3' : '#181818',
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
      spellcheck: true,
    },
  });
  constructingShell = false;
  // The shell carries the dashboard preload — mark it trusted now that its
  // webContents exists (the constructingShell flag covered its construction).
  trustedContents.add(mainWindow.webContents);
  try {
    session.defaultSession.setSpellCheckerLanguages(['en-US']);
  } catch {
    // Best-effort: Windows' native OS spellchecker remains authoritative.
  }
  installShellSpellcheckContextMenu(mainWindow);

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

  // D1 (incident-2026-07-11 §5): shell renderer-crash recovery. Before this, a
  // dead shell renderer left a permanent white screen while the backend kept
  // running (the whole outage's visible symptom). We (1) log the reason/exitCode
  // — closing evidence gap §7 Q3 for future incidents — (2) check memory pressure
  // via the D5 sampler, (3) reload when pressure permits (bounded 3/5min), else
  // (4) show a low-allocation native dialog. Wave-1 dialog actions only: reload
  // (when the user opts to) or quit; the "reap & reload" action arrives with D3/D4.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(
      `[D1] shell renderer gone: reason=${details.reason} exitCode=${details.exitCode}`,
    );
    handleShellRenderProcessGone();
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

  // Edit-loss §4.3: main-window close flush handshake. Closing the shell used
  // to silently drop dirty editor tabs — in the main window AND in every
  // detached file window (whose force-close path bypasses the per-window
  // prompt on app quit). Now the close is intercepted, every editing renderer
  // flushes via its save coordinator, and any conflict/error/timeout raises a
  // native dialog (Keep waiting / Overwrite anyway / Discard and close /
  // Cancel) — never a silent close. The shutdownStarted guard keeps an
  // already-running quit (which force-closes windows) from deadlocking on
  // preventDefault; OS-forced session end Electron cannot delay remains a
  // documented best-effort exception.
  let closeFlushState: 'idle' | 'running' | 'cleared' = 'idle';
  mainWindow.on('close', (e) => {
    if (closeFlushState === 'cleared' || shutdownStarted) return;
    e.preventDefault();
    if (closeFlushState === 'running') return;
    closeFlushState = 'running';
    const targets = (): FlushTarget[] => {
      const wins: Array<{ id: string; label: string; wc: Electron.WebContents }> = [];
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        wins.push({ id: `main:${mainWindow.id}`, label: 'Main window', wc: mainWindow.webContents });
      }
      // Every detached file window participates in the same handshake —
      // enumerate the live registry (plan §4.3.2).
      for (const { win, req } of getDetachedEntries()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          wins.push({ id: `detached:${win.id}`, label: req.label, wc: win.webContents });
        }
      }
      return wins.map(({ id, label, wc }) => ({
        id,
        label,
        send: (payload: FlushRequestPayload) => wc.send(TAB_CHANNELS.flushRequest, payload),
        isAlive: () => !wc.isDestroyed(),
      }));
    };
    void runCloseFlush({
      targets,
      showDialog: async (opts) => {
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const boxOpts = { type: 'warning' as const, title: 'Unsaved changes', noLink: true, ...opts };
        const r = parent
          ? await dialog.showMessageBox(parent, boxOpts)
          : await dialog.showMessageBox(boxOpts);
        return r.response;
      },
    })
      .then((proceed) => {
        if (proceed) {
          closeFlushState = 'cleared';
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        } else {
          closeFlushState = 'idle';
        }
      })
      .catch((err) => {
        // Never trap the user in an unclosable window on a handshake bug.
        console.error('[close-flush] handshake failed — allowing close', err);
        closeFlushState = 'cleared';
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      });
  });

  const shellContents = mainWindow.webContents;
  mainWindow.on('closed', () => {
    trustedContents.delete(shellContents);
    // WP5 mount: tear down the plan render pane's WebContentsView with its host
    // window so it can't outlive the shell.
    planPaneManager?.destroy();
    mainWindow = null;
  });
}

/** Combine two admission decisions: the FIRST refusal wins (so the caller sees
 *  exactly one machine-readable code), else allowed. Used to layer the full-D5
 *  attribution gates on top of the D5-lite sampler gates. */
function firstRefusal(a: AdmissionDecision, b: AdmissionDecision): AdmissionDecision {
  if (!a.allowed) return a;
  if (!b.allowed) return b;
  return { allowed: true };
}

/** D1 "reap & reload" (Wave 2+ dialog action, wired in Wave 4 now D3/D4 exist):
 *  free renderer + CLI memory before reloading into a pressured machine — run the
 *  D3 agent-view discard pass and one D4 reaper sweep, then reload the shell. */
async function reapAndReloadShell(): Promise<void> {
  try { browserManager?.discardAgentViewsNow(); } catch (e) { console.warn('[D1] discard sweep failed:', e); }
  try {
    const swept = await supervisor?.reapNow();
    if (swept) console.warn(`[D1] reap-now: ${swept.reaped.length} reaped of ${swept.eligible} eligible`);
  } catch (e) { console.warn('[D1] reap-now failed:', e); }
  renderRecovery?.onRecovered(); // manual action → reset the retry budget
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once('did-finish-load', () => browserManager?.onShellRecovered());
    mainWindow.reload();
  }
}

/**
 * D1 shell renderer-crash recovery decision + side effects (incident-2026-07-11
 * §5 D1). Pure decision lives in RenderRecoveryPolicy; this owns the reload /
 * dialog side effects and the D2 recovery handshake. Safe to call before the
 * watchdog is constructed (renderRecovery null ⇒ default to a bounded reload).
 */
function handleShellRenderProcessGone(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  const criticalPressure = memorySampler?.isCriticalPressure() ?? false;
  // No policy yet (crash during early startup) → one plain reload attempt.
  const decision = renderRecovery
    ? renderRecovery.registerCrashAndDecide(Date.now(), criticalPressure)
    : { action: 'reload' as const, reason: 'reload' as const };

  if (decision.action === 'reload') {
    console.warn('[D1] reloading shell renderer (pressure OK, within retry budget)');
    // On the next successful load, reset the retry budget and re-sync the browser
    // pane (D2: resubscribe + full snapshot so the reloaded UI reflects live tabs).
    win.webContents.once('did-finish-load', () => {
      renderRecovery?.onRecovered();
      browserManager?.onShellRecovered();
      console.warn('[D1] shell renderer reload committed; recovery complete');
    });
    win.reload();
    return;
  }

  // Dialog path: critical pressure (reloading into a machine at the ceiling
  // invites a crash loop) or the retry budget is exhausted.
  const critical = decision.reason === 'critical-pressure';
  const detail = critical
    ? 'The dashboard renderer stopped and the system is under critical memory ' +
      'pressure. Reloading now would likely crash again. "Reap & reload" frees ' +
      'memory first (suspends idle agent tabs and reclaims finished agents’ ' +
      'processes), then reloads. Or free memory yourself and reload, or restart.'
    : 'The dashboard renderer stopped and automatic reload attempts were ' +
      'exhausted. You can reap & reload, reload manually, or restart the app.';
  // Wave-4 (D3/D4 now exist): the "Reap & reload" action triggers the D3 agent-
  // view discard pass + one D4 reaper sweep before reloading — the recommended
  // action under Critical pressure (reloading into a full machine crash-loops).
  void dialog
    .showMessageBox(win, {
      type: 'warning',
      title: 'Dashboard renderer stopped',
      message: 'The dashboard view stopped responding.',
      detail,
      buttons: ['Reap & reload', 'Reload', 'Quit'],
      defaultId: critical ? 0 : 1,
      cancelId: 2,
      noLink: true,
    })
    .then((res) => {
      if (res.response === 0) {
        void reapAndReloadShell();
      } else if (res.response === 1) {
        // User override: reload regardless of pressure. Reset the budget so this
        // manual reload isn't immediately re-blocked as "retries exhausted".
        renderRecovery?.onRecovered();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.once('did-finish-load', () => {
            browserManager?.onShellRecovered();
          });
          mainWindow.reload();
        }
      } else {
        app.quit();
      }
    })
    .catch((err) => console.error('[D1] recovery dialog failed:', err));
}

app.whenReady().then(async () => {
  // WP1: the analytics-snapshot branch above owns this launch end-to-end —
  // no window, no supervisor, no servers.
  if (analyticsSnapshotArgv !== null) return;
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

  try {
    console.log('Initializing database...');
    initDatabase();
    console.log('Database initialized');

    registerMediaProtocol(session.defaultSession.protocol, {
      workspaceRoots: getWorkspaceRootsWin(),
      translateWslPath: wslToWindowsPath,
      onRejected: (requestUrl) => {
        console.warn(`[security] media:// request outside workspace roots rejected: ${requestUrl}`);
      },
    });

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
      // View tear-off re-parenting for the native-view-backed views: move the
      // plan pane / browser tabs into the detached window on detach, home on
      // close. The managers are constructed later in this same ready handler, so
      // these closures read the module-level `let`s lazily at fire time (a detach
      // can only happen long after the managers exist).
      onViewWindowReady: (view, win) => {
        if (view === 'plans') planPaneManager?.reparentTo(win);
        else if (view === 'browser') browserManager?.reparentTo(win);
      },
      onViewWindowClosing: (view) => {
        if (view === 'plans') planPaneManager?.reparentHome();
        else if (view === 'browser') browserManager?.reparentHome();
      },
    };
    registerIpcHandlers(supervisor, mainWindow!, detachedWindowDeps);
    supervisor.start();
    // Runtime ~/.claude.json repair watcher. MUST be armed here — BEFORE
    // orchestration.start() / supervisor.reconcile() can respawn the claude
    // herd that manufactures the corruption this heals. Non-blocking +
    // reentrant; reuses the same pure repair + read-stability gate as the
    // startup backstop. See plans/claude-json-corruption-v3-runtime-repair-IMPL.md.
    startClaudeJsonRuntimeWatcher();
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
    // Push the active-deliberation supervisor set to the renderer on every
    // run-status transition. This keeps the owner-container border pulsing
    // through the idle gaps between groupthink turns (when both planners are
    // momentarily idle but the run is still alive), independent of per-agent
    // status flips. The renderer seeds its initial state via the IPC handle
    // below — the broadcast only fires on change.
    orchestration.on('activeRunsChanged', (supervisorIds: string[]) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orchestration:active-changed', supervisorIds);
      }
    });
    ipcMain.handle('orchestration:list-active', () => orchestration?.activeSupervisorIds() ?? []);
    apiServer = new ApiServer(supervisor, undefined, orchestration);
    // Class IV (plans/class-iv-worker-hook-scaffold.md): tell the supervisor the
    // port the API server actually bound to (handles EADDRINUSE auto-increment)
    // so supervised workers' Stop hooks POST to the right place. start()
    // resolves the bound port only once 'listening' fires (WP0.1), so this
    // can never observe a stale pre-retry port.
    const apiPort = await apiServer.start();
    supervisor.setApiServerPort(apiPort);
    // B2 D5 + WP4 (F-C): boot the plans watcher with the reparse callback.
    // `plans-watcher.ts` is the SOLE `plans/` subscription owner; WP4 injects
    // `onPlanSettled` (a constructor dep, not a hard import) so each settled live
    // plan row is reparsed → section-cache → plan_section_changes → snapshot.
    configureReparser();
    plansWatcher = startPlansWatcher({
      onPlanSettled: async (plan) => {
        const outcome = await reparsePlanFile(plan);
        // WP5: fs change → reparse → full re-render. The reparse just refreshed
        // the served projection (last-good in memory); tell the renderer to
        // re-fetch and re-render this plan surface. This rides the SAME reparse
        // path — NOT a second `plans/` fs subscription (F-C: plans-watcher owns
        // the only one). No in-place DOM patching: the renderer does a full
        // re-render off the fresh projection.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('plan-surface:changed', {
            planId: outcome.planId,
            parseError: outcome.parseError,
            degradedFrom: outcome.degradedFrom,
          });
        }
        // WP5 mount: re-render the sandboxed pane from the freshly-served
        // projection (no-op unless THIS plan is the one currently shown).
        planPaneManager?.refresh(outcome.planId);
      },
    });
    // GT-C Decision 1 (Configure site) — arm the Execution-Trail materializer ONCE,
    // now that the DB, the served-projection/reparse pipeline, and workspace
    // resolution are all live. Every dep re-derives from DB/fs on demand so the
    // materialized `sec_exectr` cache and `plan_events` can never diverge.
    trailMaterializer.configure({
      readPlanFile: async (planId) => {
        const plan = getPlan(planId);
        if (!plan || plan.deletedAt) return null;
        const ws = getWorkspace(plan.workspaceId);
        if (!ws) return null;
        const fc = await readFileContents(planAbsPath(ws.path, plan.path), ws.pathType);
        if (fc.error || typeof fc.content !== 'string') return null;
        return fc.content;
      },
      writePlanFile: async (planId, html) => {
        const plan = getPlan(planId);
        if (!plan || plan.deletedAt) return;
        const ws = getWorkspace(plan.workspaceId);
        if (!ws) return;
        // Resolve to a host-writable path (WSL plans convert to their \\wsl$ UNC
        // form). Atomic: write a sibling tmp then rename over the target.
        let abs = planAbsPath(ws.path, plan.path);
        if (ws.pathType === 'wsl') abs = wslToWindowsPath(abs);
        const tmp = `${abs}.exectr.tmp`;
        fs.writeFileSync(tmp, html, 'utf8');
        fs.renameSync(tmp, abs);
      },
      // Rec #5 (planning-surface-hardening-review) — compare-and-swap write. The
      // sibling CAS writer calls this optional dep so a human/out-of-band save that
      // lands after the materializer's last reread cannot be clobbered; without it
      // the writer runs its weaker fallback.
      writePlanFileIfUnchanged: async (planId, html, expectedHash) => {
        const plan = getPlan(planId);
        if (!plan || plan.deletedAt) return 'conflict';
        const ws = getWorkspace(plan.workspaceId);
        if (!ws) return 'conflict';
        let abs = planAbsPath(ws.path, plan.path);
        if (ws.pathType === 'wsl') abs = wslToWindowsPath(abs);
        // Atomic compare-and-swap: synchronous reread → hash-compare → rename with
        // no intervening event-loop turn, so a human/out-of-band save landing after
        // the materializer's last reread cannot be clobbered (review rec #5).
        let current: string;
        try {
          current = fs.readFileSync(abs, 'utf8');
        } catch {
          return 'conflict'; // vanished/unreadable under us → treat as contention
        }
        if (createHash('sha256').update(current, 'utf8').digest('hex') !== expectedHash) {
          return 'conflict';
        }
        const tmp = `${abs}.exectr.tmp`;
        fs.writeFileSync(tmp, html, 'utf8');
        fs.renameSync(tmp, abs);
        return 'written';
      },
      hasLiveOrchestration: (planId, exemptRunId) =>
        listOrchestrationRuns().some(
          (r) => r.planId === planId && r.runId !== exemptRunId && (r.status === 'starting' || r.status === 'running'),
        ),
      getLiveRailAgentForPlan: (planId, exemptAgentIds) => getLiveRailAgentForPlan(planId, exemptAgentIds),
      listTrailEntries: (planId) => {
        const projection = getServedPlanProjection(planId);
        const headingFor = (anchor: string | null): string => {
          if (!anchor) return '(unattributed)';
          const s = projection?.sections.find((x) => x.anchor === anchor);
          return s?.heading ?? anchor;
        };
        const writes = getPlanEventsForRender(planId).filter((e) => e.changeCount > 0);
        const last = writes.slice(-EXEC_TRAIL_MAX_ENTRIES); // oldest→newest, last ≤200
        return last.map((e): TrailEntry => {
          return {
            planEventId: e.id,
            createdAt: e.createdAt,
            agentTitle: e.agentTitle ?? e.agentId,
            sectionHeading: headingFor(e.observedSectionAnchor),
            viaLabel: observedViaLabel(e.observedVia),
            // P0 Fix-1 (planning-surface-hardening-review) — the claimed self-report
            // (`e.claimedPayload.result`) is agent narration and is DELIBERATELY NOT
            // surfaced on the system-owned trail line. Only server-derived fields
            // (attribution + observed-via) and the witnessed digest below are
            // rendered, so a forged `result` can never sit beside trusted attribution.
            // Fix-4 §5c — the witnessed digest for this write-turn (null when no
            // repo activity was captured). `e.repoActivity` is the tolerantly-parsed
            // blob from getPlanEventsForRender.
            repoDigest: formatRepoDigest(e.repoActivity?.totals ?? null),
          };
        });
      },
      hashHtml: (html) => createHash('sha256').update(html, 'utf8').digest('hex'),
    });
    // Context-brick Inc 5A — replace the relaunch route's conservative
    // awaiting-human stub with the real predicate (question-waiting latch OR
    // idle + ends-with-question cache).
    const supervisorForWatcher = supervisor;
    apiServer.isAwaitingHuman = (agentId) => supervisorForWatcher.isAwaitingHuman(agentId);
    // Inc 5B — lifecycle watcher: rides the StatusMonitor poll tick and calls
    // the authenticated continuation routes over the loopback API.
    startContinuationWatcher(supervisorForWatcher, apiPort);
    // WP1-A: embedded browser pane (M2/M3/M5/M6/M7/M9-rule live in the
    // manager + browser-decisions). Constructed AFTER the awaited start() so
    // the M2 loopback filter blocks the ACTUAL bound API port, surviving the
    // EADDRINUSE auto-increment — never a hardcoded 24678.
    browserManager = new BrowserManager(() => mainWindow, apiPort);
    registerBrowserIpc(browserManager);
    // WP5 mount: the plan render pane + its data/lifecycle IPC. Same factory
    // pattern as the browser manager (`() => mainWindow`); kept out of
    // ipc-handlers.ts to avoid contention, exactly like registerBrowserIpc.
    planPaneManager = new PlanPaneManager(() => mainWindow);
    registerPlanIpc(planPaneManager);
    // WP2-B ⇄ WP2-A seam: inject the Phase-2 browser-tool facade into the
    // API server. Setter, not constructor param, because the manager is
    // constructed AFTER the awaited apiServer.start() (its M2 filter needs
    // the bound port). Accessed structurally so this compiles before WP2-A's
    // `tools` facade lands on browser-manager; until then the optional read
    // is undefined and every /api/browser/* route answers 503 by design.
    const browserToolProvider = (browserManager as unknown as { tools?: BrowserToolProvider }).tools;
    if (browserToolProvider) apiServer.setBrowserTools(browserToolProvider);

    // ── D3.1 agent-tab grace-close (incident-2026-07-11 §5 D3) ────────────────
    // When the supervisor flips an agent to a terminal status, arm a grace-close
    // of that agent's browser tabs (exempting signin/attention tabs, evaluated at
    // fire time); any non-terminal transition cancels a pending close (the agent
    // is live again). The browser manager owns the timer + exemption logic.
    supervisor.on('statusChanged', (data: { agentId: string; status: string }) => {
      const terminal = data.status === 'done' || data.status === 'crashed';
      browserManager?.onAgentLifecycleStatus(data.agentId, terminal);
    });

    // ── Idle-agent lifecycle §B7/§B9 — guards, IPC and the stale-idle sweep ───
    // Wired HERE because the two out-of-supervisor guard sources (browser tabs,
    // active deliberations) only exist at this point. The sweep is armed after
    // app.whenReady() (we are inside it) — powerMonitor throws if touched
    // earlier.
    supervisor.setLifecycleGuardSources({
      getAgentBrowserState: (agentId) => browserManager?.getAgentBrowserState(agentId) ?? null,
      activeOrchestrationIds: () => orchestration?.activeSupervisorIds() ?? [],
    });
    const lifecycleDeps: BulkStopDeps = {
      stopIfEligible: (agentId, mode, reason, o) => supervisor!.stopIfEligibleLocked(agentId, mode, reason, o),
      listAgents: () => getActiveAgents().map((a) => ({ id: a.id, status: a.status, idleSince: a.idleSince ?? null })),
      get guardDeps() { return supervisor!.guardDeps; },
      loadSettings: () => loadLifecycleSettings(),
      saveSettings: (s) => saveLifecycleSettings(s),
      broadcastSettings: (s) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(LIFECYCLE_CHANNELS.settingsChanged, s);
        }
      },
    };
    registerLifecycleIpc(ipcMain, lifecycleDeps);
    idleSweep = new IdleSweep({ ...lifecycleDeps, powerMonitor });
    idleSweep.start();

    // ── D5-lite memory watchdog + admission control (incident-2026-07-11 §5) ──
    // Now that the supervisor + browser manager exist (their live counts feed the
    // sampler), construct the sampler, arm the admission gates, install the D1
    // recovery policy, and start sampling. Everything degrades gracefully: the
    // native module load is try/caught (→ null → commit rules fail-open, static
    // caps stay fail-closed), and the sampler never keeps the event loop alive.
    let nativeCommit: NativeCommitProvider | null = null;
    try {
      // dist/main/main/index.js → repo root is ../../.. ; the native module ships
      // outside dist (native/lares-native). Its index.js never throws at require
      // time (graceful no-op surface off-Windows / when the binary is missing).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nativeCommit = require(
        path.join(__dirname, '..', '..', '..', 'native', 'lares-native', 'index.js'),
      ) as NativeCommitProvider;
    } catch (err) {
      console.warn('[watchdog] lares-native not loadable; commit sampling degraded:', err);
      nativeCommit = null;
    }
    const supervisorForWatchdog = supervisor;
    const browserForWatchdog = browserManager;
    renderRecovery = new RenderRecoveryPolicy();
    memorySampler = new MemorySampler({
      readCommit: createCommitReader(nativeCommit),
      getLiveAgentCount: () => getActiveAgents().length,
      getAgentViewCount: () => browserForWatchdog.getAgentViewCount(),
      getElectronProcessCount: () => {
        try { return app.getAppMetrics().length; } catch { return 0; }
      },
      getAppMemoryBytes: () => {
        try {
          // ProcessMetric.memory.workingSetSize is in KB.
          return app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0) * 1024, 0);
        } catch { return 0; }
      },
      now: () => Date.now(),
      onSnapshot: (snap: MemorySnapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('memory:pressure', snap);
        }
      },
      log: (m) => console.warn(m),
    });
    // WAVE-4 full-D5 (§5): per-agent attribution + budget/owned-cap admission.
    // Constructed here (store is armed a few lines below via startOwnership; the
    // service reads it lazily and fail-opens on a cold cache). The launch/tab
    // gates below AND the sampler's D5-lite gates are combined: the FIRST refusal
    // wins, so a caller sees exactly one machine-readable code.
    attributionService = new AttributionService({
      getStore: () => supervisorForWatchdog.getOwnershipStore(),
      electron: () => {
        try {
          const m = app.getAppMetrics();
          return {
            processCount: m.length,
            workingSetBytes: m.reduce((s, p) => s + (p.memory?.workingSetSize ?? 0) * 1024, 0),
          };
        } catch { return { processCount: 0, workingSetBytes: 0 }; }
      },
      log: (m) => console.warn(m),
    });
    // Arm the admission gates (§5): NEW agent launches and NEW agent tabs are
    // refused under Critical commit pressure / static caps (D5-lite sampler) OR
    // the whole-app owned-process cap / per-agent budget (full-D5 attribution),
    // with a machine-readable code the API/MCP caller receives.
    supervisorForWatchdog.setLaunchAdmissionCheck(() =>
      firstRefusal(memorySampler!.canLaunchAgent(), attributionService!.checkLaunchOwnedCap()));
    browserForWatchdog.setTabAdmissionCheck((agentId) =>
      firstRefusal(memorySampler!.canOpenAgentTab(), attributionService!.checkTabAdmission(agentId)));
    // Renderer pulls for the status-bar meter / banner / orphan list.
    ipcMain.handle('memory:get-snapshot', () => memorySampler?.getSnapshot() ?? null);
    ipcMain.handle('memory:attribution', () => attributionService?.getFresh() ?? null);
    // Reap-now estimate: best-effort working-set bytes for an orphan candidate's
    // PID set, from the attribution service's last snapshot (budget.ts math).
    ipcMain.handle('memory:reap-estimate', (_e, pids: number[]) =>
      attributionService?.estimateBytesForPids(pids ?? []) ?? 0);
    // Detached-process transparency (§5 Wave 5): list + PID-verify the descriptors
    // agents self-registered under <workspaceRoot>/.dashboard/detached/. Purely
    // read-only; a missing dir yields [] (never throws).
    ipcMain.handle('detached:list', (_e, workspaceRoot: string) => {
      if (typeof workspaceRoot !== 'string' || !workspaceRoot) return [];
      return listDetachedProcesses(detachedDirFor(workspaceRoot), defaultDetachedRegistryDeps());
    });
    memorySampler.start();

    orchestration.start();                 // boot reconcile of orphaned runs
    // D4 (incident-2026-07-11 §5): arm durable CLI-process ownership (store +
    // reaper + reconcile gate, native Job Object surface loaded here) BEFORE
    // reconcile() so respawns are duplicate-CLI-gated on Windows/ConPTY.
    supervisor.startOwnership();
    attributionService.start();            // begin the slow attribution refresh loop
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
  // §B9 — disarm the sweep BEFORE the drain and await any in-flight run, so a
  // stale-idle kill is never abandoned half-way through shutdown.
  await idleSweep?.stop();
  memorySampler?.stop();
  try { await supervisor?.drainForShutdown(); }
  catch (err) { console.error('[shutdown] drain failed:', err); }
  drainCompleted = true;
  apiServer?.stop();
  wsServer?.stop();
  disposeKernelClient();
  void shutdownJupyterServer();
  stopClaudeJsonRuntimeWatcher();
  plansWatcher?.stop();
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
