---
artifact_id: prop_ce97b9ad
title: Planning surface mechanics remediation — close the gaps the audit found
author: "Planning surface Performance Review" (supervisor, AgentDashboard)
author_agent_id: c30eb66f-fc78-4c86-8974-bf5f8be12196
author_role: supervisor
author_provider: claude
authored_at: 2026-08-08T16:34:05-07:00
promoted_to: 2026-08-08-planning-surface-mechanics-remediation-close-the-ce97b9ad
promoted_at: 2026-08-08T18:15:00-07:00
---

# Planning surface mechanics remediation

Source evidence: `.lares/research/inbox/planning-surface-audit-report.md`
(sha256 `3338c5a79828f864c6eac1d316c357b661f3fcf55feb50142f1ab728f4f9a4d0`),
the delivered output of audit plan `plan_65e665d7`. Every claim below traces to a
finding ID (F1–F10) in that report. This proposal does not re-argue the findings;
it converts them into buildable work.

## In plain terms

We recently audited how this workspace plans and executes work, using one real
project as the test case. The thinking held up well: the design debate genuinely
improved the product, and the review steps caught several real mistakes before
they shipped. Two things did not hold up.

First, a piece of work can be marked finished, pass all its tests, and still be
completely unreachable by the actual application. That happened. Nobody noticed
until a later task tripped over it. The tests were real and they all passed —
they just tested the part in isolation, never checking that the app could
actually get to it.

Second, the system does not keep a reliable record of its own successes. A person
can reconstruct what happened by cross-referencing about six different places, but
the software cannot. It still lists finished work as blocked, and it loses the
links between a decision, the work it caused, and the code that resulted.

On top of that, two of the displays we rely on to check work are misleading. One
shows a running history of every file an agent ever touched but labels it as if it
were just this turn's activity — which nearly caused a false accusation during the
audit itself. The other shows how current a plan's summary is, and it was wrong on
four of five plans.

This proposal fixes those in a deliberate order: repair the misleading displays
first, because we use them to verify everything else; then close the
finished-but-unreachable hole; then rebuild the record-keeping. What changes for
the user is that "done" starts meaning reachable-and-working, the system can show
you its own history without a forensic exercise, and the readouts stop lying.

## Why now

The audit is closed and its instrument is preserved, so these findings are
reproducible rather than anecdotal. Two of the defects were independently
rediscovered by a second agent working from different evidence (the
finished-but-unreachable hole, twice in the same subsystem). One defect fired
live, three separate times, during the audit that was measuring it. These are
recurring mechanics, not one-off mistakes.

## Non-goals

- **Do not trim deliberation or gating.** F10 is a *protective* finding: the
  two-agent deliberation replaced a naive bidirectional equality check with a
  proof-bearing monotonic discharge predicate, and the gates caught bad
  attribution, false skip claims, missing documentation, and eventually the dead
  bridge. If cost pressure arrives, cut elsewhere. Any package here that makes
  deliberation or gating cheaper by making it weaker is out of scope.
- No migration of the 303 legacy root `plans/` documents. Out of scope.
- No change to the frozen specimen `plan_5b3ea7d1`.
- No push or deploy. That is a separate human-gated action (see Dependencies).

## Proposed work, in execution order

The ordering is load-bearing. Cluster A repairs the instruments we would use to
verify Clusters B–D. Doing it last would mean verifying every other fix with
readouts already known to be wrong.

### Cluster A — Repair the misleading readouts (small, do first)

**A1 — Scope and label file activity correctly.** *(F3)*
`api-server.ts:1828-1831` defaults to all retained sessions.
`supervisor/index.ts:2187-2198` passes `getFileActivities(id)` into idle events
without `currentOnly`. `event-payload-builder.ts:157-169` labels the result
simply "Files touched." Result: 47 rows spanning three renewal generations render
as one turn's activity.
*Change:* either request current-turn activity, or render an explicit heading such
as "Files touched across retained sessions" carrying session ID, generation, and
time range. Ambiguity here is the defect; either resolution is acceptable, silence
is not.
*Acceptance:* an event/renderer test spanning renewal generations asserts the
rendered scope matches the label.
*Why first:* this produced a false freeze-violation accusation against a
cooperating agent during the audit, and fired twice more afterward.

