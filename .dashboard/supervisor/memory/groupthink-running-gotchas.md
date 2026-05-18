# GroupThink Running — Gotchas Learned 2026-05-15

Compiled while running a GroupThink on the agent-lifecycle-hardening plan.
Things that bit me; future-supervisor should know.

## 1. `launch_agent`'s initial prompt sits un-submitted

(FIXED 2026-05-17, commit f4e1a58 — see BUG-01. `launch_agent` now sends
provider+host-aware Enter after the prompt unless `submit: false` is passed.)

`mcp__agent-dashboard__launch_agent` writes the prompt into the agent's input
buffer but does **not** press Enter. The agent shows the prompt text on screen,
status flaps `working`→`idle` a few times from launch redraws, but no model
turn fires. You'll get spurious `[DASHBOARD EVENT]` lines suggesting the agent
finished, then read its chat and find it empty.

**Fix:** after `launch_agent`, send a CR via `send_keys_to_agent` to submit.

```
mcp__agent-dashboard__send_keys_to_agent({
  agent_id: "<id>",
  keys: "<literal CR — see encoding note below>"
})
```

## 2. `send_keys_to_agent` JSON-escape encoding is flaky for `\r`

(FIXED 2026-05-17, commit f4e1a58 — see BUG-02. The tool now accepts a
`key` enum with provider+host-aware byte mapping. Raw `keys` kept as
fallback.)

Sending `"keys": "\r"` once came back as **"Sent 2 byte(s)"** with the literal
backslash-r appearing in the agent's input buffer. Sending the same call again
came back as **"Sent 1 byte(s)"** with a real CR. The difference: in the
working call the JSON value was the literal CR control character; in the broken
one it was the two-char escape sequence `\r` that didn't get interpreted.

**Workaround:** if your first Enter attempt prints `\r` literally on screen,
send 2 backspaces and retry. Easier: paste a literal CR character into the
`keys` value rather than typing the `\r` escape.

This is also documented as a behavior the tool description claims works but
in practice depends on JSON-encoding behavior at the tool boundary.

## 3. `scripts/groupthink-v1.js`'s parseArgs **had** a `split('=')` bug

(Fixed 2026-05-15 at lines 44-47 by replacing destructured `split('=')` with
`indexOf('=')` + `slice`.) The old code truncated any `--flag=value` whose
value contained a `=`. So topics with `>=200`, `stop_reason=end_turn`, URL
query strings, code snippets, etc. would silently lose everything past the
second `=`.

If a GroupThink agent comes back saying "topic was truncated mid-sentence,"
suspect this bug has regressed. Check `scripts/groupthink-v1.js:44` — should
use `indexOf`, not `split('=')`.

## 4. GroupThink's per-turn timeout is **10 minutes hardcoded**

(FIXED 2026-05-17, commit f4e1a58 — see BUG-03. `--turn-timeout-ms` CLI
flag (default 600000ms) is now exposed, and `waitTurnComplete` resets the
stall clock while `agent.status === 'working'`.)

`waitTurnComplete` gives each turn 10 min to produce a `turnComplete: true`
event. After that the script emits `orchestration.groupthink.stalled` even if
the agent is still actively producing output.

**Observed on 2026-05-15:** Codex Reviewer took 13.5 min for a complex
9-finding review. Script stalled at 10 min. The deliberation was healthy;
the script just gave up too soon. We resumed via `resume_hint` and the script
picked up the now-complete message on the next poll.

**Recovery:** when you receive `orchestration.groupthink.stalled` with
`reason: "timeout"` and turns=1, first check `read_agent_chat` on the
reviewer/lead — if there's a fresh `turnComplete: true` message, fire the
`resume_hint` command from the stall event. The script will see the message
on its first poll after resume.

**Meta:** this is itself an instance of the agent-lifecycle-detection bug
we're trying to fix. Heuristic timeout that doesn't consult ground-truth
signals (agent.status, fresh PTY activity, message ring buffer). Worth
mentioning to planners on relevant topics.

## 5. Codex `resumeSessionId` discovery is unreliable

