#!/usr/bin/env node

/**
 * GroupThink Orchestration Script (v1 - Basic)
 * 
 * Drives a two-agent deliberation loop:
 * 1. Launches a Lead Planner (Agent A) and a Reviewer (Agent B).
 * 2. Relays messages between them with framing prose.
 * 3. Terminates when Agent A writes the final markdown plan file.
 * 4. Persists session IDs and adheres to the plan schema.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Configuration ---
const DEFAULT_PORTS = [24678, 24679, 24680, 24681];
const READY_STATUSES = new Set(['idle', 'waiting']);
const MAX_TURNS = 10;
const POLL_INTERVAL_MS = 2000;
const MIN_READY_POLLS = 3;

// --- State ---
const lastRelayedTs = {}; // agentId -> ISO timestamp

// --- Utils ---
function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {};
  const orphans = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      args[key] = value;
    } else {
      orphans.push(arg);
    }
  }
  if (orphans.length > 0) {
    log('WARN', `Ignored argv tokens (likely shell quote-stripping on a multi-word flag value — e.g. --topic="A B C" arriving as 3 tokens): ${JSON.stringify(orphans)}`);
  }
  return args;
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

// --- API Client ---
async function requestJson(base, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: base.host,
      port: base.port,
      path: apiPath,
      method,
      timeout: 60000,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : undefined,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => {
        let json = null;
        if (text) {
          try { json = JSON.parse(text); }
          catch (e) { json = null; }
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

// Send a terminal notification (groupthink.complete / groupthink.stalled) to the
// supervisor with retry-on-409. The dashboard's /input gate rejects POSTs when
// the target agent is in `working` state — see BUG-09 enforcement arm in
// src/main/database.ts. The supervisor's protective working latch can hold for
// minutes after it stops actually working, so a fire-and-forget POST is
// fragile. We poll until idle/waiting (or timeout) before each attempt and
// retry on transient 409s. On persistent failure we write a sentinel file so
// the result isn't silently lost; the supervisor (or a human) can recover it.
async function deliverToSupervisor(base, supervisorId, text, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 12;
  const intervalMs = opts.intervalMs ?? 5_000;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let supervisorStatus = null;
      try {
        const sup = await apiJson(base, 'GET', `/api/agents/${supervisorId}`);
        supervisorStatus = sup && sup.status;
      } catch (e) {
        // GET failures don't disqualify the attempt — fall through to POST.
        log('WARN', `Supervisor status fetch failed (attempt ${attempt}/${maxAttempts}): ${e.message}`);
      }
      if (supervisorStatus && !READY_STATUSES.has(supervisorStatus)) {
        log('INFO', `Supervisor not ready (status=${supervisorStatus}); waiting ${intervalMs}ms ` +
                    `(attempt ${attempt}/${maxAttempts})`);
        await sleep(intervalMs);
        continue;
      }
      await apiJson(base, 'POST', `/api/agents/${supervisorId}/input`, { text });
      if (attempt > 1) {
        log('INFO', `Supervisor delivery succeeded on attempt ${attempt}/${maxAttempts}`);
      }
      return { ok: true, attempts: attempt, elapsedMs: Date.now() - startedAt };
    } catch (err) {
      if (err && err.status === 409 && attempt < maxAttempts) {
        log('WARN', `Supervisor /input rejected with 409 (attempt ${attempt}/${maxAttempts}); ` +
                    `retrying in ${intervalMs}ms`);
        await sleep(intervalMs);
        continue;
      }
      // Non-409 error or out of attempts → write sentinel and surface failure.
      const sentinelDir = path.join('plans', '.runs');
      try { fs.mkdirSync(sentinelDir, { recursive: true }); } catch {}
      const sentinelPath = path.join(
        sentinelDir,
        `groupthink-undelivered-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      );
      const payload = {
        supervisorId,
        text,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        lastError: { status: err && err.status, message: err && err.message },
        capturedAt: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(sentinelPath, JSON.stringify(payload, null, 2));
        log('ERROR', `Supervisor delivery failed after ${attempt} attempts. ` +
                     `Sentinel written: ${sentinelPath}`);
      } catch (writeErr) {
        log('ERROR', `Supervisor delivery failed AND sentinel write failed: ${writeErr.message}`);
      }
      return { ok: false, attempts: attempt, elapsedMs: Date.now() - startedAt, sentinelPath };
    }
  }
  return { ok: false, attempts: maxAttempts, elapsedMs: Date.now() - startedAt };
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
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not connect to AgentDashboard API');
}

async function waitReady(base, agentId, label, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let readyCount = 0;
  while (Date.now() < deadline) {
    const agent = await apiJson(base, 'GET', `/api/agents/${agentId}`);
    if (READY_STATUSES.has(agent.status)) {
      readyCount++;
      if (readyCount >= MIN_READY_POLLS) return agent;
    } else {
      readyCount = 0;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout waiting for ${label} (${agentId})`);
}

async function waitReceiverReady(base, agentId, label, timeoutMs = 600000) {
  // BUG-17b: the /input endpoint returns HTTP 409 when the receiver is still
  // working/launching or has input-in-flight. Poll status until idle/waiting
  // before relaying so a slow receiver produces a clean stall (exit 2 with
  // resume_hint) instead of a 409 crash (exit 1, orphaned agents).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agent = await apiJson(base, 'GET', `/api/agents/${agentId}`);
    if (agent.status === 'crashed' || agent.status === 'done') {
      throw new Error(`${label} (${agentId}) exited with status=${agent.status} before accepting relay`);
    }
    if (READY_STATUSES.has(agent.status)) return agent;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`STALL: Timeout waiting for ${label} (${agentId}) to become ready for relay`);
}

async function readNextMessage(base, agentId) {
  const result = await apiJson(base, 'GET', `/api/agents/${agentId}/messages?limit=1&role=assistant`);
  const msg = result?.messages?.[0];
  if (!msg || !msg.turnComplete) return null;
  if (lastRelayedTs[agentId] && msg.ts <= lastRelayedTs[agentId]) return null; // stale
  return msg;
}

async function seedLastRelayedTsFromChat(base, agentId, label) {
  // BUG-06: on resume, the relay loop's lastRelayedTs map starts empty, so the
  // next poll treats any pre-existing turnComplete message as fresh and re-pastes
  // it to the other planner. Seed from the latest assistant message so Turn 1
  // waits for genuinely new content.
  const result = await apiJson(base, 'GET', `/api/agents/${agentId}/messages?limit=1&role=assistant`);
  const msg = result?.messages?.[0];
  if (msg && msg.turnComplete && msg.ts) {
    lastRelayedTs[agentId] = msg.ts;
    log('INFO', `Seeded lastRelayedTs[${label} ${agentId}] = ${msg.ts}`);
  } else {
    log('INFO', `No prior turnComplete message for ${label} ${agentId}; lastRelayedTs unseeded`);
  }
}

const STATUS_CHECK_INTERVAL_MS = 10000;

async function waitTurnComplete(base, agentId, label, timeoutMs = 600000) {
  // Source of truth: the message stream's `turnComplete` flag, not the agent's
  // status field. Status lags by minutes on some providers (codex especially)
  // while the chat-ingestion layer marks `turnComplete: true` the instant the
  // final assistant message lands. We poll messages directly and consult
  // status (a) as a hard-exit signal for crashed/done agents, and (b) to reset
  // the stall clock while the agent is demonstrably still working.
  //
  // BUG-03: a hardcoded 10-min stall produced false timeouts on slow reviewers.
  // With the post-M2A status latch, `agent.status === 'working'` is reliable
  // ground truth — we only declare stall after `timeoutMs` of continuous
  // non-working status with no new turnComplete message.
  let stallDeadline = Date.now() + timeoutMs;
  let lastStatusCheck = 0;
  while (true) {
    const msg = await readNextMessage(base, agentId);
    if (msg) return msg;

    const now = Date.now();
    if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL_MS) {
      lastStatusCheck = now;
      const agent = await apiJson(base, 'GET', `/api/agents/${agentId}`);
      if (agent.status === 'crashed' || agent.status === 'done') {
        throw new Error(`${label} (${agentId}) exited with status=${agent.status} before completing turn`);
      }
      if (agent.status === 'working') {
        stallDeadline = now + timeoutMs;
      }
    }

    if (Date.now() > stallDeadline) {
      // Final status check before declaring stall — agent may have transitioned
      // back to 'working' since our last sample.
      const agent = await apiJson(base, 'GET', `/api/agents/${agentId}`);
      lastStatusCheck = Date.now();
      if (agent.status === 'crashed' || agent.status === 'done') {
        throw new Error(`${label} (${agentId}) exited with status=${agent.status} before completing turn`);
      }
      if (agent.status === 'working') {
        stallDeadline = lastStatusCheck + timeoutMs;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(`Timeout waiting for ${label} (${agentId}) to complete turn (agent.status=${agent.status})`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// --- Main ---
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceId = args.workspaceId;
  const supervisorId = args.supervisorId;
  const topic = args.topic || "Research and plan a feature.";
  const planPath = args.planPath || "plans/new-plan.md";
  const turnTimeoutRaw = args['turn-timeout-ms'];
  const parsedTurnTimeout = turnTimeoutRaw === undefined ? NaN : Number(turnTimeoutRaw);
  const turnTimeoutMs = Number.isFinite(parsedTurnTimeout) && parsedTurnTimeout > 0
    ? parsedTurnTimeout
    : 600000;

  if (!workspaceId || !supervisorId) {
    console.error("Usage: groupthink.js --workspaceId=<id> --supervisorId=<id> [--topic=<topic>] [--planPath=<path>] [--turn-timeout-ms=<ms>] [--api-host=<host>] [--api-port=<port>]");
    process.exit(1);
  }

  log('INFO', `Per-turn timeout: ${turnTimeoutMs}ms${turnTimeoutRaw !== undefined ? ' (overridden via --turn-timeout-ms)' : ' (default)'}`);

  const base = await connectApi(resolveHost(args), candidatePorts(args));

  log('INFO', `Starting GroupThink on topic: ${topic}`);

  // 1. Launch or Resume Agents
  let leadAgentId = args['resume-lead-id'];
  let reviewerAgentId = args['resume-reviewer-id'];
  let lead, reviewer;

  if (leadAgentId) {
      lead = await apiJson(base, 'GET', `/api/agents/${leadAgentId}`);
      log('INFO', `Resuming Lead: ${lead.id}`);
      await seedLastRelayedTsFromChat(base, lead.id, 'Lead');
  } else {
      lead = await apiJson(base, 'POST', '/api/agents', {
        workspaceId,
        title: `Lead Planner (GroupThink)`,
        roleDescription: "Lead planner in charge of making the final call. You will receive feedback from a reviewer.",
        provider: args.leadProvider || 'claude',
        freshSession: true,
        systemPrompt: `You are the Lead Planner in a GroupThink deliberation.

Topic: ${topic}

You are working with a Reviewer agent. Each of your assistant turns will be relayed verbatim to the Reviewer as your message — put your actual draft plan, questions, or responses directly in your message body. Do not write meta-narration like "I'll now do X" or "I just finished Y" — produce the deliberation content itself.

Plan schema when you finalize: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Termination contract: write the plan file to ${planPath} ONLY after the Reviewer has explicitly approved the latest draft in their own message. The file-write ends the orchestration — a premature write terminates the deliberation before consensus.

Begin by producing your first draft of the plan as your next message.`
      });
      leadAgentId = lead.id;
      await seedLastRelayedTsFromChat(base, lead.id, 'Lead');
  }

  if (reviewerAgentId) {
      reviewer = await apiJson(base, 'GET', `/api/agents/${reviewerAgentId}`);
      log('INFO', `Resuming Reviewer: ${reviewer.id}`);
      await seedLastRelayedTsFromChat(base, reviewer.id, 'Reviewer');
  } else {
      reviewer = await apiJson(base, 'POST', '/api/agents', {
        workspaceId,
        title: `Reviewer (GroupThink)`,
        roleDescription: "Reviewer agent providing feedback to the Lead Planner.",
        provider: args.reviewerProvider || 'codex',
        freshSession: true,
        systemPrompt: `You are the Reviewer in a GroupThink deliberation.

Topic: ${topic}

You are working with a Lead Planner who is drafting a worker-ready plan. Each of your assistant turns will be relayed verbatim to the Lead as your message — put your critique, risk callouts, or approval directly in your message body. Do not write meta-narration about what you're about to do.

Review their drafts critically: point out risks, suggest better file paths or implementation details, push back on weak choices, and ensure the plan is robust.

Approval contract: the Lead is instructed NOT to finalize the plan file until you have explicitly approved the latest draft. When you approve, say so clearly in your message (e.g., "Approved — ready to finalize") so the Lead can act on it. Until then, keep iterating.

Wait for the Lead's first draft; your first message will be your response to it.`
      });
      reviewerAgentId = reviewer.id;
      await seedLastRelayedTsFromChat(base, reviewer.id, 'Reviewer');
  }

  log('INFO', `Active Lead: ${lead.id}, Reviewer: ${reviewer.id}`);

  // 2. Relay Loop — Lead is self-starting from its system prompt (topic baked in).
  let turn = 0;
  const members = {
      lead: { id: lead.id, sid: lead.resumeSessionId, provider: lead.provider },
      reviewer: { id: reviewer.id, sid: reviewer.resumeSessionId, provider: reviewer.provider }
  };

  try {
      while (turn < MAX_TURNS) {
        turn++;
        log('INFO', `--- Turn ${turn} ---`);

        // Lead -> Reviewer
        const leadMsg = await waitTurnComplete(base, lead.id, 'Lead', turnTimeoutMs);
        lastRelayedTs[lead.id] = leadMsg.ts;

        if (fs.existsSync(planPath)) {
            log('INFO', `Plan file detected at ${planPath}. Termination condition met.`);
            break;
        }
        log('INFO', `Relaying Lead -> Reviewer`);
        await waitReceiverReady(base, reviewer.id, 'Reviewer', turnTimeoutMs);
        await apiJson(base, 'POST', `/api/agents/${reviewer.id}/input`, {
            text: `Feedback from Lead Planner:\n\n${leadMsg.content}\n\nWhat is your review?`
        });

        // Reviewer -> Lead
        const revMsg = await waitTurnComplete(base, reviewer.id, 'Reviewer', turnTimeoutMs);
        lastRelayedTs[reviewer.id] = revMsg.ts;

        log('INFO', `Relaying Reviewer -> Lead`);
        await waitReceiverReady(base, lead.id, 'Lead', turnTimeoutMs);
        await apiJson(base, 'POST', `/api/agents/${lead.id}/input`, {
            text: `Reviewer Feedback:\n\n${revMsg.content}\n\nRespond to this feedback or finalize the plan.`
        });

        if (fs.existsSync(planPath)) {
            log('INFO', `Plan file detected at ${planPath}. Termination condition met.`);
            break;
        }
      }

      if (turn >= MAX_TURNS && !fs.existsSync(planPath)) {
          throw new Error("STALL: Max turns reached without plan completion.");
      }
  } catch (err) {
      if (err.message.startsWith("STALL") || err.message.includes("Timeout")) {
          log('WARN', `GroupThink stalled: ${err.message}`);
          const event = {
              reason: err.message.includes("Max turns") ? "turn_cap_reached"
                    : err.message.includes("ready for relay") ? "receiver_not_ready"
                    : "timeout",
              topic,
              turns: turn,
              planners: [
                  { role: "lead", ...members.lead },
                  { role: "reviewer", ...members.reviewer }
              ],
              planPath,
              resume_hint: `node scripts/groupthink-v1.js --workspaceId=${workspaceId} --supervisorId=${supervisorId} --resume-lead-id=${members.lead.id} --resume-reviewer-id=${members.reviewer.id} --topic="${topic}" --planPath="${planPath}" --turn-timeout-ms=${turnTimeoutMs}`
          };
          await deliverToSupervisor(
            base,
            supervisorId,
            `[DASHBOARD EVENT] orchestration.groupthink.stalled\n${JSON.stringify(event, null, 2)}`,
          );
          process.exit(2);
      }
      throw err;
  }

  // 4. Success & Cleanup
  log('INFO', `GroupThink complete. Members: ${members.lead.sid}, ${members.reviewer.sid}`);
  
  if (fs.existsSync(planPath)) {
      let content = fs.readFileSync(planPath, 'utf8');
      const sessionBlock = `\n\n<!-- groupthink_members: ${members.lead.sid}, ${members.reviewer.sid} -->\n`;
      if (!content.includes('groupthink_members:')) {
          fs.writeFileSync(planPath, content + sessionBlock);
      }
  }

  const deliveryResult = await deliverToSupervisor(
    base,
    supervisorId,
    `[DASHBOARD EVENT] groupthink.complete: Plan produced at ${planPath}. Members: ${members.lead.sid}, ${members.reviewer.sid}`,
  );
  if (!deliveryResult.ok) {
    log('ERROR', `Supervisor never received groupthink.complete (sentinel: ${deliveryResult.sentinelPath}). ` +
                 `Cleanup will proceed anyway so planners aren't orphaned.`);
  }

  if (!args.keepAgents) {
      try {
        await apiJson(base, 'DELETE', `/api/agents/${lead.id}`);
        await apiJson(base, 'DELETE', `/api/agents/${reviewer.id}`);
        log('INFO', "Agents cleaned up.");
      } catch (err) {
        log('WARN', `Planner cleanup failed (lead=${lead.id} reviewer=${reviewer.id}): ${err.message}. ` +
                    `Planners left alive; supervisor or user can clean up manually.`);
      }
  }
}

main().catch(err => {
  log('ERROR', err.stack || err);
  process.exit(1);
});
