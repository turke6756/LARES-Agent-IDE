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
    'browser_list_tabs',
    'browser_open_url',
    'browser_press_key',
    'browser_read_page',
    'browser_reload',
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
