# Planning-surface Wave-1 test script — for a FRESH supervisor session

Purpose: exercise the deployed `proposal-to-plan` skill end to end from a cold
session (one that launched AFTER scaffold v21 deployed, so the skill was
discovered at startup, not mid-session). Follow the steps in order; report
results in your final message using the checklist at the bottom.

Ground rules:
- Do NOT edit project source code, run builds, or touch `src/`.
- Work only under `.lares/proposals/` and the state-dir plans home
  (`.lares/plans/`).
- Use a THROWAWAY test proposal (step 1), never a real one.
- Every artifact must be created THROUGH the skill — if you find yourself
  hand-writing `plan.json` or `ARC.md`, stop and report failure instead.

## Step 0 — discovery check
Confirm the `proposal-to-plan` skill appears in your available-skills list
without any manual load. If absent, STOP and report: scaffold discovery is
broken for fresh sessions.

## Step 1 — capture
Invoke the skill in `capture` mode with this test idea:
"TEST-ONLY: add a keyboard shortcut cheat-sheet overlay to the dashboard."
Verify:
- A flat markdown file landed in `.lares/proposals/` (dated filename).
- It has `artifact_id` frontmatter.
- No folder was created — a bare proposal is a valid terminal artifact.

## Step 2 — scope
Run `scope` on the test proposal (hardening triage + markup).
Verify the proposal gained the scope/triage markup the skill specifies, and
that nothing outside the proposal file was written.

## Step 3 — promote
Run `promote` on the scoped proposal.
Verify a plan folder appeared under the state-dir plans home
(`.lares/plans/<slug>/`) containing:
- `plan.json` (written by the skill's `plan-manifest.mjs` helper — check it is
  valid JSON with the promote event recorded)
- `plan.md`
- `ARC.md` skeleton (ARC is the SUPERVISOR's file — the skill seeds it at
  promote)
- `deliberations/`, `research/`, `supplements/` subfolders

## Step 4 — orient
Run `orient` on the plan folder. Verify:
- It derives intent rungs from disk (`marked → ran → returned → folded-in`).
- It reports `ran` as UNAVAILABLE (the ledger has not shipped) — if it fakes a
  `ran` rung, that is a failure; report it.
- It refreshes `ARC.md` (check `ARC-META` updated).

## Step 5 — ownership check
Confirm `plan.json`'s last `assigned` event names YOU as the owning
supervisor (promote should have recorded it). Note what it says either way.

## Report checklist (final message)
- [ ] Step 0 skill discovered cold
- [ ] Step 1 capture → flat proposal + artifact_id
- [ ] Step 2 scope markup applied
- [ ] Step 3 promote → complete folder scaffold via manifest helper
- [ ] Step 4 orient → honest rungs (`ran` reported unavailable), ARC refreshed
- [ ] Step 5 ownership recorded
Plus: exact paths of everything created, and any step where the skill's own
instructions were ambiguous or wrong (verbatim quotes help).

Cleanup: do NOT delete anything — leave the artifacts for the dispatching
supervisor to inspect and remove.
