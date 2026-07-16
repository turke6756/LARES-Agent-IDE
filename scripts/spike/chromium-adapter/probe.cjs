/*
 * Phase 0 Candidate B feasibility probe (Chromium native PDFium + injected overlay).
 *
 * Candidate B's make-or-break is NOT render speed (the 2.1 s native path is
 * already proven by the old native-pdf-spike). It is whether a Lares-owned
 * overlay can be injected ABOVE the actual page pixels. In modern Chromium the
 * PDF renders inside the built-in PDF *extension* frame, and the page raster
 * lives in an out-of-process `<embed>`/plugin (OOPIF) guest surface. This probe
 * empirically answers, on the pinned Electron 41 / Chromium 146 build:
 *
 *   1. What is the frame tree when a PDF loads over media:// ?
 *   2. Which frame (if any) is script-reachable via WebFrameMain.executeJavaScript?
 *   3. Can we see the <pdf-viewer> custom element + its shadow DOM + page geometry?
 *   4. Can we inject an overlay DIV that actually sits above the page pixels?
 *   5. Is the plugin/embed surface a real DOM we can overlay, or an opaque
 *      compositor surface that paints above any DOM we add?
 *
 * It never starts a supervisor; isolated userData; uses the production media://.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, session, webFrameMain } = require('electron');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const REPO = path.resolve(__dirname, '../../..');
const pdfPath = path.resolve(arg('pdf', ''));
const workspaceRoot = path.resolve(arg('root', path.dirname(pdfPath)));
const outPath = path.resolve(arg('out', path.join(__dirname, 'results', 'candidateB.json')));
const shotPath = path.resolve(arg('shot', path.join(__dirname, 'results', 'candidateB.png')));
const profile = path.resolve(arg('profile', path.join(__dirname, '.profile')));
const timeoutMs = Math.max(20_000, Number.parseInt(arg('timeout-ms', '45000'), 10) || 45_000);

if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error(`--pdf must exist: ${pdfPath}`);

app.setPath('userData', profile);
app.setName('chromium-adapter-spike');
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Probe script run INSIDE a frame: describe the doc, look for the PDF viewer
// custom element / embed / page geometry, and TRY to inject an overlay above
// the page pixels. Returns a structured report (never throws out of the frame).
const FRAME_PROBE = `(() => {
  const r = { url: location.href, origin: location.origin };
  try {
    r.readyState = document.readyState;
    r.hasPdfViewer = !!document.querySelector('pdf-viewer, embed[type*="pdf"], embed[type*="chrome-pdf"]');
    const pv = document.querySelector('pdf-viewer');
    r.pdfViewerTag = pv ? pv.tagName.toLowerCase() : null;
    r.pdfViewerHasShadow = pv ? !!pv.shadowRoot : false;
    // Enumerate embeds / plugin surfaces.
    const embeds = Array.from(document.querySelectorAll('embed, object')).map(e => ({
      tag: e.tagName.toLowerCase(), type: e.getAttribute('type'),
      w: e.clientWidth, h: e.clientHeight,
    }));
    r.embeds = embeds;
    // Try to reach page geometry inside the viewer's shadow DOM.
    if (pv && pv.shadowRoot) {
      const scroller = pv.shadowRoot.querySelector('#scroller, #content, #plugin, .page');
      r.shadowFirstChildren = Array.from(pv.shadowRoot.children).map(c => c.id || c.tagName.toLowerCase());
      r.hasScroller = !!scroller;
      // Chromium's viewer exposes viewport/page info on the element in some builds.
      r.viewerApiKeys = Object.keys(pv).filter(k => /page|zoom|viewport|scroll|rotate/i.test(k)).slice(0, 40);
    }
    // Attempt overlay injection above page pixels.
    const host = (pv && pv.shadowRoot) ? pv.shadowRoot : document.body;
    if (host) {
      const el = document.createElement('div');
      el.id = '__lares_overlay_probe__';
      el.style.cssText = 'position:fixed;left:40px;top:120px;width:220px;height:60px;background:rgba(255,0,80,.55);color:#fff;z-index:2147483647;pointer-events:none;font:14px sans-serif;';
      el.textContent = 'LARES OVERLAY PROBE';
      host.appendChild(el);
      r.overlayInjected = !!(host.getRootNode && host.querySelector ? host.querySelector('#__lares_overlay_probe__') : true);
      // Was it actually laid out (non-zero box)?
      const box = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      r.overlayRect = box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null;
    }
    r.bodyChildTags = document.body ? Array.from(document.body.children).map(c => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '')) : [];
  } catch (e) {
    r.error = String(e && e.message || e);
  }
  return r;
})()`;

async function probeFrame(frame) {
  const info = { url: frame.url, origin: frame.origin, name: frame.name };
  try {
    info.report = await frame.executeJavaScript(FRAME_PROBE, true);
  } catch (e) {
    info.executeJavaScriptError = String(e && e.message || e);
  }
  return info;
}

function collectFrames(win) {
  const out = [];
  try {
    const main = win.webContents.mainFrame;
    const all = main.framesInSubtree || [main];
    for (const f of all) out.push(f);
  } catch (e) {
    out.error = String(e);
  }
  return out;
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
    width: 1200, height: 1000, show: false, backgroundColor: '#525659',
    webPreferences: { plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.showInactive());

  const findings = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    approach: 'Candidate B — native Chromium PDFium + injected overlay',
    frameTree: [],
    frameProbes: [],
    horizontalWheelInterceptable: null,
    notes: [],
  };

  const url = 'media://file/' + encodeURIComponent(pdfPath) + '#page=3&zoom=page-width';
  await win.loadURL(url);

  // Let the built-in PDF viewer extension + plugin frame fully spin up and
  // paint page 3. The plugin frame appears asynchronously after the extension
  // frame loads, so poll the frame tree until it stops growing.
  let lastCount = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const frames = collectFrames(win);
    if (frames.length === lastCount && i > 5) break;
    lastCount = frames.length;
  }

  const frames = collectFrames(win);
  for (const f of frames) {
    findings.frameTree.push({ url: f.url, origin: f.origin, name: f.name, visibilityState: undefined });
    findings.frameProbes.push(await probeFrame(f));
  }

  // Try to intercept a horizontal-wheel event from the TOP frame: can we even
  // observe wheel events, or does the plugin consume them out-of-process?
  try {
    findings.horizontalWheelObservableTopFrame = await win.webContents.mainFrame.executeJavaScript(`(() => {
      let got = false;
      const h = (e) => { got = true; };
      window.addEventListener('wheel', h, { capture: true, passive: false });
      // synthesize is not possible here; just report that a listener could be attached
      return { listenerAttached: true, note: 'real wheel routing to plugin OOPIF cannot be observed from top frame' };
    })()`, true);
  } catch (e) {
    findings.horizontalWheelObservableTopFrame = { error: String(e && e.message || e) };
  }

  // Screenshot to show whether any injected overlay actually painted above pixels.
  try {
    const cap = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, cap.toPNG());
    findings.screenshotPath = shotPath;
    findings.screenshotBytes = cap.toPNG().byteLength;
  } catch (e) { findings.screenshotError = String(e && e.message || e); }

  findings.mediaRequests = mediaRequests;
  findings.mediaResponseStatuses = statuses;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(findings, null, 2) + '\n');
  console.log('[PROBE_RESULT]' + JSON.stringify(findings));

  if (!win.isDestroyed()) win.destroy();
  try { await session.defaultSession.protocol.unhandle('media'); } catch {}
  app.quit();
}

app.whenReady().then(main).catch((err) => {
  console.error('[spike] failed:', err);
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify({ fatal: String(err && err.stack || err) }, null, 2)); } catch {}
  app.exit(1);
});
