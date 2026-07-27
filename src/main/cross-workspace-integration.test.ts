// WP6 (plans/cross-workspace-collaboration.md — "Integration, security matrix,
// docs") — the end-to-end acceptance scenario, the consolidated security matrix,
// and the credential-model rows, all in one place.
//
// Three parts:
//   A. ACCEPTANCE SCENARIO (proposal §5 steps 1–5) driven end-to-end against the
//      real ApiServer.route() dispatch: supervisor A in workspace A discovers
//      workspace B (list_workspaces), lists B's agents (list_agents {workspace_id}),
//      reads a done agent's messages, revives it, and sends it a message — with a
//      MINTED SUPERVISOR token. The same key steps are then replayed with a WORKER
//      token (403s) and with the global bearer (allowed, UI/admin path). The audit
//      ledger is asserted at every step (successes AND denials).
//   B. CONSOLIDATED SECURITY MATRIX: list / read / send / launch / revive ×
//      {global bearer, supervisor, worker, researcher} × {own, foreign} →
//      allow / deny / audited, asserted declaratively.
//   C. CREDENTIAL ROWS: no launched agent of ANY lane (worker / supervisor /
//      researcher) ever carries getApiToken() in its child env or any --mcp-config;
//      and a mint failure fails CLOSED (launch aborts, no bearer fallback). The
//      exhaustive single-token propagation coverage lives in
//      supervisor/credential-propagation.test.ts; these rows pin the WP6 invariant
//      alongside the matrix it belongs to.
//
// Parts A/B use the route-invocation harness (patched database accessors + a stub
// supervisor) shared by api-revive.test.ts / api-cross-workspace-list.test.ts — no
// http listener is needed. Part C uses a real AgentSupervisor with the runner
// stubbed, mirroring credential-propagation.test.ts.
//
//   npm run build:main
//   node dist/main/main/cross-workspace-integration.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import { AgentSupervisor as AgentSupervisorClass } from './supervisor';
import { WindowsRunner } from './supervisor/windows-runner';
import { makeAgent as makeRealAgent } from './supervisor/test-helpers/fake-bridge-deps';
import { patchApplyStatusTransition } from './supervisor/test-helpers/patch-apply-transition';
import { agentCapabilities } from './security/agent-capabilities';
import { getApiToken } from './security/api-auth';
import type { Agent, Workspace, LaunchAgentInput } from '../shared/types';
import type { CapabilityClaim } from './security/agent-capabilities';

// IdentityContext is private to api-server.ts; every route this file exercises
// keys off `capability` (the minted claim), not identity, so a structural stub of
// the non-asserted shape is all the route calls need.
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

const WS_A = 'ws-a';   // the actor's own workspace ("workspace A")
const WS_B = 'ws-b';   // a foreign workspace ("workspace B")

function makeWorkspace(id: string, title: string): Workspace {
  return {
    id, title, path: `C:/ws/${id}`, pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '2026-01-01', updatedAt: '2026-01-02', lastOpenedAt: null,
  };
}

function makeAgent(id: string, workspaceId: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, workspaceId, title: `Agent ${id}`, slug: id, roleDescription: '', workingDirectory: `C:/ws/${workspaceId}`,
    command: 'claude', provider: 'claude', isSupervisor: false, isSupervised: false, isWorker: true,
    isResearcher: false, tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: 'sess',
    status: 'idle', isAttached: false, restartCount: 0, lastExitCode: 0, pid: null, logPath: null,
    templateId: null, systemPrompt: null, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    lastOutputAt: null, lastAttachedAt: null, ownerAgentId: null,
    ...extra,
  } as Agent;
}

const WORKSPACES: Workspace[] = [makeWorkspace(WS_A, 'Alpha'), makeWorkspace(WS_B, 'Beta')];
const AGENTS: Agent[] = [
  makeAgent('a1', WS_A, { title: 'Local Worker' }),                  // local agent in A
  makeAgent('b1', WS_B, { title: 'Done Peer', isSupervisor: true, status: 'done' }), // the done agent in B to revive
];

const claim = (lane: CapabilityClaim['privilegeLane'], workspaceId = WS_A): CapabilityClaim =>
  ({ agentId: `cap-${lane}`, workspaceId, privilegeLane: lane });

