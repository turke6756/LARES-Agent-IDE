---
artifact_id: prop_e0001372
title: Bridge the proposal-to-plan skill and the planning surface (dual-register docs, disk→DB reconciler, run-to-implementation)
author_role: supervisor
author: Edward Turk + workspace supervisor (from live test of plan_pigt5a83)
authored_at: 2026-08-05T16:45:00-07:00
promoted_to: 2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372
promoted_at: 2026-08-05
---

# Proposal: bridge the proposal-to-plan skill and the planning surface

## Origin

First live end-to-end run of the proposal-to-plan flow (supervisor f56fe814,
"Planning supervisor - provider inclusive Groupthink", plan `plan_pigt5a83`,
2026-08-05). The supervisor executed the skill faithfully — scope, promote,
GroupThink deliberation, integrate, package, ten gated WPs — yet the planning
surface stayed mostly dark and Edward could not build a mental model of the
plan without asking the supervisor to explain it in chat.

Root cause, established by transcript trace + code trace (file:line evidence
inline below): **the skill and the surface live in two disconnected worlds.**
The skill writes files in the plan folder; the UI reads SQLite; the sole
bridge (`enrichAdoptedPlanRow`, the server promotion saga in
`src/main/database.ts:8003-8065`) is unreachable — `PromoteDialog`, the only
caller of the real `proposal:promote` service, is imported nowhere; the
mounted `PromoteToPlanPanel` merely asks an agent to run the skill.

## Observed failures (all structural, none supervisor error)

1. **Promoted proposal never leaves the Proposals gallery.** Gallery is
   filesystem-only (`ProposalCardGallery.tsx:44-54`,
   `src/main/plans/planning-reader.ts:563-603`); the one hide-when-promoted
   rule (`src/main/plans/plan-gallery.ts:321-322`) filters a DB projection the
   pane never consumes; the skill's promote playbook never marks the source
   file.
2. **Plan surface Proposal tab renders empty.** It reads a `plan_documents`
   row (`src/main/plans/plan-documents.ts:219-221, 90-97`) whose sole writer
   is the unreachable saga; `plan.json.source_proposal.rel_path` — which the
   skill correctly writes — is ignored by the tab.
3. **Work packages appear only as a generic supplement.** Mission Board and
   the Packages tab read exclusively `plan_work_packages`
   (`src/main/plans/mission-board.ts:60-115`), a table **no production code
   writes at planning time**; neither the supplements file the skill writes
   nor ARC's `## Work packages` section has any parser/ingest.
4. **Plan-review column empty for the whole lifecycle.** The review
   projection throws without an active execution run
   (`src/main/plans/plan-ipc.ts:540-541`); Implement requires ≥1 `ready` WP
   row (`src/main/plans/plan-implement.ts:10-20`) — impossible per (3). The
   entire back half of the surface is dead-ended for skill-driven plans.
5. **No human-readable layer.** All plan-folder prose (plan.md, ARC.md, WP
   supplement) is agent-register contract-speak. The only plain-language
   explanation ever produced was a one-off chat answer after Edward asked
   "can you explain to me in simple terms what is being done" — good content,
   zero durability. The UI's intended human surface (Overview tab summary
   band, `plan_tab_overviews`) stayed "overview pending": it is DB-only and
   the skill has no step or tool that populates it.
6. **The supervisor stopped mid-flow.** It paused for "continue" after
   promote and again between phases. The skill nowhere authorizes those
   stops; the only mandated stop is before implementation dispatch.

## Design principles

- **Dual-register, both durable.** The agent-register text (bundle-contract
  WPs, ARC ledger, sentinels) is *good* — it is the handoff medium for other
  agents and must not be diluted. The human-register layer is *additional*:
  plain-language, durable, on the surface. Never one at the expense of the
  other.
- **Disk is the source of truth; the DB follows it.** The skill's folder is
  resumable ground truth by design. Rather than forcing agents through DB
  sagas, reconcile skill-written folders into the DB state the UI expects.
- **One promote story.** Two half-connected promote paths (unmounted dialog
  vs. skill dispatch) is how this gap happened; end state must have exactly
  one.

## Work items (summary — scope/deliberation to refine)

**A — Skill: human-readable layer + run-to-implementation (markdown-only,
cheap, immediate)**

- **A1** New mandatory step at the end of `package` (the pre-implementation
  pause): the responsible supervisor writes a plain-language overview —
  what we are doing and why (2-3 sentences), each WP in one human sentence,
  what is decided, what is pending with the human. Durable location (exact
  home decided in scope; candidates: a dedicated `OVERVIEW.md` beside ARC.md
  that the Overview tab prefers, and/or `plan_tab_overviews` rows once A4
  ships). The register rule goes in the playbook verbatim: *written for the
  workspace owner, no sentinel names, no rung jargon, no file:line.*

<!--PLAN-INTENT
{ "intent_id": "int_7c3e9a12", "part": "human-overview-layer (A1+B4)",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "one line: a single disk overview conflicts with the per-populated-tab plan_tab_overviews readiness gate — source, mapping, and readiness semantics for A1's home and B4's band must be decided together" }
-->
- **A2** Continuity rule in SKILL.md: once `scope` begins, the supervisor
  proceeds through promote → deliberate → integrate → package **without
  stopping for permission**; the one built-in stop is after `package`, where
  it presents the A1 human overview for review and awaits the explicit
  implementation trigger. (Escalation for genuine Tier-3 questions stays
  allowed; "phase done, continue?" pauses are not.)
