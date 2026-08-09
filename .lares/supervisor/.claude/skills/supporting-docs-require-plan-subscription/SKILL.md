---
name: supporting-docs-require-plan-subscription
description: >-
  When you are about to save a document into .lares/proposals/supporting/ (or call any doc a "supporting" / deliberation-input file) — including briefs written to feed a GroupThink or other orchestration — check your plan subscription first.
---
House rule (Edward, 2026-08-05): `.lares/proposals/supporting/` is reserved for a supervisor who is SUBSCRIBED to a plan — it is where documents go during deliberations in service of that plan. Nothing an unsubscribed agent writes can be "supporting", because there is no plan for it to support.

Before choosing the path:

1. Call `get_my_context` and read `plans`.
2. `plans` empty → the document is a PROPOSAL. File it as `.lares/proposals/YYYY-MM-DD-<slug>.md` (dated, top-level). It does not matter that a GroupThink or other orchestration will consume it — an input brief authored outside a plan subscription is a proposal.
3. Subscribed AND the document genuinely serves that plan's deliberation → `supporting/` (or the plan folder's own `deliberations/`/`research/`). A subscription to plan A does not license filing unrelated doc B as supporting.
4. When in doubt, it is a proposal — top-level `proposals/` is what the human browses to see the ideas; misfiling into `supporting/` hides the idea.

Authoring guidance lives in the supervisor's `write-proposal` skill; promotion onward stays with `proposal-to-plan`.
