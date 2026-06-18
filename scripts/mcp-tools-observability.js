function getObservabilityToolDefinitions() {
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

async function handleObservabilityToolCall(name, args, apiRequest) {
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

    case 'get_context_stats': {
      const result = await apiRequest('GET', `/api/agents/${args.agent_id}/context-stats`);
      return { content: [{ type: 'text', text: JSON.stringify(result.stats || { message: 'No context stats available yet' }, null, 2) }] };
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

    case 'get_team': {
      const team = await apiRequest('GET', `/api/teams/${args.team_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(team, null, 2) }] };
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

module.exports = { getObservabilityToolDefinitions, handleObservabilityToolCall };
