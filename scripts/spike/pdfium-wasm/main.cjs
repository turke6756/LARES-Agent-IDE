/*
 * Phase 0 Candidate A harness — minimal Electron main.
 *
 * Loads the Vite-built spike renderer from file:// (packaged shape), registers
 * the REAL production media:// transport (compiled dist/main/main), lets the
 * renderer run the PDFium-WASM benchmark, samples peak process memory, captures
 * a screenshot for visual proof, writes results JSON, and quits. It never
 * starts a supervisor and uses an isolated userData dir, so it cannot disturb a
 * running Lares instance.
 *
 *   electron scripts/spike/pdfium-wasm/main.cjs \
 *     --pdf=<abs.pdf> --root=<workspace> --out=<result.json> --shot=<png>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, session } = require('electron');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const REPO = path.resolve(__dirname, '../../..');
const pdfPath = path.resolve(arg('pdf', ''));
const workspaceRoot = path.resolve(arg('root', path.dirname(pdfPath)));
const outPath = path.resolve(arg('out', path.join(__dirname, 'results', 'candidateA.json')));
const shotPath = path.resolve(arg('shot', path.join(__dirname, 'results', 'candidateA.png')));
const profile = path.resolve(arg('profile', path.join(__dirname, '.profile')));
const timeoutMs = Math.max(20_000, Number.parseInt(arg('timeout-ms', '90000'), 10) || 90_000);

if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error(`--pdf must exist: ${pdfPath}`);

app.setPath('userData', profile);
app.setName('pdfium-wasm-spike');
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Peak memory sampling across all processes (renderer 'Tab' hosts the Web Worker).
let peakRendererKB = 0;
let peakTotalKB = 0;
function sampleMemory() {
  try {
    const metrics = app.getAppMetrics();
    let total = 0;
    let renderer = 0;
    for (const m of metrics) {
      const ws = (m.memory && m.memory.workingSetSize) || 0; // KB
      total += ws;
      if (m.type === 'Tab' || m.type === 'renderer' || m.type === 'Utility') renderer += ws;
    }
    peakTotalKB = Math.max(peakTotalKB, total);
    peakRendererKB = Math.max(peakRendererKB, renderer);
  } catch { /* metrics unavailable mid-teardown */ }
}

async function main() {
  const { handleMediaProtocolRequest } = require(path.join(REPO, 'dist/main/main/media-protocol.js'));
  let mediaRequests = 0;
  const statuses = {};
  session.defaultSession.protocol.handle('media', async (request) => {
    mediaRequests += 1;
    const res = await handleMediaProtocolRequest(request, {
      workspaceRoots: [workspaceRoot],
      onRejected: (url) => console.error('[spike] media rejected:', url),
    });
    statuses[res.status] = (statuses[res.status] || 0) + 1;
    return res;
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 1000,
    show: false,
    backgroundColor: '#525659',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.showInactive());

  const memTimer = setInterval(sampleMemory, 100);

  const indexHtml = path.join(__dirname, 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) throw new Error(`build missing: ${indexHtml} (run vite build first)`);
  await win.loadFile(indexHtml, { search: '?pdf=' + encodeURIComponent(pdfPath) });

  const startedAt = Date.now();
  let result = null;
  while (Date.now() - startedAt < timeoutMs) {
    sampleMemory();
    try {
      result = await win.webContents.executeJavaScript('window.__BENCH_RESULT || null');
    } catch { /* page mid-navigation */ }
    if (result) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  clearInterval(memTimer);

  let screenshotBytes = 0;
  try {
    const cap = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, cap.toPNG());
    screenshotBytes = cap.toPNG().byteLength;
  } catch (e) { console.error('[spike] capture failed:', e.message); }

  const envelope = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    timedOut: !result,
    mediaRequests,
    mediaResponseStatuses: statuses,
    peakRendererWorkingSetMB: Math.round(peakRendererKB / 1024),
    peakTotalWorkingSetMB: Math.round(peakTotalKB / 1024),
    screenshotBytes,
    screenshotPath: shotPath,
    result,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
  console.log('[BENCH_ENVELOPE]' + JSON.stringify(envelope));

  if (!win.isDestroyed()) win.destroy();
  try { await session.defaultSession.protocol.unhandle('media'); } catch {}
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error('[spike] failed:', err);
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify({ fatal: String(err && err.stack || err) }, null, 2)); } catch {}
  app.exit(1);
});
