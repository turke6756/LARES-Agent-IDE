// mcp-tools-observability.test.js — the MCP-layer half of the WP7 §5.4 read-only
// audit, plus the guard on the retirement of the analytics surface.
//   node scripts/mcp-tools-observability.test.js
//
// HISTORY. This file used to assert that the 13 WP7 context-optimizer tools were
// registered, carried zero mutation verbs, and only ever issued GETs. Those tools
// are RETIRED — replaced by the on-demand analytics snapshot exporter and the
// `context-analytics` skill — so the strongest available statement flipped from
// "they are read-only" to "they are gone, and nothing can call them." Two things
// were deliberately KEPT rather than deleted with them:
//
//   1. The mutation-verb guard, now over the surviving observability surface.
//      The §5.4 property was never specific to the WP7 tools.
//   2. The WP-1C contract test. It pins `buildProposalsPage`'s DEFAULT-view
//      behavior — that a MATERIAL unverified subtract is surfaced with its
//      verification state rather than hidden. That builder is still live: it is
//      exactly what the analytics EXPORTER drains, which is what makes the tool
//      retirement safe. Its contract text now lives in the skill, so the text
//      half of the test is asserted against the skill instead of a tool
//      description that no longer exists.

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  getObservabilityToolDefinitions,
  getObservabilityCoreToolDefinitions,
  handleObservabilityToolCall,
} = require('./mcp-tools-observability');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }
async function okAsync(name, fn) { await fn(); passed++; console.log(`  ok - ${name}`); }

// The mutation-verb blacklist (§5.4 / test 29). A read-only surface must expose none.
const MUTATION_VERBS = ['write', 'set', 'apply', 'sign', 'mark', 'delete', 'update', 'create', 'edit'];

/** The 13 retired `observability-analytics` tools. */
const RETIRED_WP7_TOOLS = [
  'get_context_optimizer_proposals', 'get_context_optimizer_proposal',
  'get_context_optimizer_proposal_evidence', 'get_context_optimizer_cluster_exemplars',
  'get_improvement_proposals', 'get_improvement_proposal',
  'get_skill_usage', 'get_skill_usage_detail',
  'get_mcp_tool_usage',
  'get_agent_knowledge', 'get_agent_knowledge_detail',
  'get_file_heat',
  'get_context_optimizer_analyzability',
];

const defs = getObservabilityToolDefinitions();

ok('the 13 WP7 analytics tools are retired — none is registered on any observability surface', () => {
  assert.equal(RETIRED_WP7_TOOLS.length, 13, 'the retirement covered exactly 13 tools');
  for (const surface of [defs, getObservabilityCoreToolDefinitions()]) {
    for (const n of RETIRED_WP7_TOOLS) {
      assert.ok(!surface.some((d) => d.name === n), `retired tool ${n} is still registered`);
    }
  }
});

ok('the `observability` alias now resolves to exactly the core surface', () => {
  assert.deepStrictEqual(
    defs.map((d) => d.name).sort(),
    getObservabilityCoreToolDefinitions().map((d) => d.name).sort(),
    'the backward-compat alias must expose the core surface and nothing else',
  );
  assert.ok(defs.length > 0, 'the alias must not resolve to an empty surface');
});

ok('NO observability tool NAME contains a mutation verb', () => {
  for (const d of defs) {
    for (const v of MUTATION_VERBS) {
      assert.ok(!d.name.toLowerCase().includes(v), `tool name "${d.name}" contains mutation verb "${v}"`);
    }
  }
});

ok('get_my_context describes the workspace-scoped GroupThink provider defaults', () => {
  const context = defs.find((d) => d.name === 'get_my_context');
  assert.ok(context, 'get_my_context must be registered');
  assert.match(context.description, /orchestrationProviderDefaults\.groupthink/);
});

ok('get_my_context describes canonical provider availability', () => {
  const context = defs.find((d) => d.name === 'get_my_context');
  assert.ok(context, 'get_my_context must be registered');
  assert.match(context.description, /availableProviders/);
  assert.match(context.description, /all four launchable providers in canonical order/);
});

