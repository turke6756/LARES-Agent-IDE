// WP-G2.3 — Git-Native checkpoint recovery MCP toolset (SUPERVISOR-ONLY;
// defense-in-depth). Thin HTTP callers over the WP-G2.1 `/api/checkpoints*`
// routes. Every call carries the agent's minted capability token (the one the
// dashboard injected into this sidecar's env as AGENT_DASHBOARD_API_TOKEN) and
// the caller's asserted identity (X-Supervisor-Id, spread from CALLER_HEADERS in
// apiRequest). The REAL authorization boundary is that capability token: the
// route rejects the shared global bearer, requires supervisor privilege, and
// pins any X-Supervisor-Id to `claim.agentId`. This toolset is granted only to
// the supervisor lane (mcp-config-builder.ts) — that grant-hiding is purely
// belt-and-suspenders on top of the token.
//
// Shape §8.3: recovery tools are supervisor-tier + human only, NEVER workers.
//
// NO `force` parameter on ANY tool: stale-preview override is the human-IPC path
// only (WP-G2.2). The HTTP routes 400 a `force` key; we never advertise or send
// one. Whole-tree recovery is a separate human-only action, not in this toolset.

function getCheckpointsToolDefinitions() {
  return [
    {
      name: 'list_checkpoints',
      description:
        'List the recoverable turns/checkpoints in YOUR workspace (workspace scope is fixed to your '
        + 'capability — you cannot list another workspace). Each row: turnId, turnSeq, agentId, '
        + 'agentTitle, taskLabel, status, timing, before/after checkpoint readiness + quality, the '
        + 'witnessed touched paths, and any failureReason. Optionally filter to one agent with `agent_id`. '
        + 'Use this to find the turnId to diff, restore from, or revert.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Optional: restrict the list to checkpoints produced by this agent.' },
        },
        required: [],
      },
    },
    {
      name: 'diff_turn',
      description:
        'Show what a turn changed. Returns TWO separately-labeled sections: `witnessed` — the diff '
        + 'over the turn\'s server-witnessed touched set (authoritative attribution) — and `window` — '
        + 'the raw before..after window labeled "unattributed changes in this window" (e.g. shell-mediated '
        + 'writes not attributed to a tool call). Read this before restoring or reverting so you know '
        + 'exactly which paths a recovery would touch.',
      inputSchema: {
        type: 'object',
        properties: {
          turn_id: { type: 'string', description: 'The turn to diff (from list_checkpoints).' },
        },
        required: ['turn_id'],
      },
    },
    {
      name: 'restore_paths',
      description:
        'Restore a SUBSET of a turn\'s witnessed paths back to their before-state, leaving every other '
        + 'file and the git index untouched. `paths` must be a subset of the turn\'s witnessed set '
        + '(the server rejects non-witnessed paths). This tool first mints anti-TOCTOU preview tokens '
        + 'for those exact paths, then restores with them; if the workspace shifted such that no valid '
        + 'token could be minted, it returns the preview (with rejectedPaths/contention) instead of '
        + 'restoring. A recoverable pre-restore checkpoint is always taken first (preRef in the result). '
        + 'No `force` override exists here — that is the human-only IPC path.',
      inputSchema: {
        type: 'object',
        properties: {
          turn_id: { type: 'string', description: 'The turn whose witnessed before-state to restore from.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Non-empty subset of the turn\'s witnessed paths to restore (canonical workspace-relative).',
          },
        },
        required: ['turn_id', 'paths'],
      },
    },
    {
      name: 'revert_turn',
      description:
        'Undo an ENTIRE turn — restore every path in its witnessed set to the before-state (leaving the '
        + 'index unchanged). A recoverable pre-revert checkpoint is taken first (preRef in the result). '
        + 'This is the "undo this turn" primitive; use restore_paths when you only want some of the files. '
        + 'Whole-TREE recovery is NOT this — that is a separate human-only disaster action. No `force`.',
      inputSchema: {
        type: 'object',
        properties: {
          turn_id: { type: 'string', description: 'The turn to revert in full (from list_checkpoints).' },
        },
        required: ['turn_id'],
      },
    },
    {
      name: 'prune_checkpoints',
      description:
        'DELETE your workspace\'s checkpoint history: removes BOTH ref namespaces for your workspace '
        + '(refs/lares/checkpoints/<ws>/* and refs/lares/recovery/<ws>/*) in one atomic batch and reports '
        + 'the deleted-ref count. This makes those turns UNRECOVERABLE (diff/restore/revert stop working '
        + 'for them). It is workspace-scoped to YOUR capability — it can never touch another workspace\'s '
        + 'refs, and it never deletes user branches/tags. Git objects are left for normal maintenance (no '
        + 'gc/prune is run). Supervisor-only. No `force`. (The pre-mirror/pre-filter-repo repo-wide purge '
        + 'is a separate human-only action, not available here.)',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ];
}

function asText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

async function handleCheckpointsToolCall(name, args, apiRequest) {
  switch (name) {
    case 'list_checkpoints': {
      let path = '/api/checkpoints';
      if (args.agent_id) path += `?agentId=${encodeURIComponent(args.agent_id)}`;
      return asText(await apiRequest('GET', path));
    }

    case 'diff_turn': {
      const turnId = encodeURIComponent(args.turn_id);
      return asText(await apiRequest('GET', `/api/checkpoints/${turnId}/diff`));
    }

    case 'restore_paths': {
      const turnId = encodeURIComponent(args.turn_id);
      const paths = Array.isArray(args.paths) ? args.paths : [];
      if (paths.length === 0) {
        return {
          content: [{ type: 'text', text: 'restore_paths requires a non-empty `paths` array (a subset of the turn\'s witnessed set).' }],
          isError: true,
        };
      }
      // Anti-TOCTOU: mint preview tokens for exactly these paths, then restore
      // with them. The `force` stale-override is deliberately unavailable here.
      const preview = await apiRequest('POST', `/api/checkpoints/${turnId}/preview`, { paths });
      const previewTokens = (preview && preview.tokens) || {};
      if (Object.keys(previewTokens).length === 0) {
        // Nothing restorable right now (unavailable, all paths rejected, or
        // contention). Surface the preview so the caller can see why rather than
        // driving a guaranteed 400 into an opaque error.
        return {
          content: [{
            type: 'text',
            text: 'No valid preview token could be minted for the requested paths — nothing was restored. Preview:\n'
              + JSON.stringify(preview, null, 2),
          }],
          isError: true,
        };
      }
      return asText(await apiRequest('POST', `/api/checkpoints/${turnId}/restore`, { paths, previewTokens }));
    }

    case 'revert_turn': {
      const turnId = encodeURIComponent(args.turn_id);
      return asText(await apiRequest('POST', `/api/checkpoints/${turnId}/revert`, {}));
    }

    case 'prune_checkpoints': {
      return asText(await apiRequest('POST', '/api/checkpoints/prune', {}));
    }

    default:
      return null;
  }
}

module.exports = { getCheckpointsToolDefinitions, handleCheckpointsToolCall };
