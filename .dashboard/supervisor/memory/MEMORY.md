# Supervisor Memory

This file indexes the supervisor's persistent memory for this workspace.
Add entries as you learn important things about the agents, project, or decisions made.

<!-- Example entry:
- [decision_auth_approach.md](decision_auth_approach.md) - Chose JWT over sessions for auth, approved by human 2026-03-20
-->

- [hook-evidence-playbook.md](hook-evidence-playbook.md) - How to prove Claude/Codex hooks fire: query `dashboard.db` status_change rows tagged `hook-start`/`hook-stop` via `scripts/hook-evidence-query.mjs` (aggregate) or `hook-evidence-by-agent.mjs <id>` (scoped). Includes live-demo recipe. Result (2026-05-29): Claude fires both, Codex never fires `hook-start`.

- [codex-hook-trust-persistence.md](codex-hook-trust-persistence.md) - Whether rebuild / reopen / new-dir resets Codex hook trust. Verified 2026-05-29: plain rebuild + same dir does NOT reset; new dir doesn't carry persisted trust but the `--dangerously-bypass-hook-trust` launch flag runs hooks anyway; the only real silent re-gate is editing the hook command/script in constants.ts + a scaffold version bump. Trust lives in `~/.codex/config.toml [hooks.state]`, keyed per-workspace-config-path + command hash.
