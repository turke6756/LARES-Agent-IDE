---
artifact_id: prop_0e1425af
title: Split the proposal lifecycle — an authoring skill for agents, a human-triggered promotion prompt
author_role: supervisor
author: "Two Proposal Review Planning surface and Git REview" (workspace supervisor, AgentDashboard)
author_agent_id: 9b6a3d39-80a0-40ec-a2e6-ea428091627d
author_provider: claude
authored_at: 2026-08-05T23:55:00Z
amended_at: 2026-08-06T00:40:00Z
promoted_to: 2026-08-05-split-the-proposal-lifecycle-an-authoring-skill--0e1425af
promoted_at: 2026-08-05
---

# Split the proposal lifecycle: authoring is an agent skill, promotion is a human gesture

## In plain terms

Right now, one big rulebook covers everything from "an agent writes down an
idea" to "that idea becomes a full project plan" — and agents can walk that
whole road on their own. This proposal splits it into three simple pieces:

1. **Writing an idea down** gets its own small skill any agent can use. An
   idea document (a "proposal") is how an agent says: *here is a substantial
   new thing worth doing — over to you.*
2. **Turning an idea into a plan** becomes something only YOU start: you click
   "Promote" on a proposal card, and that click hands the instructions to a
   supervisor. No agent decides on its own that an idea deserves a project.
3. **Reading the planning boards** gets its own skill too, so any agent can
   look at what ideas and plans exist — and understand them correctly —
   without being able to change anything.

It also fixes two annoyances you named: every proposal card will say exactly
**which agent wrote it** (its real name and id, not just "a supervisor"), and
every proposal must **open with a plain-language summary like this one**, so
you can tell what it is and why it matters without wading into the technical
detail.

**What changes for you:** the proposals pane becomes readable at a glance
(clear summaries, clear authors), and you become the single gatekeeper for
which ideas become plans — everything else agents still do on their own.

---

**Status:** proposal. Written at Edward's direction (relayed 2026-08-05 via the
Save Card Execution supervisor). Supersedes and absorbs the framing of the Save
Card Execution supervisor's private `write-proposal` skill
(`.lares/supervisor/.claude/skills/write-proposal/SKILL.md`, authored earlier
today after the misfiled-GroupThink-brief incident).

**Relation to existing artifacts:**

- `.lares/proposals/2026-08-05-planning-surface-skill-bridge.md` (prop_e0001372)
  — the surface-bridge proposal. This proposal changes WHO initiates each
  lifecycle stage; prop_e0001372 changes what the UI can SEE of each stage. They
  compose; where both touch the promote flow, this proposal's shape is the
  intended end state and prop_e0001372's C1 ("single promote story") should be
  read through it.
- Lesson `supporting-docs-require-plan-subscription` (provisioned to all lanes
  today) and pending graduation grad-abc9293c — the subscription-gated
  `supporting/` rule. This proposal folds that rule into the authoring skill as
  its path-choice step, which is where it will actually be encountered.

---

## Part 1 — the split

### The problem with today's shape

Today one skill, `proposal-to-plan`, owns the whole arc: capture → scope →
promote → deliberate → integrate → package → orient. Two things are wrong with
that in practice:

1. **Authoring is buried inside a promotion pipeline.** An agent that just wants
   to write down a substantial idea must reach into a seven-mode dispatcher whose
   center of gravity is plan-folder mechanics (manifest locks, intent rungs,
   ARC.md ownership). The cheap, universal act — "write the idea down where the
   human will see it" — is mode one of seven. The misfiled GroupThink brief
   today is the symptom: the authoring decision (where does a planning document
   GO?) had no dedicated home, so it was improvised and got it wrong.

2. **The skill's framing invites agents to self-drive the lifecycle.** A skill
   is something an agent reaches for when its trigger matches. But every stage
   after authoring — scoping, promoting, deliberating — is a *judgment that the
   idea deserves investment*, and that judgment is Edward's. Our own live run
   (plan_pigt5a83) worked only because Edward explicitly said "capture", then
   "scope", then "dispatch". The skill's shape implies an agent could walk the
   whole ladder alone; the house practice is that it never should.

### (a) A dedicated authoring skill: `write-proposal`

