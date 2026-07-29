// WP-5 (terminal-log retention) — the OS-idle full-scan scheduler.
//
//   npm run build:main
//   node dist/main/main/log-retention/log-retention-scheduler.test.js
//
// The executable form of WP-5's "Mutations to kill":
//   - `'unknown'` treated as runnable            → idle-gate-unknown-skips
//   - resume triggering a catch-up scan          → resume-no-catch-up
//   - scanning the directory from collectGauges  → gauges-are-O1-no-inventory
//   - repair-style reclaim of a policy-exempt
//     (marked) bundle                            → marked-live / marked-young NOT selected
//   - a shared path counted twice or selected    → (see inventory test; here: plan honored)
//   - not seeding due time from lastFullScanAt    → restart-within-6h-does-not-rescan
//
// Plus: idle/locked run, active/throw skip, single-flight, due-on-a-later-idle-
// poll, actual-removal counters (partial never overclaims), 'unlimited' cap.

import assert from 'node:assert/strict';
import {
  LogRetentionScheduler,
  FULL_SCAN_CADENCE_MS,
  type LogRetentionSchedulerDeps,
  type RetentionScanSummary,
} from './log-retention-scheduler';
import type { InventoryResult } from './log-retention-inventory';
import type { RetentionBundle } from './log-retention-policy';
import { LOG_RETENTION_MIN_AGE_MS, type LogRetentionState, type RetentionExecutionResult } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

const NOW = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;

function bundle(over: Partial<RetentionBundle> & { agentId: string }): RetentionBundle {
  return { totalBytes: 0, fileCount: 0, newestMtimeMs: null, preliminaryEligible: false, ...over };
}
function inv(bundles: RetentionBundle[], extra: Partial<InventoryResult> = {}): InventoryResult {
  return { bundles, scanErrors: 0, invalidCount: 0, ...extra };
}

interface FakePM {
  pm: NonNullable<LogRetentionSchedulerDeps['powerMonitor']>;
  setIdle(s: string): void;
  setThrow(b: boolean): void;
  fire(ev: 'suspend' | 'resume'): void;
}
function fakePM(initial = 'idle'): FakePM {
  let idleState = initial;
  let throwOnIdle = false;
  const listeners: Record<'suspend' | 'resume', Array<() => void>> = { suspend: [], resume: [] };
  return {
    pm: {
      getSystemIdleState: () => { if (throwOnIdle) throw new Error('powerMonitor wedged'); return idleState; },
      on: (ev, fn) => { listeners[ev].push(fn); },
      removeListener: (ev, fn) => { listeners[ev] = listeners[ev].filter((f) => f !== fn); },
    },
    setIdle: (s) => { idleState = s; },
    setThrow: (b) => { throwOnIdle = b; },
    fire: (ev) => { listeners[ev].slice().forEach((f) => f()); },
  };
}

interface Cap { startupFn: (() => void) | null; intervalFn: (() => void) | null; disarms: number; }

interface Harness {
  sched: LogRetentionScheduler;
  calls: { inventory: number; lastDir: string | null; sweeps: RetentionBundle[][] };
  state: { value: LogRetentionState };
  pm: FakePM;
  cap: Cap;
  now: { ms: number };
  summaries: RetentionScanSummary[];
}
function mk(opts: {
  invResult?: InventoryResult;
  runSweepPlan?: (toSweep: RetentionBundle[]) => Promise<RetentionExecutionResult[]>;
  capBytes?: number;
  initialState?: LogRetentionState;
  idle?: string;
} = {}): Harness {
  const calls = { inventory: 0, lastDir: null as string | null, sweeps: [] as RetentionBundle[][] };
  const state = { value: opts.initialState ?? { lastFullScanAt: null, firstSweepNotice: null } };
  const pm = fakePM(opts.idle ?? 'idle');
  const cap: Cap = { startupFn: null, intervalFn: null, disarms: 0 };
  const now = { ms: NOW };
  const summaries: RetentionScanSummary[] = [];
  const invResult = opts.invResult ?? inv([]);
  const defaultSweep = async (toSweep: RetentionBundle[]): Promise<RetentionExecutionResult[]> =>
    toSweep.map((b) => ({ agentId: b.agentId, outcome: 'removed' as const, removed: [{ path: `${b.agentId}.log`, bytes: b.totalBytes }], failed: [] }));

  const deps: LogRetentionSchedulerDeps = {
    inventory: (dir) => { calls.inventory++; calls.lastDir = dir; return invResult; },
    runSweepPlan: (toSweep) => { calls.sweeps.push(toSweep); return (opts.runSweepPlan ?? defaultSweep)(toSweep); },
    loadCapBytes: () => opts.capBytes ?? Number.POSITIVE_INFINITY,
    getApprovedLogsDir: () => 'APPROVED_DIR',
    powerMonitor: pm.pm,
    now: () => now.ms,
    timers: {
      setTimer: (fn) => { cap.startupFn = fn; return { t: 'startup' }; },
      clearTimer: () => { cap.disarms++; },
      setInterval: (fn) => { cap.intervalFn = fn; return { t: 'interval' }; },
      clearInterval: () => { cap.disarms++; },
    },
    readState: () => state.value,
    writeState: (s) => { state.value = s; },
    emitSweepEvent: (s) => { summaries.push(s); },
    onScanComplete: () => { /* separate sink */ },
    log: () => { /* quiet */ },
  };
  return { sched: new LogRetentionScheduler(deps), calls, state, pm, cap, now, summaries };
}

