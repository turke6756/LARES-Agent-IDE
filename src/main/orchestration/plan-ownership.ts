// GT-C Ownership model (§O.2) — the SHARED "one writer per plan" guard, applied
// identically at every external plan-bound dispatch path so the API and IPC/CLI
// launch routes cannot drift.
//
// A plan is RESERVED by ANY of:
//   (a) an active orchestration run on the plan (`starting`|`running`), or
//   (b) an actively-working plan-bound agent, or
//   (c) an in-flight trail materialization.
//
// AMENDED semantics (maintainer sign-off, planning-surface-issues.md §4.4,
// authoritative over gt-c §O.1/O.4/O.5): an IDLE plan-bound agent does NOT reserve
// the plan — `getLiveRailAgentForPlan` filters to `status IN ('working','launching')`.
// The Lares pattern of keeping a seed worker idle across GroupThink phases stays
// legal, so an idle plan-bound agent is dispatch-safe.

import { getPlan, listOrchestrationRuns, getLiveRailAgentForPlan } from '../database';
import { trailMaterializer } from '../plans/execution-trail-writer';

/** A 409-shaped Error (statusCode carried so the API layer maps it to HTTP 409). */
function httpErr409(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/**
 * Throws a 409-shaped Error if the plan is reserved; returns void if free.
 * `exemptRunId` / `exemptAgentIds` let a resume or a completing run bypass its own
 * reservation (e.g. the T1 write happens while the completing run row is still
 * `running`, exempting itself + its own idle members).
 */
export function assertPlanRailFree(
  planId: string,
  opts?: { exemptRunId?: string; exemptAgentIds?: string[] },
): void {
  // WP-P0B trusted format-gate: the one-writer guard applies ONLY to legacy
  // `format === 'html'` plans (the projection/pane surface written back by a
  // native section edit). Structured / md plans — and an unknown or missing plan
  // id — bypass the guard entirely, because it protects the HTML writeback race,
  // not arbitrary external filesystem edits. The format is read from the TRUSTED
  // `plans` row via `getPlan`, NEVER from a caller-supplied value, so a caller
  // can neither spoof a bypass nor manufacture a lock. A null plan (unknown id)
  // is a safe no-crash bypass.
  const plan = getPlan(planId);
  if (!plan || plan.format !== 'html') return;

  const active = listOrchestrationRuns().find(
    (r) =>
      r.planId === planId &&
      r.runId !== opts?.exemptRunId &&
      (r.status === 'starting' || r.status === 'running'),
  );
  if (active) {
    throw httpErr409(
      `Plan ${planId} already has an active writer (run ${active.runId}) — one writer per plan.`,
    );
  }
  const liveAgent = getLiveRailAgentForPlan(planId, opts?.exemptAgentIds ?? []);
  if (liveAgent) {
    throw httpErr409(
      `Plan ${planId} has a live plan-bound agent (${liveAgent.id}, status=${liveAgent.status}) — one writer per plan.`,
    );
  }
  if (trailMaterializer.isMaterializing(planId)) {
    throw httpErr409(`Plan ${planId} is finalizing its execution trail — retry shortly.`);
  }
}
