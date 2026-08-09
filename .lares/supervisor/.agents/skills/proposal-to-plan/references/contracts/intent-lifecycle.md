# Contract reference — §R1: PLAN-INTENT markup + machine-checkable lifecycle

> **Canonical, single copy.** This file reproduces **§R1** of
> `.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`
> **verbatim** (sentinels, output frontmatter, integration record, the rung
> ladder, per-output rung rules, and re-entry semantics). It is the one
> authoritative copy inside the skill; `scope`, `deliberate`, `integrate`, and
> `orient` cite it and never restate it.

---

## §R1 — NORMATIVE: PLAN-INTENT markup + machine-checkable lifecycle (rulings 13, 16, 17, 20)

The planning agent's markup/intent pass etches intent **durably in the canonical marked document**
(the proposal during the markup pass; migrated into `plan.md` on hardening).

**PLAN-INTENT sentinel** — valid JSON (the optional supersede field is added to the same object,
never as a comment):

```html
<!--PLAN-INTENT
{ "intent_id": "int_8hex", "part": "attribution-timing",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "one line: why this part needs deliberation" }
-->
```

Reopening a decision adds one field to the same object — `"supersedes_intent_id": "int_prev"` —
and **mints a new `intent_id`**; sentinels are **never silently reused**.

**Deliberation / research output frontmatter (required).** Every in-folder output declares its
linkage; `returned` derives from this, never from a filename convention:

```yaml
---
plan_artifact_id: plan_<hex>
intent_id: int_8hex
orchestration_id: orc_<id>     # worker SELF-DECLARATION; honored only as a cross-check
kind: deliberation | research
---
```

The self-declared `orchestration_id` is **not** the authoritative `ran` signal — the authority is
the server-witnessed `orchestrations.planning_intent_id` (§P2L).

**PLAN-INTEGRATION record — JSON sentinel, adjacent to the reference, per exact output** (robust to
quotes/markup in `changed`):

```html
<!--PLAN-INTEGRATION
{ "intent_id": "int_8hex", "output_rel_path": "deliberations/2026-08-01-attr.md",
  "changed": "what the deliberation changed", "disposition": "active" }
-->
```

`disposition` ∈ `active | superseded | withdrawn` (default `active`).

**Lifecycle chain — every rung answered by inspection, machine-checkable (ruling 16):**

| Rung | Authoritative signal |
|---|---|
| **marked** | a valid `PLAN-INTENT` sentinel exists in the canonical marked doc |
| **ran** | a **server-witnessed** orchestration linked to this intent exists (`orchestrations.planning_intent_id`, joined on `(plan_id, planning_intent_id)`) — a required rail, not a heuristic; **unavailable pre-ledger** |
| **returned** | ≥1 **currently-present** in-folder output whose frontmatter `intent_id` + `plan_artifact_id` match |
| **folded-in** | a **normalized Markdown link** in the relevant `plan.md` phase **resolves (containment + existence)** to that exact present output — a raw textual substring is explicitly insufficient (false-positives on prose / code fences / comments) |

**Per-output rung rules (reruns produce multiple outputs; the surface lists each result
independently so one folded rerun never hides another pending result):**

- `returned` = **≥1 currently-present** output.
- `fully_folded_in` = **every currently-present `active` returned output is referenced**;
  `superseded`/`withdrawn` outputs are excluded from the requirement.
- **Any present, `active`, unfolded output keeps the intent open.**

**Re-entry semantics (ruling 17):**

- A **rerun of the same still-open intent** → another orchestration under the **same `intent_id`**;
  potentially another output artifact (all retained, §P2L).
- A **superseding / reopened decision** → a **new `intent_id`** carrying `supersedes_intent_id`.
- **Removed or superseded marks stay historical** and render **withdrawn / superseded**, never as
  current satisfaction.
- **Scanner reconciliation** is presence-aware and scan-transactional — see WP-P2L-ingest.
