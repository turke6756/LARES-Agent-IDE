# Review of `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md`

## Verdict

The doc is materially ready to implement. Two blockers (B1 supervisor-id race + Windows inline `--mcp-config`; B2 stuck-orchestration recovery with heartbeat) and nine tightenings should be addressed in-place before kickoff. No structural rewrites required; the design holds.

---

## Blockers

### B1. Supervisor identity is unsafe over a shared workspace `.mcp.json`, and the Windows supervisor launch bypasses `.mcp.json` entirely

**Two related problems:**

**B1a — TOCTOU on shared file.** D-04 + D-05 inject `AGENT_DASHBOARD_SUPERVISOR_ID` through `ensureMcpConfig` into a workspace-shared `.mcp.json`. The mitigation ("each supervisor only reads `.mcp.json` at its own spawn, last writer wins") does not hold when (a) two supervisor launches race, or (b) a long-lived MCP child restarts after the file has been rewritten by another supervisor. Result: shim inherits a *different* supervisor's id, and D-04's per-caller filtering silently routes the wrong rows.

**B1b — Windows inline `--mcp-config` is a separate code path.** At `src/main/supervisor/index.ts:884–895` (verified against HEAD), `launchWindowsAgent` constructs the MCP config inline and passes it as a `--mcp-config <json>` arg for `agent.isSupervisor && isClaude`. This path:
- Uses `getScriptPath('mcp-supervisor.js')` (repo-absolute) — will *not* point at the bundled workspace copy after P1-10.
- Injects only `AGENT_DASHBOARD_API_PORT` — no supervisor id at all.
- Bypasses `ensureMcpConfig` for the supervisor's own MCP server on Windows.

P1-10 as written only updates `ensureMcpConfig` / `ensureTeamMcpConfig` and will leave this site stale. Packaged Windows launches will continue to point at the repo's `scripts/` directory (which doesn't exist on user machines) and have no supervisor-id env.

**Recommended fix (one doc amendment, one new ticket, plus extending P1-10):**

1. **Amend D-04 + D-05** to add a hard rule:
   > **Supervisor identity (`AGENT_DASHBOARD_SUPERVISOR_ID`) is set per-supervisor on the parent Claude process at launch time and inherited by the MCP child via process env. It is NOT persisted in the workspace-shared `.mcp.json`.** Concretely: the supervisor launch code (both Windows inline `--mcp-config` path and POSIX `.mcp.json` path) sets the env var on the spawned `claude` process; the MCP shim, forked by Claude Code as a child, inherits it. For WSL launches: **add `AGENT_DASHBOARD_SUPERVISOR_ID` to `WSLENV`, preserving existing entries; no path/list flags are needed.** The port can remain in MCP-config env unless the implementation deliberately moves it to parent env too; the load-bearing change is that the supervisor id crosses Windows→WSL.

2. **Extend P1-10 ("Rewrite ensureMcpConfig…")** with explicit Windows steps:
   - Step 5 (new): Update the inline `--mcp-config` builder at `src/main/supervisor/index.ts:884–895` (verify against HEAD) to use the bundled workspace path `<workspace>/.dashboard/supervisor/scripts/mcp-supervisor.js` (with dev-mode preserving the repo-absolute path).
   - Step 6 (new): On the supervisor process spawn (both Windows and WSL/POSIX), set `AGENT_DASHBOARD_SUPERVISOR_ID=<agent.id>` on the child process env. Remove the env-injection from `.mcp.json` write paths once parent-process inheritance is in place.
   - Step 7 (new): On WSL launches, add `AGENT_DASHBOARD_SUPERVISOR_ID` to `WSLENV`, preserving existing entries; no path/list flags required.

3. **Rename D-04 acceptance test** to specifically exercise: (a) two simultaneous supervisor launches in the same workspace, (b) MCP child restart after a second supervisor has launched. Both must yield shims that retain their *own* supervisor's id.

### B2. Stuck-orchestration recovery requires heartbeats; the script must emit them while running

A crash between `POST /api/orchestrations` and the `running` PATCH leaves a row stuck in `starting`. A crash after `running` leaves it stuck in `running`. Both permanently block P1-09's sync-defer logic for that workspace.

A pure `updated_at < now() - N` rule is **not** sufficient: GroupThink runs can legitimately exceed any fixed threshold because the script's only on-row writes today are status transitions, not progress pings. A 4-turn deliberation with a 30-minute exploration agent will look stale by minute 11.

