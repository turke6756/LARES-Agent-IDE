# Task Sizing

Judgment heuristics for matching a task to an agent. Update as experience builds.

The pre-launch question is always: **does this task fit comfortably in this provider's context window, and is it scoped tightly enough that the agent won't have to invent direction?**

---

## Single-file bug fix (< 500 LOC touched, ≤ 3 tests)

- **Agent:** 1 worker
- **Provider:** Claude (default) or Codex (if codex has cached context for the file)
- **Expected context at finish:** ≤ 20% on Claude 1M
- **Fork?** No
- **Examples:** BUG-01 fix (auto-submit) landed at 15% / 117 turns. BUG-06 fix landed at 8% / 35 turns.

---

## Multi-file refactor across one subsystem

- **Agent:** 1 worker, briefed with explicit "stop and ask before expanding scope" instruction
- **Provider:** Claude
- **Expected context at finish:** 30–50%
- **Fork?** Optional — if a second related task exists, fork after the seed has loaded the subsystem (P-01)

---

## Investigation of an unknown symptom in unfamiliar code

- **Agent:** 1 worker, briefed as **investigation-only** (do not patch yet)
- **Provider:** Claude (writeup quality matters more than speed)
- **Expected context at writeup:** 40–60%
- **Deliverable:** a writeup at `plans/<symptom>.md`, NOT a fix. Fix happens in a follow-up turn after the supervisor reviews — usually the same agent (per B-01).
- **Examples:** GroupThink duplicate-relay investigation — Claude, 10% / 49 turns at writeup, grew to 14% / 70 turns after writing the fix.

---

## N similar bug fixes in the same subsystem

- **Pattern:** seed-and-fork (P-01)
- **Seed context after orientation:** 5–15%
- **Fork count:** N (one per task)
- **When to skip the fork pattern:** if the bugs are scattered across unrelated subsystems with no shared context, just launch separately.
- **Note:** the 2026-05-17 7-bug sweep ran each bug as a fresh launch — future similar sweeps should try seed-and-fork to compare cost.

---

## Multi-provider deliberation producing a planning artifact

- **Pattern:** GroupThink orchestration via `run-orchestration` skill
- **Expected runtime:** 10–25 min, 3 turns typical
- **Codex caution:** Codex saturates the Reviewer role at ~6–8 turns under heavy relay. If GroupThink looks like it'll need more turns (long topic, large doc to review), switch the reviewer to a higher-context provider OR use a `mesh` team instead.
- **Recovery:** see P-06.

---

## Ad-hoc N-agent deliberation without a script

- **Pattern:** `create_team` with `mesh` template
- **Provider mix:** include at least one cross-provider voice (Codex or Gemini) for diversity
- **When to use over GroupThink:** topic is genuinely free-form and the writer-of-record discipline of GroupThink would be over-engineering; OR you need >2 voices.
- **You synthesize the output** — agents debate, you write the conclusion.

---

## Anything you can't size with confidence

- **Default action:** ask the user, with orientation per B-06.
- **Or:** do a tiny scoping turn yourself first (Read + Glob + 1 grep) before launching.
- **Don't:** launch hoping the agent will figure out the scope. Agents brief themselves to the size you give them — under-scoped briefs produce under-scoped work.
