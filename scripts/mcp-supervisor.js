#!/usr/bin/env node

/**
 * MCP Server for the AgentDashboard Supervisor Agent.
 *
 * This runs as a stdio MCP server — Claude Code spawns it and communicates
 * via JSON-RPC over stdin/stdout. It proxies tool calls to the dashboard's
 * HTTP API server running on localhost.
 *
 * IMPORTANT: Never write to stdout directly — it's reserved for MCP protocol.
 * Use console.error() for debug logging.
 */

const http = require('http');
const fs = require('fs');

// The dashboard API host/port — passed via env vars or defaults.
// Auto-detect WSL: if no explicit host is set and we're inside WSL2,
// read the Windows host IP from /etc/resolv.conf so we can reach the
// dashboard running on the Windows side.
const API_PORT = parseInt(process.env.AGENT_DASHBOARD_API_PORT || '24678', 10);

function detectApiHost() {
  if (process.env.AGENT_DASHBOARD_API_HOST) return process.env.AGENT_DASHBOARD_API_HOST;
  // Detect WSL2 by checking for /proc/version containing Microsoft/WSL
  try {
    const procVersion = fs.readFileSync('/proc/version', 'utf-8');
    if (/microsoft|wsl/i.test(procVersion)) {
      const resolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match) {
        console.error(`[mcp-supervisor] WSL detected, using Windows host IP: ${match[1]}`);
        return match[1];
      }
    }
  } catch { /* not WSL or can't read — fall through */ }
  return '127.0.0.1';
}

const API_HOST = detectApiHost();
const API_BASE = `http://${API_HOST}:${API_PORT}`;

