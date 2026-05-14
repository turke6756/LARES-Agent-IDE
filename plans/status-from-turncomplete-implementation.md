# Implementation Plan: Derive Agent `status` from `turnComplete`

Worker-ready spec for the proposal in `docs/STATUS_FROM_TURNCOMPLETE.md`. Read that doc first for motivation. This file says exactly what to change, where, and why.

## Summary

Today, agent `status` is mutated by two independent code paths that drift apart for minutes at a time (the 2026-05-13 codex incident). The chat ingestion layer already detects turn-end authoritatively via `AssistantTextEvent.turnComplete`. This plan wires that signal into the status field as a new (and priority) writer, then constrains the existing process-watcher (`StatusMonitor`) so it stops competing on the working↔idle axis. `StatusMonitor` is retained as a crash/exit detector and as a fallback for cases where no chat events ever land.

## Investigation findings

### Where `turnComplete: true` is set (per provider)

| Provider | File / function | Trigger |
|---|---|---|
| Claude | `src/main/supervisor/log-readers/claude-jsonl-reader.ts:269` (`parseEntry`, `entry.type === 'assistant'` branch) | `msg.stop_reason === 'end_turn'` → applies to every text block in that assistant message (`AssistantTextEvent.turnComplete = turnComplete` at line 286). |
| Codex | `src/main/supervisor/log-readers/codex-rollout-reader.ts:273-283` (`parseEntry`, `event_msg/task_complete` or `turn_aborted` branch) | When the rollout writes `payloadType === 'task_complete'` or `'turn_aborted'`, the reader walks **the current poll's `out` array backwards** and stamps the last `assistant-text` it finds with `turnComplete = true`. The assistant text itself comes from a separate `response_item/message role=assistant` entry (line 291-318). |
| Gemini | `src/main/supervisor/log-readers/gemini-transcript-reader.ts:321-330` | Every assistant text event is emitted with `turnComplete: true` hard-coded — Gemini's transcript format writes one assistant entry per turn, so the assumption is "every assistant text IS a complete turn." |

Cross-check on adapter correctness (item 5 of the task):

- **Claude**: correct. `stop_reason: end_turn` is exactly the "model voluntarily stopped" marker; non-end_turn (e.g. `tool_use`, `max_tokens`) correctly stay `turnComplete: false`.
- **Gemini**: correct *for the transcript file format we read*. Every persisted assistant entry is the result of a completed turn; mid-stream thoughts go into a separate `thoughts` array (line 300-308 emits them as `thinking` events, no `turnComplete` field). Risk note: if a future Gemini version writes interim assistant entries, the hard-coded `true` becomes wrong. Low probability today.
- **Codex**: ⚠️ has a latent race the plan must call out (not fix here). The retro-marking at line 273-283 scans `out` — which is `newEvents` local to a single `pollSession()` call (passed in at line 193). If the `task_complete` line arrives in a *later* poll tick than the `response_item/message` line, the assistant-text is already flushed without `turnComplete` and the flag is lost forever. In practice codex writes both lines within milliseconds and they land in the same poll batch (poll interval 1s for subscribed, 5s for unsubscribed). The 2026-05-13 incident did receive `turnComplete: true`, so the current implementation is good enough for now. **Smoke test below must verify this still holds; if it ever fires, fix is to persist a per-agent "pending assistant text uuid" across polls and mark retroactively at next flush.**

### Where agent `status` is mutated today

Grep results filtered to actual writers (not reads or filter clauses):

| Writer | File:line | Sets to |
|---|---|---|
| Process-watcher idle/working/done/crashed inference | `src/main/supervisor/status-monitor.ts:44` (`StatusMonitor.poll` → `inferStatus`) | `working`, `idle`, `done`, `crashed` based on `checkAlive` + `lastOutputTime` elapsed vs `WORKING_THRESHOLD_MS` (8s) |
| Windows runner exit | `src/main/supervisor/index.ts:1064` | `done` (exit 0) or `crashed` (nonzero) |
| Windows launch | `src/main/supervisor/index.ts:1101` | `working` (initial state right after spawn) |
| WSL runner exit | `src/main/supervisor/index.ts:1272` | `done` / `crashed` |
| WSL launch | `src/main/supervisor/index.ts:1290` | `working` |
| Auto-restart starting | `src/main/supervisor/index.ts:1304` | `restarting` |
| Auto-restart failed | `src/main/supervisor/index.ts:1321` | `crashed` |
| Manual `stopAgent` | `src/main/supervisor/index.ts:1554` | `done` |
| Manual `restartAgent` | `src/main/supervisor/index.ts:1587` / `:1602` | `restarting` / `crashed` |
| Reconcile (reconnect failed) | `src/main/supervisor/index.ts:1893` | `crashed` |
| DB writer (called by all of the above) | `src/main/database.ts:395` (`updateAgentStatus`) | any |

