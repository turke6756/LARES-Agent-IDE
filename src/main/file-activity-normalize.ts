// Checkpoint Surface Hardening WP1 — the shared, side-effect-free normalizer for
// witnessed file paths. Created here (WP1) and reused by WP2's historical backfill
// and WP4's `file` filter. Two responsibilities, kept strictly separate:
//
//   1. `unwrapOsc8` — recover a human path from an OSC-8 terminal hyperlink whose
//      escape framing may be intact (ST- or BEL-terminated) or ESC-eaten degraded.
//      Recovery is CONSERVATIVE: anything structurally ambiguous is reported as
//      `{ ambiguous: true }` and the caller DROPS it. Witnessed paths are
//      authorization-adjacent evidence, so a wrong guess is worse than a lost row.
//
//   2. `canonicalizeToAbsolute` — turn a recovered path into a single canonical
//      form. Windows-shaped inputs (drive, UNC, `file:`, `~`, relative) resolve to
//      an absolute NATIVE (backslash) path; POSIX-absolute (WSL `/…`) inputs are
//      preserved as POSIX — flipping them to backslashes would corrupt real WSL
//      paths, and `file_activities` is display-only. Out-of-workspace is NOT
//      rejected here (only the witness join scope-rejects, via `normalizeWitnessPath`).
//
// This module produces `file_activities.file_path` values only. The distinct
// `turn_records.touched[].path` canonicalizer (`normalizeWitnessPath`, workspace-
// relative POSIX) is deliberately NON-interchangeable with this one.

import path from 'path';

export type Osc8Result = { text: string } | { ambiguous: true };

/**
 * Recover the path carried by an OSC-8 hyperlink.
 *
 * Intact grammar:
 *   ESC ]8;<params>;<uri>(ST|BEL)<display>ESC ]8;;(ST|BEL)
 * ESC-eaten degraded grammar (the live pollution — Claude's TUI uses ST, which
 * the old BEL-only stripper couldn't match, so the final control strip ate the
 * bare ESC bytes and left the literal marker text):
 *   ]8;<params>;<uri>…]8;;
 *
 * Recovery policy (conservative):
 *   - exactly one opener + one closer with non-empty display text → the display
 *     text (the human-visible path);
 *   - display empty but a `file:` URI is present → the URI (canonicalize decodes it);
 *   - anything else (no marker → passthrough of the untouched input; nested,
 *     unbalanced, multiple, or both-empty → ambiguous → drop).
 *
 * This is a SCANNER, not a regex splice: it counts markers and validates the
 * opener/closer structure before extracting, so a malformed or multi-link value
 * fails closed instead of being spliced into a plausible-but-wrong path.
 */