Promote the private `write-proposal` skill to a **workspace-shared skill for all
lanes** (workers, researchers, supervisors — capture is already open to anyone),
absorbing `proposal-to-plan`'s `capture` mode. Its identity:

> **A proposal is how an agent starts a SUBSTANTIAL piece of NEW work that is
> self-contained and awaits further review.** Writing one is the agent-native
> act; everything after it waits for a human.

The skill owns exactly three decisions:

1. **Threshold — is this a proposal at all?** Substantial + new + self-contained
   + review-worthy. Not a proposal: routine fixes you should just do; workspace
   state that belongs in memory; reusable steering that belongs in a lesson;
   documents in service of a plan you are subscribed to (that is supporting
   material). The skill states the boundary against `remember` explicitly —
   today nothing does, and the two attractors pull ideas into the wrong stores.

2. **Path — where does it go?** The subscription-gated rule, verbatim from
   today's ruling: `supporting/` is reserved for a supervisor subscribed to a
   plan, for documents in service of that plan's deliberation. Everyone else's
   planning document is a proposal: `.lares/proposals/YYYY-MM-DD-<slug>.md`,
   flat, dated, top-level. When in doubt, it is a proposal — top-level is what
   the human browses; `supporting/` hides it. (This makes the lesson's content
   load-bearing inside the skill, which is where authors actually are when the
   decision happens; grad-abc9293c's CLAUDE.md line then serves as the ambient
   backstop for agents that never invoke the skill.)

3. **Stamp — the frontmatter contract.** Carried over from `capture` unchanged:
   portable `artifact_id` (`prop_` + 8 crypto-random hex, mandatory collision
   scan), `title`, `author_role`, `author` + `author_agent_id` (see Part 2),
   `authored_at`. Plain markdown body beyond the required lead (next item),
   zero further ceremony, terminal-valid — a proposal that never graduates is a
   legitimate durable artifact.

