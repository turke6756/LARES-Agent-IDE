// B2 Task B — plans HTTP route tests (P1-02).
//
// Real HTTP against an ApiServer with the `./database` module stubbed (same
// pattern as api-identity.test.ts). These pin the ROUTE contract: status codes,
// which helper is called with which (normalized) args, DEC-6 snake/camel
// tolerance, path normalization, DEC-2 stat fallback, and — critically — that
// every route works with NO X-* identity headers (R1 rail-independence). The DB
// SQL itself is covered by plans-data-layer.test.ts.
//
//   npm run build:main
//   node dist/main/main/api-server-plans.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer, queryNum } from './api-server';
import { readPlanSection } from './plans/read-ladder';
import { parsePlanHtml } from './plans/section-reader';
import { configureReparser, reparsePlanFile, __resetReparserForTests } from './plans/watch-plans';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── db-module stubs ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, any>;

const WS_WIN = { id: 'ws-1', title: 'WS', path: 'C:/nonexistent/ws-1', pathType: 'windows' };
const WS_WSL = { id: 'ws-wsl', title: 'WSL', path: '/home/x/ws', pathType: 'wsl' };
const PLAN_ROW = {
  id: '11111111-2222-4333-8444-555555555555', workspaceId: 'ws-1', path: 'plans/auth.md',
  slug: 'auth', format: 'md', runState: null, mtimeMs: 100, sizeBytes: 10,
  createdAt: 't0', updatedAt: 't0', deletedAt: null,
};

// Capture handles (TS can't see stub closures mutate lets → read via fn).
let lastGetPlans: any = null;
let lastCreate: any = null;
let lastUpdate: { id: string; updates: any } | null = null;
let lastSoftDelete: string | null = null;

function resetCaptures(): void {
  lastGetPlans = null; lastCreate = null; lastUpdate = null; lastSoftDelete = null;
}
function installDefaultStubs(): void {
  db.getWorkspace = (id: string) => (id === 'ws-1' ? WS_WIN : id === 'ws-wsl' ? WS_WSL : null);
  db.getPlans = (filters: any) => { lastGetPlans = filters; return [PLAN_ROW]; };
  db.getPlan = (id: string) => (id === PLAN_ROW.id ? PLAN_ROW : null);
  db.getPlanByWorkspacePath = () => null;
  db.createOrRevivePlan = (input: any) => { lastCreate = input; return { ...PLAN_ROW, ...input }; };
  db.updatePlan = (id: string, updates: any) => { lastUpdate = { id, updates }; return { ...PLAN_ROW, ...updates }; };
  db.softDeletePlan = (id: string) => { lastSoftDelete = id; return { ...PLAN_ROW, id, deletedAt: 't-del' }; };
  // derivePlanSlug is a pure fn — keep the real implementation for DEC-4 recompute.
}
const created = () => lastCreate;
const updated = () => lastUpdate;
const softDeleted = () => lastSoftDelete;
const getPlansFilters = () => lastGetPlans;

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
  emit: () => false,
} as unknown as AgentSupervisor;

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface Res { status: number; body: string; }
function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  resetCaptures();
  installDefaultStubs();
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try { await fn(port); } finally { server.stop(); }
}

const AUTH = { Authorization: `Bearer ${getApiToken()}` };            // NO X-* headers — proves R1
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── tests ─────────────────────────────────────────────────────────────────────

test('GET /api/plans excludes soft-deleted by default (includeDeleted:false)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/plans?workspaceId=ws-1', AUTH);
    assert.equal(res.status, 200);
    assert.equal(getPlansFilters().workspaceId, 'ws-1');
    assert.equal(getPlansFilters().includeDeleted, false);
  }));

test('GET /api/plans?includeDeleted=true → includeDeleted:true', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/plans?includeDeleted=true', AUTH);
    assert.equal(res.status, 200);
    assert.equal(getPlansFilters().includeDeleted, true);
  }));

