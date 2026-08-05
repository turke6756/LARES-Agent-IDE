const { decidePollAction } = require('./mcp-supervisor-poll');

function getOrchestrationToolDefinitions() {
  return [
    {
      name: 'launch_agent',
      description: 'Launch a new worker agent in a workspace. Optionally use a template or persona for pre-configured identity/prompt. When `prompt` is provided, the dashboard writes it into the agent\'s input buffer and presses Enter to submit (provider-appropriate: CR for Claude on Windows / kitty-encoded Enter for Codex and for WSL agents). Pass `submit: false` to leave the prompt in the buffer without submitting (useful when the caller wants to append more input via send_keys_to_agent before the agent processes the turn). For codex agents, pass `fresh_session: true` to launch without `codex resume` so the codex CLI mints a fresh conversation rather than inheriting a prior rollout in this workspace — the dashboard still discovers and binds the new session id.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: the workspace ID. Defaults to your own workspace (auto-scoped from your identity).' },
          title: { type: 'string', description: 'Title for the agent.' },
          role_description: { type: 'string', description: 'Optional role description.' },
          prompt: { type: 'string', description: 'Optional initial prompt to send after launch. By default the dashboard auto-submits with a provider-appropriate Enter — set `submit: false` to suppress.' },
          submit: { type: 'boolean', description: 'Whether to auto-submit the initial prompt with Enter (default: true). Only relevant when `prompt` is provided. Pass false to leave the prompt typed but unsubmitted in the input buffer.' },
          template_id: { type: 'string', description: 'Optional template ID. Agent inherits the template persona, prompt, provider, etc.' },
          persona: { type: 'string', description: 'Persona subdirectory name under .claude/agents/. Agent inherits its CLAUDE.md as system instructions.' },
          system_prompt: { type: 'string', description: 'Optional identity prompt injected as the first message. Overrides template system_prompt.' },
          provider: { type: 'string', enum: ['claude', 'codex', 'grok', 'agy'], description: 'AI provider (default: claude). Gemini is discontinued; use Antigravity (`agy`).' },
          command: { type: 'string', description: 'Custom command to launch the agent process. Overrides the provider default.' },
          working_directory: { type: 'string', description: 'Working directory for the agent. Defaults to workspace root.' },
          auto_restart: { type: 'boolean', description: 'Auto-restart the agent on crash (default: true).' },
          supervised: { type: 'boolean', description: 'Whether the supervisor is notified on agent status changes (default: true for supervisor-launched workers — set false to opt out).' },
          is_researcher: { type: 'boolean', description: 'Launch the workspace RESEARCHER role-lane (default: false). The researcher browses + researches the web and writes findings into .lares/research/inbox/, but cannot run Bash, edit code, run notebooks, or launch agents. Claude-only (non-claude is rejected). When true, the app manages cwd/command/tools and the browser MCP — `provider`, `command`, `template_id`, and `persona` are ignored.' },
          mode: { type: 'string', enum: ['worker', 'supervisor-peer'], description: 'Launch class (default: worker). `worker` launches an owned child under you. `supervisor-peer` launches a TOP-LEVEL peer supervisor with NO owner edge (renders un-nested), with the supervisor toolset and .lares/supervisor cwd. Peer mode is the ONLY way to launch into a workspace other than your own (pass `workspace_id`), and cross-workspace peer launch requires supervisor privilege. `supervisor-peer` is incompatible with `is_researcher`/`persona`.' },
          fresh_session: { type: 'boolean', description: 'Codex-only hint (default: false). When true, the agent launches without `codex resume` so the codex CLI mints a fresh conversation rather than inheriting any prior rollout in this workspace. The dashboard still discovers and binds the new session id. Use this when you want a clean context but parallel agents in the same workspace. No-op for non-codex providers.' },
          plan_id: { type: 'string', description: 'Planning-surface rail: an existing registered plan id. Frozen onto the agent at launch and injected as AGENT_DASHBOARD_PLAN_ID. The launch route 400s an unknown plan_id.' },
          section_anchor: { type: 'string', description: 'Planning-surface rail: the section this agent is dispatched to update. Frozen at launch and injected as AGENT_DASHBOARD_PLAN_SECTION. The plan-bound brief must identify the owned write target and required durable writeback.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'stop_agent',
      description: 'Stop a running agent. Use with caution.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to stop.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'fork_agent',
      description: "Fork an agent's session to fresh context. Use for context compaction.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to fork.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'revive_agent',
      description:
        'Revive a DONE or CRASHED terminal agent: relaunch its ORIGINAL session (resume) in its ' +
        'original workspace and working directory, top-level (no new owner edge). Use to bring a ' +
        'finished/crashed agent back with its full prior context instead of launching a fresh one. ' +
        'Cross-workspace and same-workspace revival BOTH require supervisor privilege (revival is a ' +
        'launch-class mutation) and every attempt is audited. Provider support: revive supports ' +
        'claude and codex. Historical Gemini agents remain readable, but Gemini is discontinued ' +
        'and cannot be revived; use Antigravity (`agy`) for new work. Optionally pass ' +
        '`message` to queue a wake instruction — it is delivered only AFTER the revived agent can ' +
        'orient (the dashboard prepends a get_my_context orientation preamble). Pass `force: true` ' +
        'to revive a supervisor even when a live successor supervisor already exists in its workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The terminal (done/crashed) agent ID to revive.' },
          message: { type: 'string', description: 'Optional wake message queued for delivery after the revived agent orients (get_my_context preamble is prepended by the dashboard).' },
          force: { type: 'boolean', description: 'Revive a supervisor even if a live successor supervisor exists in its workspace (default: false). Ignored for non-supervisor targets.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'create_persona',
      description: 'Create a new persistent agent persona directory under .claude/agents/. Creates the folder with CLAUDE.md and memory/MEMORY.md scaffolding.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: the workspace ID. Defaults to your own workspace (auto-scoped from your identity).' },
          name: { type: 'string', description: 'Persona name (lowercase, hyphens, underscores only). Becomes the directory name under .claude/agents/.' },
          claude_md: { type: 'string', description: 'Content for the persona CLAUDE.md file. Defines the agent identity and behavior.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'send_keys_to_agent',
      description:
        'Send keystrokes to an agent\'s PTY without bracketed-paste wrapping. ' +
        'Use this to drive interactive widgets — AskUserQuestion pickers, codex slash-command menus, ' +
        'arrow-key navigation, Ctrl-C / Ctrl-D, Tab completion, digit-jump, filter typing — anywhere ' +
        'the target needs to see each byte as a real key event instead of one pasted blob. ' +
        'For prose messages, use `send_message_to_agent` instead; this tool sends nothing extra ' +
        '(no automatic Enter, no line-ending normalization).\n\n' +
        'PREFERRED: pass a named `key` (e.g. {"key": "enter"}). The dashboard looks up the ' +
        'agent\'s provider and host and emits the correct byte sequence. This is the only reliable ' +
        'way to submit Enter, because the right bytes for Enter differ across claude vs codex ' +
        'and Windows vs WSL. Supported `key` values:\n' +
        '  "enter"       — submit (provider+host-aware: \\r for claude, Win32 VK_RETURN down+up for\n' +
        '                  codex on Windows, kitty CSI-u \\x1b[13u for codex on WSL)\n' +
        '  "shift-enter" — newline without submit (Win32 Shift+Enter or kitty \\x1b[13;2u)\n' +
        '  "esc"         — \\x1b\n' +
        '  "tab"         — \\t\n' +
        '  "up" / "down" / "left" / "right" — arrow keys (\\x1b[A/B/C/D)\n' +
        '  "backspace"   — \\x7f (DEL — what readline-style apps expect)\n' +
        '  "ctrl-c"      — \\x03 (SIGINT)\n' +
        '  "ctrl-d"      — \\x04 (EOF)\n' +
        '  "space"       — single space\n' +
        'Pass `count` (1-100) to repeat the key, e.g. {"key": "down", "count": 3}.\n\n' +
        'ADVANCED: pass `keys` (a raw string of bytes) instead of or alongside `key`. The bytes are ' +
        'written verbatim — JS-style escapes ("\\x1b", "\\r") are interpreted by the JSON parser if ' +
        'your client encodes them correctly, but if it double-escapes them you get the literal ' +
        'characters on screen. Use `key` whenever possible to avoid this. If both `key` and `keys` ' +
        'are supplied, the resolved key bytes are sent first, followed by `keys`.\n\n' +
        'WSL caveat: bytes are forwarded through the attached tmux session to the focused pane. ' +
        'Do NOT send the tmux prefix byte ("\\x02" by default, C-b) via `keys` — tmux will swallow it. ' +
        '`ctrl-c` works because it reaches the pane unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          key: {
            type: 'string',
            enum: [
              'enter', 'shift-enter', 'esc', 'tab',
              'up', 'down', 'left', 'right',
              'backspace', 'ctrl-c', 'ctrl-d', 'space',
            ],
            description:
              'Named key. The dashboard translates this to the correct byte sequence for the ' +
              'agent\'s provider and host (Windows / WSL). PREFERRED ' +
              'over `keys` for Enter and any other event whose encoding varies by target.',
          },
          count: {
            type: 'number',
            description:
              'Optional repeat count for `key` (1-100, default 1). E.g. {"key": "down", "count": 3} ' +
              'sends three down-arrow events. Ignored when only `keys` is provided.',
          },
          keys: {
            type: 'string',
            description:
              'Optional raw byte string written verbatim to the agent\'s PTY. Use only when no named ' +
              '`key` fits (e.g. a multi-char filter string or a vendor-specific CSI sequence). ' +
              'JS-style escapes ("\\x1b", "\\r", "\\n") are interpreted by the JSON parser if the ' +
              'client encodes them correctly; if not, they arrive as literal characters. No wrapping, ' +
              'no Enter appended. If both `key` and `keys` are present, key bytes are sent first.',
          },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'run_orchestration',
      description: 'Start an orchestration. The only orchestration is `groupthink`, in one of two ' +
        'modes: `serial` (Lead drafts → Reviewer critiques → Lead writes the plan) or `parallel` ' +
        '(two planners draft independently → cross-pollinate → synthesizer writes the plan). ' +
        'Returns immediately with a runId; the run executes ' +
        'detached inside the dashboard and streams [DASHBOARD EVENT] messages back to you ' +
        '(groupthink.complete / orchestration.groupthink.stalled / .aborted). ' +
        'Resume a stalled run with params.resume_run_id. To re-run an OLD ' +
        '`node scripts/groupthink-v2.js …` resume_hint, paste it as params.legacy_command.',
      inputSchema: {
        type: 'object',
        properties: {
          name:               { type: 'string', description: "Orchestration name, e.g. 'groupthink'." },
          workspace_id:       { type: 'string', description: 'Workspace id (GET /api/agents to discover).' },
          supervisor_id:      { type: 'string', description: 'Your own supervisor agent id.' },
          mode:               { type: 'string', description: 'serial | parallel (groupthink).' },
          topic:              { type: 'string', description: 'One-line deliberation topic.' },
          plan_path:          { type: 'string', description: 'Output plan path relative to workspace root.' },
          lead_provider:      { type: 'string', enum: ['claude', 'codex', 'grok', 'agy'], description: 'Lead/Synthesizer writer provider responsible for producing the final deliverable; omit to inherit the workspace default.' },
          reviewer_provider:  { type: 'string', enum: ['claude', 'codex', 'grok', 'agy'], description: 'Reviewer/peer provider responsible for critique and independent review; omit to inherit the workspace default.' },
          turn_timeout_ms:    { type: 'number', description: 'Per-turn stall timeout, default 600000.' },
          plan_id:            { type: 'string', description: 'Plan rail: an existing registered plan id. The run targets that plan at section_anchor instead of writing a fresh plan file.' },
          planning_intent_id: { type: 'string', description: 'Marked PLAN-INTENT id served by this planning deliberation. Requires plan_id; the server validates same-plan active status before launch.' },
          section_anchor:     { type: 'string', description: 'Plan rail: the section this run updates (required with plan_id).' },
          resume_run_id:      { type: 'string', description: 'Resume a prior stalled run by its runId.' },
          resume_lead_id:     { type: 'string', description: 'Legacy serial resume: lead agent id.' },
          resume_reviewer_id: { type: 'string', description: 'Legacy serial resume: reviewer agent id.' },
          legacy_command:     { type: 'string', description: 'A full old `node scripts/groupthink-v2.js …` command to translate + resume.' },
        },
        required: ['name', 'workspace_id', 'supervisor_id'],
      },
    },
    {
      name: 'abort_orchestration',
      description: 'Abort a running orchestration and clean up its member agents.',
      inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    },
    // NOTE (context-overhead pass): `list_orchestrations` was removed — the
    // catalog it listed holds exactly one entry (groupthink), and the only
    // meaningful choice (mode: serial | parallel) was not surfaced by it. Both
    // are now stated in run_orchestration's own description. The
    // GET /api/orchestrations/catalog route is untouched.
    {
      name: 'get_orchestration_run',
      description: 'Get the status/progress of an orchestration run by runId.',
      inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    },
  ];
}

