---
artifact_id: prop_37cf5261
title: Planning surface human-experience overhaul
author: "Planning Surface Refinement" (supervisor, AgentDashboard)
author_agent_id: 93dff0ee-b4cb-42a2-ac32-0d4a04c46ff0
author_role: supervisor
author_provider: claude
authored_at: 2026-08-08T00:00:00Z
---

# Planning surface human-experience overhaul

Source: verbatim user feedback from Edward, 2026-08-08, after using the
deployed planning surface (Plans pane, promoted-plan cards, plan viewer,
plan review tab). Captured by the supervisor; nothing here is invented —
each item traces to a specific complaint or request.

## In plain terms

The planning area of the app now works for the machines but not yet for the
person using it. You cannot delete an old idea from the screen. Once an idea
becomes a plan, the screen never tells you who is working on it, whether it is
being worked on right now, or whether it is finished — it just says "promoted"
forever. Opening a plan shows a cluttered page with a side column for comments
that duplicates a better commenting system the app already has, and a long
"overview" that pushes the real content out of the way. The "review" view,
which was meant to show at a glance how many pieces of work are done and how
many remain, does not work at all. And the documents the agents write are
written for other agents — dense and technical — leaving the person with no
simple version they can use to build their own understanding and take part in
the thinking. This proposal is a set of changes to make the whole planning
surface legible, navigable, and honest about progress for the human, while
keeping the technical depth the agents need.

## Feedback items (the requirements)

### 1. Delete proposals from the UI

Users must be able to delete a proposal from the Plans pane, and deletion must
be real: it removes the proposal file from disk (and any associated DB rows /
supporting linkage), not just hides it.

Open question: what happens to a proposal that has already been promoted —
presumably deletion is only offered (or only simple) for un-promoted flat
proposals; promoted ones are governed by item 2's lifecycle.

### 2. Promoted-plan lifecycle status on the card

Today a promoted plan shows `PROMOTED` forever. Required:

- **Ownership**: show which supervisor is subscribed to / owns the plan (the
  last `assigned` event in `plan.json` is the existing source of truth), so
  the user can jump to that agent in the dashboard.
- **Activity**: a simple live indicator (a "blinking light" — nothing fancy)
  when the plan is actively being worked in the dashboard (owner supervisor
  live / plan-bound agents running).
- **Completion**: the status must eventually change — e.g. `PROMOTED` →
  `IMPLEMENTED` / `COMPLETED`. The likely mechanism: the owning supervisor
  explicitly reports the plan complete (a lifecycle event appended to
  `plan.json`, surfaced on the card). The proposal-to-plan skill would gain a
  `complete`/`close` step so supervisors actually do this.

The bar to meet: glancing at the promoted-plans list tells you which plans are
done, which are in flight right now, and who to go look at.

### 3. Plan viewer: comments column must go

The separate comments column/section in the plan viewer is not what was asked
for. The app already supports highlighting markdown and attaching comments in
the file viewer; the planning surface must use **that same mechanism** —
inline highlight-anchored comments, no separate column.

### 4. Plan viewer: overview collapsible, default collapsed

The human-readable overview is nice but currently gets in the way of the real
markdown. It should render as a slim bar ("Simple overview" or similar) that
expands on click. **Default collapsed.**

### 5. Plan review tab: complete rethink as work-package progress

The current review tab does nothing useful ("nothing about it works — review
does not work, packages does not work"). Its entire intended purpose, per
Edward: **a quick way to see what landed** — which work packages exist, which
are complete, how many remain. A visual checklist of work packages with
done/remaining state is the target shape. It is acceptable to conclude during
scoping that the tab should be removed entirely if the card-level status
(item 2) plus a simple package checklist elsewhere covers the need.

### 6. Work packages surface is wrong today

Work packages currently appear under the **Supplements** tab as a messy body
of machine text (`plan_artifact_id: … kind: work-packages schema_version: 1`).
That machine block is unreadable and confusing to the user. Work packages need
a proper human rendering (feeding item 5's checklist), with the machine block
demoted to an implementation detail — not the thing the user sees.

(Supervisor note from execution history: the machine `PLAN-WORK-PACKAGES:v1`
block has also mis-scoped dispatches twice; the prose **Files** list is the
dispatch authority. Any rework here should keep prose as authority.)

### 7. Dual-register authoring: agent-technical + human conceptual model

The core tension Edward named: agents deliberate and write in their native
technical register — correct for the agents who execute the work, but too
complicated for the human collaborator. The human must be able to build a
**conceptual model** and participate in the thinking. Two surfaces are
mission-critical for this:

1. **The proposal** — the `write-proposal` skill should prompt the authoring
   agent to include a very simple, high-level conceptual model for the user
   (the existing "In plain terms" lead is the seed of this; it may need to be
   strengthened/extended — e.g. a short conceptual-model section that explains
   the moving parts and how they relate, not just a summary).
2. **The work packages / implementation plan** — each work package stays
   written for an agent, but must carry a one-or-two-line plain-language
   gloss so a user scanning the package list understands what each one does.
   Lower priority: a plain-language digest of what the deliberations found.

The pattern throughout: one markdown that serves both registers — technical
body for agents, collapsible/adjacent plain overview for the human — rather
than two divergent documents. The proposal-to-plan and write-proposal skills
are the enforcement point: they should instruct agents to produce both
registers every time.

### 8. Supervisor progressive-disclosure ingestion of any plan

Agent-side requirement, with verification: any supervisor must be able to walk
up to any planning surface and ingest it **progressively** — first a cheap
high-level read (what is this plan, what stage is it at, is it complete, who
owns it), descending into full markdown only where needed — instead of having
to read every file. The `read-planning-surface` skill + `orient` mode are the
existing seeds, but Edward's judgment is "we have not achieved it yet."
Acceptance should include an actual agent verification run: a fresh supervisor
pointed at an unfamiliar plan folder demonstrates staged comprehension at
bounded token cost.

## Suggested scoping shape (non-binding)

- **UI cluster**: items 1–6 (Plans pane deletion, card lifecycle/ownership/
  activity, viewer comments + collapsible overview, review-tab rethink,
  work-package rendering). Renderer + main IPC + plan.json lifecycle events.
- **Skills cluster**: item 7 (write-proposal + proposal-to-plan scaffold
  changes — note scaffold version-bump discipline applies) and the
  supervisor-side completion-report step feeding item 2.
- **Agent-verification cluster**: item 8, which depends on 2 (completion
  state) and 6 (structured package state) to have something cheap to read.

Items 2, 5, 6 interlock: plan lifecycle state + per-package completion state
are the same underlying data; design that data model once and let the card,
the review checklist, and the supervisor ingestion path all read it.

## Status

Awaiting human review in the Plans pane. Lifecycle continues only from there.
