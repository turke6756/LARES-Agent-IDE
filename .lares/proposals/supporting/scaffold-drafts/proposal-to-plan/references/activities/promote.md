# Activity playbook — `promote`

**Purpose.** The deliberate mechanical transition from a **marked flat proposal** to a **complete
plan folder** (§R0). Promote owns the **atomic, complete-folder scaffold**: it builds a
**fully-valid** folder — including `plan.md` — in a temp sibling and renames it into the
deterministic target in **one move**, so the watcher never observes a half-valid folder or a
post-rename interval with an incomplete `plan.md`.

**Lane. Responsible supervisor only** (promote mutates the plan-folder home). A non-supervisor lane
is **rejected and instructed** to hand off.

**Contracts loaded.** `references/contracts/folder-schema.md` (§R0 — layout, identity, `.gitkeep`),
`references/contracts/manifest-lock.md` (helper-only `plan.json` creation), `references/contracts/arc.md`
(§R2 — the ARC skeleton created here), and `references/contracts/intent-lifecycle.md` (§R1 — the
markup migrated into `plan.md`).

> **All `plan.json` creation goes through `scripts/plan-manifest.mjs scaffold`.** The agent never
> hand-writes `plan.json` (§P3-MANIFEST-LOCK, helper-only).

---

## Preconditions

- `scope` is complete: the flat proposal carries its PLAN-INTENT marks (if any) **and** the required
  `## Hardening scope` verdict section.
- Marking **predates** `plan.md`; the copy into `plan.md` happens **inside the temp folder during
  promotion**, so the renamed folder is valid the instant it appears (Accept 3).

## The atomic sequence (recommendation, verbatim shape)

```
scope/mark the flat proposal (.lares/proposals/…), incl. the ## Hardening scope verdict
  → create sibling temp folder
  → write plan.json, ARC.md, seeded subdirs, AND plan.md (copied from the already-marked proposal)
     into the temp folder
  → fsync as required
  → atomically rename the COMPLETE folder into the deterministic target
  → continue hardening (deliberate / integrate / package)
```

Run this via **`plan-manifest.mjs scaffold`**, which:

1. Computes the deterministic **`plan_artifact_id = "plan_" + <proposal artifact hex>`** and the
   **`plan-sku = <YYYY-MM-DD>-<slug>-<artifact-short>`** target path under
   `<workspaceStateDir()>/plans/`.
2. Builds the **complete** folder in a **request-ID-qualified temp sibling**
   (`<plan-sku>.tmp-<id>` beside the target) containing:
   - `plan.json` — with `responsibility_events[0]` = a `manual-skill` **`assigned`** event carrying a
     **stable `event_id`**, the deterministic identity, and `source_proposal`;
   - `ARC.md` — the §R2 skeleton with `ARC-META`, `## Decisions` seeded with the dated `## Hardening
     scope` verdict, `## Work packages`, `## Deliberations`, `## Who did what`;
   - `plan.md` — **copied from the already-marked proposal** (carries the PLAN-INTENT sentinels);
   - `deliberations/.gitkeep`, `research/.gitkeep`, `supplements/.gitkeep`.
3. `fsync`s, then **atomically renames the complete folder** onto the deterministic target.
4. Migrates the `## Hardening scope` verdict into `plan.md`/`ARC.md → Decisions`.

**No post-rename incomplete-plan interval exists** — `plan.md` is already inside the temp folder
before the rename (Accept 3).

## EEXIST on the target (both branches — Accept 4)

If the deterministic target already exists, **`scaffold` does not clobber it.** Run `orient` against
the occupant and read its `plan.json.source_proposal.artifact_id`:

- **Matching `source_proposal.artifact_id`** → this is our own folder (a resumed/retried promotion).
  **Orient/resume** — do not re-scaffold; continue hardening against the existing folder.
- **Mismatching `source_proposal.artifact_id`** → an **unrelated** occupant of the deterministic
  path. **Report a collision and BLOCK.** Never adopt, never overwrite, leave the occupant
  untouched.

The temp sibling is **request-ID-qualified** so a crash before rename leaves the canonical target
**absent**, and a retry safely resumes/replaces **only its own** validated temp directory; unrelated
directories are never removed.

## Rules & acceptance touchpoints

- Complete folder via **temp-dir → atomic rename** with `plan.md` already inside (Accept 3).
- Both **EEXIST branches** (matching resume / mismatching block) (Accept 4).
- `.gitkeep` in all three subdirs so a fresh clone/checkout preserves them (Accept 11).
- `plan.json` created **only** through the helper under the lock (Accept 9 discipline).

## Hand-off

With the folder live, hardening proceeds: `deliberate` (launch marked intents) → `integrate` (fold
returned outputs) → `package` (decompose + baseline tag). `orient` is the safe first read on any
later pickup.
