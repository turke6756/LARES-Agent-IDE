// Unit tests — composed System-Memory view (System-Memory polish Part 2). Run:
//   npm run build:main
//   node dist/main/main/watchdog/system-memory-view.test.js

import assert from 'node:assert/strict';
import { composeSystemMemoryView, type SystemMemoryViewDeps } from './system-memory-view';
import type { AgentMemoryUsage, AttributionResult } from './attribution';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function usage(over: Partial<AgentMemoryUsage> & { agentId: string }): AgentMemoryUsage {
  return {
    transport: 'conpty', cliTreeBytes: 100, cliCommitBytes: 80, commitComplete: true,
    pidCount: 1, source: 'job', ...over,
  };
}

function attr(over: Partial<AttributionResult>): AttributionResult {
  return {
    perAgent: [],
    totals: {
      electronProcessCount: 0, electronBytes: 0, ownedCliProcessCount: 0,
      ownedCliBytes: 0, totalOwnedProcessCount: 0, totalOwnedBytes: 0,
    },
    electronCommit: null,
    at: 1000,
    ...over,
  };
}

function deps(over: Partial<SystemMemoryViewDeps>): SystemMemoryViewDeps {
  return {
    listLiveAgents: () => [],
    getAttribution: () => null,
    getSnapshot: () => null,
    now: () => 5000,
    ...over,
  };
}

function agent(id: string, over: Partial<{ title: string; status: string; idleSince: string | null }> = {}) {
  return { id, title: over.title ?? `Title ${id}`, status: over.status ?? 'idle', idleSince: over.idleSince ?? null };
}

const KNOWN_SNAP = (charge: number, limit: number | null = 16 * GiB, at = 2000) =>
  ({ commitKnown: true, commitChargeBytes: charge, commitLimitBytes: limit, at });

// ── join direction ────────────────────────────────────────────────────────────

test('a live agent without an ownership row is synthesized with null memory', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('launching-1', { status: 'launching' })],
    getAttribution: () => attr({}),
  }));
  assert.equal(v.liveAgents.length, 1);
  const row = v.liveAgents[0];
  assert.equal(row.transport, null);
  assert.equal(row.source, null);
  assert.equal(row.workingSetBytes, null);
  assert.equal(row.commitBytes, null);
  assert.equal(row.commitComplete, false);
  assert.equal(row.pidCount, 0);
  assert.equal(row.title, 'Title launching-1');
});

test('a source-none attribution row still renders as unattributable (null memory)', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getAttribution: () => attr({ perAgent: [usage({ agentId: 'a', source: 'none', pidCount: 0, cliTreeBytes: 0, cliCommitBytes: 0, commitComplete: false })] }),
  }));
  const row = v.liveAgents[0];
  assert.equal(row.source, 'none');
  assert.equal(row.workingSetBytes, null, 'source none ⇒ unattributable, not 0 B');
  assert.equal(row.commitBytes, null);
});

test('an unregistered ownership row lands in unregisteredTrees, never in liveAgents', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('live-1')],
    getAttribution: () => attr({ perAgent: [
      usage({ agentId: 'live-1' }),
      usage({ agentId: 'prior-epoch', cliTreeBytes: 999, cliCommitBytes: 888 }),
    ] }),
  }));
  assert.deepEqual(v.liveAgents.map((r) => r.agentId), ['live-1']);
  assert.equal(v.unregisteredTrees.length, 1);
  assert.equal(v.unregisteredTrees[0].agentId, 'prior-epoch');
  assert.equal(v.unregisteredTrees[0].workingSetBytes, 999);
});

test('liveAgentCount === liveAgents.length by construction', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a'), agent('b'), agent('c')],
    getAttribution: () => attr({ perAgent: [usage({ agentId: 'a' })] }),
  }));
  assert.equal(v.liveAgentCount, 3);
  assert.equal(v.liveAgentCount, v.liveAgents.length);
});

test('a blank registry title falls back to the agentId', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('agent-x', { title: '' })],
  }));
  assert.equal(v.liveAgents[0].title, 'agent-x');
});

// ── breakdown categories ─────────────────────────────────────────────────────

test('zero live agents ⇒ liveAgents category is a KNOWN zero', () => {
  const v = composeSystemMemoryView(deps({
    getAttribution: () => attr({ electronCommit: { bytes: 1 * GiB, complete: true } }),
    getSnapshot: () => KNOWN_SNAP(4 * GiB),
  }));
  assert.deepEqual(v.breakdown.liveAgents, { bytes: 0, complete: true });
  assert.equal(v.breakdown.otherSystemBytes, 3 * GiB, 'residual is exact with a known zero');
});

test('attribution cold with live agents ⇒ liveAgents category null, unattributed counted', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getSnapshot: () => KNOWN_SNAP(4 * GiB),
  }));
  assert.equal(v.breakdown.liveAgents, null);
  assert.equal(v.breakdown.unattributedLiveAgentCount, 1);
  assert.equal(v.breakdown.otherSystemBytes, null);
});

