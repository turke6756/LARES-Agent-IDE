// GT-C Decision 2 (§2.1) — the canonical rail-claim contract.
//
// One source of truth for the PLAN-EVENT rail contract text appended to every
// plan-bound agent's prompt. Two audiences:
//   • planRailContractBlock   — WRITERS (edit a section): edit discipline +
//                               mandatory PLAN-EVENT sentinel.
//   • planClaimConventionBlock — NON-WRITERS (reviewer / deliberation turns):
//                               claim-only, no edit discipline.
//
// This TS module is the canonical generator. `scripts/lib/plan-rail-contract.js`
// is a BYTE-IDENTICAL CommonJS mirror (the MCP scripts cannot import compiled TS
// — tsconfig.main.json sets no allowJs and excludes scripts/). The drift guard is
// `plan-rail-contract.sync.test.ts`, which asserts full string equality between
// the compiled TS output and the JS mirror for representative inputs.
//
// KEEP THE TWO FILES IN LOCKSTEP: any edit here must be mirrored verbatim in the
// JS file, or the sync test fails CI.

/** The single-source status vocabulary for the PLAN-EVENT sentinel. Presence
 *  (review / no-op) turns file claims too — `reviewed` / `deliberating` / `blocked`
 *  — so the rail is on the record even when no bytes change. */
export const PLAN_EVENT_STATUSES = [
  'integrated',
  'reviewed',
  'deliberating',
  'blocked',
  'rejected',
  'scope-changed',
  'transition',
] as const;

const VOCAB = PLAN_EVENT_STATUSES.join(' | ');

/** Rail contract for WRITERS — an agent dispatched to edit one section of an
 *  existing plan surface. plan id + anchor are threaded in words; the block
 *  carries the read-before-edit discipline AND the mandatory PLAN-EVENT sentinel. */
export function planRailContractBlock(planId: string, sectionAnchor: string): string {
  return `── Plan-rail contract ──
You are bound to plan \`${planId}\`, writing the section anchored \`${sectionAnchor}\`.

Edit discipline:
- Read that section FIRST with \`read_plan_section mode:"raw+editWindow"\` — it returns the byte-exact fragment to replace plus edit-discipline instructions. A \`raw+editWindow\` read is a stronger edit-intent signal than a plain read.
- Then edit natively (\`Edit\` / \`MultiEdit\`) — replace ONLY that exact fragment, edit ONLY the \`${sectionAnchor}\` section, and NEVER change a \`data-anchor\` value. Native edits are the only write path.

End EVERY plan-rail turn with a \`PLAN-EVENT\` sentinel so your work is on the record:

\`\`\`
<!--PLAN-EVENT
{ "status": "integrated", "result": "…", "next": "…", "claimed_section_anchor": "${sectionAnchor}" }
-->
\`\`\`

- \`status\` — one of \`${VOCAB}\`.
- \`result\` / \`next\` — short free text (what landed; what's next).
- \`claimed_section_anchor\` is diagnostics-only: emit \`status\` + \`result\` even if unsure of the anchor — a wrong/omitted \`claimed_section_anchor\` only shows as a diagnostic, never changes attribution.`;
}

/** Rail contract for NON-WRITERS — reviewer / deliberation turns that do NOT edit
 *  a section. No edit discipline; still ends every turn with a PLAN-EVENT so the
 *  review is on the record (closing I-9 for presence turns). */
export function planClaimConventionBlock(planId: string, sectionAnchor: string): string {
  return `── Plan-rail contract (review turn) ──
You are participating in plan \`${planId}\`, section \`${sectionAnchor}\`. You are NOT writing a section this turn.

Still end EVERY turn with a \`PLAN-EVENT\` sentinel (\`reviewed\` / \`deliberating\` / \`blocked\`) so your review is on the record:

\`\`\`
<!--PLAN-EVENT
{ "status": "reviewed", "result": "…", "next": "…", "claimed_section_anchor": "${sectionAnchor}" }
-->
\`\`\`

- \`status\` — one of \`${VOCAB}\`.
- \`result\` / \`next\` — short free text (what you concluded; what's next).
- \`claimed_section_anchor\` is diagnostics-only: emit \`status\` + \`result\` even if unsure of the anchor — a wrong/omitted \`claimed_section_anchor\` only shows as a diagnostic, never changes attribution.`;
}
