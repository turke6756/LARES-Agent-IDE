# groupthink-v1 — orchestration tool manual

The orchestration's parameter form, event vocabulary, and recovery contract. The supervisor reads this when it needs to invoke this orchestration.

For the architectural background and decisions, see `docs/GROUPTHINK_ORCHESTRATION_V1.md`.

## When to use

Choose this orchestration when you need a planning markdown produced through cross-provider deliberation. Two agents debate the topic in-context, one final markdown plan lands at the chosen path.

**Don't use it for:**
- Executing a plan (no orchestration for that yet — coming after this proves out).
- Fast single-agent planning (just `launch_agent` with a planning prompt).
- Topics where you already know what you want — GroupThink's value is the cross-provider critique loop.

## Invocation

```bash
node scripts/groupthink-v1.js \
  --workspaceId=<ws-id> \
  --supervisorId=<sup-id> \
  --topic="<one-line topic>" \
  --planPath="plans/<plan-name>.md"
```

PowerShell equivalent (use backticks for line continuation):

```powershell
node scripts/groupthink-v1.js `
  --workspaceId=<ws-id> `
  --supervisorId=<sup-id> `
  --topic="<one-line topic>" `
  --planPath="plans/<plan-name>.md"
```

## Parameters

### Required

| Flag | Type | Description |
|---|---|---|
| `--workspaceId` | string | Dashboard workspace ID. Discover via `GET /api/agents` and pick the workspace you want planners launched in. |
| `--supervisorId` | string | The supervisor agent that receives `[DASHBOARD EVENT]` messages from the run. Must be active in the same workspace. |

### Optional — task

| Flag | Default | Description |
|---|---|---|
| `--topic` | "Research and plan a feature." | One-line description of what the planners should produce a plan for. Concrete topics convergeFaster than vague ones. |
| `--planPath` | `plans/new-plan.md` | Where the lead agent will write the final markdown plan. The script watches this path for the termination signal. Should be **outside `.claude/`** (permission-dialog hangs). |

### Optional — agents

| Flag | Default | Description |
|---|---|---|
| `--leadProvider` | `claude` | Provider for the Lead agent (the writer of record). Choices: `claude`, `codex`, `grok`, `agy`. |
| `--reviewerProvider` | `codex` | Provider for the Reviewer. Cross-provider is the recommended default. |
| `--keepAgents` | (unset) | If set, leaves both planners alive after success. Default behavior is to clean them up. |

### Optional — connection

| Flag | Default | Description |
|---|---|---|
| `--api-host` | resolved from env / WSL | Dashboard API host. Falls back through `AGENT_DASHBOARD_API_HOST` env var, WSL `/etc/resolv.conf` nameserver, then `127.0.0.1`. |
| `--api-port` | tries 24678–24681 | Dashboard API port. The supplied port is tried first, then falls through the default range. |

### Optional — resume (stall recovery)

| Flag | Description |
|---|---|
| `--resume-lead-id` | Existing Lead agent ID. If set, the script re-attaches to that agent instead of launching a new one. Pair with `--resume-reviewer-id`. |
| `--resume-reviewer-id` | Existing Reviewer agent ID. Use both flags together. The script skips the initial topic seeding when resuming. |

## Events emitted to the supervisor

Every event arrives as a `[DASHBOARD EVENT]` line in the supervisor's chat. v1 emits a minimal set:

| Event | When | Payload |
|---|---|---|
| `groupthink.complete` | Lead has written the plan file | `Plan produced at <path>. Members: <lead-sid>, <reviewer-sid>` |
| `orchestration.groupthink.stalled` | Turn cap hit OR idle timeout | JSON object with `reason`, `topic`, `turns`, `planners[]`, `planPath`, `resume_hint` |

(More granular events — `started`, `turn_complete`, `plan_written` — are deferred. See `docs/GROUPTHINK_ORCHESTRATION_V1.md`.)

## Exit codes