// ── Helpers ─────────────────────────────────────────────────────────────

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON from API: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Dashboard API unreachable (${API_BASE}): ${err.message}`));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── MCP Protocol (newline-delimited JSON-RPC over stdio) ────────────────

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  handleMessage(line);
});

function sendResponse(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error('[mcp] Failed to parse:', raw.substring(0, 100));
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-dashboard', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
        // No response needed
        break;

      case 'tools/list':
        sendResult(id, { tools: getToolDefinitions() });
        break;

      case 'tools/call':
        try {
          const result = await handleToolCall(params.name, params.arguments || {});
          sendResult(id, result);
        } catch (err) {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
        break;

      case 'ping':
        sendResult(id, {});
        break;

      default:
        if (id !== undefined) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (err) {
    console.error(`[mcp] Error handling ${method}:`, err.message);
    if (id !== undefined) {
      sendError(id, -32603, err.message);
    }
  }
}

// ── Tool Definitions ────────────────────────────────────────────────────

function getToolDefinitions() {
  return [
    {
      name: 'list_agents',
      description: 'List all agents in the dashboard with their status, context usage, and metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: filter by workspace ID.' },
        },
      },
    },
    {
      name: 'read_agent_log',
      description: "Read the last N lines of an agent's terminal output.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          lines: { type: 'number', description: 'Lines to read (default 50, max 500).' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'send_message_to_agent',
      description:
        'Send a message to an idle/waiting agent. Rejects if agent is working. ' +
        'For interactive widgets (AskUserQuestion pickers, slash-command menus, arrow keys, Ctrl-C), ' +
        'use `send_keys_to_agent` instead — this tool\'s bracketed-paste wrapping deposits bytes into ' +
        'the input box as text, not as key events.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          message: { type: 'string', description: 'Message to send as user input.' },
        },
        required: ['agent_id', 'message'],
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
        'way to submit Enter, because the right bytes for Enter differ across claude vs codex/gemini ' +
        'and Windows vs WSL. Supported `key` values:\n' +
        '  "enter"       — submit (provider+host-aware: \\r for claude, Win32 VK_RETURN down+up for\n' +
        '                  codex/gemini on Windows, kitty CSI-u \\x1b[13u for codex/gemini on WSL)\n' +
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
              'agent\'s provider (claude / codex / gemini) and host (Windows / WSL). PREFERRED ' +
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
      name: 'get_context_stats',
      description: 'Get context window usage (tokens, percentage, model, turns) for an agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'read_agent_chat',
      description: 'Read the structured conversation history of an agent (turns/messages). Preferred over read_agent_log for orchestration.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          limit: { type: 'number', description: 'Max messages to return (newest first, default 50).' },
          role: { type: 'string', enum: ['assistant', 'user'], description: 'Optional: filter by role.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'read_agent_files_touched',
      description:
        'List files an agent has read, written, or created — paths only, not contents. This is the same data that powers the Context and Outputs tabs in the dashboard. ' +
        'Use this before launching a follow-up worker to check whether a previous agent has already touched a file you were about to ask the new agent to read. ' +
        'Far cheaper than read_agent_chat for that question. ' +
        'Paths are recorded as the tool received them (mix of absolute and workspace-relative, mix of slash and backslash), so the same logical file can appear under multiple strings — the caller does any normalization.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          operation: {
            type: 'string',
            enum: ['read', 'write', 'create'],
            description: 'Filter to one operation. Omit to get all three.',
          },
          limit: { type: 'number', description: 'Max rows, newest first (default 200).' },
          unique: {
            type: 'boolean',
            description: 'When true, dedup by (filePath, operation) and add a `count` field. Matches how the dashboard tab groups rows. Default false.',
          },
        },
        required: ['agent_id'],
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
      name: 'launch_agent',
      description: 'Launch a new worker agent in a workspace. Optionally use a template or persona for pre-configured identity/prompt. When `prompt` is provided, the dashboard writes it into the agent\'s input buffer and presses Enter to submit (provider-appropriate: CR for Claude on Windows / kitty-encoded Enter for Codex+Gemini and for WSL agents). Pass `submit: false` to leave the prompt in the buffer without submitting (useful when the caller wants to append more input via send_keys_to_agent before the agent processes the turn). For codex agents, pass `fresh_session: true` to skip post-launch session-id discovery so the new agent isn\'t auto-bound to any pre-existing rollout in this workspace — use this when launching a codex worker in a workspace that has had prior codex work and you want a clean context.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          title: { type: 'string', description: 'Title for the agent.' },
          role_description: { type: 'string', description: 'Optional role description.' },
          prompt: { type: 'string', description: 'Optional initial prompt to send after launch. By default the dashboard auto-submits with a provider-appropriate Enter — set `submit: false` to suppress.' },
          submit: { type: 'boolean', description: 'Whether to auto-submit the initial prompt with Enter (default: true). Only relevant when `prompt` is provided. Pass false to leave the prompt typed but unsubmitted in the input buffer.' },
          template_id: { type: 'string', description: 'Optional template ID. Agent inherits the template persona, prompt, provider, etc.' },
          persona: { type: 'string', description: 'Persona subdirectory name under .claude/agents/. Agent inherits its CLAUDE.md as system instructions.' },
          system_prompt: { type: 'string', description: 'Optional identity prompt injected as the first message. Overrides template system_prompt.' },
          provider: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'AI provider (default: claude).' },
          command: { type: 'string', description: 'Custom command to launch the agent process. Overrides the provider default.' },
          working_directory: { type: 'string', description: 'Working directory for the agent. Defaults to workspace root.' },
          auto_restart: { type: 'boolean', description: 'Auto-restart the agent on crash (default: true).' },
          supervised: { type: 'boolean', description: 'Whether the supervisor is notified on agent status changes (default: true for supervisor-launched workers — set false to opt out).' },
          fresh_session: { type: 'boolean', description: 'Codex-only opt-out (default: false). When true, the dashboard skips the post-launch codex session-id discovery poll so the new agent record is not auto-bound to any pre-existing rollout in this workspace cwd. Use this when you want a clean codex context in a workspace that has had prior codex work. No-op for non-codex providers.' },
        },
        required: ['workspace_id', 'title'],
      },
    },
    {
      name: 'create_persona',
      description: 'Create a new persistent agent persona directory under .claude/agents/. Creates the folder with CLAUDE.md and memory/MEMORY.md scaffolding.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          name: { type: 'string', description: 'Persona name (lowercase, hyphens, underscores only). Becomes the directory name under .claude/agents/.' },
          claude_md: { type: 'string', description: 'Content for the persona CLAUDE.md file. Defines the agent identity and behavior.' },
        },
        required: ['workspace_id', 'name'],
      },
    },
    {
      name: 'list_templates',
      description: 'List available agent templates for a workspace. Returns global and workspace-scoped templates.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
        },
        required: ['workspace_id'],
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
    // ── Team management tools ──────────────────────────────────────────
    {
      name: 'create_team',
      description: 'Create a team of agents with defined communication channels and optional task board. Agents in the team get MCP tools to communicate directly with each other.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          name: { type: 'string', description: 'Team name.' },
          description: { type: 'string', description: 'Team purpose/description.' },
          template: { type: 'string', enum: ['mesh', 'pipeline', 'custom'], description: 'Channel template: mesh (all-to-all), pipeline (linear chain A→B→C), custom (define channels explicitly).' },
          members: { type: 'array', items: { type: 'object', properties: { agentId: { type: 'string' }, role: { type: 'string' } }, required: ['agentId'] }, description: 'Agent IDs to enroll as members.' },
          channels: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] }, description: 'Explicit channels (for custom template or additions to template).' },
        },
        required: ['workspace_id', 'name', 'members'],
      },
    },
    {
      name: 'disband_team',
      description: 'Disband a team, archiving its manifest for potential resurrection. Saves members, channels, tasks, and recent messages.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID to disband.' },
        },
        required: ['team_id'],
      },
    },
    {
      name: 'add_team_member',
      description: 'Add an agent to an existing team. The agent will receive team MCP tools and a notification.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          agent_id: { type: 'string', description: 'The agent ID to add.' },
          role: { type: 'string', description: 'Role in the team (default: member).' },
        },
        required: ['team_id', 'agent_id'],
      },
    },
    {
      name: 'remove_team_member',
      description: 'Remove an agent from a team. Cleans up their channels.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          agent_id: { type: 'string', description: 'The agent ID to remove.' },
        },
        required: ['team_id', 'agent_id'],
      },
    },
    {
      name: 'add_channel',
      description: 'Add a communication channel between two team members (one-directional: from → to).',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          from_agent: { type: 'string', description: 'Sending agent ID.' },
          to_agent: { type: 'string', description: 'Receiving agent ID.' },
          label: { type: 'string', description: 'Optional label for this channel.' },
        },
        required: ['team_id', 'from_agent', 'to_agent'],
      },
    },
    {
      name: 'remove_channel',
      description: 'Remove a communication channel from a team.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          channel_id: { type: 'string', description: 'The channel ID to remove.' },
        },
        required: ['team_id', 'channel_id'],
      },
    },
    {
      name: 'get_team',
      description: 'Get full team status including members, channels, recent messages, and tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
        },
        required: ['team_id'],
      },
    },
    {
      name: 'list_teams',
      description: 'List all teams in a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'resurrect_team',
      description: 'Resurrect a disbanded team from its saved manifest. Re-launches agents, restores channels and tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The disbanded team ID to resurrect.' },
        },
        required: ['team_id'],
      },
    },
    // ── Live notebook kernel tools (Phase 1) ──────────────────────────
    // These attach to the SAME jupyter-server / kernel the dashboard notebook view is
    // using. Outputs land on disk via jupyter-collaboration RTC, so the user
    // sees live updates without a "file changed on disk" dialog. Cells are
    // addressed by nbformat 4.5 cell `id` (UUID) so inserts don't shift addresses.
    {
      name: 'execute_cell',
      description: 'Execute a single notebook cell on the live kernel and persist outputs to disk. Address by nbformat 4.5 cell id (NOT by index). The user sees the update land live in the dashboard notebook view with no reload.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path (jupyter-server root_dir is /, so a WSL path like /home/user/foo.ipynb becomes "home/user/foo.ipynb").' },
          cell_id: { type: 'string', description: 'The nbformat 4.5 cell id (UUID-like string). Read it from the .ipynb cell metadata.' },
          timeout: { type: 'number', description: 'Cell timeout in seconds (default 60). Kernel is interrupted on timeout.' },
        },
        required: ['notebook_path', 'cell_id'],
      },
    },
    {
      name: 'execute_range',
      description: 'Execute a contiguous range of cells [from_cell_id..to_cell_id] inclusive on the live kernel. Stops at the first cell that errors or times out and returns what completed.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
          from_cell_id: { type: 'string', description: 'First cell id to execute.' },
          to_cell_id: { type: 'string', description: 'Last cell id to execute (must appear after from_cell_id).' },
          timeout: { type: 'number', description: 'Per-cell timeout in seconds (default 60).' },
        },
        required: ['notebook_path', 'from_cell_id', 'to_cell_id'],
      },
    },
    {
      name: 'execute_notebook',
      description: 'Execute every code cell in a notebook from top to bottom on the live kernel. Stops on the first non-ok cell and returns the last executed cell plus compact output summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
          timeout: { type: 'number', description: 'Per-cell timeout in seconds (default 60).' },
        },
        required: ['notebook_path'],
      },
    },
    {
      name: 'interrupt_kernel',
      description: "Interrupt the live kernel for a notebook (sends SIGINT-equivalent). Affects the user's notebook view too — that is intended.",
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
        },
        required: ['notebook_path'],
      },
    },
    {
      name: 'restart_kernel',
      description: 'Restart the live kernel for a notebook. Clears in-memory state but preserves the session — the dashboard notebook view and MCP tools auto-reattach.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
        },
        required: ['notebook_path'],
      },
    },
    {
      name: 'get_kernel_state',
      description: 'Get the live kernel status for a notebook: whether a session is attached, kernel id/name, current state (idle/busy/dead), and the highest execution_count seen on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
        },
        required: ['notebook_path'],
      },
    },
  ];
}

// ── Tool Call Handlers ──────────────────────────────────────────────────

async function handleToolCall(name, args) {
  switch (name) {
    case 'list_agents': {
      const p = args.workspace_id
        ? `/api/agents?workspaceId=${encodeURIComponent(args.workspace_id)}`
        : '/api/agents';
      const agents = await apiRequest('GET', p);
      const summary = agents.map(a => ({
        id: a.id,
        title: a.title,
        status: a.status,
        provider: a.provider,
        isSupervisor: a.isSupervisor,
        workingDirectory: a.workingDirectory,
        context: a.contextStats ? {
          percentage: Math.round(a.contextStats.contextPercentage) + '%',
          tokensUsed: a.contextStats.totalTokens,
          turns: a.contextStats.turnCount,
          model: a.contextStats.model,
        } : null,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }

    case 'read_agent_log': {
      const lines = Math.min(args.lines || 50, 500);
      const result = await apiRequest('GET', `/api/agents/${args.agent_id}/log?lines=${lines}`);
      return { content: [{ type: 'text', text: result.log || '(no output)' }] };
    }

    case 'send_message_to_agent': {
      await apiRequest('POST', `/api/agents/${args.agent_id}/input`, { text: args.message });
      return { content: [{ type: 'text', text: `Message sent to agent ${args.agent_id}: "${args.message}"` }] };
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

    case 'get_context_stats': {
      const result = await apiRequest('GET', `/api/agents/${args.agent_id}/context-stats`);
      return { content: [{ type: 'text', text: JSON.stringify(result.stats || { message: 'No context stats available yet' }, null, 2) }] };
    }

    case 'read_agent_chat': {
      let p = `/api/agents/${args.agent_id}/messages`;
      const q = [];
      if (args.limit) q.push(`limit=${args.limit}`);
      if (args.role) q.push(`role=${args.role}`);
      if (q.length) p += '?' + q.join('&');
      const result = await apiRequest('GET', p);
      return { content: [{ type: 'text', text: JSON.stringify(result.messages, null, 2) }] };
    }

    case 'read_agent_files_touched': {
      let p = `/api/agents/${args.agent_id}/file-activities`;
      const q = [];
      if (args.operation) q.push(`operation=${args.operation}`);
      if (args.limit) q.push(`limit=${args.limit}`);
      if (q.length) p += '?' + q.join('&');
      const result = await apiRequest('GET', p);
      let rows = result.activities || [];
      if (args.unique) {
        const seen = new Map();
        for (const r of rows) {
          const key = `${r.filePath}|${r.operation}`;
          const prev = seen.get(key);
          if (prev) prev.count++;
          else seen.set(key, { ...r, count: 1 });
        }
        rows = Array.from(seen.values());
      }
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }

    case 'stop_agent': {
      await apiRequest('DELETE', `/api/agents/${args.agent_id}`);
      return { content: [{ type: 'text', text: `Agent ${args.agent_id} has been stopped.` }] };
    }

    case 'launch_agent': {
      const input = {
        workspaceId: args.workspace_id,
        title: args.title,
        roleDescription: args.role_description || '',
      };
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
      // Default supervised=true when called via the supervisor MCP — workers
      // launched by the supervisor should bump it on idle/done/crashed so it
      // can react without polling. Caller can pass supervised:false to opt out.
      input.isSupervised = args.supervised !== undefined ? args.supervised : true;
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
            if (current.status === 'idle' || current.status === 'waiting') {
              ready = true;
              break;
            }
            if (current.status === 'crashed' || current.status === 'done') break;
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
          // Codex/Gemini and WSL). Pass submit:false to type without submit.
          const submit = args.submit !== false;
          try {
            await apiRequest('POST', `/api/agents/${agent.id}/input`, { text: args.prompt, submit });
            text += submit
              ? `\nSent initial prompt: "${args.prompt.substring(0, 100)}..."`
              : `\nTyped initial prompt without submitting (submit:false): "${args.prompt.substring(0, 100)}..."`;
          } catch (err) {
            text += `\nNote: Agent reached idle but POST /input failed: ${err.message}. Initial prompt NOT sent — retry with send_message_to_agent.`;
          }
        }
      }
      return { content: [{ type: 'text', text }] };
    }

    case 'create_persona': {
      const body = { workspaceId: args.workspace_id, name: args.name };
      if (args.claude_md) body.claudeMd = args.claude_md;
      const persona = await apiRequest('POST', '/api/personas', body);
      return { content: [{ type: 'text', text: `Persona "${persona.name}" created at ${persona.directory}\nHas memory: ${persona.hasMemory}\nYou can now launch an agent with persona: "${persona.name}"` }] };
    }

    case 'list_templates': {
      const templates = await apiRequest('GET', `/api/templates?workspaceId=${encodeURIComponent(args.workspace_id)}`);
      const templateSummary = templates.map(t => ({
        type: 'template',
        id: t.id,
        name: t.name,
        description: t.description,
        provider: t.provider,
        isSupervisor: t.isSupervisor,
        hasSystemPrompt: !!t.systemPrompt,
      }));
      // Also fetch personas
      let personaSummary = [];
      try {
        const personas = await apiRequest('GET', `/api/personas?workspaceId=${encodeURIComponent(args.workspace_id)}`);
        personaSummary = personas.filter(p => !p.isSupervisor).map(p => ({
          type: 'persona',
          name: p.name,
          directory: p.directory,
          hasMemory: p.hasMemory,
        }));
      } catch { /* personas endpoint may not exist yet */ }
      const combined = [...personaSummary, ...templateSummary];
      return { content: [{ type: 'text', text: JSON.stringify(combined, null, 2) }] };
    }

    case 'fork_agent': {
      const newAgent = await apiRequest('POST', `/api/agents/${args.agent_id}/fork`);
      return { content: [{ type: 'text', text: `Forked agent ${args.agent_id} → new agent "${newAgent.title}" (${newAgent.id})` }] };
    }


    // ── Team management handlers ─────────────────────────────────────
    case 'create_team': {
      const team = await apiRequest('POST', '/api/teams', {
        workspaceId: args.workspace_id,
        name: args.name,
        description: args.description || '',
        template: args.template || 'custom',
        members: args.members,
        channels: args.channels,
      });
      const memberList = (team.members || []).map(m => `  - "${m.title || m.agentId}" (${m.agentId.slice(0, 8)}) [${m.role}]`).join('\n');
      const channelCount = (team.channels || []).length;
      return { content: [{ type: 'text', text: `Team "${team.name}" created (${team.id})\nTemplate: ${team.template || 'custom'}\nMembers:\n${memberList}\nChannels: ${channelCount}` }] };
    }

    case 'disband_team': {
      await apiRequest('DELETE', `/api/teams/${args.team_id}`);
      return { content: [{ type: 'text', text: `Team ${args.team_id} disbanded. Manifest saved for resurrection.` }] };
    }

    case 'add_team_member': {
      await apiRequest('POST', `/api/teams/${args.team_id}/members`, {
        agentId: args.agent_id,
        role: args.role || 'member',
      });
      return { content: [{ type: 'text', text: `Added agent ${args.agent_id} to team ${args.team_id} as ${args.role || 'member'}` }] };
    }

    case 'remove_team_member': {
      await apiRequest('DELETE', `/api/teams/${args.team_id}/members/${args.agent_id}`);
      return { content: [{ type: 'text', text: `Removed agent ${args.agent_id} from team ${args.team_id}` }] };
    }

    case 'add_channel': {
      const channel = await apiRequest('POST', `/api/teams/${args.team_id}/channels`, {
        fromAgent: args.from_agent,
        toAgent: args.to_agent,
        label: args.label,
      });
      return { content: [{ type: 'text', text: `Channel created: ${args.from_agent} → ${args.to_agent} (${channel.id})` }] };
    }

    case 'remove_channel': {
      await apiRequest('DELETE', `/api/teams/${args.team_id}/channels/${args.channel_id}`);
      return { content: [{ type: 'text', text: `Channel ${args.channel_id} removed.` }] };
    }

    case 'get_team': {
      const team = await apiRequest('GET', `/api/teams/${args.team_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(team, null, 2) }] };
    }

    case 'list_teams': {
      const teams = await apiRequest('GET', `/api/teams?workspaceId=${encodeURIComponent(args.workspace_id)}`);
      const summary = teams.map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
        template: t.template,
        memberCount: (t.members || []).length,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }

    case 'resurrect_team': {
      const team = await apiRequest('POST', `/api/teams/${args.team_id}/resurrect`);
      return { content: [{ type: 'text', text: `Team "${team.name}" resurrected (${team.id}). Status: ${team.status}` }] };
    }

    // ── Live notebook kernel handlers ─────────────────────────────────
    case 'execute_cell': {
      const payload = { notebookPath: args.notebook_path, cellId: args.cell_id };
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/kernel/execute-cell', payload);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'execute_range': {
      const payload = {
        notebookPath: args.notebook_path,
        fromCellId: args.from_cell_id,
        toCellId: args.to_cell_id,
      };
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/kernel/execute-range', payload);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'execute_notebook': {
      const payload = { notebookPath: args.notebook_path };
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/kernel/execute-notebook', payload);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'interrupt_kernel': {
      const result = await apiRequest('POST', '/api/notebooks/kernel/interrupt', { notebookPath: args.notebook_path });
      return { content: [{ type: 'text', text: `Kernel interrupted for ${args.notebook_path}` }] };
    }

    case 'restart_kernel': {
      const result = await apiRequest('POST', '/api/notebooks/kernel/restart', { notebookPath: args.notebook_path });
      return { content: [{ type: 'text', text: `Kernel restarted for ${args.notebook_path}\nKernel id: ${result.kernel_id}` }] };
    }

    case 'get_kernel_state': {
      const qs = `notebookPath=${encodeURIComponent(args.notebook_path)}`;
      const result = await apiRequest('GET', `/api/notebooks/kernel/state?${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ── Start ───────────────────────────────────────────────────────────────

console.error(`[mcp-supervisor] Started, API target: ${API_BASE}`);
