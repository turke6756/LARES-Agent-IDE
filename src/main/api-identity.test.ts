// Context-brick Inc 1 + Inc 2 — identity-layer tests for the dashboard HTTP API
// (plans/context-brick-implementation-final.md §INCREMENT 1 A1–A5,
// §INCREMENT 2 ≡ P1-10a 2.2/2.3 + the two RECORDED DECISIONS).
//
// Covers, via real HTTP against an ApiServer (resolveIdentity /
// resolveWorkspaceScope are private — exercised through routes):
//   - resolveIdentity: no header → byte-identical non-asserted path; valid
//     X-Workspace-Id → self-scoped reads; unknown workspace → 403
//     code 'unknown-workspace'.
//   - resolveWorkspaceScope matrix: absent→qp / present+no-qp→header /
//     present+match→ok / present+mismatch→403 code 'workspace-scope-mismatch'.
//   - Teams + personas "header present + no qp" relaxation (400 →
//     header-scoped) asserted AS INTENDED, and the no-header 400 preserved.
//   - GET /api/supervisor/context: 200 with header, 400 no header + no qp,
//     404 unknown ?workspaceId= (no header).
//   - Server-side workspace fill on POST /api/agents and POST /api/teams.
//   - A5 CORS preflight advertises the identity headers.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-identity.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Database / scanner fixtures (patched module exports, same pattern as
//    api-auth.test.ts — routes resolve these at call time) ─────────────────

const WS = { id: 'ws-1', title: 'Workspace One', path: 'C:/tmp/ws-1', pathType: 'windows' };
const SUP = { id: 'sup-1', title: 'Supervisor', provider: 'claude', status: 'idle' };
const WS_AGENTS = [
  { id: 'a-1', workspaceId: 'ws-1', status: 'working', isSupervised: true },
  { id: 'a-2', workspaceId: 'ws-1', status: 'done', isSupervised: false },
  { id: 'a-3', workspaceId: 'ws-1', status: 'idle', isSupervised: true },
];
const ALL_AGENTS = [...WS_AGENTS, { id: 'b-1', workspaceId: 'ws-2', status: 'idle', isSupervised: false }];

// Inc 2 (2.2) — agent rows resolveIdentity's X-Supervisor-Id validation looks
// up via getAgent. sup-1 doubles as the LIMIT-1 fallback (SUP above); sup-2 is
// a SECOND supervisor in ws-1 (the multi-supervisor misattribution case the
// override exists for); sup-ws2 is a supervisor of a FOREIGN workspace. The
// WS_AGENTS rows carry no isSupervisor → falsy → the not-a-supervisor case.
const SUP_ROW = { id: 'sup-1', workspaceId: 'ws-1', isSupervisor: true, title: 'Supervisor', provider: 'claude', status: 'idle' };
const SUP2_ROW = { id: 'sup-2', workspaceId: 'ws-1', isSupervisor: true, title: 'Supervisor Two', provider: 'claude', status: 'working' };
const FOREIGN_SUP_ROW = { id: 'sup-ws2', workspaceId: 'ws-2', isSupervisor: true, title: 'Foreign Supervisor', provider: 'claude', status: 'idle' };
// #19 supervisor-tools-for-personas — a custom persona launched on the
// 'supervisor' PRIVILEGE lane: isSupervisor stays FALSE (renders as its own card)
// but privilegeLane:'supervisor' grants it the supervisor MCP toolset, so the
// X-Supervisor-Id rail must admit it exactly like a structural supervisor.
const PERSONA_ROW = { id: 'persona-1', workspaceId: 'ws-1', isSupervisor: false, privilegeLane: 'supervisor', title: 'Mr Job Hunt Agent', provider: 'claude', status: 'idle' };
const AGENT_ROWS = [SUP_ROW, SUP2_ROW, FOREIGN_SUP_ROW, PERSONA_ROW, ...ALL_AGENTS];

// Inc 3 — owned-agent rows (owner edge = owner_agent_id, stamped at launch).
// sup-1 owns two live + two terminal workers; sup-2 owns its own pair so the
// isolation test can prove one supervisor's fleet never leaks into another's.
// Fixture order stands in for the helper's ORDER BY created_at DESC.
const OWNED_ROWS = [
  { id: 'w-live-1', workspaceId: 'ws-1', ownerAgentId: 'sup-1', status: 'working' },
  { id: 'w-live-2', workspaceId: 'ws-1', ownerAgentId: 'sup-1', status: 'idle' },
  { id: 'w-done-1', workspaceId: 'ws-1', ownerAgentId: 'sup-1', status: 'done' },
  { id: 'w-crash-1', workspaceId: 'ws-1', ownerAgentId: 'sup-1', status: 'crashed' },
  { id: 'w2-live-1', workspaceId: 'ws-1', ownerAgentId: 'sup-2', status: 'working' },
  { id: 'w2-done-1', workspaceId: 'ws-1', ownerAgentId: 'sup-2', status: 'done' },
];

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, unknown>;
db.getAllAgents = () => ALL_AGENTS;
// Stub mirrors getAgentsByOwner's SQL semantics (owner filter; terminal =
// done/crashed excluded unless includeTerminal) so the route contract —
// which params reach the helper, and that its result is returned unfiltered —
// is what these tests pin. The SQL itself is exercised only by inspection.
db.getAgentsByOwner = (ownerId: string, opts?: { includeTerminal?: boolean }) =>
  OWNED_ROWS
    .filter(a => a.ownerAgentId === ownerId)
    .filter(a => opts?.includeTerminal || (a.status !== 'done' && a.status !== 'crashed'));
db.getAgent = (id: string) => AGENT_ROWS.find(a => a.id === id) ?? null;
db.getAgentsByWorkspace = (wsId: string) => WS_AGENTS.filter(a => a.workspaceId === wsId);
db.getWorkspace = (id: string) => (id === WS.id ? WS : null);
db.getSupervisorAgent = (wsId: string) => (wsId === WS.id ? SUP : null);
db.listTeams = (wsId: string) => [{ id: 'team-1', workspaceId: wsId, name: 'T', status: 'active', members: [] }];
db.listAgentTemplates = (wsId?: string) => (wsId ? [{ id: 'tpl-ws', workspaceId: wsId }] : [{ id: 'tpl-all' }]);

