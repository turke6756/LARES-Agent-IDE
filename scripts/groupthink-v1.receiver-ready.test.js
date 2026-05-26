#!/usr/bin/env node

/**
 * BUG-17b regression test for scripts/groupthink-v1.js.
 *
 * Three scenarios — all exercise the new `waitReceiverReady` precheck before
 * relay POSTs to /api/agents/<id>/input. The precheck polls receiver status
 * until idle/waiting so a busy receiver does not collide with the BUG-09
 * `/input` 409 gate.
 *
 *   A. Happy path — receiver is `working` for a few polls, then transitions
 *      to `idle`. Assert: no /input POST to receiver before idle, and the
 *      relay POST DOES fire after the flip.
 *
 *   B. Stall — receiver stays `working` past the per-turn timeout. Assert:
 *      stall event posted to supervisor with reason="receiver_not_ready",
 *      exit code 2.
 *
 *   C. Crashed receiver — receiver returns `crashed`. Assert: non-stall
 *      throw, exit code 1, no stall event posted.
 *
 * Stub server contract:
 *   - Launches via POST /api/agents return fixed IDs (fresh-lead-001,
 *     fresh-reviewer-001).
 *   - Lead messages always return a fresh turnComplete message (timestamp =
 *     server start time + offset, > the seed timestamp) so the Lead's
 *     waitTurnComplete returns immediately on every turn.
 *   - Reviewer messages return empty so the Reviewer side of the loop
 *     parks in waitTurnComplete after the relay POST (we never reach it
 *     in failure scenarios; in scenario A we kill the script after
 *     observing the relay POST).
 *   - GET /api/agents/<id> returns scenario-controlled status.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'groupthink-v1.js');
const LEAD_ID = 'fresh-lead-001';
const REVIEWER_ID = 'fresh-reviewer-001';
const SEED_TS = '2026-05-15T12:00:00.000Z';

function startStubServer({ reviewerStatusSequence, leadStatus = 'idle' }) {
  // reviewerStatusSequence is an array of statuses returned in order; the
  // final entry is returned for all subsequent polls.
  const sendInputCalls = [];
  const reviewerStatusPolls = [];
  const leadMessageReads = { count: 0 };
  const reviewerMessageReads = { count: 0 };
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
        const isLead = parsed?.title?.includes('Lead');
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
      if (agentId === LEAD_ID) {
        const idx = leadMessageReads.count++;
        // First read is the seed — return the old turnComplete to mimic
        // contaminated session. Subsequent reads return a FRESH turnComplete
        // (current-time ts) so the relay loop's waitTurnComplete returns.
        if (idx === 0) {
          return respond(200, {
            agentId,
            limit: 1,
            messages: [{
              id: `msg-${agentId}-seed`,
              ts: SEED_TS,
              role: 'assistant',
              turnComplete: true,
              content: 'old contaminated turn',
            }],
          });
        }
        return respond(200, {
          agentId,
          limit: 1,
          messages: [{
            id: `msg-${agentId}-fresh-${idx}`,
            ts: new Date(Date.now() + 1000).toISOString(),
            role: 'assistant',
            turnComplete: true,
            content: `fresh Lead draft #${idx}`,
          }],
        });
      }
      // Reviewer side — return empty (we never need a fresh reviewer turn
      // in these scenarios; the test ends before reviewer's first reply).
      reviewerMessageReads.count++;
      return respond(200, { agentId, limit: 1, messages: [] });
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
      if (agentId === REVIEWER_ID) {
        const idx = reviewerStatusPolls.length;
        const status = reviewerStatusSequence[
          Math.min(idx, reviewerStatusSequence.length - 1)
        ];
        reviewerStatusPolls.push({ status, t: Date.now() });
        return respond(200, {
          id: agentId,
          status,
          provider: 'codex',
          resumeSessionId: `sid-${agentId}`,
        });
      }
      return respond(200, {
        id: agentId,
        status: leadStatus,
        provider: 'claude',
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
        reviewerStatusPolls,
        leadMessageReads,
        reviewerMessageReads,
        launchBodies,
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

async function scenarioHappyPath() {
  // Reviewer working for ~3 polls (~6s at POLL_INTERVAL_MS=2000) then idle.
  const stub = await startStubServer({
    reviewerStatusSequence: ['working', 'working', 'working', 'idle'],
  });
  // Use a long turn-timeout — we want time for the receiver to flip without
  // tripping the stall before then.
  const proc = spawnGroupthink(stub.port, { turnTimeoutMs: 60000 });

  // Wait long enough for: launches + seeds + lead msg + 3 working polls + idle + POST.
  // Lead waitTurnComplete returns immediately after seed (1st post-seed read).
  // waitReceiverReady then polls every 2s; idle flip after 3 working polls
  // (~6s). Total budget: ~12s.
  await sleep(15000);

  const failures = [];

  const reviewerInputs = stub.sendInputCalls.filter((c) => c.agentId === REVIEWER_ID);
  if (reviewerInputs.length === 0) {
    failures.push(
      `Scenario A: expected at least one POST /input to Reviewer after status flipped to idle, got none.\n` +
        `reviewerStatusPolls=${JSON.stringify(stub.reviewerStatusPolls.map((p) => p.status))}\n` +
        `stdout:\n${proc.getStdout()}\nstderr:\n${proc.getStderr()}`
    );
  } else {
    // Inspect the polls that happened before the first /input POST: every
    // one of them must be 'working' (or 'idle' — the resolving poll itself).
    // No /input should have fired before the first idle poll.
    const firstInputT = reviewerInputs[0].t;
    const pollsBeforeInput = stub.reviewerStatusPolls.filter((p) => p.t <= firstInputT);
    const firstIdleIdx = pollsBeforeInput.findIndex((p) => p.status === 'idle');
    if (firstIdleIdx === -1) {
      failures.push(
        `Scenario A: relay POST fired but no 'idle' status poll observed before it. ` +
          `reviewerStatusPolls=${JSON.stringify(pollsBeforeInput.map((p) => p.status))}`
      );
    } else if (firstIdleIdx < 1) {
      failures.push(
        `Scenario A: expected at least one 'working' poll before idle (precheck must wait), got ` +
          JSON.stringify(pollsBeforeInput.map((p) => p.status))
      );
    }
  }

  proc.child.kill('SIGKILL');
  await proc.exit;
  await new Promise((resolve) => stub.server.close(resolve));

  return failures;
}

async function scenarioStall() {
  // Reviewer stays 'working' forever.
  const stub = await startStubServer({
    reviewerStatusSequence: ['working'],
  });
  const proc = spawnGroupthink(stub.port, { turnTimeoutMs: 3000 });

  const exitInfo = await Promise.race([
    proc.exit,
    sleep(20000).then(() => null),
  ]);

  const failures = [];

  if (!exitInfo) {
    proc.child.kill('SIGKILL');
    await proc.exit;
    failures.push(`Scenario B: expected exit within 20s, got none.\nstdout:\n${proc.getStdout()}`);
  } else if (exitInfo.code !== 2) {
    failures.push(
      `Scenario B: expected exit code 2 (stall path), got code=${exitInfo.code} signal=${exitInfo.signal}\n` +
        `stdout:\n${proc.getStdout()}\nstderr:\n${proc.getStderr()}`
    );
  }

  const stallPosts = stub.sendInputCalls.filter((c) => c.agentId === 'test-sup');
  if (stallPosts.length === 0) {
    failures.push(
      `Scenario B: expected at least one POST /api/agents/test-sup/input (stall event), got none.\n` +
        `sendInputCalls=${JSON.stringify(stub.sendInputCalls.map((c) => c.agentId))}\n` +
        `stdout:\n${proc.getStdout()}`
    );
  } else {
    const body = stallPosts[0].body;
    if (!body.includes('orchestration.groupthink.stalled')) {
      failures.push(`Scenario B: stall event body missing orchestration.groupthink.stalled. Got: ${body}`);
    }
    if (!body.includes('receiver_not_ready')) {
      failures.push(`Scenario B: stall event reason must be receiver_not_ready. Got: ${body}`);
    }
  }

  // No /input ever sent to reviewer (precheck never resolved).
  const reviewerInputs = stub.sendInputCalls.filter((c) => c.agentId === REVIEWER_ID);
  if (reviewerInputs.length > 0) {
    failures.push(
      `Scenario B: expected zero POST /input to Reviewer (status stuck working), got ${reviewerInputs.length}`
    );
  }

  await new Promise((resolve) => stub.server.close(resolve));

  return failures;
}

async function scenarioCrashedReceiver() {
  const stub = await startStubServer({
    reviewerStatusSequence: ['crashed'],
  });
  const proc = spawnGroupthink(stub.port, { turnTimeoutMs: 30000 });

  const exitInfo = await Promise.race([
    proc.exit,
    sleep(15000).then(() => null),
  ]);

  const failures = [];

  if (!exitInfo) {
    proc.child.kill('SIGKILL');
    await proc.exit;
    failures.push(`Scenario C: expected exit within 15s on crashed receiver, got none.\nstdout:\n${proc.getStdout()}`);
  } else if (exitInfo.code !== 1) {
    failures.push(
      `Scenario C: expected exit code 1 (non-stall escalation), got code=${exitInfo.code}\n` +
        `stdout:\n${proc.getStdout()}\nstderr:\n${proc.getStderr()}`
    );
  }

  const stallPosts = stub.sendInputCalls.filter((c) => c.agentId === 'test-sup');
  if (stallPosts.length > 0) {
    failures.push(
      `Scenario C: expected NO stall event for crashed receiver (should exit 1, not 2), got ${stallPosts.length}: ` +
        `bodies=${JSON.stringify(stallPosts.map((c) => c.body))}`
    );
  }

  await new Promise((resolve) => stub.server.close(resolve));

  return failures;
}

async function run() {
  const allFailures = [];

  console.log('--- Scenario A: receiver working then idle → relay POSTs after idle ---');
  const a = await scenarioHappyPath();
  if (a.length === 0) console.log('  PASS');
  else { console.error('  FAIL'); a.forEach((f) => console.error('    - ' + f)); allFailures.push(...a.map((f) => `[A] ${f}`)); }

  console.log('--- Scenario B: receiver permanently working → stall event + exit 2 ---');
  const b = await scenarioStall();
  if (b.length === 0) console.log('  PASS');
  else { console.error('  FAIL'); b.forEach((f) => console.error('    - ' + f)); allFailures.push(...b.map((f) => `[B] ${f}`)); }

  console.log('--- Scenario C: receiver crashed → non-stall throw, exit 1 ---');
  const c = await scenarioCrashedReceiver();
  if (c.length === 0) console.log('  PASS');
  else { console.error('  FAIL'); c.forEach((f) => console.error('    - ' + f)); allFailures.push(...c.map((f) => `[C] ${f}`)); }

  if (allFailures.length > 0) {
    console.error(`\nFAIL: BUG-17b receiver-ready regression test (${allFailures.length} failure(s))`);
    process.exit(1);
  }

  console.log('\nPASS: BUG-17b receiver-ready — happy path, stall, and crash branches all behave as designed.');
}

run().catch((err) => {
  console.error('FAIL: unexpected error', err);
  process.exit(1);
});