test('GET /api/plans/:id → 404 for unknown id', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/plans/nope', AUTH);
    assert.equal(res.status, 404);
  }));

test('POST /api/plans rejects a body containing id → 400 (R2 server-minted)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ id: 'caller-supplied', workspace_id: 'ws-1', path: 'plans/x.md', format: 'md', mtime_ms: 1, size_bytes: 1 }));
    assert.equal(res.status, 400);
    assert.equal(created(), null, 'createOrRevivePlan never called');
  }));

test('WP-P8B: POST /api/plans with title only does not author an HTML plan', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-1', title: 'No legacy surface' }));
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /path is required/i);
    assert.equal(created(), null, 'no plan row was minted');
  }));

test('POST /api/plans happy path returns a uuid-like id (not path/slug-derived)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-1', path: 'plans/auth.md', format: 'md', mtime_ms: 100, size_bytes: 10 }));
    assert.equal(res.status, 200);
    const p = JSON.parse(res.body);
    assert.match(p.id, UUID_RE);
    assert.notEqual(p.id, p.path);
    assert.notEqual(p.id, p.slug);
    assert.equal(created().workspaceId, 'ws-1');
    assert.equal(created().path, 'plans/auth.md');
  }));

test('POST /api/plans tolerates camelCase aliases (DEC-6)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspaceId: 'ws-1', path: 'plans/auth.md', format: 'md', mtimeMs: 5, sizeBytes: 6 }));
    assert.equal(res.status, 200);
    assert.equal(created().workspaceId, 'ws-1');
    assert.equal(created().mtimeMs, 5);
    assert.equal(created().sizeBytes, 6);
  }));

test('POST /api/plans missing workspace_id or format → 400', () =>
  withServer(async (port) => {
    const a = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ path: 'plans/x.md', format: 'md', mtime_ms: 1, size_bytes: 1 }));
    assert.equal(a.status, 400);
    const b = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-1', path: 'plans/x.md', mtime_ms: 1, size_bytes: 1 }));
    assert.equal(b.status, 400);
  }));

test('POST /api/plans unknown workspace → 404', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-phantom', path: 'plans/x.md', format: 'md', mtime_ms: 1, size_bytes: 1 }));
    assert.equal(res.status, 404);
  }));

test('POST /api/plans path normalization rejects absolute / .. / non-plans → 400', () =>
  withServer(async (port) => {
    for (const bad of ['/etc/passwd', 'C:/win.md', 'plans/../secret.md', 'notes/x.md', '../x.md']) {
      const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
        JSON.stringify({ workspace_id: 'ws-1', path: bad, format: 'md', mtime_ms: 1, size_bytes: 1 }));
      assert.equal(res.status, 400, `expected 400 for path ${bad}`);
    }
  }));

test('POST /api/plans backslashes normalize to forward slashes', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-1', path: 'plans\\sub\\a.md', format: 'md', mtime_ms: 1, size_bytes: 1 }));
    assert.equal(res.status, 200);
    assert.equal(created().path, 'plans/sub/a.md');
  }));

test('POST /api/plans DEC-2: no mtime/size + un-statable file → 400', () =>
  withServer(async (port) => {
    // ws-1 is windows but its path is nonexistent → statPlanMeta returns null.
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-1', path: 'plans/ghost.md', format: 'md' }));
    assert.equal(res.status, 400);
  }));

test('POST /api/plans DEC-2: WSL workspace skips stat → 400 when meta omitted', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-wsl', path: 'plans/ghost.md', format: 'md' }));
    assert.equal(res.status, 400);
  }));

test('PATCH /api/plans/:id rebinds path + recomputes slug (DEC-4), keeps id', () =>
  withServer(async (port) => {
    const res = await request(port, 'PATCH', `/api/plans/${PLAN_ROW.id}`, JSON_AUTH,
      JSON.stringify({ path: 'plans/auth-renamed.md' }));
    assert.equal(res.status, 200);
    assert.equal(updated()!.id, PLAN_ROW.id);
    assert.equal(updated()!.updates.path, 'plans/auth-renamed.md');
    assert.equal(updated()!.updates.slug, 'auth-renamed', 'slug recomputed from path when omitted');
  }));

