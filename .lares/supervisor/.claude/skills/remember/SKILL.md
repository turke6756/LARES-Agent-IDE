---
name: remember
description: >-
  Something just happened that future agents shouldn't have to relearn — a
  hard-won fix, a decision with consequences, a constraint you discovered, a trap
  you fell into, or a loop you're leaving open. Invoke BEFORE ending the turn.
  Walks you through: is this worth saving at all (most things aren't), is it a
  MEMORY (current workspace state others must know) or a LESSON (reusable
  "when X, do Y" steering), and how to write it so it actually gets found and read
  later.
---

# remember

You felt "this shouldn't be lost." Good instinct — now spend it well. Most
moments are NOT worth saving. Work through these gates in order; stop the moment a
gate says stop.

## 1. Is this worth saving at all? (the loudest rule)

**If the fact already lives somewhere durable and discoverable, DON'T save it.**
Skip it if it is already captured by:

- **git** — committed code, comments, commit messages, a CLAUDE.md/AGENTS.md line;
- **a continuation brick or plan** — anything the dashboard already threads
  forward for you;
- **the database / an existing memory or lesson** — go read it instead
  (`recall_memory`, or a raw read of `.lares/supervisor/memory/`).

Save only the **non-obvious, load-bearing, and otherwise-invisible**: the reason a
tempting approach is wrong, a constraint you only learned by tripping over it, a
decision and its consequence, an open loop nobody else is holding. If in doubt,
DON'T write it — a bloated index gets ignored, which defeats the point.

## 2. Memory or lesson?

One question decides it:

> **Would this steer an agent in a DIFFERENT workspace?**

- **No — it's about THIS workspace's current state** (a migration in flight, a
  broken thing to avoid, a decision that holds only here) → it's a **MEMORY**.
  Memories are injected into supervisors at launch and fetched by workers on
  demand; they describe *this* workspace right now.
- **Yes — it's reusable "when X, do Y" steering that would help anywhere** → it's a
  **LESSON**. Lessons become skills that fire by description on both providers.

## 3a. Write a MEMORY (capsule)

Memories live in `.lares/supervisor/memory/MEMORY.md` as capsules. You do NOT edit
that file by hand here — draft the capsule and hand it to the supervisor, who owns
the write. A capsule looks like:

```
## mb-YYYY-MM-DD-<slug>: <one-line title>
- status: active            # active | done | note | archived
- <a named way to die>      # REQUIRED for an active memory — see gate 4
- read-if: <when a future agent should fetch the detail>   # optional
- detail: memory/details/<id>.md                           # optional, for long bodies
<the memory, tight — what's true and why it matters>
```

**read-if authoring:** the index carries the *trigger*, the detail file carries the
*body*. Write `read-if` as the concrete condition under which a future agent
should spend a `recall_memory` call — "read-if: you're about to touch the
auth-token refresh path", not "read-if: relevant". If there's no condition worth
naming, the memory is probably too small for a detail file — inline it.

## 3b. Write a LESSON (publish_lesson)

A lesson is a skill: it fires when its **description** trigger matches what a
future agent is mid-flight on. The description is the whole ballgame.

**Lesson-description authoring:** write the trigger as the *situation the agent is
in*, not a topic label. "When a test mutates a shared file to prove a failure,
restore it by re-editing the line, never by discarding the file" fires; "notes
about testing" does not. Front-load the concrete "when X".

Then call **`publish_lesson({ name, description, body })`**:
- `name` — a slug: lowercase, digits, hyphens (`^[a-z0-9][a-z0-9-]{0,62}$`).
  It may not collide with `remember` or a shipped skill.
- `description` — the mid-flight trigger above.
- `body` — the "when X, do Y" steering, tight.

The app writes the lesson to every provider/lane skill root transactionally — you
never touch `.claude/` or `.agents/` directories yourself.

## 4. Every active memory names a way to die

An active memory with no exit is how the index rots. Before you save an **active**
memory, give it exactly one named exit:

- **expires: YYYY-MM-DD** — a date after which it's mechanically dropped;
- **expires-when: <condition>** — a concrete condition a reviewer can check
  ("expires-when: the pi-integration branch lands");
- **open-loop: <what closes it>** — an unfinished thread; when you close the loop,
  retire the memory that same turn.

No exit → don't save it as active. (done/note/archived capsules are already dead;
they don't need an exit.)

## 5. Validate

After the supervisor writes a memory capsule, confirm the index still parses:

```
node .lares/scripts/memory-index.mjs validate .lares/supervisor/memory/MEMORY.md
```

A HARD failure means the index would be REJECTED at launch — fix it before ending
the turn. (`publish_lesson` validates its own slug and writes; you don't run the
validator for a lesson.)

## Graduation (the other exit)

If a memory turned out to be **permanent workspace truth** (not a passing state),
it belongs in `CLAUDE.md`/`AGENTS.md`, not the memory index. Call
**`propose_graduation({ target, text, rationale })`** to record the proposal for
human approval — never edit the root docs directly from here.