| Code | Meaning | Agent state |
|---|---|---|
| `0` | Plan written successfully. `groupthink.complete` event sent. | Cleaned up unless `--keepAgents` |
| `1` | Unexpected error (connection failure, launch failure, etc.). Stack trace logged. | Whatever state they were in — supervisor should `stop_agent` if needed |
| `2` | Stall (turn cap or timeout). `orchestration.groupthink.stalled` event sent with full resume metadata. | **Always alive** — the script never cleans up on stall |

## Recovery contract

On exit code `2`, the supervisor's chat contains an event with a JSON payload like:

```json
[DASHBOARD EVENT] orchestration.groupthink.stalled
{
  "reason": "turn_cap_reached",
  "topic": "Sketch a 3-step plan to ...",
  "turns": 10,
  "planners": [
    {"role": "lead",     "id": "<agent-id>", "sid": "<session-id>", "provider": "claude"},
    {"role": "reviewer", "id": "<agent-id>", "sid": "<session-id>", "provider": "codex"}
  ],
  "planPath": "plans/...",
  "resume_hint": "node scripts/groupthink-v1.js --workspaceId=... --supervisorId=... --resume-lead-id=<id> --resume-reviewer-id=<id> --topic=\"...\" --planPath=\"...\""
}
```

The supervisor's three options:

1. **Steer and resume.** Use `send_message_to_agent` to redirect one or both planners. Then run the `resume_hint` command — the script re-attaches using the agent IDs and the relay loop continues with the existing agent contexts.
2. **Accept partial.** Read both agents' chats via the `read_agent_chat` MCP tool. Synthesize what's there. Optionally write a plan manually using their material.
3. **Abandon.** `stop_agent` on both. Either run fresh with a refined topic or escalate to the user.

The script will not retry, redirect, or judge consensus. Recovery is the supervisor's job by design.

## Configuration constants (in-script)

If you need to tune behavior, these are at the top of `scripts/groupthink-v1.js`:

| Constant | Default | Meaning |
|---|---|---|
| `MAX_TURNS` | `10` | Hard cap on relay turns before stall fires |
| `POLL_INTERVAL_MS` | `2000` | How often `waitTurnComplete` polls agent status |
| `MIN_READY_POLLS` | `3` | Consecutive `idle`/`waiting` status observations `waitReady` requires before treating an agent as warmed up post-launch. Only consulted during initial launch, not for turn completion. |
| `DEFAULT_PORTS` | `[24678, 24679, 24680, 24681]` | Port fallback for `connectApi` |

These are not exposed as CLI flags in v1. Edit the script directly if you need to override (rare).

Turn completion no longer gates on `agent.status`; the script reads `turnComplete: true` from the chat stream directly. With Phase 1A landed, the status field flips to `idle` within ~1 s of `turnComplete`, but the script does not depend on this.

## Pre-flight checklist

Before invocation, confirm:

- [ ] Dashboard is running and `GET /api/agents` returns 200.
- [ ] `workspaceId` corresponds to a real workspace.
- [ ] `supervisorId` is an `isSupervisor: true` agent in that workspace, currently active (status not `done` or `crashed`).
- [ ] `planPath` is outside `.claude/` (otherwise the lead's Write tool will hit a permission dialog).
- [ ] Both providers (`claude` for Lead, `codex` for Reviewer by default) are installed and on PATH.

## Known limits (v1)

- The script appends `<!-- groupthink_members: ... -->` to the plan file on success. This is architecturally wrong (run metadata bleeding into the plan artifact) and will be removed in v1.1.
- No run log on disk; logs go to stdout only.
- No supervisor validation — the script trusts the passed `--supervisorId`.
- `lead.resumeSessionId` may be `undefined` in the events if the dashboard hasn't populated the session ID by POST-response time. Verify on first run.

For the full deferred-work list and the rationale behind each, see `docs/GROUPTHINK_ORCHESTRATION_V1.md`.