test('PATCH /api/plans/:id onto a live destination path → 409 (DEC-1)', () =>
  withServer(async (port) => {
    db.updatePlan = () => { throw Object.assign(new Error('Destination path already in use by a live plan'), { statusCode: 409 }); };
    const res = await request(port, 'PATCH', `/api/plans/${PLAN_ROW.id}`, JSON_AUTH,
      JSON.stringify({ path: 'plans/taken.md' }));
    assert.equal(res.status, 409);
  }));

test('PATCH /api/plans/:id unknown id → 404', () =>
  withServer(async (port) => {
    db.updatePlan = () => null;
    const res = await request(port, 'PATCH', '/api/plans/nope', JSON_AUTH, JSON.stringify({ run_state: 'x' }));
    assert.equal(res.status, 404);
  }));

test('DELETE /api/plans/:id is soft — returns {ok, planId, deletedAt}', () =>
  withServer(async (port) => {
    const res = await request(port, 'DELETE', `/api/plans/${PLAN_ROW.id}`, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.planId, PLAN_ROW.id);
    assert.ok(body.deletedAt);
    assert.equal(softDeleted(), PLAN_ROW.id);
  }));

test('DELETE /api/plans/:id unknown id → 404', () =>
  withServer(async (port) => {
    db.softDeletePlan = () => null;
    const res = await request(port, 'DELETE', '/api/plans/nope', AUTH);
    assert.equal(res.status, 404);
  }));

test('R1: all plan routes function with NO X-* headers present', () =>
  withServer(async (port) => {
    // Every request above used AUTH only (no X-Workspace-Id / X-Supervisor-Id).
    // A representative GET + POST + PATCH + DELETE all 200/expected here.
    assert.equal((await request(port, 'GET', '/api/plans', AUTH)).status, 200);
    const post = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: 'ws-1', path: 'plans/a.md', format: 'md', mtime_ms: 1, size_bytes: 1 }));
    assert.equal(post.status, 200);
  }));

// ── WP5: projection route — tier-2 events opt-in (?events=full) ───────────────

const RENDER_EVENTS = [
  {
    id: 'ev-1', agentId: 'a1', agentTitle: 'Worker 1', createdAt: 't0',
    observedSectionAnchor: 'sec_a1', dispatchedSectionAnchor: 'sec_a1',
    observedVia: 'edit-target', attributionConfidence: 'high',
    sectionMismatch: false, mismatchReason: null,
    claimedSectionAnchor: null, claimedPayload: null,
  },
];

test('GET /api/plans/:id/projection omits events by default (tier-1 payload stays small)', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    db.getPlanEventsForRender = () => { throw new Error('should not be called without ?events=full'); };
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection`, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.planId, PLAN_ROW.id);
    assert.equal(body.events, undefined, 'no events array unless explicitly requested');
  }));

test('GET /api/plans/:id/projection?events=full attaches per-event tier-2 rows', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    let calledWith: string | null = null;
    db.getPlanEventsForRender = (planId: string) => { calledWith = planId; return RENDER_EVENTS; };
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full`, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(calledWith, PLAN_ROW.id, 'getter scoped to the plan id');
    assert.ok(Array.isArray(body.events), 'events array present');
    assert.equal(body.events.length, 1);
    const ev = body.events[0];
    assert.equal(ev.observedVia, 'edit-target');
    assert.equal(ev.attributionConfidence, 'high');
    assert.equal(ev.sectionMismatch, false);
    assert.ok('claimedSectionAnchor' in ev && 'claimedPayload' in ev, 'claimed fields carried through, kept separate');
  }));

