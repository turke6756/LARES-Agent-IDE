# Planning-surface revival — design proposal (synthesis, 2026-07-30)

**Status:** design proposal, no code changes. Deliverable for Edward's deliberation.
**Authors:** two independent planners, synthesized. Grounded in code read 2026-07-30
(`src/main/plans/`, `src/main/git-checkpoints/`, `src/main/database.ts`,
`src/renderer/components/plan/`).

---

## Decision

**Revive the planning surface. Do not revive its current HTML-document architecture.**

Keep exactly one surface whose job is to join *intent* to *witnessed execution*:

> what outcome are we pursuing → what work remains → who is handling it →
> what actually changed → what should happen next

The load-bearing model, in one line: **explicit intent at the plan/item level,
automatic evidence at the checkpoint-turn level, and no inference that activity
equals completion.**

Get there in **two stages that separate two independent risks**:

1. **Prove the join cheaply** on the *existing* surface — does intent-grouped
   checkpoint history get used? (Small, ~1 week, reversible.)
2. **Replace the document with a structured mission board** — only if Stage 1 sees
   voluntary use.

The surface is worth keeping **only if creating a mission is easier than dispatching
the second agent**. If Stage 1 does not clear that bar in a week of dogfooding, fold
the work-item view into the checkpoint AttributionPanel and stop maintaining a
separate planning product.

---

## The six questions, answered

### Q1 — Why have a planning surface at all?

Because it is the **only Lares surface keyed to a *unit of work*** rather than an
actor or an artifact, and the **only one that holds *intent***. Every other surface
is keyed elsewhere: agent cards → an agent; checkpoint rail → an agent×turn; memory →
the workspace (durable, cross-task); research inbox → a query; git branch → a repo
state. None answers *"what are we currently trying to accomplish, what's decided,
what's still open, and what has actually landed toward it?"* — the thing a supervisor
reconstructs from chat scrollback every time a second agent joins a task.

Its irreducible value is the **inverse index**: work item → agents → turns → diffs →
recovery actions. The checkpoint rail presents execution in agent/turn order; the
human thinks in outcome/work-item order. The plan supplies that missing map from
intent to observed execution. For agents, it is **durable cross-session task state**
(distinct from memory): the goal, the assigned item, sibling status, decisions, and
blockers — so a second or resumed agent doesn't re-derive them from transcripts.

Kept as "another document viewer," it is redundant. Kept as the intent-to-evidence
join, no other surface does its job.

### Q2 — Is Edward's thesis right (checkpoints are what it was missing)?

**Partly, and the wrong half matters.** The surface *already* distrusts self-report:
`plan-touch-tracker` witnesses tool calls, the fs watcher hashes per-section HTML, a
5-rung resolver attributes turns, the PLAN-EVENT sentinel is *excluded* from
attribution (quarantined as "self-report"), and the Execution Trail is regenerated
from trusted DB rows. So "workers self-reported and it couldn't be trusted" describes
a problem the team already spent ~10k lines solving.

What checkpoints genuinely add (all verified real): whole-tree before/after snapshots
as real git commits under `refs/lares/checkpoints/...`; real inspectable diffs with
split witnessed-vs-window attribution and quality flags; restorability via a
maintained, hardened engine (25+ commits, still evolving) — versus the plan surface's
**zero feature commits since its single squash on 2026-07-15**.

But adoption did not fail on trust. Only **two plan files were ever created, one a
demo**, because using the surface cost more than it returned: MCP-only creation with
**no UI entry point**; **six mandatory zones** per task; workers must learn HTML
fragments and `data-anchor` discipline; a **PLAN-EVENT sentinel required every turn
including no-ops**; a **384px rail leading with provenance mechanics** over project
status; a **one-writer 409 lock** that fights the "many agents share one cwd"
invariant the whole codebase is built on. **Friction and no front door were the
disease.** Checkpoints make the good version *possible*; they do not make the current
version *good*. And critically: **a checkpoint proves work occurred, never that an
item is complete or correct.** The UI must never equate "files touched" with "done."

