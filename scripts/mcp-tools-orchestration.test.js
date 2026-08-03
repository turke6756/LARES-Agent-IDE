// GT-C Decision 2 (§2.5/§2.7) — launch_agent rail-dispatch shim suffix test.
//
// Drives handleOrchestrationToolCall('launch_agent', …) against a fake apiRequest
// that captures the POST /input body, and asserts:
//   • a plan-rail launch (plan_id + section_anchor) appends the WRITER contract
//     block to the submitted prompt;
//   • a non-rail launch submits args.prompt verbatim.
//
// Run via: node scripts/mcp-tools-orchestration.test.js

const assert = require('assert');
const { handleOrchestrationToolCall } = require('./mcp-tools-orchestration');
const { planRailContractBlock } = require('./lib/plan-rail-contract.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// A fake apiRequest that resolves the launch → immediate-idle → /input sequence
// and records the /input body so the test can inspect the submitted prompt.
function makeFakeApi() {
  const captured = { inputBody: null };
  const apiRequest = async (method, apiPath, body) => {
    if (method === 'POST' && apiPath === '/api/agents') {
      return { id: 'agent-1', title: 'W', workspaceId: 'ws-1', status: 'idle' };
    }
    if (method === 'GET' && apiPath.startsWith('/api/agents/')) {
      return { status: 'idle', autoRestartEnabled: true, restartCount: 0 };
    }
    if (method === 'POST' && apiPath.endsWith('/input')) {
      captured.inputBody = body;
      return { confirmed: true, mode: 'hook' };
    }
    throw new Error(`unexpected apiRequest ${method} ${apiPath}`);
  };
  return { apiRequest, captured };
}

test('rail launch (plan_id + section_anchor) appends the writer contract to the submitted prompt', async () => {
  const { apiRequest, captured } = makeFakeApi();
  await handleOrchestrationToolCall('launch_agent', {
    title: 'Rail worker',
    prompt: 'Do the thing.',
    plan_id: 'plan-42',
    section_anchor: 'sec_abc123',
  }, apiRequest);

  assert.ok(captured.inputBody, 'the /input route must have been called');
  const expected = 'Do the thing.' + '\n\n' + planRailContractBlock('plan-42', 'sec_abc123');
  assert.strictEqual(captured.inputBody.text, expected, 'submitted prompt must be the base prompt + writer contract');
  // WP-P0B: the appended block is orientation only — it names the plan + section
  // but carries NO per-turn sentinel and NO read-before-edit discipline.
  assert.ok(captured.inputBody.text.includes('plan-42') && captured.inputBody.text.includes('sec_abc123'),
    'the appended block names the bound plan + section');
  assert.ok(!captured.inputBody.text.includes('raw+editWindow') && !captured.inputBody.text.includes('PLAN-EVENT'),
    'the appended block must NOT carry the retired read-before-edit / per-turn-sentinel ceremony');
});

test('non-rail launch submits args.prompt verbatim (no contract appended)', async () => {
  const { apiRequest, captured } = makeFakeApi();
  await handleOrchestrationToolCall('launch_agent', {
    title: 'Plain worker',
    prompt: 'Do the thing.',
  }, apiRequest);

  assert.ok(captured.inputBody, 'the /input route must have been called');
  assert.strictEqual(captured.inputBody.text, 'Do the thing.', 'submitted prompt must be verbatim for a non-rail launch');
  assert.ok(!captured.inputBody.text.includes('Plan-rail contract'), 'no rail contract for a non-rail launch');
});

test('plan_id without section_anchor submits verbatim (gate needs both)', async () => {
  const { apiRequest, captured } = makeFakeApi();
  await handleOrchestrationToolCall('launch_agent', {
    title: 'Half-rail worker',
    prompt: 'Do the thing.',
    plan_id: 'plan-42',
  }, apiRequest);

  assert.strictEqual(captured.inputBody.text, 'Do the thing.', 'a plan_id without a section_anchor must not append a contract');
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err && err.stack ? err.stack : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
