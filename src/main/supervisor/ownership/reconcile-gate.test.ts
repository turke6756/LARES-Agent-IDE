// Unit tests — startup reconcile gate (D4 item 3). Run:
//   npm run build:main
//   node dist/main/main/supervisor/ownership/reconcile-gate.test.js

import assert from 'node:assert/strict';
import { OwnershipStore } from './ownership-store';
import { initFakeDb, makeFakeDb } from './fake-db';
import { ReconcileGate, UserResolution } from './reconcile-gate';
import type { JobHandle, NativeJobSurface, OwnershipRow, ProcessInfo } from './types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function makeNative(opts: { supported?: boolean; creationTimes?: Map<number, string | null> } = {}): NativeJobSurface {
  const supported = opts.supported ?? true;
  const creationTimes = opts.creationTimes ?? new Map();
  const guard = () => { if (!supported) throw new Error('unsupported'); };
  return {
    supported,
    loadError: supported ? null : 'stub',
    jobName: (a, e) => `Local\\Lares.agent.${a}.${e}`,
    createNamedJob: (name) => { guard(); return { name } as JobHandle; },
    openNamedJob: (name) => { guard(); return { name } as JobHandle; },
    assignPid: () => { guard(); return true; },
    listJobPids: () => { guard(); return []; },
    terminateJob: () => { guard(); return true; },
    pidCreationTime: (pid) => { guard(); return creationTimes.has(pid) ? creationTimes.get(pid)! : null; },
  };
}

/** Seed a PRIOR-epoch ownership row directly (the leftover a fresh instance sees). */
function seedPriorRow(db: any, row: Partial<OwnershipRow> & { agentId: string }): void {
  db.prepare(
    `INSERT INTO agent_process_ownership (agent_id, root_pid, pid_creation_time, instance_epoch, job_name, transport, tmux_session, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.agentId,
    row.rootPid ?? null,
    row.pidCreationTime ?? null,
    row.instanceEpoch ?? 'PRIOR_EPOCH',
    row.jobName ?? null,
    row.transport ?? 'conpty',
    row.tmuxSession ?? null,
    row.createdAt ?? 1,
  );
}

function harness(native: NativeJobSurface, opts: {
  processes?: ProcessInfo[];
  userResolution?: (id: string) => UserResolution;
} = {}) {
  const db = makeFakeDb();
  const logs: string[] = [];
  const killed: number[] = [];
  const store = new OwnershipStore({ db, native, instanceEpoch: 'CURRENT_EPOCH', now: () => 1, log: (m) => logs.push(m) });
  const gate = new ReconcileGate({
    store,
    processLister: { list: async () => opts.processes ?? [] },
    kill: (pid) => killed.push(pid),
    getUserResolution: opts.userResolution,
    now: () => 1_000,
    log: (m) => logs.push(m),
  });
  return { db, store, gate, killed, logs };
}

// ── proceed / reattach / no-row ──────────────────────────────────────────────

test('no ownership row → proceed', async () => {
  const h = harness(makeNative());
  const r = await h.gate.resolve('ghost');
  assert.equal(r.action, 'proceed');
});

test('WSL/tmux transport → reattach (never force-killed)', async () => {
  const h = harness(makeNative());
  seedPriorRow(h.db, { agentId: 'w', transport: 'wsl', tmuxSession: 'cad__x__w' });
  const r = await h.gate.resolve('w');
  assert.equal(r.action, 'reattach');
  assert.deepEqual(h.killed, []);
});

test('root gone (no surviving tree) → proceed, stale row dropped', async () => {
  const native = makeNative({ creationTimes: new Map([[100, null]]) }); // process exited
  const h = harness(native);
  seedPriorRow(h.db, { agentId: 'a', rootPid: 100, pidCreationTime: 'C100', jobName: 'Local\\Lares.agent.a.PRIOR_EPOCH' });
  const r = await h.gate.resolve('a');
  assert.equal(r.action, 'proceed');
  assert.equal(h.store.getOwnership('a'), null);
});

// ── terminate-then-continue (ConPTY default) ─────────────────────────────────

test('verified surviving orphan tree → terminate-then-continue kills the tree', async () => {
  const native = makeNative({ creationTimes: new Map([[100, 'C100']]) });
  const h = harness(native, { processes: [{ pid: 100, parentPid: 4 }, { pid: 101, parentPid: 100 }] });
  seedPriorRow(h.db, { agentId: 'a', rootPid: 100, pidCreationTime: 'C100', jobName: 'Local\\Lares.agent.a.PRIOR_EPOCH' });
  const r = await h.gate.resolve('a');
  assert.equal(r.action, 'terminate-then-continue');
  assert.deepEqual(r.pids.sort((a, b) => a - b), [100, 101]);
  assert.deepEqual(h.killed.sort((a, b) => a - b), [100, 101]);
  assert.equal(h.store.getOwnership('a'), null);
});

// ── leave-unmanaged (user opt-out) ───────────────────────────────────────────

test('user opts unmanaged → leave-unmanaged, orphan NOT killed, no respawn', async () => {
  const native = makeNative({ creationTimes: new Map([[100, 'C100']]) });
  const h = harness(native, {
    processes: [{ pid: 100, parentPid: 4 }],
    userResolution: () => 'unmanaged',
  });
  seedPriorRow(h.db, { agentId: 'a', rootPid: 100, pidCreationTime: 'C100', jobName: 'Local\\Lares.agent.a.PRIOR_EPOCH' });
  const r = await h.gate.resolve('a');
  assert.equal(r.action, 'leave-unmanaged');
  assert.deepEqual(h.killed, []);
});

// ── fail-closed (native module failure) ──────────────────────────────────────

test('native module unavailable → blocked (fail-closed, no respawn)', async () => {
  const native = makeNative({ supported: false });
  const h = harness(native, { processes: [{ pid: 100, parentPid: 4 }] });
  seedPriorRow(h.db, { agentId: 'a', rootPid: 100, pidCreationTime: null, jobName: null });
  const r = await h.gate.resolve('a');
  assert.equal(r.action, 'blocked');
  assert.deepEqual(h.killed, []);
});

test('native up but owner unverifiable (no stored creation time) → blocked', async () => {
  const native = makeNative({ creationTimes: new Map([[100, 'C100']]) });
  const h = harness(native, { processes: [{ pid: 100, parentPid: 4 }] });
  // Row has a live root PID but we never captured its creation time → cannot
  // prove identity → fail-closed rather than kill on PID match alone.
  seedPriorRow(h.db, { agentId: 'a', rootPid: 100, pidCreationTime: null, jobName: 'Local\\Lares.agent.a.PRIOR_EPOCH' });
  const r = await h.gate.resolve('a');
  assert.equal(r.action, 'blocked');
  assert.deepEqual(h.killed, []);
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
