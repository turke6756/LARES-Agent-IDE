// WP3 Stage 6(a) — unit tests for the planning-surface MCP tool module.
// Run via: node scripts/mcp-tools-plans.test.js
// Pure node: no Electron, no stdio MCP loop, no env token required. Identity
// (X-Self-Id) is threaded by apiRequest's CALLER_HEADERS spread at the HTTP
// layer, so these dispatch tests exercise only path/body/response shaping.

const assert = require('assert');
const {
  getPlansToolDefinitions,
  getPlansReadToolDefinitions,
  handlePlansToolCall,
  handlePlansReadToolCall,
} = require('./mcp-tools-plans');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Tool surface ────────────────────────────────────────────────────────────

test('the plans toolset — activity read + focus verbs (supervisor lane)', () => {
  const names = getPlansToolDefinitions().map((t) => t.name);
  assert.deepStrictEqual(names.sort(), [
    'focus_plan',
    'read_plan_projection',
    'record_planning_event',
    'unfocus_plan',
  ]);
});

test('focus_plan / unfocus_plan are supervisor-only — absent from the plans-read subset', () => {
  const readNames = getPlansReadToolDefinitions().map((t) => t.name);
  assert.ok(!readNames.includes('focus_plan'), 'plans-read must NOT advertise focus_plan');
  assert.ok(!readNames.includes('unfocus_plan'), 'plans-read must NOT advertise unfocus_plan');
});

test('F-F: NO migrate_plan_markdown tool, and nothing advertises markdown-migration input', () => {
  // Markdown→six-zones migration is deferred out of v1 (amendments F-F). The tool
  // must neither exist nor advertise a seed_markdown / migrate input anywhere in
  // its schema — the boundary rejects such input with a 400, never silent-ignores.
  const defs = getPlansToolDefinitions();
  assert.ok(!defs.some((d) => /migrate/i.test(d.name)), 'no migrate_plan_markdown tool');
  for (const def of defs) {
    const props = def.inputSchema.properties || {};
    for (const key of Object.keys(props)) {
      assert.ok(
        !/seed[-_ ]?markdown|migrate|^markdown$/i.test(key),
        `${def.name} must not advertise the markdown-migration input "${key}"`,
      );
    }
  }
});

test('every definition has a description and an object inputSchema with required[]', () => {
  for (const def of getPlansToolDefinitions()) {
    assert.ok(def.description && def.description.length > 50, `${def.name} description too thin`);
    assert.strictEqual(def.inputSchema.type, 'object');
    assert.ok(Array.isArray(def.inputSchema.required), `${def.name} missing required[]`);
  }
});

// ── WP-A4: plans-read read-only subset (worker lane) ────────────────────────

test('getPlansReadToolDefinitions returns the activity read + record_planning_event', () => {
  const names = getPlansReadToolDefinitions().map((t) => t.name);
  assert.deepStrictEqual(names.sort(), [
    'read_plan_projection',
    'record_planning_event',
  ]);
});

test('READ_DEFS make plan_id optional (shared by plans + plans-read)', () => {
  for (const def of getPlansReadToolDefinitions()) {
    assert.ok(!def.inputSchema.required.includes('plan_id'),
      `${def.name} must not require plan_id (env-default scoping)`);
  }
});

test('retired create_plan is not handled and makes no HTTP call', async () => {
  const api = fakeApi({});
  assert.strictEqual(await handlePlansToolCall('create_plan', {}, api), null);
  assert.strictEqual(await handlePlansReadToolCall('create_plan', {}, api), null);
  assert.strictEqual(api.calls.length, 0, 'the retired tool must not issue an HTTP call');
});

test('handlePlansReadToolCall delegates the activity read to the shared handler', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection': { sections: [{ anchor: 'sec_abc123' }] },
  });
  const r = await handlePlansReadToolCall('read_plan_projection', { plan_id: 'plan-1' }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection');
  assert.match(r.content[0].text, /sec_abc123/);
});

test('handlePlansReadToolCall returns null for non-plan tool names', async () => {
  const api = fakeApi({});
  assert.strictEqual(await handlePlansReadToolCall('list_agents', {}, api), null);
  assert.strictEqual(api.calls.length, 0);
});

test('omitted plan_id falls back to AGENT_DASHBOARD_PLAN_ID', async () => {
  const prev = process.env.AGENT_DASHBOARD_PLAN_ID;
  process.env.AGENT_DASHBOARD_PLAN_ID = 'env-plan-9';
  try {
    const api = fakeApi({
      'GET /api/plans/env-plan-9/projection': { sections: [] },
    });
    await handlePlansToolCall('read_plan_projection', {}, api);
    assert.strictEqual(api.calls[0].path, '/api/plans/env-plan-9/projection');
    // Same env-default path via the plans-read dispatcher.
    await handlePlansReadToolCall('read_plan_projection', {}, api);
    assert.strictEqual(api.calls[1].path, '/api/plans/env-plan-9/projection');
  } finally {
    if (prev === undefined) delete process.env.AGENT_DASHBOARD_PLAN_ID;
    else process.env.AGENT_DASHBOARD_PLAN_ID = prev;
  }
});

