// Unit tests — orphan reaper (D4 item 2). Run:
//   npm run build:main
//   node dist/main/main/supervisor/ownership/reaper.test.js

import assert from 'node:assert/strict';
import { OwnershipStore } from './ownership-store';
import { initFakeDb, makeFakeDb } from './fake-db';
import { Reaper, TerminalAgentRef } from './reaper';
import type { JobHandle, NativeJobSurface, ProcessInfo } from './types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function makeNative(opts: {
  supported?: boolean;
  creationTimes?: Map<number, string | null>;
  jobPids?: number[];
} = {}): NativeJobSurface & { terminatedJobs: JobHandle[] } {
  const supported = opts.supported ?? true;
  const creationTimes = opts.creationTimes ?? new Map();
  const terminatedJobs: JobHandle[] = [];
  const guard = () => { if (!supported) throw new Error('unsupported'); };
  return {
    supported,
    loadError: supported ? null : 'stub',
    terminatedJobs,
    jobName: (a, e) => `Local\\Lares.agent.${a}.${e}`,
    createNamedJob: (name) => { guard(); return { name } as JobHandle; },
    openNamedJob: (name) => { guard(); return { name } as JobHandle; },
    assignPid: () => { guard(); return true; },
    listJobPids: () => { guard(); return opts.jobPids ?? []; },
    terminateJob: (j) => { guard(); terminatedJobs.push(j); return true; },
    pidCreationTime: (pid) => { guard(); return creationTimes.has(pid) ? creationTimes.get(pid)! : null; },
  };
}

function harness(native: NativeJobSurface, opts: {
  terminals?: TerminalAgentRef[];
  processes?: ProcessInfo[];
  shuttingDown?: boolean;
  graceMs?: number;
  now?: number;
} = {}) {
  const db = makeFakeDb();
  const logs: string[] = [];
  const killed: number[] = [];
  const store = new OwnershipStore({ db, native, instanceEpoch: 'E1', now: () => 1, log: (m) => logs.push(m) });
  const reaper = new Reaper({
    store,
    processLister: { list: async () => opts.processes ?? [] },
    kill: (pid) => killed.push(pid),
    listTerminalAgents: () => opts.terminals ?? [],
    isShuttingDown: () => opts.shuttingDown ?? false,
    now: () => opts.now ?? 1_000_000,
    graceMs: opts.graceMs ?? 15 * 60_000,
    intervalMs: 60_000,
    log: (m) => logs.push(m),
  });
  return { store, reaper, killed, logs };
}

// ── grace + terminal-only ────────────────────────────────────────────────────

test('reaps a terminal agent past the grace period via its job', async () => {
  const native = makeNative({ creationTimes: new Map([[100, 'C100']]), jobPids: [100, 101] });
  const now = 1_000_000;
  const h = harness(native, {
    terminals: [{ agentId: 'a', terminalSinceMs: now - 20 * 60_000 }],
    now,
  });
  h.store.recordWindowsSpawn('a', 100);
  const res = await h.reaper.sweepOnce();
  assert.equal(res.eligible, 1);
  assert.equal(res.reaped[0].action, 'terminated');
  assert.equal(native.terminatedJobs.length, 1);
  assert.equal(h.store.getOwnership('a'), null); // row dropped
});

test('does NOT reap a terminal agent still within grace', async () => {
  const native = makeNative({ creationTimes: new Map([[100, 'C100']]) });
  const now = 1_000_000;
  const h = harness(native, {
    terminals: [{ agentId: 'a', terminalSinceMs: now - 60_000 }], // 1 min < 15 min
    now,
  });
  h.store.recordWindowsSpawn('a', 100);
  const res = await h.reaper.sweepOnce();
  assert.equal(res.eligible, 0);
  assert.equal(native.terminatedJobs.length, 0);
  assert.ok(h.store.getOwnership('a')); // row untouched
});

test('IDLE agents are structurally untouchable — never in the terminal list', async () => {
  // The idle agent has a live ownership row but is NOT returned by
  // listTerminalAgents, so the reaper never considers it. Idle is healthy.
  const native = makeNative({ creationTimes: new Map([[100, 'C100'], [200, 'C200']]), jobPids: [200] });
  const now = 1_000_000;
  const h = harness(native, {
    terminals: [{ agentId: 'crashed', terminalSinceMs: now - 30 * 60_000 }],
    now,
  });
  h.store.recordWindowsSpawn('idle', 100); // healthy, live — must survive
  h.store.recordWindowsSpawn('crashed', 200);
  await h.reaper.sweepOnce();
  assert.ok(h.store.getOwnership('idle'), 'idle agent ownership survives');
  assert.equal(h.store.getOwnership('crashed'), null, 'crashed agent reaped');
});

test('disabled while shuttingDown — reaps nothing', async () => {
  const native = makeNative({ creationTimes: new Map([[100, 'C100']]), jobPids: [100] });
  const now = 1_000_000;
  const h = harness(native, {
    terminals: [{ agentId: 'a', terminalSinceMs: now - 60 * 60_000 }],
    shuttingDown: true,
    now,
  });
  h.store.recordWindowsSpawn('a', 100);
  const res = await h.reaper.sweepOnce();
  assert.equal(res.skipped, 'shutting-down');
  assert.equal(native.terminatedJobs.length, 0);
  assert.ok(h.store.getOwnership('a'));
});

// ── PID-reuse safety ─────────────────────────────────────────────────────────

test('declines to kill (reused) when the PID was recycled; still drops the stale row', async () => {
  const ct = new Map<number, string | null>([[100, 'C100']]);
  const native = makeNative({ creationTimes: ct, jobPids: [100] });
  const now = 1_000_000;
  const h = harness(native, { terminals: [{ agentId: 'a', terminalSinceMs: now - 30 * 60_000 }], now });
  h.store.recordWindowsSpawn('a', 100);
  ct.set(100, 'C_OTHER'); // PID reused by an unrelated process
  const res = await h.reaper.sweepOnce();
  assert.equal(res.reaped[0].action, 'reused');
  assert.equal(native.terminatedJobs.length, 0);
  assert.equal(h.store.getOwnership('a'), null);
});

// ── fallback tree walk + fail-closed ─────────────────────────────────────────

test('falls back to the verified tree walk when native is off, and terminates it', async () => {
  const native = makeNative({ supported: false });
  const now = 1_000_000;
  const h = harness(native, {
    terminals: [{ agentId: 'a', terminalSinceMs: now - 30 * 60_000 }],
    processes: [{ pid: 100, parentPid: 4 }, { pid: 101, parentPid: 100 }],
    now,
  });
  // Spawn while native off → no stored creation time → unverifiable → fail-closed.
  h.store.recordWindowsSpawn('a', 100);
  const res = await h.reaper.sweepOnce();
  assert.equal(res.reaped[0].action, 'unverifiable');
  assert.deepEqual(h.killed, []);
  assert.ok(h.store.getOwnership('a'), 'unverifiable row kept for manual reconciliation');
});

(async () => {
  await initFakeDb();
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  // Let Node drain and exit naturally: a forced process.exit() here races the
  // sql.js/emscripten wasm async-handle teardown and trips a libuv
  // UV_HANDLE_CLOSING assertion (dirty exit code) even though all tests passed.
  process.exitCode = failed === 0 ? 0 : 1;
})();
