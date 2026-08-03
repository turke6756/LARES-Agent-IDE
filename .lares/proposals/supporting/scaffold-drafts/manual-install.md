# Manual install — dogfood the `proposal-to-plan` skill before P0C deploys

> **Purpose.** WP-P0C deploys the whole `proposal-to-plan/` tree into the Claude
> and Codex skill roots via version-bumped constants. Until that lands, this is
> the **hand-install** so `capture` (and the rest of the journey) can start
> **now** — the demand probe should not wait on P0C. This is a temporary dogfood
> step, **superseded by P0C**; do not treat it as the deployment mechanism.

---

## What gets installed

The self-contained tree authored in
`.lares/proposals/supporting/scaffold-drafts/proposal-to-plan/`:

```
proposal-to-plan/
  SKILL.md
  references/contracts/{folder-schema,intent-lifecycle,arc,manifest-lock}.md
  references/activities/{capture,scope,promote,deliberate,integrate,package,orient}.md
  scripts/plan-manifest.mjs
```

## The `.claude/` permission caveat (read first)

Claude Code gates edits to anything under `.claude/` with an **interactive permission dialog — even
with bypass-permissions on.** A non-interactive orchestration agent will **hang** at that dialog.
Therefore:

- **A human, or the orchestrator writing on the agent's behalf, performs the copy into `.claude/`.**
  Do not ask a headless worker to write under `.claude/`.
- The Codex root (`.agents/skills/…`) has no such dialog, but keep the two roots byte-identical.

## Install steps (human / orchestrator)

1. **Claude lane** — copy the tree to:
   `.claude/skills/proposal-to-plan/`  (SKILL.md + references/** + scripts/**)
2. **Codex lane** — copy the identical tree to:
   `.agents/skills/proposal-to-plan/`
3. **Verify the skill loads:** start a fresh session; the dispatcher (`SKILL.md`) should list the
   seven modes. Load a playbook on demand (e.g. open `references/activities/capture.md`).
4. **Smoke the helper** from a scratch dir (never a real workspace state dir):
   ```bash
   node .claude/skills/proposal-to-plan/scripts/plan-manifest.mjs \
     scaffold --proposal <scratch>/prop.md --plans-home <scratch>/plans --request-id smoke
   node .claude/skills/proposal-to-plan/scripts/plan-manifest.mjs inspect --dir <scratch>/plans/<plan-sku>
   ```

## Orientation edits (optional, until P0C)

The scaffold deltas (`../supervisor-agent-md.delta.md`, `../worker-claude-md.delta.md`) describe the
CLAUDE.md/AGENTS.md changes P0C will ship. Hand-applying them is **optional** for the dogfood — the
skill is usable without them — but applying the supervisor "where planning artifacts live" +
orient-first + ARC-ownership section makes pickup smoother. Same `.claude/` dialog caveat applies:
the human or orchestrator makes those edits.

## Uninstall / handoff to P0C

When WP-P0C lands, **remove the hand-installed copies** and let the version-bumped constants own the
tree (P0C's hash-guarded stale-file discipline preserves any file you modified locally, but a clean
handoff is: delete the manual copy, rebuild, relaunch, confirm the managed tree is present on a
Claude lane).
