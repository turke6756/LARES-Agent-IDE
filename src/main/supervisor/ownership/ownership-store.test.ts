// Unit tests — ownership store (D4). Uses a real in-memory better-sqlite3 DB and
// a fully faked native surface (no live processes). Run:
//   npm run build:main
//   node dist/main/main/supervisor/ownership/ownership-store.test.js

import assert from 'node:assert/strict';
import { OwnershipStore } from './ownership-store';
import { initFakeDb, makeFakeDb } from './fake-db';
import type { JobHandle, NativeJobSurface, ProcessInfo } from './types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** Fake native surface. `creationTimes` maps pid → live creation time (null =
 *  gone). `terminated`/`assigned` record calls for assertions. */
function makeNative(opts: {
  supported?: boolean;
  creationTimes?: Map<number, string | null>;
  jobPids?: number[];
} = {}): NativeJobSurface & { terminatedJobs: JobHandle[]; assigned: Array<[JobHandle, number]> } {
  const supported = opts.supported ?? true;
  const creationTimes = opts.creationTimes ?? new Map();
  const terminatedJobs: JobHandle[] = [];
  const assigned: Array<[JobHandle, number]> = [];
  const throwIfUnsupported = () => { if (!supported) throw new Error('unsupported'); };
  return {
    supported,
    loadError: supported ? null : 'stub',
    terminatedJobs,
    assigned,
    jobName: (agentId, epoch) => `Local\\Lares.agent.${agentId}.${epoch}`,
    createNamedJob: (name) => { throwIfUnsupported(); return { name } as JobHandle; },
    openNamedJob: (name) => { throwIfUnsupported(); return { name } as JobHandle; },
    assignPid: (job, pid) => { throwIfUnsupported(); assigned.push([job, pid]); return true; },
    listJobPids: () => { throwIfUnsupported(); return opts.jobPids ?? []; },
    terminateJob: (job) => { throwIfUnsupported(); terminatedJobs.push(job); return true; },
    pidCreationTime: (pid) => { throwIfUnsupported(); return creationTimes.has(pid) ? creationTimes.get(pid)! : null; },
  };
}

function makeStore(native: NativeJobSurface, epoch = 'EPOCH_1') {
  const db = makeFakeDb();
  const logs: string[] = [];
  let clock = 1_000;
  const store = new OwnershipStore({
    db,
    native,
    instanceEpoch: epoch,
    now: () => (clock += 1),
    log: (m) => logs.push(m),
  });
  return { store, db, logs };
}

const procs = (...rows: [number, number][]): ProcessInfo[] =>
  rows.map(([pid, parentPid]) => ({ pid, parentPid }));

// ── recordWindowsSpawn ──────────────────────────────────────────────────────────

test('recordWindowsSpawn persists rootPid + creation time + job name, and assigns the pid', () => {
  const native = makeNative({ creationTimes: new Map([[555, 'CT_555']]) });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  assert.equal(row.rootPid, 555);
  assert.equal(row.pidCreationTime, 'CT_555');
  assert.equal(row.jobName, 'Local\\Lares.agent.agent-a.EPOCH_1');
  assert.equal(row.transport, 'conpty');
  assert.deepEqual(native.assigned, [[{ name: row.jobName }, 555]]);
  const readBack = store.getOwnership('agent-a');
  assert.equal(readBack?.pidCreationTime, 'CT_555');
  assert.equal(store.hasLiveJobHandle('agent-a'), true);
});

test('recordWindowsSpawn upserts on respawn (one live row per agent)', () => {
  const native = makeNative({ creationTimes: new Map([[555, 'CT_555'], [777, 'CT_777']]) });
  const { store } = makeStore(native);
  store.recordWindowsSpawn('agent-a', 555);
  store.recordWindowsSpawn('agent-a', 777);
  assert.equal(store.listOwnershipRows().length, 1);
  assert.equal(store.getOwnership('agent-a')?.rootPid, 777);
});

test('recordWindowsSpawn with native OFF still writes the durable row (null job/ctime)', () => {
  const native = makeNative({ supported: false });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  assert.equal(row.jobName, null);
  assert.equal(row.pidCreationTime, null);
  assert.equal(store.getOwnership('agent-a')?.rootPid, 555);
  assert.equal(store.hasLiveJobHandle('agent-a'), false);
});

test('recordWslSpawn persists the tmux session as the handle, no pid/job', () => {
  const native = makeNative();
  const { store } = makeStore(native);
  const row = store.recordWslSpawn('agent-w', 'cad__slug__agent-w');
  assert.equal(row.transport, 'wsl');
  assert.equal(row.tmuxSession, 'cad__slug__agent-w');
  assert.equal(row.rootPid, null);
  assert.equal(row.jobName, null);
});