test('absent plan_id AND absent env → clear error, no HTTP call', async () => {
  const prev = process.env.AGENT_DASHBOARD_PLAN_ID;
  delete process.env.AGENT_DASHBOARD_PLAN_ID;
  try {
    const api = fakeApi({});
    const r = await handlePlansToolCall('read_plan_projection', {}, api);
    assert.ok(r.isError);
    assert.match(r.content[0].text, /no plan_id supplied and no dispatched plan in env/);
    assert.strictEqual(api.calls.length, 0, 'no HTTP call when plan_id is unresolvable');
  } finally {
    if (prev === undefined) delete process.env.AGENT_DASHBOARD_PLAN_ID;
    else process.env.AGENT_DASHBOARD_PLAN_ID = prev;
  }
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

test('returns null for non-plan tool names (caller switch keeps handling them)', async () => {
  const api = fakeApi({});
  assert.strictEqual(await handlePlansToolCall('list_agents', {}, api), null);
  assert.strictEqual(await handlePlansToolCall('browser_open_url', {}, api), null);
  assert.strictEqual(api.calls.length, 0);
});

// ── focus_plan / unfocus_plan (planning-surface P1 explicit verbs) ───────────

test('focus_plan POSTs { plan_id } to the identity-scoped /self route (no supervisor_id sent)', async () => {
  const api = fakeApi({
    'POST /api/supervisor-focus/self': { supervisorId: 'sup-1', planId: 'plan-1', notes: null },
  });
  const r = await handlePlansToolCall('focus_plan', { plan_id: 'plan-1' }, api);
  assert.deepStrictEqual(api.calls[0], {
    method: 'POST', path: '/api/supervisor-focus/self', body: { plan_id: 'plan-1' },
  });
  assert.match(r.content[0].text, /"planId": "plan-1"/);
});

test('focus_plan threads an optional note; the subscriber is server-derived, never a body arg', async () => {
  const api = fakeApi({
    'POST /api/supervisor-focus/self': { supervisorId: 'sup-1', planId: 'plan-1', notes: 'watch' },
  });
  await handlePlansToolCall('focus_plan', { plan_id: 'plan-1', notes: 'watch' }, api);
  assert.deepStrictEqual(api.calls[0].body, { plan_id: 'plan-1', notes: 'watch' });
  assert.ok(!('supervisor_id' in api.calls[0].body), 'focus_plan must not send a supervisor_id');
});

test('unfocus_plan DELETEs the identity-scoped /self/:plan_id route', async () => {
  const api = fakeApi({
    'DELETE /api/supervisor-focus/self/plan-1': { ok: true, supervisorId: 'sup-1', planId: 'plan-1' },
  });
  const r = await handlePlansToolCall('unfocus_plan', { plan_id: 'plan-1' }, api);
  assert.strictEqual(api.calls[0].method, 'DELETE');
  assert.strictEqual(api.calls[0].path, '/api/supervisor-focus/self/plan-1');
  assert.match(r.content[0].text, /"ok": true/);
});

test('focus_plan / unfocus_plan fall back to AGENT_DASHBOARD_PLAN_ID when plan_id omitted', async () => {
  const prev = process.env.AGENT_DASHBOARD_PLAN_ID;
  process.env.AGENT_DASHBOARD_PLAN_ID = 'env-plan-7';
  try {
    const api = fakeApi({
      'POST /api/supervisor-focus/self': { supervisorId: 'sup-1', planId: 'env-plan-7' },
      'DELETE /api/supervisor-focus/self/env-plan-7': { ok: true },
    });
    await handlePlansToolCall('focus_plan', {}, api);
    await handlePlansToolCall('unfocus_plan', {}, api);
    assert.strictEqual(api.calls[0].body.plan_id, 'env-plan-7');
    assert.strictEqual(api.calls[1].path, '/api/supervisor-focus/self/env-plan-7');
  } finally {
    if (prev === undefined) delete process.env.AGENT_DASHBOARD_PLAN_ID;
    else process.env.AGENT_DASHBOARD_PLAN_ID = prev;
  }
});

test('focus_plan / unfocus_plan with no plan_id and no env → clear error, no HTTP call', async () => {
  const prev = process.env.AGENT_DASHBOARD_PLAN_ID;
  delete process.env.AGENT_DASHBOARD_PLAN_ID;
  try {
    const api = fakeApi({});
    for (const name of ['focus_plan', 'unfocus_plan']) {
      const r = await handlePlansToolCall(name, {}, api);
      assert.ok(r.isError, `${name} with no plan_id must error`);
      assert.match(r.content[0].text, /no plan_id supplied and no dispatched plan in env/);
    }
    assert.strictEqual(api.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_DASHBOARD_PLAN_ID;
    else process.env.AGENT_DASHBOARD_PLAN_ID = prev;
  }
});

test('handlePlansReadToolCall rejects focus_plan / unfocus_plan (write tools, supervisor-only)', async () => {
  const api = fakeApi({});
  for (const name of ['focus_plan', 'unfocus_plan']) {
    const r = await handlePlansReadToolCall(name, { plan_id: 'plan-1' }, api);
    assert.ok(r.isError, `${name} via plans-read must be an error`);
    assert.match(r.content[0].text, new RegExp(`${name} is not available`));
  }
  assert.strictEqual(api.calls.length, 0, 'no HTTP call may be made for a rejected write tool');
});

test('read_plan_projection GETs /api/plans/:id/projection and serializes', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection': { sections: [{ anchor: 'sec_abc123', eventCount: 3 }] },
  });
  const r = await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1' }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection');
  assert.match(r.content[0].text, /"eventCount": 3/);
});

