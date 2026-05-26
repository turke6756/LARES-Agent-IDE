#!/usr/bin/env node

/**
 * BUG-17a regression test for scripts/groupthink-v1.js.
 *
 * Launches the script via the fresh-launch path (no --resume-*-id flags) so
 * both planners go through POST /api/agents. Each fresh agent's chat is
 * stubbed to return a pre-existing turnComplete:true message — simulating
 * the BUG-16 case where a Codex session inherits old turns. Before the fix
 * the relay loop would re-paste both messages immediately because the
 * fresh-launch path never seeded lastRelayedTs. With the fix, both seeds
 * fire and no /input POST happens during the test window.
 *
 * Asserts:
 *   - Both POST /api/agents bodies include freshSession: true (BUG-16).
 *   - Both seeding log lines appear (BUG-17a).
 *   - Zero POST /api/agents/<id>/input calls during the test window.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'groupthink-v1.js');
const OLD_TS = '2026-05-15T12:00:00.000Z';
const TEST_WINDOW_MS = 10000;

const LEAD_ID = 'fresh-lead-001';
const REVIEWER_ID = 'fresh-reviewer-001';

function startStubServer() {
  const sendInputCalls = [];
  const messagesPolls = [];
  const launchBodies = [];

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

    if (method === 'GET' && url === '/api/agents') {
      return respond(200, []);
    }

    if (method === 'POST' && url === '/api/agents') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        launchBodies.push(parsed);
        const isLead = (parsed && parsed.title && parsed.title.includes('Lead'));
        const id = isLead ? LEAD_ID : REVIEWER_ID;
        respond(200, {
          id,
          status: 'idle',
          provider: parsed?.provider || 'claude',
          resumeSessionId: `sid-${id}`,
        });
      });
      return;
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
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sendInputCalls.push({ agentId, t: Date.now(), body });
        respond(200, { ok: true });
      });
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
      resolve({
        server,
        port: server.address().port,
        sendInputCalls,
        messagesPolls,
        launchBodies,
      });
    });
  });
}

async function run() {
  const stub = await startStubServer();

  const child = spawn(
    process.execPath,
    [
      SCRIPT,
      '--workspaceId=test-ws',
      '--supervisorId=test-sup',
      '--api-host=127.0.0.1',
      `--api-port=${stub.port}`,
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
  await new Promise((resolve) => stub.server.close(resolve));

  const failures = [];

  // BUG-16: both launch bodies must include freshSession: true
  if (stub.launchBodies.length < 2) {
    failures.push(
      `Expected 2 POST /api/agents calls (fresh Lead + Reviewer), got ${stub.launchBodies.length}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } else {
    for (const body of stub.launchBodies) {
      if (body?.freshSession !== true) {
        failures.push(
          `Expected freshSession:true in launch body for ${body?.title || '<unknown>'}, got ${JSON.stringify(body)}`
        );
      }
    }
  }

  // BUG-17a: both seeding lines must appear
  if (!stdout.includes(`No prior turnComplete message`) && !stdout.includes(`Seeded lastRelayedTs`)) {
    failures.push(`Expected at least one seed-related log; saw none.\nstdout:\n${stdout}`);
  }
  if (!stdout.includes(`Seeded lastRelayedTs[Lead ${LEAD_ID}]`)) {
    failures.push(
      `Expected "Seeded lastRelayedTs[Lead ${LEAD_ID}]" log (fresh-launch path should seed). stdout:\n${stdout}`
    );
  }
  if (!stdout.includes(`Seeded lastRelayedTs[Reviewer ${REVIEWER_ID}]`)) {
    failures.push(
      `Expected "Seeded lastRelayedTs[Reviewer ${REVIEWER_ID}]" log. stdout:\n${stdout}`
    );
  }

  // No /input POSTs (old messages must not be relayed)
  if (stub.sendInputCalls.length !== 0) {
    failures.push(
      `Expected zero POST /input calls during ${TEST_WINDOW_MS}ms, got ${stub.sendInputCalls.length}: ` +
        JSON.stringify(stub.sendInputCalls.map((c) => c.agentId))
    );
  }

  // Sanity: script must have reached the relay loop (messages polls > 0).
  if (stub.messagesPolls.length === 0) {
    failures.push(
      `Expected at least one /messages poll, got none. Script may not have reached the relay loop.\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }

  if (failures.length > 0) {
    console.error('FAIL: BUG-17a fresh-seed regression test');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }

  console.log(
    `PASS: BUG-17a fresh-seed — both fresh launches seeded, 0 /input calls over ${TEST_WINDOW_MS}ms, ` +
      `both launch bodies carry freshSession:true.`
  );
}

run().catch((err) => {
  console.error('FAIL: unexpected error', err);
  process.exit(1);
});
