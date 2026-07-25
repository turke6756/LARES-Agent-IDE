// WP-G2.1 (plans/git-native-implementation-v2.md — "HTTP routes (capability-bound
// on ALL checkpoint routes)") — authorization tests for the `/api/checkpoints*`
// recovery surface, exercised over a REAL ApiServer (same harness shape as
// api-auth.test.ts).
//
// The load-bearing property: recovery is supervisor-tier and exposes local history
// + workspace bytes, so EVERY checkpoint route (read AND mutation) requires a minted
// per-agent capability token with SUPERVISOR privilege; the shared global bearer is
// rejected; an X-Supervisor-Id may only equal the caller's OWN claim.agentId; scope
// is the claim's workspace; and `force` is refused on every HTTP route.
//
// Build via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-server-checkpoints.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer, type CheckpointRoutes } from './api-server';
import { getApiToken } from './security/api-auth';
import { agentCapabilities } from './security/agent-capabilities';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── DB stub so resolveIdentity never throws on an asserted X-Workspace-Id ────────
// (Checkpoint auth is derived ENTIRELY from the capability claim, never from these
// header-attribution lookups — the stub just keeps the pre-route identity layer from
// 403-ing before our own gate runs.)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, unknown>;
db.getWorkspace = (id: string) => ({ id, title: 't', path: '/tmp/ws', pathType: 'windows' });
db.getSupervisorAgent = () => null;
db.getAllAgents = () => [];
db.getAgentsByWorkspace = () => [];

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
} as unknown as AgentSupervisor;

// ── a recording fake CheckpointRoutes ───────────────────────────────────────────

interface FakeState { calls: { method: string; args: unknown[] }[]; }

function makeFakeRoutes(overrides: Partial<CheckpointRoutes> = {}): CheckpointRoutes & { state: FakeState } {
  const state: FakeState = { calls: [] };
  const rec = (method: string, args: unknown[]): void => { state.calls.push({ method, args }); };
  const base: CheckpointRoutes = {
    list: (workspaceId, opts) => {
      rec('list', [workspaceId, opts]);
      return [{
        turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
        status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
        beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['a.txt'], failureReason: null,
      }];
    },
    diff: async (turnId, workspaceId) => {
      rec('diff', [turnId, workspaceId]);
      return {
        witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'W', provenance: 'witnessed' },
        window: { available: true, reason: null, label: 'unattributed changes in this window', text: 'R', provenance: 'raw-window' },
      };
    },
    preview: async (turnId, workspaceId, requestedPaths) => {
      rec('preview', [turnId, workspaceId, requestedPaths]);
      return {
        available: true, reason: null, turnId, witnessedSet: ['a.txt'],
        tokens: { 'a.txt': 'oid-current' }, validatedPaths: ['a.txt'], rejectedPaths: [], contention: [],
      };
    },
    restorePaths: async (args) => {
      rec('restorePaths', [args]);
      return {
        status: 'completed', operationId: 'op1', kind: 'restore_paths', preRef: 'r', preOid: 'o',
        requestedPaths: args.paths, completedPaths: args.paths, rejectedPaths: [], failures: [],
        contention: [], failureReason: null,
      };
    },
    revertTurn: async (args) => {
      rec('revertTurn', [args]);
      return {
        status: 'completed', operationId: 'op2', kind: 'revert_turn', preRef: 'r', preOid: 'o',
        requestedPaths: ['a.txt'], completedPaths: ['a.txt'], rejectedPaths: [], failures: [],
        contention: [], failureReason: null,
      };
    },
    ...overrides,
  };
  return Object.assign(base, { state });
}

// ── HTTP helper (supports a JSON body) ───────────────────────────────────────────

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; }

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { ...headers };
    if (payload !== undefined) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: h, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function withServer(
  fn: (port: number, server: ApiServer) => Promise<void>,
  opts: { routes?: CheckpointRoutes | null } = {},
): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  if (opts.routes !== null) server.setCheckpointRoutes(opts.routes ?? makeFakeRoutes());
  const port = await server.start();
  try {
    await fn(port, server);
  } finally {
    server.stop();
  }
}

const GLOBAL_BEARER = getApiToken();
const WS = 'ws1';

/** Mint a fresh capability token for a lane and return `Bearer <token>`. */
function bearerFor(lane: 'supervisor' | 'worker' | 'researcher', agentId: string, workspaceId = WS): string {
  const token = agentCapabilities.mint({ agentId, workspaceId, privilegeLane: lane });
  return `Bearer ${token}`;
}

function parse(res: Res): any { return JSON.parse(res.body); }

// ── 1. Global bearer rejected on ALL /api/checkpoints* ───────────────────────────

