# Codex reliability in GroupThink — deep-dive synthesis (2026-07-02)

Requested by Edward: "codex is the agent that seems to give the most issues during
groupthinks — deep dive into why, and how to improve codex experience/reliability."
Sources: memory (gotchas, open-bugs, codex-hook-trust), the exp/gt-handshake-pressure
experiment stack, and a fresh source audit of the codex machinery (Explore agent,
verified with file:line anchors). This file is the synthesis; treat as current as of
branch `exp/gt-handshake-pressure` post-`b1136f2` working tree.

## Root answer: codex isn't flakier as a MODEL — it's structurally harder to OBSERVE

Every recurring codex GroupThink failure traces to one of four provider asymmetries
vs Claude:

1. **No launch-time session id.** Claude accepts `--session-id` (authoritative, zero
   race). Codex's session must be *discovered* after launch (SQLite `state_5.sqlite`
   threads poll, 500ms × 35s window; filesystem fallback). Everything chat-shaped
   (UI chat pane, `read_agent_chat`, GroupThink's `waitTurnComplete`) hangs off that
   binding. Lost race = chat blackout while the turn is actually fine on disk.
   → bug family BUG-26 (concurrent cross-bind), BUG-28 (sid null blackout),
   BUG-29 (stale-prior inheritance), BUG-37 (GroupThink false-stall).
2. **Chat is GroupThink's source of truth.** `waitTurnComplete` polls the message
   stream's `turnComplete` (correct — codex status lags minutes); so a codex chat
   blackout = false timeout STALL with the review complete on disk, and resume
   re-stalls identically (BUG-37, still OPEN).
3. **Silent-think + status lag.** Codex accepts a big turn-1 prompt then reasons
   silently for tens of seconds (no stream, no status flip). Any fast-fail policy
   whose window is ~30s FALSE-STALLs healthy runs — measured crossover ≈32s in the
   2026-06-30 real-time F-F sweep; that's why V1 (recover-fallthrough) beat V2.
4. **Input delivery + hook trust are gated.** Windows codex needs VK_RETURN key
   events (boot can eat the Enter — BUG-27); turn-1 has NO synchronous submit
   confirmation because `usesSubmitConfirmation` requires a previously-observed
   UserPromptSubmit hook (`index.ts:4341`); codex re-gates hook trust on any config
   path/hash change (B8 — profile writer now seeds `[hooks.state]`, fixed 2026-06-03).

## What is ALREADY FIXED in source (much of it newer than open-bugs.md claims)

- **GroupThink runner hardened (groupthink-v2.ts):** V1 `recover-fallthrough` is the
  production default (2026-07-01) — confirmed handshake + evidence-gated Enter
  re-press (`confirmedSend`/`submitTookEffect`), kickoff relaunch budget (2), composite
  ts+hash highwater (T1), stale-plan archiving (T2), synth-R2 highwater + 30s
  plan-write grace (T4). Experiment: `experiments/groupthink-pressure-test/RESULTS-
  handshake-variants-2026-06-30.md` (16/16 + realtime sweep).
- **BUG-26** no longer silently cross-binds: 2+ SQL matches → `ambiguous` → decline
  to bind (fail-empty, not misattribute). Recovery excludes sibling-owned sids +
  freshness floor.
- **BUG-29** codex side fixed: `created_at >= launch` SQL floor + `selectFreshCodexRollouts`
  timestamp floor. (Gemini half — cwd-newest, no window — NOT verified fixed.)
- **BUG-28** fixed: `maybeRecoverCodexSid(agentId)` runs before `getMessages` in
  `api-server.ts:457`, plus a 60s background sid-recovery poll. BUT gated by
  `CODEX_DISCOVERY_GRACE_MS = 45_000` (`index.ts:2963`) — first 45s after launch an
  unbound codex agent's chat reads still return empty BY DESIGN (BUG-29 safety).
- **BUG-32** effectively addressed: PTY log + `.scrollback` persist across crash;
  `getAgentLog` falls back to disk.
- **BUG-10** fixed for hook-instrumented codex (turns 2+): synchronous confirm-and-
  retry keyed on UserPromptSubmit hook baseline + reactive `checkStartHookResend`.
- Codex turnComplete IS a real signal (rollout `task_complete` → marks assistant msg
  turnComplete, split-batch patch path) — but only while the reader is sid-bound.

## TOP REMAINING GAPS (ranked by leverage)

> **UPDATE 2026-07-03 — gaps 1–3 CLOSED.** The `plans/codex-groupthink-reliability-hardening.md`
> wave (WP0–WP4) landed on `exp/gt-handshake-pressure` and passed live acceptance (serial
> GroupThink w/ codex Reviewer, runId `a8d20853`: 3 codex review rounds relayed to approval, no
> stall, plan written). Remaining open: gaps 4–6 (all deferred to their own waves).

1. ~~**BUG-37 (OPEN, highest severity).**~~ **✅ FIXED (WP0–WP2, 2026-07-03).** Root cause was
   the in-process `DashboardClient.getMessages` bypassing the BUG-28 recovery hook the HTTP/IPC
   paths have — so the orchestrator's poll could never self-heal a codex chat blackout. WP0
   (`b4e5869`) fires `maybeRecoverCodexSid` unconditionally before the chat read; WP1 (`489d7d6`)
   adds the idle-at-deadline `recoverChatBinding` + bounded 15s re-poll before throwing; WP2
   (`5392e5f`) keeps a usable persisted highwater on resume so a turn completed during the stall
   is returned by the first `readNextMessage`. Live-confirmed via runId `a8d20853`.
2. ~~**45s chat-blind window** feeds #1.~~ **✅ ADDRESSED (WP3, `a429509`).** The known kickoff
   prompt is now threaded as `firstUserMessagePrefix` into codex discovery (enables the SQL
   tiebreaker). Per the deliberation verdict the **45s grace was deliberately NOT relaxed** —
   relaxing it reopens BUG-29 (identity-blind recovery pre-empting live discovery); WP4
   (`6cfb94d`) instead derives the grace from `DEFAULT_SQL_POLL_TIMEOUT_MS` so it can't drift
   below the discovery window.
3. ~~**Concurrent same-cwd codex launches with empty prefix can't positively bind.**~~
   **✅ ADDRESSED (WP3, `a429509`).** GroupThink now supplies a non-empty per-role kickoff
   prefix (512 chars, reaching past `Topic:` into run-specific material), and the discovery
   predicate is wildcard-safe (`substr(first_user_message,1,length(?))=?`), so two same-cwd
   same-role runs on different topics bind distinctly. Same-topic ties still covered by the
   `created_at` floor + ambiguous→decline.
4. **Structural kill-shot (bigger, DEFERRED to its own wave):** per-agent `CODEX_HOME` / cwd
   subdirs (zero-race discovery at the root) — entangles BUG-25 trust-list, auth cache, and
   scaffold layout; needs a characterization spike first. (Stdout-banner session-id parse is
   REJECTED for codex 0.133.0 — no session id in the boot banner; re-verify only if a future
   codex version changes it.)
5. **Codex turn-1 submit confirmation outside GroupThink (DEFERRED):** plain `launch_agent`
   kickoffs still rely on the reactive poller only (BUG-27 residual). Sketch: extend the
   no-hook-baseline case of `sendInputConfirmed` with rollout/status evidence as submit proof,
   à la `submitTookEffect` (`groupthink-v2.ts:272`).
6. BUG-33 (TUI placeholder leakage into logs) still open, cosmetic.

## Ops notes for me (supervisor)

- open-bugs.md annotated 2026-07-02: BUG-26/28/29/32 primary fixes verified IN SOURCE
  (uncommitted-or-recently-committed; live-app state depends on last `npm run restart`).
- **2026-07-03: BUG-37 FIXED and live-confirmed** (WP0–WP4 on `exp/gt-handshake-pressure`;
  runId `a8d20853`). The old manual-brokering route-around (on a serial codex-reviewer timeout
  stall, `read_agent_chat` the reviewer → relay to Lead → abort AFTER the write) is **no longer
  needed** for this failure mode, but keep it in the back pocket for any *unrelated* future stall.
- Before the next GroupThink with a codex member, confirm the running app was built
  after 2026-07-01 (V1 recovery default) — otherwise the kickoff drop protection is
  not live.