(FIXED 2026-05-17, commit f4e1a58 — see BUG-04. Two existing inline
fallback blocks (M2A commit 17555fc) are now generalized into
`ensureCodexResumeSessionId()` + `resolveCodexResumeSessionId(agent)`. When
any op needs the sid and finds it null, recovery fires automatically.)

The dashboard runs a 10-second `discoverNewCodexSession` poll after launching
a Codex agent. If Codex doesn't flush `session_meta` in time (which is common),
`resumeSessionId` stays `null` on the agent record. Stall events show
`"sid": null` for affected Codex agents. Two consecutive GroupThink runs on
2026-05-15 both hit this for the Reviewer.

**Important nuance:** `sid: null` does **NOT** mean the chat is unreadable.
`read_agent_chat` has a fallback path that finds Codex output even without
the sid being persisted (messages come through with `sessionId: ""`). The
dashboard UI also shows the chat. So:

- "Codex sid is null" ≠ "we can't see Codex"
- It DOES mean the agent record needs a manual `recoverCodexResumeSessionId`
  call to support resume/fork/query — but for chat reads in the current
  session it works anyway.

**To fix the persisted record:** the recovery function exists at
`src/main/supervisor/index.ts:1129` but isn't auto-called. A PATCH on the
agent's `resumeSessionId` (find the newest matching rollout in
`~/.codex/sessions/` by cwd) gets it back.

## 6. Claude session quotas look like stalls

When the Anthropic account hits its 5-hour session quota, a Claude agent
emits a non-`turnComplete` message:

> "You've hit your limit · resets 3:20am (America/Los_Angeles)"

`waitTurnComplete` then times out because no real turn fires. Looks identical
to a "Codex too slow" stall except the Lead's chat shows the quota message
literally. The user often sees the warning earlier as a banner in their
own Claude Code session — e.g. "96% of session limit" in the worker's launch
log was the precursor.

**When you see a stall at turn 1, ALWAYS check the Lead's chat first.** If
it shows the quota message, you can't resume — you have to wait for reset
or switch the Lead provider to Codex/Gemini.

## 7. Agent status `working`→`idle` flaps under the Pipeline-A heuristic

(FIXED 2026-05-16, commit 17555fc — see BUG-05. Agent-lifecycle hardening
M2A added `StatusMonitor.turnLatch` Map and Pipeline B chat-event-driven
status so PTY-noise heuristics can no longer oscillate the state. A
distinct cycling pattern surfaced 2026-05-17 — see BUG-09.)

Live confirmation of the bug under investigation. A short worker fix
(reading one file + applying one Edit) produced **3** `working`→`idle`
events. These show up as triple-event `[DASHBOARD EVENT]` blocks in the
supervisor chat. The agent finished once, but PTY byte-silence detection
oscillated.

Treat clusters of identical status events as a single signal. Don't
re-read the agent N times — read once after the cluster settles.

## 8. Resume command pattern (memorize)

The `resume_hint` in stall events is exactly the original launch command
plus `--resume-lead-id=<id>` and `--resume-reviewer-id=<id>`. The script
re-attaches to live agents and continues the relay loop. **Make sure**
the parseArgs fix (gotcha 3) is in place — the resume_hint includes the
full topic with all its `=` characters.

Working invocation pattern (Bash, from workspace root):

```bash
cd /c/Users/turke/Projects/AgentDashboard && \
  RUN_ID="$(date +%Y%m%d%H%M%S)-$$" && \
  LOG="plans/.runs/groupthink-resume-${RUN_ID}.log" && \
  nohup node scripts/groupthink-v1.js \
    --workspaceId=<ws> \
    --supervisorId=<sup> \
    --resume-lead-id=<lead-agent-id> \
    --resume-reviewer-id=<reviewer-agent-id> \
    --leadProvider=claude --reviewerProvider=codex \
    --topic='<full topic, single-quoted>' \
    --planPath='plans/<filename>.md' \
    > "$LOG" 2>&1 &
```

## 9. GroupThink resume re-pastes existing turn-complete messages