// ── Idle gate ───────────────────────────────────────────────────────────────

test("idle gate: 'active' skips, no scan", async () => {
  const h = mk({ idle: 'active' });
  await h.sched.tick();
  assert.equal(h.calls.inventory, 0, "'active' → skip");
});

test("idle gate: 'unknown' skips (must NOT be treated as runnable)", async () => {
  const h = mk({ idle: 'unknown' });
  await h.sched.tick();
  assert.equal(h.calls.inventory, 0, "'unknown' → skip (mutation target)");
});

test('idle gate: a throwing getSystemIdleState fails CLOSED (skip)', async () => {
  const h = mk({ idle: 'idle' });
  h.pm.setThrow(true);
  await h.sched.tick();
  assert.equal(h.calls.inventory, 0, 'throw → skip');
});

test("idle gate: 'idle' runs a due scan", async () => {
  const h = mk({ idle: 'idle', invResult: inv([]) });
  await h.sched.tick();
  assert.equal(h.calls.inventory, 1, "'idle' → scan");
});

test("idle gate: 'locked' runs a due scan", async () => {
  const h = mk({ idle: 'locked', invResult: inv([]) });
  await h.sched.tick();
  assert.equal(h.calls.inventory, 1, "'locked' → scan");
});

// ── Cadence seeded from persisted lastFullScanAt ─────────────────────────────

test('restart WITHIN 6h of lastFullScanAt does NOT re-scan (seeded due time)', async () => {
  const recent = new Date(NOW - 3 * 3600 * 1000).toISOString(); // 3h ago
  const h = mk({ idle: 'idle', initialState: { lastFullScanAt: recent, firstSweepNotice: null } });
  h.sched.start(); // seeds lastScanMs from readState
  await h.sched.tick();
  assert.equal(h.calls.inventory, 0, 'within the 6h window → not due → no scan');
});

test('restart AFTER 6h runs once the OS is idle', async () => {
  const stale = new Date(NOW - 7 * 3600 * 1000).toISOString(); // 7h ago
  const h = mk({ idle: 'idle', initialState: { lastFullScanAt: stale, firstSweepNotice: null } });
  h.sched.start();
  await h.sched.tick();
  assert.equal(h.calls.inventory, 1, 'past the 6h window → due → scan');
});

test('a due scan runs on a LATER idle poll though an earlier tick landed while active', async () => {
  const stale = new Date(NOW - 7 * 3600 * 1000).toISOString();
  const h = mk({ idle: 'active', initialState: { lastFullScanAt: stale, firstSweepNotice: null } });
  h.sched.start();
  await h.sched.tick();            // due, but OS active → skip
  assert.equal(h.calls.inventory, 0);
  h.pm.setIdle('idle');
  await h.sched.tick();            // now idle AND still due → scan
  assert.equal(h.calls.inventory, 1);
});

test('after a completed scan, lastFullScanAt is stamped and the next tick is not due', async () => {
  const stale = new Date(NOW - 7 * 3600 * 1000).toISOString();
  const h = mk({ idle: 'idle', initialState: { lastFullScanAt: stale, firstSweepNotice: null } });
  h.sched.start();
  await h.sched.tick();
  assert.equal(h.calls.inventory, 1);
  assert.equal(h.state.value.lastFullScanAt, new Date(NOW).toISOString(), 'scan time persisted');
  await h.sched.tick();            // now within the window (same NOW) → not due
  assert.equal(h.calls.inventory, 1, 'no re-scan until 6h elapse');
  // Advance past the window → due again.
  h.now.ms = NOW + FULL_SCAN_CADENCE_MS;
  await h.sched.tick();
  assert.equal(h.calls.inventory, 2);
});

