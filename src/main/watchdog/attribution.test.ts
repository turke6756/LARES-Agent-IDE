// Unit tests — per-agent memory attribution (full-D5, Wave 4). Run:
//   npm run build:main
//   node dist/main/main/watchdog/attribution.test.js

import assert from 'node:assert/strict';
import { computeAttribution, usageForAgent, type AttributionDeps } from './attribution';
import type { OwnershipRow } from '../supervisor/ownership/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function conptyRow(agentId: string, rootPid: number, epoch = 'e1'): OwnershipRow {
  return {
    agentId, rootPid, pidCreationTime: `ct-${rootPid}`, instanceEpoch: epoch,
    jobName: `Local\\Lares.agent.${agentId}.${epoch}`, transport: 'conpty',
    tmuxSession: null, createdAt: 0,
  };
}
function wslRow(agentId: string): OwnershipRow {
  return {
    agentId, rootPid: null, pidCreationTime: null, instanceEpoch: 'e1',
    jobName: null, transport: 'wsl', tmuxSession: `lares-${agentId}`, createdAt: 0,
  };
}

/** A base deps object; each test overrides what it cares about. */
function deps(over: Partial<AttributionDeps>): AttributionDeps {
  return {
    listOwnershipRows: () => [],
    resolveTree: () => ({ pids: [], source: 'none' }),
    workingSetBytes: () => null,
    commitBytes: () => null,
    electron: () => ({ processCount: 0, workingSetBytes: 0, pids: [] }),
    now: () => 12345,
    ...over,
  };
}

test('sums a resolved tree per agent and rolls up owned CLI totals', () => {
  const rows = [conptyRow('a', 100), conptyRow('b', 200)];
  const ws = new Map<number, number>([[100, 10], [101, 5], [200, 7]]);
  const cm = new Map<number, number>([[100, 3], [101, 2], [200, 4]]);
  const r = computeAttribution(deps({
    listOwnershipRows: () => rows,
    resolveTree: (row) => row.agentId === 'a'
      ? { pids: [100, 101], source: 'job' }
      : { pids: [200], source: 'tree-walk' },
    workingSetBytes: (pid) => ws.get(pid) ?? null,
    commitBytes: (pid) => cm.get(pid) ?? null,
    electron: () => ({ processCount: 4, workingSetBytes: 1000, pids: [] }),
  }));
  const a = usageForAgent(r, 'a')!;
  assert.equal(a.cliTreeBytes, 15);
  assert.equal(a.cliCommitBytes, 5);
  assert.equal(a.pidCount, 2);
  assert.equal(a.source, 'job');
  const b = usageForAgent(r, 'b')!;
  assert.equal(b.cliTreeBytes, 7);
  assert.equal(b.source, 'tree-walk');
  // Totals: electron + owned CLI (10+5+7=22, 3 pids).
  assert.equal(r.totals.ownedCliProcessCount, 3);
  assert.equal(r.totals.ownedCliBytes, 22);
  assert.equal(r.totals.electronProcessCount, 4);
  assert.equal(r.totals.totalOwnedProcessCount, 7);
  assert.equal(r.totals.totalOwnedBytes, 1022);
  assert.equal(r.at, 12345);
});

test('WSL rows report zero bytes and source none, not walked', () => {
  let resolved = false;
  const r = computeAttribution(deps({
    listOwnershipRows: () => [wslRow('w')],
    resolveTree: () => { resolved = true; return { pids: [], source: 'none' }; },
  }));
  const w = usageForAgent(r, 'w')!;
  assert.equal(w.transport, 'wsl');
  assert.equal(w.cliTreeBytes, 0);
  assert.equal(w.pidCount, 0);
  assert.equal(w.source, 'none');
  assert.equal(resolved, false, 'WSL rows are never tree-resolved');
});

test('a shared PID is counted once toward owned totals but in each agent tree', () => {
  const rows = [conptyRow('a', 100), conptyRow('b', 100)]; // both resolve to pid 100
  const r = computeAttribution(deps({
    listOwnershipRows: () => rows,
    resolveTree: () => ({ pids: [100], source: 'tree-walk' }),
    workingSetBytes: () => 50,
  }));
  assert.equal(usageForAgent(r, 'a')!.cliTreeBytes, 50);
  assert.equal(usageForAgent(r, 'b')!.cliTreeBytes, 50);
  // Owned totals dedupe by PID.
  assert.equal(r.totals.ownedCliProcessCount, 1);
  assert.equal(r.totals.ownedCliBytes, 50);
});