### Q3 — Minimal credible revival

See the two-stage architecture below. The essence: **`plan_id` + `plan_item_id`
stamped onto `turn_records` at dispatch is the whole integration seam**; progress is
*derived* from checkpoint evidence; item *completion* is an *explicit human decision*.
Stage 1 lands the join + a front door + a cheap read on the existing viewer with all
worker ceremony removed — the cheapest thing that can still test demand. Stage 2
replaces the HTML document with a structured mission board only if Stage 1 is used.

### Q4 — What should die

Sequenced across the two stages so nothing is deleted before its replacement is
proven (full list in "What dies, and when"). Headlines: the `plan_snapshots` SQLite
VCS, the PLAN-EVENT sentinel + writeback ceremony, the six mandatory zones, the
one-writer 409 lock, the claim-first sidebar, and eventually the HTML authoring path
(sanitizer, anchors, watcher, section cache, native `WebContentsView`) and the 5-rung
attribution resolver.

### Q5 — Where do "structured commits from checkpoints" fit?

It is **net-new** (the brief corrects Edward: there is no structured-commit UI today)
and it is a **Phase-2 bet, not the opening move and not the stated killer feature
until coordination proves useful on its own.** The right hierarchy once items exist:

```
plan       → a proposed commit series
work item  → a candidate commit (or coherent subset)
turn/path/hunk → selectable evidence
```

A whole plan is too coarse to be the commit unit — a real mission spans
implementation, migration, tests, docs, cleanup, and collapsing all its turns into one
commit produces exactly the oversized commits structured composition should prevent.
The **work item** is the better default grouping unit; the plan is the container for
the series. This closes the loop no mid-2026 product has closed (observed git
checkpoints → intentional commit series), and it is the strongest candidate for what
makes the surface *indispensable* — but only *after* the evidence-backed coordination
model earns its keep.

### Q6 — What is genuinely useful to agents?

A **small** contract, no document mechanics:

- **One bounded orientation read** returning mission outcome + acceptance condition,
  the assigned item, sibling item states, decisions, and blockers. (The existing
  `outline` mode in `read-ladder.ts` proves the value at ~150 tokens; it is a
  *prototype*, not an architectural constraint — a structured projection is cheaper
  and more precise than HTML excerpts + `blk_` anchors.)
- **Automatic dispatch binding** to a plan item — the agent declares nothing.
- **Trustable witnessed progress** — which turns/files already belong to its item,
  from checkpoint evidence, not a predecessor's narration.
- **Two explicit transitions** it may make: `ready_for_review` and `blocked`.

Agents must **not** be asked to understand the renderer's format, edit shared
presentation, maintain provenance, summarize file activity the engine already
witnesses, invent anchors, emit special final-message syntax, or read a full history
before acting. Plan = live task state; memory = durable cross-task knowledge;
research = source material; checkpoints = witnessed history + recovery; agent cards =
live process state. That clean division is what gives the surface a defensible job.

---

## Architecture — Stage 1 (prove the join)

Goal: on the **existing** surface, bind checkpoint turns to a plan (and, when known,
an item), surface witnessed evidence, add a creation button, and delete worker
ceremony. No renderer rewrite. This isolates the question *"does intent-grouped
checkpoint history provide value?"* from *"is a mission board the right UI?"*.

### S1.1 — Durable join columns

**File: `src/main/database.ts`**
- In the `turn_records` CREATE (~line 1490–1514), add two nullable columns via the
  existing try/catch `ALTER TABLE ... ADD COLUMN` idiom already used for
  `agents.plan_id` (~line 966) and `orchestrations.plan_id` (~line 404):
  ```sql
  ALTER TABLE turn_records ADD COLUMN plan_id TEXT;
  ALTER TABLE turn_records ADD COLUMN plan_item_id TEXT;
  ```
  Add both **now** even though Stage 1 may only populate `plan_id` — this avoids a
  second migration when items land in Stage 2.
