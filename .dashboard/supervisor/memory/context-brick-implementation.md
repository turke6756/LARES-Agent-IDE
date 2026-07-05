# Context Brick — Full Implementation Priming (Inc 1 → Inc 5)

> **✅ SUPERSEDED (2026-07-02, post-audit re-spec): implement from
> `plans/context-brick-implementation-final.md` — NOT from this file.**
> The audit's re-spec pass ran (serial GroupThink → `plans/context-brick-respec-groupthink.md`,
> Reviewer-approved) and the final worker-ready Inc 1→5 plan was synthesized. Headlines of what
> changed vs. this file's body: shim = `mcp-dashboard.js`/`createApiRequest` (not
> `mcp-supervisor.js`); `ensureMcpConfig` is a dead stub — env rides the parent-env
> `extraEnv`/`wslEnvPrefix` sites (seam-1 ".mcp.json env block" wording is WRONG per D-16);
> C3 dropped (done); **Inc 2 decided = dedicated `AGENT_DASHBOARD_SUPERVISOR_ID`/`X-Supervisor-Id`
> rail ≡ P1-10a, one ticket** (the "serial demotes X-Self-Id as throwaway" framing below is
> obsolete — SELF_ID already ships and stays the ownership rail; the server ignores `X-Self-Id`
> in `resolveIdentity` by recorded decision); dedicated `agents.continuation_generation` column
> with **attempt-owned successorGen** allocation; builder falls back to `getCurrentBrick()` with
> a `relaunched`-only gate + defined boot-reconcile re-drive; owned-idle gate = busy-blocklist
> (`launching|working|waiting|restarting`) + separate `isInputInFlight` guard (`receiving` never
> appears in raw DB rows); relaunch re-check adds no-owned-orchestration (`starting|running`);
> note-request rides the send handshake (HANDSHAKE FAILED = pre-attempt, no kill-auth consumed);
> constants alias `SUPERVISOR_CONTEXT_THRESHOLDS[0]`/`[2]`. This file stays as background map;
> the final plan wins every conflict.
>
> **⚠️ AUDIT ADDENDUM (2026-07-02) — read `plans/context-brick-plan-audit-2026-07-02.md` FIRST.**
> A full plan audit against the post-`b1136f2` tree found the design sound but several task
> specs below STALE. Do not implement from this file's anchors without that audit. Headlines:
> - **Shim refactored:** `mcp-supervisor.js` is a 4-line shim → real code is `mcp-dashboard.js`
>   (+ `mcp-tools-*.js`). `CALLER_HEADERS` goes in `createApiRequest` (`mcp-dashboard.js:46-86`),
>   which already sends an `Authorization: Bearer` token (API now has an auth layer).
> - **`ensureMcpConfig` is a throwing deprecated stub, zero callers** — Inc 1 C1 as written is
>   obsolete. Env rides the parent-process env sites that already set
>   `AGENT_DASHBOARD_API_TOKEN/PORT/HOST/SELF_ID` (`index.ts:2722-2727` Win, `:3127-3132` WSL).
>   C3 (port fix) is already done — drop it.
> - **`AGENT_DASHBOARD_SELF_ID=agent.id` ALREADY SHIPS** on every non-legacy Claude agent —
>   the serial run's "X-Self-Id is a throwaway rail" premise is stale. Also **D-16 forbids**
>   putting `AGENT_DASHBOARD_SUPERVISOR_ID` in the shared `.mcp.json` (parent env only).
>   Re-decide Inc 2's header choice + reconcile with B1a ticket **P1-10a** (same work item).
> - **Serial doc bugs:** uses `restartCount` as generation (decided: dedicated
>   `agents.continuation_generation`); omits the decided empty-memo/hard-ceiling escape from
>   §5B; sysprompt builder should fall back to `getCurrentBrick()` from DB (Electron-restart-
>   mid-handoff loses the in-memory map → brickless successor).
> - **Owned-idle gate wedge:** no `stopped` status exists; "idle|done" blocks forever on a
>   crashed owned worker — re-spec as a busy-blocklist. Relaunch route re-check also missing
>   the no-owned-orchestration condition.
> - Runtime claims that DID verify: restart/fresh-session/positional-prompt/`rebindAgent`/
>   `waitingKind`/`endsWithQuestion`/`owner_agent_id` — the §1/§2/§5A mechanics stand.

