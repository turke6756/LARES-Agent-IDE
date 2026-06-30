// Context-Overhead Analyzer — pure path operations (plan §3).
//
// The walk-up ascends absolute paths that may be Windows (`C:\Users\…`) or
// WSL/POSIX (`/home/…`). Node's `path` module would key off the HOST os, which
// is wrong when a Windows-hosted dashboard analyzes a WSL workspace. So we drive
// every path operation through a tiny pure abstraction selected by `pathType`,
// operating on a canonical forward-slash form. Electron-free + dep-free →
// unit-testable.

import type { PathType } from '../../shared/types';

export interface PathOps {
  /** Canonical absolute form: forward slashes, `.`/`..` collapsed, no trailing
   *  slash except at the filesystem root. */
  resolve(p: string): string;
  /** Parent directory (resolved). Returns the same path when already root. */
  dirname(p: string): string;
  /** Join `rel` onto `base` (a directory). Absolute `rel` wins. */
  join(base: string, rel: string): string;
  isAbsolute(p: string): boolean;
  /** True when `child` is `ancestor` or nested beneath it (both resolved). */
  isWithin(child: string, ancestor: string): boolean;
  isFilesystemRoot(p: string): boolean;
}

function normalizeSegments(rest: string): string[] {
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

function makeWindowsOps(): PathOps {
  const DRIVE = /^([a-zA-Z]:)/;
  const ops: PathOps = {
    isAbsolute(p) {
      const f = p.replace(/\\/g, '/');
      return /^[a-zA-Z]:\//.test(f) || /^[a-zA-Z]:$/.test(f);
    },
    resolve(p) {
      const f = p.replace(/\\/g, '/');
      const m = f.match(DRIVE);
      const drive = m ? m[1] : 'C:';
      const rest = m ? f.slice(m[1].length) : f;
      const segs = normalizeSegments(rest);
      return segs.length ? `${drive}/${segs.join('/')}` : `${drive}/`;
    },
    dirname(p) {
      const r = ops.resolve(p);
      if (ops.isFilesystemRoot(r)) return r;
      const idx = r.lastIndexOf('/');
      const head = r.slice(0, idx);
      // `C:` → `C:/` (root), otherwise the directory portion.
      return /^[a-zA-Z]:$/.test(head) ? `${head}/` : head;
    },
    join(base, rel) {
      if (ops.isAbsolute(rel)) return ops.resolve(rel);
      return ops.resolve(`${ops.resolve(base)}/${rel}`);
    },
    isWithin(child, ancestor) {
      const c = ops.resolve(child);
      const a = ops.resolve(ancestor);
      if (c === a) return true;
      const prefix = a.endsWith('/') ? a : `${a}/`;
      return c.startsWith(prefix);
    },
    isFilesystemRoot(p) {
      return /^[a-zA-Z]:\/$/.test(ops.resolve(p));
    },
  };
  return ops;
}

function makePosixOps(): PathOps {
  const ops: PathOps = {
    isAbsolute(p) {
      return p.replace(/\\/g, '/').startsWith('/');
    },
    resolve(p) {
      const f = p.replace(/\\/g, '/');
      const segs = normalizeSegments(f);
      return segs.length ? `/${segs.join('/')}` : '/';
    },
    dirname(p) {
      const r = ops.resolve(p);
      if (r === '/') return '/';
      const idx = r.lastIndexOf('/');
      return idx <= 0 ? '/' : r.slice(0, idx);
    },
    join(base, rel) {
      if (ops.isAbsolute(rel)) return ops.resolve(rel);
      return ops.resolve(`${ops.resolve(base)}/${rel}`);
    },
    isWithin(child, ancestor) {
      const c = ops.resolve(child);
      const a = ops.resolve(ancestor);
      if (c === a) return true;
      const prefix = a === '/' ? '/' : `${a}/`;
      return c.startsWith(prefix);
    },
    isFilesystemRoot(p) {
      return ops.resolve(p) === '/';
    },
  };
  return ops;
}

export function makePathOps(pathType: PathType): PathOps {
  return pathType === 'windows' ? makeWindowsOps() : makePosixOps();
}
