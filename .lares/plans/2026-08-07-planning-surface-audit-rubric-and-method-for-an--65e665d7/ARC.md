# ARC — Planning Surface Audit — rubric and method for an auditing agent   (plan_sku: 2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7 · plan_artifact_id: plan_65e665d7)
<!--ARC-META {"last_refreshed_at":1786130261386,"source_cutoffs":{"folder_mtime_ms":1786130252803.7292,"ledger_updated_at":null}} -->
## Decisions
- 2026-08-07 — 2026-08-07 - one intent (int_7b3ce2a4, groupthink-serial) on auditor execution design; all other parts need neither deliberation nor research.
- 2026-08-07 — **Scope ambiguity resolved by the responsible supervisor, not deliberated.** §1/§3.1
  of `plan.md` mandate a whole-surface audit; the human-inserted paragraph (plan.md line ~51) asks
  for a performance review of one agent across renewed sessions and names no id. Ruling: the audit
  is **the whole-surface rubric applied through one bounded case study**, primary trace = that
  agent's proposal→plan pipeline execution. GroupThink cannot infer an owner's intent and research
  cannot supply an agent id, so this was ruled, not hardened. **Surfaced to the workspace owner for
  confirmation in the post-package overview.**
- 2026-08-07 — **Second opinion adopted as scoping fact** (Codex `8e329bee`, read-only). It argued
  for zero intents; accepted for every part except execution design, which was marked over its
  objection on cost + conflict-of-interest grounds. Its tier-1 findings, which the plan must fix:
  `read_plan_projection`/`read_plan_section` are **retired** (`scripts/mcp-tools-plans.js:23`,`:100`;
  `src/main/api-server.ts:3655`; 404 test at `src/main/api-server-plans.test.ts:259`), so §2.9/§3.3
  are not executable as written; **A8 is inverted** — it scores the retired every-turn `PLAN-EVENT`
  sentinel, which live worker instructions are now tested to *omit*
  (`src/main/supervisor/scaffold-version-migration.test.ts:3649`), and `writeCounts`/`sec_exectr`
  belong to the same retired surface (`src/main/orchestration/groupthink-v2.ts:156`);
  `read_agent_chat`/`read_agent_log`/`read_agent_files_touched`/`list_checkpoints`/`diff_turn`/
  `get_orchestration_run` do exist; `OVERVIEW.md` is present in only 2 of 5 plan folders.
- 2026-08-07 — **Conflict of interest recorded.** `plan.md` (and its calibration appendix) were
  authored by `ae889b24`, a participant in the run to be audited. Any auditor design must address
  this; it is the second half of intent `int_7b3ce2a4`.
- 2026-08-07 — **CASE STUDY CORRECTED by the workspace owner; my first identification was wrong.**
  I had named the 2026-08-06 two-plan run under `ae889b24`/`plan_e0001372`. The actual subject is
  agent **`229530a1-04f9-4781-9c8d-a92cae9b7e18`** ("new propsoal", claude supervisor, **still
  live** — idle, 27% context, 20 turns on its *current* session), which ran the pipeline **across
  multiple sessions** for **`plan_5b3ea7d1`** (planId `81fbc146-068d-401f-b667-aeb0bb04cbcf`, SKU
  `2026-08-06-save-card-streamlining-one-gesture-no-ceremony-5b3ea7d1`) from `prop_5b3ea7d1`
  (`.lares/proposals/2026-08-06-save-card-streamlining-restamped.md`); one `assigned` event
  `rev_3147cc7dd3d3191a`. Verified from that plan's `plan.json` and the live agent list, not from
  the owner's message alone. Consequences recorded as Amendment 3 in `plan.md`: **the calibration
  appendix describes a DIFFERENT run**, so it calibrates against the whole-surface population only
  and a calibration claim that does not reproduce inside the case-study trace is **expected, not a
  finding**; and `ae889b24`'s conflict is narrower than first recorded — it authored the rubric and
  an expectations list drawn from its own run, while the run under the microscope is someone else's.
- 2026-08-07 — **Participant interview AUTHORIZED by the workspace owner; audited plan must be
  FROZEN first.** §2.2's blanket ban on questioning participants is lifted (Amendment 4 in
  `plan.md`). Protocol: interviews only *after* collection and the lead's baseline hash; testimony
  is **tier 3**, labelled `[participant testimony]`, quoted with the verbatim question, never the
  sole basis for a finding, never overriding tier 1; questions must be **inert** (never ask the
  agent to check, verify, refresh, re-derive or fix anything); every interview disclosed in the
  method section. **Freeze first:** `229530a1` is live, still responsible for the audited plan, and
  has an outstanding offer to run `orient` on it — which **rewrites `ARC.md` and its freshness
  metadata, the exact evidence dimension B4 measures**. No `orient`, no ARC refresh, no
  `record_planning_event` on `plan_5b3ea7d1` until the baseline is hashed. This is now the first
  step of WP-4.
- 2026-08-07 — **Baseline tag created:**
  `plan-baseline/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7` → `885edc25`
  ("feat(save-card): add save-all progress"). Local annotated tag, **never pushed**. Recovery
  framing: anything this plan deletes is one `git show <tag>:<path>` away, so no copy-aside
  archiving. **Advisory (non-blocking):** 60 uncommitted worktree entries are NOT captured by the
  tag, and HEAD is 299 commits ahead of `origin/master`, so this recovery point is local-disk only.
## Work packages
- `WP-1` Correct the rubric against the current tree — **ready** — unassigned
- `WP-2` Seal the calibration set — **ready** (dep WP-1) — unassigned
- `WP-3` Write the three dispatch briefs — **ready** (dep WP-1) — unassigned
- `WP-4` Run evidence collection — **blocked** (dep WP-1, WP-2, WP-3) — responsible supervisor `c30eb66f`
- `WP-5` Lead audit pass, calibration unseal, and final report — **blocked** (dep WP-4) — responsible supervisor `c30eb66f`