**Purpose of this file:** prime a future supervisor session to implement the **entire**
supervisor context-brick vision — identity foundation (Inc 1), identity-rail extension (Inc 2),
owned-agents surface (Inc 3), the continuation brick + respawn (Inc 4), and the lifecycle
watcher (Inc 5) — NOT just Increment 1. The implementation details are spread across five plan
files with phased dependencies; this consolidates the map so you don't have to re-derive it.

**Last synthesized:** 2026-06-30. All `file:line` anchors below were verified by the plan
authors against branch **`exp/gt-handshake-pressure`**. Lines DRIFT — re-anchor by symbol
(function/table name) before editing, never trust a bare line number.

---

## 0. WHY this exists (origin + the problem it solves)

A supervisor loses all working context on `/clear`, restart, crash, or compaction and wakes up
with amnesia — it doesn't reliably know **which workspace/plan it owns** or **what it was doing**.
The brick was **Edward's named fix** for the self-identity bug recorded in `MEMORY.md`
(2026-06-21 note): I once *guessed* my own `supervisor_id` for `run_orchestration` and routed
events to the wrong agent, because "who am I" was not a verifiable fact I could pull. The brick
makes identity a plumbed, validated assertion and makes "what was I doing" a handoff artifact.

Governing principle (from `supervisor-context-brick-architecture.md`): *sort every context fact
by `change-rate × size × per-action-necessity`, then route it to the cheapest channel that keeps
it correct.* Three channels:
- **Identity** (immutable) → **plumbing** (env → MCP shim header → server validation) + a
  non-canonical echo line in the system prompt.
- **Live state** (high change-rate) → **pull tools** (`list_agents`, `get_my_context`, …). NEVER
  snapshotted into a prompt (stale-at-injection).
- **Handoff memo** (written once per lifecycle, frozen, ADVISORY) → rides the rebuilt system
  prompt on respawn. It is *data the successor verifies*, never a higher-priority instruction.
- The re-orientation **protocol** lives in `CLAUDE.md` (survives compaction); the brick carries
  **data**, not procedure.

## Source-of-truth documents (read these before implementing a phase)

| Doc | Role |
|---|---|
| `plans/supervisor-context-brick-framing.md` | The GroupThink framing brief (principle, alternatives). Context only. |
| `plans/supervisor-context-brick-architecture.md` | Converged architecture: fact-routing table, 4 migration seams, security model. |
| `plans/supervisor-context-brick-implementation.md` | **Inc 1 worker spec** (tasks A/B/C/D) + the Inc 2→5 roadmap prose. |
| `plans/context-brick-nextsteps-groupthink-serial.md` | **Inc 2→5 WORKER-READY spec** — the implementation base. Red-teamed, HTTP-precise. |
| `plans/context-brick-nextsteps-groupthink-parallel.md` | Generative alt for Inc 2→5. Diverges on `X-Self-Id` (see below). Cross-reference only. |
| `plans/v2-multi-supervisor-migration-notes.md` | Origin vision (manager, graveyard, planning surface). Brick is one thread of v2. |

**Decision when serial ≠ parallel:** follow the **serial** doc. Notably serial does NOT build an
`X-Self-Id` rail — it derives the brick author from `X-Supervisor-Id` (which Inc 2 establishes) and
demotes `X-Self-Id` to a contingency note only. Parallel makes `X-Self-Id` ("Inc 2a") foundational.
Serial wins: Inc 2 is cheap and a throwaway rail is waste.

---

## THE FOUR SEAMS (every increment rides these; Inc 1 establishes them)

1. **Launch env injection** — `src/main/supervisor/index.ts` writes `AGENT_DASHBOARD_*_ID` into the
   MCP shim's `.mcp.json` `env` block (a separate spawned process; NOT the supervisor's own env).
