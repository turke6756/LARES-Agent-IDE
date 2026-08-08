---
plan_artifact_id: plan_65e665d7
kind: human-overview
schema_version: 1
---

# Plan overview

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_65e665d7",
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

This plan grades the planning system against itself. Over the last week that system — write an
idea down, argue it out, cut it into pieces, hand the pieces to workers, check the results — went
from a design to something used in earnest. Nobody has yet asked whether it actually helped.

This plan answers that. It produces one written report with scores, specific evidence for every
score, and a ranked list of what to fix first. The report is deliberately allowed to conclude that
parts of the process were not worth their cost.

Two things make it more than a formality. First, the auditors compare what agents **said** they did
against what the record **shows** they did, and treat the gap between those as the most interesting
finding. Second, the auditors are forbidden from fixing anything they find — an auditor that repairs
the thing it is measuring has destroyed the measurement.

Preparing the audit turned up real problems in the audit instructions themselves, which this plan
fixes before anyone runs it: the instructions told the auditor to use two tools that no longer
exist, and one of the scoring categories would have **penalised** agents for correctly following the
current rules. Fixing those first is most of the early work.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:proposal:BEGIN-->
## Why this work exists

A lot of process was built quickly and then used hard. The risk with any process is that it becomes
paperwork: people fill it in, it prevents nothing, and nobody notices because the forms all look
complete. The only way to tell the difference is to go back over what actually happened and check.

The original proposal is a grading sheet for exactly that. It sets out what to look at, how much to
trust each kind of evidence, and how to score seventeen separate dimensions — from whether an agent
arriving cold could get oriented without a human re-explaining, through whether instructions
contradicted themselves, to whether the supervisor's own checking was real or just a restatement of
what the worker claimed.

It is unusually honest about its own risks. It warns the grader not to reward complete paperwork,
not to treat activity counts as productivity, and not to claim something never happened without
first proving it looked somewhere that thing would have shown up.
<!--PLAN-TAB-SECTION:proposal:END-->

<!--PLAN-TAB-SECTION:plan:BEGIN-->
## How the work will proceed

Five steps, in order.

The first three are preparation and can be done by a worker: correct the audit instructions against
how the system actually works today; move the "here is what we expect you to find" list out of the
instructions into a sealed file; and write the three dispatch briefs that the auditors will
actually receive.

The last two are the audit itself. Two collectors gather raw evidence in parallel — one covering
what the agents said and did, one covering what ended up written down — and hand back standardised
packets without scoring anything. Then a single lead auditor does the scoring, builds the
end-to-end trace, and writes the report. The lead is required to go back to original sources rather
than trust the collectors' summaries.

There is one deliberate piece of theatre with a real purpose: the lead writes its conclusions with
the expectations list still sealed, those conclusions are locked and fingerprinted, and only then is
the list revealed. Anything the lead changes afterwards is marked as a change made after seeing the
answers. This is what stops the audit from simply confirming what its author already believed.

**One thing needs your confirmation before the audit runs** — see the last item under Important
decisions.
<!--PLAN-TAB-SECTION:plan:END-->

<!--PLAN-TAB-SECTION:deliberations:BEGIN-->
## Important decisions

**The audit is smaller and more structured than originally proposed.** The proposal imagined one
agent doing a multi-hour read of everything. That would not have finished: it would have run out of
working memory partway and quietly started summarising instead of reading, which is the failure mode
the audit exists to detect. The deliberation replaced it with two evidence gatherers plus one
scorer, with hard limits on how much each may read and a stated rule for what gets sampled and what
gets skipped — and the report must disclose that rule, so nobody mistakes a partial read for a
complete one. The cross-cutting analysis, which is the most valuable part, stays with the single
lead so it does not get fragmented.

**Nobody grades their own work.** The audit instructions, and the list of expected findings attached
to them, were written by one of the supervisors whose work is being audited. That is a real conflict
of interest, so the rules are explicit: no agent that wrote the instructions, took part in the run
being audited, handed out its work, or checked its results may serve as an auditor. That
disqualifies the author, and it disqualifies me. The final report has to name the conflict out loud
rather than leave a reader to discover it.

