// WP1 (plans/cross-workspace-collaboration.md — "WP1 — Discovery: list_workspaces
// + cross-workspace list_agents") — route + MCP-shim tests for the two discovery
// surfaces opened by WP1.
//
// Two concerns, both driven off the plan's "WP1 tests" bullet:
//   A. The api-server routes GET /api/agents and GET /api/workspaces — the
//      capability matrix over both routes (worker foreign → 403; supervisor
//      foreign → rows; global bearer → all; own-scope per tier), the reduced
//      workspace projection (NO `path`, counts default to zero for zero-active
//      workspaces), the enriched agent projection (`workspaceId`/`workspaceTitle`),
//      and audit ONLY on foreign-supervisor calls + denied-worker attempts.
//   B. The MCP shim (scripts/mcp-tools-observability.js) — list_agents emits the
//      documented `lastActivityAt = lastOutputAt ?? updatedAt` plus workspace
//      fields; list_workspaces returns [{id, title, agentCounts}].
//
// The routes touch only the (patched) database accessors + a stub supervisor, so
// no start()/http listener is needed — route() is invoked directly, mirroring
// api-server-status.test.ts. The shim is plain JS require()'d with a fake
// apiRequest.
//
//   npm run build:main
//   node dist/main/main/api-cross-workspace-list.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import * as path from 'node:path';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import type { Agent, Workspace } from '../shared/types';
import type { CapabilityClaim } from './security/agent-capabilities';

// IdentityContext is private to api-server.ts; the WP1 routes key off `capability`
// (the minted claim), not identity, so a structural stub of the non-asserted shape
// is all these route calls need.
interface IdentityContext {
  workspaceId: string | null;
  supervisor: Agent | null;
  asserted: boolean;
  projectId: string | null;
  supervisorId: string | null;
}

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WS_A = 'ws-a';   // the actor's own workspace
const WS_B = 'ws-b';   // a foreign workspace (deliberately zero-active in the summary)

function makeWorkspace(id: string, title: string): Workspace {
  return {
    id, title, path: `C:/ws/${id}`, pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '2026-01-01', updatedAt: '2026-01-02', lastOpenedAt: null,
  };
}

function makeAgent(id: string, workspaceId: string, title: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, workspaceId, title, slug: id, roleDescription: '', workingDirectory: `C:/ws/${workspaceId}`,
    command: 'claude', provider: 'claude', isSupervisor: false, isSupervised: false, isWorker: true,
    isResearcher: false, tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: null,
    status: 'idle', isAttached: false, restartCount: 0, lastExitCode: null, pid: null, logPath: null,
    templateId: null, systemPrompt: null, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    lastOutputAt: null, lastAttachedAt: null, ownerAgentId: null,
    ...extra,
  } as Agent;
}

const WORKSPACES: Workspace[] = [makeWorkspace(WS_A, 'Alpha'), makeWorkspace(WS_B, 'Beta')];
const AGENTS: Agent[] = [
  makeAgent('a1', WS_A, 'Worker One'),
  makeAgent('a2', WS_B, 'Worker Two'),
];

const claim = (lane: CapabilityClaim['privilegeLane'], workspaceId = WS_A): CapabilityClaim =>
  ({ agentId: `cap-${lane}`, workspaceId, privilegeLane: lane });

// A stub identity — the WP1 routes key off `capability`, not `identity`, so a
// non-asserted stub suffices (matches every UI/curl caller today).
const IDENTITY: IdentityContext = {
  workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
};

// ── DB + supervisor harness ───────────────────────────────────────────────────

interface AuditCall {
  operation: string; actorAgentId?: string | null; actorWorkspaceId?: string | null;
  actorLane?: string | null; targetWorkspaceId?: string | null; outcome: string;
  detail?: Record<string, unknown> | null;
}

function makeApi(): { api: ApiServer; audits: AuditCall[]; cleanup: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig = {
    getWorkspaces: db.getWorkspaces,
    getWorkspace: db.getWorkspace,
    getAllAgents: db.getAllAgents,
    getAgentsByWorkspace: db.getAgentsByWorkspace,
    getWorkspaceAgentSummary: db.getWorkspaceAgentSummary,
    recordCrossWorkspaceAudit: db.recordCrossWorkspaceAudit,
  };
  const audits: AuditCall[] = [];
  db.getWorkspaces = () => WORKSPACES;
  db.getWorkspace = (id: string) => WORKSPACES.find(w => w.id === id) ?? null;
  db.getAllAgents = () => AGENTS;
  db.getAgentsByWorkspace = (wsId: string) => AGENTS.filter(a => a.workspaceId === wsId);
  // Deliberately OMIT WS_B so the route must default its counts to zero.
  db.getWorkspaceAgentSummary = () => [{ workspaceId: WS_A, activeCount: 2, workingCount: 1 }];
  db.recordCrossWorkspaceAudit = (entry: AuditCall) => { audits.push(entry); };

  const supervisor = {
    getContextStats: () => null,
    isInputInFlight: () => false,
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 24678);

  return {
    api, audits,
    cleanup: () => {
      db.getWorkspaces = orig.getWorkspaces;
      db.getWorkspace = orig.getWorkspace;
      db.getAllAgents = orig.getAllAgents;
      db.getAgentsByWorkspace = orig.getAgentsByWorkspace;
      db.getWorkspaceAgentSummary = orig.getWorkspaceAgentSummary;
      db.recordCrossWorkspaceAudit = orig.recordCrossWorkspaceAudit;
    },
  };
}

