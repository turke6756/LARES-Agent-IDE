# Activity playbook — `package`

**Purpose.** The **LAST** step of the journey: decompose the **hardened** plan into
**worker-sized, bundle-contract-shaped work packages** — after a defensible implementation plan
exists — **and** perform **pre-implementation git prep** (the `plan-baseline/<plan-slug>` tag).
Packaging is decomposition; it is **not** scope (ruling 27).

**Lane. Responsible supervisor only** (package mutates the plan + records the baseline). A
non-supervisor lane is **rejected and instructed** to hand off.

**Contracts loaded.** `references/contracts/arc.md` (§R2 — recording the baseline + packages under
Decisions/Work packages), `references/contracts/folder-schema.md` (§R0 — the plan folder),
`references/contracts/work-packages.md` (the strict `PLAN-WORK-PACKAGES:v2` projection), and
`references/contracts/human-overview.md` (the `OVERVIEW.md` human register).

---

## Part A — decompose into work packages

- Cut the hardened plan into **worker-sized packages**, each fitting one worker's context, in the
  **bundle-contract shape** (`.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md`):
  every WP lists **Files · Dep · Do · Accept · Non-goals · Verify · Entry · Outcome**.
- Write exactly one `kind: work-packages` supplement. In the same operation, write its prose
  bundle contracts and its additive `PLAN-WORK-PACKAGES:v2` block. Self-check that projected IDs
  and titles have one-to-one parity with the prose headings, then validate the complete file against
  `references/contracts/work-packages.md`.
- Add an `Entry` section to every prose package. For `behavior`, mirror every v2
  `entry_seam_links` and `production_constructs` obligation: name the production symbol/path,
  its entering test, and its mutation reference. For a package that adds or changes no independently
  reachable behavior, write `Entry: none — <reviewed one-line rationale>`; a refactor that changes
  an existing seam is behavior, not `none`.
- Re-read each package's `Do`, `Accept`, and `Non-goals`. Its Outcome must promise no behavior
  outside them, and at least one acceptance condition must observably prove it. Do not declare
  dispatch readiness if the semantic Outcome check fails.
- Record the packages under `ARC.md → ## Work packages` (`<id> <title> — <state> — <responsible/assignee>`).
- **Preconditions:** a defensible implementation plan exists — every marked intent is folded or
  legitimately trivial (`## Hardening scope` verdict present). Do not package an unhardened plan.

## Part B — write the human overview

Before git prep, derive the populated tab inventory from bounded, contained disk evidence per
`references/contracts/human-overview.md` — never from SQLite. Overview and Plan are always
present; Proposal is included only for a contained regular non-symlink manifest source;
Deliberations, Research, and Supplements are included only when their directory has a real output
other than `.gitkeep`; Packages is always included; Legacy HTML is never inferred.

Write or update `OVERVIEW.md`, preserving valid unrelated sections and unmapped prose, and include
a non-empty section for every discovered tab. The register is *written for the workspace owner — no
sentinel names, no rung jargon, no file:line.* Validate `OVERVIEW.md` against
`references/contracts/human-overview.md`, then validate the work-package supplement again. Do not
declare dispatch readiness if either validation fails.

## Part C — pre-implementation git prep (the baseline tag)

Before declaring the plan **dispatch-ready**, create-or-verify a **local annotated** baseline tag so
implementation has a human-visible recovery point:

1. **Verify or create** a local **annotated** tag `plan-baseline/<plan-slug>` at the **workspace
   HEAD**:
   - Verify existence: `git tag -l plan-baseline/<plan-slug>` — if present, reuse it (verify it
     points at a sensible commit; record what it points at).
   - Create if absent: `git tag -a plan-baseline/<plan-slug> -m "<plan-sku> baseline" HEAD`.
2. **Record the tag name + commit** under `ARC.md → ## Decisions` **and** in `plan.md` (so the
   recovery point is durable on disk).
3. **Warn (advisory, NEVER blocking)** when `git status` shows uncommitted edits the tag cannot
   capture — the tag only captures committed HEAD. Surface the warning; do not block packaging.
4. **Never push the tag** — it is **local only**.

**Recovery framing (record this in `plan.md`/ARC Decisions):** any code a plan later **deletes** is
one `git show <tag>:<path>` away — deletion WPs need **no** copy-aside archiving.

> Once WP-P5C's per-run `baseline_ref` exists this tag becomes belt-and-braces; the skill step stays
> as the **human-visible** recovery point.

## Rules & acceptance touchpoints

- `package` **creates-or-verifies** the `plan-baseline/<plan-slug>` tag, **records it** in
  `plan.md`/`ARC.md`, **warns on uncommitted edits without blocking**, and **never pushes** the tag
  (Accept 13).
- Packaging is the **last** step, after hardening; it is **not** scope decomposition.
- Do not run `git checkout`/`restore`/`clean`/`stash` in the shared worktree — creating a **tag** is
  non-destructive; discarding work is forbidden.

## Hand-off

With packages and `OVERVIEW.md` validated and the baseline tag in place, present the human overview
and stop. The plan is **dispatch-ready**, but implementation is a separate explicit human **trigger**
(never auto-launched by the skill). `orient` reports readiness on pickup.
