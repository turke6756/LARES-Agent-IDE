# Supervisor Memory — Index

This is the index for the supervisor's persistent memory. Memory is organized by **category** — load the file whose category matches your situation.

## Categories

| File | Type | When to consult |
|---|---|---|
| [behavioral.md](behavioral.md) | **Behavioral patterns** | Situational "when X, do Y" rules. Consult when the current situation matches a trigger. |
| [playbooks.md](playbooks.md) | **Technical procedures** | Multi-step recipes you've used before. Consult before performing a recurring procedure. |
| [task-sizing.md](task-sizing.md) | **Task-sizing heuristics** | Pre-launch judgment on whether a task fits an agent's context comfortably. Consult before any `launch_agent`. |
| [open-bugs.md](open-bugs.md) | **Active bugs** | Confirmed bugs awaiting fix. Consult to avoid re-discovering known issues; cross-reference when filing new bugs. |
| [groupthink-running-gotchas.md](groupthink-running-gotchas.md) | **Domain gotchas (GroupThink)** | Workarounds specific to running GroupThink. Most entries cross-reference an open bug. |

## Discipline

- **Personality lives in `../CLAUDE.md`** — always loaded, level-sets every session. Memory adds situational depth on top.
- **Don't load every memory file at session start.** Consult by situation match. The index above tells you which file fits which situation.
- **Gotchas should be rare.** A gotcha confesses something is broken. Every gotcha should ideally have a matching open-bug entry; when the bug closes, the gotcha goes too. If a gotcha has no bug, either promote it to a playbook (it's how the thing works) or file the bug.
- **Update after notable interactions.** Playbook P-05 covers the routing recipe.

---

## Session highlights (most recent first)

- **2026-05-17** Memory restructured into category files (behavioral, playbooks, task-sizing). Personality principles added to `../CLAUDE.md`. Driver: user direction to formalize supervisor autonomy + memory organization. New entries B-01..B-07, P-01..P-07.
- **2026-05-17** GroupThink duplicate-relay bug found and fixed (durable: recency-based dedupe in `session-log-dispatcher.ts`). Worker delivered 19/19 dispatcher tests green. Awaits dashboard restart + commit. Investigation writeup at `plans/groupthink-duplicate-relay-investigation.md`.
- **2026-05-17** GroupThink produced `plans/multi-supervisor-migration-review.md` (187-line review of multi-supervisor migration doc). 2 blockers, 9 tightenings.
- **2026-05-17** 7-bug fix sweep (commit f4e1a58). Fixed BUG-01..BUG-08 except BUG-05 (already fixed via M2A). BUG-09 opened (status cycling). BUG-10, BUG-11 opened this session (large-prompt auto-submit race; dashboard event interrupts user typing).
- **2026-05-16** Agent-lifecycle hardening M0..M4 complete (17555fc → 4093521). Pipeline B chat-event-driven status with `IDLE_LATCH_TIMEOUT_MS = 30 min` in production.
- **2026-05-15** Agent-lifecycle planning session — master index at `docs/SESSION_2026-05-15_AGENT_LIFECYCLE_PLANNING.md`.