// Planning-surface P1 — supervisor-focus fixtures. `focusedPlansStub` backs the
// context `plans` block; `lastFocusUpsert` captures auto-subscribe calls. getPlan +
// the plan-rail guard reads are stubbed so a plan-bound launch reaches the auto-focus
// hook without touching the (uninitialized) real DB.
let focusedPlansStub: Array<Record<string, unknown>> = [];
let lastFocusUpsert: Record<string, unknown> | null = null;
db.getSupervisorFocusedPlans = (_supervisorId: string, _limit?: number) => focusedPlansStub;
db.upsertSupervisorFocus = (input: Record<string, unknown>) => { lastFocusUpsert = input; return { ...input }; };
db.getPlan = (id: string) => (id === 'plan-1' ? { id: 'plan-1', workspaceId: 'ws-1', deletedAt: null } : null);
db.listOrchestrationRuns = () => [];
db.getLiveRailAgentForPlan = () => null;
function focusUpserted(): Record<string, unknown> | null { return lastFocusUpsert; }

let lastCreateTeamInput: Record<string, unknown> | null = null;
db.createTeam = (input: Record<string, unknown>) => {
  lastCreateTeamInput = input;
  return { id: 'team-new', ...input };
};
// Accessors: TS can't see the stub closures mutate these lets, so a direct read
// after `= null` narrows to `never` — read through a function instead.
function createdTeamInput(): Record<string, unknown> | null { return lastCreateTeamInput; }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const personaScanner = require('./persona-scanner') as Record<string, unknown>;
personaScanner.scanPersonas = (wsPath: string) => [{ name: 'p1', scannedFrom: wsPath }];

let lastLaunchInput: Record<string, unknown> | null = null;
// Inc 4 — per-test in-flight ids + continuationRelaunch capture. The stub
// defaults keep every pre-Inc-4 test byte-identical (empty set → false).
let inFlightIds = new Set<string>();
let lastContinuationRelaunch: { agentId: string; brick: Record<string, unknown> } | null = null;
const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: (id: string) => inFlightIds.has(id),
  continuationRelaunch: async (agentId: string, brick: Record<string, unknown>) => {
    lastContinuationRelaunch = { agentId, brick };
  },
  launchAgent: async (input: Record<string, unknown>) => {
    lastLaunchInput = input;
    return { id: 'launched-1', ...input };
  },
  emit: () => false,
} as unknown as AgentSupervisor;
function launchedInput(): Record<string, unknown> | null { return lastLaunchInput; }
function relaunched(): { agentId: string; brick: Record<string, unknown> } | null { return lastContinuationRelaunch; }

// ── HTTP helpers ────────────────────────────────────────────────────────────

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; }

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    await fn(port);
  } finally {
    server.stop();
  }
}

const TOKEN = getApiToken();
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const WS_HDR = { ...AUTH, 'X-Workspace-Id': 'ws-1' };

// ── resolveIdentity (via routes) ────────────────────────────────────────────

test('no identity header → byte-identical non-asserted path (GET /api/agents returns ALL agents)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', AUTH);
    assert.equal(res.status, 200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map(a => a.id);
    assert.deepEqual(ids, ALL_AGENTS.map(a => a.id));
  }));

test('valid X-Workspace-Id + no qp → self-scoped (GET /api/agents returns only ws-1 agents)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', WS_HDR);
    assert.equal(res.status, 200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map(a => a.id);
    assert.deepEqual(ids, WS_AGENTS.map(a => a.id));
  }));

test("unknown workspace in X-Workspace-Id → 403 with code 'unknown-workspace'", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', { ...AUTH, 'X-Workspace-Id': 'ws-phantom' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'unknown-workspace');
  }));

// ── resolveWorkspaceScope matrix (remaining rows) ───────────────────────────

test('header absent + explicit qp → qp honored (today’s behavior)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents?workspaceId=ws-1', AUTH);
    assert.equal(res.status, 200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map(a => a.id);
    assert.deepEqual(ids, WS_AGENTS.map(a => a.id));
  }));

test('header present + MATCHING qp → ok', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents?workspaceId=ws-1', WS_HDR);
    assert.equal(res.status, 200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map(a => a.id);
    assert.deepEqual(ids, WS_AGENTS.map(a => a.id));
  }));

test("header present + MISMATCHED qp → 403 with code 'workspace-scope-mismatch'", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents?workspaceId=ws-2', WS_HDR);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'workspace-scope-mismatch');
  }));

// ── Teams / personas relaxation (RECORDED AS INTENDED: 400 → header-scoped) ─

test('GET /api/teams: no header + no qp → 400 (unchanged legacy contract)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/teams', AUTH);
    assert.equal(res.status, 400);
  }));

test('GET /api/teams: header + no qp → 200 header-scoped (INTENDED relaxation, not a regression)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/teams', WS_HDR);
    assert.equal(res.status, 200);
    const teams = JSON.parse(res.body) as { workspaceId: string }[];
    assert.equal(teams[0].workspaceId, 'ws-1');
  }));

test('GET /api/personas: no header + no qp → 400 (unchanged legacy contract)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/personas', AUTH);
    assert.equal(res.status, 400);
  }));

test('GET /api/personas: header + no qp → 200 header-scoped (INTENDED relaxation)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/personas', WS_HDR);
    assert.equal(res.status, 200);
    const personas = JSON.parse(res.body) as { scannedFrom: string }[];
    assert.equal(personas[0].scannedFrom, WS.path);
  }));

test('GET /api/templates: optional filter preserved (no header → all; header → scoped)', () =>
  withServer(async (port) => {
    const all = await request(port, 'GET', '/api/templates', AUTH);
    assert.equal(all.status, 200);
    assert.equal(JSON.parse(all.body)[0].id, 'tpl-all');
    const scoped = await request(port, 'GET', '/api/templates', WS_HDR);
    assert.equal(scoped.status, 200);
    assert.equal(JSON.parse(scoped.body)[0].workspaceId, 'ws-1');
  }));

// ── GET /api/supervisor/context (A4) ────────────────────────────────────────

test('GET /api/supervisor/context with header → 200 summary (workspace, supervisor, counts)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context', WS_HDR);
    assert.equal(res.status, 200);
    const ctx = JSON.parse(res.body);
    assert.equal(ctx.workspaceId, 'ws-1');
    assert.equal(ctx.workspaceTitle, WS.title);
    assert.deepEqual(ctx.supervisor, SUP);
    // Inc 2 (2.3): no X-Supervisor-Id → supervisorId null, supervisor stays the
    // LIMIT-1 fallback (acceptance e: header-less callers unchanged).
    assert.equal(ctx.supervisorId, null);
    // WS_AGENTS: working + done + idle → live excludes done/crashed; 2 supervised.
    // Inc 3 (3.3): counts.owned follows the resolved supervisor — here the
    // LIMIT-1 fallback (sup-1), which owns 2 live + 2 terminal fixtures.
    assert.deepEqual(ctx.counts, { total: 3, live: 2, supervised: 2, owned: { live: 2, terminal: 2 } });
  }));