test('a WSL live agent forces incomplete + counted unattributed + null residual', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('conpty-1'), agent('wsl-1')],
    getAttribution: () => attr({
      perAgent: [
        usage({ agentId: 'conpty-1', cliCommitBytes: 1 * GiB }),
        usage({ agentId: 'wsl-1', transport: 'wsl', source: 'none', pidCount: 0, cliTreeBytes: 0, cliCommitBytes: 0, commitComplete: false }),
      ],
      electronCommit: { bytes: 1 * GiB, complete: true },
    }),
    getSnapshot: () => KNOWN_SNAP(8 * GiB),
  }));
  assert.deepEqual(v.breakdown.liveAgents, { bytes: 1 * GiB, complete: false });
  assert.equal(v.breakdown.unattributedLiveAgentCount, 1);
  assert.equal(v.breakdown.otherSystemBytes, null, 'WSL shortfall must never be booked as other/system');
});

test('exact residual happy path', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getAttribution: () => attr({
      perAgent: [usage({ agentId: 'a', cliCommitBytes: 2 * GiB })],
      electronCommit: { bytes: 1 * GiB, complete: true },
      at: 1990,
    }),
    getSnapshot: () => KNOWN_SNAP(8 * GiB),
  }));
  assert.equal(v.breakdown.otherSystemBytes, 5 * GiB);
  assert.equal(v.breakdown.approximate, false);
  assert.equal(v.breakdown.attributionAt, 1990);
  assert.equal(v.breakdown.sampleAt, 2000);
});

test('a small negative residual clamps to 0 and flags approximate', () => {
  // charge 3 GiB, categories sum to 3 GiB + 100 MiB → raw = -100 MiB, within
  // max(2% of 16 GiB limit = ~327 MiB, 64 MiB).
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getAttribution: () => attr({
      perAgent: [usage({ agentId: 'a', cliCommitBytes: 2 * GiB + 100 * MiB })],
      electronCommit: { bytes: 1 * GiB, complete: true },
    }),
    getSnapshot: () => KNOWN_SNAP(3 * GiB),
  }));
  assert.equal(v.breakdown.otherSystemBytes, 0);
  assert.equal(v.breakdown.approximate, true);
});

test('a large negative residual yields null + approximate', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getAttribution: () => attr({
      perAgent: [usage({ agentId: 'a', cliCommitBytes: 4 * GiB })],
      electronCommit: { bytes: 2 * GiB, complete: true },
    }),
    getSnapshot: () => KNOWN_SNAP(3 * GiB),
  }));
  assert.equal(v.breakdown.otherSystemBytes, null);
  assert.equal(v.breakdown.approximate, true);
});

test('incomplete electron category blocks the exact residual', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getAttribution: () => attr({
      perAgent: [usage({ agentId: 'a', cliCommitBytes: 1 * GiB })],
      electronCommit: { bytes: 1 * GiB, complete: false },
    }),
    getSnapshot: () => KNOWN_SNAP(8 * GiB),
  }));
  assert.equal(v.breakdown.otherSystemBytes, null);
});

test('commitKnown false ⇒ null charge, no residual', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [agent('a')],
    getAttribution: () => attr({
      perAgent: [usage({ agentId: 'a' })],
      electronCommit: { bytes: 1 * GiB, complete: true },
    }),
    getSnapshot: () => ({ commitKnown: false, commitChargeBytes: null, commitLimitBytes: null, at: 2000 }),
  }));
  assert.equal(v.breakdown.commitChargeBytes, null);
  assert.equal(v.breakdown.otherSystemBytes, null);
  assert.deepEqual(v.breakdown.electron, { bytes: 1 * GiB, complete: true }, 'known category sums survive an unknown total');
});

test('attribution more than 60s older than the sample flags approximate', () => {
  const v = composeSystemMemoryView(deps({
    listLiveAgents: () => [],
    getAttribution: () => attr({ electronCommit: { bytes: 1 * GiB, complete: true }, at: 1000 }),
    getSnapshot: () => KNOWN_SNAP(4 * GiB, 16 * GiB, 62_000),
  }));
  assert.equal(v.breakdown.approximate, true);
  assert.equal(v.breakdown.otherSystemBytes, 3 * GiB, 'stale ⇒ approximate, not withheld');
});

// ── degradation ──────────────────────────────────────────────────────────────

test('null attribution and null snapshot degrade without throwing', () => {
  const v = composeSystemMemoryView(deps({ listLiveAgents: () => [agent('a')] }));
  assert.equal(v.liveAgentCount, 1);
  assert.equal(v.breakdown.commitChargeBytes, null);
  assert.equal(v.breakdown.electron, null);
  assert.equal(v.breakdown.attributionAt, null);
  assert.equal(v.breakdown.sampleAt, null);
  assert.deepEqual(v.unregisteredTrees, []);
});

test('throwing deps degrade to the empty view, never crash', () => {
  const v = composeSystemMemoryView({
    listLiveAgents: () => { throw new Error('db down'); },
    getAttribution: () => { throw new Error('cold'); },
    getSnapshot: () => { throw new Error('sampler down'); },
    now: () => { throw new Error('no clock'); },
  });
  assert.equal(v.liveAgentCount, 0);
  assert.deepEqual(v.breakdown.liveAgents, { bytes: 0, complete: true });
  assert.equal(v.at, 0);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
