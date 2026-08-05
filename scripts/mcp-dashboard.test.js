// WP-A.1 - unit tests for the parameterized dashboard MCP proxy.
// Run via: node scripts/mcp-dashboard.test.js

const assert = require('assert');
const path = require('path');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const toolsetModulePaths = [
  './mcp-dashboard',
  './mcp-tools-orchestration',
  './mcp-tools-teams',
  './mcp-tools-comms',
  './mcp-tools-observability',
  './mcp-tools-notebooks',
  './mcp-browser-tools',
  './mcp-tools-plans',
  './mcp-tools-memory',
];

function clearProxyModules() {
  for (const modPath of toolsetModulePaths) {
    try {
      delete require.cache[require.resolve(modPath)];
    } catch { /* module may not be loaded */ }
  }
}

function loadProxy(toolsets) {
  clearProxyModules();
  process.env.DASHBOARD_MCP_NO_START = '1';
  process.env.DASHBOARD_MCP_TOOLSETS = toolsets;
  delete process.env.AGENT_DASHBOARD_API_TOKEN;
  return require('./mcp-dashboard');
}

function namesOf(defs) {
  return defs.map((def) => def.name).sort();
}

function fakeApi() {
  const calls = [];
  const fn = async (method, route, body) => {
    calls.push({ method, route, body });
    throw new Error(`unexpected apiRequest: ${method} ${route}`);
  };
  fn.calls = calls;
  return fn;
}

test('browser-only toolset exposes only browser_* and launch_agent is unknown without loading orchestration', async () => {
  const proxy = loadProxy('browser');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names, [
    'browser_click',
    'browser_close_tab',
    'browser_get_page_text',
    'browser_go_back',
    'browser_go_forward',
    'browser_list_my_access_requests',
    'browser_list_tabs',
    'browser_open_url',
    'browser_press_key',
    'browser_read_page',
    'browser_reload',
    'browser_request_site_access',
    'browser_screenshot',
    'browser_scroll',
    'browser_select_option',
    'browser_type',
    'browser_wait_for',
  ]);
  assert.ok(names.every((name) => name.startsWith('browser_')));
  assert.strictEqual(require.cache[require.resolve('./mcp-tools-orchestration')], undefined);

  const api = fakeApi();
  const result = await proxy.handleToolCall('launch_agent', {}, api);
  assert.deepStrictEqual(result, {
    content: [{ type: 'text', text: 'Unknown tool: launch_agent' }],
    isError: true,
  });
  assert.strictEqual(api.calls.length, 0);
  assert.strictEqual(require.cache[require.resolve('./mcp-tools-orchestration')], undefined);
});

test('notebooks,comms,observability exposes exactly those toolsets, not orchestration or browser', async () => {
  const proxy = loadProxy('notebooks,comms,observability');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names, [
    'execute_cell',
    'execute_notebook',
    'execute_range',
    'get_kernel_state',
    'get_my_context',
    'get_usage_limits',
    'interrupt_kernel',
    'list_agents',
    'list_my_agents',
    'list_templates',
    'list_workspaces',
    'open_file_in_view',
    'read_agent_chat',
    'read_agent_files_touched',
    'read_agent_log',
    'read_comments',
    'restart_kernel',
    'save_continuation_brick',
    'send_message_to_agent',
    // The WP7 context-optimizer read-only agent surface used to be additive to
    // `observability` here. Those 13 tools are RETIRED (see RETIRED_ANALYTICS_TOOLS
    // below) — the `observability` alias now resolves to the core surface alone.
  ].sort());
  assert.ok(!names.includes('launch_agent'));
  assert.ok(!names.some((name) => name.startsWith('browser_')));

  const api = fakeApi();
  const result = await proxy.handleToolCall('launch_agent', {}, api);
  assert.deepStrictEqual(result, {
    content: [{ type: 'text', text: 'Unknown tool: launch_agent' }],
    isError: true,
  });
  assert.strictEqual(api.calls.length, 0);
});

