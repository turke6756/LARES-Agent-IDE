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

> **⚠️ SOURCE-AUDIT ADDENDUM 2026-07-02** (see `codex-groupthink-reliability-deepdive-2026-07-02.md`):
> verified against current source — **BUG-26, BUG-28, BUG-29 (codex half), BUG-32 primary fixes have
> LANDED in source** (ambiguous→decline binding; `maybeRecoverCodexSid` before `getMessages` with a
> 45s grace; `created_at`/freshness floors; PTY log + `.scrollback` persistence). Entries kept below
> for mechanism detail until fixes are confirmed live + committed. **BUG-37 is FIXED — landed
> 2026-07-03** (WP0–WP4, commits `b4e5869`/`489d7d6`/`5392e5f`/`a429509`/`6cfb94d` on
> `exp/gt-handshake-pressure`) and confirmed live the same day (serial GroupThink w/ codex Reviewer,
> runId `a8d20853`: 3 codex review rounds discovered+read+relayed, no stall, plan written).
> BUG-27 is PARTIALLY fixed (turn-1 kickoff still has no synchronous submit confirmation outside
> groupthink-v2's own `confirmedSend` — the `launch_agent`-lane residual is deferred to its own wave);
> BUG-33 open.

## BUG-40: Status latch stays `working` ≥60s after a user/Esc interrupt — gated `send_message_to_agent` rejects (409) an agent whose transcript already shows the turn interrupted

- Component: StatusMonitor working/idle latch (`src/main/supervisor/status-monitor.ts`) × `send_message_to_agent` busy gate.
- Severity: medium — a supervisor cannot message a just-interrupted agent through the confirmed-send rail; workaround is raw `send_keys_to_agent` (typed text + enter), which skips the handshake/subscription machinery.
- Status: open — observed live 2026-07-05 ~19:36-19:39Z on worker `51a57eba`: Esc landed 19:36:35 (transcript `[Request interrupted by user]`, turnComplete:true, PTY tail "Interrupted"), yet three gated sends over the next ~90 s all 409'd "working"; raw send_keys at 19:39:03 delivered fine and the turn started normally.
- Hypothesis: the interrupt path emits no JSONL/PTY signal the monitor's idle heuristic recognizes (no assistant turn-complete record follows an interrupt), so the latch only flips on the next slow poll/timeout — or an interrupted turn never satisfies the idle-debounce precondition at all.
- Fix sketch: on a `[Request interrupted by user]` transcript record (or PTY interrupt marker), force the latch toward idle (or reset debounce so the next tick flips it); alternatively let the send gate treat interrupted-turn-complete as idle. Relevant to the BUG-39 fix too — the new post-note grace loop reads the same `isIdle` latch and would mis-wait on an interrupted author.

## BUG-39: Continuation watcher kills the note-author mid-turn ≤5s after brick commit — closing message, transcript tail, and in-flight session-subagents all destroyed

- Component: context-brick Inc 5 watcher (`src/main/supervisor/continuation-watcher.ts` step 3 commit-observation loop → `tryRelaunch`) × relaunch route gates (`src/main/api-server.ts` ~:1046) × `continuationRelaunch` step-2 `stopAgent` (`src/main/supervisor/index.ts:4067`).
- Severity: high — every continuation handoff truncates the predecessor's final turn; any session-internal background subagent (Agent-tool child) dies invisibly with it.
- Status: **fix landed in working tree 2026-07-05** (uncommitted — folds into the L0 brick commit) per `plans/continuation-handoff-graceful-kill-and-prestage.md` WP1+WP2, workers `51a57eba`→`bf4e6007`: post-note grace loop (`CONTINUATION_POST_NOTE_GRACE_MS`/`decidePostNoteProceed` in continuation-watcher.ts, both commit-loop and retry paths), server-side `continuation-self-busy` 409 gate, 2s stop-flush delay, plus WP2 successor pre-stage kickoff (seeded in `continuationRelaunch` AND boot-reconcile). Full supervisor chain green (EXIT=0). **Pending Edward's live acceptance at next `npm run restart`** (plan §7: author finishes closing message, transcript tail intact, successor self-orients, route 409s mid-turn). Fix-sketch item (b) — author defer affordance — is WP3, NOT built (Edward-gated). Caveat: the grace loop reads the same `isIdle` latch as BUG-40; an interrupted author could mis-wait until the 120s grace expiry. Originally observed live 2026-07-05 18:58Z on supervisor `3d43d492` (planning-surface). Timeline (all from evidence, not inference): 18:53:47 predecessor spawned session-subagent `l0-committer` (build+test gate); 18:58:15 note-request injected (attempt `6ae6f3f4`); 18:58:26 last transcript record (ToolSearch for save_continuation_brick); 18:58:53.495 brick row committed (tool, 4006 B); 18:58:58.214 relaunch killed the PTY — **4.7 s after commit, mid-turn**. Predecessor never wrote its closing message; the JSONL never even flushed the brick tool_use/tool_result lines (stopAgent raced the CLI transcript writer); the 5-min-old l0-committer subagent died silently, losing the L0 commit gate run.
- Mechanism, three stacked gaps: (1) the watcher's only wait after the note-request is brick-commit observation (poll 5 s) — commit is treated as kill-authorization AND kill-timing, but the author is by construction still mid-turn when the row appears; (2) neither the client `tryRelaunch` nor the server relaunch route re-checks *self* idle/turn-complete (route gates cover owned-busy / input-in-flight / awaiting-human / orchestration only — all about OTHER agents); (3) the owned-busy gate reads `getAgentsByOwner` (dashboard DB rows), so session-internal Agent-tool subagents are invisible to every gate — a supervisor that parks work in a background child looks fully idle.
- Fix sketch: (a) after observing the committed brick, wait for the author's turn to COMPLETE (status latch back to idle, e.g. same debounce ticks) with a bounded grace (say 60–120 s; on overrun proceed anyway — brick is committed, note freshness beats liveness), and add the matching self-idle check server-side in the relaunch route (409 `continuation-self-busy`); (b) give the author an explicit defer affordance in the note-request contract (e.g. `save_continuation_brick {defer:true}` or a veto tool → close attempt 'aborted' + backoff) so an agent that KNOWS it has invisible in-flight children can postpone the kill; (c) soften the kill: after turn-complete is observed, small fixed delay (~2 s) before `stopAgent` so the CLI flushes the transcript tail. (b) is the only real cover for session-subagent invisibility — the dashboard cannot see Agent-tool children from outside.

---

## BUG-38: Continuation relaunch swaps the PTY under a stable agent id but never rebinds the live terminal-attach layer — terminal view shows the retired (dead) session

- Component: context-brick Inc 4 continuation (`src/main/supervisor/index.ts` `continuationRelaunch`/`continuationLaunchTail`) × the live-terminal attach layer on BOTH sides: renderer `src/renderer/components/terminal/TerminalPanel.tsx` (module-level `terminalCache = Map<agentId,…>`, reattach guard `if (!cached.unsub)` at ~:166) and main `src/main/ipc-handlers.ts` `terminal:attach` (~:245, `if (activeListeners.has(agentId)) return {ok:true}` short-circuit; `activeListeners`/`attachedAgents` only cleared by the renderer-invoked `terminal:detach` at ~:267).
- Severity: high — the live terminal for a continued supervisor is unusable until a full app restart; only the PTY view is affected (chat/log/MCP ride the rebound readers and work).
- Status: **open** — observed live 2026-07-03 on `6cd9d367` (first successful in-the-wild continuation: 80%+ → fresh session `dbd72798…` at 31%, brick-driven self-orientation confirmed working). Double-clicking the agent re-mounts the retired session's dead xterm and takes no new output.
- Mechanism: `continuationRelaunch` kills the old PTY (`stopAgent`) and spawns a NEW PTY under the SAME dashboard agent id, correctly rebinding the log/chat/ring layer (`rebindAgent` → `agent-rebound` purges ring/context-stats/file_activities). But nothing tears down the LIVE terminal attach: (1) the renderer `terminalCache` still holds the old xterm + old IPC subscription, and the reattach path skips `window.api.terminal.attach()` because `cached.unsub` is still set (cleanup deliberately keeps it alive for scrollback); (2) main's `activeListeners.has(agentId)` is still true (no `terminal:detach` was invoked during continuation), so even a forced re-attach early-returns and never wires the new PTY's bridge. Net: the retired session's buffer is shown; new-session bytes never flow. A renderer reload alone does NOT fix it (main's `activeListeners` still short-circuits) — only a full app restart clears both.
- Fix sketch: piggyback the existing `agent-rebound` signal to tear down the live terminal attach for that agent id on both sides. Main: on `agent-rebound`/continuation run the `terminal:detach` cleanup (`removeAgentListener` + drop `activeListeners`/`attachedAgents`) so the next attach binds the fresh bridge. Renderer: subscribe to an `agent-rebound` IPC event → `terminalCache.get(id)?.terminal.dispose()` + `terminalCache.delete(id)` + force the mount effect to re-run so it re-attaches to the new PTY and pulls the freshly-purged ring buffer. Also audit the restart button (`restartAgent`) — same PTY-swap shape, likely the same latent bug. Full spec: `plans/context-brick-cross-session-continuity.md`.

---

## BUG-37: GroupThink serial `waitTurnComplete` false-stalls AND is un-resumable when the codex Reviewer finishes — same root cause as BUG-28 (codex chat-blackout), now in `groupthink-v2.ts`

- Component: `src/main/orchestration/groupthink-v2.ts:169-203` (`waitTurnComplete`) + the BUG-28 codex-sid-discovery / chat-read pipeline (`src/main/api-server.ts:150-158`, `src/main/supervisor/index.ts` `resolveCodexResumeSessionId`).
- Severity: high — silently breaks serial GroupThink whenever the codex Reviewer's discovery race is lost; the run stalls with `reason:timeout` despite a complete, high-quality review on disk, and the documented one-call resume re-stalls identically, so there is no in-band recovery.
- Status: **FIXED 2026-07-03** — WP0–WP4 of `plans/codex-groupthink-reliability-hardening.md` landed on `exp/gt-handshake-pressure` (commits `b4e5869` WP0 in-process chat-read recovery / `489d7d6` WP1 deadline recovery re-poll / `5392e5f` WP2 resume-seed guard / `a429509` WP3 kickoff-prefix threading + wildcard-safe `substr` discovery / `6cfb94d` WP4 grace anti-drift). All orchestration + supervisor unit suites green. **Live acceptance passed same day**: serial GroupThink w/ codex Reviewer, runId `a8d20853` — the codex Reviewer was discovered, its chat read, and its completed turn relayed across **3 review rounds** to approval; **no `orchestration.groupthink.stalled`**; plan written to `plans/dashboard-skill-observability-tools.md`. Originally reproduced 2026-06-17, runId `50a54895` (serial; Lead=claude `7078d8d3`, Reviewer=codex `8086b256`; topic = harden plans/detachable-file-tabs.md).
- Mechanism: `waitTurnComplete` (correctly, per its docstring) treats the message stream's `turnComplete` flag as source of truth and consults `agent.status` only to reset the stall clock while `working`. When BUG-28 strikes (codex `resumeSessionId` stays null → `/api/agents/<id>/messages?role=assistant` returns `[]` even though the rollout JSONL holds the full turn), `readNextMessage` returns null for the entire window; the Reviewer's status flips `working→idle` (turn genuinely done) so the stall clock is never reset; at the 600s deadline the `status==='idle'` branch throws `"Timeout waiting for <label> (<id>) to complete turn (agent.status=idle)"`. We confirmed the review WAS complete: `read_agent_chat(8086b256, role:'assistant')` returned a `turnComplete:true` 7-point critique — but only AFTER the stall (sid bound late). **Resume re-enters the same `waitTurnComplete` against the still-blacked-out (or already-emitted, non-"new") chat and stalls identically** — verified: a second `run_orchestration({resume_run_id})` produced a byte-identical stall.
- Reliable diagnostic signature: `orchestration.groupthink.stalled reason:"timeout" message:"...to complete turn (agent.status=idle)"` for a codex receiver that the dashboard event stream already showed flipping `working→idle`; `read_agent_chat` on that agent returns the full assistant turn (proving the work exists and the failure is read-path, not the model).
- Recovery that worked (Path-2 manual brokering): read the codex Reviewer's critique via `read_agent_chat`, `send_message_to_agent` it to the (idle) Lead with "write the FINAL plan to <planPath>", let the Lead finish, THEN `abort_orchestration(runId)` to release members (abort AFTER the write — abort cleans up member agents and would kill the Lead mid-write). Deliberation value fully preserved.
- Fix sketches → **all landed** (sketch N → WP; see resolution above):
  1. **[→ WP0, `b4e5869`]** Land BUG-28's primary fix on the in-process path: `maybeRecoverCodexSid(id)` unconditionally before `getChatService().getMessages` in `src/main/orchestration/dashboard-client.ts` (the orchestrator's poll loop bypassed the HTTP/IPC recovery hooks — root of the family). Highest leverage — fixed the family.
  2. **[→ WP1, `489d7d6`]** Belt-and-suspenders in `waitTurnComplete`: at the idle-at-deadline branch, one-shot `client.recoverChatBinding(id)` + bounded 15s re-poll (`RECOVERY_REPOLL_MS`) before throwing; message extended to `(agent.status=idle, post-recovery re-poll empty)` so post-fix stalls are distinguishable. Guarded by a `recoveryAttempted` boolean.
  3. **[→ WP2, `5392e5f`]** Resume robust to an already-completed turn: guard the resume-path highwater seed on a parsed, usable mark (`parseHighwater(...).ts`) — keep the persisted highwater instead of re-seeding from chat, so a Reviewer turn that completed during the stall satisfies the first `readNextMessage` with no idle special-casing.
  - Plus **WP3 (`a429509`)** thread the kickoff prompt into codex discovery as `firstUserMessagePrefix` (+ wildcard-safe `substr(first_user_message,1,length(?))=?` predicate) so concurrent same-cwd codex sessions bind to the right rollout, and **WP4 (`6cfb94d`)** derive `CODEX_DISCOVERY_GRACE_MS` from `DEFAULT_SQL_POLL_TIMEOUT_MS` (anti-drift).