- **A3** `promote` playbook stamps the source proposal's frontmatter
  (`promoted_to: <plan_sku>`, `promoted_at:`) after successful scaffold, and
  refreshes the proposal's own `## Status` line if present (the pigt copy
  still says "not yet scoped/promoted").

**B — Surface: read what the skill writes**

- **B1** Proposal gallery filters cards carrying `promoted_to` frontmatter
  (filesystem-consistent with the rest of the pane; render optionally as a
  collapsed "promoted" group rather than deletion, so history stays
  discoverable).
- **B2** Proposal tab falls back to `plan.json.source_proposal.rel_path`
  when no `plan_documents` row exists.
- **B3** WP ingest: parse the `kind: work-packages` supplement (and/or ARC's
  `## Work packages` ledger) into `plan_work_packages` rows on folder
  adoption/refresh (`plan-folder-watcher.ts` is the natural host). This is
  the keystone: it lights up Mission Board and the Packages tab **and
  unlocks Implement → execution runs → the review column** for skill-driven
  plans.

<!--PLAN-INTENT
{ "intent_id": "int_4f8b2d61", "part": "wp-ingest-implementability-chain (B3 + supervisor reconciliation)",
  "kind": "groupthink-parallel",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "one line: WP identity/parsing/reconciliation between disk planning data and DB runtime state is load-bearing, and B3 alone does not unlock Implement — responsible_supervisor_id reconciliation, mark-ready transition, and ready-state rules must be designed as one chain" }
-->
- **B4** Overview band: prefer the A1 human overview from disk (or provide
  an MCP/IPC path for the supervisor to set `plan_tab_overviews`), so the
  "overview pending" band fills without manual UI action.
- **B5** Review column empty-state honesty: while no execution run exists,
  render *why* ("no work packages implemented yet — pull Implement to
  begin") instead of an error/permanent blank.

**C — Promote-path decision**

- **C1** Decide and implement the single promote story: either mount the
  real `PromoteDialog`/saga and make the skill call the same service, or
  bless the skill+reconciler path (B-series) and delete the dead saga code
  (`PromoteDialog.tsx`, unreachable branches of `promote-proposal.ts`).
  Leaning: skill+reconciler is already the de-facto path and preserves
  disk-as-truth; a live saga would reintroduce a second writer.

<!--PLAN-INTENT
{ "intent_id": "int_9e5d0c47", "part": "promote-path-single-writer (C1)",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "one line: the saga is partially wired (IPC service + pending-request reconciler run at startup), so choosing the sole writer needs a migration policy and a full deletion inventory, not casual dead-code removal" }
-->

## Scope boundaries

- No change to the agent-register artifacts' format (bundle contract, ARC
  ledger, sentinels, rung ladder) beyond A3's frontmatter stamp.
- No new orchestration modes; A2 is prose in the existing skill.
- Legacy HTML plan surface (`plans/*.html`) untouched.

## Evidence pointers

- Transcript trace: supervisor f56fe814, sessions 253dc340 / 9c20c57d
  (Claude projects dir, lares-supervisor slug).
- Code trace with file:line for every mechanism above: available from the
  2026-08-05 investigation in the workspace supervisor session; key files:
  `ProposalCardGallery.tsx`, `plan-documents.ts`, `mission-board.ts`,
  `plan-ipc.ts`, `plan-implement.ts`, `promote-proposal.ts`,
  `plan-folder-watcher.ts`, `database.ts:8003-8065`.

## Hardening scope
- **Verdict (dated):** 2026-08-05 — three parts need groupthink deliberation: the human-overview layer (A1+B4, one design because the disk overview collides with the per-tab `plan_tab_overviews` readiness gate), the WP-ingest implementability chain (B3 widened to include `responsible_supervisor_id` reconciliation, mark-ready transition, and ready-state rules — B3 alone does not unlock Implement), and the promote-path single-writer decision (C1, whose saga is partially wired at startup and needs a migration policy + deletion inventory). A2, A3, B1, B2, B5 need no hardening — bounded playbook/projection edits; specify A3's concurrency-safe frontmatter update and B2's containment/dedup checks at package time. No part needs online research (all uncertainty is repo-local architecture and product policy).
- **Second opinion:** codex-lane read-only reviewer, agent 157853e2 (2026-08-05) — validated the proposal's file:line claims by spot-check; contributed the implementability-chain gap, the partially-wired-saga correction, and the B3 ingest-schema/tombstone/transactionality risks.
- **Marked intents:**
  - `int_7c3e9a12` — human-overview-layer (A1+B4), groupthink-serial: decide source, per-tab mapping, and readiness semantics together.
  - `int_4f8b2d61` — wp-ingest-implementability-chain (B3+), groupthink-parallel: WP identity/parsing/reconciliation plus the full chain that makes a skill-driven plan implementable.
  - `int_9e5d0c47` — promote-path-single-writer (C1), groupthink-serial: sole-writer decision with migration policy and deletion inventory.

## Status

Captured 2026-08-05 from the live plan_pigt5a83 test, per Edward's direction.
Scoped and PROMOTED 2026-08-05 into plan folder
`.lares/plans/2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372`
(plan_e0001372). Three marked intents await deliberation (see `## Hardening
scope`); responsible supervisor: "Planning supervisor - planning surface fix"
(ae889b24).
