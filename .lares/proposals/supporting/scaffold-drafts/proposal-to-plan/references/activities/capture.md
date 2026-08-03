# Activity playbook — `capture`

**Purpose.** Write a stamped **flat** proposal markdown with zero ceremony. This is the universal
cheap entry point; a bare proposal is valid as a **terminal state** — capture does not obligate any
later hardening.

**Lane.** Anyone may capture (supervisor or worker). A worker may author a proposal with
`author_role: worker` (see `worker-claude-md.delta.md`).

**Contracts loaded.** `references/contracts/folder-schema.md` (the *Bare proposal* clause) only. No
`plan.json`, no folder, no lock — capture never touches the plan-folder home.

---

## Steps

1. Pick a path under `.lares/proposals/`:
   `.lares/proposals/<YYYY-MM-DD>-<slug>.md` (deliberation/detail docs go in
   `.lares/proposals/supporting/`).
2. Write portable frontmatter — **`artifact_id` is required and portable** (never the local DB UUID,
   so clones adopt without dirtying):

   ```yaml
   ---
   artifact_id: prop_<hex>
   title: <human title>
   author_role: supervisor | worker
   authored_at: <ISO-8601>
   ---
   ```

3. Write the proposal body in plain markdown. **No additional structure** — no `plan.json`, no
   subdirs, no sentinels. That is the whole ceremony.

## Rules

- **Zero ceremony.** Do not scaffold a folder, do not mark intents, do not open a plan. Those are
  `scope`/`promote`, invoked later and only if the proposal graduates.
- **Terminal-valid.** A proposal that never hardens is a legitimate durable artifact; leave it flat.
- `artifact_id` **must be portable and unique** — it is the identity every later rung keys on
  (`source_proposal.artifact_id`).

## Hand-off

When a captured proposal looks worth hardening, the responsible supervisor runs **`scope`** next
(hardening triage + markup). Capture itself makes no such judgment.