const IDENTITY: IdentityContext = {
  workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
};

// ── Route-invocation harness (Parts A + B) ──────────────────────────────────────

interface AuditCall {
  operation: string; actorAgentId?: string | null; actorWorkspaceId?: string | null;
  actorLane?: string | null; targetAgentId?: string | null; targetWorkspaceId?: string | null;
  force?: boolean; queuedMessageLen?: number | null; outcome: string;
  detail?: Record<string, unknown> | null;
}

interface Recorder {
  audits: AuditCall[];
  revives: Array<{ id: string; message?: string; force?: boolean }>;
  launches: LaunchAgentInput[];
  sends: Array<{ id: string; text: string }>;
  subscriptions: Array<{ targetAgentId: string; subscriberAgentId: string }>;
}

function makeApi(): { api: ApiServer; rec: Recorder; cleanup: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig: Record<string, unknown> = {};
  for (const k of ['getWorkspaces', 'getWorkspace', 'getAllAgents', 'getAgentsByWorkspace',
    'getWorkspaceAgentSummary', 'getAgent', 'recordCrossWorkspaceAudit', 'getPlan']) orig[k] = db[k];

  const rec: Recorder = { audits: [], revives: [], launches: [], sends: [], subscriptions: [] };
  db.getWorkspaces = () => WORKSPACES;
  db.getWorkspace = (id: string) => WORKSPACES.find(w => w.id === id) ?? null;
  db.getAllAgents = () => AGENTS;
  db.getAgentsByWorkspace = (wsId: string) => AGENTS.filter(a => a.workspaceId === wsId);
  db.getWorkspaceAgentSummary = () => [{ workspaceId: WS_A, activeCount: 1, workingCount: 0 }];
  db.getAgent = (id: string) => AGENTS.find(a => a.id === id) ?? null;
  db.recordCrossWorkspaceAudit = (e: AuditCall) => { rec.audits.push(e); };
  db.getPlan = () => null;

  const supervisor = {
    getContextStats: () => null,
    isInputInFlight: () => false,
    getChatService: () => ({
      getMessages: async (_id: string, _o: unknown) => [
        { role: 'assistant', content: 'prior work summary', timestamp: '2026-01-02T00:00:00Z' },
      ],
    }),
    maybeRecoverCodexSid: () => {},
    registerTransientTurnSubscription: (s: { targetAgentId: string; subscriberAgentId: string }) => {
      rec.subscriptions.push(s);
      return { registered: true };
    },
    cancelTransientTurnSubscriptionsForPair: () => {},
    sendInputConfirmed: async (id: string, text: string) => {
      rec.sends.push({ id, text });
      return { confirmed: true, mode: 'hook' };
    },
    sendInput: async (id: string, text: string) => { rec.sends.push({ id, text }); },
    reviveAgent: async (id: string, opts: { message?: string; force?: boolean }) => {
      rec.revives.push({ id, message: opts.message, force: opts.force });
      return { revived: true as const, queued: !!opts.message };
    },
    launchAgent: async (input: LaunchAgentInput) => {
      rec.launches.push(input);
      return { id: 'new-agent', workspaceId: input.workspaceId, title: input.title } as unknown as Agent;
    },
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 24690);

  return { api, rec, cleanup: () => { for (const k of Object.keys(orig)) db[k] = orig[k]; } };
}

interface RouteResult { status: number; body: any; }

async function call(
  api: ApiServer, method: string, pathname: string,
  opts: { capability?: CapabilityClaim; identity?: IdentityContext; body?: unknown } = {},
): Promise<RouteResult> {
  const url = new URL(pathname, 'http://localhost:24690');
  const req = new http.IncomingMessage(null as any);
  req.method = method;
  req.url = pathname;
  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(opts.body)));
    req.emit('end');
  });
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage, id: IdentityContext, cap?: CapabilityClaim) => Promise<any>;
    }).route(method, url, req, opts.identity ?? IDENTITY, opts.capability);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message, code: err.code } };
  }
}

// ══ Part A — the acceptance scenario end-to-end ════════════════════════════════

