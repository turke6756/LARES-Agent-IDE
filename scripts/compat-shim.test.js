#!/usr/bin/env node

/**
 * Compat-shim test for scripts/groupthink-v2.js (plan §7, Phase 3).
 *
 * Two layers:
 *  1) Unit — require the shim module and assert buildRequest(argv) produces the
 *     expected POST body (name + top-level workspaceId/supervisorId + a
 *     legacyCommand carrying the original argv).
 *  2) Integration — spawn the shim against a stub HTTP server and assert it
 *     actually POSTs that body to /api/orchestrations and reports the runId.
 *
 * Run: node scripts/compat-shim.test.js
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('node:assert/strict');

const SCRIPT = path.join(__dirname, 'groupthink-v2.js');
const { buildRequest, parseArgs } = require('./groupthink-v2.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok  ${name}`); passed++; })
    .catch((err) => { console.error(`  FAIL ${name}`); console.error('       ', err && err.stack || err); failed++; });
}

// ── Unit ─────────────────────────────────────────────────────────────
function unitTests() {
  const argv = [
    '--mode=serial', '--workspaceId=ws-1', '--supervisorId=sup-1',
    '--resume-lead-id=lead9', '--resume-reviewer-id=rev9', '--turn-timeout-ms=120000',
  ];
  const req = buildRequest(argv);
  assert.equal(req.name, 'groupthink', 'name is groupthink');
  assert.equal(req.params.workspaceId, 'ws-1', 'workspaceId promoted to top-level param');
  assert.equal(req.params.supervisorId, 'sup-1', 'supervisorId promoted to top-level param');
  assert.match(req.params.legacyCommand, /scripts\/groupthink-v2\.js/, 'legacyCommand is a runnable command line');
  assert.match(req.params.legacyCommand, /--resume-lead-id=lead9/, 'legacyCommand carries resume-lead-id');
  assert.match(req.params.legacyCommand, /--resume-reviewer-id=rev9/, 'legacyCommand carries resume-reviewer-id');
  assert.match(req.params.legacyCommand, /--turn-timeout-ms=120000/, 'legacyCommand carries turn-timeout-ms');

  // keepAgents flag is forwarded only when present.
  assert.equal(req.params.keepAgents, undefined, 'keepAgents absent by default');
  assert.equal(buildRequest(['--workspaceId=w', '--supervisorId=s', '--keepAgents']).params.keepAgents, true,
    'keepAgents forwarded as a bare flag');

  // parseArgs grammar: --k=v, --k v, bare flag.
  const a = parseArgs(['--mode', 'parallel', '--keepAgents', '--workspaceId=x']);
  assert.equal(a.mode, 'parallel', '--k v form parsed');
  assert.equal(a.keepAgents, 'true', 'bare flag is true');
  assert.equal(a.workspaceId, 'x', '--k=v form parsed');
}

// ── Integration ──────────────────────────────────────────────────────
function startStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/orchestrations') {
        received.push(JSON.parse(body || '{}'));
        const text = JSON.stringify({ runId: 'run-xyz' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        return res.end(text);
      }
      res.writeHead(404); res.end();
    });
  });
  return { server, received };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function integrationTest() {
  const { server, received } = startStub();
  const port = await listen(server);
  try {
    const argv = [
      '--mode=serial', '--workspaceId=ws-int', '--supervisorId=sup-int',
      '--resume-lead-id=L1', '--resume-reviewer-id=R1', '--turn-timeout-ms=90000',
      `--api-port=${port}`, '--api-host=127.0.0.1',
    ];
    const { code, stdout } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => out += d);
      child.stderr.on('data', (d) => err += d);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
    });

    assert.equal(code, 0, 'shim exits 0 on a successful forward');
    assert.equal(received.length, 1, 'shim made exactly one POST /api/orchestrations');
    const body = received[0];
    assert.equal(body.name, 'groupthink');
    assert.equal(body.params.workspaceId, 'ws-int');
    assert.equal(body.params.supervisorId, 'sup-int');
    assert.match(body.params.legacyCommand, /--resume-lead-id=L1/);
    assert.match(body.params.legacyCommand, /--resume-reviewer-id=R1/);
    assert.match(stdout, /runId=run-xyz/, 'shim reports the runId back');
  } finally {
    server.close();
  }
}

(async () => {
  await test('buildRequest/parseArgs produce the expected POST body', unitTests);
  await test('shim subprocess POSTs the legacy command to /api/orchestrations', integrationTest);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
