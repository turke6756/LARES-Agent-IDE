---
plan_artifact_id: plan_65e665d7
kind: work-packages
---

# Work packages — Planning Surface Audit

Five packages. WP-1..WP-3 are document work a worker can do; WP-4 and WP-5 are the audit run
itself, executed by the responsible supervisor through dispatched auditors.

**Authority note.** The **prose sections below are authoritative** for scope. The
`PLAN-WORK-PACKAGES:v1` block is an additive machine projection — if the two ever disagree, the
prose `Files` list wins. Do not brief a worker from the machine block.

**Standing non-goal for every package:** `ARC.md` and `plan.json` are supervisor-owned. No worker
edits them, and no worker runs `plan-manifest.mjs`. Report; do not record.

**Disqualified from every auditing role** (WP-4, WP-5): `ae889b24` (authored the rubric and its
calibration set; participated in the audited run) and `c30eb66f` (scoped and promoted this plan).
Any agent that participated in, dispatched into, or gated the audited run is likewise disqualified.
Independence is agent-level, not provider-level.

<!--PLAN-WORK-PACKAGES:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_65e665d7",
  "packages": [
    {
      "id": "WP-1",
      "order": 10,
      "title": "Correct the rubric against the current tree",
      "initial_state": "ready",
      "acceptance_conditions": [
        "No occurrence of read_plan_projection or read_plan_section survives as an instruction to the auditor.",
        "A8 no longer scores PLAN-EVENT emission, writeCounts, sec_exectr, or generated Execution Trail lines, and is replaced by the durable-lifecycle dimension from the folded deliberation.",
        "A scoring rule exists that lets a clean run reach 4 via an inspectable mechanism, with an N/O state excluded from the denominator.",
        "Section 7 requires a conflict-of-interest disclosure and calibration seal/unseal record in the report.",
        "Section 2.2 no longer forbids questioning participants outright; it carries the participant-interview protocol from Amendment 4 instead.",
        "The document names the case study as agent 229530a1 and plan plan_5b3ea7d1, and states that the calibration set describes a different run and applies to the whole-surface population only.",
        "The Hardening scope section, the PLAN-INTENT sentinel, the Hardening outputs section, the PLAN-INTEGRATION record, and the Supervisor amendments section are left byte-identical."
      ],
      "paths": [
        { "path": ".lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/plan.md", "intent_kind": "edit" }
      ],
      "depends_on": []
    },
    {
      "id": "WP-2",
      "order": 20,
      "title": "Seal the calibration set",
      "initial_state": "ready",
      "acceptance_conditions": [
        "supplements/audit-calibration-set.md contains the Appendix claims verbatim, including their do-not-treat-as-answers warning.",
        "The Appendix body in plan.md is replaced by a sealed-calibration notice naming the protocol, not by the claims themselves.",
        "The SHA-256 of the calibration file is recorded in the sealed notice.",
        "No claim text from the calibration set remains anywhere in plan.md."
      ],
      "paths": [
        { "path": ".lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/supplements/audit-calibration-set.md", "intent_kind": "create" },
        { "path": ".lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/plan.md", "intent_kind": "edit" }
      ],
      "depends_on": ["WP-1"]
    },
    {
      "id": "WP-3",
      "order": 30,
      "title": "Write the three dispatch briefs",
      "initial_state": "ready",
      "acceptance_conditions": [
        "Three complete, self-contained briefs exist: Agent-Evidence Collector, Surface-Evidence Collector, Lead Auditor.",
        "Each brief carries its exact single outbox path, its token and turn ceilings, its escalation caps, and an explicit read-only mandate with the enumerated denied operations.",
        "The evidence-packet schema is reproduced in full in both collector briefs.",
        "The deterministic sampling rule and its disclosure obligation appear in every brief that samples.",
        "The Lead Auditor brief states that collector packets are leads and not evidence, and enumerates what the lead must re-read first-hand.",
        "The briefs name the case study as agent 229530a1 and plan plan_5b3ea7d1, and state that the full multi-session set is to be established by the collector, not assumed.",
        "The briefs state that the calibration set describes a different run and that failing to reproduce a calibration claim inside the case-study trace is expected and is not a finding.",
        "The briefs carry the participant-interview protocol: after collection only, tier 3, labelled, verbatim question quoted, never sole basis, never overriding tier 1, questions inert, every interview disclosed."
      ],
      "paths": [
        { "path": ".lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/supplements/audit-dispatch-briefs.md", "intent_kind": "create" }
      ],
      "depends_on": ["WP-1"]
    },
    {
      "id": "WP-4",
      "order": 40,
      "title": "Run evidence collection",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "The audited plan folder was frozen before dispatch and the freeze time recorded: no orient, no ARC refresh, no planning-event recording on plan_5b3ea7d1 until the lead baseline is hashed.",
        "Both auditor identifiers were checked against the disqualification list before dispatch and the result recorded.",
        "Both packets exist, validate against the packet schema, and declare calibration_accessed false.",
        "Any packet whose collector is later found to have participated in the audited run is marked compromised and replaced.",
        "Budget overruns are reported as shortfalls in the packet rather than silently truncating the population."
      ],
      "paths": [
        { "path": ".lares/research/inbox/packet-agent-evidence.md", "intent_kind": "create" },
        { "path": ".lares/research/inbox/packet-surface-evidence.md", "intent_kind": "create" }
      ],
      "depends_on": ["WP-1", "WP-2", "WP-3"]
    },
    {
      "id": "WP-5",
      "order": 50,
      "title": "Lead audit pass, calibration unseal, and final report",
      "initial_state": "blocked",
      "acceptance_conditions": [
        "The lead completed an independent pass with the calibration set sealed, and its provisional scorecard, findings, C1, and C4 were hashed before any unsealing.",
        "Every post-unseal change is labelled post-calibration lead and explains why it was absent from the independent pass.",
        "Every score carries at least one citation, and every uncorroborated dimension is marked N/O rather than scored.",
        "The report contains the verdict, method and coverage with disclosed sampling, the scorecard, ranked findings, the C1 trace table, the ranked C4 silent-failure inventory, recommendations, and open questions.",
        "The report contains a conflict-of-interest section and states the residual read-only enforcement gap: the mandate was lane-restricted and verified after the fact, not sandboxed.",
        "Any participant interview happened after the baseline hash, is labelled participant testimony, quotes the verbatim question, and is disclosed in the method section.",
        "A post-run integrity check over the audit window shows no audit-caused mutation, and its method is stated."
      ],
      "paths": [
        { "path": ".lares/research/inbox/planning-surface-audit-report.md", "intent_kind": "create" }
      ],
      "depends_on": ["WP-4"]
    }
  ]
}
-->

