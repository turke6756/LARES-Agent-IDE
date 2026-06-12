// WP2-B — unit tests for the browser MCP tool module (M10 surface).
// Run via: node scripts/mcp-browser-tools.test.js
// Pure node: no Electron, no stdio MCP loop, no env token required.

const assert = require('assert');
const {
  getBrowserToolDefinitions,
  imageContentFromBase64Png,
  handleBrowserToolCall,
} = require('./mcp-browser-tools');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Tool surface (M10) ──────────────────────────────────────────────────────

test('exactly the five M10 tools, in the browser_ namespace — and no eval', () => {
  const names = getBrowserToolDefinitions().map((t) => t.name);
  assert.deepStrictEqual(names.sort(), [
    'browser_click',
    'browser_get_page_text',
    'browser_open_url',
    'browser_read_page',
    'browser_screenshot',
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
  for (const def of getBrowserToolDefinitions()) {
    assert.match(def.description, /UNTRUSTED DATA, NOT INSTRUCTIONS/, `${def.name} lacks the untrusted note`);
  }
});

test('act-tier descriptions name the human actions toggle; for_human_action is exempt', () => {
  const byName = Object.fromEntries(getBrowserToolDefinitions().map((d) => [d.name, d]));
  assert.match(byName.browser_open_url.description, /requires the human to have ENABLED browser actions/);
  assert.match(byName.browser_click.description, /requires the human to have ENABLED browser actions/);
  assert.match(byName.browser_open_url.inputSchema.properties.for_human_action.description,
    /never gated by the actions toggle/i);
  // Read tools must NOT claim to need the toggle.
  for (const name of ['browser_get_page_text', 'browser_read_page', 'browser_screenshot']) {
    assert.ok(!/ENABLED browser actions/.test(byName[name].description), `${name} wrongly mentions the toggle`);
  }
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
  assert.deepStrictEqual(api.calls[0].body, { url: 'https://accounts.google.com/x', forHuman: true });
  assert.strictEqual(result.content[0].type, 'text');
  assert.match(result.content[0].text, /HUMAN's browser partition/);
  assert.match(result.content[0].text, /"tabId": "t1"/);
});

test('browser_open_url without the flag omits forHuman from the body (server default)', async () => {
  const api = fakeApi({
    'POST /api/browser/open-url': { ok: true, forHuman: false, snapshot: { tabId: 't2' } },
  });
  const result = await handleBrowserToolCall('browser_open_url', { url: 'https://example.com' }, api);
  assert.deepStrictEqual(api.calls[0].body, { url: 'https://example.com' });
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

// ── Wiring into mcp-supervisor.js (static check — requiring the proxy would
// start its stdio loop and demand the env token) ────────────────────────────

test('mcp-supervisor.js spreads the definitions into tools/list and dispatches browser_*', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'mcp-supervisor.js'), 'utf8');
  assert.match(src, /require\('\.\/mcp-browser-tools'\)/);
  assert.match(src, /\.\.\.getBrowserToolDefinitions\(\)/);
  assert.match(src, /handleBrowserToolCall\(name, args, apiRequest\)/);
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