// ── I-7: read_plan_projection events opt-in + clamp + section scoping ─────────

test('read_plan_projection def advertises events / events_limit / section_anchor', () => {
  const def = getPlansReadToolDefinitions().find((d) => d.name === 'read_plan_projection');
  const props = def.inputSchema.properties;
  assert.strictEqual(props.events.type, 'boolean');
  assert.strictEqual(props.events_limit.type, 'number');
  assert.strictEqual(props.section_anchor.type, 'string');
  assert.ok(!def.inputSchema.required.includes('events'), 'events is opt-in, never required');
});

test('read_plan_projection {events:true} → events=full&events_limit=50 (default cap)', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?events=full&events_limit=50': { sections: [], events: [] },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', events: true }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?events=full&events_limit=50');
});

test('read_plan_projection {events:true, events_limit:5000} → clamped to hard max 200', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?events=full&events_limit=200': { sections: [], events: [] },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', events: true, events_limit: 5000 }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?events=full&events_limit=200');
});

test('read_plan_projection {events:true, events_limit:-3} → clamped to 0', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?events=full&events_limit=0': { sections: [], events: [] },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', events: true, events_limit: -3 }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?events=full&events_limit=0');
});

test('read_plan_projection threads events_limit + section_anchor together', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?events=full&events_limit=12&section_anchor=sec_x': { sections: [], events: [] },
  });
  await handlePlansToolCall(
    'read_plan_projection',
    { plan_id: 'plan-1', events: true, events_limit: 12, section_anchor: 'sec_x' },
    api,
  );
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?events=full&events_limit=12&section_anchor=sec_x');
});

test('read_plan_projection with no events flag → bare /projection (parity floor unchanged)', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection': { sections: [] },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', section_anchor: 'sec_x' }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection', 'no events:true → no query at all');
});

// ── Fix-4 §4d: event_detail_id Tier-3 drill-down threading ───────────────────

test('read_plan_projection def advertises event_detail_id (Tier-3 drill-down param)', () => {
  const def = getPlansReadToolDefinitions().find((d) => d.name === 'read_plan_projection');
  assert.strictEqual(def.inputSchema.properties.event_detail_id.type, 'string');
  assert.ok(!def.inputSchema.required.includes('event_detail_id'), 'event_detail_id is opt-in');
  assert.match(def.description, /drill|detail|witnessed/i, 'description mentions the drill-down');
});

test('read_plan_projection {event_detail_id} alone → ?event_detail_id=… (independent of events)', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?event_detail_id=ev-7': { sections: [], eventDetail: null },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', event_detail_id: 'ev-7' }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?event_detail_id=ev-7',
    'a detail fetch needs no events=full listing');
});

test('read_plan_projection threads event_detail_id alongside events=full', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?events=full&events_limit=50&event_detail_id=ev-9': { sections: [], events: [] },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', events: true, event_detail_id: 'ev-9' }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?events=full&events_limit=50&event_detail_id=ev-9');
});

test('read_plan_projection URL-encodes an event_detail_id with unsafe chars', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?event_detail_id=a%2Fb%20c': { sections: [], eventDetail: null },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', event_detail_id: 'a/b c' }, api);
  assert.strictEqual(api.calls[0].path, '/api/plans/plan-1/projection?event_detail_id=a%2Fb%20c');
});

test('read_plan_projection without event_detail_id → no event_detail_id param', async () => {
  const api = fakeApi({
    'GET /api/plans/plan-1/projection?events=full&events_limit=50': { sections: [], events: [] },
  });
  await handlePlansToolCall('read_plan_projection', { plan_id: 'plan-1', events: true }, api);
  assert.ok(!api.calls[0].path.includes('event_detail_id'), 'absent arg → param omitted');
});

// ── Wiring into mcp-dashboard.js (static check for the plans toolset) ────────

test('mcp-dashboard.js registers plans as a lazy toolset', () => {
  const dashboardSrc = require('fs').readFileSync(require('path').join(__dirname, 'mcp-dashboard.js'), 'utf8');
  assert.match(dashboardSrc, /plans:\s*\(\)\s*=>/);
  assert.match(dashboardSrc, /require\('\.\/mcp-tools-plans'\)/);
  assert.match(dashboardSrc, /getPlansToolDefinitions/);
  assert.match(dashboardSrc, /handlePlansToolCall/);
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
  console.log(`\nAll ${tests.length} mcp-tools-plans tests passed`);
})();
