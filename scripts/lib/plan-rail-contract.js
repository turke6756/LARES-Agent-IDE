// GT-C Decision 2 (§2.2) — CommonJS mirror of src/main/plans/plan-rail-contract.ts.
//
// BYTE-IDENTICAL output to the TS canonical. The MCP scripts (scripts/*.js)
// cannot import the compiled TS module — tsconfig.main.json sets no allowJs and
// excludes scripts/ — so this hand-kept mirror is what the launch_agent rail
// shim requires. The drift guard is src/main/plans/plan-rail-contract.sync.test.ts,
// which asserts full string equality between the compiled TS output and this file.
//
// WP-P0B (ceremony subtraction): the mandatory every-turn `PLAN-EVENT` sentinel
// and the read-before-edit discipline have been REMOVED from these blocks. See
// the TS canonical for the full rationale.
//
// KEEP THE TWO FILES IN LOCKSTEP: any edit to the TS canonical must be mirrored
// here verbatim, or the sync test fails CI.

/** The status vocabulary for the OPTIONAL `PLAN-EVENT` sentinel an agent may
 *  still volunteer (no longer mandated by any prompt). Retained for the fail-open
 *  `scrapePlanEventSentinel` parser + diagnostics. */
const PLAN_EVENT_STATUSES = [
  'integrated',
  'reviewed',
  'deliberating',
  'blocked',
  'rejected',
  'scope-changed',
  'transition',
];

/** Rail orientation for WRITERS — an agent dispatched to edit one section of an
 *  existing plan surface. Names the plan + the section it owns; carries NO
 *  per-turn sentinel obligation and NO read-before-edit discipline (WP-P0B). */
function planRailContractBlock(planId, sectionAnchor) {
  return `── Plan-rail contract ──
You are bound to plan \`${planId}\`, writing the section anchored \`${sectionAnchor}\`. Edit that one section of the existing plan surface in place with native \`Edit\`; the run completes when its content changes.`;
}

/** Rail orientation for NON-WRITERS — reviewer / deliberation turns that do NOT
 *  edit a section. Names the plan + section and states this is not a write turn;
 *  carries NO per-turn sentinel obligation (WP-P0B). */
function planClaimConventionBlock(planId, sectionAnchor) {
  return `── Plan-rail contract (review turn) ──
You are participating in plan \`${planId}\`, section \`${sectionAnchor}\`. You are NOT writing a section this turn.`;
}

module.exports = { PLAN_EVENT_STATUSES, planRailContractBlock, planClaimConventionBlock };
