// Detachable (tear-off) file tabs — main-side registry, file-keyed ownership,
// and the detached-window factory. plans/detachable-file-tabs-plan.md §4 (1.2).
//
// A detached window is a TRUSTED preload-bearing context (the dashboard
// preload) that owns exactly ONE file. Ownership is keyed by file so the
// `files:write` handler can enforce single-writer (ipc-handlers.ts): once a
// file is detached-owned, only the owning webContents may write it. Lifecycle
// is keyed by window id.

import { BrowserWindow, shell } from 'electron';
import path from 'path';
import { JUPYTER_BASE_PORT, JUPYTER_PORT_RETRIES } from './control-ports';
import { normalizeFileKey } from '../shared/file-key';
import { TAB_CHANNELS, VIEW_CHANNELS } from '../shared/types';
import { installShellSpellcheckContextMenu } from './spellcheck-context-menu';
import type {
  DetachRequest,
  DetachedClosedPayload,
  DetachResult,
  DetachableView,
  ViewDetachRequest,
  ViewDetachedClosedPayload,
} from '../shared/types';

// ── Registries ──────────────────────────────────────────────────────────
// Window registry: lifecycle keyed by BrowserWindow id.
const detached = new Map<number /* win.id */, { win: BrowserWindow; req: DetachRequest }>();
// File-keyed ownership registry: who is allowed to write this file.
const owners = new Map<string /* fileKey */, { winId: number; webContentsId: number }>();

// ── View tear-off registries (parallel to the file ones above) ──────────
// Detached top-level VIEW windows. Lifecycle keyed by window id; single-owner
// ownership keyed by the view id so at most one window per view. No write /
// dirty-close state — a view has nothing to save.
const detachedViews = new Map<number /* win.id */, { win: BrowserWindow; req: ViewDetachRequest }>();
const viewOwners = new Map<DetachableView, number /* winId */>();

// ── Phase 2: dirty-on-close protocol state ──────────────────────────────
// Outstanding close-confirmation requests keyed by a deterministic requestId
// (`winId:seq` — never Date.now/random, so close behavior stays testable). A
// request lives from the moment the user tries to close a window until the
// detached renderer replies with a decision via handleDetachedCloseReply.
let requestSeq = 0;
const pendingCloses = new Map<string /* requestId */, number /* winId */>();
// Windows cleared to actually close: the 'close' intercept lets these through.
// Acts as the re-entry guard for a confirmed close.
const allowClose = new Set<number /* winId */>();
// Set during app shutdown so the close intercept can't deadlock quit.
let forceCloseAll = false;

function makeRequestId(winId: number): string {
  return `${winId}:${++requestSeq}`;
}

function fileKey(reqOrPath: DetachRequest | string): string {
  return normalizeFileKey(typeof reqOrPath === 'string' ? reqOrPath : reqOrPath.filePath);
}

function toClosedPayload(req: DetachRequest): DetachedClosedPayload {
  return {
    filePath: req.filePath,
    rootDirectory: req.rootDirectory,
    pathType: req.pathType,
    workspaceId: req.workspaceId,
    label: req.label,
  };
}

/** The owner entry for a file, or undefined when it is not detached-owned. */
export function isDetachedOwned(filePath: string): { winId: number; webContentsId: number } | undefined {
  return owners.get(fileKey(filePath));
}

/**
 * Write-permission check for `files:write`. A file may be written if it is not
 * detached-owned, or if the writer IS the owning webContents. Any other sender
 * (the main shell re-opening the same path, an agent-driven file:open-tab) is
 * rejected so there is exactly one writer per file at all times.
 */
export function canWrite(filePath: string, senderId: number): boolean {
  const owner = owners.get(fileKey(filePath));
  return !owner || owner.webContentsId === senderId;
}

/** Live detached windows (Phase 2 quit guard). */
export function getDetachedEntries(): Array<{ win: BrowserWindow; req: DetachRequest }> {
  return [...detached.values()];
}

