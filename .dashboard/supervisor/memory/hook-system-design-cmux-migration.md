# Hook System Redesign (cmux-inspired) — V2 next-step

**Recorded:** 2026-06-03. **Source doc:** `docs/HOOK_SYSTEM_DESIGN.md` (772 lines).
**Why this matters:** Worker-lane status (working/idle/waiting) is **hook-owned** —
`StatusMonitor.inferStatus()` returns `null` for any `isSupervised || isWorker` agent
(`status-monitor.ts:840`), so PTY heuristics are deliberately OFF for workers. Every
supervisor automation (route idle worker's question to human, orchestration step
gating, idle-worker reaping) keys off a hook firing. If a hook silently fails, the
worker isn't degraded — it's **blind** until a 15-min silence watchdog warns. This
doc is the plan to make that single-path system resilient. Paired with the V2 dashboard
initiative ([v2-supervisor-dashboard-initiative.md]) as a **V2 big-lift next step.**

## Related existing memories (read alongside)

- [codex-hook-trust-persistence.md] — Codex `[hooks.state]` trust mechanics; the B8 fix (trust-seeding) detail. Narrower than this doc.
- [hook-evidence-playbook.md] — how to PROVE a hook fired (query `dashboard.db` status_change rows; `scripts/hook-evidence-query.mjs` / `hook-evidence-by-agent.mjs`). Forensics, not redesign.
- [working-detection-history.md] — history of working/idle detection approaches.

This memory is the **umbrella / roadmap**; those three are the slices.

## The model being copied: cmux

On-disk reference clone: `C:\Users\turke\Projects\_cmux_inspect` (Swift, Ghostty-based).
What's worth stealing (transport-agnostic parts):
- **Defensive hook contract** (`CLI/CMUXCLI+AgentHookDefinitions.swift:318`): resolve CLI from bundled-path-or-PATH, guard on surface-id + per-agent disable env, **always `echo '{}'`** so the hook satisfies the framework's stdout contract and never errors the agent — even when the dashboard is down.
- **Codex has a `SessionStart` hook**; its "needs human" signal is **`PermissionRequest`** (not a generic Notification).
- **Codex feature gate:** cmux patches `config.toml` `[features] hooks = true` on install (`cmux.swift:26202`). If off, hook tables parse but never fire.
- **Claude `CLAUDE_CONFIG_DIR` redirection** — cmux points Claude at a managed config dir + injects its own `settings.json`, never mutating the user's real `~/.claude`. (We should EVALUATE adopting this — §5.4.)
- **OSC 99 / BEL in-band signals** are an *attention* backstop only, NOT a turn-complete control plane.

## Two hard requirements (shape every decision)

1. **Zero user setup.** Dashboard installs/enables/verifies all hooks itself. User never edits settings.json/config.toml, trusts a project, or runs setup. Non-negotiable.
2. **Multi-transport delivery.** A hook event must reach the dashboard via >1 channel so a single transport failure (WSL→Windows NAT, dead port, captured stdout) degrades to another **hook-grade** signal, not to heuristics.

## Target architecture (§5)

One normalized `AgentStatusSignal` carrying **provenance + confidence**
(`authoritative | durable-fallback | heuristic`). Delivery layers in priority order:

| Layer | Source | Confidence |
|---|---|---|
| 0 | Runner lifecycle (launch→launching; exit→done/crashed) | authoritative |
| 1 | Framework hooks → **HTTP POST** | authoritative |
| 2 | Same hooks → **durable spool file** (+ tmux pane `@user-option` on WSL) | durable-fallback |
| 3 | Terminal OSC/BEL parse (+ tmux monitor-bell) | heuristic (attention) |
| 4 | Prompt-pattern regex on PTY tail | heuristic (non-worker, or worker after grace w/ no L1/L2) |
| 5 | Silence watchdog | marks `degraded`, never fabricates state |

**Key contract:** Layers 1 & 2 are the SAME hook event over two transports. A broken
HTTP path drops to L2 (still hook-grade), NOT to L3/L4 heuristics. This is the Codex
agent's central critique — fix fragility by making *delivery* multi-transport, don't
re-enable PTY inference for workers (that masks broken hooks).

## STATUS: what's DONE vs the remaining V2 lift

**DONE (P0 + B8, committed; live-verify pending an app restart):**
- SessionStart hooks (both providers) — health-only ping, never changes `status`.
- `hook_status` model (`unknown|healthy|broken|degraded`) + `lastHookEventAt` on Agent type + DB.
- **Launch-time canary** (`HOOK_CANARY_WINDOW_MS=8000`): stamps `hook_status='broken'` if no hook clears the window; never touches `status`. Live-verified 2026-06-02 (caught real B8 regression).
- B2: custom Codex command instrumentation (`instrumentCodexWorkerCommand()`) — injects missing `--profile`/`--bypass-hook-trust`, marks `degraded` if it can't.
- **B8 fix (2026-06-03):** `ensureCodexHookProfile()` now **seeds `[hooks.state]` trusted_hash** and is **non-clobbering** (hash-guarded; plain restart no longer wipes trust). Hash recipe verified byte-for-byte against live file. See [codex-hook-trust-persistence.md] for recipe detail.
- Research corrections: **B3 was a NON-BUG** (Codex `timeout` is SECONDS not ms; `30`=30s is correct — do NOT "bump to 5000"). **B1 overstated** (Codex hooks on-by-default now; `[features]` added as insurance).
- Red-test cleanup (BR-13 + masked siblings) green; `npm run test:supervisor` exit 0.