**A2 — Make staleness computed and visible.** *(F4)*
Four of five readable plans had source mtimes newer than
`ARC-META.source_cutoffs.folder_mtime_ms` (`plan_e0001372` by ~54.75M ms,
`plan_65e665d7` by ~86.45M ms). `plan_0e1425af` stores `1786034858.657` against
millisecond source times — a seconds-vs-milliseconds unit defect. Contract helper:
`plan-manifest.mjs:445-489`.
*Change:* compute the cutoff at read time, show a stale badge when source mtimes
exceed it, add explicit unit handling, and stop presenting stale ARC prose as
current completion state.
*Acceptance:* a read-only freshness calculator run across all folders flags the
known-stale ones; a unit-scale regression test covers the seconds/ms case.

### Cluster B — Make production reachability provable *(F1, rank-1 silent failure)*

**B1 — Production entry point becomes a required package field.**
Every behavior package must name its real entry point: IPC registration, preload
binding, route, UI caller, job registration, or equivalent. Package schema plus
brief template.

**B2 — Every behavior package must test through that seam.**
A directly-constructed service test stops being sufficient evidence of completion.
The gate checklist must require entry through the declared production path.
*Acceptance (from the report's own refutation test):* revert one registration or
binding in a disposable branch and observe the production-path test fail. If it
still passes, the test does not enter through the seam.
*Evidence:* `e52ad5fb` added the service and its direct tests with no main IPC
registration and no preload binding; `b4617499` later added
`src/main/ipc-handlers.ts`, `src/main/index.ts`, `src/preload/index.ts`, and a
production registration test.

**B3 — Workers must report entry points and unperformed checks in final messages.**
Agent-instruction change; pairs with preserving the honest-limitation reporting
F10 credits.

**B4 — A registration-existence check is NOT sufficient. Mocks can simulate the
missing bridge.**
*Added after a second, independent first-hand pass by `229530a1`, the audited
agent, which found a second incident the audit never saw.* The audit observed only
WP-6, where the mechanical cause was that all 12 tests in
`save-sweep-service.test.ts` (512 lines) open `new SaveSweepService({…})` directly —
**direct construction can never fail from a missing registration**, which is why it
stayed green. `b4617499` fixed it by loading the real `registerIpcHandlers` against
a fake `ipcMain`, asserting `savecard:sweep` is registered, and only then invoking
the captured handler.

The **mint incident (2026-08-05)** is the harder case and it breaks the naive rule.
There the mocks did not merely fail to cover the bridge — they **simulated it**,
supplying a token that production itself would have had to create. The renderer
suite was therefore positive evidence *for* a flow that could not happen. Its own
root-cause doc states: *"no test drives the whole production chain through real
route registration… Unit suites validate each island while mocks conceal the dead
bridge."*

*Consequence for design:* a rule of the form "assert a registration exists" catches
WP-6 and misses mint. The check must additionally establish that **no test supplies
a token, handle, or client that production would have to construct itself.** Scoping
should treat B4 as a constraint on B1–B3, not an optional extra — building B1–B3
against the weaker rule would close one hole and leave the worse one open.

*Note:* a `prove-the-production-entry-point` skill now exists in this workspace,
published by `229530a1` and carrying both incidents first-hand. B1–B4 should
reference or extend it rather than duplicate its guidance — scoping should check
whether the remaining gap is the skill's content or the fact that **nothing
enforces it**. On present evidence the content is sound and the enforcement is
missing, which would shrink this cluster substantially.

<!--PLAN-INTENT
{ "intent_id": "int_b7d41c2e", "part": "cluster-b-production-reachability",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "B4 breaks the naive registration-existence rule and no enforcement mechanism for the mock-simulated-bridge case is specified; B1 is a package-schema commitment (same long-lived-commitment test as D1)" }
-->

### Cluster C — Document self-consistency and containment (small, independent)

**C1 — Validate prose counts against machine blocks.** *(F5)*
The audit supplement says WP-3 has "six" machine conditions where the parsed JSON
has eight, and says WP-5 has six where JSON has seven — in a document whose own
header declares prose authoritative while those lines delegate to the machine
block.
*Change:* generate the counts from the machine block or remove them; validate on
save/CI and fail loudly on divergence; preserve exactly one authority for file
scope and acceptance.
*Note for scoping:* the live instance in
`plan_65e665d7/supplements/2026-08-07-work-packages.md` was **deliberately left
unpatched as audit evidence**. It may be fixed once this package lands, but not
before, and the fix should be recorded rather than silent.

**C2 — Sandbox declared-outbox lanes provider-neutrally.** *(F8)*
The audit's read-only containment was an instruction, not a sandbox. The Codex
worker config carries status hooks and a git-discard guard only; the research
write guard is Claude-only and intercepts only tool name `Write`
(`research-write-guard.mjs:19-24,120-135`) while the lane exposed unrestricted
shell and apply-patch.
*Change:* enforce the role's declared outbox at the host/tool boundary across
providers.
*Why it matters:* an audit lane that can silently contaminate its own specimen
cannot make absence claims about it.

<!--PLAN-INTENT
{ "intent_id": "int_c2a90f13", "part": "c2-provider-neutral-outbox-sandbox",
  "kind": "research",
  "targets": [ { "provider": "anthropic", "model": "claude" } ],
  "reason": "\"enforce at the host/tool boundary across providers\" names a goal, not a mechanism; whether provider-native sandbox/OS-level restriction capabilities exist per provider is an external-documentation question, load-bearing for feasibility" }
-->

### Cluster D — The machine register (largest; deliberate before building)

**D1 — Server-witnessed package ledger.** *(F2)*
Record `plan_artifact_id`, `intent_id`, package ID/revision, dispatched
agent/session, gate outcome, commit OIDs, and deployment state as explicit joins.
Update package state through one supported transition API.
*Evidence of the gap:* orchestration `a1bacc4a` is complete with `plan_id`,
`planning_intent_id`, and `plan_item_id` all null; the audited supervisor and all
15 child agent records have null plan bindings; `plan_work_packages` still shows
WP6–WP8 blocked with null assignees after all 11 packages landed; 13 verified
commits have no machine row joining them to package gates.
*Acceptance:* render the plan from DB-only state and compare against the verified
commit chain.

**D2 — Enforce portable identity at ingestion, not only at promotion.** *(F2, F7)*
The promotion UI enforces `prop_[0-9a-f]{8}` (`promotion-dispatch.ts:7-9,64-69`),
but the existing population includes non-contract IDs (`prop_0ed…`,
`prop_pigt5a83`), 16 flat proposals parse as only 5 valid frontmatters, and
`plans.source_proposal_id` is null for both the case and audit plans.
*Change:* reject or visibly quarantine non-contract IDs at ingestion, backfill
`source_proposal_id`, require orchestration `planning_intent_id` at launch.

**D3 — Separate continuation delivery from checkpoint-turn completion.** *(F6)*
Turns 1774, 1808, 1836 all carry `after_ready=0` and
`failure_reason=overlapping-active-turn` (one open, two crashed) — yet every
predecessor saved its brick and every successor started ~23–24s later, re-oriented,
and continued successfully.
*Change:* give the handoff attempt its own durable result (`brick_saved`,
`successor_started`, `successor_oriented`); stop leaving the initiating turn
crashed/open merely because a successor overlaps; normalize witnessed paths before
storing (healthy turn 1773 recorded three whitespace variants of one path).
*Open first:* determine whether the turn failure is correct concurrency semantics
or a recorder bug. The records do not say, and the answer changes the fix.

<!--PLAN-INTENT
{ "intent_id": "int_d3f8266b", "part": "d3-continuation-vs-checkpoint-semantics",
  "kind": "research",
  "targets": [ { "provider": "anthropic", "model": "claude" } ],
  "reason": "semantics-vs-recorder-bug is a factual question answerable from the checkpoint-engine code and turn records; a deliberation held before that forensic read would speculate — its answer feeds the D1+D4 deliberation" }
-->

**D4 — Plan folders are only partially version-controlled, and the untracked part
is the machine-readable half.** *(F2-adjacent; raised by `229530a1`, verified
independently here.)*
In the case-study folder, five files are tracked (`ARC.md`, `OVERVIEW.md`,
`plan.md`, `supplements/2026-08-06-work-packages.md`, and one deliberation draft)
while **`plan.json` is untracked** — along with the active synthesis deliberation
`2026-08-06-carry-forward-equivalence.md`.

The `deliberations/` split is the sharpest illustration: the **tracked** file is the
superseded draft (`int_7c1e94af-claude-draft.md`), while the **active synthesis that
was actually folded into `plan.md`** (`2026-08-06-carry-forward-equivalence.md`) has
no version history at all. The folder's git record preserves the argument that lost
and drops the one that won — and the winning synthesis is the artifact carrying the
proof-bearing predicate that F10 credits as the deliberation's whole value.

That split is the wrong way round. `plan.json` carries plan identity,
responsibility events, and lifecycle state — it is the file a future agent uses to
determine who owns a plan and what happened to it, and it is the one with no
history. The human-readable prose is durable; the machine-readable record is not.
This compounds F2: the register is incomplete *and* the on-disk identity file it
would reconcile against has no version history to reconcile with.

*Change:* decide deliberately which plan-folder artifacts are version-controlled
and make the policy uniform and enforced, rather than leaving it to whatever a
scaffold happened to write. If `plan.json` is intentionally untracked (it holds
churn-heavy event appends), then its durability must come from the D1 ledger
instead — but that must be a decision on the record, not an accident.

*Scoping note:* this affects all plan folders, not just the case study; the
population should be surveyed before a policy is fixed.

<!--PLAN-INTENT
{ "intent_id": "int_d1d47a05", "part": "d1-d4-ledger-schema-and-plan-folder-versioning",
  "kind": "groupthink-parallel",
  "targets": [ { "provider": "anthropic", "model": "claude" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "D1's ledger schema is a long-lived commitment and D4's version-control policy is the same decision (untracked plan.json durability must come from the ledger if anywhere); deliberate jointly, informed by the D3 finding and a plan-folder population survey" }
-->

## Recommended deliberation

Cluster D is the only part I would deliberate before building. D1's schema is a
long-lived commitment and D3 has a genuine open question underneath it (semantics
vs. recorder bug) that changes the design. Clusters A, B, and C are well-specified
enough to package and dispatch directly.

## Dependencies and sequencing risk

- **Nothing is deployed.** At audit time the tree was 320 commits ahead of
  `origin/master` with no remote branch containing the 13 case-study commits, and
  the manual multi-package Electron acceptance pass was explicitly never performed
  (F9). Any acceptance criterion here that depends on observing live app behavior
  inherits that blocker and should say so rather than quietly assuming a restart.
- Cluster A should land before Clusters B–D are *verified*, not necessarily before
  they are built.
- C1's live instance stays unpatched until C1 itself lands.

## Known limitation of the evidence base

The audit scored 42/68 with the specimen plan folder sealed — direct reads of
`plan_5b3ea7d1` were prohibited, so the whole-surface rubric was applied without
the case study's own contents. The auditor disclosed this as a mandatory coverage
shortfall rather than working around it, and the audited agent independently
raised that the caveat should travel with the number. It travels here. Separately,
all 15 post-return supervisor gates were never captured by the collectors, so gate
coverage in the report is partial.

**The audit's incident coverage was also narrower than the real incident set.**
B4 exists because a second agent, working from evidence the audit could not reach,
found a second occurrence of the rank-1 failure — and that occurrence breaks the
fix the audit's own recommendation would have produced. Read that as a caution
about scope rather than a defect in the report: a sealed-specimen audit found the
pattern, and only a participant with folder access found the variant that
invalidates the naive remedy. Where this proposal's evidence beats the report's, it
says so above rather than deferring to the higher-ceremony source.

## Conflict of interest

I (`c30eb66f`, "Planning surface Performance Review") am disqualified from
auditing this surface, yet I commissioned the audit, authored the rubric-correction
brief and all three dispatch briefs, staged the checkpoint extract and renewal
transcripts, and originated one finding (F3) — which I first misread as a freeze
violation before disproving myself by mtime. The lead auditor was a fresh Codex
worker verified absent from the audited population; it re-derived F3 from source
and agreed on its own reading. This proposal is nonetheless written by the party
with the most incentive for the audit to look worthwhile. Scoping should weigh
that, particularly on Cluster D's size.

## Hardening scope
- **Verdict (dated):** 2026-08-08 — Clusters A, C1, and D2 need no hardening
  (fully pinned defects with acceptance criteria; package directly). Cluster B
  needs groupthink deliberation: B4 proves the naive registration-existence rule
  insufficient and no enforcement mechanism for the mock-simulated-bridge case is
  specified, and B1 is a package-schema commitment. C2 needs targeted online
  research on provider-native sandboxing/OS-level containment capabilities before
  a mechanism is chosen. D3's open question (concurrency semantics vs. recorder
  bug) is a forensic code/records investigation, marked as research — not a
  deliberation topic. D1+D4 are one joint groupthink deliberation (ledger schema
  and plan-folder version-control policy are one decision), informed by the D3
  finding and a plan-folder population survey. This narrows the author's blanket
  "deliberate all of Cluster D" and widens their "dispatch B directly" — both
  corrections cut against the author's disclosed conflict of interest.
- **Second opinion:** independent fresh-context Claude agent read (agent
  a040f19e98ae9bf3e, this session); it disagreed with the author on B (deliberate),
  C2 (research), D2 (skip), and D3 (investigate, don't deliberate) — all four
  adopted.
- **Marked intents:**
  - `int_b7d41c2e` — Cluster B (B1–B4) enforcement design, groupthink-serial.
  - `int_c2a90f13` — C2 provider-neutral outbox sandboxing, research.
  - `int_d3f8266b` — D3 semantics-vs-recorder-bug forensic investigation, research.
  - `int_d1d47a05` — D1+D4 ledger schema + plan-folder versioning policy,
    groupthink-parallel.
