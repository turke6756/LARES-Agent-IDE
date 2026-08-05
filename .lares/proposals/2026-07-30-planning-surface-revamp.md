---
artifact_id: prop_8e2f5a93
title: Planning-surface revamp — proposals, promotion, and the intent-to-evidence join
author_role: supervisor
authored_at: 2026-07-30T20:30:00Z
---

# Planning-surface revamp

**Status:** proposal — consolidates the full plan-surface revival deliberation
(2026-07-30) into one artifact. Sources, which remain the detail record:

- `.lares/proposals/supporting/2026-07-30-plan-surface-revival-design-detail.md`
  — design synthesis + Revision 2 (Edward's clarified intent, R2.1–R2.8).
  Parallel GroupThink run 0dddc0b7.
- `.lares/proposals/supporting/2026-07-30-plan-surface-revival-technical-strategy.md`
  — executable technical strategy at file/schema/IPC granularity. Serial
  GroupThink run c50b5f71.
- `.lares/research/inbox/plan-surface-inspiration/2026-07-30-plan-surface-inspiration.md`
  — external research (untrusted tier).
- `.lares/proposals/supporting/plan-surface-revival-context-2026-07-30.md` and
  `.lares/proposals/supporting/plan-surface-round2-brief-2026-07-30.md`
  — deliberation context briefs fed to the GroupThink rounds (minor record).

All supporting deliberation material lives under `.lares/proposals/supporting/`
(moved 2026-07-30 from the gitignored repo-root `plans/` and from
`.lares/supervisor/`), so the whole record is durable and trackable together.

## Decision

**Revive the planning surface. Do not revive its current HTML-document
architecture.** The load-bearing model in one line: **explicit intent at the
plan/work-package level, automatic evidence at the checkpoint-turn level, and no
inference that activity equals completion.**

## Why (what the evaluation actually found)

1. **The surface's failure was friction, not trust.** It already distrusts
   self-report (5-rung attribution resolver, witnessed touch tracking, quarantined
   PLAN-EVENT claims — ~10k lines). It failed on adoption: only **two plan files
   were ever created, one a demo**, because creation was MCP-only with no UI front
   door, every plan charged a six-zone ceremony at idea time, workers had to learn
   HTML-fragment discipline and emit a sentinel every turn, and a one-writer 409
   lock fought the shared-cwd invariant.
2. **The plan surface and the git-checkpoint engine are fully disjoint** — zero
   cross-imports, no SQL join, different turn-ID namespaces. The checkpoint engine
   now does with real git objects what the plan layer reimplemented bespokely.
   The bespoke provenance can die; the join is the missing piece.
3. **There is no structured-commit UI today** (contrary to prior belief — what
   exists is restore/undo/attribution only). Structured commit composition is
   net-new and belongs at the END of the sequence.

## The vision (Edward's north star, R2.6/R2.7)

The surface is the **lifecycle container for the house workflow**:

> idea → proposal markdown → hardening (groupthinks + research) → implementation
> plan → work packages sized to one worker's context → execution by many agents →
> historical audit artifact.

- **Proposals are the universal cheap entry point** — plain markdowns in
  `.lares/proposals/`, valid as a terminal state. No ceremony. (This file is one.)
- **A proposals gallery UI** (list + reading pane) lets the human browse and
  decide what graduates.
- **Promotion is the single formal gate**: a supervisor takes responsibility, the
  planning skill runs hardening → implementation plan → work-package scoping.
- **Execution is visible on the surface**, derived from checkpoint evidence:
  which package is checked off, who did what, what was found.
- **Finished plans retire into history** — later you can ask "did any plan
  produce this?" and get the what *and* the why.
- **The supervisor drives the app** (R2.7): it recognizes proposal-shaped
  discussion, offers the next practice at the right moment, and routes to the
  app's tools so the user never has to know the sequence.

## How — staged sequence (each stage gated on the previous earning its keep)

**Stage 0A — no app code, ship immediately.** A `proposal-to-plan` supervisor
skill + instruction edits encoding the driving role: write proposals to
`.lares/proposals/` with portable `artifact_id` frontmatter; run hardening
groupthinks with `plan_id`+`section_anchor` so results land IN the surface, not
as stray markdowns; promotion is the manual `create_plan` path for now. This is
the demand probe.

**Stage 0B — scaffold deploy.** The skill + supervisor/worker instruction edits
ship via `src/shared/constants.ts` version bumps (SUPERVISOR_AGENT_MD,
WORKER_CLAUDE_MD, two skill roots) with the frozen-hash migration discipline.

**Stage 1 — join + registry + gallery + promotion** (~1 week, reversible;
sub-stages S1.0/S1.A–S1.F in the technical strategy):

- **The whole integration seam:** stamp `plan_id` + `plan_item_id` onto
  `turn_records` at dispatch (caller-supplied, server-validated, copied at turn
  open, never inferred later from cwd/edits/messages). Derive the Execution
  Trail from accepted `turn_records` — witnessed touches, diff stats, links into
  the existing diff/restore flows. Progress is association evidence, never
  completion; `done` is always an explicit human/supervisor transition.
- **Durable artifact spaces:** `.lares/proposals/` (md) + `.lares/plans/` (html),
  both git-tracked; tracked files carry a portable `artifact_id`, never the local
  DB UUID (clones adopt without dirtying). A dedicated `proposals` table + split
  watcher; witnessed-first author attribution (no witnessed write ⇒ `unknown`).
- **Promotion service:** transactional, idempotent, compensated; mints a linked
  `hardening` plan with a singular `responsible_supervisor_id` +
  `supervisor_active_plan` (deterministic dispatch default — workers a
  responsible supervisor dispatches inherit the plan automatically).
- **Gallery pane:** unified proposals+plans projection over new IPC channels;
  date-grouped rows, author chips, Promote button with supervisor picker.
- **Ceremony deletion:** PLAN-EVENT sentinel requirement, one-writer 409 lock,
  read-before-edit progress discipline — all removed. Agents report nothing; the
  engine witnesses.

**Stage-1 dogfood gate:** ≥5 real multi-agent tasks over one week, **≥3 plans
created voluntarily**, plan-from-UI in <30s, supervisor answers
status/blocker/diff/restore in <30s, resumed agent orients from one bounded
read. **If voluntary use does not occur, stop:** keep the cheap proposals
gallery (it earns its keep alone), fold the trail into AttributionPanel, retire
the heavy surface.

**Stage 2 — gated on voluntary use.** Structured renderer-native mission board
modeling `proposal → hardening → executing → archived` (resurrectable); work
packages first-class (title, acceptance condition, state, assignee); a small
agent contract (`get_plan_context`, `set_plan_item_state`, `add_plan_note`)
replaces all HTML-section tooling; legacy HTML imported then retired; the
bespoke provenance machinery (5-rung resolver, `plan_snapshots` VCS, section
hashing/caching/sanitizing) deleted — snapshots only once plan state is
structured DB rows with their own audit ledger.

**Stage 3 — commit composer.** User-always-commits contract: group per work
package (plan = the commit series), start from witnessed paths, show contention
and unattributed changes, stage + draft message, human clicks commit. **Shared
engine with the Save-card proposal** (`prop_4c8d21b7`,
`.lares/proposals/2026-07-30-save-card-commit-ui.md`) — build one composer; the
Save card is its fleet-level UI, the plan surface its per-plan UI.

## What dies

Stage 1 neutralizes: the one-writer lock, the every-turn sentinel, claim-first
sidebar ordering, six-mandatory-zones. Stage 2 deletes: the HTML authoring
pipeline (watcher/section-cache/touch-tracker/read-ladder/sanitizer/render-pane),
the 5-rung attribution resolver, the SQLite snapshot VCS. Never inferred at any
stage: completion from file activity; plan association from cwd, plan-file
edits, final messages, or provider hook keys.

## Risks the sequence already handles

Over-building on a zero-adoption surface (Stage 1 is small + reversible; Stage 2
gated on voluntary use) · items becoming the new ceremony (packages optional; a
flat mission stays valid) · losing plan-document history (snapshots retained
until the audit ledger exists) · scaffold drift (all instruction changes ship
via version-bumped constants, never local edits) · shared-cwd attribution (all
binding is per-dispatch/per-turn, never "the one agent in this folder").

## Amendments — 2026-07-30 cross-evaluation + Edward's rulings

Source: `.lares/proposals/supporting/2026-07-30-two-proposal-cross-evaluation-groupthink.md`
(parallel GroupThink run 98b56a3e) plus engine-owner (Git Native Work, 5d94254d)
and Plans-supervisor consultations, plus Edward's selection-comment rulings.
These amendments are AUTHORITATIVE over the body above where they conflict.

1. **Two-layer surface (Edward's ruling on Decision B).** The surface has two
   joined components, both first-class:
   - **Document home** — ALL of a plan's artifacts (proposal md, groupthink
     outputs, research findings) render together in ONE place. Edward's core
     pain is hunting scattered markdowns; documents are never demoted.
   - **Breadcrumbs/state** — statuses, work packages, who-did-what live as
     structured DB rows fed by checkpoint evidence.
   What dies is only the generated six-zone HTML template as the *state
   container* (checkboxes/status inside an HTML file). Promotion mints
   structured DB rows + links the source documents; it does NOT mint a new
   HTML plan file (supersedes the technical strategy's promote-proposal.ts
   HTML-minting flow, §D).
1b. **Document pane is tabbed, not one giant scroll (Edward's ruling).** The
   document home renders via a clever template with **tabs** (e.g. Overview /
   Proposal / Deliberation / Research / Packages) and **plain-language
   overviews** — a human-friendly summary per tab that says in simple terms
   what is going on, with the full documents beneath/behind it. Never a single
   endless scroll.
1b-ii. **Plans stay conversational after hardening (Edward's ruling).** A
   hardened plan is not frozen: the user can still **ask questions and leave
   comments on it** at any stage (pre-trigger, mid-execution, archived). The
   surface should surface those comments to the responsible supervisor (the
   app's existing document-comments store is the natural backbone), and
   answers/clarifications land back on the plan page — the plan is a living
   document with a dialogue around it, not a locked artifact.
1c. **Implementation is a trigger pull (Edward's ruling).** Promotion and
   hardening do NOT imply execution. A hardened plan with work packages can sit
   indefinitely in a ready state; **dispatching workers is gated behind an
   explicit human "implement" action**. No agent is launched onto a plan until
   that trigger is pulled.
2. **Live visual mission board (Edward's requirement).** Not a static status
   table: work-package cards light up while their agent works, witnessed file
   touches tick in in real time, each file click-through opens the diff, done
   checkmarks are explicit human/supervisor transitions, contention/drift
   warnings render on the card, and the commit-package action (see Save-card
   proposal) appears on done cards.
3. **Stamp lifecycle coverage (both consultants' top risk).** plan_id /
   plan_item_id stamping must explicitly decide carry/no-carry for EVERY
   dispatch path — direct sends, orchestration lanes, forks, revivals,
   continuation handoffs — and the trail must annotate "unstamped/unverified
   turns exist for this agent" rather than silently looking complete.
   Concentrate test effort on continuation/revival re-dispatches.
4. **Trail reads distilled evidence.** Retention thins raw refs after the dense
   window; the Execution Trail must read the distilled diff_stats/compact_diff
   (which survive pruning) — that is what makes the historical-audit claim true
   beyond 10 days. Restores/reverts (recovery_operations) appear as trail
   events.
5. **Aggregate plan-review candidate becomes the primary review object** (per
   plan: HEAD/worktree vs pinned baseline over plan-witnessed paths, annotated
   with mixed-authorship + capture gaps); the per-turn trail is drill-down.
   Pre-dispatch contention advisories ("you're briefing two workers onto the
   same hot file") ship with it. Evidence never implies completion.
6. **Shared bundle contract.** "Work package = candidate commit = save bundle"
   is one data model with two lenses (fleet Save card / per-plan surface). Pin
   that contract before any composer work so two divergent bundle assemblers
   cannot get built.
7. **Ceremony subtraction is split.** PLAN-EVENT sentinel + read-before-edit die
   now; `assertPlanRailFree` stays scoped to legacy HTML ops until the HTML
   writer is retired (removing the lock before the writer trades visible 409s
   for silent lost updates).
8. **Demand probe split.** Three metrics over several weeks — proposal capture,
   voluntary browsing, promotion demand — with the heavy build gated on
   promotion demand specifically; one quiet week does not kill the feature
   (Edward may grant one explicit extension).
9. **Honest loss, accepted:** Stage-2 agent writes narrow to notes/state
   changes; narrative deliberation stays in the document layer (proposals,
   groupthink markdowns), which the surface renders in place.

## Amendments II — 2026-08-02 Edward's rulings (folder-native plans + planning intent ledger)

Source: Edward's selection comment on the plan-surface mockup review
(2026-08-02, agent chat "Two Proposal Review"). Authoritative over the body
AND over Amendments 1–9 where they conflict. These refine — they do not
overturn — the markdown-documents + structured-state model of Amendment 1.

10. **Folder-per-plan, filesystem-first.** A plan IS a folder (with an
   identifier/SKU-style name) under the plans home in `.lares/`. A bare
   proposal is just a markdown with no additional structure; **promotion runs
   the planning skill, whose first mechanical act is scaffolding that plan's
   folder schema** — designated places for deliberations, research, and
   supplementary documents. The planning surface is the **UI reflection of
   that inherent folder organization** (the app already renders markdown);
   the DB registry/watcher *ingests* the folder structure, it does not own
   it. Agents can subscribe to a plan (attach to its folder/context).
11. **Deliberations are scoped, and folded by reference.** A groupthink or
   research run may target one complicated part of a plan, not the whole.
   Its output is its own markdown in the plan folder, **referenced from the
   relevant phase of the main plan document — never pasted in**. Reaching
   phase X during execution means following its references to the documents
   that specify it.
12. **Integration is a tracked step, never presumed.** "The workflow
   completed, so presumably the deliberation was considered" is not good
   enough — planning is disjoint in time (deliberations can be ordered
   mid-plan, land later). The responsible supervisor must *consider* each
   completed deliberation and integrate it into the plan (at minimum the
   reference; possibly restructuring), and the surface must show per
   deliberation: done or not, results, what it changed, folded-in or still
   pending. An unfolded deliberation renders as open — never silently
   complete.
13. **The planning skill opens with a markup/intent pass, and intent is a
   ledger.** Phase one of proposal→plan: the sanctioned planning agent marks
   up the proposal — which parts deserve deeper deliberation, what kind
   (serial vs parallel groupthink, research), and which providers/models to
   use (today codex + anthropic; later, model-fit choices, cross-model
   deliberations). That intent is **etched durably where the UI can read
   it**, so the surface answers: what was planned? did it happen? what came
   back? what did it change? This is the same intent→evidence discipline as
   execution (Amendment 3), applied to planning itself: the UI shows a
   running groupthink as "in service of *this* marked part of the plan."
14. **Confidence and compute readout.** The surface keeps the user oriented
   on how fleshed-out a plan is: which marked intents are satisfied, how
   much deliberation/compute was spent, whether a final plan exists.
   Confidence is *derived* from the intent ledger + integration status,
   never self-asserted.
15. **Execution view shows the whole plan.** A finalized plan is fully known
   before implementation, so the surface shows ALL phases and work packages
   up front — who is responsible, per-package working/done state — with done
   packages linking to the Save-package composer. Commits typically come
   after testing, so **done-but-uncommitted is a normal, long-lived state**,
   not an anomaly. (Consistent with Amendment 2 and Save-card Amendment 1.)

16. **Lifecycle state is answered by inspection, never asserted.** The
   questions the surface must answer form a derivable chain, each resolved by
   looking at the folder and the plan document — not by anyone's claim:
   *Was this part marked for deliberation?* (intent ledger) → *Did the
   deliberation happen?* (its output markdown exists in the plan folder's
   designated place) → *Was it incorporated?* (the plan document references
   it — a reference is the incorporation signal; no reference = still open)
   → *Was the plan scoped into work packages?* (packages exist) → *Did
   execution start?* (execution evidence exists). Every rung is checkable by
   an agent or the UI from artifacts on disk plus the ledger.
17. **The lifecycle is interruptible, resumable, and amendable — never
   strict.** The skill *starts* the process; it does not own it end-to-end.
   Planning can be interrupted and continued later. A finished plan can take
   further feedback and refinement. If a part is decided not to work, that
   part is closed, a new deliberation may be groupthought, and the plan
   amended with a new stage. The lifecycle model must accommodate re-entry
   at any rung of the Amendment-16 chain, not assume one linear pass.
18. **The record serves agents at multiple altitudes.** Work and breadcrumbs
   are recorded for users AND agents. An agent reviewing a planning surface
   must be able to grasp the entire arc cheaply (few tokens): here is the
   proposal → this is what was decided → here are the work packages → and,
   only when it wants the final detail, what was actually done via files
   touched and commit activity. Reviewing diffs is the deepest tier, never
   the entry point. This altitude ladder is a design requirement of the
   surface's read API, mirroring the outline/text/raw ladder of the old plan
   reader.
19. **Durable evidence + durable attribution — checkpoints are not the
   archive.** Checkpoints only live so long; reviewing old, completed
   planning surfaces must NOT rely on them. The durable record is commit
   activity, the intent ledger, and per-plan attribution rows: which agents
   did what, and which supervisor was subscribed/responsible, recorded
   durably at the time of the work. (Refines the P7 evidence surfaces and
   the P8 archive: both must read from durable stores, with checkpoints as
   an optional recent-history enrichment only.)

20. **Reference is the folded-in signal; the note says what changed.**
   (Reconciles 16 with 12.) A deliberation counts as incorporated when the
   plan document references it — cheap, mechanically inspectable. The ledger
   row may additionally carry the responsible supervisor's one-line
   integration note describing what the deliberation changed. Critical
   deliberations get the note; routine ones get by on the reference alone.
21. **The durable arc lives in the plan folder.** Each plan folder carries a
   maintained arc/summary file — decisions, work packages, who did what —
   committed with the plan, so an agent reads the entire history from disk
   with zero DB access, even years later. The DB ledger *enriches* the arc
   (live status, cross-plan queries); it never owns it. This file is the
   cheapest tier of the Amendment-18 altitude ladder.
22. **Attribution is etched when the work happens.** "Which agents did what,
   which supervisor was responsible" is captured at work time — dispatch
   stamps and commit trailers — never reconstructed later from checkpoints
   (which expire, per 19). This pulls attribution scope earlier in the
   implementation plan than currently staged.

23. **A plan is owned by one supervisor, and the skill orients on pickup.**
   A plan has a single responsible supervisor; that supervisor *uses* the
   planning skill, the skill does not own the plan. Any supervisor
   approaching an unfinished plan picks it up through the skill, and the
   skill's opening move on an existing plan folder is an **orientation/
   evaluation pass**: what has been done for this plan already (which
   intents satisfied, which deliberations landed, which rung of the
   Amendment-16 chain it sits at), before doing anything new. (Extends 17's
   re-entry model with a concrete mechanism.)

24. **The skill spans the whole journey and embodies best practices — with a
   scoping step that takes a worker's opinion.** The planning skill carries a
   proposal all the way to an implementation plan with work packages ready
   for implementation: capture → **scoping** → markup/intent → deliberations
   launched on marked aspects → folding-in → hardened plan → work-package
   decomposition. It is the house method written down — best practices, not
   just mechanics. **Scoping is done by the supervisor WITH the opinion of a
   worker agent** — a worker-lane perspective on implementability/size joins
   the supervisor's judgment before intents are marked. The surface's job is
   keeping everything this journey produces organized. (The skill carries us
   far; whether parts of its mechanical spine later become a
   workflow/orchestration — per the P3 promotion-service design — is a
   post-gate decision, not a change to this ruling.)
25. **The skill and the surface talk through structure.** The skill does its
   work in a structured way — the folder schema, `plan.json`, sentinels,
   `ARC.md` (§R0/§R1/§R2 of the P0–P2 rescope) — **and may ship helper
   scripts that set that structure up** — precisely so the UI can depend on
   it. Those structured artifact formats ARE the skill↔surface contract:
   the skill writes them, the surface renders/ingests them, and neither
   side invents a private channel around them.

**Consequence for the implementation plan:** stages P0–P2 of
`2026-07-30-planning-surface-implementation-plan.md` predate these rulings.
Before the planning-surface go, P0 (skill) must be re-scoped to include folder
scaffolding + the markup/intent pass, P1's registry to ingest folder-per-plan
structure, and the intent ledger added as new scope (likely a new early
stage). Amendments 16–19 additionally touch the later stages: P7's evidence
surfaces and P8's archive must read from durable stores (commits, ledger,
attribution rows), not checkpoints, and the read API needs the Amendment-18
altitude ladder. The mockup pair (board + document reading) at Claude
artifact 41001407 reflects Amendments 10–15 in spirit; treat prose here as
authoritative over pixels.

## Amendments III — 2026-08-02 Edward's rulings (plain-language-guide review)

Source: Edward's selection comments on
`.lares/proposals/supporting/2026-08-02-planning-surface-plain-language-guide.md`
and his rulings on the supervisor's read-back (agent chat, 2026-08-02).
Authoritative over the body and earlier amendments where they conflict.

26. **Planning surface and Save card are SEPARATE surfaces for now.** Save-card
   commit bundles are not always pure to one plan/supervisor (a bundle can
   contain files other agents touched), so the plan→bundle mapping is not
   reliably 1-to-1. Ruling: let them be two separate things — the user goes to
   the Save card separately, and it processes/bundles according to its own
   logic; committing is a separate step from the planning surface. Consequence:
   the mission board's **commit checkbox is DEFERRED** (not built in the initial
   P6), Amendment 15's "done packages link to the Save-package composer" is
   deferred with it, and the "work package = commit bundle" identity of the
   shared bundle contract becomes an *alignment goal*, not a build dependency —
   the two surfaces may be re-joined by a later explicit ruling once both
   exist. Done-but-uncommitted remains a normal state; package completion
   evidence (finalization freeze) is unaffected by this decoupling.
27. **Scope = hardening triage, not decomposition.** (Refines ruling 24.)
   Scoping is NOT cutting work into worker-sized packages. Scope is the first
   hardening step: the responsible supervisor — ideally with an **independent
   second opinion** (e.g. a Codex-lane agent, or even a small groupthink as the
   scoping vehicle) — reads the proposal and decides *what deserves extra
   effort*: which parts need groupthink deliberation, which would benefit from
   online research. The scoping agents must understand the hardening process
   itself. Scope's output is the **marked-up proposal** (it feeds/performs the
   markup pass). A trivial proposal may legitimately be judged "nothing needs
   hardening — package and implement"; that is always an option. Worker-sized
   packaging is the LAST step of the journey (after a defensible implementation
   plan exists), not part of scope.
28. **Marking happens on the proposal, before `plan.md` exists.** The markup is
   the supervisor's strategy for getting the proposal to a plan, applied to the
   proposal document itself; the marked-up proposal migrates into `plan.md` on
   hardening (consistent with §R1 of the P0–P2 rescope).
29. **Actors are explicit, and ARC.md is supervisor-owned.** Mark, integrate,
   and package are the **responsible supervisor's** activities. `ARC.md` is
   written and maintained by the responsible supervisor. This ownership must be
   stated explicitly in the supervisor's scaffolded CLAUDE.md/AGENTS.md and in
   the skill itself — never merely implied.
30. **Orient-first is a scaffold-level rule.** The supervisor scaffold must
   instruct: if you are subscribed to a plan and picking it up, `plan.json` +
   `ARC.md` + the intent markers are the FIRST place you look, before doing
   anything new. (Makes ruling 23's skill behavior a standing orientation rule
   the app itself teaches.)
31. **Implement-readiness must be visible.** A plan deemed ready for
   implementation must show a **visible UI readiness element** (state badge on
   the gallery card and in the reader) — the Implement trigger is gated on, and
   justified by, that visible ready state (P5 lifecycle).

32. **Journey shape RULED (2026-08-02): the hybrid.** Edward ordered a
   GroupThink on skill-vs-workflow (run 2850dad1) and approved its
   recommendation (`supporting/2026-08-02-skill-vs-workflow-recommendation.md`,
   NORMATIVE for the skill's internal structure): **one** `proposal-to-plan`
   skill root — thin dispatcher, seven public modes (capture / scope / promote /
   deliberate / integrate / package / orient), per-activity playbook files,
   single-copy contract references, one `plan-manifest.mjs` helper — reusing the
   existing groupthink/researcher lanes for deliberations. No new orchestration,
   no journey driver process; activity playbooks are extraction-ready if the
   post-Gate-K evidence justifies a real workflow later (ruling 24's
   parenthetical). Marking is owned inside `scope`; the trivial-scope verdict is
   a required `## Hardening scope` prose section. **Rider:** scoping treats BOTH
   hardening kinds — groupthink deliberation AND online research — as live
   options for every part, and a small groupthink is a legitimate vehicle for
   the scoping step itself.

## Hardening deliverables (2026-07-30, post-amendment)

The amendments above have been hardened into executable artifacts. Where they
conflict with this proposal's body, the deliverables below are authoritative:

- `.lares/proposals/supporting/2026-07-30-shared-bundle-contract.md` — NORMATIVE
  contract v1 for "work package = candidate commit = save bundle" (Amendment 6):
  types, DDL, token, stamping rules, `package_finalizations` freeze, test list.
  Serial GroupThink run 50bfdec9.
- `.lares/proposals/supporting/2026-07-30-planning-surface-implementation-plan.md`
  — this proposal's implementation plan: stages P0–P8 with the
  promotion-demand gate after P1, WPs sized to one worker's context. Serial
  GroupThink run 51fc6796.
- `.lares/proposals/supporting/2026-07-30-save-card-implementation-plan.md` —
  the sibling Save-card plan (WPs `SC-WP-*`) this plan depends on by name;
  DDL work across both plans is serialized (barrier A2), and stages P5–P7 gate
  on Save-card Stage ③, P6D/P7A on Stage ④. Serial GroupThink run 6d5bb4b0.
  *(Amendment 26 defers the P6 commit-checkbox integration — the Stage-④
  dependency applies only if/when the surfaces are re-joined; the Stage-③
  finalization-evidence gate for P5–P7 stands.)*

## Ask

Decisions A and B are RESOLVED (see Amendments; Decision A is recorded in the
Save-card proposal). Remaining ask is execution sequencing only: Stage 0
(proposal-capture skill + safe ceremony subtraction, no app code) and the
read-only Save card are unblocked and ready to start on Edward's go.