- Related: BUG-28 (the underlying codex chat-blackout — this is the same root cause surfacing in the new in-dashboard orchestration path; the BUG-28 entry only covered the old `scripts/groupthink-v1.js`). Distinct from `groupthink-premature-stall-no-plan-written.md` (parallel-mode `no_plan_written`, a different early-check race).

---

## BUG-36: Site-access approval does not notify the requesting agent — agent silently downgrades to a worse tool, human's approval wasted

- Component: the §18 request-and-approve allowlist flow — the approve IPC that upserts a `browser_access_requests` pending row into `browser_access_rules` (browser allowlist backend, `src/main/browser/`). No event is emitted to the requesting agent on approval.
- Severity: medium — wastes the human's approval and degrades output quality; the agent has no way to learn the gate opened except to re-poll `browser_list_my_access_requests()` / retry navigation, which an agent that already decided "I'm blocked" won't do.
- Status: open — observed live 2026-06-17. Researcher `59276984` (Guerneville-hotel task) hit the agent-browsing gate, filed a request, the human approved in the UI (worked), but the researcher got no signal and fell back to WebFetch (which returns only JS-rendered empty shells for booking engines). It recovered native browsing only by later self-discovery, after burning ~80% of its context. (Note: while the agent is `working`, `send_message_to_agent` rejects with HANDSHAKE FAILED, so the supervisor cannot push the news mid-turn either.)
- Fix sketches:
  1. **Push a dashboard-style event to the requesting agent on approval** (analogous to the `[DASHBOARD EVENT]` lines supervisors receive): "User approved `<origin>` — retry now." Hook at the approve IPC where the pending row → `browser_access_rules` upsert happens; resolve the requesting agent id from the request row.
  2. Delivery flavor: inject a one-line system notice into the requesting agent's input buffer (provider-appropriate Enter), OR a structured harness-surfaced event the agent's loop reads.
  3. Pairs with a worker-brief convention: when blocked, request access and KEEP the native-browser plan; do not pre-emptively fall back to WebFetch.

---

## BUG-35: Native browser tools cannot drive JS date-picker / calendar widgets via the accessibility-tree refs

- Component: agent browser tooling — `browser_read_page` (a11y tree + numbered refs) + `browser_click(ref)` against React/JS booking-engine date pickers.
- Severity: medium — blocks a plausible headline use case (driving real hotel/flight/booking flows that gate availability behind a calendar). The researcher could not get Dawn Ranch / Google Hotels calendars to COMMIT a selected date: refs went stale/misfired, the calendar reopened, the "WHEN" field stayed "Add dates."
- Status: open — observed live 2026-06-17 (researcher `59276984`, then worked-around by v2 `96d4e462`). Workaround that succeeded: skip calendar clicks entirely and use date-in-URL query params (`?checkin=2026-06-27&checkout=2026-06-28`, Google Hotels date-scoped URLs, booking-engine URLs that accept date params) so the page loads already date-scoped.
- Fix sketches:
  1. Investigate why `browser_click(ref)` against these widgets doesn't register/commit (synthetic-event trust? ref staleness after the calendar re-renders? need a settle/re-read between clicks?).
  2. Consider a higher-level helper for date inputs (set value + dispatch input/change events) or document the date-in-URL-params pattern as the supported approach in the researcher brief.
  3. Lower urgency if booking-flow automation is not a target use case — but the date-in-URL workaround should be captured in researcher guidance regardless.

---

## BUG-34: Context stats use a hardcoded 200K window for 1M-context models — false "98% critical" alarms on healthy agents

- Component: context accounting — `get_context_stats` / context-threshold `[DASHBOARD EVENT]`s compute `contextPercentage` against `contextWindowMax: 200000` even when the agent runs a 1M-window model (e.g. Opus 4.8 with extended context; the worker's own Claude Code status line showed "Opus 4.8 (1M context)" while the dashboard reported "98% (196K/200K)").
- Severity: high — drove a real bad intervention 2026-06-06: supervisor stopped healthy worker `p1-hook-spool-impl` (63194e2b) mid-task at "98%" that was actually ~20% of the real window, losing 196K tokens of paged-in recon. Every 1M worker will trip the 80/90/95% event thresholds at one-fifth of its real usage, training supervisors on false alarms.
- Status: open — observed live 2026-06-06; recovery was `fork_agent` (resume + fork-session restored full history).
- Fix sketch: resolve `contextWindowMax` per-agent from the model actually in use rather than a constant — Claude Code exposes the model id in transcript/status; map known 1M models (or better, read the window from the provider's model metadata) and surface `contextWindowMax` honestly in `get_context_stats` and the threshold events. Until fixed, supervisors must sanity-check % against the agent's own status line before intervening (behavioral.md B-14).

---

## BUG-30: Supervisor cannot discover its own workspace_id — every workspace-scoped MCP tool requires an ID the supervisor is never given

- Component: sysprompt injection — `src/main/supervisor/index.ts:1597` (Windows) and `:1952` (WSL), both emit only `Workspace root: <path>`, never the ID. `list_agents` summary — `scripts/mcp-supervisor.js:596-609`, includes `workingDirectory` but drops `workspaceId` even though `a.workspaceId` is present in the API response. No `list_workspaces` tool exists in `mcp-supervisor.js`.
- Severity: high — `launch_agent`, `list_templates`, `list_teams`, `create_team` all `require: ['workspace_id', ...]` (`mcp-supervisor.js:357,370,381,409,493`), but the supervisor is told only its workspace *path*, not its ID, and has no tool to resolve path→ID. Reported workaround was grepping `.dashboard/launches.log` after 4 wrong guesses ("Workspace not found"). Blocks every Path-2 launch/team flow until the ID is found by hand.
- Status: open — reported 2026-05-29 by NEON_GIS workspace supervisor; root cause confirmed against code same day.
- Fix sketches (any one helps; first two are cheapest and complementary):
  1. **Inject the ID into the sysprompt.** At `index.ts:1597`/`:1952`, append `Workspace ID: <id>` next to the existing `Workspace root:` line. The launch path already has the agent's `workspaceId`. ~2 LOC each side.
  2. **Add `workspaceId` to `list_agents` output.** At `mcp-supervisor.js:602`, add `workspaceId: a.workspaceId` to the summary object — the field is already in the API payload. One line. Lets a supervisor read its own ID off any agent row (including itself).
  3. **Add a `list_workspaces` MCP tool** (id, name, path) backed by a `GET /api/workspaces` endpoint — most discoverable, slightly more work.
  4. **Let `launch_agent` accept a `working_directory`/path and resolve path→id server-side** when `workspace_id` is omitted. `working_directory` is already an accepted arg (`mcp-supervisor.js:352`); resolution would happen in the launch handler.
- Recommendation: ship (1)+(2) together — both trivial, cover sysprompt-read and list_agents-read paths. (3) is the clean long-term answer.

---

## BUG-31: Documented curl API fallback is unreachable from WSL — but the bind is fine; firewall/host-IP is the real cause

- Component: docs (`SUPERVISOR_AGENT_MD` in `src/shared/constants.ts`, "Fallback" section) + Windows networking. NOT `src/main/api-server.ts` — it already binds `0.0.0.0:24678` (`api-server.ts:68,76`), so the server is listening on all interfaces.
- Severity: medium — the documented WSL fallback (`http://127.0.0.1:24678`, or the resolv.conf gateway IP) is a dead end from inside WSL: `127.0.0.1` hits WSL's own loopback (connection refused), and the resolv.conf gateway (`10.255.255.254`) also failed for the reporter. Because the bind is already `0.0.0.0`, a rebind does NOT fix this — the inbound connection from WSL to the Windows host is almost certainly blocked by Windows Defender Firewall on port 24678, or the host IP differs under mirrored networking (where the correct address is the host's LAN IP / `$(hostname).local`, not the resolv.conf gateway).
- Status: open — reported 2026-05-29; bind verified correct against code same day. MCP tools were unaffected (the reporter used them); only the curl fallback is broken.
- Fix sketches:
  1. **Add a Windows Firewall inbound allow rule for TCP 24678** at app first-run (or document the manual `netsh advfirewall firewall add rule` command).
  2. **Fix the docs** to give the address that actually works from WSL — under mirrored networking that's `localhost`/`127.0.0.1` once the firewall allows it; under NAT it's the host's LAN IP, not the resolv.conf gateway. Add a one-liner the supervisor can run to discover the right host IP.
  3. Lowest priority since MCP tools are the primary interface and they work — this only matters when MCP is down.

---

## BUG-32: No post-mortem log after a Codex crash — `read_agent_log` returns empty, so a crashed codex agent is undiagnosable

- Component: PTY/log capture + crash cleanup path in `src/main/supervisor/` (log persistence on agent exit). Once codex crashes, its PTY/log is gone and `read_agent_log` returns empty.
- Severity: medium — defeats crash triage, which is an explicit supervisor responsibility ("crashed: read the log to diagnose"). The supervisor's CLAUDE.md tells it to read the log on a crash event, but for codex crashes there's nothing left to read. Compounds with BUG-26's "all 3 vanished from list_agents" crash-cascade (see BUG-26 fresh evidence below) — the agents that most need a post-mortem are exactly the ones whose logs disappear.
- Status: open — reported 2026-05-29 by NEON_GIS supervisor.
- Fix sketch: on agent exit/crash, persist the last N lines (e.g. last 200) of the PTY buffer to a durable side file (e.g. `.dashboard/workers/<provider>/<agentId>.crash.log` or a DB column) before cleanup tears down the PTY. `read_agent_log` should fall back to that snapshot when the live PTY is gone. Pairs with BUG-20's framebuffer-tail logic.

---

## BUG-33: Codex TUI placeholder hints leak into captured logs as if they were real prompts

- Component: log capture / `read_agent_log` rendering — codex's empty-input-box placeholder suggestions ("Run /review on my current changes", "Write tests for @filename") are surfaced in captured output as though they were real prompt content.
- Severity: low — cosmetic but caused a brief misdiagnosis (reporter mistook the placeholder text for an actual prompt). Same family as BUG-20 (TUI chrome leaking into the event preview).
- Status: open — reported 2026-05-29.
- Fix sketch: filter codex's known placeholder-suggestion lines from captured PTY output (blocklist the fixed suggestion strings, or detect the empty-box placeholder styling). Brittle to codex version changes; low priority.

---

## BUG-29: New Codex/Gemini agents inherit prior agents' chat history despite `freshSession: true` — same-cwd discovery binds to days-or-weeks-old prior sessions

- Component: `src/main/supervisor/log-readers/gemini-transcript-reader.ts:46-49` (cwd-match-newest with no time window) + `src/main/supervisor/session-id-discovery.ts:313-331` (codex discovery still runs on `freshSession=true` per BUG-26 trade-off, can bind to sessions older than the 2-day `RECENT_CWD_DISCOVERY_DAYS`).
- Severity: high — silently contaminates every same-cwd Codex/Gemini agent in a workspace that has ever hosted a prior agent of the same provider. Confirmed across `groupthink-v1.js` runs and the dashboard's `GET /api/agents/:id/messages` endpoint. Distinct from BUG-26 (concurrent same-minute cross-binding) and BUG-28 (discovery never resolves) — this is the *stale-prior* sibling.
- Status: open — reproduced four times 2026-05-26 in this workspace. Three failure modes: (1) Codex agent created `06:11:38Z` returned 5 chat messages from `2026-05-25T18:41Z` (an 11.5h-old prior GroupThink on an unrelated topic); (2) Codex agent created `06:26:47Z` after stashing all of yesterday's rollouts bound to `resumeSessionId: 019e5112-...` from `2026-05-22` (3 days, outside the documented 2-day window); (3) Gemini reviewer agent created `06:27:47Z` returned 8 chat messages from `2026-05-07` (19 days old, fits the docstring's "no window" admission). Claude+Claude is the only provider combo that launched clean in the same session; cause of immunity not investigated. Full repro, root-cause analysis, fix sketch, workaround, and file/line refs in `plans/bug-29-fresh-session-chat-inheritance.md`.
- Gotcha ref: groupthink-running-gotchas.md (add entry — same-cwd cross-provider GroupThink is currently unreliable; use Claude+Claude or manually verify chat is clean after launch).
- Fix sketch: two independent changes required. Fix 1 — gemini-transcript-reader: add mtime-vs-createdAt threshold check (refuse to bind to a JSONL with mtime older than `agent.createdAt - ε`). Fix 2 — codex discovery: tighten the SQLite path's tiebreaker to require the matched session's mtime within ε of launch; if no fresh session, leave `resumeSessionId` null and let BUG-28's lazy-recovery path (once fixed) handle re-binding when the new rollout appears. After both, `freshSession: true` once again means what the name implies; if it doesn't, the API field should be renamed.

---

## BUG-28: Codex `resumeSessionId` stays `null` after a lost discovery race — chat-read endpoint never triggers lazy recovery, so `CodexRolloutReader` never tails the rollout file and the structured chat stays empty even though the rollout JSONL has every assistant turn

