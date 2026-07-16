// B2 Task C — supervisor-focus HTTP route tests (P1-03).
//
// Real HTTP against an ApiServer with `./database` stubbed. Pins the route
// contract: explicit supervisor_id (R4 — NO header defaulting, NO is_supervisor
// / ACL check), DEC-6 casing, 404 on unknown supervisor/plan, and that every
// route works with NO X-Supervisor-Id header (R1). DB SQL is covered by
// plans-data-layer.test.ts.
//
//   npm run build:main
//   node dist/main/main/api-server-focus.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, any>;

const PLAN = {
  id: 'plan-1', workspaceId: 'ws-1', path: 'plans/auth.md', slug: 'auth', format: 'md',
  runState: null, mtimeMs: 1, sizeBytes: 1, createdAt: 't', updatedAt: 't', deletedAt: null,
};
const FOCUS_ROW = {
  supervisorId: 'sup-1', planId: 'plan-1', focusedAt: 't0', lastAttendedAt: 't0',
  notes: null, plan: PLAN,
};

let lastGetFocus: any = null;
let lastUpsert: any = null;
let lastDelete: { supervisorId: string; planId: string } | null = null;

function resetCaptures(): void { lastGetFocus = null; lastUpsert = null; lastDelete = null; }
function installDefaultStubs(): void {
  db.getAgent = (id: string) => (id === 'sup-1' ? { id: 'sup-1', workspaceId: 'ws-1', isSupervisor: true } : null);
  db.getWorkspace = (id: string) => (id === 'ws-1' ? { id: 'ws-1', title: 'WS', path: 'C:/ws-1', pathType: 'windows' } : null);
  db.getPlan = (id: string) => (id === 'plan-1' ? PLAN : null);
  db.getSupervisorFocus = (filters: any) => { lastGetFocus = filters; return [FOCUS_ROW]; };
  db.upsertSupervisorFocus = (input: any) => { lastUpsert = input; return { ...FOCUS_ROW, ...input }; };
  db.deleteSupervisorFocus = (supervisorId: string, planId: string) => { lastDelete = { supervisorId, planId }; };
}
const getFocusFilters = () => lastGetFocus;
const upserted = () => lastUpsert;
const deleted = () => lastDelete;

const stubSupervisor = {
  getContextStats: () => null, isInputInFlight: () => false, emit: () => false,
} as unknown as AgentSupervisor;

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

const AUTH = { Authorization: `Bearer ${getApiToken()}` };            // NO X-Supervisor-Id — proves R1/R4
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
// Asserted-supervisor headers for the identity-scoped /self routes (planning-surface P1).
const SUP_HDR = { ...AUTH, 'X-Workspace-Id': 'ws-1', 'X-Supervisor-Id': 'sup-1' };
const SUP_JSON = { ...SUP_HDR, 'Content-Type': 'application/json' };

// ── tests ─────────────────────────────────────────────────────────────────────

test('POST /api/supervisor-focus inserts and returns the full SupervisorFocus (DEC-3)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH,
      JSON.stringify({ supervisor_id: 'sup-1', plan_id: 'plan-1', notes: 'watch this' }));
    assert.equal(res.status, 200);
    const row = JSON.parse(res.body);
    assert.equal(row.supervisorId, 'sup-1');
    assert.equal(row.planId, 'plan-1');
    assert.ok(row.plan, 'joined plan projection present (DEC-3)');
    assert.equal(upserted().notes, 'watch this');
  }));

test('POST /api/supervisor-focus tolerates camelCase (DEC-6)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH,
      JSON.stringify({ supervisorId: 'sup-1', planId: 'plan-1' }));
    assert.equal(res.status, 200);
    assert.equal(upserted().supervisorId, 'sup-1');
    assert.equal(upserted().planId, 'plan-1');
  }));

test('POST /api/supervisor-focus missing supervisor_id or plan_id → 400', () =>
  withServer(async (port) => {
    const a = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH, JSON.stringify({ plan_id: 'plan-1' }));
    assert.equal(a.status, 400);
    const b = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH, JSON.stringify({ supervisor_id: 'sup-1' }));
    assert.equal(b.status, 400);
  }));

test('POST /api/supervisor-focus unknown supervisor → 404', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH,
      JSON.stringify({ supervisor_id: 'phantom', plan_id: 'plan-1' }));
    assert.equal(res.status, 404);
    assert.equal(upserted(), null);
  }));

test('POST /api/supervisor-focus unknown plan → 404', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH,
      JSON.stringify({ supervisor_id: 'sup-1', plan_id: 'phantom' }));
    assert.equal(res.status, 404);
    assert.equal(upserted(), null);
  }));

