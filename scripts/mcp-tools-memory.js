// The `memory` MCP toolset (Memory & Lessons v2, WP-D) — granted to BOTH the
// supervisor and worker lanes (mcp-config-builder.toolsetsForLane). This module
// CREATES the `memory` toolset; it is registered in mcp-dashboard.js's
// TOOLSET_REGISTRY.
//
// It exposes `recall_memory`: an on-demand fetch of a CLOSED memory capsule's
// detail body (progressive disclosure — active capsules ride inline in the
// injected index, so nothing live is ever fetched late). The tool is a thin
// shim over POST /api/memory/recall; the server derives the workspace SOLELY
// from the authenticated X-Workspace-Id header (forwarded by apiRequest's
// CALLER_HEADERS spread), validates the id, resolves the capsule's DECLARED
// `detail:` pointer, realpath-bounds it beneath the memory details dir, and
// returns a structured result (never a throw). Modeled on mcp-tools-observability.js.

function getMemoryToolDefinitions() {
  return [
    {
      name: 'recall_memory',
      description:
        'Fetch the full detail body for a CLOSED memory capsule by its id (e.g. ' +
        '"mb-2026-07-28-some-slug"). Active capsules already ride inline in your injected ' +
        'memory index — you only need this for the closed history/evidence a capsule points ' +
        'to via its `detail:` line. Returns { ok, status, archived, body, truncated, bytes } on ' +
        'success (bodies over the byte cap are truncated, never split mid-character), or ' +
        '{ ok:false, code } where code is invalid_id | not_found | read_error. Workspace is ' +
        'inferred from your identity — you cannot read another workspace\'s memory.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The memory capsule id, exactly as it appears in the index heading (mb-YYYY-MM-DD-<slug>).',
          },
        },
        required: ['id'],
      },
    },
    {
      // Memory & Lessons v2 (WP-F1): the LESSON write path behind the `remember`
      // skill. The app transactionally provisions the lesson SKILL.md to every
      // lane/provider skill root (Claude + Codex, supervisor + worker); the agent
      // never touches .claude/ or .agents/ directories. Workspace is inferred
      // from the caller's identity (X-Workspace-Id).
      name: 'publish_lesson',
      description:
        'Publish a reusable LESSON as a skill that fires by description on both providers ' +
        '(the `remember` skill routes here for its LESSON branch). Provisions the lesson to ' +
        'every lane/provider skill root transactionally — you never write skill files by hand. ' +
        'Returns { ok:true, lessonId, status:"active", copies } on success, or { ok:false, code } ' +
        'where code is invalid_name | reserved_name | invalid_body | collision | conflict | ' +
        'write_error. A slug that collides with `remember`/a shipped skill, or an existing lesson ' +
        'of the same name with DIFFERING content, is rejected; a target holding differing content ' +
        'is never overwritten (conflict).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Lesson slug: lowercase letters, digits, hyphens (^[a-z0-9][a-z0-9-]{0,62}$). Becomes the skill directory name.',
          },
          description: {
            type: 'string',
            description: 'The mid-flight trigger — the SITUATION a future agent is in when this lesson should fire (front-load the concrete "when X").',
          },
          body: {
            type: 'string',
            description: 'The "when X, do Y" steering, tight. Rendered as the SKILL.md body.',
          },
        },
        required: ['name', 'description', 'body'],
      },
    },
    {
      // Memory & Lessons v2 (WP-F2): the graduation PROPOSAL path. An agent that
      // finds a memory entry turned out to be PERMANENT (belongs in the
      // workspace-wide CLAUDE.md / AGENTS.md, not the days-to-weeks index)
      // proposes graduating it. RECORD-ONLY — the human approves/applies via the
      // review UI (WP-H3); this never edits a target file. Workspace is inferred
      // from the caller's identity (X-Workspace-Id).
      name: 'propose_graduation',
      description:
        'Propose GRADUATING a memory entry into a permanent workspace-root doc when it turned out ' +
        'to be always-true rather than a days-to-weeks open loop. Target MUST be "CLAUDE.md" or ' +
        '"AGENTS.md" (workspace-root) — any other path, and any `.lares/**` target, is rejected. ' +
        'Records a pending proposal for human review (it does NOT edit the file). Returns ' +
        '{ ok:true, proposalId, status:"pending" }, or { ok:false, code } where code is ' +
        'invalid_target | invalid_text | record_failed.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'The workspace-root doc to graduate into: exactly "CLAUDE.md" or "AGENTS.md".',
          },
          text: {
            type: 'string',
            description: 'The always-true content to add to the target doc.',
          },
          rationale: {
            type: 'string',
            description: 'Why this belongs in the permanent doc rather than the memory index.',
          },
        },
        required: ['target', 'text'],
      },
    },
  ];
}

async function handleMemoryToolCall(name, args, apiRequest) {
  switch (name) {
    case 'recall_memory': {
      // Structured errors ride back as an ok:false BODY on a 200 response, so a
      // not_found/invalid_id/read_error is returned to the model as data — never
      // an exception. The workspace is asserted server-side from X-Workspace-Id.
      const result = await apiRequest('POST', '/api/memory/recall', { id: args.id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'publish_lesson': {
      // The route resolves the workspace + its on-disk root + write dialect from
      // the authenticated X-Workspace-Id header and runs the transactional
      // publisher; structured { ok:false, code } errors ride back as a 200 body.
      const result = await apiRequest('POST', '/api/memory/publish-lesson', {
        name: args.name,
        description: args.description,
        body: args.body,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'propose_graduation': {
      // The route resolves the workspace + its on-disk root from the
      // authenticated X-Workspace-Id header, resolves the target under the
      // workspace root, rejects any non-CLAUDE.md/AGENTS.md target, captures the
      // target hash (or ABSENT), and records a pending proposal. Structured
      // { ok:false, code } errors ride back as a 200 body.
      const result = await apiRequest('POST', '/api/memory/propose-graduation', {
        target: args.target,
        text: args.text,
        rationale: args.rationale,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return null;
  }
}

module.exports = {
  getMemoryToolDefinitions,
  handleMemoryToolCall,
};