test('GET /api/supervisor/context: no header + no qp → 400', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context', AUTH);
    assert.equal(res.status, 400);
  }));

test('GET /api/supervisor/context: no header + unknown ?workspaceId= → 404', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context?workspaceId=ws-phantom', AUTH);
    assert.equal(res.status, 404);
  }));

test('GET /api/supervisor/context: explicit matching qp with header → 200', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context?workspaceId=ws-1', WS_HDR);
    assert.equal(res.status, 200);
  }));

// ── INCREMENT 2 (≡ P1-10a) — X-Supervisor-Id validation + override ──────────

const SUP_HDR = { ...WS_HDR, 'X-Supervisor-Id': 'sup-1' };

test('Inc 2 (a): context with X-Supervisor-Id → supervisorId = the asserted caller’s own id', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context', SUP_HDR);
    assert.equal(res.status, 200);
    const ctx = JSON.parse(res.body);
    assert.equal(ctx.supervisorId, 'sup-1');
    assert.equal(ctx.supervisor.id, 'sup-1');
  }));

test('Inc 2 (a): asserted SECOND supervisor OVERRIDES the LIMIT-1 fallback (multi-supervisor)', () =>
  withServer(async (port) => {
    // getSupervisorAgent (LIMIT-1) returns sup-1; the caller asserts sup-2.
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-2' });
    assert.equal(res.status, 200);
    const ctx = JSON.parse(res.body);
    assert.equal(ctx.supervisorId, 'sup-2');
    assert.deepEqual(ctx.supervisor,
      { id: 'sup-2', title: 'Supervisor Two', provider: 'claude', status: 'working' });
  }));

test("Inc 2 (b): foreign-workspace supervisor id in header → 403 'supervisor-workspace-mismatch'", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-ws2' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'supervisor-workspace-mismatch');
  }));

test("Inc 2 (c): non-is_supervisor agent id in header → 403 'not-a-supervisor'", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'a-1' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'not-a-supervisor');
  }));

test("#19: privilegeLane:'supervisor' persona id in header → authenticates as its OWN id (rail admits it like a supervisor)", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'persona-1' });
    assert.equal(res.status, 200);
    const ctx = JSON.parse(res.body);
    assert.equal(ctx.supervisorId, 'persona-1');
    assert.equal(ctx.supervisor.id, 'persona-1');
  }));

test("#19: a plain worker (no isSupervisor, no privilegeLane) in header still 403s 'not-a-supervisor'", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'a-1' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'not-a-supervisor');
  }));

test("Inc 2 (d): nonexistent id in header → 403 'unknown-supervisor'", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-phantom' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'unknown-supervisor');
  }));

test('Inc 2: validation lives in resolveIdentity, not the context route (any route 403s)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-phantom' });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'unknown-supervisor');
  }));

// ── Inc 2 RECORDED DECISIONS (Gap 1 / Gap 2) ────────────────────────────────

test('Inc 2 Gap 2 (f): X-Self-Id alone (no X-Supervisor-Id, no X-Workspace-Id) → identical to header-less', () =>
  withServer(async (port) => {
    // Workers forward X-Self-Id on every call; resolveIdentity must not read it.
    // A bogus id proves it: were it read, this would 403 — instead the request
    // rides the non-asserted path and returns ALL agents, like header-less.
    const res = await request(port, 'GET', '/api/agents',
      { ...AUTH, 'X-Self-Id': 'no-such-agent' });
    assert.equal(res.status, 200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map(a => a.id);
    assert.deepEqual(ids, ALL_AGENTS.map(a => a.id));
  }));

test('Inc 2 Gap 2 (f): X-Self-Id does NOT populate supervisorId (reserved for the ownership path)', () =>
  withServer(async (port) => {
    // sup-2 is a real supervisor row — if resolveIdentity read X-Self-Id, it
    // would land in supervisor/supervisorId. It must not.
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Self-Id': 'sup-2' });
    assert.equal(res.status, 200);
    const ctx = JSON.parse(res.body);
    assert.equal(ctx.supervisorId, null);
    assert.deepEqual(ctx.supervisor, SUP); // still the LIMIT-1 fallback
  }));

test('Inc 2 Gap 1 (f): ownership stays on the body/SELF_ID rail — header and body may differ, NO cross-check', () =>
  withServer(async (port) => {
    // The launch_agent shim stamps owner_agent_id from AGENT_DASHBOARD_SELF_ID
    // (body); X-Supervisor-Id is authz/author only. The server must pass the
    // body value through unchanged — never 403 on the difference, never
    // overwrite it from the header.
    lastLaunchInput = null;
    const res = await request(port, 'POST', '/api/agents',
      { ...SUP_HDR, 'Content-Type': 'application/json' },
      JSON.stringify({ title: 'w1', owner_agent_id: 'a-1' }));
    assert.equal(res.status, 200);
    assert.equal(launchedInput()?.ownerAgentId, 'a-1');
  }));

// ── INCREMENT 3 — GET /api/supervisor/owned-agents + context owned counts ───

function ownedIds(body: string): string[] {
  return (JSON.parse(body).agents as { id: string }[]).map(a => a.id);
}

test('Inc 3: owned-agents default → live owned agents only, owner = the asserted caller', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/owned-agents', SUP_HDR);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ownerId, 'sup-1');
    assert.equal(body.includeTerminal, false);
    assert.deepEqual(ownedIds(res.body), ['w-live-1', 'w-live-2']);
  }));

test('Inc 3: owned-agents?includeTerminal=true → live + terminal (the graveyard window)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/owned-agents?includeTerminal=true', SUP_HDR);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).includeTerminal, true);
    assert.deepEqual(ownedIds(res.body), ['w-live-1', 'w-live-2', 'w-done-1', 'w-crash-1']);
  }));

test('Inc 3: owned-agents ?limit= caps the list, newest first', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/owned-agents?includeTerminal=true&limit=3', SUP_HDR);
    assert.equal(res.status, 200);
    assert.deepEqual(ownedIds(res.body), ['w-live-1', 'w-live-2', 'w-done-1']);
  }));

test('Inc 3: explicit agent-id/owner query param → 400 (owner is header-derived)', () =>
  withServer(async (port) => {
    for (const qp of ['agentId=sup-2', 'agent_id=sup-2', 'ownerAgentId=sup-2', 'owner_agent_id=sup-2', 'owner=sup-2', 'supervisorId=sup-2', 'supervisor_id=sup-2']) {
      const res = await request(port, 'GET', `/api/supervisor/owned-agents?${qp}`, SUP_HDR);
      assert.equal(res.status, 400, `expected 400 for ?${qp}`);
    }
  }));

