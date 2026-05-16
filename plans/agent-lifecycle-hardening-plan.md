# Agent Lifecycle & Event Pipeline Hardening

**Status:** planning. Pre-implementation; companion to (and prerequisite for) `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md`.

**Scope:** one architectural defect surfacing as five symptoms. The dashboard runs two unreconciled "what is this agent doing" pipelines:

- **Pipeline A** — PTY byte-silence heuristic in `StatusMonitor` (8 s + meaningful-burst gate). Feeds `agent.status`, `[DASHBOARD EVENT]` stream, orchestration 409 gate.
- **Pipeline B** — provider-native end-of-turn markers parsed by chat readers; exposed as `turnComplete: true` but only the chat reader consumes it.

Symptoms: (a) minutes-long stale `working` on Codex; (b) GroupThink's `waitTurnComplete` polling messages directly to dodge `agent.status`; (c) the declared-but-unused `'waiting'` status; (d) crash events bypassing `handleSupervisorEvent` because runner `exit` handlers write status directly; (e) zero tests across the event bridge.

**Out of scope:** the multi-supervisor migration itself; in-process MCP lift; user-authored orchestrations; the Track-3 Claude Code hooks sidecar (deferred per the source doc).

**Companion / context docs:**

- `docs/STATUS_FROM_TURNCOMPLETE.md`
- `docs/AGENT_STATUS_AND_INPUT_DETECTION.md`
- `docs/concerns/IDLE_DETECTION_FINDINGS.md`
- `docs/concerns/INTERACTIVE_PROMPT_FINDINGS.md`
- `docs/concerns/SUPERVISOR_NOTIFICATION_FINDINGS.md`
- `docs/MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md`

---

# Part 1 — Intent

## Why now

The multi-supervisor migration (`MULTI_SUPERVISOR_AND_ORCHESTRATION_MIGRATION.md`) reworks the event queue from a singleton to `Map<supervisorId, ...>` and reroutes via `agent.supervisorId`. Those changes are correct in isolation but assume the bridge is the canonical event path. Today the bridge is bypassed for the most operationally important event class — crashes — because runner `exit` handlers commit status directly and the bridge listens only on `monitor.on('statusChanged')`, not on the supervisor's own emit. Shipping per-supervisor routing on top of a bridge that doesn't see crashes encodes the bug forever and harder to find.

Concurrently, the byte-silence status heuristic has a documented 5-minute lag on Codex (`docs/STATUS_FROM_TURNCOMPLETE.md`) that killed a real GroupThink run on 2026-05-13. The chat readers already know ground truth via `turnComplete`; only the wire from Pipeline B to `agent.status` is missing.

Both problems are small, both block downstream work, and both need test coverage that doesn't exist today. This plan hardens them together.

## Goals

- `agent.status` flips `working → idle` within one dispatcher tick of `turnComplete: true` landing in the chat stream (vs. up to 5 min today).
- Worker crash events reliably reach the workspace's supervisor — through `handleSupervisorEvent`, not around it.
- The `'waiting'` slot has a real producer: at minimum, in-text question detection (`?`-tail on `turnComplete:true`) and PTY pattern matching for `(y/N)` / `Press Enter` / numbered choice lists, surfaced as both a status and a new supervisor event.
- The supervisor's CLAUDE.md and the event vocabulary agree: every event type listed in `event-payload-builder.ts` either has a producer or is removed.
- The event bridge has a tested seam: a thin `EventBridge` module with injected collaborators, covering happy path / cooldown / queue / drain / attached-suppression / crash / multi-supervisor isolation.
- All routing-sensitive sites (the multi-supervisor seam list) are enumerated and verified before the multi-supervisor migration starts, with each routing call site marked "single-owner safe" / "needs per-owner rework."

## Non-goals

- The multi-supervisor migration itself (lives in its own doc — this plan unblocks it).
- A new chat-reader interface (`getStructuredStatus`, `recordInputQueued`) — Phase 2 Track 2 from `AGENT_STATUS_AND_INPUT_DETECTION.md`. We do the smaller "wire `turnComplete` directly" instead because it covers the documented incident.
- The Track-3 Claude Code hooks sidecar — explicitly deferred. We rely on `stop_reason`, `task_complete`, and PTY pattern heuristics.
- Removing the `withInputInFlight` wire-format override or shipping the `Sending…` overlay (Phase 1.4 of the design doc). Orthogonal.
- Tightening `WORKING_THRESHOLD_MS` from 8 s. Defer; with Pipeline B latching `idle`, the 8 s threshold is only a fallback, and a tighter value risks flicker on slow-streaming providers.
- Gemini-specific tool-call-completeness gating in the chat reader. Phase 1A keeps Gemini on PTY-only status (strictly no worse than today); the gating ticket is deferred (see D-07).

## Cross-cutting constraints (what stays the same)

- Terminal states (`'crashed'` / `'done'`) are still produced by the runner-exit path; the bridge consumes them but does not produce them. (We move *delivery*, not *production*.)
- `StatusMonitor`'s polling loop keeps running and remains authoritative for `working` resumption (when no Pipeline B latch is set), the initial `launching → working` transition, and the alive check.
- The bridge keeps its current event vocabulary (`status_change`, `context_threshold`) plus exactly one new type (`waiting_for_input`, carried as a status_change to `'waiting'` with extra fields). No other additions in this plan.
- Existing IPC contract (`statusChanged` listener) and downstream consumers (`AgentCard`, `team-delivery`, the 409 gate in `api-server.ts:178-184` and `ipc-handlers.ts:62-63`) unchanged in shape.
- `scripts/groupthink-v1.js`'s `waitTurnComplete` keeps polling messages directly even after Phase 1A lands. It's correct and harder to break than re-introducing a status-gated wait. We *do* update the stale `MIN_READY_POLLS` doc in `scripts/groupthink-v1.md`.

---

# Part 2 — Specification

## 2.1 Pipeline B → status wiring (with latch)

**Producer:** `SessionLogDispatcher` in `src/main/supervisor/session-log-dispatcher.ts` — emits batched `chat-events` consumed by `AgentSupervisor` at `index.ts:274-276`.

**New consumer:** `EventBridge.onChatEvents(batch)` (new). Maps each event to a status hint:

| Event | Action |
|---|---|
| `assistant-text` && `turnComplete === true` && !endsWithQuestion && provider !== 'gemini' | `statusMonitor.forceIdle(agentId, source='turnComplete')` |
| `assistant-text` && `endsWithQuestion === true` | `statusMonitor.forceWaiting(agentId, kind='question', excerpt=lastTextTail)` |
| `assistant-text` && `stopReason === 'tool_use'` | `statusMonitor.forceWorking(agentId, source='turnContinues')` |
| `tool-use` | `statusMonitor.forceWorking(agentId, source='tool-use')` |
| `tool-result` | `statusMonitor.forceWorking(agentId, source='tool-result')` |
| `user-text` | `statusMonitor.forceWorking(agentId, source='user-turn')` |
| `task-started` (new event variant for Codex) | `statusMonitor.forceWorking(agentId, source='task-started')` |
| `assistant-text-patch` (new event variant) | If patch sets `turnComplete: true`, treat identical to the row above for `assistant-text` + `turnComplete: true`. |

Gemini is excluded from `forceIdle` in Phase 1A: `gemini-transcript-reader.ts:327` hardcodes `turnComplete: true` on every assistant-text emission, while transcripts can later rewrite the same turn with tool calls. Until the deferred Gemini-tool-call-gating ticket lands, Gemini falls back to the existing 8 s PTY threshold (no regression — strictly no worse than today). Waiting detection (`endsWithQuestion`, PTY-pattern) still applies to Gemini since both signals are independent of `turnComplete`'s reliability.

### 2.1.1 The turn latch

`StatusMonitor` adds a per-agent latch:

```ts
private turnLatch = new Map<string, {
  state: 'idle' | 'waiting';
  setAt: number;
  waitingKind?: 'question' | 'tty-pattern';
  waitingExcerpt?: string;
}>();
```

`forceIdle(agentId, source)`:
1. Read current `agent.status` via injected `getAgent`. If terminal (`crashed`/`done`) or `launching`/`restarting`, no-op.
2. Capture `prior = agent.status`.
3. Call `updateAgentStatus(agentId, 'idle')`.
4. Set `turnLatch.set(agentId, { state: 'idle', setAt: now })`.
5. Emit `statusChanged({ agentId, status: 'idle', fromStatus: prior, source })`.
6. **Bypass `statusHoldUntil`** — Pipeline B is high-confidence and shouldn't be held by a flicker debounce.

