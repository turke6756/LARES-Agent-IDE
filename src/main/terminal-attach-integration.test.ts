// Memory-hardening WP-3e — attach-path integration assertions (deferred from
// WP-3a). Exercises the real `computeTerminalAttachResult` — the shape the
// `terminal:attach` IPC handler returns — against a fake supervisor, covering:
//
//   - LIVE attach returns the FULL {ok, live:true, terminalEpoch, snapshotCutoff,
//     degraded} with the cutoff/degraded coming from the write barrier and the
//     epoch from the live runner (agentEpoch).
//   - a DEGRADED live epoch surfaces degraded:true (the renderer routes to the
//     ring-snapshot recovery, not `.log` replay).
//   - DEAD attach returns {ok, live:false, snapshotCutoff:<fstat size>} with the
//     LAST recorded epoch when known, and null when the agent was never launched
//     this process — never degraded.
//   - the epoch reflects the LIVE runner while alive and falls back to
//     lastTerminalEpoch once the runner is gone (the retained-after-exit rule).
//
//   npm run build:main
//   node dist/main/main/terminal-attach-integration.test.js

import assert from 'node:assert/strict';
import { computeTerminalAttachResult, type AttachResultSupervisor } from './terminal-attach-result';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

/** A fake supervisor exposing exactly the narrow surface the builder consumes.
 *  `runners` decides live-ness; `barrier` feeds the live cutoff/degraded;
 *  `liveEpoch` is the runner's current epoch; `logSizes` feeds the dead cutoff. */
function fakeSupervisor(opts: {
  runners?: Record<string, { epoch: string; barrier: { cutoff: number; degraded: boolean } }>;
  logSizes?: Record<string, number>;
  lastEpochs?: Record<string, string>;
  notices?: Record<string, string>;
}): AttachResultSupervisor & { barrierCalls: string[] } {
  const runners = opts.runners ?? {};
  const logSizes = opts.logSizes ?? {};
  const notices = opts.notices ?? {};
  const barrierCalls: string[] = [];
  return {
    barrierCalls,
    hasRunner: (id) => id in runners,
    agentLogWriteBarrier: async (id) => {
      barrierCalls.push(id);
      const r = runners[id];
      if (!r) throw new Error('Agent not found or not running');
      return r.barrier;
    },
    agentEpoch: (id) => runners[id]?.epoch ?? opts.lastEpochs?.[id] ?? null,
    agentLogSize: async (id) => logSizes[id] ?? 0,
    lastTerminalEpoch: new Map(Object.entries(opts.lastEpochs ?? {})),
    // WP-6: no marker unless a test supplies one → historyNotice defaults to null.
    agentTerminalHistoryNotice: (id) =>
      id in notices ? { kind: 'retention-reclaimed', reclaimedAt: notices[id] } : null,
  };
}

// ── LIVE attach ───────────────────────────────────────────────────────

test('LIVE attach returns the full {ok,live,epoch,cutoff,degraded} from the barrier', async () => {
  const sup = fakeSupervisor({ runners: { a: { epoch: 'epoch-live', barrier: { cutoff: 4242, degraded: false } } } });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.deepEqual(res, {
    ok: true, live: true, terminalEpoch: 'epoch-live', snapshotCutoff: 4242, degraded: false, historyNotice: null,
  });
  assert.deepEqual(sup.barrierCalls, ['a'], 'the live path consults the write barrier');
});

test('LIVE attach on a DEGRADED epoch surfaces degraded:true (ring-recovery signal)', async () => {
  const sup = fakeSupervisor({ runners: { a: { epoch: 'ep-deg', barrier: { cutoff: 100, degraded: true } } } });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.equal(res.live, true);
  assert.equal(res.degraded, true, 'degraded flows straight from the barrier');
  assert.equal(res.snapshotCutoff, 100, 'cutoff is the barrier cutoff even when degraded');
  assert.equal(res.terminalEpoch, 'ep-deg');
});

// ── DEAD attach ───────────────────────────────────────────────────────

test('DEAD attach returns live:false + fstat cutoff + the last recorded epoch', async () => {
  const sup = fakeSupervisor({ logSizes: { a: 9000 }, lastEpochs: { a: 'epoch-was' } });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.deepEqual(res, {
    ok: true, live: false, terminalEpoch: 'epoch-was', snapshotCutoff: 9000, degraded: false, historyNotice: null,
  });
  assert.deepEqual(sup.barrierCalls, [], 'the dead path never touches the write barrier');
});

test('DEAD attach with no recorded epoch (never launched this process) → terminalEpoch null', async () => {
  const sup = fakeSupervisor({ logSizes: { a: 7 } });
  const res = await computeTerminalAttachResult(sup, 'a');
  assert.equal(res.live, false);
  assert.equal(res.terminalEpoch, null, 'unknown last epoch → null, not undefined');
  assert.equal(res.snapshotCutoff, 7);
  assert.equal(res.degraded, false, 'a dead agent is never degraded');
});

test('DEAD attach with an absent/empty .log → snapshotCutoff 0 (never negative)', async () => {
  const sup = fakeSupervisor({}); // no logSizes → agentLogSize resolves 0
  const res = await computeTerminalAttachResult(sup, 'ghost');
  assert.equal(res.snapshotCutoff, 0);
  assert.equal(res.live, false);
});

// ── epoch retained-after-exit transition ──────────────────────────────

test('epoch reflects the LIVE runner while alive, then lastTerminalEpoch once it exits', async () => {
  // Alive: agentEpoch returns the live runner epoch.
  const alive = fakeSupervisor({ runners: { a: { epoch: 'ep-1', barrier: { cutoff: 5, degraded: false } } }, lastEpochs: { a: 'ep-stale' } });
  const r1 = await computeTerminalAttachResult(alive, 'a');
  assert.equal(r1.terminalEpoch, 'ep-1', 'live runner epoch wins over the retained one');

  // Exited: no runner, but the epoch was retained in lastTerminalEpoch.
  const dead = fakeSupervisor({ logSizes: { a: 5 }, lastEpochs: { a: 'ep-1' } });
  const r2 = await computeTerminalAttachResult(dead, 'a');
  assert.equal(r2.live, false);
  assert.equal(r2.terminalEpoch, 'ep-1', 'the retained epoch survives the runner exit');
});

// ── Runner ────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
