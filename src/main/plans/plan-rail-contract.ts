// GT-C Decision 2 (§2.1) — the canonical rail orientation block.
//
// One source of truth for the plan-rail block appended to every plan-bound
// agent's prompt. Two audiences:
//   • planRailContractBlock   — WRITERS (edit a section): names the plan + the
//                               section they own.
//   • planClaimConventionBlock — NON-WRITERS (reviewer / deliberation turns):
//                               names the plan + section, states it is not a
//                               write turn.
//
// WP-P0B (ceremony subtraction): the mandatory every-turn `PLAN-EVENT` sentinel
// and the read-before-edit discipline have been REMOVED from these blocks — no
// prompt obligates a per-turn sentinel or a read-before-edit ritual. The
// fail-open `scrapePlanEventSentinel` parser and the `plan_events`/touch columns
// remain (a sentinel an agent volunteers is still recorded), and the
// `raw+editWindow` read mode still returns its byte-exact edit window; agents are
// simply no longer commanded to emit either. `PLAN_EVENT_STATUSES` is retained
// as the status vocabulary for that fail-open parser + diagnostics.
//
// This TS module is the canonical generator. `scripts/lib/plan-rail-contract.js`
// is a BYTE-IDENTICAL CommonJS mirror (the MCP scripts cannot import compiled TS
// — tsconfig.main.json sets no allowJs and excludes scripts/). The drift guard is
// `plan-rail-contract.sync.test.ts`, which asserts full string equality between
// the compiled TS output and the JS mirror for representative inputs.
//
// KEEP THE TWO FILES IN LOCKSTEP: any edit here must be mirrored verbatim in the
// JS file, or the sync test fails CI.

/** The status vocabulary for the OPTIONAL `PLAN-EVENT` sentinel an agent may
 *  still volunteer (no longer mandated by any prompt). Retained for the fail-open
 *  `scrapePlanEventSentinel` parser + diagnostics. */
export const PLAN_EVENT_STATUSES = [
  'integrated',
  'reviewed',
  'deliberating',
  'blocked',
  'rejected',
  'scope-changed',
  'transition',
] as const;

/** Rail orientation for WRITERS — an agent dispatched to edit one section of an
 *  existing plan surface. Names the plan + the section it owns; carries NO
 *  per-turn sentinel obligation and NO read-before-edit discipline (WP-P0B). */
export function planRailContractBlock(planId: string, sectionAnchor: string): string {
  return `── Plan-rail contract ──
You are bound to plan \`${planId}\`, writing the section anchored \`${sectionAnchor}\`. Edit that one section of the existing plan surface in place with native \`Edit\`; the run completes when its content changes.`;
}

/** Rail orientation for NON-WRITERS — reviewer / deliberation turns that do NOT
 *  edit a section. Names the plan + section and states this is not a write turn;
 *  carries NO per-turn sentinel obligation (WP-P0B). */
export function planClaimConventionBlock(planId: string, sectionAnchor: string): string {
  return `── Plan-rail contract (review turn) ──
You are participating in plan \`${planId}\`, section \`${sectionAnchor}\`. You are NOT writing a section this turn.`;
}