- Component: `src/main/api-server.ts:150-158` (chat-messages endpoint) + `src/main/supervisor/index.ts:1647` (`resolveCodexResumeSessionId`, the existing lazy-recovery hook that this bug fails to invoke from the chat-read path).
- Severity: high — silent chat-blackout for any Codex agent whose post-launch discovery loses the 10-s session_meta race. Fully blocks `groupthink-v1.js` (and any future orchestration) when the Reviewer is Codex, because the script's relay loop polls `/api/agents/{id}/messages?limit=1&role=assistant` for `turnComplete: true` and that endpoint can't see what the rollout reader never ingested. PTY shows the assistant turn fine; the dashboard chat / MCP `read_agent_chat` / HTTP messages endpoint all return empty `assistant`-role arrays. Script stalls at the 10-min per-turn cap and exits code 2.
- Status: open — reproduced 2026-05-25 in this workspace's GroupThink run on the supervisor-scaffold-promote-workflow topic. Reviewer agent `76b7bc6b-90d0-4a3d-8a33-c9a222e7f068` (codex), launched via `scripts/groupthink-v1.js:387` with `freshSession: true`, completed its review (Worked for 1m 52s, visible in PTY), wrote the full turn to `~/.codex/sessions/2026/05/25/rollout-2026-05-25T11-37-53-019e606d-dbea-7053-a09f-96cc1d965fd5.jsonl`, but `read_agent_chat(agent_id, role:'assistant')` returned `[]`. Manual JSONL extraction recovered the review; the script could not.
- Reliable diagnostic signature:
  - Agent record has `provider: 'codex'` and `resumeSessionId: null` (visible in `GET /api/agents/<id>` JSON).
  - Same agent's PTY log contains a `Worked for Nm Ns` terminal marker — Codex's canonical post-turn fingerprint, so we know the model turn completed.
  - The agent's rollout JSONL exists in `~/.codex/sessions/YYYY/MM/DD/` with mtime after launch, containing an `assistant`-role event with substantive content.
  - `GET /api/agents/<id>/messages?limit=1&role=assistant` returns `messages: []`.
  - `GET /api/agents/<id>/messages?limit=5` (no role filter) returns relayed `user` messages with `sessionId: ""` (relay-injected) but zero assistant rows.