**Recommended fix (D-17, new):**

1. **Script-side heartbeat.** While an orchestration is in `starting` or `running`, the script PATCHes `/api/orchestrations/:id` with no body (or `{ heartbeat: true }`) every 30 seconds. The server-side handler does nothing except bump `updated_at`. Heartbeat stops when the script issues a terminal-status PATCH.
2. **Server-side stale detection.** Stale rule: `status IN ('starting','running','stalled') AND updated_at < now() - 3 minutes` (~6× heartbeat interval, generous for GC pause / API latency).
3. **Two enforcement points:**
   - **Dashboard boot sweep:** at startup, find stale rows; mark `status='failed'`, append `summary='auto-failed: no heartbeat for >3min'`; log per workspace.
   - **Sync-defer check (P1-09 step 4):** before deferring sync on an active orchestration, filter out stale rows (treat them as not-active for defer purposes). Belt-and-braces against the case where boot sweep hasn't run yet (race between sweep and sync).
4. **Failure mode for legitimately long-running steps the script can't ping during** (e.g., agent reading large context): the script's heartbeat loop runs in a separate `setInterval` independent of the relay loop, so it pings even when the relay is awaiting an agent. No special handling required — but call this out in P1-11's notes so the implementer keeps the heartbeat in its own scheduler.
5. **Spec impact:**
   - Add D-17 to the decision register.
   - Add an HTTP route note to Part 2: `PATCH /api/orchestrations/:id` accepts empty/heartbeat-only PATCHes that bump `updated_at`. No state-machine validation triggered.
   - Add to P1-07 acceptance: heartbeat PATCH succeeds and bumps `updated_at` without status change.
   - Add to P1-11 acceptance: a running GroupThink updates `updated_at` at least every 30s.

---

## Tightenings

### T1. `resources/supervisor-template/` dev vs packaged path resolution

P1-08 + P1-09 reference `resources/supervisor-template/` but `process.resourcesPath` is undefined in `npm run dev`. Add to P1-08 step 3 an explicit resolution helper:

> Path resolution: in packaged builds, use `path.join(process.resourcesPath, 'supervisor-template')`. In `npm run dev` / unpackaged, use `path.join(app.getAppPath(), 'resources', 'supervisor-template')`. Centralize in a `getSupervisorTemplatePath()` helper consumed by P1-09's sync writer.

### T2. Bundle source vs allowlist drift (reinforced by Reviewer's D-14 count nit)

D-14 says "currently 4" managed files. The bundle section in Part 2 actually lists **5**: `groupthink-v1.js`, `groupthink-v1.md`, `mcp-supervisor.js`, `mcp-team.js`, plus `.claude/skills/run-orchestration/SKILL.md`. The count is already wrong; drift is happening before implementation starts. Two-part fix:

1. **Derive the allowlist from the bundle walk at startup**, not from a literal list. The "allowlist" becomes "anything present in `resources/supervisor-template/` is managed; anything else is left alone." Edit D-14 from "hard-coded literal list" to "computed from bundle tree at scaffold time."
2. If literal list is kept for any reason (audit trail, security review): add an automated startup assertion in P1-09 that the literal list and the bundle walk agree, with a clear failure mode (refuse to sync, log mismatch, surface in the dashboard).

Update D-14's count language to remove the magic number "4" — it will rot.

### T3. `DASHBOARD_API_VERSION` constant — pin the server's source of truth

P1-11 puts the constant in the script; P1-07 references it for validation. Pin in P1-07 step 3:

> Server reads `DASHBOARD_API_VERSION` from `src/shared/constants.ts` (exported as `DASHBOARD_API_VERSION = '1.0'`). Build step from P1-08 must keep the bundled script's top-of-file constant in lockstep with this value — add an assertion in the build script that fails if they diverge.

### T4. SKILL.md silent overwrite is a user-facing regression — surface in Part 1

Today's scaffold writer never overwrites. The new managed-file sync overwrites `run-orchestration/SKILL.md` on every launch in non-dogfood workspaces. Even though intentional, a user who edits that file will see their edits silently revert.

Add a bullet to **Part 1 — Cross-cutting constraints** under a new "What CHANGES intentionally" sub-section (or fold into the existing "Removal contract" section in Part 2 and cross-reference from Part 1):

