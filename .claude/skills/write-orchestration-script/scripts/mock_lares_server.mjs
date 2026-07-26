// mock_lares_server.mjs — scenario-driven mock of the Lares dashboard HTTP API.
//
// Serves the real routes the fixed-core client depends on:
//   GET  /api/agents                          (probe → JSON array)
//   POST /api/agents                          (launch → {id,status,...})
//   GET  /api/agents/:id                      (status poll)
//   GET  /api/agents/:id/messages             (newest-first assistant messages)
//   POST /api/agents/:id/input                (409 gate + confirm handshake)
//   POST /api/agents/:id/keys                 (submit-only Enter)
//   DELETE /api/agents/:id                    (retire — records order)
//   GET  /health                             (readiness, no auth)
//   GET  /control/log                        (recorded events, for cross-checks)
//
// Behavior is a pure function of (scenario, per-agent counters). Turn-completion
// messages appear after the Nth *delivered* /input, so the driver can trigger
// exactly one turn per send deterministically — no wall-clock coupling.
//
// Usage: node mock_lares_server.mjs --scenario <name> --port <n> --token <t>

import http from 'node:http';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const SCENARIO = args.scenario || 'happy';
const PORT = parseInt(args.port || process.env.PORT || '0', 10);
const TOKEN = args.token || process.env.AGENT_DASHBOARD_API_TOKEN || 'test-token';

const SEED = { role: 'assistant', content: 'seed baseline', timestamp: '100', turnComplete: true };

// ── Scenario table ────────────────────────────────────────────────────────────
// input409Times : leading /input attempts that return HTTP 409
// inputConfirmed: whether the eventual 200 reports confirmed:true|false
// turns         : completion messages, served after the Nth delivered /input
//                 (delayPolls: hold `seed` for N message-polls after the send)
// history       : static newest-first list returned when a caller asks limit>1
// status        : GET /:id status (default 'idle')
// always409     : every /input returns 409 (supervisor-latch scenario)
const SCENARIOS = {
  happy: {
    turns: [{ content: 'done', timestamp: '200', turnComplete: true }],
  },
  '1': { // 409 on input → ready → retry
    input409Times: 1,
    turns: [{ content: 'result-after-409', timestamp: '200', turnComplete: true }],
  },
  '2': { // confirmed:false + newer activity → no 2nd prompt
    inputConfirmed: false,
    turns: [{ content: 'invisible-turn-started', timestamp: '150', turnComplete: false },
            { content: 'never-reached', timestamp: '999', turnComplete: true }],
  },
  '3': { // same-ts, different hash → composite distinguishes
    turns: [{ content: 'draft-A', timestamp: '200', turnComplete: true },
            { content: 'draft-B', timestamp: '200', turnComplete: true }],
  },
  '4': { // resume w/ valid highwater → no reseed (client-side; chat would be stale)
    turns: [{ content: 'post-resume-turn', timestamp: '500', turnComplete: true }],
    history: [{ role: 'assistant', content: 'stale-chat-head', timestamp: '050', turnComplete: true }],
  },
  '5': { // idle before completed message → not terminal
    turns: [{ content: 'late-completion', timestamp: '200', turnComplete: true, delayPolls: 3 }],
  },
  '6': { // stale token + newer verdict → newest wins
    turns: [{ content: 'verdict', timestamp: '300', turnComplete: true }],
    history: [{ role: 'assistant', content: 'FINAL PASS', timestamp: '300', turnComplete: true },
              { role: 'assistant', content: 'early retry FAIL', timestamp: '200', turnComplete: true }],
  },
  '7': { // stale artifact vs hash-changed → only fresh verifies (filesystem-driven)
    turns: [{ content: 'wrote-artifact', timestamp: '200', turnComplete: true }],
  },
  '8': { // recoverable stall → members retained + resume_hint
    turns: [], // no completion ever ⇒ soft/hard deadline fires
  },
  '9': { // success → reverse-order retirement
    turns: [{ content: 'done', timestamp: '200', turnComplete: true }],
  },
  '10': { // supervisor delivery persistent-409 → sentinel
    always409: true,
  },
};
const CFG = SCENARIOS[SCENARIO] || SCENARIOS.happy;

