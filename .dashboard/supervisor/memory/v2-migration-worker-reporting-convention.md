# V2 Migration — worker self-reporting convention

**Established 2026-06-08 (human directive).** Standing rule for the V2
supervisor-centric dashboard migration (the big lift mapped in
`v2-supervisor-dashboard-initiative.md` and sequenced in
`plans/v2-migration-phase-order-audit.md`).

## The rule

**Every worker launched in service of the V2 migration must report back what it
changed in the migration docs — a short brief that lands in the hub's execution
log.** The migration's paper trail has to be self-maintaining; I do not backfill
it from memory after the fact (that was the gap that prompted this — the §5
pre-phase edits lived only in supervisor memory, never in the docs themselves).

## How I enforce it when launching a V2 worker

Bake the reporting requirement into the launch prompt, at the start AND restated
at the end. The worker must, as its final action, emit a **short brief** of:

- which doc(s) / ticket(s) / phase it touched,
- what was done (1–3 lines, not a full diff),
- commit/uncommitted state,
- and append that brief as a dated entry to the **execution log** in
  `docs/SUPERVISOR_DASHBOARD_UI_MIGRATION.md` Part 0 (§0.6 "Execution status &
  log"), using the same status legend (☐ not started · ◐ in progress · ✅ done ·
  ⛔ blocked).

If a worker can't write the log itself (e.g. it's gated off `.claude/` or the
file is locked), it returns the brief in its final assistant message and **I**
append it to §0.6 on the idle/done event.

## On the done event

Read the worker's `## Patch summary` / final brief, confirm it updated §0.6
(or append it myself if it didn't), and update the §0.6 phase rollup row +
per-ticket markers in the owning flanking doc. The hub log is the single
glance-able record of everything executed against the migration.

## Where this also lives

The convention is documented in the hub doc itself (Part 0, alongside the §0.6
execution log) so any future supervisor/contributor — not just me — follows it.