test('A. acceptance: supervisor A discovers B, lists+reads B, revives + messages the done peer — every step audited', async () => {
  const h = makeApi();
  const sup = claim('supervisor', WS_A);
  try {
    // Step 1 — discover workspace B via list_workspaces.
    const ws = await call(h.api, 'GET', '/api/workspaces', { capability: sup });
    assert.equal(ws.status, 200);
    const beta = ws.body.find((w: any) => w.id === WS_B);
    assert.ok(beta, 'supervisor A sees workspace B in the discovery list');
    assert.equal(beta.title, 'Beta');
    assert.ok(!('path' in beta), 'the agent-caller projection omits the filesystem path');

    // Step 2 — list B's agents by name.
    const list = await call(h.api, 'GET', `/api/agents?workspaceId=${WS_B}`, { capability: sup });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1, 'only B agents');
    assert.equal(list.body[0].id, 'b1');
    assert.equal(list.body[0].workspaceTitle, 'Beta', 'foreign row disambiguated by workspace title');

    // Step 3 — read the done peer's prior messages.
    const msgs = await call(h.api, 'GET', '/api/agents/b1/messages', { capability: sup });
    assert.equal(msgs.status, 200);
    assert.equal(msgs.body.messages[0].content, 'prior work summary');

    // Step 4 — revive it, queuing a wake message.
    const rev = await call(h.api, 'POST', '/api/agents/b1/revive', { capability: sup, body: { message: 'resume where you left off' } });
    assert.equal(rev.status, 200, `revive expected 200; got ${rev.status} ${JSON.stringify(rev.body)}`);
    assert.deepEqual(rev.body, { revived: true, queued: true });
    assert.deepEqual(h.rec.revives, [{ id: 'b1', message: 'resume where you left off', force: false }]);

    // Step 5 — send it a follow-up message (confirmed handshake).
    const send = await call(h.api, 'POST', '/api/agents/b1/input', { capability: sup, body: { text: 'status?', confirm: true } });
    assert.equal(send.status, 200, `send expected 200; got ${send.status} ${JSON.stringify(send.body)}`);
    assert.equal(h.rec.sends.at(-1)?.text, 'status?');

    // Audit: one foreign row per cross-workspace step, all outcome 'ok', contents never stored.
    const ops = h.rec.audits.map(a => a.operation);
    assert.deepEqual(ops, ['list_workspaces', 'list_agents', 'read_agent', 'revive', 'send_message'],
      `audit ledger order/coverage; got ${JSON.stringify(ops)}`);
    for (const a of h.rec.audits) {
      assert.equal(a.outcome, 'ok', `${a.operation} audited ok`);
      assert.equal(a.actorLane, 'supervisor');
      for (const v of Object.values(a)) {
        assert.notEqual(v, 'resume where you left off', 'the revive message contents are never stored');
        assert.notEqual(v, 'status?', 'the sent message contents are never stored');
      }
    }
    const revRow = h.rec.audits.find(a => a.operation === 'revive')!;
    assert.equal(revRow.queuedMessageLen, 'resume where you left off'.length, 'revive stores message LENGTH only');
    const sendRow = h.rec.audits.find(a => a.operation === 'send_message')!;
    assert.equal(sendRow.queuedMessageLen, 'status?'.length, 'send stores message LENGTH only');
  } finally { h.cleanup(); }
});

test('A. acceptance replay: a WORKER token is refused at every cross-workspace step (403 + audited denial)', async () => {
  const h = makeApi();
  const wk = claim('worker', WS_A);
  try {
    const list = await call(h.api, 'GET', `/api/agents?workspaceId=${WS_B}`, { capability: wk });
    assert.equal(list.status, 403);
    assert.equal(list.body.code, 'cross-workspace-requires-supervisor');

    const read = await call(h.api, 'GET', '/api/agents/b1/messages', { capability: wk });
    assert.equal(read.status, 403);
    assert.equal(read.body.code, 'cross-workspace-target-forbidden');

    const rev = await call(h.api, 'POST', '/api/agents/b1/revive', { capability: wk, body: {} });
    assert.equal(rev.status, 403);
    assert.equal(rev.body.code, 'cross-workspace-target-forbidden');
    assert.equal(h.rec.revives.length, 0, 'a denied worker never reaches reviveAgent');

    // Every denial was audited.
    assert.equal(h.rec.audits.length, 3);
    assert.ok(h.rec.audits.every(a => a.outcome.startsWith('denied:')), 'all worker attempts audited as denials');
    assert.ok(h.rec.audits.every(a => a.actorLane === 'worker'));
  } finally { h.cleanup(); }
});