> Files inside `resources/supervisor-template/` (including `.claude/skills/run-orchestration/SKILL.md`) are dashboard-managed and **silently overwritten** on each launch in non-dogfood workspaces. Users who want to customize orchestration skill content must either (a) work in the dogfood repo, (b) set `AGENTDASH_DEV_SKIP_SYNC=1`, or (c) author a *different* skill at a different path — which the scaffold writer will preserve. This is a deliberate trade against the previous "scaffold never overwrites" semantic.

P1-12 still adds the two notes to the bundled skill's text, but the user-surprise contract belongs in Part 1.

### T5. Orphaned-supervised-worker re-tie path

D-01 logs orphans but doesn't say how they recover. Two options, pick one in the doc:

- **Option A (recommended):** Add a `claimOrphans(supervisorId, workspaceId)` step to the supervisor's launch path: if there are workers in this workspace with `is_supervised=1 AND supervisor_id IS NULL` AND no other active supervisor exists, claim them. Idempotent.
- **Option B:** Document that orphans must be stopped and re-launched manually; the dashboard surfaces a banner per orphaned worker.

Add to D-01 the recovery rule; add a corresponding step to P1-06.

### T6. `is_supervised` vs `supervisor_id` redundancy

Add a single line to P1-01's Notes:
> `is_supervised INT` remains for back-compat. All new code reads `supervisor_id !== null` as the source of truth. A follow-up cleanup pass will drop `is_supervised` after one release cycle — out of scope for this migration.

### T7. P1-02 — enumerate guard's callers before deleting

Add step 0 to P1-02:
> Pre-step: grep for `getSupervisorAgent` callers and the duplicate-guard's error code/text across `src/`. List discovered call sites in the ticket's Notes section. Confirm that none assume a single-supervisor-per-workspace invariant beyond what P1-03/P1-04 already rewires. If any do, capture them as P1-02a sub-tasks before the guard delete lands.

### T8. P2-03 — do the consumer audit *now*

Reviewer found three known consumers (`App.tsx`, `dashboard-store.ts`, `MainContent.tsx`); the ticket says "and any others." Update P2-03 step 1 to:

> Replace `supervisorAgent: Agent | null` slot with `agents.filter(a => a.isSupervisor)` derivation. Known consumers (verify and update each, line refs as of HEAD): `src/renderer/stores/dashboard-store.ts:81` (the slot), `:553–566` (the splitting loader), `src/renderer/App.tsx:58–68`, `src/renderer/components/layout/MainContent.tsx` (audit). **A stale line ref discovered at kickoff is a pre-kickoff blocker on this ticket, not a runtime discovery — re-run the grep before starting.**

### T9. Two-supervisor smoke test — Vitest in-process harness, no real spawn

Clarify in P1-03 acceptance:

> Test scaffolding: Vitest in-process harness with fake `Supervisor` instances. Inject two synthetic supervisors with distinct ids, push events through the rewired enqueue path, assert per-queue isolation and per-queue batch-payload construction. Reuse existing test harness infrastructure where present — do not spawn real Claude/Codex processes for this unit test. Manual real-spawn coverage remains in the Phase 1 combined-acceptance demo.

If the existing harness genuinely cannot reach the event-bridge path, escalate as a P1-03a scaffolding ticket — but do not pre-create it.

---

## Nits

### N1. P1-10 second call site at `:984` — distinguishing rule

Add to P1-10 Notes: *"Site is in the `.mcp.json` write path → update. Site is a one-shot exec helper (e.g., WSL command invocation that re-references the script directly) → leave alone."*

### N2. Dev mode + env-var injection

P1-10's dev-mode preserves repo-absolute path; per B1's fix, dev mode also still needs `AGENT_DASHBOARD_SUPERVISOR_ID` on the parent process env. State explicitly: dev-mode skip only applies to the script-bundling rewrite, not to identity-env injection.

### N3. D-12 MEMORY.md note doesn't propagate to existing supervisors

Per Reviewer: `SUPERVISOR_AGENT_MD` content isn't in the managed allowlist, so already-scaffolded supervisors will never receive the new MEMORY.md-append note. Two options:

