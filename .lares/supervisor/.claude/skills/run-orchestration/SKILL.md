---
name: run-orchestration
description: Run an AgentDashboard orchestration — a multi-agent dashboard-driven workflow such as planning committee, scoping, fork-and-execute, or GroupThink. Use when the user names an orchestration or describes a goal that maps to one. Don't autonomously launch.
---

# Run Orchestration

Use this skill when the user asks to run any AgentDashboard **orchestration** — a multi-agent workflow (planning committee, scoping, fork-and-execute, etc.) that the dashboard drives end-to-end.

Orchestrations now run **in-process inside the dashboard** and are controlled through MCP tools. You launch **no** `scripts/*.js` — you call `run_orchestration`, it returns a `runId` immediately, and the run proceeds detached. Progress flows back as `[DASHBOARD EVENT]` lines in your chat, plus a pull channel (`get_orchestration_run`).

## MCP tools

- **run_orchestration** — Start a run (detached). Returns `{ runId }` synchronously. Args: `name`, `workspace_id`, `supervisor_id`, plus orchestration params (`topic`, `plan_path`, `mode`, `lead_provider`, `reviewer_provider`, `turn_timeout_ms`). Resume with `resume_run_id` (preferred) or `legacy_command` (paste a whole old `node scripts/groupthink-v2.js …` line).
- **get_orchestration_run** — Pull current status/progress for a `run_id` (status, turn/round, members, last error).
- **abort_orchestration** — Abort a run by `run_id`; cleans up member agents and emits `orchestration.groupthink.aborted`.

## Available orchestrations

| Name | How to run | Purpose |
|---|---|---|
| `groupthink` | `run_orchestration({name:'groupthink', workspace_id, supervisor_id, topic, plan_path, mode})` | Cross-provider deliberation that writes a worker-ready plan. `mode:'serial'` (default — Lead drafts, Reviewer launched with that draft as kickoff, Lead writes plan) or `mode:'parallel'` (3 rounds — both planners draft independently, cross-pollinate, synthesizer writes plan). |

**Legacy resume.** Older plans/`.runs` may carry a `node scripts/groupthink-v2.js … --resume-lead-id=… --resume-reviewer-id=…` resume_hint. Don't run that script — pass the whole line through `run_orchestration({name:'groupthink', workspace_id, supervisor_id, legacy_command:"<the whole old line>"})`. The dashboard parses it into structured resume params and runs the in-process runner. (`scripts/groupthink-v2.js` still exists only as a thin compat shim that forwards to this same tool.)

`groupthink` is the only orchestration in the catalog; the table above and `run_orchestration`'s own schema are the authoritative parameter list.

## Workflow

### 1. Identify the orchestration

The user will name one (e.g., "run a GroupThink on X") or describe a goal that maps to one. If unclear, ask. Don't guess — orchestrations launch real agents and burn real tokens. Today `groupthink` is the only one; the real choice is `mode: 'serial'` vs `'parallel'`.

### 2. Discover IDs

Every run needs a `workspace_id` and a `supervisor_id`. You are the supervisor: use `list_agents` to find your own agent record (the supervisor for this workspace) and read its `id` (→ `supervisor_id`) and `workspaceId` (→ `workspace_id`). If exactly one active supervisor for the current workspace isn't identifiable, stop and report the ambiguity.

### 3. Construct and confirm the call

Fill in required + useful optional params, e.g.:

```
run_orchestration({
  name: 'groupthink',
  workspace_id: '<ws-id>',
  supervisor_id: '<sup-id>',
  topic: 'Plan the X migration',
  plan_path: 'plans/x-migration.md',   // relative to workspace root
  mode: 'serial',                       // or 'parallel'
})
```

Confirm with the user before launching anything that will burn tokens — show the constructed call. Don't autonomously launch.

### 4. Launch (detached) and return to idle

`run_orchestration` returns `{ runId }` in milliseconds; the run continues inside the dashboard. Tell the user the `runId`, then stop working. The orchestration drives itself and sends `[DASHBOARD EVENT]` messages to your input as it progresses.

### 5. Watch for events

When a `[DASHBOARD EVENT]` arrives in your chat:

- **`groupthink.complete`**: the plan was written (path in the message). Acknowledge; no action unless the user asks.
- **`orchestration.groupthink.stalled`**: the payload carries a `resume_hint`. Typically `{tool:'run_orchestration', params:{resumeRunId}}` — resume with `run_orchestration({name:'groupthink', workspace_id, supervisor_id, resume_run_id:'<id>'})`. Decide based on the payload (reason, turns/rounds elapsed, planner ids). When in doubt, escalate to the user.
- **`orchestration.groupthink.aborted`**: the run was aborted (by you, or by a dashboard restart's boot-reconcile, which also emits a resume_hint). Diagnose via `get_orchestration_run`, then resume or escalate.

You can also pull status anytime with `get_orchestration_run({run_id})` instead of waiting for an event.

### 6. Inspect agents during a run

Read what planners are saying mid-run without disturbing the run:

- `read_agent_chat` (preferred): structured turn-complete messages.
- `read_agent_log` (fallback): raw terminal output.

Don't `send_message_to_agent` to a planner mid-run unless the run is stalled — you'll race the dashboard's relay loop. To stop a run cleanly, use `abort_orchestration`.

## File-write convention

Orchestrations and the agents they launch should not write to paths under `.claude/`. Claude Code's permission system gates edits there even with bypass-permissions on, hanging worker forks at an interactive dialog. Plan markdown and any agent-edited files belong outside `.claude/` — typically under `plans/` or the workspace root.

## Constraints

- Run orchestrations only when the user asks. Don't autonomously launch them.
- Confirm the constructed call with the user before launching, especially for non-trivial topics.
- `run_orchestration`'s tool schema is the source of truth for parameters and defaults.
- After launch, return to idle. Don't poll in a loop; let `[DASHBOARD EVENT]` messages drive your wake-ups (use `get_orchestration_run` for an on-demand status check).
