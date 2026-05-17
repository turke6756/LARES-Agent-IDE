#!/usr/bin/env node

/**
 * BUG-03 regression test for scripts/groupthink-v1.js.
 *
 * Two scenarios — together they prove both halves of the fix:
 *
 *   A. status='working' + short --turn-timeout-ms:
 *      Even with the timeout set to 2s and no new turnComplete message ever
 *      arriving, waitTurnComplete must NOT throw a stall because the agent
 *      is demonstrably still working. We wait well past the timeout and
 *      assert the script is still alive and emitted no stall event.
 *
 *   B. status='idle' + short --turn-timeout-ms:
 *      With the agent NOT working and no new message, the timeout must
 *      fire at roughly the configured 2s (proves --turn-timeout-ms is
 *      parsed and applied — the default is 600000ms, so a default-bound
 *      script would not exit within the test window). We assert the
 *      script POSTs a stall event to the supervisor and exits with code 2.
 *
 * Stub-server contract: returns one pre-existing turnComplete message per
 * /messages poll (timestamp OLD_TS). seedLastRelayedTsFromChat seeds that
 * timestamp into lastRelayedTs so the relay loop sees no fresh messages
 * and parks in waitTurnComplete — exactly the situation we want to test.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'groupthink-v1.js');
const OLD_TS = '2026-05-15T12:00:00.000Z';
const TURN_TIMEOUT_MS = 2000;
const SCENARIO_A_WINDOW_MS = 8000;   // 4x the configured timeout
const SCENARIO_B_WAIT_MS = 12000;    // generous upper bound for ~2s timeout + exit

function startStubServer({ status }) {
  const sendInputCalls = [];
  const messagesPolls = [];
  const statusPolls = [];

  const server = http.createServer((req, res) => {
    const { method, url } = req;

    const respond = (code, body) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
      });
      res.end(text);
    };

    if (method === 'GET' && url === '/api/agents') {
      return respond(200, []);
    }

    const messagesMatch = url.match(/^\/api\/agents\/([^/?]+)\/messages(\?.*)?$/);
    if (method === 'GET' && messagesMatch) {
      const agentId = messagesMatch[1];
      messagesPolls.push({ agentId, t: Date.now() });
      return respond(200, {
        agentId,
        limit: 1,
        messages: [
          {
            id: `msg-${agentId}-old`,
            ts: OLD_TS,
            role: 'assistant',
            turnComplete: true,
            content: `pre-existing turn-complete message from ${agentId}`,
          },
        ],
      });
    }

    const inputMatch = url.match(/^\/api\/agents\/([^/?]+)\/input$/);
    if (method === 'POST' && inputMatch) {
      const agentId = inputMatch[1];
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        sendInputCalls.push({ agentId, t: Date.now(), body });
        respond(200, { ok: true });
      });
      return;
    }

    const agentMatch = url.match(/^\/api\/agents\/([^/?]+)$/);
    if (method === 'GET' && agentMatch) {
      const agentId = agentMatch[1];
      statusPolls.push({ agentId, t: Date.now() });
      return respond(200, {
        id: agentId,
        status,
        provider: agentId.includes('lead') ? 'claude' : 'codex',
        resumeSessionId: `sid-${agentId}`,
      });
    }

    respond(404, { error: 'not found', url });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        sendInputCalls,
        messagesPolls,
        statusPolls,
      });
    });
  });
}

function spawnGroupthink(port, { turnTimeoutMs }) {
  const child = spawn(
    process.execPath,
    [
      SCRIPT,
      '--workspaceId=test-ws',
      '--supervisorId=test-sup',
      '--resume-lead-id=lead-001',
      '--resume-reviewer-id=reviewer-001',
      '--api-host=127.0.0.1',
      `--api-port=${port}`,
      `--turn-timeout-ms=${turnTimeoutMs}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, exit, getStdout: () => stdout, getStderr: () => stderr };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scenarioWorkingDoesNotStall() {
  const stub = await startStubServer({ status: 'working' });
  const proc = spawnGroupthink(stub.port, { turnTimeoutMs: TURN_TIMEOUT_MS });

  let exited = null;
  proc.exit.then((info) => { exited = info; });

  await sleep(SCENARIO_A_WINDOW_MS);

  const failures = [];

  if (exited) {
    failures.push(
      `Expected script to remain running while status='working', but it exited: ${JSON.stringify(exited)}\n` +
        `stdout:\n${proc.getStdout()}\nstderr:\n${proc.getStderr()}`
    );
  }

  if (stub.sendInputCalls.length > 0) {
    failures.push(
      `Expected zero POST /input calls (no stall event) but got ${stub.sendInputCalls.length}: ` +
        JSON.stringify(stub.sendInputCalls.map((c) => c.agentId))
    );
  }

  if (stub.statusPolls.length === 0) {
    failures.push(
      `Expected at least one GET /api/agents/<id> status poll, got none. ` +
        `Script may not have reached waitTurnComplete.\nstdout:\n${proc.getStdout()}`
    );
  }

  if (!proc.getStdout().includes(`Per-turn timeout: ${TURN_TIMEOUT_MS}ms (overridden via --turn-timeout-ms)`)) {
    failures.push(
      `Expected log line confirming --turn-timeout-ms override. stdout:\n${proc.getStdout()}`
    );
  }

  proc.child.kill('SIGKILL');
  await proc.exit;
  await new Promise((resolve) => stub.server.close(resolve));

  return failures;
}

async function scenarioIdleHonorsConfiguredTimeout() {
  const stub = await startStubServer({ status: 'idle' });
  const proc = spawnGroupthink(stub.port, { turnTimeoutMs: TURN_TIMEOUT_MS });

  const startedAt = Date.now();
  const exitInfo = await Promise.race([
    proc.exit,
    sleep(SCENARIO_B_WAIT_MS).then(() => null),
  ]);
  const elapsed = Date.now() - startedAt;

  const failures = [];

  if (!exitInfo) {
    proc.child.kill('SIGKILL');
    await proc.exit;
    failures.push(
      `Expected script to exit within ${SCENARIO_B_WAIT_MS}ms when status='idle' and ` +
        `--turn-timeout-ms=${TURN_TIMEOUT_MS}, but it did not. ` +
        `(If the flag were ignored, the default 600000ms timeout would keep it alive.)\n` +
        `stdout:\n${proc.getStdout()}\nstderr:\n${proc.getStderr()}`
    );
  } else if (exitInfo.code !== 2) {
    failures.push(
      `Expected exit code 2 (stall path), got code=${exitInfo.code} signal=${exitInfo.signal} after ${elapsed}ms\n` +
        `stdout:\n${proc.getStdout()}\nstderr:\n${proc.getStderr()}`
    );
  }

  // Loose lower bound — the timeout must at least give one poll interval before firing.
  // Loose upper bound — should be well under the default 600000ms; we cap by the wait window.
  if (exitInfo && elapsed > SCENARIO_B_WAIT_MS) {
    failures.push(`Script exited too late: ${elapsed}ms (configured timeout ${TURN_TIMEOUT_MS}ms)`);
  }

  const stallCalls = stub.sendInputCalls.filter((c) => c.agentId === 'test-sup');
  if (stallCalls.length === 0) {
    failures.push(
      `Expected at least one POST /api/agents/test-sup/input (stall event) but got none. ` +
        `sendInputCalls=${JSON.stringify(stub.sendInputCalls.map((c) => c.agentId))}\n` +
        `stdout:\n${proc.getStdout()}`
    );
  } else if (!stallCalls[0].body.includes('orchestration.groupthink.stalled')) {
    failures.push(
      `Expected stall event body to mention orchestration.groupthink.stalled. Got: ${stallCalls[0].body}`
    );
  }

  await new Promise((resolve) => stub.server.close(resolve));

  return failures;
}

async function run() {
  const allFailures = [];

  console.log('--- Scenario A: status=working should NOT stall ---');
  const aFailures = await scenarioWorkingDoesNotStall();
  if (aFailures.length === 0) {
    console.log('  PASS');
  } else {
    console.error('  FAIL');
    for (const f of aFailures) console.error('    - ' + f);
    allFailures.push(...aFailures.map((f) => `[A] ${f}`));
  }

  console.log('--- Scenario B: --turn-timeout-ms honored when status=idle ---');
  const bFailures = await scenarioIdleHonorsConfiguredTimeout();
  if (bFailures.length === 0) {
    console.log('  PASS');
  } else {
    console.error('  FAIL');
    for (const f of bFailures) console.error('    - ' + f);
    allFailures.push(...bFailures.map((f) => `[B] ${f}`));
  }

  if (allFailures.length > 0) {
    console.error(`\nFAIL: BUG-03 regression test (${allFailures.length} failure(s))`);
    process.exit(1);
  }

  console.log('\nPASS: BUG-03 regression — --turn-timeout-ms parsed and status=working resets stall clock.');
}

run().catch((err) => {
  console.error('FAIL: unexpected error', err);
  process.exit(1);
});
