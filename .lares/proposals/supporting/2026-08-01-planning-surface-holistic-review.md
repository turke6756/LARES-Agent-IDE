# Planning-surface program — Holistic Coherence Review

**Status:** findings report — GroupThink deliberation, Lead Planner × Reviewer,
Reviewer-approved 2026-08-01. **Audit, not a rescope.** This document changes no plan
scope and rewrites no plan document; it reports coherence findings across the complete
planning-surface program and recommends an execution order. Every finding names the
source document + section and a *recommended* reconciliation (advisory only).

**Documents audited (in order):**
1. `.lares/proposals/2026-07-30-planning-surface-revamp.md` (proposal body + Amendments
   1–9 + Amendments II rulings 10–23).
2. `.lares/proposals/supporting/2026-07-30-planning-surface-implementation-plan.md`
   (parent, stages P0–P8 + barriers A1/A2/A3 + WP-SEP + WP-FB).
3. `.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md`
   (supersedes P0–P2, adds P2L, §R0/§R1/§R2/§R-P3/§R-ATTR/§R-A2).
4. `.lares/proposals/supporting/2026-08-01-planning-surface-p4-p7-p8-durable-evidence-rescope.md`
   (supersedes P4/P7/P8).
5. `.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md` (normative contract).
6. `.lares/proposals/supporting/2026-07-30-save-card-implementation-plan.md` (SC-WP-*
   interlock — skimmed for names/stages/DDL order).

---

## Axis results (summary)

- **(a) Ruling traceability.** Amendments II contains **14 rulings (numbered 10–23)**.
  **12 of 14 are fully traced; rulings 15 and 21 are partially covered** (IMPORTANT-1 and
  IMPORTANT-2).
- **(b) One coherent sequence.** Two seams break: **P3 promotion is not
  worker-dispatchable** — parent P3 (stage acceptance, WP-P3B, WP-P3C, P3Z, stage graph)
  contradicts §R-P3 (BLOCKER-2); and the promotion async/reconciler machinery +
  `promotion_requests` DDL have no home WP brief (folded into BLOCKER-2). The
  `proposal-reader → planning-reader` rename is **clean** — every stale reference sits only
  in stages the rescopes supersede (P1, P2D, P4A, P4B); no untouched stage
  (P3/P5/P6/P7/P8) references the renamed file/IPC. **WP-SEP exists** (parent §A) and all
  consumers (WP-P6A, WP-P7-trail, WP-FB) resolve. **All `SC-WP-*` names resolve** against
  the Save-card plan — including `SC-WP-0A`, headed `## WP-0A` (not `### WP-`), which
  defines the contract types.
- **(c) A2 DDL order.** **No single materialized cross-plan total order exists in any
  document** (IMPORTANT-4). The documents supply Save-card internal partial orders, a
  planning linear chain, and the global "every `database.ts` edit serializes + rebases on
  head" rule. No two documents state an *incompatible pairwise* order, but "consistent
  total order across all documents" is **not proven**. Separately, parent WP-P2A says
  "**four**" plan ALTERs while both rescopes say "**five**" (`+ folder_rel_path`) —
  superseded, not live (MINOR-1).
- **(d) Circular dependencies.** **None found after applying supersession precedence.**
  Qualified: **P3 remains an incomplete replacement graph** until its new WPs/edges are
  written (BLOCKER-2), so this conclusion is provisional for P3.
- **(e) Stamping/attribution vs contract.** The *seam* is consistent (turn stamps §6.3;
  additive `orchestrations.planning_intent_id`; explicit "no `ResolvedPlanStamp` change").
  The **version label is not** (BLOCKER-1), and the **trailer grammar is unspecified**
  (IMPORTANT-5).
- **(f) Worker-readiness.** Most WPs are self-contained. Exceptions: the P3 cluster
  (BLOCKER-2); WP-P0A self-flags its size and offers a split; **WP-P7-ladder-low has an
  ambiguous — but not broken — ARC-manifest-ID handoff** (MINOR-2): its declared
  `{WP-P1A, …}` deps are sufficient *if* tier 1 enumerates the folder through the WP-P1A
  API directly, and need WP-P4A/P4Z added only if the plan-scoped UI supplies the ID.

---

## BLOCKERS (must be fixed before execution go)

**BLOCKER-1 — Bundle-contract version label is incoherent; the evidence-backed
reconciliation is v1.**
- **Where:** `2026-07-30-shared-bundle-contract.md` **title (line 1) says "(v3)"** but the
  **normative constant is `BUNDLE_CONTRACT_VERSION = 1`** (line 25, §12, §13), and §13
  explicitly requires "the constant and this file's version header move together." Parent
  planning plan and Save-card plan both consistently implement **v1**. Only the contract
  *title* and the two 2026-08-01 rescopes' prose say **v3**.