2. **MCP shim → header** — `scripts/mcp-supervisor.js` scans env for `AGENT_DASHBOARD_(.+)_ID` and
   forwards each as `X-*-Id` on every `apiRequest`. Generic from day one → new ids cost zero shim work.
3. **Server identity middleware** — `src/main/api-server.ts` `resolveIdentity(req)` reads the headers,
   validates against DB, produces `IdentityContext`. Backward-compat gate = `identity.asserted`.
4. **Server scope predicates** — read endpoints call `resolveWorkspaceScope(identity, qp)`.

Inc 2/3 are **pure additions on these seams**. Inc 4 is **net-new plumbing** (reuses ONLY seam-1's
per-spawn `--append-system-prompt-file` echo). Inc 5 adds a watcher module.

---

## PHASED DEPENDENCY GRAPH — build in this order (hard requirements)

```
Inc 1  identity + get_my_context + standing re-orientation instruction
   │      (foundation; establishes all 4 seams)
   ├── Inc 2  supervisor_id / project_id identity rail        ← additive; HARD-REQUIRED before Inc 4
   ├── Inc 3  owned-agents / graveyard in get_my_context      ← additive; must precede Inc 4 Block C
   └── Inc 4  continuation brick + continuationRelaunch()     ← NET-NEW plumbing; needs Inc 2 + Inc 3
          └── Inc 5  lifecycle watcher                        ← needs Inc 4 routes/tool/event + Inc 3 owned-idle
```

**⚠️ CURRENT BUILD STATUS (verify before starting):** the serial doc *assumes* "Inc 1 = shipped
foundation", but `supervisor-context-brick-implementation.md` shows **all Inc 1 tasks A/B/C/D still
`☐ not started`**. So the true starting point is **Inc 1**. Confirm on disk first: grep
`api-server.ts` for `resolveIdentity`, `mcp-supervisor.js` for `CALLER_HEADERS`,
`constants.ts` for `get_my_context` / `Re-Orientation on Revival`. If absent → Inc 1 is unbuilt;
do it first. Do NOT jump to Inc 4 — it cannot compile without Inc 2's `X-Supervisor-Id` author binding
and Inc 3's owned-agent ids for Block C.

---

## INCREMENT 1 — identity foundation (spec: implementation.md tasks A–D)

Scope is **`workspace_id` only**. Backward-compat is load-bearing: every existing UI/IPC caller
sends NO header → `asserted:false` → today's exact code path. Ship server-side FIRST (dead-code
until the shim sends headers).

**A. `src/main/api-server.ts`**
- **A1** `resolveIdentity(req): IdentityContext` — insert between URL parse (~`:66`) and `route()`
  (~`:67`), AFTER the `OPTIONS` short-circuit (`:59–63`). Thread result as a new 4th arg to `route()`
  (sig `:132`). `IdentityContext = { workspaceId, supervisor: Agent|null, asserted, projectId, supervisorId }`.
  Header absent → `asserted:false`, all null. Header present: `getWorkspace(id)` missing → **403**;
  `getSupervisorAgent(id)` missing → **403** (add to import block `:4–13`). Throw `Object.assign(err,{statusCode})`
  — the `catch` at `:70–83` maps it to HTTP.
- **A2** `resolveWorkspaceScope(identity, qpWorkspace): string|null` — matrix: header absent → return
  `qpWorkspace` (today); present + no qp → `identity.workspaceId`; present + matching qp → ok; present +
  mismatched qp → **403**.
- **A3** apply scope to read endpoints: `GET /api/agents` (`:136`), `/api/teams` (`:485`), `/api/personas`
  (`:909`), `/api/templates` (`:930`).
- **A4** new `GET /api/supervisor/context` (insert before the `/api/orchestrations*` block `:437–470`).
  Returns `{ workspaceId, workspaceTitle, supervisor{id,title,provider,status}, counts{total,live,supervised} }`
  from existing db fns (`getWorkspace`, `getSupervisorAgent`, `getAgentsByWorkspace` `:466`). No header + no
  `?workspaceId=` → 400; unknown ws → 404.
