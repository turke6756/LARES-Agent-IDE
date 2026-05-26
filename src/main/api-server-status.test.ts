// Tests for POST /api/agents/:id/status — Class IV worker hook endpoint.
// Covers the v3 contract: idle ↔ forceIdleFromHook, working ↔
// forceWorkingFromHook, anything else → HTTP 400.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-server-status.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import { makeAgent } from './supervisor/test-helpers/fake-bridge-deps';
import type { Agent } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

function patchDb(agents: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig = {
    getAgent: db.getAgent,
  };
  db.getAgent = (id: string) => agents.get(id) ?? null;
  return () => {
    db.getAgent = orig.getAgent;
  };
}

interface RouteResult {
  status: number;
  body: any;
}

async function callRoute(
  api: ApiServer,
  method: string,
  pathname: string,
  body?: any,
): Promise<RouteResult> {
  const url = new URL(pathname, 'http://localhost:24678');
  const req = new http.IncomingMessage(null as any);
  req.method = method;
  req.url = pathname;
  // Push the JSON body and end the stream so readBody resolves.
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage) => Promise<any>;
    }).route(method, url, req);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message } };
  }
}

function makeApi(opts: { agent: Agent }): {
  api: ApiServer;
  recorded: Array<{ method: string; agentId: string; source: string }>;
  cleanup: () => void;
} {
  const agents = new Map<string, Agent>([[opts.agent.id, opts.agent]]);
  const restoreDb = patchDb(agents);
  const recorded: Array<{ method: string; agentId: string; source: string }> = [];
  const fakeSupervisor = {
    forceIdleFromHook: (id: string, source: string) => {
      recorded.push({ method: 'forceIdleFromHook', agentId: id, source });
    },
    forceWorkingFromHook: (id: string, source: string) => {
      recorded.push({ method: 'forceWorkingFromHook', agentId: id, source });
    },
    isInputInFlight: () => false,
    getContextStats: () => null,
  } as unknown as AgentSupervisor;
  const api = new ApiServer(fakeSupervisor, 24678);
  return {
    api,
    recorded,
    cleanup: () => { restoreDb(); },
  };
}

test('POST /api/agents/:id/status with state="idle" calls forceIdleFromHook', async () => {
  const agent = makeAgent('a-1');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/status', {
      state: 'idle',
      source: 'hook-stop',
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.deepStrictEqual(h.recorded, [{
      method: 'forceIdleFromHook',
      agentId: 'a-1',
      source: 'hook-stop',
    }]);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with state="working" calls forceWorkingFromHook', async () => {
  const agent = makeAgent('a-2');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-2/status', {
      state: 'working',
      source: 'hook-start',
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.deepStrictEqual(h.recorded, [{
      method: 'forceWorkingFromHook',
      agentId: 'a-2',
      source: 'hook-start',
    }]);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with state="bogus" returns 400 and dispatches nothing', async () => {
  const agent = makeAgent('a-3');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-3/status', {
      state: 'bogus',
      source: 'whatever',
    });
    assert.equal(res.status, 400, `expected 400; got ${res.status}`);
    assert.equal(h.recorded.length, 0, 'no supervisor dispatch on rejected state');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with unknown agent returns 404', async () => {
  const agent = makeAgent('a-4');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/does-not-exist/status', {
      state: 'idle',
      source: 'hook-stop',
    });
    assert.equal(res.status, 404, `expected 404; got ${res.status}`);
    assert.equal(h.recorded.length, 0);
  } finally {
    h.cleanup();
  }
});

// ── Runner ───────────────────────────────────────────────────────────
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
