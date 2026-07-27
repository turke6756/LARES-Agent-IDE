// Smoke tests for the /api/agents/:id/file-activities HTTP route, which
// backs the `read_agent_files_touched` MCP tool. Verifies operation filter,
// fallback for bogus values, empty-result behavior, payload shape, and the
// limit slice.
//
//   npm run build:main
//   node dist/main/main/supervisor/file-activities-query.test.js
//
// Stubs `database.getFileActivities` BEFORE importing api-server. That keeps
// the test off SQLite's native binding, which is built against Electron's
// Node ABI and won't load under the system Node that `npm run test:supervisor`
// uses. The same pattern is used by event-bridge.integration.test.

import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbModule = require('../database') as {
  getFileActivities: (agentId: string, op?: string, currentOnly?: boolean) => unknown[];
  getAgent: (id: string) => unknown;
};

interface FakeRow {
  id: number;
  agentId: string;
  filePath: string;
  operation: 'read' | 'write' | 'create';
  timestamp: string;
  generation: number;
  sessionId: string | null;
  // Test-only: which session the fake treats as "live" for current_only.
  _live?: boolean;
}

let fakeRows: FakeRow[] = [];
const dbCalls: Array<{ agentId: string; op: string | undefined; currentOnly: boolean | undefined }> = [];

// WP2 (plans/cross-workspace-collaboration.md) added a target lookup + per-ID
// authorization to this route: `getAgent(id)` (404 if missing) → authorizeAgentTarget.
// This test drives route() with a bare `{}` request (no capability = trusted
// global bearer), so authorization is a pass-through; we only need getAgent to
// resolve the target so the read reaches getFileActivities. 'ghost-agent' stays
// unknown so the missing-target 404 path can be asserted.
const origGetAgent = dbModule.getAgent;
dbModule.getAgent = (id: string) =>
  id === 'ghost-agent' ? null : { id, workspaceId: 'ws-x' };

const origGetFileActivities = dbModule.getFileActivities;
dbModule.getFileActivities = (agentId: string, op?: string, currentOnly?: boolean) => {
  dbCalls.push({ agentId, op, currentOnly });
  // Mirror the real SQL: filter by agent_id (always), operation (if provided),
  // and — when currentOnly — the rows flagged as the live session.
  let rows = fakeRows.filter((r) => r.agentId === agentId);
  if (op) rows = rows.filter((r) => r.operation === op);
  if (currentOnly) rows = rows.filter((r) => r._live);
  return rows;
};

import { ApiServer } from '../api-server';

// Construct with a stub supervisor — our route doesn't touch it.
const server = new ApiServer({} as never);

async function get(routePath: string): Promise<{ agentId: string; operation: string | null; activities: FakeRow[] }> {
  const url = new URL(`http://localhost:24678${routePath}`);
  // route() is private; cast to access it directly without spinning up an HTTP server.
  return await (server as unknown as { route: (m: string, u: URL, r: unknown) => Promise<{ agentId: string; operation: string | null; activities: FakeRow[] }> }).route('GET', url, {});
}

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, run: fn }); }

function makeRow(over: Partial<FakeRow>): FakeRow {
  return {
    id: 1,
    agentId: 'agent-x',
    filePath: 'C:\\repo\\file.ts',
    operation: 'read',
    timestamp: '2026-05-17 12:00:00',
    generation: 0,
    sessionId: null,
    ...over,
  };
}

function resetCalls(): void { dbCalls.length = 0; }

test('returns all operations when no filter is supplied', async () => {
  fakeRows = [
    makeRow({ id: 1, filePath: 'C:\\repo\\a.ts', operation: 'read' }),
    makeRow({ id: 2, filePath: 'C:\\repo\\b.ts', operation: 'write' }),
    makeRow({ id: 3, filePath: 'C:\\repo\\c.ts', operation: 'create' }),
    makeRow({ id: 4, agentId: 'agent-other', filePath: 'C:\\repo\\d.ts', operation: 'read' }),
  ];
  resetCalls();

  const result = await get('/api/agents/agent-x/file-activities');
  assert.equal(result.agentId, 'agent-x');
  assert.equal(result.operation, null);
  assert.equal(result.activities.length, 3);
  const ops = result.activities.map((a) => a.operation).sort();
  assert.deepEqual(ops, ['create', 'read', 'write']);
  // Verify getFileActivities was called without an operation argument so the
  // unfiltered SQL path is exercised (not just JS-side filtering).
  assert.deepEqual(dbCalls, [{ agentId: 'agent-x', op: undefined, currentOnly: false }]);
});

test('operation=read narrows to reads only', async () => {
  fakeRows = [
    makeRow({ id: 1, filePath: 'C:\\repo\\read1.ts', operation: 'read' }),
    makeRow({ id: 2, filePath: 'C:\\repo\\read2.ts', operation: 'read' }),
    makeRow({ id: 3, filePath: 'C:\\repo\\written.ts', operation: 'write' }),
  ];
  resetCalls();

  const result = await get('/api/agents/agent-x/file-activities?operation=read');
  assert.equal(result.operation, 'read');
  assert.equal(result.activities.length, 2);
  assert.ok(result.activities.every((a) => a.operation === 'read'));
  assert.deepEqual(dbCalls, [{ agentId: 'agent-x', op: 'read', currentOnly: false }]);
});

