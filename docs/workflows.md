# Workflows

The patterns Lares is built for. Each one is a way of putting **more than one
agent** to work while keeping every agent visible and interruptible. For the
mechanics behind these, see [Architecture](./architecture.md).

Copyable, worked examples live in [`examples/`](../examples/) — each is a short
brief with roles and an example prompt you can adapt. These are **workflow /
prompt examples**, not runnable scripts.

## Supervisor and worker waves

The workhorse pattern. You launch a **supervisor** agent into a workspace and give
it a goal. The supervisor decomposes the work and delegates **waves** of it to
**workers** (execution) and **researchers** (read-only digging that writes findings
to a research store). Each delegated agent runs in its own live session; the
supervisor watches their status, reads their chat and files-touched when it needs
to, and folds their results back together.

You supervise the supervisor. Because every worker is an attended session, you can
attach to any one of them mid-wave, read what it is doing, and take over if it
drifts — the supervisor keeps coordinating around you.

**Good for:** a multi-part task where one agent would run out of context or
serialize work that could run in parallel — a broad refactor, a research report
assembled from many sources, a sweep across many files.

→ [`examples/research-report`](../examples/research-report/) shows a supervisor
fanning a research question out to researcher agents and assembling a cited report.

## Cross-provider groupthink

When a decision benefits from more than one perspective, a supervisor can convene
a **groupthink** deliberation: a structured, multi-round exchange between agents —
including agents from **two different providers** — where a script guarantees the
turn order and aggregation while the agents supply the judgment. The deliberation
converges on a conclusion that lands on the planning surface.

Groupthink is the pattern that most visibly exercises Lares' multi-card,
attach-to-chat UI: two agent cards go busy, you attach to either one to watch its
reasoning, and you see the two sessions exchange messages and converge. Convening
one is a judgment call (policy); the protocol that runs it is deterministic
(mechanism).

It comes in two flavors. **Parallel** gives both agents the *same* prompt and
lets each reach its own solution independently, then shows them each other's
answers to reconcile across a few rounds until they converge — the way to pin
down the *shape* of a solution before committing to it. **Serial** is an
adversarial review: one agent leads with a proposal and the other tries to poke
holes, then they refine back and forth toward consensus.

A supervisor knows both, which unlocks a strong sequence: **talk it through with
the supervisor** so it has your intent, let it run a **parallel** groupthink to
settle the shape, then a **serial** one to harden it. By the time you implement,
most of the surprises have already been argued out.

**Good for:** a design decision, a plan review, or an ambiguous trade-off where a
single agent's first answer shouldn't be the last word.

→ [`examples/code-review`](../examples/code-review/) uses a two-agent review pass
to catch what one reviewer misses.

## Notebook-driven work with a live kernel

Agents can drive a **live Jupyter kernel** — the same kernel you see in the
notebook view. An agent executes cells, reads the outputs, iterates on the code,
and the results persist in the notebook file without "file changed on disk"
prompts. Because it is the same kernel, you can grab a cell and run it yourself
mid-task; intervention is takeover, not restart.

**Good for:** cleaning up an experimental notebook, validating that every cell runs
end to end, or turning a scratch analysis into something presentable.

→ [`examples/notebook-cleanup`](../examples/notebook-cleanup/) walks an agent
through repairing and validating a notebook against its live kernel.

## Document review with in-band comments

Lares' Markdown editor supports **agent-visible comments** anchored to specific
lines. You point at a line, leave a comment on *that* line, and an agent picks it
up as an in-band instruction tied to the exact spot — instead of describing the
change out-of-band in a side chat. The agent edits the same document you are
reading, so the review loop is a shared artifact, not two copies to reconcile.

**Good for:** iterating on a plan, a spec, or any prose document with an agent,
where "change this paragraph" needs to point at *this* paragraph.

## Browser-driven tasks under an access policy

Agents can drive Lares' embedded browser — the same tab you can grab — to look
things up, work through a web flow, or gather information. Every action passes
through an access-policy layer and is written to an audit log. **These boundaries
are partial**: the browser will act in whatever sessions you are signed into.
Read [Security](./security.md) before pointing an agent at the browser, and keep
sensitive logged-in accounts out of it during alpha runs.

## Read next

- [`examples/`](../examples/) — the three worked examples.
- [Architecture](./architecture.md) — the mechanisms underneath these patterns.
- [Security](./security.md) — the guardrails, and where they stop.