// ── WP-F (P5) observability split, and the retirement of the analytics half ──

const OBSERVABILITY_CORE_TOOLS = [
  'get_my_context', 'get_usage_limits',
  'list_agents', 'list_my_agents', 'list_templates', 'list_workspaces',
  'open_file_in_view', 'read_agent_chat', 'read_agent_files_touched',
  'read_agent_log', 'read_comments', 'save_continuation_brick',
].sort();

/** The 13 tools that made up the `observability-analytics` toolset, retired in
 *  favour of the on-demand analytics snapshot exporter + the `context-analytics`
 *  skill. This list is deliberately KEPT so the guards below can assert the
 *  retirement is total — that no grant, alias, or registry entry can reach any of
 *  them — instead of the list simply disappearing along with the coverage. */
const RETIRED_ANALYTICS_TOOLS = [
  'get_agent_knowledge', 'get_agent_knowledge_detail',
  'get_context_optimizer_analyzability',
  'get_context_optimizer_cluster_exemplars',
  'get_context_optimizer_proposal', 'get_context_optimizer_proposal_evidence',
  'get_context_optimizer_proposals',
  'get_file_heat', 'get_improvement_proposal', 'get_improvement_proposals',
  'get_mcp_tool_usage', 'get_skill_usage', 'get_skill_usage_detail',
].sort();

test('observability-core exposes exactly the operational tools', async () => {
  const proxy = loadProxy('observability-core');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names, OBSERVABILITY_CORE_TOOLS);
});

test('the `observability-analytics` toolset is UNREGISTERED — the name resolves to nothing', async () => {
  // The retirement removed all 13 of its tools, so the toolset would have been an
  // empty entry; it was unregistered instead. An unknown toolset name must not
  // silently smuggle in some other surface.
  const proxy = loadProxy('observability-analytics');
  assert.deepStrictEqual(
    namesOf(proxy.getToolDefinitions()), [],
    'a retired toolset name must expose zero tools, not fall back to another toolset',
  );
});

test('every retired analytics tool is unreachable under EVERY grant that could have carried it', async () => {
  const grants = [
    'observability',                    // the backward-compat alias (was the union)
    'observability-core',
    'observability-analytics',          // the retired name itself
    'observability,observability-core,observability-analytics',
    'orchestration,comms,observability-core,plans,browser-present',      // supervisor
    'comms,observability-core,browser-present,plans-read',               // worker
  ];
  for (const grant of grants) {
    const proxy = loadProxy(grant);
    const names = namesOf(proxy.getToolDefinitions());
    for (const retired of RETIRED_ANALYTICS_TOOLS) {
      assert.ok(
        !names.includes(retired),
        `grant '${grant}' still advertises retired analytics tool ${retired}`,
      );
      // Not merely unadvertised — not routable, and it must make NO HTTP call.
      // (The /api/context-optimizer/* routes still exist for the exporter, so a
      // surviving handler case would silently keep working. This is the guard.)
      const api = fakeApi();
      const result = await proxy.handleToolCall(retired, {}, api);
      assert.deepStrictEqual(
        result,
        { content: [{ type: 'text', text: `Unknown tool: ${retired}` }], isError: true },
        `grant '${grant}' still ROUTES retired analytics tool ${retired}`,
      );
      assert.strictEqual(api.calls.length, 0, `${retired} under '${grant}' still issued an HTTP call`);
    }
  }
});

test('SUPERVISOR grant keeps its operational surface after the analytics retirement', async () => {
  const proxy = loadProxy('orchestration,comms,observability-core,plans,browser-present');
  const names = namesOf(proxy.getToolDefinitions());
  for (const kept of ['list_agents', 'read_agent_chat', 'get_my_context', 'launch_agent']) {
    assert.ok(names.includes(kept), `supervisor must keep ${kept}`);
  }
});

