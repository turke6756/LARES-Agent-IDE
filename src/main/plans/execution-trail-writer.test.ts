// GT-C Decision 1 (§1.10) — execution-trail-writer tests (deps injected as fakes).
//
//   npm run build:main
//   node dist/main/main/plans/execution-trail-writer.test.js

import assert from 'node:assert/strict';
import { TrailMaterializer, type TrailWriterDeps } from './execution-trail-writer';
import type { TrailEntry } from './execution-trail';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, run: fn }); }

const PLAN = 'plan-1';
const ENTRY: TrailEntry = {
  planEventId: 'evt-1', createdAt: '2026-07-05T12:00:00.000Z', agentTitle: 'W',
  sectionHeading: 'Summary', viaLabel: 'Observed via file diff', claimResult: 'done',
};

// A plan doc with two anchored sections; sec_exectr is the trail zone. A "clobber"
// edit lands in the OTHER section (sec_summry) between reads.
function doc(summaryBody: string): string {
  return [
    '<!DOCTYPE html><html><body data-plan-id="p1">',
    `<section data-zone="summary" data-anchor="sec_summry"><h2>Summary</h2><p>${summaryBody}</p></section>`,
    '<section data-zone="execution-trail" data-anchor="sec_exectr"><h2>Execution Trail</h2><p class="zone-hint">hint</p></section>',
    '</body></html>',
  ].join('\n');
}

interface FakeOpts {
  reads: string[];                 // successive readPlanFile results (last repeats)
  quiescent?: Array<boolean>;      // per isQuiescent-call: consumed via hasLiveOrchestration (non-quiescent when false)
  liveAgent?: (exempt: string[]) => { id: string } | null;
  writeThrows?: boolean;
  onWrite?: (html: string) => void | Promise<void>;
  entries?: TrailEntry[];
}
function makeDeps(o: FakeOpts): { deps: TrailWriterDeps; writes: string[]; readCalls: () => number } {
  const writes: string[] = [];
  let readIdx = 0;
  const quiescent = o.quiescent ? [...o.quiescent] : null;
  const deps: TrailWriterDeps = {
    readPlanFile: async (_p) => {
      const v = o.reads[Math.min(readIdx, o.reads.length - 1)];
      readIdx++;
      return v ?? null;
    },
    writePlanFile: async (_p, html) => {
      if (o.writeThrows) throw new Error('disk full');
      if (o.onWrite) await o.onWrite(html);
      writes.push(html);
    },
    // isQuiescent() first consults hasLiveOrchestration; we drive quiescence through
    // it (returning true = non-quiescent). A `quiescent` sequence is consumed per call.
    hasLiveOrchestration: (_p, _ex) => {
      if (!quiescent) return false;
      const next = quiescent.shift();
      return next === undefined ? false : !next; // true means "has live" = non-quiescent
    },
    getLiveRailAgentForPlan: (_p, exempt) => (o.liveAgent ? o.liveAgent(exempt) : null),
    listTrailEntries: (_p) => o.entries ?? [ENTRY],
    hashHtml: (html) => html, // identity hash — exact byte comparison
  };
  return { deps, writes, readCalls: () => readIdx };
}

// ── Clobber test A — bytes change between reads ───────────────────────────────

test('clobber A — an other-section edit between reads is preserved AND the trail lands', async () => {
  const first = doc('original');
  const edited = doc('AGENT EDIT');   // a different section changed under us
  const { deps, writes } = makeDeps({ reads: [first, edited] });
  const m = new TrailMaterializer();
  m.configure(deps);
  await m.materialize(PLAN);
  assert.equal(writes.length, 1, 'exactly one write');
  const out = writes[0];
  assert.ok(out.includes('<p>AGENT EDIT</p>'), 'the concurrent other-section edit survives (no lost content)');
  assert.match(out, /data-plan-event-id="evt-1"/, 'the regenerated trail is present');
});

// ── Clobber test B — active-state race at the pre-write recheck ───────────────

test('clobber B — quiescent at first check but non-quiescent at pre-write recheck → NO write', async () => {
  const stable = doc('x');
  // reads are byte-stable (same hash) → the re-read loop breaks without a mid-loop
  // quiescence check, so isQuiescent is called: (1) at start [true], (2) pre-write [false].
  const { deps, writes } = makeDeps({ reads: [stable], quiescent: [true, false] });
  const m = new TrailMaterializer();
  m.configure(deps);
  await m.materialize(PLAN);
  assert.equal(writes.length, 0, 'a race detected at the pre-write recheck aborts the write');
});

// ── gate ──────────────────────────────────────────────────────────────────────

