# Scaffold delta — SUPERVISOR CLAUDE.md / AGENTS.md

> **Draft, not yet deployed.** This is the text WP-P0C will fold into the new
> `SUPERVISOR_AGENT_MD_V20` (Claude lane) and the Codex `SUPERVISOR_FILES_CODEX`
> body, via version-bumped constants (`scaffold-content-needs-version-bump`).
> WP-P0A only authors it; it does **not** edit `src/` or `.claude/`. The prose is
> written to drop verbatim into both lanes.

---

## Where planning artifacts live  (Edward, 2026-08-02)

You never guess where planning artifacts go — the app tells you here:

- **Proposals** are flat markdown files in **`.lares/proposals/`** (deliberation / detail docs go in
  **`.lares/proposals/supporting/`**). A bare proposal with portable `artifact_id` frontmatter is a
  valid terminal artifact — no folder, no ceremony.
- **Plan folders** live under **`<workspaceStateDir()>/plans/`** (resolves to `.lares/plans/`, or the
  `.dashboard` fallback) — one folder per plan, `plan.json` + `plan.md` + `ARC.md` + `deliberations/`
  `research/` `supplements/` (§R0). This is **distinct** from the legacy workspace-root `plans/`
  directory that holds flat HTML/markdown plans.
- The **`proposal-to-plan` skill** is how you create or resume any of this: `capture` a proposal,
  `scope` (triage + mark) it, `promote` it into a plan folder, then `deliberate` / `integrate` /
  `package`, with `orient` as the re-entry read.

## ARC.md is YOUR job  (ruling 29)

`ARC.md` is **written and maintained by the plan's responsible supervisor** — not a worker's job:

- **Create it at `promote`** (the skill's scaffold seeds the skeleton).
- **Refresh it on `orient` and `integrate`** from current disk/ledger evidence, updating `ARC-META`.
- It is a **summary that cites** durable records (intent→orchestration links, turn stamps, commit
  records) — a prose row is **never** a substitute for work-time stamping.

## Orient-first  (ruling 30)

If you are subscribed to a plan and picking it up, **`plan.json` + `ARC.md` + the intent markers are
the FIRST place you look, before doing anything new.** Run the skill's `orient` mode: it derives
every intent's rung from disk (`marked → ran → returned → folded-in`; `ran` is **unavailable until
the ledger ships** and is reported as such, never faked), reports safe next actions, and refreshes
`ARC.md`. A plan is **owned by one supervisor** (the last `assigned` event in `plan.json`); a
different supervisor must **append a new `assigned` event before mutating** — read-only `orient` is
always allowed.