// ── read_comments: the in-process replacement for the pure-Python
// .lares/scripts/read-comments.py (removes the app's only hard Python dep). ──
ok('read_comments is registered on the core surface with a file_path-required schema', () => {
  const rc = getObservabilityCoreToolDefinitions().find((d) => d.name === 'read_comments');
  assert.ok(rc, 'read_comments must be registered on observability-core (granted to supervisor + worker)');
  assert.equal(rc.inputSchema.type, 'object');
  assert.ok(rc.inputSchema.properties.file_path, 'read_comments must accept file_path');
  assert.ok(rc.inputSchema.properties.include_resolved, 'read_comments must accept include_resolved');
  assert.deepStrictEqual(rc.inputSchema.required, ['file_path'], 'file_path is the only required arg');
});

// ── WP-1C: contract text is TESTED against real builder behavior, not prose ──
// The claim must not be that material unverified subtracts are "hidden by
// default", because the shared default-surface policy makes them
// default-visible-with-caveat. The text carrying this contract is now the
// `context-analytics` skill (the tool description that used to carry it is gone).
const { SUPERVISOR_CONTEXT_ANALYTICS_SKILL } = require(
  path.join(__dirname, '..', 'dist', 'main', 'shared', 'constants.js'),
);

ok('1C: the skill does NOT assert unverified subtracts are hidden, and states the gate is a wiring state', () => {
  const d = SUPERVISOR_CONTEXT_ANALYTICS_SKILL.toLowerCase();
  // The specific contract lie that WP-B1 invalidated.
  assert.ok(!/hidden from the actionable list by default/.test(d),
    'stale claim: "hidden from the actionable list by default"');
  assert.ok(!/unverified subtract candidates are hidden/.test(d),
    'stale claim: unverified subtract candidates are hidden');
  // And it must still carry the honest reading of the gate: `verified: false` is
  // a wiring state, not a confidence score. This is the claim the retired tool
  // descriptions used to make, and the reason a zero verified-count must not be
  // read as "nothing qualifies".
  assert.match(SUPERVISOR_CONTEXT_ANALYTICS_SKILL, /DERIVATION_GATE_ALWAYS_UNVERIFIED/,
    'the skill must name the derivation-gate caveat');
  assert.match(d, /wiring state, not a score/,
    'the skill must state that verified:false is a wiring state, not a score');
});

ok('1C fixture: a MATERIAL unverified subtract IS surfaced by the default builder (matches the text)', () => {
  const { buildProposalsPage } = require('../dist/main/main/context-optimizer/agent-dto-build.js');
  const materialUnverifiedSubtract = {
    id: 'subtract-dead-guidance:supervisor:mat', kind: 'subtract-dead-guidance', lever: 'subtract',
    title: 'material subtract', rationale: 'r',
    target: { absPath: '/ws/CLAUDE.md', lineStart: 12, lane: 'supervisor', mutable: 'scaffold-managed' },
    residentTokenDelta: { estimate: 1000, basis: 'remove-resident' },
    tokenTurnsWeight: 900, occurrence: 'never', confidence: 'observed', epochConfidence: 'high',
    attribution: { lane: 'supervisor', streamIds: ['s'], sharedCwdRisk: 'none' },
    exposure: { turns: 10, streams: 2, slugs: 1 },
    citations: [{ source: 'staticOverheadModel' }],
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified', derivationVerified: false,
    suppressedFromAgentSurface: true, // gate-suppressed, yet MATERIAL → default-visible by policy
  };
  const result = {
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    proposals: [materialUnverifiedSubtract], fileHeat: [],
    modelStats: { residentTokensByLane: [], behaviorEvents: 0, attributionWarnings: 0, notAnalyzable: [] },
    meta: { tierGroups: [], unverifiedSuppressedCount: 0 },
  };
  const page = buildProposalsPage(result, {}); // DEFAULT view, no include_unverified
  assert.equal(page.ok, true);
  assert.equal(page.data.length, 1, 'the material unverified subtract IS in the default list');
  assert.equal(page.data[0].actionability, 'candidate-unverified', 'and carries its verification state');
});

