---
plan_artifact_id: plan_ac37e3ae
kind: human-overview
schema_version: 1
---

# Plan overview

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_ac37e3ae",
  "sections": [
    { "tab": "overview", "heading": "What this plan changes" },
    { "tab": "proposal", "heading": "Why this work exists" },
    { "tab": "plan", "heading": "How the work will proceed" },
    { "tab": "deliberations", "heading": "Important decisions" },
    { "tab": "supplements", "heading": "Supporting material" },
    { "tab": "packages", "heading": "Work packages" }
  ]
}
-->

<!--PLAN-TAB-SECTION:overview:BEGIN-->
## What this plan changes

The Save screen stops bundling work by "which files happen to touch each other"
and starts bundling it by **what you asked for**: each dispatched task becomes a
saveable unit with a readable name, grouped under its plan. Commit messages
become sentences instead of hex codes. The hundred-checkbox problem goes away —
paths are shown instead of hashes, and a whole backlog of unrecognized changes
can be acknowledged in one gesture. The screen gets fast (seconds, not minutes).

Two agents doing the same job may share files silently; the only warning left is
the genuinely dangerous case — one task's finished work being overwritten by an
unrelated task — and resolving it is a single click, never a manual merge.

Separately, each plan's implementation gets its own private working copy of the
repo, created automatically when implementation starts and merged back when the
work is saved. Everyday conversational work stays in the shared tree exactly as
today. The trusted commit machinery — the part that guarantees saving one bundle
never drags along unrelated changes — is kept unchanged and extended, not
replaced.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:proposal:BEGIN-->
## Why this work exists

An audit of the real history found the recording machinery precise but the
product unusable in practice: commit messages were meaningless codes, the screen
took about ten minutes to work through, and roughly a hundred per-file
checkboxes were demanded for changes no agent was seen making — including the
human's own edits. The proposal (already refined once through deliberation,
research, and six human rulings) diagnosed all of this and set the directions
this plan now implements.
<!--PLAN-TAB-SECTION:proposal:END-->

<!--PLAN-TAB-SECTION:plan:BEGIN-->
## How the work will proceed

Two small quick-win packages ship first and need nothing else: readable commit
messages plus sane acknowledgements, and the speed fix. The architecture then
lands in seven staged packages behind a feature flag: task identity is minted at
dispatch; the Save screen regroups around it; the collision policy and its
one-click resolver arrive; the commit contract is upgraded; per-plan working
copies are provisioned and later merged back safely; and a final package retires
the old grouping only after everything else has proven itself end to end. Two
riders add provenance labeling ("Assisted-by") with durable local evidence, and
an optional per-repo check that a save actually builds before it commits.
<!--PLAN-TAB-SECTION:plan:END-->

<!--PLAN-TAB-SECTION:deliberations:BEGIN-->
## Important decisions

Two independent planners designed the architecture and converged. The notable
calls: a task (one dispatched brief) is the unit of saving, finer than a plan
item; collision detection compares the actual file contents recorded before and
after each turn, not whole-project snapshots; the system never guesses that
later work "intentionally replaced" earlier work — that call is always the
human's; each plan's working copy lives outside the repo on internal
bookkeeping, invisible to ordinary git; cleanup never force-deletes anything it
cannot prove is safe; and when work built on other work can't be separated, the
two are committed together with both credited, rather than blocking anyone.
<!--PLAN-TAB-SECTION:deliberations:END-->

<!--PLAN-TAB-SECTION:supplements:BEGIN-->
## Supporting material

The supplements folder holds the work-package breakdown — eleven packages, each
with its scope, acceptance criteria, and verification steps written to fit a
single worker.
<!--PLAN-TAB-SECTION:supplements:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

Eleven packages. Ready now, in order: the two quick wins (readable Save screen;
speed), then task identity, Save-screen regrouping, collision policy, the
upgraded commit contract, per-plan working copies, and merge-back. Two riders
(provenance labeling; optional build-check before save) follow the commit
contract. The final cutover package is blocked until everything before it lands
and the full end-to-end scenarios pass. Hunk-level attribution — splitting one
file between two authors — is deliberately deferred until the task model exists.
<!--PLAN-TAB-SECTION:packages:END-->