// ── Single-flight ───────────────────────────────────────────────────────────

test('single-flight: a slow scan is never joined by a second tick', async () => {
  let resolveSweep: (() => void) | null = null;
  const gate = new Promise<void>((r) => { resolveSweep = r; });
  const h = mk({
    idle: 'idle',
    invResult: inv([]),
    runSweepPlan: async () => { await gate; return []; },
  });
  const t1 = h.sched.tick();
  await flush();
  const t2 = h.sched.tick(); // lands mid-scan
  await flush();
  assert.equal(h.calls.inventory, 1, 'only one scan in flight');
  resolveSweep!();
  await Promise.all([t1, t2]);
  assert.equal(h.calls.inventory, 1, 'the second tick joined the in-flight scan');
});

// ── Suspend / resume: no catch-up ────────────────────────────────────────────

test('resume re-arms a FRESH startup delay and does NOT scan (no catch-up burst)', async () => {
  const stale = new Date(NOW - 7 * 3600 * 1000).toISOString();
  const h = mk({ idle: 'idle', initialState: { lastFullScanAt: stale, firstSweepNotice: null } });
  h.sched.start();
  h.cap.startupFn = null; // clear the arm from start()
  h.pm.fire('suspend');
  h.pm.fire('resume');
  await flush();
  assert.equal(h.calls.inventory, 0, 'resume never scans directly');
  assert.ok(h.cap.startupFn !== null, 'resume re-armed a fresh startup delay');
});

test('a tick while suspended is a no-op', async () => {
  const h = mk({ idle: 'idle', invResult: inv([]) });
  h.sched.start(); // registers the suspend/resume listeners
  h.pm.fire('suspend');
  await h.sched.tick();
  assert.equal(h.calls.inventory, 0);
});

// ── collectGauges is O(1), zero fs ───────────────────────────────────────────

test('collectGauges performs NO inventory (O(1) — never a fresh scan)', async () => {
  const h = mk({
    idle: 'idle',
    invResult: inv([bundle({ agentId: 'x', totalBytes: 4096, fileCount: 2, newestMtimeMs: NOW - 8 * DAY, preliminaryEligible: true })], { scanErrors: 0 }),
    capBytes: 0,
  });
  // Before any scan: zeros.
  assert.deepEqual(h.sched.collectGauges(), [
    { name: 'terminal-log-disk', count: 0, bytes: 0 },
    { name: 'terminal-log-reclaimed', count: 0, bytes: 0 },
  ]);
  await h.sched.tick(); // one real scan populates the cache
  const invCallsAfterScan = h.calls.inventory;
  const g1 = h.sched.collectGauges();
  const g2 = h.sched.collectGauges();
  assert.equal(h.calls.inventory, invCallsAfterScan, 'collectGauges did NOT trigger a scan');
  assert.deepEqual(g1, g2, 'idempotent cached read');
  assert.equal(g1[0].name, 'terminal-log-disk');
  assert.equal(g1[0].count, 2, 'managed file count cached from the scan');
  assert.equal(g1[0].bytes, 4096);
});

// ── Counters come from ACTUAL removals ───────────────────────────────────────

test('counters use ACTUAL removals — a partial failure does not overclaim', async () => {
  const b = bundle({ agentId: 'p', totalBytes: 1000, fileCount: 4, newestMtimeMs: NOW - 8 * DAY, preliminaryEligible: true });
  const h = mk({
    idle: 'idle',
    invResult: inv([b]),
    capBytes: 0, // force selection
    // Planned 1000 bytes / 4 files, but only 300 bytes / 1 file actually removed.
    runSweepPlan: async (toSweep) => toSweep.map((x) => ({
      agentId: x.agentId, outcome: 'partial' as const,
      removed: [{ path: `${x.agentId}.log`, bytes: 300 }],
      failed: [{ path: `${x.agentId}.scrollback`, code: 'EBUSY' }],
    })),
  });
  await h.sched.tick();
  const reclaimed = h.sched.collectGauges()[1];
  assert.equal(reclaimed.name, 'terminal-log-reclaimed');
  assert.equal(reclaimed.count, 1, 'only the file ACTUALLY removed is counted (not the 4 planned)');
  assert.equal(reclaimed.bytes, 300, 'only bytes ACTUALLY removed (not 1000 planned)');
  // The first-sweep notice records the ACTUAL reclaim.
  assert.deepEqual(h.state.value.firstSweepNotice, { completedAt: new Date(NOW).toISOString(), agents: 1, bytes: 300, acknowledgedAt: null });
});

