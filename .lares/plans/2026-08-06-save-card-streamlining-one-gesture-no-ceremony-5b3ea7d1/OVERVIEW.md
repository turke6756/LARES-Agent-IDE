---
plan_artifact_id: plan_5b3ea7d1
kind: human-overview
schema_version: 1
---

# Plan overview

<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_5b3ea7d1",
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

Saving your work should feel like pressing save. After this plan, you tick one
box at the top of the save surface, walk away, and come back to everything saved.
The app writes its own commit descriptions, shows you a spinner wherever it is
thinking, speaks in ordinary sentences, and interrupts you only when something is
genuinely wrong.

The reason it does not work that way today is small and specific: each successful
save nudges the repository forward, and that movement made every other pending
save look out of date — even when not one byte of those files had changed. So the
app kept stopping to ask you to redo steps you had already done. This plan
teaches it to tell "the repository moved" apart from "your files changed", and to
stay quiet about the first.

Two things worth knowing before you start it. First, the review found a real
safety gap that already exists today, unrelated to this feature: there is a brief
moment during every save where another agent can write to a file after the app has
checked it but before the commit is made, and those unreviewed bytes can land in
your commit. Saving many packages in a row would hit that moment many more times,
so the plan fixes it first rather than building on top of it. Second, that fix
changes how commits are constructed, which affects Git hooks and commit signing.
That was a decision for you, and you made it on 2026-08-06: hooks do not run on
saves made through this app. It costs nothing today — this repo has no hooks
installed and no commit signing configured.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:proposal:BEGIN-->
## Why this work exists

You sat down to save about fifty files of finished work and found the flow
unusable: seven saves went through and the rest piled up behind errors. The
errors asked you to redo steps, re-confirm things you had already confirmed, and
type descriptions the app could have written itself — three commits ended up
titled "ok". Your bar was stated plainly: just save and move on, with no refusals
unless something is truly wrong and no required messages.

The proposal carries that bar verbatim, along with the evidence: which saves
landed, which stalled, and exactly which piece of the app's bookkeeping caused
the cascade.
<!--PLAN-TAB-SECTION:proposal:END-->

<!--PLAN-TAB-SECTION:plan:BEGIN-->
## How the work will proceed

The work splits into two independent halves.

The larger half rebuilds the decision the app makes when it asks "is what I am
about to save still the thing you looked at?" It gets a precise answer that
allows the repository to move underneath you, allows a file already saved earlier
in the same sweep to drop out, and refuses everything else — a changed byte, a
changed rename, changed ownership, or a safety check that no longer passes. On
top of that sits the batch itself, which runs inside the app rather than the
window, saves one package at a time, and stops cleanly the moment anything
uncertain happens rather than plowing ahead.

The smaller half needs none of that and can proceed in parallel: better
auto-written commit messages, the loading indicators, and the plain-language
rewrite of every message you see.

Three packages are held until earlier ones land. Nothing is waiting on you — the
hooks-and-signing call is answered.
<!--PLAN-TAB-SECTION:plan:END-->

<!--PLAN-TAB-SECTION:deliberations:BEGIN-->
## Important decisions

A two-model deliberation examined the fix the proposal suggested and rejected it
as written — it was simultaneously too loose and too strict. Too loose because
comparing only the files' raw contents misses a rename quietly changing what gets
committed, and misses a change in who worked on a file that alters whether you
must be asked about it at all. Too strict because once a file has genuinely been
saved earlier in the same batch, insisting it still be there blocks the rest of
the batch for no reason.

What replaced it: the app compares everything it showed you, allows a file to
drop out only when it can prove that exact file is already saved, and never
allows anything new to appear. Being asked to confirm shared or unattributed work
now happens once per batch instead of once per card, and only for the specific
items you have not already seen.

The review also found two pre-existing bugs while looking, both now folded into
the work, and it scoped one of your requirements down honestly: the app cannot
currently tell "another agent's work" from "your own", because nothing records
which human is acting. Rather than pretend otherwise, that wording changes to
what the app can actually prove.
<!--PLAN-TAB-SECTION:deliberations:END-->

<!--PLAN-TAB-SECTION:supplements:BEGIN-->
## Supporting material

One supplement holds the ten work packages in full: what each one touches, what
it must achieve, what it must not do, and how to check it. It is the document a
worker is handed when a package is dispatched.
<!--PLAN-TAB-SECTION:supplements:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

Ten packages. Three can start immediately and independently; the rest are ordered
because each depends on the one before it.

Ready now:

1. **The shared description of what a save contains** — the vocabulary everything
   else is written in.
2. **The plain-language rewrite** — every message and control you see.
3. **Better commit messages** — derived from the work itself instead of a generic
   count.

Then, in order: fixing the ownership bug found during review; binding renames
into the check so nothing can slip in unnoticed; the new decision about what may
carry across a save; the safer way of building commits; the batch engine; the
window changes that use it; and finally the one-click control with its progress
indicators.

**The package that was held for you is released.** The safer commit construction
changes how Git hooks and commit signing behave. You decided on 2026-08-06 that
they stop running on saves made through this app, rather than running a
reduced non-modifying subset. The choice is free today — this repo has no hooks
installed, no `core.hooksPath`, no husky, and no commit signing — so nothing that
exists is being skipped. The package must state the bypass plainly in the code
and docs, so if hooks are ever added, whoever adds them finds out immediately
instead of wondering why theirs never run.
<!--PLAN-TAB-SECTION:packages:END-->
