// P2-02: shared PTY prompt-pattern detector. Returns a match for known
// "agent is blocked on user input" terminal prompts: yes/no confirmations,
// "Press Enter to continue", numbered choice lists, plan-mode approvals.
//
// Match contract:
// - Only the last 512 bytes of the input are considered, so a stale prompt
//   deeper in scrollback doesn't trigger a false positive.
// - Patterns are anchored to end-of-line / end-of-input where appropriate.
// - Caller is expected to ANSI-strip and quietness-gate (≥2s since last
//   meaningful burst) BEFORE calling; the detector itself is pure.
//
// Per the plan's §2.3.2 tightening, the bare `❯` cursor pattern and any
// `\s*$` anchor have been removed to avoid false positives on shell prompts.

export type PromptKind = 'y-n' | 'enter' | 'choice' | 'approve';

export interface PromptMatch {
  kind: PromptKind;
  excerpt: string;
}

const TAIL_BYTES = 512;

const PROMPT_PATTERNS: { kind: PromptKind; re: RegExp }[] = [
  { kind: 'y-n', re: /\((?:y|Y)\/(?:n|N)\)\s*\??\s*$/m },
  { kind: 'y-n', re: /\[(?:y|Y)\/(?:n|N)\]\s*\??\s*$/m },
  { kind: 'enter', re: /Press\s+(?:Enter|RETURN|any\s+key)\b/i },
  { kind: 'choice', re: /\bChoose\s+(?:an\s+)?option\b/i },
  // ≥2 numbered options like `1) foo\n2) bar`.
  { kind: 'choice', re: /(?:^|\n)\s*\d+\)\s+\S.*\n(?:.*\n)*?\s*\d+\)\s+\S/ },
  { kind: 'approve', re: /\bApprove\s*\?\s*$/m },
];

/** Pure detector. `strippedTail` must already have ANSI escapes removed. */
export function match(strippedTail: string): PromptMatch | null {
  if (!strippedTail) return null;
  const slice = strippedTail.length > TAIL_BYTES
    ? strippedTail.slice(strippedTail.length - TAIL_BYTES)
    : strippedTail;

  for (const pat of PROMPT_PATTERNS) {
    const m = pat.re.exec(slice);
    if (m && typeof m[0] === 'string') {
      return { kind: pat.kind, excerpt: m[0] };
    }
  }
  return null;
}

/** Default export as a tiny namespace so callers can write
 *  `PromptPatternDetector.match(...)` per the plan's §2.3.2 phrasing. */
export const PromptPatternDetector = { match };