test('gate — non-quiescent at the initial check → no read, no write', async () => {
  const { deps, writes, readCalls } = makeDeps({ reads: [doc('x')], quiescent: [false] });
  const m = new TrailMaterializer();
  m.configure(deps);
  await m.materialize(PLAN);
  assert.equal(writes.length, 0);
  assert.equal(readCalls(), 0, 'gate short-circuits before any read');
});

test('before configure — materialize / request are inert, isMaterializing false', async () => {
  const m = new TrailMaterializer();
  assert.equal(m.isMaterializing(PLAN), false);
  await m.materialize(PLAN);       // no throw
  m.request(PLAN);                 // no throw
});

// ── serialization ─────────────────────────────────────────────────────────────

test('two concurrent materialize calls do not interleave (serialized per plan)', async () => {
  let active = 0, maxActive = 0;
  const { deps, writes } = makeDeps({
    reads: [doc('x')],
    onWrite: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    },
  });
  const m = new TrailMaterializer();
  m.configure(deps);
  await Promise.all([m.materialize(PLAN), m.materialize(PLAN)]);
  assert.equal(maxActive, 1, 'writes never overlap');
  assert.equal(writes.length, 2);
});

test('a rejecting writePlanFile does not throw to the caller', async () => {
  const { deps } = makeDeps({ reads: [doc('x')], writeThrows: true });
  const m = new TrailMaterializer();
  m.configure(deps);
  await assert.doesNotReject(() => m.materialize(PLAN));
});

// ── ownership window / exemptions ─────────────────────────────────────────────

test('ownership window — a DIFFERENT running run on the plan blocks the write', async () => {
  // hasLiveOrchestration honors exemptRunId; simulate a non-exempt live run.
  const writes: string[] = [];
  const deps: TrailWriterDeps = {
    readPlanFile: async () => doc('x'),
    writePlanFile: async (_p, html) => { writes.push(html); },
    hasLiveOrchestration: (_p, exemptRunId) => exemptRunId !== 'run-other', // 'run-other' still live
    getLiveRailAgentForPlan: () => null,
    listTrailEntries: () => [ENTRY],
    hashHtml: (h) => h,
  };
  const m = new TrailMaterializer();
  m.configure(deps);
  // completing run is 'run-mine'; a different run 'run-other' is still live → non-quiescent.
  await m.materialize(PLAN, { completingRunId: 'run-mine' });
  assert.equal(writes.length, 0, 'the exemption only clears the completing run, not others');
});

test('ownership window — exempting the completing run allows the write', async () => {
  const writes: string[] = [];
  const deps: TrailWriterDeps = {
    readPlanFile: async () => doc('x'),
    writePlanFile: async (_p, html) => { writes.push(html); },
    hasLiveOrchestration: (_p, exemptRunId) => exemptRunId !== 'run-mine', // only 'run-mine' is live
    getLiveRailAgentForPlan: () => null,
    listTrailEntries: () => [ENTRY],
    hashHtml: (h) => h,
  };
  const m = new TrailMaterializer();
  m.configure(deps);
  await m.materialize(PLAN, { completingRunId: 'run-mine' });
  assert.equal(writes.length, 1, 'the completing run exempts itself and writes');
});

test('exemption — a live rail agent blocks the write; blocked=false when exempt or terminal', async () => {
  // blocked by a live agent
  {
    const { deps, writes } = makeDeps({ reads: [doc('x')], liveAgent: () => ({ id: 'ag-1' }) });
    const m = new TrailMaterializer(); m.configure(deps);
    await m.materialize(PLAN);
    assert.equal(writes.length, 0, 'a live rail agent blocks');
  }
  // not blocked when that agent id is exempt
  {
    const { deps, writes } = makeDeps({
      reads: [doc('x')],
      liveAgent: (exempt) => (exempt.includes('ag-1') ? null : { id: 'ag-1' }),
    });
    const m = new TrailMaterializer(); m.configure(deps);
    await m.materialize(PLAN, { exemptAgentIds: ['ag-1'] });
    assert.equal(writes.length, 1, 'exempting the agent clears the block');
  }
  // not blocked when all rail agents are terminal (getLiveRailAgentForPlan → null)
  {
    const { deps, writes } = makeDeps({ reads: [doc('x')], liveAgent: () => null });
    const m = new TrailMaterializer(); m.configure(deps);
    await m.materialize(PLAN);
    assert.equal(writes.length, 1);
  }
});

// ── in-flight dispatch guard ──────────────────────────────────────────────────

test('in-flight — isMaterializing is true during the window, false after it settles', async () => {
  let sawInFlight = false;
  const m = new TrailMaterializer();
  const { deps, writes } = makeDeps({
    reads: [doc('x')],
    onWrite: async () => { sawInFlight = m.isMaterializing(PLAN); },
  });
  m.configure(deps);
  assert.equal(m.isMaterializing(PLAN), false, 'false before');
  await m.materialize(PLAN);
  assert.equal(sawInFlight, true, 'true during the write window');
  assert.equal(m.isMaterializing(PLAN), false, 'false after it settles');
  assert.equal(writes.length, 1);
});