- Mechanism:
  1. **Launch.** `scripts/groupthink-v1.js:387` POSTs `/api/agents` with `provider: 'codex'`, `freshSession: true`. This goes to `AgentSupervisor.launchAgent` in `src/main/supervisor/index.ts:525` — the same code path as `mcp__agent-dashboard__launch_agent`. There is no GroupThink-specific launch logic.
  2. **Post-BUG-26 discovery runs anyway.** `shouldDiscoverCodexSession({ provider:'codex', resume:false, freshSession:true })` at `src/main/supervisor/session-id-discovery.ts:332-336` returns `true` (BUG-26 explicitly stopped freshSession from skipping discovery). `captureCodexSessionId` (`src/main/supervisor/index.ts:1655`) fires the ~10-s poll for the new session.
  3. **Race lost.** Codex sometimes flushes `session_meta` later than the 10-s window (older known race, gotcha #5). When the poll times out without a match, the agent record's `resumeSessionId` stays `null`. The rollout file gets written normally — it just isn't bound to the agent.
  4. **`CodexRolloutReader` requires the sid.** The reader's `SessionLogReader.register(new CodexRolloutReader())` (`src/main/supervisor/index.ts:418`) tails files keyed by `sessionId`. With `sessionId: null` on the agent record, the reader has no file to tail — the rollout JSONL sits on disk untouched by the chat pipeline.
  5. **Lazy recovery exists but is never invoked here.** `resolveCodexResumeSessionId` (`src/main/supervisor/index.ts:1647-1653`) is the self-healing hook: it checks `getAgent(id)?.resumeSessionId`, and if null, calls `recoverCodexResumeSessionId` (`:1618-1636`) which scans `~/.codex/sessions/` by cwd, finds the matching rollout, calls `updateAgentResumeSessionId(agent.id, sessionId)`, then crucially `this.sessionLogReader.rebindAgent(agent.id)` — at which point the reader attaches to the file and emits all the pent-up chat events. This works perfectly **when something calls it.** Today the only callers are operations that need the sid to construct a CLI command — `resume`, `fork`, `query`. The chat-messages endpoint (`src/main/api-server.ts:156`) does not call it.
  6. **GroupThink polls chat, not sid-using ops.** `scripts/groupthink-v1.js:251-256`'s `readNextMessage` calls `GET /api/agents/<id>/messages?limit=1&role=assistant` every ~2 s. None of these reads invoke `resolveCodexResumeSessionId`. So no matter how many times the script polls — and no matter how long it waits — the sid stays null, the reader stays unbound, and the chat stays empty. The 10-min `waitTurnComplete` cap fires, the script emits `orchestration.groupthink.stalled` with `reason: 'timeout'`.
- Why this is distinct from BUG-26: BUG-26 is about *cross-binding* under concurrent same-cwd codex launches (N agents, N-1 shift in chat attribution). BUG-28 is about *no binding at all* for a single codex agent whose discovery race lost. BUG-26's Path A fix (extending SQL `threads`-poll from 10 s → 35 s) would also reduce BUG-28's incidence — if discovery wins more often, the race is lost less often. But Path A doesn't *eliminate* BUG-28: codex can still flush late or the dashboard can be killed mid-window. Once the race is lost under any fix, the chat-read endpoint must still know how to self-heal. The two bugs are complementary, not duplicates.
- Why it doesn't reliably surface in single-agent MCP launches: a manual `mcp__agent-dashboard__launch_agent` for one codex agent leaves the system uncontested — Codex usually flushes `session_meta` well within the 10-s window because there's no concurrent launch noise. GroupThink launches Lead + Reviewer back-to-back and immediately starts message relay, increasing the chance the race loses on the Reviewer specifically. Same code path, looser race-handling under load.
- Affected workflows: every Codex agent whose discovery missed at launch, with consumers that read structured chat. Highest blast radius today: `scripts/groupthink-v1.js` with `--reviewerProvider=codex` (the default). Also affects the dashboard UI's chat pane for the same agent — it polls the same endpoint. The PTY view in the dashboard is unaffected because PTY rendering is byte-level streaming, independent of session-id resolution.
- Workaround (manual, supervisor-side): when a Codex agent shows `resumeSessionId: null` and chat is empty but PTY has content, the supervisor can force recovery by triggering a sid-using op. Cheapest is `mcp__agent-dashboard__fork_agent({agent_id})` and immediately `stop_agent` the fork — the fork attempt reads the sid, fires `resolveCodexResumeSessionId`, rebinds the reader, and the pent-up chat events flow on the next dispatcher poll. Ugly but doesn't require code changes. For GroupThink runs, do this before the 10-min stall cap fires and the script's next poll will pick up the message naturally. **Important note:** this workaround is theoretical-but-untested as of 2026-05-25; the supervisor reading this should verify before relying on it in a live recovery. **CORRECTION 2026-05-29: the fork lever is INVALID for codex — `fork_agent` returns "Fork is only supported for Claude agents."** Tested live during a GroupThink v2 parallel run (codex planner `f9743867`): chat returned `[]` while the rollout JSONL had the full turn; `get_context_stats` did not trigger recovery either; `fork_agent` was rejected. With no MCP-exposed sid-consuming op for codex, there is currently **no in-band recovery** for a codex chat-blackout. Practical salvage that worked: (1) locate the agent's rollout at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (newest mtime matching launch time), (2) extract the assistant turn directly from the JSONL, (3) relay it onward manually. This makes the BUG-28 *primary fix* (auto-recover sid on chat-read) more urgent — it is the only thing that would make codex chat self-heal, since none of the manual levers are reachable for codex.
- Fix sketches:
  - **Primary — auto-recover sid on chat-read.** In `src/main/api-server.ts:150-158`, before `getChatService().getMessages(agentId, ...)`, add a single call: `this.supervisor.maybeRecoverCodexSid(agentId)`. Implement `maybeRecoverCodexSid(agentId: string): void` as a new public method on `AgentSupervisor` that: (a) looks up the agent, (b) returns early if `provider !== 'codex'`, (c) returns early if `resumeSessionId` is set, (d) calls the existing private `resolveCodexResumeSessionId(agent)`. Cost: ~6 production LOC + one regression test (launch codex without sid, write rollout file by hand into `~/.codex/sessions/`, hit messages endpoint, assert sid is populated and chat returns the assistant turn). No new public surface for the recovery logic itself — the new method just wraps and exposes the existing private one for the API layer. This is the smallest, cleanest fix and it makes every future GroupThink Codex-Reviewer self-heal on the script's first poll.
  - **Secondary — also recover on `getContextStats` and any other agent-read endpoint.** Same shape as primary, applied wherever the supervisor reads agent state via the API. Belt-and-suspenders: a UI tab that opens to the agent's stats view (no chat poll) would also trigger recovery. Optional, ships after primary if useful.
  - **Tertiary — fs.watch the sessions dir instead of polling.** Replace `captureCodexSessionId`'s 10-s poll with an `fs.watch` on `~/.codex/sessions/<date>/` that binds the sid on first matching `session_meta`-bearing file, with a 60-s safety timeout. Eliminates the race itself instead of recovering from it. Bigger change; layer on top of primary if/when BUG-26's Path A doesn't fully close the timing gap.
- Related:
  - BUG-26 (Path A in flight 2026-05-25) — extends SQL `threads`-poll from 10 s → 35 s. Reduces BUG-28's incidence but doesn't fix it. Ship both.
  - Gotcha #5 (`groupthink-running-gotchas.md`) — original observation that Codex discovery is flaky and chat is unreadable even though dashboard event stream still fires. The "fixed 2026-05-17" tag on that gotcha refers to BUG-04 — adding `resolveCodexResumeSessionId` for sid-using callers. BUG-28 is the chat-read caller that the 2026-05-17 fix didn't cover. The gotcha should be updated to flag this remaining gap.
  - BUG-10 — paste-then-Enter race on `send_message_to_agent`. Different bug; same family of "input-side timing race" issues with Codex.

---

## BUG-27: Codex launch-Enter race on Windows — prompt text lands in input buffer but the submit-Enter byte gets eaten by the booting TUI

- Component: `src/main/supervisor/index.ts` (`launch_agent` post-launch prompt+Enter sequence on Windows) + codex TUI boot timing.
- Severity: medium — intermittent under load (~1 in 4 in the 2026-05-23 8-agent batch). When it hits, the agent looks `working` forever from the supervisor's view (no turn happens → no Stop hook → no `working → idle` event), but the agent is actually sitting at its `›` prompt with the prompt text already typed, waiting for Enter that already came and went.
- Status: open — reproduced 2026-05-23 on Windows.
- Surfaced: 2026-05-23. 8-agent sanity test (4 Claude + 4 Codex) launched in parallel via `mcp__agent-dashboard__launch_agent`. Three codex workers processed their prompts cleanly. The fourth, Test Codex 2 (`7af6b0a0`), sat in `working` indefinitely. PTY log showed `› Name a primary color. Reply with one word.` — the prompt text was bracketed-pasted into the input box, but the trailing Enter never registered. Sending a manual `send_keys_to_agent(key: 'enter')` to the agent immediately unstuck it and the Stop hook fired normally on completion.
- Reliable diagnostic signature: codex agent status stuck `working` shortly after launch; PTY log shows the prompt text visible in the input box at the `›` prompt with no `•` response line below it; chat shows only the user message with no assistant message. Manual `send_keys_to_agent(<id>, key: 'enter')` recovers immediately.
- Mechanism (suspected): Windows-only. `launch_agent` calls `runner.launch()`, then writes the prompt to the PTY via bracketed paste, then sends the provider-appropriate Enter (`VK_RETURN` down+up on Windows for codex). If the codex TUI has not yet bound its keystroke handler to the input widget when those bytes arrive (the boxed `OpenAI Codex (v0.133.0)` banner repaint is still in progress), the paste bytes get buffered into the input field but the Enter event is dropped — there's no input handler attached to consume it yet. By the time codex's input loop binds, the Enter has already flown past and only the text remains. Claude doesn't show this on the same hardware (4/4 Claude workers in the same batch worked) because Claude submits via plain `\r` written to the PTY rather than a Win32 VK key event — `\r` lands in the PTY's pending-input buffer and gets processed when the handler binds. Codex's VK-style synthetic key delivery on Windows has no equivalent buffering.
- Affected workflows: parallel-launch codex workers on Windows. Sequential launches are less affected because each TUI has uncontested CPU/IO to finish booting before the next prompt arrives.
- Workaround: after launching codex on Windows, watch for status stuck `working` with empty assistant chat. Send `send_keys_to_agent(<id>, key: 'enter')` to recover. Or launch with `submit: false` and re-send Enter explicitly after a delay.
- Fix sketches:
  - **Primary — wallclock launch-settle gate before submitting the prompt.** Hold the prompt+Enter send until `runner.launch()` has had ≥ `LAUNCH_SETTLE_TIMEOUT_MS` (provider-specific; codex needs longer than Claude on Windows) OR an authoritative "TUI input-ready" signal has arrived. Pairs naturally with the BUG-23 launch-settle timer Claude Explorer already designed.
  - **Secondary — read-back verification.** After sending the prompt+Enter, scan PTY output for the codex `• <user>` echo of the prompt. If not seen within ~3s, re-send Enter (just the key, not the prompt — the text is already in the input box). Catches the dropped-Enter case without depending on a wallclock estimate.
  - **Tertiary — switch codex's Enter delivery from VK to byte stream on Windows.** If we can get codex's input loop to accept a buffered byte sequence the way Claude does (write `\r` or `\n` to the PTY), the boot-time race disappears. Risk: codex on Windows may strictly require the VK delivery for normal key events; needs investigation.
- Related: same family as the launch-settle window discussion (the prior BUG-23 deliberation between Claude Explorer + Codex Explorer). That work was framed as Claude-supervised-worker stuck-`working`; this is the codex-parallel-launch stuck-`working` cousin. A single wallclock launch-settle fix covers both.

---

## BUG-26: Concurrent codex launches in the same cwd cross-bind rollout files → assistant responses attributed to the wrong agent

- Component: `src/main/supervisor/index.ts` — `captureCodexSessionId` (filesystem-polling session discovery) interacting with `src/main/supervisor/log-readers/codex-rollout-reader.ts` (which surfaces chat from whichever rollout file the agent record points to).
- Severity: high — silent data corruption in the chat history. A response from agent A shows up in agent B's `read_agent_chat`, and agent A's chat looks empty. The dashboard event stream still fires (each hook fires from the correct process), so the **status path** stays correct — but every consumer that reads chat content (the dashboard UI, the supervisor's `read_agent_chat` workflow, downstream orchestrations) gets misattributed text. Especially dangerous for orchestrations that route an agent's output to another agent based on chat reads.
- Status: open — surfaced 2026-05-23 on Windows.
- Surfaced: 2026-05-23. 8-agent sanity test (4 Claude + 4 Codex) launched in parallel. Claude side passed cleanly (each worker's chat had its own answer). Codex side: 3/4 codex workers had their answers correctly attributed; 1/4 (Test Codex 2, `7af6b0a0`, prompt "Name a primary color") had an empty assistant chat — its actual response "Red" landed in Test Codex 4's chat (`a3b2d425`, prompt "Spell 'agent' backwards"), which then showed *two* assistant messages: its own legitimate "tnega" at 16:52:30 and Codex 2's stray "Red" at 16:53:16. Both codex agents fired their Stop hooks correctly (`working → idle` events arrived for both agent IDs), but the chat persistence layer attributed Codex 2's rollout entries to Codex 4's record.
- Reliable diagnostic signature: launch ≥ 2 codex workers concurrently into the same cwd, send distinct prompts. After both turns complete, one or more agent records will show either an empty assistant chat or an assistant message whose content doesn't match the user prompt in that same chat record. The agents' Stop hooks will have fired correctly (status flips happened) — the divergence is chat-only.
- Mechanism (symptom): codex writes its session rollout to `<cwd>/.codex/sessions/<timestamp>-<uuid>.jsonl`. The dashboard's `captureCodexSessionId` polls the directory after `runner.launch()` returns and binds the agent record to the rollout file it finds (newest-mtime). With N codex workers spawning into the same cwd in the same poll window, the file-discovery races: agent A's record can end up pointing at agent B's rollout file, and vice versa. The rollout-reader then surfaces B's turns as A's chat. The hook POST is unaffected because it carries the dashboard's own `AGENT_ID` from env — independent of the rollout file binding.
- Proposed cause (architectural): codex doesn't expose a launch-time `--session-id <uuid>` flag the way Claude does, so the dashboard can't *assign* a session-id at launch — it must *discover* one. Today's discovery is filesystem-polling, which is correct only when each codex process is the unique writer to its cwd at that moment. Codex DOES print session metadata to its own stdout at boot (visible in the PTY log as the boxed `OpenAI Codex (v0.133.0)` banner plus subsequent rollout-file path messages); parsing that stream would give an unambiguous per-process session-id with no race window. The current code doesn't do that.
- Affected workflows: any orchestration or test that launches multiple codex workers concurrently into the supervised codex worker dir (`.dashboard/workers/codex`) — which is what `launch_agent(provider: 'codex')` does today by default. Sequential codex launches are probably safe because each launch sees only the one new rollout file when it polls. The bug becomes severe under fan-out workloads: GroupThink-style multi-codex deliberation, parallel test batches, any "spin N codex workers" pattern. Same risk on Windows and WSL — the mechanism is filesystem-discovery, not Win32-specific.
- Workaround (immediate):
  - **Launch codex workers sequentially**, waiting for each to settle before launching the next. Adds latency but avoids the race.
  - **Give each codex worker its own cwd subdirectory** — pass `working_directory: '<workspace>/.dashboard/workers/codex/<agentId>'` to `launch_agent`. The cwd is then unique per worker, the rollout files don't compete. Cost: per-worker scaffold dir, and the codex trust-list entry from BUG-25 needs to cover each subdir (or the parent, if codex's trust walks up).
- Fix sketches:
  - **Primary — capture the session-id from codex's own stdout (eliminates the filesystem-polling discovery).** Tee the PTY output during the boot window, scan for the rollout-file path line that codex prints (format roughly `… sessions/<timestamp>-<uuid>.jsonl …`), extract the UUID. Use that as the authoritative session-id binding. Zero race regardless of how many workers share a cwd. Implementation: add a stdout-scan helper in `windows-runner.ts` (and `wsl-runner.ts` for parity) that fires a `Promise<sessionId>` on first match, with a short timeout that falls back to today's polling discovery so we don't break workers on codex versions that change the banner format. This is the structural fix.
  - **Secondary — per-agent cwd subdirectory by default.** Have `launch_agent(provider: 'codex')` auto-mint a `<workers/codex>/<agentId>/` subdir as the cwd. Each worker gets its own `.codex/sessions/` namespace; no file competition. Cheap, requires no codex CLI changes, but multiplies the trust-list entries codex needs (BUG-25 fix expands to "trust the parent dir and let codex walk up," which may or may not be how codex's project-trust walk works — needs verification).
  - **Tertiary — lock-based serialization at the supervisor.** Take a per-cwd lock around the codex launch + discovery window so only one launch is racing at a time. Removes the bug but caps codex concurrency at 1 per cwd, which is bad for orchestrations.
- Related: BUG-25 is in the same codex-scaffold neighborhood but addresses a different gate (trust list). BUG-27 (launch-Enter race) was reproduced in the same test batch but is mechanistically unrelated. Note: this bug does NOT affect Claude — Claude's CLI accepts `--session-id <uuid>` at launch so the dashboard injects an authoritative session-id with zero discovery race.

### Fresh evidence 2026-05-24 — pattern is strictly N → (N-1) shift with three user-visible signatures, and the first agent is the off-by-one origin

Reproduction: 6 codex workers launched into NEON_GIS workspace (`d09349ca-7a62-4094-af69-1940066f5a8c`) `.dashboard/workers/codex/` cwd, near-simultaneously, distinct prompts. All 6 PTYs received their correct prompts and rendered their correct responses (verified by reading `read_agent_log` — input routing is unaffected, the prompt-write path uses the dashboard's own agent record and PTY handle, not the rollout binding). Damage is confined entirely to chat-history readback.

The shift is **strictly N → N-1 in launch order**, never random, with three concrete observable symptoms:

1. **Each non-first agent's chat shows three messages instead of two.** Expected `user → assistant`. Actual `user(own) → assistant(prior agent's) → user(prior agent's)`. The dashboard chat UI renders this as **two user bubbles with an assistant bubble in between** — the "user message appears twice" symptom the human reports.

2. **The first agent has empty `sessionId` and zero assistant messages in chat.** Test-1's `read_agent_chat` returned exactly `[{role:'user', content:<own prompt>, sessionId:''}]`. No assistant message ever attaches, because Test-1's rollout never gets discovered — by the time `captureCodexSessionId` polls, codex has not yet flushed the rollout file for the first concurrent launch, so polling either picks up an older session or times out. This is the off-by-one origin: Test-1 fails to bind to its own rollout, then every subsequent launch's polling picks up the *previous* launch's rollout (now on disk) instead of its own, cascading the shift through the chain.

3. **Each non-first agent's `sessionId` matches the prior agent's actual rollout UUID, not its own.** Verified by inspecting `sessionId` field per agent — Test-2's `sessionId` is the UUID of Test-1's rollout file, Test-3's is Test-2's, etc. This is the smoking-gun fingerprint when debugging: cross-reference any agent's `read_agent_chat` `sessionId` with the rollout files on disk at `~/.codex/sessions/<date>/` and the binding is unambiguous.

Concrete data from this run (titles abbreviated):

| # | Title | Own prompt (verified in PTY log) | Chat `sessionId` field | `assistant` content in chat | `user` content(s) in chat |
|---|---|---|---|---|---|
| 1 | Math | "What is 17*23?" | `""` (empty) | — (none) | own prompt only |
| 2 | Capital | "capital of Australia?" | `019e5c83-7c68-...` (= Test-1's rollout) | "391" (Test-1's answer) | own prompt + Test-1's prompt |
| 3 | Haiku | "haiku about a cat" | `019e5c83-e315-...` (= Test-2's rollout) | "Canberra" (Test-2's answer) | own prompt + Test-2's prompt |
| 4 | Color | "primary color?" | `019e5c84-4658-...` (= Test-3's rollout) | "Silent paws..." (Test-3's haiku) | own prompt + Test-3's prompt |

Implications for the proposed primary fix (stdout-banner-parse for session-id): this evidence strengthens the primary fix because the secondary fix (per-agent cwd subdir) would only solve the cross-binding by *preventing* the race entirely via filesystem isolation, but it doesn't address why polling-discovery is fragile in the first place. The primary fix is the structural one — codex prints its own session-id at boot; reading it directly is race-free regardless of cwd policy.

Implications for the **fallback path** if the stdout-banner-parse times out: today's fallback is filesystem polling, which is exactly what's broken. A safer fallback during transition would be to leave `sessionId` empty (as it does for Test-1 today) rather than silently bind to whatever happens to be newest in the dir. Empty binding fails loudly (no chat at all for that agent) instead of silently corrupting the chain. Worth considering in implementation.

Tested workaround: the secondary fix from the original sketch (per-agent cwd subdir via `working_directory: '<workspace>/.dashboard/workers/codex/<agentId>'`) was not tested in this run because we wanted to reproduce the unsegregated default behavior. The chain reproduces 100% reliably under default settings.

User-visible severity update: the original "one or more agent records will show either an empty assistant chat" understates the damage. Every non-first concurrent codex agent's chat is corrupted in a specific predictable way (own user msg + leaked prior chat). For supervisors or downstream orchestrations that branch on chat content, this means **every chat-read decision against a concurrent codex worker except the first is wrong** — not just intermittent attribution noise.

### Correction 2026-05-25 — the original "stdout banner contains rollout path" sketch is FALSE for codex 0.133.0

The Primary Fix sketch above ("capture the session-id from codex's own stdout … format roughly `… sessions/<timestamp>-<uuid>.jsonl …`") is based on intel that no longer holds — possibly never did for current codex. Verified by inspecting actual codex 0.133.0 PTY logs today (`dba41bd6.log`, `02524272.log`, `04a61a8f.log`). The boot banner contains ONLY:

```
╭────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.133.0)                             │
│ model:       gpt-5.5 high   /model to change           │
│ directory:   ~\Projects\AgentDashboard\…\workers\codex │
│ permissions: YOLO mode                                 │
╰────────────────────────────────────────────────────────╯
```

No `sessions/` line. No rollout path. No UUID anywhere in the first 30 KB of stdout (grep `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` returned zero matches). The session-id only leaks to stdout at session **end** as `To continue this session, run codex resume <uuid>` — far too late for launch-time binding. `codex --help` (v0.133.0) exposes no flag to inject or print a session-id at boot.

**Implication for fix planning:** The stdout-banner-parse approach (Path C as discussed today) is **dead** unless codex's CLI changes. Two supervisors independently planned around the old intel before this was verified — be aware when reading older planning artifacts.

**The actual structural options that remain:**
- **Path A (chosen 2026-05-25):** Extend SQL `threads`-table poll timeout from 10s → 35s so the codex-deferred INSERT (lands ~25-26s after launch) is caught by the primary path. Pair with fail-loud-empty filesystem fallback (return null instead of misbinding when no usable prefix filter exists). Smallest delta, cost is ~25s slower codex launches.
- **Path B (deferred):** Per-agent `CODEX_HOME` env at launch — each agent's `~/.codex/sessions/` namespace is unique, race eliminated by construction. Requires investigating BUG-25 trust-list interaction and codex auth-state cache transfer. Better structural fix; not yet characterized.
- **Path C (dead):** Stdout-banner-parse — premise invalid per above. Do not pursue without re-verifying the banner format on a future codex version.

### Fresh evidence 2026-05-29 (NEON_GIS) — plus a possible crash-cascade facet

NEON_GIS supervisor launched 3 codex agents (trivial prompts) into the shared `.dashboard/workers/codex` cwd. Reproduced the core BUG-26 signature (two agents even shared the SAME session id `019e755a-edaa-7dd1-...`). **New facet not previously captured:** crash/cleanup appeared entangled — one agent crashed twice at launch (race), another crashed *after* going idle, and then **all 3 vanished from `list_agents`** as if a crash in one cascaded into sibling teardown. Worth investigating whether shared-cwd codex agents share any cleanup/lifecycle state that lets one crash evict the others. Also note `freshSession: true` mints a fresh conversation but does NOT isolate the directory, so rollout/session files still collide — consistent with the BUG-26 Path-B (per-agent `CODEX_HOME`) recommendation. The undiagnosable-after-crash half of this report is tracked separately as BUG-32.

---

## BUG-25: Codex Stop hook scaffold is written but never loaded — workspace not in `~/.codex/config.toml` trusted_projects, so Codex skips the hook entirely

- Component: scaffold side — `src/main/supervisor/index.ts` `ensureWorkerScaffold(..., 'codex', ...)` writes the per-workspace hook config but doesn't register the workspace as trusted in the user's global codex config. Constant lives at `src/shared/constants.ts:430–442` (`WORKER_CODEX_CONFIG_TOML`).
- Severity: high — every supervised codex worker silently runs WITHOUT its Stop hook. Class IV degrades to Class I–III (PTY inference), which for codex's `›`-with-placeholder idle repaint apparently doesn't promote. Net effect: codex workers answer correctly but sit in `working` forever, breaking `launch_agent`'s 60s poll-for-idle and rejecting `send_message_to_agent`.
- Status: **fixed in code 2026-06-04, pending live verify** — `launchAgent` now calls `ensureProviderDirTrust(workDir, agentCwd, provider, pathType)` (src/main/supervisor/index.ts) on every launch (all lanes, including legacy root-cwd like GroupThink), which append-merges `[projects.'<path>'] trust_level = "trusted"` into `~/.codex/config.toml` for the workspace root + agent cwd (Windows: exact-case, lowercase, AND `\\?\` variants — codex 0.136 rejected a lowercase-only entry, verified live in UAP_Phenomina 2026-06-04) and seeds `hasTrustDialogAccepted: true` into `~/.claude.json` projects for Claude (WSL branches included). Unit tests: src/main/supervisor/provider-dir-trust.test.ts. Verify by launching a codex worker in a brand-new workspace: no trust banner in the boot log + Stop hook fires; then delete this entry.
- Surfaced: 2026-05-22. Smoke test in parallel: Claude side (`5b78e2ec`) passed cleanly (Stop hook fired, idle event arrived, 1 turn). Codex side (`a3255c65`) answered correctly in chat (`turnComplete: true` at 19:04:19 with the right product 391) but status remained `working` until manually force-idled via POST. Re-surfaced 2026-06-04 in fresh workspace UAP_Phenomina: codex at the (untrusted, non-git) workspace root died silently at kickoff; supervisor manually added trust entries to recover.
- Smoking gun in the codex PTY log header:
  ```
  1. C:\Users\turke\Projects\AgentDashboard\.dashboard\workers\codex\.codex
     To load project-local config, hooks, and exec policies, add c:\users\turke\projects\agentdashboard
     as a trusted project in C:\Users\turke\.codex\config.toml.
  ```
  Codex prints this verbatim on every launch in an untrusted project and **skips loading** the project-local `.codex/config.toml`. Our `[[hooks.Stop]]` block goes unread, the `dashboard-status.mjs` POST never runs, status falls back to PTY inference.
- Reliable diagnostic signature: agent boot log contains the literal `"To load project-local config, hooks, and exec policies, add ... as a trusted project"` line. If that line is present, the Stop hook is being skipped — confirms BUG-25 vs other status-promotion failure modes.
- Mechanism: the scaffold (`ensureWorkerScaffold` in `src/main/supervisor/index.ts`) writes `<workspace>/.dashboard/workers/codex/.codex/config.toml` with the materialized hook command. That part works. But Codex's security model gates loading any project-local config/hooks/exec-policies behind a per-user trust list in `~/.codex/config.toml`. The scaffolder never edits that file, so the per-user trust is missing, and Codex silently no-ops the hook. The chat-side `turnComplete: true` flag comes from a completely separate path — the rollout-file reader (`codex-rollout-reader.ts`) — which doesn't depend on hooks and reflects the rollout truth. That's why chat and status diverge.
- Affected workflows: every supervised codex worker in every workspace. Pre-existing trusted projects (e.g. via prior `codex login` interactions or manual config edits) would not see this bug, which is why it may have hidden in past testing.
- Workaround (immediate, manual):
  - Add the workspace path to `~/.codex/config.toml`:
    ```toml
    [projects."C:/Users/turke/Projects/AgentDashboard"]
    trust_level = "trusted"
    ```
    (Schema per https://developers.openai.com/codex/config — the project key is the absolute path with forward slashes.) Restart the codex worker. The header line disappears, the Stop hook loads, status flows.
  - Supervisor-side fallback while bug is open: treat codex `working` as untrustworthy; poll `read_agent_chat(<id>, role:'assistant', limit:1)` and watch for `turnComplete: true`, then `POST /api/agents/<id>/status {"state":"idle","source":"hook-fallback"}` to unstick.
- Fix sketches:
  - **Primary — scaffold also writes to `~/.codex/config.toml`.** Extend `ensureWorkerScaffold(..., 'codex', ...)` to atomically merge a `[projects."<abs path>"] trust_level = "trusted"` block into the user's global codex config. Use a TOML library (don't string-concat) and write idempotently: if the project key already exists, leave it; only add if missing. Surface a one-line console log on first write so the user sees what happened. **Risk: editing user-global config without consent.** Mitigation: gate behind a supervisor confirmation the first time a workspace gets a codex worker, OR document the trust requirement and emit a clear diagnostic instead of silently editing user-global state. The latter is more conservative; the former is more "it just works."
  - **Alternative — supervisor detects the untrusted-project banner and surfaces it.** Have the supervisor watch the agent boot log for the literal "To load project-local config, hooks, and exec policies, add ... as a trusted project" string; on match, fire a `waiting_for_input`-style event to the user explaining what to add to `~/.codex/config.toml` and why. No user-global state changes; user does the trust-list edit themselves. Loses zero-touch UX but avoids editing the user's global codex config without consent.
  - **Belt-and-suspenders — also wire codex-rollout-reader's `turnComplete: true` into `statusMonitor.forceIdleFromHook`.** Even with the trust list fixed, the rollout-driven signal is a strictly better idle source than PTY inference for codex (it's the actual event stream from the runtime, not a TUI-shape heuristic). Doing this would make codex status correct even if a future user has a trusted-list mishap.
- Related: BUG-23 (launch-settle stuck-`launching`) is the launch-side equivalent of Class IV depending on a single signal. BUG-25 is the *configuration* failure mode — the hook exists in scaffold-land but is config-gated out at runtime, which is invisible without reading the boot log. Architectural lesson: scaffold correctness must include verifying the runtime actually loads the scaffold, not just that the file was written.
- Smoke-test artifacts:
  - Claude side (passing baseline): `5b78e2ec-3819-448f-aec5-48d7fc175d46` — chat returned the expected two lines, `list_agents` showed `idle` / 1 turn / 3%, Stop hook POST visible in dashboard logs.
  - Codex side (failing): `a3255c65-cee8-43c6-b5d8-23ff510d262f` — chat has the correct answer at `turnComplete: true`, status stuck `working`, boot log contains the trust-project banner, no hook POST ever arrived at `/api/agents/.../status`.

---

## BUG-22: WSL supervisor first-launch tmux session dies before PTY attach (`can't find session`)

- Component: `src/main/supervisor/wsl-runner.ts` (`tmuxNewSession` → `spawnPtyHost` boundary) + `src/main/supervisor/wsl-bridge.ts` (`tmuxNewSession` escaping)
- Severity: medium-high — every fresh supervisor launch in WSL crashes on attempt #1. Today the crash is obscured because BUG-21 amplifies it into a 5x "No conversation found" restart loop that misattributes the failure. Once BUG-21 ships, BUG-22 becomes the clean visible signal.
- Status: open — diagnosis incomplete (multiple candidate causes); needs diagnostic logging before fix
- Surfaced: 2026-05-21. User opened a new WSL workspace `/home/turke/GIS_Analysis/NEON_GIS_CrestedButte_Analysis`, supervisor scaffold succeeded (`.dashboard/supervisor/{.claude,memory,scripts}` + `.sysprompt-<id>.txt` all written), but the supervisor pane exited immediately. Agents `2e11bfc6` and `ba789143` both reproduce. Worker `fc94409d` (non-supervised Claude) in the same workspace launched fine — so the bug is supervisor-launch-specific (the wrap path with `--add-dir` + `--append-system-prompt`), not a general WSL breakage.
- Reliable diagnostic signature: first bytes of the agent log are `can't find session: cad__supervisor__<8-char>` followed by `[exited]`. Event timeline shows exit code 1 on attempt #1 (this bug) followed by exit code 137 on every subsequent restart (BUG-21 cascade).
- Mechanism: `wsl-runner.ts:81–87` calls `tmuxNewSession` and **swallows failures with a stale comment** ("Continue anyway — we'll run directly in PTY"). `spawnPtyHost` then unconditionally executes `wsl.exe bash -lc "tmux attach -t '<session>'"`. If the tmux session created by `tmuxNewSession` is already dead by the time `tmux attach` runs (a few hundred ms later), `tmux attach` fails with `can't find session` and exit code 1. The swallowing path makes the underlying tmux failure invisible.
- Three candidate causes (need diagnostic logging to discriminate):
  - **`ccode` venv activation in detached pane.** Pane runs `bash -lic '<wrap>'`. Wrap calls `ccode` → `source ~/.venvs/claude-env/bin/activate && claude ...`. If `source` errors silently in a non-interactive subshell (or `activate` prints to stderr triggering some trap), `ccode` could `return` early. Without `claude` actually running, the bash command chain completes and the pane exits — killing the tmux session.
  - **Quoting bug in `tmuxNewSession` escape pass.** The supervisor wrap contains `$(cat '...')`, embedded `"..."`, many `'...'`-paths, and the new bash command-prefix env-var sequence post-fix-A. The single-quote-escape at `wsl-bridge.ts:284` (`command.replace(/'/g, "'\\''")`) is *probably* fine but unproven for this specific wrap.
  - **Session-creation race.** `tmux new-session -d` returns 0 as soon as tmux **forks** the pane process, not when the pane is stable. If the pane process exits within the few hundred ms between session creation and the PTY-side `tmux attach`, the attach fails.
- Affected workflows: every supervisor launch in WSL. Non-supervised Claude workers (no `--add-dir`, no `--append-system-prompt`) appear unaffected — the wrap path with sysprompt + cat-substitutions is the trigger surface. Class IV supervised workers may also hit this (same wrap path); not yet observed because the user hasn't launched one in WSL post-fix.
- Workaround: blocked by BUG-21. Until BUG-21 ships, the cascade obscures BUG-22's real signal. Post-BUG-21, the workaround is "launch the supervisor twice" — attempt #1 will still die with `can't find session`, but the dashboard's restart machinery (no longer poisoned) should now have a fighting chance on attempt #2 if the race is the cause. The two non-race candidates (venv activation, quoting) will still need a real fix.
- Fix sketches:
  - **Step 1 — diagnostic logging (mandatory first).** Capture `tmuxNewSession`'s stderr in the agent log header rather than `console.error`-and-swallow at `wsl-runner.ts:84`. Pipe the fully-rendered `command` string from `launchWslAgent:1391` to a side log file in the workspace (e.g., `.dashboard/launches.log`) so we can see exactly what the failing first-attempt wrap looked like. Emit a `tmux_new_session_failed` event when the session creation fails. Without this, every candidate cause stays speculative.
  - **Step 2 — pick the targeted fix based on the diagnostic signal.** If venv-activation-in-detached-pane: harden `ccode` (make it tolerate non-interactive activation) or stop using `ccode` for supervisor launches (call `claude` directly with the venv path). If quoting bug: fix the escape pass in `wsl-bridge.ts:284`. If race: poll-until-session-exists in `tmuxNewSession` before returning, or move the attach to use a created-session marker.
  - **Step 3 — fix the stale comment** at `wsl-runner.ts:85`. The fallback path doesn't actually "run directly in PTY"; it still tmux-attaches and fails. The comment hides the bug.
- Related: BUG-21 (cascading restart) — must ship first so BUG-22 shows its real signal. The WSL launch env/exec fix landed 2026-05-21 (commit pending) — verified non-supervised worker launches work; this bug is the supervisor-path remainder.
- Investigation agent: `6c0b29c4` ("wsl") delivered the diagnosis 2026-05-21 (worker started the day on the env/exec fix; same worker did this round of analysis). Their writeup is in the chat history; key candidate-cause framing above is taken from their `## Diagnosis` block.

---

## BUG-21: Auto-restart poisons itself with never-saved Claude session-id (cascading "No conversation found" loop)

- Component: `src/main/supervisor/index.ts` — `launchAgent` (DB pre-population at 535–540), `launchWslAgent` (resume branch ~1279), `launchWindowsAgent` (resume branch ~1030), `handleAutoRestart` (~1438), `restartAgent` (~1731), `reconcile` (~2178)
- Severity: high — converts every first-launch failure into a 5x restart cascade that **misattributes the root cause** (every restart prints `No conversation found with session ID: <uuid>`, which looks like a session-tracking bug instead of the underlying first-launch failure). Cross-platform in code; visible only on WSL today because Windows first-launches don't currently crash.
- Status: **in-progress** (2026-05-21) — wsl worker `6c0b29c4` implementing **Option 1** (validate session file before `--resume`, fall back to fresh-launch behavior if missing). Mirror in both WSL and Windows resume branches.
- Surfaced: 2026-05-21. WSL supervisor launches in `/home/turke/GIS_Analysis/NEON_GIS_CrestedButte_Analysis` reproduce reliably — agents `2e11bfc6` and `ba789143` both show identical event timelines (1× exit 1, 5× exit 137 `No conversation found`, then restart-limit-reached). DB inspection confirmed: agent `2e11bfc6`'s `resume_session_id` is `9be13d4d-7ac8-4ef6-af6e-443b73567868`, byte-identical to the UUID Claude reports it can't find.
- Mechanism: `launchAgent:535–540` runs **before** any launch attempt and pre-populates `resume_session_id` with a fresh UUID:
  ```ts
  if (provider === 'claude') {
    sessionId = uuidv4();
    updateAgentResumeSessionId(agent.id, sessionId);   // ← baked in BEFORE launch
    this.sessionLogReader.invalidatePath(agent.id);
  }
  ```
  If the launch then crashes before Claude writes its session JSONL to disk, the DB still has the UUID. All three restart paths (`handleAutoRestart`, `restartAgent`, `reconcile`) call `launchWslAgent(latest, true)` or `launchWindowsAgent(latest, true)` with `resume=true`. The WSL resume branch at line 1279 (and the Windows mirror around 1030) blindly trusts `latest.resumeSessionId` and emits `--resume <uuid>`. Claude can't find the conversation, fails with the canonical `No conversation found` error, exits 137. The DB still has the same bad UUID, so the next restart picks it up and repeats — until restart-limit-reached.
- Affected workflows: every Claude launch where attempt #1 crashes before Claude flushes its JSONL. Currently the only known repro is WSL supervisor launches (via BUG-22's first-crash). Windows is a **latent landmine** — currently dormant because Windows first-launches don't crash, but any future Windows regression that crashes attempt #1 would inherit the same cascade.
- Reliable diagnostic signature: event timeline shows exit code 1 on attempt #1 followed by 5× exit code 137 with `No conversation found with session ID: <uuid>` in the pane log; DB inspection shows `resume_session_id` matches the UUID Claude is failing to find.
- Workaround for now: stop the crashed agent + manually clear `resume_session_id` from the DB row (`sqlite3 <db-path> "UPDATE agents SET resume_session_id=NULL WHERE id='<agent-id>'"`), then relaunch. Or: disable `autoRestartEnabled` on the agent before launch so the cascade doesn't fire (one bad launch only, no loop).
- Fix sketches:
  - **Option 1 (in progress).** Validate session file before emitting `--resume`. At the WSL and Windows resume branches, call a helper `sessionFileExists(agentId, sessionId): boolean` (or pass the session-id through `sessionLogReader.findSessionFile`). If the file doesn't exist: clear the stale `resumeSessionId` from the DB, generate a new UUID, persist it, invalidate the session-log-reader cache, and emit `--session-id <newUuid>` instead of `--resume`. Log a `console.warn` on the fall-back path so the supervisor can spot it. Scoped: WSL branch + Windows branch + shared validation helper + 2 regression tests. ~30 prod LOC + ~80 test LOC.
  - **Option 2 (deferred, cleaner long-term).** Don't pre-populate `resume_session_id` in `launchAgent` at all. Make the field a *post-condition* of a successful launch — populate it from the session-log-reader once Claude has actually written the JSONL (mirror Codex's `captureCodexSessionId` pattern at line 1183–1203). The resume branch becomes correct-by-construction. Bigger refactor; correct architecturally but riskier today. Defer until the in-flight inference-disable + Plan 2 + BUG-20 + BUG-21 stack ships.
- Related:
  - BUG-22 — the first-launch crash on WSL is what currently triggers BUG-21's cascade. The two are independent bugs; BUG-21 amplifies BUG-22 into a misleading error. Fix BUG-21 first to **stop hiding** BUG-22.
  - BUG-09 launch-seed fix (closed 2026-05-19, commit `906ad7b9`) — established the launch-window `working` semantics. BUG-21 is the resume-side counterpart to that fix: pre-population of a session-id before launch success is the same anti-pattern.
- Investigation agent: `6c0b29c4` ("wsl") — same agent that did the env/exec fix earlier today. Two-bug diagnosis (BUG-21 + BUG-22) delivered 2026-05-21 ~20:17 UTC.

---

## BUG-20: `[DASHBOARD EVENT]` "Last output" preview shows TUI chrome instead of the agent's last assistant message

- Component: `src/main/supervisor/event-payload-builder.ts` (`formatLogTail`)
- Severity: medium — supervisor cannot triage idle events from the event message alone; every event requires a follow-up `read_agent_chat` call, multiplying tokens and latency on what should be a one-shot decision.
- Status: **fix delivered, pending verification + commit** (2026-05-21)
- Surfaced: 2026-05-21 during Class IV worker-hook scaffold smoke test (agent `51dce3e5`). Two consecutive `working → idle` events delivered "Last output" blocks containing only Claude Code TUI footer paint (`Opus 4.7 (1M context) | C:\...\.dashboard\workers\claude | Style: de…`, the horizontal rule, `⏵⏵ bypass permissions on (shift+tab to cycle)`, `paste again to expand`, `…running stop hook · 6s · ↓325 tokens)`). Zero bytes of the agent's actual final message reached the preview. Real message was only visible via `read_agent_chat`.
- Mechanism: `formatLogTail` (`event-payload-builder.ts:38-55`) strips ANSI escapes per line, then takes the last 5 non-empty lines. Claude Code's TUI footer (status bar, permission ribbon, spinner / hook indicator, info hints) is rendered in plain Unicode — the strip pass doesn't touch it, the non-empty filter doesn't drop it, and these lines are *always* the last lines drawn in the framebuffer. The assistant's message text — emitted earlier and scrolled above the prompt — never makes it into the 5-line slice. This is the explicit leftover scope from the BUG-13 closure note ("TUI footer text fragments … still leak through formatLogTail because they're plain Unicode, not escape sequences").
- Reliable diagnostic signature: every `[DASHBOARD EVENT] Agent status changed` "Last output:" block consists of footer chrome (`Opus … | … | Style:`, `⏵⏵ bypass`, `(shift+tab to cycle)`, `running stop hook`, framebuffer rules); `read_agent_chat(agent_id, role:'assistant', limit:1)` for the same agent returns substantive prose that does NOT appear in the event payload.
- Affected workflows: **every supervisor idle-event triage**, because every Claude worker leaves TUI chrome at the bottom of the PTY. Class IV workers make it worse — their CLAUDE.md design assumes the supervisor reads the worker's final-message question from the event preview, which today the supervisor cannot do.
- Fix sketches:
  - **Option A — chat-first preview.** Replace `formatLogTail`'s PTY-frame slice with the agent's last assistant message text (truncated). For `status_change` to `idle`, read the most recent `role:'assistant'` chat record (the same source `read_agent_chat` uses) and format that as "Last output:". Falls back to today's logTail only if no assistant chat is available (Codex/Gemini early bootstrap, crash events). Cleanest semantics — the supervisor wants the agent's words, not the terminal chrome.
  - **Option B — TUI-chrome blocklist in `formatLogTail`.** Match and drop lines whose stripped form matches known TUI footer shapes: `^Opus \d+\.\d+ \(.+\) \| .+ \| Style:`, `^⏵⏵`, `\(shift\+tab to cycle\)`, `running stop hook`, `paste again to expand`, the box-drawing rule character class. Brittle (every Claude Code TUI revision is a new line), keeps the PTY-tail mental model, but doesn't require chat-API reads from inside the event pipeline.
  - **Option C — slice from above the prompt marker.** Find the last `❯ ` (prompt glyph) in the strip-cleaned tail and take the 5 lines *before* it, not after. Works only when the prompt is in the frame; doesn't handle the "agent in mid-response" case.
- Workaround for now: supervisor must call `read_agent_chat(agent_id, role:'assistant', limit:1)` after every `working → idle` event before deciding next action. This is already in the supervisor's CLAUDE.md "Automatic Events / idle/done" guidance — confirming today that the workaround is mandatory, not optional.
- Related: BUG-13 closed 2026-05-19 — Path B Change 2 strip-ANSI-per-line landed in `formatLogTail:47-51`. The closure note explicitly defers this TUI-chrome class to a future fix; this is that fix.

### Fix in progress (2026-05-21)

Worker **`7f3797ad-b60e-43db-bbf5-38c9909609e3`** ("BUG-20 Event Payload Fix") delivered the chat-first preview + `Files touched:` extension. Build clean + tests green at the worker's hand (15% context, 104 turns, 9m 22s wall time). **Not yet user-reviewed. Not yet restarted into running dashboard. Not yet live-verified.**

**What the worker changed (per their patch summary):**

- `src/main/supervisor/event-payload-builder.ts` — Added `lastAssistantMessage` and `filesTouched` fields to `SupervisorEvent`. New helpers: `formatChatPreview` (10-line / 800-char cap, ellipsis on overflow), `formatFilesTouched` (10-entry cap, `> … (N more)` overflow marker), `consolidatedHint` (80-char snippet for digest mode). `buildEventPayload` `status_change` branch now prefers `formatChatPreview` over `formatLogTail`, falling back when the chat preview is empty. `formatFilesTouched` appended after the output block. `buildConsolidatedPayload` appends ` — "<hint>"` per-event line when `lastAssistantMessage` is present.
- `src/main/supervisor/event-bridge.ts` — Two new `EventBridgeDeps`: `getLastAssistantMessage(agentId)` + `getFileActivities(agentId)`. In `onStatusChanged`, for terminal statuses (`idle`/`done`/`crashed`) the bridge pre-fetches both via private safe wrappers `fetchLastAssistantMessage` / `fetchFileActivities` (try/catch + console.error, return `undefined` on error so the builder degrades to today's `logTail`).
- `src/main/supervisor/index.ts` — Added `getFileActivities` to database imports. Wired the new bridge deps in `AgentSupervisor.bridgeDeps`: `getLastAssistantMessage` → `this.chatService.getMessages(id, { limit: 1, role: 'assistant' })[0]?.content`; `getFileActivities` → thin wrapper over the database module.
- `src/main/supervisor/test-helpers/fake-bridge-deps.ts` — Stubs for the two new deps + one-shot error setters.
- `src/main/supervisor/event-bridge.integration.test.ts` — Wired the two new harness deps (per-agent maps).

**Tests added (per the worker):** 11 new unit tests in `event-payload-builder.test.ts` (chat-first preview, fallback when empty/undefined/whitespace, line+char truncation caps, filesTouched rendering, omission when empty, 10-entry cap with overflow, ordering, consolidated digest hint + 80-char cap) + 2 integration scenarios in `event-bridge.integration.test.ts` (`single_idle_chatFirstPreview_BUG_20`, `single_idle_fallbackOnChatError_BUG_20`).

**Open question the worker flagged:** the `filesTouched` source is the raw DB ordering newest-first capped at 20 in the bridge, 10 visible in the payload. No time-window applied. Worker asked whether a "since-last-user-turn" window is wanted; that would need a turn-boundary signal not currently tracked at this layer. **My read (recommend approving as-is):** newest-N is fine for the supervisor's "what did they just do" triage; turn-window is over-engineering without a sponsoring requirement.

**Pickup checklist for next session:**

1. `git diff src/main/supervisor/event-payload-builder.ts src/main/supervisor/event-bridge.ts src/main/supervisor/index.ts src/main/supervisor/test-helpers/fake-bridge-deps.ts src/main/supervisor/event-bridge.integration.test.ts` — inspect the actual patch.
2. Decide on the open question (recommend: leave as-is).
3. `npm run restart`.
4. Live smoke test: launch a supervised Claude worker, send a small prompt that touches a file (e.g., "read CLAUDE.md and report the first line"). Expect on idle: `[DASHBOARD EVENT]` "Last output:" contains the assistant's response prose (no `⏵⏵`, no `Opus 4.7 (1M context)`, no `running stop hook`); "Files touched:" section appears with at least one entry; no token bloat.
5. Negative-path verification: launch a worker, immediately kill or restart before any assistant turn lands. Confirm event still ships (degrades to `logTail` per the try/catch fallback) instead of crashing the supervisor.
6. If both pass: commit. Move BUG-20 to the Closed section.
7. If a failure surfaces: the worker's patch is in clean shape; either send a fix directive back to the same worker (still alive? check `list_agents` — context was 15%, room to spare) or open a follow-up.

**What unblocks once BUG-20 ships:** `plans/disable-inference-for-supervised-claude-workers.md` becomes implementable. That plan promotes Class IV from "one of many signals" to "the only signal" for supervised Claude workers — kills BUG-09/13/18's failure modes for the dominant worker case. Sequenced after BUG-20 because without the chat-first preview, you can't verify Class IV promotion from events alone.

**Bonus follow-up:** `class-iv-worker-hook-scaffold.md` §12 (added same session) widens Class IV to Codex + Gemini once their scaffolds ship hook configs. Both providers have hook systems (verified 2026-05-21) — Gemini's `Notification` hook even gives a purpose-built `waiting_for_input` signal that's strictly better than today's pattern-matching.

---

## BUG-19: supervisor receives no live dashboard events — events queue silently while terminal is open

- Component: src/main/supervisor/event-bridge.ts (`deliver()` gate stack) + src/main/supervisor/status-monitor.ts (`turnInFlight` clearing for supervisor lifecycle)
- Severity: **high** — architecturally defeats the supervisor's autonomous-reaction purpose. Worker idle/waiting_for_input/crashed/context-threshold events do not reach the supervisor while a human is watching it, so the supervisor cannot triage agents until the human types something that flushes the queue. The dashboard supervisor button shows a permanent green `working` dot.
- Status: open
- Surfaced: 2026-05-19 — this session. User observed (a) supervisor's status indicator stuck on `working` (green dot) for entire session despite the supervisor sitting idle between user turns, (b) zero `[DASHBOARD EVENT]` lines arriving for 4 worker idle/done transitions across ~10 minutes, (c) when events finally landed, all 7 queued events arrived in one consolidated message. Triggered by no specific user action — this is the supervisor's normal operating mode on this build.
- Two compounding sub-causes (both must be fixed to restore reactive supervisor behavior):
  - **19a — `turnInFlight` latch never clears for supervisor lifecycle.** BUG-18's fix added `turnInFlight: boolean` to `WorkingLatchEntry`, set on tool-use / task-started / non-terminal assistant-text, cleared only by `forceIdle('turnComplete')`. For workers this works — every Claude turn ends with `stop_reason='end_turn'` → turnComplete. For supervisors the assumption breaks: supervisors sit idle between *user turns*, not model turns, so any missed or delayed `turnComplete` event leaves `turnInFlight=true` permanently. `inferStatus` then returns `working` indefinitely because there's no TTL ceiling on the sticky flag (the whole point of BUG-18's fix was that there isn't one). Result: supervisor permanently shows `working` in the dashboard.
  - **19b — `event-bridge.ts:285` working/launching gate then queues every event.** With 19a making `fresh.status === 'working'` always true for the supervisor, `deliver()` short-circuits at the first gate and calls `queueEvent` for every worker-status transition. The drain function (`drain()` at `:351`) re-checks supervisor status before flushing; it never flushes while 19a is in effect. Queue cap is `SUPERVISOR_EVENT_QUEUE_MAX` — past that, the oldest queued events are silently dropped.
- Compounding-factor (separate design question, surfaced same session): the second gate at `event-bridge.ts:293` also queues events when `fresh.isAttached === true` (renderer mounted). User confirmed they explicitly want events delivered live to the supervisor terminal even while watching it. This gate's mental model — "don't interrupt the user reading" — fits a worker pane but is hostile to a supervisor pane whose whole purpose is autonomous event-driven reaction. Even fixing 19a leaves this as the next bite. The consolidated-batch payload (`buildConsolidatedPayload` at `:378`) is good design and should be preserved either way — the problem isn't the batching, it's that anything got queued at all.
- Reliable diagnostic signature: supervisor dashboard status indicator shows green `working` for many minutes with no observable activity AND no `[DASHBOARD EVENT]` lines arriving for worker state changes that did happen (verifiable via `list_agents` showing workers idle/done). Confirmed by reading `event-bridge.ts` console output — `[event-bridge] Queued event (supervisor busy)` log lines correspond 1:1 to the missing notifications.
- Affected workflows: every supervisor session on Claude after the BUG-18 patch landed (commit `2062ae0`, 2026-05-19). This is a regression of supervisor reactiveness introduced by tightening worker working-detection.
- Workaround for now: type any character to the supervisor's terminal and the resulting end-of-turn signal eventually drains the queue (probably via the path that finally fired in this session). Or call `list_agents` periodically to discover transitions the events would have surfaced.
- Fix sketches (need both 19a and 19b/compounding-factor solved):
  - **19a — supervisor-aware turnInFlight clearing.** Three options:
    - **Option A:** mark supervisors specifically in the latch and use the legacy TTL-decay model instead of `turnInFlight` for them. Cleanest separation but reintroduces TTL math the rest of the system is moving away from.
    - **Option B:** add a fallback that clears `turnInFlight` after some chat-stream silence (e.g., 30s of no events at all, not just no `assistant-text`). Catches missed `turnComplete` without re-introducing the BUG-18 failure mode.
    - **Option C:** investigate *why* `turnComplete` isn't reaching the bridge for supervisor turns — there may be a dispatcher path that the supervisor's input writes bypass. If a missing wire-up is the root cause, fix that and 19a evaporates without architectural changes.
  - **19b — drop the working-gate for supervisor.** When `fresh.isSupervisor === true`, skip the working-gate at `:285` and the isAttached-gate at `:293`. The user-typing gate at `:307` remains (BUG-11's defense is still relevant — don't truncate the user's in-progress sentence). Consolidated-batch payload remains.
  - **Compounding-factor — drop or invert `isAttached` gate for supervisors.** Same change as 19b's gate-skip handles this; isAttached and working gates are skipped together for supervisor agents. Alternative for non-supervisor agents: keep current behavior (workers' attached terminals don't want event interruption).
- Related:
  - BUG-18 (closed 2026-05-19, commit `2062ae0`) — introduced `turnInFlight`. This bug is the supervisor-side failure mode of that patch.
  - BUG-09 (closed 2026-05-19) — established the working-latch architecture and the `/input` API gate. 19b's working-gate is symmetric to BUG-09's gate; the supervisor's stuck status now triggers it.
  - BUG-11 (open) — added the user-typing defer at `:307`. That defer is correctly scoped to "user actively typing in unattended terminal" and is NOT the cause here; the working-gate fires first and short-circuits before BUG-11's gate runs.
  - Meta-bug Codex flagged in BUG-16/17 design review (2026-05-19) — if supervisor is `working` when a worker script tries to POST `orchestration.groupthink.stalled` to the supervisor's `/input`, the BUG-09 API gate returns 409 and the stall event drops. Same root cause as 19a; fixing 19a fixes the meta-bug.
- **Investigation 2026-05-19 (agent `08dfea00`, writeup `plans/bug-19-investigation.md`):**
  - Static-code finding: end_turn → forceIdle chain has NO `isSupervisor` filter — structurally intact. JSONL had 22 end_turn entries on the day. Reader/dispatcher/bridge all forward symmetrically. So the 19a hypothesis "turnInFlight never clears for supervisors as a class" is unsupported by static analysis.
  - Closest concrete suspect: `event-bridge.ts:141` `initialLoad` first-batch skip on dashboard restart swallows ALL pre-restart events including the most recent end_turn → supervisor starts with launch-time `status='working'`, empty latch, and PTY fallback pins it via TUI redraws.
  - **Observation that further weakens the architectural hypothesis (live, same session):** the supervisor's status indicator *did* flip to idle mid-session. So the trap is intermittent, not permanent — consistent with the restart-first-batch theory (only bites on the first turn after a restart) or with a specific turn shape that misses turnComplete.
  - Recommended bundle (~65 prod LOC + ~170 test LOC; each layer independently revertable):
    - **Layer 1** (~10 LOC) — env-gated logs in the end_turn → forceIdle path to verify the runtime path before any structural fix.
    - **Layer 2** (~25 LOC) — restart replay: at initial-load time, scan the first batch backwards for the newest terminal event and fire `forceIdle('turnComplete-replay')`. Direct fix for the restart-swallow theory.
    - **Layer 3** (~15 LOC) — 60 s chat-silence fallback that clears `turnInFlight` when no tools outstanding. Belt-and-suspenders for missed turnComplete; this is the 19a Option B sketch.
    - **19b** (~15 LOC) — wrap working-gate at `:285` and isAttached-gate at `:293` in `if (!fresh.isSupervisor)`. Preserves BUG-11's user-typing defense at `:307` and `done/crashed` drop. Worker behavior unchanged.
  - Doc includes 18 proposed tests modeled on existing BR-IDs and explicit non-regression analysis for BUG-09/11/18.
  - **Decision (deferred):** not implementing now. User wants to revisit once the symptom is more clearly reproducible or another supervisor lock-up forces the hand. If we revisit, ship Layer 1 first to confirm which sub-fix matters before writing Layer 2/3.

---

## BUG-10: large-prompt auto-submit fails on multiple input paths (launch_agent AND send_message_to_agent)

- Component: src/main/supervisor/index.ts (sendInput / _doSendInput) + send-input-encoders.ts
- Severity: medium (silent — agent sits with paste staged but unsent; status often flips to `working` from the paste activity, masking the failure)
- Status: open
- Gotcha ref: groupthink-running-gotchas.md §13 (to be added)
- Surfaced: 2026-05-17 launching `groupthink-duplicate-relay-investigation` (`launch_agent` + Claude + Windows + ~3 KB prompt)
- Re-surfaced: 2026-05-19 during the AUTONOMOUS_PLAN_LIFECYCLE GroupThink manual-stitch recovery. Supervisor called `send_message_to_agent` on the **Codex** Reviewer with Draft 2 (~16 KB message). Codex's terminal showed `[Pasted Content 7012 chars]` in the input box, the placeholder hint "Find and fix a bug in @filename" was still visible (input not submitted), but the agent's `status` was `working`. Manual `send_keys_to_agent({key:'enter'})` kicked it off and Codex began producing the actual review. Expands the bug's scope:
  - **Affected MCP tools:** both `launch_agent` (BUG-10 original) AND `send_message_to_agent` (today). The shared code path is `_doSendInput` → bracketed-paste + Enter.
  - **Affected providers:** Claude (May 17) AND Codex (May 19). Not Claude-specific.
  - **Status-signal misleadingness is path-specific** (correction 2026-05-19, second occurrence this session):
    - **`send_message_to_agent`:** the post-launch seed `forceWorking({source: 'user-input-submitted', ttlClass: 'model-pending'})` fires on Enter-written-to-runner (BUG-09 fix), **not on agent-actually-processed-prompt**. A staged-but-unconsumed paste still seeds the latch, so `status: working` for ~180s with no real processing. This was the misleading signal on the Codex Reviewer relay.
    - **`launch_agent`:** status flips `working` from normal process startup, regardless of whether the initial prompt's Enter fired. Useless as a BUG-10 diagnostic on its own. The fold-worker today went `working → idle` purely from launch + idle, with the prompt staged-but-unconsumed.
  - **Reliable diagnostic signature** (path-agnostic): chat has the user prompt but **zero assistant turns**; `git status` clean (no edits); log grep for `Edit|tool_use|Read` finds nothing from the assistant. Don't rely on the status field.
  - **Codex-reported char count was lower than the actual message size** (7012 vs ~16000). Codex's CLI may also be truncating very large pastes — separate sub-issue worth verifying but not the root cause; even truncated pastes need Enter to submit.
- Symptoms (consolidated): supervisor sends a large prompt via either MCP tool. Dashboard reports success. Agent's terminal contains the paste body but no submitted message. Agent never actually processes the prompt until a separate Enter arrives. Status field is unreliable as an indicator — use the chat-has-no-assistant-turn + clean-working-tree signature instead.
- Suspected root cause (unchanged): race between the bracketed-paste sequence and the immediate Enter follow-up. For multi-line / many-byte prompts, the receiver's input widget (Claude Code OR Codex CLI) is still consuming the paste body when Enter arrives — Enter is either dropped or consumed mid-paste. Provider-agnostic; tool-agnostic.
- Fix sketch (consolidated):
  - **Option A — delay-based, scaled by payload:** after writing the prompt body, insert a small delay before sending Enter (e.g. 50ms baseline + 5ms per KB, capped at ~500ms). Cheap, low risk, won't catch every edge case.
  - **Option B — confirm-then-submit:** after writing the paste, poll for a known-good "paste fully ingested" signal (provider-specific — e.g. Claude Code's "Pasted text #N" marker landing in the terminal stream, Codex's `[Pasted Content N chars]` marker), then send Enter. More robust, more plumbing.
  - **Option C — provider-aware paste end-marker:** end the bracketed paste with a sentinel the receiver acks before we send Enter. Most robust, requires receiver cooperation.
  - **Status-signal hardening (separate):** the paste-activity working flip is misleading for any watcher trying to detect this failure mode. Consider not flipping `working` on raw paste bytes alone; require some downstream evidence of processing (e.g. an assistant turn started, or a tool-call event).
- Workaround for now: when sending a long prompt via either tool, follow up with `send_keys_to_agent({key:'enter'})` after a couple seconds. Or chunk the message into smaller messages (small enough that the race doesn't fire).
- Note: this is **not** a regression of BUG-01 — that fix correctly added the Enter to the launch path. The bug is timing/race between the paste body and the Enter for large payloads, and it lives in the shared `_doSendInput` path used by every input-sending MCP tool.

### Fresh evidence 2026-05-25 — third reproduction, `launch_agent` + Claude + Windows + ~7 KB prompt; status stayed `working` for ~25 minutes before user noticed

Reproduction during BUG-26 work this session. Supervisor called `launch_agent` for the "BUG-26 Path C implementer" (Claude, Windows, fresh launch) with a ~7 KB multi-paragraph brief. Dashboard reported launch success; agent flipped to `working`; supervisor saw the initial post-launch idle event (BUG-20-flavored TUI-footer preview) and assumed thinking-pending per BUG-18 workaround. Agent sat at `working` for ~25 minutes with the prompt visible in the terminal but never submitted. The user (watching the terminal directly) noticed the staged prompt and instructed the supervisor to force the agent off `working` and send Enter.

Recovery sequence that worked:
1. `POST /api/agents/<id>/status {"state":"idle","source":"hook-fallback"}` — unstuck the latched `working` from BUG-09's launch-seed.
2. `send_keys_to_agent({key:'enter'})` — submitted the staged paste.
3. Agent immediately began processing (`Reading 5 files… thinking some more with xhigh effort`); turn proceeded normally afterwards.

Reinforces and extends prior findings:
- **Third occurrence in the wild**, same root cause family. Bug is not workload-rare; it's reliably triggered by multi-paragraph briefs on Windows.
- **The supervisor cannot detect this from MCP signals alone.** The `working` latch from BUG-09's launch-seed (`source: 'user-input-submitted', ttlClass: 'model-pending'`, 180s TTL) hides the failure for the full TTL window. After 180s the launch-seed expires, status flips to `idle` once, but the next chat-event refresh (if any) re-seeds. The path-agnostic diagnostic ("user message in chat, zero assistant turns, clean working tree") is the only reliable signal — and it requires the supervisor to actively check rather than respond to events. Without a human watching the actual terminal, this can sit indefinitely.
- **BUG-18 false-idle masking compounds the detection problem.** Today's idle event from BUG-09's seed expiry was indistinguishable in shape from a BUG-18 thinking-pending false-flip. The supervisor (correctly per BUG-18 workaround) chose to wait for content rather than act on the idle event. Net result: BUG-10 + BUG-18 + BUG-09's launch-seed conspire to make staged-but-unsubmitted prompts invisible for the entire TTL window plus however long the supervisor waits past it.

Behavioral takeaway for supervisor (until BUG-10 is fixed):
- After **any** `launch_agent` call with a prompt > ~2 KB on Windows, pre-emptively send `send_keys_to_agent({key:'enter'})` ~3-5 seconds after launch. Idempotent: if the original Enter took, the extra Enter is consumed by the empty input box (a no-op); if it didn't, the recovery is immediate. Same heuristic applies to `send_message_to_agent` with large payloads.
- Diagnostic signature to actively check at the ~30-second mark after launching a large-prompt agent: `read_agent_chat(<id>, role:'assistant', limit:1)` returns empty AND `read_agent_log` shows the prompt text visible at the input prompt → BUG-10. Recover with the two-step above.
- Do NOT trust the `working` status for the first ~3 minutes after launching a large-prompt agent. The launch-seed TTL makes it indistinguishable from genuine processing.

Fix-side note (no code change requested yet, just sharpening the priority): the cost of this bug is now demonstrably "supervisor loses entire 25-minute windows of work to undetected staged paste." Option A from the consolidated sketch (delay-based, scaled by payload) would have prevented today's occurrence at ~50ms cost per launch. Worth bumping in priority next time BUG sweeps are scheduled.

---

## BUG-18: dashboard fires false `working → idle` event during long extended-thinking spans

- Component: src/main/supervisor/status-monitor.ts (working latch TTL / refresh table) + event-bridge.ts
- Severity: high — supervisor sees idle and may stop a worker that's still actively producing tokens, wasting context + tokens (today: 40K Claude tokens lost on a worker the supervisor killed prematurely)
- Status: open
- Surfaced: 2026-05-19 — supervisor launched a Claude worker (`fold-autonomous-plan-resolutions`, e61c1044) on a 3.5 KB brief involving Read of two ~30 KB markdown files + six surgical edits. Worker entered long extended-thinking with "xhigh effort" — terminal showed continuous "Wrangling… almost done thinking with xhigh effort" spinner output for several minutes. After ~3 minutes the dashboard emitted `[DASHBOARD EVENT] working → idle` with `Context: 4% (40K/1M tokens, 3 turns)`. Supervisor (incorrectly) treated this as terminal and stopped the agent. User opened the terminal view and confirmed the worker had still been working at that moment; the supervisor's stop killed live work, no edits had landed yet, 40K tokens wasted.
- Mechanism (hypothesis): BUG-09's working latch is seeded with `ttlClass: 'model-pending'` (180 s TTL) at sendInput delivery. Refresh on `assistant-text` / `thinking` / `task-started` events keeps it warm during normal turn flow. Extended thinking with no chat-event emission (Claude's pure-thinking phases under "xhigh effort") produces only spinner glyphs / "Wrangling…" PTY output, which the `_lastMeaningfulBurst` gate may not classify as content. After 180 s of pure thinking with no chat-event refresh, the latch expires; `inferStatus` returns idle. Status flips to idle while the model is still producing tokens behind the scenes. This is the inverse-failure of BUG-09's working↔idle cycling: same mechanism, longer timescale, triggered by reasoning-heavy turns rather than spinner-only API output.
- Reliable diagnostic signature: a `working → idle` event arrives with `Last output` consisting almost entirely of spinner/Wrangling/thinking-effort text and no assistant prose; chat read returns no new assistant turn relative to the prior idle; terminal view (manual user check) shows the agent still in an active "thinking" state with token counters incrementing. The dashboard's status field is **not trustworthy** for these workers.
- Affected workflows: any worker doing heavy planning before its first tool call. Especially likely with: Opus 4.7 + "xhigh effort" thinking, complex briefs that ask for multiple reads + multiple edits in sequence, briefs that present a planning problem before an action.
- Workaround for now:
  - **Brief-side:** instruct the worker to commit to a tool call early (e.g. "your first action is a Read of <X>"), then emit one-line chat acknowledgements between major steps. Chat events refresh the latch; tool calls produce them; mid-task narration produces them.
  - **Supervisor-side:** do NOT auto-stop on a `working → idle` event for workers known to do heavy thinking. Confirm via terminal view (user-side) or via `read_agent_chat` showing a real assistant message before treating as terminal.
- Fix sketches (real fix, not workaround):
  - **Option A — extend the model-pending TTL during observed thinking.** If PTY output contains thinking-indicator markers ("Wrangling…", "thinking with xhigh effort"), refresh the latch even if `_lastMeaningfulBurst` doesn't classify those bytes as content. Requires recognizing the markers, which are Claude Code TUI-specific.
  - **Option B — add a `thinking-pending` TTL class** with a longer ceiling (~900 s, same as `tool-pending`) seeded when the PTY emits a known thinking-mode marker. Closer to how `tool-pending` is currently used for tool-execution windows.
  - **Option C — refresh the latch on Claude SDK `thinking_delta` events** (if those exist in the chat stream) rather than relying on PTY content classification.
  - **Option D — abandon TTL ceilings and require an explicit terminal event** (turn complete, crash, real idle) to flip working → idle. Strongest semantics; biggest design change.
- Related: BUG-09 (closed 2026-05-19, established the latch + refresh table architecture; this bug is a new failure mode in the same system). The BUG-09 fix bundle was specifically about working↔idle cycling within a single turn (spinner-only API output); extended thinking is a different shape (no chat-event emission for minutes at a time) and was not in scope of BUG-09's verification.

---

## BUG-16: GroupThink Reviewer inherits stale Codex session because the launch call omits `freshSession`

- Component: `scripts/groupthink-v1.js` (POST `/api/agents` for Lead/Reviewer)
- Severity: high — corrupts deliberation correctness; supervisor cannot trust any GroupThink-produced plan until fixed
- Status: open
- Surfaced: 2026-05-19 — a GroupThink launched at 13:23 PDT relayed a stale "Reviewer feedback" to the Lead in Turn 1. The Lead correctly detected the mismatch ("Reviewer — your feedback doesn't match this deliberation; your notes are about supervisor event-bridge tests"); the actual Reviewer was busy reviewing Draft 1 normally.
- Mechanism: the dashboard's launch path for a fresh-launch Codex agent runs `shouldDiscoverCodexSession({ provider, resume: false })`, which returns `true` by design unless the caller passes `freshSession: true` (BUG-08 closed 2026-05-17). The discovered session is the most recent Codex rollout in the workspace — for today's run, that was the 05:27 BUG-09 GroupThink's Reviewer session. The newly-created Reviewer agent is therefore bound to a chat history that contains a prior `turnComplete: true` BUG-09 approval as its last assistant message. Combined with BUG-17 below, that stale message is relayed to the Lead as if it were a fresh Turn-1 response.
- Fix sketch:
  - Add `freshSession: true` to both POST `/api/agents` bodies in `scripts/groupthink-v1.js:274-290` (Lead) and `:299-315` (Reviewer). Lead also uses Codex via `--leadProvider=codex` paths, so apply unconditionally.
  - Verify by re-running GroupThink in a workspace that has prior Codex sessions and confirming both agents launch with empty chat history.
- Related: BUG-08 (closed 2026-05-17, added the flag); BUG-17 (the script-side defensive gap that compounded today's failure); BUG-12 (closed 2026-05-17, fixed a different cross-session contamination at the dispatcher layer).

---

## BUG-17: GroupThink relay loop has two robustness gaps (missing watermark seed on fresh launch + 409 crash on race)

- Component: `scripts/groupthink-v1.js` (relay loop, watermark seed paths)
- Severity: high — script crashes mid-deliberation with exit code 1 (not a stall, so no `resume_hint` is emitted; user must hand-stitch recovery)
- Status: open
- Surfaced: 2026-05-19 same run as BUG-16; script logged Turn 2 relay attempt with HTTP 409 and died unhandled. Both planners were left alive and idle holding good but unmerged content.
- Two distinct gaps in the same loop:
  - **17a — Watermark unseeded on fresh launch.** `seedLastRelayedTsFromChat()` is only called on the `--resume-*-id` paths (`:272, :297`). The else (fresh-launch) branches skip it, on the assumption "newly-created agent = no chat history." BUG-16 violates that assumption for Codex. Even with BUG-16 fixed, defense-in-depth says always seed: `readNextMessage` filters by `msg.ts > lastRelayedTs[agentId]`, and a zero watermark turns the very first message returned by the chat API into a "fresh" turn regardless of when it was produced.
  - **17b — 409 crash on relay race.** `apiJson(base, 'POST', '/api/agents/<receiver>/input', ...)` at `:342` and `:351` does not check the receiver's status. The dashboard's API gate at `src/main/api-server.ts:193` (added in BUG-09's fix bundle) rejects `/input` with HTTP 409 when the target is `working`. The script's `apiJson` helper throws on non-2xx, the throw is unhandled in the relay loop, and the script exits with code 1 — not exit code 2, so no stall event with `resume_hint` is emitted. Today's race: Lead finished Turn 2 pushback in 26 s while Reviewer was still composing its legitimate ~5-minute Draft-1 review.
- Fix sketches:
  - **17a:** call `seedLastRelayedTsFromChat(base, lead.id, 'Lead')` immediately after `leadAgentId = lead.id` at `:291`, and the symmetric call after `reviewerAgentId = reviewer.id` at `:316`. Two-line fix.
  - **17b:** before each relay POST, await a small helper `waitReceiverReady(base, receiverId, timeoutMs)` that polls `GET /api/agents/<id>` until status ∈ {`idle`, `waiting`} (the same statuses the API gate accepts). Reuse `POLL_INTERVAL_MS`. Alternative: catch the 409 from `apiJson`, wait, retry — uglier but localized. Either way, on persistent failure emit `orchestration.groupthink.stalled` with exit code 2 so the supervisor can recover with `resume_hint`.
- Related: BUG-06 (closed 2026-05-17, added `seedLastRelayedTsFromChat` for the resume path — this entry generalizes it); BUG-09 (closed 2026-05-19, established the API gate that 17b races against).

---

## BUG-14: GroupThink terminates after Lead Turn 1 when `--planPath` points at an existing file

- Component: `scripts/groupthink-v1.js` (plan-file detection / termination logic)
- Severity: medium — silently kills cross-provider deliberation; Reviewer never engages; user gets a single-provider rewrite that looks like a deliberated artifact
- Status: open
- Surfaced: 2026-05-18 — supervisor ran GroupThink with `--planPath=plans/notes-canvas-implementation.md` (an existing file the Lead was asked to refine in place). Lead (Claude) produced Draft 1 in Turn 1 — full refined plan in chat, ending with "approve and I'll write" — explicitly **not** writing the file because the seed prompt's "wait for Reviewer approval" gate worked. Script nonetheless logged `Plan file detected at <path>. Termination condition met.` 5m25s in, terminated, cleaned up agents. Reviewer (Codex) session id = `null` in the completion event — never invoked. On-disk file is the **original** content with mtime bumped at termination (08:59:23 PDT), because the script appended its `<!-- groupthink_members -->` trailer (the v1 quirk).
- Mechanism (hypothesized): the termination watcher either (a) checks file existence and fires once Lead Turn 1 lands (regardless of who wrote it), or (b) the script's own trailer-stamping logic writes the file as part of the completion-detection path. Either way: an existing-file planPath is a one-turn trap.
- Fix sketch (two options):
  - **Option A — content-hash watch.** Snapshot the file's SHA-256 at script startup; termination requires the on-disk hash to differ from the snapshot. An existing-file planPath becomes safe — Lead must actually mutate it before termination fires. Cheap.
  - **Option B — explicit "ready-to-write" signal from Lead.** The Lead writes a sentinel (e.g., `<!-- GROUPTHINK_FINAL -->`) at the top of the file on the actual final write; the script watches for that sentinel only. More plumbing, more robust against accidental Lead-side writes mid-deliberation.
- Workaround for now: always pass a planPath that does NOT exist yet (e.g., `plans/foo-v2.md`). If the user wants to overwrite an existing file, save the refined output to a new path and manually merge after.
- Related: the trailer-stamping of `<!-- groupthink_members -->` is already flagged in the orchestration manual under "Known limits (v1)" as architecturally wrong; fixing that may obviate Option A here.

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

- **2026-05-19** BUG-09: agent.status cycled `working↔idle` within a single user turn — false `working → idle` event fired ~8 s after sendInput when Claude Code Coalescing/Reading phases emitted spinner-only output below the `_lastMeaningfulBurst` >200 bytes/3 s gate. Fix shipped in 4 bundles (commits `8aca2d1`, `c1d8409`, `ce24b2a`, `6cb09c2` + the latch-shape change): typed-options `forceWorking` API with `toolUseId` pairing, tagged-union latch (`idle|waiting|working`), model-pending (180 s) / tool-pending (900 s) TTLs as safety floor, refresh on `assistant-text` + `thinking` + `task-started`, dual PTY signals (`lastOutputTime` + `lastMeaningfulBurstTime`), poll/chat race re-read guard, `forgetAgent` on delete/restart, dispatcher `initialLoad` suppression, Gemini D-07 `turnComplete` gate. Bundle 2's initial implementation of §3.4 placed the launch-window seed `forceWorking('launch-pending', ttlClass: 'model-pending')` at `runner.launch()` instead of at the sendInput delivery boundary, deadlocking `launch_agent` auto-submit (60 s poll vs 180 s latch) and rejecting `send_message_to_agent` for the same 180 s window. Corrected in **commit <pending>** per `plans/bug-09-launch-seed-fix-plan.md` (GroupThink-produced, Claude lead + Codex reviewer): `_doSendInput` now returns `Promise<boolean>`; `sendInput` chain calls `notifyUserInputDelivered` then `forceWorking({source: 'user-input-submitted', ttlClass: 'model-pending'})` gated on `submit && delivered`. Launch-time seeds deleted from both Windows (`index.ts:1026-1030`) and WSL (`:1282-1284`) launch paths. New supervisor-level test file `src/main/supervisor/agent-supervisor.test.ts` with 6 cases (call-order recorded via `calls: string[]` array; pragmatic refinement: test wraps `notifyUserInputDelivered` instead of replacing, so the real `event-bridge.ts:351` inner forceWorking fires for Case 4's three-element sequence). 25/25 `status-monitor.test.ts` non-regression. Verified live post-restart 2026-05-19 on smoke-test agent 906ad7b9: launch_agent reported "Sent initial prompt" (no 60 s wait), single clean `working → idle` event, real 200-word reply produced. Original ce44c2db sighting closed at the actual race site (submit time) and protection is strictly stronger than launch-time (covers every turn started from idle, not just the first).

- **2026-05-19** BUG-13: Claude Code CLI's grey ghost-text input suggestions flapped status `idle↔working` and leaked into the supervisor's `Last output:` block as if they were user-typed input. **Path A** (commit `156e0d2`): disabled the suggestions at the CLI source by setting `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` as `extraEnv` on `runner.launch()` for Claude agents (`src/main/supervisor/index.ts:1018-1020`). **Path B** (commits `a60d14b` + Change-2 in `0996c83`): tightened the meaningful-content gate and stripped ANSI per-line inside `formatLogTail` (`event-payload-builder.ts:49`). Verified live 2026-05-18/19 in smoke-test agents 06ad8cb3 + 906ad7b9: event `Last output:` contains zero `\x1b` bytes; bare `❯` prompt in idle terminal has no trailing grey suggestion. Two observations outside Path B's scope, noted for separate decisions: (i) TUI footer text fragments (`Shenaniganing… still thinking with xhigh effort`, the `Opus 4.7 (1M context) | … | Style: default` status line, the horizontal box-drawing rule, `⏵⏵ bypass permissions on (shift+tab to cycle)`) still leak through formatLogTail because they're plain Unicode, not escape sequences; (ii) agent reply text appears word-merged in spots (e.g. `splitonlines.status-monitor.ts`) because cursor-positioning escapes that previously rendered as visual spacing got stripped without inserting a real space.

- **2026-05-19** BUG-15: terminal viewer diverged from chat for both live and `done` agents — bytes emitted before viewer-mount were lost because the renderer subscribed to live PTY data but never requested a snapshot of the runner-side ring buffer; `done` agents had no scrollback source at all once the runner exited. Fix (commits `80fd91e` + `e1323ee`): added `getRingBuffer(agentId)` IPC (`src/main/supervisor/index.ts:1827-1860`); rewrote `TerminalPanel.tsx` mount as an atomic subscribe → snapshot → write-snapshot → drain-buffered-tail → go-live sequence (no bytes lost in the ~50 ms IPC round-trip); chunked initial paint with rAF for smooth large-scrollback rendering; runners now persist their ring to disk at `${logPath}.scrollback` in the exit handler (`windows-runner.ts:269`, `wsl-runner.ts:304`) so `done` agents have a recoverable source. Verified live 2026-05-18/19: user confirmed terminal viewer on agent 906ad7b9 showed real Claude Code activity during tool calls (not just `[Pasted text]` placeholder); stopping smoke-test agent 06ad8cb3 produced a 60 035-byte `d27c0464.log.scrollback` file alongside the log; head of file verified to contain the full PTY byte stream including ANSI escapes for xterm.js replay. Bracketed-paste truncation (`[Pasted text #1 +N lines]`) is intentional CLI behavior and remains expected behavior, not a bug.

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
