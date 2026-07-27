// Checkpoint Surface Hardening WP4 — MCP `list_checkpoints` byte guard + query build.
//
// Drives the PUBLIC handler with a fake apiRequest (no network), so it exercises the
// real query-string assembly AND the incremental byte-budget truncation:
//   - filters (agent_id/since/sinceTime/limit/file) are threaded into the query string;
//   - a large touched[] result is trimmed so the FULL serialized tool payload (wrapper
//     included) stays under the cap, dropping the OLDEST rows first (newest retained),
//     output stays ascending, and truncated/returnedCount/totalMatched are set;
//   - a single oversized row → zero rows + truncated:true (totalMatched still 1);
//   - a small result is returned whole (truncated:false, ascending preserved).
//
//   node scripts/mcp-tools-checkpoints.test.js

const assert = require('node:assert/strict');
const { handleCheckpointsToolCall } = require('./mcp-tools-checkpoints');

const CAP = 100_000; // must match LIST_CHECKPOINTS_OUTPUT_CAP_BYTES in the module

const tests = [];
function test(name, fn) { tests.push({ name, run: fn }); }

/** A fake apiRequest that records the path and returns a canned list response. */
function fakeApi(response) {
  const calls = [];
  const apiRequest = async (method, path) => { calls.push({ method, path }); return response; };
  apiRequest.calls = calls;
  return apiRequest;
}

function turn(seq, pathCount, pathLen) {
  const witnessedPaths = [];
  for (let i = 0; i < pathCount; i++) witnessedPaths.push(`src/${'x'.repeat(pathLen)}/f${seq}-${i}.ts`);
  return {
    turnId: `t${seq}`, turnSeq: seq, agentId: 'a1', agentTitle: 'Agent',
    taskLabel: 'task', status: 'accepted', startedAt: seq * 1000, endedAt: seq * 1000 + 1,
    beforeReady: true, afterReady: true, beforeQuality: 'guaranteed', afterQuality: 'hook',
    witnessedPaths, failureReason: null, beforeRawFilterBypassed: false,
  };
}

const payloadOf = (result) => JSON.parse(result.content[0].text);
const wrapperBytes = (result) => Buffer.byteLength(JSON.stringify(result), 'utf8');

// ── query building ────────────────────────────────────────────────────────────

test('filters are threaded into the query string', async () => {
  const api = fakeApi({ workspaceId: 'ws', turns: [] });
  await handleCheckpointsToolCall('list_checkpoints', {
    agent_id: 'a1', since: 7, sinceTime: 1500, limit: 25, file: 'src/a.txt',
  }, api);
  const path = api.calls[0].path;
  assert.ok(path.startsWith('/api/checkpoints?'), 'has a query string');
  assert.ok(path.includes('agentId=a1'), 'agentId');
  assert.ok(path.includes('since=7'), 'since');
  assert.ok(path.includes('sinceTime=1500'), 'sinceTime');
  assert.ok(path.includes('limit=25'), 'limit');
  assert.ok(path.includes('file=src%2Fa.txt'), 'file (url-encoded)');
});

test('no filters → no query string', async () => {
  const api = fakeApi({ workspaceId: 'ws', turns: [] });
  await handleCheckpointsToolCall('list_checkpoints', {}, api);
  assert.equal(api.calls[0].path, '/api/checkpoints');
});

// ── byte guard ──────────────────────────────────────────────────────────────

test('small result is returned whole, ascending, truncated:false', async () => {
  const turns = [turn(1, 1, 4), turn(2, 1, 4), turn(3, 1, 4)];
  const api = fakeApi({ workspaceId: 'ws', turns });
  const result = await handleCheckpointsToolCall('list_checkpoints', {}, api);
  const body = payloadOf(result);
  assert.equal(body.truncated, false);
  assert.equal(body.returnedCount, 3);
  assert.equal(body.totalMatched, 3);
  assert.deepEqual(body.turns.map((t) => t.turnSeq), [1, 2, 3], 'ascending preserved');
  assert.ok(wrapperBytes(result) < CAP, 'under cap');
});

test('a large touched[] result is trimmed under the cap, dropping OLDEST first', async () => {
  // Each row ~ a few KB; 60 rows blow the ~100KB cap.
  const turns = [];
  for (let seq = 1; seq <= 60; seq++) turns.push(turn(seq, 12, 120));
  const api = fakeApi({ workspaceId: 'ws', turns });
  const result = await handleCheckpointsToolCall('list_checkpoints', {}, api);
  const body = payloadOf(result);

  assert.ok(wrapperBytes(result) < CAP, `serialized wrapper (${wrapperBytes(result)}) under cap`);
  assert.equal(body.truncated, true, 'truncated');
  assert.equal(body.totalMatched, 60, 'totalMatched is the pre-byte-truncation count');
  assert.ok(body.returnedCount > 0 && body.returnedCount < 60, `kept a proper subset (${body.returnedCount})`);
  assert.equal(body.turns.length, body.returnedCount);

  const keptSeqs = body.turns.map((t) => t.turnSeq);
  assert.deepEqual(keptSeqs, [...keptSeqs].sort((a, b) => a - b), 'output stays ascending');
  // Newest retained: the kept window ends at the newest turn (60) and the dropped
  // rows are the OLDEST.
  assert.equal(keptSeqs[keptSeqs.length - 1], 60, 'newest row is kept');
  assert.equal(keptSeqs[0], 60 - body.returnedCount + 1, 'the dropped rows are the oldest');
});

test('a single oversized row → zero rows + truncated:true (totalMatched still 1)', async () => {
  const huge = turn(1, 4000, 200); // one row well over the cap on its own
  assert.ok(
    Buffer.byteLength(JSON.stringify(huge), 'utf8') > CAP,
    'fixture row is genuinely oversized',
  );
  const api = fakeApi({ workspaceId: 'ws', turns: [huge] });
  const result = await handleCheckpointsToolCall('list_checkpoints', {}, api);
  const body = payloadOf(result);
  assert.equal(body.returnedCount, 0, 'zero rows returned');
  assert.deepEqual(body.turns, []);
  assert.equal(body.truncated, true);
  assert.equal(body.totalMatched, 1);
  assert.ok(wrapperBytes(result) < CAP, 'payload never over budget even with an oversized row');
});

// ── runner ────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err && err.stack || err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