- **Why it blocks:** `contractVersion` is a checked field — §13 "consumers reject
  mismatches, force a rebuild" — and a candidate-identity input (§4.2). A worker building
  §R-ATTR / WP-P2L-runs / P7 against "v3" while the constant is `1` fails on the mismatch,
  and the contract file is internally self-contradictory.
- **Recommended fix (evidence-backed default, not an open choice):** treat the
  **wire/schema contract as v1** — the constant and both implementing plans agree — and
  **correct the contract title and the rescopes' "v3" prose to v1**, *unless Edward
  explicitly intends a breaking bump*. If "v3" was meant as a **document-revision number**,
  keep that as a separate `doc_revision` field and stop overloading it onto the wire
  `BUNDLE_CONTRACT_VERSION`. Pure doc reconciliation; do it before any stamping/attribution
  WP.

**BLOCKER-2 — The P3 promotion stage is not dispatchable; the contradiction spans the
whole stage, not just WP-P3B.**
*(CLOSED 2026-08-02: the P3 re-author (`2026-08-01-planning-surface-p3-reauthor.md`) is now
UNBLOCKED — Edward resolved BLOCK-1 (no promote-time doc selection; the planning activity's
emissions are the plan's documents) and BLOCK-2 (sidecar lockfile w/ heartbeat + stale reclaim,
skill helper as skill-side owner) via selection comments.)*
- **Where:**
  - Parent **P3 stage acceptance** (impl-plan lines 368–374): "promotion mints structured
    rows… **no HTML**," synchronous.
  - Parent **WP-P3B** (390–413): *"one SQLite transaction, **no filesystem write**…
    `proposal_id` + unique constraints ARE the idempotency key."*
  - Parent **WP-P3C** (425–435) Non-goal: *"**no auto-dispatch on promote** (Implement is
    P5)."*
  - **§R-P3** replaces this with filesystem-first atomic temp-dir→rename scaffold,
    adopt-not-duplicate of the P2B-folder row, **dispatch of a planning/hardening worker**
    (orchestration-before-delivery §R-P3.5), the durable **`promotion_requests`** de-dup
    row, an in-memory pending latch, **startup reconstruction** (§R-P3.6), and the
    **`plan-manifest.ts` CAS seam**.
- **The ambiguity to resolve:** WP-P3C's "no auto-dispatch" most plausibly meant *no P5
  execution-package dispatch* — but read literally it forbids the **planning/hardening
  dispatch** §R-P3 now requires. The reconciled briefs **must distinguish
  planning/hardening dispatch (allowed at promote, per Amendment 10) from P5 execution
  dispatch (gated behind the human Implement trigger, Amendment 1c)** and say so explicitly
  at each site.
- **Also unhomed:** the **pending-promotion reconciler**, **`plan-manifest.ts`**, and the
  **`promotion_requests` DDL** have no WP brief with Files/Accept/Verify;
  `promotion_requests` is assigned to "P3A's slot" but WP-P3A's body never creates it.
- **Recommended fix (before go — planning-doc work, not code):** re-author P3 into concrete
  self-contained WPs and update **P3 stage acceptance, WP-P3B, WP-P3C, P3Z, and the P3
  stage graph** together — e.g. **WP-P3A′** (add `promotion_requests` to the P3A DDL body),
  **WP-P3-manifest** (`plan-manifest.ts` CAS), **WP-P3B′** (the async
  scaffold→dispatch→adopt→enrich service, superseding the "no filesystem write" body
  verbatim), **WP-P3-reconcile** (§R-P3.6 startup reconstruction). Mark the parent WP-P3B
  body superseded. The reconciled briefs then *dispatch* post-gate at the P3 wave, but the
  **re-authoring is a pre-go blocker fix**, consistent with the taxonomy.

---

## IMPORTANT (fix during execution, at named points)

**IMPORTANT-1 — Ruling 15 partially covered: no phase↔package model, and readiness cannot
prove the plan is fully scoped.** The folder-native model makes **phases** `plan.md`
sections (§R1), but `plan_work_packages` (SC-WP-3A) is a flat, plan_id-keyed list with **no
phase association**, and P5/P6 (bodies untouched by both rescopes) predate it. Concretely,
neither P5 nor P6:
- models a phase-to-package association;
- verifies every phase has been scoped into packages before Mark Ready / Implement —
  **WP-P5B requires only "≥1 non-archived package,"** so a partially decomposed plan can go
  ready;
