# Code review

A **workflow / prompt example** — a prompt to adapt, not a runnable script.

**Pattern:** cross-provider groupthink (see
[docs/workflows.md](../../docs/workflows.md#cross-provider-groupthink)).

## Roles

- **Supervisor** — frames the review question, convenes a groupthink deliberation
  between two reviewer agents, and lands the agreed findings on the planning
  surface.
- **Two reviewer agents** — ideally from two different providers, so they bring
  independent perspectives. They exchange messages over structured rounds and
  converge on a shared set of findings.

## How to run it

1. Open the workspace containing the diff or files you want reviewed.
2. Launch a **supervisor** agent and give it a prompt like the one below.
3. When the two reviewer cards go busy, attach to either one to watch its
   reasoning and see the two sessions converge.

## Example prompt (to the supervisor)

```
Review the changes on the current branch for correctness bugs and risky edge
cases. Convene a two-agent groupthink between two reviewers (use two providers
if available). Have them each review independently first, then deliberate to
reconcile disagreements. Produce a single findings list ranked by severity, and
note anywhere the two reviewers disagreed and why. Land the result on the
planning surface.
```

## What to expect

Two agent cards deliberate over several rounds and converge; the reconciled
findings land on the planning surface. Two reviewers catch failure modes a single
reviewer misses — but this is a review aid, not a guarantee of correctness. Verify
the findings before acting on them.
