# Working-detection — two approaches to the same problem

The dashboard's `agent.status` field answers one product question: **"can this CLI accept new input right now?"** Three patches (BUG-05 → BUG-09 → BUG-18) have refined the same architectural family. A rearch is now designed but not implemented. Both approaches live concurrently; this file is the comparison index so we can revisit the tradeoff with fresh eyes.

**Consult this file when:** scoping next-iteration work on `agent.status`, debugging a new working/idle false-flip, deciding whether to invest more in the patch family or commit to the rearch.

---

## Approach 1 — BUG-18 patch bundle (shipped, commit `2062ae0`)

**Philosophy:** stay inside the TTL-decay latch family. Make the inference cleverer.

**Mechanism:**
- `ttlClass` is now load-bearing in `inferStatus` (was dead-stored data; both BUG-18 investigators flagged this).
- New `thinking-pending` TTL class (900 s ceiling) for Claude xhigh thinking. The `thinking` chat event refreshes the latch with this class instead of `model-pending`.
- `sendInput.delivered` seed flipped from `model-pending` (180 s) to `tool-pending` (900 s) — covers first-turn extended thinking before any chat event lands.
- `turnInFlight: boolean` sticky flag on the latch, set on tool-use/task-started/non-terminal-assistant-text, cleared by `forceIdle('turnComplete')`. While true and no tools outstanding, `inferStatus` forces effective TTL to `tool-pending` regardless of the stored class — closes the `tool_result → next-assistant thinking gap`.

**Files touched (in commit `2062ae0`):**
- `src/shared/constants.ts` — added `WORKING_LATCH_THINKING_PENDING_MS = 900_000`.
- `src/main/supervisor/status-monitor.ts` — `WorkingLatchTtlClass` extended; `turnInFlight` on `WorkingLatchEntry`; `effectiveTtl` derivation rewritten to use `ttlClass` as source-of-truth; `ttlForClass()` helper.
- `src/main/supervisor/event-bridge.ts` — `thinking → 'thinking-pending'`; `turnInFlight: true` on tool-use/task-started/non-terminal assistant-text.
- `src/main/supervisor/index.ts` — sendInput seed `model-pending` → `tool-pending`.

**Tests:**
- `status-monitor.test.ts`: +7 BUG-18 tests (32 total, was 25).
- `event-bridge.test.ts`: +3 BUG-18 tests.
- **One existing BUG-09 test rewritten** (`BUG-09: both tools resolve — effective TTL shrinks to model-pending`) because it asserted the exact broken behavior Change 1 fixes. Renamed to `BUG-18 Change 1: both tools resolve — latch still survives past model-pending (ttlClass=tool-pending stored)`.

**Commit scope note:** `2062ae0` also carried pre-existing BUG-11 (user-typing deferral) hunks that were intermixed in the working tree. Committed wholesale; the BUG-11 work is unit-tested by its own BR-11a..d tests in `event-bridge.test.ts`. Title says `bug-18`; body's "Bundle scope note" is honest about it.

**Net effect:** false `working → idle` requires a chat-stream silence of **>900 s** during any window where chat-stream truth says a turn is live. The 2026-05-19 Opus 4.7 xhigh sighting (311 s gap) is comfortably covered.

**Remaining edge:** a 15-minute single tool turn with no chat events would still flip. The BUG-18 writeup recommends a playbook-level fork-and-execute pattern for those.

**LOC:** ~150 net of code change (commit shows 757/42 with BUG-11 ride-along; BUG-18-only portion is closer to ~150).

---

## Approach 2 — turn-bounded FSM rearch (designed, NOT implemented)

**Philosophy:** invert the model. Stop inferring decay; track explicit turn brackets.

**Design doc:** `plans/working-detection-rearch-design.md` (produced by GroupThink 2026-05-19; Claude lead + Codex reviewer, 4 turns).

**Source novel-approaches investigations:**
- `plans/working-detection-novel-approaches-claude.md` — Approach 2 (turn-bounded FSM).
- `plans/working-detection-novel-approaches-codex.md` — Approach 1 (transcript-backed turn lease with real submission ACK) + Approach 24 (`idle_candidate` quarantine).