test('global bearer is rejected on every checkpoint route (read AND mutation)', () =>
  withServer(async (port) => {
    const auth = { Authorization: `Bearer ${GLOBAL_BEARER}` };
    const cases: [string, string, unknown?][] = [
      ['GET', '/api/checkpoints'],
      ['GET', '/api/checkpoints/t1/diff'],
      ['POST', '/api/checkpoints/t1/preview', {}],
      ['POST', '/api/checkpoints/t1/restore', { paths: ['a.txt'], previewTokens: { 'a.txt': 'x' } }],
      ['POST', '/api/checkpoints/t1/revert', {}],
      ['POST', '/api/checkpoints/prune', {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await request(port, method, path, auth, body);
      assert.equal(res.status, 403, `${method} ${path} must reject the global bearer`);
      assert.equal(parse(res).code, 'checkpoint-requires-capability', `${method} ${path} code`);
    }
  }));

// ── 2. Forged X-Supervisor-Id (real worker credential + real supervisor's id) ────

test('forged X-Supervisor-Id with a WORKER credential is rejected on a READ route (list)', () =>
  withServer(async (port) => {
    // A worker holds a valid minted credential and forges a real supervisor's id.
    const res = await request(port, 'GET', '/api/checkpoints', {
      Authorization: bearerFor('worker', 'worker-1'),
      'X-Supervisor-Id': 'real-supervisor-9',
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-requires-supervisor');
  }));

test('forged X-Supervisor-Id with a WORKER credential is rejected on a MUTATION route (restore)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/t1/restore', {
      Authorization: bearerFor('worker', 'worker-1'),
      'X-Supervisor-Id': 'real-supervisor-9',
    }, { paths: ['a.txt'], previewTokens: { 'a.txt': 'x' } });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-requires-supervisor');
  }));

test('forged X-Supervisor-Id with a WORKER credential is rejected on revert (mutation)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/t1/revert', {
      Authorization: bearerFor('worker', 'worker-1'),
      'X-Supervisor-Id': 'real-supervisor-9',
    }, {});
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-requires-supervisor');
  }));

// ── 3. Self-assertion only: a SUPERVISOR may not assert another agent's id ────────

test('a supervisor asserting ANOTHER agent id is rejected (may only assert yourself)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', {
      Authorization: bearerFor('supervisor', 'sup-A'),
      'X-Supervisor-Id': 'sup-B',
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-identity-mismatch');
  }));

test('a supervisor asserting ITS OWN id is admitted', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', {
      Authorization: bearerFor('supervisor', 'sup-A'),
      'X-Supervisor-Id': 'sup-A',
    });
    assert.equal(res.status, 200);
    assert.equal(parse(res).turns.length, 1);
  }));

// ── 4. Workspace scope is the claim's workspace ──────────────────────────────────

test('supervisor scoped to its claim workspace: mismatched ?workspaceId= is rejected', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints?workspaceId=other-ws', {
      Authorization: bearerFor('supervisor', 'sup-A', WS),
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-workspace-mismatch');
  }));

test('supervisor scoped to its claim workspace: mismatched X-Workspace-Id is rejected', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', {
      Authorization: bearerFor('supervisor', 'sup-A', WS),
      'X-Workspace-Id': 'other-ws',
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-workspace-mismatch');
  }));

test('list is scoped to the claim workspace (provider called with claim.workspaceId)', () =>
  withServer(async (port) => {
    const routes = makeFakeRoutes();
    const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
    server.setCheckpointRoutes(routes);
    const p = await server.start();
    try {
      const res = await request(p, 'GET', '/api/checkpoints', { Authorization: bearerFor('supervisor', 'sup-A', WS) });
      assert.equal(res.status, 200);
      assert.equal(parse(res).workspaceId, WS);
      const listCall = routes.state.calls.find((c) => c.method === 'list');
      assert.ok(listCall, 'list must be called');
      assert.equal(listCall!.args[0], WS, 'list must be scoped to the claim workspace');
    } finally {
      server.stop();
    }
  }));

// ── 5. A minted WORKER credential (no forged header) is still refused everywhere ──

test('a minted worker credential without any forged header is refused (supervisor-tier)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', { Authorization: bearerFor('worker', 'worker-1') });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-requires-supervisor');
  }));

// ── 6. Happy-path read/mutation with a supervisor capability ─────────────────────

test('supervisor capability: diff returns witnessed + separately-labeled raw window', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints/t1/diff', { Authorization: bearerFor('supervisor', 'sup-A') });
    assert.equal(res.status, 200);
    const body = parse(res);
    assert.equal(body.witnessed.provenance, 'witnessed');
    assert.equal(body.window.label, 'unattributed changes in this window');
  }));

