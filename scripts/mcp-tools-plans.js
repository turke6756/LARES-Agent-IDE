// Planning-surface MCP toolset (WP3). Thin HTTP callers over the dashboard's
// /api/plans routes — the create primitive plus the read ladder. Identity flows
// through the X-Self-Id (worker) / X-Supervisor-Id (supervisor) header that
// apiRequest spreads from CALLER_HEADERS on every call, so the server records
// the `source:'handler'` read breadcrumb against the calling agent (R2 §2.2).
//
// NO migrate_plan_markdown tool: markdown→six-zones migration is deferred out of
// v1 (amendments F-F). The HTTP boundary already 400s any markdown-migration
// input ("markdown migration is not supported in v1 (deferred)"); apiRequest
// surfaces that as a thrown Error here rather than silent-ignoring it.
//
// WP-A4 (GT-A I-1): the defs are factored into a create primitive + a shared
// READ_DEFS ladder. `plans` (supervisor lane) advertises the full set;
// `plans-read` (worker lane) advertises READ_DEFS only via
// getPlansReadToolDefinitions(). `plan_id` is INTENTIONALLY optional in the
// shared read schemas — an omitted plan_id falls back to the dispatched plan in
// AGENT_DASHBOARD_PLAN_ID (D-2 soft env-default scoping); still-falsy → clear error.

// create_plan — supervisor-only write primitive; keeps workspace_id/title required.
const createDef = {
  name: 'create_plan',
  description:
    'Create a new plan surface from the default six-zone template (summary, questions, ' +
    'research, decisions, execution-trail, open-items). Mints a plans row + plan_sections ' +
    'rows and writes the HTML surface file under the workspace `plans/` directory (a slug ' +
    'derived from the title, with a collision suffix if needed). Returns the created plan. ' +
    'Markdown migration is NOT supported in v1 (deferred) — supply a title only. ' +
    'DISPATCH NOTE: the execution-trail section (`sec_exectr`) is system-owned — auto-generated ' +
    'from trusted write events — so NEVER dispatch a writer to it; dispatch execution workers to ' +
    'the section they UPDATE (`sec_opitem` for checklist execution). Plan-bound briefs must mandate ' +
    "a turn-end writeback: the worker flips its completed items' `&#9744;`→`&#9745;` in its assigned " +
    'section (native HTML edit) and emits a `<!--PLAN-EVENT …-->` sentinel — that edit is what ' +
    'materializes the trail lines and the visible checkmarks.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: 'The workspace to create the plan in.' },
      title: { type: 'string', description: 'Human-readable plan title (used to derive the slug/path).' },
    },
    required: ['workspace_id', 'title'],
  },
};