**Mechanism (two-phase open):**
1. `sendInput.delivered=true` → `markSubmissionPending` → latch in `ackState='pending', turnInFlight=true`. UI flips to working with no perceptible delay.
2. Real provider transcript `user-text` (or dispatcher's `'submission-ack'` for Codex/Gemini's synthetic dedupe path) → `confirmSubmissionAck` → `ackState='confirmed'`. No TTL ceiling on `turnInFlight`.
3. If no ACK within `WORKING_LATCH_ACK_DEADLINE_MS=15_000` ms → single `input_unacked_warning` audit row; latch stays (`delivered=true` is still meaningful evidence).

**Close:** existing provider-transcript terminal events (`stop_reason='end_turn'`, `task_complete/turn_aborted`, Gemini `allToolsResolved && usageLanded`) call `forceIdle('turnComplete')`, which overwrites the latch.

**Safety layers:**
- **Layer A — `idle_candidate` quarantine.** Bridge's `onStatusChanged` suppresses any `working → idle` whose `reason !== 'turnComplete'` if the agent had `turnInFlight` evidence within `QUARANTINE_WINDOW_MS=3_000`. Status flips in DB (UI correct); supervisor automation held back. Audits `quarantine_idle_candidate`.
- **Layer B — long-horizon watchdog.** 60-min ceiling on `inflightSince` → emits `degraded_state` audit. Does NOT flip status.

**Smart BUG-10-derived defense:** `session-log-dispatcher.ts` already synthesizes a fake `user-text` for Codex/Gemini and drops the real reader event within the 35 s dedupe window. Naively trusting that would create false ACKs. The plan splits the ACK path: dispatcher emits `'submission-ack'` exactly at the dedupe-match point (the moment the real reader event would be dropped); bridge gates its own ACK on `provider === 'claude'`. Synthetic events from codex/gemini reaching the bridge cannot ACK.

**BUG-10 handling improved (bonus):** `delivered=false` → no `markSubmissionPending` → no FSM open. Today's PTY meaningful-burst could falsely promote on staged-paste activity; the new design can't.

**Resume from transcript on reconcile:** new `scanTranscriptForOpenTurn` helper scans the last ~200 lines of the agent's transcript; if non-terminal, `resumeTurnInFlight` seeds `ackState='confirmed', turnInFlight=true`. Wired in the workspace-load reconcile path, NOT in `attachAgent` (terminal binding ≠ resume).

**Files touched / added:**
- `src/shared/constants.ts` — 4 new constants.
- `src/main/supervisor/status-events.ts` — optional `reason: StatusChangeReason` on `StatusChangedEvent`.
- `src/main/supervisor/status-monitor.ts` — extend `WorkingLatchEntry` (5 new fields), inject `auditEvent` collaborator, new methods (`markSubmissionPending`, `confirmSubmissionAck`, `resumeTurnInFlight`, `hadInflightRecently`, `touchInflight`), rewrite `inferStatus` working-branch (FSM path + preserved legacy non-inflight path).
- `src/main/supervisor/session-log-dispatcher.ts` — emit `'submission-ack'` at dedupe-match point.
- `src/main/supervisor/event-bridge.ts` — widen collaborator interface, provider-gate `user-text` ACK, insert quarantine gate in `onStatusChanged`, widen `addAuditEvent` union for `quarantine_idle_candidate`.
- `src/main/supervisor/index.ts` — sendInput callback: notify FIRST, then `markSubmissionPending`. Dispatcher `'submission-ack'` subscription. Reconcile-time gated resume.
- `src/main/supervisor/resume-turn-inflight.ts` — **new ~60 LOC** scan helper.
- `scripts/replay-bug18.ts` — **new ~50 LOC** offline validation.

**Tests:** +~280 LOC across 5 test files. Notable: direct regression for synthetic Codex/Gemini `user-text` reaching the bridge → no ACK fires (protects the provider gate against future widening regressions).

**Total LOC:** ~540 (150 production + 60 resume helper + 280 tests + 50 replay script).

