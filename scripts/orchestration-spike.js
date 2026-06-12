#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PORTS = [24678, 24679, 24680, 24681];
const ACTIVE_STATUSES = new Set(['launching', 'working', 'idle', 'waiting', 'restarting']);
const READY_STATUSES = new Set(['idle', 'waiting']);

const rootDir = process.cwd();
const promptDir = path.join(rootDir, 'scripts', 'spike-prompts');
// Plan lives at repo root, not under `.claude/`, because Claude Code's
// permission system gates edits inside `.claude/` even with bypass-permissions
// on (settings live there, so the harness asks for confirmation regardless of
// the permission mode). That confirmation dialog blocks the worker fork mid-
// task — the spike is non-interactive, so any prompt is a hang.
const planPath = path.join(rootDir, 'spike-hello-world.md');
const runsDir = path.join(rootDir, '.claude', 'plans', 'runs');
const helloPath = path.join(rootDir, 'hello.py');

let logPath = null;
let quiet = false;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    if (key === 'keep-agents' || key === 'quiet') {
      args[key] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

function ensureLog(runId) {
  fs.mkdirSync(runsDir, { recursive: true });
  logPath = path.join(runsDir, `spike-${runId}.log`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] [INFO] Run log initialized\n`);
}

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (logPath) fs.appendFileSync(logPath, `${line}\n`);
  if (!quiet) console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME) || os.release().toLowerCase().includes('microsoft');
}

function readWslHost() {
  if (!isWsl()) return null;
  try {
    const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
    const match = resolv.match(/^nameserver\s+(\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function resolveHost(args) {
  return args['api-host'] || process.env.AGENT_DASHBOARD_API_HOST || readWslHost() || '127.0.0.1';
}

function candidatePorts(args) {
  const ports = [];
  if (args['api-port']) ports.push(Number(args['api-port']));
  for (const port of DEFAULT_PORTS) ports.push(port);
  return ports.filter((port, index, all) => Number.isInteger(port) && port > 0 && all.indexOf(port) === index);
}

// WP0.2 (M1): per-launch bearer token for the dashboard API. Fail closed.
const API_TOKEN = process.env.AGENT_DASHBOARD_API_TOKEN;
if (!API_TOKEN) {
  console.error('[orchestration-spike] FATAL: AGENT_DASHBOARD_API_TOKEN env var is required (set by the dashboard at launch)');
  process.exit(1);
}

function requestJson(base, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: base.host,
      port: base.port,
      path: apiPath,
      method,
      timeout: 60000,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let json = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out: ${method} ${apiPath}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function apiJson(base, method, apiPath, body) {
  const res = await requestJson(base, method, apiPath, body);
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`${method} ${apiPath} failed with HTTP ${res.status}: ${res.text}`);
    err.status = res.status;
    err.body = res.text;
    throw err;
  }
  return res.json;
}

async function connectApi(host, ports) {
  let lastError = null;
  for (const port of ports) {
    const base = { host, port };
    try {
      const res = await requestJson(base, 'GET', '/api/agents');
      if (res.status >= 200 && res.status < 300 && Array.isArray(res.json)) {
        log('INFO', `Connected to AgentDashboard API at http://${host}:${port}`);
        return base;
      }
      lastError = new Error(`HTTP ${res.status}: ${res.text}`);
      log('WARN', `API probe failed at http://${host}:${port}: HTTP ${res.status} ${res.text}`);
    } catch (err) {
      lastError = err;
      log('WARN', `API probe failed at http://${host}:${port}: ${err.message}`);
    }
  }
  throw lastError || new Error('Could not connect to AgentDashboard API');
}

function active(agent) {
  return agent && ACTIVE_STATUSES.has(agent.status);
}

async function emitEvent(base, supervisorId, label) {
  const text = `[DASHBOARD EVENT] ${label}`;
  for (let attempt = 1; attempt <= 7; attempt++) {
    const res = await requestJson(base, 'POST', `/api/agents/${encodeURIComponent(supervisorId)}/input`, { text })
      .catch((err) => ({ status: 0, text: err.message, json: null }));
    if (res.status >= 200 && res.status < 300) {
      log('INFO', `Delivered event: ${label}`);
      return true;
    }

    log('WARN', `Event delivery failed (attempt ${attempt}) for "${label}": HTTP ${res.status} ${res.text}`);
    if (res.status !== 409 || attempt === 7) break;
    await sleep(5000);
  }

  log('ERROR', `Non-fatal event delivery failure: ${label}`);
  return false;
}

