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
import { toCheckpointSummary } from './git-checkpoints/engine-bootstrap';
import type { TurnRecord } from './database';

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
        beforeRawFilterBypassed: false,
      }];
    },
    fileHistory: async (workspaceId, filePath, opts) => {
      rec('fileHistory', [workspaceId, filePath, opts]);
      return [{
        turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
        status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
        beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPath: filePath, op: 'write',
        afterVerified: true, beforeRawFilterBypassed: false,
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
      ['GET', '/api/checkpoints/file-history?path=a.txt'],
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

// ── 10. Prune is capability-bound; unwired backend still 501s, wired one forwards ─

test('prune requires a supervisor capability first, THEN 501s when no prune backend is wired', () =>
  withServer(async (port) => {
    // Global bearer still rejected (auth precedes the availability check).
    const bad = await request(port, 'POST', '/api/checkpoints/prune', { Authorization: `Bearer ${GLOBAL_BEARER}` }, {});
    assert.equal(bad.status, 403);
    assert.equal(parse(bad).code, 'checkpoint-requires-capability');
    // Authorized supervisor, but the default fake omits `prune` → 501 (engine predates backend).
    const ok = await request(port, 'POST', '/api/checkpoints/prune', { Authorization: bearerFor('supervisor', 'sup-A') }, {});
    assert.equal(ok.status, 501);
    assert.equal(parse(ok).code, 'checkpoint-prune-unavailable');
  }));

test('WP-G3.5: a wired prune forwards the claim workspace + agent and returns the count', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/prune', { Authorization: bearerFor('supervisor', 'sup-A', WS) }, {});
    assert.equal(res.status, 200);
    const body = parse(res);
    assert.equal(body.workspaceId, WS, 'scoped to the claim workspace');
    assert.equal(body.deletedRefs, 3);
  }, {
    routes: makeFakeRoutes({
      // The route forwards the (already-authorized) claim workspace + agent, never a
      // caller-chosen scope; the backend reports the atomic-batch deleted-ref count.
      prune: async ({ workspaceId, agentId }) => {
        assert.equal(workspaceId, WS);
        assert.equal(agentId, 'sup-A');
        return { workspaceId, deletedRefs: 3 };
      },
    }),
  }));

test('WP-G3.5: prune is workspace-scoped — a mismatched ?workspaceId= is rejected before the backend', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/checkpoints/prune?workspaceId=other-ws', {
      Authorization: bearerFor('supervisor', 'sup-A', WS),
    }, {});
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-workspace-mismatch');
  }, {
    routes: makeFakeRoutes({
      prune: async () => { throw new Error('backend must not run on a scope mismatch'); },
    }),
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

// ── 12. beforeRawFilterBypassed flows TurnRecord → summary → HTTP wire ───────────
// The CONTENT-semantics diagnostic is dropped by neither the adapter nor the route:
// RestoreDialog's filter-managed warning is dormant unless the whole chain carries it.

function makeTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 't1', workspaceId: WS, turnSeq: 1, agentId: 'a1', agentTitle: 'A',
    ownerAgentId: null, ownerBrickGeneration: null, sessionId: null, taskLabel: 'task',
    startedAt: 1, endedAt: 2, status: 'accepted',
    beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
    beforeReady: true, afterReady: true, beforeQuality: 'guaranteed', afterQuality: 'hook',
    beforeRawFilterBypassed: false, beforeFilteredPaths: null, beforePrunedAt: null, afterPrunedAt: null,
    touched: [{ path: 'a.txt', op: 'write' }], diffStats: null, compactDiff: null,
    compactDiffProvenance: null, failureReason: null,
    ...overrides,
  };
}

test('adapter maps beforeRawFilterBypassed=true from the turn record into the summary', () => {
  const summary = toCheckpointSummary(makeTurnRecord({ beforeRawFilterBypassed: true }));
  assert.equal(summary.beforeRawFilterBypassed, true);
  // sanity: witnessed paths still derive from touched write/create entries.
  assert.deepEqual(summary.witnessedPaths, ['a.txt']);
});

test('adapter maps beforeRawFilterBypassed=false from the turn record into the summary', () => {
  const summary = toCheckpointSummary(makeTurnRecord({ beforeRawFilterBypassed: false }));
  assert.equal(summary.beforeRawFilterBypassed, false);
});

