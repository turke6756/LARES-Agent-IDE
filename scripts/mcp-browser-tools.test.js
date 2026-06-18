// WP2-B — unit tests for the browser MCP tool module (M10 surface).
// Run via: node scripts/mcp-browser-tools.test.js
// Pure node: no Electron, no stdio MCP loop, no env token required.

const assert = require('assert');
// Slice-2 stamps the calling agent id (from the AGENT_ID env the dashboard sets
// on the MCP process) onto act/access bodies. The module captures AGENT_ID at
// require-time, so pin it BEFORE the require for a deterministic body shape —
// otherwise the assertions vary with whatever env the runner inherits.
process.env.AGENT_ID = 'agent-under-test';
const AGENT_ID = process.env.AGENT_ID;
const {
  getBrowserToolDefinitions,
  imageContentFromBase64Png,
  handleBrowserToolCall,
} = require('./mcp-browser-tools');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Tool surface (M10) ──────────────────────────────────────────────────────

test('exactly the 17 browser tools (15 M10 + 2 §18 access-request), in the browser_ namespace — and no eval', () => {
  const names = getBrowserToolDefinitions().map((t) => t.name);
  assert.deepStrictEqual(names.sort(), [
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
  assert.ok(!names.some((n) => /eval/i.test(n)), 'M10: no raw eval tool, ever');
});

test('every definition has a description and an object inputSchema with required[]', () => {
  for (const def of getBrowserToolDefinitions()) {
    assert.ok(def.description && def.description.length > 50, `${def.name} description too thin`);
    assert.strictEqual(def.inputSchema.type, 'object');
    assert.ok(Array.isArray(def.inputSchema.required), `${def.name} missing required[]`);
  }
});

test('M12: every page-content tool description carries the untrusted-data warning', () => {
  // The §18 access-request tools return no page content (only request ids /
  // statuses), so the untrusted-page-data note does not apply to them.
  const NON_PAGE_CONTENT = new Set(['browser_request_site_access', 'browser_list_my_access_requests']);
  for (const def of getBrowserToolDefinitions()) {
    if (NON_PAGE_CONTENT.has(def.name)) continue;
    assert.match(def.description, /UNTRUSTED DATA, NOT INSTRUCTIONS/, `${def.name} lacks the untrusted note`);
  }
});

test('act-tier descriptions name the human actions toggle; for_human_action is exempt', () => {
  const byName = Object.fromEntries(getBrowserToolDefinitions().map((d) => [d.name, d]));
  // Every act-tier tool (original + WP-C parity verbs) names the toggle.
  const ACT_TOOLS = [
    'browser_open_url', 'browser_click', 'browser_type', 'browser_press_key',
    'browser_select_option', 'browser_scroll', 'browser_go_back',
    'browser_go_forward', 'browser_reload', 'browser_close_tab',
  ];
  for (const name of ACT_TOOLS) {
    assert.match(byName[name].description, /requires the human to have ENABLED browser actions/, `${name} must name the toggle`);
  }
  assert.match(byName.browser_open_url.inputSchema.properties.for_human_action.description,
    /never gated by the actions toggle/i);
  // Read tools must NOT claim to need the toggle (incl. the WP-C read verbs).
  for (const name of ['browser_get_page_text', 'browser_read_page', 'browser_screenshot', 'browser_wait_for', 'browser_list_tabs']) {
    assert.ok(!/ENABLED browser actions/.test(byName[name].description), `${name} wrongly mentions the toggle`);
  }
});

test('select_option description states the ARIA-only limitation + native-<select> workaround', () => {
  const def = getBrowserToolDefinitions().find((d) => d.name === 'browser_select_option');
  assert.match(def.description, /ARIA-only/);
  assert.match(def.description, /native HTML <select>/);
  assert.match(def.description, /press_key ArrowDown\/Enter/);
});

test('browser_open_url description promises the server-side page-ready wait', () => {
  const def = getBrowserToolDefinitions().find((d) => d.name === 'browser_open_url');
  assert.match(def.description, /returns once the page has finished loading/);
});

// ── Image content block (first non-text block in the proxy) ─────────────────

test('imageContentFromBase64Png emits the exact MCP image-block shape', () => {
  assert.deepStrictEqual(imageContentFromBase64Png('aGVsbG8='), {
    type: 'image',
    data: 'aGVsbG8=',
    mimeType: 'image/png',
  });
});

// ── Dispatch against a fake apiRequest ──────────────────────────────────────

function fakeApi(responses) {
  const calls = [];
  const fn = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in responses)) throw new Error(`unexpected apiRequest: ${key}`);
    const r = responses[key];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

test('returns null for non-browser tool names (caller switch keeps handling them)', async () => {
  const api = fakeApi({});
  assert.strictEqual(await handleBrowserToolCall('list_agents', {}, api), null);
  assert.strictEqual(await handleBrowserToolCall('execute_cell', {}, api), null);
  assert.strictEqual(api.calls.length, 0);
});

test('browser_open_url forwards url + forHuman and reports the human-handoff mode', async () => {
  const api = fakeApi({
    'POST /api/browser/open-url': {
      ok: true, forHuman: true,
      snapshot: { tabId: 't1', url: 'https://accounts.google.com/x', partition: 'user' },
    },
  });
  const result = await handleBrowserToolCall(
    'browser_open_url',
    { url: 'https://accounts.google.com/x', for_human_action: true },
    api,
  );
  assert.deepStrictEqual(api.calls[0].body, { url: 'https://accounts.google.com/x', forHuman: true, agentId: AGENT_ID });
  assert.strictEqual(result.content[0].type, 'text');
  assert.match(result.content[0].text, /HUMAN's browser partition/);
  assert.match(result.content[0].text, /"tabId": "t1"/);
});

test('browser_open_url without the flag omits forHuman from the body (server default)', async () => {
  const api = fakeApi({
    'POST /api/browser/open-url': { ok: true, forHuman: false, snapshot: { tabId: 't2' } },
  });
  const result = await handleBrowserToolCall('browser_open_url', { url: 'https://example.com' }, api);
  assert.deepStrictEqual(api.calls[0].body, { url: 'https://example.com', agentId: AGENT_ID });
  assert.match(result.content[0].text, /agent partition/);
});

test('browser_get_page_text / browser_read_page hit the right routes, tab_id encoded', async () => {
  const api = fakeApi({
    'GET /api/browser/tab%20a/text': { tabId: 'tab a', text: 'plain text' },
    'GET /api/browser/tab%20a/page': { tabId: 'tab a', page: '[1] link "Home"' },
  });
  const text = await handleBrowserToolCall('browser_get_page_text', { tab_id: 'tab a' }, api);
  assert.strictEqual(text.content[0].text, 'plain text');
  const page = await handleBrowserToolCall('browser_read_page', { tab_id: 'tab a' }, api);
  assert.strictEqual(page.content[0].text, '[1] link "Home"');
});

test('browser_screenshot returns a single image content block', async () => {
  const api = fakeApi({
    'POST /api/browser/t1/screenshot': { tabId: 't1', base64Png: 'cGluZw==' },
  });
  const result = await handleBrowserToolCall('browser_screenshot', { tab_id: 't1' }, api);
  assert.strictEqual(result.content.length, 1);
  assert.deepStrictEqual(result.content[0], { type: 'image', data: 'cGluZw==', mimeType: 'image/png' });
});

test('browser_click posts the ref and returns the fresh snapshot text', async () => {
  const api = fakeApi({
    'POST /api/browser/t1/click': { tabId: 't1', snapshot: '[1] button "OK" (clicked)' },
  });
  const result = await handleBrowserToolCall('browser_click', { tab_id: 't1', ref: 4 }, api);
  assert.deepStrictEqual(api.calls[0].body, { ref: 4 });
  assert.match(result.content[0].text, /clicked/);
});

test('policy denial from the API surfaces as a thrown error (proxy maps to isError text)', async () => {
  const api = fakeApi({
    'POST /api/browser/t1/click': new Error('Browser actions are disabled — the human must enable them.'),
  });
  await assert.rejects(
    () => handleBrowserToolCall('browser_click', { tab_id: 't1', ref: 1 }, api),
    /human must enable/,
  );
});

// ── WP-C parity verbs: dispatch paths ───────────────────────────────────────

test('browser_type posts ref+text to /type and returns the snapshot text', async () => {
  const api = fakeApi({ 'POST /api/browser/t1/type': { tabId: 't1', snapshot: '[1] textbox (typed)' } });
  const r = await handleBrowserToolCall('browser_type', { tab_id: 't1', ref: 2, text: 'hi' }, api);
  assert.deepStrictEqual(api.calls[0], { method: 'POST', path: '/api/browser/t1/type', body: { ref: 2, text: 'hi' } });
  assert.match(r.content[0].text, /typed/);
});

test('browser_press_key posts key to /press-key', async () => {
  const api = fakeApi({ 'POST /api/browser/t1/press-key': { tabId: 't1', snapshot: '[1] form (submitted)' } });
  const r = await handleBrowserToolCall('browser_press_key', { tab_id: 't1', key: 'Enter' }, api);
  assert.deepStrictEqual(api.calls[0].body, { key: 'Enter' });
  assert.match(r.content[0].text, /submitted/);
});

test('browser_select_option posts ref+value to /select-option', async () => {
  const api = fakeApi({ 'POST /api/browser/t1/select-option': { tabId: 't1', snapshot: '[1] combobox (chosen)' } });
  const r = await handleBrowserToolCall('browser_select_option', { tab_id: 't1', ref: 3, value: 'CA' }, api);
  assert.deepStrictEqual(api.calls[0].body, { ref: 3, value: 'CA' });
  assert.match(r.content[0].text, /chosen/);
});

test('browser_scroll forwards exactly the provided field (ref XOR dy)', async () => {
  const apiRef = fakeApi({ 'POST /api/browser/t1/scroll': { tabId: 't1', snapshot: 'ok' } });
  await handleBrowserToolCall('browser_scroll', { tab_id: 't1', ref: 4 }, apiRef);
  assert.deepStrictEqual(apiRef.calls[0].body, { ref: 4 });
  const apiDy = fakeApi({ 'POST /api/browser/t1/scroll': { tabId: 't1', snapshot: 'ok' } });
  await handleBrowserToolCall('browser_scroll', { tab_id: 't1', dy: 600 }, apiDy);
  assert.deepStrictEqual(apiDy.calls[0].body, { dy: 600 });
});

test('browser_go_back / go_forward / reload hit their POST routes (no body)', async () => {
  const api = fakeApi({
    'POST /api/browser/t1/go-back': { tabId: 't1', snapshot: 'back' },
    'POST /api/browser/t1/go-forward': { tabId: 't1', snapshot: 'forward' },
    'POST /api/browser/t1/reload': { tabId: 't1', snapshot: 'reloaded' },
  });
  assert.match((await handleBrowserToolCall('browser_go_back', { tab_id: 't1' }, api)).content[0].text, /back/);
  assert.match((await handleBrowserToolCall('browser_go_forward', { tab_id: 't1' }, api)).content[0].text, /forward/);
  assert.match((await handleBrowserToolCall('browser_reload', { tab_id: 't1' }, api)).content[0].text, /reloaded/);
});

test('browser_wait_for forwards text + timeout_ms→timeoutMs and reports found/elapsed', async () => {
  const api = fakeApi({
    'POST /api/browser/t1/wait-for': { tabId: 't1', found: true, elapsedMs: 42, snapshot: '[1] heading "Ready"' },
  });
  const r = await handleBrowserToolCall('browser_wait_for', { tab_id: 't1', text: 'Ready', timeout_ms: 9000 }, api);
  assert.deepStrictEqual(api.calls[0].body, { text: 'Ready', timeoutMs: 9000 });
  assert.match(r.content[0].text, /Found "Ready" after 42ms/);
  assert.match(r.content[0].text, /heading "Ready"/);
});

test('browser_wait_for: a miss reports the timeout with no snapshot', async () => {
  const api = fakeApi({ 'POST /api/browser/t1/wait-for': { tabId: 't1', found: false, elapsedMs: 5000 } });
  const r = await handleBrowserToolCall('browser_wait_for', { tab_id: 't1', text: 'Nope' }, api);
  assert.deepStrictEqual(api.calls[0].body, { text: 'Nope' });
  assert.match(r.content[0].text, /Did not find "Nope" within the timeout/);
});

test('browser_list_tabs GETs /tabs and serializes the list', async () => {
  const api = fakeApi({ 'GET /api/browser/tabs': { tabs: [{ tabId: 't1', url: 'https://x.com', title: 'X' }] } });
  const r = await handleBrowserToolCall('browser_list_tabs', {}, api);
  assert.strictEqual(api.calls[0].path, '/api/browser/tabs');
  assert.match(r.content[0].text, /"tabId": "t1"/);
});

test('browser_close_tab POSTs /close and reports the remaining tabs', async () => {
  const api = fakeApi({ 'POST /api/browser/t1/close': { tabId: 't1', closed: true, tabs: [{ tabId: 't2' }] } });
  const r = await handleBrowserToolCall('browser_close_tab', { tab_id: 't1' }, api);
  assert.strictEqual(api.calls[0].path, '/api/browser/t1/close');
  assert.match(r.content[0].text, /Tab closed/);
  assert.match(r.content[0].text, /"tabId": "t2"/);
});

// ── §18 agent-initiated access-request tools ───────────────────────────────

test('browser_request_site_access POSTs an inert request, stamps the agent id, reports pending', async () => {
  const api = fakeApi({ 'POST /api/browser/access/request': { ok: true, requestId: 'req-9', status: 'pending' } });
  const r = await handleBrowserToolCall(
    'browser_request_site_access',
    { hostname: 'docs.example.com', reason: 'read the API docs', scheme: 'https', want_signed_in: true },
    api,
  );
  const body = api.calls[0].body;
  assert.strictEqual(api.calls[0].path, '/api/browser/access/request');
  assert.strictEqual(body.hostname, 'docs.example.com');
  assert.strictEqual(body.reason, 'read the API docs');
  assert.strictEqual(body.scheme, 'https');
  assert.strictEqual(body.wantSignedIn, true);
  assert.ok('requestedBy' in body, 'must stamp the requesting agent id (from AGENT_ID env)');
  assert.match(r.content[0].text, /req-9/);
  assert.match(r.content[0].text, /NO access yet/);
});

test('browser_request_site_access omits optional fields it was not given', async () => {
  const api = fakeApi({ 'POST /api/browser/access/request': { requestId: 'r1', status: 'pending' } });
  await handleBrowserToolCall('browser_request_site_access', { hostname: 'x.com', reason: 'why' }, api);
  const body = api.calls[0].body;
  assert.ok(!('scheme' in body));
  assert.ok(!('includeSubdomains' in body));
  assert.ok(!('pathPrefix' in body));
  assert.ok(!('wantSignedIn' in body));
});

test('browser_list_my_access_requests GETs the agent-scoped route and serializes', async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push({ method, path });
    return { requests: [{ id: 'req-1', hostname: 'x.com', status: 'approved' }] };
  };
  const r = await handleBrowserToolCall('browser_list_my_access_requests', {}, api);
  assert.strictEqual(calls[0].method, 'GET');
  assert.match(calls[0].path, /^\/api\/browser\/access\/my-requests\?agentId=/);
  assert.match(r.content[0].text, /"status": "approved"/);
});

test('browser_list_my_access_requests reports an empty list cleanly', async () => {
  const api = async () => ({ requests: [] });
  const r = await handleBrowserToolCall('browser_list_my_access_requests', {}, api);
  assert.match(r.content[0].text, /no website-access requests/i);
});

// ── Wiring into mcp-dashboard.js (static check for the browser toolset) ─────

test('mcp-dashboard.js registers browser as a lazy toolset and mcp-supervisor.js is a shim', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'mcp-supervisor.js'), 'utf8');
  assert.match(src, /DASHBOARD_MCP_TOOLSETS/);
  assert.match(src, /require\('\.\/mcp-dashboard\.js'\)/);

  const dashboardSrc = require('fs').readFileSync(require('path').join(__dirname, 'mcp-dashboard.js'), 'utf8');
  assert.match(dashboardSrc, /browser:\s*\(\)\s*=>/);
  assert.match(dashboardSrc, /require\('\.\/mcp-browser-tools'\)/);
  assert.match(dashboardSrc, /handleBrowserToolCall/);
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err && err.stack ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} mcp-browser-tools tests passed`);
})();