test('Inc 3: workspace-only assertion (no X-Supervisor-Id) → 400 — the LIMIT-1 fallback never substitutes', () =>
  withServer(async (port) => {
    // identity.supervisor IS populated here (fallback), but the route requires
    // the asserted header: attribution by LIMIT-1 could hand one supervisor
    // another's fleet in a multi-supervisor workspace.
    const res = await request(port, 'GET', '/api/supervisor/owned-agents', WS_HDR);
    assert.equal(res.status, 400);
  }));

test('Inc 3: header-less caller → 400 (identity-required endpoint)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/owned-agents', AUTH);
    assert.equal(res.status, 400);
  }));

test("Inc 3: isolation — sup-2 sees ONLY its own owned agents (sup-1's never leak)", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/owned-agents?includeTerminal=true',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-2' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ownerId, 'sup-2');
    assert.deepEqual(ownedIds(res.body), ['w2-live-1', 'w2-done-1']);
  }));

test('Inc 3 (3.3): get_my_context counts.owned follows the ASSERTED caller, not the fallback', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/supervisor/context',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-2' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).counts.owned, { live: 1, terminal: 1 });
  }));

// ── Server-side workspace fill on POST create endpoints (B4 server half) ────

test('POST /api/agents: header + no body workspaceId → launch input filled from header', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await request(port, 'POST', '/api/agents',
      { ...WS_HDR, 'Content-Type': 'application/json' },
      JSON.stringify({ title: 'w1' }));
    assert.equal(res.status, 200);
    assert.equal(launchedInput()?.workspaceId, 'ws-1');
  }));

test('POST /api/agents: header + mismatched body workspaceId → 403, launchAgent never called', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await request(port, 'POST', '/api/agents',
      { ...WS_HDR, 'Content-Type': 'application/json' },
      JSON.stringify({ title: 'w1', workspaceId: 'ws-2' }));
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).code, 'workspace-scope-mismatch');
    assert.equal(launchedInput(), null);
  }));

test('POST /api/agents: no header + explicit body workspaceId → unchanged passthrough', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await request(port, 'POST', '/api/agents',
      { ...AUTH, 'Content-Type': 'application/json' },
      JSON.stringify({ title: 'w1', workspaceId: 'ws-2' }));
    assert.equal(res.status, 200);
    assert.equal(launchedInput()?.workspaceId, 'ws-2');
  }));

test('POST /api/teams: header + no body workspaceId → createTeam input filled from header', () =>
  withServer(async (port) => {
    lastCreateTeamInput = null;
    const res = await request(port, 'POST', '/api/teams',
      { ...WS_HDR, 'Content-Type': 'application/json' },
      JSON.stringify({ name: 'T', members: [{ agentId: 'a-1' }] }));
    assert.equal(res.status, 200);
    assert.equal(createdTeamInput()?.workspaceId, 'ws-1');
  }));

// ── A5 CORS ─────────────────────────────────────────────────────────────────

test('OPTIONS preflight advertises X-Workspace-Id / X-Supervisor-Id / X-Project-Id', () =>
  withServer(async (port) => {
    const res = await request(port, 'OPTIONS', '/api/agents', { Origin: 'http://localhost:5173' });
    assert.equal(res.status, 204);
    const allowed = String(res.headers['access-control-allow-headers']);
    assert.match(allowed, /X-Workspace-Id/);
    assert.match(allowed, /X-Supervisor-Id/);
    assert.match(allowed, /X-Project-Id/);
  }));

// ── Planning-surface P1 — focus orientation + auto-subscribe ────────────────
//
// The context `plans` block appears ONLY for an asserted supervisor; auto-subscribe
// fires on plan-bound launch_agent / run_orchestration and is a silent no-op for
// non-supervisor callers.

test('P1 context: asserted supervisor gets the `plans` block (subscriptions), header-less callers do not', () =>
  withServer(async (port) => {
    focusedPlansStub = [
      { planId: 'plan-1', path: 'plans/a.html', slug: 'a', format: 'html', focusedAt: 't0', lastAttendedAt: 't1', notes: null },
    ];
    const asserted = await request(port, 'GET', '/api/supervisor/context', { ...WS_HDR, 'X-Supervisor-Id': 'sup-1' });
    assert.equal(asserted.status, 200);
    const ctx = JSON.parse(asserted.body);
    assert.deepEqual(ctx.plans, focusedPlansStub, 'asserted supervisor sees its focused plans');

    // Header-less (no X-Supervisor-Id) → no `plans` key at all (parity with supervisorId: null).
    const headerless = await request(port, 'GET', '/api/supervisor/context', WS_HDR);
    assert.equal(headerless.status, 200);
    const ctx2 = JSON.parse(headerless.body);
    assert.equal('plans' in ctx2, false, 'header-less caller gets no plans key');
    assert.equal(ctx2.supervisorId, null);
    focusedPlansStub = [];
  }));

test('P1 auto-subscribe: a plan-bound launch_agent by an asserted supervisor upserts a focus row', () =>
  withServer(async (port) => {
    lastFocusUpsert = null;
    const res = await request(port, 'POST', '/api/agents',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-1', 'Content-Type': 'application/json' },
      JSON.stringify({ title: 'w1', plan_id: 'plan-1' }));
    assert.equal(res.status, 200);
    assert.equal(focusUpserted()?.supervisorId, 'sup-1');
    assert.equal(focusUpserted()?.planId, 'plan-1');
  }));

test('P1 auto-subscribe: a launch_agent with NO plan binding upserts nothing', () =>
  withServer(async (port) => {
    lastFocusUpsert = null;
    const res = await request(port, 'POST', '/api/agents',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-1', 'Content-Type': 'application/json' },
      JSON.stringify({ title: 'w1' }));
    assert.equal(res.status, 200);
    assert.equal(focusUpserted(), null, 'no plan_id → nothing to subscribe to');
  }));

test('P1 auto-subscribe: run_orchestration with a plan_id upserts for the dispatching supervisor', async () => {
  lastFocusUpsert = null;
  const stubOrchestration = { start_run: () => ({ runId: 'run-1' }) } as unknown as ConstructorParameters<typeof ApiServer>[2];
  const server = new ApiServer(stubSupervisor, 0, stubOrchestration, '127.0.0.1');
  const port = await server.start();
  try {
    const res = await request(port, 'POST', '/api/orchestrations',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-1', 'Content-Type': 'application/json' },
      JSON.stringify({ name: 'groupthink', params: { workspaceId: 'ws-1', supervisorId: 'sup-1', planId: 'plan-1' } }));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).runId, 'run-1');
    assert.equal(focusUpserted()?.supervisorId, 'sup-1');
    assert.equal(focusUpserted()?.planId, 'plan-1');
  } finally { server.stop(); }
});

