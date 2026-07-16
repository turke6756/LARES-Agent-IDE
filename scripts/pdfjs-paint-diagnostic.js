/* Throwaway pdf.js page-3 paint profiler. Does not load the Lares application. */
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, session } = require('electron');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const pdfPath = path.resolve(arg('pdf'));
const workspaceRoot = path.resolve(arg('root', path.dirname(pdfPath)));
const pdfjsDir = path.resolve(arg('pdfjs-dir', path.join(process.cwd(), 'node_modules', 'pdfjs-dist')));
const profilePath = path.resolve(arg('profile', path.join(process.cwd(), '.pdfjs-diagnostic-profile')));
const resultPath = path.resolve(arg('out', path.join(process.cwd(), 'pdfjs-paint-diagnostic.json')));
const scales = arg('scales', '0.25,0.5,1,2');
const options = arg('options-base64')
  ? Buffer.from(arg('options-base64'), 'base64').toString('utf8')
  : arg('options', '{}');
const label = arg('label', path.basename(pdfjsDir));
const skipConstructPaths = arg('skip-construct-paths', 'false') === 'true';

if (!fs.existsSync(pdfPath)) throw new Error(`Missing --pdf: ${pdfPath}`);
if (!fs.existsSync(path.join(pdfjsDir, 'build', 'pdf.mjs'))) {
  throw new Error(`Missing pdf.js browser build under --pdfjs-dir: ${pdfjsDir}`);
}

app.setPath('userData', profilePath);
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function patchPdfJsBuild() {
  const sourcePath = path.join(pdfjsDir, 'build', 'pdf.mjs');
  const targetPath = path.join(profilePath, `instrumented-pdf-${Date.now()}.mjs`);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const before = `        if (fnId !== OPS.dependency) {
          if (fnArgs === null) {
            this[fnId](i);
          } else {
            this[fnId](i, ...fnArgs);
          }
        } else {`;
  const after = `        if (fnId !== OPS.dependency) {
          const __diagMetadata = globalThis.__pdfDiagBeforeOp?.(i, fnId, fnArgs);
          const __diagStart = performance.now();
          const __diagSkip = globalThis.__pdfDiagSkipOp?.(i, fnId, fnArgs) === true;
          if (!__diagSkip) {
            if (fnArgs === null) {
              this[fnId](i);
            } else {
              this[fnId](i, ...fnArgs);
            }
          }
          globalThis.__pdfDiagRecordOp?.(i, fnId, performance.now() - __diagStart, __diagMetadata);
        } else {`;
  if (!source.includes(before)) {
    throw new Error(`pdf.js executeOperatorList dispatch shape changed in ${sourcePath}`);
  }
  let instrumented = source.replace(before, after);
  const pathBuildBefore = `    if (!(path instanceof Path2D)) {\n      const path2d = data[0] = new Path2D();`;
  const pathBuildAfter = `    if (!(path instanceof Path2D)) {\n      const __diagPathBuildStart = performance.now();\n      const path2d = data[0] = new Path2D();`;
  const pathBuildEndBefore = `      path = path2d;\n    }\n    Util.axialAlignedBoundingBox`;
  const pathBuildEndAfter = `      path = path2d;\n      globalThis.__pdfDiagRecordPathPhase?.(opIdx, "path2d-build", performance.now() - __diagPathBuildStart);\n    }\n    Util.axialAlignedBoundingBox`;
  const pathPaintBefore = `    this[op](opIdx, path);\n    this._pathStartIdx = opIdx;`;
  const pathPaintAfter = `    const __diagPathPaintStart = performance.now();\n    this[op](opIdx, path);\n    globalThis.__pdfDiagRecordPathPhase?.(opIdx, "canvas-paint", performance.now() - __diagPathPaintStart);\n    this._pathStartIdx = opIdx;`;
  for (const [needle, replacement] of [
    [pathBuildBefore, pathBuildAfter],
    [pathBuildEndBefore, pathBuildEndAfter],
    [pathPaintBefore, pathPaintAfter],
  ]) {
    if (!instrumented.includes(needle)) throw new Error(`pdf.js constructPath shape changed in ${sourcePath}`);
    instrumented = instrumented.replace(needle, replacement);
  }
  fs.mkdirSync(profilePath, { recursive: true });
  fs.writeFileSync(targetPath, instrumented);
  return targetPath;
}

async function main() {
  const { handleMediaProtocolRequest } = require('../dist/main/main/media-protocol.js');
  session.defaultSession.protocol.handle('media', (request) => handleMediaProtocolRequest(request, {
    workspaceRoots: [workspaceRoot],
    onRejected: (url) => console.error(`[pdfjs-diagnostic] confined request rejected: ${url}`),
  }));

  const instrumentedModule = patchPdfJsBuild();
  const originalWorkerPath = path.join(pdfjsDir, 'build', 'pdf.worker.mjs');
  const workerPath = path.join(profilePath, `instrumented-worker-${Date.now()}.mjs`);
  const workerSource = fs.readFileSync(originalWorkerPath, 'utf8');
  fs.writeFileSync(
    workerPath,
    `Math.sumPrecise ??= (values) => [...values].reduce((sum, value) => sum + value, 0);\n${workerSource}`,
  );
  const htmlPath = path.join(__dirname, 'pdfjs-paint-diagnostic.html');
  const mediaUrl = `media://file/${encodeURIComponent(pdfPath)}`;
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(`[pdfjs-diagnostic renderer] ${message}`);
  });

  await win.loadFile(htmlPath, {
    query: {
      module: `file:///${instrumentedModule.replace(/\\/g, '/')}`,
      worker: `file:///${workerPath.replace(/\\/g, '/')}`,
      pdf: mediaUrl,
      scales,
      options,
      label,
      skipConstructPaths: String(skipConstructPaths),
    },
  });
  const result = await win.webContents.executeJavaScript('globalThis.runPdfDiagnostic()');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[pdfjs-diagnostic] wrote ${resultPath}`);
  for (const render of result.renders) {
    console.log(`[pdfjs-diagnostic] scale=${render.scale} pixels=${render.pixels} paint=${render.paintMs}ms dispatch=${render.dispatchMs}ms maxGap=${render.maxEventLoopGapMs}ms`);
  }
  // Do not tear the renderer down from inside executeJavaScript's completion
  // callback; Electron/V8 can assert in DisallowJavascriptExecutionScope.
  await new Promise((resolve) => setTimeout(resolve, 250));
  win.destroy();
  session.defaultSession.protocol.unhandle('media');
  await new Promise((resolve) => setTimeout(resolve, 250));
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error('[pdfjs-diagnostic] failed:', error);
  app.exit(1);
});
