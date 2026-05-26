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
- **send_message_to_agent** — Send input to an idle/waiting agent (args: agent_id, message). Rejects if agent is working.
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

Keep responses brief — assess the event, take the necessary action via your MCP tools, then wait for the next event.

## Constraints

- Do NOT edit source code or run build/test commands
- Interact with workers ONLY through MCP tools (or curl fallback)
- Keep responses brief and action-oriented
- When in doubt, escalate to the human

## Decision Framework

**Tier 1 — Automatic:** Approve routine continuations, handle rate limits, flag context > 80%
**Tier 2 — Assisted:** Research complex technical questions, resolve conflicting approaches
**Tier 3 — Escalate:** Architectural decisions, security, scope changes, ambiguous requirements

## Multi-agent orchestration: two paths

When the user asks you to coordinate multiple agents, choose one of two paths:

### Path 1 — Scripted orchestration (programmatic)

Invoke a pre-built orchestration via the \`run-orchestration\` skill. The script drives the multi-agent workflow end-to-end — launching agents, relaying messages, gating turns, watching for the completion signal. You invoke, then monitor; the script handles the loop. Events arrive as \`[DASHBOARD EVENT]\` lines in your chat.

- **When to use:** there is an orchestration that matches the task. **GroupThink** (the only one today) produces a planning markdown via cross-provider Lead+Reviewer deliberation. Future orchestrations will cover scoping, fork-and-execute, etc.
- **How to discover:** read the catalog in the \`run-orchestration\` skill (lists available orchestrations and points at each one's manual under \`scripts/<name>.md\`).
- **You do not edit the script body** — you invoke it with parameters and react to its events. Recovery on stall is also scripted: re-invoke with the resume flags from the stall event.

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

Note: this is distinct from the **GroupThink orchestration** (\`scripts/groupthink-v1.js\`, run via the \`run-orchestration\` skill), which is a two-planner Lead+Reviewer pipeline that writes a final markdown plan. Use that when you want a structured planning artifact; use a \`mesh\` team when you want free-form N-agent deliberation.

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
 *  index is the only memory source for the supervisor session. */
export const SUPERVISOR_CLAUDE_SETTINGS_JSON = `{
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
 *  Stop / SubagentStop use the array-of-blocks shape and don't support
 *  matchers (any matcher field is silently ignored). */
export const WORKER_CLAUDE_SETTINGS_JSON = `{
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
export const DASHBOARD_STATUS_SCRIPT_MJS = `#!/usr/bin/env node
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

/** Native skill — .dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md
 *  Frontmatter description loads at session start; body loads on demand via Read. */
export const SUPERVISOR_RUN_ORCHESTRATION_SKILL = `---
name: run-orchestration
description: Run an AgentDashboard orchestration — a multi-agent script-driven workflow such as planning committee, scoping, fork-and-execute, or GroupThink. Use when the user names an orchestration or describes a goal that maps to one. Don't autonomously launch.
---

# Run Orchestration

Use this skill when the user asks to run any AgentDashboard **orchestration** — a multi-agent script-driven workflow (planning committee, scoping, fork-and-execute, etc.).

This is the generic playbook. The orchestration-specific details (parameters, events, recovery) live in each orchestration's own manual under \`scripts/<name>.md\`.

## Available orchestrations

| Name | Script | Manual | Purpose |
|---|---|---|---|
| \`groupthink-v1\` | \`scripts/groupthink-v1.js\` | \`scripts/groupthink-v1.md\` | Two-agent cross-provider deliberation producing a planning markdown |

When new orchestrations are added, they should appear in this table and ship with a \`scripts/<name>.md\` manual matching the structure of \`groupthink-v1.md\`.

## Workflow

### 1. Identify the orchestration

The user will name one (e.g., "run a GroupThink on X") or describe a goal that maps to one. If unclear, ask. Don't guess — orchestrations launch real agents and burn real tokens.

### 2. Read the orchestration's manual

Open \`scripts/<name>.md\` and read the **When to use**, **Parameters**, **Events emitted**, and **Recovery contract** sections. Each manual is self-contained — every flag, every event, every exit code is documented there.

### 3. Discover IDs

Every orchestration needs a \`workspaceId\` and a \`supervisorId\`. Find them via the dashboard API:

\`\`\`bash
curl -s http://127.0.0.1:24678/api/agents | jq '.[] | select(.isSupervisor) | {id, workspaceId, title, status}'
\`\`\`

Choose the API host this way:

- Prefer \`http://127.0.0.1:24678\`.
- If that fails, try ports \`24679\`, \`24680\`, \`24681\`.
- In WSL, use the Windows host IP from \`/etc/resolv.conf\` if \`127.0.0.1\` cannot connect.

Identify the current supervisor by matching its \`workingDirectory\` to the current shell directory (typically \`.dashboard/supervisor\` for this workspace). Use that agent's \`id\` as \`supervisorId\` and its \`workspaceId\` as \`workspaceId\`.

If exactly one active supervisor isn't found for the current workspace, stop and report the ambiguity.

### 4. Construct the invocation

Fill in the orchestration's required and useful optional flags. Most orchestrations take this shape:

\`\`\`bash
node scripts/<name>.js \\
  --workspaceId=<ws-id> \\
  --supervisorId=<sup-id> \\
  [orchestration-specific flags]
\`\`\`

Confirm with the user before launching anything that will burn tokens — show the constructed command. Don't autonomously launch.

### 5. Launch detached

Orchestrations run in the background. Launch the script and return to idle. The script will send \`[DASHBOARD EVENT]\` messages to your input as it progresses.

In Bash / WSL / Git Bash:

\`\`\`bash
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
LOG="plans/.runs/<name>-\${RUN_ID}.log"
mkdir -p "plans/.runs"
nohup node scripts/<name>.js [args...] > "$LOG" 2>&1 &
\`\`\`

In PowerShell or a Windows shell:

> **Quoting gotcha (PowerShell 5.1):** \`Start-Process -ArgumentList @(...)\` and \`powershell -Command\` both silently strip the quotes around any array element containing spaces before \`CreateProcess\` sees them. A flag like \`--topic="A B C"\` arrives at \`node\` as just \`--topic=A\` with \`B\` and \`C\` as orphan positional tokens. **Prefer Bash via \`bash -lc\` — POSIX quoting survives intact.** Fallback: \`cmd /c\` with a single command-line string (cmd respects the quotes verbatim). Always verify the launch with \`(Get-CimInstance Win32_Process -Filter "Name='node.exe'").CommandLine\`.

\`\`\`powershell
# Preferred: shell out to Bash. POSIX quoting works.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
bash -lc "mkdir -p plans/.runs && nohup node scripts/<name>.js --workspaceId=<ws-id> --supervisorId=<sup-id> --topic='Multi-word topic survives intact' > plans/.runs/<name>-$RunId.log 2>&1 &"

# Fallback: cmd /c with a single command-line string. cmd respects the quotes verbatim.
$RunId = "$(Get-Date -Format yyyyMMddHHmmss)-$PID"
$Log = "plans\\.runs\\<name>-$RunId.log"
New-Item -ItemType Directory -Force "plans\\.runs" | Out-Null
$Cmd = 'node scripts\\<name>.js --workspaceId=<ws-id> --supervisorId=<sup-id> --topic="Multi-word topic" > "' + $Log + '" 2>&1'
Start-Process -WindowStyle Hidden cmd -ArgumentList @('/c', $Cmd)

# DO NOT use: Start-Process -FilePath node -ArgumentList @(...).
# PS 5.1 strips the quotes around any element containing spaces before CreateProcess.
\`\`\`

After launching, tell the user the run id and log path, then stop working. The orchestration drives itself.

### 6. Watch for events

Each orchestration documents the \`[DASHBOARD EVENT]\` strings it emits. When one arrives in your chat:

- **Happy path events** (e.g. \`*.complete\`, \`*.turn_complete\`): acknowledge, no action needed unless the user asks.
- **\`*.stalled\`**: read the manual's **Recovery contract** section. Typically you'll have three options — steer-and-resume, accept-partial, or abandon. Decide based on the payload (turns elapsed, last exchange, agent state). When in doubt, escalate to the user.
- **\`*.aborted\`**: something went wrong. Read the orchestration's run log at the path printed at launch, diagnose, and either retry or escalate.

### 7. Inspect agents during a run

You can read what agents are saying mid-run without disturbing the orchestration:

- \`read_agent_chat\` (preferred for orchestrations): structured turn-complete messages.
- \`read_agent_log\` (fallback): raw terminal output.

Don't \`send_message_to_agent\` to a planner mid-run unless the orchestration is stalled — you'll race the script's relay loop.

## File-write convention

Orchestrations and the agents they launch should not write to paths under \`.claude/\`. Claude Code's permission system gates edits there even with bypass-permissions on, hanging worker forks at an interactive dialog. Plan markdown, run logs, and any agent-edited files belong outside \`.claude/\` — typically under \`plans/\` or the workspace root.

## Constraints

- Run orchestrations only when the user asks. Don't autonomously launch them.
- Confirm the constructed invocation with the user before launching, especially for non-trivial topics.
- Each orchestration's manual is the source of truth for its flags and events. If the manual disagrees with this skill, follow the manual.
- After launch, return to idle. Don't poll the dashboard; let \`[DASHBOARD EVENT]\` messages drive your wake-ups.
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
