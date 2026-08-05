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
import { ApiServer } from './api-server';
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

// ── WP-P8D: HTML section routes are retired ────────────────────────────────

test('legacy HTML section routes are absent', () =>
  withServer(async (port) => {
    for (const route of [
      `/api/plans/${PLAN_ROW.id}/sections`,
      `/api/plans/${PLAN_ROW.id}/sections/sec_smoke`,
    ]) {
      const res = await request(port, 'GET', route, AUTH);
      assert.equal(res.status, 404, `${route} is retired`);
    }
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
