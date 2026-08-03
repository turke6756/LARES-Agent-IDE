# Activity playbook — `package`

**Purpose.** The **LAST** step of the journey: decompose the **hardened** plan into
**worker-sized, bundle-contract-shaped work packages** — after a defensible implementation plan
exists — **and** perform **pre-implementation git prep** (the `plan-baseline/<plan-slug>` tag).
Packaging is decomposition; it is **not** scope (ruling 27).

**Lane. Responsible supervisor only** (package mutates the plan + records the baseline). A
non-supervisor lane is **rejected and instructed** to hand off.

**Contracts loaded.** `references/contracts/arc.md` (§R2 — recording the baseline + packages under
Decisions/Work packages) and `references/contracts/folder-schema.md` (§R0 — the plan folder the WPs
are recorded in).

---

## Part A — decompose into work packages

- Cut the hardened plan into **worker-sized packages**, each fitting one worker's context, in the
  **bundle-contract shape** (`.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md`):
  every WP lists **Files · Dep · Do · Accept · Non-goals · Verify**.
- Record the packages under `ARC.md → ## Work packages` (`<id> <title> — <state> — <responsible/assignee>`).
- **Preconditions:** a defensible implementation plan exists — every marked intent is folded or
  legitimately trivial (`## Hardening scope` verdict present). Do not package an unhardened plan.

## Part B — pre-implementation git prep (the baseline tag)

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

With packages recorded and the baseline tag in place, the plan is **dispatch-ready**. Implementation
is a separate explicit human **trigger** (never auto-launched by the skill). `orient` reports
readiness on pickup.
