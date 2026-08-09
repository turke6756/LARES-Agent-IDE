---
artifact_id: prop_7c4f2a91
title: Make the remember skill an observable knowledge-placement workflow
author_role: worker
authored_at: 2026-08-03T00:00:00-07:00
---

# Proposal: make `remember` observable and complete

## Problem

Lares has several durable-knowledge destinations, but the `remember` skill does
not yet provide a complete, observable workflow for choosing and persisting among
them. The current contract distinguishes workspace memory, reusable lessons, and
graduation to project documentation. That taxonomy is sufficient and should stay
small.

The current implementation already provides meaningful pieces:

- a v2 workspace memory index at `.lares/supervisor/memory/MEMORY.md`;
- launch injection of the active index for supervisors;
- on-demand `recall_memory` for detail bodies/closed history;
- transactional lesson publishing;
- graduation proposals targeting root `CLAUDE.md` or `AGENTS.md`.

The visible workspace currently contains only inline memory capsules. This is
valid: progressive disclosure is optional and is represented by an index capsule
with a `detail:` pointer plus a file under `memory/details/`. There is no
automatic size-based split. The current worker branch of `remember` is weaker:
it tells a worker to draft a memory and hand it to the supervisor, but provides
no durable worker-to-supervisor memory-submission path. A skill invocation alone
therefore leaves no filesystem evidence unless a supervisor applies the draft.

There is also no reliable evidence surface answering whether the skill was merely
advertised, invoked, classified correctly, persisted, or later recalled. Lessons
and positive user preferences should be valid lesson inputs alongside hard-won
technical fixes, while workspace memories should remain intentionally ephemeral
and subject to expiry, stale review, and culling.

## Proposed behavior

Keep the existing three-way destination model, while making the boundaries
explicit in `remember`:

1. **Workspace memory** — current, workspace-specific facts, open loops,
   temporary decisions, and warnings. Short capsules remain inline in
   `MEMORY.md`; long or closed bodies may live under `memory/details/` and are
   fetched on demand. Active memories must name an exit (`expires`,
   `expires-when`, or `open-loop`).
2. **Reusable lesson** — a behavior, technique, or user preference that should
   steer an agent in a different workspace. The description must be a concrete
   mid-flight trigger. Positive feedback (“the user liked this behavior”) is a
   valid source, not only a failure or trap.
3. **Graduation** — a memory or lesson that has become stable project truth;
   propose it for human approval in the appropriate root documentation. Do not
   silently overwrite user-owned root docs.

Continuation state remains an app-managed handoff mechanism, not a fourth memory
destination. Research inboxes remain untrusted evidence, not durable memory,
until reviewed.

Add a worker-callable `propose_memory` (name subject to API design) operation.
It should accept a capsule draft plus provenance, validate the id/fields/exit,
and place it in a supervisor review queue or database record. It must not allow a
worker to mutate the shared index directly. The responsible supervisor should be
able to approve, edit, reject, merge, or archive the proposal. Applying an
approved long capsule should create the `detail:` pointer and detail file in one
validated transaction.

Make lane policy explicit. Claude and Codex workers should receive the memory
proposal/recall workflow if they are expected to participate. Researchers should
either receive an equivalent reviewed-memory path or be explicitly documented as
research-inbox-only. Lesson publication must be granted wherever the skill says
it is callable; otherwise the skill must say “draft for supervisor publication.”

Add a compatibility-audit/proposal path for user-owned higher-level
`CLAUDE.md`/`AGENTS.md` files. Shared provider-neutral content may be proposed for
mirrored sections, but whole-file duplication or silent overwrites are out of
scope. The existing graduation path should remain the approval boundary.

## Evidence that the skill is working

The implementation should produce inspectable evidence at each stage, with tests
covering the following acceptance scenarios:

### Classification

- A fact already present in git, a plan, a continuation brick, or an existing
  memory is rejected as duplicate/no-save.
