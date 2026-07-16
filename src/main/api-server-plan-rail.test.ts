// Planning surface WP1 — launch-rail plan-binding tests for POST /api/agents
// (plans/planning-surface-master-implementation.md §3 WP1).
//
// Covers, via real HTTP against an ApiServer (the launch route's body
// normalization + plan validation are private — exercised through the route):
//   - unknown plan_id → 400, launchAgent never called (a plans row must exist).
//   - snake_case plan_id/plan_section normalized to camelCase on the launch input.
//   - camelCase planId/planSection passed through unchanged.
//   - the validated binding reaches launchAgent (→ frozen onto the agent row by
//     createAgent, unit-tested in database.test.ts).
//   - omitted / empty plan binding → no rejection (the rail is optional).
//
// Same stub-the-database-module pattern as api-identity.test.ts (the route
// resolves getPlan through the module object at call time).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-server-plan-rail.test.js

import assert from 'node:assert/strict';
import http from 'http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Database fixtures (patched module exports; routes resolve at call time) ──

// One known plan surface; every other id is "unknown".
const PLAN = { id: 'plan-1', workspaceId: 'ws-1', path: '.dashboard/plans/p.html' };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, unknown>;
db.getPlan = (id: string) => (id === PLAN.id ? PLAN : null);
// The launch route reads no other db helpers on the no-identity-header path used
// below; getAllAgents is only hit by GET, but stub it defensively.
db.getAllAgents = () => [];
// GT-C §O.2 — the launch route now applies the shared `assertPlanRailFree` guard
// after plan-existence validation. It consults these two helpers; with no live
// run / rail agent in this harness they return "free" so the launch proceeds.
db.listOrchestrationRuns = () => [];
db.getLiveRailAgentForPlan = () => null;

let lastLaunchInput: Record<string, unknown> | null = null;
const stubSupervisor = {
  launchAgent: async (input: Record<string, unknown>) => {
    lastLaunchInput = input;
    return { id: 'launched-1', ...input };
  },
} as unknown as AgentSupervisor;
function launchedInput(): Record<string, unknown> | null { return lastLaunchInput; }

// ── HTTP helpers ────────────────────────────────────────────────────────────

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
  try {
    await fn(port);
  } finally {
    server.stop();
  }
}

const TOKEN = getApiToken();
// No X-Workspace-Id: the launch route rides the non-asserted passthrough so
// workspaceId comes from the body — keeps these tests focused on the plan rail.
const JSON_HDR = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const post = (port: number, body: Record<string, unknown>) =>
  request(port, 'POST', '/api/agents', JSON_HDR, JSON.stringify({ title: 'w', workspaceId: 'ws-1', ...body }));

// ── Tests ─────────────────────────────────────────────────────────────────

test('unknown plan_id → 400, launchAgent never called', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, { plan_id: 'plan-phantom' });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error ?? res.body, /plan/i);
    assert.equal(launchedInput(), null);
  }));

test('unknown planId (camelCase) → 400, launchAgent never called', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, { planId: 'plan-phantom' });
    assert.equal(res.status, 400);
    assert.equal(launchedInput(), null);
  }));

test('snake_case plan_id/plan_section → normalized to camelCase, reaches launchAgent', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, { plan_id: 'plan-1', plan_section: 'sec_abc123' });
    assert.equal(res.status, 200, res.body);
    assert.equal(launchedInput()?.planId, 'plan-1');
    assert.equal(launchedInput()?.planSection, 'sec_abc123');
  }));

test('camelCase planId/planSection → passed through unchanged', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, { planId: 'plan-1', planSection: 'sec_def456' });
    assert.equal(res.status, 200, res.body);
    assert.equal(launchedInput()?.planId, 'plan-1');
    assert.equal(launchedInput()?.planSection, 'sec_def456');
  }));

test('camelCase wins when both snake+camel present (existing DEC-6 alias precedence)', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, { planId: 'plan-1', plan_id: 'plan-phantom' });
    assert.equal(res.status, 200, res.body);
    assert.equal(launchedInput()?.planId, 'plan-1');
  }));

test('no plan binding → unchanged passthrough, launch proceeds', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, {});
    assert.equal(res.status, 200, res.body);
    assert.equal(launchedInput()?.planId, undefined);
    assert.equal(launchedInput()?.planSection, undefined);
  }));

test('empty-string plan_id → treated as unbound (not validated, launch proceeds)', () =>
  withServer(async (port) => {
    lastLaunchInput = null;
    const res = await post(port, { plan_id: '' });
    assert.equal(res.status, 200, res.body);
  }));

// ── Run ─────────────────────────────────────────────────────────────────────

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
  console.log(`\nAll ${tests.length} api-server-plan-rail tests passed`);
})();
