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

## BUG-09: agent.status cycles working↔idle within a single user turn

- Component: src/main/supervisor/status-monitor.ts + EventBridge
- Severity: medium (observability noise; cosmetic at agent scale, confusing
  at supervisor scale; can mask real "task done" idles)
- Status: open — needs investigation
- Gotcha ref: groupthink-running-gotchas.md §12
- Surfaced: 2026-05-17 during the 7-bug fix sweep (commit f4e1a58)
- Fix sketch: With M2A's `IDLE_LATCH_TIMEOUT_MS = 30 min` and a
  `turnComplete` chat event latching idle, the latch should hold for 30 min
  unless a real new `task_started` event arrives. In practice, worker
  agents cycled working↔idle multiple times per task within
  seconds-to-minutes — bug-06-fix idled at 8 turns then continued to 35
  turns; bug-01-fix idled mid-thinking; "events while you were busy"
  bursts kept arriving. Initially mis-attributed to "running on
  pre-hardening" — verified by checking Electron process start time
  (2026-05-17 15:56) vs M4 commit time (2026-05-16 16:41) and confirming
  `dist/main/main/supervisor/status-monitor.js` contains the M2A turnLatch
  logic (12 references to `turnLatch` / `forceIdle` / `forceWaiting` /
  `IDLE_LATCH_TIMEOUT_MS`). The running app DOES have M2A, so this is
  post-hardening behavior.

  Two possible root causes — investigation needed:

  - **(A) Definitional mismatch.** `EventBridge.onChatEvents` may emit
    `turnComplete` on each assistant-message-with-tool-result boundary,
    not just "agent has nothing else to do". If so, the M2A latch is
    doing exactly what it's coded to do, but the supervisor protocol
    (and the dashboard UI) reads idle as "task done", which it shouldn't.
    Fix is semantic: either gate the latch on terminal turn-end only,
    or redefine the supervisor's idle interpretation, or both.
  - **(B) Latch leak.** `IDLE_LATCH_TIMEOUT_MS = 30 min` should suppress
    re-latching working from Pipeline A or any non-chat source for 30
    min, but the cycling suggests something is clearing or bypassing
    the latch. Audit `forceWorking()` callers and verify no path resets
    the latch before the timeout expires.

  Recommended approach: instrument StatusMonitor with a debug log on
  every latch set/clear, run a multi-agent session, classify each
  transition by trigger (chat event kind, Pipeline A heuristic, manual
  force). That tells you which root cause it is in <30 minutes of
  observation.

---

## BUG-10: launch_agent auto-submit fails for very large initial prompts

- Component: src/main/supervisor/index.ts (sendInput / _doSendInput) + send-input-encoders.ts
- Severity: medium (silent — agent sits idle with the prompt unsent, supervisor thinks it launched cleanly)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §13 (to be added)
- Surfaced: 2026-05-17 launching `groupthink-duplicate-relay-investigation`
- Symptoms: Supervisor called `launch_agent` (Claude provider, Windows) with a ~3 KB multi-paragraph prompt. The dashboard accepted the call and reported "Sent initial prompt". The agent's terminal showed `[Pasted text #1 +46 lines]` with "paste again to expand" — i.e., the prompt was written into the input buffer as a bracketed paste but the trailing Enter never fired (or fired before the paste was fully ingested by Claude Code's input widget). Agent went to idle without processing. Supervisor had to issue a manual `send_keys_to_agent({key:'enter'})` to kick it off.
- Suspected root cause: race between the bracketed-paste sequence and the immediate `\r` follow-up. For multi-line / many-byte prompts, Claude Code's input handler may still be consuming the paste body when Enter arrives, so the Enter is either dropped or consumed mid-paste.
- Fix sketch:
  - **Option A — delay-based:** after writing the prompt body, insert a small delay (50–100 ms, scaling with payload size) before sending Enter. Cheap, low risk, won't catch every edge case.
  - **Option B — confirm-then-submit:** after writing the prompt, poll the agent's input-buffer state (or wait for a known-good signal that the paste is fully ingested), then send Enter. More robust, more plumbing.
  - **Option C — provider-aware paste end-marker:** end the bracketed paste with a sentinel that the receiver acks before we send Enter. Most robust, requires Claude Code cooperation.
- Workaround for now: when launching with a very long prompt, follow up with `send_keys_to_agent({key:'enter'})` after a couple seconds. Or split the launch into `launch_agent` (small prompt) + `send_message_to_agent` (the bulk).
- Note: this is **not** a regression of BUG-01 — that fix correctly added the Enter to the launch path. The bug is timing/race between the paste body and the Enter for large payloads.

---

## BUG-11: dashboard events interrupt the user's in-progress terminal input by auto-submitting

