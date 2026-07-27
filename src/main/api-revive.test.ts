// WP3.3 (plans/cross-workspace-collaboration.md — "HTTP route + MCP tool") —
// POST /api/agents/:id/revive authorization + audit tests.
//
// The route's contract:
//   - revival is SUPERVISOR-only even same-workspace when a capability is present
//     (a same-workspace worker read/send is fine, but never a revive);
//   - the trusted global-bearer/UI path is allowed;
//   - cross-workspace targets additionally pass through authorizeAgentTarget;
//   - EVERY attempt — success, denial, AND failure — is audited with sanitized
//     detail; queued_message_len carries the LENGTH only, never contents;
//   - a thrown revErr maps its statusCode → HTTP and its code → the error body.
//
// Like api-agent-target-scope.test.ts, route() is invoked directly against a stub
// supervisor + patched database accessors — no http listener needed.
//
//   npm run build:main
//   node dist/main/main/api-revive.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import type { Agent } from '../shared/types';
import type { CapabilityClaim } from './security/agent-capabilities';

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

function makeAgent(id: string, workspaceId: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, workspaceId, title: `Agent ${id}`, slug: id, roleDescription: '', workingDirectory: `C:/ws/${workspaceId}`,
    command: 'claude', provider: 'claude', isSupervisor: false, isSupervised: false, isWorker: true,
    isResearcher: false, tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: 'sess',
    status: 'done', isAttached: false, restartCount: 0, lastExitCode: 0, pid: null, logPath: null,
    templateId: null, systemPrompt: null, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    lastOutputAt: null, lastAttachedAt: null, ownerAgentId: null,
    ...extra,
  } as Agent;
}

const AGENTS: Agent[] = [
  makeAgent('a1', WS_A),   // local terminal agent
  makeAgent('a2', WS_B),   // foreign terminal agent
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

interface ReviveCall { id: string; message?: string; force?: boolean; }

type ReviveImpl = (id: string, opts: { message?: string; force?: boolean }) => Promise<{ revived: true; queued: boolean }>;

function makeApi(reviveImpl?: ReviveImpl): {
  api: ApiServer; audits: AuditCall[]; revives: ReviveCall[]; cleanup: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig = { getAgent: db.getAgent, recordCrossWorkspaceAudit: db.recordCrossWorkspaceAudit };
  const audits: AuditCall[] = [];
  db.getAgent = (id: string) => AGENTS.find(a => a.id === id) ?? null;
  db.recordCrossWorkspaceAudit = (entry: AuditCall) => { audits.push(entry); };

  const revives: ReviveCall[] = [];
  const supervisor = {
    reviveAgent: async (id: string, opts: { message?: string; force?: boolean }) => {
      revives.push({ id, message: opts.message, force: opts.force });
      if (reviveImpl) return reviveImpl(id, opts);
      return { revived: true as const, queued: !!opts.message };
    },
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 24681);

  return {
    api, audits, revives,
    cleanup: () => { db.getAgent = orig.getAgent; db.recordCrossWorkspaceAudit = orig.recordCrossWorkspaceAudit; },
  };
}

interface RouteResult { status: number; body: any; }

async function callRevive(
  api: ApiServer, id: string, capability?: CapabilityClaim, body?: unknown,
): Promise<RouteResult> {
  const pathname = `/api/agents/${id}/revive`;
  const url = new URL(pathname, 'http://localhost:24681');
  const req = new http.IncomingMessage(null as any);
  req.method = 'POST';
  req.url = pathname;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage, id: IdentityContext, cap?: CapabilityClaim) => Promise<any>;
    }).route('POST', url, req, IDENTITY, capability);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message, code: err.code } };
  }
}

// ── authorization matrix ─────────────────────────────────────────────────────

test('same-workspace worker → 403 cross-workspace-requires-supervisor, denial audited', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'a1', claim('worker'), {});
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'cross-workspace-requires-supervisor');
    assert.equal(h.revives.length, 0, 'reviveAgent is never called on a denial');
    assert.equal(h.audits.length, 1);
    const a = h.audits[0];
    assert.equal(a.operation, 'revive');
    assert.equal(a.outcome, 'denied:cross-workspace-requires-supervisor');
    assert.equal(a.actorLane, 'worker');
    assert.equal(a.targetAgentId, 'a1');
  } finally { h.cleanup(); }
});