test('A. acceptance replay: the global bearer (UI/admin) is allowed foreign, and never audited', async () => {
  const h = makeApi();
  try {
    const list = await call(h.api, 'GET', `/api/agents?workspaceId=${WS_B}`, { capability: undefined });
    assert.equal(list.status, 200);
    const read = await call(h.api, 'GET', '/api/agents/b1/messages', { capability: undefined });
    assert.equal(read.status, 200);
    const rev = await call(h.api, 'POST', '/api/agents/b1/revive', { capability: undefined, body: {} });
    assert.equal(rev.status, 200);
    // Revive by the global bearer DOES audit (the revive route audits every attempt,
    // incl. the trusted path, with actorLane 'global-bearer'); list/read do not.
    assert.equal(h.rec.audits.length, 1, 'only the revive route audits the trusted path');
    assert.equal(h.rec.audits[0].operation, 'revive');
    assert.equal(h.rec.audits[0].actorLane, 'global-bearer');
    assert.equal(h.rec.audits[0].actorAgentId ?? null, null);
  } finally { h.cleanup(); }
});

// ══ Part B — the consolidated security matrix ══════════════════════════════════
//
// Each row states one (operation, actor, target) cell and its expected outcome:
// HTTP status, whether the cross_workspace_audit ledger got a row, and (when
// audited) the outcome string. `null` audit = the row must NOT be recorded.

type Lane = CapabilityClaim['privilegeLane'];
type Actor = 'bearer' | Lane;
interface MatrixRow {
  op: 'list' | 'read' | 'send' | 'launch' | 'revive';
  actor: Actor;
  target: 'own' | 'foreign';
  status: number;
  audit: string | null;       // expected outcome, or null for "not audited"
}

const OWN = WS_A;
const FOREIGN = WS_B;
const ownAgent = 'a1';        // in WS_A
const foreignAgent = 'b1';    // in WS_B

function capOf(actor: Actor): CapabilityClaim | undefined {
  return actor === 'bearer' ? undefined : claim(actor as Lane, WS_A);
}

async function runCell(api: ApiServer, row: MatrixRow): Promise<RouteResult> {
  const cap = capOf(row.actor);
  const wsId = row.target === 'own' ? OWN : FOREIGN;
  const agentId = row.target === 'own' ? ownAgent : foreignAgent;
  switch (row.op) {
    case 'list':   return call(api, 'GET', `/api/agents?workspaceId=${wsId}`, { capability: cap });
    case 'read':   return call(api, 'GET', `/api/agents/${agentId}/messages`, { capability: cap });
    case 'send':   return call(api, 'POST', `/api/agents/${agentId}/input`, { capability: cap, body: { text: 'ping', confirm: true } });
    case 'revive': return call(api, 'POST', `/api/agents/${agentId}/revive`, { capability: cap, body: {} });
    case 'launch': return call(api, 'POST', '/api/agents', { capability: cap, body: { title: 'Peer', mode: 'supervisor-peer', workspaceId: wsId } });
  }
}