// ── Context-brick Inc 4 (4.4) — continuation attempt / brick / relaunch ─────
//
// Same stub-the-database-module pattern as above: the routes' continuation
// helpers are swapped per test and restored, so each test pins exactly the
// route contract (status codes, error codes, which helper is consulted with
// which args) — the SQL itself is exercised by continuation-lifecycle.test.ts.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CONTINUATION_BRICK_MAX_BYTES, CONTINUATION_ESCAPE_MAX_ATTEMPTS, CONTINUATION_ESCAPE_MAX_ALIVE_MS } =
  require('../shared/constants') as {
    CONTINUATION_BRICK_MAX_BYTES: number;
    CONTINUATION_ESCAPE_MAX_ATTEMPTS: number;
    CONTINUATION_ESCAPE_MAX_ALIVE_MS: number;
  };

type AttemptRow = {
  id: string; dashboardAgentId: string; generation: number; startedAt: string;
  closedAt: string | null; status: string; reason: string | null; thresholdContextPct: number | null;
};
type BrickRow = {
  id: string; dashboardAgentId: string; handoffAttemptId: string; generation: number;
  note: string; noteSource: string; byteLen: number; writtenAt: string; supersededAt: string | null;
};
function attemptRow(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 'att-1', dashboardAgentId: 'sup-1', generation: 1,
    startedAt: '2026-07-03 10:00:00.000', closedAt: null,
    status: 'open', reason: null, thresholdContextPct: null, ...over,
  };
}
function brickRow(over: Partial<BrickRow> = {}): BrickRow {
  return {
    id: 'brick-1', dashboardAgentId: 'sup-1', handoffAttemptId: 'att-1',
    generation: 1, note: 'phase notes', noteSource: 'tool', byteLen: 11,
    writtenAt: '2026-07-03 10:00:01.000', supersededAt: null, ...over,
  };
}

/** Swap db-module continuation helpers for the duration of one server run,
 *  restoring afterwards. `fn` also receives the ApiServer so tests can
 *  override the injectable isAwaitingHuman predicate. */
async function withContinuationDb(
  overrides: Record<string, unknown>,
  fn: (port: number, server: ApiServer) => Promise<void>,
): Promise<void> {
  const keys = Object.keys(overrides);
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  Object.assign(db, overrides);
  lastContinuationRelaunch = null;
  inFlightIds = new Set();
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    await fn(port, server);
  } finally {
    server.stop();
    for (const k of keys) db[k] = orig[k];
  }
}

const JSON_SUP = { ...SUP_HDR, 'Content-Type': 'application/json' };

// ── POST /api/agents/:id/continuation-attempt ──────────────────────────────

test('Inc 4: continuation-attempt happy path → server-minted { attemptId, successorGen }', () => {
  let created: { agentId: string; opts?: Record<string, unknown> } | null = null;
  return withContinuationDb({
    getOpenContinuationAttempt: () => null,
    createContinuationHandoffAttempt: (agentId: string, opts?: Record<string, unknown>) => {
      created = { agentId, opts };
      return attemptRow();
    },
  }, async (port) => {
    const res = await request(port, 'POST', '/api/agents/sup-1/continuation-attempt',
      JSON_SUP, JSON.stringify({ reason: 'context-pressure', thresholdContextPct: 80 }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { attemptId: 'att-1', successorGen: 1 });
    assert.equal(created!.agentId, 'sup-1');
    assert.equal((created!.opts as Record<string, unknown>).reason, 'context-pressure');
    assert.equal((created!.opts as Record<string, unknown>).thresholdContextPct, 80);
  });
});

test('Inc 4: continuation-attempt unknown agent → 404', () =>
  withContinuationDb({ getOpenContinuationAttempt: () => null }, async (port) => {
    const res = await request(port, 'POST', '/api/agents/nope/continuation-attempt', JSON_SUP, '{}');
    assert.equal(res.status, 404);
  }));

test('Inc 4: continuation-attempt author-binding — foreign-workspace supervisor assertion → 403, attempt never minted', () => {
  let createCalls = 0;
  return withContinuationDb({
    getOpenContinuationAttempt: () => null,
    createContinuationHandoffAttempt: () => { createCalls++; return attemptRow(); },
  }, async (port) => {
    const res = await request(port, 'POST', '/api/agents/sup-1/continuation-attempt',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-ws2', 'Content-Type': 'application/json' }, '{}');
    assert.equal(res.status, 403);
    assert.equal(createCalls, 0);
  });
});

test('Inc 4: continuation-attempt one-open-max — 2nd attempt → 409 continuation-open-attempt-exists', () =>
  withContinuationDb({
    getOpenContinuationAttempt: (id: string) => (id === 'sup-1' ? attemptRow() : null),
  }, async (port) => {
    const res = await request(port, 'POST', '/api/agents/sup-1/continuation-attempt', JSON_SUP, '{}');
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-open-attempt-exists');
  }));

// ── POST /api/supervisor/continuation-brick ────────────────────────────────

test('Inc 4: continuation-brick POST with any body agent-id field → 400, nothing written', () => {
  let inserts = 0;
  return withContinuationDb({
    getOpenContinuationAttempt: () => attemptRow(),
    insertContinuationBrick: () => { inserts++; return 'brick-1'; },
    closeContinuationHandoffAttempt: () => {},
  }, async (port) => {
    for (const key of ['agent_id', 'agentId', 'dashboard_agent_id', 'dashboardAgentId']) {
      const res = await request(port, 'POST', '/api/supervisor/continuation-brick',
        JSON_SUP, JSON.stringify({ note: 'n', [key]: 'sup-2' }));
      assert.equal(res.status, 400, `expected 400 for body key ${key}`);
    }
    assert.equal(inserts, 0);
  });
});

test('Inc 4: continuation-brick POST without X-Supervisor-Id (workspace-only) → 400', () =>
  withContinuationDb({ getOpenContinuationAttempt: () => attemptRow() }, async (port) => {
    const res = await request(port, 'POST', '/api/supervisor/continuation-brick',
      { ...WS_HDR, 'Content-Type': 'application/json' }, JSON.stringify({ note: 'n' }));
    assert.equal(res.status, 400);
  }));

test('Inc 4: continuation-brick POST from wrong (foreign-workspace) supervisor → 403', () =>
  withContinuationDb({ getOpenContinuationAttempt: () => attemptRow() }, async (port) => {
    const res = await request(port, 'POST', '/api/supervisor/continuation-brick',
      { ...WS_HDR, 'X-Supervisor-Id': 'sup-ws2', 'Content-Type': 'application/json' },
      JSON.stringify({ note: 'n' }));
    assert.equal(res.status, 403);
  }));

test("#19: continuation-brick POST from a privilegeLane:'supervisor' persona → 200, author = the persona's own id", () => {
  let inserted: Record<string, unknown> | null = null;
  let closed: string | null = null;
  return withContinuationDb({
    // Attempt is keyed to persona-1 (the route reads the open attempt for the
    // asserted author id), proving the persona authenticates as itself.
    getOpenContinuationAttempt: (id: string) => (id === 'persona-1' ? attemptRow({ dashboardAgentId: 'persona-1' }) : null),
    insertContinuationBrick: (input: Record<string, unknown>) => { inserted = input; return 'brick-p'; },
    closeContinuationHandoffAttempt: (attemptId: string) => { closed = attemptId; },
  }, async (port) => {
    const res = await request(port, 'POST', '/api/supervisor/continuation-brick',
      { ...WS_HDR, 'X-Supervisor-Id': 'persona-1', 'Content-Type': 'application/json' },
      JSON.stringify({ note: 'persona handoff note' }));
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).id, 'brick-p');
    assert.equal((inserted as unknown as Record<string, unknown>)!.agentId, 'persona-1');
    assert.equal((inserted as unknown as Record<string, unknown>)!.noteSource, 'tool');
    assert.equal(closed, 'att-1');
  });
});