interface RouteResult { status: number; body: any; }

async function callRoute(
  api: ApiServer, pathname: string, capability?: CapabilityClaim,
): Promise<RouteResult> {
  const url = new URL(pathname, 'http://localhost:24678');
  const req = new http.IncomingMessage(null as any);
  req.method = 'GET';
  req.url = pathname;
  process.nextTick(() => req.emit('end'));
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage, id: IdentityContext, cap?: CapabilityClaim) => Promise<any>;
    }).route('GET', url, req, IDENTITY, capability);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message, code: err.code } };
  }
}

// ── A. GET /api/agents ─────────────────────────────────────────────────────────

test('GET /api/agents: worker + foreign workspaceId → 403 cross-workspace-requires-supervisor, denial audited', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, `/api/agents?workspaceId=${WS_B}`, claim('worker'));
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'cross-workspace-requires-supervisor');
    assert.equal(h.audits.length, 1, 'the denied attempt is audited');
    const a = h.audits[0];
    assert.equal(a.operation, 'list_agents');
    assert.equal(a.actorLane, 'worker');
    assert.equal(a.targetWorkspaceId, WS_B);
    assert.ok(a.outcome.startsWith('denied:'), `outcome ${a.outcome}`);
    assert.equal(a.outcome, 'denied:cross-workspace-requires-supervisor');
  } finally { h.cleanup(); }
});

test('GET /api/agents: supervisor + foreign workspaceId → foreign rows + workspaceTitle, success audited', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, `/api/agents?workspaceId=${WS_B}`, claim('supervisor'));
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.length, 1, 'only WS_B agents');
    assert.equal(res.body[0].id, 'a2');
    assert.equal(res.body[0].workspaceId, WS_B);
    assert.equal(res.body[0].workspaceTitle, 'Beta', 'row enriched with owning workspace title');
    assert.equal(h.audits.length, 1, 'the foreign supervisor list is audited');
    assert.equal(h.audits[0].outcome, 'ok');
    assert.equal(h.audits[0].targetWorkspaceId, WS_B);
    assert.equal(h.audits[0].actorLane, 'supervisor');
  } finally { h.cleanup(); }
});

test('GET /api/agents: global bearer (no capability), no workspaceId → ALL agents, no audit', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, '/api/agents', undefined);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, AGENTS.length, 'global bearer sees all');
    assert.equal(h.audits.length, 0, 'the trusted path is never audited');
  } finally { h.cleanup(); }
});

test('GET /api/agents: worker own-scope (no workspaceId) → own agents only, no audit', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, '/api/agents', claim('worker'));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1, 'self-scoped to WS_A');
    assert.equal(res.body[0].id, 'a1');
    assert.equal(res.body[0].workspaceTitle, 'Alpha');
    assert.equal(h.audits.length, 0, 'a self-scoped list is not audited');
  } finally { h.cleanup(); }
});

test('GET /api/agents: supervisor own-scope (explicit === own) → no audit', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, `/api/agents?workspaceId=${WS_A}`, claim('supervisor'));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, 'a1');
    assert.equal(h.audits.length, 0, 'own-scope is not a cross-workspace reach');
  } finally { h.cleanup(); }
});

// ── B. GET /api/workspaces ───────────────────────────────────────────────────

test('GET /api/workspaces: global bearer → FULL Workspace objects (path present), no audit', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, '/api/workspaces', undefined);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.ok('path' in res.body[0], 'trusted path keeps the full object incl. path');
    assert.equal(h.audits.length, 0);
  } finally { h.cleanup(); }
});

test('GET /api/workspaces: supervisor → all workspaces, reduced projection (no path), zero-active default, audited', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, '/api/workspaces', claim('supervisor'));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2, 'supervisor sees every workspace');
    for (const w of res.body) {
      assert.deepEqual(Object.keys(w).sort(), ['agentCounts', 'id', 'title'], 'reduced projection, NO path');
    }
    const a = res.body.find((w: any) => w.id === WS_A);
    const b = res.body.find((w: any) => w.id === WS_B);
    assert.deepEqual(a.agentCounts, { activeCount: 2, workingCount: 1 }, 'summary counts applied');
    assert.deepEqual(b.agentCounts, { activeCount: 0, workingCount: 0 }, 'zero-active workspace defaults to zero');
    assert.equal(h.audits.length, 1, 'a broader-than-own list is audited');
    assert.equal(h.audits[0].operation, 'list_workspaces');
    assert.equal(h.audits[0].outcome, 'ok');
  } finally { h.cleanup(); }
});

