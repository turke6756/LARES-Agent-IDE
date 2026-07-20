// Idle-agent lifecycle §B8 — human copy for `StopExclusionCode`.
//
// The guard layer (`src/main/lifecycle/guards.ts`) speaks in codes; every
// surface that shows a user why an agent was (or would be) left alone renders
// through here, so the stale-idle preview, the bulk-stop confirm and the card
// toast cannot describe the same code three different ways.
//
// The table is a `Record<StopExclusionCode, …>` on purpose: adding a code to
// the union without writing copy for it is a COMPILE error, not a runtime
// "unknown reason" string leaking into the UI.
//
// Pure module — no React, no `window`, no imports beyond the shared type.

import type { StopExclusionCode } from '@shared/types';

export interface StopExclusionCopy {
  /** Two-or-three words, for a chip/badge next to an agent name. */
  label: string;
  /** One sentence, user-facing: what the guard saw and why it blocks a stop. */
  explanation: string;
}

/**
 * Exhaustive code → copy. Ordered as in the union declaration so a diff
 * against `StopExclusionCode` reads straight down.
 */
export const STOP_EXCLUSION_COPY: Record<StopExclusionCode, StopExclusionCopy> = {
  not_idle: {
    label: 'Not idle',
    explanation: 'The agent is still working, launching or waiting — only idle agents are swept.',
  },
  threshold_not_met: {
    label: 'Idle too recently',
    explanation: 'The agent has not been idle long enough to meet the auto-stop threshold.',
  },
  active_child: {
    label: 'Has live children',
    explanation: 'This agent still owns running child agents; stopping it would leave them orphaned.',
  },
  active_orchestration: {
    label: 'Running a deliberation',
    explanation: 'A team deliberation this agent is driving is still starting or running.',
  },
  pending_delivery: {
    label: 'Message undelivered',
    explanation: 'A message is queued for this agent and has not been delivered yet.',
  },
  human_attention: {
    label: 'Needs you',
    explanation: 'The agent is parked on a question, mid-continuation, or has a browser tab waiting on you.',
  },
  browser_lease: {
    label: 'Browser in use',
    explanation: 'The agent holds a browser lease — a page is loading, downloading, or otherwise in flight.',
  },
  detached_process: {
    label: 'Detached process',
    explanation: 'A live process was verified for this agent, but this app instance does not hold its runner.',
  },
  ownership_unverified: {
    label: 'Ownership unverified',
    explanation: 'We could not confirm this app owns the agent’s process, so stopping it might kill something else.',
  },
  lifecycle_busy: {
    label: 'Busy',
    explanation: 'Another stop, restart or continuation for this agent is already in progress.',
  },
  guard_unavailable: {
    label: 'Checks unavailable',
    explanation: 'One or more safety checks could not be read, so the agent is left alone rather than guessed at.',
  },
  not_found: {
    label: 'Not found',
    explanation: 'No agent with this id exists any more — there is nothing to stop.',
  },
};

/** Short chip text for a code. */
export function stopExclusionLabel(code: StopExclusionCode): string {
  return STOP_EXCLUSION_COPY[code].label;
}

/** One-sentence explanation for a code. */
export function stopExclusionExplanation(code: StopExclusionCode): string {
  return STOP_EXCLUSION_COPY[code].explanation;
}

/**
 * All codes, in declaration order. Useful for grouping a preview's exclusions
 * into a stable, non-alphabetical order that matches the guard module.
 */
export const STOP_EXCLUSION_CODES = Object.keys(STOP_EXCLUSION_COPY) as StopExclusionCode[];

/**
 * Human summary for one agent's code list. Codes are joined by label; an empty
 * list is `null` (never an empty string that renders as a stray separator).
 */
export function summarizeStopExclusions(codes: readonly StopExclusionCode[]): string | null {
  if (codes.length === 0) return null;
  const seen = new Set<StopExclusionCode>();
  const labels: string[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    labels.push(STOP_EXCLUSION_COPY[code].label);
  }
  return labels.join(' · ');
}

/**
 * Group a preview's `excluded` list by code → agent ids, in declaration order.
 * An agent with several codes appears under each of them: the panel's job is to
 * say "these 4 were skipped because a deliberation is running", and hiding the
 * second reason would misreport why the agent survived.
 */
export function groupExclusionsByCode(
  excluded: ReadonlyArray<{ agentId: string; codes: StopExclusionCode[] }>,
): Array<{ code: StopExclusionCode; copy: StopExclusionCopy; agentIds: string[] }> {
  const byCode = new Map<StopExclusionCode, string[]>();
  for (const entry of excluded) {
    for (const code of new Set(entry.codes)) {
      const ids = byCode.get(code);
      if (ids) ids.push(entry.agentId);
      else byCode.set(code, [entry.agentId]);
    }
  }
  return STOP_EXCLUSION_CODES.filter((code) => byCode.has(code)).map((code) => ({
    code,
    copy: STOP_EXCLUSION_COPY[code],
    agentIds: byCode.get(code)!,
  }));
}