test('WORKER grant is unchanged by the retirement and keeps operational observability', async () => {
  const proxy = loadProxy('comms,observability-core,browser-present,plans-read');
  const names = namesOf(proxy.getToolDefinitions());
  assert.ok(names.includes('list_agents'), 'worker keeps operational observability (list_agents)');
  assert.ok(names.includes('read_agent_chat'), 'worker keeps operational observability (read_agent_chat)');
});

test('backward-compat: the `observability` alias resolves to the core surface and still routes', async () => {
  const proxy = loadProxy('observability');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names, OBSERVABILITY_CORE_TOOLS);
  // A core tool still routes through the alias handler (the alias is a live seam,
  // not a dead name).
  const api = capturingApi({ ok: true });
  await proxy.handleToolCall('read_agent_log', { agent_id: 'a1' }, api);
  assert.strictEqual(api.calls.length, 1, 'a core tool must still route under the observability alias');
  assert.strictEqual(api.calls[0].method, 'GET');
});

// ── WP-A4: plans-read worker grant exposes exactly the 3 read tools ──

test('plans-read toolset exposes the activity read + record_planning_event', async () => {
  const proxy = loadProxy('plans-read');
  const names = namesOf(proxy.getToolDefinitions());
  // WP-P0PRE: record_planning_event is a telemetry ping (a demand probe), not a
  // plan write, so it rides in the read-only worker lane alongside the activity read.
  assert.deepStrictEqual(names, [
    'read_plan_projection',
    'record_planning_event',
  ]);
});

test('plans (supervisor) toolset exposes the activity read + focus verbs', async () => {
  const proxy = loadProxy('plans');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names, [
    'focus_plan',
    'read_plan_projection',
    'record_planning_event',
    'unfocus_plan',
  ]);
});

// ── memory toolset (WP-D): recall_memory ──

test('memory toolset exposes recall_memory + publish_lesson + propose_graduation', async () => {
  // WP-D created the toolset with recall_memory; WP-F1 added the publish_lesson
  // write path; WP-F2 added propose_graduation (the graduation PROPOSAL path) to
  // the same both-lane toolset.
  const proxy = loadProxy('memory');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names.sort(), ['propose_graduation', 'publish_lesson', 'recall_memory']);
});

test('propose_graduation POSTs { target, text, rationale } to /api/memory/propose-graduation', async () => {
  const proxy = loadProxy('memory');
  const body = { ok: true, proposalId: 'grad-abc', status: 'pending' };
  const api = capturingApi(body);
  const result = await proxy.handleToolCall('propose_graduation', { target: 'CLAUDE.md', text: 'always true', rationale: 'why' }, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].method, 'POST');
  assert.strictEqual(api.calls[0].route, '/api/memory/propose-graduation');
  assert.deepStrictEqual(api.calls[0].body, { target: 'CLAUDE.md', text: 'always true', rationale: 'why' });
  assert.deepStrictEqual(JSON.parse(result.content[0].text), body);
});

test('migration toolset exposes the three guarded ops (WP-F2)', async () => {
  const proxy = loadProxy('migration');
  const names = namesOf(proxy.getToolDefinitions());
  assert.deepStrictEqual(names.sort(), ['publish_lessons_batch', 'replace_memory_bundle', 'restore_memory_bundle']);
});

test('migration ops POST to their /api/migration/* routes', async () => {
  const proxy = loadProxy('migration');
  const api = capturingApi({ ok: true });
  await proxy.handleToolCall('publish_lessons_batch', { batch_id: 'b1', lessons: [] }, api);
  await proxy.handleToolCall('replace_memory_bundle', { snapshot_id: 's1', index_source: 'i', detail_files: [], expected_prior_hash: 'h', archive: { index_text: 'i', details: {} } }, api);
  await proxy.handleToolCall('restore_memory_bundle', { snapshot_id: 's1', expected_live_hash: 'h', archive: { index_text: 'i', details: {} } }, api);
  assert.deepStrictEqual(api.calls.map((c) => c.route), [
    '/api/migration/publish-lessons-batch',
    '/api/migration/replace-bundle',
    '/api/migration/restore-bundle',
  ]);
  assert.ok(api.calls.every((c) => c.method === 'POST'));
});