// READ_DEFS — the read ladder shared by the `plans` and `plans-read` toolsets.
// `plan_id` is optional in every schema here: supervisors normally pass it
// explicitly, but an omitted plan_id falls back to AGENT_DASHBOARD_PLAN_ID (the
// dispatched plan) at handler time; still-falsy yields a clear error.
const READ_DEFS = [
  {
    name: 'list_plan_sections',
    description:
      'Orient on a plan: list its live sections (anchor, zone, title, heading outline) — ~200 ' +
      'tokens, no body content. Records a single `*` orientation read breadcrumb. Call this ' +
      'first to find the section anchor you want, then read_plan_section for the body.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan ID (optional — defaults to the dispatched plan in AGENT_DASHBOARD_PLAN_ID).' },
      },
      required: [],
    },
  },
  {
    name: 'read_plan_section',
    description:
      'Read one plan section (or a `blk_` block within it) by anchor. Modes: `outline` (headings ' +
      'only), `text` (rendered text projection), `raw` (byte-exact HTML fragment), ' +
      '`raw+editWindow` (byte-exact oldString + range + append point + edit-discipline guidance — ' +
      'read this BEFORE natively Editing a zone). `offset`/`limit` page long sections. A `blk_` ' +
      'anchor is attributed to its owning section. Records a read breadcrumb before returning content. ' +
      'NOTE: the execution-trail section (`sec_exectr`) is system-owned (auto-generated from trusted ' +
      'write events) — read it, but never edit it; edits there are dropped from write attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan ID (optional — defaults to the dispatched plan in AGENT_DASHBOARD_PLAN_ID).' },
        anchor: { type: 'string', description: 'Section anchor (`sec_…`) or block anchor (`blk_…`).' },
        mode: {
          type: 'string',
          enum: ['outline', 'text', 'raw', 'raw+editWindow'],
          description: 'Projection mode (default server-side). Use `raw+editWindow` before a native Edit.',
        },
        offset: { type: 'number', description: 'Start offset for paging a long section.' },
        limit: { type: 'number', description: 'Max length to return when paging.' },
      },
      required: ['anchor'],
    },
  },
  {
    name: 'read_plan_projection',
    description:
      'Read the trusted activity projection for a plan: each live section with its ' +
      'plan_events roll-up (trusted event count + last event, observed_via + confidence, ' +
      'plus witnessed repo-activity counts: repoFilesEdited/Created/Read per section). ' +
      'Records a `*` read breadcrumb. Use to see who did what where on the plan. Per-event ' +
      'tier-2 rows are opt-in (events:true) and default-capped (latest 50, hard max 200); ' +
      'each tier-2 row carries a counts-only witnessed digest. For ONE event\'s full ' +
      'witnessed file list (Tier-3 drill-down), pass event_detail_id. ' +
      'scope to one zone with section_anchor to keep token cost down.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan ID (optional — defaults to the dispatched plan in AGENT_DASHBOARD_PLAN_ID).' },
        events: { type: 'boolean', description: 'Attach per-event tier-2 rows (agent, observed_via, confidence, claims, witnessed digest). Off by default — counts only.' },
        events_limit: { type: 'number', description: 'Max events when events:true — returns the latest N (oldest-first within that window). Default 50, hard max 200; raise deliberately (token cost).' },
        section_anchor: { type: 'string', description: 'When events:true, restrict events to those touching this section anchor.' },
        event_detail_id: { type: 'string', description: 'Fetch the capped witnessed file list for ONE event (Tier-3 drill-down). Opt-in token cost.' },
      },
      required: [],
    },
  },
];

// focus_plan / unfocus_plan — supervisor-only subscription verbs (planning-surface
// P1). A supervisor auto-subscribes on the natural verbs (create_plan / plan-bound
// launch_agent / run_orchestration), but these let it curate the set explicitly so a
// plan it minted/dispatched — and thus resurfaces in get_my_context after a /clear —
// can be added or dropped by hand. The subscriber is ALWAYS the calling supervisor,
// derived server-side from the validated X-Supervisor-Id; there is no supervisor_id
// argument, and a non-supervisor caller is rejected server-side. Advertised only in
// the `plans` (supervisor) toolset — never in READ_DEFS / `plans-read`.
const FOCUS_DEFS = [
  {
    name: 'focus_plan',
    description:
      'Subscribe YOU (the calling supervisor) to a plan so it reappears in get_my_context after a ' +
      '/clear, restart, or revival. Idempotent — re-focusing an already-focused plan just refreshes ' +
      "the optional note. You already auto-subscribe when you create_plan or dispatch a plan-bound " +
      'agent/orchestration; use this to add one you did neither for. Supervisor-only.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan ID to subscribe to (optional — defaults to the dispatched plan in AGENT_DASHBOARD_PLAN_ID).' },
        notes: { type: 'string', description: 'Optional free-text note stored on the subscription (why you are watching this plan).' },
      },
      required: [],
    },
  },
  {
    name: 'unfocus_plan',
    description:
      'Unsubscribe YOU (the calling supervisor) from a plan so it no longer appears in ' +
      'get_my_context. No-op if you were not subscribed. Does NOT touch the plan itself — only your ' +
      'subscription row. Supervisor-only.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan ID to unsubscribe from (optional — defaults to the dispatched plan in AGENT_DASHBOARD_PLAN_ID).' },
      },
      required: [],
    },
  },
];

function getPlansToolDefinitions() {
  return [createDef, ...READ_DEFS, ...FOCUS_DEFS];
}

/** WP-A4 (D-1): the read-only subset advertised to the worker `plans-read`
 *  toolset — the three read tools, never create_plan. */
function getPlansReadToolDefinitions() {
  return READ_DEFS;
}

/** Resolve the effective plan id for a read call: explicit arg first, else the
 *  dispatched plan frozen into the agent's env at launch (AGENT_DASHBOARD_PLAN_ID,
 *  D-2 soft env-default scoping). Returns undefined when neither is present. */
