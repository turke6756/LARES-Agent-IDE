---
plan_artifact_id: plan_ce97b9ad
kind: human-overview
schema_version: 1
---

# Plan overview

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_ce97b9ad",
  "sections": [
    { "tab": "overview", "heading": "What this plan changes" },
    { "tab": "proposal", "heading": "Why this work exists" },
    { "tab": "plan", "heading": "How the work will proceed" },
    { "tab": "deliberations", "heading": "Important decisions" },
    { "tab": "research", "heading": "What we investigated" },
    { "tab": "supplements", "heading": "Supporting material" },
    { "tab": "packages", "heading": "Work packages" }
  ]
}
-->

<!--PLAN-TAB-SECTION:overview:BEGIN-->
## What this plan changes

After the recent audit of how this workspace plans and executes work, this plan
fixes the four weaknesses it exposed. First, the two misleading readouts get
repaired: the "files touched" display will stop presenting an agent's whole
history as one turn's activity, and plan summaries will visibly say when they
have gone stale. Second, "done" starts meaning reachable-and-working: every
piece of work that adds behavior must declare its real entry point into the
application and prove — by temporarily removing the connection and watching the
test fail — that its tests actually travel through it. Third, the system gets a
reliable machine record of its own work: which packages were dispatched, gated,
committed, and deployed, kept in the database and renderable without any
forensic cross-referencing. Fourth, plan folders become properly
version-controlled, including the identity file that today has no history at
all.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:proposal:BEGIN-->
## Why this work exists

An independent audit scored the planning surface 42 out of 68, and two defects
stood out. A piece of work passed all its tests and was marked finished while
being completely unreachable by the running application — and that happened
twice, in two different ways. And the system could not show its own history:
finished work still displayed as blocked, and the links between decisions,
dispatched work, and resulting code were simply missing. The proposal converts
those findings into buildable work, in a deliberate order: fix the readouts we
use to verify everything else first, then the reachability hole, then the
record-keeping. Two displays that nearly caused a false accusation during the
audit itself are first in line.
<!--PLAN-TAB-SECTION:proposal:END-->

<!--PLAN-TAB-SECTION:plan:BEGIN-->
## How the work will proceed

Eighteen work packages in four groups. Group A (two packages) repairs the
misleading readouts and lands first because everything else is verified through
them. Group B (four packages) builds the reachability proof: a required
entry-point declaration on every behavior package, a proving tool that removes
the declared connection in a throwaway copy and demands the test fail, and
updated instructions for every worker. Group C (three packages) adds a
consistency check for package documents and two levels of write-containment for
research lanes, up to an operating-system-enforced sandbox. Group D (nine
packages) builds the machine record: new database tables for gate outcomes,
verified commits, deployment state, and continuation handoffs; one single
service through which all package-state changes flow; a display that renders a
plan entirely from the database; and version control for every durable plan
file. Nothing in this plan pushes to a remote or restarts the app — deployment
remains a separate, human-triggered step.
<!--PLAN-TAB-SECTION:plan:END-->

<!--PLAN-TAB-SECTION:deliberations:BEGIN-->
## Important decisions

Two design debates were run before packaging. The reachability debate settled
what can be machine-enforced versus what stays human judgment: document
validation is enforced automatically on ingestion; the removal-test proof is
generated and recorded now but only blocks completion once the new record
system's completion check ships — until then this remains an honestly-stated
partial fix. It also confirmed that simply checking "a registration exists" is
not enough, because test doubles can fake the missing connection; the proof
must also confirm no test hand-supplies something production is supposed to
create. The record-keeping debate concluded the database is the authority for
execution facts while git holds the portable plan documents; it added only four
new tables after proving most of the needed infrastructure already exists, and
decided the plan identity file will be version-controlled rather than
regenerated from the database.
<!--PLAN-TAB-SECTION:deliberations:END-->

<!--PLAN-TAB-SECTION:research:BEGIN-->
## What we investigated

Two investigations fed the design. A read-only forensic dig into three
suspicious "failed" turn records proved they were a recording bug, not real
conflicts: the handoffs they described actually succeeded, but a race in the
bookkeeping orphaned their records, and the startup repair pass only looked at
the newest fifty rows so one stayed marked open. The fix specification from
that dig is built into the record-system packages. A web research pass compared
the sandboxing abilities of all four agent providers on Windows and found only
one has a real operating-system sandbox today; instruction-level guards can be
bypassed by any shell command. The containment packages therefore build an
OS-level wrapper rather than relying on per-provider hooks.
<!--PLAN-TAB-SECTION:research:END-->

<!--PLAN-TAB-SECTION:supplements:BEGIN-->
## Supporting material

The supplements folder holds the work-package document: eighteen packages, each
with its file list, dependencies, task description, acceptance criteria,
non-goals, and verification steps, plus the machine-readable block the dashboard
projects into its package board.
<!--PLAN-TAB-SECTION:supplements:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

Eighteen packages. Ready to start immediately: the two readout repairs, the
document-consistency check, the first containment tier, the identity-validation
package, the database schema, and the version-control policy. The rest unblock
as their prerequisites land — the proving tool after the schema that stores its
evidence, the transition service after the schema, the rerouted writers and
ingestion seams after the service, and the final acceptance fixture last, which
replays a real historical project from database records alone and must
reproduce its verified thirteen-commit history exactly.
<!--PLAN-TAB-SECTION:packages:END-->
