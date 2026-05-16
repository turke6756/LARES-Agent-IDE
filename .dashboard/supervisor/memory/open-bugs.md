# Open Bugs — To Fix Then Delete

Each entry below is a confirmed bug surfaced during supervisor runs. When a
bug is fixed, **delete its entry from this file**. The detailed context lives
in `groupthink-running-gotchas.md` — once a bug is fixed, that gotcha entry
can also be removed (or marked `(FIXED YYYY-MM-DD)`).

Format per bug:

```
## BUG-NN: <short title>
- Component: <subsystem>
- Severity: <low | medium | high>
- Status: <open | in-progress | fixed>
- Gotcha ref: groupthink-running-gotchas.md §<n>
- Fix sketch: <one-paragraph proposed fix>
```

---

## BUG-01: `launch_agent` does not auto-submit its initial `prompt`

- Component: dashboard MCP / launch_agent
- Severity: medium (causes every supervised launch to need a second tool call)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §1
- Fix sketch: after writing the prompt into the agent's input buffer, send a
  provider-appropriate Enter (CR for Claude, kitty-encoded for Codex/Gemini)
  unless an explicit `submit: false` flag is passed. Document the flag in the
  tool description.

---

## BUG-02: `send_keys_to_agent` JSON `\r` escape is flaky at the tool boundary

- Component: dashboard MCP / send_keys_to_agent (tool param handling)
- Severity: medium (every Enter submission is a coin flip; supervisor often
  needs 2-3 retries with different encodings)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §2
- Fix sketch: the tool description claims JS-style escapes (`\r`, `\x1b`,
  `\n`) are interpreted by the JSON parser, but in practice they're often
  delivered as literal multi-byte text. Audit the param-decoding path so
  the documented behavior is reliable, OR change the doc to require
  literal control bytes (which works) and remove the misleading escape
  claim. Better: add a `key: 'enter' | 'esc' | 'tab' | ...` enum
  parameter that the tool translates internally per provider.

---

## BUG-03: GroupThink per-turn timeout hardcoded to 10 min

- Component: scripts/groupthink-v1.js (`waitTurnComplete`)
- Severity: low-medium (causes false-stall on slow reviewers; recoverable
  via resume but burns supervisor time)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §4
- Fix sketch: expose `--turn-timeout-ms` (default 10 min) so callers can
  bump it for complex deliberations. Or, better, have `waitTurnComplete`
  also consult ground-truth signals (agent.status, fresh PTY activity,
  message ring) before declaring stall — i.e. don't time out while the
  agent is demonstrably still working. The latter dovetails with the
  agent-lifecycle-hardening plan.

---

## BUG-04: Codex `resumeSessionId` discovery is unreliable (10s poll often misses)

- Component: dashboard / supervisor `discoverNewCodexSession`
- Severity: medium (breaks resume/fork/query for affected agents until
  manually recovered)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §5
- Fix sketch: `recoverCodexResumeSessionId` (`src/main/supervisor/index.ts:1129`)
  exists but isn't auto-called when discovery fails. Either extend the
  poll window beyond 10s, or call the recovery function as a fallback
  the first time any operation needs `resumeSessionId` and finds it null.

---

## BUG-05: Pipeline A status flapping — `working`→`idle` clusters

- Component: src/main/supervisor/status-monitor.ts (Pipeline A heuristic)
- Severity: high (root cause of supervisor decision errors; surfaced
  during this very session as 3-flap events on P0-00 and P0-01 worker
  agents, and as the misread that drove the codex panic-spawn)
- Status: **in-progress via `plans/agent-lifecycle-hardening-plan.md`**
  (M2A — P1A-01 through P1A-04). Will be fully fixed when M2A lands.
- Gotcha ref: groupthink-running-gotchas.md §7
- Fix sketch: see the plan. Pipeline B (`turnComplete: true` from chat
  events) is wired into `agent.status` with a per-agent turn-latch so
  PTY noise cannot oscillate the state. Crash routing through the
  bridge is M2B.

---

## BUG-06: GroupThink resume re-pastes existing turn-complete messages

- Component: scripts/groupthink-v1.js (resume branch / `lastRelayedTs`
  initialization)
- Severity: high when triggered (burned the entire Reviewer context
  window on 2026-05-15)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §9
- Fix sketch: in the resume branch, after fetching each planner's agent
  record, also fetch its chat (one message back is enough), find the
  latest `turnComplete: true` message, and seed
  `lastRelayedTs[agentId]` with its timestamp. Add a smoke test that
  resumes against two agents whose chats already contain turn-complete
  messages and asserts zero `sendInput` calls fire on Turn 1.

---

## BUG-07: `read_agent_chat` with `role` filter returns stale data on resumed codex sessions

- Component: dashboard MCP / chat reader (role-filtered query path)
- Severity: medium-high (caused the panic-spawn cycle on 2026-05-16 —
  three reviewer agents created when one had already succeeded)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §10
- Fix sketch: investigate whether the `role` filter hits a different
  code path than the unfiltered query (likely) and whether that path
  picks up newly-committed turns from the on-disk codex session log
  without lag. The unfiltered query path apparently does. Either align
  the filtered path with the unfiltered one, or document the lag
  contract and have the role filter return a "stale-as-of" timestamp
  the caller can compare against.

---

## BUG-08: Codex agent fresh-launches inherit saturated prior session

- Component: dashboard MCP / launch_agent (codex provider)
- Severity: medium (blocks cross-provider review patterns and any other
  case that wants a fresh codex context in a workspace that has had
  prior codex work)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §11
- Fix sketch: add a `resume: false` (or `freshSession: true`) parameter
  to `launch_agent`. When set, skip the resume-session discovery for
  this launch and start codex with a brand-new session. Default behavior
  unchanged for back-compat.

---

# Closed bugs (kept as history; delete entries here whenever you like)

- **2026-05-15** BUG-X: `scripts/groupthink-v1.js` `parseArgs` `split('=')`
  truncated topics containing `=`. Fixed at lines 44-47 by replacing
  destructured `split('=')` with `indexOf('=')` + `slice`. Gotcha ref:
  groupthink-running-gotchas.md §3.
