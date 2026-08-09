---
name: read-planning-surface
description: >-
  Read and interpret the whole planning surface without changing it. Report
  flat proposals, plan folders, lifecycle state, observed responsibility, and
  safe next actions from disk-derived evidence only.
---

# Read the planning surface

This skill produces a **whole-surface state report** and a list of **safe next
actions**. It is the read-only half of planning orientation and is safe for every
lane.

## Absolute boundary

This skill **never writes**. It never launches agents, never appends `assigned`
events, never refreshes `ARC-META`, and never performs any other mutation. It may
recommend “run `orient` on plan X” without running it. Route every action that
requires judgment or mutation to the responsible supervisor or the human.

The responsibility verdict that authorizes a supervisor to mutate a plan is
outside this skill. For the normative derivation, cite the provisioned
`proposal-to-plan` contract at `references/contracts/responsibility.md` §`Determination`;
do not duplicate it here. This report may show the currently responsible agent
as observed state, but it never decides that a supervisor may act.

## Read the whole disk surface

1. Enumerate flat Markdown proposals directly under `.lares/proposals/`. Read
   valid `artifact_id`, title, authorship frontmatter, `promoted_to` /
   `promoted_at`, the dated `## Hardening scope` verdict, and PLAN-INTENT markup.
2. Treat `.lares/proposals/supporting/` as subordinate material serving a plan,
   never as another flat proposal gallery. Relate it to its plan when disk
   evidence supplies that relationship; otherwise report it as unresolved
   supporting material.
3. Enumerate plan folders under `<workspaceStateDir()>/plans/`. Read
   `plan.json`, `plan.md`, `ARC.md`, and present outputs. Use
   `proposal-to-plan/scripts/plan-manifest.mjs inspect` when available because
   it is read-only; do not invoke `refresh-arc` or a manifest mutation.
4. Join proposals to folders by the proposal `artifact_id` and
   `plan.json.source_proposal.artifact_id`, not by filenames and never with
   `derivePlanSku()`. Report the **promoted-but-bare-card gap** when a matching
   plan folder exists although the flat proposal lacks or does not yet display
   its promotion stamp.

A bare proposal with a valid `artifact_id` is **terminal-valid**. It is not an
unfinished plan and does not imply that hardening should begin.

## Lifecycle reporting

Derive and report each intent and each present output independently. Cite the
normative derivation rather than restating it:
`proposal-to-plan`'s `references/contracts/responsibility.md`
§`Determination` (with the rung definitions in its
`references/contracts/intent-lifecycle.md`). Never turn this report into the
responsibility verdict that gates a write.

`ran` is unavailable until the server-witnessed ledger ships. Always report
`ran: unavailable`; never infer it from a filename, output, timestamp, or a
self-declared `orchestration_id`.

| Disk evidence | Report | Safe next action |
|---|---|---|
| intent marked; `ran` unavailable; no present output | launch state unknown | ask the responsible supervisor to inspect known run context; do not launch or rerun |
| one or more valid active outputs not referenced | returned, unfolded, open; list each output | route exact outputs to the responsible supervisor for `integrate` |
| every present active output referenced | fully folded | report that hardening may continue; the responsible supervisor determines the write-side action |
| output malformed or identity-mismatched | invalid, not returned | report it for quarantine; do not integrate |
| intent superseded or withdrawn | historical, not open | no launch or integration action |
| explicit trivial-scope verdict and no intents | scope complete; hardening intentionally skipped | report the next write-side choice to the responsible supervisor |
| no intents and no explicit verdict | scope unknown or incomplete | recommend that the responsible supervisor run or complete `scope` |

Broken or unresolved links, path traversal, mixed path separators, and malformed
frontmatter are invalid evidence, not proof of a returned or folded output.

## Interpretation rules

- Witnessed activity says **whether to look closer**, never the quality of the
  work or the effort invested.
- Frontmatter authorship is a **self-claim**. Keep it distinct from witnessed
  truth; do not merge the two registers or treat agreement as proof.
- `supporting/` is subordinate to its plan, not an independent proposal.
- Disk ambiguity stays ambiguity. Report missing, conflicting, and malformed
  evidence explicitly rather than filling gaps by inference.

## Deferred surfaces

This skill documents **disk-derived state only**. Gallery grouping or collapse
behavior, database projections of work packages or responsibility, and
readiness gates are explicitly out of scope and are not described here. Their
documentation is deferred to plan_e0001372 after its WP-Z gates because those
surfaces are still changing.

## Output

Return one concise state report covering proposals, plan folders, joins/gaps,
per-intent lifecycle state, observed responsibility, and ambiguities. End with
safe next actions addressed explicitly to the responsible supervisor or the
human. Do not take those actions.
