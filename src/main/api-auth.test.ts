// WP0.4 (plans/embedded-browser-implementation-tasks.md) — M1 + M8 admission
// tests for the dashboard HTTP API: bearer-token gate (401 fail-closed),
// origin-allowlist CORS (403 / per-origin echo, never `*`), OPTIONS preflight,
// and the bound-port contract (port 0 ephemeral binds + EADDRINUSE retry).
// Maps to safety-spec §5 acceptance tests #1, #2 (worker half), #3 (worker half).
//
// The server binds 127.0.0.1 here (constructor bindHost) — the production
// default stays 0.0.0.0 because WSL agents reach the API via the Windows
// gateway IP; the token, not the bind scope, is the gate (WP0.1 decision).
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-auth.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken, isAuthorized, decideApiAccess } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Pure decision-function tests ────────────────────────────────────────────

test('isAuthorized: missing / wrong-scheme / wrong-token all fail closed', () => {
  assert.equal(isAuthorized(undefined, 'tok'), false);
  assert.equal(isAuthorized('', 'tok'), false);
  assert.equal(isAuthorized('Token tok', 'tok'), false);
  assert.equal(isAuthorized('Bearer wrong', 'tok'), false);
  assert.equal(isAuthorized('Bearer tokk', 'tok'), false); // length mismatch
  assert.equal(isAuthorized('Bearer tok', 'tok'), true);
});

test('decideApiAccess: order is preflight → origin → bearer', () => {
  // Disallowed origin loses even with a valid token.
  assert.equal(decideApiAccess('POST', 'https://evil.example', 'Bearer t', 't').kind, 'forbidden-origin');
  // Disallowed origin does not even get a preflight.
  assert.equal(decideApiAccess('OPTIONS', 'https://evil.example', undefined, 't').kind, 'forbidden-origin');
  // Allowed origin without a token → unauthorized, with the CORS echo so the
  // browser can read the 401 body.
  const unauth = decideApiAccess('GET', 'null', undefined, 't');
  assert.equal(unauth.kind, 'unauthorized');
  assert.equal((unauth as { corsOrigin?: string }).corsOrigin, 'null');
  // Headless client (no Origin) with the right token → ok, no CORS echo.
  const ok = decideApiAccess('GET', undefined, 'Bearer t', 't');
  assert.equal(ok.kind, 'ok');
  assert.equal((ok as { corsOrigin?: string }).corsOrigin, undefined);
});

// ── HTTP-level tests against a real ApiServer ───────────────────────────────

// GET /api/agents touches the database module — patch it to a fixed empty
// list so no real sqlite file is needed (same pattern as agent-supervisor.test).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, unknown>;
db.getAllAgents = () => [];
db.getAgentsByWorkspace = () => [];

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
} as unknown as AgentSupervisor;

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; }

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent:false → no keep-alive sockets pinning the server open after close()
      { hostname: '127.0.0.1', port, path, method, headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn: (port: number, server: ApiServer) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    await fn(port, server);
  } finally {
    server.stop();
  }
}

const TOKEN = getApiToken(); // same module instance the server gates with

test('port 0 → start() resolves a real ephemeral port; getPort() agrees', () =>
  withServer(async (port, server) => {
    assert.ok(Number.isInteger(port) && port > 0, `expected real port, got ${port}`);
    assert.equal(server.getPort(), port);
  }));

test('no Authorization → 401, fail closed', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/agents', {});
    assert.equal(res.status, 401);
  }));

test('wrong token → 401', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', { Authorization: 'Bearer not-the-token' });
    assert.equal(res.status, 401);
  }));

test('valid token, no Origin (headless proxy) → 200, no CORS headers', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', { Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }));

test("valid token + Origin 'null' (file:// renderer) → 200, per-origin echo", () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', {
      Authorization: `Bearer ${TOKEN}`, Origin: 'null',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'null');
    assert.equal(res.headers['vary'], 'Origin');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  }));

test('valid token + Origin http://localhost:5173 (Vite dev) → 200, echo (never *)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', {
      Authorization: `Bearer ${TOKEN}`, Origin: 'http://localhost:5173',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  }));

test('valid token + disallowed Origin → 403 (origin gate beats the token)', () =>
  withServer(async (port) => {
    const res = await request(port, 'GET', '/api/agents', {
      Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example',
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }));

test('no token + disallowed Origin → 403 (not 401: origin checked first)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/agents', { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  }));

test('OPTIONS preflight, allowed origin, no auth → 204 with Authorization advertised', () =>
  withServer(async (port) => {
    const res = await request(port, 'OPTIONS', '/api/agents', { Origin: 'http://localhost:5173' });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.match(String(res.headers['access-control-allow-headers']), /Authorization/);
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  }));

test('OPTIONS preflight, disallowed origin → 403', () =>
  withServer(async (port) => {
    const res = await request(port, 'OPTIONS', '/api/agents', { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  }));

test('EADDRINUSE → start() resolves the incremented port, not the stale one', () =>
  withServer(async (portA) => {
    const serverB = new ApiServer(stubSupervisor, portA, undefined, '127.0.0.1');
    const portB = await serverB.start();
    try {
      assert.equal(portB, portA + 1);
      assert.equal(serverB.getPort(), portB);
      // And the retried server actually serves (gate included):
      const res = await request(portB, 'GET', '/api/agents', { Authorization: `Bearer ${TOKEN}` });
      assert.equal(res.status, 200);
    } finally {
      serverB.stop();
    }
  }));

// ── Run ────────────────────────────────────────────────────────────────────

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
  console.log(`\nAll ${tests.length} api-auth tests passed`);
})();
