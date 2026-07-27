// WP4.3 (plans/cross-workspace-collaboration.md — "Authorize the normalized
// input.workspaceId; foreign only for peer") — POST /api/agents launch-scope
// authorization for the `supervisor-peer` launch class.
//
// The route's contract:
//   - the snake_case `mode` is normalized to the camelCase `launchMode`;
//   - a `supervisor-peer` launch is the ONLY class permitted to reach a FOREIGN
//     workspace, and only with supervisor privilege — a capability-bearing
//     non-supervisor is refused even in its own workspace;
//   - foreign peer launches (and denials) are audited (operation 'launch'); a
//     same-workspace peer launch and the trusted global-bearer/UI path are not;
//   - a `worker`-mode launch stays self-scoped via resolveWorkspaceScope — a
//     foreign worker-mode launch under an asserted identity is a scope-mismatch 403.
//
// Like api-revive.test.ts, route() is invoked directly against a stub supervisor +
// patched database accessors — no http listener needed.
//
//   npm run build:main
//   node dist/main/main/api-launch-peer-supervisor.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import type { Agent, LaunchAgentInput } from '../shared/types';
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

const claim = (lane: CapabilityClaim['privilegeLane'], workspaceId = WS_A): CapabilityClaim =>
  ({ agentId: `cap-${lane}`, workspaceId, privilegeLane: lane });

const UNASSERTED: IdentityContext = {
  workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
};
const assertedIn = (workspaceId: string): IdentityContext =>
  ({ workspaceId, supervisor: null, asserted: true, projectId: null, supervisorId: null });

// ── DB + supervisor harness ───────────────────────────────────────────────────

interface AuditCall {
  operation: string; actorAgentId?: string | null; actorWorkspaceId?: string | null;
  actorLane?: string | null; targetAgentId?: string | null; targetWorkspaceId?: string | null;
  force?: boolean; queuedMessageLen?: number | null; outcome: string;
  detail?: Record<string, unknown> | null;
}

function makeApi(): {
  api: ApiServer; audits: AuditCall[]; launches: LaunchAgentInput[]; cleanup: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig = { recordCrossWorkspaceAudit: db.recordCrossWorkspaceAudit, getPlan: db.getPlan };
  const audits: AuditCall[] = [];
  db.recordCrossWorkspaceAudit = (entry: AuditCall) => { audits.push(entry); };
  db.getPlan = () => null;

  const launches: LaunchAgentInput[] = [];
  const supervisor = {
    launchAgent: async (input: LaunchAgentInput) => {
      launches.push(input);
      return { id: 'new-agent', workspaceId: input.workspaceId, title: input.title } as unknown as Agent;
    },
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 24682);

  return {
    api, audits, launches,
    cleanup: () => { db.recordCrossWorkspaceAudit = orig.recordCrossWorkspaceAudit; db.getPlan = orig.getPlan; },
  };
}

interface RouteResult { status: number; body: any; }

async function callLaunch(
  api: ApiServer, body: unknown, identity: IdentityContext, capability?: CapabilityClaim,
): Promise<RouteResult> {
  const pathname = '/api/agents';
  const url = new URL(pathname, 'http://localhost:24682');
  const req = new http.IncomingMessage(null as any);
  req.method = 'POST';
  req.url = pathname;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage, id: IdentityContext, cap?: CapabilityClaim) => Promise<any>;
    }).route('POST', url, req, identity, capability);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message, code: err.code } };
  }
}

// ── supervisor-peer scope authorization ─────────────────────────────────────────

test('foreign peer launch by SUPERVISOR → ok + audit (scope = foreign workspace)', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Peer', mode: 'supervisor-peer', workspaceId: WS_B }, UNASSERTED, claim('supervisor'));
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.launches.length, 1, 'launchAgent was called');
    assert.equal(h.launches[0].launchMode, 'supervisor-peer', 'mode normalized to launchMode');
    assert.equal(h.launches[0].workspaceId, WS_B, 'launch scoped to the foreign workspace');
    assert.equal(h.audits.length, 1);
    const a = h.audits[0];
    assert.equal(a.operation, 'launch');
    assert.equal(a.outcome, 'ok');
    assert.equal(a.actorLane, 'supervisor');
    assert.equal(a.actorWorkspaceId, WS_A);
    assert.equal(a.targetWorkspaceId, WS_B);
  } finally { h.cleanup(); }
});

test('foreign peer launch by WORKER → 403 cross-workspace-requires-supervisor, denial audited, no launch', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Peer', mode: 'supervisor-peer', workspaceId: WS_B }, UNASSERTED, claim('worker'));
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'cross-workspace-requires-supervisor');
    assert.equal(h.launches.length, 0, 'no launch on a denial');
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].outcome, 'denied:cross-workspace-requires-supervisor');
    assert.equal(h.audits[0].actorLane, 'worker');
    assert.equal(h.audits[0].targetWorkspaceId, WS_B);
  } finally { h.cleanup(); }
});

test('OWN-workspace peer launch by WORKER → 403 (a peer supervisor is a launch-class privilege)', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Peer', mode: 'supervisor-peer', workspaceId: WS_A }, UNASSERTED, claim('worker'));
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'cross-workspace-requires-supervisor');
    assert.equal(h.launches.length, 0);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].outcome, 'denied:cross-workspace-requires-supervisor');
    assert.equal(h.audits[0].targetWorkspaceId, WS_A);
  } finally { h.cleanup(); }
});

test('OWN-workspace peer launch by SUPERVISOR → ok, NOT audited (same workspace)', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Peer', mode: 'supervisor-peer', workspaceId: WS_A }, UNASSERTED, claim('supervisor'));
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].workspaceId, WS_A);
    assert.equal(h.audits.length, 0, 'a same-workspace peer launch is not audited');
  } finally { h.cleanup(); }
});

test('global bearer foreign peer launch → ok, NOT audited (trusted UI/admin path)', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Peer', mode: 'supervisor-peer', workspaceId: WS_B }, UNASSERTED, undefined);
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].workspaceId, WS_B, 'the bearer keeps the caller-supplied scope');
    assert.equal(h.audits.length, 0, 'the trusted path is not audited');
  } finally { h.cleanup(); }
});

// ── worker mode stays self-scoped (NO foreign reach) ─────────────────────────────

test('worker-mode (default) foreign launch under an asserted identity → 403 workspace-scope-mismatch, no peer audit', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Worker', workspaceId: WS_B }, assertedIn(WS_A), claim('worker'));
    assert.equal(res.status, 403, `expected 403; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'workspace-scope-mismatch');
    assert.equal(h.launches.length, 0, 'a scope-mismatch never launches');
    assert.equal(h.audits.length, 0, 'worker-mode denial goes through resolveWorkspaceScope, not the peer audit');
  } finally { h.cleanup(); }
});

test('worker-mode self launch (default) → ok, no audit', async () => {
  const h = makeApi();
  try {
    const res = await callLaunch(h.api, { title: 'Worker', workspaceId: WS_A }, assertedIn(WS_A), claim('worker'));
    assert.equal(res.status, 200, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].workspaceId, WS_A);
    assert.equal(h.launches[0].launchMode ?? undefined, undefined, 'no launchMode → worker default');
    assert.equal(h.audits.length, 0);
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