// ── handler audit: no retired tool routes, and no HTTP call escapes ──
async function run() {
  await okAsync('get_my_context preserves orchestration provider defaults through the MCP proxy', async () => {
    const expected = {
      workspaceId: 'ws-1',
      orchestrationProviderDefaults: {
        groupthink: { defaultLeadProvider: 'grok', defaultReviewerProvider: 'agy' },
      },
    };
    const calls = [];
    const result = await handleObservabilityToolCall('get_my_context', {}, (method, p) => {
      calls.push({ method, path: p });
      return Promise.resolve(expected);
    });
    assert.deepStrictEqual(calls, [{ method: 'GET', path: '/api/supervisor/context' }]);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), expected);
  });

  await okAsync('get_my_context preserves provider availability through the MCP proxy', async () => {
    const expected = {
      workspaceId: 'ws-1',
      availableProviders: ['claude', 'codex', 'grok', 'agy'].map(provider => ({
        provider, status: 'available', installed: true, reasons: [], evidence: [],
      })),
    };
    const result = await handleObservabilityToolCall('get_my_context', {}, () => Promise.resolve(expected));
    assert.deepStrictEqual(JSON.parse(result.content[0].text), expected);
  });

  await okAsync('no retired analytics tool routes through any observability handler', async () => {
    const calls = [];
    const fakeApi = (method, p) => { calls.push({ method, path: p }); return Promise.resolve({ ok: true }); };
    // The /api/context-optimizer/* routes these tools called STILL EXIST — the
    // exporter depends on them — so a leftover handler case would keep working
    // silently. Assert on the HTTP call, not just on the return value.
    const argsFor = {
      get_context_optimizer_proposal: { id: 'x' },
      get_context_optimizer_proposal_evidence: { id: 'x' },
      get_context_optimizer_cluster_exemplars: { id: 'x' },
      get_improvement_proposal: { id: 'x' },
      get_skill_usage_detail: { id: 'x' },
      get_agent_knowledge: { agent_id: 'a' },
      get_agent_knowledge_detail: { agent_id: 'a', id: 'x' },
    };
    for (const name of RETIRED_WP7_TOOLS) {
      calls.length = 0;
      const result = await handleObservabilityToolCall(name, argsFor[name] || {}, fakeApi);
      assert.equal(result, null, `${name} must be unhandled (null), got ${JSON.stringify(result)}`);
      assert.equal(calls.length, 0, `${name} still issued an HTTP call: ${JSON.stringify(calls)}`);
    }
  });

  await okAsync('the surviving core surface still routes, and only ever via GET', async () => {
    const calls = [];
    // Shape-aware stub: /api/agents returns an ARRAY, the rest return objects.
    const fakeApi = (method, p) => {
      calls.push({ method, path: p });
      if (/^\/api\/agents(\?|$)/.test(p)) return Promise.resolve([]);
      return Promise.resolve({ log: '', messages: [], activities: [], comments: [] });
    };
    // The read verbs of the surviving surface. (save_continuation_brick and
    // open_file_in_view are deliberately excluded — they are the two POST tools
    // on this toolset and were never part of the read-only §5.4 claim.)
    for (const name of ['list_agents', 'read_agent_log', 'read_agent_chat',
      'read_agent_files_touched', 'get_usage_limits', 'get_my_context', 'list_my_agents',
      'read_comments']) {
      calls.length = 0;
      await handleObservabilityToolCall(name, { agent_id: 'a1', file_path: 'C:\\ws\\doc.md' }, fakeApi);
      assert.ok(calls.length >= 1, `${name} made no API call`);
      for (const c of calls) {
        assert.equal(c.method, 'GET', `${name} used ${c.method}, expected GET`);
      }
    }
  });

  await okAsync('read_comments GETs /api/comments with the file_path (and include_resolved when set)', async () => {
    const calls = [];
    const fakeApi = (method, p) => { calls.push({ method, path: p }); return Promise.resolve({ comments: [] }); };
    await handleObservabilityToolCall('read_comments', { file_path: 'C:\\ws\\my doc.md' }, fakeApi);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].path.startsWith('/api/comments?file_path='), `unexpected path: ${calls[0].path}`);
    assert.ok(calls[0].path.includes(encodeURIComponent('C:\\ws\\my doc.md')), 'file_path must be URL-encoded');
    assert.ok(!calls[0].path.includes('include_resolved'), 'include_resolved omitted when unset');

    calls.length = 0;
    await handleObservabilityToolCall('read_comments', { file_path: '/ws/doc.md', include_resolved: true }, fakeApi);
    assert.ok(calls[0].path.includes('include_resolved=true'), 'include_resolved=true must be forwarded');
  });

  console.log(`\nmcp-tools-observability: ${passed} checks passed`);
}

run().catch((e) => { console.error(e); process.exit(1); });
