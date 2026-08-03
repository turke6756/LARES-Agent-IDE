// WP8 (hook-absence-resilience) — the ONE formatter every send surface routes
// through, so no surface can omit the mandatory terminal-check guidance. This is
// the plan's HARD REQUIREMENT: every `failed` / `delivered-unconfirmed` outcome
// surfaced to the user MUST tell them to double-click the agent card and check
// the terminal for a pending interactive prompt, and MUST name the prompt when
// one was detected.
//
// Leaf module (shared): imports only the SendOutcome type so both main and
// renderer can consume it freely.

import type { SendOutcome } from './types';

/** The verbatim double-click sentence the plan requires on every non-confirmed
 *  outcome. Exported so tests can assert its exact presence across surfaces. */
export const TERMINAL_CHECK_SENTENCE =
  'Double-click the agent card and check the terminal for a pending interactive ' +
  'prompt — a trust dialog, sign-in, or question.';

export interface SendOutcomeCopy {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

/**
 * Render user-facing copy for a send outcome.
 *   - `confirmed`            → brief/empty banner (tone 'ok').
 *   - `delivered-unconfirmed`→ amber warning + the mandatory terminal-check
 *                              sentence; names the prompt when one was detected.
 *   - `failed`               → red error + the SAME mandatory terminal-check
 *                              sentence.
 */
export function sendOutcomeMessage(o: SendOutcome): SendOutcomeCopy {
  if (o.disposition === 'confirmed') {
    return { tone: 'ok', text: '' };
  }

  // When the PTY classifier named a blocking prompt, lead with it so the user
  // knows exactly what the terminal is waiting on, then still give the
  // double-click instruction. Both branches carry the mandatory sentence.
  if (o.prompt) {
    const excerpt = o.prompt.excerpt ? `: “${o.prompt.excerpt}”` : '';
    if (o.prompt.kind === 'sign-in') {
      const named =
        `The agent is at its sign-in screen${excerpt}. ` +
        'Open the terminal to finish signing in, then resend the message.';
      return {
        tone: o.disposition === 'failed' ? 'error' : 'warn',
        text: `${named} ${TERMINAL_CHECK_SENTENCE}`,
      };
    }
    const named =
      `The terminal appears to be waiting on a ${o.prompt.label}${excerpt}. ` +
      'Double-click the agent card and accept it there.';
    // The named copy already instructs the double-click; append the canonical
    // sentence too so the verbatim guidance is present on every surface.
    return {
      tone: o.disposition === 'failed' ? 'error' : 'warn',
      text: `${named} ${TERMINAL_CHECK_SENTENCE}`,
    };
  }

  const lead =
    o.disposition === 'failed'
      ? 'The message could not be delivered — no runner accepted it.'
      : 'The message was delivered, but Lares saw no sign the agent started its turn.';
  return {
    tone: o.disposition === 'failed' ? 'error' : 'warn',
    text: `${lead} ${TERMINAL_CHECK_SENTENCE}`,
  };
}
