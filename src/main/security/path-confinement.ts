// WP0.3 (plans/embedded-browser-implementation-tasks.md) — path-confinement
// helpers, extracted from file-writer.ts so the media:// protocol handler
// (M8) and the Phase-3 surface protocol can reuse the SAME root-confinement
// logic the file IPC path already trusts. Pure Node — no Electron imports —
// so the compiled-node test runner covers it directly.

import * as fs from 'fs';
import * as path from 'path';
import type { PathType } from '../../shared/types';
import { ensureWslPath } from '../path-utils';

export function normalizeWslPath(p: string): string {
  const normalized = path.posix.normalize(p.replace(/\\/g, '/').replace(/\/+/g, '/'));
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function normalizeWindowsPath(p: string): string {
  return path.resolve(p);
}

export function isWindowsPathInside(targetPath: string, rootDirectory: string): boolean {
  const target = normalizeWindowsPath(targetPath);
  const root = normalizeWindowsPath(rootDirectory);
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isWslPathInside(targetPath: string, rootDirectory: string): boolean {
  const target = normalizeWslPath(ensureWslPath(targetPath, 'wsl'));
  const root = normalizeWslPath(ensureWslPath(rootDirectory, 'wsl'));
  if (target === root) return true;
  if (root === '/') return target.startsWith('/');
  return target.startsWith(`${root}/`);
}

export function assertInsideRoot(targetPath: string, rootDirectory: string, pathType: PathType): void {
  const inside = pathType === 'wsl'
    ? isWslPathInside(targetPath, rootDirectory)
    : isWindowsPathInside(targetPath, rootDirectory);
  if (!inside) {
    throw new Error('Target path is outside the working directory');
  }
}

/**
 * Realpath-resolve `requestedPath` and return it only if it lands inside one
 * of `roots` (Windows path semantics; roots are realpath'd too so a symlinked
 * root still matches its canonical form). Returns `null` — never throws — on:
 *   - nonexistent paths (realpath fails),
 *   - `..` traversal escaping every root,
 *   - symlinks/junctions whose canonical target lies outside every root.
 * Designed for protocol handlers (media://, surface://) where the only safe
 * answer to anything questionable is a 404.
 */
export function resolveConfined(requestedPath: string, roots: string[]): string | null {
  let real: string;
  try {
    real = fs.realpathSync.native(requestedPath);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      continue; // unreadable/missing root can't admit anything
    }
    if (isWindowsPathInside(real, realRoot)) return real;
  }
  return null;
}
