// Lares orchestration — fixed-core HTTP client (Node.js, ESM).
//
// This module is the FIXED CORE. It implements the invariant lifecycle from
// `OrchestrationScriptStructure.md` §2 and the attribution contract of §1. Do NOT
// edit helper bodies except transport/storage/error/packaging adaptation (which
// requires re-running validation). Per-workflow policy lives in the SHAPE
// templates (dispatcher.mjs, control-skeleton.mjs), never here.
//
// Fixed-core symbols (normative §5 + §2, verbatim across languages):
//   connectApi, launchAgent, waitReady, seedHighwater, confirmedSend, kickoff,
//   waitTurnComplete, waitReceiverReady, relay, markRelayed, verifyArtifact,
//   retire, reconcile, plus the composite `highwater` (ts+hash).
//
// This file carries NO customization markers — it is pure fixed core.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const intEnv = (name, dflt) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
};

// ── Tunable bounds (bounded everything — §6). Test overrides via env. ─────────
export const POLL_MS = intEnv('LARES_POLL_MS', 500);
export const READY_TIMEOUT_MS = intEnv('LARES_READY_TIMEOUT_MS', 120_000);
export const SOFT_STALL_MS = intEnv('LARES_SOFT_STALL_MS', 90_000);
export const HARD_DEADLINE_MS = intEnv('LARES_HARD_DEADLINE_MS', 600_000);
export const MAX_409_RETRIES = intEnv('LARES_MAX_409_RETRIES', 8);
export const MAX_SUBMIT_RECOVERY = intEnv('LARES_MAX_SUBMIT_RECOVERY', 3);
export const FLUSH_GRACE_MS = intEnv('LARES_FLUSH_GRACE_MS', 1500);
export const SUPERVISOR_409_RETRIES = intEnv('LARES_SUPERVISOR_409_RETRIES', 8);
// §1.1 standalone-only probe literals (used only in connectApi's standalone branch).
export const STANDALONE_PORT_RANGE = [24678, 24679, 24680, 24681];

// Exit-code convention (CLI templates, §2 step 11): 0 ok · 2 stall · 1 crash.
export const EXIT_OK = 0, EXIT_STALL = 2, EXIT_CRASH = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

export class LaresError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── Composite highwater (§2 step 5; anti-pattern: timestamp-only) ─────────────
export class Highwater {
  constructor(ts, hash) { this.ts = ts; this.hash = hash; }
  static of(message) {
    const content = message?.content ?? '';
    const ts = String(message?.timestamp ?? message?.createdAt ?? '');
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    return new Highwater(ts, hash);
  }
  // True when `message` is strictly newer than this highwater. Same ts +
  // different hash counts as newer (composite), which timestamp-only misses.
  isOlderThan(message) {
    const other = Highwater.of(message);
    if (other.ts !== this.ts) return other.ts > this.ts;
    return other.hash !== this.hash;
  }
  toString() { return `${this.ts}|${this.hash}`; }
}

export class LaresClient {
  constructor(baseUrl, token, { selfId, workspaceId, supervisorId, projectId, standalone } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.selfId = selfId ?? null;
    this.workspaceId = workspaceId ?? null;
    this.supervisorId = supervisorId ?? null;
    this.projectId = projectId ?? null;
    this.standalone = !!standalone;
  }

  // -- transport --------------------------------------------------------------
  headers(hasBody) {
    // §1.2 four concerns: auth on EVERY request; scope headers only when present;
    // X-Self-Id is provenance ONLY (never scope/ownership).
    const h = { Authorization: `Bearer ${this.token}` };
    if (hasBody) h['Content-Type'] = 'application/json';
    if (this.selfId) h['X-Self-Id'] = this.selfId;
    if (this.workspaceId) h['X-Workspace-Id'] = this.workspaceId;
    if (this.supervisorId) h['X-Supervisor-Id'] = this.supervisorId;
    if (this.projectId) h['X-Project-Id'] = this.projectId;
    return h;
  }