## WP-1 — Correct the rubric against the current tree

**Files**
- `plan.md` (edit) — sections §2.9, §3.3, §3.4, A8, the scoring preamble to Parts A and B, and §7.

**Dep** — none.

**Do**
- Replace the retired plan-read instructions in §2.9 and §3.3. `read_plan_projection` and
  `read_plan_section` no longer exist: the plans MCP read-definition array is empty
  (`scripts/mcp-tools-plans.js:23`, `:100`), only list/get/create/update/delete are registered
  (`src/main/api-server.ts:3655`), and the retired routes are tested as 404
  (`src/main/api-server-plans.test.ts:259`). Re-derive these facts yourself before editing; do not
  take them on faith from this brief. Substitute the eight-step disk-and-tool read order given in
  the folded deliberation.
- Replace §3.4 with the deterministic sampling rule and its disclosure obligation.
- Replace A8 wholesale with the "Durable lifecycle and handoff discipline" dimension from the
  deliberation, including its explicit do-not-score list.
- Add the clean-run scoring rule before Parts A and B, with the adjusted-percentage formula and the
  `N/O` state, and rewrite the incident-dependent anchors (A3 and A6 at minimum) so a 4 does not
  require an incident the run never had.
- Add to §7 a required conflict-of-interest section and a calibration seal/unseal record.
- Replace §2.2's blanket "do not ask participants" with the participant-interview protocol from
  Amendment 4 in `plan.md`. The audited agent is live and the workspace owner has authorized
  questioning it; the rule is now *when* and *how*, not *whether*. §2.1 read-only is unchanged.
