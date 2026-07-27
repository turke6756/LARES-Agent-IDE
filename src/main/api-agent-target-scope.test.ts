// WP2 (plans/cross-workspace-collaboration.md — "WP2 — Per-ID intentional
// gating") — per-ID target-agent authorization + audit tests.
//
// Covers the five per-ID routes opened by WP2:
//   GET  /api/agents/:id
//   GET  /api/agents/:id/log
//   GET  /api/agents/:id/messages
//   GET  /api/agents/:id/file-activities
//   POST /api/agents/:id/input
//
// The capability matrix per the plan's "WP2 tests" bullet:
//   - local worker read/send  → allowed, NO audit;
//   - foreign worker          → 403 cross-workspace-target-forbidden (audited denial);
//   - foreign supervisor      → allowed + audit;
//   - global bearer foreign   → allowed (UI compat), NO audit;
//   - a send still arms the one-turn subscription;
//   - a foreign SEND records queued_message_len (length only), never contents;
//   - same-workspace /input is NOT audited.
//
// Like api-cross-workspace-list.test.ts, route() is invoked directly against a
// stub supervisor + patched database accessors — no http listener needed.
//
//   npm run build:main
//   node dist/main/main/api-agent-target-scope.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import type { Agent } from '../shared/types';
import type { CapabilityClaim } from './security/agent-capabilities';

// IdentityContext is private to api-server.ts; the WP2 routes key off `capability`
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
const WS_B = 'ws-b';   // a foreign workspace

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

// a1 lives in the actor's own workspace (WS_A); a2 is foreign (WS_B).
const AGENTS: Agent[] = [
  makeAgent('a1', WS_A, 'Local Worker'),
  makeAgent('a2', WS_B, 'Foreign Worker'),
];

const claim = (lane: CapabilityClaim['privilegeLane'], workspaceId = WS_A): CapabilityClaim =>
  ({ agentId: `cap-${lane}`, workspaceId, privilegeLane: lane });

const IDENTITY: IdentityContext = {
  workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
};

// ── DB + supervisor harness ───────────────────────────────────────────────────

interface AuditCall {
  operation: string; actorAgentId?: string | null; actorWorkspaceId?: string | null;
  actorLane?: string | null; targetAgentId?: string | null; targetWorkspaceId?: string | null;
  force?: boolean; queuedMessageLen?: number | null; outcome: string;
  detail?: Record<string, unknown> | null;
}

interface SubCall { targetAgentId: string; subscriberAgentId: string; }

function makeApi(): {
  api: ApiServer; audits: AuditCall[]; subs: SubCall[]; sends: Array<{ id: string; text: string }>;
  cleanup: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig = {
    getAgent: db.getAgent,
    getFileActivities: db.getFileActivities,
    recordCrossWorkspaceAudit: db.recordCrossWorkspaceAudit,
  };
  const audits: AuditCall[] = [];
  db.getAgent = (id: string) => AGENTS.find(a => a.id === id) ?? null;
  db.getFileActivities = () => [];
  db.recordCrossWorkspaceAudit = (entry: AuditCall) => { audits.push(entry); };

  const subs: SubCall[] = [];
  const sends: Array<{ id: string; text: string }> = [];
  const supervisor = {
    getContextStats: () => null,
    isInputInFlight: () => false,
    getAgentLog: async () => 'log-bytes',
    maybeRecoverCodexSid: () => {},
    getChatService: () => ({ getMessages: async () => [{ role: 'assistant', text: 'hi' }] }),
    registerTransientTurnSubscription: (arg: SubCall) => { subs.push(arg); return { registered: true }; },
    cancelTransientTurnSubscriptionsForPair: () => {},
    sendInput: async (id: string, text: string) => { sends.push({ id, text }); },
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 24679);

  return {
    api, audits, subs, sends,
    cleanup: () => {
      db.getAgent = orig.getAgent;
      db.getFileActivities = orig.getFileActivities;
      db.recordCrossWorkspaceAudit = orig.recordCrossWorkspaceAudit;
    },
  };
}

interface RouteResult { status: number; body: any; }

async function callRoute(
  api: ApiServer, method: string, pathname: string, capability?: CapabilityClaim, body?: unknown,
): Promise<RouteResult> {
  const url = new URL(pathname, 'http://localhost:24679');
  const req = new http.IncomingMessage(null as any);
  req.method = method;
  req.url = pathname;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage, id: IdentityContext, cap?: CapabilityClaim) => Promise<any>;
    }).route(method, url, req, IDENTITY, capability);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message, code: err.code } };
  }
}

// Every per-ID READ route, keyed to its target-id path segment.
const READ_ROUTES: Array<{ name: string; path: (id: string) => string }> = [
  { name: 'GET /api/agents/:id', path: (id) => `/api/agents/${id}` },
  { name: 'GET /api/agents/:id/log', path: (id) => `/api/agents/${id}/log` },
  { name: 'GET /api/agents/:id/messages', path: (id) => `/api/agents/${id}/messages` },
  { name: 'GET /api/agents/:id/file-activities', path: (id) => `/api/agents/${id}/file-activities` },
];

// ── Reads: local worker → allowed, no audit ────────────────────────────────────