  async request(method, p, body) {
    const res = await fetch(this.baseUrl + p, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    if (!res.ok) {
      let code;
      try { code = JSON.parse(raw).code; } catch { /* non-JSON body */ }
      throw new LaresError(`HTTP ${res.status} ${method} ${p}: ${raw.slice(0, 200)}`, res.status, code);
    }
    return raw ? JSON.parse(raw) : null;
  }

  // -- 1. connectApi (§2 step 1) ---------------------------------------------
  static async connectApi() {
    const token = process.env.AGENT_DASHBOARD_API_TOKEN;
    const host = process.env.AGENT_DASHBOARD_API_HOST || '127.0.0.1';
    const workspaceId = process.env.AGENT_DASHBOARD_WORKSPACE_ID;
    const selfId = process.env.AGENT_DASHBOARD_SELF_ID;
    const supervisorId = process.env.AGENT_DASHBOARD_SUPERVISOR_ID;
    const projectId = process.env.AGENT_DASHBOARD_PROJECT_ID;
    const injectedPort = process.env.AGENT_DASHBOARD_API_PORT;

    if (injectedPort) {
      // On-behalf mode — fail closed on missing attribution (§1.1).
      if (!token) throw new LaresError('on-behalf mode: AGENT_DASHBOARD_API_TOKEN required');
      if (!workspaceId) throw new LaresError('on-behalf mode: AGENT_DASHBOARD_WORKSPACE_ID required');
      if (!selfId) {
        throw new LaresError('on-behalf mode: AGENT_DASHBOARD_SELF_ID missing — refusing to '
          + 'launch UNOWNED agents (attribution contract §1.1)');
      }
      const client = new LaresClient(`http://${host}:${injectedPort}`, token,
        { selfId, workspaceId, supervisorId, projectId });
      await client.probe();
      return client;
    }

    // Standalone mode — deliberate, logged; range-probe is allowed ONLY here.
    if (!token) throw new LaresError('standalone mode: AGENT_DASHBOARD_API_TOKEN required');
    for (const port of STANDALONE_PORT_RANGE) {
      const candidate = new LaresClient(`http://${host}:${port}`, token,
        { selfId, workspaceId, supervisorId, projectId, standalone: true });
      try {
        await candidate.probe();
        process.stderr.write(`[connectApi] standalone: bound port ${port}\n`);
        return candidate;
      } catch { /* try next port */ }
    }
    throw new LaresError(`standalone: no Lares API on ports ${STANDALONE_PORT_RANGE}`);
  }

  async probe() {
    const agents = await this.request('GET', '/api/agents');
    if (!Array.isArray(agents)) throw new LaresError('GET /api/agents did not return a JSON array');
  }

  // -- 3. launchAgent (§2 step 3, payload §1.3/§1.4) -------------------------
  async launchAgent(payload) {
    // NO task prompt goes here (§0.2); the kickoff is delivered post-launch via
    // confirmed /input.
    const body = { ...payload };
    if (body.workspaceId === undefined) body.workspaceId = this.workspaceId;
    // Forward SELF_ID verbatim as the ownership edge — safe to over-send; the
    // server re-validates and drops a stale/foreign edge, never throws (§1.4).
    if (this.selfId && body.owner_agent_id === undefined && body.ownerAgentId === undefined) {
      body.owner_agent_id = this.selfId;
    }
    return this.request('POST', '/api/agents', body);
  }

  // -- 4. waitReady (§2 step 4) ----------------------------------------------
  async waitReady(agentId) {
    const deadline = nowMs() + READY_TIMEOUT_MS;
    while (nowMs() < deadline) {
      const agent = await this.getAgent(agentId);
      if (agent === null) throw new LaresError(`waitReady: agent ${agentId} disappeared`);
      const { status } = agent;
      if (status === 'idle' || status === 'waiting') return agent;
      if (status === 'done' || status === 'crashed') {
        throw new LaresError(`waitReady: agent ${agentId} terminal (${status})`);
      }
      await sleep(POLL_MS);
    }
    throw new LaresError(`waitReady: timeout for ${agentId}`);
  }

  async getAgent(agentId) {
    try {
      return await this.request('GET', `/api/agents/${agentId}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async newestAssistant(agentId) {
    const msgs = await this.request('GET', `/api/agents/${agentId}/messages?limit=1&role=assistant`);
    return Array.isArray(msgs) && msgs.length ? msgs[0] : null;
  }

  // -- 5. seedHighwater (§2 step 5) ------------------------------------------
  async seedHighwater(agentId, { persisted = null } = {}) {
    // On RESUME, preserve the persisted highwater — reseeding a valid one
    // re-stalls the run (BUG-06/BUG-37).
    if (persisted !== null) return persisted;
    const newest = await this.newestAssistant(agentId);
    return newest === null ? new Highwater('', '') : Highwater.of(newest);
  }

  // -- 6. confirmedSend / kickoff (§2 step 6) --------------------------------
  async confirmedSend(agentId, text, { preHw = null, trace = null } = {}) {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let res;
      try {
        res = await this.request('POST', `/api/agents/${agentId}/input`, {
          text, submit: true, confirm: true, sender_agent_id: this.selfId,
        });
      } catch (e) {
        if (e.status === 409 && attempts <= MAX_409_RETRIES) {
          if (trace) trace('retry_after_409', { id: agentId, attempt: attempts });
          await this.waitReceiverReady(agentId);
          await sleep(POLL_MS);
          continue;
        }
        throw e; // 502 delivery/confirm throw ⇒ no turn will start
      }
      if (res.confirmed) return { confirmed: true, fullSends: attempts };
      // delivered-unconfirmed (HTTP 200): NOT an automatic failure.
      const started = await this.recoverUnconfirmed(agentId, preHw, trace);
      return { confirmed: false, fullSends: attempts, started };
    }
  }

  async recoverUnconfirmed(agentId, preHw, trace) {
    // Re-press Enter only while still idle with NO turn-start evidence; NEVER
    // resend the full prompt on a mere confirmation timeout.
    for (let i = 0; i < MAX_SUBMIT_RECOVERY; i += 1) {
      const agent = await this.getAgent(agentId);
      const status = agent?.status;
      if (status === 'working' || status === 'done' || status === 'crashed') return true;
      const newest = await this.newestAssistant(agentId);
      if (newest && preHw && preHw.isOlderThan(newest)) return true; // turn started invisibly
      if (trace) trace('enter_press', { id: agentId });
      await this.request('POST', `/api/agents/${agentId}/keys`, { keys: '\r' });
      await sleep(POLL_MS);
    }
    return false;
  }

  async kickoff(agentId, text, opts = {}) {
    // Deliver the task AFTER launch — never a launch-time systemPrompt.
    return this.confirmedSend(agentId, text, opts);
  }

  // -- 7. waitTurnComplete (§2 step 7) ---------------------------------------
  async waitTurnComplete(agentId, highwater, { softMs = SOFT_STALL_MS, hardMs = HARD_DEADLINE_MS, trace = null } = {}) {
    const start = nowMs();
    let softDeadline = start + softMs;
    const hardDeadline = start + hardMs;
    for (;;) {
      const agent = await this.getAgent(agentId);
      const status = agent?.status;
      if (status === 'done' || status === 'crashed') {
        const newest = await this.newestAssistant(agentId);
        if (newest && newest.turnComplete && highwater.isOlderThan(newest)) {
          return { status: 'complete', message: newest, highwater: Highwater.of(newest) };
        }
        throw new LaresError(`waitTurnComplete: ${agentId} terminal (${status}) with no new turn`);
      }
      const newest = await this.newestAssistant(agentId);
      if (newest && newest.turnComplete && highwater.isOlderThan(newest)) {
        if (trace) trace('turn_complete', { id: agentId, hw: Highwater.of(newest).toString() });
        return { status: 'complete', message: newest, highwater: Highwater.of(newest) };
      }
      const now = nowMs();
      if (status === 'working') softDeadline = now + softMs; // working extends soft
      if (now >= hardDeadline || now >= softDeadline) {
        if (trace) trace('stall', { id: agentId, status });
        return { status: 'stalled', message: null, highwater };
      }
      await sleep(POLL_MS);
    }
  }

  // -- 8. waitReceiverReady + relay (§2 step 8) ------------------------------
  async waitReceiverReady(agentId) {
    const deadline = nowMs() + READY_TIMEOUT_MS;
    while (nowMs() < deadline) {
      const agent = await this.getAgent(agentId);
      if (agent === null) throw new LaresError(`waitReceiverReady: ${agentId} disappeared`);
      const { status } = agent;
      if (status === 'idle' || status === 'waiting') return agent;
      if (status === 'done' || status === 'crashed') {
        throw new LaresError(`waitReceiverReady: ${agentId} terminal (${status})`);
      }
      await sleep(POLL_MS);
    }
    throw new LaresError(`waitReceiverReady: timeout for ${agentId}`);
  }

  markRelayed(highwaters, agentId, hw) {
    // MUST be called for every consumed turn — even one whose content is not
    // forwarded — or a completed turn is re-relayed (stale-turn bug, §3).
    highwaters[agentId] = hw;
  }

  async relay(fromId, toId, content, { trace = null } = {}) {
    await this.waitReceiverReady(toId);
    const framed = `[from ${fromId}]\n${content}`;
    if (trace) trace('relay', { from: fromId, to: toId });
    return this.confirmedSend(toId, framed, { trace });
  }

  // -- 9. verifyArtifact / deliverable (§2 step 9) ---------------------------
  static async verifyArtifact(p, { baselineHash = null, minBytes = 1, graceMs = FLUSH_GRACE_MS, predicate = null } = {}) {
    // A token is NOT success. Verify existence + content + freshness/hash change
    // after a bounded flush grace. A stale artifact at the target path ≠ success.
    await sleep(graceMs);
    if (!fs.existsSync(p)) return { ok: false, reason: 'missing' };
    const data = fs.readFileSync(p);
    if (data.length < minBytes) return { ok: false, reason: 'empty' };
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (baselineHash !== null && digest === baselineHash) return { ok: false, reason: 'stale', hash: digest };
    if (predicate !== null && !predicate(data.toString('utf-8'))) return { ok: false, reason: 'predicate', hash: digest };
    return { ok: true, reason: 'fresh', hash: digest };
  }

  static verifyToken(messages, accept) {
    // Validate NEWEST-FIRST so an early retry's stale token can't shadow the
    // final verdict (§2 step 9).
    const TOKENS = ['PASS', 'FAIL', 'CONSENSUS', 'APPROVED', 'REJECTED', 'SKILL_BUILD_OK', 'DONE'];
    for (const msg of messages) { // caller passes newest-first
      const content = msg.content ?? '';
      for (const tok of TOKENS) if (content.includes(tok) && accept(tok)) return tok;
    }
    return null;
  }

  async readMessages(agentId, limit = 10) {
    const msgs = await this.request('GET', `/api/agents/${agentId}/messages?limit=${limit}&role=assistant`);
    return Array.isArray(msgs) ? msgs : [];
  }

  // -- 10. retire / terminal-policy dispatch (§2 step 10) --------------------
  async retire(terminalState, members, { keepAgents = false, trace = null } = {}) {
    // Cleanup is terminal-state-specific — NOT an unconditional finally delete.
    if (terminalState === 'stalled') {
      // Recoverable — leave alive; persist + emit resume_hint elsewhere.
      for (const m of members) if (trace) trace('retain', { id: m });
      return { retired: [], retained: [...members] };
    }
    if (keepAgents && terminalState === 'complete') return { retired: [], retained: [...members] };
    const retired = [], survivors = [];
    for (const m of [...members].reverse()) { // reverse launch order
      try {
        await this.request('DELETE', `/api/agents/${m}`);
        if (trace) trace('delete', { id: m });
        retired.push(m);
      } catch (e) {
        survivors.push(m);
        process.stderr.write(`[retire] failed to delete ${m} (surviving): ${e}\n`);
      }
    }
    return { retired, retained: survivors };
  }

  // -- 11. reconcile / resume + terminal notification (§2 step 11) -----------
  resumeHint(runId, phase, members, params = {}) {
    return { kind: 'resume_hint', runId, phase, members, params };
  }

  async deliverToSupervisor(text, { sentinelPath, trace = null } = {}) {
    // Survive the supervisor's protective working-latch (409s while working):
    // poll→ready, POST /input, retry on 409; on persistent failure write a
    // sentinel so the result is not lost, then proceed. (CLI convention.)
    const sup = this.supervisorId;
    if (!sup) {
      writeSentinel(sentinelPath, { reason: 'no-supervisor', text });
      if (trace) trace('sentinel', { path: sentinelPath });
      return { delivered: false, sentinel: sentinelPath };
    }
    for (let attempt = 1; attempt <= SUPERVISOR_409_RETRIES; attempt += 1) {
      try {
        await this.waitReceiverReady(sup);
        await this.request('POST', `/api/agents/${sup}/input`, { text, submit: true, sender_agent_id: this.selfId });
        return { delivered: true, attempts: attempt };
      } catch (e) {
        if (e.status === 409 && attempt < SUPERVISOR_409_RETRIES) { await sleep(POLL_MS); continue; }
        break;
      }
    }
    writeSentinel(sentinelPath, { reason: 'undelivered', text });
    if (trace) trace('sentinel', { path: sentinelPath });
    return { delivered: false, sentinel: sentinelPath };
  }

  async reconcile(runState) {
    // Restore members/phase/counters/baselines/highwaters; NEVER reseed a valid
    // highwater; detect terminal/missing members.
    const restored = { phase: runState.phase, members: [], missing: [] };
    for (const m of runState.members ?? []) {
      const agent = await this.getAgent(m);
      if (agent === null || agent.status === 'done' || agent.status === 'crashed') restored.missing.push(m);
      else restored.members.push(m);
    }
    return restored;
  }
}

function writeSentinel(p, payload) {
  fs.mkdirSync(path.dirname(p) || '.', { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload));
}

// Shared timing helper re-exported for shape templates.
export { sleep };
