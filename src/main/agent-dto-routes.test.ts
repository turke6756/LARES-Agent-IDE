// agent-dto-routes.test — WP7 §7 test 29 (route half): a non-GET to any of the
// read-only context-optimizer surfaces returns 405 BEFORE any DB/analyze work runs.
// Real HTTP against an ApiServer with `./database` stubbed (mirrors api-server-focus).
//   npm run build:main
//   node dist/main/main/agent-dto-routes.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const stubSupervisor = {
  getContextStats: () => null, isInputInFlight: () => false, emit: () => false,
} as unknown as AgentSupervisor;

interface Res { status: number; body: string; }
function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try { await fn(port); } finally { server.stop(); }
}

const AUTH = { Authorization: `Bearer ${getApiToken()}` };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

// The GET-only read-only surfaces (worker #1's three + worker #2's three).
const READ_ONLY_PATHS = [
  '/api/context-optimizer/proposals',
  '/api/context-optimizer/proposals/some-id',
  '/api/context-optimizer/file-heat',
  '/api/context-optimizer/skill-usage',
  '/api/context-optimizer/skill-usage/alpha',
  '/api/context-optimizer/mcp-tool-usage',
  '/api/context-optimizer/agent-knowledge',
  '/api/context-optimizer/agent-knowledge/node-1',
  '/api/context-optimizer/improvement-proposals',
  '/api/context-optimizer/improvement-proposals/some-id',
];

// POST/PUT/PATCH reach the route dispatcher and hit the read-only guard → 405 (test 29).
// (DELETE is rejected even earlier by the server's outer method handling — 400 — so it
//  never reaches this block; it is not part of the "mutate a GET route" contract here.)
for (const method of ['POST', 'PUT', 'PATCH']) {
  test(`${method} to every read-only optimizer path → 405`, () =>
    withServer(async (port) => {
      for (const p of READ_ONLY_PATHS) {
        const res = await request(port, method, p, JSON_AUTH, '{}');
        assert.equal(res.status, 405, `${method} ${p} expected 405, got ${res.status}`);
      }
    }));
}

// A read-only method that this surface does NOT implement is still not a 405 (the 405 is
// specifically the "you tried to mutate a read-only route" signal, not a catch-all).
test('POST to an unrelated path is not swallowed as a 405 by this block', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/context-optimizer/not-a-real-route', JSON_AUTH, '{}');
    assert.notEqual(res.status, 405, 'the 405 guard must be scoped to the matched read-only paths only');
  }));

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok - ${t.name}`); }
    catch (e) { failed += 1; console.error(`  FAIL - ${t.name}\n`, e); }
  }
  console.log(`\nagent-dto-routes: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
