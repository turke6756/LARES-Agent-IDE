#!/usr/bin/env node

/**
 * GroupThink Orchestration v2 — Serial + Parallel modes
 *
 * Modes:
 *   --mode=serial   (default) — Lead drafts, Reviewer reviews, Lead writes plan.
 *     Lead launches first; Reviewer launches AFTER Lead's first turnComplete
 *     with Lead's draft as its kickoff input. This sidesteps BUG-29: a
 *     freshly-launched Codex/Gemini agent that sits idle through the 35 s
 *     SQLite-discovery window falls through to a "newest cwd-match" recovery
 *     scan that binds it to a stale prior session. Delivering a real prompt
 *     at launch forces codex to flush session_meta inside the window so the
 *     primary discovery path binds correctly; gemini's new JSONL wins the
 *     cwd-newest race against any stale one.
 *
 *   --mode=parallel — Fan-out + cross-pollination + synthesis (3 rounds).
 *     R1: both planners draft independently from the same kickoff prompt.
 *     R2: each sees the other's R1 and reacts (agree / disagree / refine).
 *     R3: synthesizer (always the lead-provider, default claude) sees the
 *         other planner's R2, synthesizes, and writes the plan to disk.
 *     Same BUG-29 mitigation: every agent gets a real kickoff at launch.
 *
 * Provider routing:
 *   --leadProvider     default=claude. Lead in serial; synthesizer in parallel.
 *                      Claude is the only provider that writes plan files
 *                      reliably (codex/gemini lack a uniform file-write tool),
 *                      so the writer side should stay on claude.
 *   --reviewerProvider default=codex. Reviewer in serial; other planner in parallel.
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
const STATUS_CHECK_INTERVAL_MS = 10000;

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

// --- Idle / ready helpers ---
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
  throw new Error(`Timeout waiting for ${label} (${agentId}) to reach idle`);
}

async function waitReceiverReady(base, agentId, label, timeoutMs = 600000) {
  // BUG-17b: /input returns 409 while the receiver is launching/working/has
  // input-in-flight. Poll until idle/waiting before relaying so a slow
  // receiver produces a clean stall (exit 2 with resume_hint) rather than a
  // 409 crash (exit 1, orphaned agents).
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

// --- Message helpers ---
async function readNextMessage(base, agentId) {
  const result = await apiJson(base, 'GET', `/api/agents/${agentId}/messages?limit=1&role=assistant`);
  const msg = result?.messages?.[0];
  if (!msg || !msg.turnComplete) return null;
  if (lastRelayedTs[agentId] && msg.ts <= lastRelayedTs[agentId]) return null;
  return msg;
}

async function seedLastRelayedTsFromChat(base, agentId, label) {
  // BUG-06: on resume, lastRelayedTs starts empty, so the next poll treats any
  // pre-existing turnComplete message as fresh and re-relays it. Seed from the
  // latest assistant message so the first wait blocks on genuinely new content.
  const result = await apiJson(base, 'GET', `/api/agents/${agentId}/messages?limit=1&role=assistant`);
  const msg = result?.messages?.[0];
  if (msg && msg.turnComplete && msg.ts) {
    lastRelayedTs[agentId] = msg.ts;
    log('INFO', `Seeded lastRelayedTs[${label} ${agentId}] = ${msg.ts}`);
  } else {
    log('INFO', `No prior turnComplete message for ${label} ${agentId}; lastRelayedTs unseeded`);
  }
}

async function waitTurnComplete(base, agentId, label, timeoutMs = 600000) {
  // Source of truth: the message stream's `turnComplete` flag, not agent.status.
  // Status lags by minutes on some providers (codex especially) while the
  // chat-ingestion layer marks turnComplete the instant the final assistant
  // message lands. Status is consulted (a) as a hard-exit signal for
  // crashed/done agents and (b) to reset the stall clock while the agent is
  // demonstrably still working.
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

// --- Supervisor delivery ---
async function deliverToSupervisor(base, supervisorId, text, opts = {}) {
  // Terminal notifications retry on 409 (supervisor still in 'working' latch)
  // and fall through to a sentinel file on persistent failure so results aren't
  // silently lost. See v1 history (BUG-09 enforcement arm in src/main/database.ts).
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
        log('ERROR', `Supervisor delivery failed after ${attempt} attempts. Sentinel written: ${sentinelPath}`);
      } catch (writeErr) {
        log('ERROR', `Supervisor delivery failed AND sentinel write failed: ${writeErr.message}`);
      }
      return { ok: false, attempts: attempt, elapsedMs: Date.now() - startedAt, sentinelPath };
    }
  }
  return { ok: false, attempts: maxAttempts, elapsedMs: Date.now() - startedAt };
}

// --- Agent launch with kickoff ---
//
// Uniform launch contract: every agent gets a real kickoff prompt at launch
// time. For Claude, the dashboard delivers `systemPrompt` as an initial user
// message at process start (src/main/supervisor/index.ts:706). For
// Codex/Gemini, `systemPrompt` is stored on the agent record but NOT delivered
// — that's the BUG-29 idle-window hole. So for non-Claude providers we POST
// /input with the kickoff text after the agent reaches idle.
async function launchAgentWithKickoff(base, opts) {
  const { workspaceId, title, roleDescription, provider, kickoffPrompt } = opts;
  const isClaude = provider === 'claude';

  const launchBody = {
    workspaceId,
    title,
    roleDescription,
    provider,
    freshSession: true,
    // Supervised: ride the worker lane (hook-driven status) and emit
    // [DASHBOARD EVENT] status changes to the workspace supervisor — without
    // this the event-bridge drops the agent's idle/done events and the
    // supervisor never hears that a GroupThink member finished.
    isSupervised: true,
  };
  if (isClaude) {
    launchBody.systemPrompt = kickoffPrompt;
  }

  const agent = await apiJson(base, 'POST', '/api/agents', launchBody);
  log('INFO', `Launched ${title} (${agent.id}, provider=${provider})`);

  if (!isClaude) {
    // Wait for the agent to be ready before posting /input; the dashboard's
    // /input route returns 409 while the agent is in launching/working state.
    await waitReady(base, agent.id, title);
    await apiJson(base, 'POST', `/api/agents/${agent.id}/input`, { text: kickoffPrompt });
    log('INFO', `Delivered kickoff to ${title} (${agent.id}) via /input`);
  }

  await seedLastRelayedTsFromChat(base, agent.id, title);
  return agent;
}

// --- Prompt templates ---
function serialLeadPrompt(topic, planPath) {
  return `You are the Lead Planner in a GroupThink deliberation.

Topic: ${topic}

You are working with a Reviewer agent. Each of your assistant turns will be relayed verbatim to the Reviewer — put your actual draft plan, questions, or responses directly in your message body. Do not write meta-narration like "I'll now do X" or "I just finished Y" — produce the deliberation content itself.

Plan schema when you finalize: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Termination contract: write the plan file to ${planPath} ONLY after the Reviewer has explicitly approved the latest draft in their own message. The file-write ends the orchestration — a premature write terminates the deliberation before consensus.

Begin by producing your first draft of the plan as your next message.`;
}

function serialReviewerKickoff(topic, leadDraft) {
  return `You are the Reviewer in a GroupThink deliberation.

Topic: ${topic}

You are working with a Lead Planner who is drafting a worker-ready plan. Each of your assistant turns will be relayed verbatim to the Lead — put your critique, risk callouts, or approval directly in your message body. Do not write meta-narration about what you're about to do.

Review the Lead's drafts critically: point out risks, suggest better file paths or implementation details, push back on weak choices, and ensure the plan is robust.

Approval contract: the Lead is instructed NOT to finalize the plan file until you have explicitly approved the latest draft. When you approve, say so clearly in your message (e.g., "Approved — ready to finalize") so the Lead can act on it. Until then, keep iterating.

The Lead's first draft follows below. Respond with your initial review.

---

${leadDraft}`;
}

function parallelR1Prompt(topic) {
  return `You are one of two independent planners working in parallel on the same topic. Produce your strongest independent plan; you will see the other planner's draft afterward and have one round to compare notes before a synthesis turn.

Topic: ${topic}

Plan schema: file paths, specific edits, clear instructions a worker agent could execute without further questions.

Do not write meta-narration ("I'll now do X", "I just finished Y") — produce the plan content itself. Begin your draft now.`;
}

function parallelR2Prompt(otherR1) {
  return `The other planner produced this independent take on the same topic:

---

${otherR1}

---

Compare it to your own draft. Where do you agree? Where do you disagree, and why? Refine your view in light of their reasoning.

Do NOT write a final plan file yet — focus on engaging with the differences. A synthesis turn will follow.`;
}

function parallelSynthesisPrompt(otherR2, planPath) {
  return `Here is the other planner's reaction after seeing your initial draft and engaging with the differences:

---

${otherR2}

---

You now have full context: your initial draft, the other planner's initial take, and the other planner's reaction above. Synthesize.

Identify where you both agree. Identify where you disagree and pick the right middle ground with reasoning. Write the final consensus plan to ${planPath}.

Plan schema: file paths, specific edits, clear instructions a worker agent could execute without further questions. The file-write ends the orchestration.`;
}

// --- Mode: Serial ---
async function runSerial(base, ctx) {
  const { workspaceId, topic, planPath, leadProvider, reviewerProvider, turnTimeoutMs, resumeLeadId, resumeReviewerId } = ctx;

  let lead, reviewer;
  let firstLeadMsg = null;

  if (resumeLeadId) {
    lead = await apiJson(base, 'GET', `/api/agents/${resumeLeadId}`);
    log('INFO', `Resuming Lead: ${lead.id}`);
    await seedLastRelayedTsFromChat(base, lead.id, 'Lead');
  } else {
    lead = await launchAgentWithKickoff(base, {
      workspaceId,
      title: 'Lead Planner (GroupThink)',
      roleDescription: 'Lead planner in charge of making the final call. You will receive feedback from a reviewer.',
      provider: leadProvider,
      kickoffPrompt: serialLeadPrompt(topic, planPath),
    });
  }

  if (resumeReviewerId) {
    reviewer = await apiJson(base, 'GET', `/api/agents/${resumeReviewerId}`);
    log('INFO', `Resuming Reviewer: ${reviewer.id}`);
    await seedLastRelayedTsFromChat(base, reviewer.id, 'Reviewer');
  } else {
    // BUG-29 mitigation: wait for Lead's first draft before launching the
    // Reviewer, then launch with that draft as the kickoff. This guarantees
    // the Reviewer (especially codex/gemini) has a real prompt in hand at
    // launch — codex flushes session_meta inside the SQLite-discovery window,
    // gemini's new JSONL wins the cwd-newest race against any stale one.
    log('INFO', 'Waiting for Lead first draft before launching Reviewer (BUG-29 mitigation)...');
    firstLeadMsg = await waitTurnComplete(base, lead.id, 'Lead', turnTimeoutMs);
    lastRelayedTs[lead.id] = firstLeadMsg.ts;
    log('INFO', `Lead first draft received (${firstLeadMsg.content.length} chars); launching Reviewer with it as kickoff`);

    if (fs.existsSync(planPath)) {
      log('INFO', `Plan file already exists at ${planPath} after Lead turn 1 — terminating before Reviewer launch.`);
      return { lead, reviewer: null, turns: 1, planWritten: true };
    }

    reviewer = await launchAgentWithKickoff(base, {
      workspaceId,
      title: 'Reviewer (GroupThink)',
      roleDescription: 'Reviewer agent providing feedback to the Lead Planner.',
      provider: reviewerProvider,
      kickoffPrompt: serialReviewerKickoff(topic, firstLeadMsg.content),
    });
  }

  log('INFO', `Active Lead: ${lead.id}, Reviewer: ${reviewer.id}`);

  // Relay loop. If we're coming from a fresh launch we've already done Lead's
  // turn 1 and delivered it to the Reviewer as kickoff, so the loop starts at
  // "wait for Reviewer's response". If we're resuming, seedLastRelayedTs has
  // set both highwater marks and the loop's first wait blocks on whichever
  // side speaks next; we pick Reviewer-first as the canonical starting edge.
  let turn = firstLeadMsg ? 1 : 0; // count Lead turn 1 if we did it inline
  let planWritten = false;

  while (turn < MAX_TURNS) {
    turn++;
    log('INFO', `--- Turn ${turn} ---`);

    // Reviewer -> Lead
    const revMsg = await waitTurnComplete(base, reviewer.id, 'Reviewer', turnTimeoutMs);
    lastRelayedTs[reviewer.id] = revMsg.ts;

    if (fs.existsSync(planPath)) {
      log('INFO', `Plan file detected at ${planPath}. Termination condition met.`);
      planWritten = true;
      break;
    }
    log('INFO', 'Relaying Reviewer -> Lead');
    await waitReceiverReady(base, lead.id, 'Lead', turnTimeoutMs);
    await apiJson(base, 'POST', `/api/agents/${lead.id}/input`, {
      text: `Reviewer Feedback:\n\n${revMsg.content}\n\nRespond to this feedback or finalize the plan.`,
    });

    // Lead -> Reviewer
    const leadMsg = await waitTurnComplete(base, lead.id, 'Lead', turnTimeoutMs);
    lastRelayedTs[lead.id] = leadMsg.ts;

    if (fs.existsSync(planPath)) {
      log('INFO', `Plan file detected at ${planPath}. Termination condition met.`);
      planWritten = true;
      break;
    }
    log('INFO', 'Relaying Lead -> Reviewer');
    await waitReceiverReady(base, reviewer.id, 'Reviewer', turnTimeoutMs);
    await apiJson(base, 'POST', `/api/agents/${reviewer.id}/input`, {
      text: `Feedback from Lead Planner:\n\n${leadMsg.content}\n\nWhat is your review?`,
    });
  }

  if (!planWritten && turn >= MAX_TURNS) {
    throw new Error('STALL: Max turns reached without plan completion.');
  }

  return { lead, reviewer, turns: turn, planWritten };
}

// --- Mode: Parallel ---
async function runParallel(base, ctx) {
  const { workspaceId, topic, planPath, leadProvider, reviewerProvider, turnTimeoutMs } = ctx;

  // R1: both launch with the same prompt; we kick off in parallel.
  log('INFO', '--- Round 1: independent drafts ---');
  const r1Prompt = parallelR1Prompt(topic);
  const [synthesizer, peer] = await Promise.all([
    launchAgentWithKickoff(base, {
      workspaceId,
      title: `Synthesizer ${leadProvider} (GroupThink //)`,
      roleDescription: 'Independent planner; will synthesize the final plan in R3.',
      provider: leadProvider,
      kickoffPrompt: r1Prompt,
    }),
    launchAgentWithKickoff(base, {
      workspaceId,
      title: `Planner ${reviewerProvider} (GroupThink //)`,
      roleDescription: 'Independent planner contributing a cross-provider perspective.',
      provider: reviewerProvider,
      kickoffPrompt: r1Prompt,
    }),
  ]);
  log('INFO', `Synthesizer: ${synthesizer.id} (${leadProvider}); Peer: ${peer.id} (${reviewerProvider})`);

  log('INFO', 'Waiting for both R1 drafts...');
  const [synthR1, peerR1] = await Promise.all([
    waitTurnComplete(base, synthesizer.id, 'Synthesizer R1', turnTimeoutMs),
    waitTurnComplete(base, peer.id, 'Peer R1', turnTimeoutMs),
  ]);
  lastRelayedTs[synthesizer.id] = synthR1.ts;
  lastRelayedTs[peer.id] = peerR1.ts;
  log('INFO', `R1 complete. Synthesizer draft: ${synthR1.content.length} chars; Peer draft: ${peerR1.content.length} chars.`);

  // Plan-file termination check: if either agent wrote the plan prematurely
  // we treat that as accidental termination — log and return rather than
  // continue rounds that would clobber it.
  if (fs.existsSync(planPath)) {
    log('WARN', `Plan file exists at ${planPath} after R1 — terminating early (premature write).`);
    return { synthesizer, peer, round: 1, planWritten: true };
  }

  // R2: each sees the other's R1 and reacts (parallel).
  log('INFO', '--- Round 2: cross-pollination ---');
  await Promise.all([
    (async () => {
      await waitReceiverReady(base, synthesizer.id, 'Synthesizer', turnTimeoutMs);
      await apiJson(base, 'POST', `/api/agents/${synthesizer.id}/input`, {
        text: parallelR2Prompt(peerR1.content),
      });
    })(),
    (async () => {
      await waitReceiverReady(base, peer.id, 'Peer', turnTimeoutMs);
      await apiJson(base, 'POST', `/api/agents/${peer.id}/input`, {
        text: parallelR2Prompt(synthR1.content),
      });
    })(),
  ]);

  log('INFO', 'Waiting for both R2 reactions...');
  const [, peerR2] = await Promise.all([
    waitTurnComplete(base, synthesizer.id, 'Synthesizer R2', turnTimeoutMs),
    waitTurnComplete(base, peer.id, 'Peer R2', turnTimeoutMs),
  ]);
  // We only need the peer's R2 content for R3; the synthesizer's R2 is in
  // its own context already.
  lastRelayedTs[peer.id] = peerR2.ts;
  log('INFO', `R2 complete. Peer reaction: ${peerR2.content.length} chars.`);

  if (fs.existsSync(planPath)) {
    log('WARN', `Plan file exists at ${planPath} after R2 — terminating early (premature write).`);
    return { synthesizer, peer, round: 2, planWritten: true };
  }

  // R3: synthesizer-only. Hand it the peer's R2 with the synthesis + write-plan
  // instructions; wait for plan file or its turnComplete.
  log('INFO', '--- Round 3: synthesis + plan write ---');
  await waitReceiverReady(base, synthesizer.id, 'Synthesizer', turnTimeoutMs);
  await apiJson(base, 'POST', `/api/agents/${synthesizer.id}/input`, {
    text: parallelSynthesisPrompt(peerR2.content, planPath),
  });

  const synthR3 = await waitTurnComplete(base, synthesizer.id, 'Synthesizer R3', turnTimeoutMs);
  lastRelayedTs[synthesizer.id] = synthR3.ts;
  const planWritten = fs.existsSync(planPath);
  if (!planWritten) {
    throw new Error(`STALL: Synthesizer completed R3 but no plan file at ${planPath}.`);
  }
  log('INFO', `R3 complete. Plan written to ${planPath}.`);

  return { synthesizer, peer, round: 3, planWritten: true };
}

// --- Main ---
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = (args.mode || 'serial').toLowerCase();
  const workspaceId = args.workspaceId;
  const supervisorId = args.supervisorId;
  const topic = args.topic || 'Research and plan a feature.';
  // Resolve to absolute: the path is embedded verbatim in agent prompts, and
  // supervised agents run from the worker-lane cwd (.dashboard/workers/<p>/),
  // not from this script's cwd — a relative path would land in the wrong dir.
  const planPath = path.resolve(args.planPath || 'plans/new-plan.md');
  const leadProvider = args.leadProvider || 'claude';
  const reviewerProvider = args.reviewerProvider || 'codex';
  const turnTimeoutRaw = args['turn-timeout-ms'];
  const parsedTurnTimeout = turnTimeoutRaw === undefined ? NaN : Number(turnTimeoutRaw);
  const turnTimeoutMs = Number.isFinite(parsedTurnTimeout) && parsedTurnTimeout > 0
    ? parsedTurnTimeout
    : 600000;

  if (!workspaceId || !supervisorId) {
    console.error('Usage: groupthink-v2.js --mode=serial|parallel --workspaceId=<id> --supervisorId=<id> ' +
                  '[--topic=<topic>] [--planPath=<path>] [--leadProvider=<p>] [--reviewerProvider=<p>] ' +
                  '[--turn-timeout-ms=<ms>] [--api-host=<host>] [--api-port=<port>] ' +
                  '[--resume-lead-id=<id>] [--resume-reviewer-id=<id>] [--keepAgents]');
    process.exit(1);
  }

  if (mode !== 'serial' && mode !== 'parallel') {
    console.error(`Unknown --mode=${mode}; expected serial or parallel.`);
    process.exit(1);
  }

  if (mode === 'parallel' && (args['resume-lead-id'] || args['resume-reviewer-id'])) {
    console.error('Parallel mode does not currently support --resume-* flags. Re-run from scratch.');
    process.exit(1);
  }

  if (leadProvider !== 'claude') {
    log('WARN', `leadProvider=${leadProvider} (non-claude). The plan-writer side relies on a uniform file-write tool; ` +
                `expect failure if this provider can't write files.`);
  }

  log('INFO', `Mode: ${mode}. Per-turn timeout: ${turnTimeoutMs}ms` +
              `${turnTimeoutRaw !== undefined ? ' (overridden via --turn-timeout-ms)' : ' (default)'}`);
  log('INFO', `Topic: ${topic}`);
  log('INFO', `Plan path: ${planPath}`);
  log('INFO', `Providers: lead=${leadProvider}, reviewer=${reviewerProvider}`);

  const base = await connectApi(resolveHost(args), candidatePorts(args));

  const ctx = {
    workspaceId,
    topic,
    planPath,
    leadProvider,
    reviewerProvider,
    turnTimeoutMs,
    resumeLeadId: args['resume-lead-id'],
    resumeReviewerId: args['resume-reviewer-id'],
  };

  let result;
  let agentsForStallReport = { lead: null, reviewer: null };
  try {
    if (mode === 'serial') {
      result = await runSerial(base, ctx);
      agentsForStallReport.lead = result.lead;
      agentsForStallReport.reviewer = result.reviewer;
    } else {
      result = await runParallel(base, ctx);
      agentsForStallReport.lead = result.synthesizer;
      agentsForStallReport.reviewer = result.peer;
    }
  } catch (err) {
    if (err.message.startsWith('STALL') || err.message.includes('Timeout')) {
      log('WARN', `GroupThink stalled: ${err.message}`);
      const lead = agentsForStallReport.lead;
      const reviewer = agentsForStallReport.reviewer;
      const event = {
        mode,
        reason: err.message.includes('Max turns') ? 'turn_cap_reached'
              : err.message.includes('ready for relay') ? 'receiver_not_ready'
              : err.message.includes('no plan file') ? 'no_plan_written'
              : 'timeout',
        topic,
        planPath,
        message: err.message,
        planners: [
          lead ? { role: mode === 'serial' ? 'lead' : 'synthesizer', id: lead.id, sid: lead.resumeSessionId, provider: lead.provider } : null,
          reviewer ? { role: mode === 'serial' ? 'reviewer' : 'peer', id: reviewer.id, sid: reviewer.resumeSessionId, provider: reviewer.provider } : null,
        ].filter(Boolean),
        resume_hint: mode === 'serial' && lead && reviewer
          ? `node scripts/groupthink-v2.js --mode=serial --workspaceId=${workspaceId} --supervisorId=${supervisorId} ` +
            `--resume-lead-id=${lead.id} --resume-reviewer-id=${reviewer.id} ` +
            `--topic=${JSON.stringify(topic)} --planPath=${JSON.stringify(planPath)} --turn-timeout-ms=${turnTimeoutMs}`
          : null,
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

  // Success + cleanup
  const lead = agentsForStallReport.lead;
  const reviewer = agentsForStallReport.reviewer;
  const leadSid = lead?.resumeSessionId ?? 'n/a';
  const reviewerSid = reviewer?.resumeSessionId ?? 'n/a';
  log('INFO', `GroupThink complete. Members: ${leadSid}, ${reviewerSid}`);

  if (fs.existsSync(planPath)) {
    const content = fs.readFileSync(planPath, 'utf8');
    const sessionBlock = `\n\n<!-- groupthink_members: ${leadSid}, ${reviewerSid} (mode=${mode}) -->\n`;
    if (!content.includes('groupthink_members:')) {
      fs.writeFileSync(planPath, content + sessionBlock);
    }
  }

  const deliveryResult = await deliverToSupervisor(
    base,
    supervisorId,
    `[DASHBOARD EVENT] groupthink.complete (mode=${mode}): Plan at ${planPath}. Members: ${leadSid}, ${reviewerSid}`,
  );
  if (!deliveryResult.ok) {
    log('ERROR', `Supervisor never received groupthink.complete (sentinel: ${deliveryResult.sentinelPath}). ` +
                 `Cleanup will proceed anyway so planners aren't orphaned.`);
  }

  if (!args.keepAgents) {
    for (const agent of [lead, reviewer]) {
      if (!agent) continue;
      try {
        await apiJson(base, 'DELETE', `/api/agents/${agent.id}`);
        log('INFO', `Cleaned up ${agent.id}.`);
      } catch (err) {
        log('WARN', `Cleanup failed for ${agent.id}: ${err.message}. Left alive; supervisor can clean up manually.`);
      }
    }
  }
}

main().catch(err => {
  log('ERROR', err.stack || err);
  process.exit(1);
});