test('GET /api/workspaces: worker → OWN workspace only, reduced projection, no audit', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, '/api/workspaces', claim('worker'));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1, 'worker sees only its own workspace');
    assert.equal(res.body[0].id, WS_A);
    assert.ok(!('path' in res.body[0]), 'agent caller gets no path');
    assert.deepEqual(res.body[0].agentCounts, { activeCount: 2, workingCount: 1 });
    assert.equal(h.audits.length, 0, 'own-only scope is not audited');
  } finally { h.cleanup(); }
});

// ── C. MCP shim projection (scripts/mcp-tools-observability.js) ────────────────

test('shim list_agents: emits workspaceId/workspaceTitle + lastActivityAt = lastOutputAt ?? updatedAt', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handleObservabilityCoreToolCall } = require(path.resolve('scripts/mcp-tools-observability.js'));
  // Two rows: one with lastOutputAt (→ lastActivityAt = lastOutputAt), one without
  // (→ falls back to updatedAt).
  const fakeAgents = [
    { id: 'a1', title: 'One', status: 'idle', provider: 'claude', isSupervisor: false,
      workspaceId: WS_A, workspaceTitle: 'Alpha', workingDirectory: 'C:/ws/a',
      updatedAt: '2026-01-02T00:00:00Z', lastOutputAt: '2026-01-03T00:00:00Z',
      contextStats: { contextPercentage: 42.7, totalTokens: 1000, turnCount: 3, model: 'opus' } },
    { id: 'a2', title: 'Two', status: 'done', provider: 'codex', isSupervisor: true,
      workspaceId: WS_B, workspaceTitle: 'Beta', workingDirectory: 'C:/ws/b',
      updatedAt: '2026-01-05T00:00:00Z', lastOutputAt: null, contextStats: null },
  ];
  const apiRequest = async (_m: string, p: string) => {
    assert.equal(p, '/api/agents', 'no workspace_id → own-scope path');
    return fakeAgents;
  };
  const res = await handleObservabilityCoreToolCall('list_agents', {}, apiRequest);
  const rows = JSON.parse(res.content[0].text);
  assert.equal(rows[0].workspaceId, WS_A);
  assert.equal(rows[0].workspaceTitle, 'Alpha');
  assert.equal(rows[0].lastActivityAt, '2026-01-03T00:00:00Z', 'lastOutputAt wins when present');
  assert.equal(rows[0].context.contextPercentage, 42.7, 'numeric contextPercentage emitted');
  assert.equal(rows[1].lastActivityAt, '2026-01-05T00:00:00Z', 'falls back to updatedAt when lastOutputAt is null');
  assert.equal(rows[1].context, null);
});

test('shim list_agents: a workspace_id is forwarded as ?workspaceId=', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handleObservabilityCoreToolCall } = require(path.resolve('scripts/mcp-tools-observability.js'));
  let seen = '';
  const apiRequest = async (_m: string, p: string) => { seen = p; return []; };
  await handleObservabilityCoreToolCall('list_agents', { workspace_id: WS_B }, apiRequest);
  assert.equal(seen, `/api/agents?workspaceId=${WS_B}`);
});

test('shim list_workspaces: GETs /api/workspaces and returns [{id, title, agentCounts}]', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handleObservabilityCoreToolCall } = require(path.resolve('scripts/mcp-tools-observability.js'));
  let seen = '';
  const apiRequest = async (_m: string, p: string) => {
    seen = p;
    return [{ id: WS_A, title: 'Alpha', agentCounts: { activeCount: 2, workingCount: 1 } },
            { id: WS_B, title: 'Beta', agentCounts: { activeCount: 0, workingCount: 0 } }];
  };
  const res = await handleObservabilityCoreToolCall('list_workspaces', {}, apiRequest);
  assert.equal(seen, '/api/workspaces');
  const rows = JSON.parse(res.content[0].text);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['agentCounts', 'id', 'title']);
  assert.deepEqual(rows[0].agentCounts, { activeCount: 2, workingCount: 1 });
});

test('shim list_workspaces is a registered observability-core tool (auto-appears in tools/list)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getObservabilityCoreToolDefinitions } = require(path.resolve('scripts/mcp-tools-observability.js'));
  const defs = getObservabilityCoreToolDefinitions();
  const names = defs.map((d: any) => d.name);
  assert.ok(names.includes('list_workspaces'), 'list_workspaces is defined');
  assert.ok(names.includes('list_agents'), 'list_agents still defined');
  const lw = defs.find((d: any) => d.name === 'list_workspaces');
  assert.deepEqual(lw.inputSchema.properties, {}, 'no-arg schema');
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
