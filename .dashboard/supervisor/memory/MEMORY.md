# Supervisor Memory

This file indexes the supervisor's persistent memory for this workspace.
Add entries as you learn important things about the agents, project, or decisions made.

<!-- Example entry:
- [decision_auth_approach.md](decision_auth_approach.md) - Chose JWT over sessions for auth, approved by human 2026-03-20
-->

- **[open-bugs.md](open-bugs.md)** — confirmed bugs to fix, then delete the
  entry once fixed. 8 open (BUG-01..BUG-08) as of 2026-05-16. BUG-05
  (status flapping) is in-progress via the agent-lifecycle-hardening plan.
  When fixing a bug, also delete or mark its detail entry in
  `groupthink-running-gotchas.md`.
- [groupthink-running-gotchas.md](groupthink-running-gotchas.md) — full
  detailed notes on 11 gotchas (8 are bugs cross-referenced from
  open-bugs.md; the others are operational lore like Claude quota walls
  and the resume command shape). #1-9 from GroupThink 2026-05-15. #10-11
  added 2026-05-16 from the codex-review panic-spawn incident.
- [docs/SESSION_2026-05-15_AGENT_LIFECYCLE_PLANNING.md](../../../docs/SESSION_2026-05-15_AGENT_LIFECYCLE_PLANNING.md) — master index for the agent-lifecycle planning session. Points at the produced plan, the three findings docs, the gotchas, the one source-tree fix shipped, and the bugs surfaced but not fixed. Read this first if returning to this work.
- **Hardening plan progress (`plans/agent-lifecycle-hardening-plan.md`):** M0 (P0-00, P0-01) + M1 (P0-02, P0-03) + **M2A (P1A-01, P1A-02, P1A-03, P1A-04)** complete as of 2026-05-16. M2A landed via agent f2a22815: `StatusMonitor` got `turnLatch` Map + `forceIdle/forceWaiting/forceWorking`; `EventBridge.onChatEvents` dispatches per §2.1 table with narrow Gemini opt-out; Codex reader emits `AssistantTextPatchEvent` (split-batch retag) + `TaskStartedEvent`; dispatcher mutates ring in place with audit comment. New test files: `status-monitor.test.ts` (11 tests, BR-11/16/17/18) + extensions to `event-bridge.test.ts` (BR-19), `session-log-dispatcher.test.ts` (BR-12 half), `codex-rollout-reader.test.ts` (BR-12 half + task_started + regression). All 8 test files green. `IDLE_LATCH_TIMEOUT_MS` (30 min) + `WAITING_LATCH_TIMEOUT_MS` (5 min) in constants. **Codex stall / BUG-05 fixed.** **Next:** M2B (P1B-01..03 — crash routing through bridge + dead team_* event cleanup + attach-driven ignore window). Must land before multi-supervisor migration starts. M3 (waiting detection — P2-01..04) is independent and can ship in parallel with the migration.