/**
 * Resolve a close-query the detached renderer answered. 'cancel' keeps the
 * window open; 'save'/'discard' clear it to close (on 'save' the renderer has
 * already persisted the buffer before replying, so main only needs to close).
 * No-op for a stale/unknown requestId (window already gone, or superseded).
 */
export function handleDetachedCloseReply(
  requestId: string,
  decision: 'save' | 'discard' | 'cancel',
): void {
  const winId = pendingCloses.get(requestId);
  if (winId === undefined) return;
  pendingCloses.delete(requestId);
  if (decision === 'cancel') return; // window stays open
  const entry = detached.get(winId);
  if (!entry) return;
  allowClose.add(winId);
  if (!entry.win.isDestroyed()) entry.win.close();
}

/**
 * Force every detached window shut WITHOUT the dirty-on-close prompt. Called on
 * app shutdown so the 'close' intercept can't deadlock quit. Unsaved in-window
 * edits are lost on quit — consistent with the main shell's file-viewer tabs,
 * which have no quit-time dirty guard either.
 */
export function forceCloseAllDetached(): void {
  forceCloseAll = true;
  for (const { win } of detached.values()) {
    if (!win.isDestroyed()) win.close();
  }
  // View windows have no close intercept, so a plain close is safe on shutdown.
  for (const { win } of detachedViews.values()) {
    if (!win.isDestroyed()) win.close();
  }
}

// ── External navigation handlers (shared with the shell) ────────────────
// Extracted from the shell's externalize logic so both the shell and detached
// windows route http(s) links to the OS browser instead of replacing the
// trusted renderer (which would strand the user with no way back).
const isInternalUrl = (url: string): boolean => {
  if (url.startsWith('file://')) return true;
  try {
    const u = new URL(url);
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!isLoopback) return false;
    const port = Number(u.port);
    // Vite dev server ports
    if (port >= 5173 && port <= 5175) return true;
    // Embedded Jupyter server ports
    if (port >= JUPYTER_BASE_PORT && port <= JUPYTER_BASE_PORT + JUPYTER_PORT_RETRIES) return true;
    return false;
  } catch {
    return false;
  }
};

export function installExternalNavHandlers(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });
}

// ── Window factory ──────────────────────────────────────────────────────
export interface DetachedWindowDeps {
  devServerUrl: string | null;
  builtIndexHtml: string;
  theme: 'dark' | 'light';
  trustedContents: Set<Electron.WebContents>;
  setConstructingDetached: (v: boolean) => void;
  getMainWindow: () => BrowserWindow | null;
  // Test seam: overridable window constructor. Production omits it and the real
  // `new BrowserWindow()` is used — letting the unit tests exercise the
  // ownership / duplicate-focus logic without an Electron runtime.
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  // Test seam for the native editable-surface context menu. Production uses the
  // real installer; tests inject a recorder without constructing Electron Menu.
  installSpellcheckContextMenu?: (win: BrowserWindow) => void;
  // View re-parenting hooks (plans/browser). A detachable view whose content is a
  // main-process WebContentsView (the plan pane, the browser tabs) must move that
  // native view OUT of the main window and INTO the detached window on detach, and
  // back to the main window when the detached window closes. `onViewWindowReady`
  // fires as the window is created (before load) so the view is already re-parented
  // by the time the detached renderer streams show/setBounds; `onViewWindowClosing`
  // fires on the window's 'close' (BEFORE destruction) so the pane can be moved
  // home while the detached window still exists (a clean removeChildView). Both are
  // no-ops for the pure-DOM views (dashboard/files). Optional so the unit-test deps
  // and any caller that doesn't own the managers can omit them.
  onViewWindowReady?: (view: DetachableView, win: BrowserWindow) => void;
  onViewWindowClosing?: (view: DetachableView) => void;
}

