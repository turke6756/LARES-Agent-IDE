import { stripAnsi } from './strip-ansi';

export interface GrokFreeLimitMatch {
  reason: 'free-usage-limit';
  detail: 'You hit your free usage limit.';
}

const EXHAUSTION_SENTENCE = /\byou\s+hit\s+your\s+free\s+usage\s+limit\.\s*/i;
const SUPERGROK_OPTION = /\bupgrade\s+to\s+supergrok\b(?!\s+heavy)/i;
const SUPERGROK_HEAVY_OPTION = /\bupgrade\s+to\s+supergrok\s+heavy\b/i;

/**
 * Strict, pure classifier for Grok's captured free-tier exhaustion picker.
 * Callers must supply the current rendered screen, never append-only scrollback.
 */
export function classifyGrokFreeLimit(screen: string | null | undefined): GrokFreeLimitMatch | null {
  if (!screen) return null;
  const visible = stripAnsi(screen).replace(/\s+/g, ' ').trim();
  if (
    !EXHAUSTION_SENTENCE.test(visible)
    || !SUPERGROK_OPTION.test(visible)
    || !SUPERGROK_HEAVY_OPTION.test(visible)
  ) {
    return null;
  }
  return {
    reason: 'free-usage-limit',
    detail: 'You hit your free usage limit.',
  };
}