// ── I-7: MCP projection events parity — bounded events + metadata ─────────────

// ≥3 events, oldest-first (getPlanEventsForRender contract). ev-3 is the latest;
// ev-2 touches sec_x (for the section_anchor filter test).
const EVENTS3 = [
  {
    id: 'ev-1', agentId: 'a1', agentTitle: 'Worker 1', createdAt: 't1',
    observedSectionAnchor: 'sec_a', dispatchedSectionAnchor: 'sec_a',
    observedVia: 'edit-target', attributionConfidence: 'high',
    sectionMismatch: false, mismatchReason: null,
    claimedSectionAnchor: null, claimedPayload: null,
  },
  {
    id: 'ev-2', agentId: 'a2', agentTitle: 'Worker 2', createdAt: 't2',
    observedSectionAnchor: 'sec_x', dispatchedSectionAnchor: 'sec_a',
    observedVia: 'breadcrumb', attributionConfidence: 'medium',
    sectionMismatch: false, mismatchReason: null,
    claimedSectionAnchor: null, claimedPayload: null,
  },
  {
    id: 'ev-3', agentId: 'a3', agentTitle: 'Worker 3', createdAt: 't3',
    observedSectionAnchor: 'sec_b', dispatchedSectionAnchor: 'sec_b',
    observedVia: 'edit-target', attributionConfidence: 'high',
    sectionMismatch: false, mismatchReason: null,
    claimedSectionAnchor: null, claimedPayload: null,
  },
];
function stub3Events(): void {
  db.getPlanEventRollup = () => [];
  db.getPlanSections = () => [];
  db.getPlanEventsForRender = () => EVENTS3;
}

test('?events=full&events_limit=1 → latest 1 kept, truncated, omitted:2', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&events_limit=1`, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].id, 'ev-3', 'retained event is the latest');
    assert.equal(body.eventsTruncated, true);
    assert.equal(body.eventsOmitted, 2);
  }));

test('?events=full&events_limit=2 → latest 2, still oldest-first (ev-2 then ev-3)', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&events_limit=2`, AUTH);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 2);
    assert.deepEqual(body.events.map((e: any) => e.id), ['ev-2', 'ev-3'], 'kept latest 2, oldest-first order preserved');
    assert.equal(body.eventsTruncated, true);
    assert.equal(body.eventsOmitted, 1);
  }));

test('?events=full&events_limit=0 → empty, truncated, omitted:3', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&events_limit=0`, AUTH);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.events, []);
    assert.equal(body.eventsTruncated, true);
    assert.equal(body.eventsOmitted, 3);
  }));

test('?events=full&events_limit=-5 → clamped to 0', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&events_limit=-5`, AUTH);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.events, []);
    assert.equal(body.eventsTruncated, true);
    assert.equal(body.eventsOmitted, 3);
  }));

test('?events=full&events_limit=abc → queryNum undefined → uncapped, NO metadata fields', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&events_limit=abc`, AUTH);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 3, 'non-finite limit → uncapped');
    assert.ok(!('eventsTruncated' in body), 'no metadata when unbounded');
    assert.ok(!('eventsOmitted' in body));
  }));

test('?events=full&section_anchor=sec_x → only events touching sec_x; metadata present (bounded)', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&section_anchor=sec_x`, AUTH);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].id, 'ev-2', 'only the event touching sec_x');
    assert.ok('eventsTruncated' in body, 'metadata present because a filter was requested (bounded)');
    assert.equal(body.eventsTruncated, false, 'a filter without a cap does not set truncated');
    assert.equal(body.eventsOmitted, 0);
  }));