export function createDetachedWindow(req: DetachRequest, deps: DetachedWindowDeps): DetachResult {
  // Duplicate detach (or same-file re-detach) → focus the existing window,
  // abort the new spawn. Authoritative single-writer backstop is canWrite().
  const existing = owners.get(fileKey(req));
  if (existing) {
    const e = detached.get(existing.winId);
    if (e) {
      e.win.focus();
      return { ok: true, focusedExisting: true };
    }
  }

  const makeWindow = deps.createWindow ?? ((opts) => new BrowserWindow(opts));

  let win: BrowserWindow;
  // The detached window's 'web-contents-created' fires synchronously inside the
  // constructor — before any post-construction trustedContents.add can run.
  // The constructingDetached flag exempts it from the M4 guard during its own
  // construction (mirrors constructingShell in index.ts).
  deps.setConstructingDetached(true);
  try {
    win = makeWindow({
      width: 900,
      height: 700,
      x: req.x,
      y: req.y,
      title: req.label,
      backgroundColor: deps.theme === 'light' ? '#f7f5f0' : '#1e1e1e',
      webPreferences: {
        // TIGHTENED vs shell (Q4 / Reviewer #6): trust triple kept, but
        // webSecurity stays on and allowRunningInsecureContent is omitted —
        // notebooks / Jupyter iframe views are excluded from detached v1.
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // trust triple — required so the preload can require shared modules
        webSecurity: true,
      },
    });
    deps.trustedContents.add(win.webContents); // BEFORE load (Reviewer answer (a))
    (deps.installSpellcheckContextMenu ?? installShellSpellcheckContextMenu)(win);
  } finally {
    deps.setConstructingDetached(false);
  }

  installExternalNavHandlers(win);

  const q = new URLSearchParams({
    detached: '1',
    filePath: req.filePath,
    rootDirectory: req.rootDirectory,
    pathType: req.pathType,
    workspaceId: req.workspaceId,
    label: req.label,
  }).toString();
  if (deps.devServerUrl) win.loadURL(`${deps.devServerUrl}/?${q}`);
  else win.loadFile(deps.builtIndexHtml, { search: q });

  detached.set(win.id, { win, req });
  owners.set(fileKey(req), { winId: win.id, webContentsId: win.webContents.id });

  // Capture the webContents reference NOW. By the time 'closed' fires the window
  // is destroyed and `win.webContents` throws "Object has been destroyed" — an
  // uncaught throw here exits the whole main process (index.ts uncaughtException
  // handler). Mirrors the shell's `shellContents` capture in index.ts.
  const winContents = win.webContents;
  const winId = win.id;

  // Phase 2 dirty-on-close: intercept the user's close, ask the renderer to
  // confirm (it shows a Save/Discard/Cancel modal when dirty), and only close
  // for real once the renderer replies via handleDetachedCloseReply. `allowClose`
  // is the re-entry guard so the confirmed close isn't intercepted a second time;
  // `forceCloseAll` is the shutdown bypass so quit never deadlocks.
  win.on('close', (e) => {
    if (forceCloseAll || allowClose.has(winId)) return;
    e.preventDefault();
    if (winContents.isDestroyed()) { allowClose.add(winId); win.close(); return; }
    const requestId = makeRequestId(winId);
    pendingCloses.set(requestId, winId);
    winContents.send(TAB_CHANNELS.closeQuery, { requestId });
  });

  // If the detached renderer dies we can't ask about unsaved edits — release it
  // and let the window close so the file returns to the main strip (via 'closed').
  winContents.on('render-process-gone', () => {
    allowClose.add(winId);
    if (!win.isDestroyed()) win.close();
  });

  win.on('closed', () => {
    allowClose.delete(winId);
    for (const [rid, id] of pendingCloses) if (id === winId) pendingCloses.delete(rid);
    deps.trustedContents.delete(winContents);
    detached.delete(winId);
    owners.delete(fileKey(req));
    const mw = deps.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send(TAB_CHANNELS.closed, toClosedPayload(req));
    }
  });

  return { ok: true };
}