- **A5** CORS — extend allow-headers (`:57`) to
  `'Content-Type, X-Workspace-Id, X-Project-Id, X-Supervisor-Id'`. **Without this the renderer's preflight
  silently blocks any request carrying the header.**

**B. `scripts/mcp-supervisor.js`**
- **B1** build `CALLER_HEADERS` after `const API_BASE` (`:42`): scan `process.env` for
  `/^AGENT_DASHBOARD_(.+)_ID$/`, camelCase → `X-<Part>-Id`. (`_API_PORT`/`_HOST` don't match `_ID`.)
- **B2** forward on every call: spread `...CALLER_HEADERS` into the `apiRequest` headers (`:54`). One spread
  covers ~30 call sites.
- **B3** `get_my_context` tool (no args) → `GET /api/supervisor/context`, return JSON pretty-printed.
- **B4** make `workspace_id` OPTIONAL (drop from `required`, omit query/body field when absent — server
  fills from header). `list_agents` (`:675`) already does this — mirror it for `launch_agent`, `create_team`,
  `list_teams`, `list_templates`, `create_persona`. **Leave `run_orchestration` `workspace_id`+`supervisor_id`
  REQUIRED this increment** (`:405`).

**C. `src/main/supervisor/index.ts`** (launch plumbing)
- **C1** inject `AGENT_DASHBOARD_WORKSPACE_ID` into the shim `.mcp.json` `env` at all supervisor sites. Add a
  workspaceId param to `ensureMcpConfig` (sig `:1888`; callers `:1170`/`:1172` pass `resolvedInput.workspaceId`,
  reconcile `:4106`/`:4108` pass `agent.workspaceId`). Sites: Windows base env `:1895–1897`; WSL env `:1938–1941`;
  Windows inline `--mcp-config` in `launchWindowsAgent` `:2162–2173`. Team-config sites are workers — OUT of scope.
- **C2** supervisor-only identity echo in the append-system-prompt file. Wrap in `if (agent.isSupervisor)`.
  Windows `:2184–2196` (`const sysPrompt` `:2186`), WSL `:2557–2561` (flag appended `:2668–2675`). Text: a
  `Situational identity (echo only …)` line with `workspace_id`/`workspace_root`, "do NOT pass as tool args".
- **C3** fix hardcoded port: replace the three `'24678'` literals with `String(this.apiServerPort)`
  (set by `setApiServerPort()` `:3197`; shim keeps its `|| '24678'` fallback `mcp-supervisor.js:22`).

**D. `src/shared/constants.ts` — `SUPERVISOR_AGENT_MD`** (the scaffolded CLAUDE.md)
- **D1** add `## Re-Orientation on Revival` section (call `get_my_context` first on any revival; treat
  `supervisor.wake` as a hint not authoritative state; self-orient via tools).
- **D2** add a `get_my_context` bullet under `## Your Tools`.
- **D3/D4 — SCAFFOLD MIGRATION DISCIPLINE (critical, do not hand-edit on-disk CLAUDE.md):** the scaffold is
  version-managed (`writeScaffoldMap`, `ensureSupervisorScaffold`, `supervisor/index.ts` ~`:1309`). To ship a
  CLAUDE.md change you MUST bump the `SUPERVISOR_FILES` CLAUDE.md entry `version` and append the prior content's
  SHA-256 to `previousHashes` (add a `SUPERVISOR_AGENT_MD_V*_HASH` constant). An edit WITHOUT the bump never
  reaches existing workspaces (same-version sidecars skip). Wrap the additions in an idempotent versioned
  sentinel (e.g. `<!-- reorientation-note-v1 -->`) — the CLAUDE.md surface has 3 colliding tickets appending to
  it; append only, never rewrite a section. A hand-edit gets `.bak`'d + overwritten at next launch.

**Inc 1 acceptance:** self-scope works with no arg; foreign `workspace_id` → 403; matching explicit arg ok;
`get_my_context` returns the summary; UI/IPC (no header) byte-identical; header-unset shim harmless; invalid
header → 403; CORS passes; CLAUDE.md has the section + sidecar records new version; non-default port reflected.

---

## INCREMENT 2 — extend identity rail to supervisor_id (+ project_id)

Pure additions on the four seams. Add the env vars (seam 1), forward headers (seam 2 = already generic, zero
shim work), read+validate server-side (seam 3), grow `get_my_context` to answer *who* (this supervisor), not
just *where* (workspace). **HARD-REQUIRED before Inc 4** — Inc 4's author binding derives from `X-Supervisor-Id`.
Retire the transitional "newest supervisor" (`getSupervisorAgent` = `ORDER BY created_at DESC LIMIT 1`,
`database.ts:474`) fallback once a real `X-Supervisor-Id` is honored.

---

## INCREMENT 3 — owned-agents & graveyard into get_my_context

The `owner_agent_id` edge **already ships** (v2 notes §7-bis; `database.ts:767,942`). Surface it:
`get_my_context` / a new `list_my_agents` return the agents this supervisor owns — live AND terminated
("graveyard"). Live status stays **pull-only**; never snapshot it. **Must precede Inc 4 Block C**, which names
owned-agent ids and what each was mid-way on. Add `getAgentsByOwner(ownerId, {includeTerminal})`.

---

## INCREMENT 4 — continuation brick + continuationRelaunch() (the core mechanism)

Spec: `context-brick-nextsteps-groupthink-serial.md` §1–§4, §6, §7. **9 deliverables consolidated at the
bottom of that doc.** Key pieces:

### 4.1 `continuationRelaunch(agentId, brick)` — NEW sibling method in `supervisor/index.ts` (~after `:3838`)
**DO NOT mutate `restartAgent` (`:3807`)** — its `resume=true` backs the restart button + reconcile; must keep
resuming the OLD session. The new method mints a FRESH session while reusing the same dashboard id.
Verified facts it rides on:
- Session mint+persist+invalidate block (`:1569–1573`: `uuidv4()` → `updateAgentResumeSessionId` →
  `invalidatePath`) lives in `launchAgent`, which relaunch does NOT call — so do it yourself.
- Fresh-launch branch `if (!resume && sessionId && isClaude)` (`:2500`) emits `--session-id` from the
  `sessionId` **param** (not `agent.resumeSessionId`).
- On `!resume`, Windows positional (`:2558`) AND WSL `.prompt-*` positional (`:3288`) re-append `agentMdPrompt`
  (the original task). Pass **`agentMdPrompt = null`** to suppress BOTH — else the successor re-runs the old task.
- System prompt file is rewritten on EVERY spawn (`:2480–2488` Win, `:3254`/`:3278` WSL) → brick rides
  `--append-system-prompt-file`, no new injection plumbing.

**Sequence (guard FIRST, before any stop):**
1. `getAgent`; if not `provider==='claude'` → throw (never stop a non-eligible agent).
2. `stopAgent` (clears `pendingInitialPrompts` `:3764`); `monitor.forgetAgent`; delete
   `pendingInitialPrompts` + `lastEndsWithQuestion` for the id.
3. `const newSession = uuidv4()`; `updateAgentResumeSessionId(id, newSession)`;
   `sessionLogReader.rebindAgent(id)` — **ONE call**; it delegates `invalidatePath` to every reader
   (`session-log-dispatcher.ts:292`) and emits `agent-rebound` → purges ring/context-stats/`file_activities`
   (the real BUG-26 exposure). Do NOT double-call `invalidatePath`; do NOT pre-touch the new path.
4. `incrementRestartCount`; `generation = getAgent(id).restartCount`; `addEvent(id,'continuation',{generation,
   handoffAttemptId, noteId, reason, newSession})`; `updateAgentStatus(id,'restarting')` + emit `statusChanged`
   with `source:'continuation'`.
5. `pendingContinuationBricks.set(id, brick)` (read by the per-spawn sysprompt builder).
6. `setTimeout(1000)` → relaunch: `launchWindowsAgent(latest, false, null, newSession, undefined, true)` OR
   `launchWslAgent(latest, false, null, undefined, newSession, true)` (positional session id + `freshSession=true`;
   `resume=false` ALONE launches with NO session id). On throw → status `crashed` + `source:'continuation-failed'`.
   `finally` → delete `pendingContinuationBricks`.

New fields: `pendingContinuationBricks: Map<string,ContinuationBrick>`, `lastEndsWithQuestion: Map<string,boolean>`.
`ContinuationBrick = { handoffAttemptId, noteId(=bricks.id), reason?, note, workspaceId }`.

### 4.2 Sysprompt plumbing (the one Inc-1 seam Inc 4 reuses)
In BOTH sysprompt builders, after the supervisor identity echo, if `pendingContinuationBricks.get(agent.id)`
exists append the deterministically rendered **Blocks A/B/C** (§7), enforcing
`CONTINUATION_BRICK_RENDER_MAX_BYTES`.

### 4.3 Storage — `src/main/database.ts` (append rows, server-minted attempts)
- `continuation_bricks` — APPEND one row per handoff (soft `superseded_at`, **NO hard delete, NO cascade FK** so
  the §5 graveyard survives agent deletion). Cols: `id`(uuid=noteId), `dashboard_agent_id`, `handoff_attempt_id`,
  `generation`, `note`, `note_source`('tool'|'scrape'), `byte_len`, `written_at`, `superseded_at`. Index
  `(dashboard_agent_id, written_at DESC)`.
- `continuation_handoff_attempts` — SERVER-MINTED. Cols: `id`, `dashboard_agent_id`, `generation`, `started_at`,
  `closed_at`, `status`('open'|'committed'|'aborted'|'relaunched'), `reason`, `threshold_context_pct`. Index
  `(dashboard_agent_id, status)`. **Reject a 2nd `open` attempt** for the same agent (one live at a time).
- Track handoff generation in a **dedicated `agents.continuation_generation` column** — do NOT reuse
  `restart_count` (keep that = crash restarts).  *(Note: §1's code uses `restartCount` for `generation`; the
  data-model section calls for a dedicated column — reconcile toward the dedicated column when implementing.)*
- Helpers: `insertContinuationBrick` (append + supersede prior), `getLatestBrickForAttempt(agentId, attemptId,
  {source})` (gate authority, `source:'tool'`), `getCurrentBrick(agentId)` (sysprompt builder),
  `createContinuationHandoffAttempt` (mint, reject if open exists), `getOpenContinuationAttempt`,
  `closeContinuationHandoffAttempt(id, status)`.

### 4.4 Routes — `src/main/api-server.ts`
- `POST /api/agents/:id/continuation-attempt` (author via `X-Supervisor-Id`) → `createContinuationHandoffAttempt`,
  returns `{ attemptId }`. Watcher opens the attempt BEFORE injecting the "write your note" message.
- `POST /api/supervisor/continuation-brick` `{ note }`: author = `identity.supervisor` from `X-Supervisor-Id`;
  body carrying any `agent_id`/`dashboard_agent_id` → **400**; header supervisor not the ws supervisor → **403**;
  no open attempt → **409**; `Buffer.byteLength(note,'utf8') > CONTINUATION_BRICK_MAX_BYTES` → **413** (trim-to-
  pointers message, NO silent truncation); else `insertContinuationBrick(note_source:'tool')` + attempt
  `open→committed`, return `{ id }`.
- `GET /api/supervisor/continuation-brick?agentId=&attemptId=&source=tool` — watcher's commit-observation read.
- `POST /api/agents/:id/continuation-relaunch` → `continuationRelaunch(id, brick)` ONLY after re-checking
  **server-side, atomically, against fresh reads:** attempt is current + `status='committed'`; a
  `continuation_bricks` row for that attempt with `note_source='tool'` AND `written_at > attempt.started_at`;
  every owned agent (`owner_agent_id=:id`) `idle`/`done`; `supervisor.isAwaitingHuman(:id)===false`. Any fail →
  **409/425, NO kill**. On success → `closeContinuationHandoffAttempt(id,'relaunched')`.

### 4.5 Tool — `scripts/mcp-supervisor.js`
`save_continuation_brick({ note })` — NO `workspace_id`, NO `agent_id` (author header-derived). Handler POSTs
`{ note }` with `...CALLER_HEADERS`.

### 4.6 Constants — `src/shared/constants.ts`
`CONTINUATION_BRICK_MAX_BYTES = 6144` (raw note; reject 413), `CONTINUATION_BRICK_RENDER_MAX_BYTES = 8192`
(rendered A+B+C; over-cap → **abort continuation, keep process alive, page human**). **Reject, never truncate.
No pointer-only fallback** this increment. The 2 KB headroom reserves A/B framing. *(Fresh budget — NOT aligned
with PLAN_SUBSCRIPTION_MIGRATION D-06's 25-plan wake cap.)*

### 4.7 Event/status typing
`status-events.ts:3` — `StatusChangeSource += 'continuation' | 'continuation-failed'`. `'continuation'` is a DB
event-log string via `addEvent` (like `clear_session_rotated` `:2943`); add to the renderer event-label map so
the timeline distinguishes it from `reconnected`/`restart`/`clear_session_rotated`.

### 4.8 Brick contents (Blocks A/B/C — §7)
- **A Handoff header** (generated): "You are CONTINUATION #N — a session reset, not a new assignment." · `reason`
  · timestamp · advisory "the note below is your predecessor's best guess — confirm against your tools before acting."
- **B Identity echo** (generated): `dashboard_agent_id` + `workspace_id` (+ `supervisor_id`/`project_id` post-Inc2),
  non-canonical, "tools auto-scope; do not pass as args." Reuses Inc 1's echo line.
- **C Predecessor's note** (authored, from `continuation_bricks`): current phase · directional next steps ·
  agents to launch (kind / ~how many / which phases) · pointers (file paths + plan ids + **owned-agent ids** and
  what each was mid-way on, from Inc 3) · watch-outs.
- **Pull-only, named by id, NEVER snapshotted:** owned-agent live status, plan focus/run-states
  (`supervisor.wake` + `list_my_plans`), file/plan bodies (`Read` via pointers).

---

## INCREMENT 5 — lifecycle watcher (automation)

A **dedicated in-process module** (`continuation-watcher.ts`, NOT folded into `status-monitor.ts`) — pure
decision logic with injected effects, mirroring `claude-clear-rotation.ts`. **Never mutates runner/session
state, never mints attempt ids locally.** Observes DB + calls authenticated routes; trigger authority stays in main.

### 5A. `isAwaitingHuman(agentId)` helper — REQUIRED (DB status is insufficient)
`waitingKind` is transient payload; a Claude question-ending turn is intentionally **`idle`**, not
`waiting/question` (`event-bridge.ts:447` — `endsWithQuestion` no longer manufactures `waiting`). So inspect the
last completed assistant turn.
- `status-monitor.ts` — add public `getWaitingKind(agentId): WaitingKind|null` reading the latch (field is
  **`waitingKind`** `:56`/`:320`/`:334`, NOT `kind`; latch is private `:126`). Return kind only when
  `state==='waiting'`.
- `index.ts` — cache `lastEndsWithQuestion` from `assistant-text` / `assistant-text-patch` events (where
  `endsWithQuestion !== undefined`) in the `chat-events` handler (`:1104–1107`), BEFORE `bridge.onChatEvents(batch)`.
  `endsWithQuestion` is already computed per reader (`trimmed.endsWith('?')`, e.g. `gemini-transcript-reader.ts:349`,
  `codex-rollout-reader.ts:327`), set only on completed turns. *(Confirm exact `ChatEvent` discriminant strings
  against the reader/dispatcher types before wiring.)*
- Helper: `isAwaitingHuman(id)` = `getWaitingKind(id)==='question'` OR (`status==='idle'` AND
  `lastEndsWithQuestion.get(id)===true`). Clear the cache in `stopAgent`/`forgetAgent`/`continuationRelaunch`.

### 5B. Watcher loop (fail-safe state machine)
Trigger (ALL must hold): self ctx ≥ threshold **AND** self idle ≥ DEBOUNCE (**≥2 consecutive idle ticks**, not
one; use the existing `StatusMonitor` latch — don't reinvent idle) **AND** `isAwaitingHuman(self)===false` **AND**
every owned agent (`owner_agent_id`) idle|done **AND** no owned orchestration running. Then:
`POST …/continuation-attempt` → inject "write your successor note via save_continuation_brick" user message →
poll `GET …/continuation-brick?…&source=tool` until COMMITTED → `POST …/continuation-relaunch`; or TIMEOUT
(`HANDSHAKE_TIMEOUT_MS`, no committed row) → ABORT: close attempt `aborted`, `addEvent 'continuation_aborted'`,
**keep process ALIVE, page human, back off.**

**HARD RULES:**
- **Kill authorization = exactly one thing:** a `note_source='tool'` `continuation_bricks` row for the CURRENT
  attempt with `written_at > attempt.started_at`. A scrape NEVER authorizes.
- **Commit-observed timeout, not tool-response-observed:** poll the DB row. Tool/HTTP timeout AFTER commit =
  success; BEFORE commit = keep-alive.
- **Fail-safe direction is ALWAYS keep-alive + page human** (timeout, scrape-only, owned-busy, awaiting-human).
  A stuck-alive supervisor is recoverable; a killed-without-note one loses its handoff.
- **Re-check owned-idle + `isAwaitingHuman` atomically INSIDE the relaunch route** against fresh reads.
- **Empty-memo escape (hard-ceiling rescue):** no note + ctx BELOW hard ceiling → abort-don't-kill, retry later.
  No note + AT hard ceiling → proceed with a "none" Block C + a Block A "no note captured — self-orient fully"
  advisory, so a 100%-context supervisor is never permanently stuck.
- **Scrape = advisory only** — may be stored `note_source='scrape'` for a human, never read by the gate.

### Delivery channel: continuation-relaunch (preferred) vs `/clear`-in-place (fallback)
Relaunch = real respawn → system prompt rebuilt → brick rides `--append-system-prompt-file`, same dashboard id.
`/clear`-in-place keeps the same process+id but does NOT respawn, so the brick must arrive as a **user message**
(weaker — doesn't survive a later compaction). Reserve `/clear` for handoffs where killing the process is
undesirable (open shell mid-task). Machinery = existing `claude-clear-rotation.ts`.

---

## CROSS-CUTTING LANDMINES (don't relearn these the hard way)

- **Shared-cwd invariant (workspace CLAUDE.md):** many agents share one cwd/slug by design. NEVER key
  supervisor↔session mapping on "one agent per cwd." The brick keys off dashboard agent id (survives respawn) —
  keep it that way.
- **`.claude/` write gate:** agents can't durably edit under `.claude/` (interactive dialog even with bypass).
  Point any authored artifact outside `.claude/`.
- **Restart ≠ continuation:** the restart button/reconcile must stay byte-identical (resume old session). All the
  fresh-session logic is a SIBLING path.
- **Windows/PowerShell quoting:** multi-word launch args lose quotes through `Start-Process`/`powershell -Command`
  — prefer `bash -lc`, verify with `Win32_Process.CommandLine`.
- **Scaffold migration:** any `SUPERVISOR_AGENT_MD` edit needs a `version` bump + `previousHashes` entry + a
  sentinel; else it never reaches existing workspaces. THREE tickets collide on that surface — append only.
- **Line numbers drift** — all anchors verified at `exp/gt-handshake-pressure`; re-anchor by symbol before editing.

## Build/verify per phase
Server-side (api-server) ships first and is dead-code until the shim sends headers. `npm run build:main` after
main-process edits; shim is plain JS (no compile). `npm run restart` to relaunch Electron so new `.mcp.json` +
sysprompt + middleware take effect. Restart the running supervisor to trigger the scaffold migration for CLAUDE.md
changes; review any `.bak.<ts>` it leaves. Acceptance criteria: implementation.md (Inc 1, 10 items) + serial doc
(Inc 2→5, 12 items). Tests: unit (`resolveIdentity`, `resolveWorkspaceScope`, `getWaitingKind`, `isAwaitingHuman`,
attempt lifecycle, author-binding 400/403, cap 413, relaunch-gate 425/409); integration (full handshake happy-path,
timeout-before/after-commit); regression (BUG-26 sibling isolation post-continuation, restart button still resumes).
```