`forceWaiting(agentId, kind, excerpt)`:
1. Same preamble as `forceIdle`.
2. `updateAgentStatus(agentId, 'waiting')`; set latch to `{ state: 'waiting', setAt: now, waitingKind: kind, waitingExcerpt: excerpt }`.
3. Emit `statusChanged({ agentId, status: 'waiting', fromStatus: prior, source: kind, waitingKind: kind, waitingExcerpt: excerpt })`. (One event, per Reviewer's Q2 — the bridge renders this as `[DASHBOARD EVENT] Agent waiting for input`.)

`forceWorking(agentId, source)`:
1. Clear `turnLatch.delete(agentId)`.
2. If `agent.status` already `'working'`, no-op.
3. Otherwise update + emit (no debounce bypass needed; `working` writes via the normal path).

`inferStatus` (modified):

```
if alive:
  const latched = this.turnLatch.get(agent.id);
  if (latched) {
    // Stale-after timeout — fall back to PTY truth eventually
    const age = now - latched.setAt;
    const ttl = latched.state === 'waiting' ? WAITING_LATCH_TIMEOUT_MS : IDLE_LATCH_TIMEOUT_MS;
    if (age > ttl) {
      this.turnLatch.delete(agent.id);
      // fall through to PTY fallback
    } else {
      return latched.state;
    }
  }
  // existing 8s-threshold fallback
```

Constants in `src/shared/constants.ts`:

```ts
export const IDLE_LATCH_TIMEOUT_MS = 30 * 60 * 1000;   // 30 min — never-resumed agent eventually falls back to PTY
export const WAITING_LATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 min  — unanswered prompt times out
```

### 2.1.2 Latch invalidation summary

The latch is cleared by:
1. Any `forceWorking` call (turn continues / tool-use / tool-result / user-turn / task-started).
2. A successful `EventBridge.sendInput(agentId, ...)` wrap — synthetic user turn.
3. The TTL above.
4. A new `forceWaiting` or `forceIdle` overwrites the latch (state transition).

It is NOT cleared by PTY bursts. PTY bursts can never promote a latched-idle agent back to `working`, which is the contract the documented Codex incident requires.

### 2.1.3 Codex split-batch retag (formalized)

The latent bug: `codex-rollout-reader.ts:273-283` walks back through the *current poll's* `out` array on `task_complete`. If `task_complete` lands in poll N+1 but the preceding `assistant-text` was emitted in poll N, the tag is lost.

**Fix shape:**

1. Add `AssistantTextPatchEvent` to `src/shared/session-events.ts`:

   ```ts
   export interface AssistantTextPatchEvent {
     type: 'assistant-text-patch';
     uuid: string;          // patch's OWN uuid (fresh, not the target's)
     timestamp: string;
     agentId: string;
     targetUuid: string;    // the assistant-text being patched
     turnComplete?: boolean;
     stopReason?: string;
     endsWithQuestion?: boolean;
   }
   ```
2. `CodexRolloutReader` retains per-session `lastAssistantTextEvent: AssistantTextEvent | null`. On every emitted `assistant-text`, update the reference.
3. On `task_complete` / `turn_aborted`: the existing walk-back tries the current poll's `out` array first. If no `assistant-text` is found in the current batch and `lastAssistantTextEvent` is non-null, emit an `assistant-text-patch` with `targetUuid: lastAssistantTextEvent.uuid` and `turnComplete: true`, `stopReason: payloadType`. Clear `lastAssistantTextEvent` after.
4. `SessionLogDispatcher.pollOne` recognizes `assistant-text-patch` *before* the dedupe check. The patch event itself is uuid-deduped normally (its own uuid is fresh). On accept:
   - Walk `eventsByAgent.get(agentId)` for `targetUuid` and mutate `turnComplete` / `stopReason` / `endsWithQuestion` in place.
   - Push the patch into `newEvents` so consumers see the batch.
5. `EventBridge.onChatEvents` maps `assistant-text-patch` with `turnComplete: true` to `forceIdle(agentId, 'turnComplete')`.
6. `AgentChatService.getMessages` (`agent-chat-service.ts:74-81`) reads the ring buffer; the in-place mutation is reflected on next read. Audit reveals no other consumer caches `assistant-text` envelopes outside the dispatcher's ring.

## 2.2 Crash routing through the bridge

Today (`index.ts:1071-1084` Windows, `:1310-1322` WSL):

```ts
runner.on('exit', (exitCode) => {
  updateAgentStatus(agent.id, status);          // status = 'done' | 'crashed'
  addEvent(agent.id, status, JSON.stringify({ exitCode }));
  this.emit('statusChanged', { agentId, status });  // bypasses StatusMonitor
});
```

The bridge listens on `this.monitor.on('statusChanged')` (`index.ts:246`) — so a direct `this.emit('statusChanged')` does NOT trigger `handleSupervisorEvent`.

**Fix:** add a sibling listener on `this` itself, with a `source` discriminator to avoid double-firing:

```ts
// AgentSupervisor (after EventBridge extraction in P0-02)
this.monitor.on('statusChanged', (data) =>
  this.bridge.onStatusChanged({ ...data, source: 'monitor' })
);
this.on('statusChanged', (data) => {
  // Bridge already fires from monitor path; only invoke for non-monitor sources
  if (data.source && data.source !== 'monitor') {
    this.bridge.onStatusChanged(data);
  }
});
```

Every direct `this.emit('statusChanged')` site stamps a `source` field and a captured `fromStatus`:

```ts
const prior = getAgent(agent.id)?.status;   // capture BEFORE updateAgentStatus
updateAgentStatus(agent.id, status);
this.emit('statusChanged', { agentId: agent.id, status, fromStatus: prior, source });
```

Sources: `'monitor' | 'runner-exit' | 'launch' | 'restart' | 'restart-failed' | 'stop'`.

Bridge behavior keyed by source:
- `'runner-exit'` (crashes / completions): bypass the per-agent 10 s cooldown. A crash is not a flicker.
- `'launch'` / `'restart'` (transient working/restarting): no notification.
- `'monitor'`: existing behavior (cooldown applies).

Race-with-delete: if `getAgent(id)` returns `null` between updateAgentStatus and emit, `prior` is `undefined`. The bridge's existing `fromStatus === undefined` short-circuit (`index.ts:346`) handles this gracefully — no extra guard.

## 2.3 Waiting-state detection

### 2.3.1 In-text question heuristic

In each reader, when emitting `assistant-text` with `turnComplete === true`, compute:

```ts
endsWithQuestion = text.trimEnd().endsWith('?')
                && text.trimEnd().length > 0
```

Add `endsWithQuestion?: boolean` to `AssistantTextEvent` in `src/shared/session-events.ts`. False positives (mid-monologue questions) are accepted; the supervisor reading the log resolves them.

### 2.3.2 PTY prompt-pattern detector

New file: `src/main/supervisor/prompt-pattern-detector.ts`. Pattern set (post-review tightening):

```ts
const PROMPT_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'y-n',     re: /\((?:y|Y)\/(?:n|N)\)\s*\??\s*$/m },
  { kind: 'y-n',     re: /\[(?:y|Y)\/(?:n|N)\]\s*\??\s*$/m },
  { kind: 'enter',   re: /Press\s+(?:Enter|RETURN|any\s+key)\b/i },
  { kind: 'choice',  re: /\bChoose\s+(?:an\s+)?option\b/i },
  { kind: 'choice',  re: /(?:^|\n)\s*\d+\)\s+\S.*\n(?:.*\n)*?\s*\d+\)\s+\S/ },  // ≥2 numbered options
  { kind: 'approve', re: /\bApprove\s*\?\s*$/m },
];
```

Removed from earlier draft: bare `❯` cursor pattern (false-positive on shell prompts), and any pattern anchored only on `\s*$`.

Match additionally gated:
- PTY has been quiet ≥ 2 s (elapsed since `lastMeaningfulBurst`).
- The matched substring is in the **last 512 bytes** of stripped tail (anchors against finding a stale prompt deeper in scrollback).

When matched, `StatusMonitor.inferStatus` returns `'waiting'` and `forceWaiting(agentId, kind: matchedKind, excerpt: matchedSubstring)` runs.

### 2.3.3 Waiting event payload

`SupervisorEvent` extended:

```ts
type: 'status_change' | 'context_threshold';
// (no new event type; waiting is a status_change to 'waiting' with extra fields)
waitingKind?: 'question' | 'y-n' | 'enter' | 'choice' | 'approve' | 'tty-pattern';
waitingExcerpt?: string;
```

`buildEventPayload` for a status_change with `toStatus === 'waiting'` renders:

```
[DASHBOARD EVENT] Agent waiting for input
Agent: "<title>" (<short-id>)
Waiting kind: <waitingKind>
Excerpt: "<excerpt>"
Last output:
> <5-line log tail>
```

`'waiting'` is added to the bridge's `triggerStatuses` at `index.ts:341`. The `'waiting'` → `'working'` transition is also a status_change but does NOT emit a `[DASHBOARD EVENT]` (filter: when `fromStatus === 'waiting'`, the bridge only fires if `toStatus` is `idle`/`crashed`/`done`).

## 2.4 Dead-code event cleanup

Per Reviewer Q4: delete `'team_created'` and `'team_loop_detected'` from the `SupervisorEvent.type` union and from `SUPERVISOR_AGENT_MD`. Restore when Teams actually emits them.

## 2.5 EventBridge extraction

New file: `src/main/supervisor/event-bridge.ts`. Contracts:

```ts
interface EventBridgeDeps {
  getAgent(id: string): Agent | null;
  getSupervisorForWorker(worker: Agent): Agent | null;  // wraps getSupervisorAgent(workspaceId) today
  sendInput(supervisorId: string, text: string): Promise<void>;
  addAuditEvent(
    agentId: string,
    type: 'supervisor_event' | 'supervisor_event_batch',
    payload: string,
  ): void;
  getAgentLog(agentId: string, lines: number): Promise<string>;
  getContextStats(agentId: string): ContextStats | null;
  now(): number;
  scheduleDrain(ms: number, fn: () => void): { cancel(): void };
}

class EventBridge {
  constructor(deps: EventBridgeDeps);

  onStatusChanged(data: StatusChangedEvent): Promise<void>;
  onContextStatsChanged(stats: ContextStats): void;

  // Lifecycle hook: AgentSupervisor.deleteAgent must call this so the bridge
  // can clear its per-agent cooldown / threshold / queue state. Without it,
  // those maps reach across the boundary into the bridge's private fields.
  forgetAgent(agentId: string): void;

  // Test seam
  drainPendingFor(supervisorId: string): Promise<void>;
  getQueueSnapshot(): SupervisorEvent[];
}
```

The implementation moves `handleSupervisorEvent`, `checkContextThreshold`, `deliverToSupervisor`, `drainEventQueue`, the per-agent cooldown map, and the queue/drain timers out of `AgentSupervisor` into the bridge. `AgentSupervisor` becomes a thin wirer.

`getSupervisorForWorker` takes the worker `Agent` so the multi-supervisor migration's swap to `worker.supervisorId` is a one-line edit in `AgentSupervisor`'s wiring, not a bridge change.

**Deferred surface — added in M2A (P1A-02), NOT in P0-02:**

- `statusMonitor: { forceIdle, forceWorking, forceWaiting }` collaborator — the methods don't exist on `StatusMonitor` today and none of the moved code paths use them. Adding them now creates fake API surface for behavior that doesn't yet exist; the M0 contract stays narrow.
- `onChatEvents(batch: ChatEventBatch): void` on `EventBridge` — wires Pipeline B → status, which is M2A scope. P0-02 ships a bridge that only reacts to `statusChanged` and `statsChanged`. P1A-02 extends it.

This split keeps P0-02 a true pure refactor (no behavior change) and isolates the M2A wiring to one cohesive change.

## 2.6 Multi-supervisor seam list (Phase 3 deliverable)

| File:line | Call | Today's behavior | Post-multi-supervisor disposition |
|---|---|---|---|
| `database.ts:361-364` | `getSupervisorAgent(workspaceId)` definition | newest supervisor | keep as legacy; add `getSupervisorAgents` (plural) |
| `supervisor/index.ts:329-331` | `AgentSupervisor.getSupervisorAgent` re-export | wraps above | wrap both |
| `supervisor/index.ts:348` | bridge: status_change owner lookup | `getSupervisorAgent(workspaceId)` | swap to `worker.supervisorId` lookup |
| `supervisor/index.ts:396` | bridge: context_threshold owner lookup | same | same |
| `supervisor/index.ts:529` (verify) | launchAgent duplicate-supervisor guard | rejects 2nd supervisor | delete (per migration P1-02) |
| `supervisor/index.ts:216-218` | singleton `supervisorQueuedEvents`, drain timer, `lastContextThreshold` | one global queue | `Map<supervisorId, ...>` |
| `supervisor/index.ts:1515-1520` | `queryAgent` `--continue` fallback | picks newest supervisor's session | gate on `agent.isSupervisor === false` or drop |
| `ipc-handlers.ts:83` | `agent:get-supervisor` IPC | singular | add `agent:get-supervisors` (per migration P1-05) |
| `team-delivery.ts:120-129` | `pollPendingDeliveries` reads `getAllAgentStatuses` | scans all agents | inherits owner-aware routing |
| `event-payload-builder.ts:108` | `buildConsolidatedPayload` | single array | invariant comment + dev-assertion: single-owner |
| `scripts/list-ids.js:1,8` | dev script | newest supervisor | update or document |

The integration test from P3-02 exercises this list as a smoke matrix.

## 2.7 Test surface (Phase 0 + Phase 3)

Convention (per Reviewer F8): existing pattern is `tsc -p tsconfig.main.json` + `node dist/.../foo.test.js` using `node:assert/strict`. P0-00 codifies this with an npm script. No new test framework.

Test matrix:

| ID | Scenario | Asserts |
|---|---|---|
| BR-01 | Worker idle event happy path | `sendInput` called with `[DASHBOARD EVENT] Agent status changed` |
| BR-02 | Worker crash via runner-exit | bridge receives event with `source: 'runner-exit'`; `sendInput` called with `Exit code:` line. (HEAD baseline — cooldown still applies; the bypass is tested at BR-02b under P1B-01.) |
| BR-03 | Two events while supervisor working | drain produces consolidated batch on transition to idle |
| BR-04 | Supervisor idle but attached | event queued; drained when supervisor flips to idle via existing timer/listener path. (HEAD baseline — `drainEventQueue` does not re-check `isAttached`; the detach-driven drain is a deferred ticket, see note below.) |
| BR-05 | Per-agent cooldown drops dup inside 10 s | second monitor-source event not delivered |
| BR-06 | Cooldown clears after 10 s | second event delivered |
| BR-07 | Context threshold ordering: 80 → 80 (no) → 90 (yes) | `lastContextThreshold` map respected |
| BR-08 | Consolidated batch mixes status + context | both kinds present in payload |
| BR-09 | `sendInput` rejects mid-bridge | failure logged; behavior documented |
| BR-10 | Multi-supervisor isolation (two workspaces) | each supervisor sees only its workspace's events (pre-migration baseline) |
| BR-11 | `turnComplete` → idle bypasses debounce | `forceIdle` fires even if `statusHoldUntil` in future |
| BR-12 | Codex split-batch `task_complete` | reader emits `assistant-text-patch`; ring's prior event is mutated; bridge fires `forceIdle` |
| BR-13 | Waiting from `?`-tail | event built with `waitingKind='question'`; status='waiting'; supervisor notified |
| BR-14 | Waiting from PTY `(y/N)` pattern | event built with `waitingKind='y-n'`; status='waiting' |
| BR-15 | Waiting cleared on user input | latch cleared; status flips from `waiting` → `working` |
| BR-16 | Idle latch holds against PTY burst | PTY meaningful-burst arrives 5 s after `forceIdle`; status remains `idle` |
| BR-17 | Idle latch TTL expires | After `IDLE_LATCH_TIMEOUT_MS`, latch cleared; PTY truth resumes |
| BR-18 | Waiting latch TTL expires | After `WAITING_LATCH_TIMEOUT_MS`, latch cleared; agent falls to PTY-inferred status |
| BR-19 | Gemini turnComplete is ignored for forceIdle | Gemini agent emits `turnComplete: true`; latch is NOT set; PTY 8 s threshold still in effect |
| BR-20 | Gemini waiting detection still works | Gemini agent emits `endsWithQuestion`; `forceWaiting` fires |

**Note on BR-02 / BR-04 (per Reviewer 2 critique, 2026-05-16):** earlier drafts asserted behavior P0-02 doesn't actually have — runner-exit cooldown bypass and detach-driven drain. Both have been rebaselined above to test HEAD behavior at P0-03, keeping P0-02 a true pure refactor. The behavior changes live elsewhere:

- **BR-02b (cooldown bypass for `runner-exit`)** — implemented by P1B-01; test added there. The `source: 'runner-exit'` discriminator is what enables the bypass; P0-02 only ensures the discriminator reaches the bridge.
- **BR-04b (drain on detach)** — requires a new contract method on `EventBridge` (e.g. `onSupervisorDetached(supervisorId)`) plus a wiring call from `detachAgent` (`index.ts:1833`). Tracked as a deferred ticket; see Part 6 item 8.

---

# Part 3 — Decision register

### D-01 `'waiting'` semantics: status + event, or event only?
**Status:** decided
**Owner:** doc author
**Decision:** Status + event, single payload (per Reviewer Q2). The slot is wired in UI (`StatusBadge.tsx:8`, `AgentCard.tsx:34` — orange pulse) and gates accept it. Repurpose it. The status_change to `'waiting'` carries `waitingKind`/`waitingExcerpt` fields; the payload builder renders it as `[DASHBOARD EVENT] Agent waiting for input`.

### D-02 PTY pattern detector — shared module or per-provider?
**Status:** decided
**Owner:** doc author
**Decision:** Single shared module. The prompt vocabulary that survives launch flags is shared across providers. Per-provider hooks (Track 3) are deferred.

### D-03 Dead team_* events — delete or wire?
**Status:** decided
**Owner:** doc author + reviewer Q4
**Decision:** Delete. Re-add when Teams wants them.

### D-04 Bypass `statusHoldUntil` for Pipeline B?
**Status:** decided
**Owner:** doc author + reviewer Q3
**Decision:** Yes, bypass. The hold exists to dampen byte-flicker; Pipeline B is high-confidence. Safety: the latch (D-09) prevents PTY bursts from immediately undoing the bypass.

### D-05 Codex split-batch fix in the reader or in the bridge?
**Status:** decided
**Owner:** doc author + reviewer F3
**Decision:** In the reader, formalized as `AssistantTextPatchEvent` in the `SessionEvent` union. Dispatcher applies the patch to the ring buffer and propagates the patch to subscribers.

### D-06 Cooldown applies to `runner-exit` events?
**Status:** decided
**Owner:** doc author + reviewer Q1
**Decision:** No. `source === 'runner-exit'` bypasses the per-agent 10 s cooldown. A crash isn't a flicker.

### D-07 Gemini turnComplete-driven status?
**Status:** decided (Phase 1A no, follow-up ticket deferred)
**Owner:** doc author + reviewer F7 + reviewer Q4
**Decision:** Phase 1A excludes Gemini from `forceIdle`. Gemini's `turnComplete: true` is hardcoded (`gemini-transcript-reader.ts:327`) and the transcript can later rewrite the same turn with tool calls. Gemini stays on the existing 8 s PTY threshold for `idle` (strictly no worse than today). Waiting detection (`endsWithQuestion`, PTY-pattern) still applies. **Follow-up ticket (deferred):** in `gemini-transcript-reader.ts`, suppress `turnComplete: true` while tool-call envelopes are pending in the same turn; once that ticket lands, Gemini is wired into `forceIdle` like the others.

### D-08 PTY pattern detector tick interval
**Status:** decided
**Owner:** doc author
**Decision:** Run on every `StatusMonitor` tick. Measured cost ~50 µs/agent/tick × 20 agents = 1 ms / 1.5 s ≈ 0.07 % CPU. No gating needed.

### D-09 Latch contract for Pipeline B
**Status:** decided
**Owner:** doc author + reviewer F1, F6, Q3 + final user decision (Q1)
**Decision:**
- Pipeline B writes a per-agent `turnLatch` of `'idle'` or `'waiting'`.
- While latched, `StatusMonitor.inferStatus` returns the latched state regardless of PTY activity. PTY bursts cannot promote a latched-idle agent back to `'working'`.
- Latch cleared by: any `forceWorking` call, a successful `EventBridge.sendInput` wrap (synthetic user turn), the TTL, or a state-change `force*` overwrite.
- TTLs (constants in `src/shared/constants.ts`):
  - `IDLE_LATCH_TIMEOUT_MS = 30 * 60 * 1000` (30 min — never-resumed agent eventually falls back to PTY truth so the field doesn't drift permanently).
  - `WAITING_LATCH_TIMEOUT_MS = 5 * 60 * 1000` (5 min — unanswered prompt times out).

### D-10 Codex `task_started` — emit as a typed event?
**Status:** decided
**Owner:** doc author + final user decision (Q2)
**Decision:** Yes. Add `TaskStartedEvent` to `src/shared/session-events.ts`; `CodexRolloutReader` emits it on `event_msg/task_started`. The latch (D-09) needs an explicit "new turn" signal anyway, and `task_started` is cheaper and clearer than waiting for the first `tool-use` / `assistant-text` after `task_complete`. `EventBridge.onChatEvents` maps it to `forceWorking(agentId, 'task-started')`.

### D-11 `fromStatus` capture failure mode
**Status:** decided
**Owner:** doc author + final user decision (Q3)
**Decision:** Accept `fromStatus === undefined` on race-with-delete. The bridge's existing short-circuit (`index.ts:346`) handles it gracefully. No extra guard.

---

# Part 4 — Implementation tickets

Each ticket is self-contained:

```
### P<phase>-<number> <short title>
**Phase:**
**Prerequisites:** D-XX, P-YY (none if independent)
**Files:** specific paths and line refs (verify against HEAD on kickoff)
**Out of scope:** what this ticket explicitly does NOT do
**Steps:** ordered list of changes
**Acceptance:** objective, testable conditions
**Notes:** anything weird the agent should know
```

Verify line refs against HEAD before starting any ticket. The supervisor source is large and shifts often.

## Phase 0 — Test convention, payload contract, bridge extraction

### P0-00 Document and wire the test convention
**Status:** Complete — landed 2026-05-16 (agent 85fc03a4). `npm run test:supervisor` runs all 7 existing supervisor tests green (86 assertions, 0 failures). `docs/TESTING.md` published.
**Phase:** 0
**Prerequisites:** none
**Files:** `package.json` (scripts section); new `docs/TESTING.md`.
**Steps:**
1. Add an npm script:
   ```json
   "test:supervisor": "npm run build:main && node dist/main/main/supervisor/codex-shell-parser.test.js && node dist/main/main/supervisor/context-stats-monitor.test.js && node dist/main/main/supervisor/file-activity-tracker.test.js && node dist/main/main/supervisor/session-id-discovery.test.js && node dist/main/main/supervisor/session-log-dispatcher.test.js && node dist/main/main/supervisor/log-readers/codex-rollout-reader.test.js && node dist/main/main/supervisor/log-readers/gemini-transcript-reader.test.js"
   ```
   Enumerates every existing `.test.ts`. Subsequent tickets append their own file to this list.
2. Write `docs/TESTING.md` documenting the convention: `.test.ts` files compile via `tsc -p tsconfig.main.json` and run as Node scripts using `node:assert/strict`. No new test framework.
**Acceptance:** `npm run test:supervisor` runs all currently-existing tests green.
**Notes:** verify the dist path layout — `tsconfig.main.json` outputs to `dist/main/`, but tests live one level deeper (`dist/main/main/supervisor/...`) per the existing `node dist/main/main/supervisor/session-log-dispatcher.test.js` instruction in `session-log-dispatcher.test.ts:5`.

### P0-01 Add `source` and pre-write `fromStatus` to all `statusChanged` payloads
**Status:** Complete — landed 2026-05-16 (agent a80463ac). Type defined in new `src/main/supervisor/status-events.ts` (`StatusChangeSource` union + `StatusChangedEvent` interface). 11 direct emit sites stamped in `index.ts` + 1 in `status-monitor.ts`; 12th match at `index.ts:248` is a pass-through forwarder. `npm run build:main` clean; `npm run test:supervisor` green.
**Phase:** 0
**Prerequisites:** none
**Files:**
- `src/main/supervisor/status-monitor.ts:48`
- `src/main/supervisor/index.ts:1077` (Windows runner exit)
- `src/main/supervisor/index.ts:1113` (Windows launch)
- `src/main/supervisor/index.ts:1316` (WSL runner exit)
- `src/main/supervisor/index.ts:1333` (WSL launch)
- `src/main/supervisor/index.ts:1348` (restarting)
- `src/main/supervisor/index.ts:1365` (restart-failed)
- `src/main/supervisor/index.ts:1599` (stopAgent)
- `src/main/supervisor/index.ts:1631` (verify — restart path)
- `src/main/supervisor/index.ts:1645` (verify — restart-failed)
- `src/main/supervisor/index.ts:1937` (verify — reconnect-failed)
**Steps:**
1. Extend the payload type with `source: 'monitor' | 'runner-exit' | 'launch' | 'restart' | 'restart-failed' | 'stop'`. Define in `src/shared/types.ts` or a new `src/main/supervisor/status-events.ts`.
2. At every direct emit site, capture `const prior = getAgent(agent.id)?.status` BEFORE `updateAgentStatus`, then emit with `{ agentId, status, fromStatus: prior, source: '<appropriate>' }`.
3. `StatusMonitor.poll` (`status-monitor.ts:48`) stamps `source: 'monitor'` and reuses the existing `agent.status` it already has in scope.
**Out of scope:** any consumer change — `handleSupervisorEvent` already accepts `fromStatus`; new `source` field is additive.
**Acceptance:** TypeScript compile passes; grep `emit\('statusChanged'` shows every call site stamps a source AND a captured `fromStatus`.

### P0-02 Extract `EventBridge`
**Status:** Complete — landed 2026-05-16 (agent 13d8bc29). New `src/main/supervisor/event-bridge.ts` (~225 lines) with the §2.5 interface; 4 methods moved out of `index.ts` (grep confirms zero remaining references to `handleSupervisorEvent` / `checkContextThreshold` / `deliverToSupervisor` / `drainEventQueue`); per-agent maps + drain timer moved into bridge; `deleteAgent` routed through `bridge.forgetAgent`. Dual-listener wiring preserves the public `statusChanged` forwarder for IPC/WS/team-delivery. No deps additions beyond §2.5. `npm run build` clean; `npm run test:supervisor` green.
**Phase:** 0
**Prerequisites:** P0-01
**Files:** new `src/main/supervisor/event-bridge.ts`; `src/main/supervisor/index.ts:214-218,246-255,335-485,1625` (`deleteAgent` cleanup).
**Steps:**
1. Create `EventBridge` per §2.5 contract. Move `eventCooldowns`, `supervisorQueuedEvents`, `eventDrainTimer`, `lastContextThreshold` into private fields on the bridge.
2. Move `handleSupervisorEvent`, `checkContextThreshold`, `deliverToSupervisor`, `drainEventQueue` into the bridge (renamed: `onStatusChanged`, `onContextStatsChanged`, `deliver`, `drain`).
3. Implement `forgetAgent(agentId)` on the bridge — clears that agent's entries from `eventCooldowns`, `supervisorQueuedEvents` (filter), `lastContextThreshold`, and cancels its `eventDrainTimer` handle if any. Replace the direct map mutations in `AgentSupervisor.deleteAgent` (`index.ts:~1625`) with a single `this.bridge.forgetAgent(agentId)` call.
4. `AgentSupervisor` constructs `EventBridge` with the deps in §2.5. The `getSupervisorForWorker(worker)` collaborator wraps `getSupervisorAgent(worker.workspaceId)` today; the multi-supervisor migration changes only this one wiring line.
5. Wire two listeners with the source dedup. **Both listeners must remain in place** — the `this.on('statusChanged', …)` callback feeds the bridge for non-monitor sources, but the *outer* `this.emit('statusChanged', data)` from the monitor-forward (`index.ts:248`) must NOT be removed: IPC handlers (`ipc-handlers.ts:362`), the WS server (`ws-server.ts:127`), and `team-delivery.ts:27` all listen on the public `statusChanged` event. The bridge subscribes via `this.monitor.on(...)` directly, so removing the forwarder would break those other consumers.
   ```ts
   this.monitor.on('statusChanged', (data) => this.bridge.onStatusChanged({ ...data, source: 'monitor' }));
   this.on('statusChanged', (data) => {
     if (data.source && data.source !== 'monitor') this.bridge.onStatusChanged(data);
   });
   ```
6. Wire `this.contextStatsMonitor.on('statsChanged', s => this.bridge.onContextStatsChanged(s))`.
**Out of scope:**
- changing routing semantics; the multi-supervisor swap of `getSupervisorForWorker` happens in migration P1-04.
- the `statusMonitor.force*` collaborator and `onChatEvents` bridge method — both deferred to P1A-02 (see §2.5 "Deferred surface" note).
- runner-exit cooldown bypass (lands at P1B-01) and detach-driven drain (deferred ticket per §2.7 note).
**Acceptance:** No behavior change vs. HEAD on manual exercise (existing supervisor receives `[DASHBOARD EVENT]` on worker idle, on worker crash, on context threshold). `npm run build` passes. `npm run test:supervisor` passes. `Grep` shows the four moved methods no longer exist on `AgentSupervisor`, and `deleteAgent` no longer touches the bridge's private maps directly.

### P0-03 Bridge baseline tests
**Status:** Complete — landed 2026-05-16 (agent 13d8bc29, same task as P0-02). New `src/main/supervisor/event-bridge.test.ts` (~260 lines) implements BR-01..BR-10; new `src/main/supervisor/test-helpers/fake-bridge-deps.ts` (~155 lines) provides `FakeScheduler`, `makeFakeBridgeDeps`, `makeAgent`, `flushMicrotasks`. Appended to `test:supervisor` script in `package.json`. All 10 BR tests pass. Interpretation notes: BR-04 held to HEAD baseline (drain doesn't re-check `isAttached` — detach-driven drain deferred per Part 6 item 8); BR-09 asserts zero audit records on `sendInput` rejection since HEAD calls `addEvent` only after `sendInput` resolves (comment in test flags this so any future change trips the assertion).
**Phase:** 0
**Prerequisites:** P0-02
**Files:** new `src/main/supervisor/event-bridge.test.ts`; new `src/main/supervisor/test-helpers/fake-bridge-deps.ts`.
**Steps:**
1. Build `FakeBridgeDeps` factory: in-memory agent map, `sendInput` recording array, controllable `now`, drainable scheduler that returns `{ cancel }` and lets the test fast-forward.
2. Implement BR-01 through BR-10 from §2.7 using `node:assert/strict`.
3. Append the new test to the `test:supervisor` script in `package.json`.
**Acceptance:** `npm run test:supervisor` runs the 10 bridge tests green.

## Phase 1A — Pipeline B → status (with latch)

### P1A-01 `StatusMonitor` latch + force methods
**Status:** Complete — landed 2026-05-16 (agent f2a22815, M2A bundle). `StatusMonitor` gained `turnLatch: Map<>`, `forceIdle/forceWaiting/forceWorking`, `getLatchSnapshot` test seam, `WaitingKind` export, and modified `inferStatus` consulting the latch before the 8s threshold. Two new constructor collaborators: `getAgent(id)` (required, per plan) and `now: () => number` (optional, defaults to `Date.now` — added as test seam, no behavior change). Constants `IDLE_LATCH_TIMEOUT_MS = 30 * 60 * 1000` and `WAITING_LATCH_TIMEOUT_MS = 5 * 60 * 1000` added to `src/shared/constants.ts`. New `status-monitor.test.ts` (11 tests) covers BR-11, BR-16, BR-17, BR-18. New `test-helpers/fake-status-deps.ts`. Force methods are no-op when status already at target (no redundant emission) — judgment call documented in agent report.
**Phase:** 1A
**Prerequisites:** P0-01
**Files:** `src/main/supervisor/status-monitor.ts:6-73`; `src/shared/constants.ts`; `src/main/supervisor/index.ts:241-244` (constructor wiring).
**Steps:**
1. Add constants `IDLE_LATCH_TIMEOUT_MS = 30 * 60 * 1000` and `WAITING_LATCH_TIMEOUT_MS = 5 * 60 * 1000` to `src/shared/constants.ts`.
2. `StatusMonitor` accepts a third constructor collaborator `getAgent(id): Agent | null`. `AgentSupervisor` passes `getAgent` from the database module.
3. Add private `turnLatch: Map<string, { state: 'idle' | 'waiting'; setAt: number; waitingKind?: string; waitingExcerpt?: string }>`.
4. Add public methods:
   - `forceIdle(agentId, source: string)`: short-circuit on terminal/transitional status; capture `prior`; `updateAgentStatus(agentId, 'idle')`; set latch; emit `statusChanged({ ..., fromStatus: prior, source })`. Bypass `statusHoldUntil`.
   - `forceWaiting(agentId, kind, excerpt)`: same shape; status = `'waiting'`; latch records kind/excerpt; emit carries `waitingKind`/`waitingExcerpt`.
   - `forceWorking(agentId, source)`: clear latch; if status already `'working'`, no-op; otherwise update + emit (no debounce bypass).
5. Modify `inferStatus`: after the alive check, consult `turnLatch`. If present and `now - setAt < TTL`, return latched state. Else delete latch entry and fall through to existing 8 s threshold.
**Acceptance:** unit tests in `status-monitor.test.ts` (new file): forcing idle bypasses a 5 s hold; forcing on a `crashed` agent is a no-op; PTY burst after `forceIdle` does not promote to `working` until latch TTL or explicit `forceWorking`. BR-11, BR-16, BR-17, BR-18 pass.

### P1A-02 `EventBridge.onChatEvents` — wire to chat dispatcher
**Status:** Complete — landed 2026-05-16 (agent f2a22815, M2A bundle). `EventBridge.onChatEvents(batch)` dispatches per §2.1 table; Gemini opt-out is narrow (only the `assistant-text + turnComplete: true → forceIdle` branch — waiting detection still applies when M3 lands). `assistant-text-patch + turnComplete: true` maps identically to the unwrapped row. `endsWithQuestion === true` branch is pre-wired (checked before `turnComplete: true`) but unreachable until P2-01. New `EventBridgeDeps.statusMonitor: StatusMonitorForceCollaborator` field exposes only `forceIdle/forceWaiting/forceWorking` (matches §2.5's "Deferred surface — added in M2A" note exactly). Wiring at `index.ts:305` invokes `bridge.onChatEvents(batch)` after the existing `this.emit('chatEvents', batch)`. BR-19 + 3 supporting dispatch cases in `event-bridge.test.ts`.
**Phase:** 1A
**Prerequisites:** P1A-01, P0-02, P1A-04 (for `assistant-text-patch` handling)
**Files:** `src/main/supervisor/event-bridge.ts`; `src/main/supervisor/index.ts:274-276`.
**Steps:**
1. Add `onChatEvents(batch: ChatEventBatch)` to the bridge.
2. For each event in the batch, dispatch per the table in §2.1 (verify provider via `getAgent(event.agentId)?.provider`). Gemini agents skip `forceIdle` for `turnComplete: true` (D-07).
3. Wire `this.sessionLogReader.on('chat-events', batch => this.bridge.onChatEvents(batch))` after the existing `this.emit('chatEvents', batch)` line at `:275`.
**Out of scope:** the `endsWithQuestion` annotation lives in P2-01; until P2-01 lands, the `endsWithQuestion === true` branch is unreachable (field always undefined → falls into the `forceIdle` branch). That's correct — Phase 1A's behavior is "turnComplete → idle" without waiting; Phase 2 layers waiting on top.
**Acceptance:** BR-19 passes (Gemini opt-out). Manual: launch a Codex agent, send a prompt, watch the dashboard card flip to `idle` within ~1 s of the dispatcher tick after `turnComplete: true` (vs. minutes today).

### P1A-03 `inferStatus` defers to latch
**Status:** Complete — landed 2026-05-16 (agent f2a22815, M2A bundle). Side-effect of P1A-01 step 5. BR-16 (PTY burst cannot promote latched-idle to working — the Codex incident in test form) and BR-17 (latch TTL expires, PTY truth resumes) both pass in `status-monitor.test.ts`.
**Phase:** 1A
**Prerequisites:** P1A-01
**Files:** `src/main/supervisor/status-monitor.ts:56-72`.
**Steps:**
This is a side effect of P1A-01 step 5; ticket exists to call out the test obligation explicitly: BR-16 / BR-17 must pass before this is signed off. (BR-16 is the documented Codex incident in test form.)
**Acceptance:** BR-16: PTY meaningful-burst arrives 5 s after `forceIdle`; status remains `idle`. BR-17: latch TTL expires; PTY truth resumes.

### P1A-04 Codex `assistant-text-patch` + `task-started` events
**Status:** Complete — landed 2026-05-16 (agent f2a22815, M2A bundle). `AssistantTextPatchEvent`, `TaskStartedEvent`, and `endsWithQuestion?` field added to `src/shared/session-events.ts`. `CodexRolloutReader` retains per-agent `lastAssistantTextEvent` ref; emits `TaskStartedEvent` on `event_msg/task_started`; on `task_complete`/`turn_aborted` falls back to `AssistantTextPatchEvent` (targetUuid = stored ref's uuid) when in-batch walk-back finds nothing, then clears the ref. `SessionLogDispatcher.applyAssistantTextPatch` mutates the ring in place; audit comment at `:230-238` documents the safety conclusion. **In-place mutation re-audit:** holders of `assistant-text` envelopes are the dispatcher ring (mutated), `AgentChatService.getMessages` (reads fresh, no cache), `ChatPane.tsx` (touches text/uuid only), and the new `lastAssistantTextEvent` ref (cleared before mutation applies). All safe. BR-12 covered in two halves: reader test (split-batch fixture asserts patch emission) + dispatcher test (asserts in-place ring mutation). Plus task_started fixture and in-batch walk-back regression fixture.
**Phase:** 1A
**Prerequisites:** P0-03
**Files:**
- `src/shared/session-events.ts:9-79` (add two new event variants)
- `src/main/supervisor/log-readers/codex-rollout-reader.ts:208-285`
- `src/main/supervisor/session-log-dispatcher.ts:208-246`
- `src/main/supervisor/log-readers/codex-rollout-reader.test.ts` (new fixtures)
**Steps:**
1. Add to `session-events.ts`:
   - `AssistantTextPatchEvent` (full shape per §2.1.3 step 1).
   - `TaskStartedEvent` (`type: 'task-started'`, `uuid`, `timestamp`, `agentId`).
   - Extend the union.
2. `CodexRolloutReader`:
   - Add per-session `lastAssistantTextEvent: AssistantTextEvent | null`. Update on each emitted `assistant-text`.
   - On `event_msg/task_started`: emit `TaskStartedEvent`.
   - On `event_msg/task_complete` or `turn_aborted`: try the existing in-batch walk-back first. If no `assistant-text` is found in current `out` and `lastAssistantTextEvent` is non-null, emit an `AssistantTextPatchEvent` with `targetUuid: lastAssistantTextEvent.uuid`, `turnComplete: true`, `stopReason: payloadType`. Clear `lastAssistantTextEvent`.
3. `SessionLogDispatcher.pollOne`:
   - Recognize `assistant-text-patch` after the dedupe (the patch's own uuid is fresh, so dedupe accepts it).
   - On accept: walk `eventsByAgent.get(agentId)` for `targetUuid` and mutate `turnComplete` / `stopReason` / `endsWithQuestion` in place.
   - Push the patch into `newEvents` so subscribers see it.
4. New fixtures in `codex-rollout-reader.test.ts`: a synthetic rollout where `task_complete` lands in poll N+1 after the `assistant-text` was emitted in poll N. Assert the ring's first event ends up `turnComplete: true`. Also: a fixture where `task_started` precedes the `assistant-text`; assert `TaskStartedEvent` is emitted.
5. Append the test to `test:supervisor`.
**Acceptance:** BR-12 passes; new codex-rollout-reader fixtures pass; existing codex-rollout-reader tests still pass.
**Notes:** Audit `AgentChatService.getMessages` (`agent-chat-service.ts:74-81`) confirms it reads from the dispatcher's ring buffer; the in-place mutation propagates. No other consumer caches `assistant-text` envelopes outside the ring.

## Phase 1B — Crash routing, dead-code cleanup, ignore window

### P1B-01 Bridge consumes runner-exit events
**Status:** Complete — landed 2026-05-16 (agent a485f0b4, M2B bundle). `EventBridge.onStatusChanged` cooldown check now negated as `if (data.source !== 'runner-exit' && nowOnCooldown) return;` (functionally identical to the plan's positive form; D-06 cited inline). BR-02b in `event-bridge.test.ts` verifies two runner-exit events 5 s apart both deliver. `lastExitCode` already populated by the existing runner-exit path; no payload changes required.
**Phase:** 1B
**Prerequisites:** P0-02 (bridge listeners wired), P0-01 (source field)
**Files:** `src/main/supervisor/index.ts:246-255` (the dual-listener wiring); `src/main/supervisor/event-bridge.ts` (cooldown bypass).
**Steps:**
1. Verify P0-02's dual-listener wiring fires `bridge.onStatusChanged` for `source === 'runner-exit'`.
2. In `EventBridge.onStatusChanged`, when `source === 'runner-exit'`, skip the per-agent 10 s cooldown check.
3. Crash-event payload includes `lastExitCode` (already populated on the `Agent` row by `updateAgentExitCode` at `index.ts:1072`/`:1311`).
**Acceptance:** BR-02 passes. Manual: kill a worker; supervisor terminal receives `[DASHBOARD EVENT] Agent status changed ... Status: working → crashed Exit code: -1` within ~1 s.

### P1B-02 Delete dead `team_*` event types
**Status:** Complete — landed 2026-05-16 (agent a485f0b4, M2B bundle). `team_created` + `team_loop_detected` removed from the `SupervisorEvent` union and both `buildEventPayload` branches in `event-payload-builder.ts` (-34/+5); deleted team-only fields (`teamId`, `teamName`, `teamMembers`, `teamTemplate`, `loopAgentA/B`, `loopAlternations`). "Restore here" comment added per plan step 4. Plan line-number was stale (said "near line 126"; actual was at :183 inside a "Loop Detection" subsection) — agent removed the whole subsection from `SUPERVISOR_AGENT_MD` (-9/+1) since no producer exists, and softened Teams workflow item 4 to "Act on blocked agents or escalation requests". `(event as { type: string }).type` cast required in payload-builder fallback after exhaustive union narrowing.
**Phase:** 1B
**Prerequisites:** none
**Files:**
- `src/main/supervisor/event-payload-builder.ts:3-25, 77-100` (union + branches)
- `src/shared/constants.ts` (`SUPERVISOR_AGENT_MD` — find the `team_loop_detected` mention near line 126)
**Steps:**
1. Remove `'team_created'` and `'team_loop_detected'` from the `SupervisorEvent.type` union.
2. Remove the matching branches from `buildEventPayload`.
3. Remove the matching mention from the supervisor CLAUDE.md template constant.
4. Add a comment above the union: `// Team events are not currently emitted. If Teams reintroduces them, restore the type tag and payload branch here.`
**Acceptance:** `Grep -rn "team_created|team_loop_detected" src/` returns zero hits. Supervisor CLAUDE.md no longer claims to receive a `[TEAM EVENT]` line.
**Notes:** Per the project's CLAUDE.md "Supervisor scaffold" section, verifying the CLAUDE.md change in a workspace that already has a supervisor requires forcing a fresh scaffold (delete `.dashboard/supervisor/CLAUDE.md`, remove + re-add the workspace).

### P1B-03 Attach-driven ignore window
**Status:** Complete — landed 2026-05-16 (agent a485f0b4, M2B bundle). Both `windows-runner.ts` and `wsl-runner.ts` (+13 each) gained `_ignoreBurstUntil` field + `markInteractionIgnoreWindow(ms = 750)`; `_lastMeaningfulBurst` advance gated with `&& now >= this._ignoreBurstUntil` inside each runner's existing `if (this._recentOutputBytes > 200)` block. `attachAgent` (+6) calls `markInteractionIgnoreWindow(750)` on both Windows and WSL branches before establishing the new data channel; the lazy `spawnPtyHost` reconnect path runs after the ignore window is set, so reattach redraws are gated. No ring buffer added to WSL (deferred to P2-02). Final `markInteractionIgnoreWindow` grep is 4 hits, not 3 as the plan predicted (Windows+WSL definitions, plus Windows+WSL call sites in `attachAgent`).
**Phase:** 1B
**Prerequisites:** none
**Files:**
- `src/main/supervisor/windows-runner.ts:107-148`
- `src/main/supervisor/wsl-runner.ts:151-168`
- `src/main/supervisor/index.ts` (search `attachAgent`)
**Steps:**
1. Add `markInteractionIgnoreWindow(ms = 750)` to both runners. Implementation: set `_ignoreBurstUntil = Date.now() + ms`. In the data handler that advances `_lastMeaningfulBurst`, skip the advance while `Date.now() < _ignoreBurstUntil`.
2. `AgentSupervisor.attachAgent` calls `runner.markInteractionIgnoreWindow(750)` before establishing the new output channel.
**Acceptance:** manual — open an idle Codex agent's terminal; status does not flip to `working` from the TUI redraw alone.

## Phase 2 — Waiting-state detection

### P2-01 Add `endsWithQuestion` to `assistant-text` events
**Status:** Complete — landed 2026-05-16 (agent c89e9a46, M3 bundle). `endsWithQuestion?: boolean` added to `AssistantTextEvent` and `AssistantTextPatchEvent` in `src/shared/session-events.ts`. All three readers compute `text.trimEnd().endsWith('?') && text.trimEnd().length > 0` with intentional per-provider divergence: Claude only when `stop_reason === 'end_turn'`; Codex when `task_complete`/`turn_aborted` retroactively tags an in-batch `assistant-text`, plus on `AssistantTextPatchEvent` (computed from cached `prior.text`); Gemini on every `assistant-text` (D-07: per-emission since Gemini hardcodes `turnComplete: true`). New per-reader fixtures + new `claude-jsonl-reader.test.ts` file (3 P2-01 tests).
**Phase:** 2
**Prerequisites:** P1A-02
**Files:**
- `src/shared/session-events.ts:20-27`
- `src/main/supervisor/log-readers/claude-jsonl-reader.ts:269-289`
- `src/main/supervisor/log-readers/codex-rollout-reader.ts:273-283`
- `src/main/supervisor/log-readers/gemini-transcript-reader.ts:321-331`
**Steps:**
1. Add `endsWithQuestion?: boolean` to `AssistantTextEvent`.
2. Each reader, when emitting `turnComplete: true` (Claude/Codex) or any `assistant-text` (Gemini), computes `endsWithQuestion = text.trimEnd().endsWith('?') && text.trimEnd().length > 0`.
3. Update `AssistantTextPatchEvent` (P1A-04) to also carry `endsWithQuestion?: boolean` so codex split-batch retag preserves the flag.
**Acceptance:** new fixtures per reader exercise the flag. Existing reader tests continue to pass.

### P2-02 PromptPatternDetector + waiting status from PTY
**Status:** Complete — landed 2026-05-16 (agent c89e9a46, M3 bundle). New `src/main/supervisor/prompt-pattern-detector.ts` + `.test.ts` (11 tests, BR-14 + supporting). WSL runner gained sibling `outputRing: string[]` (MAX_RING_LINES = 500) advanced inside the existing `handleMessage('data')` block — same code path as `_lastMeaningfulBurst`. Both runners expose `getOutputRingTail(maxBytes = 4096): string`; partial-line concatenation logic mirrored across both so fragmented prompts coalesce. `StatusMonitor` gained a fourth collaborator `getOutputRingTail`; `inferStatus` runs the detector after latch check on `elapsed > 2_000` and calls `forceWaiting` on match. Inlined `stripAnsi` helper inside `status-monitor.ts` rather than extracting a shared module (judgment call: lower-cost than churning a shared file). BR-14 + 11 status-monitor tests green.
**Phase:** 2
**Prerequisites:** P0-02, P1A-01
**Files:**
- new `src/main/supervisor/prompt-pattern-detector.ts`
- `src/main/supervisor/status-monitor.ts:56-72`
- `src/main/supervisor/windows-runner.ts:107-148` (expose ring tail)
- `src/main/supervisor/wsl-runner.ts:107-168` (add ring buffer + ring tail)
**Steps:**
1. Implement `PromptPatternDetector.match(strippedTail: string): { kind: string; excerpt: string } | null` with the §2.3.2 pattern set. Match must be in the last 512 bytes of the input.
2. **Windows runner:** add `getOutputRingTail(maxBytes = 4096): string` that joins `outputRing` and slices the trailing N bytes.
3. **WSL runner:** add a sibling ring buffer — `outputRing: string[]`, `MAX_RING_LINES = 500`, advanced in the data handler at `wsl-runner.ts:~108` (where `_lastMeaningfulBurst` is currently advanced — verify line on kickoff). Add `getOutputRingTail(maxBytes = 4096): string` matching Windows. **Reason:** an extra `tmuxCapturePane` subprocess per tick would cost more than the ring.
4. `StatusMonitor` accepts a fourth collaborator `getOutputRingTail(agentId): string` from `AgentSupervisor`.
5. In `inferStatus`, after the latch check, before the elapsed-time fallback: if `elapsed > 2_000`, run `PromptPatternDetector.match(stripAnsi(getOutputRingTail(agent.id)))`. If matched, call `forceWaiting(agent.id, kind=match.kind, excerpt=match.excerpt)` (which sets the latch and emits) and return `'waiting'`.
**Acceptance:** synthetic test in `status-monitor.test.ts`: a fake `getOutputRingTail` containing `Do you want to proceed? (y/N) `; `inferStatus` returns `'waiting'` and bridge fires the event. BR-14 passes.
**Notes:** the ANSI strip helper exists in `windows-runner.ts:176-184` and `wsl-runner.ts:200-207`; extract to a shared helper or duplicate the regex set inline in the detector — implementer's choice.

### P2-03 `waiting_for_input` payload + bridge wiring
**Status:** Complete — landed 2026-05-16 (agent c89e9a46, M3 bundle). `SupervisorEvent` extended with `waitingKind?` + `waitingExcerpt?` (no new type tag — kept as `status_change` to `'waiting'` per D-01). `buildEventPayload` renders the §2.3.3 format. `'waiting'` added to `TRIGGER_STATUSES` at top of `event-bridge.ts`; the `waiting → working` suppression is a separate early return inside `onStatusChanged`, ordered before the supervisor lookup (BR-20). For codex `assistant-text-patch` carrying `endsWithQuestion: true`, bridge calls `forceWaiting(agentId, 'question', '')` — excerpt empty since patch event has no body, supervisor still gets dedicated header + log tail. `sendInput` clearing the latch: implementer chose `bridge.notifyUserInputDelivered(agentId)` hook called from `AgentSupervisor.sendInput` after `_doSendInput` resolves (keeps the "only forceWorking if currently waiting" conditional on the bridge for BR-15 testability while keeping the bottleneck in `sendInput` so HTTP/IPC/MCP all benefit). BR-13×2, BR-15×2, BR-20 green.
**Phase:** 2
**Prerequisites:** P2-01, P2-02
**Files:**
- `src/main/supervisor/event-payload-builder.ts:3-25, 48-103`
- `src/main/supervisor/event-bridge.ts`
- `src/main/supervisor/index.ts:341` (`triggerStatuses`)
**Steps:**
1. Extend `SupervisorEvent` with `waitingKind?` and `waitingExcerpt?` fields. Do NOT add a new `type` tag — waiting is a `status_change` to `'waiting'`.
2. `buildEventPayload` for `type === 'status_change' && toStatus === 'waiting'` renders the §2.3.3 format.
3. Add `'waiting'` to `triggerStatuses`. Add a fromStatus filter: when `fromStatus === 'waiting'` and `toStatus === 'working'`, do NOT fire (avoid noise on user response).
4. When a chat event has `endsWithQuestion: true`, the bridge calls `forceWaiting(agentId, 'question', text.slice(-300))` (the existing `statusMonitor.forceWaiting` path, which emits the status_change event with `waitingKind`/`waitingExcerpt` populated).
5. Bridge wraps `sendInput` to clear the latch on success: when the supervisor or a user sends input to an agent currently in `'waiting'`, the wrap calls `forceWorking(agentId, 'user-input')` after `sendInput` resolves. (This handles the `waiting → working` transition for both the question case and the PTY-pattern case.)
**Acceptance:** BR-13, BR-14, BR-15, BR-20 pass. Manual: a Codex agent emits a `?`-ending final message → supervisor receives `[DASHBOARD EVENT] Agent waiting for input` with the question quoted. Sending a reply via the chat input flips the agent back to `working` immediately.

### P2-04 Supervisor CLAUDE.md text for waiting_for_input
**Status:** Complete — landed 2026-05-16 (agent c89e9a46, M3 bundle). `SUPERVISOR_AGENT_MD` constant in `src/shared/constants.ts` (+1 line) gained the `waiting_for_input` bullet under the Automatic Events section. On-disk `.dashboard/supervisor/CLAUDE.md` NOT touched (running supervisor would block the edit). To surface the new bullet in an existing workspace requires the rebuild + force-fresh-scaffold sequence per the project CLAUDE.md "Supervisor scaffold" section.
**Phase:** 2
**Prerequisites:** P2-03
**Files:** `src/shared/constants.ts` (search `SUPERVISOR_AGENT_MD`, "Automatic Events" section).
**Steps:**
1. Add a `waiting_for_input` bullet: "When a supervised agent is waiting on user input (in-text question, terminal prompt, plan-mode approval), the dashboard sends `[DASHBOARD EVENT] Agent status changed` with `Status: ... → waiting`, plus a `Waiting kind:` and `Excerpt:` line. Read the agent log for context, decide a response, and reply with `send_message_to_agent` (text answers) or `send_keys_to_agent` (arrow-key pickers / Enter)."
**Acceptance:** rebuild + force-fresh-scaffold a supervisor; new bullet present in `.dashboard/supervisor/CLAUDE.md`. (See CLAUDE.md "Supervisor scaffold" section for the rebuild + delete-folder + re-add-workspace sequence.)

## Phase 3 — Multi-supervisor seam audit + integration test

### P3-01 Multi-supervisor seam audit doc
**Status:** Complete — landed 2026-05-16 (agent 981fc41a). `docs/SUPERVISOR_ROUTING_SEAMS.md` published (143 lines). 17 seams documented (13 from plan §2.6 verified + 4 surfaced by audit): 3 single-owner safe, 10 need per-owner rework, 1 delete (duplicate-supervisor guard), 1 dev/legacy (`list-ids.js`). Plan §2.6's table was stale (pre-M2A); audit captured the shape change (`event-bridge` extraction collapsed two open-coded sites into one wiring point at `index.ts:245`) and corrected line-number drift on 6 of 11 entries. **New sites the plan missed:** `dashboard-store.ts:555-557` (renderer's single `supervisorAgent` field); `mcp-supervisor.js:594-609` (`launch_agent` MCP handler doesn't propagate `supervisorId` — would orphan MCP-launched workers post-migration); `event-bridge.ts:280 forgetAgent`; `test-helpers/fake-bridge-deps.ts:109`. **Highest-risk silent-bug seams:** singleton queue/drain in `event-bridge.ts:50,52` (events would consolidate to wrong supervisor); `getSupervisorForWorker` wiring at `index.ts:245`; orphaned MCP workers; `queryAgent --continue` fallback at `index.ts:1443`. Audit added an MS-01..MS-05 test matrix proposal for P3-02 (per-owner queue isolation, per-supervisor drain state, explicit `supervisor_id`-based resolution). Minor accounting nit: disposition counts sum to 15 not 17 (worth reconciling on follow-up read).
**Phase:** 3
**Prerequisites:** Phase 0, 1A, 1B complete; can run in parallel with Phase 2.
**Files:** new `docs/SUPERVISOR_ROUTING_SEAMS.md`.
**Steps:**
1. Walk every site in §2.6's table; verify against HEAD; correct any drifted line numbers.
2. For each site, document current behavior + post-multi-supervisor disposition.
3. For each site, note any per-call-site test required to cover the routing change (cross-reference the BR-IDs from P3-02).
**Acceptance:** doc lists every `getSupervisorAgent` call site in `src/`. Each entry has a "disposition under multi-supervisor" column.

### P3-02 Bridge integration test: agent-X-transitioned-to-supervisor-Y-received-event
**Phase:** 3
**Prerequisites:** P0-03, P1A-02, P1B-01, P2-03
**Files:** new `src/main/supervisor/event-bridge.integration.test.ts`.
**Steps:**
1. Scenarios: idle, crash, context-threshold, waiting (question), waiting (tty-pattern). For each, set up worker A and (in a multi-supervisor variant) workers A under supervisor A and B under supervisor B.
2. Assert: worker A's events land at the workspace's supervisor (today), at A's owning supervisor (post-migration). B's events likewise.
3. The multi-supervisor variant lives behind a flag `process.env.MULTI_SUPERVISOR === '1'` (or `it.skip` style) so the migration ticket can flip it on.
4. Append to `test:supervisor`.
**Acceptance:** all single-supervisor variants pass; the multi-supervisor variant is documented as the acceptance test for migration P1-03/P1-04.

### P3-03 GroupThink markdown freshness
**Phase:** 3
**Prerequisites:** P1A-02
**Files:** `scripts/groupthink-v1.md:120-129`.
**Steps:**
1. Remove the stale "Consecutive ready+fresh-message observations required before treating a turn as complete" claim about `MIN_READY_POLLS` — that constant is only used by `waitReady` for initial launch now.
2. Add a note: "Turn completion no longer gates on `agent.status`; the script reads `turnComplete: true` from the chat stream directly. With Phase 1A landed, the status field flips to `idle` within ~1 s of `turnComplete`, but the script does not depend on this."
**Acceptance:** doc matches script behavior at HEAD.

---

# Part 5 — Ordering & milestones

| Milestone | Tickets | Unblocks |
|---|---|---|
| **M0 — Test convention + payload `source`/`fromStatus`** | P0-00 ✓, P0-01 ✓ | Every subsequent ticket can assert |
| **M1 — Bridge extracted + baseline tests** | P0-02 ✓, P0-03 ✓ | Phase 1A, 1B, 2 |
| **M2A — Pipeline B → status (latched)** | P1A-01 ✓, P1A-02 ✓, P1A-03 ✓, P1A-04 ✓ | UX fix for documented Codex stall incident |
| **M2B — Crash routing + cleanup + attach window** | P1B-01 ✓, P1B-02 ✓, P1B-03 ✓ (committed 3b19a1b) | Multi-supervisor migration becomes safe |
| **M3 — Waiting visible** | P2-01 ✓, P2-02 ✓, P2-03 ✓, P2-04 ✓ (uncommitted on master 2026-05-16) | Plan-mode + in-text questions reach supervisor |
| **M4 — Migration-ready** | P3-01 ✓ (uncommitted), P3-02, P3-03 | Multi-supervisor migration P1-03/P1-04 have integration tests to pass |

M2A and M2B are sibling-parallel after M1. **Both M2A and M2B must land before the multi-supervisor migration starts** — M2A so the bridge has authoritative status truth, M2B so the bridge actually sees crashes.

M3 is independent of the multi-supervisor migration and can ship in parallel with it.

M4 is concurrent with the multi-supervisor migration's Phase 1.

---

# Part 6 — Deferred follow-ups (NOT in this plan)

These are explicitly out of scope but tracked here so they don't get lost:

1. **Gemini turnComplete gating.** When the Gemini reader can suppress `turnComplete: true` while tool-call envelopes are still pending in the same turn, wire Gemini into `forceIdle` like Claude/Codex. Source: D-07.
2. **`Sending…` overlay split** (Phase 1.4 of `AGENT_STATUS_AND_INPUT_DETECTION.md`). Retire the `withInputInFlight` wire-format override without removing the safety gate. Orthogonal to this plan.
3. **`OutputClassifier`** (Phase 1.2 of `AGENT_STATUS_AND_INPUT_DETECTION.md`). Per-instance classifier to suppress spinner / status-line redraws. Marginal value once the latch (D-09) prevents PTY bursts from undoing Pipeline B.
4. **Track 3 Claude Code hooks sidecar.** Per-agent `.claude/settings.local.json` registering `PermissionRequest`, `Notification`, `PreToolUse(AskUserQuestion|ExitPlanMode)`, `Stop(permission_mode=plan)` hooks for high-confidence waiting detection. Defer until the in-text + PTY-pattern heuristics in Phase 2 prove insufficient.
5. **Tighten `WORKING_THRESHOLD_MS`** (Phase 1.3 of the design doc). Defer; with Pipeline B latching, the 8 s threshold is only a fallback and tightening risks flicker on slow-streaming providers.
6. **Team events.** If Teams reintroduces a need for `team_created` / `team_loop_detected`, restore the type tags and payload branches deleted in P1B-02.
7. **`team-delivery.ts` owner-aware routing audit.** Per the multi-supervisor seam list (§2.6); inherits owner-aware routing from the bridge changes once the migration lands.
8. **Drain-on-detach hook (BR-04b).** Today `drainEventQueue` runs on a timer regardless of `isAttached`; `detachAgent` (`index.ts:1833`) only writes DB state. To make a detached supervisor receive its queued events immediately on detach, add `onSupervisorDetached(supervisorId)` to `EventBridge` and call it from `detachAgent`. Test as BR-04b. Surfaced by Reviewer 2's critique of P0-02 (2026-05-16).
