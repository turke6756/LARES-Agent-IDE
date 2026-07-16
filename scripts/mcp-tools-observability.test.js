// mcp-tools-observability.test.js — WP7 §7 test 29 (read-only audit) at the MCP layer.
//   node scripts/mcp-tools-observability.test.js
//
// Asserts the observability toolset exposes NO mutation-named tool and that the WP7
// context-optimizer tools carry zero mutation verbs in their descriptions and only ever
// issue GET requests — the MCP half of the §5.4 read-only guarantee. The route half
// (POST → 405) is covered by agent-dto-routes.test.ts.

const assert = require('node:assert/strict');
const { getObservabilityToolDefinitions, handleObservabilityToolCall } = require('./mcp-tools-observability');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }
async function okAsync(name, fn) { await fn(); passed++; console.log(`  ok - ${name}`); }

// The mutation-verb blacklist (§5.4 / test 29). A read-only surface must expose none.
const MUTATION_VERBS = ['write', 'set', 'apply', 'sign', 'mark', 'delete', 'update', 'create', 'edit'];
const WP7_TOOLS = [
  'get_context_optimizer_proposals', 'get_context_optimizer_proposal',
  'get_context_optimizer_proposal_evidence',
  'get_improvement_proposals', 'get_improvement_proposal',
  'get_skill_usage', 'get_skill_usage_detail',
  'get_mcp_tool_usage',
  'get_agent_knowledge', 'get_agent_knowledge_detail',
  'get_file_heat',
  'get_context_optimizer_analyzability',
];

const defs = getObservabilityToolDefinitions();

ok('all WP7 read-only tools are registered', () => {
  for (const n of WP7_TOOLS) {
    assert.ok(defs.some((d) => d.name === n), `missing tool ${n}`);
  }
});

ok('NO observability tool NAME contains a mutation verb', () => {
  for (const d of defs) {
    for (const v of MUTATION_VERBS) {
      assert.ok(!d.name.toLowerCase().includes(v), `tool name "${d.name}" contains mutation verb "${v}"`);
    }
  }
});

ok('NO WP7 tool DESCRIPTION contains a mutation verb (whole word)', () => {
  for (const d of defs.filter((x) => WP7_TOOLS.includes(x.name))) {
    const desc = (d.description || '').toLowerCase();
    for (const v of MUTATION_VERBS) {
      assert.ok(!new RegExp(`\\b${v}\\b`).test(desc), `"${d.name}" description contains mutation verb "${v}"`);
    }
  }
});

ok('every WP7 description instructs the reader it is read-only', () => {
  for (const d of defs.filter((x) => WP7_TOOLS.includes(x.name))) {
    assert.match(d.description.toLowerCase(), /read-only/, `${d.name} must state read-only`);
  }
});

// ── WP-1C: contract text is TESTED against real builder behavior, not prose ──
// The description must not claim material unverified subtracts are "hidden by default",
// because the shared default-surface policy makes them default-visible-with-caveat.
const proposalsDesc = defs.find((d) => d.name === 'get_context_optimizer_proposals').description;

ok('1C description does NOT assert unverified subtracts are hidden from the default list', () => {
  const d = proposalsDesc.toLowerCase();
  // The specific contract lie that WP-B1 invalidated.
  assert.ok(!/hidden from the actionable list by default/.test(d),
    'stale claim: "hidden from the actionable list by default"');
  assert.ok(!/unverified subtract candidates are hidden/.test(d),
    'stale claim: unverified subtract candidates are hidden');
  // It must still preserve the honest disclosure contract (count is authoritative).
  assert.match(proposalsDesc, /meta\.unverifiedSuppressedCount/,
    'description must still point at the disclosure count');
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

// ── handler audit: every WP7 tool issues GET only, never a write verb ──
async function run() {
  await okAsync('every WP7 handler issues GET only (never POST/PUT/PATCH/DELETE)', async () => {
    const calls = [];
    const fakeApi = (method, path) => { calls.push({ method, path }); return Promise.resolve({ ok: true }); };
    const argsFor = {
      get_context_optimizer_proposal: { id: 'x' },
      get_context_optimizer_proposal_evidence: { id: 'x' },
      get_improvement_proposal: { id: 'x' },
      get_skill_usage_detail: { id: 'x' },
      get_agent_knowledge: { agent_id: 'a' },
      get_agent_knowledge_detail: { agent_id: 'a', id: 'x' },
    };
    for (const name of WP7_TOOLS) {
      calls.length = 0;
      await handleObservabilityToolCall(name, argsFor[name] || {}, fakeApi);
      assert.equal(calls.length, 1, `${name} made exactly one API call`);
      assert.equal(calls[0].method, 'GET', `${name} used GET, got ${calls[0].method}`);
    }
  });

  // ── WP-1A: the evidence drill tool routes to the read-only evidence GET ──
  await okAsync('get_context_optimizer_proposal_evidence routes to GET /proposals/:id/evidence', async () => {
    const calls = [];
    const fakeApi = (method, path) => { calls.push({ method, path }); return Promise.resolve({ ok: true }); };
    await handleObservabilityToolCall('get_context_optimizer_proposal_evidence', { id: 'subtract:sup:abc' }, fakeApi);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].path, /^\/api\/context-optimizer\/proposals\/subtract%3Asup%3Aabc\/evidence$/,
      `id must be percent-encoded and routed to the evidence subpath, got ${calls[0].path}`);
  });

  console.log(`\nmcp-tools-observability: ${passed} checks passed`);
}

run().catch((e) => { console.error(e); process.exit(1); });
