# Context brief: Planning-surface revival deliberation (2026-07-30)

You are deliberating a DESIGN PROPOSAL (no code changes now). Read this whole brief before drafting.

## Edward's ask (the human)

The planning surface has stagnated ("sorta broken, I haven't been using it"). He believes the
git-native checkpoint engine we built since is "the thing the planning surface was lacking most":
originally workers SELF-REPORTED what they did into the plan; now the app witnesses real activity
via git checkpoints + a DB joining agent file-touches to turn snapshots. He wants a candid
evaluation: does the planning surface offer users AND agents something real? What should its
revival look like, rebuilt on checkpoint evidence? He is open to major modification or even
concluding the concept isn't worth it. Deliverable = a proposal, with a plain-language
articulation of WHY a planning surface should exist at all.

## What the planning surface IS today (verified by code exploration, 2026-07-30)

- One HTML doc per plan under `plans/*.html`, minted from a fixed 6-zone template:
  Summary (`sec_summry`), Open Questions (`sec_quests`), Research (`sec_resrch`),
  Decisions (`sec_dcsion`), Execution Trail (`sec_exectr`, system-owned), Open Items (`sec_opitem`).
- Implementation: `src/main/plans/` (~10.4k lines incl. tests), landed as ONE squash commit
  `67f5b04` on 2026-07-15. Exactly zero feature commits since. Renderer: `src/renderer/components/plan/`
  (sandboxed WebContentsView render pane + 384px provenance rail with trusted-vs-claimed event rows).
- Provenance spine (surprisingly sophisticated, NOT naive self-reporting):
  - `plan-touch-tracker` records plan-read tools + native Edit/Write/apply_patch edit-targets during the turn.
  - fs watcher reparses the plan HTML on settle, hashes per-section inner HTML → `plan_section_changes`.
  - At Stop, a 5-rung resolver (edit-target > fs-diff > diff∩intent > intent-only > dispatched-fallback)
    attributes the turn to a section with a confidence label; agent CLAIMS (a `<!--PLAN-EVENT-->` sentinel)
    are stored but deliberately EXCLUDED from attribution — quarantined as "self-report".
  - Execution Trail is wholesale-regenerated from `plan_events` DB rows; hand-written trail lines get
    relocated to an "Unverified manual notes" quarantine div.
- DB: `plans`, `plan_sections`, `plan_events`, `plan_section_touches`, `plan_section_changes`,
  `plan_snapshots`/`plan_snapshot_blobs` (content-addressed full-HTML history — a hand-rolled SQLite VCS
  for the plan file, predating the git engine).
- Supervisor "subscription" = `supervisor_focus` table (focus_plan/unfocus_plan MCP tools, auto-focus on
  create/dispatch, resurfaced by get_my_context). NO renderer UI for it at all.
- One-writer policy: `assertPlanRailFree` 409s a second active writer per plan.
- Known gaps: anchor-name drift with no alias layer; claim-first sidebar rows contradict the
  evidence-first hardening review; mtime/hash edit-guard never implemented; snapshot retention unbounded;
  docs describe pre-hardening state (5 P0s fixed in code, no doc records it); roadmap Phases 2-6 unbuilt;
  no "New plan" button (MCP-only creation); only 2 plan files ever created, one a demo.

## What the checkpoint engine IS (verified same day)

- `src/main/git-checkpoints/` (~5.5k LOC), landed 2026-07-24..27 (~25 commits + hardening).
- Per-turn before/after WHOLE-TREE snapshots as real git commits under private refs
  `refs/lares/checkpoints/<ws>/<agent>/<turn>/{before,after}`; byte-exact (`--no-filters`), never touches
  HEAD/index/branches. Turn rows in `turn_records`: witnessed `touched[]` (from the agent's own tool calls
  via the shared `file_activities` ingress), split `diff_stats` {witnessed vs raw window}, quality flags,
  `compact_diff`. `recovery_operations` audits restores with pre-restore safety snapshots.
- Human UI: per-agent turn rail (dots per turn), RestoreDialog, workspace AttributionPanel
  (witnessed vs unattributed diffs, contention), FileHistoryView. Supervisor-lane MCP tools:
  list_checkpoints/diff_turn/restore_paths/revert_turn/prune_checkpoints.
- IMPORTANT CORRECTION to Edward's premise: there is NO structured-commit UI. Nothing composes real user
  commits from checkpoints. That is a candidate feature, not an existing one.

## The integration gap (the core finding)

The two systems are ENTIRELY disjoint: zero cross-imports, no SQL join, different turn-ID namespaces
(TurnCoordinator UUID vs provider-hook turn key), different triggers (checkpoint turn opens at dispatch;
plan event composes at idle), duplicated path-normalization code. Their ONLY shared wire is the
`file_activities` stream. The plan surface's "witnessed" repo digest is a rendered file_activities
rollup, NOT the checkpoint engine's witnessed/window attribution. Plan snapshots duplicate in SQLite
what checkpoints do properly in git.

## Landscape (untrusted web research, treat as inspiration not fact)

Mid-2026 products: Devin (4-zone header Goal/Status/PR/Confidence; confidence gates; arrow-key step
navigation), GitHub Copilot Mission Control (fleet view above sessions; logs-before-diff reading order;
comment-on-diff-line steering), Cursor Glass (branch diff as THE completion artifact, per-turn noise
hidden), Factory (plan as pre-execution artifact), Claude Code (plan mode as hard read-only gate).
AgentDiff: git-notes provenance, blame-with-prompt. Nobody has closed the loop "observed git
checkpoints → live plan-progress surface" — a genuine open gap. CHI 2026 collaborative-doc paper:
embed AI activity in EXISTING affordances (comments/sections), implicit provenance beats novel
provenance UI; personal-territory vs shared-output ownership emerges naturally.

## Questions the deliberation MUST answer

1. WHY have a planning surface at all? Articulate the irreducible value in plain terms — for the human
   AND for agents — or candidly conclude it's redundant with (agent cards + checkpoint rail + memory +
   research inbox). What job does it do that no other Lares surface does?
2. Is Edward's thesis right — checkpoint evidence is what the surface was missing? Note the nuance: the
   surface ALREADY distrusts self-reports and has its own witnessing. What checkpoints actually add:
   whole-tree before/after snapshots, real diffs, restorability, a maintained/hardened pipeline. Weigh
   honestly: was self-reporting the actual reason it stagnated, or was it friction (MCP-only creation,
   no UI entry point, HTML-edit discipline burden on workers, heavyweight 6-zone ceremony per task)?
3. What is the MINIMAL credible revival? Propose a concrete architecture direction for joining
   plan ↔ turn_records (e.g. stamp plan_id/section into DispatchContext & turn_records; derive plan
   progress/trail from checkpoint evidence; retire plan_snapshots in favor of git refs; per-section
   diffs from touched-file mapping). Sequence it: what lands first, what proves value in a week of
   dogfooding, what gets deleted.
4. What should DIE? Be specific (e.g. plan_snapshot SQLite VCS, PLAN-EVENT sentinel + writeback ceremony
   burden on workers, 6 mandatory zones, claim-first sidebar).
5. Where does "structured commits from checkpoints" fit — is the plan the natural grouping unit for
   turning witnessed turn diffs into real git commits (plan → commit series), and is that the killer
   feature that makes the surface indispensable?
6. What is genuinely useful TO AGENTS (not just the human)? E.g. plan as durable cross-session shared
   state vs the memory system; outline-mode cheap reads; dispatch context.

Be candid. "Kill it" or "fold it into X" are acceptable conclusions if argued. Prefer a small number of
load-bearing recommendations over a laundry list.