- Component: dashboard event bridge → supervisor input pane (likely src/main/api-server.ts or supervisor input handler)
- Severity: medium (UX-breaking — user's sentence gets truncated mid-typing and sent as input)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §14 (to be added)
- Surfaced: 2026-05-17 during this session (user typing a workflow-change message when a `[DASHBOARD EVENT]` arrived; user's partial sentence was submitted)
- Symptoms: When the user is actively typing a message into the supervisor's terminal AND a `[DASHBOARD EVENT]` message arrives from the dashboard, the event delivery includes (or triggers) an Enter that submits whatever the user had typed so far, regardless of completion. The user's partial sentence goes to Claude as a separate turn, then the dashboard event lands as another turn.
- Suspected root cause: dashboard event injection writes its payload to the supervisor's input buffer and presses Enter unconditionally — it does not check whether the supervisor (a) is mid-turn or (b) has user-typed bytes pending in its input buffer.
- Fix sketch (gated on a prerequisite):
  - **Prerequisite:** the supervisor itself must expose a reliable "user-is-typing / buffer-non-empty" signal, OR a "ready-for-event" status distinct from "idle". Today the supervisor's status flips per chat events (working↔idle, see BUG-09) but does not reflect "user has uncommitted bytes in input box."
  - **With that signal:** the dashboard event bridge defers event delivery while the supervisor's input buffer is non-empty (or while it has a "user typing" lock). Events queue and flush on the next safe boundary (buffer empty, last keystroke > N ms ago).
  - **Stopgap (no signal needed):** never auto-submit on event injection. Write the event text as a separate visible block above the user's input area, and let the user submit when ready. Loses the "supervisor sees it as a chat turn automatically" property but ends the interruption.
- Related: this couples to BUG-09 — fixing the supervisor's status semantics may unlock the cleanest fix here.

---

# Closed bugs (kept as history; delete entries here whenever you like)

- **2026-05-17** BUG-12: GroupThink relayed messages appeared duplicated in Codex's chat history because `emitSyntheticUserEcho` recorded a synthetic marker with the dashboard's unicode-rich text, but ConPTY flattened em-dashes / smart quotes / ellipsis to ASCII before codex's real `user-text` event landed — text-equality dedupe in `session-log-dispatcher.ts` saw two strings and let both through. Replaced text-equality with recency-only FIFO dedupe (oldest unconsumed marker within ±35s window consumes the real event regardless of payload). `SyntheticMarker` no longer stores text. +8 new tests covering em-dash, en-dash, smart apostrophe, ellipsis, multiple in-flight synthetics, synthetic-after-real edge case, window boundary. Investigation writeup at `plans/groupthink-duplicate-relay-investigation.md`. **Requires `npm run restart` to activate in the running dashboard.**

- **2026-05-17** BUG-08: Codex `launch_agent` inherited the saturated prior
  workspace session. Added `freshSession?: boolean` to `LaunchAgentInput`
  (`fresh_session` in MCP schema). Pure helper `shouldDiscoverCodexSession()`
  gates discovery. +4 tests. Commit f4e1a58. Gotcha §11.

- **2026-05-17** BUG-07: `read_agent_chat` could return stale data on
  resumed codex sessions. Root cause was NOT the role filter but
  `pollNow()` in `SessionLogDispatcher` being rate-limited to 5s per agent.
  `pollNow(agentId?)` now bypasses the `nextPollAt` gate and supports
  targeted single-agent polling. +2 dispatcher tests. Commit f4e1a58.
  Gotcha §10.

- **2026-05-17** BUG-06: GroupThink resume re-pasted existing turn-complete
  messages because `lastRelayedTs` initialized to 0. Added
  `seedLastRelayedTsFromChat()` to seed it from each planner's latest
  `turnComplete:true` message on resume. +new resume-no-replay.test.js.
  Commit f4e1a58. Gotcha §9.

- **2026-05-17** BUG-04: `discoverNewCodexSession`'s 10s post-launch poll
  often missed codex's `session_meta` flush. Generalized two existing
  inline fallback blocks (index.ts:930-942 / 1124-1136 from M2A commit
  17555fc) into `ensureCodexResumeSessionId()` helper + private
  `resolveCodexResumeSessionId(agent)` method. +4 tests. Commit f4e1a58.
  Gotcha §5.

- **2026-05-17** BUG-03: GroupThink `waitTurnComplete` had a 10-min
  hardcoded timeout. Exposed `--turn-timeout-ms` (default 600000ms) and
  made the stall clock reset while `agent.status === 'working'`. +new
  turn-timeout.test.js. Commit f4e1a58. Gotcha §4.

- **2026-05-17** BUG-02: `send_keys_to_agent` JSON `\r` escape decoding
  was flaky. Added `key` enum (`enter`, `shift-enter`, `esc`, `tab`,
  arrow keys, `backspace`, `ctrl-c`, `ctrl-d`, `space`) with
  provider+host-aware byte mapping via new `key-bytes.ts`. Raw `keys`
  kept as fallback. +20 tests. Commit f4e1a58. Gotcha §2.

- **2026-05-17** BUG-01: `launch_agent` didn't auto-submit its initial
  prompt. Added `submit` parameter (default true) with
  provider+host-aware Enter byte sequence via new `send-input-encoders.ts`.
  +12 encoder tests. Commit f4e1a58. Gotcha §1.

- **2026-05-16** BUG-05: Pipeline A status flapping (working→idle
  clusters). Fixed by agent-lifecycle hardening M2A — `StatusMonitor`
  turnLatch + Pipeline B chat-event-driven status. Commit 17555fc.
  Gotcha §7. (Note: a related but distinct cycling pattern surfaced
  2026-05-17 — see BUG-09 above.)

- **2026-05-15** BUG-X: `scripts/groupthink-v1.js` `parseArgs` `split('=')`
  truncated topics containing `=`. Fixed at lines 44-47 by replacing
  destructured `split('=')` with `indexOf('=')` + `slice`. Gotcha §3.