The lag comes from `StatusMonitor.inferStatus` (status-monitor.ts:56-72): when the codex CLI keeps writing internal-cleanup output to the PTY for minutes after the turn-complete marker, `lastOutputTime` stays fresh, `elapsed < WORKING_THRESHOLD_MS`, and the monitor returns `'working'`. The `statusChange` debounce (`statusHoldUntil`, status-monitor.ts:46) only delays writes by 1.5-2.5s — it doesn't prevent the underlying inference from being wrong.

### IPC path (renderer spinner reaction)

Already in place, no changes required:

- `AgentSupervisor.emit('statusChanged', { agentId, status })` — emitted by `StatusMonitor` (via `monitor.on('statusChanged', ...)` re-emit at `src/main/supervisor/index.ts:243`) and by every direct writer in supervisor/index.ts.
- IPC bridge: `src/main/ipc-handlers.ts:362-367` — listens to `supervisor.on('statusChanged', ...)`, re-fetches the agent record, sends `agent:status-changed` to the renderer via `webContents.send`.
- Preload: `src/preload/index.ts:128` — exposes `onAgentStatusChanged`.
- Renderer: `src/renderer/App.tsx:58-64` — calls `useDashboardStore.updateAgent(agent)` on every event; the agent card's spinner reads `agent.status` from the store (`AgentCard.tsx:225` gates on `'working'`).

The new ingestion writer must emit `statusChanged` on the same `AgentSupervisor` instance, with the same payload shape, and **must call `updateAgentStatus()` first** so the re-fetched agent in the IPC handler reflects the new status.

The WebSocket path at `src/main/ws-server.ts:127` listens to the same `statusChanged` event — it also gets the fix for free.

## Proposed change

### Hook point selection

Two reasonable options were considered:

| Option | Where | Pros | Cons |
|---|---|---|---|
| **A: New `chatEvents` listener on `AgentSupervisor`** | `src/main/supervisor/index.ts:270-272` (sibling subscriber) | Lives next to existing event plumbing; uses already-shaped events; no changes to per-provider readers. | Runs once per `chatEvents` batch — must scan for turnComplete on each. |
| B: Add `turnCompleted` event from `SessionLogDispatcher` | `src/main/supervisor/session-log-dispatcher.ts:241-245` (where other typed events are re-emitted) | Slightly more efficient (no scan). | Adds a new event type to the dispatcher's public surface; needs cross-package event-name discipline. |

**Recommendation: Option A.** Smaller surface area, no new event type, the scan cost is negligible (events per batch ≤ ring-buffer chunk, typically <20). Code lives in one place (`AgentSupervisor`) alongside all the other status writers.

### Race-safety: who wins?

**Priority order (lowest writer to highest):**

1. `StatusMonitor.inferStatus` → `working` / `idle` (process-activity heuristic) — *now constrained*.
2. Ingestion `turnComplete` listener → `idle` — *new, priority for the working↔idle axis*.
3. `launchAgent` / `runner.on('exit')` / `stopAgent` / `restartAgent` → `launching` / `working` / `restarting` / `done` / `crashed` — *highest priority for terminal & transition states; unchanged*.

**Enforcement mechanism — in-memory hold map on `StatusMonitor`:**

When ingestion writes `idle`, it also calls `monitor.noteIngestionIdle(agentId)`, which records `Date.now()` in a private `ingestionIdleAt: Map<string, number>`. `StatusMonitor.inferStatus` then refuses to return `'working'` purely from PTY-activity recency while the hold is fresh (e.g. within `INGESTION_IDLE_HOLD_MS = 60_000` of the last ingestion-marked idle). Two clearing paths:

