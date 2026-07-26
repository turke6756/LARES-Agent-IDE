# API contract & lifecycle idioms

Derived from `OrchestrationScriptStructure.md` §1.1–§1.3, §1.6, §2. Every row
traces to a spec §; no independent normative claims.

## Identity env vars (§1.1)

| Env var | Use |
|---|---|
| `AGENT_DASHBOARD_API_TOKEN` | `Authorization: Bearer …` on **every** request |
| `AGENT_DASHBOARD_API_PORT` | authoritative endpoint (dashboard-launched) |
| `AGENT_DASHBOARD_SELF_ID` | `owner_agent_id` (ownership) + `X-Self-Id` (provenance) |
| `AGENT_DASHBOARD_WORKSPACE_ID` | default `workspaceId` in launch bodies |
| `AGENT_DASHBOARD_SUPERVISOR_ID` | terminal/stall delivery target; `X-Supervisor-Id` |
| `AGENT_DASHBOARD_API_HOST` | default `127.0.0.1` (WSL: resolve resolv.conf) |
| `AGENT_DASHBOARD_PROJECT_ID` | `X-Project-Id` |

## Four independent request concerns (§1.2) — none substitutes for another

| Concern | Mechanism | Server |
|---|---|---|
| Authentication | `Authorization: Bearer` | missing/invalid → **401** |
| Caller scope | `X-Workspace-Id` / `X-Supervisor-Id` / `X-Project-Id` | `resolveIdentity` validates |
| Read provenance | `X-Self-Id` | plan-read breadcrumb only; **never** scope/ownership |
| Ownership edge | `owner_agent_id` in the **launch body** | re-validated; drop-never-throw |

`resolveIdentity` deliberately does **not** read `X-Self-Id`.

## HTTP failure reference (§1.6)

`401` missing/invalid bearer · `403 unknown-workspace` · `403 workspace-scope-mismatch`
· `403 unknown-supervisor` / `supervisor-workspace-mismatch` / `not-a-supervisor`
· `400` unknown `plan_id` · `409` input to a non-ready agent (§2 step 6).

## Lifecycle idioms — purpose → rule → bug prevented (§2)

| # | Idiom | Rule | Prevents |
|---|---|---|---|
| 1 | `connectApi` | injected port; fail closed on-behalf; range-probe standalone only | blind probing |
| 2 | capture ids | record each agent id immediately after launch | unrecoverable partial failure |
| 3 | `launchAgent` | exact lane payload; **no task prompt in the body** | kickoff never arms |
| 4 | `waitReady` | poll to idle/waiting; fail on done/crashed/timeout | acting on a cold agent |
| 5 | `seedHighwater` | composite (ts+hash); seed fresh, **preserve on resume** | BUG-06/37 re-stall |
| 6 | `kickoff`/`confirmedSend` | `POST /input {confirm:true}`; 409→`waitReceiverReady`+retry; unconfirmed→evidence-gated submit-only Enter, never re-send prompt | 409 crash, duplicate task |
| 7 | `waitTurnComplete` | new `turnComplete` beyond highwater; status only for hard-exit / soft-extend | idle treated as terminal |
| 8 | `waitReceiverReady`+`relay` | gate every send; advance **every** participant's highwater | BUG-17b, stale-turn |
| 9 | verify deliverable | explicit predicate; token newest-first; artifact freshness after grace | false success |
| 10 | `retire` | terminal-state-specific; stall → leave alive | deleting resume context |
| 11 | `reconcile`/`resume_hint` | restore state, never reseed valid highwater; `deliverToSupervisor`+sentinel | lost result, self-fork |

Exit codes (CLI convention, not HTTP): `0` ok · `2` recoverable stall · `1` crash.
