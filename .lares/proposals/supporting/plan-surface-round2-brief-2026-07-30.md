# Round-2 brief: sharpen the plan-surface revival into a technical strategy (2026-07-30)

READ FIRST, in order:
1. `.lares/supervisor/plan-surface-revival-context-2026-07-30.md` — verified code/DB facts from round 1.
2. `plans/plan-surface-revival-proposal.md` — the round-1 synthesis PLUS Revision 2 (Edward's
   corrections and north-star vision in R2.1–R2.7). Treat Revision 2 as the governing intent.

## What Edward added since round 1 (new requirements, verbatim intent)

1. **`.lares/` becomes the home of proposals and plans.** The app already constructs
   `.lares/research/` (and `.lares/supervisor/`, `.lares/workers/`) in every workspace via its
   state-dir scaffolding; it should likewise construct a space for **proposals** and **plans**.
   The `.lares` folder starts FEEDING THE APP UI — the existing Plans toolbar button draws its
   gallery from that folder's contents.
2. **CLAUDE.md / scaffold edits** so every supervisor (and perhaps workers) knows: when chat
   produces a potential feature/work idea, save a proposal markdown into that space. (Scaffold
   content lives in `src/shared/constants.ts` and deploys via version bump — the
   `scaffold-content-needs-version-bump` rule; existing workspaces are NOT auto-updated.)
3. **Gallery UX:** peruse proposals and plans, organized by date; see WHICH AGENT (supervisor or
   worker) created each; click to read.
4. **Promotion in the UI:** a user promotes a proposal → plan in the gallery. On promotion the
   user PICKS the supervisor to take charge; that supervisor **and all its workers** subscribe
   to the plan.
5. Everything else from R2 stands: proposals stay cheap markdowns (valid terminal state);
   promotion is the formality gate; planning skill runs hardening (groupthinks write INTO the
   plan via the existing plan rail); work packages sized to one worker context; checkpoint-
   derived execution trail; archived plans as historical artifacts; user is always the committer.

## Your deliverable

A TECHNICAL STRATEGY that makes this buildable — concrete file/module/schema level detail,
sequenced into shippable stages, each with its verification. Resolve (do not merely list) the
open technical questions below. Where round 1 already answered something, don't re-litigate —
extend.

## Open technical questions to RESOLVE

**A. Filesystem layout + git posture.**
- Propose the exact layout (e.g. `.lares/proposals/*.md`, `.lares/plans/<slug>/…`). One space or
  two? Where do archived plans go?
- CRITICAL TENSION: `.lares/` is currently in `.gitignore`, but plans are meant to be durable
  historical artifacts, and the two existing plan HTMLs live in tracked repo-root `plans/`.
  Decide: carve tracked subpaths out of the ignore (e.g. `!.lares/plans/`), keep them untracked
  (history then lives only on one machine — acceptable?), or another posture. State the
  recommendation and its consequence plainly. Also: what happens to repo-root `plans/` and the
  two legacy HTML files.
- Note `src/main/workspace-state-dir.ts` owns state-dir construction/renames; research space
  construction is precedent.

**B. Author attribution for proposals.** A bare markdown carries no author. Decide the
mechanism: YAML frontmatter written by the authoring agent? A DB row minted when the file
appears (watcher + file_activities lookup to attribute the creating agent)? Both? Keep it
robust to hand-authored (human) proposals. Date ordering source: file mtime vs frontmatter vs
DB created_at.

**C. Proposal registry + watcher.** Does the app watch `.lares/proposals/` (like plans-watcher
watches `plans/`)? New `proposals` DB table or reuse `plans` with `format:'md', run_state:
'proposal'`? Weigh both; pick one. Remember `plans.path` is UNIQUE per workspace and the
md-migration 400 must be lifted at the promotion seam.

**D. Promotion flow, end to end.** UI action → what exactly happens: seed `create_plan` from the
proposal md (which template/sections in the R2 world?), archive/move the source proposal, mint
the plan id, record lineage (proposal → plan provenance), open the supervisor picker. Which
existing seams are reused (`createPlanSurface`, `POST /api/plans` register-existing branch)?

**E. Subscription semantics.** Today `supervisor_focus` is supervisor-only (PK supervisor_id,
plan_id). Edward wants: chosen supervisor takes charge AND all its workers subscribe. Decide
what worker "subscription" concretely means — rows in a generalized `agent_focus` table? Or is
worker subscription = the existing plan rail (agents.plan_id frozen at launch + turn_records
stamping from Stage 1), with the supervisor's dispatches auto-binding its workers to the plan?
Prefer the minimal mechanism that delivers the visible behavior: workers launched by the
in-charge supervisor are plan-bound by default; the UI shows supervisor + bound workers. Also:
what does "take charge" surface to the supervisor agent itself (context injection at launch /
get_my_context)?

**F. Gallery UI.** Extend `PlansMenu`/`PlanCard` popover or a dedicated pane/tab (Edward
sketched a split screen: scrollable list on top, reading pane below)? Cover: date grouping,
author chip, proposal-vs-plan distinction, promote button, supervisor picker, archived filter.
Markdown proposals render in the existing file-viewer; plans keep their pane. Keep it shippable
— smallest gallery that delivers peruse/click/promote.

**G. Scaffold/CLAUDE.md edits.** Exactly which scaffold constants change (supervisor CLAUDE.md
section teaching: proposal habit + where to save + promotion model; worker variant if any), and
the version-bump/deploy consequence.

**H. Sequencing.** Fold ALL of this into the R2.7 staged sequence (Stage 0 skill / Stage 1 join
+ front door / Stage 2 board / Stage 3 composer) — produce a REVISED stage list where the
.lares space, registry, gallery, promotion, and subscription land in the right order with
per-stage acceptance checks. Call out what can ship independently and what must move together
(e.g. gallery needs registry; promotion needs md-migration lift; scaffold edit can ship
day one).

Be concrete: name files, tables, IPC channels, MCP tools. Flag any place the vision fights an
existing invariant (shared-cwd, `.claude/` write gating, checkpoint capture assumptions) and
resolve it.
