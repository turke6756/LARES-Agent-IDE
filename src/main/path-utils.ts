import { PathType } from '../shared/types';
import { execFileSync } from 'child_process';

export function detectPathType(p: string): PathType {
  // WSL paths start with /
  if (p.startsWith('/')) return 'wsl';
  // UNC paths pointing into WSL (\\wsl.localhost\... or \\wsl$\...)
  if (/^\\\\wsl[\.\$]/i.test(p)) return 'wsl';
  // Windows paths start with drive letter or UNC
  return 'windows';
}

export function windowsToWslPath(winPath: string): string {
  // \\wsl.localhost\Ubuntu\home\turke\... -> /home/turke/...
  // \\wsl$\Ubuntu\home\turke\... -> /home/turke/...
  const uncMatch = winPath.match(/^\\\\wsl[\.\$][^\\]*\\[^\\]+(\\.*)/i);
  if (uncMatch) {
    return uncMatch[1].replace(/\\/g, '/');
  }
  // C:\Users\turke\Projects -> /mnt/c/Users/turke/Projects
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(.*)/);
  if (!match) return winPath;
  return `/mnt/${match[1].toLowerCase()}${match[2]}`;
}

export function wslToWindowsPath(wslPath: string): string {
  // /home/turke/project -> \\wsl$\Ubuntu\home\turke\project
  // /mnt/c/Users/... -> C:\Users\...
  const mntMatch = wslPath.match(/^\/mnt\/([a-z])(\/.*)/);
  if (mntMatch) {
    return `${mntMatch[1].toUpperCase()}:${mntMatch[2].replace(/\//g, '\\')}`;
  }
  // For native WSL paths, use wslpath
  try {
    const result = execFileSync('wsl.exe', ['wslpath', '-w', wslPath], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return result;
  } catch {
    return `\\\\wsl$\\Ubuntu${wslPath.replace(/\//g, '\\')}`;
  }
}

export function getVSCodeOpenPath(p: string, pathType: PathType): string {
  if (pathType === 'wsl') {
    // VS Code remote WSL format
    return `vscode://vscode-remote/wsl+Ubuntu${p}`;
  }
  return p;
}

/** Convert a UNC WSL path (\\wsl.localhost\Ubuntu\home\...) to a Linux path (/home/...) */
export function uncToWslPath(p: string): string {
  const match = p.match(/^\\\\wsl[\.\$][^\\]*\\[^\\]+(\\.*)/i);
  if (match) {
    return match[1].replace(/\\/g, '/');
  }
  return p;
}

export function ensureWslPath(p: string, pathType: PathType): string {
  if (pathType === 'wsl') {
    // If it's a UNC path, convert to Linux path
    return uncToWslPath(p);
  }
  return windowsToWslPath(p);
}

export function ensureWindowsPath(p: string, pathType: PathType): string {
  if (pathType === 'windows') return p;
  return wslToWindowsPath(p);
}

/** Convert a Windows-native path into the agent's path space. Native-Windows
 *  agents keep the path; WSL agents get the /mnt or /home form. Detects
 *  unmappable paths (windowsToWslPath returns its input unchanged for those)
 *  and reports an error instead of emitting a bad path.
 *
 *  A missing workingDirectory is rejected outright (addendum E): falling back to
 *  detectPathType(winPath) would silently treat a WSL agent's target as Windows
 *  when the agent lookup failed, reintroducing the wrong-path bug. */
export function toAgentPath(
  winPath: string, workingDirectory: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!workingDirectory) {
    return { ok: false, error: 'Agent working directory unavailable.' };
  }
  const agentType = detectPathType(workingDirectory);
  if (agentType !== 'wsl') return { ok: true, path: winPath };
  const wsl = windowsToWslPath(winPath);
  if (!wsl.startsWith('/')) {
    return { ok: false, error: `Cannot map "${winPath}" into this WSL agent's path space.` };
  }
  return { ok: true, path: wsl };
}