**P1 PLAN APPROVED (2026-06-06):** GroupThink v2 serial (Lead=Claude `4f01793c`, Reviewer=Codex `da83c178`) produced `plans/p1-hook-spool-multi-transport.md` (394 lines) — APPROVED by Codex after 4 drafts / 3 review rounds. Work items: A (hook script v7, §5.3 contract, spool path from env — v6's relative path spools the CODEX_HOME copy to `~/pending-status.jsonl`, outside workspace), B (central `applyHookStatusEvent(event, transport)` — single owner of dedupe/ordering/`receivedAt` stamping; build FIRST), C (spool tailer w/ partial-line buffer + startup-lookback gates), D (tmux pane option poll w/ triple freshness gate: 10-min bound + persisted `lastHookEventAt` + launch stamp — closes restart-replay), E (tests incl. restart-shaped case + provider×OS matrix). Key review catches to preserve in implementation: duplicates/stales NEVER advance `lastHookEventAt` (stale tmux option would otherwise become a perpetual heartbeat masking hook silence); transport drain runs once at top of `poll()` tick BEFORE per-agent canary checks; skew tolerance allowed on launch guard only, never on the persisted-last-hook guard. Ordering: B→A→C→D, E alongside. No rotation in P1 (racy; deferred to P2, §8).

**P1 STATUS UPDATE 2026-06-07:** P1 appears LANDED in the tree — `src/main/supervisor/hook-spool-tailer.ts` + `hook-spool-tailer.test.ts` + `multi-transport-matrix.test.ts` exist (commit `80b871c` "batch: hook-spool tailer, provider dir-trust, file-viewer + theme persistence"). Verified by file presence only, not live-verified; the live-verify checklist below still applies after a restart.

**REMAINING — the real V2 payoff (in order):**
- **P1 — multi-transport resilience core (the headline lift). [PLANNED — see above; ready for a worker]** Promote `pending-status.jsonl` from passive failure-log to an **always-write active spool**: dashboard tails it, applies unseen/deduped events (dedupe by `{agentId, ts, hookEventName, turnId}`) through the same `forceIdle/WorkingFromHook` path. Add tmux pane `@user-option` write (WSL) + poll on watchdog ticks. Harden `dashboard-status.mjs` to the §5.3 contract: **spool-first, then HTTP, then tmux option, parse stdin, always exit 0.** Works identically across Windows/WSL/Claude/Codex with no per-OS branching — this is what removes the single-point-of-failure.
- **P2 — precision:** Claude `Notification` hook + Codex `PermissionRequest` hook → `waiting` with `waitingKind` (`approve|question|choice|enter`). Forward `session_id`/`turn_id` (prefer hook-supplied Codex session id over rollout-file discovery). Surface `hook_status` in the UI.
- **P3 — OSC/BEL ambient backstop (last, attention-only):** streaming OSC/BEL parser in WindowsRunner/WslRunner; emit `terminal-osc`/`terminal-bel` as attention hints, never turn-complete truth.
- **Tests:** one per matrix cell (Claude×Win, Codex×Win, Claude×WSL, Codex×WSL) + a "custom Codex worker command" test that FAILS if the lane is silently hookless.

## Explicitly NOT doing (§7)

- NOT re-enabling PTY idle/working inference for worker lanes (masks broken hooks).
- NOT a Unix socket as primary transport (HTTP simpler across WSL→Windows-Electron; socket is a later latency optimization only).
- NOT forking a terminal emulator.
- NOT treating OSC/BEL or tmux monitor-bell as turn-complete truth.

## Key file refs (Appendix)

- Hook script: `src/shared/constants.ts:517` (`DASHBOARD_STATUS_SCRIPT_MJS`)
- Claude settings template: `constants.ts:423`; Codex profile template: `constants.ts:596`
- Codex profile writer (B8 seeding lives here): `src/main/supervisor/index.ts:1238`
- Status endpoint: `api-server.ts:305`; hook→status dispatch: `index.ts:2598`
- PTY inference disabled for workers: `status-monitor.ts:840`
- Codex critique (full): `.dashboard/workers/claude/_codex_hooks_critique.md`
- Canary verify helper: `scripts/hook-canary-verify.mjs <id>` (reads hook_status/last_hook_event_at columns)

## Bottom line for V2

P0 correctness + the B8 trust-seeding are landed (pending one live restart-verify).
The **V2 lift is P1**: the multi-transport active-spool that makes hook delivery
survive any single transport failure — the difference between "worker goes blind on a
NAT hiccup" and "worker degrades to a second hook-grade channel." P2 (precise waiting)
and P3 (ambient OSC/BEL) follow. Always re-verify DONE-state against the tree before
planning — the doc's §8 log is detailed but the running app may lag the latest commit.
