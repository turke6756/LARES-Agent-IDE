# Activity playbook — `orient`

**Purpose.** The **re-entry interpreter**. On any pickup of an existing plan folder, `orient` derives
the **known** lifecycle state from disk evidence and presents **safe** next actions — **before doing
anything new** (ruling 23/30, orient-first). Re-entry is a **read**, not a process to resume.

**Lane. Anyone may run `orient`** — it is **read-only**. It never mutates the plan, never launches,
never auto-relaunches. Judgment-bearing actions it surfaces are **gated on the responsible
supervisor**.

**Contracts loaded.** `references/contracts/folder-schema.md` (§R0), `references/contracts/intent-lifecycle.md`
(§R1 rungs), `references/contracts/arc.md` (§R2 — refresh on re-run), and
`references/contracts/manifest-lock.md` (read-only `inspect` only — orient never mutates `plan.json`).

---

## Steps

1. **Inspect the folder.** Run `scripts/plan-manifest.mjs inspect` (read-only `plan.json` + folder
   listing) and read `ARC.md` + the PLAN-INTENT / PLAN-INTEGRATION sentinels.
2. **Derive every intent's rung from disk** per §R1: marked → (`ran` **unavailable**) → returned →
   folded-in. Report each intent independently (multiple outputs each listed).
3. **Report launch-state honestly.** `ran` is server-witnessed and **unavailable from disk pre-P2L**;
   `orient` **never auto-relaunches**. A detached deliberation may be running with no artifact yet.
4. **Refresh `ARC.md`/`ARC-META`** from current disk evidence (excluding `ARC.md`'s own mtime from the
   cutoff) **without clobbering** existing content (Accept 12).
5. **Surface the safe next action** from the table below; **gate any judgment-bearing action on the
   responsible supervisor.**

## Decision table (from the recommendation doc, verbatim)

| Disk evidence | `orient` reports | Safe next action |
|---|---|---|
| intent marked; `ran` unavailable; no present output | launch state **unknown** | inspect known run context; **ask the supervisor** whether to launch or rerun — do **not** auto-launch |
| ≥1 valid `active` output, not referenced | returned, **unfolded → open** | `integrate` that exact output |
| every present `active` output referenced | fully folded | continue hardening / `package` if otherwise ready |
| output present but malformed / identity-mismatched | **invalid, not returned** | quarantine + report; do **not** integrate |
| intent superseded / withdrawn | historical, **not open** | no launch, no integration |
| explicit trivial-scope verdict present, no intents | scope complete; **hardening intentionally skipped** | proceed to hardening / `package` |
| no intents **and** no explicit verdict | scope status **unknown/incomplete** | do **not** infer readiness; run/complete `scope` |

## Rules & acceptance touchpoints

- **`ran` reported unknown/unavailable without relaunching** (Accept 5).
- **No-intents-no-verdict is reported as scope-incomplete**, never as ready (Accept 5). The explicit
  `## Hardening scope` trivial verdict is what distinguishes "nothing needs hardening" from "scope
  never happened" (Accept 2).
- **Malformed frontmatter, `..`-traversal, broken/unresolved links, mixed `\`/`/` separators** are
  reported **invalid, not returned/folded** (Accept 10) — quarantine, never integrate.
- **Multiple outputs** for one intent are surfaced **independently** (Accept 6) — one folded rerun
  never hides another pending result.
- **Re-run refreshes `ARC.md`/`ARC-META` without clobbering** (Accept 12).
- **Read-only**: orient is the one mode a non-supervisor lane may run; `mark`/`integrate`/`package`
  it may not. Mutation by a new supervisor requires a fresh `assigned` reassignment event **first**
  (Accept 7, 8).

## The EEXIST resume path

`promote` delegates its EEXIST decision to `orient`: read the occupant's
`source_proposal.artifact_id` — **matching** → orient/resume against it; **mismatching** → report a
**collision** and **block** (occupant untouched). See `promote.md`.