export function unwrapOsc8(raw: string): Osc8Result {
  if (raw == null) return { text: '' };
  const s = String(raw);

  // No OSC-8 marker at all → the overwhelmingly common clean case. Passthrough.
  if (!s.includes(']8;')) return { text: s };

  // Count `]8;` markers. A well-formed single hyperlink has exactly two (one in
  // the opener, one in the closer). Zero is handled above; one is unbalanced;
  // three or more is nested/multiple — all ambiguous.
  let count = 0;
  for (let i = s.indexOf(']8;'); i !== -1; i = s.indexOf(']8;', i + 3)) count++;
  if (count !== 2) return { ambiguous: true };

  const m1 = s.indexOf(']8;');
  const m2 = s.indexOf(']8;', m1 + 3);

  // Opener: `]8;<params>;` — params run to the next `;`, which must precede the
  // closer marker.
  const semi = s.indexOf(';', m1 + 3);
  if (semi === -1 || semi >= m2) return { ambiguous: true };

  // Closer must be `]8;;` (empty params, empty uri) followed only by optional
  // terminator residue / whitespace. A trailing path-shaped tail means the second
  // marker is not a real closer → ambiguous.
  if (s[m2 + 3] !== ';') return { ambiguous: true };
  if (!/^(?:\x1b\\|\x07|\x1b|\\)?\s*$/.test(s.slice(m2 + 4))) return { ambiguous: true };

  // Region between the opener's params-semicolon and the closer marker:
  //   intact:   <uri>(ST|BEL)<display>
  //   degraded: <uri>[\]<display>   (ST's ESC eaten; the bare `\` residue, if any)
  // The closer's own leading ESC (intact `ESC]8;;`) sits at m2-1 — exclude it so
  // it is not captured as a trailing byte of the display.
  const closerStart = s[m2 - 1] === '\x1b' ? m2 - 1 : m2;
  const region = s.slice(semi + 1, closerStart);

  // Locate the earliest real terminator (BEL or ST/ESC). Its presence means an
  // intact sequence whose display we can separate cleanly.
  const bel = region.indexOf('\x07');
  const esc = region.indexOf('\x1b');
  let termPos = -1;
  let termLen = 0;
  if (bel !== -1 && (esc === -1 || bel < esc)) {
    termPos = bel;
    termLen = 1;
  } else if (esc !== -1) {
    termPos = esc;
    termLen = region[esc + 1] === '\\' ? 2 : 1; // ST is ESC '\'
  }

  let display = '';
  let uri = '';
  if (termPos !== -1) {
    // Intact: uri up to the terminator, display after it.
    uri = region.slice(0, termPos);
    display = region.slice(termPos + termLen);
  } else {
    // Degraded: no real terminator survived. The uri/display boundary is not
    // reliably recoverable, so treat display as empty and recover from the
    // `file:` URI instead (a well-formed file: URI never contains a literal
    // backslash or space, so it terminates at the first such character).
    const fileMatch = region.match(/file:[^\s\\\x00-\x1f]*/i);
    uri = fileMatch ? fileMatch[0] : '';
    display = '';
  }

  display = display.trim();
  if (display !== '') return { text: display };

  // No usable display → fall back to a `file:` URI if present (canonicalize decodes it).
  uri = uri.trim();
  if (/^file:/i.test(uri)) return { text: uri };

  return { ambiguous: true };
}

/**
 * Strip any CSI / charset / mode / stray-ESC / control residue left after
 * `unwrapOsc8`. A parsing aid — never strips `\` (load-bearing on Windows) and
 * never touches OSC-8 (that is `unwrapOsc8`'s job).
 */
export function stripTerminalEscapes(raw: string): string {
  if (raw == null) return '';
  return String(raw)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (incl. mode changes)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')       // charset designators
    .replace(/\x1b\\?/g, '')                    // stray ST / bare ESC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // control chars (keep \t \n \r)
}

export interface CanonicalizeCtx {
  cwd?: string;
  home?: string;
}