test('Inc 4: continuation-brick POST with no open attempt → 409 continuation-no-open-attempt', () =>
  withContinuationDb({ getOpenContinuationAttempt: () => null }, async (port) => {
    const res = await request(port, 'POST', '/api/supervisor/continuation-brick',
      JSON_SUP, JSON.stringify({ note: 'n' }));
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-no-open-attempt');
  }));

test('Inc 4: continuation-brick byte cap — exactly 6144 bytes ok; 6145 → 413; multibyte counts BYTES not chars', () => {
  let inserts = 0;
  return withContinuationDb({
    getOpenContinuationAttempt: () => attemptRow(),
    insertContinuationBrick: () => { inserts++; return 'brick-1'; },
    closeContinuationHandoffAttempt: () => {},
  }, async (port) => {
    assert.equal(CONTINUATION_BRICK_MAX_BYTES, 6144, 'spec 4.6 constant');
    const post = (note: string) => request(port, 'POST', '/api/supervisor/continuation-brick',
      JSON_SUP, JSON.stringify({ note }));

    const atCap = await post('a'.repeat(6144));
    assert.equal(atCap.status, 200, `exactly ${CONTINUATION_BRICK_MAX_BYTES} bytes must commit`);
    assert.equal(inserts, 1);

    const overByOne = await post('a'.repeat(6145));
    assert.equal(overByOne.status, 413);
    assert.equal(JSON.parse(overByOne.body).code, 'continuation-note-too-large');

    // 2049 '€' chars = 6147 UTF-8 bytes — far under the cap in chars, over in bytes.
    const multibyte = await post('€'.repeat(2049));
    assert.equal(multibyte.status, 413, 'byte length, not char length, is the capped quantity');
    assert.equal(inserts, 1, 'no insert happened for either rejected note');
  });
});

test('Inc 4: continuation-brick success → tool-sourced insert at attempt generation + attempt committed + { id }', () => {
  let inserted: Record<string, unknown> | null = null;
  let closed: { id: string; status: string } | null = null;
  return withContinuationDb({
    getOpenContinuationAttempt: () => attemptRow({ generation: 3 }),
    insertContinuationBrick: (input: Record<string, unknown>) => { inserted = input; return 'brick-9'; },
    closeContinuationHandoffAttempt: (id: string, status: string) => { closed = { id, status }; },
  }, async (port) => {
    const res = await request(port, 'POST', '/api/supervisor/continuation-brick',
      JSON_SUP, JSON.stringify({ note: 'current phase: tests' }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { id: 'brick-9' });
    assert.equal(inserted!.agentId, 'sup-1', 'author bound to the header-derived supervisor');
    assert.equal(inserted!.handoffAttemptId, 'att-1');
    assert.equal(inserted!.generation, 3, 'brick copies the attempt-owned successorGen');
    assert.equal(inserted!.noteSource, 'tool');
    assert.deepEqual(closed, { id: 'att-1', status: 'committed' });
  });
});

// ── GET /api/supervisor/continuation-brick ─────────────────────────────────

test('Inc 4: continuation-brick GET returns the tool-sourced row for agent+attempt', () => {
  let asked: { agentId: string; attemptId: string; opts?: Record<string, unknown> } | null = null;
  return withContinuationDb({
    getLatestBrickForAttempt: (agentId: string, attemptId: string, opts?: Record<string, unknown>) => {
      asked = { agentId, attemptId, opts };
      return brickRow();
    },
  }, async (port) => {
    const res = await request(port, 'GET',
      '/api/supervisor/continuation-brick?agentId=sup-1&attemptId=att-1&source=tool', SUP_HDR);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.agentId, 'sup-1');
    assert.equal(body.attemptId, 'att-1');
    assert.equal(body.brick.id, 'brick-1');
    assert.deepEqual(asked!.opts, { source: 'tool' });

    const missing = await request(port, 'GET', '/api/supervisor/continuation-brick?agentId=sup-1', SUP_HDR);
    assert.equal(missing.status, 400);
    const badSource = await request(port, 'GET',
      '/api/supervisor/continuation-brick?agentId=sup-1&attemptId=att-1&source=psychic', SUP_HDR);
    assert.equal(badSource.status, 400);
  });
});

// ── POST /api/agents/:id/continuation-relaunch — the gate matrix ───────────

/** All-clear defaults: committed attempt at expected gen 1, tool brick written
 *  after open, no owned agents, nothing in flight, no orchestration. Tests
 *  override exactly one gate each. */
function relaunchStubs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getLatestContinuationAttempt: (_id: string, status?: string) =>
      (status === 'committed' ? attemptRow({ status: 'committed' }) : null),
    getContinuationAttempt: (id: string) => (id === 'att-1' ? attemptRow({ status: 'committed' }) : null),
    getLatestBrickForAttempt: (_a: string, _att: string, opts?: { source?: string }) =>
      (opts?.source === 'tool' ? brickRow() : null),
    getAgentsByOwner: () => [] as unknown[],
    hasRunningOrchestrationForSupervisor: () => false,
    ...over,
  };
}
const relaunch = (port: number, body = '{}') =>
  request(port, 'POST', '/api/agents/sup-1/continuation-relaunch', JSON_SUP, body);

