## Appendix — Calibration set (verify independently; do NOT treat as answers)

Claims from the 2026-08-06 two-plan run, recorded by a participant supervisor
(`ae889b24`) and therefore **not disinterested**. Use them to check your method
is sensitive enough to find real events. **If you cannot independently reproduce
one, that discrepancy is itself a finding — including the possibility that the
claim is wrong.**

- Two packages were mis-scoped by dispatching from a machine block when the prose
  Files list was authoritative; the document itself said the block was
  provisional. (Tests B5, A2.)
- A brief carried a stale inherited count — "~10 call sites in four named files"
  — where the real number was zero in all four. Re-derivation caught it.
  (Tests A3.)
- One brief contained mutually exclusive instructions about deleting a function;
  the worker chose one reading, leaving two identity derivations live in the tree
  for a period. (Tests A2, B1.)
- Four separate workers encountered the same failing foreign test and each
  correctly refused to fix it, until it was formally assigned. (Tests A4.)
- A final gate package reported three of its fifteen items as "fixture-proven
  only; deployment unproven until human restart" rather than claiming them.
  (Tests A5.)
- A proposal sat untracked on disk for days before being committed, and at the
  time of writing at least one proposal in `.lares/proposals/` has **no
  `artifact_id`**, so the promote gesture refuses it. Several existing
  `artifact_id` values do not match the stated `prop_` + 8-hex contract.
  (Tests B1, B7.)
- Memory index cap pressure caused two supervisors to edit one shared file
  concurrently. (Tests B4, B7.)

Treat every line above as a claim to be checked, not a conclusion to be repeated.
