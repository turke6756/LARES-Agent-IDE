---
name: write-proposal
description: >-
  Author a substantial, new, self-contained idea that awaits human review.
  Invoke before choosing a path for a planning, design, or idea document.
  Distinguishes proposals from memories, lessons, and plan supporting material;
  stamps the proposal contract; and stops after telling the human.
---

# Write a proposal

A proposal is how an agent starts a **substantial piece of new work that is
self-contained and awaits further review**. Writing one is the agent-native act;
everything after it waits for a human.

## 1. Threshold: is this a proposal?

Write a proposal when the idea is substantial, new, self-contained, and worth a
human decision about further investment.

Do not write a proposal for:

- a routine fix already within the current task — do the work;
- workspace state or a decision that future agents need — use `remember` to
  create a memory;
- reusable "when X, do Y" steering — use `remember` to create a lesson; or
- a document serving the deliberation of a plan to which you are subscribed —
  that is supporting material.

If the idea is durable new work awaiting review, it is a proposal, not a memory
or lesson. A proposal may remain flat forever; that is a valid terminal state.

## 2. Path: choose the visible surface

`supporting/` is reserved for a supervisor subscribed to a plan, for documents
in service of that plan's deliberation. A subscription to one plan does not make
an unrelated document supporting material. Use the subscribed plan's designated
supporting location (including its own `deliberations/` or `research/` folder
when applicable).

Everyone else's planning document goes to:

`.lares/proposals/YYYY-MM-DD-<slug>.md`

Keep proposals flat, dated, and top-level. When in doubt, use the top-level
proposal path: that is the surface the human browses, while `supporting/` hides
subordinate material.

## 3. Stamp: required frontmatter

Use this contract exactly:

```yaml
author: "<agent title verbatim>" (<lane>, <workspace>)
author_agent_id: <dashboard agent uuid>
author_role: supervisor | worker | researcher
author_provider: claude | codex | grok | agy   # optional but cheap
authored_at: <ISO-8601>
```

Also include these required fields:

- `artifact_id: prop_<8 lowercase hex>`
- `title: <human title>`

`author` must use the agent's **specific launch title verbatim**, with the lane
and workspace as shown. A generic role label such as "supervisor", "workspace
supervisor", "worker", or "researcher" **fails the contract**.

`author_agent_id` is the dashboard agent UUID from the launch context. It is the
stable join key to transcripts, checkpoints, and witnessed file activity.

Generate `artifact_id` as `prop_` plus exactly 8 lowercase hexadecimal
characters from a crypto-quality random source, never a timestamp, counter,
filename, local database UUID, or `derivePlanSku()`. Before writing, scan every
existing `artifact_id:` frontmatter value under `.lares/proposals/`, including
`.lares/proposals/supporting/`. If the candidate appears anywhere, regenerate
and scan again until it is unique.

## 4. Lead in plain language

The first body section is required and must be titled exactly:

`## In plain terms`

In ordinary words, answer: **what is this, why does it matter, and what changes
for the user?** Use no file paths, identifiers, or jargon in this section. A
non-specialist who stops there must still understand the idea. Technical detail
may follow and may be as deep as needed; the plain lead supplements it.

## 5. Write with zero further ceremony

Write plain Markdown after the required lead. Do not create a plan folder,
`plan.json`, subdirectories, intent sentinels, or lifecycle markup. Authoring a
proposal does not obligate later hardening.

## Hand-off

Tell the human the proposal exists and where it is; the lifecycle continues only
from the Plans pane.
