# Supervisor Memory

This file indexes the supervisor's persistent memory for this workspace.
Add entries as you learn important things about the agents, project, or decisions made.

<!-- Example entry:
- [decision_auth_approach.md](decision_auth_approach.md) - Chose JWT over sessions for auth, approved by human 2026-03-20
-->

- **[open-bugs.md](open-bugs.md)** — confirmed bugs to fix, then delete the
  entry once fixed. **1 open (BUG-09)** as of 2026-05-17. BUG-01..BUG-08
  (excluding BUG-05) all fixed via commit f4e1a58 (7-bug sweep). BUG-05
  fixed earlier via M2A (commit 17555fc). When fixing a bug, also delete
  or mark its detail entry in `groupthink-running-gotchas.md`.
- [groupthink-running-gotchas.md](groupthink-running-gotchas.md) — full
  detailed notes on 12 gotchas. 9 are bugs cross-referenced from
  open-bugs.md (§1, §2, §4, §5, §7, §9, §10, §11 now marked FIXED;
  §12 added 2026-05-17 for BUG-09); the others are operational lore
  (§3 closed-bug history, §6 Claude quota walls, §8 resume command shape).
- [docs/SESSION_2026-05-15_AGENT_LIFECYCLE_PLANNING.md](../../../docs/SESSION_2026-05-15_AGENT_LIFECYCLE_PLANNING.md) — master index for the agent-lifecycle planning session. Points at the produced plan, the three findings docs, the gotchas, the one source-tree fix shipped, and the bugs surfaced but not fixed. Read this first if returning to this work.
- **Hardening plan (`plans/agent-lifecycle-hardening-plan.md`): COMPLETE
  through M4** as of 2026-05-16. M0..M4 all committed (17555fc → 4093521).
  Codex stall / BUG-05 fixed. Pipeline B chat-event-driven status with
  `IDLE_LATCH_TIMEOUT_MS = 30 min` is in production.
- **7-bug fix sweep (commit f4e1a58)** — 2026-05-17. Fixed BUG-01
  (`launch_agent` auto-submit + `submit` param), BUG-02 (`send_keys`
  `key` enum), BUG-03 (groupthink `--turn-timeout-ms` + agent.status
  awareness), BUG-04 (`ensureCodexResumeSessionId` helper), BUG-06
  (groupthink resume `seedLastRelayedTsFromChat`), BUG-07 (pollNow
  rate-limit bypass with optional agentId), BUG-08 (codex
  `freshSession` flag). +1661 / −137 across 19 files. Combined tree
  built clean and `test:supervisor` green before commit.
- **BUG-09 open (2026-05-17):** agent.status cycles working↔idle within
  a single user turn post-hardening. Verified the running app has M2A.
  Two hypotheses: (A) definitional — Pipeline B emits turnComplete on
  every tool-cycle boundary; (B) latch leak — `forceWorking` path is
  clearing the latch before the 30-min timeout. Investigation entry in
  open-bugs.md; symptoms in gotchas §12.
