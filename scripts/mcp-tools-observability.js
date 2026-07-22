// The observability MCP surface: operational status / necessary dashboard
// observability, granted to BOTH the supervisor and worker lanes.
//
// HISTORY — WP-F (P5) split this into `observability-core` and a second
// `observability-analytics` toolset (the WP7 context-optimizer deep-analytics
// surface: context-optimizer / agent-knowledge / file-heat / skill-usage). Those
// 13 tools have since been RETIRED: they cost 3,172 resident tokens on every
// supervisor session, and the same analysis surfaces are now emitted to disk on
// demand by `npm run analytics:snapshot:fast -- export`, which drains the SAME
// DTO builders their routes called (so captured fields are byte-identical, not a
// reimplementation). The supervisor reaches them through the `context-analytics`
// native skill instead. The underlying /api/context-optimizer/* HTTP routes and
// DTO builders are deliberately UNTOUCHED — the exporter depends on them; only
// the always-resident MCP surface was removed. Re-adding a tool is a one-line
// definition + one handler case the day a workflow needs it live.
//
// `getObservabilityToolDefinitions` (formerly the core+analytics union) is kept
// below as a backward-compat alias so any grant still naming `observability`
// keeps working (QW1 precedent); it now resolves to the core surface alone.
function getObservabilityCoreToolDefinitions() {
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
          current_only: {
            type: 'boolean',
            description: 'When true, return only the agent\'s CURRENT session. Default false returns files touched across ALL retained sessions (a continued agent keeps prior-session activity), which is usually what you want for "has this agent ever touched X?".',
          },
        },
        required: ['agent_id'],
      },
    },
    // NOTE (context-overhead pass): `get_context_stats` was removed here as
    // redundant, NOT unwanted — `list_agents` already returns the same reading
    // inline per agent (`context: {percentage, tokensUsed, turns, model}`), so
    // the capability is preserved without a second resident schema.
    {
      name: 'get_usage_limits',
      description:
        'Get the Claude subscription rate-limit reading (5-hour + 7-day windows: used %, reset countdown). ACCOUNT-WIDE — shared across every session and workspace, NOT per-worker. Takes no arguments. May be stale or absent (available:false, reason:"no_reading_yet") until an agent makes an API call.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_my_context',
      description:
        'Re-orient after a reset, /clear, restart, or revival. Returns your workspace id + title, your ' +
        'own supervisorId (when you are a supervisor — validated from your injected identity), your ' +
        'workspace supervisor (id, title, provider, status), and agent counts (total / live / supervised, ' +
        'plus owned: how many agents YOU launched are live vs terminal — pull the list via list_my_agents). ' +
        'When you are a supervisor it also returns `plans`: the plan surfaces you are subscribed to ' +
        '(planId, path, slug, format, focusedAt, lastAttendedAt, notes), most-recently-attended first, ' +
        'capped at 10 — you auto-subscribe when you create_plan or dispatch a plan-bound agent/orchestration, ' +
        'and can curate the set with focus_plan / unfocus_plan, so a plan you minted before the /clear is ' +
        'not lost. Takes NO arguments — the dashboard scopes it to YOUR workspace from your injected ' +
        'identity. Call this FIRST on any revival, before trusting a wake hint, then self-orient via list_agents.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'list_my_agents',
      description:
        'List the agents YOU launched (your owner edge), newest first — live agents by default; set ' +
        'include_terminal to add recently finished/crashed ones (the graveyard window). Takes NO agent id: ' +
        'the dashboard derives the owner from YOUR injected identity, so you can never read another ' +
        "supervisor's fleet. Pull this fresh whenever you need your workers' state — never rely on a " +
        'snapshot of it written into a prompt or handoff note.',
      inputSchema: {
        type: 'object',
        properties: {
          include_terminal: {
            type: 'boolean',
            description: 'Include done/crashed owned agents (default false: live only).',
          },
          limit: { type: 'number', description: 'Max agents returned, newest first.' },
        },
      },
    },
    {
      name: 'save_continuation_brick',
      description:
        'Save your continuation handoff note (the "brick") when the dashboard asks you to prepare for a ' +
        'session reset. Write ≤6KB of PLAIN TEXT: current phase, directional next steps, agents to launch ' +
        '(kind / roughly how many / which phases), pointers (file paths, plan ids, owned-agent ids + what ' +
        'each was mid-way on), and watch-outs. Use POINTERS, never snapshots — your successor pulls live ' +
        'state via get_my_context / list_my_agents. Takes ONLY the note: the dashboard derives the author ' +
        'from your injected identity. Over 6144 bytes is REJECTED (never truncated) — trim prose to ' +
        'pointers and retry.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The handoff note (plain text, ≤6144 bytes UTF-8).' },
        },
        required: ['note'],
      },
    },
    // NOTE (context-overhead pass): the team READ tools (`list_teams` /
    // `get_team`) were removed — zero calls corpus-wide since 2026-04-11, and no
    // lane documents a team workflow (the `teams` write toolset is ungranted to
    // every lane per QW1). The /api/teams routes still exist; re-add the day a
    // team workflow returns.
    {
      name: 'list_templates',
      description: 'List available agent templates for a workspace. Returns global and workspace-scoped templates. Omit workspace_id to use your own workspace (auto-scoped from your identity).',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: the workspace ID. Defaults to your own workspace.' },
        },
      },
    },
    {
      name: 'open_file_in_view',
      description:
        "Open a file as a tab in the user's dashboard file viewer — markdown, code, CSV/TSV, " +
        'images, PDFs, notebooks: anything the viewer renders. Use this to surface a document ' +
        'or output to the human (e.g. a report you just wrote, a generated plot). The file ' +
        'appears immediately as the active tab in their file view. Prefer an absolute path ' +
        '(Windows "C:\\\\..." or WSL "/home/..."); a relative path is resolved against the ' +
        'workspace root. If workspace_id is omitted, the workspace currently selected in the ' +
        'dashboard UI is used.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file to open. Absolute preferred; relative paths resolve against the workspace root.',
          },
          path_type: {
            type: 'string',
            enum: ['windows', 'wsl'],
            description: 'Filesystem namespace of the path. Usually inferable from the path shape — omit unless ambiguous.',
          },
          workspace_id: {
            type: 'string',
            description: 'Workspace whose file tree the tab belongs to. Defaults to the workspace currently selected in the dashboard UI.',
          },
        },
        required: ['file_path'],
      },
    },
  ];
}