- **Option A (recommended):** add a one-time idempotent append migration. On dashboard launch, for each existing supervisor `CLAUDE.md` in every workspace, check for a sentinel marker (e.g., `<!-- memory-append-note-v1 -->`); if absent, append the note and the marker. Survives one upgrade, no-ops thereafter.
- **Option B:** Document explicitly that the MEMORY.md convention note applies to *new scaffolds only*. Existing supervisors continue under the unwritten convention; user can manually add the note if desired.

Either is acceptable; D-12 must pick one and say so. Recommend Option A — it's cheap and avoids the "the convention is on paper but my CLAUDE.md never got told" gap.

### N4. Owner / reviewer assignment

Part 1 line 39: `Owner / reviewers: TBD before kickoff.` Assign before this plan is acted on.

### N5. Pre-kickoff line-ref audit step should be non-optional

Part 4 schema says "Verify line refs against HEAD before kickoff" as a recommendation. Promote to a hard prerequisite: every P-ticket has an implicit step 0 "verify line refs; if any are stale, update the ticket before starting."

---

## Recommended doc edits (concrete checklist)

All edits target `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md`. Each line below is one self-contained edit a worker agent can execute.

1. **Part 2 § "MCP tools" + D-04 + D-05:** add the per-process-env rule from B1. Strike "last writer wins" from D-04. Add WSLENV propagation note: *"Add `AGENT_DASHBOARD_SUPERVISOR_ID` to `WSLENV`, preserving existing entries; no path/list flags are needed."*
2. **D-04 implementation specifics:** delete the `AGENT_DASHBOARD_SUPERVISOR_ID` line from the `.mcp.json` env-object change in P1-06 step 1; move identity-env injection to supervisor process spawn instead.
3. **Add D-16 (new decision):** "Supervisor identity injection — parent-process env, inherited by MCP child. WSLENV propagation required for Windows→WSL." Status: decided.
4. **Add D-17 (new decision):** "Stuck-orchestration recovery via script heartbeat + boot sweep." Status: decided. Heartbeat every 30s. Stale threshold 3 minutes. Two enforcement points (boot sweep + sync-defer check).
5. **P1-10:** add steps 5, 6, 7 for Windows inline `--mcp-config` update at `:884–895`, parent-process env injection, and WSLENV.
6. **P1-07:** add row to HTTP API table for heartbeat PATCH semantics (no body / `{heartbeat:true}` → bump `updated_at`, no state-machine validation). Add server `DASHBOARD_API_VERSION` source pin (T3).
7. **P1-09:** add stale-row filter to step 4 (defer check). Add new step 5: dashboard-boot stale sweep. Switch allowlist source from "literal" to "bundle walk" per T2 (or add assertion).
8. **P1-11:** add steps for heartbeat scheduler (`setInterval` independent of relay loop). Add acceptance: `updated_at` bumps at least every 30s during a run.
9. **P1-08:** add `getSupervisorTemplatePath()` dev-vs-packaged resolution helper (T1).
10. **Part 1 — Cross-cutting constraints:** add the "What CHANGES intentionally" bullet on managed-file overwrite of `run-orchestration/SKILL.md` (T4).
11. **D-14:** strike "currently 4" magic number; pivot to bundle-walk-derived OR add startup assertion (T2).
12. **D-01:** add orphan re-tie rule (Option A: supervisor-launch claim path). Add corresponding step to P1-06 (T5).
13. **P1-01 Notes:** add the `is_supervised` deprecation note (T6).
14. **P1-02:** add step 0 — guard-caller enumeration before delete (T7).
15. **P1-03 acceptance:** clarify Vitest in-process harness, no real spawn (T9).
16. **P2-03 step 1:** list known consumers with line refs (including `src/renderer/components/layout/MainContent.tsx`), mark pre-kickoff re-grep as blocking (T8).
17. **P1-10 Notes:** add `:984` distinguishing rule (N1). Add dev-mode-still-injects-env note (N2).
18. **D-12:** add Option A one-time idempotent append migration; or document new-scaffolds-only caveat (N3).
19. **Part 1 line 39:** assign Owner / reviewer (N4).
20. **Part 4 schema:** promote line-ref verification from recommendation to hard step-0 prerequisite (N5).

---

## Deferred to a separate plan

None at this size. If T9's harness doesn't exist, the P1-03a test-scaffolding ticket would be the only candidate, and it's small enough to stay in this migration's Phase 1 if needed.


<!-- groupthink_members: fb87e3b0-005f-4197-82c4-e39c2b64a373, null -->