// ── Clobber test C — human save AFTER the final reread (P0 rec #5) ─────────────
//
// The reread loop settles on byte-stable bytes, THEN a human saves an edit before
// the write. With no compare-and-swap the writer would rename its stale buffer
// (splice of the OLD summary) over the human's change. The guard reread at the
// write boundary must (a) preserve the human edit, (b) skip the stale write, and
// (c) requeue so the trail eventually lands against the fresh bytes.

async function settle(pred: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('clobber C — a human save landing at the write boundary is NOT clobbered; trail is requeued and lands', async () => {
  const original = doc('original');       // bytes the reread loop settles on
  const humanSave = doc('HUMAN EDIT');    // saved AFTER the final reread
  // read#1 original, read#2 original (loop stable → break), read#3 (guard) humanSave
  // → conflict. Requeue then reads humanSave consistently (last element repeats).
  const { deps, writes } = makeDeps({ reads: [original, original, humanSave] });
  const m = new TrailMaterializer();
  (m as any).requeueDelayMs = 5; // fast, deterministic requeue for the test
  m.configure(deps);

  await m.materialize(PLAN);
  // (b) The stale-buffer write was skipped and (c) the plan is marked pending.
  assert.equal(writes.length, 0, 'the stale full-file buffer is NOT written on conflict');
  assert.equal(m.isTrailPending(PLAN), true, 'the plan is marked "trail pending due to concurrent edit"');

  // (c) The requeue eventually lands.
  await settle(() => m.isTrailPending(PLAN) === false);
  assert.equal(m.isTrailPending(PLAN), false, 'pending clears once the requeued write lands');
  assert.equal(writes.length, 1, 'exactly one write — the requeued materialize against fresh bytes');
  const out = writes[0];
  // (a) The human edit survives; (b) the stale original body is gone.
  assert.ok(out.includes('<p>HUMAN EDIT</p>'), 'the human edit survives (no clobber)');
  assert.ok(!out.includes('<p>original</p>'), 'no stale buffer content is written');
  assert.match(out, /data-plan-event-id="evt-1"/, 'the regenerated trail lands on the fresh bytes');
});

// ── Clobber test D — atomic CAS dep path (writePlanFileIfUnchanged) ────────────

test('clobber D — writePlanFileIfUnchanged conflict requeues; a later CAS success lands', async () => {
  const writes: string[] = [];
  let casCalls = 0;
  const deps: TrailWriterDeps = {
    readPlanFile: async () => doc('x'),
    writePlanFile: async () => { throw new Error('CAS path must not use the plain write'); },
    writePlanFileIfUnchanged: async (_p, html, _expected) => {
      casCalls++;
      if (casCalls === 1) return 'conflict'; // a concurrent edit landed at the fs op
      writes.push(html);
      return 'written';
    },
    hasLiveOrchestration: () => false,
    getLiveRailAgentForPlan: () => null,
    listTrailEntries: () => [ENTRY],
    hashHtml: (h) => h,
  };
  const m = new TrailMaterializer();
  (m as any).requeueDelayMs = 5;
  m.configure(deps);

  await m.materialize(PLAN);
  assert.equal(writes.length, 0, 'first CAS conflict writes nothing');
  assert.equal(m.isTrailPending(PLAN), true, 'conflict marks the plan pending');

  await settle(() => m.isTrailPending(PLAN) === false);
  assert.equal(writes.length, 1, 'the requeued CAS succeeds and lands exactly one write');
  assert.equal(m.isTrailPending(PLAN), false, 'pending clears after the CAS success');
  assert.match(writes[0], /data-plan-event-id="evt-1"/, 'the trail landed via the atomic CAS dep');
});

test('onTrailPendingChange fires on enter/leave of the pending state', async () => {
  const events: boolean[] = [];
  const original = doc('original');
  const humanSave = doc('HUMAN EDIT');
  const { deps } = makeDeps({ reads: [original, original, humanSave] });
  (deps as any).onTrailPendingChange = (_p: string, pending: boolean) => events.push(pending);
  const m = new TrailMaterializer();
  (m as any).requeueDelayMs = 5;
  m.configure(deps);

  await m.materialize(PLAN);
  await settle(() => m.isTrailPending(PLAN) === false);
  assert.deepEqual(events, [true, false], 'pending toggled on then off exactly once');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); passed++; }
    catch (err) { failed++; console.error(`✗ ${t.name}\n  ${(err as Error).message}`); }
  }
  console.log(`\nexecution-trail-writer: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