test('operation=write narrows to writes only', async () => {
  fakeRows = [
    makeRow({ id: 1, operation: 'read' }),
    makeRow({ id: 2, operation: 'write', filePath: 'C:\\repo\\out.ts' }),
    makeRow({ id: 3, operation: 'create' }),
  ];

  const result = await get('/api/agents/agent-x/file-activities?operation=write');
  assert.equal(result.operation, 'write');
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].operation, 'write');
  assert.equal(result.activities[0].filePath, 'C:\\repo\\out.ts');
});

test('operation=create narrows to creates only', async () => {
  fakeRows = [
    makeRow({ id: 1, operation: 'read' }),
    makeRow({ id: 2, operation: 'create', filePath: 'C:\\repo\\new.ts' }),
  ];

  const result = await get('/api/agents/agent-x/file-activities?operation=create');
  assert.equal(result.operation, 'create');
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].operation, 'create');
});

test('bogus operation value is rejected, falls back to no-filter (no SQL injection surface)', async () => {
  fakeRows = [
    makeRow({ id: 1, operation: 'read' }),
    makeRow({ id: 2, operation: 'write' }),
  ];
  resetCalls();

  const result = await get('/api/agents/agent-x/file-activities?operation=evil%27%20OR%201%3D1');
  assert.equal(result.operation, null);
  assert.equal(result.activities.length, 2);
  // Crucially, the bogus string is never passed to the DB layer.
  assert.deepEqual(dbCalls, [{ agentId: 'agent-x', op: undefined, currentOnly: false }]);
});

test('non-existent target agent → 404 (WP2 per-ID target lookup)', async () => {
  // WP2 changed this route's contract: a missing target is now a 404 (was an
  // empty activities array), matching the other per-ID routes.
  fakeRows = [makeRow({ id: 1, agentId: 'agent-x' })];
  await assert.rejects(
    () => get('/api/agents/ghost-agent/file-activities'),
    (err: any) => err.statusCode === 404,
  );
});

test('payload row shape matches the writeup example', async () => {
  // Lifted verbatim from the live-DB sample in plans/mcp-context-output-tools-investigation.md.
  fakeRows = [{
    id: 1507,
    agentId: 'be04c8ed-721a-43db-90e2-d64f792dc125',
    filePath: 'C:\\Users\\turke\\Projects\\AgentDashboard\\plans\\agent-lifecycle-hardening-plan.md',
    operation: 'write',
    timestamp: '2026-05-17 22:41:25',
    generation: 2,
    sessionId: 'sess-live',
  }];

  const result = await get('/api/agents/be04c8ed-721a-43db-90e2-d64f792dc125/file-activities');
  assert.equal(result.activities.length, 1);
  const row = result.activities[0];
  // Exact key set — no snake_case leakage, no surprise fields. Phase 4 adds
  // generation + sessionId (the per-session partition the tabs render on).
  assert.deepEqual(Object.keys(row).sort(), ['agentId', 'filePath', 'generation', 'id', 'operation', 'sessionId', 'timestamp']);
  assert.equal(row.id, 1507);
  assert.equal(row.agentId, 'be04c8ed-721a-43db-90e2-d64f792dc125');
  assert.equal(row.filePath, 'C:\\Users\\turke\\Projects\\AgentDashboard\\plans\\agent-lifecycle-hardening-plan.md');
  assert.equal(row.operation, 'write');
  assert.equal(row.timestamp, '2026-05-17 22:41:25');
  assert.equal(row.generation, 2);
  assert.equal(row.sessionId, 'sess-live');
});

test('current_only=true narrows to the agent\'s live session; default returns all sessions', async () => {
  fakeRows = [
    makeRow({ id: 1, filePath: 'C:\\repo\\live.ts', operation: 'read', sessionId: 'sess-live', generation: 1, _live: true }),
    makeRow({ id: 2, filePath: 'C:\\repo\\prior.ts', operation: 'read', sessionId: 'sess-old', generation: 0 }),
  ];
  resetCalls();

  const all = await get('/api/agents/agent-x/file-activities');
  assert.equal(all.activities.length, 2, 'default returns prior + current sessions');

  const current = await get('/api/agents/agent-x/file-activities?current_only=true');
  assert.equal(current.activities.length, 1, 'current_only drops the prior session');
  assert.equal(current.activities[0].filePath, 'C:\\repo\\live.ts');
  assert.deepEqual(dbCalls, [
    { agentId: 'agent-x', op: undefined, currentOnly: false },
    { agentId: 'agent-x', op: undefined, currentOnly: true },
  ]);
});

test('limit param trims the result array', async () => {
  fakeRows = [
    makeRow({ id: 1, operation: 'read' }),
    makeRow({ id: 2, operation: 'write' }),
    makeRow({ id: 3, operation: 'create' }),
  ];
  const result = await get('/api/agents/agent-x/file-activities?limit=2');
  assert.equal(result.activities.length, 2);
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
  dbModule.getFileActivities = origGetFileActivities;
  dbModule.getAgent = origGetAgent;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
