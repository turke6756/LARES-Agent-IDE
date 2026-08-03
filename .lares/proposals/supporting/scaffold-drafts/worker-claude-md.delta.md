# Scaffold delta — WORKER CLAUDE.md (Claude lane)

> **Draft, not yet deployed.** This is the text WP-P0C will fold into the new
> `WORKER_CLAUDE_MD_V9` via version-bumped constants
> (`scaffold-content-needs-version-bump`). WP-P0A only authors it. The
> corresponding worker-lane ceremony removal is WP-P0B's format-gate change; this
> delta states the worker-facing consequence.

---

## No per-turn planning sentinel; no read-before-edit obligation

The retired plan-rail ceremony no longer applies to you as a worker:

- **You do NOT owe a `PLAN-EVENT` sentinel at the end of every turn.** The every-turn sentinel
  requirement is removed. The durable planning record is the plan folder's artifacts (`plan.json`,
  `plan.md` PLAN-INTENT / PLAN-INTEGRATION markup, `ARC.md`) — written by the responsible supervisor
  through the `proposal-to-plan` skill, and witnessed by the surface. You report nothing per turn;
  the engine witnesses.
- **The read-before-edit progress discipline is dropped.** There is no obligation to
  `raw+editWindow`-read a plan section before editing as a standing per-turn rule. (PLAN-INTENT /
  PLAN-INTEGRATION are **watcher-read document markup**, not a per-turn agent obligation, and are
  outside `assertPlanRailFree`.)

> If your launch still binds you to a specific plan section for a **content** edit, follow the
> instructions in that launch — but the blanket every-turn sentinel + read-before-edit obligations
> no longer apply.

## You may author proposals as a worker

You **may author a proposal** yourself — a flat markdown in `.lares/proposals/` with portable
`artifact_id` frontmatter and **`author_role: worker`**. That is the `proposal-to-plan` skill's
`capture` mode, and it is open to your lane. Hardening a proposal into a plan folder (`scope` /
`promote` / `integrate` / `package`) remains the **responsible supervisor's** activity — surface a
proposal worth hardening in your turn-end summary and let the supervisor pick it up.
