import path from 'path';
import { app } from 'electron';

export function getScriptsDir(): string {
  // `app` is undefined when this module is loaded outside the Electron runtime
  // (e.g. the system-Node test runner, where `require('electron')` resolves to
  // the binary path string). Guard so pure builders that need a script path
  // remain unit-testable; fall back to the dev (non-packaged) layout.
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'scripts');
  }
  return path.join(__dirname, '..', '..', '..', '..', 'scripts');
}

export function getScriptPath(scriptName: string): string {
  return path.join(getScriptsDir(), scriptName);
}

/**
 * Absolute path to the PTY helper (`pty-host.js`).
 *
 * The helper ships INSIDE the application bundle (`dist/`, and therefore
 * `app.asar` when packaged) so its bare `require('node-pty')` resolves through
 * the app's own module tree and Electron's asar layer transparently redirects
 * the native binding into `app.asar.unpacked`.
 *
 * Do NOT move it back to `resources/scripts`: from there no `node_modules` is
 * on the resolution path and the require fails with
 * `Cannot find module 'node-pty'` (ground truth F5). `getScriptPath()` stays
 * for genuinely external scripts (the MCP sidecars, which an agent CLI or a
 * Linux `node` launches by absolute path).
 *
 * Emit layout: this file compiles to `dist/main/main/supervisor/paths.js` and
 * `scripts/copy-static-main.mjs` puts the helper at `dist/main/main/pty-host.js`
 * — one level up.
 */
export function getPtyHostPath(): string {
  return path.join(__dirname, '..', 'pty-host.js');
}

/**
 * Directory holding the `lares-native` module (its `index.js` + built binding).
 *
 * It lives OUTSIDE `dist/`, so packaged it cannot be resolved relative to
 * `__dirname` — that would land inside `app.asar`, where it does not exist
 * (ground truth F6). electron-builder copies it to
 * `resources/native/lares-native` via `extraResources`.
 *
 * Same `app?.isPackaged` guard as `getScriptsDir()`: `app` is undefined under
 * the plain-Node test runner.
 */
export function getLaresNativeDir(): string {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'native', 'lares-native');
  }
  return path.join(__dirname, '..', '..', '..', '..', 'native', 'lares-native');
}
