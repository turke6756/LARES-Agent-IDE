// Idle-agent lifecycle §B4 — guards, snapshot assembly and eligibility.
//
// Covers:
//   - EVERY StopExclusionCode is producible and produced by the right guard;
//   - 'stale-idle' fails closed on every guard, `guard_unavailable` and
//     `ownership_unverified` included; 'explicit' turns the same set into
//     warnings and stays eligible;
//   - a guard source that throws, or a browser state of `null` ("cannot
//     enumerate"), degrades to `guard_unavailable` — never to "clear";
//   - an EMPTY tab list is a clear reading (all flags false), not unavailable;
//   - `lifecycle_busy` is SUPPRESSED for the caller's own locked agent;
//   - OwnershipStore.verifyStopOwnership: WSL → 'wsl-tmux', an absent/released
//     Job Object is NOT a failure, and only the creation-time identity check
//     produces 'unverifiable' (the same mapping findVerifiedTree uses, so
//     eligibility and termination can never disagree).
//
//   npm run build:main
//   node dist/main/main/lifecycle/guards.test.js

import assert from 'node:assert/strict';
import {
  assembleGuardSnapshot,
  evaluateStopEligibility,
  parseIdleSince,
  AUTO_STOP_THRESHOLD_MS,
  type GuardDeps,
  type GuardAgentRow,
  type AgentBrowserState,
  type StopOwnershipKind,
} from './guards';
import { OwnershipStore } from '../supervisor/ownership/ownership-store';
import { initFakeDb, makeFakeDb } from '../supervisor/ownership/fake-db';
import type { JobHandle, NativeJobSurface } from '../supervisor/ownership/types';
import type { StopExclusionCode } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Guard-deps builder ───────────────────────────────────────────────────────

const AGENT = 'agent-1';
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-20T12:00:00Z');

/** idle_since as the DB writes it: SQLite `datetime('now')`, UTC, no zone. */
function idleSinceHoursAgo(h: number): string {
  return new Date(NOW - h * HOUR).toISOString().replace('T', ' ').slice(0, 19);
}

const CLEAR_BROWSER: AgentBrowserState = {
  agentId: AGENT,
  tabCount: 0,
  loading: false,
  signinPending: false,
  needsHumanAttention: false,
  pendingDownload: false,
  activeLease: false,
};

interface DepOverrides extends Partial<GuardDeps> {
  row?: GuardAgentRow | null;
  ownershipKind?: StopOwnershipKind;
}

function makeDeps(over: DepOverrides = {}): GuardDeps {
  const row: GuardAgentRow | null =
    over.row === undefined ? { id: AGENT, status: 'idle', idleSince: idleSinceHoursAgo(48) } : over.row;
  const base: GuardDeps = {
    getAgent: () => row,
    getLiveChildren: () => [],
    activeOrchestrationIds: () => [],
    hasPendingDelivery: () => false,
    isContinuationInFlight: () => false,
    isLifecycleLocked: () => false,
    hasLiveRunner: () => true,
    verifyStopOwnership: () => ({ kind: over.ownershipKind ?? 'verified-job' }),
    getAgentBrowserState: () => CLEAR_BROWSER,
    now: () => NOW,
  };
  const { row: _r, ownershipKind: _k, ...rest } = over;
  return { ...base, ...rest };
}

async function codesFor(over: DepOverrides = {}, mode: 'stale-idle' | 'explicit' = 'stale-idle'): Promise<{
  eligible: boolean;
  exclusions: StopExclusionCode[];
  warnings: StopExclusionCode[];
}> {
  const snap = await assembleGuardSnapshot([AGENT], makeDeps(over), { staleThresholdMs: 24 * HOUR });
  const e = evaluateStopEligibility(AGENT, mode, snap);
  return { eligible: e.eligible, exclusions: e.exclusions, warnings: e.warnings };
}

// ── Baseline ─────────────────────────────────────────────────────────────────