function resolvePlanId(args) {
  return args.plan_id || process.env.AGENT_DASHBOARD_PLAN_ID;
}

function missingPlanIdError() {
  return {
    content: [{ type: 'text', text: 'no plan_id supplied and no dispatched plan in env' }],
    isError: true,
  };
}

async function handlePlansToolCall(name, args, apiRequest) {
  switch (name) {
    case 'create_plan': {
      // Create branch of POST /api/plans: { workspace_id, title } + no path.
      // seed_markdown/migrate inputs are NOT advertised; the boundary 400s them (F-F).
      const plan = await apiRequest('POST', '/api/plans', {
        workspace_id: args.workspace_id,
        title: args.title,
      });
      return { content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }] };
    }

    case 'list_plan_sections': {
      const planId = resolvePlanId(args);
      if (!planId) return missingPlanIdError();
      const result = await apiRequest('GET', `/api/plans/${encodeURIComponent(planId)}/sections`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'read_plan_section': {
      const planId = resolvePlanId(args);
      if (!planId) return missingPlanIdError();
      let p = `/api/plans/${encodeURIComponent(planId)}/sections/${encodeURIComponent(args.anchor)}`;
      const q = [];
      if (args.mode) q.push(`mode=${encodeURIComponent(args.mode)}`);
      if (args.offset !== undefined) q.push(`offset=${encodeURIComponent(args.offset)}`);
      if (args.limit !== undefined) q.push(`limit=${encodeURIComponent(args.limit)}`);
      if (q.length) p += '?' + q.join('&');
      const result = await apiRequest('GET', p);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'read_plan_projection': {
      const planId = resolvePlanId(args);
      if (!planId) return missingPlanIdError();
      let p = `/api/plans/${encodeURIComponent(planId)}/projection`;
      const q = [];
      if (args.events) {
        q.push('events=full');
        const reqLim = args.events_limit !== undefined ? Number(args.events_limit) : 50;
        const lim = Number.isFinite(reqLim) ? Math.min(200, Math.max(0, Math.floor(reqLim))) : 50; // clamp + hard max
        q.push(`events_limit=${lim}`);
        if (args.section_anchor) q.push(`section_anchor=${encodeURIComponent(args.section_anchor)}`);
      }
      // Fix-4 Tier-3 — a detail fetch is INDEPENDENT of tier-2 (outside the events
      // block): drilling into one event needs no per-event listing.
      if (args.event_detail_id) q.push('event_detail_id=' + encodeURIComponent(args.event_detail_id));
      if (q.length) p += '?' + q.join('&');
      const result = await apiRequest('GET', p);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'focus_plan': {
      const planId = resolvePlanId(args);
      if (!planId) return missingPlanIdError();
      // Identity-scoped route: the server binds the subscriber from the validated
      // X-Supervisor-Id header (spread by CALLER_HEADERS) — no supervisor_id is sent.
      const body = { plan_id: planId };
      if (args.notes !== undefined) body.notes = args.notes;
      const result = await apiRequest('POST', '/api/supervisor-focus/self', body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'unfocus_plan': {
      const planId = resolvePlanId(args);
      if (!planId) return missingPlanIdError();
      const result = await apiRequest('DELETE', `/api/supervisor-focus/self/${encodeURIComponent(planId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return null;
  }
}

/** Write tools advertised only in the supervisor `plans` toolset — never reachable
 *  from the read-only `plans-read` worker lane. */
const PLANS_WRITE_ONLY = new Set(['create_plan', 'focus_plan', 'unfocus_plan']);

/** WP-A4 (D-1): dispatcher for the read-only `plans-read` toolset. create_plan is
 *  never advertised to this toolset (getPlansReadToolDefinitions omits it); this
 *  belt-and-suspenders check errors if it is somehow invoked. The three read
 *  tools delegate to the shared handlePlansToolCall (incl. the env-default
 *  plan_id scoping). */
async function handlePlansReadToolCall(name, args, apiRequest) {
  if (PLANS_WRITE_ONLY.has(name)) {
    return {
      content: [{ type: 'text', text: `${name} is not available to the read-only plans-read toolset (supervisor-only).` }],
      isError: true,
    };
  }
  return handlePlansToolCall(name, args, apiRequest);
}

module.exports = {
  getPlansToolDefinitions,
  getPlansReadToolDefinitions,
  handlePlansToolCall,
  handlePlansReadToolCall,
};