// ── reapViaJob (same-instance) ────────────────────────────────────────────────

test('reapViaJob terminates the job when the root verifies', () => {
  const native = makeNative({ creationTimes: new Map([[555, 'CT_555']]), jobPids: [555, 600] });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  const out = store.reapViaJob(row);
  assert.equal(out.action, 'terminated');
  assert.deepEqual(out.pids, [555, 600]);
  assert.equal(native.terminatedJobs.length, 1);
  assert.equal(store.hasLiveJobHandle('agent-a'), false);
});

test('reapViaJob DECLINES to kill when the PID was reused (creation time changed)', () => {
  const ct = new Map([[555, 'CT_555']]);
  const native = makeNative({ creationTimes: ct, jobPids: [555] });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  // PID 555 now belongs to an unrelated process (different creation time).
  ct.set(555, 'CT_OTHER');
  const out = store.reapViaJob(row);
  assert.equal(out.action, 'reused');
  assert.equal(native.terminatedJobs.length, 0);
});

test('reapViaJob reports gone when the root process disappeared', () => {
  const ct = new Map<number, string | null>([[555, 'CT_555']]);
  const native = makeNative({ creationTimes: ct });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  ct.set(555, null); // process exited
  const out = store.reapViaJob(row);
  assert.equal(out.action, 'gone');
  assert.equal(native.terminatedJobs.length, 0);
});

test('reapViaJob is unavailable when native is off (caller falls back to tree walk)', () => {
  const native = makeNative({ supported: false });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  assert.equal(store.reapViaJob(row).action, 'unavailable');
});

test('reapViaJob is unavailable for a prior-epoch row (job name not ours to reopen)', () => {
  const native = makeNative({ creationTimes: new Map([[555, 'CT_555']]) });
  const { store } = makeStore(native, 'EPOCH_2');
  // Row minted under a different epoch.
  const priorRow = { agentId: 'agent-a', rootPid: 555, pidCreationTime: 'CT_555', instanceEpoch: 'EPOCH_1', jobName: 'Local\\Lares.agent.agent-a.EPOCH_1', transport: 'conpty' as const, tmuxSession: null, createdAt: 1 };
  assert.equal(store.reapViaJob(priorRow).action, 'unavailable');
});

// ── reapViaTreeWalk (cross-instance / fallback) ───────────────────────────────

test('reapViaTreeWalk terminates the verified tree', () => {
  const native = makeNative({ creationTimes: new Map([[555, 'CT_555']]) });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  const killed: number[] = [];
  const out = store.reapViaTreeWalk(row, procs([555, 4], [600, 555], [700, 600]), (pid) => killed.push(pid));
  assert.equal(out.action, 'terminated');
  assert.deepEqual(killed.sort((a, b) => a - b), [555, 600, 700]);
});

test('reapViaTreeWalk declines (gone) when the PID was reused', () => {
  const ct = new Map([[555, 'CT_555']]);
  const native = makeNative({ creationTimes: ct });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555);
  ct.set(555, 'CT_OTHER');
  const killed: number[] = [];
  const out = store.reapViaTreeWalk(row, procs([555, 4], [600, 555]), (pid) => killed.push(pid));
  assert.equal(out.action, 'gone');
  assert.deepEqual(killed, []);
});

test('reapViaTreeWalk is unverifiable (fail-closed) when native is off', () => {
  const native = makeNative({ supported: false });
  const { store } = makeStore(native);
  const row = store.recordWindowsSpawn('agent-a', 555); // no creation time stored
  const killed: number[] = [];
  const out = store.reapViaTreeWalk(row, procs([555, 4], [600, 555]), (pid) => killed.push(pid));
  assert.equal(out.action, 'unverifiable');
  assert.deepEqual(killed, []);
});

test('listPriorEpochRows returns only rows from other instances', () => {
  const native = makeNative({ creationTimes: new Map([[1, 'C1'], [2, 'C2']]) });
  const { store, db } = makeStore(native, 'EPOCH_CUR');
  store.recordWindowsSpawn('current', 1);
  // inject a prior-epoch row directly
  db.prepare(
    `INSERT INTO agent_process_ownership (agent_id, root_pid, pid_creation_time, instance_epoch, job_name, transport, tmux_session, created_at)
     VALUES ('old', 2, 'C2', 'EPOCH_OLD', 'Local\\\\Lares.agent.old.EPOCH_OLD', 'conpty', NULL, 5)`,
  ).run();
  const prior = store.listPriorEpochRows();
  assert.equal(prior.length, 1);
  assert.equal(prior[0].agentId, 'old');
});

(async () => {
  await initFakeDb();
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