async function sendPeerInput(base, agentId, text, options = {}) {
  const attempts = options.attempts || 4;
  const backoffMs = options.backoffMs || 2000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await requestJson(base, 'POST', `/api/agents/${encodeURIComponent(agentId)}/input`, { text })
      .catch((err) => ({ status: 0, text: err.message, json: null }));
    if (res.status >= 200 && res.status < 300) {
      return;
    }

    log('WARN', `Peer input failed for ${agentId} (attempt ${attempt}): HTTP ${res.status} ${res.text}`);
    if (res.status !== 409 || attempt === attempts) {
      const err = new Error(`Could not send input to ${agentId}: HTTP ${res.status} ${res.text}`);
      err.status = res.status;
      throw err;
    }
    await sleep(backoffMs);
  }
}

async function waitReady(base, agentId, label, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  let readyPolls = 0;
  const minReadyPolls = options.minReadyPolls || 1;
  const pollMs = options.pollMs || 2000;
  const requireOutput = Boolean(options.requireOutput);

  while (Date.now() < deadline) {
    const agent = await apiJson(base, 'GET', `/api/agents/${encodeURIComponent(agentId)}`);
    lastStatus = agent.status;
    if (READY_STATUSES.has(agent.status)) {
      if (!requireOutput || agent.lastOutputAt) {
        readyPolls++;
        if (readyPolls >= minReadyPolls) {
          log('INFO', `${label} is ${agent.status} after ${readyPolls} ready poll(s)`);
          return agent;
        }
      }
    } else {
      readyPolls = 0;
    }
    if (agent.status === 'crashed' || agent.status === 'done') {
      throw new Error(`${label} entered terminal status "${agent.status}"`);
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for ${label} to become idle/waiting; last status was ${lastStatus}`);
}

function scrubAnsi(text) {
  return String(text || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+$/gm, '');
}

async function readAgentLog(base, agentId, lines) {
  const result = await apiJson(base, 'GET', `/api/agents/${encodeURIComponent(agentId)}/log?lines=${lines}`);
  return scrubAnsi(result && result.log ? result.log : '');
}

function tailText(text, maxChars) {
  const trimmed = scrubAnsi(text).trim();
  return trimmed.length > maxChars ? trimmed.slice(trimmed.length - maxChars) : trimmed;
}

function loadPrompt(name) {
  return fs.readFileSync(path.join(promptDir, name), 'utf8').trim();
}

async function launchAgent(base, input) {
  const agent = await apiJson(base, 'POST', '/api/agents', input);
  log('INFO', `Launched ${input.title} (${agent.id}, provider=${agent.provider})`);
  return agent;
}

function writePlan(runId) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  const content = [
    '# Spike Hello World Plan',
    '',
    `Run: ${runId}`,
    '',
    '## Phase 1',
    '',
    "- [ ] Create `hello.py` with exactly `print('Hello, world!')`.",
    '',
    '<!-- notes: phase-1 -->',
    '<!-- /notes -->',
    '',
  ].join('\n');
  fs.writeFileSync(planPath, content, 'utf8');
  log('INFO', `Wrote plan ${planPath}`);
}

function verifyArtifacts() {
  const failures = [];
  if (!fs.existsSync(helloPath)) {
    failures.push('hello.py does not exist');
  } else {
    const hello = fs.readFileSync(helloPath, 'utf8');
    if (hello !== "print('Hello, world!')") {
      failures.push(`hello.py contents were ${JSON.stringify(hello)}, expected exactly "print('Hello, world!')"`);
    }
  }

  if (!fs.existsSync(planPath)) {
    failures.push('plan file does not exist');
  } else {
    const plan = fs.readFileSync(planPath, 'utf8');
    if (!/- \[x\] .*hello\.py/.test(plan)) failures.push('phase-1 checkbox is not checked');
    const notes = plan.match(/<!-- notes: phase-1 -->([\s\S]*?)<!-- \/notes -->/);
    if (!notes || !notes[1].trim()) failures.push('phase-1 notes block was not updated');
  }

  if (failures.length) {
    throw new Error(`Artifact verification failed: ${failures.join('; ')}`);
  }
  log('INFO', 'Artifact verification passed');
}

async function cleanupAgents(base, agentIds) {
  const failures = [];
  for (const id of agentIds.filter(Boolean)) {
    try {
      await apiJson(base, 'DELETE', `/api/agents/${encodeURIComponent(id)}`);
      log('INFO', `Stopped agent ${id}`);
    } catch (err) {
      failures.push(`${id}: ${err.message}`);
      log('WARN', `Cleanup failed for ${id}: ${err.message}`);
    }
  }
  return failures;
}

async function validateSupervisor(base, workspaceId, supervisorId) {
  const supervisor = await apiJson(base, 'GET', `/api/agents/${encodeURIComponent(supervisorId)}`);
  if (!supervisor.isSupervisor) throw new Error(`${supervisorId} is not a supervisor`);
  if (supervisor.workspaceId !== workspaceId) {
    throw new Error(`${supervisorId} belongs to workspace ${supervisor.workspaceId}, not ${workspaceId}`);
  }

  const agents = await apiJson(base, 'GET', `/api/agents?workspaceId=${encodeURIComponent(workspaceId)}`);
  const supervisors = agents.filter((agent) => agent.isSupervisor && active(agent));
  if (supervisors.length !== 1 || supervisors[0].id !== supervisorId) {
    throw new Error(`Expected exactly one active supervisor for workspace ${workspaceId}, found ${supervisors.length}`);
  }

  log('INFO', `Validated supervisor ${supervisorId} for workspace ${workspaceId}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  quiet = Boolean(args.quiet);

  const runId = args['run-id'] || makeRunId();
  ensureLog(runId);

  const workspaceId = args['workspace-id'];
  const supervisorId = args['supervisor-id'];
  const keepAgents = Boolean(args['keep-agents']);
  const task = args.task || "Create a trivial hello.py file that prints Hello, world! and update the spike plan.";
  const launched = [];
  let base = null;
  let cleaned = false;

  if (!workspaceId) throw new Error('Missing required --workspace-id');
  if (!supervisorId) throw new Error('Missing required --supervisor-id');

  try {
    const plannerPrompt = loadPrompt('planner.md');
    const workerPrompt = loadPrompt('worker.md');
    const host = resolveHost(args);
    const ports = candidatePorts(args);

    log('INFO', 'Phase A: validating API, supervisor, and workspace');
    base = await connectApi(host, ports);
    await validateSupervisor(base, workspaceId, supervisorId);

    log('INFO', 'Phase B: launching planners');
    const alpha = await launchAgent(base, {
      workspaceId,
      title: `Spike Planner Alpha ${runId}`,
      roleDescription: 'Disposable orchestration spike Claude planner',
      provider: 'claude',
      isSupervised: false,
      autoRestartEnabled: false,
      systemPrompt: plannerPrompt,
    });
    launched.push(alpha.id);

    const beta = await launchAgent(base, {
      workspaceId,
      title: `Spike Planner Beta ${runId}`,
      roleDescription: 'Disposable orchestration spike Codex planner',
      provider: 'codex',
      isSupervised: false,
      autoRestartEnabled: false,
    });
    launched.push(beta.id);

    await emitEvent(base, supervisorId, 'Spike: planners launched');
    // Require sustained idle. Claude Code's startup briefly transitions through
    // 'idle' between 'launching' and the first prompt-UI burst — minReadyPolls:
    // 1 catches that gap and lets sendPeerInput race the harness, hitting 409.
    // 3 polls × 2s = 6s of stable idle is well past the startup output window.
    const launchWaitOpts = { minReadyPolls: 3, pollMs: 2000 };
    await waitReady(base, alpha.id, 'Alpha planner', 240000, launchWaitOpts);
    await waitReady(base, beta.id, 'Beta planner', 240000, launchWaitOpts);

    await sendPeerInput(base, alpha.id, `Task for planner:\n${task}\n\nReturn a concise Phase 1 plan. Use the CONSENSUS protocol only after reviewing peer feedback.`);
    await sendPeerInput(base, beta.id, `${plannerPrompt}\n\n---\n\nTask for planner:\n${task}\n\nReturn a concise Phase 1 plan. Use the CONSENSUS protocol only after reviewing peer feedback.`);
    // Same reasoning post-task: an agent that finishes a tool call may briefly
    // read 'idle' before the next thinking burst. Require sustained idle.
    const turnWaitOpts = { minReadyPolls: 3, pollMs: 2000 };
    await waitReady(base, alpha.id, 'Alpha planner after task', 600000, turnWaitOpts);
    await waitReady(base, beta.id, 'Beta planner after task', 600000, turnWaitOpts);

    log('INFO', 'Phase C: consensus exchange');
    const alphaLog = await readAgentLog(base, alpha.id, 200);
    await sendPeerInput(base, beta.id, [
      'Review this tail from Alpha planner.',
      'If you agree that the spike should write the fixed plan and fork Alpha into a worker, include the literal word CONSENSUS.',
      '',
      tailText(alphaLog, 5000),
    ].join('\n'));
    await waitReady(base, beta.id, 'Beta planner after Alpha review', 600000, turnWaitOpts);

    const betaLog = await readAgentLog(base, beta.id, 240);
    const consensus = /\bCONSENSUS\b/.test(betaLog);
    log('INFO', `Consensus token observed in Beta log: ${consensus}`);
    await sendPeerInput(base, alpha.id, [
      `Beta consensus token observed: ${consensus}`,
      'Here is the Beta planner tail. Acknowledge briefly. The orchestrator will continue even if consensus is absent.',
      '',
      tailText(betaLog, 5000),
    ].join('\n'));
    await waitReady(base, alpha.id, 'Alpha planner after Beta mirror', 600000, turnWaitOpts);
    await emitEvent(base, supervisorId, 'Spike: consensus check complete');

    log('INFO', 'Phase D: writing plan');
    writePlan(runId);
    await emitEvent(base, supervisorId, 'Spike: plan written');

    log('INFO', 'Phase E: forking Alpha into worker');
    const worker = await apiJson(base, 'POST', `/api/agents/${encodeURIComponent(alpha.id)}/fork`);
    launched.push(worker.id);
    log('INFO', `Forked Alpha into worker ${worker.id}`);
    await waitReady(base, worker.id, 'Worker fork', 240000, {
      minReadyPolls: 5,
      pollMs: 1000,
      requireOutput: true,
    });
    await sendPeerInput(base, worker.id, [
      workerPrompt,
      '',
      `Run ID: ${runId}`,
      `Plan path: ${planPath}`,
      `Target file: ${helloPath}`,
    ].join('\n'), { attempts: 15, backoffMs: 2000 });
    await waitReady(base, worker.id, 'Worker fork after execution', 600000, turnWaitOpts);
    verifyArtifacts();
    await emitEvent(base, supervisorId, 'Spike: phase-1 done');

    log('INFO', 'Phase F: cleanup');
    let cleanupFailures = [];
    if (keepAgents) {
      log('INFO', 'Skipping cleanup because --keep-agents was set');
    } else {
      cleanupFailures = await cleanupAgents(base, launched.slice().reverse());
      cleaned = true;
    }

    const cleanupSummary = keepAgents
      ? 'agents kept'
      : cleanupFailures.length
        ? `cleanup failures: ${cleanupFailures.join(' | ')}`
        : 'cleanup succeeded';
    await emitEvent(base, supervisorId, `Spike: complete (${cleanupSummary})`);
    log('INFO', `Phase F complete: ${cleanupSummary}`);
    process.exitCode = 0;
  } catch (err) {
    log('ERROR', err && err.stack ? err.stack : String(err));
    if (base && supervisorId) {
      await emitEvent(base, supervisorId, `Spike: aborted (${err.message || String(err)})`);
    }
    if (base && !keepAgents && !cleaned && launched.length) {
      await cleanupAgents(base, launched.slice().reverse());
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log('ERROR', err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
