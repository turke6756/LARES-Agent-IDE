/** Windows provider-CLI path resolution — the ONE place that decides where
 *  `claude` / `codex` / `gemini` live on this machine.
 *
 *  This module exists so preflight and launch cannot disagree. Before it, the
 *  resolvers were private to `supervisor/index.ts` and the startup health check
 *  did its own `execFileSync('claude', ['--version'])` — a bare PATH lookup.
 *  That is exactly the failure mode commit 7e99959 was written to fix: Electron
 *  inherits the LOGIN-time PATH, not the user's shell PATH, so an npm/global
 *  shim that works fine in their terminal is invisible to a bare exec. The old
 *  health check could therefore report "claude: not available" for a CLI the
 *  launcher resolves perfectly — or the reverse. A detector that disagrees with
 *  the launcher is worse than no detector, so both now call these functions.
 *
 *  Anything that needs to answer "is provider X installed / where is it" MUST
 *  come through here rather than adding another lookup. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** Resolve a path under `%SystemRoot%\System32`. Used instead of a bare
 *  `cmd.exe` / `where.exe` so we never depend on PATH to find PATH. */
export function getWindowsSystemPath(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', ...parts);
}

function userHome(): string {
  return process.env.USERPROFILE || os.homedir();
}

/** Locate the claude CLI. Rejects when not found — this is the launch-path
 *  contract and callers there treat a rejection as a hard launch failure. Use
 *  `probeWindowsProvider('claude')` for the non-throwing preflight form. */
export function findWindowsClaudePath(_env: NodeJS.ProcessEnv): Promise<string> {
  // Use known install path directly — avoids all PATH/shell resolution issues in Electron
  const knownPath = path.join(userHome(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(knownPath)) {
    return Promise.resolve(knownPath);
  }

  // Fallback: try where.exe through cmd.exe
  return new Promise<string>((resolve, reject) => {
    execFile(getWindowsSystemPath('cmd.exe'), ['/c', 'where', 'claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message || 'Failed to locate claude'));
        return;
      }

      const match = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => /claude(\.exe)?$/i.test(line));

      if (!match) {
        reject(new Error('Failed to locate claude'));
        return;
      }

      resolve(match);
    });
  });
}

/** Absolute-path resolver for the codex / gemini CLIs on Windows.
 *
 *  Unlike claude (findWindowsClaudePath), codex and gemini have no known
 *  installer location, no existence preflight, and no clear error — so on a
 *  Windows machine they silently fail. Electron inherits the LOGIN-time PATH,
 *  NOT the user's shell PATH, so a `codex`/`gemini` shim that works in their
 *  terminal can be invisible to a bare `cmd.exe /c codex`. Search the common
 *  npm-global and per-user install locations directly, then fall back to
 *  `where.exe` (which resolves anything already on the login PATH). Returns an
 *  absolute path — including a `.cmd` shim, which `cmd.exe /c` runs fine — or
 *  null when the binary genuinely cannot be found. */
export function findWindowsProviderBinary(provider: 'codex' | 'gemini'): Promise<string | null> {
  const home = userHome();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const npmDirs = [path.join(appData, 'npm'), path.join(localAppData, 'npm')];
  const exts = ['.cmd', '.exe', '.ps1', ''];

  const candidates: string[] = [];
  for (const dir of npmDirs) {
    for (const ext of exts) candidates.push(path.join(dir, `${provider}${ext}`));
  }
  candidates.push(path.join(localAppData, 'Programs', provider, `${provider}.exe`));
  if (provider === 'codex') {
    // OpenAI's native PowerShell installer (irm https://chatgpt.com/codex/install.ps1 | iex)
    // lands here — the exact command PROVIDER_INSTALL_HINTS now recommends.
    candidates.push(path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  }
  candidates.push(path.join(home, '.local', 'bin', `${provider}.exe`));
  candidates.push(path.join(home, '.local', 'bin', provider));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return Promise.resolve(candidate);
    } catch {
      /* ignore unreadable candidate and keep searching */
    }
  }

  // Fallback: where.exe through cmd.exe resolves anything on the login PATH.
  return new Promise<string | null>((resolve) => {
    execFile(getWindowsSystemPath('cmd.exe'), ['/c', 'where', provider], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => new RegExp(`${provider}(\\.(exe|cmd|ps1|bat))?$`, 'i').test(line));
      resolve(match || null);
    });
  });
}

/** Non-throwing preflight form: the absolute path a launch WOULD use, or null.
 *  Deliberately delegates to the two functions above rather than reproducing
 *  their candidate lists — if the launcher can't find it, neither can we, and
 *  vice versa. */
export function probeWindowsProvider(
  provider: 'claude' | 'codex' | 'gemini',
): Promise<string | null> {
  if (provider === 'claude') {
    return findWindowsClaudePath(process.env as NodeJS.ProcessEnv).catch(() => null);
  }
  return findWindowsProviderBinary(provider).catch(() => null);
}

/** The user-facing sentence for "this provider's CLI is not installed"
 *  (packaging plan §6.4).
 *
 *  It lives here, next to the resolver, so the message and the lookup that
 *  produced it can never drift. Three things it must do, because the person
 *  reading it just clicked Launch and got nothing:
 *
 *   - Say plainly that LARES is fine and the missing thing is a separate
 *     program. Otherwise a missing CLI reads as "this app is broken".
 *   - Name the restart requirement. Electron inherits the login-time PATH, so
 *     installing a CLI while Lares is running genuinely does not take effect
 *     until Lares is fully quit and reopened. Users hit this constantly.
 *   - Point at the one place that lists everything.
 *
 *  Never let a missing executable degrade into a blank terminal or a bare
 *  exit code. */
export function missingProviderMessage(provider: 'claude' | 'codex' | 'gemini'): string {
  const label = provider === 'claude'
    ? 'Claude Code'
    : provider === 'codex' ? 'Codex' : 'Gemini';
  return (
    `${label} CLI was not found.\n\n` +
    `Lares is installed correctly, but ${label} is a separate command-line tool ` +
    `that Lares runs on your behalf. Install ${label}, fully quit and restart ` +
    `Lares so it picks up your updated PATH, then choose Recheck in ` +
    `Help ▸ Check prerequisites.`
  );
}