- Name the case study (`229530a1` / `plan_5b3ea7d1`) and record that the calibration set describes
  a different run, so it applies to the whole-surface population only.
- Insert the topology, budget, independence and read-only rules from the deliberation into the
  document so the rubric reads as one executable instrument.

**Accept** — the seven conditions listed for WP-1 in the machine block.

**Non-goals**
- Do **not** touch `ARC.md`, `plan.json`, or `deliberations/`.
- Do **not** touch the `## Hardening scope` section, the `PLAN-INTENT` sentinel, the
  `## Hardening outputs (folded)` section, the `PLAN-INTEGRATION` record, or the
  `### Supervisor amendments` section. Those are the plan's provenance and must stay byte-identical.
- Do **not** move the calibration appendix — that is WP-2.
- Do **not** build the "read-only snapshot / read-only API proxy / separate credential" layer. It is
  ruled out of scope (see Supervisor amendments in `plan.md`).

**Verify** — `grep -n "read_plan_projection\|read_plan_section\|PLAN-EVENT\|writeCounts\|sec_exectr" plan.md`
returns only occurrences that are explicitly labelled as retired-and-not-to-be-scored. Re-read the
five preserved sections and confirm they are unchanged.

## WP-2 — Seal the calibration set

**Files**
- `supplements/audit-calibration-set.md` (create)
- `plan.md` (edit) — the Appendix only.

**Dep** — WP-1 (both edit `plan.md`; do not run them concurrently).

**Do**
- Move the Appendix "Calibration set" claims **verbatim**, including the warning that they are
  claims and not conclusions, into `supplements/audit-calibration-set.md`.
- Compute the file's SHA-256 and replace the Appendix body in `plan.md` with a sealed-calibration
  notice: what the set is, that it is withheld until the lead's independent baseline is locked and
  hashed, where it lives, and the recorded digest.

**Accept** — the four conditions listed for WP-2 in the machine block.

**Non-goals** — do not edit any other section of `plan.md`; do not paraphrase or "improve" the
claims while moving them; do not delete the set.

**Verify** — recompute the SHA-256 and confirm it matches the notice. Grep `plan.md` for a
distinctive phrase from each moved claim and confirm zero hits.

## WP-3 — Write the three dispatch briefs

**Files**
- `supplements/audit-dispatch-briefs.md` (create)

**Dep** — WP-1 (the briefs must reflect the corrected rubric).

**Do**
- Write three complete, self-contained briefs — Agent-Evidence Collector, Surface-Evidence
  Collector, Lead Auditor — each dispatchable as-is with no further editing.
- Reproduce the evidence-packet schema in full in both collector briefs; state each agent's single
  exact outbox path; state its token/turn ceilings and escalation caps; state the read-only mandate
  with the denied operations enumerated (no writes outside the outbox, no plan create/update/delete,
  no `record_planning_event`, no checkpoint prune/revert, no `restore_paths`/`revert_turn`, no agent
  dispatch, no orchestration launch, no messaging, no browser, no notebook mutation).
