// launch_agent prompt forwarding tests.
//
// Run via: node scripts/mcp-tools-orchestration.test.js

const assert = require('assert');
const { getOrchestrationToolDefinitions, handleOrchestrationToolCall } = require('./mcp-tools-orchestration');

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

test('launch_agent provider enum includes agy', () => {
  const launch = getOrchestrationToolDefinitions().find((tool) => tool.name === 'launch_agent');
  assert.ok(launch.inputSchema.properties.provider.enum.includes('agy'));
});

test('rail launch submits args.prompt verbatim', async () => {
  const { apiRequest, captured } = makeFakeApi();
  await handleOrchestrationToolCall('launch_agent', {
    title: 'Rail worker',
    prompt: 'Do the thing.',
    plan_id: 'plan-42',
    section_anchor: 'sec_abc123',
  }, apiRequest);

  assert.ok(captured.inputBody, 'the /input route must have been called');
  assert.strictEqual(captured.inputBody.text, 'Do the thing.', 'submitted prompt must be verbatim');
});

test('non-rail launch submits args.prompt verbatim', async () => {
  const { apiRequest, captured } = makeFakeApi();
  await handleOrchestrationToolCall('launch_agent', {
    title: 'Plain worker',
    prompt: 'Do the thing.',
  }, apiRequest);

  assert.ok(captured.inputBody, 'the /input route must have been called');
  assert.strictEqual(captured.inputBody.text, 'Do the thing.', 'submitted prompt must be verbatim for a non-rail launch');
});

test('plan_id without section_anchor submits verbatim', async () => {
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