- Hold expires after `INGESTION_IDLE_HOLD_MS`.
- Hold is explicitly cleared by a subsequent ingestion event that signals "new turn started" — any `assistant-text` with `turnComplete !== true`, any `thinking` event, or any `user-text` (means the user/orchestrator sent new input). In that case the listener also writes `'working'` so the spinner re-appears.

This preserves StatusMonitor's authority over `done`/`crashed` (those run *before* the hold check in `inferStatus`, at line 62-65) and over the initial `working` write at launch (the supervisor sets it directly, the hold doesn't apply).

The hold map is in-memory only — process restarts drop it, but reconcile() relaunches agents with `working` state, so the hold isn't needed across restarts.

### Edit 1 — `src/main/supervisor/status-monitor.ts`

Add the hold-map fields, two public methods, and consult the hold inside `inferStatus`.

**At top of class (after line 11 `private statusHoldUntil = new Map<string, number>();`):**

```ts
// Ingestion-driven idle hold. The chat-ingestion layer (AgentSupervisor's
// chatEvents listener) calls noteIngestionIdle(agentId) when a message with
// turnComplete: true lands. While the hold is fresh, inferStatus() will not
// downgrade an idle agent back to 'working' purely from PTY-activity recency
// — codex emits stdout for minutes after its turn ends, which is exactly the
// signal we no longer want to treat as "working." Process-exit transitions
// (done/crashed) still override the hold.
private static INGESTION_IDLE_HOLD_MS = 60_000;
private ingestionIdleAt = new Map<string, number>();
```

**After `stop()` (~line 32), add:**

```ts
/** Called by AgentSupervisor when a turnComplete:true event lands. */
noteIngestionIdle(agentId: string): void {
  this.ingestionIdleAt.set(agentId, Date.now());
}

/** Called by AgentSupervisor when a new-turn signal (mid-stream
 *  assistant-text, thinking, or user-text) lands and the agent should
 *  be marked 'working' again. */
clearIngestionIdle(agentId: string): void {
  this.ingestionIdleAt.delete(agentId);
}
```

**Modify `inferStatus` (line 56-72) — insert the hold check between the !alive branch and the elapsed-based decision:**

```ts
private async inferStatus(agent: Agent): Promise<AgentStatus | null> {
  if (agent.status === 'restarting' || agent.status === 'launching') {
    return null;
  }

  const alive = await this.checkAlive(agent);
  if (!alive) {
    if (agent.lastExitCode === 0) return 'done';
    return 'crashed';
  }

  // Honor the ingestion-driven idle hold. See INGESTION_IDLE_HOLD_MS comment.
  const idleSince = this.ingestionIdleAt.get(agent.id);
  if (idleSince && Date.now() - idleSince < StatusMonitor.INGESTION_IDLE_HOLD_MS) {
    return 'idle';
  }

  const lastOutput = this.getLastOutput(agent.id);
  const elapsed = Date.now() - lastOutput;

  if (elapsed < WORKING_THRESHOLD_MS) return 'working';
  return 'idle';
}
```

### Edit 2 — `src/main/supervisor/index.ts`

Add a sibling subscriber next to the existing `chat-events` re-emit at line 270-272. Place the new listener immediately below it.

**Replace lines 270-272:**

```ts
this.sessionLogReader.on('chat-events', (batch) => {
  this.emit('chatEvents', batch);
});
```

**With:**

```ts
this.sessionLogReader.on('chat-events', (batch) => {
  this.emit('chatEvents', batch);
  this.applyTurnCompleteStatus(batch);
});
```

**Add a new private method on `AgentSupervisor`. Logical location: just below `getChatService()` at line 323, next to the other "status / observability" surface methods. The method handles the ingestion → status hook end-to-end.**