// ── View tear-off window factory ────────────────────────────────────────
// Spawns (or focuses) a trusted, preload-bearing window that renders one
// top-level view full-screen. Reuses the same trust seam as the file factory:
// constructingDetached exempts the window from the M4 guard during its own
// construction, and trustedContents holds it after load (added BEFORE load,
// removed on close). No ownership-by-file / single-writer / dirty-close — a
// view is read-only chrome, so the window closes immediately on user close and
// main fires VIEW_CHANNELS.closed so the shell un-hollows the button.
export function createDetachedViewWindow(req: ViewDetachRequest, deps: DetachedWindowDeps): DetachResult {
  // Duplicate detach → focus the existing window, abort the new spawn.
  const existingWinId = viewOwners.get(req.view);
  if (existingWinId !== undefined) {
    const e = detachedViews.get(existingWinId);
    if (e) {
      e.win.focus();
      return { ok: true, focusedExisting: true };
    }
  }

  const makeWindow = deps.createWindow ?? ((opts) => new BrowserWindow(opts));

  let win: BrowserWindow;
  deps.setConstructingDetached(true);
  try {
    win = makeWindow({
      // Wider default than a file window — a view holds a full pane, not one file.
      width: 1100,
      height: 800,
      x: req.x,
      y: req.y,
      title: req.label,
      backgroundColor: deps.theme === 'light' ? '#f7f5f0' : '#1e1e1e',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // trust triple — required so the preload can require shared modules
        webSecurity: true,
      },
    });
    deps.trustedContents.add(win.webContents); // BEFORE load
  } finally {
    deps.setConstructingDetached(false);
  }

  installExternalNavHandlers(win);

  const q = new URLSearchParams({
    detached: '1',
    view: req.view,
    workspaceId: req.workspaceId,
    label: req.label,
  }).toString();
  if (deps.devServerUrl) win.loadURL(`${deps.devServerUrl}/?${q}`);
  else win.loadFile(deps.builtIndexHtml, { search: q });

  detachedViews.set(win.id, { win, req });
  viewOwners.set(req.view, win.id);

  // Re-parent a native-view-backed view (plans/browser) into this window so its
  // WebContentsView paints here, not the main window. Fired before load so the
  // reparent is in place by the time the detached renderer drives show/setBounds.
  // No-op for the pure-DOM views (dashboard/files).
  deps.onViewWindowReady?.(req.view, win);

  // Capture references up front — after 'closed' fires, win.webContents / win.id
  // throw "Object has been destroyed" (see the file factory's note).
  const winContents = win.webContents;
  const winId = win.id;
  const view = req.view;

  // A dead renderer can't be recovered — close the window so the view returns.
  winContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.close();
  });

  // 'close' fires BEFORE destruction — move a native-view-backed view home while
  // this window still exists (so removeChildView targets a live window). Does not
  // preventDefault; the close proceeds to 'closed' below for registry cleanup.
  win.on('close', () => {
    deps.onViewWindowClosing?.(view);
  });

  win.on('closed', () => {
    deps.trustedContents.delete(winContents);
    detachedViews.delete(winId);
    if (viewOwners.get(view) === winId) viewOwners.delete(view);
    const mw = deps.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      const payload: ViewDetachedClosedPayload = { view, workspaceId: req.workspaceId };
      mw.webContents.send(VIEW_CHANNELS.closed, payload);
    }
  });

  return { ok: true };
}

/** True when the given view is currently torn off into its own window. */
export function isViewDetached(view: DetachableView): boolean {
  return viewOwners.has(view);
}

/** Live detached view windows — used to broadcast the shell's data feeds so a
 *  torn-off view (e.g. the Dashboard grid) stays live. */
export function getDetachedViewWindows(): BrowserWindow[] {
  return [...detachedViews.values()].map((e) => e.win);
}

/** Forward a main→renderer push to every live detached view window. The shell's
 *  IPC feeds (agent status, deletions, context stats…) are sent to the main
 *  window only; a torn-off Dashboard needs the same stream to stay in sync. */
export function broadcastToDetachedViews(channel: string, ...args: unknown[]): void {
  for (const { win } of detachedViews.values()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

// Test-only: reset module state between unit-test cases.
export function __resetDetachedRegistryForTest(): void {
  detached.clear();
  owners.clear();
  detachedViews.clear();
  viewOwners.clear();
  pendingCloses.clear();
  allowClose.clear();
  forceCloseAll = false;
  requestSeq = 0;
}
