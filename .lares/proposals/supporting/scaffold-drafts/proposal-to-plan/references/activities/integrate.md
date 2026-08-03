# Activity playbook — `integrate`

**Purpose.** Validate a **returned** deliberation/research output and **fold it into the plan** — by
a **normalized Markdown-link reference** in the relevant `plan.md` phase **plus** a per-output
**PLAN-INTEGRATION** record — then **refresh `ARC.md`/`ARC-META`**. Integration is a **tracked,
separate, later** step; it is **never presumed** from "the workflow completed."

**Lane. Responsible supervisor only** (integrate mutates `plan.md`/`ARC.md`). A non-supervisor lane
is **rejected and instructed** to hand off.

**Contracts loaded.** `references/contracts/intent-lifecycle.md` (§R1 — identity/containment,
returned/folded rungs, PLAN-INTEGRATION record) and `references/contracts/arc.md` (§R2 — the ARC
refresh + freshness contract).

---

## Steps

1. **Validate identity + containment** of the candidate output:
   - Frontmatter `intent_id` **and** `plan_artifact_id` match this plan/intent (§R1).
   - The output path **resolves inside the plan folder** (containment): reject `..`-traversal,
     symlink/junction escape, and **normalize mixed `\`/`/` separators** before resolving.
   - The output is **currently present** on disk.
2. **Treat `ran` as unavailable** (pre-ledger). Do **not** promote a self-declared `orchestration_id`
   to authority — it is a cross-check only.
3. **Fold by reference:** add a **normalized Markdown link** to the exact output from the relevant
   `plan.md` phase. A raw textual substring is **insufficient** — the link must **resolve
   (containment + existence)** to that exact present output.
4. **Write the per-output PLAN-INTEGRATION record** (§R1, adjacent to the reference):

   ```html
   <!--PLAN-INTEGRATION
   { "intent_id": "int_8hex", "output_rel_path": "deliberations/2026-08-01-attr.md",
     "changed": "what the deliberation changed", "disposition": "active" }
   -->
   ```

5. **Refresh `ARC.md`** — update `## Deliberations` (part, rung, output ref, integration summary
   citing `intent_id`/`orchestration_id`) and **`ARC-META`** (`last_refreshed_at`, `source_cutoffs`
   over `plan.md`/outputs/`plan.json`, **excluding `ARC.md` itself**).

## Rules & acceptance touchpoints

- **Malformed frontmatter, `..`-traversal, broken/unresolved Markdown links, and mixed
  `\`/`/` separators DO NOT count as returned/folded** (Accept 10). An output failing validation is
  **quarantined + reported**, never integrated.
- **Multiple outputs for one intent remain independently open/folded** (Accept 6). Fold each present
  `active` output on its own; an intent is `fully_folded_in` only when **every** present `active`
  returned output is referenced. **Any present, `active`, unfolded output keeps the intent open.**
- A reference removed later flips that output's `folded_in` back to open while the intent stays
  `active` — folding is recomputed from disk, never a stored "done" flag.
- `superseded`/`withdrawn` outputs are excluded from the fully-folded requirement.

## Hand-off

Once every marked intent's present `active` outputs are folded (or legitimately trivial), the plan
is ready for **`package`** (decompose + baseline tag). `orient` re-derives all rungs from disk on any
pickup.