(FIXED 2026-05-17, commit f4e1a58 — see BUG-06. Added
`seedLastRelayedTsFromChat()` to seed `lastRelayedTs[agentId]` from each
planner's latest `turnComplete:true` chat message on resume. Smoke test
at `scripts/groupthink-v1.resume-no-replay.test.js`.)

**The bug.** `scripts/groupthink-v1.js`'s relay loop maintains a
`lastRelayedTs[agentId]` map to know which turn-complete messages have
already been forwarded. When invoked with `--resume-lead-id` and
`--resume-reviewer-id`, the script fetches the existing agent records but
does **not** initialize `lastRelayedTs` from the most recent turn-complete
message in each agent's chat. So at Turn 1, the script sees the existing
turn-complete messages as fresh, and re-relays both directions:

- Lead's previous Draft → fed back into Reviewer as new input.
- Reviewer's previous critique → fed back into Lead as new input.

This kicks off two parallel new turns simultaneously. About 2 minutes later
(if Lead is fast) the script tries to relay Lead's new response to Reviewer,
but Reviewer is still chewing on the re-pasted Draft. The dashboard returns
**HTTP 409 ("Cannot send input to agent in 'working' state")** and the
script crashes with an unhandled error.

**Side-effects observed 2026-05-15:**
- Reviewer (Codex) burned its **entire** context window producing a
  near-duplicate critique of the re-pasted Draft.
- Lead produced a substantive v2 that the script never relayed.
- Plan-finalization required the supervisor to manually `send_message_to_agent`
  the approval to Lead, bypassing the script's termination contract.

**Recovery options when this fires:**

1. **Read `read_agent_chat` on Lead** — if Lead produced a fresh response
   to the re-relayed Reviewer critique, that's likely your v2 and you can
   manually approve/finalize via `send_message_to_agent`.
2. **Don't try to re-resume** — the same bug will fire again. Either
   accept what's there or fix the script first.
