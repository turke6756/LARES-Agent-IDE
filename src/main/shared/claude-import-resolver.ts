// Shared `@import` resolver for CLAUDE.md / SKILL.md files (base plan §3.2).
//
// Extracted from `context-overhead/walk-up.ts` so both the overhead walk and the
// knowledge extractor (D3) resolve `@path` imports the same way, without coupling
// knowledge extraction to overhead internals. Pure: all IO is injected via
// `readFn`; path math is self-contained (Windows + POSIX) but overridable.
//
// NOTE (WP0 scope): `walk-up.ts` still carries its own private copy of
// `extractClaudeImports` (identical logic below). P1 rewires walk-up to import
// from here; WP0 deliberately does not touch walk-up (minimal diff on the shared
// tree). The two copies are byte-identical so behavior cannot drift meanwhile.

const IMPORT_MAX_DEPTH = 4;

/** Extract `@path` import targets from a CLAUDE.md body. Skips fenced code
 *  blocks (``` … ```), inline code spans (`…`), and backtick-escaped tokens
 *  (`@README`). Returns raw path strings in document order (relative or
 *  absolute). An `@` only starts an import at a line boundary or after
 *  whitespace, so `foo@bar.com` is never treated as an import. */
export function extractClaudeImports(markdown: string): string[] {
  const noFences = markdown.replace(/```[\s\S]*?```/g, '');
  const noInline = noFences.replace(/`[^`]*`/g, '');
  const out: string[] = [];
  const re = /(?:^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noInline)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// ── path ops (self-contained; overridable so walk-up can inject its PathOps) ──

export interface ImportPathOps {
  isAbsolute(p: string): boolean;
  dirname(p: string): string;
  join(dir: string, rel: string): string;
}

function isAbsolute(p: string): boolean {
  // POSIX root, Windows drive (C:\ or C:/), or UNC (\\server).
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p) || /^\\\\/.test(p);
}

function normalizeSegments(p: string): string {
  const isAbs = isAbsolute(p);
  const norm = p.replace(/\\/g, '/');
  const driveMatch = /^[a-zA-Z]:/.exec(norm);
  const drive = driveMatch ? driveMatch[0] : '';
  const rest = drive ? norm.slice(drive.length) : norm;
  const leadingSlash = rest.startsWith('/');
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!isAbs) out.push('..'); continue; }
    out.push(seg);
  }
  return drive + (leadingSlash ? '/' : '') + out.join('/');
}

const defaultPathOps: ImportPathOps = {
  isAbsolute,
  dirname(p) {
    const norm = p.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx <= 0 ? norm.slice(0, idx + 1) || '/' : norm.slice(0, idx);
  },
  join(dir, rel) {
    return normalizeSegments(`${dir.replace(/\\/g, '/')}/${rel}`);
  },
};

// ── resolution ────────────────────────────────────────────────────────────────

export interface ResolvedImport {
  /** The raw `@token` text as written in the source file. */
  rawPath: string;
  /** Absolute path the token resolves to (relative tokens joined to the parent's dir). */
  resolvedPath: string;
  /** File that contained the `@import` (the root `absPath` for depth-1 imports). */
  parentPath: string;
  /** 1 = a direct import of the root file; 2 = an import of an import; … */
  depth: number;
  /** `readFn` returned content for `resolvedPath`. */
  exists: boolean;
  /** Already resolved earlier in this walk (walk-up's dedup placeholder case). */
  duplicate: boolean;
  /** Children were not expanded because `maxDepth` was reached at this node. */
  depthLimited: boolean;
}

/** Resolve the transitive `@import` graph rooted at `absPath`, reading files via
 *  `readFn` (returns file text or null when missing/unreadable). Returns imports
 *  in depth-first document order. Each distinct resolved path appears once
 *  (`duplicate:true` on re-encounter) — cycle-safe and dedup-consistent with the
 *  overhead walk. Expansion stops at `maxDepth` hops (default 4). */
export function resolveClaudeImports(
  absPath: string,
  readFn: (p: string) => string | null,
  maxDepth: number = IMPORT_MAX_DEPTH,
  pathOps: ImportPathOps = defaultPathOps,
): ResolvedImport[] {
  const out: ResolvedImport[] = [];
  const seen = new Set<string>([absPath]);

  const walk = (parentPath: string, depth: number): void => {
    if (depth > maxDepth) return;
    const content = readFn(parentPath);
    if (content === null) return;
    for (const raw of extractClaudeImports(content)) {
      const resolved = pathOps.isAbsolute(raw)
        ? raw
        : pathOps.join(pathOps.dirname(parentPath), raw);
      if (seen.has(resolved)) {
        out.push({ rawPath: raw, resolvedPath: resolved, parentPath, depth, exists: true, duplicate: true, depthLimited: false });
        continue;
      }
      seen.add(resolved);
      const childContent = readFn(resolved);
      const exists = childContent !== null;
      const depthLimited = exists && depth >= maxDepth;
      out.push({ rawPath: raw, resolvedPath: resolved, parentPath, depth, exists, duplicate: false, depthLimited });
      if (exists && !depthLimited) walk(resolved, depth + 1);
    }
  };

  walk(absPath, 1);
  return out;
}