test('recall_memory POSTs { id } to /api/memory/recall and returns the structured body verbatim', async () => {
  const proxy = loadProxy('memory');
  const body = { ok: true, id: 'mb-2026-07-28-x', status: 'done', archived: false, body: 'DETAIL', truncated: false, bytes: 6 };
  const api = capturingApi(body);
  const result = await proxy.handleToolCall('recall_memory', { id: 'mb-2026-07-28-x' }, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].method, 'POST');
  assert.strictEqual(api.calls[0].route, '/api/memory/recall');
  assert.deepStrictEqual(api.calls[0].body, { id: 'mb-2026-07-28-x' });
  assert.deepStrictEqual(JSON.parse(result.content[0].text), body);
});

test('a structured ok:false recall error rides back as a normal body (not an isError throw)', async () => {
  const proxy = loadProxy('memory');
  const body = { ok: false, code: 'not_found' };
  const api = capturingApi(body);
  const result = await proxy.handleToolCall('recall_memory', { id: 'mb-2026-07-28-missing' }, api);
  assert.ok(!result.isError, 'a structured recall error is data, not a tool error');
  assert.deepStrictEqual(JSON.parse(result.content[0].text), body);
});

// ── get_usage_limits: returns the /api/usage-limits result verbatim ──

test('get_usage_limits (happy path) returns the endpoint reading verbatim', async () => {
  const proxy = loadProxy('observability');
  const reading = {
    available: true,
    account_wide: true,
    source: 'claude_statusline',
    captured_at: 1000,
    age_seconds: 5,
    stale: false,
    five_hour: { used_percentage: 42, resets_at: 1234, resets_at_ms: 1234000, resets_in_seconds: 60, captured_at: 1000, age_seconds: 5, stale: false },
    seven_day: null,
  };
  const api = capturingApi(reading);
  const result = await proxy.handleToolCall('get_usage_limits', {}, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].method, 'GET');
  assert.strictEqual(api.calls[0].route, '/api/usage-limits');
  assert.deepStrictEqual(JSON.parse(result.content[0].text), reading);
});

test('get_usage_limits (no_reading_yet) returns the available:false shape verbatim', async () => {
  const proxy = loadProxy('observability');
  const reading = { available: false, account_wide: true, reason: 'no_reading_yet' };
  const api = capturingApi(reading);
  const result = await proxy.handleToolCall('get_usage_limits', {}, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].route, '/api/usage-limits');
  assert.deepStrictEqual(JSON.parse(result.content[0].text), reading);
});

// ── Transient one-turn subscription: sender_agent_id wiring (tests 21–25) ──

function capturingApi(returnVal) {
  const calls = [];
  const fn = async (method, route, body) => { calls.push({ method, route, body }); return returnVal; };
  fn.calls = calls;
  return fn;
}

const OK_SUBSCRIBED = { confirmed: true, mode: 'hook', transientSubscription: { registered: true } };

