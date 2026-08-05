// Planning-surface MCP toolset (WP3). Thin HTTP callers over the dashboard's
// /api/plans routes — the activity read plus supervisor focus controls. Identity flows
// through the X-Self-Id (worker) / X-Supervisor-Id (supervisor) header that
// apiRequest spreads from CALLER_HEADERS on every call, so the server records
// the `source:'handler'` read breadcrumb against the calling agent (R2 §2.2).
//
// NO migrate_plan_markdown tool: markdown→six-zones migration is deferred out of
// v1 (amendments F-F). The HTTP boundary already 400s any markdown-migration
// input ("markdown migration is not supported in v1 (deferred)"); apiRequest
// surfaces that as a thrown Error here rather than silent-ignoring it.
//
// WP-A4 (GT-A I-1): the defs are factored into a shared READ_DEFS ladder plus
// supervisor focus controls. `plans` (supervisor lane) advertises the full set;
// `plans-read` (worker lane) advertises READ_DEFS only via
// getPlansReadToolDefinitions(). `plan_id` is INTENTIONALLY optional in the
// shared read schemas — an omitted plan_id falls back to the dispatched plan in
// AGENT_DASHBOARD_PLAN_ID (D-2 soft env-default scoping); still-falsy → clear error.

// READ_DEFS — the read surface shared by the `plans` and `plans-read` toolsets.
// `plan_id` is optional in every schema here: supervisors normally pass it
// explicitly, but an omitted plan_id falls back to AGENT_DASHBOARD_PLAN_ID (the
// dispatched plan) at handler time; still-falsy yields a clear error.
const READ_DEFS = [
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
// P1). A supervisor auto-subscribes on plan-bound launch_agent / run_orchestration,
// but these let it curate the set explicitly so a
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
      "the optional note. You already auto-subscribe when you dispatch a plan-bound " +
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

// record_planning_event — planning-surface DEMAND PROBE (WP-P0PRE). A lightweight
// telemetry ping (NOT a plan write): it records that an agent authored a proposal
// or requested a promotion, so the revamp can measure voluntary demand. Advertised
// to BOTH the supervisor (`plans`) and worker (`plans-read`) lanes because
// proposal authoring happens on the worker lane; it touches no plan section, so it
// is safe in the read-only lane. `source` is stamped server-side as `agent-tool`
// (the route ignores any caller-asserted origin), and voluntary eligibility is
// computed at aggregation — never asserted here.
const recordPlanningEventDef = {
  name: 'record_planning_event',
  description:
    'Record a planning-surface demand-probe event (telemetry only — this does NOT edit any ' +
    'plan section). Call it when you author a proposal (`proposal_authored`) or request a ' +
    'promotion/graduation (`promotion_requested`) so the planning-surface revamp can measure ' +
    'voluntary demand. Fire-and-forget; safe to retry (idempotent by event id).',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['proposal_authored', 'promotion_requested'],
        description: 'What planning action you just took.',
      },
    },
    required: ['kind'],
  },
};

function getPlansToolDefinitions() {
  return [...READ_DEFS, ...FOCUS_DEFS, recordPlanningEventDef];
}

/** WP-A4 (D-1): the read-only subset advertised to the worker `plans-read`
 *  toolset — the three read tools. record_planning_event is
 *  included: it is a telemetry ping, not a plan write. */
function getPlansReadToolDefinitions() {
  return [...READ_DEFS, recordPlanningEventDef];
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

    case 'record_planning_event': {
      // Demand probe (WP-P0PRE). Workspace + `source:'agent-tool'` are derived
      // server-side from the caller identity headers — only `kind` is sent.
      const result = await apiRequest('POST', '/api/demand-probe', { kind: args.kind });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return null;
  }
}

/** Write tools advertised only in the supervisor `plans` toolset — never reachable
 *  from the read-only `plans-read` worker lane. */
const PLANS_WRITE_ONLY = new Set(['focus_plan', 'unfocus_plan']);

/** WP-A4 (D-1): dispatcher for the read-only `plans-read` toolset. Supervisor-only
 *  focus controls are never advertised to this toolset; this belt-and-suspenders
 *  check errors if one is somehow invoked. The three read
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