test('an empty resolved tree downgrades source to none', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => ({ pids: [], source: 'job' }),
  }));
  assert.equal(usageForAgent(r, 'a')!.source, 'none');
  assert.equal(usageForAgent(r, 'a')!.pidCount, 0);
});

test('missing per-PID bytes contribute 0, not NaN; process still counted', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => ({ pids: [100, 101], source: 'tree-walk' }),
    workingSetBytes: (pid) => (pid === 100 ? 40 : null),
  }));
  const a = usageForAgent(r, 'a')!;
  assert.equal(a.cliTreeBytes, 40);
  assert.equal(a.pidCount, 2);
  assert.equal(r.totals.ownedCliProcessCount, 2, 'both pids counted even when one has no byte reading');
  assert.equal(r.totals.ownedCliBytes, 40);
});

// ── Commit completeness (System-Memory polish Part 1) ───────────────────────

test('electronCommit: all PIDs resolve → summed and complete', () => {
  const cm = new Map<number, number>([[1, 100], [2, 200]]);
  const r = computeAttribution(deps({
    electron: () => ({ processCount: 2, workingSetBytes: 999, pids: [1, 2] }),
    commitBytes: (pid) => cm.get(pid) ?? null,
  }));
  assert.deepEqual(r.electronCommit, { bytes: 300, complete: true });
});

test('electronCommit: one PID missing from the snapshot → known sum, incomplete', () => {
  const cm = new Map<number, number>([[1, 100]]);
  const r = computeAttribution(deps({
    electron: () => ({ processCount: 2, workingSetBytes: 999, pids: [1, 2] }),
    commitBytes: (pid) => cm.get(pid) ?? null,
  }));
  assert.deepEqual(r.electronCommit, { bytes: 100, complete: false });
});

test('electronCommit: no PIDs supplied → null, never a false 0-complete', () => {
  const r = computeAttribution(deps({
    electron: () => ({ processCount: 0, workingSetBytes: 0, pids: [] }),
  }));
  assert.equal(r.electronCommit, null);
});

test('per-agent commitComplete: full tree resolves → true', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => ({ pids: [100, 101], source: 'job' }),
    commitBytes: () => 10,
  }));
  const a = usageForAgent(r, 'a')!;
  assert.equal(a.cliCommitBytes, 20);
  assert.equal(a.commitComplete, true);
});

test('per-agent commitComplete: one PID lacking commit → sum of the rest, false', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => ({ pids: [100, 101], source: 'tree-walk' }),
    commitBytes: (pid) => (pid === 100 ? 30 : null),
  }));
  const a = usageForAgent(r, 'a')!;
  assert.equal(a.cliCommitBytes, 30);
  assert.equal(a.commitComplete, false);
});

test('per-agent commitComplete: WSL row is false with zero bytes, no NaN', () => {
  const r = computeAttribution(deps({ listOwnershipRows: () => [wslRow('w')] }));
  const w = usageForAgent(r, 'w')!;
  assert.equal(w.cliCommitBytes, 0);
  assert.equal(w.commitComplete, false);
  assert.ok(Number.isFinite(w.cliCommitBytes));
});

test('per-agent commitComplete: empty tree (source none) is false', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => ({ pids: [], source: 'job' }),
  }));
  assert.equal(usageForAgent(r, 'a')!.commitComplete, false);
});

test('a throwing commitBytes degrades per-PID: incomplete, never crashes', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => ({ pids: [100, 101], source: 'job' }),
    commitBytes: (pid) => { if (pid === 101) throw new Error('read failed'); return 25; },
    electron: () => ({ processCount: 1, workingSetBytes: 0, pids: [7] }),
  }));
  const a = usageForAgent(r, 'a')!;
  assert.equal(a.cliCommitBytes, 25);
  assert.equal(a.commitComplete, false);
  assert.deepEqual(r.electronCommit, { bytes: 25, complete: true });
});

test('throwing deps degrade to unknown, never crash', () => {
  const r = computeAttribution(deps({
    listOwnershipRows: () => [conptyRow('a', 100)],
    resolveTree: () => { throw new Error('walk failed'); },
    electron: () => { throw new Error('metrics failed'); },
  }));
  const a = usageForAgent(r, 'a')!;
  assert.equal(a.pidCount, 0);
  assert.equal(a.source, 'none');
  assert.equal(r.totals.electronProcessCount, 0);
  assert.equal(r.electronCommit, null, 'a throwing electron dep yields no commit category');
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
