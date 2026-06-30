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
    'get_context_stats',
    'get_kernel_state',
    'get_team',
    'interrupt_kernel',
    'list_agents',
    'list_teams',
    'list_templates',
    'open_file_in_view',
    'read_agent_chat',
    'read_agent_files_touched',
    'read_agent_log',
    'restart_kernel',
    'send_message_to_agent',
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