- A workspace-only open loop is classified as a memory, with exactly one exit
  condition.
- A reusable technical behavior and a positive user preference are each
  classified as lessons with trigger-first descriptions.
- Stable project truth creates a graduation proposal rather than a direct root
  documentation edit.

### Memory persistence and disclosure

- A worker submits a valid memory draft and receives a durable proposal id.
- A supervisor approves it and the capsule appears in `MEMORY.md` with valid v2
  fields and provenance.
- A short approved memory remains inline.
- A long/closed approved memory produces both an index capsule with a `detail:`
  pointer and a file beneath the exact `memory/details/` root.
- `recall_memory` returns the referenced detail body and rejects missing,
  escaping, or unauthorized pointers without leaking content.
- Supervisor launch injection contains active inline capsules but not detail
  bodies unless they are explicitly recalled.
- An expired memory is omitted from injected text; stale/never-recalled entries
  are surfaced for review and eventual culling.

### Lesson persistence and steering

- Publishing a valid lesson creates the expected `SKILL.md` in every declared
  provider/lane root transactionally.
- A lesson with a description matching a later agent situation is discoverable
  and invoked; a topic-only description is shown by a negative test to be
  insufficient.
- A published lesson records source/provenance sufficient to distinguish a
  worker observation, supervisor decision, and user preference.
- A lesson can be proposed for graduation, and the approved result is reflected
  in provider-neutral mirrored documentation without overwriting unrelated user
  content.

### Operational observability

The UI/API or an inspectable report should distinguish:

```text
skill advertised → invoked → classified → proposed → approved/rejected
→ persisted → injected/recalled → expired/archived/graduated
```

At minimum, evidence should include the proposal id, source agent/lane,
classification, target destination, approval decision, resulting paths, and
recall/publication events. A filesystem-only check is insufficient to prove that
an agent invoked the skill; invocation and recall telemetry must be retained.

## Non-goals

- Automatically splitting every memory based only on byte length.
- Creating a separate memory store for every worker or provider.
- Treating continuation bricks, plans, or raw research as workspace memory.
- Silently copying or overwriting user-owned root `CLAUDE.md`/`AGENTS.md` files.
- Making every memory permanent; workspace memories should remain the most
  ephemeral durable-knowledge layer.

## Expected result

After implementation, a user should be able to watch one complete example move
from a worker observation to a reviewed workspace capsule, see the index/detail
filesystem changes, observe the supervisor receiving the active summary, recall a
long body on demand, and separately verify a reusable lesson being installed and
steering a later agent. The current single inline `MEMORY.md` state would remain a
valid small-workspace state, but it would no longer be the only visible evidence
that the system can do progressive disclosure.

---

## Supervisor comment (2026-08-04, supervisor 853e07dc)

Endorsed with one architectural reframe and one new ruling folded in.

**Reframe — one write path, observability for free.** Do not build a parallel
telemetry surface for the skill. Route ALL memory saves through a single MCP tool
(`propose_memory`): a worker invoking the skill ends by calling it; the proposal
lands as a DB record; the supervisor reviews/applies it to the index. That gives
every property this proposal asks for — a durable worker→supervisor submission
path, invocation evidence, classification audit, persistence confirmation — as
ordinary DB rows, reusing the already-landed WP-H review-store rail rather than
inventing new evidence plumbing. (The proposal as written under-credits what WP-H
already shipped.)

**Ruling folded in (Edward, 2026-08-04) — memory flows one direction.** Workers
SUGGEST memories (via the skill → `propose_memory`); the supervisor is the sole
writer of the index. Workers do NOT retrieve memory as a matter of course: the
supervisor reads the injected index and bakes the relevant context into each
brief. Workers stay lean and raw. Consequence: the worker scaffold's
"fetch it yourself via `recall_memory` / raw-read" guidance is being removed
(WORKER_CLAUDE_MD v10 → v11); worker-side `recall_memory` remains available only
when a brief explicitly points at a capsule.