// The declarative matrix. Reasoning per family:
//  - list/read/send: own = allowed & unaudited for every actor; foreign = allowed
//    for supervisor (audited ok) + bearer (unaudited), denied for worker/researcher
//    (audited denial). list denials use cross-workspace-requires-supervisor; read/
//    send denials use cross-workspace-target-forbidden.
//  - launch (supervisor-peer): a peer supervisor is a launch-class privilege, so a
//    capability-bearing non-supervisor is refused even in its OWN workspace
//    (audited). supervisor own = ok unaudited; supervisor foreign = ok audited;
//    bearer = ok unaudited.
//  - revive: supervisor-only even same-workspace. own worker/researcher = denied
//    (requires-supervisor); foreign worker/researcher = denied at the target gate
//    (target-forbidden). supervisor own = ok (audited — the revive route audits
//    every attempt); supervisor foreign = ok audited; bearer = ok audited.
const MATRIX: MatrixRow[] = [
  // list
  { op: 'list', actor: 'bearer',     target: 'own',     status: 200, audit: null },
  { op: 'list', actor: 'supervisor', target: 'own',     status: 200, audit: null },
  { op: 'list', actor: 'worker',     target: 'own',     status: 200, audit: null },
  { op: 'list', actor: 'researcher', target: 'own',     status: 200, audit: null },
  { op: 'list', actor: 'bearer',     target: 'foreign', status: 200, audit: null },
  { op: 'list', actor: 'supervisor', target: 'foreign', status: 200, audit: 'ok' },
  { op: 'list', actor: 'worker',     target: 'foreign', status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  { op: 'list', actor: 'researcher', target: 'foreign', status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  // read
  { op: 'read', actor: 'bearer',     target: 'own',     status: 200, audit: null },
  { op: 'read', actor: 'supervisor', target: 'own',     status: 200, audit: null },
  { op: 'read', actor: 'worker',     target: 'own',     status: 200, audit: null },
  { op: 'read', actor: 'researcher', target: 'own',     status: 200, audit: null },
  { op: 'read', actor: 'bearer',     target: 'foreign', status: 200, audit: null },
  { op: 'read', actor: 'supervisor', target: 'foreign', status: 200, audit: 'ok' },
  { op: 'read', actor: 'worker',     target: 'foreign', status: 403, audit: 'denied:cross-workspace-target-forbidden' },
  { op: 'read', actor: 'researcher', target: 'foreign', status: 403, audit: 'denied:cross-workspace-target-forbidden' },
  // send
  { op: 'send', actor: 'bearer',     target: 'own',     status: 200, audit: null },
  { op: 'send', actor: 'supervisor', target: 'own',     status: 200, audit: null },
  { op: 'send', actor: 'worker',     target: 'own',     status: 200, audit: null },
  { op: 'send', actor: 'researcher', target: 'own',     status: 200, audit: null },
  { op: 'send', actor: 'bearer',     target: 'foreign', status: 200, audit: null },
  { op: 'send', actor: 'supervisor', target: 'foreign', status: 200, audit: 'ok' },
  { op: 'send', actor: 'worker',     target: 'foreign', status: 403, audit: 'denied:cross-workspace-target-forbidden' },
  { op: 'send', actor: 'researcher', target: 'foreign', status: 403, audit: 'denied:cross-workspace-target-forbidden' },
  // launch (supervisor-peer)
  { op: 'launch', actor: 'bearer',     target: 'own',     status: 200, audit: null },
  { op: 'launch', actor: 'supervisor', target: 'own',     status: 200, audit: null },
  { op: 'launch', actor: 'worker',     target: 'own',     status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  { op: 'launch', actor: 'researcher', target: 'own',     status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  { op: 'launch', actor: 'bearer',     target: 'foreign', status: 200, audit: null },
  { op: 'launch', actor: 'supervisor', target: 'foreign', status: 200, audit: 'ok' },
  { op: 'launch', actor: 'worker',     target: 'foreign', status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  { op: 'launch', actor: 'researcher', target: 'foreign', status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  // revive (supervisor-only even same-workspace)
  { op: 'revive', actor: 'bearer',     target: 'own',     status: 200, audit: 'ok' },
  { op: 'revive', actor: 'supervisor', target: 'own',     status: 200, audit: 'ok' },
  { op: 'revive', actor: 'worker',     target: 'own',     status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  { op: 'revive', actor: 'researcher', target: 'own',     status: 403, audit: 'denied:cross-workspace-requires-supervisor' },
  { op: 'revive', actor: 'bearer',     target: 'foreign', status: 200, audit: 'ok' },
  { op: 'revive', actor: 'supervisor', target: 'foreign', status: 200, audit: 'ok' },
  { op: 'revive', actor: 'worker',     target: 'foreign', status: 403, audit: 'denied:cross-workspace-target-forbidden' },
  { op: 'revive', actor: 'researcher', target: 'foreign', status: 403, audit: 'denied:cross-workspace-target-forbidden' },
];

for (const row of MATRIX) {
  test(`B. matrix: ${row.op} · ${row.actor} · ${row.target} → ${row.status}${row.audit ? ` (${row.audit})` : ' (no audit)'}`, async () => {
    const h = makeApi();
    try {
      const res = await runCell(h.api, row);
      assert.equal(res.status, row.status,
        `${row.op}/${row.actor}/${row.target}: expected ${row.status}, got ${res.status} ${JSON.stringify(res.body)}`);
      if (row.audit === null) {
        assert.equal(h.rec.audits.length, 0,
          `${row.op}/${row.actor}/${row.target} must not be audited; got ${JSON.stringify(h.rec.audits)}`);
      } else {
        assert.equal(h.rec.audits.length, 1,
          `${row.op}/${row.actor}/${row.target} must record exactly one audit row`);
        assert.equal(h.rec.audits[0].operation, row.op === 'list' ? 'list_agents' : row.op === 'read' ? 'read_agent' : row.op === 'send' ? 'send_message' : row.op);
        assert.equal(h.rec.audits[0].outcome, row.audit,
          `${row.op}/${row.actor}/${row.target} outcome`);
      }
    } finally { h.cleanup(); }
  });
}

// ══ Part C — credential rows: no launched agent of any lane holds the bearer ════
//
// Real AgentSupervisor, runner stubbed. Mirrors credential-propagation.test.ts;
// the exhaustive single-token propagation coverage lives there — these rows pin the
// WP6 matrix invariant ("no launched agent (any lane) ever holds getApiToken() in
// child env or MCP configs; mint failure fails closed") next to the matrix.

interface CapturedLaunch { args: string[]; env: Record<string, string> | undefined; }
let lastLaunch: CapturedLaunch | null = null;

function patchRunner(): () => void {
  const origLaunch = (WindowsRunner.prototype as { launch: unknown }).launch;
  (WindowsRunner.prototype as { launch: unknown }).launch = function (
    this: WindowsRunner,
    _cwd: string, _cmd: string, args: string[], _log: string, _direct: boolean,
    extraEnv?: Record<string, string>,
  ) {
    lastLaunch = { args, env: extraEnv };
    (this as unknown as { _pid: number; _alive: boolean })._pid = 4242;
    (this as unknown as { _pid: number; _alive: boolean })._alive = true;
  };
  return () => { (WindowsRunner.prototype as { launch: unknown }).launch = origLaunch; };
}

function patchDbForLaunch(workspacePath: string, created: Agent[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const keys = [
    'getWorkspace', 'createAgent', 'updateAgentStatus', 'applyStatusTransition', 'updateAgentPid',
    'getAgent', 'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent',
    'addFileActivity', 'updateAgentResumeSessionId', 'getTeamMembership',
    'getAgentTemplate', 'getFileActivities', 'insertAgentSession',
    'getCurrentBrick', 'getContinuationAttempt', 'incrementRestartCount',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  db.getWorkspace = (id: string) => ({ id, path: workspacePath, defaultCommand: 'claude' });
  db.createAgent = (input: Partial<Agent>) => { const a = makeRealAgent(`c-${created.length}`, input); created.push(a); return a; };
  db.updateAgentStatus = () => {};
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => created.find(a => a.id === id) ?? null;
  db.addEvent = () => {};
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => created;
  db.getAllAgents = () => created;
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = () => {};
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.getFileActivities = () => [];
  db.insertAgentSession = () => {};
  db.getCurrentBrick = () => null;
  db.getContinuationAttempt = () => null;
  db.incrementRestartCount = () => {};
  patchApplyStatusTransition(db);
  return () => { for (const k of keys) db[k] = orig[k]; };
}

function makeLaunchSupervisor(): AgentSupervisorClass {
  const s = new AgentSupervisorClass();
  const anyS = s as unknown as Record<string, unknown>;
  anyS.writeAgentRegistry = () => {};
  anyS.reclaimTerminalCheckpoint = () => {};
  anyS.ensureSpoolTailer = () => {};
  anyS.healLegacyStateDirScaffold = () => {};
  anyS.setupFileTracker = () => null;
  anyS.sweepStaleSyspromptFiles = () => {};
  anyS.buildContinuationBrickBlock = () => '';
  return s;
}

/** Every AGENT_DASHBOARD_API_TOKEN embedded in any inline --mcp-config JSON. */
function allMcpTokens(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--mcp-config') continue;
    let cfg: any;
    try { cfg = JSON.parse(args[i + 1]); } catch { continue; }
    const servers = cfg?.mcpServers ?? {};
    for (const name of Object.keys(servers)) {
      const tok = servers[name]?.env?.AGENT_DASHBOARD_API_TOKEN;
      if (typeof tok === 'string' && tok.length > 0) out.push(tok);
    }
  }
  return out;
}

async function withLaunchHarness(
  fn: (deps: { supervisor: AgentSupervisorClass; created: Agent[]; workspacePath: string }) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cwx-cred-'));
  const created: Agent[] = [];
  const restoreDb = patchDbForLaunch(workspacePath, created);
  const restoreRunner = patchRunner();
  agentCapabilities.clear();
  lastLaunch = null;
  try {
    await fn({ supervisor: makeLaunchSupervisor(), created, workspacePath });
  } finally {
    restoreRunner();
    restoreDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

function launchWin(s: AgentSupervisorClass, agent: Agent): Promise<void> {
  return (s as unknown as {
    launchWindowsAgent(a: Agent, resume: boolean, md: string | null, sid?: string, over?: string[], fresh?: boolean): Promise<void>;
  }).launchWindowsAgent(agent, false, null, 'sess-fresh', undefined, true);
}

const LANE_CASES: Array<{ lane: string; over: Partial<Agent> }> = [
  { lane: 'worker',     over: { isWorker: true, isSupervised: false, isSupervisor: false, isResearcher: false } },
  { lane: 'supervisor', over: { isWorker: false, isSupervised: false, isSupervisor: true, isResearcher: false } },
  { lane: 'researcher', over: { isWorker: false, isSupervised: false, isSupervisor: false, isResearcher: true } },
];

for (const { lane, over } of LANE_CASES) {
  test(`C. no ${lane}-lane launch ever carries getApiToken() in child env or any --mcp-config`, () =>
    withLaunchHarness(async ({ supervisor, created, workspacePath }) => {
      const agent = makeRealAgent(`${lane}-1`, {
        provider: 'claude', workspaceId: 'ws-own',
        workingDirectory: path.join(workspacePath, lane),
        logPath: path.join(workspacePath, `${lane}.log`),
        resumeSessionId: `sess-${lane}`,
        ...over,
      });
      created.push(agent);
      await launchWin(supervisor, agent);

      const bearer = getApiToken();
      const envToken = lastLaunch?.env?.AGENT_DASHBOARD_API_TOKEN;
      assert.ok(envToken, `${lane} child env must carry a minted token`);
      assert.notEqual(envToken, bearer, `${lane} child env must NEVER carry the global bearer`);
      for (const tok of allMcpTokens(lastLaunch!.args)) {
        assert.notEqual(tok, bearer, `${lane} --mcp-config must NEVER carry the global bearer`);
      }
      // The minted token resolves to THIS lane, scoped to its own workspace.
      const resolved = agentCapabilities.resolve(envToken!);
      assert.equal(resolved?.privilegeLane, lane, `${lane} token resolves to the ${lane} lane`);
      assert.equal(resolved?.workspaceId, 'ws-own');
    }));
}

test('C. mint failure fails CLOSED — the launch aborts, runner.launch is never reached, no bearer leaks', () =>
  withLaunchHarness(async ({ supervisor, created, workspacePath }) => {
    const agent = makeRealAgent('fc-1', {
      provider: 'claude', isWorker: true, isSupervised: false, workspaceId: 'ws-own',
      workingDirectory: path.join(workspacePath, 'fc'), logPath: path.join(workspacePath, 'fc.log'),
      resumeSessionId: 'sess-fc',
    });
    created.push(agent);
    const origMint = agentCapabilities.mint.bind(agentCapabilities);
    (agentCapabilities as unknown as { mint: unknown }).mint = () => { throw new Error('boom: store unavailable'); };
    try {
      await assert.rejects(launchWin(supervisor, agent), /capability mint failed/,
        'a mint failure must abort the launch, never fall back to the bearer');
      assert.equal(lastLaunch, null, 'the launch never reached runner.launch');
    } finally { (agentCapabilities as unknown as { mint: unknown }).mint = origMint; }
  }));

// ── Runner ──────────────────────────────────────────────────────────────────────
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