test('Inc 4: relaunch gate — no committed attempt → 409 continuation-attempt-not-committed, no kill', () =>
  withContinuationDb(relaunchStubs({ getLatestContinuationAttempt: () => null }), async (port) => {
    const res = await relaunch(port);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-attempt-not-committed');
    assert.equal(relaunched(), null);
  }));

test('Inc 4: relaunch gate — attempt still open (explicit attemptId) → 409', () =>
  withContinuationDb(relaunchStubs({
    getContinuationAttempt: () => attemptRow({ status: 'open' }),
  }), async (port) => {
    const res = await relaunch(port, JSON.stringify({ attemptId: 'att-1' }));
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-attempt-not-committed');
    assert.equal(relaunched(), null);
  }));

test('Inc 4: relaunch gate — committed attempt at a STALE generation → 409 (expected = agent gen + 1)', () =>
  withContinuationDb(relaunchStubs({
    getLatestContinuationAttempt: () => attemptRow({ status: 'committed', generation: 2 }),
  }), async (port) => {
    // sup-1's continuationGeneration is unset → coalesces to 0 → expectedGen 1 ≠ 2.
    const res = await relaunch(port);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-attempt-not-committed');
    assert.equal(relaunched(), null);
  }));

test('Inc 4: relaunch gate — committed but NO tool brick (scrape-only) → 425, scrape never authorizes', () => {
  const sources: (string | undefined)[] = [];
  return withContinuationDb(relaunchStubs({
    // A scrape row exists; the gate must ask for source 'tool' and get nothing.
    getLatestBrickForAttempt: (_a: string, _att: string, opts?: { source?: string }) => {
      sources.push(opts?.source);
      return opts?.source === 'tool' ? null : brickRow({ noteSource: 'scrape' });
    },
  }), async (port) => {
    const res = await relaunch(port);
    assert.equal(res.status, 425);
    assert.equal(JSON.parse(res.body).code, 'continuation-no-tool-brick');
    assert.deepEqual(sources, ['tool'], "gate authority is queried with source:'tool' only");
    assert.equal(relaunched(), null);
  });
});

test('Inc 4: relaunch gate — tool brick written BEFORE the attempt opened → 425', () =>
  withContinuationDb(relaunchStubs({
    getLatestBrickForAttempt: () => brickRow({ writtenAt: '2026-07-03 09:59:59.000' }),
  }), async (port) => {
    const res = await relaunch(port);
    assert.equal(res.status, 425);
    assert.equal(JSON.parse(res.body).code, 'continuation-no-tool-brick');
    assert.equal(relaunched(), null);
  }));

test('Inc 4: relaunch gate — busy owned status (launching/working/waiting/restarting) NO LONGER blocks (Edward 2026-07-05) → 200', async () => {
  for (const status of ['launching', 'working', 'waiting', 'restarting']) {
    await withContinuationDb(relaunchStubs({
      getAgentsByOwner: () => [{ id: 'w-busy', status }],
    }), async (port) => {
      const res = await relaunch(port);
      assert.equal(res.status, 200, `status '${status}' must NOT block: ${res.body}`);
      assert.equal(relaunched()!.agentId, 'sup-1');
    });
  }
});

test('Inc 4: relaunch gate — crashed owned agent does NOT block; all-clear proceeds', () =>
  withContinuationDb(relaunchStubs({
    getAgentsByOwner: () => [{ id: 'w-crash-1', status: 'crashed' }, { id: 'w-idle', status: 'idle' }],
  }), async (port) => {
    const res = await relaunch(port);
    assert.equal(res.status, 200, `crashed/idle owned agents must not block: ${res.body}`);
    assert.equal(relaunched()!.agentId, 'sup-1');
  }));

test('Inc 4: relaunch gate — owned agent input-in-flight → 425 continuation-input-in-flight', () =>
  withContinuationDb(relaunchStubs({
    getAgentsByOwner: () => [{ id: 'w-idle', status: 'idle' }],
  }), async (port) => {
    inFlightIds = new Set(['w-idle']);
    const res = await relaunch(port);
    assert.equal(res.status, 425);
    assert.equal(JSON.parse(res.body).code, 'continuation-input-in-flight');
    assert.equal(relaunched(), null);
  }));

test('Inc 4: relaunch gate — SELF input-in-flight (mid-receiving supervisor) → 425', () =>
  withContinuationDb(relaunchStubs(), async (port) => {
    inFlightIds = new Set(['sup-1']);
    const res = await relaunch(port);
    assert.equal(res.status, 425);
    assert.equal(JSON.parse(res.body).code, 'continuation-input-in-flight');
    assert.equal(relaunched(), null);
  }));

test('Inc 4/5: relaunch gate — isAwaitingHuman(:id) latch → 409 continuation-awaiting-human, keep-alive', () =>
  withContinuationDb(relaunchStubs(), async (port, server) => {
    // Phase 5: the route consults an injected predicate. The wiring now derives
    // it LATCH-ONLY (waitingKind !== null blocks; a merely-idle turn that ends
    // with "?" but holds no latch does NOT block — see computeAwaitingHuman in
    // continuation-watcher.test.ts). At this HTTP layer a true predicate blocks.
    server.isAwaitingHuman = (id: string) => id === 'sup-1';
    const res = await relaunch(port);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-awaiting-human');
    assert.equal(relaunched(), null);
  }));

test('Inc 4/5: relaunch gate — no awaiting-human latch (default false predicate) does NOT block; all-clear proceeds', () =>
  withContinuationDb(relaunchStubs(), async (port) => {
    // The default injected predicate is () => false, standing in for "no latch".
    // An idle supervisor with no waiting latch must relaunch normally.
    const res = await relaunch(port);
    assert.equal(res.status, 200, res.body);
    assert.equal(relaunched()!.agentId, 'sup-1');
  }));

test('BUG-39 WP1: relaunch gate — SELF busy (working|launching|restarting) → 409 continuation-self-busy, no kill', async () => {
  for (const status of ['working', 'launching', 'restarting']) {
    await withContinuationDb(relaunchStubs({
      getAgent: (id: string) => (id === 'sup-1' ? { ...SUP_ROW, status } : null),
    }), async (port) => {
      const res = await relaunch(port);
      assert.equal(res.status, 409, `self status '${status}' must block`);
      assert.equal(JSON.parse(res.body).code, 'continuation-self-busy');
      assert.equal(relaunched(), null);
    });
  }
});

