#!/usr/bin/env node

/**
 * BUG-06 regression test for scripts/groupthink-v1.js.
 *
 * Resumes the script against two stub agents whose chats already contain a
 * turnComplete:true message and asserts that NO POST /api/agents/<id>/input
 * calls fire during Turn 1. With the bug present the script re-pastes both
 * existing messages within a couple of poll intervals; with the fix the
 * relay loop sits in waitTurnComplete forever (we kill it after the window).
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'groupthink-v1.js');
const OLD_TS = '2026-05-15T12:00:00.000Z';
const TEST_WINDOW_MS = 10000; // ~5 poll intervals at POLL_INTERVAL_MS=2000

function startStubServer(sendInputCalls, messagesPolls) {
  const server = http.createServer((req, res) => {
    const { method, url } = req;

    const respond = (status, body) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
      });
      res.end(text);
    };

    // GET /api/agents — connect probe
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
      sendInputCalls.push({ agentId, t: Date.now() });
      // consume body
      req.on('data', () => {});
      req.on('end', () => respond(200, { ok: true }));
      return;
    }

    const agentMatch = url.match(/^\/api\/agents\/([^/?]+)$/);
    if (method === 'GET' && agentMatch) {
      const agentId = agentMatch[1];
      return respond(200, {
        id: agentId,
        status: 'idle',
        provider: agentId.includes('lead') ? 'claude' : 'codex',
        resumeSessionId: `sid-${agentId}`,
      });
    }

    respond(404, { error: 'not found', url });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function run() {
  const sendInputCalls = [];
  const messagesPolls = [];
  const { server, port } = await startStubServer(sendInputCalls, messagesPolls);

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
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const childExit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  await new Promise((resolve) => setTimeout(resolve, TEST_WINDOW_MS));

  child.kill('SIGKILL');
  await childExit;
  await new Promise((resolve) => server.close(resolve));

  const failures = [];

  if (sendInputCalls.length !== 0) {
    failures.push(
      `Expected zero POST /input calls on Turn 1, got ${sendInputCalls.length}: ` +
        JSON.stringify(sendInputCalls)
    );
  }

  // Sanity: confirm the script actually reached the relay loop, otherwise a
  // zero-input result could be a false pass (e.g. connect failure).
  if (messagesPolls.length === 0) {
    failures.push(
      'Expected at least one GET /messages poll (script never reached the relay loop). ' +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (!stdout.includes('Seeded lastRelayedTs[Lead lead-001]')) {
    failures.push(
      `Expected seeding log for Lead but did not find it. stdout:\n${stdout}`
    );
  }
  if (!stdout.includes('Seeded lastRelayedTs[Reviewer reviewer-001]')) {
    failures.push(
      `Expected seeding log for Reviewer but did not find it. stdout:\n${stdout}`
    );
  }

  if (failures.length > 0) {
    console.error('FAIL: BUG-06 regression test');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }

  console.log(
    `PASS: BUG-06 regression — 0 /input calls over ${TEST_WINDOW_MS}ms ` +
      `with ${messagesPolls.length} /messages polls observed.`
  );
}

run().catch((err) => {
  console.error('FAIL: unexpected error', err);
  process.exit(1);
});
