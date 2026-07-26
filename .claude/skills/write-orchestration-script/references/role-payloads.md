# Role-lane payloads & omission symptoms

Derived from `OrchestrationScriptStructure.md` §1.3–§1.5. Verified against
`src/shared/types.ts` (`LaunchAgentInput`) and `src/main/supervisor/index.ts`
(`roleLaneOf`, owner-edge validation).

## Common launch payload (§1.3)

```jsonc
{
  "workspaceId": "<AGENT_DASHBOARD_WORKSPACE_ID>", // mandatory
  "title": "<card label>",
  "roleDescription": "<persistent role, NOT the kickoff task>",
  "provider": "claude",                            // claude | codex | gemini
  "workingDirectory": "<workspace-contained root>",// NOT the runtime cwd
  "autoRestartEnabled": false,
  "owner_agent_id": "<AGENT_DASHBOARD_SELF_ID>",   // ownership edge; verbatim
  "notify_owner": true
}
```

`systemPrompt`/`roleDescription` are framing, **not** the kickoff — deliver the
task via confirmed `POST /input` after `waitReady`. Artifact paths in prompts
must be **absolute** (a relative path resolves under the lane cwd `.lares/…`).

## Role-lane additions (§1.4) — `roleLaneOf` precedence: supervisor → supervisor-privilege persona → researcher → worker → legacy

| Lane | Fields to add |
|---|---|
| Structural supervisor | `isSupervisor: true`; omit other role flags; normally no owner |
| Supervised worker | `isSupervised: true` (+ `owner_agent_id`) |
| Researcher | `isResearcher: true`, `isSupervised: true` (+ owner); Claude |
| Muted member | worker/researcher fields + `notify_owner: false` |
| Unsupervised worker | `isWorker: true`, `isSupervised: false` (+ owner) |

- `isSupervised: true` **implies** the worker lane; adding `isWorker` is redundant.
- Owner validation is **safe to over-send**: the server drops a stale/foreign/
  terminal owner edge with a `console.warn`, **never throws**.
- Concurrent codex on the shared worker cwd: set `freshSession: true` +
  `firstUserMessagePrefix` + seed highwater before kickoff.
- Do **not** set conflicting role flags and rely on precedence.

## Omission → symptom (§1.5)

| Omitted / wrong | Symptom | HTTP |
|---|---|---|
| `workspaceId` absent | agent never appears | rejected |
| `workspaceId` wrong-valid | wrong workspace, owner edge dropped | 200 |
| `owner_agent_id` absent | child floats top-level | 200 |
| `owner_agent_id` invalid/terminal/foreign | unowned; edge dropped after warn | 200 |
| `isSupervisor` absent (intended supervisor) | ordinary card, wrong cwd/toolset | 200 |
| `isSupervised` absent (child) | no structural-event fallback | 200 |
| `isResearcher` absent | wrong cwd, no researcher boundary | 200 |
| relative artifact path | file lands under `.lares/<lane>/…` | — |
