// WP4 — Strict hook-unavailable PTY prompt classifier.
//
// A PURE classifier over the PTY ring tail. It recognizes the handful of
// blocking interactive prompts a provider TUI shows at a fresh terminal —
// workspace-trust, sign-in, approval, yes/no, a numbered selection menu, a
// press-Enter gate — using high-confidence provider chrome / exact wording,
// NEVER loose heuristics.
//
// Why it exists: when the status hooks can't run (no Node on PATH), a launch
// can silently stall on one of these dialogs with nothing on the card. This
// classifier lets the fallbacks (WP7 launch/waiting resolution, WP5 send-outcome
// diagnostics) name what the terminal is blocked on so the human can key it
// through. See plans/hook-absence-resilience.md §WP4.
//
// PURITY: no I/O, no clock, no state. Same input → same output. The caller owns
// stability (see the stability contract below). The function strips ANSI itself
// (idempotent) so callers may pass a raw ring tail.
//
// ── Stability contract for callers that DRIVE STATUS (WP7) ──────────────────
// A returned match may drive a status transition (e.g. forceWaiting) ONLY if it
//   (a) is an exact high-confidence signature (every kind here is — that is the
//       whole point of the strict signature set), AND
//   (b) reproduces across two consecutive polls of a settled tail, AND
//   (c) no substantive output followed it (a prompt the agent has already moved
//       past is not a live block).
// Every OTHER use of this classifier is diagnostic only (WP5 send-outcome
// annotation), where a single-shot read is acceptable because it only labels an
// already-degraded outcome, never drives state. This module intentionally does
// NOT implement (b)/(c) — they depend on time and repeated reads the caller
// holds; keeping the classifier pure is what makes it safe to reuse from both
// the status-driving and the diagnostic paths.

import { stripAnsi } from './strip-ansi';

export type InteractivePromptKind =
  | 'trust-dialog'
  | 'hook-trust'
  | 'sign-in'
  | 'approval'
  | 'yes-no'
  | 'choice'
  | 'press-enter';

export interface InteractivePromptMatch {
  kind: InteractivePromptKind;
  /** Human-facing name of the prompt for tooltips / event copy. */
  label: string;
  /** The cleaned line (or matched span) that triggered the classification. */
  excerpt: string;
}

const EXCERPT_MAX = 160;

/** Box-drawing / bullet chrome we strip from an excerpt so a tooltip reads as
 *  prose, not as a fragment of a TUI border. */
const BOX_CHROME = /[│┃┆┇┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼╭╮╯╰─━╌╍═║╱╲╳▌▐█▏▕]/g;

interface Cleaned {
  /** ANSI-stripped, per-line (chrome preserved for `❯` detection). */
  lines: string[];
  /** All lines joined with single spaces + collapsed whitespace. Lets a
   *  signature match even when the terminal WRAPPED it across two rows. */
  joined: string;
}

function clean(rawTail: string): Cleaned {
  // stripAnsi is idempotent, so a caller passing an already-stripped tail is fine.
  const stripped = stripAnsi(rawTail);
  const lines = stripped.split(/\r?\n/);
  const joined = stripped.replace(/\s+/g, ' ').trim();
  return { lines, joined };
}