test('21. confirmed send_message_to_agent forwards sender_agent_id = AGENT_ID', async () => {
  const prev = process.env.AGENT_ID;
  process.env.AGENT_ID = 'agent-123';
  try {
    const proxy = loadProxy('comms');
    const api = capturingApi(OK_SUBSCRIBED);
    await proxy.handleToolCall('send_message_to_agent', { agent_id: 't-1', message: 'hi' }, api);
    assert.strictEqual(api.calls.length, 1);
    assert.strictEqual(api.calls[0].body.sender_agent_id, 'agent-123', 'confirmed POST body carries sender_agent_id');
    assert.strictEqual(api.calls[0].body.confirm, true);
  } finally { if (prev === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prev; }
});

test('22. fire-and-forget send_message_to_agent forwards sender_agent_id', async () => {
  const prev = process.env.AGENT_ID;
  process.env.AGENT_ID = 'agent-456';
  try {
    const proxy = loadProxy('comms');
    const api = capturingApi({});
    await proxy.handleToolCall('send_message_to_agent', { agent_id: 't-1', message: 'hi', confirm: false }, api);
    assert.strictEqual(api.calls.length, 1);
    assert.strictEqual(api.calls[0].body.sender_agent_id, 'agent-456', 'fire-and-forget POST body carries sender_agent_id');
  } finally { if (prev === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prev; }
});

test('23. AGENT_ID unset/empty → POST body omits sender_agent_id (no empty key)', async () => {
  const prev = process.env.AGENT_ID;
  delete process.env.AGENT_ID;
  try {
    const proxy = loadProxy('comms');
    const api = capturingApi(OK_SUBSCRIBED);
    await proxy.handleToolCall('send_message_to_agent', { agent_id: 't-1', message: 'hi' }, api);
    assert.strictEqual(api.calls.length, 1);
    assert.ok(!('sender_agent_id' in api.calls[0].body), 'no sender_agent_id key when AGENT_ID is empty');
  } finally { if (prev === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prev; }
});

test('24. tool schema does NOT expose sender_agent_id/senderAgentId', async () => {
  clearProxyModules();
  const comms = require('./mcp-tools-comms');
  const props = comms.getCommsToolDefinitions()[0].inputSchema.properties;
  assert.ok(!('sender_agent_id' in props), 'schema must not expose sender_agent_id');
  assert.ok(!('senderAgentId' in props), 'schema must not expose senderAgentId');
});

test('25. HANDSHAKE-OK text mentions the one-turn subscription only when registered', async () => {
  const prev = process.env.AGENT_ID;
  process.env.AGENT_ID = 'agent-789';
  try {
    const proxy = loadProxy('comms');

    const subscribedApi = capturingApi(OK_SUBSCRIBED);
    const r1 = await proxy.handleToolCall('send_message_to_agent', { agent_id: 't-1', message: 'hi' }, subscribedApi);
    assert.ok(/one-turn subscription/.test(r1.content[0].text), 'registered → mentions one-turn subscription');

    const plainApi = capturingApi({ confirmed: true, mode: 'hook' });
    const r2 = await proxy.handleToolCall('send_message_to_agent', { agent_id: 't-1', message: 'hi' }, plainApi);
    assert.ok(!/one-turn subscription/.test(r2.content[0].text), 'no transientSubscription → no subscription mention');
    assert.ok(/goes idle/.test(r2.content[0].text), 'falls back to the plain idle-event line');
  } finally { if (prev === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = prev; }
});

// ── Context-brick Inc 1 (B1/B2): CALLER_HEADERS env → header mapping ────────
//
// CALLER_HEADERS is built once at module scope from AGENT_DASHBOARD_<PART>_ID
// env vars. The agent running these tests may itself carry AGENT_DASHBOARD_*
// identity env, so the helper strips ALL of it first, sets exactly the fixture
// set, reloads the proxy, and restores the original env afterwards.

function withCallerEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGENT_DASHBOARD_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  const restore = () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AGENT_DASHBOARD_')) delete process.env[key];
    }
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  };
  return (async () => fn())().finally(restore);
}

test('26. CALLER_HEADERS maps AGENT_DASHBOARD_*_ID env to X-*-Id headers; _API_TOKEN/_API_PORT excluded', () =>
  withCallerEnv({
    AGENT_DASHBOARD_SELF_ID: 'agent-1',
    AGENT_DASHBOARD_SUPERVISOR_ID: 'sup-1',
    AGENT_DASHBOARD_WORKSPACE_ID: 'ws-1',
    AGENT_DASHBOARD_PROJECT_ID: 'proj-1',
    AGENT_DASHBOARD_FOO_BAR_ID: 'fb-1', // generic multi-part: zero shim work for future ids
    AGENT_DASHBOARD_API_TOKEN: 'secret', // must NOT become a header
    AGENT_DASHBOARD_API_PORT: '12345',   // must NOT become a header
    AGENT_DASHBOARD_API_HOST: '127.0.0.1',
  }, () => {
    const proxy = loadProxy('observability');
    assert.deepStrictEqual(proxy.CALLER_HEADERS, {
      'X-Self-Id': 'agent-1',
      'X-Supervisor-Id': 'sup-1',
      'X-Workspace-Id': 'ws-1',
      'X-Project-Id': 'proj-1',
      'X-Foo-Bar-Id': 'fb-1',
    });
  }));

test('27. CALLER_HEADERS empty when no identity env is set (header-unset shim is harmless)', () =>
  withCallerEnv({ AGENT_DASHBOARD_API_HOST: '127.0.0.1' }, () => {
    const proxy = loadProxy('observability');
    assert.deepStrictEqual(proxy.CALLER_HEADERS, {});
  }));

test('28. createApiRequest forwards CALLER_HEADERS + Authorization on the wire', async () => {
  const httpMod = require('http');
  const received = [];
  const server = httpMod.createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await withCallerEnv({
      AGENT_DASHBOARD_WORKSPACE_ID: 'ws-wire',
      AGENT_DASHBOARD_SELF_ID: 'self-wire',
      AGENT_DASHBOARD_API_PORT: String(port),
      AGENT_DASHBOARD_API_HOST: '127.0.0.1',
    }, async () => {
      const proxy = loadProxy('observability');
      const apiRequest = proxy.createApiRequest('tok-wire');
      const result = await apiRequest('GET', '/api/anything');
      assert.deepStrictEqual(result, { ok: true });
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0]['x-workspace-id'], 'ws-wire');
      assert.strictEqual(received[0]['x-self-id'], 'self-wire');
      assert.strictEqual(received[0]['authorization'], 'Bearer tok-wire');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Context-brick Inc 3 (3.2): list_my_agents shim wiring ───────────────────

test('29. list_my_agents (no args) GETs /api/supervisor/owned-agents with no query params', async () => {
  const proxy = loadProxy('observability');
  const payload = { ownerId: 'sup-1', includeTerminal: false, agents: [] };
  const api = capturingApi(payload);
  const result = await proxy.handleToolCall('list_my_agents', {}, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].method, 'GET');
  assert.strictEqual(api.calls[0].route, '/api/supervisor/owned-agents');
  assert.deepStrictEqual(JSON.parse(result.content[0].text), payload);
});

test('30. list_my_agents forwards include_terminal + limit as query params', async () => {
  const proxy = loadProxy('observability');
  const api = capturingApi({ ownerId: 'sup-1', includeTerminal: true, agents: [] });
  await proxy.handleToolCall('list_my_agents', { include_terminal: true, limit: 5 }, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].route, '/api/supervisor/owned-agents?includeTerminal=true&limit=5');
});

test('31. list_my_agents schema exposes NO agent/owner id arg (owner is identity-derived)', () => {
  clearProxyModules();
  const observability = require('./mcp-tools-observability');
  const def = observability.getObservabilityToolDefinitions().find((d) => d.name === 'list_my_agents');
  assert.ok(def, 'list_my_agents definition registered');
  assert.deepStrictEqual(Object.keys(def.inputSchema.properties).sort(), ['include_terminal', 'limit']);
  assert.ok(!('required' in def.inputSchema) || def.inputSchema.required.length === 0, 'no required args');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${t.name}`);
      console.error(err && err.stack ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} mcp-dashboard tests passed`);
})();
