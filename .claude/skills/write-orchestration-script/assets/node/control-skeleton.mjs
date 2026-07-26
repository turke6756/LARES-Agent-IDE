// control-skeleton.mjs — the language-neutral reference skeleton (spec §7.1),
// realized in Node. Shows the INVARIANT function order every orchestration
// script preserves; `// user policy` marks the customizable slots. Copy this as
// the starting point for a bespoke topology (relay/deliberation/pipeline) and
// fill the policy hooks — never reorder the core lifecycle.
//
// Invoked core subset: connectApi, launchAgent, waitReady, seedHighwater,
//   confirmedSend/kickoff, waitTurnComplete, waitReceiverReady, relay,
//   markRelayed, verifyArtifact, retire, reconcile, resumeHint.

import { LaresClient, EXIT_OK, EXIT_STALL, EXIT_CRASH } from './lares-client.mjs';

// A durable run-state store is POLICY (§4): file / sentinel / db all acceptable.
// This skeleton keeps it in-memory for illustration.  // user policy
function makeRunState() {
  return { runId: 'run-0001', phase: 'kickoff', members: [], highwaters: {}, artifactBaselines: {}, retryCounters: {} };
}

export async function main() {
  const client = await LaresClient.connectApi();          // 1. connect + fail closed
  const run = makeRunState();                             // 2. capture run identity eagerly

  const members = [];                                     // user policy — topology/count/providers/lanes
  const plan = [{ title: 'worker', payload: { title: 'worker', provider: 'claude', isSupervised: true },
    kickoff: 'Do the task. Write the artifact to an ABSOLUTE path. End with the token DONE.' }]; // user policy

  try {
    for (const spec of plan) {
      const agent = await client.launchAgent(spec.payload);   // 3. launch (NO kickoff in the body)
      run.members.push(agent.id); members.push(agent.id);
      await client.waitReady(agent.id);                       // 4. waitReady (warm-up gate)
      const hw = await client.seedHighwater(agent.id, { persisted: run.highwaters[agent.id] ?? null }); // 5. seed (preserve on resume)
      run.highwaters[agent.id] = hw;
      const res = await client.kickoff(agent.id, spec.kickoff, { preHw: hw }); // 6. confirmed kickoff via /input
      const tc = await client.waitTurnComplete(agent.id, hw); // 7. message-stream completion
      if (tc.status === 'stalled') {
        run.phase = 'stalled';
        await client.retire('stalled', run.members);          // leave-alive + resume_hint
        const hint = client.resumeHint(run.runId, run.phase, run.members); // user policy — resume params
        process.stdout.write(JSON.stringify(hint) + '\n');
        return EXIT_STALL;
      }
      run.highwaters[agent.id] = tc.highwater;                // advance every participant's highwater

      // Relay to a peer (topology-specific). Gate EVERY cross-agent send.  // user policy
      // await client.waitReceiverReady(peerId);
      // await client.relay(agent.id, peerId, tc.message.content);

      // 9. Verify the deliverable — token is not success.  // user policy — success predicate
      const msgs = await client.readMessages(agent.id, 5);
      const okToken = LaresClient.verifyToken(msgs, (t) => t === 'DONE');
      if (!okToken) { run.phase = 'error'; await client.retire('error', run.members); return EXIT_CRASH; }
    }
    await client.retire('complete', run.members);             // 10. terminal-policy dispatch (reverse order)
    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`[control-skeleton] ${err.stack || err}\n`);
    // best-effort terminal dispatch; do NOT unconditionally delete on a stall.
    await client.retire('error', run.members).catch(() => {});
    return EXIT_CRASH;
  }
}

if (process.argv[1]?.endsWith('control-skeleton.mjs')) {
  process.exit(await main());
}