/** Turn a raw matched line/span into a tooltip-ready excerpt. */
function excerptOf(text: string): string {
  const cleaned = text.replace(BOX_CHROME, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > EXCERPT_MAX ? `${cleaned.slice(0, EXCERPT_MAX - 1)}…` : cleaned;
}

/** First cleaned line matching `re` (chrome stripped for the test), else null. */
function lineMatching(c: Cleaned, re: RegExp): string | null {
  for (const line of c.lines) {
    const bare = line.replace(BOX_CHROME, ' ');
    if (re.test(bare)) return excerptOf(line);
  }
  return null;
}

/** A signature: an ordered, exact, high-confidence recognizer. `match` returns
 *  an excerpt string when it fires, else null. Order in SIGNATURES is priority
 *  order — the most specific dialogs are tested first so an approval box that
 *  also contains a `(y/n)` reads as `approval`, not `yes-no`. */
interface Signature {
  kind: InteractivePromptKind;
  label: string;
  match(c: Cleaned): string | null;
}

// Explicit FORBIDDEN matches (do NOT recognize — enforced by the strict
// signatures below and asserted in the test):
//   • any trailing `?` treated as a generic question,
//   • a bare numbered list with no selection chrome (`❯`),
//   • the substring "Sign in" appearing inside ordinary prose.
// There is deliberately NO generic prose-question fallback.

const SIGNATURES: Signature[] = [
  {
    kind: 'trust-dialog',
    label: 'workspace trust dialog',
    // Claude Code / Codex workspace-trust box. Exact wording; the box chrome
    // around it is stripped before the test so a wrapped or bordered copy
    // still matches on the joined text.
    match: (c) =>
      /do you trust the files in this folder/i.test(c.joined)
        ? lineMatching(c, /do you trust the files/i) ?? excerptOf('Do you trust the files in this folder?')
        : null,
  },
  {
    kind: 'hook-trust',
    label: 'hook trust dialog',
    // Codex hook trust-review prompt. Requires the DIALOG form — a second-person
    // question/command about a hook ("Do you trust this hook…", "A hook wants to
    // run…") — NOT a bare statement that merely co-mentions "trust" and "hook"
    // (e.g. prose like "I trust that the hook configuration is correct"). The
    // interrogative/imperative shape is the signature.
    match: (c) =>
      /\bhook\b[^.]*\bwants to (run|execute|proceed)/i.test(c.joined)
      || /do you (want to )?(trust|allow|approve)\b[^.]*\bhook/i.test(c.joined)
      || /do you (want to )?(trust|allow|approve)\b[^.]*\bthis (hook|session)/i.test(c.joined)
        ? lineMatching(c, /\bhook\b|do you (want to )?(trust|allow|approve)/i) ?? excerptOf(c.joined)
        : null,
  },
  {
    kind: 'sign-in',
    label: 'sign-in prompt',
    // Provider login chrome. NOT a bare "Sign in" in prose — requires the
    // login-method menu, an explicit "Log in with <provider>", an OAuth
    // "paste the code / visit <url> to authenticate" gate, or agy's captured
    // startup auth chrome. The agy signature requires its branded welcome plus
    // the exact signed-out state so ordinary prose containing "sign in" stays
    // forbidden (Phase-0 probe §0.1a).
    match: (c) =>
      /select login method/i.test(c.joined)
      || /\blog ?in with \S/i.test(c.joined)
      || /choose an authentication method/i.test(c.joined)
      || /(visit|open) https?:\/\/\S+ to (authenticate|sign in|log ?in)/i.test(c.joined)
      || /paste (the|your) (code|authorization code) here/i.test(c.joined)
      || (/welcome to the antigravity cli/i.test(c.joined)
        && /you are currently not signed in/i.test(c.joined))
        ? lineMatching(c, /select login method|log ?in with \S|authentication method|to (authenticate|sign in|log ?in)|paste (the|your) (code|authorization code)|you are currently not signed in/i)
            ?? excerptOf(c.joined)
        : null,
  },
  {
    kind: 'approval',
    label: 'approval prompt',
    // Permission / proceed box (Claude tool-permission, Codex command approval).
    match: (c) =>
      /do you want to proceed/i.test(c.joined)
      || /\bdo you want to (allow|make this edit|run|create|apply)/i.test(c.joined)
        ? lineMatching(c, /do you want to (proceed|allow|make this edit|run|create|apply)/i)
            ?? excerptOf(c.joined)
        : null,
  },
  {
    kind: 'press-enter',
    label: 'press-enter prompt',
    match: (c) =>
      /press enter to continue/i.test(c.joined)
        ? lineMatching(c, /press enter to continue/i) ?? excerptOf('Press Enter to continue')
        : null,
  },
  {
    kind: 'yes-no',
    label: 'yes/no prompt',
    // An explicit y/n affordance on a prompt line: (y/n), [Y/n], (yes/no), etc.
    // The bracketed/parenthesized y-then-n token is the signature — NOT a bare
    // trailing "?".
    match: (c) => lineMatching(c, /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i),
  },
  {
    kind: 'choice',
    label: 'selection prompt',
    // A numbered menu WITH selection chrome (`❯`). The `❯` cursor plus at least
    // one numbered option is required — a bare numbered list is explicitly NOT
    // a choice prompt (forbidden above).
    match: (c) => {
      const hasCursor = c.lines.some((l) => l.includes('❯'));
      if (!hasCursor) return null;
      const numbered = c.lines.find((l) => /^\s*❯?\s*\d+[.)]\s+\S/.test(l.replace(BOX_CHROME, ' ')));
      if (!numbered) return null;
      // The excerpt is the highlighted (`❯`) option when we can find it, else
      // the first numbered option.
      const cursorLine = c.lines.find((l) => l.includes('❯') && /\d/.test(l));
      return excerptOf(cursorLine ?? numbered);
    },
  },
];

/**
 * Classify the current PTY ring tail. Returns the single highest-priority
 * blocking-prompt match, or null when the tail shows no recognized prompt.
 *
 * PURE: no side effects; safe to call from both the status-driving path (under
 * the stability contract above) and the diagnostic path.
 */
export function detectInteractivePrompt(rawTail: string | null | undefined): InteractivePromptMatch | null {
  if (!rawTail) return null;
  const c = clean(rawTail);
  if (c.joined.length === 0) return null;
  for (const sig of SIGNATURES) {
    const excerpt = sig.match(c);
    if (excerpt !== null) {
      return { kind: sig.kind, label: sig.label, excerpt };
    }
  }
  return null;
}