test("BUG-39 WP1: relaunch gate — SELF 'waiting' PASSES the self-busy gate (awaiting-human owns that case; no latch → proceeds)", () =>
  withContinuationDb(relaunchStubs({
    getAgent: (id: string) => (id === 'sup-1' ? { ...SUP_ROW, status: 'waiting' } : null),
  }), async (port) => {
    // 'waiting' is deliberately absent from the self-busy set; with no
    // awaiting-human latch (default predicate false) the relaunch proceeds.
    const res = await relaunch(port);
    assert.equal(res.status, 200, res.body);
    assert.equal(relaunched()!.agentId, 'sup-1');
  }));

test('Inc 4: relaunch gate — live owned orchestration → 409 continuation-orchestration-running', () => {
  const asked: string[] = [];
  return withContinuationDb(relaunchStubs({
    hasRunningOrchestrationForSupervisor: (id: string) => { asked.push(id); return true; },
  }), async (port) => {
    const res = await relaunch(port);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-orchestration-running');
    assert.deepEqual(asked, ['sup-1']);
    assert.equal(relaunched(), null);
  });
});

test('Inc 4: relaunch all-clear → supervisor.continuationRelaunch invoked with the exact brick shape', () =>
  withContinuationDb(relaunchStubs({
    getLatestContinuationAttempt: (_id: string, status?: string) =>
      (status === 'committed' ? attemptRow({ status: 'committed', reason: 'context-pressure' }) : null),
  }), async (port) => {
    const res = await relaunch(port);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(JSON.parse(res.body),
      { agentId: 'sup-1', attemptId: 'att-1', generation: 1, noteId: 'brick-1' });
    assert.equal(relaunched()!.agentId, 'sup-1');
    assert.deepEqual(relaunched()!.brick, {
      handoffAttemptId: 'att-1',
      noteId: 'brick-1',
      reason: 'context-pressure',
      note: 'phase notes',
      workspaceId: 'ws-1',
    });
  }));

test('Inc 4: relaunch unknown agent → 404', () =>
  withContinuationDb(relaunchStubs(), async (port) => {
    const res = await request(port, 'POST', '/api/agents/nope/continuation-relaunch', JSON_SUP, '{}');
    assert.equal(res.status, 404);
  }));

// ── Inc 5 (5B): note-less empty-memo escape (emptyMemoEscape: true) ─────────
//
// Phase 5 model: the escape is authorized by the durable EFFORT BUDGET
// (getContinuationEscapeBudget over the current successor cycle) — NOT a context
// percentage. 100% context is a cost metric, not a cliff. The escape opens iff
// the attempt is still OPEN, NO tool brick exists, and the budget is exhausted:
// abortedCount ≥ CONTINUATION_ESCAPE_MAX_ATTEMPTS OR the cycle has been alive
// past CONTINUATION_ESCAPE_MAX_ALIVE_MS. Until then it is abort-don't-kill.
// Timestamps are the UTC 'YYYY-MM-DD HH:MM:SS.fff' strings the route converts
// to epoch ms; the route's alive clock reads real Date.now(), so an ancient
// firstAttemptStartedAt trips alive-time and null never does.

/** Escape defaults: OPEN attempt at expected gen 1, NO tool brick, and a budget
 *  that is exhausted BY ABORT COUNT — so the happy path and the shared-gate
 *  rechecks proceed. Budget tests override getContinuationEscapeBudget. */
function escapeStubs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return relaunchStubs({
    getOpenContinuationAttempt: (id: string) => (id === 'sup-1' ? attemptRow({ status: 'open' }) : null),
    getLatestBrickForAttempt: () => null,
    getContinuationEscapeBudget: () => ({
      abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS,
      firstAttemptStartedAt: null,
    }),
    ...over,
  });
}
const ESCAPE_BODY = JSON.stringify({ emptyMemoEscape: true });

test('Inc 5: escape with budget exhausted by ABORT COUNT → 200, "none" Block C + Block A self-orient advisory', () =>
  withContinuationDb(escapeStubs(), async (port) => {
    const res = await relaunch(port, ESCAPE_BODY);
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).noteId, 'none');
    const brick = relaunched()!.brick;
    assert.equal(brick.note, 'none');
    assert.equal(brick.noteId, 'none');
    assert.match(String(brick.reason), /no note captured/);
    assert.match(String(brick.reason), /get_my_context/);
  }));

test('Inc 5: escape with budget exhausted by ALIVE-TIME (zero aborts, ancient first attempt) → 200', () =>
  withContinuationDb(escapeStubs({
    // now - firstMs ≫ MAX_ALIVE_MS even with zero aborts (the still-open attempt
    // alone trips the alive clock).
    getContinuationEscapeBudget: () => ({ abortedCount: 0, firstAttemptStartedAt: '2000-01-01 00:00:00.000' }),
  }), async (port) => {
    const res = await relaunch(port, ESCAPE_BODY);
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).noteId, 'none');
  }));

test('Inc 5: escape with budget NOT exhausted (aborts<MAX, no alive-time) → 425 continuation-budget-not-exhausted, abort-don\'t-kill', () =>
  withContinuationDb(escapeStubs({
    getContinuationEscapeBudget: () => ({
      abortedCount: CONTINUATION_ESCAPE_MAX_ATTEMPTS - 1,
      firstAttemptStartedAt: null,
    }),
  }), async (port) => {
    const res = await relaunch(port, ESCAPE_BODY);
    assert.equal(res.status, 425);
    assert.equal(JSON.parse(res.body).code, 'continuation-budget-not-exhausted');
    assert.equal(relaunched(), null);
  }));

test('Inc 5: escape without an OPEN attempt at the current gen → 409 continuation-attempt-not-open', () =>
  withContinuationDb(escapeStubs({ getOpenContinuationAttempt: () => null }), async (port) => {
    const res = await relaunch(port, ESCAPE_BODY);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-attempt-not-open');
    assert.equal(relaunched(), null);
  }));

test('Inc 5: escape while a tool brick EXISTS → 409 continuation-escape-has-brick (use the normal path)', () =>
  withContinuationDb(escapeStubs({
    getLatestBrickForAttempt: (_a: string, _att: string, opts?: { source?: string }) =>
      (opts?.source === 'tool' ? brickRow() : null),
  }), async (port) => {
    const res = await relaunch(port, ESCAPE_BODY);
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).code, 'continuation-escape-has-brick');
    assert.equal(relaunched(), null);
  }));

test('Inc 5: escape with a busy owned worker NO LONGER blocks (owned-busy removed, Edward 2026-07-05) → 200', () =>
  withContinuationDb(escapeStubs({
    getAgentsByOwner: () => [{ id: 'w-busy', status: 'working' }],
  }), async (port) => {
    const res = await relaunch(port, ESCAPE_BODY);
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).noteId, 'none');
  }));

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} api-identity tests passed`);
})();