// P0 Fix-1 REGRESSION (planning-surface-hardening-review, repro b): an event whose
// ONLY link to a section is a FORGED `claimedSectionAnchor` must NOT be admitted to
// that section's scoped ("trusted") projection. Membership is effect-set / dispatched
// facts only.
test('?events=full&section_anchor=sec_forge → forged claimedSectionAnchor does NOT select the event', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    // ev-c: dispatched to sec_a, observed writing sec_a, but CLAIMS sec_forge.
    const forgedEvent = {
      id: 'ev-c', agentId: 'ac', agentTitle: 'Forger', createdAt: 't4',
      observedSectionAnchor: 'sec_a', dispatchedSectionAnchor: 'sec_a',
      observedVia: 'edit-target', attributionConfidence: 'high',
      sectionMismatch: false, mismatchReason: null,
      claimedSectionAnchor: 'sec_forge', claimedPayload: { result: 'I totally worked on sec_forge' },
    };
    db.getPlanEventsForRender = () => [...EVENTS3, forgedEvent];
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full&section_anchor=sec_forge`, AUTH);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.events, [], 'no event has an OBSERVED/DISPATCHED tie to sec_forge → empty scoped set');
    assert.ok(!JSON.stringify(body.events).includes('ev-c'), 'the forged-claim event is excluded from the scoped projection');
  }));

test('bare ?events=full → all events, NO eventsTruncated/eventsOmitted keys (byte-compat)', () =>
  withServer(async (port) => {
    stub3Events();
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full`, AUTH);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 3, 'all events, uncapped');
    assert.ok(!('eventsTruncated' in body), 'bare events=full must not add metadata keys');
    assert.ok(!('eventsOmitted' in body), 'bare events=full must not add metadata keys');
  }));

// ── I-5: read_plan_section returns EMPTY when `limit` omitted ─────────────────

// 1. queryNum unit matrix — a MISSING param must be undefined, never 0.
test('queryNum: absent/empty/non-finite → undefined; explicit numbers pass through', () => {
  assert.equal(queryNum(new URLSearchParams(''), 'limit'), undefined, 'absent param → undefined (not 0)');
  assert.equal(queryNum(new URLSearchParams('limit='), 'limit'), undefined, 'empty value → undefined');
  assert.equal(queryNum(new URLSearchParams('limit=0'), 'limit'), 0, 'explicit 0 preserved');
  assert.equal(queryNum(new URLSearchParams('limit=250'), 'limit'), 250);
  assert.equal(queryNum(new URLSearchParams('limit=abc'), 'limit'), undefined, 'non-finite → undefined');
  assert.equal(queryNum(new URLSearchParams('offset=5'), 'offset'), 5);
});

// 2. Read-ladder consumer proof — window() already treats limit:undefined right;
//    documents that an EXPLICIT 0 still empties (the intentional, not-buggy case).
const I5_FIXTURE = [
  '<!doctype html><html><body>',
  '<section data-zone="summary" data-anchor="sec_smoke">',
  '  <h2>Summary</h2><p>KNOWN_BODY — enough text to be non-trivial for the window</p>',
  '</section>',
  '</body></html>',
].join('\n');

test('readPlanSection text mode with offset/limit undefined → full content, not truncated (I-5 consumer)', () => {
  const proj = parsePlanHtml(I5_FIXTURE);
  const res = readPlanSection(proj, 'sec_smoke', { mode: 'text', offset: undefined, limit: undefined });
  assert.equal(res.found, true);
  assert.ok(res.content && res.content.includes('KNOWN_BODY'), 'full section text returned');
  assert.equal(res.truncated, false);
});

test('readPlanSection text mode with explicit limit:0 → empty, truncated (intentional, not the bug)', () => {
  const proj = parsePlanHtml(I5_FIXTURE);
  const res = readPlanSection(proj, 'sec_smoke', { mode: 'text', offset: undefined, limit: 0 });
  assert.equal(res.found, true);
  assert.equal(res.content, '', 'explicit 0 still empties the window');
  assert.equal(res.truncated, true);
});

