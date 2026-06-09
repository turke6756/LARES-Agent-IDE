import type { AgentProvider } from './types';

export const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions --chrome';
export const DEFAULT_COMMAND_WSL = 'ccode --dangerously-skip-permissions --chrome';
export const TMUX_SESSION_PREFIX = 'cad__';
export const STATUS_POLL_INTERVAL_MS = 1500;
export const WORKING_THRESHOLD_MS = 8_000;
export const LOG_DIR_NAME = 'agent-dashboard-logs';
export const CONTEXT_STATS_POLL_INTERVAL_MS = 5000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;

// Teams
export const TEAM_MAX_MESSAGES_PER_5MIN = 50;
export const TEAM_MAX_ALTERNATIONS = 6;
export const TEAM_ALTERNATION_WINDOW_MS = 120_000;
export const TEAM_PAIR_COOLDOWN_MS = 60_000;
export const TEAM_MESSAGE_DELIVERY_POLL_MS = 10_000;
export const TEAM_MESSAGE_BATCH_DELAY_MS = 2_000;

// Supervisor event bridge
export const SUPERVISOR_EVENT_COOLDOWN_MS = 10_000;
export const SUPERVISOR_EVENT_LOG_TAIL_LINES = 5;
export const SUPERVISOR_CONTEXT_THRESHOLDS = [80, 90, 95];
export const SUPERVISOR_EVENT_QUEUE_MAX = 10;
export const SUPERVISOR_EVENT_DRAIN_INTERVAL_MS = 15_000;
// BUG-11: defer auto-submitting dashboard events while the user is actively
// typing into the supervisor's PTY. Any byte arriving through
// `AgentSupervisor.writeToAgent` stamps the agent's last-user-activity time;
// the bridge defers (queues + re-arms drain) while the gap since that stamp
// is below this threshold. 3 s covers the gap between successive keystrokes
// during human typing without locking out events when the user pauses.
export const SUPERVISOR_USER_TYPING_QUIESCENT_MS = 3_000;

// Turn-latch TTLs — see plans/agent-lifecycle-hardening-plan.md §2.1.1 / D-09.
// The latch holds Pipeline B's idle/waiting truth against contradictory PTY
// byte-bursts. TTL exists so a never-resumed agent eventually falls back to
// PTY truth rather than drifting permanently.
export const IDLE_LATCH_TIMEOUT_MS = 30 * 60 * 1000;   // 30 min
export const WAITING_LATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// BUG-09 working-latch TTLs — see plans/bug-09-fix-design.md §3.2.
// Two-tier TTL so the latch holds across Coalescing / spinner-only windows
// while not wedging forever on a silently-broken CLI.
//
// `model-pending` covers inter-event gaps when no tool is outstanding —
// post-tool-result re-coalesce, rate-limit backoff, model thinking phases.
// Reviewer convergence picked 120–180 s (Claude) and 5 min (Codex); we land at 3 min.
export const WORKING_LATCH_MODEL_PENDING_MS = 180_000;
// `tool-pending` covers windows where a specific `toolUseId` is outstanding —
// the chat-stream-verified fact that a tool is running outranks PTY silence.
// `toolUseId` pairing in `event-bridge.ts` means this is a safety floor, not
// the primary mechanism.
export const WORKING_LATCH_TOOL_PENDING_MS = 900_000; // 15 min
// BUG-18 Change 1 — `thinking-pending` covers Claude extended-thinking
// (xhigh effort) and equivalent provider phases where no chat event fires
// for minutes. The 2026-05-19 sighting (311 s gap, Opus 4.7 xhigh) lands
// comfortably under this ceiling. Set to 900 s to match the tool-pending
// floor — the bound is "no chat refresh for 15 min" regardless of whether
// the silence is a tool or pure model thinking.
export const WORKING_LATCH_THINKING_PENDING_MS = 900_000; // 15 min

// Unsupervised-agent working-latch TTLs. The worker-shaped 180 s / 900 s
// ceilings above exist to suppress false-idle events that a supervisor would
// react expensively to (BUG-09 / BUG-13 / BUG-18). When an agent has no
// supervisor (`!isSupervised && !isSupervisor`), no consumer pays that cost —
// status drives the UI dot and team-delivery's idle hook, both of which
// already guard against momentary flap (and unsupervised agents aren't put
// in teams in practice). Use snappy ceilings so a genuinely idle
// unsupervised agent flips quickly.
//
// See plans/tighten-inference-for-unsupervised-agents.md §1.
export const WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS = 30_000;      // 30 s
export const WORKING_LATCH_TOOL_PENDING_UNSUPERVISED_MS = 120_000;      // 2 min
export const WORKING_LATCH_THINKING_PENDING_UNSUPERVISED_MS = 120_000;  // 2 min — collapse with tool-pending

// Supervisor-specific working latch. The 3–15 min worker latches above exist
// to suppress false idle events that would otherwise be relayed to the
// worker's supervisor (Coalescing pauses, tool windows, extended thinking).
// The supervisor has no equivalent consumer — nobody is supervising the
// supervisor — so its `status === 'working'` is read only by the /input gate
// and event-bridge's queue gate, both of which want an accurate "is the
// supervisor actively typing right now?" signal, not a pessimistic ceiling.
// A short latch lets those gates release as soon as the supervisor goes
// quiet, instead of waiting out the worker-shaped TTL.
export const SUPERVISOR_WORKING_LATCH_MS = 5_000;

// Class IV watchdog — see plans/disable-inference-for-supervised-claude-workers.md §2.2.
// When a supervised Claude worker (which uses the Stop-hook → forceIdleFromHook
// path instead of inference) has been in `working` for this long with no hook
// event received, log a warning. Belt-and-suspenders for a broken hook
// scaffold (missing script, missing env injection, settings.json corruption).
// Warn-only; the dashboard does NOT auto-fall-back to inference, by design.
export const HOOK_SILENCE_WARN_MS = 15 * 60 * 1000;  // 15 min

// Start-hook silence watchdog — supervised workers must see a
// UserPromptSubmit hook within this window after sendInput; otherwise the
// dashboard would be silently lying that the agent is idle when the user's
// paste never got submitted (BUG-10). Short threshold (3 s) because the
// hook fires synchronously on submit and round-trips in well under 1 s
// on a healthy scaffold. Warn-only.
export const START_HOOK_SILENCE_WARN_MS = 3_000;

// Launch-time hook canary (HOOK_SYSTEM_DESIGN.md §5.4 / B5). When a worker-lane
// agent launches we expect a SessionStart hook (or the first UserPromptSubmit /
// Stop hook) to reach the dashboard within this window. If none has arrived by
// then AND hook_status is still 'unknown', the scaffold is broken — set
// hook_status='broken' immediately rather than wait for the 15-min silence
// watchdog. This does NOT change `status` and does NOT re-enable PTY inference;
// broken is surfaced via hook_status only. 8 s comfortably covers a cold codex
// boot's first SessionStart on a healthy scaffold (the POST round-trips in well
// under 1 s once the hook fires).
export const HOOK_CANARY_WINDOW_MS = 8_000;

// P1 multi-transport hook delivery (plans/p1-hook-spool-multi-transport.md §2
// step 4a) — tmux pane-option freshness gate. The @agentdashboard-status pane
// option survives tmux-side across dashboard restarts while the in-process
// dedupe/ordering registries start empty, so a tmux-option event must
// additionally be younger than this bound (vs. the applier's host-clock
// receivedAt) before it can flip status or stamp hook health. Exported so the
// applier unit tests reference the same value.
export const TMUX_OPTION_MAX_AGE_MS = 10 * 60_000;

// Skew tolerance for the §2 step-4a CURRENT-LAUNCH guard ONLY (WSL and Windows
// clocks normally agree, but the guard must not be fragile at the millisecond
// boundary). The persisted last-hook guard deliberately has NO tolerance — it
// is what prevents a previously delivered HTTP/spool event from being
// resurrected after a dashboard restart.
export const TMUX_OPTION_LAUNCH_SKEW_MS = 2_000;

// BUG-10 reactive Enter-resend — when a hook-backed worker (claude/codex) has
// been delivered input but no UserPromptSubmit hook has fired, the dashboard
// now resends ONLY the submit keystroke (not the body, which is already in the
// prompt buffer) to recover a dropped Enter. The submit hook fires
// synchronously on a real submission and round-trips in well under 1 s, so a
// silence this long is strong evidence the Enter was eaten by the paste race
// (fixed ~80 ms body→Enter delay losing under load). Gated on the authoritative
// hook signal — only safe now that the optimistic `user-input-submitted` working
// seed is gone, so `idle` after input genuinely means "submit never took."
export const START_HOOK_RESEND_AFTER_MS = 3_000;     // wait before the 1st resend
export const START_HOOK_RESEND_INTERVAL_MS = 3_000;  // spacing between resends
export const START_HOOK_RESEND_MAX_ATTEMPTS = 2;     // then give up and warn

// ── Worker handoff handshake ─────────────────────────────────────────────
// POST /api/agents/:id/input with `confirm: true` (the MCP supervisor's
// send_message_to_agent / launch_agent handshake) blocks until the worker's
// turn provably started. For contract providers the UserPromptSubmit hook is
// the proof (sendInput's synchronous confirm-and-retry already owns that);
// for non-contract providers (gemini, codex-pre-proof) the server falls back
// to observing the hook timestamp / a status flip to 'working' for this long
// before reporting `confirmed: false`. Sized to outlast the reactive
// Enter-resend schedule (3s first resend + 3s second + hook round-trip).
export const HANDSHAKE_CONFIRM_WINDOW_MS = 15_000;
export const HANDSHAKE_CONFIRM_POLL_MS = 250;

