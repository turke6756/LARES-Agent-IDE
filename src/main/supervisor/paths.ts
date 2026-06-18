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