test('list route carries beforeRawFilterBypassed=true onto the HTTP wire', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', { Authorization: bearerFor('supervisor', 'sup-A') });
    assert.equal(res.status, 200);
    assert.equal(parse(res).turns[0].beforeRawFilterBypassed, true);
  }, {
    routes: makeFakeRoutes({
      list: () => [{
        turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
        status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
        beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['a.txt'], failureReason: null,
        beforeRawFilterBypassed: true,
      }],
    }),
  }));

test('list route carries beforeRawFilterBypassed=false onto the HTTP wire (warning dormant)', () =>
  withServer(async (port) => {
    // The default fake summary sets the flag false.
    const res = await request(port, 'GET', '/api/checkpoints', { Authorization: bearerFor('supervisor', 'sup-A') });
    assert.equal(res.status, 200);
    assert.equal(parse(res).turns[0].beforeRawFilterBypassed, false);
  }));

// ── 13. WP-G3.1 file-history route — capability-bound + shape ─────────────────────

test('file-history: a minted worker credential is refused (supervisor-tier)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints/file-history?path=a.txt', {
      Authorization: bearerFor('worker', 'worker-1'),
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-requires-supervisor');
  }));

test('file-history: a supervisor asserting ANOTHER agent id is rejected', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints/file-history?path=a.txt', {
      Authorization: bearerFor('supervisor', 'sup-A'),
      'X-Supervisor-Id': 'sup-B',
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-identity-mismatch');
  }));

test('file-history: a mismatched ?workspaceId= is outside the claim scope (403)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints/file-history?path=a.txt&workspaceId=other-ws', {
      Authorization: bearerFor('supervisor', 'sup-A', WS),
    });
    assert.equal(res.status, 403);
    assert.equal(parse(res).code, 'checkpoint-workspace-mismatch');
  }));

test('file-history: a supervisor gets versions scoped to the claim workspace + path', () =>
  withServer(async (port) => {
    const routes = makeFakeRoutes();
    const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
    server.setCheckpointRoutes(routes);
    const p = await server.start();
    try {
      const res = await request(p, 'GET', '/api/checkpoints/file-history?path=src/a.txt', {
        Authorization: bearerFor('supervisor', 'sup-A', WS),
      });
      assert.equal(res.status, 200);
      const body = parse(res);
      assert.equal(body.workspaceId, WS);
      assert.equal(body.path, 'src/a.txt');
      assert.equal(body.versions.length, 1);
      assert.equal(body.versions[0].witnessedPath, 'src/a.txt');
      const call = routes.state.calls.find((c) => c.method === 'fileHistory');
      assert.ok(call, 'fileHistory must be called');
      assert.equal(call!.args[0], WS, 'scoped to the claim workspace');
      assert.equal(call!.args[1], 'src/a.txt', 'the canonical path is forwarded');
    } finally {
      server.stop();
    }
  }));

test('file-history without a `path` query → 400', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints/file-history', {
      Authorization: bearerFor('supervisor', 'sup-A'),
    });
    assert.equal(res.status, 400);
    assert.equal(parse(res).code, 'checkpoint-bad-request');
  }));

// ── 14. WP4 list filters — parsing, validation, `file` normalization, threading ──
// The workspace root the route normalizes `file` against is the DB stub's `/tmp/ws`.

/** Run one authorized GET /api/checkpoints and return {status, body, listOpts}. */
async function listWith(query: string): Promise<{ status: number; body: any; opts: any }> {
  const routes = makeFakeRoutes();
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  server.setCheckpointRoutes(routes);
  const p = await server.start();
  try {
    const res = await request(p, 'GET', `/api/checkpoints${query}`, { Authorization: bearerFor('supervisor', 'sup-A', WS) });
    let body: any = null;
    try { body = JSON.parse(res.body); } catch { /* non-JSON */ }
    const call = routes.state.calls.find((c) => c.method === 'list');
    return { status: res.status, body, opts: call ? call.args[1] : undefined };
  } finally {
    server.stop();
  }
}

test('WP4: no filters → list is threaded an opts object (default limit resolved in the DB)', async () => {
  const { status, opts } = await listWith('');
  assert.equal(status, 200);
  assert.ok(opts && typeof opts === 'object', 'route always threads an opts object');
  assert.equal(opts.limit, undefined, 'no limit param → undefined (DB defaults 50), never a silent clamp value');
});

