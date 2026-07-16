// file-access-path.ts — canonical path identity for the guidance→file-access
// occurrence match (Priority 0, WP-1B). The ONE place that turns a raw path token
// (a guidance backtick, a Read/Edit arg, an executed-script token) into a
// canonical absolute form + optional workspace-relative form.
//
// WHY this exists: the compiler (guidance side) and the ingestion (behavior side)
// MUST agree byte-for-byte on what "the same file" means, or a legitimate read is
// classified `never`. Both sides call THIS module, and it delegates the actual
// Windows/WSL/POSIX folding to `normalizeExecPath` (skill-analytics), which is the
// already-tested §4.3 canonicalizer used for executed scripts. Reusing it — rather
// than re-deriving casing/slash/`..` rules — is what guarantees the two sides fold
// identically (e.g. `/mnt/c/x` and `C:\x` collapse to one key).
//
// Honesty boundaries encoded here (see brief risks):
//  • A token we cannot resolve to a genuine absolute (bare relative with no cwd,
//    a glob/variable token) yields `canonicalAbs === undefined`. Callers MUST treat
//    that as candidate-only — NEVER suffix/basename-match it into a subtract signal.
//  • We never rewrite the raw evidence; `raw` is preserved verbatim for citation.
//
// Pure, IO-free.

import { normalizeExecPath } from '../skill-analytics/command-path-extractor';

export type FileAccessMode = 'read' | 'write' | 'executed';
export type FileAccessBase = 'agent-cwd' | 'workspace-root' | 'source-dir' | 'unknown';

export interface CanonicalFileAccess {
  /** The token exactly as compiled/ingested (leading `@` stripped, else verbatim). */
  raw: string;
  /** Canonical absolute form (Windows drive `C:\…` or genuine POSIX `/…`), or
   *  undefined when the token could not be resolved to a real absolute path. */
  canonicalAbs?: string;
  /** Forward-slash, root-anchored workspace-relative form (no leading slash), or
   *  undefined when no workspace root is known or the path is outside it. */
  workspaceRelative?: string;
}

/** True for a token carrying glob/variable/subshell metachars — never resolvable to
 *  a single concrete file, so never eligible for a canonical-abs subtract match. */
export function hasUnresolvableMeta(token: string): boolean {
  return /[*?]/.test(token) || /\$\(|`|\$\w|\$\{|%[^%]+%/.test(token);
}

/** Strip a leading `@` import marker and trim; slashes are left for the canonicalizer. */
function stripToken(raw: string): string {
  return raw.replace(/^@/, '').trim();
}

/** Forward-slash a canonical path for workspace-relative comparison (case preserved;
 *  LOWER() is applied at match time, mirroring the `arg_path` heat-key convention). */
function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Canonicalize a raw path token against a base working directory (and, when known,
 * a workspace root). `cwd` is the representative agent cwd on the compiler side and
 * the stream's recorded working directory on the ingestion side — passing the SAME
 * kind of base on both sides is what makes the two canonical forms line up.
 *
 * Returns `canonicalAbs: undefined` (candidate-only) when:
 *  - the token carries glob/variable metachars, OR
 *  - it is relative and `cwd` is missing/blank (historical rows with no recorded cwd
 *    stay unresolved — they must NOT be suffix-matched, per the brief).
 */
export function canonicalizeAccessPath(
  raw: string,
  cwd: string | null | undefined,
  workspaceRoot?: string | null,
): CanonicalFileAccess {
  const token = stripToken(raw);
  if (!token || hasUnresolvableMeta(token)) return { raw: token || raw };

  const ep = normalizeExecPath(token, cwd ?? null);
  const canonicalAbs = ep.normalizedPath ?? undefined;
  if (!canonicalAbs) return { raw: token };

  const out: CanonicalFileAccess = { raw: token, canonicalAbs };
  const rel = workspaceRelativeOf(canonicalAbs, workspaceRoot);
  if (rel !== undefined) out.workspaceRelative = rel;
  return out;
}

/** Root-anchored workspace-relative form of an already-canonical absolute path, or
 *  undefined when the root is unknown or the path is not under it. Case-insensitive
 *  prefix test (Windows-friendly); the returned string preserves the canonical case. */
export function workspaceRelativeOf(
  canonicalAbs: string,
  workspaceRoot: string | null | undefined,
): string | undefined {
  if (!workspaceRoot || !workspaceRoot.trim()) return undefined;
  const rootCanon = normalizeExecPath(workspaceRoot, null).normalizedPath;
  if (!rootCanon) return undefined;
  const a = fwd(canonicalAbs);
  const r = fwd(rootCanon).replace(/\/+$/, '');
  const al = a.toLowerCase();
  const rl = r.toLowerCase();
  if (al === rl) return '';
  if (al.startsWith(rl + '/')) return a.slice(r.length + 1);
  return undefined;
}

// ── Verb → access-mode lexicon (small, explicit; downgrade on ambiguity) ─────────
// Conservative per the brief: read/check/open/inspect → read; save/update/write →
// write. An instruction that names BOTH senses, or NEITHER, is ambiguous → [] (any
// touch), and the caller keeps it candidate-only (cannot support an observed-safe
// subtract).
const READ_VERBS = /\b(read|re-?read|check|re-?check|open|inspect|review|consult|refer\s+to|see|look\s+at|load|view|examine)\b/i;
const WRITE_VERBS = /\b(write|re-?write|save|update|edit|modify|append|create|overwrite|persist|record\s+to|add\s+to)\b/i;

/**
 * Infer the required access mode(s) from an instruction's prose. Returns:
 *  - `['read']`  when only read-sense verbs are present,
 *  - `['write']` when only write-sense verbs are present,
 *  - `[]`        when both or neither are present (AMBIGUOUS → any touch, candidate-only).
 * Deliberately small: we downgrade rather than guess.
 */
export function inferAccessModes(text: string): FileAccessMode[] {
  const hasRead = READ_VERBS.test(text);
  const hasWrite = WRITE_VERBS.test(text);
  if (hasRead && !hasWrite) return ['read'];
  if (hasWrite && !hasRead) return ['write'];
  return [];
}