// 3. HTTP/route regression — MANDATORY. Drive a real served projection through
//    the configureReparser/reparsePlanFile seam; prove the route no longer passes
//    limit:0 when no ?limit is present. __resetReparserForTests() teardown so no
//    later API test inherits a served projection.
const FIXTURE_HTML = [
  '<!doctype html><html><body>',
  '<section data-zone="summary" data-anchor="sec_smoke">',
  '  <h2>Summary</h2><p>KNOWN_BODY — enough text to be non-trivial for the window</p>',
  '</section>',
  '</body></html>',
].join('\n');

test('GET /sections/:anchor with NO limit returns full content (I-5 route regression)', () =>
  withServer(async (port) => {
    db.getPlan = (id: string) => (id === PLAN_ROW.id ? PLAN_ROW : null);
    configureReparser({
      readFile: async () => ({ content: FIXTURE_HTML }),
      writeFile: async () => {},
      registry: {
        getPlanSections: () => [], getPlanSectionByAnchor: () => null,
        insertPlanSection: () => 'x', archivePlanSection: () => {},
      },
      now: () => 't',
      resolveAbsolutePath: () => ({ absPath: 'x', pathType: 'windows' }),
      recordPlanSectionChange: () => 'chg',   // REQUIRED — SectionCache captures it in the ctor
      recordPlanSnapshot: () => null,
      getLatestPlanSnapshotHtml: () => null,
    });
    try {
      await reparsePlanFile(PLAN_ROW as any);                // populates getServedPlanProjection
      const res = await request(port, 'GET',
        `/api/plans/${PLAN_ROW.id}/sections/sec_smoke`, AUTH);   // no ?limit
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.content.includes('KNOWN_BODY'), 'full content, not empty');
      assert.equal(body.truncated, false);
    } finally {
      __resetReparserForTests();                             // teardown — no leaked served projection
    }
  }));

// ── GT-A WP-A2.3: buildPlanActivityProjection attaches write/presence split ───