test('foreign worker → 403 cross-workspace-target-forbidden, denial audited', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'a2', claim('worker'), {});
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'cross-workspace-target-forbidden');
    assert.equal(h.revives.length, 0);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].outcome, 'denied:cross-workspace-target-forbidden');
    assert.equal(h.audits[0].targetWorkspaceId, WS_B);
  } finally { h.cleanup(); }
});

test('same-workspace supervisor → success + audit ok', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'a1', claim('supervisor'), {});
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { revived: true, queued: false });
    assert.deepEqual(h.revives, [{ id: 'a1', message: undefined, force: false }]);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].outcome, 'ok');
    assert.equal(h.audits[0].actorLane, 'supervisor');
  } finally { h.cleanup(); }
});

test('foreign supervisor → success + audit ok', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'a2', claim('supervisor'), {});
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(h.revives, [{ id: 'a2', message: undefined, force: false }]);
    assert.equal(h.audits.length, 1);
    const a = h.audits[0];
    assert.equal(a.outcome, 'ok');
    assert.equal(a.actorAgentId, 'cap-supervisor');
    assert.equal(a.actorWorkspaceId, WS_A);
    assert.equal(a.targetAgentId, 'a2');
    assert.equal(a.targetWorkspaceId, WS_B);
  } finally { h.cleanup(); }
});

test('global bearer foreign → allowed (UI/admin) + audit ok, actorLane global-bearer', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'a2', undefined, {});
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.revives.length, 1);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].outcome, 'ok');
    assert.equal(h.audits[0].actorLane, 'global-bearer');
    assert.equal(h.audits[0].actorAgentId ?? null, null);
  } finally { h.cleanup(); }
});

test('missing target → 404, no audit, no revive', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'nope', claim('supervisor'), {});
    assert.equal(res.status, 404, `expected 404; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.audits.length, 0);
    assert.equal(h.revives.length, 0);
  } finally { h.cleanup(); }
});

// ── message length (never contents) + force pass-through ─────────────────────

test('a message records queued_message_len (length only, never contents); force passes through', async () => {
  const h = makeApi();
  try {
    const res = await callRevive(h.api, 'a2', claim('supervisor'), { message: 'orient then act', force: true });
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { revived: true, queued: true });
    assert.deepEqual(h.revives, [{ id: 'a2', message: 'orient then act', force: true }]);
    const a = h.audits[0];
    assert.equal(a.outcome, 'ok');
    assert.equal(a.queuedMessageLen, 'orient then act'.length);
    assert.equal(a.force, true);
    assert.ok(!Object.values(a).includes('orient then act'), 'message contents are never stored');
  } finally { h.cleanup(); }
});

// ── failure from the supervisor is mapped + audited ──────────────────────────

test('a revErr from reviveAgent maps statusCode→HTTP + code→body, and is audited as error:<code>', async () => {
  const failImpl: ReviveImpl = async () => {
    throw Object.assign(new Error('revive-no-session'), { code: 'revive-no-session', statusCode: 422 });
  };
  const h = makeApi(failImpl);
  try {
    const res = await callRevive(h.api, 'a2', claim('supervisor'), {});
    assert.equal(res.status, 422, `expected 422; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'revive-no-session');
    assert.equal(h.audits.length, 1);
    const a = h.audits[0];
    assert.equal(a.outcome, 'error:revive-no-session');
    assert.deepEqual(a.detail, { code: 'revive-no-session' });
  } finally { h.cleanup(); }
});

test('a revive-live-successor failure carries successorId into the sanitized detail', async () => {
  const failImpl: ReviveImpl = async () => {
    throw Object.assign(new Error('revive-live-successor'),
      { code: 'revive-live-successor', statusCode: 409, successorId: 'sup-new' });
  };
  const h = makeApi(failImpl);
  try {
    const res = await callRevive(h.api, 'a1', claim('supervisor'), {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'revive-live-successor');
    const a = h.audits[0];
    assert.equal(a.outcome, 'error:revive-live-successor');
    assert.deepEqual(a.detail, { code: 'revive-live-successor', successorId: 'sup-new' });
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