- Add indexes: `idx_turn_records_plan ON turn_records(plan_id, turn_seq)` and
  `idx_turn_records_plan_item ON turn_records(plan_item_id, turn_seq)`.
- Extend `AllocateTurnFields` and the `turn_records` row→object mapper to carry
  `planId` / `planItemId`. Keep the "plain attribute, NO FK cascade" rule the file
  already documents for `agent_id`: deleting an agent must never purge these rows or
  null the plan association.

### S1.2 — Bind at dispatch (per-dispatch intent, validated server-side)

Resolution rule (agreed after debate — **not** the `ownerBrickGeneration` pattern):
plan/item selection is *dispatch intent*, not authoritative identity, so the caller
may supply it and the server validates it. `agents.plan_id` is frozen at launch and
stale for a reused agent, so it is only a compatibility default.

1. Explicit dispatch `planId`/`planItemId` **win after validation** (plan exists,
   belongs to the workspace, and — if an item is given — the item belongs to the
   plan).
2. A frozen `agents.plan_id` may supply a **default** when the dispatch names none.
3. The resolved values are **copied into `turn_records` at open time and never
   inferred later** from cwd, plan-file edits, final messages, or provider hook keys.

**File: `src/main/git-checkpoints/dispatch-context.ts`**
- Add optional `planId?: string | null` and `planItemId?: string | null` to
  `DispatchContext` (these ARE caller-suppliable, unlike `ownerBrickGeneration`).
- In `buildDispatchTurnContext`, resolve per the rule above: prefer validated
  dispatch values; fall back to `agent`'s frozen `plan_id` (extend
  `DispatchAgentInfo` to expose it) for `planId` only; set `planId`/`planItemId` on
  the returned `TurnContext`. Do membership validation here or reject upstream (see
  S1.4) — never write an item id whose plan doesn't match.

**File: `src/main/git-checkpoints/turn-coordinator.ts`**
- Add `planId?` / `planItemId?` to `TurnContext` and pass them straight through the
  `allocateAndInsertTurn` call in `openTurn` (~line 221). No logic — carry unchanged.

**File: `src/shared/types.ts`**
- Add the plan/item fields to the dispatch, turn-record, and any projection contracts
  that cross the IPC/API boundary.

### S1.3 — Derive the Execution Trail from `turn_records`

**File: `src/main/plans/execution-trail.ts` + `execution-trail-writer.ts`**
- Retarget the trail's data source from `plan_events` to:
  ```sql
  SELECT ... FROM turn_records
   WHERE plan_id = ? AND status = 'accepted'
   ORDER BY turn_seq
  ```
  Project each turn's `task_label`, witnessed `touched[]`, `diff_stats.witnessed`,
  `before/after` quality flags, and a link into the existing `diff_turn` /
  FileHistory / RestoreDialog flows. **Reuse the checkpoint diff/restore/file-history
  interactions — do not build plan-specific copies.**
- Progress is *association evidence*, explicitly **not** completion. Do NOT map
  section file-globs to derive "done" (fragile: planned paths are unknown pre-
  investigation, multiple items touch shared files, a path match proves association
  not advancement, refactors cross boundaries). A file-glob/section mapping may later
  serve only as an optional **scope hint or contention warning**, never as progress.

### S1.4 — Server-side dispatch binding + validation

**Files: `src/main/api-server.ts`, `src/main/plans/plan-ipc.ts`,
`src/main/orchestration/groupthink-v2.ts`, `src/main/orchestration/types.ts`**
- Accept optional `planId`/`planItemId` on the dispatch/send path.
- Validate workspace ∋ plan and plan ∋ item **server-side**; reject a mismatch (400).
- In orchestration, bind each dispatched lane to a plan (and item once items exist);
  allow multiple agents on different items of the same plan. Stop treating the
  persistent `agents.plan_id` as turn attribution — the turn's binding is authoritative.