test('R4: no is_supervisor/ACL check — any agent may focus any plan (upsert reached)', () =>
  withServer(async (port) => {
    // A non-supervisor agent row is still accepted: the route only checks EXISTENCE,
    // never is_supervisor (R4). Stub getAgent to a plain agent.
    db.getAgent = (id: string) => (id === 'plain' ? { id: 'plain', workspaceId: 'ws-1', isSupervisor: false } : null);
    const res = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH,
      JSON.stringify({ supervisor_id: 'plain', plan_id: 'plan-1' }));
    assert.equal(res.status, 200);
    assert.equal(upserted().supervisorId, 'plain');
  }));

test('GET /api/supervisor-focus?supervisorId= scopes to that supervisor', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor-focus?supervisorId=sup-1', AUTH);
    assert.equal(res.status, 200);
    assert.equal(getFocusFilters().supervisorId, 'sup-1');
    assert.equal(getFocusFilters().workspaceId, undefined);
  }));

test('GET /api/supervisor-focus?workspaceId= scopes via the plan join', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor-focus?workspaceId=ws-1', AUTH);
    assert.equal(res.status, 200);
    assert.equal(getFocusFilters().workspaceId, 'ws-1');
  }));

test('GET /api/supervisor-focus projection carries plan.deletedAt for soft-deleted plans', () =>
  withServer(async (port) => {
    db.getSupervisorFocus = () => [{ ...FOCUS_ROW, plan: { ...PLAN, deletedAt: 't-del' } }];
    const res = await request(port, 'GET', '/api/supervisor-focus?supervisorId=sup-1', AUTH);
    assert.equal(res.status, 200);
    const rows = JSON.parse(res.body);
    assert.ok(rows[0].plan.deletedAt, 'soft-deleted plan still projected with deletedAt');
  }));

test('DELETE /api/supervisor-focus/:sup/:plan removes the row, plan untouched', () =>
  withServer(async (port) => {
    const res = await request(port, 'DELETE', '/api/supervisor-focus/sup-1/plan-1', AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(deleted(), { supervisorId: 'sup-1', planId: 'plan-1' });
  }));

test('DELETE /api/supervisor-focus decodes URL-encoded id segments', () =>
  withServer(async (port) => {
    const res = await request(port, 'DELETE', '/api/supervisor-focus/sup%2F1/plan%2F1', AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(deleted(), { supervisorId: 'sup/1', planId: 'plan/1' });
  }));

test('R1: focus routes function with NO X-Supervisor-Id header', () =>
  withServer(async (port) => {
    const post = await request(port, 'POST', '/api/supervisor-focus', JSON_AUTH,
      JSON.stringify({ supervisor_id: 'sup-1', plan_id: 'plan-1' }));
    assert.equal(post.status, 200);
    const get = await request(port, 'GET', '/api/supervisor-focus?supervisorId=sup-1', AUTH);
    assert.equal(get.status, 200);
  }));

// ── Identity-scoped /self routes (planning-surface P1 — focus_plan / unfocus_plan) ──

test('POST /self derives the supervisor from X-Supervisor-Id (no body supervisor_id)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus/self', SUP_JSON,
      JSON.stringify({ plan_id: 'plan-1', notes: 'mine' }));
    assert.equal(res.status, 200);
    assert.equal(upserted().supervisorId, 'sup-1', 'subscriber taken from identity, not body');
    assert.equal(upserted().planId, 'plan-1');
    assert.equal(upserted().notes, 'mine');
  }));

test('POST /self with NO X-Supervisor-Id → 403 not-a-supervisor, no upsert', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus/self', JSON_AUTH,
      JSON.stringify({ plan_id: 'plan-1' }));
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'not-a-supervisor');
    assert.equal(upserted(), null);
  }));

test('POST /self missing plan_id → 400', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus/self', SUP_JSON, JSON.stringify({}));
    assert.equal(res.status, 400);
    assert.equal(upserted(), null);
  }));

test('POST /self unknown plan → 404', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/supervisor-focus/self', SUP_JSON,
      JSON.stringify({ plan_id: 'phantom' }));
    assert.equal(res.status, 404);
    assert.equal(upserted(), null);
  }));

test('DELETE /self/:plan derives the supervisor from identity (never treats "self" as an id)', () =>
  withServer(async (port) => {
    const res = await request(port, 'DELETE', '/api/supervisor-focus/self/plan-1', SUP_HDR);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.deepEqual(deleted(), { supervisorId: 'sup-1', planId: 'plan-1' });
  }));

test('DELETE /self/:plan with NO X-Supervisor-Id → 403 not-a-supervisor, no delete', () =>
  withServer(async (port) => {
    const res = await request(port, 'DELETE', '/api/supervisor-focus/self/plan-1', AUTH);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'not-a-supervisor');
    assert.equal(deleted(), null);
  }));

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ✓ ${t.name}`); }
    catch (err) { failed++; console.error(`  ✗ ${t.name}`); console.error(err instanceof Error ? err.stack : String(err)); }
  }
  if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log(`\nAll ${tests.length} api-server-focus tests passed`);
})();