test('GET /projection attaches writeCount/presenceCount/lastWriteAt per section (A2.3), keeps eventCount', () =>
  withServer(async (port) => {
    db.getPlan = (id: string) => (id === PLAN_ROW.id ? PLAN_ROW : null);
    db.getPlanSections = () => [];
    db.getPlanEventRollup = () => [
      {
        sectionAnchor: 'sec_smoke', writeCount: 2, presenceCount: 3,
        lastWriteAt: 't-write', lastPresenceAt: 't-presence',
        eventCount: 5, lastEventAt: 't-presence',
      },
    ];
    configureReparser({
      readFile: async () => ({ content: FIXTURE_HTML }),
      writeFile: async () => {},
      registry: {
        getPlanSections: () => [], getPlanSectionByAnchor: () => null,
        insertPlanSection: () => 'x', archivePlanSection: () => {},
      },
      now: () => 't',
      resolveAbsolutePath: () => ({ absPath: 'x', pathType: 'windows' }),
      recordPlanSectionChange: () => 'chg',
      recordPlanSnapshot: () => null,
      getLatestPlanSnapshotHtml: () => null,
    });
    try {
      await reparsePlanFile(PLAN_ROW as any);
      const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection`, AUTH);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const sec = body.sections.find((s: any) => s.anchor === 'sec_smoke');
      assert.ok(sec, 'sec_smoke section present in projection');
      assert.equal(sec.writeCount, 2, 'writeCount attached from rollup');
      assert.equal(sec.presenceCount, 3, 'presenceCount attached from rollup');
      assert.equal(sec.lastWriteAt, 't-write', 'lastWriteAt attached from rollup');
      assert.equal(sec.eventCount, 5, 'eventCount back-compat preserved');
      assert.equal(sec.lastEventAt, 't-presence', 'lastEventAt back-compat preserved');
    } finally {
      __resetReparserForTests();
    }
  }));

// ── Fix-4 §4: Tier-1 section counts, Tier-2 digest strip, Tier-3 drill-down ───

// A captured evidence blob as getPlanEventsForRender / getPlanEventRepoActivity
// would return it (loose `any` — the pure module owns the strict type).
function evidence(): any {
  return {
    schemaVersion: 1, status: 'captured',
    window: { sinceIso: 't0', untilIso: 't1' },
    totals: {
      filesRead: 3, filesEdited: 2, filesCreated: 1,
      fileEvents: 6, distinctFiles: 4, testsRun: 0, testsPassed: 0, testsFailed: 0,
    },
    files: {
      truncated: false,
      items: [{ path: 'src/a.ts', operations: ['write'], counts: { read: 0, write: 1, create: 0 }, firstAt: 't0', lastAt: 't1' }],
    },
    tests: { truncated: false, items: [] },
    commits: { truncated: false, items: [] },
    caps: { fileDetailMax: 200 },
  };
}
const CAPTURED_EVENT = { ...RENDER_EVENTS[0], id: 'ev-cap', repoActivity: evidence() };

test('fix4 §4a — section carries the seven witnessed repo counts from the rollup', () =>
  withServer(async (port) => {
    db.getPlan = (id: string) => (id === PLAN_ROW.id ? PLAN_ROW : null);
    db.getPlanSections = () => [];
    db.getPlanEventRollup = () => [
      {
        sectionAnchor: 'sec_smoke', writeCount: 1, presenceCount: 0,
        lastWriteAt: 't-write', lastPresenceAt: null, eventCount: 1, lastEventAt: 't-write',
        repoFilesRead: 3, repoFilesEdited: 2, repoFilesCreated: 1,
        testsRun: 0, testsPassed: 0, testsFailed: 0, lastCommit: null,
      },
    ];
    configureReparser({
      readFile: async () => ({ content: FIXTURE_HTML }),
      writeFile: async () => {},
      registry: {
        getPlanSections: () => [], getPlanSectionByAnchor: () => null,
        insertPlanSection: () => 'x', archivePlanSection: () => {},
      },
      now: () => 't',
      resolveAbsolutePath: () => ({ absPath: 'x', pathType: 'windows' }),
      recordPlanSectionChange: () => 'chg',
      recordPlanSnapshot: () => null,
      getLatestPlanSnapshotHtml: () => null,
    });
    try {
      await reparsePlanFile(PLAN_ROW as any);
      const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection`, AUTH);
      const body = JSON.parse(res.body);
      const sec = body.sections.find((s: any) => s.anchor === 'sec_smoke');
      assert.ok(sec, 'sec_smoke present');
      assert.equal(sec.repoFilesRead, 3);
      assert.equal(sec.repoFilesEdited, 2);
      assert.equal(sec.repoFilesCreated, 1);
      assert.equal(sec.testsRun, 0, 'reserved test count is inert 0 in cut 1');
      assert.equal(sec.lastCommit, null, 'reserved commit is null in cut 1');
    } finally {
      __resetReparserForTests();
    }
  }));