**One promise is being deliberately downgraded rather than quietly dropped.** The deliberation asked
for the auditors to be locked down mechanically — run against a frozen read-only copy of everything,
with credentials that physically cannot write. That infrastructure does not exist here, and building
it would turn "run one audit" into "build an audit sandbox". So the audit uses the restrictions that
do exist and then checks afterwards that nothing was modified — and the report must say plainly that
this was checked after the fact rather than prevented. It is a weaker guarantee and it is recorded
as one.

**Who is being reviewed — now settled.** The audit document was ambiguous: most of it describes
reviewing the entire planning system, while an added paragraph asks for a performance review of one
agent across several sessions, without naming which. You have since identified the subject, and it
has been confirmed against the records rather than taken on trust. It is the supervisor titled "new
propsoal", which ran the pipeline across multiple sessions for the save-card streamlining plan of
6 August. My earlier guess named a different supervisor and a different plan; that was wrong and has
been corrected everywhere it appeared.

That correction has a consequence worth knowing. The list of expected findings attached to the
rubric describes a **different** run — the one its author was working on. So those expectations
cannot be reproduced inside the run actually being reviewed, and an auditor that goes looking for
them there would invent problems. They are now explicitly scoped to the system-wide sweep only, and
the rules say plainly that failing to find them in the case study is expected rather than a defect.

**Questioning the agent is now allowed, with conditions.** The original rules forbade the auditor
from asking anyone anything. You have lifted that, and it is a genuine improvement — but it needs
guard rails, because the agent being reviewed is still running and still holds write access to the
very records being examined. So: questions come only *after* the evidence is gathered and the
conclusions are locked, never before, so testimony cannot steer what the auditor goes looking for.
Answers count as the agent's account, not as fact, and can never be the only thing behind a finding.
Questions must be inert — asking it to *check* or *refresh* something would contaminate the
measurement exactly as an auditor's own edit would.

**One time-sensitive thing.** That agent has an outstanding offer to run a routine refresh on its own
plan. That refresh rewrites the plan's summary and its freshness timestamps — which is one of the
things the audit measures. If it runs mid-audit, the auditor measures the refresh instead of the
work. **The plan needs to stay frozen until the audit's conclusions are locked**, and that is now
the first step of the collection package.
<!--PLAN-TAB-SECTION:deliberations:END-->

<!--PLAN-TAB-SECTION:supplements:BEGIN-->
## Supporting material

There is one supporting document at present: the work-package breakdown, which contains the five
packages summarised below, each with its file list, prerequisites, acceptance conditions and
explicit non-goals.

Two more will be created by the early packages — the sealed list of expected findings, and the three
dispatch briefs the auditors will receive.
<!--PLAN-TAB-SECTION:supplements:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

1. **Correct the rubric against the current tree** — fix the instructions that reference two removed
   tools, and replace the scoring category that would have penalised agents for following the
   current rules. Also fixes a scoring flaw where a clean run with no incidents could not earn full
   marks, because several top scores required something to have gone wrong.
2. **Seal the calibration set** — move the "expected findings" list into its own file, record a
   fingerprint of it, and leave a note in its place explaining that it is withheld until the auditor
   has committed to its own conclusions.
3. **Write the three dispatch briefs** — one per auditor, each complete enough to hand over with no
   further explanation: what to collect, where to write it, how much to read, and what it is
   forbidden from doing.
4. **Run evidence collection** — check both candidates are eligible, dispatch the two collectors,
   and check their returned packets against the required format. Blocked until 1–3 are done.
5. **Lead audit pass and final report** — the independent scoring pass, the lock-and-fingerprint
   step, the reveal, one follow-up pass, and the final report. Blocked until 4 is done.

Packages 1–3 are ready to start. The audit report lands in the workspace research inbox, which is
the holding area for material that has not yet been reviewed and accepted — that is deliberate: the
report is evidence for a decision, not a decision.
<!--PLAN-TAB-SECTION:packages:END-->