// Backward-compat alias for the `observability` toolset name (mcp-dashboard.js
// TOOLSET_REGISTRY / context-overhead TOOLSET_SCRIPT_MAP), so any grant or
// persona still naming `observability` keeps working (QW1 precedent: reversible,
// one-line). It was the core+analytics union; with the analytics half retired it
// is the core surface, and is kept as a distinct export so the alias stays a
// named seam rather than a silent re-point.
function getObservabilityToolDefinitions() {
  return [
    ...getObservabilityCoreToolDefinitions(),
  ];
}

// ── CORE toolset (observability-core) handler ────────────────────────────────
// Operational status / necessary dashboard observability. Granted to BOTH the
// supervisor and worker lanes (the analytics half above is supervisor-only).
async function handleObservabilityCoreToolCall(name, args, apiRequest) {
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
      if (args.current_only) q.push('current_only=true');
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

    case 'get_usage_limits': {
      // Return the canonical endpoint result verbatim — it already carries
      // `available`, `account_wide`, and `source`; re-wrapping could mask an
      // available:false shape.
      const result = await apiRequest('GET', '/api/usage-limits');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'get_my_context': {
      // Inc 1 (B3): no args — the server scopes to the caller's workspace from
      // the forwarded X-Workspace-Id header.
      const ctx = await apiRequest('GET', '/api/supervisor/context');
      return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] };
    }

    case 'list_my_agents': {
      // Inc 3 (3.2): no agent_id — the server derives the owner from the
      // forwarded X-Supervisor-Id header (explicit owner params are rejected
      // server-side with 400). Pull-only surface: never write the result into
      // a brick or prompt artifact.
      const q = [];
      if (args.include_terminal) q.push('includeTerminal=true');
      if (args.limit) q.push(`limit=${encodeURIComponent(args.limit)}`);
      const p = '/api/supervisor/owned-agents' + (q.length ? '?' + q.join('&') : '');
      const result = await apiRequest('GET', p);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'save_continuation_brick': {
      // Inc 4 (4.5): note only — no workspace_id/agent_id args; the server
      // binds the author from the forwarded X-Supervisor-Id header (apiRequest
      // spreads CALLER_HEADERS on every call).
      const result = await apiRequest('POST', '/api/supervisor/continuation-brick', { note: args.note });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'list_templates': {
      // Inc 1 (B4): omit workspaceId when absent so the server self-scopes from
      // the caller's identity header (both templates and personas endpoints).
      const wq = args.workspace_id ? `?workspaceId=${encodeURIComponent(args.workspace_id)}` : '';
      const templates = await apiRequest('GET', `/api/templates${wq}`);
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
        const personas = await apiRequest('GET', `/api/personas${wq}`);
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

    case 'open_file_in_view': {
      const body = { filePath: args.file_path };
      if (args.path_type) body.pathType = args.path_type;
      if (args.workspace_id) body.workspaceId = args.workspace_id;
      const result = await apiRequest('POST', '/api/files/open-tab', body);
      const scope = result.workspaceId ? ` (workspace ${result.workspaceId})` : ' (active workspace)';
      return { content: [{ type: 'text', text: `Opened in the user's file view: ${result.filePath}${scope}` }] };
    }

    default:
      return null;
  }
}

// Backward-compat alias handler for the `observability` toolset name. It used to
// fall through to the analytics handler after core; with the analytics half
// retired there is nothing to fall through to, so an unknown name returns null
// (the proxy's own unknown-tool path) exactly as the core handler does.
async function handleObservabilityToolCall(name, args, apiRequest) {
  return handleObservabilityCoreToolCall(name, args, apiRequest);
}

module.exports = {
  getObservabilityToolDefinitions,
  getObservabilityCoreToolDefinitions,
  handleObservabilityToolCall,
  handleObservabilityCoreToolCall,
};