test('fix4 §4a — a section with no rollup entry defaults the repo counts to 0 / null', () =>
  withServer(async (port) => {
    db.getPlan = (id: string) => (id === PLAN_ROW.id ? PLAN_ROW : null);
    db.getPlanSections = () => [];
    db.getPlanEventRollup = () => []; // no witnessed activity anywhere
    configureReparser({
      readFile: async () => ({ content: FIXTURE_HTML }),
      writeFile: async () => {},
      registry: {
        getPlanSections: () => [], getPlanSectionByAnchor: () => null,
        insertPlanSection: () => 'x', archivePlanSection: () => {},
      },
      now: () => 't',
      resolveAbsolutePath: () => ({ absPath: 'x', pathType: 'windows' }),
      recordPlanSectionChange: () => 'chg',
      recordPlanSnapshot: () => null,
      getLatestPlanSnapshotHtml: () => null,
    });
    try {
      await reparsePlanFile(PLAN_ROW as any);
      const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection`, AUTH);
      const sec = JSON.parse(res.body).sections.find((s: any) => s.anchor === 'sec_smoke');
      assert.equal(sec.repoFilesEdited, 0);
      assert.equal(sec.repoFilesRead, 0);
      assert.equal(sec.lastCommit, null);
    } finally {
      __resetReparserForTests();
    }
  }));

test('fix4 §4a — Tier-2 event carries repoActivityDigest (counts + line), NO raw repoActivity / files', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    db.getPlanEventsForRender = () => [CAPTURED_EVENT];
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full`, AUTH);
    assert.equal(res.status, 200);
    const ev = JSON.parse(res.body).events[0];
    assert.ok(ev.repoActivityDigest, 'digest attached to the tier-2 event');
    assert.equal(ev.repoActivityDigest.status, 'captured');
    assert.equal(ev.repoActivityDigest.totals.filesEdited, 2, 'counts carried');
    assert.equal(ev.repoActivityDigest.line, 'witnessed: 2 repo files edited; 1 created; 3 read', 'digest line synthesized');
    assert.ok(!('repoActivity' in ev), 'the heavy raw blob is stripped off the wire');
    assert.ok(!('files' in ev), 'no capped file list rides the tier-2 event');
  }));

test('fix4 §4a — a NULL-blob event → repoActivityDigest not-captured (pre-fix-4 row)', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    db.getPlanEventsForRender = () => [{ ...RENDER_EVENTS[0], repoActivity: null }];
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full`, AUTH);
    const ev = JSON.parse(res.body).events[0];
    assert.equal(ev.repoActivityDigest.status, 'not-captured');
    assert.equal(ev.repoActivityDigest.totals, null);
    assert.equal(ev.repoActivityDigest.line, null);
  }));

test('fix4 §4a — NO eventDetail key unless event_detail_id is requested', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    db.getPlanEventsForRender = () => [CAPTURED_EVENT];
    db.getPlanEventRepoActivity = () => { throw new Error('must not be called without event_detail_id'); };
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?events=full`, AUTH);
    const body = JSON.parse(res.body);
    assert.ok(!('eventDetail' in body), 'tier-3 stays out of the payload until explicitly drilled');
  }));

test('fix4 §4a — event_detail_id → Tier-3 eventDetail (capped files) scoped to the (planId, eventId)', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    db.getPlanEventsForRender = () => [];
    let calledWith: any = null;
    db.getPlanEventRepoActivity = (pid: string, eid: string) => { calledWith = { pid, eid }; return evidence(); };
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?event_detail_id=ev-cap`, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(calledWith, { pid: PLAN_ROW.id, eid: 'ev-cap' }, 'reader scoped to plan + event id');
    assert.ok(body.eventDetail, 'eventDetail present');
    assert.equal(body.eventDetail.planEventId, 'ev-cap');
    assert.equal(body.eventDetail.files.items.length, 1, 'capped file list carried');
    assert.equal(body.eventDetail.files.items[0].path, 'src/a.ts');
    assert.ok(body.eventDetail.totals && body.eventDetail.window, 'totals + window carried');
  }));

test('fix4 §4a — event_detail_id for a bad/foreign id → eventDetail null (key present, no error)', () =>
  withServer(async (port) => {
    db.getPlanEventRollup = () => [];
    db.getPlanSections = () => [];
    db.getPlanEventsForRender = () => [];
    db.getPlanEventRepoActivity = () => null; // foreign/unknown id → null (plan_id in WHERE)
    const res = await request(port, 'GET', `/api/plans/${PLAN_ROW.id}/projection?event_detail_id=foreign`, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok('eventDetail' in body, 'the key is present because a drill-down was requested');
    assert.equal(body.eventDetail, null, 'bad id → null, not an error');
  }));

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ✓ ${t.name}`); }
    catch (err) { failed++; console.error(`  ✗ ${t.name}`); console.error(err instanceof Error ? err.stack : String(err)); }
  }
  if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log(`\nAll ${tests.length} api-server-plans tests passed`);
})();
