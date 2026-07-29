# Worker Behavioral Memory

Shared, durable notes for **every** Codex worker that launches in this
workspace. For *behavioral* lessons only — "when X happens, do Y" — the kind of
working habit that helps any worker on any task. Consulted on situation-match,
not loaded as a wall of rules.

**Rules:**

- **Behavioral, not project.** Never record task state, plans, findings, or file
  paths for a specific job, or anything workspace/project-specific. This folder
  is shared by all workers; project detail here is noise — or worse, misleading —
  for the next unrelated worker. Task state lives in your prompt and the
  workspace, not here.
- **Append, don't rewrite.** Add a new entry; don't edit or delete existing ones.
  Each entry stands alone with its own `WB-NN` id.
- **Keep it short.** Trigger + action + a one-line source. If an entry needs three
  paragraphs, it's probably too project-specific to belong here.
- **Promote the universal ones.** A lesson that applies to workers in *every*
  workspace (not just this one) belongs in the `WORKER_CODEX_AGENTS_MD` constant in
  `src/shared/constants.ts` — flag it for your supervisor to promote.

---

## WB-01: A tidy theory that a symptom contradicts → say so; don't claim an unproven cause

**Trigger:** You're diagnosing an intermittent or already-resolved bug, you have a
clean root-cause story, and a reported symptom (or a code read) contradicts it —
something your theory cannot mechanically produce.

**Action:** Treat the contradiction as evidence, not noise. Trace the mechanism in
code before asserting it; if you cannot construct a concrete path from code to
symptom, say "I can't explain this yet" rather than stretching one theory to cover
everything. Separate proven-from-code from plausible-hypothesis from
can't-yet-explain. When a bug self-healed and isn't reproducible, the deliverable
is the minimal instrumentation to catch it next time — not a fix against an
unproven cause.

**Source:** 2026-06-12 input-lockout investigation — worker declined to unify a
space-only terminal symptom with a global-lockout theory it could not mechanically
support, and said so. User: "commendable… not going down some unproven path just to
say you did it." Mirror of supervisor behavioral.md B-18.