Source of truth: `supplements/2026-08-07-work-packages.md`. **Its prose `Files` lists are
authoritative; the `PLAN-WORK-PACKAGES:v1` block is an additive projection — never brief a worker
from the machine block.** `OVERVIEW.md` written and validated (6 tabs: overview, proposal, plan,
deliberations, supplements, packages; research omitted — directory holds only `.gitkeep`).
## Deliberations
- `int_7b3ce2a4` (groupthink-serial, run `085f680a`, codex Lead → agy Reviewer) — auditor execution
  design. **Rung: folded-in.** Output: `deliberations/2026-08-07-auditor-execution-design.md`
  (frontmatter validated: `plan_artifact_id: plan_65e665d7`, `intent_id: int_7b3ce2a4`, contained
  in-folder, present). Folded by resolving Markdown link + PLAN-INTEGRATION record in `plan.md`.
  `ran` is **unavailable** (pre-ledger) — the run id above is a self-declared cross-check, not the
  authoritative signal, and is not being presented as one.
  **What it changed:** replaced the proposal's single-multi-hour-auditor shape with a bounded
  3-agent design (2 evidence collectors + 1 lead owning the scorecard and Parts C1/C4 first-hand);
  added a packet schema, hard token/turn ceilings (~180k retrieved total) and a deterministic
  disclosable sampling rule; added a sealed-calibration protocol hashing an independent baseline
  before unsealing; added an auditor-eligibility check; specified read-only enforcement; rewrote
  §§2.9/3.3 off the retired plan-read tools; replaced the inverted A8; and added an N/O rule so a
  clean run can score 4. This is a substantive change of plan, not a restatement — it is the
  evidence that this intent was worth its cost.
- 2026-08-07 — **Two supervisor amendments applied at integration** (recorded in full in `plan.md`
  under "Supervisor amendments"): (1) auditor independence is **agent-level, not provider-level** —
  the blanket Claude ban is dropped because the researcher lane is the only mechanically restricted
  read-only lane and it is Claude-only (`src/main/persona-scanner.ts:245`,
  `src/main/supervisor/index.ts:5635`); the disqualification list itself stands, and it disqualifies
  both `ae889b24` and me (`c30eb66f`). (2) The deliberation's read-only enforcement **layer 3**
  (repo snapshot, read-only API proxy, withheld bearer token) **does not exist in this app** and is
  out of scope; layers 1/2/4 ship, and the report must disclose the residual gap rather than imply
  a sandbox.
## Who did what
- `c30eb66f` (Planning surface Performance Review, claude) — responsible supervisor; ran scope,
  promote, deliberate, integrate and package on 2026-08-07. **Disqualified from auditing.**
- `8e329bee` (Scope second opinion — audit rubric, codex) — independent scoping second opinion;
  stopped after returning. Not otherwise involved in the audited run.
- Orchestration `085f680a` (groupthink serial, codex Lead → agy Reviewer) — produced the auditor
  execution design.
- `ae889b24` (Planning supervisor - planning surface fix, claude) — **not** a contributor to this
  plan; named here because it authored the source proposal and its calibration set and is a
  participant in the run to be audited. **Disqualified from auditing.**

## Audit run log
- **2026-08-08 ~11:59 PDT — SPECIMEN FROZEN.** `c30eb66f` sent a freeze notice to `229530a1`
  (the audited agent, live, idle at 28% context / 22 turns). It acknowledged in full at
  ~12:00 PDT: outstanding `orient` offer **withdrawn**; no edits to
  `ARC.md`/`OVERVIEW.md`/`plan.md`/`plan.json` of `plan_5b3ea7d1`; no `record_planning_event`,
  `focus_plan` or `unfocus_plan` against it; no folder-rewriting scripts; reads only. It also
  accepted a later, clearly-labelled auditor interview. **The freeze stands until the WP-5 lead
  baseline is hashed, at which point `c30eb66f` sends an explicit UNFREEZE.** This satisfies the
  first WP-4 acceptance condition ahead of dispatch.
- **Freeze verified against disk, not testimony.** Audited-folder mtimes are byte-identical
  before and after the freeze turn: `ARC.md` 18922 B @ `2026-08-06 18:52:44.300989900 -0700`,
  `OVERVIEW.md` @ `15:51:30`, `plan.md` @ `15:34:09`, `plan.json` @ `15:20:27`,
  `supplements/2026-08-06-work-packages.md` @ `15:51:03`. No mutation.
- **False-positive worth carrying into the audit (C4 / B6 candidate).** The `idle` dashboard event
  for that freeze turn rendered a "Files touched" block listing ~20 writes to the audited folder's
  `ARC.md`, `OVERVIEW.md` and `supplements/2026-08-06-work-packages.md`. Those are **cumulative
  per-agent/session file activities dating from 2026-08-06**, when `229530a1` legitimately authored
  its own plan — not writes made during the acknowledged turn. Presented under a per-turn event
  header with no scoping label, an always-on activity list reads as a live freeze violation. The
  auditors must not score it as one, and the surface-side rubric should treat the mislabelling
  itself as a finding.
- **2026-08-08 ~12:00 PDT — WP-1 dispatched.** Codex worker `e04531c9-e615-4362-80f4-13fdd0268243`
  ("WP-1 correct audit rubric", fresh session), write target `plan.md` only, ordered to re-derive
  every scoping claim rather than trust the brief, and barred from `ARC.md`/`plan.json`/
  `deliberations/`, from committing, and from the frozen audited folder. HANDSHAKE OK.
  WP-2 and WP-3 remain queued behind it.
