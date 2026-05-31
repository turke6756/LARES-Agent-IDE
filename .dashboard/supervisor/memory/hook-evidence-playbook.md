# Playbook: Inspecting hook activity (proving hooks fire)

**Last verified:** 2026-05-29

## Mental model

Every Claude/Codex hook invokes `<workspace>/.dashboard/scripts/dashboard-status.mjs`,
which POSTs to the dashboard API `/api/agents/{id}/status` with a `source` tag:

- `hook-start` — the **working/UserPromptSubmit** hook fired (Claude exports
  `CLAUDE_HOOK_EVENT_NAME`; Codex passes it on stdin).
- `hook-stop` — the **Stop/idle** hook fired.

The dashboard records these as `status_change` rows in the SQLite DB at:

```
%APPDATA%\AgentDashboard\dashboard.db   (table: events; joined to agents)
```

**A row tagged with `hook-start`/`hook-stop` = the hook physically ran AND reached
the dashboard.** No row for an expected hook = it didn't fire (or didn't reach us).

### Caveat: rows are transitions, not raw fires
The rows are `status_change` events, so a hook only adds a row when it causes an
actual status transition. A `hook-start` that fires while already `working` is
deduped → no new row. So **row count ≤ actual hook fires** — fine for a yes/no
"did it fire" proof, not for counting invocations.

## Tools (in `<workspace>/scripts/`)

- **`hook-evidence-query.mjs`** — aggregate: hook_start/hook_stop counts by
  provider, latest 25 hook-tagged events, agent census. Run for the big picture.
- **`hook-evidence-by-agent.mjs <agent-id-or-title-substring>`** — scoped: every
  hook-tagged event for one agent in time order. Use to prove a *specific* agent's
  hooks fired (I authored this 2026-05-29).

Both open the DB `readOnly`. Run from workspace root:
```
cd <workspace> && node scripts/hook-evidence-query.mjs
node scripts/hook-evidence-by-agent.mjs <id>
```
(Node prints an "SQLite is experimental" warning to stderr — harmless.)

## Live-demo recipe (proving a NEW agent's hooks fire)

1. `launch_agent` a fresh worker with a trivial auto-submitting prompt
   (e.g. `"Reply with exactly one word: pong. Do nothing else."`).
2. Note the returned agent id.
3. `node scripts/hook-evidence-by-agent.mjs <id>` — expect a `hook-start` then a
   `hook-stop` row a few seconds apart, bracketing the turn.
4. `stop_agent` the throwaway.

Need the `workspace_id` for `launch_agent`? `/api/workspaces` does NOT exist;
instead pull it off any agent: `curl -s http://127.0.0.1:24678/api/agents` and read
`workspaceId`. (AgentDashboard ws id seen 2026-05-29: `029b5cea-9a4a-4161-8e74-0ba8af5f3580`.)

## Known result (2026-05-29)

- **Claude:** `hook-start` ✅ AND `hook-stop` ✅ — both ends fire. Live-demo agent
  `1d6a5db6` produced `idle→working hook-start` @17:19:32 then `working→idle
  hook-stop` @17:19:36.
- **Codex:** `hook-stop` ✅ but `hook-start` = **0, ever** — the start hook never
  fires. Consistent with Codex per-hook trust-gating (see
  `plans/global-hook-rollout-and-submit-confirmation.md` §2.2). The measurement is
  sound (it catches Claude's full pair and Codex's Stop) — the gap is real, not
  instrumentation.

So when "we can't prove a hook fires," first run the aggregate query: if the
measurement catches *other* hooks but not the one in question, the hook genuinely
isn't firing.

## REFINEMENT (2026-05-29 live test) — the Codex finding was more subtle

Live-tested Codex with trust granted via the TUI. Two corrections to the earlier
"Codex start hook does NOT fire" conclusion:

1. **Codex gates hooks behind an interactive TUI trust prompt.** Opening the Codex
   terminal shows a **Hooks** panel: `⚠ N hook(s) need review before they can run`,
   with a per-event table (`Installed / Active / Review`). Keys: **`t` = trust all**,
   `enter` = review, `esc` = close. This IS the per-hook trust-gating from
   `plans/global-hook-rollout-and-submit-confirmation.md` §2.2 — caught live.
   - Before trust: `Stop  Installed 2  Active 1  Review 1` (Stop was the gated one).
   - After `t`:     `Stop  Installed 2  Active 2` — gate cleared.
   - The trust prompt **re-appears per fresh agent/session** until the trusted hash
     is durably stored; pressing `t` each time clears it.

2. **`UserPromptSubmit` was Active 2/2 the WHOLE time, yet `hook_start` = 0 in the DB.**
   So the start hook is installed, trusted, and active — it is NOT "not firing."
   The reason no `hook-start` row appears is **transition dedup**: the row is only
   written on an actual `idle→working` status_change, but Codex's PTY-paint inference
   (and/or the chat-event stream) flips the agent to `working` *before* the hook's
   POST lands, so the hook's `working` POST is a no-op transition → no row.
   - Corollary: a missing `hook-start` row is **not** proof the hook didn't fire for
     Codex. To prove the start hook actually executes, instrument the POST itself
     (e.g. an unconditional append in `dashboard-status.mjs`, or check
     `pending-status.jsonl`), not the dedup'd `status_change` table.
   - Confirmed live: after trust, fresh Codex agent `b56520a6` produced
     `working→idle hook-stop` @17:30:15 but **no** `hook-start` row — Stop fires,
     start fires-but-dedups.

**Action item flagged (not yet done):** rollout doc §2.2 and the spike's
"start hook does not fire" wording should be reconciled to "start hook is active but
its working-transition is dedup'd by inference" — a different root cause with
different implications for the confirm-and-retry design.

## PROVEN (2026-05-29 hooks-only test) — Codex start hook DOES fire

After landing the event-bridge change (gate chat-stream `force*` for supervised
claude/codex; see below) and restarting the app, ran a supervised Codex agent
through a real ~15s working window (`sleep 15` then reply). Result — the
**first-ever Codex `hook-start` transition row**:
```
18:03:50  idle→working  source:hook-start    ← Codex UserPromptSubmit hook
18:04:15  working→idle   source:hook-stop     ← Codex Stop hook
```
Live dashboard status (polled via /api/agents) tracked it exactly: `working`
@11:03:58 → `idle` @11:04:15, driven PURELY by hooks.

**Conclusion — the spike's "Codex start hook does NOT fire" is OVERTURNED.** The
start hook was always firing; the chat-event stream simply beat it to the
`idle→working` transition, so `hook-start` was a dedup no-op and never hit the DB.
Removing the chat-stream as a status source both isolated the variable AND
unmasked the start hook. Codex hooks-only status (both start and stop) works.

### The enabling code change (event-bridge gating)
`src/main/supervisor/event-bridge.ts`, in `onChatEvents`, after the `getAgent`
null-check, before the `switch`:
```js
// supervised claude/codex derive working/idle solely from hooks; gemini kept
// (no hook scaffold) so it isn't stranded.
if (agent.isSupervised && agent.provider !== 'gemini') continue;
```
Plus PTY inference was already disabled for supervised in
`status-monitor.inferStatus` (`if (agent.isSupervised) return null`). So for
supervised claude/codex, hooks are now the SOLE working/idle source (done/crashed
still come from the alive-check; `waiting` detection is lost — it only came from
the chat-stream). Requires `npm run build:main` + app restart to take effect
(no main-process hot reload).
