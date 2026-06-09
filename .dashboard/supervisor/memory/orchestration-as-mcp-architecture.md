# Orchestration-as-MCP — how it works + where to look

**Status as of 2026-06-08:** implemented, builds clean, 28/28 tests green, **uncommitted, app NOT yet restarted.** The running dashboard is still the OLD build until someone does `npm run restart` — the `run_orchestration` MCP tool and in-process runner do not exist in the live process until then. Source plan: `plans/orchestration-as-mcp-tool.md` (Option 3).

---

## What changed (the one-line version)

Orchestrations (starting with GroupThink) no longer run as a standalone `node scripts/groupthink-v2.js` process that HTTP-talks to the dashboard. They now run **in-process inside the Electron main process**, driven by an `OrchestrationService`, and you start them with an **MCP tool** instead of a shell launch. No orchestration script is scaffolded into any workspace anymore.

---

## How a supervisor runs one now (the new workflow)

1. **Discover:** `list_orchestrations` → returns the catalog (currently just `groupthink`) with its params/modes.
2. **Start:** `run_orchestration({ name:'groupthink', workspace_id, supervisor_id, topic, plan_path, mode })`
   - Returns **immediately** with a `runId`. The run executes **detached** inside the dashboard.
   - `mode` = `serial` (default; lead drafts → reviewer reviews → lead finalizes) or `parallel` (3 rounds: fan-out → cross-pollinate → synthesize).
3. **Watch:** the run streams the same `[DASHBOARD EVENT]` messages back to the owning supervisor as before — `groupthink.complete`, `orchestration.groupthink.stalled`, `.aborted`.
4. **Poll (new pull channel):** `get_orchestration_run({ run_id })` for status/progress at any time.
5. **Abort:** `abort_orchestration({ run_id })` — cancels the run and cleans up its member agents.
6. **Resume a stalled run:** `run_orchestration({ ..., resume_run_id })` (rehydrates full state from the DB). For an OLD `node scripts/groupthink-v2.js … --resume-lead-id=… --resume-reviewer-id=…` hint, paste the whole line as `legacy_command` and the dashboard parses it deterministically.

The four MCP tools: `list_orchestrations`, `run_orchestration`, `get_orchestration_run`, `abort_orchestration`.

---

## Where the code lives (where to view what was done)

**New module — `src/main/orchestration/`:**
- `types.ts` — all the shared types (RunOrchestrationRequest, OrchestrationRun, DashboardClient interface, etc.)
- `catalog.ts` — single source of truth for `list_orchestrations` (the groupthink descriptor + params).
- `service.ts` — `OrchestrationService`: owns run lifecycle, creates DB rows, fires detached runner tasks, holds AbortControllers, records events, delivers `[DASHBOARD EVENT]` to the supervisor (with retry), and on boot marks stale in-flight runs aborted (crash recovery).
- `groupthink-v2.ts` — the in-process port of the runner (`runSerial`/`runParallel` + the wait/relay helpers). This is the faithful port of the old script's loop logic.
- `groupthink-v2-prompts.ts` — the 5 prompt templates, copied verbatim from the old script.
- `groupthink-legacy.ts` — parser that turns a legacy `node scripts/groupthink-v2.js …` command string into structured resume params.
- `dashboard-client.ts` — concrete `DashboardClient` over `AgentSupervisor` + DB (launchAgent/getAgent/getMessages/sendInput/isInputInFlight/deleteAgent).
- Tests: `orchestration-service.test.ts`, `groupthink-v2.test.ts`, `groupthink-legacy.test.ts`.

**Edits to existing files:**
- `src/main/database.ts` — 3 new tables (`orchestrations`, `orchestration_events`, `orchestration_members`) + accessors + `markActiveRunsAborted`.
- `src/main/api-server.ts` — 5 routes under `/api/orchestrations` (catalog, list, POST start, GET :id, DELETE :id abort).
- `src/main/index.ts` — constructs `OrchestrationService`, injects into `ApiServer`, start/stop lifecycle (`orchestration.start()` boot reconcile, `orchestration.stop()` on shutdown).
- `src/main/supervisor/index.ts` — `deliverToSupervisor()` (in-process port of the relay retry loop) + scaffold **version 2→3** bumps for `CLAUDE.md` and the run-orchestration SKILL, with V2-hash entries in `previousHashes` so existing supervisors upgrade silently.
- `scripts/mcp-supervisor.js` — the 4 new tool defs + handlers (thin HTTP proxy to `/api/orchestrations*`).
- `src/shared/constants.ts` — `SUPERVISOR_RUN_ORCHESTRATION_SKILL` + `SUPERVISOR_AGENT_MD` rewritten MCP-first (removed the `node scripts/…` / `nohup &` / PowerShell-quoting sections).
- `scripts/groupthink-v2.js` — body **replaced with a forwarding compat shim**: parses argv and POSTs to `/api/orchestrations` so old `resume_hint` lines still run, now routed through the in-process runner. (Transitional — slated for deletion at Phase 5 per the plan.)
- `scripts/compat-shim.test.js` — new, tests the shim.

---

## Where to view RUN HISTORY / what happened in a run

- **DB (durable, available now after restart):** the `orchestrations`, `orchestration_events`, and `orchestration_members` tables in `dashboard.db`. Every run persists its row; `orchestration_events` holds the started/turn/round/complete/stalled/aborted/delivery_failed timeline; `orchestration_members` maps run → lead/reviewer agent ids.
- **API:** `GET /api/orchestrations` (list, optional `?status=`), `GET /api/orchestrations/:id` (one run). These are live.
- **Renderer Runs-view panel:** **NOT built yet** (deferred to a follow-up, 2026-06-08). The read API exists, but there is no dashboard UI panel to browse past orchestrations / event timelines yet. Until it's built, view history via the DB tables or the API endpoints above, or `get_orchestration_run` from a supervisor.

---

## What's left (pending human action)

- **P4 dogfood + P5 cleanup:** require `npm run restart` (kills all live sessions) — human will do this at a safe point. After restart, smoke-test: serial → parallel → forced stall (tiny `turn_timeout_ms`) → resume via `resume_run_id` → mid-run dashboard restart → boot reconcile → resume; plus a `legacy_command` resume.
- **Renderer Runs-view panel** (resolved-decision #1) — deferred follow-up.
- **Commit** — nothing committed yet; tree is open for review.
- **Existing supervisor sessions** won't see the 4 new MCP tools until relaunched after the rebuild.