test('WP4: since / sinceTime / limit are parsed and threaded', async () => {
  const { status, opts } = await listWith('?since=7&sinceTime=1500&limit=25&agentId=a1');
  assert.equal(status, 200);
  assert.equal(opts.since, 7);
  assert.equal(opts.sinceTime, 1500);
  assert.equal(opts.limit, 25);
  assert.equal(opts.agentId, 'a1');
});

test('WP4: sinceTime accepts an ISO-8601 string → epoch-ms', async () => {
  const { status, opts } = await listWith('?sinceTime=2020-01-01T00:00:00.000Z');
  assert.equal(status, 200);
  assert.equal(opts.sinceTime, Date.parse('2020-01-01T00:00:00.000Z'));
});

test('WP4: `file` is normalized to workspace-relative POSIX (touched[] form) and threaded', async () => {
  const { status, opts } = await listWith('?file=src/a.txt');
  assert.equal(status, 200);
  assert.equal(opts.file, 'src/a.txt');
});

test('WP4: `file` with redundant segments is normalized', async () => {
  const { status, opts } = await listWith('?file=./src/../src/a.txt');
  assert.equal(status, 200);
  assert.equal(opts.file, 'src/a.txt');
});

test('WP4: URL-decoded `file` — an encoded valid path is accepted and normalized', async () => {
  const { status, opts } = await listWith('?file=src%2Fa.txt');
  assert.equal(status, 200);
  assert.equal(opts.file, 'src/a.txt');
});

test('WP4: URL-decoded `file` — an encoded ..-traversal is rejected (400)', async () => {
  const { status, body } = await listWith('?file=..%2F..%2Fetc%2Fpasswd');
  assert.equal(status, 400);
  assert.equal(body.code, 'checkpoint-bad-request');
});

test('WP4: an absolute out-of-workspace `file` is rejected (400)', async () => {
  const { status, body } = await listWith('?file=/etc/passwd');
  assert.equal(status, 400);
  assert.equal(body.code, 'checkpoint-bad-request');
});

test('WP4: an empty `file` is rejected (400)', async () => {
  const { status, body } = await listWith('?file=');
  assert.equal(status, 400);
  assert.equal(body.code, 'checkpoint-bad-request');
});

test('WP4: the limit validation matrix rejects 0, -1, 1.5, "abc", 201 (no silent clamp)', async () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '201']) {
    const { status, body } = await listWith(`?limit=${encodeURIComponent(bad)}`);
    assert.equal(status, 400, `limit=${bad} must 400`);
    assert.equal(body.code, 'checkpoint-bad-request', `limit=${bad} code`);
  }
  // The boundary values 1 and 200 ARE accepted.
  for (const ok of ['1', '200']) {
    const { status, opts } = await listWith(`?limit=${ok}`);
    assert.equal(status, 200, `limit=${ok} must be accepted`);
    assert.equal(opts.limit, Number(ok));
  }
});

test('WP4: an unparseable `since` is rejected (400)', async () => {
  const { status, body } = await listWith('?since=notanumber');
  assert.equal(status, 400);
  assert.equal(body.code, 'checkpoint-bad-request');
});

test('WP4: an unparseable `sinceTime` is rejected (400)', async () => {
  const { status, body } = await listWith('?sinceTime=not-a-date');
  assert.equal(status, 400);
  assert.equal(body.code, 'checkpoint-bad-request');
});

test('WP4: the ascending list contract is preserved (route does not reorder the engine rows)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/checkpoints', { Authorization: bearerFor('supervisor', 'sup-A', WS) });
    assert.equal(res.status, 200);
    const turns = parse(res).turns;
    const seqs = turns.map((t: any) => t.turnSeq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'turns stay ascending by turnSeq');
  }, {
    routes: makeFakeRoutes({
      list: () => [
        { turnId: 't1', turnSeq: 4, agentId: 'a1', agentTitle: 'A', taskLabel: null, status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true, beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['a.txt'], failureReason: null, beforeRawFilterBypassed: false },
        { turnId: 't2', turnSeq: 9, agentId: 'a1', agentTitle: 'A', taskLabel: null, status: 'accepted', startedAt: 3, endedAt: 4, beforeReady: true, afterReady: true, beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['b.txt'], failureReason: null, beforeRawFilterBypassed: false },
      ],
    }),
  }));

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