4. **Lead in plain language — required (Edward's amendment, 2026-08-05).**
   Every proposal MUST open with a plain-language summary a non-specialist
   reader can follow — before any technical content. House shape: a first
   section titled **"In plain terms"** answering three questions in ordinary
   words: *what is this?* — *why does it matter?* — *what changes for the
   user?* No file paths, no identifiers, no jargon; a reader who stops there
   should still correctly understand the idea. The skill treats a proposal
   without this lead as unfinished, the same way it treats missing
   frontmatter. Rationale: the proposals pane is the surface the HUMAN
   browses; a proposal is addressed to a human reviewer by definition (that is
   the whole Part 1 thesis), so human readability is part of the artifact's
   contract, not a courtesy. This is the same dual-register principle as
   prop_e0001372's A1 (mandatory human overview on plans): the technical body
   stays as deep as it needs to be — the plain layer is additive, never a
   replacement. Card-display bonus: the pane's description snippet derives
   from the first body paragraph, so the plain lead is exactly what the card
   will show. (This proposal's own "In plain terms" section is the template.)

The skill ends there, deliberately. Its hand-off sentence is not "next run
`scope`" but "**tell the human the proposal exists and where it is; the
lifecycle continues only from the Plans pane.**"

<!--PLAN-INTENT
{ "intent_id": "int_6781b552", "part": "promotion-prompt-design",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "Part 1b + open questions 1-2: saved-prompt storage (constant vs state-dir template), promote-gesture targeting (workspace supervisor vs picker), and composition with prop_e0001372 C1's single-promote-story need one deliberation before packaging" }
-->

### (b) Promotion becomes a human-triggered saved prompt

Convert the remainder of `proposal-to-plan` from an agent-invocable skill into a
**saved prompt that the PROMOTE gesture injects**. Concretely:

- The user opens a proposal card in the Plans pane and clicks **Promote to
  plan**. The dashboard inserts a stored prompt into the workspace supervisor
  (or a chosen fresh planning supervisor — the picker prop_e0001372's C1 already
  implies), naming the proposal file and its `artifact_id`, and directing the
  supervisor to carry it through scope → promote → deliberate → integrate →
  package under the house method.
- The **method content survives, the trigger dies.** The reference playbooks and
  contracts (`scope.md`, `promote.md`, the manifest-lock protocol, the intent
  rung ladder, `plan-manifest.mjs`) stay on disk exactly where they are — they
  are the *method library* the injected prompt points into. What is removed is
  the skill's self-service front door: its trigger description no longer invites
  any agent to "use whenever you author a proposal or harden one." An agent has
  no reason to enter the pipeline unprompted, because entering it IS the human's
  gesture.
- **Reading stays agent-reachable; mutation does not.** Re-entry into an
  already-promoted plan you are responsible for (after a reset, a handoff, a
  crash) is not "starting the lifecycle" — it is resuming work the human already
  authorized. Read-only orientation lives in the dedicated reading skill (see
  (c) below), invokable by any lane at any time. Every mutating mode is reached
  only through the injected promotion prompt or through the responsible
  supervisor continuing a plan that prompt opened.

Why a saved prompt and not a literal mega-prompt: the promotion prompt should be
a **pointer, not a payload** — a few paragraphs binding {proposal path,
artifact_id, chosen supervisor} and instructing "follow the method at
`<skill-root>/references/`, starting with scope." Inlining seven playbooks into
a stored prompt would fork the method into two copies that drift; the folder on
disk stays the single resumable source of truth, which is the property that made
plan_pigt5a83 recoverable across many context resets.

This also aligns the lifecycle with Edward's A2 ruling in prop_e0001372
(run-to-implementation continuity, single stop at the human overview): the human
gestures are the *joints* of the lifecycle — author (agent) → **promote
(human)** → plan+deliberate+package (agent, continuous) → **implement (human)**
— and between joints agents run without asking permission mid-flow.

### (c) A dedicated reading skill: `read-planning-surface` (Edward's amendment, 2026-08-05)

Edward's follow-up names the third act the original split left implicit:
**reading the planning surface and interpreting it** should be its own skill,
distinct from authoring and from the promotion prompt.

**Position: yes — a separate skill, built by splitting `orient` rather than
growing it.** The lifecycle then has three agent-facing entries plus one human
gesture, each owning one verb:

| Entry | Verb | Who | Mutates? |
|---|---|---|---|
| `write-proposal` | author | any lane | creates one file |
| `read-planning-surface` | read + interpret | any lane | never |
| Promote gesture → saved prompt | harden + execute | human-initiated, responsible supervisor runs | yes |

Why a separate skill and not an expanded `orient`:

- **`orient` is plan-folder-scoped; the reading problem is surface-wide.** An
  agent picking up cold needs to answer "what ideas exist, what state is each
  in, what is mine to act on?" across the WHOLE surface — flat proposals
  (including their scope-verdict and PLAN-INTENT markup), plan folders, and the
  gap between them (a proposal whose plan folder exists but whose card still
  looks bare, prop_e0001372's exact blind spot). `orient` answers a narrower
  question — "what rung is each intent of THIS plan on?" — and should remain
  that plan-folder instrument.
- **`orient` today is not purely read-only**, and that impurity is exactly what
  should not spread: its step 4 refreshes ARC-META when the runner is the
  responsible supervisor. Growing `orient` into the general reading skill would
  drag a mutation into a skill whose whole contract must be "interpret, never
  touch." Split instead: the read-only derivation and the decision-table
  *reporting* move into `read-planning-surface` (any lane, any plan, always
  safe); the ARC refresh stays behind, a method-library step the responsible
  supervisor runs from inside the promotion pipeline (b).
- **Interpretation rules deserve a home of their own.** The surface has real
  epistemics that today live scattered across CLAUDE.md and skill internals:
  a bare proposal is terminal-valid, not "unfinished"; `ran` is unavailable
  pre-ledger and must be reported as such, never inferred from filenames;
  witnessed activity says whether to look closer, never proves quality; a
  `supporting/` doc is subordinate material, not a proposal; frontmatter
  authorship is a self-claim, the witnessed register is server truth. The
  reading skill is where those rules get taught once, to every lane — including
  non-claude lanes as they gain supervisor capability, which will need exactly
  this "how to read the surface" packet.

Boundary contract: `read-planning-surface` never writes, never launches, never
appends `assigned` events; its output is a state report + safe-next-actions
list, and every judgment-bearing action it surfaces routes to the responsible
supervisor or the human. `orient` remains the plan-folder deep-dive the
promotion method invokes; the reading skill may end a whole-surface pass by
recommending "run `orient` on plan X" without running it.

### What changes on disk / in product

1. `write-proposal` skill moves from the Save Card supervisor's private folder
   to workspace-shared provisioning (all lanes), rewritten with the framing
   above; `proposal-to-plan`'s `capture` mode is deleted and its playbook
   content absorbed.
2. `proposal-to-plan`'s SKILL.md trigger description is rewritten to
   promotion-prompt-entry only; no agent-facing "use when authoring" language
   survives. Its `orient` mode splits per (c): read-only derivation +
   reporting moves to the new `read-planning-surface` skill (all lanes); the
   ARC-META refresh stays in the method library, responsible-supervisor-only.
2a. A new workspace-shared `read-planning-surface` skill is provisioned to all
   lanes, carrying the surface-wide interpretation rules in (c).
3. The dashboard stores the promotion prompt template and the Promote gesture
   injects it (today `PromoteToPlanPanel` already dispatches a skill invocation
   to the supervisor — this narrows *what* it sends, so it is a small delta on
   an existing wire, and the natural landing spot for prop_e0001372 C1's "one
   promote story, delete the dead saga path").
4. Scaffold-version bump for the skill provisioning changes (per the
   scaffold-content rules — deployment to existing workspaces is not automatic).

## Part 2 — should proposals carry the authoring agent's name?

### The observed anonymity is an accident, not a design

The prompt asks whether proposals' anonymity is intentional. Evidence says the
convention already decided the opposite, and the anonymity Edward sees is drift:

- The `capture` playbook **requires** `author` (display name) and `authored_at`
  today, precisely because "the Plans-pane proposal cards render them; a
  proposal without them shows an anonymous, undated card."
- But early proposals predate that rule — e.g.
  `2026-07-30-save-card-commit-ui.md` carries only `author_role: supervisor`,
  no `author`, so its card renders authorless. Half the folder is stamped, half
  is not.
- Meanwhile the ingestion side (`proposals-watcher.ts`) deliberately treats
  frontmatter authorship as an **untrusted self-claim** and derives its own
  `author_role` from the `file_activities` witness store — the agent the server
  actually SAW write the file.

So there are already two authorship registers with different trust levels, and
the question is not "anonymous or named" but "which register shows, and is the
self-declared one required."

### Position: named, in both registers — merits-review is a reviewer norm, not a metadata property

**Proposals should carry authorship. Anonymity should not be the convention.**

The merits argument for anonymity — a proposal stands on its content and awaits
review on its merits — is real but mislocated. Review-on-merits is achieved by
*how the reviewer reads*, not by stripping provenance. Edward is the only
reviewer, he can see every agent's transcript anyway, and no status hierarchy
exists among agents for a byline to bias. Blinding metadata here would buy
nothing.

What named authorship buys, concretely, in an agent fleet:

1. **A follow-up path.** "Which agent's context holds the evidence behind this?"
   is a routine question — the author's transcript, checkpoints, and witnessed
   file activity are the proposal's real appendix. An anonymous proposal orphans
   its own evidence trail.
2. **The memory-jog function.** Edward's save-card ruling (Amendment 10 of
   prop_4c8d21b7) established that surfaces should lead with "who worked on
   what, when" so the human recognizes work without reading paths. Proposal
   cards are the same surface pattern; today's half-anonymous folder is exactly
   what that ruling exists to prevent.
3. **Calibration over time.** Which lane authored a proposal (a supervisor's
   synthesis vs. a worker's in-the-trenches observation vs. a researcher's
   web-derived digest) legitimately changes how it should be read — not its
   worth, but its epistemic character. `author_role` already encodes this;
   hiding it would discard signal, not bias.

### Amendment (Edward, 2026-08-05): identity must be SPECIFIC, not a role label

Edward's review of the live cards: a byline like "workspace supervisor" answers
nothing — *which* supervisor? Dozens of supervisors have existed in this
workspace; a role label is anonymity with extra steps. (This proposal's own
original byline committed the sin: "Workspace supervisor (AgentDashboard)."
Its frontmatter now demonstrates the corrected contract.)

**The required identity is the concrete agent, in both registers:**

- **Frontmatter (self-declared register)** — the authoring skill requires:

  ```yaml
  author: "<agent title verbatim>" (<lane>, <workspace>)
  author_agent_id: <dashboard agent uuid>
  author_role: supervisor | worker | researcher
  author_provider: claude | codex | grok | agy   # optional but cheap
  authored_at: <ISO-8601>
  ```

  The agent title is the specific launch title (e.g. "Save Card Execution",
  "P6 mission-board worker"), never a generic role noun. `author_agent_id` is
  the load-bearing field: titles collide and get renamed; the uuid is the join
  key to transcripts, checkpoints, and witnessed file activity — the proposal's
  real appendix. An agent always knows its own id (it is injected in the
  system prompt), so requiring it costs nothing.

- **Witnessed register** — the watcher already stores the witnessing
  `author_agent_id`; the gap is display. Wherever the witnessed chip surfaces
  (prop_e0001372's DB-backed projection), it should resolve that id to the
  agent's title + short id, not collapse to a role word.

**What the card displays** (so the human can tell exactly which agent, at a
glance, memory-jog style per the save-card Amendment-10 convention):

> by **Save Card Execution** · supervisor · f57ca63c · Aug 5, 2026

i.e. `<agent title> · <lane> · <uuid first 8> · <date>` — with a mismatch
marker (e.g. "byline unwitnessed") when the self-declared `author_agent_id`
disagrees with the witnessed writer, which is precisely the case the
two-register design exists to expose. Hovering/expanding may show the full
uuid and provider.

Therefore:

- **`author` + `author_agent_id` + `author_role` + `authored_at` required** in
  the authoring skill's frontmatter contract; `author_provider` encouraged.
  A generic role label in `author` fails the contract.
- **Keep the two registers distinct and label them honestly.** Frontmatter
  identity is a self-claim rendered as the card byline; witnessed attribution
  is server truth. Show both; never merge them; flag disagreement.
- **Backfill is optional and cheap.** The handful of pre-rule proposals can get
  specific `author` + `author_agent_id` lines from known history (the sibling
  save-card proposal was authored by the 2026-07-30 "Two Proposal Review"-line
  workspace supervisor; ids are recoverable from the agents table); no tooling
  needed.
- One nuance worth preserving: authorship names the **agent role/title, not a
  claim of authority**. A worker's proposal outranks nothing and is outranked by
  nothing; the lifecycle's only gate is the human's promote gesture (Part 1b),
  which is what actually guarantees merits-review.

## Open questions

1. **Where does the saved promotion prompt live?** Options: a constant in
   `src/shared/constants.ts` (versioned with scaffolds), or a user-editable
   template in the state dir. Lean: constant first — user-editable templates are
   a feature, not a prerequisite.
2. **Does the promote gesture always target the workspace supervisor, or offer
   the fresh-planning-supervisor choice?** Edward has used both patterns live
   (pigt ran on a dedicated peer). Lean: a small picker defaulting to the
   workspace supervisor.
3. **Scope of `write-proposal` provisioning:** all lanes including researchers,
   or workers+supervisors only? Lean: all lanes — the researcher's "findings
   suggest we should build X" is exactly a proposal, and the inbox/untrusted
   tier is for its *data*, not its ideas.

## Hardening scope
- **Verdict (dated):** 2026-08-05 — Parts 1a (write-proposal skill), 1c
  (read-planning-surface skill), and 2 (authorship contract) are fully
  specified by Edward's two amendments and need no hardening. Part 1b plus
  open questions 1–2 (saved-prompt storage, promote-gesture targeting,
  composition with prop_e0001372 C1) carry the residual design uncertainty
  and get one groupthink-serial deliberation. No online research needed —
  all unknowns are internal to this codebase.
- **Second opinion:** none consulted — promotion was directly human-directed
  (Edward, 2026-08-05); triage performed by the responsible supervisor.
- **Marked intents:** int_6781b552 — groupthink-serial on the promotion-prompt
  design (Part 1b + open questions 1–2, incl. prop_e0001372 C1 composition).