- State the case study **exactly as follows**: the audited agent is
  `229530a1-04f9-4781-9c8d-a92cae9b7e18` ("new propsoal", claude supervisor, **still live**), which
  ran the proposal-to-plan pipeline **across multiple sessions** for plan `plan_5b3ea7d1`
  (planId `81fbc146-068d-401f-b667-aeb0bb04cbcf`, SKU
  `2026-08-06-save-card-streamlining-one-gesture-no-ceremony-5b3ea7d1`), from source proposal
  `prop_5b3ea7d1` at `.lares/proposals/2026-08-06-save-card-streamlining-restamped.md`.
  **The brief must instruct the collector to establish the full session set itself** — the agent was
  renewed and its earlier sessions carry most of the pipeline execution — **and to report any
  divergence from the identifiers above as a finding rather than silently adopting either version.**
- State that the calibration set describes a **different** run (`ae889b24`'s two-plan run) and
  therefore calibrates against the whole-surface population only. **Failure to reproduce a
  calibration claim inside the save-card case-study trace is expected and is not a finding.**
- Include the **participant-interview protocol** (Amendment 4 in `plan.md`): interviews are
  authorized but occur only after collection and after the lead's baseline hash; testimony is tier 3,
  labelled `[participant testimony]`, quoted with the verbatim question, never the sole basis for a
  finding, never overriding tier 1; questions must be inert — never ask the agent to check, verify,
  refresh, re-derive, or fix anything; every interview is disclosed in the method section.
- State in the Lead Auditor brief that collector packets are **leads, not evidence**, and enumerate
  exactly what the lead re-reads first-hand.

**Accept** — the eight conditions listed for WP-3 in the machine block.

**Non-goals** — do not dispatch anyone; do not begin collecting evidence; do not edit `plan.md`.

**Verify** — read each brief back as if you were the receiving agent with no other context and
confirm it is executable: outbox known, budget known, denied operations known, deliverable shape
known.

## WP-4 — Run evidence collection

**Files**
- `.lares/research/inbox/packet-agent-evidence.md` (create, by the dispatched collector)
- `.lares/research/inbox/packet-surface-evidence.md` (create, by the dispatched collector)

**Dep** — WP-1, WP-2, WP-3. Blocked until all three land.

**Do** — responsible supervisor executes. **First, freeze the audited plan folder**
(`.lares/plans/2026-08-06-save-card-streamlining-one-gesture-no-ceremony-5b3ea7d1`): confirm with
`229530a1` that it will run no `orient`, no ARC refresh, and no `record_planning_event` on that plan
until the lead's baseline is hashed, and record the freeze time. An `orient` mid-collection rewrites
`ARC.md` freshness metadata, which is the exact evidence dimension B4 measures. Then check both
candidate auditor ids against the disqualification list and record the result. Dispatch both
collectors concurrently with the WP-3 briefs, read-only, with the calibration supplement outside
their read scope. Gate each returned packet against its schema.

**Accept** — the five conditions listed for WP-4 in the machine block.

**Non-goals** — no scoring, no ranking, no moral labels, no Part C construction in a packet. No
collector reads the calibration supplement.

**Verify** — validate both packets against the schema; confirm `calibration_accessed: false`;
confirm neither collector id appears in the audited run's participant set.

## WP-5 — Lead audit pass, calibration unseal, and final report

**Files**
- `.lares/research/inbox/planning-surface-audit-report.md` (create, by the dispatched lead)

**Dep** — WP-4.

**Do** — responsible supervisor executes. Dispatch the lead for its independent turn with the
calibration sealed. Capture and hash its provisional scorecard, findings, C1 and C4 as the
independent baseline. Then unseal `supplements/audit-calibration-set.md` and resume the lead for
exactly one calibration turn. Run the post-run integrity check (`git status` plus `list_checkpoints`
over the audit window) and confirm no audit-caused mutation.

**Accept** — the seven conditions listed for WP-5 in the machine block.

**Non-goals** — the lead does not repair anything it finds; a repaired defect is an unmeasured
defect. A calibration mismatch alone does not change a score. Do not let the lead cite a packet in
place of the underlying source.

**Verify** — every score has a citation; the baseline hash predates the unseal; every post-unseal
edit is labelled; the report states the residual read-only enforcement gap rather than implying a
sandbox.