// Stalled-worker watchdog — a supervised/worker-lane agent sitting in
// `working` with ZERO signal (no raw PTY output, no hook event, no fresh
// input) for this long is presumed stuck (dead turn, hung tool, dropped
// submit that slipped past every other guard). Emits a one-shot
// `worker_stalled` [DASHBOARD EVENT] so the supervisor gets the "this is
// taking forever" sense it otherwise lacks — without it, a worker that never
// finishes produces no Stop hook and therefore no event, ever. A genuinely
// long turn does NOT trigger this: streaming output / TUI spinner redraws
// keep the raw PTY timestamp fresh.
export const WORKER_STALL_WARN_MS = 15 * 60 * 1000;  // 15 min

// Synchronous submit confirmation (plans/global-hook-rollout-and-submit-confirmation.md
// §2.3/§2.4, Q4). The send chokepoint (`AgentSupervisor._doSendInput`) confirms a
// contract-provider submit actually started a turn by watching for the
// UserPromptSubmit hook, re-pressing the submit-only keystroke until it does.
//
// Asymmetric windows: the FIRST window after the initial body+Enter is the
// widest because every hook is a cold `node` spawn (no warm path) — node boot +
// fetch round-trip. Subsequent retry windows are tighter because the body is
// already in the composer and only the dropped Enter is being replayed.
//   - CONFIRM_WINDOW_FIRST_MS  — wait after the initial submit before retry #1
//   - CONFIRM_WINDOW_RETRY_MS  — wait after each submit-only re-press
//   - CONFIRM_POLL_MS          — poll cadence for the start-hook timestamp
//   - MAX_SUBMIT_RETRIES       — submit-only re-presses after the initial send
//                                (the final retry IS polled before giving up)
// INVARIANT: CONFIRM_WINDOW_FIRST_MS MUST cover the hook POST self-abort
// (2500ms — `buildDashboardStatusScript(2500, ...)` below) PLUS a cold node
// spawn budget of 1500ms, i.e. ≥ 4000ms. The 2500ms abort timer starts
// INSIDE the spawned hook process, AFTER node boot — so a valid slow hook's
// worst case as seen from the dashboard is `cold node spawn + 2500ms`, not
// 2500ms flat. A first window that only beats the abort value by a few
// hundred ms still hands a legitimately slow hook (e.g. a ~700ms+ cold spawn
// on a busy box) a premature Enter re-press. (Enforced by a constants test
// in handoff-handshake.test.ts asserting ≥ 2500 + 1500. Do NOT lower this
// without also changing the hook script's self-abort — which requires a
// scaffold version bump.)
export const CONFIRM_WINDOW_FIRST_MS = 4_000;
export const CONFIRM_WINDOW_RETRY_MS = 1_200;
export const CONFIRM_POLL_MS = 100;
export const MAX_SUBMIT_RETRIES = 3;

