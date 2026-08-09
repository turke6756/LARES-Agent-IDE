# Activity playbook — `deliberate`

**Purpose.** Launch a bounded hardening run — a **groupthink** deliberation or a **research** dig —
**keyed to exactly one marked PLAN-INTENT**. Deliberate reuses the **existing** groupthink
orchestration and researcher lane; it introduces **no new orchestration** and no journey driver.

**Lane.** Launching a deliberation on a plan the supervisor is responsible for is a supervisor
activity in practice; the actual **fold-in** (`integrate`) is supervisor-only. Orientation before
launching is open to anyone.

**Contracts loaded.** `references/contracts/intent-lifecycle.md` (§R1 — the intent being served, the
required output frontmatter, and re-entry semantics).

---

## Steps

1. **Pick the marked intent.** Read the PLAN-INTENT sentinel (from `plan.md`, or the source proposal
   pre-hardening). Confirm it is **`active`** and belongs to this plan.
2. **Launch the existing lane keyed to that one intent:**
   - `kind: groupthink-serial | groupthink-parallel` → the **existing `groupthink` orchestration**
     via `run_orchestration`, with the intent's `targets` (providers/models).
   - `kind: research` → the **existing researcher lane** (writes findings to
     `.lares/research/inbox/`; cleared findings become durable in `.lares/research/cleared/`).
3. **Brief the lane on the hardening context** — which part of the plan it serves and why (the
   intent's `reason`).
4. **Require the output frontmatter (§R1)** on every in-folder output the run produces:
   `plan_artifact_id`, `intent_id`, `orchestration_id` (self-declared cross-check only), `kind`.
   `returned` derives from this frontmatter, **never** from a filename convention.

## Rules

- **One intent per launch.** A run serves exactly one PLAN-INTENT so the surface can show it "in
  service of *this* marked part."
- **Re-entry (§R1):** a rerun of a still-open intent launches **another** orchestration under the
  **same `intent_id`** and may produce **another** output artifact (all retained). A superseding
  decision is a **new `intent_id`** with `supersedes_intent_id` — mint it in `scope`, not here.
- **`ran` is server-witnessed and unavailable from disk pre-ledger.** Deliberate does **not** write a
  `ran` signal; the self-declared `orchestration_id` is a cross-check only, never authority. A
  detached deliberation may be running with no returned artifact yet — that is "launch state
  unknown" to `orient`, not "done."
- Deliberate **does not fold**. Folding is a separate, later, supervisor-owned act (`integrate`),
  triggered by a valid returned artifact's presence.

## Hand-off

When a run returns an in-folder output (correct frontmatter, contained), the responsible supervisor
runs **`integrate`** to validate and fold it. Until then `orient` surfaces the intent as
returned-but-open (or launch-unknown if nothing is present yet).