test('a long-idle agent with every guard clear is eligible in BOTH modes', async () => {
  const stale = await codesFor();
  assert.deepEqual(stale.exclusions, []);
  assert.equal(stale.eligible, true);
  const explicit = await codesFor({}, 'explicit');
  assert.equal(explicit.eligible, true);
  assert.deepEqual(explicit.warnings, []);
});

test('idle_since is parsed as UTC — a SQLite datetime() string is not read as local time', () => {
  assert.equal(parseIdleSince('2026-07-20 12:00:00'), Date.parse('2026-07-20T12:00:00Z'));
  assert.equal(parseIdleSince('2026-07-20T12:00:00.000Z'), Date.parse('2026-07-20T12:00:00Z'));
  assert.equal(parseIdleSince(null), null);
  assert.equal(parseIdleSince('not a date'), null);
});

// ── Every exclusion code ─────────────────────────────────────────────────────

test('not_found: the agent row is gone', async () => {
  const r = await codesFor({ row: null });
  assert.deepEqual(r.exclusions, ['not_found']);
  assert.equal(r.eligible, false);
});

test('not_idle: a working agent is never stale-idle eligible', async () => {
  const r = await codesFor({ row: { id: AGENT, status: 'working', idleSince: null } });
  assert.equal(r.exclusions.includes('not_idle'), true);
});

test('threshold_not_met: idle, but not long enough', async () => {
  const r = await codesFor({ row: { id: AGENT, status: 'idle', idleSince: idleSinceHoursAgo(2) } });
  assert.deepEqual(r.exclusions, ['threshold_not_met']);
});

test('threshold_not_met: an idle agent with NO idle clock does not pass by default', async () => {
  const r = await codesFor({ row: { id: AGENT, status: 'idle', idleSince: null } });
  assert.deepEqual(r.exclusions, ['threshold_not_met']);
});

test('active_child: a supervisor with live children', async () => {
  const r = await codesFor({ getLiveChildren: () => [{ id: 'kid', status: 'working', idleSince: null }] });
  assert.deepEqual(r.exclusions, ['active_child']);
});

test('active_orchestration: the agent owns a running deliberation', async () => {
  const r = await codesFor({ activeOrchestrationIds: () => [AGENT] });
  assert.deepEqual(r.exclusions, ['active_orchestration']);
});

test('pending_delivery: an undelivered initial prompt', async () => {
  const r = await codesFor({ hasPendingDelivery: () => true });
  assert.deepEqual(r.exclusions, ['pending_delivery']);
});

test('human_attention: a tab flagged for the human', async () => {
  const r = await codesFor({ getAgentBrowserState: () => ({ ...CLEAR_BROWSER, tabCount: 1, needsHumanAttention: true }) });
  assert.deepEqual(r.exclusions, ['human_attention']);
});

test('human_attention: a sign-in is pending', async () => {
  const r = await codesFor({ getAgentBrowserState: () => ({ ...CLEAR_BROWSER, tabCount: 1, signinPending: true }) });
  assert.deepEqual(r.exclusions, ['human_attention']);
});

test('human_attention: a continuation swap is mid-flight', async () => {
  const r = await codesFor({ isContinuationInFlight: () => true });
  assert.deepEqual(r.exclusions, ['human_attention']);
});

test("human_attention: the agent is parked on a question ('waiting')", async () => {
  const r = await codesFor({ row: { id: AGENT, status: 'waiting', idleSince: null } });
  assert.equal(r.exclusions.includes('human_attention'), true);
});

test('browser_lease: an active action lease', async () => {
  const r = await codesFor({ getAgentBrowserState: () => ({ ...CLEAR_BROWSER, tabCount: 1, activeLease: true }) });
  assert.deepEqual(r.exclusions, ['browser_lease']);
});

test('browser_lease: a loading tab or an in-flight download', async () => {
  const loading = await codesFor({ getAgentBrowserState: () => ({ ...CLEAR_BROWSER, tabCount: 1, loading: true }) });
  assert.deepEqual(loading.exclusions, ['browser_lease']);
  const dl = await codesFor({ getAgentBrowserState: () => ({ ...CLEAR_BROWSER, tabCount: 1, pendingDownload: true }) });
  assert.deepEqual(dl.exclusions, ['browser_lease']);
});

