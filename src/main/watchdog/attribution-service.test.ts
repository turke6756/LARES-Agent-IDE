// Unit tests — AttributionService (full-D5 stateful shell, Wave 4). Run:
//   npm run build:main
//   node dist/main/main/watchdog/attribution-service.test.js
//
// Everything the service needs is injected (store facade, electron summary,
// snapshot reader, clock), so no live processes / native module / electron.

import assert from 'node:assert/strict';
import { AttributionService, type OwnershipReadFacade } from './attribution-service';
import { makeSnapshot, type ProcessMemEntry } from './process-memory';
import type { OwnershipRow, ProcessInfo } from '../supervisor/ownership/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const GiB = 1024 * 1024 * 1024;

function row(over: Partial<OwnershipRow>): OwnershipRow {
  return {
    agentId: 'a', rootPid: 100, pidCreationTime: '1', instanceEpoch: 'e1', jobName: 'job',
    transport: 'conpty', tmuxSession: null, createdAt: 0, ...over,
  };
}

function entry(pid: number, ws: number, commit: number): ProcessMemEntry {
  return { pid, parentPid: 0, workingSetBytes: ws, commitBytes: commit };
}

/** A store facade returning a fixed row set + job-pid map. */
function facade(over: Partial<OwnershipReadFacade> & { rows?: OwnershipRow[]; jobPids?: Record<string, number[]> }): OwnershipReadFacade {
  const rows = over.rows ?? [];
  const jobPids = over.jobPids ?? {};
  return {
    listOwnershipRows: over.listOwnershipRows ?? (() => rows),
    getLiveJobPids: over.getLiveJobPids ?? ((id) => jobPids[id] ?? null),
    classifyTree: over.classifyTree ?? (() => ({ status: 'no-tree', pids: [] })),
  };
}

function svc(store: OwnershipReadFacade | null, snapshot: ProcessMemEntry[], opts: { electronProcs?: number; electronBytes?: number } = {}) {
  return new AttributionService({
    getStore: () => store,
    electron: () => ({ processCount: opts.electronProcs ?? 10, workingSetBytes: opts.electronBytes ?? 1 * GiB }),
    readSnapshot: () => Promise.resolve(makeSnapshot(snapshot)),
    now: () => 12345,
    config: { perAgentBudgetBytes: 4 * GiB, maxOwnedProcesses: 100 },
  });
}

// ── refresh / rollup ────────────────────────────────────────────────────────────

test('refresh rolls up job-pid tree bytes into per-agent + owned totals', async () => {
  const store = facade({ rows: [row({ agentId: 'a' })], jobPids: { a: [100, 101] } });
  const s = svc(store, [entry(100, 2 * GiB, 1 * GiB), entry(101, 1 * GiB, 512 * 1024 * 1024)]);
  const r = await s.refresh();
  assert.equal(r.at, 12345);
  const a = r.perAgent.find((u) => u.agentId === 'a')!;
  assert.equal(a.source, 'job');
  assert.equal(a.pidCount, 2);
  assert.equal(a.cliTreeBytes, 3 * GiB);
  assert.equal(r.totals.ownedCliProcessCount, 2);
  assert.equal(r.totals.ownedCliBytes, 3 * GiB);
  assert.equal(r.totals.totalOwnedProcessCount, 12); // 10 electron + 2 cli
});

test('falls back to the tree walk when no live job pids', async () => {
  const store = facade({
    rows: [row({ agentId: 'b' })],
    jobPids: {},
    classifyTree: (_r: OwnershipRow, _p: ProcessInfo[]) => ({ status: 'tree', pids: [200] }),
  });
  const s = svc(store, [entry(200, 1 * GiB, 0)]);
  const r = await s.refresh();
  const b = r.perAgent.find((u) => u.agentId === 'b')!;
  assert.equal(b.source, 'tree-walk');
  assert.equal(b.cliTreeBytes, 1 * GiB);
});

test('getFresh refreshes then returns the latest rollup', async () => {
  const store = facade({ rows: [row({ agentId: 'a' })], jobPids: { a: [100] } });
  const s = svc(store, [entry(100, 1 * GiB, 0)]);
  assert.equal(s.getLatest(), null);
  const r = await s.getFresh();
  assert.ok(r);
  assert.equal(s.getLatest(), r);
});

// ── admission helpers ────────────────────────────────────────────────────────────

test('checkLaunchOwnedCap fail-opens on a cold cache', () => {
  const s = svc(facade({}), []);
  assert.equal(s.checkLaunchOwnedCap().allowed, true); // no refresh yet → null totals → allowed
});

test('checkTabAdmission refuses over the per-agent budget (owned cap ok)', async () => {
  const store = facade({ rows: [row({ agentId: 'a' })], jobPids: { a: [100] } });
  const s = svc(store, [entry(100, 5 * GiB, 0)]); // over the 4 GiB budget
  await s.refresh();
  const d = s.checkTabAdmission('a');
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'memory-budget');
});

test('checkTabAdmission allows a within-budget agent', async () => {
  const store = facade({ rows: [row({ agentId: 'a' })], jobPids: { a: [100] } });
  const s = svc(store, [entry(100, 1 * GiB, 0)]);
  await s.refresh();
  assert.equal(s.checkTabAdmission('a').allowed, true);
});

// ── reap estimate ────────────────────────────────────────────────────────────────

test('estimateBytesForPids sums working set from the last snapshot', async () => {
  const store = facade({ rows: [row({ agentId: 'a' })], jobPids: { a: [100] } });
  const s = svc(store, [entry(100, 2 * GiB, 0), entry(101, 1 * GiB, 0)]);
  await s.refresh();
  assert.equal(s.estimateBytesForPids([100, 101]), 3 * GiB);
  assert.equal(s.estimateBytesForPids([999]), 0); // unknown pid contributes 0
  assert.equal(s.estimateBytesForPids([]), 0);
});

// ── resilience ───────────────────────────────────────────────────────────────────

test('a throwing snapshot reader degrades to an empty rollup, never throws', async () => {
  const s = new AttributionService({
    getStore: () => facade({ rows: [row({ agentId: 'a' })], jobPids: { a: [100] } }),
    electron: () => ({ processCount: 3, workingSetBytes: 0 }),
    readSnapshot: () => Promise.reject(new Error('wmic down')),
    now: () => 1,
  });
  const r = await s.refresh();
  const a = r.perAgent.find((u) => u.agentId === 'a')!;
  assert.equal(a.cliTreeBytes, 0);          // no bytes resolvable
  assert.equal(r.totals.electronProcessCount, 3);
});

test('null store yields an empty per-agent list, electron totals intact', async () => {
  const s = svc(null, []);
  const r = await s.refresh();
  assert.equal(r.perAgent.length, 0);
  assert.equal(r.totals.totalOwnedProcessCount, 10);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