### S1.5 — A front door + evidence-first rows (minimal renderer change)

**File: `src/renderer/components/plan/PlansMenu.tsx`**
- Add a visible **"New plan"** action calling the existing `createPlanSurface` seam
  (today MCP-only). Creation requires only a title (+ outcome/summary).
- Add a **"Create plan from this dispatch"** shortcut in the send/orchestration UI so
  a mission can be minted at the moment of dispatch.

**Files: `PlanSurfaceView.tsx`, `PlanActivityTrail.tsx`, `plan-surface-model.ts`**
- Render the derived checkpoint-backed trail as the primary evidence. **Invert the
  sidebar to evidence-first**: the witnessed `turn_records` row is the row; any agent
  claim is a muted annotation. Do not render claimed final-message payloads as
  primary. (`ClaimedPayload.tsx` / `TrustedEventRow.tsx` become removable in Stage 2.)

### S1.6 — Remove worker ceremony immediately

**Files: `src/main/plans/plan-rail-contract.ts`, `src/shared/constants.ts`,
`.lares/workers/claude/CLAUDE.md` (via orchestrator, not directly — `.claude/` gating
does not apply here but the worker template is scaffold content: bump the scaffold
version per the `scaffold-content-needs-version-bump` rule when editing
`src/shared/constants.ts`).**
- Drop the "end EVERY plan-rail turn with a `PLAN-EVENT` block" requirement.
- Remove the `assertPlanRailFree` one-writer 409 lock — progress is per-turn
  witnessed, so concurrent writers to different items are fine and same-item edits are
  ordinary last-write-wins, already witnessed per turn.
- Stop requiring `raw+editWindow` read-before-edit discipline for progress reporting;
  agents report nothing — the engine witnesses.

### S1.7 — Item state as explicit decision (schema now, UI in Stage 2)

**File: `src/main/database.ts`**
- Add `plan_items` (id, plan_id, title, acceptance_condition, state, assignee,
  parent_item_id, ordering) and `plan_item_state_events` (item_id, from_state,
  to_state, actor, reason, ts) — a **small audit ledger**, NOT a content VCS.
- States: `not_started | active | ready_for_review | blocked | done | dropped`.
  A worker may reach `ready_for_review` / `blocked`; **`done` is an explicit
  supervisor/human transition, never inferred from a diff.** Every transition records
  actor + timestamp + optional reason.
- Stage 1 may leave items unused (flat mission = one implicit item). Adding the tables
  now costs nothing and lets orchestration begin stamping `plan_item_id` early.

### Stage 1 dogfood gate

Run ≥5 real multi-agent tasks for one week. Stage 1 passes only if:
- a plan is created from the UI in under ~30s;
- every plan-bound dispatch (direct, orchestration, continuation, failed turn) yields
  a correctly joined `turn_records` row, and deleting an agent preserves the join;
- no worker edits plan HTML or emits a sentinel;
- a supervisor identifies status / blocker / responsible agent / diff / restore for a
  task within ~30s;
- a resumed agent orients from **one** bounded context read;
- low-quality checkpoints, contention, and unattributed-window changes stay visible;
- **≥3 plans are created voluntarily**, not just to exercise the feature.

If voluntary use does not occur, **stop** — fold the trail into AttributionPanel and
retire the surface. Do not proceed to Stage 2.

---

## Architecture — Stage 2 (replace the document)

Only if Stage 1 passes. Make intent structured and retire HTML authoring.

### S2.1 — Structured mission board (renderer-native)