test('detached_process: a verified live process this instance holds no runner for', async () => {
  const r = await codesFor({ hasLiveRunner: () => false });
  assert.deepEqual(r.exclusions, ['detached_process']);
});

test("detached_process is NOT raised when ownership says 'gone' — there is no process to detach from", async () => {
  const r = await codesFor({ ownershipKind: 'gone', hasLiveRunner: () => false });
  assert.deepEqual(r.exclusions, []);
});

test('ownership_unverified: the identity check could not be completed', async () => {
  const r = await codesFor({ ownershipKind: 'unverifiable' });
  assert.deepEqual(r.exclusions, ['ownership_unverified']);
});

test('lifecycle_busy: another lifecycle op holds the lock', async () => {
  const r = await codesFor({ isLifecycleLocked: () => true });
  assert.deepEqual(r.exclusions, ['lifecycle_busy']);
});

test('guard_unavailable: a guard source throws', async () => {
  const r = await codesFor({ hasPendingDelivery: () => { throw new Error('boom'); } });
  assert.deepEqual(r.exclusions, ['guard_unavailable']);
});

test('guard_unavailable: the batch-wide orchestration read throws (every agent fails closed)', async () => {
  const r = await codesFor({ activeOrchestrationIds: () => { throw new Error('boom'); } });
  assert.deepEqual(r.exclusions, ['guard_unavailable']);
});

test('guard_unavailable: a guard returns undefined', async () => {
  const r = await codesFor({ isLifecycleLocked: (() => undefined) as unknown as GuardDeps['isLifecycleLocked'] });
  assert.deepEqual(r.exclusions, ['guard_unavailable']);
});

test('guard_unavailable: an agent that was never snapshotted', async () => {
  const snap = await assembleGuardSnapshot([], makeDeps(), {});
  const e = evaluateStopEligibility('never-seen', 'stale-idle', snap);
  assert.deepEqual(e.exclusions, ['guard_unavailable']);
  assert.equal(e.eligible, false);
});

test('guard_unavailable beats not_found: an unreadable row is not reported as "gone"', async () => {
  const r = await codesFor({ getAgent: () => { throw new Error('db down'); } });
  assert.deepEqual(r.exclusions, ['guard_unavailable']);
});

// ── The browser guard's two null-ish readings are DIFFERENT ─────────────────

test('empty tab list → CLEAR (all-false), not guard_unavailable', async () => {
  const r = await codesFor({ getAgentBrowserState: () => ({ ...CLEAR_BROWSER, tabCount: 0 }) });
  assert.deepEqual(r.exclusions, [], 'an agent that never opened a tab is trivially safe');
});

test('null browser state (cannot enumerate) → guard_unavailable, never "clear"', async () => {
  const r = await codesFor({ getAgentBrowserState: () => null });
  assert.deepEqual(r.exclusions, ['guard_unavailable']);
});

// ── Mode policy ──────────────────────────────────────────────────────────────

test('stale-idle fails CLOSED on a pile of guards at once', async () => {
  const r = await codesFor({
    row: { id: AGENT, status: 'working', idleSince: null },
    getLiveChildren: () => [{ id: 'kid', status: 'idle', idleSince: null }],
    hasPendingDelivery: () => true,
    isLifecycleLocked: () => true,
    ownershipKind: 'unverifiable',
    getAgentBrowserState: () => null,
  });
  assert.equal(r.eligible, false);
  for (const code of ['guard_unavailable', 'not_idle', 'threshold_not_met', 'active_child', 'pending_delivery', 'ownership_unverified', 'lifecycle_busy'] as StopExclusionCode[]) {
    assert.equal(r.exclusions.includes(code), true, `expected ${code}`);
  }
});