- proves the displayed package set is the complete finalized plan (ruling 15's "shows ALL
  phases and work packages up front").

**Fix point (before the P5 wave), covering backend eligibility *and* renderer grouping:**
define how phase identity is derived from `plan.md` (the §R1 phase refs); associate
packages to phases **without altering SC-WP-3A's pinned 11-column schema** (a companion
table like the existing `plan_work_package_layout` / `_paths` pattern); and either make
Mark Ready/Implement **reject incomplete phase→package scoping** or **record an explicit
authoritative completeness decision** the surface can display. Add this as a §R-P5/P6
alignment note mirroring §R-P3 / §R-ATTR.

**IMPORTANT-2 — Ruling 21 partially covered: `ARC.md` is created but never maintained
through execution.** The skill's orient/integrate modes (WP-P0A) create and refresh ARC
during *planning*; readers can flag staleness (WP-P7-ladder-low). But **no P5/P6/archive
transition refreshes ARC** as packages are created, executed, finalized, or committed, and
**WP-P8-archive-durability explicitly audits existing content and does not make it
durable**. So ARC's "work packages / who did what" sections go stale during execution with
no owner, and the promise of a **complete zero-DB historical arc** is not implemented. A
stale-ARC warning does not satisfy ruling 21.

**Fix point — respect filesystem-first (the DB ingests/enriches, it does not own
plan-folder artifacts, ruling 10):** make ARC refresh a **responsible-supervisor skill
action**, and make **WP-P5-archive eligibility verify both that ARC is fresh *and* that the
refreshed `ARC.md` is committed** (a refresh alone does not satisfy ruling 21's "committed
with the plan"). An application hook **may request or verify** a refresh but **must not
silently regenerate `ARC.md` from DB rows** — that would invert the ownership rule.
**Alternatively, narrow the §R2 / WP-P8-archive-durability acceptance claim** to "ARC is a
planning-phase summary; live execution status comes from the DB ledger," dropping the
zero-DB-complete-arc promise for the execution portion.

**IMPORTANT-3 — WP-P3A brief must actually create `promotion_requests`.** The DDL exists
only in §R-A2 prose ("lands inside P3A's serialized slot"); the WP-P3A body enumerates only
`responsible_supervisor_id` / `supervisor_active_plan` / `plan_documents` /
`plan_tab_overviews`. Fold into BLOCKER-2's WP-P3A′; called out separately because the A2
barrier depends on this DDL having a concrete owner.

**IMPORTANT-4 — No materialized cross-plan DDL total order; name the serialization owner
before the first DDL wave.** The documents give Save-card internal partial orders, a
planning linear chain, and the global serialize-and-rebase rule — but **never a single
merged order across both lanes' `database.ts` edits**. **Before Save-card Stage ② or
planning P2 begins**, the integrator must **materialize the actual merged order or name a
single serialization owner/queue** that assigns each DDL WP its rebase slot. Two guardrails:
**preserve Save-card's explicit Stage ② internal order `2A → 2G-DDL → binding-cols(2D,
2F)`** (save-card plan line 507), and **do not read the parent planning A2 comma-separated
"serialized set" as an ordering** — it is a set; its `2A, 2D, 2F, 2G` sequence actually
contradicts Save-card's real `2A, 2G, 2D, 2F` if misread as order.

**IMPORTANT-5 — Trailer authority is established but the trailer grammar is unspecified;
resolve before SC-WP-3G / SC-WP-4D and WP-P7-trail.** The contract establishes trailer
*trust* (§9.4) and all-or-none mixed-plan behavior (§3), and Save-card WPs promise
**server-generated** `Lares-Turns` / `Lares-Plan` trailers, but **no normative grammar
specifies exact values, multiplicity, ordering, encoding, or duplicate handling.**
WP-P7-trail's single `classifyLaresCommit` seam and WP-P7C consume these trailers and need
a concrete spec. **Fix point:** pin the trailer grammar in the bundle contract (as part of
the BLOCKER-1 version pass), resolved **before SC-WP-3G / SC-WP-4D (the assembler/coordinator
that would emit them) and before WP-P7-trail (the consumer)** — **not at P6D**, which only
invokes the shared route and explicitly does not forge trailers.

---

## MINOR / notes

- **MINOR-1 — Stale WP-P2A ALTER count.** Parent "four"; both rescopes "five"
  (`+ folder_rel_path`). Superseded; dispatch the five-ALTER rescoped body.
- **MINOR-2 — WP-P7-ladder-low ARC-manifest-ID handoff is ambiguous, not broken.** Tier-1
  ARC needs the exact ARC manifest doc ID and "does not resolve a plan_id against the
  registry." The WP text allows that ID to come from **either WP-P4A or WP-P1A**:
  - **If tier 1 invokes/enumerates the folder through the already-declared WP-P1A API
    directly, its declared dependency is sufficient** — no change needed.
  - **If the plan-scoped UI supplies the ID via WP-P4A, add WP-P4A / P4Z as an explicit
    dependency.**

  The brief should state which route it takes so the dep set is unambiguous; do not rely on
  WP-P7A-ui to bridge a route left unspecified.
- **MINOR-3 — Same WP id, different bodies across parent vs rescope**
  (WP-P1A/P1B/P2A/P2B/P2C/P2D/P4A/P4B/P4C-*/P4D-*/P4E). WP-P4A is the starkest (parent "plan
  documents" vs rescope "folder-native tab-model"). A one-line supersession map atop each
  rescope would remove all ambiguity.
- **MINOR-4 — DDL-creation order ≠ runtime order for P2L.** The A2 chain creates
  `plan_intents` before the P3A promotion slot, yet WP-P2L-runs operates at hardening time
  (after promotion). Fine under the guarded-CREATE / rebase-on-head rule; note so the chain
  isn't read as a runtime sequence.
- **MINOR-5 — Cross-stage file edit.** WP-P7-ladder-low appends a `source_cutoff_mtime`
  accessor to the P1-owned `planning-reader.ts`. The P7Z gate must re-run WP-P1A's suite and
  treat `planning-reader.ts` as a shared-surface file for contention.

---

## Recommended execution order — first waves after Edward's go

Honors two authoritative constraints: **A1 makes every planning WP depend on `SC-WP-0A`**
(so no planning WP runs in Wave 1 alongside it), and **the consolidated P0 graph is
`WP-P0PRE → {WP-P0A ∥ WP-P0B}`** (so WP-P0B follows WP-P0PRE regardless of its local
`Dep: none`).

- **Wave 1:** `SC-WP-0A` only (contract types + constants — the universal prerequisite;
  also where BLOCKER-1's version constant lands, so fix BLOCKER-1 first).
- **Wave 2:** `WP-P0PRE` + Save-card `{SC-WP-1A, SC-WP-1P, SC-WP-1C}`.
- **Wave 3:** after `WP-P0PRE`, `{WP-P0A, WP-P0B, WP-P1A}` in parallel; on the Save-card
  lane, `SC-WP-1B` after `1A + 1P`.
- **Later pre-gate waves:** `WP-P0C → P0Z`; `WP-P1B → WP-P1C`; `WP-P1S` (needs `SC-WP-1I`);
  **`P1Z`** — then **★ Gate K ★**.

**WP-SEP is gate-independent.** It is explicitly "not gated on K" and backs the WP-FB
fallback if K fails, so **schedule it as soon as Save-card Stage ② completes — potentially
during the probe window, before Gate K resolves** — not after the gate. The **pre-gate
critical path** is universal `SC-WP-0A` plus `SC-WP-1I → WP-P1S`, ending at `P1Z`; WP-SEP
runs off to the side on the Save-card Stage ② signal.

**Post-gate (only if K is met):** P2, P2L, and the re-authored P3 cluster. Everything
through Gate K is Save-card-light — the only pre-gate interlock is `WP-P1S ← SC-WP-1I` (plus
the universal `SC-WP-0A`).

**Sequencing of the fixes:** BLOCKER-1 before Wave 1 (it *is* the Wave-1 constant).
BLOCKER-2 (P3 re-author) before go, dispatching at the post-gate P3 wave. IMPORTANT-4
before Save-card Stage ② or planning P2 begins. IMPORTANT-5 before SC-WP-3G/4D and
WP-P7-trail. IMPORTANT-1/-2 before the P5 wave.

---

## Addendum 2026-08-02 — guide-review rulings (revamp Amendments III) affect the wave plan

Edward's rulings 26–31 (see the revamp proposal's Amendments III) landed after this
review. Wave-order impact:

- **HOLD LIFTED (2026-08-02, same day):** Edward approved GroupThink 2850dad1's hybrid
  recommendation (`2026-08-02-skill-vs-workflow-recommendation.md`); WP-P0A/WP-P0C are
  re-authored per it in the p0-p2 rescope and the full Wave 1 (P0 + P1) is dispatchable
  on Edward's GO.
- **Scope semantics changed (ruling 27):** scope = hardening triage with an independent
  second opinion, output = marked-up proposal; decomposition is the journey's last step.
  Folded into the p0-p2 rescope's Δ blocks.
- **Save-card decoupling (ruling 26):** the P6 commit checkbox is deferred; the SC
  Stage-④ interlock applies only if the surfaces are later re-joined. The SC Stage-③
  finalization-evidence gate for P5–P7 stands.

<!-- groupthink: planning-surface holistic coherence review, Lead Planner × Reviewer, 4 rounds, approved 2026-08-01 -->


<!-- groupthink_run: 207e5a7b (mode=serial) -->