/** Percent-decode, tolerating a malformed `%` (leave the string untouched). */
function decodePercent(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalize a Windows-shaped path to canonical native form (backslashes,
 *  collapsed `.`/`..`, upper-case drive letter). Idempotent. */
function winNormalize(p: string): string {
  let s = p.replace(/\//g, '\\');
  s = path.win32.normalize(s);
  s = s.replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ':');
  return s;
}

/** Normalize a POSIX-shaped path (collapsed `.`/`..`, forward slashes). Idempotent. */
function posixNormalize(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

/** True for a Windows-shaped absolute/rooted spelling (drive, UNC). */
function isWindowsShaped(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s) || /^[A-Za-z]:$/.test(s) || s.startsWith('\\\\') || (s.startsWith('//') && !s.startsWith('///'));
}

/** Decode a `file:` URI to a native (or POSIX, for `/…`) absolute path, or `''`. */
function fileUriToPath(uri: string): string {
  let s = uri.replace(/^file:/i, '');
  let authority = '';
  if (s.startsWith('//')) {
    s = s.slice(2);
    const slash = s.indexOf('/');
    if (slash === -1) {
      authority = s;
      s = '';
    } else {
      authority = s.slice(0, slash);
      s = s.slice(slash); // keep the leading '/'
    }
  }
  s = decodePercent(s);
  authority = decodePercent(authority);

  // Authored host (not empty / localhost) → UNC share.
  if (authority && authority.toLowerCase() !== 'localhost') {
    const share = s.replace(/^\//, '').replace(/\//g, '\\');
    return winNormalize('\\\\' + authority + '\\' + share);
  }

  // Drive path: `/C:/…`.
  const drive = s.match(/^\/([A-Za-z]):(.*)$/);
  if (drive) return winNormalize(drive[1].toUpperCase() + ':' + drive[2]);

  // POSIX absolute.
  if (s.startsWith('/')) return posixNormalize(s);

  // No usable path component.
  return s === '' ? '' : winNormalize(s);
}

/**
 * Canonicalize a recovered path to a single stable form.
 *
 * Coverage: `file:` URIs (percent-decode, scheme/authority strip, drive + UNC);
 * `~` / `~/…` whole-leading-segment home expansion (never `~foo`); relative →
 * resolve via `cwd`; absolute passthrough + normalize; separator normalization to
 * native for Windows-shaped paths; drive-letter upcasing; UNC; empty / control-only
 * → `''`. POSIX-absolute (`/…`, WSL) is preserved as POSIX. Idempotent:
 * `f(f(x)) === f(x)`.
 */
export function canonicalizeToAbsolute(raw: string, ctx: CanonicalizeCtx = {}): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (s === '') return '';
  if (/^[\x00-\x1f\x7f]+$/.test(s)) return '';

  // 1. file: URI.
  if (/^file:/i.test(s)) return fileUriToPath(s);

  // 2. `~` home expansion — only as a whole leading segment.
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    const home = ctx.home;
    if (home) {
      const rest = s === '~' ? '' : s.slice(2);
      if (home.startsWith('/') && !isWindowsShaped(home)) {
        return posixNormalize(home.replace(/\/+$/, '') + '/' + rest.replace(/\\/g, '/'));
      }
      return winNormalize(path.win32.join(home, rest.replace(/\//g, '\\')));
    }
    // No home to expand against — leave the value normalized rather than dropping
    // it (display-only; the witness join independently scope-rejects).
    return winNormalize(s);
  }

  // 3. POSIX absolute (WSL) — keep POSIX separators.
  if (s.startsWith('/') && !s.startsWith('//')) return posixNormalize(s);

  // 4. UNC / Windows absolute (drive-rooted or bare drive).
  if (s.startsWith('\\\\') || s.startsWith('//')) return winNormalize(s);
  if (/^[A-Za-z]:[\\/]/.test(s)) return winNormalize(s);
  if (/^[A-Za-z]:$/.test(s)) return winNormalize(s + '\\');

  // 5. Relative → resolve against cwd (preserving cwd's spelling style).
  const cwd = ctx.cwd;
  if (cwd) {
    if (cwd.startsWith('/') && !isWindowsShaped(cwd)) {
      return posixNormalize(cwd.replace(/\/+$/, '') + '/' + s.replace(/\\/g, '/'));
    }
    return winNormalize(path.win32.resolve(cwd, s));
  }

  // 6. Relative with no cwd → cannot make absolute; leave normalized rather than
  //    drop (file_activities is display-only). Windows-ish spelling → native.
  return s.includes('\\') ? winNormalize(s) : posixNormalize(s);
}

/**
 * Cheap prefilter for WP2's historical migration: does this value plausibly
 * carry escape/OSC pollution? A raw ESC, an OSC-8 marker, or an embedded `file:`
 * segment are the three signatures.
 */
export function looksPolluted(raw: string): boolean {
  if (raw == null) return false;
  const s = String(raw);
  return s.includes('\x1b') || s.includes(']8;') || s.includes(';file:');
}