```ts
/**
 * Drive agent.status from chat-ingestion `turnComplete` markers.
 *
 * Background: process-watching (StatusMonitor) reports `working` for as long
 * as the underlying CLI writes to its PTY. Codex keeps writing internal
 * cleanup output for several minutes after the turn-complete marker hits the
 * rollout file, so status can lag the chat stream by 3-5 minutes. That gap
 * killed an orchestration run on 2026-05-13 (see docs/STATUS_FROM_TURNCOMPLETE.md).
 *
 * This listener treats the per-message `turnComplete` flag as the
 * authoritative working↔idle signal. It writes the agent's status, hands a
 * hold to StatusMonitor so the next poll cannot downgrade idle back to
 * working from PTY recency alone, and emits `statusChanged` on the same
 * channel as every other writer so IPC + WebSocket + supervisor event
 * bridge all pick the change up unchanged.
 *
 * Mid-stream events (assistant-text without turnComplete, thinking, or a
 * fresh user-text) signal that a new turn has started; we mark working and
 * clear the hold so subsequent inference can resume.
 */
private applyTurnCompleteStatus(batch: ChatEventBatch): void {
  // Skip replays of cached events on initial subscription; we only want
  // live transitions, not retroactive flips at app boot.
  if (batch.initialLoad) return;

  const agentId = batch.agentId;
  const agent = getAgent(agentId);
  if (!agent) return;

  // Never override terminal or transitional states. The runner-exit /
  // launch / restart paths own those.
  if (['done', 'crashed', 'restarting', 'launching'].includes(agent.status)) {
    return;
  }

  let nextStatus: AgentStatus | null = null;

  for (const ev of batch.events) {
    if (ev.type === 'assistant-text' && ev.turnComplete === true) {
      nextStatus = 'idle';
      // keep scanning — a later event in the same batch could re-trigger working
    } else if (
      ev.type === 'user-text' ||
      ev.type === 'thinking' ||
      (ev.type === 'assistant-text' && ev.turnComplete !== true)
    ) {
      nextStatus = 'working';
    }
    // tool-use / tool-result / usage / system-init: no status implication
  }

  if (!nextStatus) return;
  if (nextStatus === agent.status) return;

  updateAgentStatus(agentId, nextStatus);
  if (nextStatus === 'idle') {
    this.monitor.noteIngestionIdle(agentId);
  } else {
    this.monitor.clearIngestionIdle(agentId);
  }
  addEvent(agentId, 'status_change', JSON.stringify({
    from: agent.status, to: nextStatus, source: 'ingestion',
  }));
  this.emit('statusChanged', { agentId, status: nextStatus });
}
```

**Imports to add at top of `src/main/supervisor/index.ts`:**

- `ChatEventBatch` from `../../shared/session-events` (the file already imports from `../../shared/types` and several local modules; add the new import next to the others).

### Edit 3 — none required to IPC / preload / renderer

The IPC path (`supervisor.on('statusChanged') → webContents.send('agent:status-changed')`) at `src/main/ipc-handlers.ts:362-367` already re-fetches the agent record and forwards it. The renderer's `App.tsx:58-64` listener already calls `store.updateAgent(agent)`, which the spinner reads. Verified by tracing the existing `working`/`idle` flow.

The WebSocket bridge at `src/main/ws-server.ts:127` listens to the same event — no change needed.

## Race-safety summary

- **Two writers to `status`:** (1) `StatusMonitor.poll`, (2) ingestion listener (new). The ingestion writer is given priority on the working↔idle axis by handing `StatusMonitor` an in-memory hold (`ingestionIdleAt`). Inside `inferStatus`, the hold is checked **after** the alive check (so `done`/`crashed` from process-exit still wins) and **before** the PTY-recency check (so `working` from output bursts cannot win).
- **`runner.on('exit')` writes `done`/`crashed`:** these run inside the supervisor, not the monitor; they bypass the hold and update DB + emit directly. Correct.
- **`launchAgent` writes `working`:** runs before any chat events could possibly arrive (chat events require an active `pollSession` cycle and persisted log content). Correct.
- **Concurrent same-tick writes from `StatusMonitor` and ingestion:** SQLite serializes; the monitor's `statusHoldUntil` debounce (status-monitor.ts:46) also prevents tight churn. The ingestion writer doesn't use `statusHoldUntil` because we *want* it to fire immediately on turnComplete (the whole point of the fix is "don't wait 1.5s").

## Smoke-test sequence

The 2026-05-13 incident is the natural reproduction case. The fastest local reproduction:

1. **Build**: `npm run build:main && npm run start` (need a fresh main-process build for the new code to load).
2. **Pre-fix baseline** (run *before* applying this patch, to capture current behavior — skip if you trust the incident timeline). Launch a codex agent, send it any prompt that needs ~30s of reasoning ("write me a 500-word essay on X"). When `read_agent_chat` shows the response landed and ends with the final assistant message, immediately `GET /api/agents/<id>` — observe `status: "working"`. Sleep 60s, check again — still `working`. This is the lag.
3. **Apply patch and rebuild.**
4. **Post-fix repro**:
   - Launch a codex agent.
   - `curl -X POST http://127.0.0.1:24678/api/agents/<id>/input -d '{"text":"Write me a 500-word essay on tide pools."}' -H 'Content-Type: application/json'`
   - Poll `GET /api/agents/<id>` every 2s. Expect: `status: "working"` while the agent is reasoning, then **`status: "idle"` within ~1s of the final assistant message appearing in `GET /api/agents/<id>/messages` with `turnComplete: true`**. Status should NOT lag past the message.
   - Wait 90s — confirm `status` stays `idle` and does not re-flip to `working` (would indicate the hold isn't holding).
5. **Multi-provider sanity**:
   - Repeat (4) with `provider: 'claude'` — verify `turnComplete` from `stop_reason: end_turn` still drives idle (no regression in the existing fast path).
   - Repeat (4) with `provider: 'gemini'` — verify hard-coded `turnComplete: true` from gemini-transcript-reader still drives idle.
6. **Recovery from idle → working**:
   - With the agent idle from step (4), send another `/input`. Expect: `status` flips to `working` immediately (the input-in-flight override at api-server.ts:97-105 short-circuits) and remains `working` through the reasoning phase (the mid-stream `thinking` event clears the ingestion-idle hold and re-marks working).
7. **Crash override**:
   - With the agent idle from step (4), kill the codex process out-of-band (`taskkill /F` on Windows; `kill -9` in WSL). Expect: `StatusMonitor` detects `!alive` within ~1.5s and writes `crashed`. The hold must NOT prevent this (verify by tailing the renderer log — the `agent:status-changed` event should land with `status: crashed`).
8. **UI verification**: with the dashboard open, watch the agent card spinner during step (4). Spinner should disappear within seconds of the final message instead of spinning for minutes.

## Test coverage gaps (informational — not in scope to fix here)

`src/main/supervisor/status-monitor.ts` has **no unit test** today. Search of `src/**/*.test.ts` finds only `codex-shell-parser`, `context-stats-monitor`, `file-activity-tracker`, `codex-rollout-reader`, `gemini-transcript-reader`, `session-id-discovery`, `session-log-dispatcher`. The status-mutation pathways across `AgentSupervisor` are exercised only through end-to-end manual runs.

Recommended (but optional, can ship the fix without it):

- Add `src/main/supervisor/status-monitor.test.ts`: with `checkAlive` / `getLastOutput` callbacks stubbed, assert that (a) recent `noteIngestionIdle` prevents `inferStatus` from returning `working` even when `lastOutput` is fresh, (b) the hold expires after `INGESTION_IDLE_HOLD_MS`, (c) `!alive` still returns `done`/`crashed` regardless of the hold, (d) `clearIngestionIdle` immediately re-enables `working` inference.
- Extend `session-log-dispatcher.test.ts` (or add a sibling) covering the new `applyTurnCompleteStatus` method: feed synthetic `ChatEventBatch` instances with `turnComplete: true`, `turnComplete: false`, and mixed-event batches; assert `updateAgentStatus` calls and `statusChanged` emissions. The DB write would need stubbing; consider extracting `applyTurnCompleteStatus` to a pure function for testability, or use a sqlite in-memory fixture as `context-stats-monitor.test.ts` does.

## Files touched by this change

| File | Edit |
|---|---|
| `src/main/supervisor/status-monitor.ts` | Add `INGESTION_IDLE_HOLD_MS`, `ingestionIdleAt`, `noteIngestionIdle()`, `clearIngestionIdle()`; insert hold check inside `inferStatus`. |
| `src/main/supervisor/index.ts` | Import `ChatEventBatch`; add `this.applyTurnCompleteStatus(batch)` call in the existing `chat-events` listener; add the `applyTurnCompleteStatus` private method. |

No edits to: `database.ts`, `ipc-handlers.ts`, `ws-server.ts`, `preload/index.ts`, the renderer, the per-provider readers, the shared types, or `agent-chat-service.ts`.