test('explicit mode returns eligible with the SAME set as warnings, and no exclusions', async () => {
  const over: DepOverrides = {
    row: { id: AGENT, status: 'working', idleSince: null },
    hasPendingDelivery: () => true,
    ownershipKind: 'unverifiable',
  };
  const stale = await codesFor(over, 'stale-idle');
  const explicit = await codesFor(over, 'explicit');
  assert.equal(explicit.eligible, true);
  assert.deepEqual(explicit.exclusions, []);
  assert.deepEqual(
    explicit.warnings,
    stale.exclusions.filter((c) => c !== 'threshold_not_met'),
    'the idle threshold is a stale-idle concept only; every OTHER guard comes back as a warning',
  );
});

test('explicit mode still cannot stop a missing agent', async () => {
  const r = await codesFor({ row: null }, 'explicit');
  assert.equal(r.eligible, false);
  assert.deepEqual(r.exclusions, ['not_found']);
});

test('explicit mode carries no threshold — an agent idle for 2 minutes warns about nothing', async () => {
  const snap = await assembleGuardSnapshot([AGENT], makeDeps({ row: { id: AGENT, status: 'idle', idleSince: idleSinceHoursAgo(0.03) } }), {});
  const e = evaluateStopEligibility(AGENT, 'explicit', snap);
  assert.deepEqual(e.warnings, []);
  assert.equal(e.eligible, true);
});

// ── selfLockedAgent ──────────────────────────────────────────────────────────

test('lifecycle_busy is SUPPRESSED for the caller\'s own locked agent', async () => {
  const deps = makeDeps({ isLifecycleLocked: () => true });
  const snap = await assembleGuardSnapshot([AGENT], deps, { selfLockedAgent: AGENT, staleThresholdMs: 24 * HOUR });
  const e = evaluateStopEligibility(AGENT, 'stale-idle', snap);
  assert.deepEqual(e.exclusions, [], 'an agent must not be excluded by its OWN lifecycle lock');
  assert.equal(e.eligible, true);
});

test('selfLockedAgent suppresses the lock for that agent ONLY', async () => {
  const other = 'agent-2';
  const deps = makeDeps({
    isLifecycleLocked: () => true,
    getAgent: (id: string) => ({ id, status: 'idle', idleSince: idleSinceHoursAgo(48) }),
  });
  const snap = await assembleGuardSnapshot([AGENT, other], deps, { selfLockedAgent: AGENT, staleThresholdMs: 24 * HOUR });
  assert.deepEqual(evaluateStopEligibility(AGENT, 'stale-idle', snap).exclusions, []);
  assert.deepEqual(evaluateStopEligibility(other, 'stale-idle', snap).exclusions, ['lifecycle_busy']);
});

test('one snapshot judges the whole batch against ONE clock', async () => {
  let calls = 0;
  const deps = makeDeps({
    now: () => { calls++; return NOW; },
    getAgent: (id: string) => ({ id, status: 'idle', idleSince: idleSinceHoursAgo(48) }),
  });
  const snap = await assembleGuardSnapshot(['a', 'b', 'c'], deps, { staleThresholdMs: 24 * HOUR });
  assert.equal(calls, 1, 'the clock is read once per batch, not once per agent');
  assert.equal(snap.agents.size, 3);
});

test('thresholds table matches the AutoStopThreshold enum', () => {
  assert.equal(AUTO_STOP_THRESHOLD_MS.never, null);
  assert.equal(AUTO_STOP_THRESHOLD_MS['24h'], 24 * HOUR);
  assert.equal(AUTO_STOP_THRESHOLD_MS['7d'], 7 * 24 * HOUR);
});

// ── OwnershipStore.verifyStopOwnership ───────────────────────────────────────