// BUG-23 — per-provider cold-start settle window. After `runner.launch()`
// returns, the agent is in `'launching'`; once wallclock since the launch
// stamp exceeds this provider-specific budget, StatusMonitor.poll() promotes
// it to `'idle'` (the supervisor launch-helper's poll-for-idle target).
// Honors env overrides at module-load so we can ratchet without a rebuild
// when a user reports keystroke-eating during boot.
//   - AGENTDASH_LAUNCH_SETTLE_MS_CLAUDE
//   - AGENTDASH_LAUNCH_SETTLE_MS_CODEX
//   - AGENTDASH_LAUNCH_SETTLE_MS_GEMINI
function _readSettleMs(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
export const LAUNCH_SETTLE_TIMEOUT_MS: Record<AgentProvider, number> = {
  claude: _readSettleMs('AGENTDASH_LAUNCH_SETTLE_MS_CLAUDE', 10_000),
  codex:  _readSettleMs('AGENTDASH_LAUNCH_SETTLE_MS_CODEX',  25_000),
  gemini: _readSettleMs('AGENTDASH_LAUNCH_SETTLE_MS_GEMINI', 10_000),
};
// Narrow watchdog: warn if a `launching` agent persists past
// LAUNCH_SETTLE_TIMEOUT_MS[provider] + this grace, which means the settle
// timer itself is misbehaving (clock skew, frozen poll, etc.).
export const LAUNCH_SETTLE_OVERRUN_GRACE_MS = 5_000;

/** Default CLI commands per provider and environment */
export const PROVIDER_COMMANDS: Record<AgentProvider, { windows: string; wsl: string }> = {
  claude: { windows: 'claude --dangerously-skip-permissions --chrome', wsl: 'ccode --dangerously-skip-permissions --chrome' },
  gemini: { windows: 'gemini --yolo', wsl: 'gemini --yolo' },
  codex:  {
    windows: 'codex --dangerously-bypass-approvals-and-sandbox',
    wsl: 'ccodex --dangerously-bypass-approvals-and-sandbox',
  },
};

/** Display metadata for provider badges */
export const PROVIDER_META: Record<AgentProvider, { label: string; color: string; bgClass: string; textClass: string }> = {
  claude: { label: 'Claude', color: '#F59E0B', bgClass: 'bg-amber-500/20', textClass: 'text-amber-400' },
  gemini: { label: 'Gemini', color: '#3B82F6', bgClass: 'bg-blue-500/20', textClass: 'text-blue-400' },
  codex:  { label: 'Codex',  color: '#22C55E', bgClass: 'bg-green-500/20', textClass: 'text-green-400' },
};

/** Default agent name used with --agent flag for supervisor instances */
export const SUPERVISOR_AGENT_NAME = 'supervisor';

// ── Supervisor scaffold: folder structure + file contents ──────────────

/** Default content for .dashboard/supervisor/CLAUDE.md */
export const SUPERVISOR_AGENT_MD = `# Supervisor Agent

You are a Supervisor Agent for the AgentDashboard. You coordinate worker agents — you do NOT edit code directly.

## Your Tools

You have MCP tools provided by the AgentDashboard. Use these as your primary interface:

- **list_agents** — List all agents with status, context usage, metadata
- **read_agent_chat** — Read an agent's structured chat messages (args: agent_id, role?, limit?). **PREFER over \`read_agent_log\`** for assessing worker output — returns clean role/content/timestamp records without PTY escape noise. Typical use on an idle event: \`read_agent_chat(agent_id, role: 'assistant', limit: 1)\` grabs the agent's final assistant message (where "## Patch summary" sections land). 10–50× cheaper in tokens than the raw-log path.
- **read_agent_log** — Read an agent's raw terminal output (args: agent_id, lines). Use only when you need PTY-level forensics (exact bytes in the terminal, test-runner stdout, error traces). Heavy with escape codes; fall back here when \`read_agent_chat\` is empty or insufficient.
- **send_message_to_agent** — Send input to an idle/waiting agent (args: agent_id, message). Rejects if agent is working. Blocks until the worker turn is confirmed started (see "Worker handoff handshake" below); read the HANDSHAKE result before ending your turn.
- **send_keys_to_agent** — Send key events (args: agent_id, key | keys, count?). Use for interactive widgets (AskUserQuestion pickers, slash-command menus, arrow keys, Enter, Ctrl-C) where \`send_message_to_agent\`'s bracketed-paste wrapping would deposit bytes as text instead of as key events.
- **get_context_stats** — Get token usage, context %, model, turns (args: agent_id)
- **stop_agent** — Stop an agent (args: agent_id)
- **launch_agent** — Launch a new agent (args: workspace_id, title, role_description, prompt)
- **fork_agent** — Fork to fresh context (args: agent_id)

**Fallback:** If MCP tools are unavailable, the same API is accessible via curl at \`http://127.0.0.1:24678/api/agents\`. In WSL, use the Windows host IP from \`/etc/resolv.conf\`.

## Working Directory

You live in \`<workspace>/.dashboard/supervisor/\`. Your shell commands run from there by default — useful for editing your own persona, memory, or skills, but not for project work.

Your workspace root is provided in your system prompt as \`Workspace root: <abs-path>\`. For any project-level shell command (\`git status\`, \`npm test\`, \`ls\`, etc.) **cd to that path first** or use tooling-specific flags (\`npm --prefix <workspace> ...\`). For Read / Edit / Glob, pass absolute paths — those tools do not respect bash cwd changes within a turn.

The dashboard launches you with \`--add-dir <workspace-root>\`, which extends your file scope to the workspace and lets you discover any workspace-shared skills under \`<workspace>/.claude/skills/\`. Your own private skills under \`./.claude/skills/\` are also auto-loaded because cwd is your folder.

## Memory

Check \`./memory/MEMORY.md\` at session start for context from prior runs. Save important observations there. Your memory is isolated from other Claude Code sessions in this workspace via \`autoMemoryEnabled: false\` in your \`./.claude/settings.json\` — repo-wide auto-memory is off, so the manual index is your only memory source.

## Automatic Events

You receive \`[DASHBOARD EVENT]\` messages automatically when supervised agents change status. When you receive one:

- **idle/done**: Read the agent's final assistant message via \`read_agent_chat(agent_id, role: 'assistant', limit: 1)\` — clean structured chat, no PTY noise. If the agent posted a clear summary (e.g., "## Patch summary"), respond accordingly. Fall back to \`read_agent_log\` only when the chat read is empty or you need PTY-level detail (terminal output of a test run, raw error trace). If the agent is asking a question or awaiting approval, respond via \`send_message_to_agent\`. If work is complete, no action needed.
- **waiting_for_input**: When a supervised agent is waiting on user input (in-text question, terminal prompt, plan-mode approval), the dashboard sends \`[DASHBOARD EVENT] Agent waiting for input\` with a \`Waiting kind:\` and \`Excerpt:\` line. Read the agent log for context, decide a response, and reply with \`send_message_to_agent\` (text answers) or \`send_keys_to_agent\` (arrow-key pickers / Enter).
- **crashed**: Read the log to diagnose. Decide whether to restart (transient error) or escalate to the human (persistent failure).
- **context threshold (80%+)**: Compact the agent — read its log to summarize progress, launch a new agent via \`launch_agent\` with a role description containing the compacted context (what was accomplished, current state, what's next), then stop the old agent via \`stop_agent\`. This gives the work a fresh context window without losing continuity.
- **handoff_failed**: A prompt you (or anyone) sent to a worker was typed but the turn NEVER started — the worker is idle with the prompt sitting unsubmitted or dead. It will never emit an idle event for that prompt, so act immediately: \`read_agent_log\`, then \`send_keys_to_agent {key: "enter"}\` if the prompt is visible in the input box, or stop + relaunch if the agent is dead.
- **worker_stalled**: A worker has been \`working\` with zero output for a long stretch — presumed hung. Inspect the log and decide: nudge, wait, or stop + relaunch.

Keep responses brief — assess the event, take the necessary action via your MCP tools, then wait for the next event.

## Worker handoff handshake

\`send_message_to_agent\` and \`launch_agent\`'s initial prompt BLOCK until the worker's turn provably started (UserPromptSubmit hook, or a status flip to working) and say so in their result. Read that result before ending your turn:

- **HANDSHAKE OK** — the worker is genuinely working; you'll get an idle event when it finishes. Safe to end your turn.
- **HANDSHAKE UNCONFIRMED** — delivered, but no start proof (some providers lack one). Verify with \`read_agent_log\` before relying on it.
- **HANDSHAKE FAILED** — the turn never started and no idle event will ever come. Recover in THIS turn (re-press Enter via \`send_keys_to_agent\`, or relaunch); never end your turn assuming the handoff worked.

## Constraints

- Do NOT edit source code or run build/test commands
- Interact with workers ONLY through MCP tools (or curl fallback)
- Keep responses brief and action-oriented
- When in doubt, escalate to the human

## Decision Framework

**Tier 1 — Automatic:** Approve routine continuations, handle rate limits, flag context > 80%
**Tier 2 — Assisted:** Research complex technical questions, resolve conflicting approaches
**Tier 3 — Escalate:** Architectural decisions, security, scope changes, ambiguous requirements

## Online research

You have **WebSearch** and **WebFetch** for direct lookups, and the **Agent** tool (\`subagent_type: "general-purpose"\`) for multi-step research into source repos, docs, changelogs, or community threads. Reach for them — proactively, before treating a question as user-only — when the answer lives outside this codebase: a third-party CLI's behavior, a config format you don't recognize, a vendor flag, a platform-specific quirk, an unfamiliar error string.

**Direct WebSearch/WebFetch** when the answer fits on one page: a changelog entry, a doc paragraph, an issue thread.

**Research subagent** (\`Agent\`, general-purpose) when the dig is multi-step: reading several source files, cross-referencing PRs, chasing a behavior chain ("what does this hash cover" → find the hash function → find its callers → find their inputs). Cap the response (e.g. "under 400 words, GitHub permalinks where helpful") so the answer stays compressed and doesn't bloat your context.

**Triage** before escalating to the user — see behavioral.md B-11 (research-first / triage by impact) and B-12 (when to spawn a research subagent vs. direct lookup). Bothering the user is expensive; reaching for research is cheap.

## Multi-agent orchestration: two paths

When the user asks you to coordinate multiple agents, choose one of two paths:

### Path 1 — Dashboard-run orchestration (via the \`run_orchestration\` MCP tool)

Invoke a pre-built orchestration via the \`run_orchestration\` MCP tool (see the run-orchestration skill). The orchestration runs **detached inside the dashboard** — launching agents, relaying messages, gating turns, watching for the completion signal. You launch no \`scripts/*.js\`: you call the tool, it returns a \`runId\` immediately, then you monitor. Events arrive as \`[DASHBOARD EVENT]\` lines in your chat.

- **When to use:** there is an orchestration that matches the task. **GroupThink** produces a planning markdown via cross-provider deliberation and offers two modes — \`mode: 'serial'\` (default; Lead drafts, Reviewer is launched with that draft as kickoff, Lead writes plan) and \`mode: 'parallel'\` (3 rounds — both planners draft independently, cross-pollinate, synthesizer writes plan). Future orchestrations will cover scoping, fork-and-execute, etc.
- **How to discover:** call \`list_orchestrations\` (or read the catalog in the run-orchestration skill). Start one with \`run_orchestration({name, workspace_id, supervisor_id, topic, plan_path, mode})\`; poll \`get_orchestration_run({run_id})\`; abort with \`abort_orchestration({run_id})\`.
- **You drive it through the tool, not a script** — react to its \`[DASHBOARD EVENT]\` lines. Recovery on stall is a single call: \`run_orchestration({name:'groupthink', resume_run_id})\` from the stall event's resume hint. A legacy \`node scripts/groupthink-v2.js …\` hint can be replayed by passing the whole old line as \`legacy_command\`.

### Path 2 — Freeform supervision (you coordinate)

Use your MCP tools directly to launch agents, optionally group them into a team, brief them, and steer the work yourself. You make the round-by-round judgment calls.

- **Single worker:** \`launch_agent\` + \`send_message_to_agent\` for one-shot or ongoing work you'll babysit.
- **Team:** \`create_team\` with a template (\`mesh\` = all-to-all, \`pipeline\` = chain, \`custom\` = explicit edges). Team members get their own MCP tools (\`send_message\`, \`get_messages\`, etc.) to message each other directly — you do NOT relay messages, you set the structure and monitor.
- **When to use:** no scripted orchestration fits, the user wants ad-hoc multi-agent work, or the task is one-off enough that a script would be over-engineering.

The two paths can compose: a Path-1 orchestration can produce an artifact (e.g., a plan markdown) that you then hand to Path-2 workers to execute. Likewise, a Path-2 team can be a stepping stone toward identifying a workflow worth lifting into a Path-1 script later.

## Teams

*These are the Path 2 tools — use them when you're driving the coordination yourself rather than invoking a scripted orchestration.*

You can create teams of agents that communicate directly with each other via MCP tools. You define the team structure (members, channels, tasks) and agents coordinate autonomously within the boundaries you set. You do NOT relay messages between team members — they message each other directly.

### Team Management Tools

- **create_team** — Create a team with members, channels, and optional task board (args: workspace_id, name, description, template, members, channels, tasks)
- **disband_team** — Archive a team, saving manifest for resurrection (args: team_id)
- **add_team_member** — Add an agent to a team (args: team_id, agent_id, role). Injects MCP tools and notifies agent.
- **remove_team_member** — Remove an agent and clean up their channels (args: team_id, agent_id)
- **add_channel** — Add a communication channel between two members (args: team_id, from_agent, to_agent)
- **remove_channel** — Remove a channel (args: team_id, channel_id)
- **get_team** — Get full team status: members, channels, tasks, recent messages (args: team_id)
- **list_teams** — List all teams in workspace (args: workspace_id)
- **resurrect_team** — Resurrect a disbanded team from manifest (args: team_id)

### Templates

- **mesh** — All-to-all channels between members. Good for deliberation where every member should hear every other member's perspective.
- **pipeline** — Linear chain: A→B→C. Each member can talk to the next in the chain and back. Good for staged workflows (analysis → implementation → testing).
- **custom** — You define channels explicitly. Use when communication needs are asymmetric or selective.

### How Teams Work

When you create a team, each member agent receives MCP tools scoped to their team:
- \`send_message\` — Send a structured message to a teammate (enforced: only to agents in their approved channel list)
- \`get_messages\` — Check their inbox for messages from teammates
- \`get_tasks\` — View the shared task board
- \`update_task\` — Update task status and notes
- \`get_team_info\` — See who's on the team and who they can communicate with

Agents can only message teammates they have a channel to. The dashboard enforces this — unauthorized messages are rejected.

### Workflow

1. **Create team**: Identify a multi-agent task. Use \`create_team\` with appropriate template.
2. **Brief agents**: Send each member their initial instructions via \`send_message_to_agent\`. Tell them their role, the team task board, and that they should coordinate with teammates using their MCP tools.
3. **Monitor**: Use \`get_team\` periodically to check task progress and message flow. Agents handle routine coordination themselves.
4. **Intervene on exception**: Act on blocked agents or escalation requests. Read logs, adjust channels, or send guidance.
5. **Disband**: When work is complete, \`disband_team\` archives the team for potential resurrection.

### Deliberation

For multi-model deliberation between teammates, create a team with template \`mesh\` (all-to-all channels). Mix providers (Claude, Gemini, Codex) for diverse perspectives. Brief agents with the topic, let them debate through direct messages, then synthesize findings yourself when they converge or hit diminishing returns.

Note: this is distinct from the **GroupThink orchestration** (run via the \`run_orchestration\` MCP tool — see the run-orchestration skill), which drives the deliberation end-to-end inside the dashboard and writes a final markdown plan. Its serial mode is a Lead+Reviewer relay; its parallel mode runs two planners independently across 3 rounds (draft → cross-pollinate → synthesize). Use GroupThink when you want a structured planning artifact; use a \`mesh\` team when you want free-form N-agent deliberation.

## Platform notes (Windows + PowerShell 5.1)

**Quoting gotcha when launching native exes from PowerShell:** \`Start-Process -ArgumentList @(...)\` and \`powershell -Command\` both silently strip the quotes around any array element containing spaces before \`CreateProcess\` sees them. A flag like \`--topic="A B C"\` arrives at \`node\` as just \`--topic=A\` with \`B\` and \`C\` as orphan positional tokens — the launch looks fine but the script gets garbled args.

- **Prefer Bash (\`bash -lc "..."\`) for any launch passing multi-word args** — POSIX quoting survives intact through to CreateProcess.
- **Fallback inside PowerShell:** \`Start-Process cmd -ArgumentList @('/c', $singleCommandString)\` — cmd respects the quotes in the single command string verbatim.
- **Always verify** after launch with \`(Get-CimInstance Win32_Process -Filter "Name='node.exe'").CommandLine\`. If the recorded CommandLine is missing quotes you expected, the launch is broken even if the process started.
- When auditing a supervisor run that misbehaved with a truncated/garbled flag value (e.g. \`--topic\` arriving as a single word), suspect this quoting bug first.

## Notebooks (live kernel)

When the user is editing a \`.ipynb\` in the dashboard, the notebook surface is connected to a real Jupyter kernel. Prefer the dashboard notebook MCP tools so your executions land in the file via the contents API and the user's view updates live.

### Kernel tools

- **execute_cell** (notebook_path, cell_id, timeout?=60) — Run one code cell. Returns \`{ status, cell_id, execution_count, outputs_summary }\`. Outputs are compact: text truncated to ~5 KB, images shown as \`{ mime, bytes }\`.
- **execute_range** (notebook_path, from_cell_id, to_cell_id, timeout?=60) — Sequential, stops on first error.
- **execute_notebook** (notebook_path, timeout?=60) — Run every code cell top-to-bottom. Returns \`{ status, last_executed_cell_id, failed_cell_id?, error?, outputs_summary }\`.
- **interrupt_kernel** (notebook_path) — Interrupts whatever is running. **Affects the user's notebook view too** — only do this if you know they want it stopped.
- **restart_kernel** (notebook_path) — Clears in-memory state. The dashboard view and your tools auto-reattach.
- **get_kernel_state** (notebook_path) — \`{ attached, kernel_id, kernel_name, status, execution_state, last_execution_count }\`. Use this before driving a kernel you didn't open.

### Path conventions (important)

The Jupyter server's root_dir is \`/\`. \`notebook_path\` is **server-relative** — strip the leading slash:

- WSL absolute \`/home/user/foo.ipynb\` → \`home/user/foo.ipynb\`
- Windows absolute \`C:\\Users\\user\\foo.ipynb\` → \`mnt/c/Users/user/foo.ipynb\`

### Cell addressing

**Always address cells by their nbformat 4.5 \`id\` (a UUID-like string), never by index.** Indexes shift the moment anyone inserts a cell. Read the \`.ipynb\` JSON to find a cell's \`id\`, or call the \`Read\` tool on the file first.

### Gotchas

- If the notebook has not been opened in the dashboard, \`execute_cell\` may start a fresh \`python3\` session — fine if that's what you want, surprising if not.
- R kernels (IRkernel) buffer stdout until cell end. Don't expect streaming output for R — it lands when the cell finishes.
- Default timeout is 60s. If the cell legitimately takes longer (training, large I/O), pass a higher \`timeout\` rather than letting interrupt fire.
`;

export const SUPERVISOR_MEMORY_MD = `# Supervisor Memory

This file indexes the supervisor's persistent memory for this workspace.
Add entries as you learn important things about the agents, project, or decisions made.

<!-- Example entry:
- [decision_auth_approach.md](decision_auth_approach.md) - Chose JWT over sessions for auth, approved by human 2026-03-20
-->
`;

/** Supervisor settings — .dashboard/supervisor/.claude/settings.json
 *  Disables repo-wide auto-memory so the supervisor's manual ./memory/MEMORY.md
 *  index is the only memory source for the supervisor session.
 *  v2 adds autoCompactEnabled: false — long-running supervisor sessions must
 *  not silently auto-compact; context management is the dashboard's job. */
export const SUPERVISOR_CLAUDE_SETTINGS_JSON = `{
  "autoMemoryEnabled": false,
  "autoCompactEnabled": false
}
`;

/** Pre-autoCompact supervisor settings (v1) — kept verbatim so a v1
 *  workspace's on-disk settings.json can be hashed and silently upgraded to
 *  v2 (which adds autoCompactEnabled: false). */
export const SUPERVISOR_CLAUDE_SETTINGS_JSON_V1 = `{
  "autoMemoryEnabled": false
}
`;

/** Class IV worker scaffold — see plans/class-iv-worker-hook-scaffold.md.
 *  Written to <workspace>/.dashboard/workers/claude/CLAUDE.md on first
 *  supervised Claude worker launch. Shared cwd for N workers, read-only by
 *  convention. The "no TTY prompts" rule is load-bearing: workers end their
 *  turn with the question in plain text so the Stop hook → idle → supervisor
 *  notification pipeline carries the question through. */
export const WORKER_CLAUDE_MD = `# Worker Agent

You are a generic worker agent launched by the dashboard supervisor.
The supervisor is your only human-side interlocutor.

## How to ask questions

You do not have a human at your terminal. **Never invoke** \`AskUserQuestion\`,
plan-mode approval prompts, \`(y/n)\` confirmations, or any other interactive
blocking dialog. They will hang forever.

Instead, end your turn with the question in plain text. Your turn-end fires a
Stop hook that flips your dashboard status to \`idle\` and notifies your
supervisor. The supervisor reads your final assistant message (via
\`read_agent_chat\`) and routes the question to the human.

Examples of good turn endings when you need input:

> I've drafted the migration. Should I apply it to staging now, or do you want
> to review the SQL first?

> Two reasonable approaches: (a) extend the existing handler, (b) add a new
> route. Which would you like?

## You are supervised

Your supervisor watches your status via \`[DASHBOARD EVENT]\` messages.
When you go idle, the supervisor decides next steps. Trust that — end turns
cleanly with decisions and questions surfaced in plain text. Don't keep the
loop alive yourself; don't poll; don't loop on busy-work to avoid going idle.

## Working directory and scope

Your cwd is the worker template folder (\`.dashboard/workers/claude/\`), not
the workspace. Workspace root is provided via \`--add-dir\` at launch and via
the \`Workspace root:\` line in your initial system prompt. **Use absolute
paths for Read / Edit / Glob / Bash.** Relative paths from your cwd will not
find workspace files.

## No memory, stateless across sessions

There is no \`./memory/\` folder and no auto-memory. Do not write per-session
state into your cwd — that folder is shared with every other worker of your
provider, by design. Everything you need for your task is in your initial
prompt and the workspace files you can read.
`;

/** Class IV worker hook config — written to
 *  <workspace>/.dashboard/workers/claude/.claude/settings.json on first
 *  supervised Claude worker launch. \${CLAUDE_PROJECT_DIR} is auto-expanded
 *  by Claude Code at hook fire time (it points to the launch cwd, which is
 *  the template folder — we walk up two levels to the workspace root where
 *  .dashboard/scripts/dashboard-status.mjs lives).
 *  Schema verified against https://code.claude.com/docs/en/hooks.md —
 *  Stop uses the array-of-blocks shape and doesn't support matchers (any
 *  matcher field is silently ignored).
 *  v4 removes the SubagentStop hook: it fires when a Task-tool subagent
 *  finishes while the MAIN agent is still mid-turn, and its no-arg script
 *  invocation POSTed `idle` — flipping a visibly-working agent's card to idle
 *  (and pinging its supervisor) before the turn was done. Stop alone is the
 *  correct turn boundary.
 *  v5 adds autoCompactEnabled: false so workers never silently auto-compact
 *  mid-task regardless of the machine's user-level Claude settings. */
export const WORKER_CLAUDE_SETTINGS_JSON = `{
  "autoMemoryEnabled": false,
  "autoCompactEnabled": false,
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" session-start"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" working"
          }
        ]
      }
    ]
  }
}
`;

/** Pre-autoCompact Claude worker settings (v4) — kept verbatim so a v4
 *  workspace's on-disk settings.json can be hashed and silently upgraded to
 *  v5 (which adds autoCompactEnabled: false). */
export const WORKER_CLAUDE_SETTINGS_JSON_V4 = `{
  "autoMemoryEnabled": false,
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" session-start"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" working"
          }
        ]
      }
    ]
  }
}
`;

/** Pre-SubagentStop-removal Claude worker settings (v3) — kept verbatim so a
 *  v3 workspace's on-disk settings.json can be hashed and silently upgraded to
 *  v4 (which drops the idle-flipping SubagentStop hook). */
export const WORKER_CLAUDE_SETTINGS_JSON_V3 = `{
  "autoMemoryEnabled": false,
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" session-start"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\""
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" working"
          }
        ]
      }
    ]
  }
}
`;

/** Pre-SessionStart Claude worker settings (v2) — kept verbatim so a v2
 *  workspace's on-disk settings.json can be hashed and silently upgraded to v3
 *  (which adds the SessionStart hook). Written verbatim by the scaffolder —
 *  \${CLAUDE_PROJECT_DIR} stays literal — so the hash matches on-disk bytes. */
export const WORKER_CLAUDE_SETTINGS_JSON_V2 = `{
  "autoMemoryEnabled": false,
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\""
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \\"\${CLAUDE_PROJECT_DIR}/../../scripts/dashboard-status.mjs\\" working"
          }
        ]
      }
    ]
  }
}
`;

/** Class IV worker hook config (Codex) — written to
 *  <workspace>/.dashboard/workers/codex/.codex/config.toml on first supervised
 *  Codex worker launch. \${WORKSPACE_ROOT} is replaced at scaffold-write time
 *  with the absolute workspace path; Codex has no analog of Claude's
 *  \${CLAUDE_PROJECT_DIR}, so the path is materialized rather than expanded
 *  at hook fire time. Schema per https://developers.openai.com/codex/hooks —
 *  the Stop event fires on agent-turn-complete; Codex passes JSON via stdin
 *  (session_id, cwd, hook_event_name, model, turn_id). Our dashboard-status.mjs
 *  ignores stdin and reads AGENT_ID + DASHBOARD_PORT from process env (injected
 *  by the supervisor on isSupervised launches in src/main/supervisor/index.ts),
 *  so the single workspace-shared script serves Claude and Codex unchanged. */
export const WORKER_CODEX_CONFIG_TOML = `# Class IV worker hook config — see plans/class-iv-worker-hook-scaffold.md §12.
# Codex Stop hook fires when an agent turn completes. Our hook script reads
# AGENT_ID + DASHBOARD_PORT from env (injected at supervised-worker launch)
# and POSTs idle to the dashboard. \${WORKSPACE_ROOT} is materialized at
# scaffold-write time — Codex has no \${CLAUDE_PROJECT_DIR} analog.

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'node "\${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs"'
timeout = 30

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'node "\${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs" working'
timeout = 30

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "\${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs" session-start'
timeout = 30
`;

/** Pre-SessionStart Codex worker config (v2) — kept verbatim so a v2
 *  workspace's materialized config.toml can be hashed and silently upgraded to
 *  v3 (which adds the SessionStart hook). The \${WORKSPACE_ROOT} substitution
 *  and hash comparison both happen after the substitution at scaffold-write
 *  time, mirroring the v1→v2 path. */
export const WORKER_CODEX_CONFIG_TOML_V2 = `# Class IV worker hook config — see plans/class-iv-worker-hook-scaffold.md §12.
# Codex Stop hook fires when an agent turn completes. Our hook script reads
# AGENT_ID + DASHBOARD_PORT from env (injected at supervised-worker launch)
# and POSTs idle to the dashboard. \${WORKSPACE_ROOT} is materialized at
# scaffold-write time — Codex has no \${CLAUDE_PROJECT_DIR} analog.

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'node "\${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs"'
timeout = 30

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'node "\${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs" working'
timeout = 30
`;

/** Pre-UserPromptSubmit Codex config — kept verbatim so a v1 workspace's
 *  materialized config.toml can be hashed and silently upgraded to v2. The
 *  workspace-root substitution happens at scaffold-write time; the hash
 *  comparison is performed after substitution. */
export const WORKER_CODEX_CONFIG_TOML_V1 = `# Class IV worker hook config — see plans/class-iv-worker-hook-scaffold.md §12.
# Codex Stop hook fires when an agent turn completes. Our hook script reads
# AGENT_ID + DASHBOARD_PORT from env (injected at supervised-worker launch)
# and POSTs idle to the dashboard. \${WORKSPACE_ROOT} is materialized at
# scaffold-write time — Codex has no \${CLAUDE_PROJECT_DIR} analog.

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'node "\${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs"'
timeout = 30
`;

/** Class IV hook script — written to
 *  <workspace>/.dashboard/scripts/dashboard-status.mjs on first supervised
 *  worker launch. Reads AGENT_ID + DASHBOARD_PORT from the worker process env
 *  (injected at launch by the supervisor). Fire-and-forget POST with a 1.5s
 *  timeout so a slow / missing dashboard never blocks the user-visible hook.
 *  If the POST fails, inference (classes I–III) still drives status — degraded
 *  but not broken. */
/** FROZEN v≤6 worker hook script body, parameterized by the POST self-abort
 *  timeout (ms) and the v6 SubagentStop guard. Versions v4/v5/v6 differ ONLY
 *  in these two values, so a single builder keeps the frozen verbatim copies
 *  (used for silent-upgrade hashing) byte-identical apart from them — no risk
 *  of hand-copy drift breaking the hash. v7 diverges structurally and lives in
 *  {@link buildDashboardStatusScript} below. */
function buildDashboardStatusScriptV6(postAbortMs: number, ignoreSubagentStop = false): string {
  return `#!/usr/bin/env node
// Class IV worker hook script — see plans/class-iv-worker-hook-scaffold.md
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const agentId = process.env.AGENT_ID;
const port = process.env.DASHBOARD_PORT || '24678';
const host = process.env.DASHBOARD_HOST || '127.0.0.1';
if (!agentId) process.exit(0);
${ignoreSubagentStop ? `
// SubagentStop fires when a Task-tool subagent finishes while the MAIN agent
// is still mid-turn — posting idle here would flip a working agent's card to
// idle (and falsely ping its supervisor). Only Stop marks the turn boundary,
// so bail before any POST. Belt-and-suspenders for settings.json versions
// that still wire SubagentStop to this script (≤ v3). Claude-only: Codex has
// no SubagentStop and doesn't export CLAUDE_HOOK_EVENT_NAME.
if (process.env.CLAUDE_HOOK_EVENT_NAME === 'SubagentStop') process.exit(0);
` : ''}
// argv[2] selects the lifecycle event:
//   'session-start' → state 'active'  (SessionStart hook; canary proof the
//                       hook scaffold loaded — must NOT flip working/idle)
//   'working'       → state 'working' (UserPromptSubmit hook)
//   (default)       → state 'idle'    (${ignoreSubagentStop ? 'Stop hook' : 'Stop / SubagentStop hook'})
const rawState = process.argv[2];
let state, source;
if (rawState === 'session-start') {
  state = 'active';
  source = 'hook-session-start';
} else if (rawState === 'working') {
  state = 'working';
  source = 'hook-start';
} else {
  state = 'idle';
  source = 'hook-stop';
}
const body = JSON.stringify({ state, source, ts: Date.now() });
const url = \`http://\${host}:\${port}/api/agents/\${agentId}/status\`;
// Claude exports CLAUDE_HOOK_EVENT_NAME (e.g. 'Stop', 'SubagentStop',
// 'UserPromptSubmit'); Codex passes hook_event_name on stdin instead, so for
// Codex we tag it as 'codex'.
const hookEvent = process.env.CLAUDE_HOOK_EVENT_NAME || 'unknown';

try {
  const ac = new AbortController();
  // Self-abort raised to ≥ CONFIRM_WINDOW_FIRST_MS (synchronous submit
  // confirmation, plan §2.4) so a slow UserPromptSubmit POST isn't cancelled
  // before the dashboard's first confirm window can observe it.
  const timer = setTimeout(() => ac.abort(), ${postAbortMs});
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: ac.signal,
  });
  clearTimeout(timer);
} catch (err) {
  // L-C diagnosability: append an attempt record so a single grep over
  // <workspace>/.dashboard/pending-status.jsonl shows every hook that failed
  // to reach the dashboard. Stays best-effort — if even the appendFileSync
  // fails (e.g. read-only fs) we still swallow so the user-visible hook
  // never blocks. Inference fallback continues to drive status.
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const logPath = path.resolve(scriptDir, '..', 'pending-status.jsonl');
    const line = JSON.stringify({
      ts: Date.now(),
      agentId,
      hookEvent,
      host,
      port,
      url,
      error: err instanceof Error ? err.message : String(err),
    }) + '\\n';
    fs.appendFileSync(logPath, line);
  } catch {
    // Last-resort swallow — inference fallback still drives status.
  }
}
`;
}

/** Live (v7) Class IV hook script — P1 multi-transport delivery
 *  (HOOK_SYSTEM_DESIGN.md §5.3, plans/p1-hook-spool-multi-transport.md §1).
 *
 *  v7 contract:
 *    - Step 0: read hook JSON from stdin (64 KB cap raced against a 300 ms
 *      timeout with defensive listener-removal + destroy), resolve
 *      hookEventName stdin → CLAUDE_HOOK_EVENT_NAME → argv, extended
 *      SubagentStop bail (env OR stdin), then build ONE event record with a
 *      single ts — all transports carry identical bytes so the dashboard's
 *      dedupe key {agentId, ts, hookEventName, turnId} matches across channels.
 *    - Transport 1 — spool: ALWAYS appended (not just on HTTP failure). Path
 *      from DASHBOARD_SPOOL_PATH env; script-relative fallback only for old
 *      workspaces launched without the env (the CODEX_HOME copy would
 *      otherwise spool to ~/, invisible to the tailer).
 *    - Transport 2 — HTTP POST (2.5 s self-abort, ≥ CONFIRM_WINDOW_FIRST_MS).
 *    - Transport 3 — tmux pane option @agentdashboard-status via
 *      `tmux set-option -p -t $TMUX_PANE` (WSL lanes; skipped when not under
 *      tmux).
 *    - Every step in its own try/catch; unconditional exit 0 — a hook script
 *      failure must NEVER block or fail the user-visible hook.
 *
 *  Deliberately avoids JS template literals so the embedded script needs no
 *  backtick/dollar escaping inside this TS template. */
function buildDashboardStatusScript(): string {
  return `#!/usr/bin/env node
// Class IV worker hook script v7 — multi-transport delivery. See
// docs/HOOK_SYSTEM_DESIGN.md §5.3 and plans/p1-hook-spool-multi-transport.md §1.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// destroy() below can emit an ASYNC 'error' on some Node versions; an
// unhandled 'error' event escapes every try/catch and would violate the
// always-exit-0 contract, so attach a no-op handler BEFORE any read begins.
try { process.stdin.on('error', () => {}); } catch { /* exotic stdin */ }

async function main() {
  const agentId = process.env.AGENT_ID;
  const port = process.env.DASHBOARD_PORT || '24678';
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  if (!agentId) return;

  // ── Step 0: event construction (prework, not a transport) ─────────────
  // Read stdin (both frameworks pass hook JSON there) with a 64 KB cap raced
  // against a 300 ms timeout — the hook must never hang on a stdin that stays
  // open. On timeout: remove listeners, pause, destroy (each best-effort) so
  // the event loop drains and the process can exit.
  let stdinMeta = {};
  try {
    const raw = await new Promise((resolve) => {
      let buf = '';
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try {
          process.stdin.removeAllListeners('data');
          process.stdin.removeAllListeners('end');
          // Keep an 'error' no-op attached across the removal — destroy()'s
          // async error must always have a listener.
          process.stdin.removeAllListeners('error');
          process.stdin.on('error', () => {});
          process.stdin.pause();
          process.stdin.destroy();
        } catch { /* best-effort cleanup */ }
        resolve(buf);
      };
      timer = setTimeout(finish, 300);
      try {
        process.stdin.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.length >= 65536) { buf = buf.slice(0, 65536); finish(); }
        });
        process.stdin.on('end', finish);
      } catch { finish(); }
    });
    if (raw && raw.trim()) {
      try { stdinMeta = JSON.parse(raw); } catch { /* tolerate invalid JSON */ }
      if (stdinMeta === null || typeof stdinMeta !== 'object') stdinMeta = {};
    }
  } catch { /* stdin meta is best-effort */ }

  // hookEventName: stdin → CLAUDE_HOOK_EVENT_NAME env → argv-derived.
  const rawState = process.argv[2];
  const argvEventName = rawState === 'working' ? 'UserPromptSubmit'
    : rawState === 'session-start' ? 'SessionStart'
    : 'Stop';
  const stdinEventName = typeof stdinMeta.hook_event_name === 'string' ? stdinMeta.hook_event_name : '';
  const hookEventName = stdinEventName || process.env.CLAUDE_HOOK_EVENT_NAME || argvEventName;

  // SubagentStop guard (v6, extended to stdin): a Task-tool subagent finishing
  // mid-turn must not flip the still-working main agent idle. Bail before any
  // transport writes — nothing is spooled, posted, or set.
  if (process.env.CLAUDE_HOOK_EVENT_NAME === 'SubagentStop' || stdinEventName === 'SubagentStop') return;

  // argv[2] selects the lifecycle event:
  //   'session-start' → state 'active'  (SessionStart hook; canary proof —
  //                       must NOT flip working/idle)
  //   'working'       → state 'working' (UserPromptSubmit hook)
  //   (default)       → state 'idle'    (Stop hook)
  let state, source;
  if (rawState === 'session-start') { state = 'active'; source = 'hook-session-start'; }
  else if (rawState === 'working') { state = 'working'; source = 'hook-start'; }
  else { state = 'idle'; source = 'hook-stop'; }

  // ONE record, ONE ts — identical bytes on every transport.
  const record = { v: 1, agentId, state, source, ts: Date.now(), hookEventName };
  if (typeof stdinMeta.turn_id === 'string' && stdinMeta.turn_id) record.turnId = stdinMeta.turn_id;
  if (typeof stdinMeta.session_id === 'string' && stdinMeta.session_id) record.sessionId = stdinMeta.session_id;
  const body = JSON.stringify(record);
  const line = body + '\\n';

  // ── Transport 1: spool (always-write) ──────────────────────────────────
  try {
    let spoolPath = process.env.DASHBOARD_SPOOL_PATH;
    if (!spoolPath) {
      // Fallback for old workspaces launched without the env. NOTE: for the
      // CODEX_HOME copy of this script this resolves OUTSIDE the workspace —
      // which is exactly why the env form is primary.
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      spoolPath = path.resolve(scriptDir, '..', 'pending-status.jsonl');
    }
    fs.appendFileSync(spoolPath, line);
  } catch { /* spool is best-effort; HTTP/tmux may still deliver */ }

  // ── Transport 2: HTTP POST ─────────────────────────────────────────────
  try {
    const ac = new AbortController();
    // Self-abort ≥ CONFIRM_WINDOW_FIRST_MS (synchronous submit confirmation)
    // so a slow UserPromptSubmit POST isn't cancelled before the dashboard's
    // first confirm window can observe it.
    const timer = setTimeout(() => ac.abort(), 2500);
    await fetch('http://' + host + ':' + port + '/api/agents/' + agentId + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ac.signal,
    });
    clearTimeout(timer);
  } catch { /* HTTP is best-effort; the spool already has the event */ }

  // ── Transport 3: tmux pane option (WSL lanes) ──────────────────────────
  // Persist the record tmux-side so the dashboard's pane-option poll can
  // recover it even when both spool and HTTP were unreachable. -p -t targets
  // the pane named by TMUX_PANE explicitly (tmux sets it in every pane's
  // env); skip silently when not under tmux or tmux isn't on PATH.
  try {
    if (process.env.TMUX && process.env.TMUX_PANE) {
      spawnSync('tmux',
        ['set-option', '-p', '-t', process.env.TMUX_PANE, '@agentdashboard-status', line],
        { timeout: 1000, stdio: 'ignore' });
    }
  } catch { /* tmux option is best-effort */ }
}

try { await main(); } catch { /* nothing escapes — exit 0 below */ }
process.exit(0);
`;
}

export const DASHBOARD_STATUS_SCRIPT_MJS = buildDashboardStatusScript();

/** v6 verbatim (POST self-abort 2500ms + SubagentStop guard) — frozen so a v6
 *  workspace's on-disk dashboard-status.mjs can be hashed and silently
 *  upgraded to v7. Exists only as the hash source for previousHashes[6]. */
export const DASHBOARD_STATUS_SCRIPT_MJS_V6 = buildDashboardStatusScriptV6(2500, true);

/** v5 verbatim (POST self-abort 2500ms, no SubagentStop guard) — kept so a v5
 *  workspace's on-disk dashboard-status.mjs can be hashed and silently
 *  upgraded to v6. Exists only as the hash source for previousHashes[5]. */
export const DASHBOARD_STATUS_SCRIPT_MJS_V5 = buildDashboardStatusScriptV6(2500);

/** v4 verbatim (POST self-abort 1500ms) — kept so a v4 workspace's on-disk
 *  dashboard-status.mjs can be hashed and silently upgraded. Written by
 *  no scaffolder; exists only as the hash source for previousHashes[4]. */
export const DASHBOARD_STATUS_SCRIPT_MJS_V4 = buildDashboardStatusScriptV6(1500);

/** Pre-session-start hook script (v3) — kept verbatim so a v3 workspace's
 *  on-disk dashboard-status.mjs can be hashed and silently upgraded to v4
 *  (which adds the 'session-start' argv → state 'active' branch). Written
 *  verbatim by the scaffolder, so the hash matches on-disk bytes. */
export const DASHBOARD_STATUS_SCRIPT_MJS_V3 = `#!/usr/bin/env node
// Class IV worker hook script — see plans/class-iv-worker-hook-scaffold.md
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const agentId = process.env.AGENT_ID;
const port = process.env.DASHBOARD_PORT || '24678';
const host = process.env.DASHBOARD_HOST || '127.0.0.1';
if (!agentId) process.exit(0);

const rawState = process.argv[2];
const state = rawState === 'working' ? 'working' : 'idle';
const source = state === 'working' ? 'hook-start' : 'hook-stop';
const body = JSON.stringify({ state, source, ts: Date.now() });
const url = \`http://\${host}:\${port}/api/agents/\${agentId}/status\`;
// Claude exports CLAUDE_HOOK_EVENT_NAME (e.g. 'Stop', 'SubagentStop',
// 'UserPromptSubmit'); Codex passes hook_event_name on stdin instead, so for
// Codex we tag it as 'codex'.
const hookEvent = process.env.CLAUDE_HOOK_EVENT_NAME || 'unknown';

try {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: ac.signal,
  });
  clearTimeout(timer);
} catch (err) {
  // L-C diagnosability: append an attempt record so a single grep over
  // <workspace>/.dashboard/pending-status.jsonl shows every hook that failed
  // to reach the dashboard. Stays best-effort — if even the appendFileSync
  // fails (e.g. read-only fs) we still swallow so the user-visible hook
  // never blocks. Inference fallback continues to drive status.
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const logPath = path.resolve(scriptDir, '..', 'pending-status.jsonl');
    const line = JSON.stringify({
      ts: Date.now(),
      agentId,
      hookEvent,
      host,
      port,
      url,
      error: err instanceof Error ? err.message : String(err),
    }) + '\\n';
    fs.appendFileSync(logPath, line);
  } catch {
    // Last-resort swallow — inference fallback still drives status.
  }
}
`;

/** Codex supervised-worker hook profile.
 *
 *  WHY THIS EXISTS (see plans/global-hook-rollout-and-submit-confirmation.md and
 *  the 2026-05-29 investigation): Codex 0.134 does NOT read a worker-cwd
 *  `.codex/config.toml` unless that exact cwd is a *trusted project*, and
 *  `--dangerously-bypass-hook-trust` does not grant project trust. So the
 *  per-worker `.dashboard/workers/codex/.codex/config.toml` we scaffold is, in
 *  practice, never loaded — which is why codex `hook-start` events were 0 across
 *  the entire DB. A `--profile <name>` file, by contrast, is layered onto the
 *  user's base config as a User-layer (no project-trust gate), so it carries the
 *  hooks unconditionally. Combined with `--dangerously-bypass-hook-trust` on the
 *  launch (confirmed present in codex 0.134), the per-hook trust hash never has
 *  to be computed or interactively re-approved.
 *
 *  Written to `<CODEX_HOME>/dashboard-worker.config.toml` by
 *  `ensureCodexHookProfile()` and selected via `codex --profile dashboard-worker`.
 *  `__SCRIPT__` is replaced at write time with the absolute path of the shared
 *  dashboard-status.mjs (written alongside it in CODEX_HOME). The script reads
 *  AGENT_ID/DASHBOARD_PORT/DASHBOARD_HOST from env (injected at supervised-worker
 *  launch) and exits 0 when AGENT_ID is unset, so the profile is inert for any
 *  non-dashboard codex session that happens to select it. */
export const CODEX_WORKER_PROFILE_NAME = 'dashboard-worker';

export const CODEX_WORKER_PROFILE_TOML = `# AgentDashboard supervised-codex hook profile.
# Layered onto the user's base config via \`codex --profile ${CODEX_WORKER_PROFILE_NAME}\`.
# The hook script reads AGENT_ID/DASHBOARD_PORT/DASHBOARD_HOST from env (injected
# at supervised-worker launch) and POSTs status to the dashboard; it exits 0 when
# AGENT_ID is unset, so it is a no-op outside dashboard-launched workers.

# Codex hooks are on by default in current Codex, but the feature gate is cheap
# insurance: if a user's base config (or an older Codex) leaves the feature off,
# the [[hooks.*]] tables below parse fine yet NEVER fire. This MUST be a
# top-level table (NOT nested under any [profiles.*]) and use the [features]
# hooks key — the deprecated codex_hooks key is intentionally not used.
[features]
hooks = true

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'node "__SCRIPT__"'
timeout = 30

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'node "__SCRIPT__" working'
timeout = 30

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "__SCRIPT__" session-start'
timeout = 30
`;

/** Native skill — .dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md
 *  Frontmatter description loads at session start; body loads on demand via Read. */
export const SUPERVISOR_RUN_ORCHESTRATION_SKILL = `---
name: run-orchestration
description: Run an AgentDashboard orchestration — a multi-agent dashboard-driven workflow such as planning committee, scoping, fork-and-execute, or GroupThink. Use when the user names an orchestration or describes a goal that maps to one. Don't autonomously launch.
---

# Run Orchestration

Use this skill when the user asks to run any AgentDashboard **orchestration** — a multi-agent workflow (planning committee, scoping, fork-and-execute, etc.) that the dashboard drives end-to-end.

Orchestrations now run **in-process inside the dashboard** and are controlled through MCP tools. You launch **no** \`scripts/*.js\` — you call \`run_orchestration\`, it returns a \`runId\` immediately, and the run proceeds detached. Progress flows back as \`[DASHBOARD EVENT]\` lines in your chat, plus a pull channel (\`get_orchestration_run\`).

## MCP tools

- **list_orchestrations** — Discover available orchestrations: name, modes, parameters, defaults.
- **run_orchestration** — Start a run (detached). Returns \`{ runId }\` synchronously. Args: \`name\`, \`workspace_id\`, \`supervisor_id\`, plus orchestration params (\`topic\`, \`plan_path\`, \`mode\`, \`lead_provider\`, \`reviewer_provider\`, \`turn_timeout_ms\`). Resume with \`resume_run_id\` (preferred) or \`legacy_command\` (paste a whole old \`node scripts/groupthink-v2.js …\` line).
- **get_orchestration_run** — Pull current status/progress for a \`run_id\` (status, turn/round, members, last error).
- **abort_orchestration** — Abort a run by \`run_id\`; cleans up member agents and emits \`orchestration.groupthink.aborted\`.

## Available orchestrations

| Name | How to run | Purpose |
|---|---|---|
| \`groupthink\` | \`run_orchestration({name:'groupthink', workspace_id, supervisor_id, topic, plan_path, mode})\` | Cross-provider deliberation that writes a worker-ready plan. \`mode:'serial'\` (default — Lead drafts, Reviewer launched with that draft as kickoff, Lead writes plan) or \`mode:'parallel'\` (3 rounds — both planners draft independently, cross-pollinate, synthesizer writes plan). |

**Legacy resume.** Older plans/\`.runs\` may carry a \`node scripts/groupthink-v2.js … --resume-lead-id=… --resume-reviewer-id=…\` resume_hint. Don't run that script — pass the whole line through \`run_orchestration({name:'groupthink', workspace_id, supervisor_id, legacy_command:"<the whole old line>"})\`. The dashboard parses it into structured resume params and runs the in-process runner. (\`scripts/groupthink-v2.js\` still exists only as a thin compat shim that forwards to this same tool.)

Call \`list_orchestrations\` for the authoritative parameter list; new orchestrations appear there automatically.

## Workflow

### 1. Identify the orchestration

The user will name one (e.g., "run a GroupThink on X") or describe a goal that maps to one. If unclear, ask. Don't guess — orchestrations launch real agents and burn real tokens. Call \`list_orchestrations\` to confirm the name and its parameters.

### 2. Discover IDs

Every run needs a \`workspace_id\` and a \`supervisor_id\`. You are the supervisor: use \`list_agents\` to find your own agent record (the supervisor for this workspace) and read its \`id\` (→ \`supervisor_id\`) and \`workspaceId\` (→ \`workspace_id\`). If exactly one active supervisor for the current workspace isn't identifiable, stop and report the ambiguity.

### 3. Construct and confirm the call

Fill in required + useful optional params, e.g.:

\`\`\`
run_orchestration({
  name: 'groupthink',
  workspace_id: '<ws-id>',
  supervisor_id: '<sup-id>',
  topic: 'Plan the X migration',
  plan_path: 'plans/x-migration.md',   // relative to workspace root
  mode: 'serial',                       // or 'parallel'
})
\`\`\`

Confirm with the user before launching anything that will burn tokens — show the constructed call. Don't autonomously launch.

### 4. Launch (detached) and return to idle

\`run_orchestration\` returns \`{ runId }\` in milliseconds; the run continues inside the dashboard. Tell the user the \`runId\`, then stop working. The orchestration drives itself and sends \`[DASHBOARD EVENT]\` messages to your input as it progresses.

### 5. Watch for events

When a \`[DASHBOARD EVENT]\` arrives in your chat:

- **\`groupthink.complete\`**: the plan was written (path in the message). Acknowledge; no action unless the user asks.
- **\`orchestration.groupthink.stalled\`**: the payload carries a \`resume_hint\`. Typically \`{tool:'run_orchestration', params:{resumeRunId}}\` — resume with \`run_orchestration({name:'groupthink', workspace_id, supervisor_id, resume_run_id:'<id>'})\`. Decide based on the payload (reason, turns/rounds elapsed, planner ids). When in doubt, escalate to the user.
- **\`orchestration.groupthink.aborted\`**: the run was aborted (by you, or by a dashboard restart's boot-reconcile, which also emits a resume_hint). Diagnose via \`get_orchestration_run\`, then resume or escalate.

You can also pull status anytime with \`get_orchestration_run({run_id})\` instead of waiting for an event.

### 6. Inspect agents during a run

Read what planners are saying mid-run without disturbing the run:

- \`read_agent_chat\` (preferred): structured turn-complete messages.
- \`read_agent_log\` (fallback): raw terminal output.

Don't \`send_message_to_agent\` to a planner mid-run unless the run is stalled — you'll race the dashboard's relay loop. To stop a run cleanly, use \`abort_orchestration\`.

## File-write convention

Orchestrations and the agents they launch should not write to paths under \`.claude/\`. Claude Code's permission system gates edits there even with bypass-permissions on, hanging worker forks at an interactive dialog. Plan markdown and any agent-edited files belong outside \`.claude/\` — typically under \`plans/\` or the workspace root.

## Constraints

- Run orchestrations only when the user asks. Don't autonomously launch them.
- Confirm the constructed call with the user before launching, especially for non-trivial topics.
- \`list_orchestrations\` is the source of truth for each orchestration's parameters and defaults.
- After launch, return to idle. Don't poll in a loop; let \`[DASHBOARD EVENT]\` messages drive your wake-ups (use \`get_orchestration_run\` for an on-demand status check).
`;

/** Native skill — .dashboard/supervisor/.claude/skills/orchestration-spike/SKILL.md */
export const SUPERVISOR_ORCHESTRATION_SPIKE_SKILL = `---
name: orchestration-spike
description: Run the disposable orchestration smoke test that launches a detached Node process driving planner and worker agents through the dashboard HTTP API. Use only when the user explicitly asks to run the orchestration spike.
---

# Orchestration Spike

Use this skill only when the user asks to run the orchestration spike.

This is a disposable smoke test. It launches a detached Node process, then returns to idle while the script drives planner and worker agents through the AgentDashboard HTTP API.

## Preconditions

- Run from this supervisor agent's shell.
- Abort if AgentDashboard's API is not reachable.
- Abort if you cannot identify exactly one active supervisor for the current workspace.

## Discover API, Supervisor, And Workspace

Use \`GET /api/agents\` and filter active agents where \`isSupervisor\` is \`true\`. Active means status is not \`done\` or \`crashed\`.

Choose the API host and port this way:

- Prefer \`http://127.0.0.1:24678\`.
- If that fails, try ports \`24679\`, \`24680\`, and \`24681\`.
- In WSL, use the Windows host IP from \`/etc/resolv.conf\` if \`127.0.0.1\` cannot connect.

Identify the current supervisor by matching its \`workingDirectory\` to the current shell directory. The current directory should be \`.dashboard/supervisor\` for this workspace. Use that agent's \`id\` as \`supervisorId\` and its \`workspaceId\` as \`workspaceId\`.

If the filtered current-workspace supervisor count is not exactly one, stop and report the ambiguity.

## Launch Detached Spike

Create a run id and log path:

\`\`\`bash
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LOG="plans/.runs/spike-\${RUN_ID}.log"
mkdir -p "plans/.runs"
\`\`\`

In Bash, WSL, or Git Bash, launch with:

\`\`\`bash
nohup node scripts/orchestration-spike.js \\
  --run-id "$RUN_ID" \\
  --task "Create hello.py and update the spike plan." \\
  --workspace-id "$WORKSPACE_ID" \\
  --supervisor-id "$SUPERVISOR_ID" \\
  --api-host "$API_HOST" \\
  --api-port "$API_PORT" \\
  --quiet \\
  > "$LOG" 2>&1 &
\`\`\`

In PowerShell or a Windows shell, launch with:

> **Quoting gotcha (PowerShell 5.1):** \`Start-Process -ArgumentList @(...)\` and \`powershell -Command\` both silently strip the quotes around array elements containing spaces (so \`--task "Create hello.py..."\` arrives as just \`--task\` with the rest as orphan tokens). Prefer Bash; fallback is \`cmd /c\` with a single command string. Verify with \`(Get-CimInstance Win32_Process -Filter "Name='node.exe'").CommandLine\`.

\`\`\`powershell
# Preferred: shell out to Bash. POSIX quoting works.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
bash -lc "mkdir -p plans/.runs && nohup node scripts/orchestration-spike.js --run-id '$RunId' --task 'Create hello.py and update the spike plan.' --workspace-id '$WorkspaceId' --supervisor-id '$SupervisorId' --api-host '$ApiHost' --api-port '$ApiPort' --quiet > plans/.runs/spike-$RunId.log 2>&1 &"

# Fallback: cmd /c with a single command-line string. cmd respects the quotes verbatim.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
$Log = "plans\\.runs\\spike-$RunId.log"
New-Item -ItemType Directory -Force "plans\\.runs" | Out-Null
$Cmd = 'node scripts\\orchestration-spike.js --run-id "' + $RunId + '" --task "Create hello.py and update the spike plan." --workspace-id "' + $WorkspaceId + '" --supervisor-id "' + $SupervisorId + '" --api-host "' + $ApiHost + '" --api-port "' + $ApiPort + '" --quiet > "' + $Log + '" 2>&1'
Start-Process -WindowStyle Hidden cmd -ArgumentList @('/c', $Cmd)

# DO NOT use: Start-Process -FilePath node -ArgumentList @(...).
# PS 5.1 strips the quotes around any element containing spaces before CreateProcess.
\`\`\`

After launching, tell the user the run id and log path, then stop working. The detached script will send \`[DASHBOARD EVENT]\` messages back to this supervisor:

- \`Spike: planners launched\`
- \`Spike: consensus check complete\`
- \`Spike: plan written\`
- \`Spike: phase-1 done\`
- \`Spike: complete\`

It may send \`Spike: aborted\` if the smoke test fails.

## Agent file-write convention

The spike's plan markdown is intentionally written to **repo root**
(\`spike-hello-world.md\`), not under \`.claude/\`. Claude Code's permission
system gates edits inside \`.claude/\` even with bypass-permissions on, which
hangs worker forks on an interactive confirmation dialog. When iterating on
this spike or writing similar orchestrations, keep agent-edited files outside
\`.claude/\`. See \`docs/ORCHESTRATION_SPIKE.md\` for the run that surfaced this.
`;

/** read-agent-log.sh — .dashboard/supervisor/scripts/read-agent-log.sh */
export const SCRIPT_READ_AGENT_LOG = `#!/usr/bin/env bash
# Read the last N lines of an agent's terminal log via the dashboard HTTP API.
# Usage: read-agent-log.sh <agent-id> [lines]

AGENT_ID="\$\{1:?Usage: read-agent-log.sh <agent-id> [lines]\}"
LINES="\$\{2:-50\}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf "\$\{API_BASE\}/api/agents/\$\{AGENT_ID\}/log?lines=\$\{LINES\}" 2>&1)
if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to read agent log. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "\$RESPONSE"
`;

/** list-agents.sh — .dashboard/supervisor/scripts/list-agents.sh */
export const SCRIPT_LIST_AGENTS = `#!/usr/bin/env bash
# List all agents managed by AgentDashboard via the HTTP API.
# Output: JSON array of agents with id, title, status, context info

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf "\$\{API_BASE\}/api/agents" 2>&1)
if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to list agents. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "\$RESPONSE"
`;

/** send-message.sh — .dashboard/supervisor/scripts/send-message.sh */
export const SCRIPT_SEND_MESSAGE = `#!/usr/bin/env bash
# Send a message to an agent via the dashboard HTTP API.
# Usage: send-message.sh <agent-id> "<message>"
#
# SAFETY: Only send to agents in idle/waiting status.
# The API will reject messages to working agents.

AGENT_ID="\$\{1:?Usage: send-message.sh <agent-id> \\"<message>\\"\}"
MESSAGE="\$\{2:?Usage: send-message.sh <agent-id> \\"<message>\\"\}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf -X POST "\$\{API_BASE\}/api/agents/\$\{AGENT_ID\}/input" \\
  -H "Content-Type: application/json" \\
  -d "{\\"text\\": \\"\$\{MESSAGE\}\\"}" 2>&1)

if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to send message. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "Sent to \$AGENT_ID: \$MESSAGE"
echo "\$RESPONSE"
`;

/** get-context-stats.sh — .dashboard/supervisor/scripts/get-context-stats.sh */
export const SCRIPT_GET_CONTEXT_STATS = `#!/usr/bin/env bash
# Get context window stats for a specific agent via the dashboard HTTP API.
# Usage: get-context-stats.sh <agent-id>

AGENT_ID="\$\{1:?Usage: get-context-stats.sh <agent-id>\}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf "\$\{API_BASE\}/api/agents/\$\{AGENT_ID\}/context-stats" 2>&1)
if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to get context stats. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "\$RESPONSE"
`;

/** Map model ID patterns to their context window sizes */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'claude-opus-4-6': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'claude-opus-4-1': DEFAULT_CONTEXT_WINDOW_TOKENS,
  'claude-opus-4-20250514': DEFAULT_CONTEXT_WINDOW_TOKENS,
  'claude-sonnet-4-6': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'claude-haiku-4-5': DEFAULT_CONTEXT_WINDOW_TOKENS,
  'claude-sonnet-4-5': DEFAULT_CONTEXT_WINDOW_TOKENS,
  'opusplan': DEFAULT_CONTEXT_WINDOW_TOKENS,
  'opus': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'sonnet': DEFAULT_CONTEXT_WINDOW_TOKENS,
  'haiku': DEFAULT_CONTEXT_WINDOW_TOKENS,
  // Gemini — substring match catches `gemini-3-flash-preview` via `gemini-3-flash` etc.
  'gemini-3-pro': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'gemini-3-flash': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'gemini-2.5-pro': EXTENDED_CONTEXT_WINDOW_TOKENS,
  'gemini-2.5-flash': EXTENDED_CONTEXT_WINDOW_TOKENS,
};

/**
 * Gauge cap for context tracking: regardless of the model's true window
 * (1M for [1m] Claude or Codex GPT models), the dashboard treats 200K as
 * 100%. Applied at window-resolution time in the claude and codex readers;
 * gemini keeps its real window.
 */
export const CONTEXT_GAUGE_CAP_TOKENS = 200_000;

export function getContextWindowForModel(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes('[1m]') || lower.includes('context-1m')) {
    return EXTENDED_CONTEXT_WINDOW_TOKENS;
  }
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) return value;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