**Validation:** offline replay of the 311 s xhigh trace + 276 s tool_result-gap trace; live xhigh agent test.

**Implementation status:** approved design, sequencing in §3 of the doc spells out 16 steps with green-test gates between each. Not yet handed to a worker.

---

## Comparison axes

| Axis | Approach 1 (BUG-18 patch) | Approach 2 (FSM rearch) |
|---|---|---|
| **Architectural family** | TTL-decay latch with smarter refreshes | Event-bracketed FSM (turn lease) |
| **Status when this file was written** | Shipped (commit `2062ae0`) | Designed, not implemented |
| **LOC** | ~150 (net of BUG-18 portion) | ~540 (150 prod + 60 helper + 280 tests + 50 replay) |
| **Pure-thinking coverage (BUG-18 311 s gap)** | Yes — 900 s `thinking-pending` ceiling | Yes — `turnInFlight` never decays |
| **15-min single tool turn** | Edge remains (no chat events refresh the 900 s ceiling for that long) | Handled — tool outstanding holds latch indefinitely |
| **BUG-10 (staged paste)** | Status flips working from PTY meaningful-burst on paste activity — misleading signal | Better — `delivered=false` → no FSM open → no false working |
| **BUG-10 false-ACK risk via synthetic user-text** | Not applicable (no ACK semantics) | Explicitly defended via dispatcher-emits-at-dedupe + bridge provider gate |
| **Failure mode if classifier is wrong** | Silent flip to idle → supervisor may auto-stop the worker | Layer A quarantine swallows non-`turnComplete` working→idle events; supervisor not auto-triggered |
| **Restart with open turn** | DB status carried back; no reconcile; relies on PTY/chat events to keep latch warm post-restart | Explicit `scanTranscriptForOpenTurn` at reconcile; deterministic resume |
| **Reversibility** | `git revert 2062ae0` | Larger swap; less straightforward to revert once landed |
| **Relationship** | Approach 2 BUILDS ON Approach 1 — preserves `turnInFlight` field, preserves PTY fallback for non-inflight latches. Not competing at the field level; competing at the architectural-philosophy level. |

---

## When to revisit

Trigger conditions for re-opening this decision:
1. **A `working → idle` false-flip lands in production despite Approach 1.** Means the 900 s ceiling isn't enough or there's an unrefreshed window. Approach 2's `turnInFlight=true never decays` is the next move.
2. **A 15-min single-tool-call shape surfaces.** The Approach 1 edge case. Either accept the playbook-level workaround (fork-and-execute pattern) or escalate to Approach 2.
3. **BUG-10 / BUG-11 effort spins up.** Approach 2 strengthens both — worth scoping it into a combined workstream rather than patching BUG-10/11 in isolation.
4. **Multi-workspace / supervisor scaling exposes restart semantics.** Approach 2's reconcile path is the right home for restart correctness; today's behavior is hope-driven.
5. **Six months pass with no false-flip incident on Approach 1.** Decide whether the rearch ROI is still there.

If none of the above happen and the dashboard is healthy: leave Approach 2 as a documented option, not a backlog item. Patches were the right ceiling in that scenario.

---

## Cross-references

- `plans/status-flip-bug18-investigation-claude.md` — BUG-18 root cause investigation (Claude).
- `plans/status-flip-bug18-investigation-codex.md` — BUG-18 root cause investigation (Codex).
- `plans/terminal-state-parsing-feasibility.md` — the disproved "idle-prompt as primary signal" detour.
- `plans/working-detection-novel-approaches-claude.md` — Approach 2's source investigation (Claude perspective).
- `plans/working-detection-novel-approaches-codex.md` — Approach 2's source investigation (Codex perspective, 24-option survey).
- `plans/working-detection-rearch-design.md` — the GroupThink-produced implementation plan for Approach 2.
- `plans/transient-idle-flip-investigation.md` — earlier BUG-09 root-cause investigation that established the latch architecture.
- `.dashboard/supervisor/memory/open-bugs.md` — BUG-18's closed entry references commit `2062ae0`; BUG-09's closed entry references the latch-shape lineage.