3. **Manual single-direction relay** — if you only need to forward one
   side (e.g., Lead's v2 → Reviewer for one more pass), do it directly
   with `send_message_to_agent` rather than restarting the script.

**The fix (when someone has time):** in the resume branch of
`scripts/groupthink-v1.js`, after `apiJson('GET', '/api/agents/<id>')`
for each planner, also fetch its chat (one message back is enough), find
the latest `turnComplete: true` message, and seed
`lastRelayedTs[agentId]` with that timestamp. Then the relay loop's first
iteration won't re-fire on already-seen content. Add a unit / smoke test
that resumes against two agents whose chats already contain turn-complete
messages and asserts no `sendInput` calls fire on Turn 1.

This is also a candidate ticket for the agent-lifecycle-hardening plan if
the dashboard maintainers want to formalize a "resume contract" for
orchestrations alongside the event-bridge work.

## 10. `read_agent_chat` with `role` filter can return stale data on resumed codex sessions

(FIXED 2026-05-17, commit f4e1a58 — see BUG-07. Root cause was NOT the
role filter (red herring) but `SessionLogDispatcher.pollNow()` being
rate-limited to 5s per agent — supervisor MCP calls don't subscribe, so
freshly-polled state could be up to 5s stale. `pollNow(agentId?)` now
bypasses the `nextPollAt` gate and supports targeted single-agent polling.
The "operational takeaway" below — cross-check with an unfiltered query —
is no longer necessary post-fix, but remains useful general advice.)

Observed 2026-05-16 running a one-shot codex pre-review of P0-02:

1. Launched codex agent, sent prompt via `send_message_to_agent`.
2. Codex went `working`, ran for 2m 28s, transitioned to `idle`. The
   dashboard event payload included `Worked for 2m 28s` — a strong
   positive signal that a real turn completed.
3. Called `read_agent_chat({ agent_id, role: 'assistant', limit: 3 })`
   to grab the response. Got three messages from **yesterday's**
   GroupThink Reviewer session. The new substantive review (today,
   timestamped just before the chat call) was NOT in the result set.
4. Concluded codex was context-saturated. Stopped the agent. Spawned a
   second codex agent. Stopped it too when it inherited the same
   on-disk session. Launched a Claude fallback reviewer.
5. Only later, when re-checking with `read_agent_chat({ agent_id, limit: 10 })`
   (no `role` filter), did the new review surface — first in the result
   set with today's timestamp.

**Two hypotheses for the staleness:**
- `role`-filtered queries may hit a different / cached code path than
  the unfiltered one.
- There may be a propagation lag between codex committing a turn to its
  on-disk session and the chat reader indexing the new role/timestamp
  pair.

Either way, the takeaway is operational:

**Don't trust a `role`-filtered chat read in isolation.** Cross-check
with an unfiltered query (or `read_agent_log`) before concluding the
agent failed. A "Worked for Nm Ns" terminal marker in a dashboard event
is much more reliable than a chat-reader miss as a signal the agent
actually responded.

## 11. Codex resume-session discovery is broader than gotcha #5 suggested

(FIXED 2026-05-17, commit f4e1a58 — see BUG-08. `launch_agent` now accepts
`fresh_session: true` (in MCP schema) / `freshSession: true` (in
`LaunchAgentInput`) to skip post-launch session discovery for codex. Pure
helper `shouldDiscoverCodexSession()` gates the discovery call.)

Same 2026-05-16 incident. After stopping the first codex agent, I called
`launch_agent({ provider: 'codex', ... })` for a fresh session. The new
agent immediately showed:

- `inputTokens: 394156`
- `contextPercentage: 100`
- `turnCount: 10`

before I had sent it a single prompt. It had auto-resumed the prior
codex session in this workspace. The dashboard's `launch_agent` tool
exposes no `resume: false` flag, so there is no clean way to force a
fresh-context codex from supervisor MCP today.

**Workarounds when this matters:**
- Launch in a different workspace (the workspace_id scopes session
  discovery).
- Use Claude or Gemini for the task instead.
- File a feature request on the dashboard to add `resume: false` to
  `launch_agent` arguments. This would be a small addition and would
  unlock cross-provider review patterns without the panic-spawn cycle.

## 12. agent.status cycles working↔idle within a single user turn (post-hardening)

Observed 2026-05-17 during the 7-bug fix sweep. With 5+ supervised worker
agents running in parallel, the supervisor received many "events while
you were busy" notifications that each listed `working → idle` transitions
for agents that were demonstrably still working on their first user prompt
(no new user messages had been sent). Examples:

- `bug-06-fix` idled at 8 turns then continued working to 35 turns to
  finish smoke-testing and post its patch summary.
- `bug-01-fix` idled while the terminal still showed "Osmosing… thinking".
- Multiple flap events fired during the same task with no intervening
  user input.

Initially mis-attributed to "running on pre-hardening" — but verified
otherwise:

- Electron process started 2026-05-17 15:56 PDT.
- Latest hardening commit (M4, `4093521`): 2026-05-16 16:41 PDT — ~23 h
  earlier.
- `dist/main/main/supervisor/status-monitor.js` contains the M2A
  `turnLatch` logic (12 references to `turnLatch` / `forceIdle` /
  `forceWaiting` / `IDLE_LATCH_TIMEOUT_MS` / `WAITING_LATCH_TIMEOUT_MS`).

So the running app DOES have M2A. The cycling is post-hardening behavior.
Two possible root causes — see BUG-09 for the investigation entry:

- **(A) Definitional mismatch.** `EventBridge.onChatEvents` may emit
  `turnComplete` on every assistant-message-with-tool-result boundary,
  not just "agent has nothing else to do". If so, the latch is doing
  exactly what it's coded to do — but supervisor and UI interpret idle
  as "task done", which it isn't yet.
- **(B) Latch leak.** `IDLE_LATCH_TIMEOUT_MS = 30 min` should suppress
  re-latching working from any non-chat source for 30 min, but something
  is clearing or bypassing the latch.

**Operational workaround until BUG-09 is fixed:** treat `working → idle`
events with skepticism within an active multi-agent task. Read the agent
log before concluding "done"; if the agent is still emitting tool calls
or thinking spinners, the idle is likely intermediate.
