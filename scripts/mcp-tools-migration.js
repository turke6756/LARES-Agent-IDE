// Memory & Lessons v2 (WP-F2) — the SUPERVISOR-ONLY `migration` MCP toolset.
// The guarded, batch/bundle memory-migration operations WP-I2's signed migration
// drives. Granted ONLY to the supervisor lane (mcp-config-builder.toolsetsForLane)
// — never the both-lane `memory` toolset — and registered in mcp-dashboard.js's
// TOOLSET_REGISTRY. Thin HTTP callers over the `/api/migration/*` routes; the
// route resolves the caller's workspace + on-disk root + write dialect SOLELY
// from the authenticated X-Workspace-Id header and runs the transactional
// operation, returning a structured { ok, ... } body (never a throw). Modeled on
// mcp-tools-memory.js / mcp-tools-checkpoints.js.
//
// Archive seam: WP-I1's archive artifact does not exist yet, so
// replace_/restore_memory_bundle take the archived pre-migration bundle
// (index_text + detail bodies keyed by basename) as an EXPLICIT `archive`
// argument — WP-I2 sources it from WP-I1 when both land. This invents nothing
// about WP-I1's on-disk format; it only fixes the in-memory shape at the boundary.

function getMigrationToolDefinitions() {
  return [
    {
      name: 'publish_lessons_batch',
      description:
        'Publish an ATOMIC BATCH of lessons (WP-I2 migration). Every lesson lands to every ' +
        'lane/provider skill root, or the WHOLE batch unwinds — durable, crash-recoverable. All ' +
        'lesson rows + the batch row are inserted pending BEFORE any filesystem write; the batch ' +
        'activates in one transaction only once every copy is on disk. Returns ' +
        '{ ok:true, batchId, status:"active", receipts } (receipts enumerate every created path + ' +
        'written hash + preexisted flag), or { ok:false, code, receipts } where code is empty_batch | ' +
        'invalid_name | reserved_name | invalid_body | duplicate_name | conflict | ' +
        'pending_insert_failed | write_error. A target holding differing content is never overwritten.',
      inputSchema: {
        type: 'object',
        properties: {
          batch_id: { type: 'string', description: 'The durable batch key (crash-recovery record).' },
          snapshot_id: { type: 'string', description: 'The migration snapshot this batch belongs to (optional).' },
          lessons: {
            type: 'array',
            description: 'The lessons to publish. Each: { name (slug), description (trigger), body }.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Lesson slug (^[a-z0-9][a-z0-9-]{0,62}$).' },
                description: { type: 'string', description: 'The mid-flight trigger — the SITUATION this lesson fires in.' },
                body: { type: 'string', description: 'The "when X, do Y" steering (SKILL.md body).' },
              },
              required: ['name', 'description', 'body'],
            },
          },
        },
        required: ['batch_id', 'lessons'],
      },
    },
    {
      name: 'replace_memory_bundle',
      description:
        'Replace the WHOLE memory bundle (index + detail set) with a signed proposal (WP-I2). ' +
        'Validates the proposed index against the proposed detail set (full pure + I/O), rejecting ' +
        'any hard finding, escaping detail path, or orphan detail BEFORE any live mutation. Under the ' +
        'workspace lock: stages all details + the index, hash-guarded-removes obsolete live details ' +
        '(only if they match a known archived body — else conflict), CAS-checks expected_prior_hash, ' +
        'and renames the index LAST. Requires a recorded migration approval for snapshot_id. On any ' +
        'failure it restores the archived bundle. Returns { ok:true, removed, written } or ' +
        '{ ok:false, code } where code is no_approval | invalid_detail_path | hard_invalid | ' +
        'cas_mismatch | conflict | write_error.',
      inputSchema: {
        type: 'object',
        properties: {
          snapshot_id: { type: 'string', description: 'The signed migration snapshot id (must have a recorded approval).' },
          index_source: { type: 'string', description: 'The proposed MEMORY.md index text.' },
          detail_files: {
            type: 'array',
            description: 'The proposed detail set. Each: { rel_path (under .lares/supervisor/memory/details/), content }.',
            items: {
              type: 'object',
              properties: {
                rel_path: { type: 'string', description: 'Workspace-relative detail path under .lares/supervisor/memory/details/.' },
                content: { type: 'string', description: 'The detail file body.' },
              },
              required: ['rel_path', 'content'],
            },
          },
          expected_prior_hash: { type: 'string', description: 'sha256 of the live index the proposal was authored against (CAS).' },
          archive: {
            type: 'object',
            description: 'The archived pre-migration bundle (WP-I1 seam): { index_text, details: { <basename>: <body> } }.',
            properties: {
              index_text: { type: 'string' },
              details: { type: 'object' },
            },
            required: ['index_text', 'details'],
          },
        },
        required: ['snapshot_id', 'index_source', 'detail_files', 'expected_prior_hash', 'archive'],
      },
    },
    {
      name: 'restore_memory_bundle',
      description:
        'Roll the WHOLE memory bundle back to the archived pre-migration state — index + full prior ' +
        'detail inventory (removing migration-created details, restoring obsolete ones the bundle ' +
        'removed). Requires a recorded migration approval for snapshot_id and a live index whose hash ' +
        'matches expected_live_hash (CAS). Returns { ok:true, removed, written } or { ok:false, code } ' +
        'where code is no_approval | cas_mismatch | write_error.',
      inputSchema: {
        type: 'object',
        properties: {
          snapshot_id: { type: 'string', description: 'The migration snapshot id (must have a recorded approval).' },
          expected_live_hash: { type: 'string', description: 'sha256 of the current (post-migration) live index (CAS).' },
          archive: {
            type: 'object',
            description: 'The archived pre-migration bundle (WP-I1 seam): { index_text, details: { <basename>: <body> } }.',
            properties: {
              index_text: { type: 'string' },
              details: { type: 'object' },
            },
            required: ['index_text', 'details'],
          },
        },
        required: ['snapshot_id', 'expected_live_hash', 'archive'],
      },
    },
  ];
}

async function handleMigrationToolCall(name, args, apiRequest) {
  switch (name) {
    case 'publish_lessons_batch': {
      const result = await apiRequest('POST', '/api/migration/publish-lessons-batch', {
        batch_id: args.batch_id,
        snapshot_id: args.snapshot_id,
        lessons: args.lessons,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'replace_memory_bundle': {
      const result = await apiRequest('POST', '/api/migration/replace-bundle', {
        snapshot_id: args.snapshot_id,
        index_source: args.index_source,
        detail_files: args.detail_files,
        expected_prior_hash: args.expected_prior_hash,
        archive: args.archive,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'restore_memory_bundle': {
      const result = await apiRequest('POST', '/api/migration/restore-bundle', {
        snapshot_id: args.snapshot_id,
        expected_live_hash: args.expected_live_hash,
        archive: args.archive,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return null;
  }
}

module.exports = {
  getMigrationToolDefinitions,
  handleMigrationToolCall,
};
