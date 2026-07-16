// WP-F (P5): the observability surface is split into two toolsets.
//   CORE — operational status / necessary dashboard observability. Granted to
//          BOTH the supervisor and worker lanes.
//   ANALYTICS — the WP7 context-optimizer read-only deep-analytics surface
//          (context-optimizer / agent-knowledge / file-heat / skill-usage).
//          Only a context-overhead supervisor needs it; supervisor-only grant.
// `getObservabilityToolDefinitions` (the union) is kept below as a backward-compat
// alias so any grant still naming `observability` keeps working (QW1 precedent).
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
    {
      name: 'list_teams',
      description: 'List all teams in a workspace. Omit workspace_id to use your own workspace (auto-scoped from your identity).',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: the workspace ID. Defaults to your own workspace.' },
        },
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

// ── ANALYTICS toolset (observability-analytics) ──────────────────────────────
// The WP7 context-optimizer read-only agent surface (classifier addendum §5).
// Split out of `observability` into `observability-analytics` (WP-F / P5): these
// are the deep-analytics tools only a context-overhead supervisor needs.
// Every tool below is READ-ONLY: it only calls GET routes. NONE can mark an action
// applied or sign a derivation — those are human-gated UI/IPC affordances with no
// MCP path (§5.4). Descriptions carry ZERO mutation verbs by design (test 29).
function getObservabilityAnalyticsToolDefinitions() {
  return [
    {
      name: 'get_context_optimizer_proposals',
      description:
        'Read-only. Lists behavior-grounded context-optimizer proposals across all four levers ' +
        '(subtract / add / tune / relocate) as lean summary rows (id, kind, title, lane, confidence, ' +
        'token-turns weight, exposure, verification). You can only READ here — this surface never ' +
        'changes any file or config; a human actions a proposal from the dashboard, never an agent. ' +
        'Material candidates may appear in the default list alongside verified ones, each carrying its ' +
        'explicit verification state — so a default-surfaced subtract can still be an unverified ' +
        'candidate. Any candidates still held back are counted in meta.unverifiedSuppressedCount (and ' +
        'reflected in meta.parityStatus); never conclude "nothing to optimize" while that count is ' +
        'nonzero. When you relay ANY subtract proposal whose verification is not derivation-verified, ' +
        'caveat it explicitly as an unverified candidate. ' +
        'Paginate with the opaque cursor; get_context_optimizer_proposal returns one proposal in full.',
      inputSchema: {
        type: 'object',
        properties: {
          lane: { type: 'string', description: 'Optional persona-lane filter (e.g. worker, researcher, supervisor).' },
          kind: { type: 'string', description: 'Optional proposal-kind filter (e.g. subtract-dead-guidance).' },
          min_tier: { type: 'string', description: 'Optional minimum evidence tier (heuristic|inferred|observed|observed-safe).' },
          limit: { type: 'number', description: 'Rows per page (default 20, max 50).' },
          cursor: { type: 'string', description: 'Opaque page cursor from a prior response.' },
          include_unverified: { type: 'boolean', description: 'Also materialize the candidates still held back by the gate (default false: the default view already surfaces MATERIAL unverified candidates with their verification state; only the remainder stay counted-not-listed in meta.unverifiedSuppressedCount).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
      },
    },
    {
      name: 'get_context_optimizer_proposal',
      description:
        'Read-only detail for ONE context-optimizer proposal by id: full rationale, capped citations ' +
        '(max 5), phrase-gap terms + counts, cost evidence, and the proposed unified diff only when ' +
        'include_patch is true. Raw trigger snippets are NEVER returned through this surface (they ' +
        'stay a local UI-only affordance); the phrase-gap terms are post-redaction aggregates. If the ' +
        'proposal is an unverified subtract candidate, caveat it as unverified when you relay it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The proposal id (from a list response).' },
          include_patch: { type: 'boolean', description: 'Include the proposed unified diff (default false).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_context_optimizer_proposal_evidence',
      description:
        'Read-only. The auditable non-occurrence evidence behind ONE `never`/subtract proposal: ' +
        'the matcher that ran + version, the queried epoch/window, capped denominator EXPOSURE-sample ' +
        'streams (proof the guidance WAS exposed), the numerator occurrence samples (empty for a true ' +
        'never), capture coverage per provider, and exclusions. Identifiers + counts only — never raw ' +
        'path text or snippets. A proposal with evidenceState=unavailable (legacy / static-config) has ' +
        'no evidence object and returns INVALID_ARGUMENT. Use this to substantiate a `never` before relaying it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The proposal id (from a list/detail response).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_context_optimizer_cluster_exemplars',
      description:
        'Read-only. The REDACTED structural exemplars behind ONE hash-only cluster ROLLUP ' +
        'proposal (a proposal carrying target.rollup with drillable members). For each folded ' +
        'member hash it returns the tool SHORT name + the sorted input-key NAMES (input_shape_hash ' +
        'clusters) or the normalized search TERMS (search_signature_hash clusters), plus recurrence ' +
        'counts and capped byte-locator event refs. NEVER returns a raw prompt or input value — ' +
        'structural identifiers only. A non-rollup id, or a rollup with no drillable members (it is a ' +
        'diagnostic, not an actionable improvement), returns INVALID_ARGUMENT. Paginate with the opaque cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The rollup proposal id (from a list/detail response; see clusterExemplarRef).' },
          cursor: { type: 'string', description: 'Opaque page cursor from a prior response.' },
          limit: { type: 'number', description: 'Exemplars per page (default 20, max 50).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_improvement_proposals',
      description:
        "Read-only. The 'improve' slice of the context-optimizer analysis — proposals on the ADD / " +
        'TUNE / RELOCATE levers only (guidance to add, skill triggers to tune, sections to relocate to ' +
        'progressive disclosure); subtract proposals are excluded (use get_context_optimizer_proposals ' +
        'for those). Lean summary rows in the same envelope. A human actions a proposal; this surface ' +
        'only READS. Caveat any candidate whose verification is unverified when you relay it. Paginate ' +
        'via cursor; get_improvement_proposal returns one proposal in full.',
      inputSchema: {
        type: 'object',
        properties: {
          lane: { type: 'string', description: 'Optional persona-lane filter.' },
          kind: { type: 'string', description: 'Optional proposal-kind filter.' },
          min_tier: { type: 'string', description: 'Optional minimum evidence tier.' },
          limit: { type: 'number', description: 'Rows per page (default 20, max 50).' },
          cursor: { type: 'string', description: 'Opaque page cursor.' },
          include_unverified: { type: 'boolean', description: 'Materialize unverified candidates (default false).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
      },
    },
    {
      name: 'get_improvement_proposal',
      description:
        'Read-only full detail for one improvement proposal by id (same shape as ' +
        'get_context_optimizer_proposal): rationale, capped citations, phrase-gap terms + counts, and ' +
        'the proposed unified diff only when include_patch is true. No raw snippets are ever returned here.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The proposal id.' },
          include_patch: { type: 'boolean', description: 'Include the proposed unified diff (default false).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_skill_usage',
      description:
        'Read-only skill-usage analytics rollup for your workspace: per-skill invocation counts, ' +
        'two-tier effectiveness (an observable composite plus raw counts, never blended), token cost ' +
        'medians, and a recent timeline (capped at 100). Lean summary rows; paginate via cursor. ' +
        'get_skill_usage_detail returns one skill in full. Read-only — nothing here changes a skill or its config.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Skills per page (default 25, max 100).' },
          cursor: { type: 'string', description: 'Opaque page cursor.' },
          slug: { type: 'string', description: 'Optional project-slug filter.' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
      },
    },
    {
      name: 'get_skill_usage_detail',
      description:
        'Read-only detail for ONE skill (by name/id): full two-tier effectiveness inputs, per-invocation ' +
        "token cost spread, the skill's timeline (capped at 100), and context samples. Read-only analytics.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The skill name (id from a list row).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_mcp_tool_usage',
      description:
        'Read-only per-MCP-tool usage rollup for your workspace: how many times each individual MCP tool ' +
        '(e.g. browser_read_page inside the "browser" toolset) was invoked, as a lean rollup — top tools, a ' +
        'tool×lane cross-tab (byToolLane), a per-lane breakdown, and a recent timeline. Attribution is ' +
        'reported in FOUR honest tiers (tierBreakdown + attributionCoveragePct): (1) agent-attributed — the ' +
        'session resolves to one dashboard agent; (2) lane-attributed-explicit — the stream carries lane ' +
        'metadata; (3) lane-inferred-from-current-grant — the tool\'s toolset is granted to exactly ONE lane ' +
        'today, so the lane is inferred from the current grant topology (lower confidence, carries a reason; ' +
        'never inferred for a toolset shared by >1 lane); (4) unattributed — kept first-class, never dropped, ' +
        'never implied to be one agent (many agents share a working directory). Coverage bands (direct / ' +
        'cautioned / provisional / diagnostic) qualify LANE claims only; a per-agent claim is never promoted ' +
        'to "direct" on coverage. No per-tool error rates (not linkable in the log). Read-only — nothing here ' +
        'changes a tool grant or config.',
      inputSchema: {
        type: 'object',
        properties: {
          lane: { type: 'string', description: 'Optional persona-lane filter (supervisor/worker/researcher/legacy).' },
          slug: { type: 'string', description: 'Optional project-slug filter (the honest workspace scope).' },
          agent_id: { type: 'string', description: 'Optional dashboard agent id (only session-attributed calls match).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
      },
    },
    {
      name: 'get_agent_knowledge',
      description:
        "Read-only 'what this agent knows' graph for one agent (pass agent_id): the typed knowledge " +
        'nodes (capability / constraint / tool / memory / workflow / file-reference) pulled from its ' +
        'resolved scaffold, as lean rows with a redacted source citation per node (max 2). Paginate via ' +
        "cursor; get_agent_knowledge_detail returns one node's full text. Read-only — it only READS the " +
        "agent's guidance surfaces, never changes them.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent whose knowledge graph to extract.' },
          limit: { type: 'number', description: 'Nodes per page (default 100, max 300).' },
          cursor: { type: 'string', description: 'Opaque page cursor.' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'get_agent_knowledge_detail',
      description:
        'Read-only detail for one knowledge node (pass agent_id and the node id): its type, label, ' +
        'full detail text, and redacted source citation. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent id.' },
          id: { type: 'string', description: 'The node id (from a list row).' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
        required: ['agent_id', 'id'],
      },
    },
    {
      name: 'get_file_heat',
      description:
        'Read-only file-heat rollup for your workspace: per-file activity counts (reads, executes, ' +
        'modifications), coverage bucket, path role, and whether a file is a guidance-gap candidate. ' +
        'The corpus is WORKSPACE-SCOPED at the query layer — rows without your workspace identity are ' +
        'dropped (honest dropped/proxy counts ride scopeMeta); scope_mode selects the strict/include-proxy/' +
        'global-diagnostic tier and slug unlocks the include-proxy leg. Each row is role-classified ' +
        '(product-source / guidance-or-config / test-or-fixture / build-generated / dependency-or-vendor / ' +
        'skill-owned / external / unknown) with an explainable reason; operational-noise roles (build/vendor/' +
        'test) are excluded from the default hot view unless include_operational_noise=true (they are never ' +
        'deleted — the excluded count is always disclosed). view=guidance-gaps returns only guidance-gap ' +
        'candidates (uncovered ∧ workflow-level artifact ∧ repeated cross-stream). Rows rank by ONE canonical ' +
        'score shared with the engine. Filter by role, coverage, and access_mode. Paths are redacted to a ' +
        'scope prefix ($WORKSPACE / $DASHBOARD / $SKILL / ~ / external) — no username, no drive. Paginate via ' +
        'cursor. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          lane: { type: 'string', description: 'Optional persona-lane filter.' },
          limit: { type: 'number', description: 'Rows per page (default 20, max 100).' },
          cursor: { type: 'string', description: 'Opaque page cursor.' },
          slug: { type: 'string', description: 'Optional Claude project slug; unlocks the include-proxy scope leg for uniquely-mapped rows.' },
          scope_mode: { type: 'string', description: "Workspace scope tier: 'strict' (default), 'include-proxy', or 'global-diagnostic'." },
          view: { type: 'string', description: "Which view: 'hot' (default, full activity ranking) or 'guidance-gaps' (guidance-gap candidates only)." },
          role: { type: 'string', description: 'Optional path-role filter (e.g. product-source, guidance-or-config, test-or-fixture).' },
          coverage: { type: 'string', description: 'Optional coverage-bucket filter (e.g. uncovered).' },
          access_mode: { type: 'string', description: "Keep only rows with the given access present: 'read', 'write', or 'executed'." },
          include_operational_noise: { type: 'boolean', description: 'Include operational-noise rows (build/vendor/test) in the default hot view (default false).' },
          all_workspaces: { type: 'boolean', description: 'Legacy back-compat flag; the corpus is workspace-scoped at the query layer, so this no longer widens the view.' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
      },
    },
    {
      name: 'get_context_optimizer_analyzability',
      description:
        'Read-only section-level analyzability diagnostic: EXPLAINS the notAnalyzable blind spot. Each ' +
        'row is a guidance section that the classifier could not observe, deduped by section + LANE GROUP ' +
        '(a section shared across lanes is counted ONCE carrying BOTH lanes — never mislabeled to the ' +
        'first lane seen), carrying its resident-token cost, exposure turns, the number of rejected ' +
        'actions, and a breakdown by STABLE actionable reason code (pure-prose / sequence-deferred / ' +
        'branch-deferred / capture-missing / exposure-low / matcher-ambiguous) with an ADVISORY ' +
        'suggestedDetector (a hint for authoring — NOT a detector that changes classification). Rows rank ' +
        'by trapped cost (residentTokens × exposureTurns) DESC so detector investment targets the largest ' +
        'blind spots. Paths are redacted to a scope prefix — no username, no drive. Paginate via cursor. ' +
        'Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          lane: { type: 'string', description: 'Optional persona-lane filter (keep only sections that appear under this lane).' },
          limit: { type: 'number', description: 'Rows per page (default 20, max 100).' },
          cursor: { type: 'string', description: 'Opaque page cursor.' },
          workspace_id: { type: 'string', description: 'Optional workspace scope (defaults to your own).' },
        },
      },
    },
  ];
}

// Backward-compat union: the full observability surface (core + analytics). The
// `observability` toolset alias (mcp-dashboard.js TOOLSET_REGISTRY /
// context-overhead TOOLSET_SCRIPT_MAP) maps here, so any grant still naming
// `observability` keeps working (QW1 precedent: reversible, one-line).
function getObservabilityToolDefinitions() {
  return [
    ...getObservabilityCoreToolDefinitions(),
    ...getObservabilityAnalyticsToolDefinitions(),
  ];
}

// ── WP7 helpers: map snake_case tool args → the GET query the localhost API expects.
// READ-ONLY: every call is a GET; there is no write/POST path in any WP7 tool.
function optQuery(pairs) {
  const q = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue;
    q.push(`${k}=${encodeURIComponent(v)}`);
  }
  return q.length ? '?' + q.join('&') : '';
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

async function handleObservabilityAnalyticsToolCall(name, args, apiRequest) {
  switch (name) {
    case 'get_context_optimizer_proposals':
    case 'get_improvement_proposals': {
      const base = name === 'get_improvement_proposals'
        ? '/api/context-optimizer/improvement-proposals'
        : '/api/context-optimizer/proposals';
      const p = base + optQuery([
        ['lane', args.lane], ['kind', args.kind], ['minTier', args.min_tier],
        ['limit', args.limit], ['cursor', args.cursor],
        ['includeUnverified', args.include_unverified === true ? 'true' : undefined],
        ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_context_optimizer_proposal':
    case 'get_improvement_proposal': {
      const base = name === 'get_improvement_proposal'
        ? '/api/context-optimizer/improvement-proposals'
        : '/api/context-optimizer/proposals';
      const p = `${base}/${encodeURIComponent(args.id)}` + optQuery([
        ['includePatch', args.include_patch === true ? 'true' : undefined],
        ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_context_optimizer_proposal_evidence': {
      const p = `/api/context-optimizer/proposals/${encodeURIComponent(args.id)}/evidence`
        + optQuery([['workspaceId', args.workspace_id]]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_context_optimizer_cluster_exemplars': {
      const p = `/api/context-optimizer/proposals/${encodeURIComponent(args.id)}/cluster-exemplars`
        + optQuery([['cursor', args.cursor], ['limit', args.limit], ['workspaceId', args.workspace_id]]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_skill_usage': {
      const p = '/api/context-optimizer/skill-usage' + optQuery([
        ['limit', args.limit], ['cursor', args.cursor],
        ['slug', args.slug], ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_skill_usage_detail': {
      const p = `/api/context-optimizer/skill-usage/${encodeURIComponent(args.id)}`
        + optQuery([['workspaceId', args.workspace_id]]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_mcp_tool_usage': {
      const p = '/api/context-optimizer/mcp-tool-usage' + optQuery([
        ['lane', args.lane], ['slug', args.slug],
        ['agentId', args.agent_id], ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_agent_knowledge': {
      const p = '/api/context-optimizer/agent-knowledge' + optQuery([
        ['agentId', args.agent_id], ['limit', args.limit],
        ['cursor', args.cursor], ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_agent_knowledge_detail': {
      const p = `/api/context-optimizer/agent-knowledge/${encodeURIComponent(args.id)}`
        + optQuery([['agentId', args.agent_id], ['workspaceId', args.workspace_id]]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_file_heat': {
      const p = '/api/context-optimizer/file-heat' + optQuery([
        ['lane', args.lane], ['limit', args.limit], ['cursor', args.cursor],
        ['slug', args.slug], ['scopeMode', args.scope_mode],
        ['view', args.view], ['role', args.role], ['coverage', args.coverage],
        ['accessMode', args.access_mode],
        ['includeOperationalNoise', args.include_operational_noise === true ? 'true' : undefined],
        ['allWorkspaces', args.all_workspaces === true ? 'true' : undefined],
        ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    case 'get_context_optimizer_analyzability': {
      const p = '/api/context-optimizer/analyzability' + optQuery([
        ['lane', args.lane], ['limit', args.limit], ['cursor', args.cursor],
        ['workspaceId', args.workspace_id],
      ]);
      return textResult(await apiRequest('GET', p));
    }

    default:
      return null;
  }
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

    case 'get_context_stats': {
      const result = await apiRequest('GET', `/api/agents/${args.agent_id}/context-stats`);
      return { content: [{ type: 'text', text: JSON.stringify(result.stats || { message: 'No context stats available yet' }, null, 2) }] };
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

    case 'list_teams': {
      // Inc 1 (B4): omit workspaceId when absent so the server self-scopes from
      // the caller's identity header.
      const p = args.workspace_id
        ? `/api/teams?workspaceId=${encodeURIComponent(args.workspace_id)}`
        : '/api/teams';
      const teams = await apiRequest('GET', p);
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

// Backward-compat union handler: route to core first, then analytics. The
// `observability` alias uses this so a grant still naming `observability` gets
// the full surface. A lane granted ONLY `observability-core` routes its handler,
// which returns null for analytics tool names — belt-and-suspenders isolation
// mirroring handlePlansReadToolCall (a worker cannot invoke an analytics tool it
// was never advertised).
async function handleObservabilityToolCall(name, args, apiRequest) {
  const core = await handleObservabilityCoreToolCall(name, args, apiRequest);
  if (core !== null) return core;
  return handleObservabilityAnalyticsToolCall(name, args, apiRequest);
}

module.exports = {
  getObservabilityToolDefinitions,
  getObservabilityCoreToolDefinitions,
  getObservabilityAnalyticsToolDefinitions,
  handleObservabilityToolCall,
  handleObservabilityCoreToolCall,
  handleObservabilityAnalyticsToolCall,
};