**Files: `PlanSurfaceContainer.tsx`, `PlanSurfaceView.tsx`, `PlanActivityTrail.tsx`,
`plan-surface-model.ts`, `planSurface.css`, `PlanSectionNav.tsx`, `PlanCard.tsx`**
- Render, renderer-native (no `WebContentsView`): mission outcome + status; ordered
  work items with state / assignee / acceptance condition; checkpoint evidence nested
  under the selected item; a compact decisions/blockers area.
- Work items are **optional** — a flat mission (goal + evidence, no sub-items) must
  stay valid. Add items lazily only when decomposition earns its keep, so the board
  never becomes the new six-zone ceremony.

### S2.2 — Agent contract (replace HTML-section tools)

**Files: `src/main/plans/plan-ipc.ts`, `src/main/supervisor/index.ts`,
`src/main/orchestration/groupthink-v2-prompts.ts`, `src/shared/constants.ts`**
- `get_plan_context(plan_id, item_id?)` → outcome, item states, acceptance
  conditions, decisions, blockers, bounded evidence summaries. One bounded read.
- `set_plan_item_state(item_id, ready_for_review|blocked, reason?)`.
- `add_plan_note(plan_id, decision|question|blocker, text)` — this preserves the
  *untrusted agent summary* capability **without** the sentinel: no hidden HTML-comment
  protocol, no parser, no prompt-creep. (The existing final assistant message + task
  label already carry a turn summary the UI can excerpt, clearly labeled as
  agent-authored.)
- At dispatch, inject the assigned item's outcome + acceptance condition
  automatically. Remove all read-before-edit / edit-window / `PLAN-EVENT`
  instructions.

### S2.3 — Legacy migration

- Retain old `plans/*.html` as **read-only legacy** for one release.
- One-time importer: convert title/summary + recognizable checklist items into a
  mission + items; **archive** originals, don't rewrite them.
- Drop legacy HTML rendering the following release.

### S2.4 — Commit Composer (deferred, item-grouped)

**Files (new/edited): `src/main/git-checkpoints/commit-composer.ts` (new),
`src/main/git-checkpoints/checkpoint-ipc.ts` (preview/apply IPC), plan item evidence
view, `src/main/database.ts` (audited composition rows).**
- Group per **work item** by default; plan = the series container; allow path/hunk
  selection. Begin from **witnessed paths**, never the raw window. Show contention +
  unattributed changes + sibling overlap before composing. Preview exact contents +
  message. Take a recovery snapshot before touching index/refs. Never assume one turn
  = one commit. **Human/supervisor-initiated only.** Build only after the board is
  used *without* it.

---

## What dies, and when

**Stage 1 (delete/neutralize):**
- `assertPlanRailFree` one-writer lock.
- PLAN-EVENT sentinel *requirement* + the every-turn writeback rule (parser stays
  until Stage 2 legacy retirement).
- Claim-first sidebar ordering (invert to evidence-first).
- Six-mandatory-zones *as a requirement* for new plans (template retained until S2).

**Stage 2 (delete after board ships + legacy imported):**
- `plan_snapshots` + `plan_snapshot_blobs` tables, accessors, tests. **Caveat
  (agreed):** checkpoints do NOT automatically version human UI plan edits (they wrap
  agent turns, have their own retention, and a plan edit can occur outside a
  checkpointed dispatch). So snapshots may only die once the plan is **structured DB
  state** whose mutations are recorded by the `plan_item_state_events` audit ledger —
  not before. Do not claim checkpoint refs version every planning-state mutation.
- HTML authoring pipeline: `watch-plans.ts`, `section-cache.ts`,
  `plan-touch-tracker.ts`, `repo-activity.ts`, `read-ladder.ts`, `section-reader.ts`,
  `section-anchors.ts`, `sanitize-plan-html.ts`, `plan-render-pane.ts`,
  `plan-pane-manager.ts`, `templates/default-surface.ts`, `plan-events.ts`.
- 5-rung attribution resolver: **mark deprecated at Stage 1 launch**, measure whether
  anything still consumes it, and delete it with legacy HTML authoring. Do not keep it
  as a permanent fallback — that preserves most of the 10k-line burden for a dead path.
