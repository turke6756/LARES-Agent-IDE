# Deliberation brief: one skill vs. scripted workflow for the proposal→plan journey

*2026-08-02. Kickoff brief for a GroupThink. Read this first, then the pointer docs, then deliberate.*

## The question

The planning-surface design (Phase P0) currently ships the whole proposal→plan hardening
journey as **one skill**, `proposal-to-plan`, with three modes (capture / promote-scaffold /
orient-resume) and a five-activity journey inside promote: **scope → mark → deliberate →
integrate → package**.

Edward's reaction (2026-08-02, ruling pending this deliberation): *each journey activity feels
like its own behavioral skill — scope, mark, deliberate, integrate, package — so a **scripted
workflow** that hands agents the right skill at the right point in the workstream may be better
than one monolithic skill. I'm tempted to just start with the workflow, but I want more
deliberation and opinions first.*

Decide: **(A)** one monolithic `proposal-to-plan` skill; **(B)** a scripted workflow (an
orchestration or driver script) that sequences per-activity skills; **(C)** a hybrid (e.g. one
umbrella skill that delegates to per-activity sub-skills, or start monolithic with seams cut so
activities can be extracted later). Recommend one, with a migration story if it changes P0.

## Fresh rulings that constrain the design (2026-08-02, authoritative)

- **Scope is redefined**: scope is NOT cutting work into worker-sized packages. Scope = the
  hardening triage — the responsible supervisor, ideally with an independent second opinion
  (e.g. a Codex-lane agent, or even a small groupthink), reads the proposal and decides what
  deserves extra effort: which parts need groupthink deliberation, which would benefit from
  online research. Scoping agents must understand the hardening process itself. Output = the
  **marked-up proposal**. A trivial proposal may be judged "nothing needs hardening — package
  and implement" — always an option. Worker-sized packaging is the LAST step.
- **Marking happens on the proposal**, before plan.md exists — the markup is the supervisor's
  strategy for getting proposal → plan.
- The actor for mark / integrate / package is the **supervisor**. ARC.md is
  supervisor-maintained.
- The skill (or workflow) ships a **helper script** that owns all plan.json edits under the
  approved plan.json.lock protocol (owner+nonce 'wx' acquire, 2s heartbeat, 15s stale reclaim).
- The journey must be **interruptible/resumable**: state lives in the plan folder; any later
  agent can orient (plan.json + ARC.md + intent markers) and resume.

## Things to weigh

- The old plan surface died of **ceremony**; whatever ships must keep capture near-zero-cost
  and not re-introduce ritual. P0's whole point is skill + folder homes, no app UI yet.
- The dashboard already has an orchestration runner (`run_orchestration`, groupthink catalog)
  and skills auto-load per agent scaffold. A "scripted workflow" could mean: a new orchestration
  in the catalog, an external driver script, or a supervisor-followed skill that sequences
  sub-skills. Cost/complexity differs a lot between these.
- P0 is the first dispatchable wave; a workflow-shaped P0 changes WP-P0A/P0B briefs materially.
  Consider build cost now vs. refactor cost later.
- Skills are per-agent-lane (supervisor vs worker scaffolds differ); the journey spans lanes
  (supervisor drives, worker/codex lanes consult, groupthink deliberates).

## Pointer docs (read as needed, in this order)

1. `.lares/proposals/2026-07-30-planning-surface-revamp.md` — the proposal; its Amendments
   section is authoritative.
2. `.lares/proposals/supporting/2026-08-01-planning-surface-p0-p2-rescope.md` — §R0/§R1/§R2
   NORMATIVE + the current WP-P0A/P0B/P0C briefs (the thing your recommendation reshapes).
3. `.lares/proposals/supporting/2026-08-02-planning-surface-plain-language-guide.md` — §3 "The
   skill" is the plain-language version of the journey.
4. `.claude`-adjacent skill examples: `.lares/supervisor/.claude/skills/` (what a skill looks
   like here); `run-orchestration` skill shows the orchestration surface.

## Deliverable

A worker-ready recommendation markdown: chosen shape (A/B/C), rationale, the skill/workflow
inventory it implies (names + one-line purpose each), how interruption/resume works in that
shape, what changes in WP-P0A/P0B (concretely), and what is deferred. Flag any point where the
fresh rulings above conflict with the shape you recommend.
