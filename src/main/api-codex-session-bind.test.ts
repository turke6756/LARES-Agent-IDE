// Layer A — POST /api/agents/:id/codex-session bind-endpoint acceptance tests.
//
// The codex SessionStart hook carries codex's own session_id and is routed to
// THIS agent by its AGENT_ID launcher env, so the bind is env-direct and
// race-free even under the shared-cwd invariant (many codex agents, one cwd).
// This endpoint is the dedicated authed surface that maps the supervisor's
// bind DECISION to HTTP. These tests drive the REAL route + the REAL
// `decideCodexHookBind` decision (via a stub supervisor that mirrors
// index.ts's `bindCodexSessionFromHook` wiring against an in-memory registry),
// so both the HTTP status mapping AND the null-guard ordering are exercised
// end-to-end over HTTP.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-codex-session-bind.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import { decideCodexHookBind } from './supervisor/session-id-discovery';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

const SESSION_ID = '33333333-4444-5555-6666-777777777777';
const OTHER_ID = '44444444-5555-6666-7777-888888888888';

interface RegAgent { id: string; provider: string; resumeSessionId: string | null; }

// In-memory agent registry backing the stub supervisor. Reset per test.
let registry: Map<string, RegAgent>;

// Mirror of index.ts `bindCodexSessionFromHook`: resolve sibling-ownership
// against the registry, run the REAL decision helper, and (on bind only) apply
// the sid. The internal side effects the real method also performs
// (rebindAgent, releaseCodexLaunchGate) are not observable through this
// endpoint, so the stub omits them — the endpoint contract under test is the
// decision→HTTP mapping and the persisted-sid null-guard.
const stubSupervisor = {
  bindCodexSessionFromHook(agentId: string, sessionId: string | null | undefined) {
    const agent = registry.get(agentId) ?? null;
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    let sessionOwnedByOther = false;
    if (sid && agent) {
      for (const other of registry.values()) {
        if (other.id !== agentId && other.resumeSessionId === sid) { sessionOwnedByOther = true; break; }
      }
    }
    const decision = decideCodexHookBind({ agent, sessionId, sessionOwnedByOther });
    if (decision.action === 'bind') {
      const a = registry.get(agentId);
      if (a) a.resumeSessionId = decision.sessionId;
    }
    return decision;
  },
} as unknown as AgentSupervisor;

// ── HTTP helpers ─────────────────────────────────────────────────────────────

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; }

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
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
const JSON_AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

function bind(port: number, agentId: string, sessionId: unknown): Promise<Res> {
  return request(port, 'POST', `/api/agents/${agentId}/codex-session`, JSON_AUTH, JSON.stringify({ sessionId }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('happy path — unbound codex agent binds the reported sid (200, bound:true, persisted)', () => {
  registry = new Map([['a-codex', { id: 'a-codex', provider: 'codex', resumeSessionId: null }]]);
  return withServer(async (port) => {
    const res = await bind(port, 'a-codex', SESSION_ID);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.bound, true);
    assert.equal(body.sessionId, SESSION_ID);
    assert.equal(registry.get('a-codex')!.resumeSessionId, SESSION_ID, 'sid persisted to the registry');
  });
});

test('unknown agent → 404 (report for a since-gone agent)', () => {
  registry = new Map();
  return withServer(async (port) => {
    const res = await bind(port, 'ghost', SESSION_ID);
    assert.equal(res.status, 404);
  });
});

test('non-codex agent → 409 (only codex mints late ids)', () => {
  registry = new Map([['a-claude', { id: 'a-claude', provider: 'claude', resumeSessionId: null }]]);
  return withServer(async (port) => {
    const res = await bind(port, 'a-claude', SESSION_ID);
    assert.equal(res.status, 409);
    assert.equal(registry.get('a-claude')!.resumeSessionId, null, 'no sid applied to a non-codex agent');
  });
});

test('null-guard ordering — a later restart\'s resumeSessionId is NOT overwritten by a stale bind (200, bound:false, unchanged)', () => {
  // The agent already carries OTHER_ID (e.g. a later restart/resume owns it).
  // A stale SessionStart-hook report for the OLD sid must be an idempotent
  // no-op, never a clobber — this is the ordering that keeps BUG-29 closed.
  registry = new Map([['a-codex', { id: 'a-codex', provider: 'codex', resumeSessionId: OTHER_ID }]]);
  return withServer(async (port) => {
    const res = await bind(port, 'a-codex', SESSION_ID);
    assert.equal(res.status, 200, 'already-bound is an idempotent no-op, not an error');
    const body = JSON.parse(res.body);
    assert.equal(body.bound, false);
    assert.equal(body.reason, 'already-bound');
    assert.equal(registry.get('a-codex')!.resumeSessionId, OTHER_ID, 'the persisted sid MUST survive the stale bind');
  });
});

test('empty / whitespace sid → 400 (nothing to bind)', () => {
  registry = new Map([['a-codex', { id: 'a-codex', provider: 'codex', resumeSessionId: null }]]);
  return withServer(async (port) => {
    for (const sid of ['', '   ']) {
      const res = await bind(port, 'a-codex', sid);
      assert.equal(res.status, 400, `empty sid ${JSON.stringify(sid)} → 400`);
    }
    assert.equal(registry.get('a-codex')!.resumeSessionId, null);
  });
});

test('sibling-theft protection — sid already owned by another agent → 409, not applied', () => {
  registry = new Map([
    ['a-codex', { id: 'a-codex', provider: 'codex', resumeSessionId: null }],
    ['b-codex', { id: 'b-codex', provider: 'codex', resumeSessionId: SESSION_ID }],
  ]);
  return withServer(async (port) => {
    const res = await bind(port, 'a-codex', SESSION_ID);
    assert.equal(res.status, 409);
    assert.equal(registry.get('a-codex')!.resumeSessionId, null, 'sibling-owned sid must not be stolen');
  });
});

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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