// ── State ──────────────────────────────────────────────────────────────────────
let seq = 0;
const agents = new Map(); // id → {id, provider, status, launchSeq, inputAttempts, msgPollsSinceInput}
const log = []; // recorded events for cross-checks
const record = (event, data) => log.push({ event, ...data });

function currentMessage(agent) {
  const delivered = Math.max(0, agent.inputAttempts - (CFG.input409Times || 0));
  if (delivered === 0 || !CFG.turns || CFG.turns.length === 0) return SEED;
  const turn = CFG.turns[Math.min(delivered - 1, CFG.turns.length - 1)];
  if ((turn.delayPolls || 0) > agent.msgPollsSinceInput) return SEED;
  return { role: 'assistant', turnComplete: true, ...turn };
}

// ── HTTP ────────────────────────────────────────────────────────────────────────
function send(res, status, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(raw);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (p === '/health') return send(res, 200, { ok: true, scenario: SCENARIO });
  if (p === '/control/log') return send(res, 200, { log });

  // Auth on every /api request (§1.2 → 401 on missing/invalid bearer).
  if (p.startsWith('/api/')) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  }

  if (method === 'GET' && p === '/api/agents') return send(res, 200, [...agents.values()]);

  if (method === 'POST' && p === '/api/agents') {
    const body = await readBody(req);
    seq += 1;
    const id = `agent-${seq}`;
    const agent = {
      id, provider: body.provider || 'claude', status: 'idle', launchSeq: seq,
      inputAttempts: 0, msgPollsSinceInput: 0,
      title: body.title, ownerAgentId: body.owner_agent_id ?? body.ownerAgentId ?? null,
    };
    agents.set(id, agent);
    record('launch', { id, owner: agent.ownerAgentId });
    return send(res, 200, { id, status: 'idle', resumeSessionId: `sess-${seq}`, provider: agent.provider });
  }

  const idMatch = p.match(/^\/api\/agents\/([^/]+)(\/messages|\/input|\/keys)?$/);
  if (idMatch) {
    const id = idMatch[1];
    const sub = idMatch[2];
    const agent = agents.get(id);

    if (method === 'DELETE' && !sub) {
      if (!agent) return send(res, 404, { error: 'not found' });
      agents.delete(id);
      record('delete', { id, launchSeq: agent.launchSeq });
      return send(res, 200, { ok: true, agentId: id });
    }
    if (!agent) return send(res, 404, { error: 'Agent not found' });

    if (method === 'GET' && !sub) {
      const status = CFG.status ? CFG.status(agent) : agent.status;
      return send(res, 200, { id, status, provider: agent.provider, resumeSessionId: `sess-${agent.launchSeq}` });
    }

    if (method === 'GET' && sub === '/messages') {
      const limit = parseInt(url.searchParams.get('limit') || '1', 10);
      if (limit > 1 && CFG.history) return send(res, 200, CFG.history.slice(0, limit));
      agent.msgPollsSinceInput += 1;
      return send(res, 200, [currentMessage(agent)]);
    }

    if (method === 'POST' && sub === '/input') {
      const body = await readBody(req);
      agent.inputAttempts += 1;
      agent.msgPollsSinceInput = 0;
      record('input', { id, attempt: agent.inputAttempts, textLen: (body.text || '').length });
      if (CFG.always409) return send(res, 409, { error: 'working', code: 'receiver-busy' });
      if ((CFG.input409Times || 0) >= agent.inputAttempts) {
        return send(res, 409, { error: 'Cannot send input to agent in "receiving" state.' });
      }
      const confirmed = CFG.inputConfirmed !== false;
      return send(res, 200, {
        ok: true, agentId: id, submit: true, confirmed,
        mode: confirmed ? 'status-poll' : 'unconfirmed',
      });
    }

    if (method === 'POST' && sub === '/keys') {
      record('keys', { id });
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'no route' });
});

server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address().port;
  // Emit the bound port so the runner can capture an ephemeral assignment.
  process.stdout.write(`MOCK_LISTENING ${bound}\n`);
});