test('supervisor capability: preview mints tokens; restore with tokens succeeds', () =>
  withServer(async (port) => {
    const auth = { Authorization: bearerFor('supervisor', 'sup-A') };
    const pv = await request(port, 'POST', '/api/checkpoints/t1/preview', auth, { paths: ['a.txt'] });
    assert.equal(pv.status, 200);
    const tokens = parse(pv).tokens;
    const rs = await request(port, 'POST', '/api/checkpoints/t1/restore', auth, { paths: ['a.txt'], previewTokens: tokens });
    assert.equal(rs.status, 200);
    assert.equal(parse(rs).status, 'completed');
  }));

test('supervisor capability: revert is admitted', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/t1/revert', { Authorization: bearerFor('supervisor', 'sup-A') }, {});
    assert.equal(res.status, 200);
    assert.equal(parse(res).status, 'completed');
  }));

// ── 7. Restore requires a valid preview token ────────────────────────────────────

test('restore without previewTokens → 400 (a valid preview token is required)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/t1/restore', { Authorization: bearerFor('supervisor', 'sup-A') }, { paths: ['a.txt'] });
    assert.equal(res.status, 400);
    assert.equal(parse(res).code, 'checkpoint-preview-token-required');
  }));

test('restore with an empty previewTokens map → 400', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/t1/restore', { Authorization: bearerFor('supervisor', 'sup-A') }, { paths: ['a.txt'], previewTokens: {} });
    assert.equal(res.status, 400);
    assert.equal(parse(res).code, 'checkpoint-preview-token-required');
  }));

// ── 8. Non-witnessed path rejected (server-side attribution enforcement) ─────────

test('a non-witnessed path is rejected by the restore route (surfaced from the engine)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/t1/restore', { Authorization: bearerFor('supervisor', 'sup-A') }, {
      paths: ['evil.txt'], previewTokens: { 'evil.txt': 'x' },
    });
    assert.equal(res.status, 200);
    const body = parse(res);
    assert.equal(body.status, 'failed');
    assert.equal(body.failureReason, 'non-witnessed-paths');
    assert.deepEqual(body.rejectedPaths, ['evil.txt']);
  }, {
    routes: makeFakeRoutes({
      restorePaths: async (args) => ({
        status: 'failed', operationId: '', kind: 'restore_paths', preRef: null, preOid: null,
        requestedPaths: args.paths, completedPaths: [], rejectedPaths: args.paths, failures: [],
        contention: [], failureReason: 'non-witnessed-paths',
      }),
    }),
  }));

// ── 9. No `force` accepted on any HTTP route ─────────────────────────────────────

test('`force` in the body is refused on every checkpoint mutation route', () =>
  withServer(async (port) => {
    const auth = { Authorization: bearerFor('supervisor', 'sup-A') };
    const cases: [string, string, unknown][] = [
      ['POST', '/api/checkpoints/t1/preview', { force: true }],
      ['POST', '/api/checkpoints/t1/restore', { paths: ['a.txt'], previewTokens: { 'a.txt': 'x' }, force: true }],
      ['POST', '/api/checkpoints/t1/revert', { force: true }],
      ['POST', '/api/checkpoints/prune', { force: true }],
    ];
    for (const [method, path, body] of cases) {
      const res = await request(port, method, path, auth, body);
      assert.equal(res.status, 400, `${path} must refuse force`);
      assert.equal(parse(res).code, 'checkpoint-force-forbidden', `${path} code`);
    }
  }));

// ── 10. Prune is a capability-bound mechanism, not-yet-available (WP-G3.5) ────────

test('prune requires a supervisor capability first, THEN reports not-yet-available', () =>
  withServer(async (port) => {
    // Global bearer still rejected (auth precedes the not-available check).
    const bad = await request(port, 'POST', '/api/checkpoints/prune', { Authorization: `Bearer ${GLOBAL_BEARER}` }, {});
    assert.equal(bad.status, 403);
    assert.equal(parse(bad).code, 'checkpoint-requires-capability');
    // Authorized supervisor → 501 not-yet-available (no prune backend wired).
    const ok = await request(port, 'POST', '/api/checkpoints/prune', { Authorization: bearerFor('supervisor', 'sup-A') }, {});
    assert.equal(ok.status, 501);
    assert.equal(parse(ok).code, 'checkpoint-prune-unavailable');
  }));

// ── 11. Auth precedes engine-availability: unwired engine still 403s the bearer ──

test('with the engine unwired, the global bearer is still rejected (auth before 503)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', { Authorization: `Bearer ${GLOBAL_BEARER}` });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-requires-capability');
  }, { routes: null }));

test('with the engine unwired, an AUTHORIZED supervisor gets 503 (feature off)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', { Authorization: bearerFor('supervisor', 'sup-A') });
    assert.equal(res.status, 503);
    assert.equal(parse(res).code, 'checkpoint-engine-unavailable');
  }, { routes: null }));

// ── Run ──────────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      agentCapabilities.clear();
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    } finally {
      agentCapabilities.clear();
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} api-server-checkpoints tests passed`);
})();