- Renderer: `ClaimedPayload.tsx`, `TrustedEventRow.tsx`, `PlanSectionNav.tsx` (if the
  board supersedes section nav), the native `WebContentsView` render path.

**Never inferred, at any stage:** completion from file activity; plan association from
cwd / plan-file edits / final messages / provider hook keys.

---

## Risks & how the sequence handles them

- **Over-building on a zero-adoption surface.** Stage 1 is ~1 week and reversible; the
  large structured rewrite (Stage 2) is gated on voluntary use. We never rebuild the
  renderer before validating demand.
- **"One column" mistaken for a product.** `turn_records.plan_id` alone yields a
  task-filtered checkpoint rail, not a planning surface — hence Stage 1 *also* ships a
  front door, a bounded read, and evidence-first framing, and the `plan_item_id`
  column + item tables land early so Stage 2 has its coordination unit.
- **Items becoming the new ceremony.** Items are optional; a flat mission is always
  valid; acceptance conditions are added lazily.
- **Losing plan-document history.** Snapshots are retained until the plan becomes
  structured state with its own audit ledger — never deleted on the false premise that
  checkpoints already version plan edits.
- **Scaffold drift.** Any edit to worker/supervisor scaffold constants in
  `src/shared/constants.ts` must bump the scaffold version (existing workspaces are not
  auto-updated).

---

## Bottom line

The surface was never lacking evidence — it was lacking a front door, a light touch,
and a join. Checkpoints supply the evidence that makes the light-touch version
possible. Build **explicit intent at the plan/item level, automatic evidence at the
checkpoint-turn level, and no inference that activity equals completion** — cheapest
credible join first, structured mission board only once it's used, commit composition
last. If the one-week probe isn't used voluntarily, fold it into the AttributionPanel
and don't keep a separate planning product alive for the sunk cost of its provenance
machinery.


---

# Revision 2 — Edward's clarified intent (2026-07-30, post-review)

Edward reviewed the synthesis and left three comments that refine the concept. This
revision reconciles them with the findings; where they change the design, the change
is stated explicitly.

## R2.1 The "why", restated in Edward's terms (supersedes Q1's framing in emphasis)

The surface is the **lifecycle container for the house workflow**:

> idea → proposal markdown → hardening (cross-model groupthinks + research) →
> implementation plan → scoping into worker-context-sized work packages →
> execution by many agents → historical record.

Today every step emits its own disjoint markdown (the proposal, one file per
groupthink, the implementation plan) with **nothing connecting them** — so later
nobody can answer: *was this proposal groupthink-hardened? who participated? what did
the hardening find? is the implementation plan trustworthy?* The surface's job, part
one, is to be the **one mutable whiteboard those results get incorporated into**, so
deliberation provenance travels with the plan. Part two is execution visibility:
which work package is checked off, "agent X did xyz on package G2, agent Z found an
issue on G3." And it is a **historical audit artifact**: when something breaks later,
"did any plan produce this?" — read the plan and you get the what *and the why*.

This is *compatible* with the synthesis's intent→evidence join, but it adds a stage
the synthesis under-weighted: the surface starts earning its keep at **deliberation
time**, before any worker is dispatched — as the accumulator of hardening rounds.

**Finding that matters here:** the plumbing for part one already exists.
`run_orchestration` accepts `plan_id` + `section_anchor` and writes the groupthink
result INTO a plan section instead of minting a stray markdown; `create_plan` exists.
What's missing is not machinery — it's a front door and a codified habit.

## R2.2 Stage 0 (new, zero code): encode the workflow as a supervisor skill

Edward: "it's almost like this could be a skill the supervisor has, because we are
following a workflow — a series of best practices to turn a proposal into an
implementation plan."

Adopted, and promoted to the opening move: a **supervisor skill** (e.g.
`proposal-to-plan`) that codifies the house workflow using ONLY existing tools:

1. On "I'm thinking of doing X" → `create_plan` (mint the surface), write the
   proposal into Summary/Open Questions.
2. Harden: parallel groupthink first, then serial — each dispatched with
   `plan_id`+`section_anchor` so results land IN the surface (Research/Decisions),
   not as stray markdowns.
3. Scope: turn the hardened plan into work packages sized to a single worker's
   context, written into Open Items.
4. Dispatch workers per package via the plan rail; gate returned work.

This is a process change, costs no code, is adoptable immediately, and is the
cheapest possible demand probe — it exercises the existing surface end-to-end and
tells us within a couple of real proposals whether the container is used. Stage 1's
dogfood gate should run ON Stage 0's output.

## R2.3 Simplification mandate (Edward's comment 2) — git replaces the bespoke provenance

Edward: the ~10k-line plan-provenance machinery "may be overly complicated — now we
are using git so it can take the place of understanding who worked on what when."

Agreed, and this is already the proposal's direction; stated more bluntly: the
5-rung resolver, per-section HTML hashing, touch tracking, and the SQLite snapshot
VCS are **bespoke reimplementations of what the checkpoint engine now does with real
git objects**. They die (Stage 1 neutralizes, Stage 2 deletes, per "What dies").
"Who worked on what, when" is answered by `turn_records` (witnessed touches +
before/after snapshots) joined to the plan via the two stamped columns. The only
provenance the plan layer keeps for itself is the **item-state audit ledger**
(who marked done, when, why) — decisions, not diffs.

## R2.4 Commit model clarified (Edward's comment 1)

Edward's model, adopted verbatim as the composer's contract: **the user is always
the one who commits.** Checkpoints supply the *structure* — the units of work — that
an agent or the app can bundle into a meaningful commit *package*, but composition
output is always a staged proposal gated on the human. No agent-initiated commits,
ever. (This matches the existing consent posture: `git init` is renderer-IPC-only
human consent; MCP checkpoint tools accept no `force`.) Hierarchy stands: work
package → candidate commit; plan → the commit series that narrates the feature.

## R2.5 Terminology + item semantics

`plan_items` are Edward's **work packages** — sized at scoping time to fit a single
worker's context. The scoping step is a first-class part of the Stage-0 skill and,
in Stage 2, of the board (a package carries title, acceptance condition, state,
assignee). The audit question "did any plan produce this broken thing?" becomes a
supported query in Stage 1: file → `list_checkpoints {file}` → turn → `plan_id` →
plan; the plan's Decisions/Research sections then answer *why*.

## R2.6 North-star vision (Edward, 2026-07-30) — the proposal→plan→artifact lifecycle

Edward's end-state, verbatim in structure:

1. **Proposals are the universal cheap entry point.** Whenever chat surfaces
   something that could be new work, the first step is what already happens today:
   write a markdown proposal documenting the why and the how. **If it's simple,
   that's the end of the story** — a proposal is a valid terminal state. No
   ceremony, no supervisor binding, no sections.
2. **A proposals gallery UI** (split screen: scrollable proposal list on top, a
   reading pane below). The human browses, reads, and decides — alone or with an
   agent — whether a proposal graduates.
3. **Promotion is a deliberate, formal act.** Turning a proposal into a *plan* is
   the moment formality begins: a supervisor **subscribes** to the plan (new or
   resurrected), invokes the **planning skill**, and runs the hardening workflow
   (groupthinks → implementation plan → work-package scoping) until the plan is
   implementation-ready.
4. **Execution is visible on the surface.** Workers launch per package; the plan UI
   shows what is being done, what got checked off, what was found.
5. **Retirement into history.** A finished plan becomes a durable workspace
   artifact — reviewable later to answer "what was done and why."