for (const r of READ_ROUTES) {
  test(`${r.name}: local worker read → allowed, NO audit`, async () => {
    const h = makeApi();
    try {
      const res = await callRoute(h.api, 'GET', r.path('a1'), claim('worker'));
      assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(h.audits.length, 0, 'a same-workspace read is never audited');
    } finally { h.cleanup(); }
  });

  test(`${r.name}: foreign worker read → 403 cross-workspace-target-forbidden, denial audited`, async () => {
    const h = makeApi();
    try {
      const res = await callRoute(h.api, 'GET', r.path('a2'), claim('worker'));
      assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'cross-workspace-target-forbidden');
      assert.equal(h.audits.length, 1, 'the denied foreign read is audited');
      const a = h.audits[0];
      assert.equal(a.operation, 'read_agent');
      assert.equal(a.actorLane, 'worker');
      assert.equal(a.targetAgentId, 'a2');
      assert.equal(a.targetWorkspaceId, WS_B);
      assert.equal(a.outcome, 'denied:cross-workspace-target-forbidden');
      assert.equal(a.queuedMessageLen ?? null, null, 'a read never carries a message length');
      assert.deepEqual(a.detail, { code: 'cross-workspace-target-forbidden' });
    } finally { h.cleanup(); }
  });

  test(`${r.name}: foreign supervisor read → allowed + audit`, async () => {
    const h = makeApi();
    try {
      const res = await callRoute(h.api, 'GET', r.path('a2'), claim('supervisor'));
      assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(h.audits.length, 1, 'a foreign supervisor read is audited');
      const a = h.audits[0];
      assert.equal(a.operation, 'read_agent');
      assert.equal(a.actorLane, 'supervisor');
      assert.equal(a.actorAgentId, 'cap-supervisor');
      assert.equal(a.actorWorkspaceId, WS_A);
      assert.equal(a.targetAgentId, 'a2');
      assert.equal(a.targetWorkspaceId, WS_B);
      assert.equal(a.outcome, 'ok');
    } finally { h.cleanup(); }
  });

  test(`${r.name}: global bearer foreign read → allowed (UI compat), NO audit`, async () => {
    const h = makeApi();
    try {
      const res = await callRoute(h.api, 'GET', r.path('a2'), undefined);
      assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(h.audits.length, 0, 'the trusted global-bearer path is never audited');
    } finally { h.cleanup(); }
  });

  test(`${r.name}: missing target → 404`, async () => {
    const h = makeApi();
    try {
      const res = await callRoute(h.api, 'GET', r.path('nope'), claim('supervisor'));
      assert.equal(res.status, 404, `expected 404; got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(h.audits.length, 0, 'a missing-target 404 is not a cross-workspace event');
    } finally { h.cleanup(); }
  });
}

// ── POST /api/agents/:id/input ─────────────────────────────────────────────────

test('POST /input: local worker send → allowed, NO audit, delivered', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a1/input', claim('worker'), { text: 'hello' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.queued, true);
    assert.equal(h.audits.length, 0, 'a same-workspace /input is intentionally NOT audited');
    assert.deepEqual(h.sends, [{ id: 'a1', text: 'hello' }], 'the message was delivered');
  } finally { h.cleanup(); }
});

test('POST /input: foreign worker send → 403, denial audited with queued_message_len (length only)', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a2/input', claim('worker'), { text: 'hello' });
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'cross-workspace-target-forbidden');
    assert.equal(h.audits.length, 1, 'the denied foreign send is audited');
    const a = h.audits[0];
    assert.equal(a.operation, 'send_message');
    assert.equal(a.actorLane, 'worker');
    assert.equal(a.targetAgentId, 'a2');
    assert.equal(a.targetWorkspaceId, WS_B);
    assert.equal(a.outcome, 'denied:cross-workspace-target-forbidden');
    assert.equal(a.queuedMessageLen, 'hello'.length, 'length only — never contents');
    assert.equal(h.sends.length, 0, 'a denied send never reaches delivery');
  } finally { h.cleanup(); }
});

test('POST /input: foreign supervisor send → allowed + audit (queued_message_len, no contents)', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a2/input', claim('supervisor'), { text: 'orient please' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.queued, true);
    assert.equal(h.audits.length, 1, 'a foreign supervisor send is audited');
    const a = h.audits[0];
    assert.equal(a.operation, 'send_message');
    assert.equal(a.actorLane, 'supervisor');
    assert.equal(a.targetAgentId, 'a2');
    assert.equal(a.targetWorkspaceId, WS_B);
    assert.equal(a.outcome, 'ok');
    assert.equal(a.queuedMessageLen, 'orient please'.length);
    // The audit entry must NOT carry the text under any key.
    assert.ok(!Object.values(a).includes('orient please'), 'message contents are never stored');
    assert.deepEqual(h.sends, [{ id: 'a2', text: 'orient please' }]);
  } finally { h.cleanup(); }
});

test('POST /input: global bearer foreign send → allowed (UI compat), NO audit', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a2/input', undefined, { text: 'hi' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.audits.length, 0, 'the trusted global-bearer path is never audited');
  } finally { h.cleanup(); }
});

test('POST /input: a submitted send still arms the one-turn subscription', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(
      h.api, 'POST', '/api/agents/a1/input', claim('worker'),
      { text: 'hello', senderAgentId: 'cap-worker' },
    );
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.subs.length, 1, 'the one-turn subscription was armed');
    assert.deepEqual(h.subs[0], { targetAgentId: 'a1', subscriberAgentId: 'cap-worker' });
    assert.equal(res.body.transientSubscription.registered, true);
  } finally { h.cleanup(); }
});

test('POST /input: missing target → 404, no audit, no delivery', async () => {
  const h = makeApi();
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/nope/input', claim('supervisor'), { text: 'hi' });
    assert.equal(res.status, 404, `expected 404; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.audits.length, 0);
    assert.equal(h.sends.length, 0);
  } finally { h.cleanup(); }
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