test("'unlimited' cap → planner sweeps nothing, but disk gauges still emit", async () => {
  const b = bundle({ agentId: 'u', totalBytes: 9999, fileCount: 3, newestMtimeMs: NOW - 100 * DAY, preliminaryEligible: true });
  const h = mk({ idle: 'idle', invResult: inv([b]), capBytes: Number.POSITIVE_INFINITY });
  await h.sched.tick();
  assert.deepEqual(h.calls.sweeps, [[]], 'nothing selected under an unlimited cap');
  const gauges = h.sched.collectGauges();
  assert.equal(gauges[0].bytes, 9999, 'observability (disk gauge) survives a no-delete cap');
  assert.equal(gauges[1].bytes, 0, 'nothing reclaimed');
  assert.equal(h.state.value.firstSweepNotice, null, 'zero-byte scan raises no banner');
});

// ── No repair pass — marked/exempt bundles are NOT specially selected ─────────

test('a marked+revived LIVE bundle is never selected (preliminaryEligible=false)', async () => {
  // The scheduler consults no marker; a live/revived bundle arrives ineligible.
  const live = bundle({ agentId: 'revived', totalBytes: 5000, fileCount: 2, newestMtimeMs: NOW - 30 * DAY, preliminaryEligible: false, blocker: 'live-runner' });
  const h = mk({ idle: 'idle', invResult: inv([live]), capBytes: 0 });
  await h.sched.tick();
  assert.deepEqual(h.calls.sweeps, [[]], 'a live bundle is not swept, marked or not');
});

test('a marked recently-stopped bundle younger than 7 days is not selected (age gate)', async () => {
  const young = bundle({ agentId: 'fresh', totalBytes: 5000, fileCount: 2, newestMtimeMs: NOW - 1 * DAY, preliminaryEligible: true });
  const h = mk({ idle: 'idle', invResult: inv([young]), capBytes: 0 });
  await h.sched.tick();
  assert.deepEqual(h.calls.sweeps, [[]], 'younger than the 7-day min age → not selected');
});

test('a marked OLD terminal bundle over target IS selected normally (no exemption)', async () => {
  const old = bundle({ agentId: 'old', totalBytes: 5000, fileCount: 2, newestMtimeMs: NOW - (LOG_RETENTION_MIN_AGE_MS + DAY), preliminaryEligible: true });
  const h = mk({ idle: 'idle', invResult: inv([old]), capBytes: 0 });
  await h.sched.tick();
  assert.equal(h.calls.sweeps.length, 1);
  assert.deepEqual(h.calls.sweeps[0].map((b) => b.agentId), ['old'], 'ordinary policy selects the old, over-target bundle');
});

// ── The scan feeds the exact minAge + now the planner needs ──────────────────

test('boundary: a bundle aged EXACTLY minAge is selected (inclusive)', async () => {
  const exact = bundle({ agentId: 'edge', totalBytes: 5000, fileCount: 1, newestMtimeMs: NOW - LOG_RETENTION_MIN_AGE_MS, preliminaryEligible: true });
  const h = mk({ idle: 'idle', invResult: inv([exact]), capBytes: 0 });
  await h.sched.tick();
  assert.deepEqual(h.calls.sweeps[0].map((b) => b.agentId), ['edge']);
});

// ── Seam: inventory + executor both consume getApprovedLogsDirForRetention() ──

test('inventory receives the dir from getApprovedLogsDir (same source the executor reclaims under)', async () => {
  const h = mk({ idle: 'idle', invResult: inv([]) });
  await h.sched.tick();
  assert.equal(h.calls.lastDir, 'APPROVED_DIR', 'the scan dir flows from getApprovedLogsDir()');
});

// ── stop drains ──────────────────────────────────────────────────────────────

test('stop() drains an in-flight scan and unhooks power events', async () => {
  let resolveSweep: (() => void) | null = null;
  const gate = new Promise<void>((r) => { resolveSweep = r; });
  const h = mk({ idle: 'idle', invResult: inv([]), runSweepPlan: async () => { await gate; return []; } });
  const t = h.sched.tick();
  await flush();
  const stopP = h.sched.stop();
  resolveSweep!();
  await Promise.all([t, stopP]);
  // A tick after stop is inert.
  await h.sched.tick();
  assert.equal(h.calls.inventory, 1, 'no scan after stop');
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