**Why this matters to the design:** it fixes the original surface's core adoption
error. v1 charged the full 6-zone ceremony at *idea time*, so nothing got created.
The vision moves the expensive machinery behind an explicit **promotion gate** —
most ideas live and die as cheap markdowns; only deliberately promoted ones incur
plan formality. The lifecycle also gives the surface a real state machine
(`proposal → hardening → executing → archived`, with resurrection), which Stage 2's
board should model explicitly.

**Mapping to existing machinery:** proposals = plain markdowns (today's habit,
unchanged); gallery = an extension of the existing Plans toolbar popover
(`PlansMenu`/`PlanCard`, today HTML-only — would list proposals too); subscription =
`supervisor_focus` (exists, MCP-only, no UI — the vision finally gives it a visible
role: the plan's responsible supervisor, surfaced in the UI); planning skill =
Stage 0's `proposal-to-plan`; promotion = `create_plan` seeded from the proposal
file; execution visibility = Stage 1's checkpoint-derived trail; historical
artifact = the archived plan + its `turn_records` join. Notable v1 decision to
revisit at promotion time: `POST /api/plans` currently 400s markdown migration —
promotion is exactly a markdown→plan conversion, so that boundary moves from
"rejected" to "the promotion ritual."

## R2.7 The supervisor drives the app (Edward, 2026-07-30) — proactive best-practices encoding

A new user does not know this app's concepts. They don't know "I should write a proposal,"
"this deserves a groupthink," "work should be scoped into worker-sized packages." **The
supervisor does — and it is the supervisor's job to drive.** The supervisor encodes the
app's best practices and proactively offers them in conversation:

- **Recognize a proposal forming.** When discussion shapes into a potential feature or
  piece of work, say so: "what we're discussing could be a proposal — want me to write
  one?" Never assume the user knows the concept; teach it in one sentence at the moment
  it's useful.
- **Suggest the next practice at the right moment.** Proposal written → offer promotion
  when it matures. Promoted → run the hardening groupthinks (parallel then serial).
  Hardened → scope into work packages sized to one worker's context. Scoped → launch
  workers and gate their returns. The user should never need to know the sequence; the
  supervisor walks them through it.
- **The supervisor knows the app's tools so the user doesn't have to.** Checkpoints,
  plan rails, orchestrations, the research lane — the supervisor routes to them and
  explains only what the user needs to decide.

**Where this lives:** (a) a section in the supervisor scaffold CLAUDE.md (deployed via
the scaffold version bump, per §G of the technical strategy) stating the driving role
and the proposal-recognition behavior; (b) the Stage-0 `proposal-to-plan` skill, whose
trigger description must fire on the *situation* ("discussion is converging on new
feature-shaped work") — not only on the user explicitly asking for a proposal. This
makes Stage 0A a behavior change, not just a filing convention: the skill teaches WHERE
to save proposals, WHAT shape they take, and WHEN to offer one unprompted.

## R2.8 Revised sequence

- **Stage 0 (now, no code):** the `proposal-to-plan` supervisor skill; route all new
  proposals + groupthinks through existing plan surfaces. Demand probe begins.
  Proposals themselves stay cheap markdowns (R2.6 §1) — the skill fires only at
  promotion.
- **Stage 1 (unchanged, ~1 week):** the join (`plan_id`/`plan_item_id` on
  `turn_records`), checkpoint-derived trail, front door, ceremony deletion. Front
  door grows toward the R2.6 gallery: list proposals alongside plans; "promote to
  plan" seeds `create_plan` from the proposal markdown (lifting the md-migration
  400); surface the subscribed supervisor.
- **Stage 2 (gated on voluntary use):** structured mission board modeling the R2.6
  state machine (`proposal → hardening → executing → archived`, resurrectable);
  work packages as first-class rows; legacy HTML retired; bespoke provenance
  deleted.
- **Stage 3:** commit composer under R2.4's user-always-commits contract.

<!-- groupthink_run: 0dddc0b7 (mode=parallel) -->
