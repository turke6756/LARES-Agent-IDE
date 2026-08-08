---
plan_artifact_id: plan_e0001372
kind: human-overview
schema_version: 1
---

# Plan overview

> Written by the responsible supervisor for the workspace owner. This is the
> first hand-written example of the format this plan designs; the tooling that
> reads it does not exist yet (WP-A freezes the contract, WP-D implements the
> reader), so today this file is for people only.

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_e0001372",
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

When a supervisor plans work, it writes a folder of files. When you look at the
planning screen, the app reads its database. Nothing currently carries the
first into the second, so a plan can be complete on disk while the screen shows
almost nothing — which is exactly what happened on the first real run.

This plan connects the two. After it lands, promoting a proposal produces a
plan you can read, understand, and start from the screen, without asking an
agent to explain it in chat.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:proposal:BEGIN-->
## Why this work exists

The first end-to-end planning run worked correctly and still left you unable to
see what was going on. The promoted proposal stayed in the gallery as though
nothing had happened, the plan's own Proposal tab was blank, the work packages
never became cards, the review column stayed empty for the whole lifecycle, and
the Start button could never light up.

None of that was a mistake by the supervisor. Each was a missing connection
between the files it wrote and the screen you were looking at. There was also
no plain-language description of any plan anywhere — the only one that ever
existed was a chat message that vanished with the conversation.
<!--PLAN-TAB-SECTION:proposal:END-->

<!--PLAN-TAB-SECTION:plan:BEGIN-->
## How the work will proceed

Three questions were hard enough to deserve their own deliberations: how work
packages should cross from files into the database, where the plain-language
layer should live, and which of the two half-built promotion paths should be
the real one. All three are now answered.

The build goes in waves. First the shared foundations everything else depends
on, plus a handful of small fixes that need nothing. Then the database work,
then the two readers that turn files into screen content, then the piece that
coordinates them, and finally the promote button, the readiness checks, and the
cleanup of the old path. A last package proves the whole journey works on a
real plan.
<!--PLAN-TAB-SECTION:plan:END-->

<!--PLAN-TAB-SECTION:deliberations:BEGIN-->
## Important decisions

**The files stay in charge, but only up to a point.** Definitions of work live
on disk and the app follows them. The moment a package is actually assigned or
running, the app owns it and an edit to the files can no longer overwrite it —
it gets reported as a conflict instead. Nothing is ever deleted outright.

**One way to promote, not two.** There were two half-finished promotion paths.
The one already in use wins; the other retires carefully, so anyone with a
promotion still in progress does not silently lose it.

**Starting work stays your decision.** Everything here makes the Start button
*reachable*. Nothing makes it press itself — marking a plan ready and starting
it remain two deliberate actions by you.

**A bug turned up along the way.** The promotion machinery was naming plans
after the proposal's filename rather than the title recorded inside it. It
happens to have produced the right answer for this plan, but it would go wrong
whenever the two disagree. The fix is folded into the first work package.
<!--PLAN-TAB-SECTION:deliberations:END-->

<!--PLAN-TAB-SECTION:supplements:BEGIN-->
## Supporting material

The supporting documents hold the detailed contracts the builders work from:
the exact shape of the work-package list, the three deliberation write-ups
behind the decisions above, and the briefs each deliberation was given.
<!--PLAN-TAB-SECTION:supplements:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

Eleven packages. The first lays shared groundwork that everything else builds
on and must be done by one person alone, because three separate pieces of the
design all want to edit the same files. Alongside it, a small package fixes the
three visible annoyances that needed no debate: the promoted proposal lingering
in the gallery, the blank Proposal tab, and the review column that shows
nothing rather than explaining itself.

The middle packages build the database side, then the two readers that turn
plan files into screen content, then the coordinator that keeps them in step.
The later ones rebuild the promote button on a safer footing, make the readiness
checks work off a single shared answer, and retire the old promotion path
without stranding anything in flight.

The final package is a full rehearsal: take a proposal, promote it, and reach
the point where work can start — with no manual database fixing anywhere along
the way. That is the failure this whole plan exists to remove.
<!--PLAN-TAB-SECTION:packages:END-->
