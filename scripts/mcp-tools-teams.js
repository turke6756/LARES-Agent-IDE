function getTeamsToolDefinitions() {
  return [
    {
      name: 'create_team',
      description: 'Create a team of agents with defined communication channels and optional task board. Agents in the team get MCP tools to communicate directly with each other.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: the workspace ID. Defaults to your own workspace (auto-scoped from your identity).' },
          name: { type: 'string', description: 'Team name.' },
          description: { type: 'string', description: 'Team purpose/description.' },
          template: { type: 'string', enum: ['mesh', 'pipeline', 'custom'], description: 'Channel template: mesh (all-to-all), pipeline (linear chain A→B→C), custom (define channels explicitly).' },
          members: { type: 'array', items: { type: 'object', properties: { agentId: { type: 'string' }, role: { type: 'string' } }, required: ['agentId'] }, description: 'Agent IDs to enroll as members.' },
          channels: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] }, description: 'Explicit channels (for custom template or additions to template).' },
        },
        required: ['name', 'members'],
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
  ];
}

async function handleTeamsToolCall(name, args, apiRequest) {
  switch (name) {
    case 'create_team': {
      // Inc 1 (B4): omit workspaceId when absent so the server self-scopes from
      // the caller's identity header.
      const createBody = {
        name: args.name,
        description: args.description || '',
        template: args.template || 'custom',
        members: args.members,
        channels: args.channels,
      };
      if (args.workspace_id) createBody.workspaceId = args.workspace_id;
      const team = await apiRequest('POST', '/api/teams', createBody);
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

    case 'resurrect_team': {
      const team = await apiRequest('POST', `/api/teams/${args.team_id}/resurrect`);
      return { content: [{ type: 'text', text: `Team "${team.name}" resurrected (${team.id}). Status: ${team.status}` }] };
    }

    default:
      return null;
  }
}

module.exports = { getTeamsToolDefinitions, handleTeamsToolCall };
