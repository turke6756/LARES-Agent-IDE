import { app, BrowserWindow, dialog, protocol, net, session, shell, nativeTheme } from 'electron';
import path from 'path';
import { loadPersistedTheme } from './theme-persistence';
import { initDatabase } from './database';
import { AgentSupervisor } from './supervisor';
import { registerIpcHandlers } from './ipc-handlers';
import { WsServer } from './ws-server';
import { ApiServer } from './api-server';
import { pathToFileURL } from 'url';
import { wslToWindowsPath } from './path-utils';
import { shutdownJupyterServer } from './jupyter-server';
import { disposeKernelClient } from './jupyter-kernel-client';
import { closeAllWatchers as closeAllFsWatchers } from './fs-watcher';

const JUPYTER_BASE_PORT = 18888;
const JUPYTER_PORT_RETRIES = 50;

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

let mainWindow: BrowserWindow | null = null;
let supervisor: AgentSupervisor | null = null;
let wsServer: WsServer | null = null;
let apiServer: ApiServer | null = null;

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

// Register media protocol before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
]);

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.ico')
    : path.join(__dirname, '..', '..', '..', 'assets', 'icon.ico');

  const theme = loadPersistedTheme();
  nativeTheme.themeSource = theme;

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
      // Required so the file:// renderer can iframe-embed the locally-spawned
      // Jupyter server at http://127.0.0.1:<port>. Without this, Chromium
      // rejects the cross-origin iframe load with ERR_BLOCKED_BY_RESPONSE
      // before our webRequest header shim runs.
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

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
          mainWindow!.loadURL(`http://localhost:${port}`);
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
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
  protocol.handle('media', async (request) => {
    const urlObj = new URL(request.url);
    // Path is /<encodedFilePath>, strip leading slash and decode
    const decodedUrl = decodeURIComponent(urlObj.pathname.slice(1));

    let filePath = decodedUrl;
    
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = wslToWindowsPath(filePath);
    }

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

    supervisor = new AgentSupervisor();
    createWindow();
    registerIpcHandlers(supervisor, mainWindow!);
    supervisor.start();
    wsServer = new WsServer(supervisor);
    wsServer.start();
    apiServer = new ApiServer(supervisor);
    apiServer.start();
    // Class IV (plans/class-iv-worker-hook-scaffold.md): tell the supervisor the
    // port the API server actually bound to (handles EADDRINUSE auto-increment)
    // so supervised workers' Stop hooks POST to the right place.
    supervisor.setApiServerPort(apiServer.getPort());
    supervisor.reconcile();
    console.log('App ready');
  } catch (err: any) {
    console.error('Startup error:', err);
    dialog.showErrorBox('Startup Error', err.message || String(err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  apiServer?.stop();
  wsServer?.stop();
  supervisor?.stop();
  disposeKernelClient();
  void shutdownJupyterServer();
  closeAllFsWatchers();
  app.quit();
});

app.on('will-quit', () => {
  disposeKernelClient();
  void shutdownJupyterServer();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
