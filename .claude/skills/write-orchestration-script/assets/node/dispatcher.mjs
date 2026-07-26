// dispatcher.mjs — DISPATCHER FAN-OUT shape (Node). Fan out a bounded-concurrency
// pool of workers, one per work item; kick each off; wait for the STRICT
// completion profile (idle + stable signature for N polls + flush grace); verify
// the per-item deliverable; record a per-item result; retire; aggregate exit.
//
// Invoked core subset: connectApi, launchAgent, waitReady, seedHighwater,
//   confirmedSend/kickoff, waitTurnComplete (STRICT profile), verifyArtifact,
//   retire (terminal-state-specific). Reconcile/resume machinery is NOT part of
//   the dispatcher profile — see the deliberation/scheduler/pipeline shapes.
//
// Everything marked `// user policy` is a customization slot. Do NOT edit the
// fixed-core client (lares-client.mjs); adjust behavior via these hooks only.

import { LaresClient, Highwater, POLL_MS, EXIT_OK, sleep } from './lares-client.mjs';

const nowMs = () => Date.now();

// user policy — how a work item becomes a launch payload + kickoff prompt.
export function defaultItemToWork(item) {
  return {
    payload: { title: `dispatch: ${item.id}`, provider: 'claude', isSupervised: true }, // user policy
    kickoff: `Do the task for ${item.id}. Write the result to ${item.artifact} (absolute path). ` // user policy
      + `End your final message with the token DONE.`,
    artifact: item.artifact ?? null,     // user policy — absolute path or null (token-only)
    baselineHash: null,                  // user policy — set to gate on freshness
  };
}

// STRICT one-shot completion (dispatcher hardening, §2 step 7 strict profile):
// require status idle AND a stable (msg-count, newest-ts) signature for N polls.
async function waitStableIdle(client, agentId, { stablePolls = 3, hardMs = 60_000 } = {}) {
  const deadline = nowMs() + hardMs;
  let lastSig = null, stable = 0;
  while (nowMs() < deadline) {
    const agent = await client.getAgent(agentId);
    if (!agent) return false;
    if (agent.status === 'crashed' || agent.status === 'done') return agent.status === 'done';
    const msgs = await client.readMessages(agentId, 1);
    const sig = `${msgs.length}:${msgs[0]?.timestamp ?? ''}`;
    if (agent.status === 'idle' && sig === lastSig) { stable += 1; if (stable >= stablePolls) return true; }
    else { stable = 0; lastSig = sig; }
    await sleep(POLL_MS);
  }
  return false;
}

async function runOne(client, item, policy) {
  const work = policy.itemToWork(item);
  const agent = await client.launchAgent(work.payload);
  emit('launch', { id: agent.id, item: item.id });
  const record = { item: item.id, agentId: agent.id, ok: false, reason: null };
  try {
    await client.waitReady(agent.id);
    const hw = await client.seedHighwater(agent.id);
    const res = await client.kickoff(agent.id, work.kickoff, { preHw: hw, trace: emit });
    emit('kickoff', { id: agent.id, confirmed: res.confirmed });
    const tc = await client.waitTurnComplete(agent.id, hw, { trace: emit });
    if (tc.status !== 'complete') { record.reason = 'stalled'; return record; }
    await waitStableIdle(client, agent.id, { stablePolls: policy.stablePolls }); // strict flush
    if (work.artifact) {
      const v = await LaresClient.verifyArtifact(work.artifact, { baselineHash: work.baselineHash });
      record.ok = v.ok; record.reason = v.reason;
    } else {
      const msgs = await client.readMessages(agent.id, 5);
      record.ok = !!LaresClient.verifyToken(msgs, policy.acceptToken); // user policy predicate
      record.reason = record.ok ? 'token' : 'no-token';
    }
    return record;
  } finally {
    if (!policy.keepWorkers) await client.retire(record.ok ? 'complete' : 'error', [agent.id], { trace: emit });
  }
}

// Bounded-concurrency pool.
export async function runDispatcher(client, items, overrides = {}) {
  const policy = {
    itemToWork: defaultItemToWork,
    concurrency: 4,          // user policy — concurrency cap
    stablePolls: 3,          // user policy — strict-idle stability polls
    keepWorkers: false,      // user policy — retire successful workers?
    acceptToken: (t) => t === 'DONE', // user policy — success token predicate
    ...overrides,
  };
  const queue = [...items];
  const results = [];
  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      results.push(await runOne(client, item, policy));
    }
  }
  await Promise.all(Array.from({ length: Math.min(policy.concurrency, items.length || 1) }, worker));
  return results;
}

let TRACE = false;
function emit(event, data) { if (TRACE) process.stdout.write('TRACE ' + JSON.stringify({ event, ...data }) + '\n'); }
export function enableTrace() { TRACE = true; }

// CLI: read items from LARES_ITEMS (JSON) or default one item; aggregate exit.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('dispatcher.mjs')) {
  const client = await LaresClient.connectApi();
  const items = JSON.parse(process.env.LARES_ITEMS || '[{"id":"item-1"}]'); // user policy — item selection
  const results = await runDispatcher(client, items);
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  process.exit(failed.length ? EXIT_OK + 1 : EXIT_OK); // aggregate exit
}