function makeNative(opts: { supported?: boolean; creationTimes?: Map<number, string | null> } = {}): NativeJobSurface {
  const supported = opts.supported ?? true;
  const creationTimes = opts.creationTimes ?? new Map<number, string | null>();
  const guard = (): void => { if (!supported) throw new Error('unsupported'); };
  return {
    supported,
    loadError: supported ? null : 'stub',
    jobName: (agentId, epoch) => `Local\\Lares.agent.${agentId}.${epoch}`,
    createNamedJob: (name) => { guard(); return { name } as JobHandle; },
    openNamedJob: (name) => { guard(); return { name } as JobHandle; },
    assignPid: () => { guard(); return true; },
    listJobPids: () => { guard(); return []; },
    terminateJob: () => { guard(); return true; },
    pidCreationTime: (pid) => { guard(); return creationTimes.has(pid) ? creationTimes.get(pid)! : null; },
  };
}

function makeStore(native: NativeJobSurface, epoch = 'EPOCH_1'): OwnershipStore {
  return new OwnershipStore({ db: makeFakeDb(), native, instanceEpoch: epoch, now: () => 1, log: () => {} });
}

test("verifyStopOwnership: no row → 'gone'", () => {
  assert.equal(makeStore(makeNative()).verifyStopOwnership('nobody').kind, 'gone');
});

test("verifyStopOwnership: a WSL agent with a tmux session → 'wsl-tmux'", () => {
  const store = makeStore(makeNative());
  store.recordWslSpawn(AGENT, 'lares_agent_x');
  assert.equal(store.verifyStopOwnership(AGENT).kind, 'wsl-tmux');
});

test("verifyStopOwnership: a verified root with our own job name → 'verified-job'", () => {
  const store = makeStore(makeNative({ creationTimes: new Map([[555, 'CT_555']]) }));
  store.recordWindowsSpawn(AGENT, 555);
  assert.equal(store.verifyStopOwnership(AGENT).kind, 'verified-job');
});

test("verifyStopOwnership: a root gone → 'gone' (nothing of ours survives)", () => {
  const ct = new Map<number, string | null>([[555, 'CT_555']]);
  const store = makeStore(makeNative({ creationTimes: ct }));
  store.recordWindowsSpawn(AGENT, 555);
  ct.delete(555); // process exited
  assert.equal(store.verifyStopOwnership(AGENT).kind, 'gone');
});

test("verifyStopOwnership: a REUSED pid → 'gone', matching what terminateVerifiedAgent does with 'reused'", () => {
  const ct = new Map<number, string | null>([[555, 'CT_555']]);
  const store = makeStore(makeNative({ creationTimes: ct }));
  store.recordWindowsSpawn(AGENT, 555);
  ct.set(555, 'CT_SOMEONE_ELSE');
  assert.equal(store.verifyStopOwnership(AGENT).kind, 'gone');
});

test("verifyStopOwnership: no creation time obtainable → 'unverifiable' (fail-closed)", () => {
  const store = makeStore(makeNative({ supported: false }));
  // A row written with native off has no creation time at all.
  store.recordWindowsSpawn(AGENT, 555);
  assert.equal(store.verifyStopOwnership(AGENT).kind, 'unverifiable');
});

test("verifyStopOwnership: a PRIOR-epoch row still verifies — as 'verified-tree', not a failure", () => {
  const native = makeNative({ creationTimes: new Map([[555, 'CT_555']]) });
  const store = makeStore(native, 'EPOCH_1');
  store.recordWindowsSpawn(AGENT, 555);
  // Same DB, a NEW app instance: the job name belongs to a dead epoch.
  const reopened = new OwnershipStore({
    db: (store as unknown as { deps: { db: ReturnType<typeof makeFakeDb> } }).deps.db,
    native,
    instanceEpoch: 'EPOCH_2',
    now: () => 1,
    log: () => {},
  });
  assert.equal(reopened.verifyStopOwnership(AGENT).kind, 'verified-tree',
    'an unusable Job Object downgrades the kind to the tree walk — it is not a failure');
});

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // The ownership store's SQL runs on the sql.js stand-in (see fake-db.ts).
  await initFakeDb();
  let failures = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${(e as Error).message}`);
    }
  }
  console.log(`\nlifecycle guards: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