async function handleOrchestrationToolCall(name, args, apiRequest) {
  switch (name) {
    case 'launch_agent': {
      const input = {
        title: args.title,
        roleDescription: args.role_description || '',
      };
      // Inc 1 (B4): omit workspaceId when absent so the server self-scopes from
      // the caller's identity header. Present → forwarded (server 403s a mismatch).
      if (args.workspace_id) input.workspaceId = args.workspace_id;
      if (args.template_id) input.templateId = args.template_id;
      if (args.persona) input.persona = args.persona;
      if (args.system_prompt) input.systemPrompt = args.system_prompt;
      if (args.provider) input.provider = args.provider;
      if (args.command) input.command = args.command;
      if (args.working_directory) input.workingDirectory = args.working_directory;
      if (args.auto_restart !== undefined) input.autoRestartEnabled = args.auto_restart;
      // BUG-08: codex-only opt-out for post-launch session-id discovery.
      // Default unset → backwards-compatible (discovery still runs). Pass
      // true to start codex with a clean context in a workspace that has
      // had prior codex work.
      if (args.fresh_session !== undefined) input.freshSession = args.fresh_session;
      // Planning-surface rail (WP6): freeze plan_id/section_anchor onto the agent
      // so the launch rail injects AGENT_DASHBOARD_PLAN_ID/_PLAN_SECTION at both
      // env sites. The route validates plan_id existence (400 on unknown).
      if (args.plan_id !== undefined) input.planId = args.plan_id;
      if (args.section_anchor !== undefined) input.planSection = args.section_anchor;
      // Researcher role-lane (browser-parity-and-capability-isolation §0): a
      // hardcoded app primitive. The supervisor (AgentSupervisor.launchAgent)
      // forces provider=claude, the canonical command, the browser MCP toolset,
      // the --tools/--disallowedTools native boundary, and the
      // .lares/researcher/ cwd. Just pass the flag through.
      if (args.is_researcher !== undefined) input.isResearcher = args.is_researcher;
      // Peer-supervisor launch class (cross-workspace-collaboration WP4.1). Forward
      // the `mode` enum as `launchMode`; the server canonicalizes it (top of
      // launchAgent) and gates foreign-workspace peer launches to supervisors. We
      // deliberately do NOT forward a caller-controlled ownerAgentId — the owner
      // edge is server-derived from AGENT_DASHBOARD_SELF_ID (worker mode only).
      if (args.mode !== undefined) input.launchMode = args.mode;
      // Default supervised=true when called via the supervisor MCP — workers
      // launched by the supervisor should bump it on idle/done/crashed so it
      // can react without polling. Caller can pass supervised:false to opt out.
      input.isSupervised = args.supervised !== undefined ? args.supervised : true;
      // Agent-ownership primitive (§4.3): stamp the launcher → child edge from
      // AGENT_DASHBOARD_SELF_ID. This env is set by the dashboard at launch
      // (index.ts launchWindowsAgent/launchWslAgent) — it is dashboard-derived,
      // NOT caller-supplied, so it is the trusted calling-agent identity. The
      // dashboard re-validates it (§4.1: exists + same workspace + non-terminal)
      // before persisting, degrading to null (today's structural-supervisor
      // routing) when absent or invalid.
      if (process.env.AGENT_DASHBOARD_SELF_ID) {
        input.owner_agent_id = process.env.AGENT_DASHBOARD_SELF_ID;
      }
      const agent = await apiRequest('POST', '/api/agents', input);
      let text = `Launched agent "${agent.title}" (${agent.id}) in workspace ${agent.workspaceId}`;
      if (args.template_id) text += `\nTemplate: ${args.template_id}`;
      if (args.prompt) {
        // Poll until the worker leaves 'launching'/'working' before posting the
        // prompt. The /input route returns 409 in those states (the per-agent
        // input queue blocks reentry), and a Claude cold-start needs >8s of
        // silence to flip to 'idle' — well past any fixed wait we could pick.
        const READY_TIMEOUT_MS = 60_000;
        const POLL_INTERVAL_MS = 1000;
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let ready = false;
        let lastStatus = agent.status;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const current = await apiRequest('GET', `/api/agents/${agent.id}`);
            lastStatus = current.status;
            // T1-D / L-B: when a launch crashes and auto-restart is pending,
            // keep polling — the relaunched worker reaches idle on a later
            // cycle and the queued prompt fires. The decision tree is
            // extracted so it can be unit-tested without the MCP shim.
            const action = decidePollAction(
              current.status,
              !!current.autoRestartEnabled,
              current.restartCount
            );
            if (action === 'ready') { ready = true; break; }
            if (action === 'break') break;
            // 'continue' falls through to the next poll iteration.
          } catch (err) {
            lastStatus = `error: ${err.message}`;
            break;
          }
        }
        if (!ready) {
          text += `\nNote: Agent launched but did not reach idle within ${READY_TIMEOUT_MS / 1000}s (last status: ${lastStatus}). Initial prompt NOT sent — retry with send_message_to_agent once the agent is idle.`;
        } else {
          // BUG-01: submit defaults to true so the prompt is auto-pressed
          // (Enter is provider-appropriate: CR for Claude, kitty-encoded for
          // Codex and WSL). Pass submit:false to type without submit.
          // Handoff handshake: submitted prompts use confirm:true so this
          // result reports whether the worker turn ACTUALLY started — not
          // just that bytes were typed.
          const submit = args.submit !== false;
          try {
            const r = await apiRequest('POST', `/api/agents/${agent.id}/input`, {
              text: args.prompt,
              submit,
              confirm: submit,
            });
            if (!submit) {
              text += `\nTyped initial prompt without submitting (submit:false): "${args.prompt.substring(0, 100)}..."`;
            } else if (r.confirmed) {
              text += `\nHANDSHAKE OK — initial prompt sent and the worker turn is CONFIRMED started `
                + `(proof: ${r.mode === 'hook' ? 'UserPromptSubmit hook' : 'status flipped to working'}): `
                + `"${args.prompt.substring(0, 100)}..."`;
            } else {
              text += `\nHANDSHAKE UNCONFIRMED — initial prompt delivered but no turn-start proof arrived in time. `
                + `Verify before relying on this worker: read_agent_log; if the prompt sits unsubmitted, `
                + `send_keys_to_agent {"agent_id":"${agent.id}","key":"enter"}.`;
            }
          } catch (err) {
            text += `\nHANDSHAKE FAILED — agent reached idle but the initial prompt did not start a turn: ${err.message}. `
              + `The worker is NOT working and will never emit an idle event for this prompt. `
              + `Recover now: read_agent_log; if the prompt sits unsubmitted, `
              + `send_keys_to_agent {"agent_id":"${agent.id}","key":"enter"}; otherwise stop_agent + relaunch.`;
          }
        }
      }
      return { content: [{ type: 'text', text }] };
    }

    case 'stop_agent': {
      await apiRequest('DELETE', `/api/agents/${args.agent_id}`);
      return { content: [{ type: 'text', text: `Agent ${args.agent_id} has been stopped.` }] };
    }

    case 'fork_agent': {
      const newAgent = await apiRequest('POST', `/api/agents/${args.agent_id}/fork`);
      return { content: [{ type: 'text', text: `Forked agent ${args.agent_id} → new agent "${newAgent.title}" (${newAgent.id})` }] };
    }

    case 'revive_agent': {
      const body = {};
      if (args.message !== undefined) body.message = args.message;
      if (args.force !== undefined) body.force = args.force;
      const result = await apiRequest('POST', `/api/agents/${args.agent_id}/revive`, body);
      const queuedNote = result?.queued
        ? ' A wake message was queued and will be delivered after the agent orients (get_my_context first).'
        : '';
      return { content: [{ type: 'text', text: `Revived agent ${args.agent_id} — relaunching its original session in its original workspace/cwd.${queuedNote}` }] };
    }

    case 'create_persona': {
      // Inc 1 (B4): omit workspaceId when absent so the server self-scopes from
      // the caller's identity header.
      const body = { name: args.name };
      if (args.workspace_id) body.workspaceId = args.workspace_id;
      if (args.claude_md) body.claudeMd = args.claude_md;
      const persona = await apiRequest('POST', '/api/personas', body);
      return { content: [{ type: 'text', text: `Persona "${persona.name}" created at ${persona.directory}\nHas memory: ${persona.hasMemory}\nYou can now launch an agent with persona: "${persona.name}"` }] };
    }

    case 'send_keys_to_agent': {
      const body = {};
      if (args.key !== undefined) body.key = args.key;
      if (args.count !== undefined) body.count = args.count;
      if (args.keys !== undefined) body.keys = args.keys;
      if (body.key === undefined && body.keys === undefined) {
        throw new Error('send_keys_to_agent requires "key" (named) or "keys" (raw bytes)');
      }
      const result = await apiRequest('POST', `/api/agents/${args.agent_id}/keys`, body);
      const bytes = result?.bytes ?? 0;
      const parts = [];
      if (body.key !== undefined) {
        const count = body.count ?? 1;
        parts.push(count > 1 ? `key=${body.key} x${count}` : `key=${body.key}`);
      }
      if (typeof body.keys === 'string' && body.keys.length > 0) {
        const preview = body.keys.length > 60 ? body.keys.slice(0, 60) + '…' : body.keys;
        parts.push(`raw=${JSON.stringify(preview)}`);
      }
      return {
        content: [{
          type: 'text',
          text: `Sent ${bytes} byte(s) to agent ${args.agent_id} (${parts.join(', ')})`,
        }],
      };
    }

    case 'run_orchestration': {
      const params = {
        workspaceId: args.workspace_id, supervisorId: args.supervisor_id,
        mode: args.mode, topic: args.topic, planPath: args.plan_path,
        planId: args.plan_id, planningIntentId: args.planning_intent_id,
        sectionAnchor: args.section_anchor,
        leadProvider: args.lead_provider, reviewerProvider: args.reviewer_provider,
        turnTimeoutMs: args.turn_timeout_ms,
        resumeRunId: args.resume_run_id, resumeLeadId: args.resume_lead_id,
        resumeReviewerId: args.resume_reviewer_id, legacyCommand: args.legacy_command,
      };
      const r = await apiRequest('POST', '/api/orchestrations', { name: args.name, params });
      return { content: [{ type: 'text', text:
        `Orchestration '${args.name}' started detached. runId=${r.runId}. ` +
        `You'll receive [DASHBOARD EVENT] messages as it progresses; ` +
        `poll get_orchestration_run({run_id:"${r.runId}"}) for status.` }] };
    }

    case 'abort_orchestration': {
      const r = await apiRequest('DELETE', `/api/orchestrations/${encodeURIComponent(args.run_id)}`);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    }

    case 'get_orchestration_run': {
      const r = await apiRequest('GET', `/api/orchestrations/${encodeURIComponent(args.run_id)}`);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }

    default:
      return null;
  }
}

module.exports = { getOrchestrationToolDefinitions, handleOrchestrationToolCall };
