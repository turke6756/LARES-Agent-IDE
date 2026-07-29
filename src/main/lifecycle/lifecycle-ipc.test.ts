// Idle-agent lifecycle §B7/§B9 — settings persistence, the IPC surface, the
// bulk runner and the stale-idle sweep.
//
// Covers:
//   - PER-ENDPOINT REASON ASSIGNMENT: a renderer cannot claim
//     'automatic-stale-idle' (or any other main-only reason) through ANY
//     endpoint, however it shapes its payload;
//   - validation: bad modes fall back, non-string ids are dropped, ids are
//     deduped and then capped at BULK_STOP_MAX;
//   - explicit + warnings + !confirmActive → 'skipped' with the warnings;
//   - settings: atomic write (temp + rename), malformed-file fallback, enum
//     validation main-side, and a broadcast to ALL windows;
//   - the sweep: single-flight, 'never' → no-op, settings re-read every run,
//     suspend/resume re-arms a FRESH delay with no catch-up burst, and stop()
//     drains an in-flight run.
//
//   npm run build:main
//   node dist/main/main/lifecycle/lifecycle-ipc.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeBulkRequest,
  runBulkStop,
  buildStaleIdlePreview,
  registerLifecycleIpc,
  LIFECYCLE_CHANNELS,
  type BulkStopDeps,
} from './lifecycle-ipc';
import { IdleSweep, STARTUP_DELAY_MS, INTERVAL_MS } from './idle-sweep';
import { loadLifecycleSettings, saveLifecycleSettings, lifecycleSettingsPath } from './lifecycle-settings';
import { BULK_STOP_MAX, DEFAULT_LIFECYCLE_SETTINGS, type AgentStopReason, type BulkStopItemResult, type LifecycleSettings } from '../../shared/types';
import type { GuardAgentRow, GuardDeps } from './guards';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const HOUR = 60 * 60 * 1000;

// ── Deps harness ─────────────────────────────────────────────────────────────

interface Harness {
  deps: BulkStopDeps;
  calls: Array<{ agentId: string; mode: string; reason: AgentStopReason; confirmActive?: boolean }>;
  settings: LifecycleSettings;
  broadcasts: LifecycleSettings[];
  agents: GuardAgentRow[];
  /** Guard codes to return as warnings/exclusions for a given agent. */
  warn: Set<string>;
}

function makeHarness(over: { agents?: GuardAgentRow[]; threshold?: LifecycleSettings['autoStopIdleThreshold'] } = {}): Harness {
  const idleSince = new Date(Date.now() - 48 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
  const h: Harness = {
    calls: [],
    settings: { autoStopIdleThreshold: over.threshold ?? '24h' },
    broadcasts: [],
    agents: over.agents ?? [{ id: 'a1', status: 'idle', idleSince }],
    warn: new Set<string>(),
    deps: null as unknown as BulkStopDeps,
  };
  const guardDeps: GuardDeps = {
    getAgent: (id) => h.agents.find((a) => a.id === id) ?? null,
    getLiveChildren: (id) => (h.warn.has(id) ? [{ id: 'kid', status: 'working', idleSince: null }] : []),
    activeOrchestrationIds: () => [],
    hasPendingDelivery: () => false,
    isContinuationInFlight: () => false,
    isLifecycleLocked: () => false,
    hasLiveRunner: () => true,
    verifyStopOwnership: () => ({ kind: 'verified-job' }),
    getAgentBrowserState: (id) => ({
      agentId: id, tabCount: 0, loading: false, signinPending: false,
      needsHumanAttention: false, pendingDownload: false, activeLease: false,
    }),
    now: () => Date.now(),
  };
  h.deps = {
    stopIfEligible: async (agentId, mode, reason, opts): Promise<BulkStopItemResult> => {
      h.calls.push({ agentId, mode, reason, confirmActive: opts?.confirmActive });
      return { agentId, result: 'stopped', codes: [], outcome: 'stopped' };
    },
    listAgents: () => h.agents,
    guardDeps,
    loadSettings: () => h.settings,
    saveSettings: (s) => { h.settings = s; return s; },
    broadcastSettings: (s) => { h.broadcasts.push(s); },
  };
  return h;
}

interface FakeIpc {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}
function makeIpc(): FakeIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel, listener) { handlers.set(channel, listener); },
    async invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({}, ...args);
    },
  };
}

// ── Reason assignment: the security property ─────────────────────────────────

test('every stop endpoint assigns its OWN reason', async () => {
  const h = makeHarness();
  const ipc = makeIpc();
  registerLifecycleIpc(ipc, h.deps);
  await ipc.invoke(LIFECYCLE_CHANNELS.stop, 'a1');
  await ipc.invoke(LIFECYCLE_CHANNELS.stopBulk, { agentIds: ['a1'], mode: 'explicit', confirmActive: true });
  await ipc.invoke(LIFECYCLE_CHANNELS.stopStaleIdle);
  assert.deepEqual(h.calls.map((c) => c.reason), ['manual-card', 'manual-selection', 'manual-stale-idle']);
});

test('a renderer CANNOT claim automatic-stale-idle (or any main-only reason) on any endpoint', async () => {
  const h = makeHarness();
  const ipc = makeIpc();
  registerLifecycleIpc(ipc, h.deps);
  const forged = ['automatic-stale-idle', 'supervisor', 'restart', 'terminal-capture-failure'];
  for (const reason of forged) {
    await ipc.invoke(LIFECYCLE_CHANNELS.stopBulk, { agentIds: ['a1'], mode: 'explicit', confirmActive: true, reason });
    await ipc.invoke(LIFECYCLE_CHANNELS.stop, 'a1');
    await ipc.invoke(LIFECYCLE_CHANNELS.stopStaleIdle, { reason });
  }
  const seen = new Set(h.calls.map((c) => c.reason));
  assert.deepEqual([...seen].sort(), ['manual-card', 'manual-selection', 'manual-stale-idle']);
  for (const forgedReason of forged) {
    assert.equal(seen.has(forgedReason as AgentStopReason), false, `${forgedReason} must be unreachable from IPC`);
  }
});

test('the main-only reasons have NO ipc channel of their own', () => {
  const ipc = makeIpc();
  registerLifecycleIpc(ipc, makeHarness().deps);
  const channels = [...ipc.handlers.keys()];
  assert.deepEqual(channels.sort(), [
    'agent:preview-stale-idle', 'agent:stop', 'agent:stop-bulk', 'agent:stop-stale-idle',
    'lifecycle:get-settings', 'lifecycle:set-settings',
  ]);
});

// ── Request validation ───────────────────────────────────────────────────────

test('normalizeBulkRequest: an invalid mode falls back to explicit', () => {
  assert.equal(normalizeBulkRequest({ agentIds: [], mode: 'wat' }).mode, 'explicit');
  assert.equal(normalizeBulkRequest({ agentIds: [], mode: 'stale-idle' }).mode, 'stale-idle');
  assert.equal(normalizeBulkRequest(null).mode, 'explicit');
});

test('normalizeBulkRequest: non-string ids are dropped and duplicates deduped', () => {
  const r = normalizeBulkRequest({ agentIds: ['a', 'a', '', 7, null, { id: 'b' }, 'b'], mode: 'explicit' });
  assert.deepEqual(r.agentIds, ['a', 'b']);
});

test('normalizeBulkRequest: dedupe FIRST, then cap at BULK_STOP_MAX', () => {
  const ids = Array.from({ length: BULK_STOP_MAX + 50 }, (_, i) => `a${i}`);
  assert.equal(normalizeBulkRequest({ agentIds: ids, mode: 'explicit' }).agentIds.length, BULK_STOP_MAX);
  // 300 copies of one id must not consume the cap.
  const dupes = Array.from({ length: 300 }, () => 'same');
  assert.deepEqual(normalizeBulkRequest({ agentIds: dupes, mode: 'explicit' }).agentIds, ['same']);
});

test('confirmActive is only true when literally true', () => {
  assert.equal(normalizeBulkRequest({ agentIds: [], mode: 'explicit', confirmActive: 'yes' }).confirmActive, false);
  assert.equal(normalizeBulkRequest({ agentIds: [], mode: 'explicit', confirmActive: 1 }).confirmActive, false);
  assert.equal(normalizeBulkRequest({ agentIds: [], mode: 'explicit', confirmActive: true }).confirmActive, true);
});

// ── The runner ───────────────────────────────────────────────────────────────

test('runBulkStop is SEQUENTIAL and carries confirmActive through to the locked stop', async () => {
  const h = makeHarness();
  const order: string[] = [];
  h.deps.stopIfEligible = async (agentId, _m, _r, opts) => {
    order.push(`start:${agentId}`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`end:${agentId}`);
    h.calls.push({ agentId, mode: _m, reason: _r, confirmActive: opts?.confirmActive });
    return { agentId, result: 'stopped', codes: [] };
  };
  await runBulkStop({ agentIds: ['a', 'b'], mode: 'explicit', confirmActive: true }, 'manual-selection', h.deps);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  assert.deepEqual(h.calls.map((c) => c.confirmActive), [true, true]);
});

test('explicit + warnings + !confirmActive → skipped with the warnings as codes', async () => {
  const h = makeHarness();
  // A realistic stopIfEligible: it is the one that applies the gate (§B6.1).
  h.deps.stopIfEligible = async (agentId, mode, _r, opts) => {
    const warnings = ['not_idle' as const];
    if (mode === 'explicit' && warnings.length > 0 && opts?.confirmActive !== true) {
      return { agentId, result: 'skipped', codes: warnings };
    }
    return { agentId, result: 'stopped', codes: [] };
  };
  const skipped = await runBulkStop({ agentIds: ['a'], mode: 'explicit' }, 'manual-selection', h.deps);
  assert.deepEqual(skipped.items, [{ agentId: 'a', result: 'skipped', codes: ['not_idle'] }]);
  const stopped = await runBulkStop({ agentIds: ['a'], mode: 'explicit', confirmActive: true }, 'manual-selection', h.deps);
  assert.equal(stopped.items[0].result, 'stopped');
});

test("one agent's failure never aborts the batch", async () => {
  const h = makeHarness();
  h.deps.stopIfEligible = async (agentId) => {
    if (agentId === 'boom') throw new Error('kaboom');
    return { agentId, result: 'stopped', codes: [] };
  };
  const r = await runBulkStop({ agentIds: ['a', 'boom', 'b'], mode: 'explicit' }, 'manual-selection', h.deps);
  assert.deepEqual(r.items.map((i) => i.result), ['stopped', 'failed', 'stopped']);
});

// ── Preview ──────────────────────────────────────────────────────────────────

test('preview splits eligible from excluded-with-codes', async () => {
  const idleSince = new Date(Date.now() - 48 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
  const recent = new Date(Date.now() - 1 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
  const h = makeHarness({
    agents: [
      { id: 'old', status: 'idle', idleSince },
      { id: 'busy', status: 'idle', idleSince },
      { id: 'recent', status: 'idle', idleSince: recent },
      { id: 'working', status: 'working', idleSince: null },
    ],
  });
  h.warn.add('busy'); // gets a live child
  const p = await buildStaleIdlePreview(h.deps);
  assert.equal(p.thresholdLabel, '24h');
  assert.deepEqual(p.eligible.map((e) => e.agentId), ['old']);
  assert.deepEqual(p.excluded, [{ agentId: 'busy', codes: ['active_child'] }],
    'a merely-too-recent agent is not listed as excluded; a guarded one is');
});

test("preview with threshold 'never' is empty", async () => {
  const h = makeHarness({ threshold: 'never' });
  const p = await buildStaleIdlePreview(h.deps);
  assert.deepEqual(p.eligible, []);
  assert.deepEqual(p.excluded, []);
});

// ── Reclaim estimate (System-Memory polish Part 4) ───────────────────────────

test('estimator absent → both reclaim fields null (back-compat)', async () => {
  const h = makeHarness();
  assert.equal(h.deps.estimateAgentBytes, undefined);
  const p = await buildStaleIdlePreview(h.deps);
  assert.deepEqual(p.eligible.map((e) => e.agentId), ['a1'], 'preview fully functional without an estimator');
  assert.equal(p.estimatedReclaimBytes, null);
  assert.equal(p.reclaimEstimateComplete, null);
});

test('all eligible agents resolved → exact bytes + complete true', async () => {
  const h = makeHarness();
  let asked: string[] = [];
  h.deps.estimateAgentBytes = (ids) => { asked = ids; return { bytes: 1234, complete: true }; };
  const p = await buildStaleIdlePreview(h.deps);
  assert.deepEqual(asked, ['a1'], 'the estimator is asked about exactly the eligible set');
  assert.equal(p.estimatedReclaimBytes, 1234);
  assert.equal(p.reclaimEstimateComplete, true);
});

test('one agent unresolved → partial sum + complete false', async () => {
  const h = makeHarness();
  h.deps.estimateAgentBytes = () => ({ bytes: 500, complete: false });
  const p = await buildStaleIdlePreview(h.deps);
  assert.equal(p.estimatedReclaimBytes, 500);
  assert.equal(p.reclaimEstimateComplete, false);
});

test('attribution cold (estimator returns null) → both fields null, preview intact', async () => {
  const h = makeHarness();
  h.deps.estimateAgentBytes = () => null;
  const p = await buildStaleIdlePreview(h.deps);
  assert.deepEqual(p.eligible.map((e) => e.agentId), ['a1']);
  assert.equal(p.estimatedReclaimBytes, null);
  assert.equal(p.reclaimEstimateComplete, null);
});

test("threshold 'never' returns before the estimator is consulted", async () => {
  const h = makeHarness({ threshold: 'never' });
  let called = 0;
  h.deps.estimateAgentBytes = () => { called++; return { bytes: 9, complete: true }; };
  const p = await buildStaleIdlePreview(h.deps);
  assert.equal(called, 0);
  assert.equal(p.estimatedReclaimBytes, null);
  assert.equal(p.reclaimEstimateComplete, null);
});

// ── Settings ─────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lares-lifecycle-'));
}

test('settings round-trip through the file', () => {
  const dir = tmpDir();
  assert.deepEqual(loadLifecycleSettings(dir), DEFAULT_LIFECYCLE_SETTINGS, 'first run → default');
  saveLifecycleSettings({ autoStopIdleThreshold: '7d' }, dir);
  // Terminal-log retention (WP-1): load/save now validate each field
  // independently and merge with defaults, so a saved threshold reads back with
  // the defaulted logRetentionCap alongside it.
  assert.deepEqual(loadLifecycleSettings(dir), { autoStopIdleThreshold: '7d', logRetentionCap: '2gib' });
});

test('the write is ATOMIC (temp file + rename) and leaves no temp behind', () => {
  const dir = tmpDir();
  saveLifecycleSettings({ autoStopIdleThreshold: '6h' }, dir);
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['lifecycle-settings.json'], 'the .tmp staging file is renamed, never left');
  assert.equal(JSON.parse(fs.readFileSync(lifecycleSettingsPath(dir), 'utf8')).autoStopIdleThreshold, '6h');
});

test('a malformed file falls back to the default rather than trusting disk', () => {
  const dir = tmpDir();
  for (const junk of ['', '{', 'null', '{"autoStopIdleThreshold":"forever"}', '{"autoStopIdleThreshold":42}', '[]']) {
    fs.writeFileSync(lifecycleSettingsPath(dir), junk, 'utf8');
    assert.deepEqual(loadLifecycleSettings(dir), DEFAULT_LIFECYCLE_SETTINGS, `junk: ${junk}`);
  }
});

test('an invalid threshold is never persisted', () => {
  const dir = tmpDir();
  const saved = saveLifecycleSettings({ autoStopIdleThreshold: 'forever' as never }, dir);
  assert.deepEqual(saved, DEFAULT_LIFECYCLE_SETTINGS);
  assert.deepEqual(loadLifecycleSettings(dir), DEFAULT_LIFECYCLE_SETTINGS);
});

test('lifecycle:set-settings validates main-side and broadcasts to ALL windows', async () => {
  const h = makeHarness();
  const ipc = makeIpc();
  registerLifecycleIpc(ipc, h.deps);
  // WP-7: set-settings loads current → merges the partial → validates each field
  // → saves the FULL two-field settings. The current settings carry no explicit
  // cap, so it defaults to '2gib' alongside the accepted threshold.
  const ok = await ipc.invoke(LIFECYCLE_CHANNELS.setSettings, { autoStopIdleThreshold: '12h' });
  assert.deepEqual(ok, { autoStopIdleThreshold: '12h', logRetentionCap: '2gib' });
  assert.deepEqual(h.broadcasts, [{ autoStopIdleThreshold: '12h', logRetentionCap: '2gib' }]);

  const bad = await ipc.invoke(LIFECYCLE_CHANNELS.setSettings, { autoStopIdleThreshold: '999y' });
  // The invalid threshold falls back — but the PERSISTED sibling ('12h' from the
  // prior write, now the current value) is what an invalid threshold defaults
  // to, not the hard default. The cap remains '2gib'.
  assert.deepEqual(bad, { autoStopIdleThreshold: '12h', logRetentionCap: '2gib' },
    'a renderer-supplied bad enum falls back to the persisted value, never widening it');
  assert.deepEqual(await ipc.invoke(LIFECYCLE_CHANNELS.getSettings), { autoStopIdleThreshold: '12h', logRetentionCap: '2gib' });
  assert.equal(h.broadcasts.length, 2, 'every accepted write is broadcast');
});

test('WP-7: a partial set-settings preserves the SIBLING field (cap↔threshold never clobber)', async () => {
  const h = makeHarness();
  h.settings = { autoStopIdleThreshold: '7d', logRetentionCap: '5gib' };
  const ipc = makeIpc();
  registerLifecycleIpc(ipc, h.deps);

  // Change ONLY the cap → the threshold '7d' survives.
  const afterCap = await ipc.invoke(LIFECYCLE_CHANNELS.setSettings, { logRetentionCap: '1gib' });
  assert.deepEqual(afterCap, { autoStopIdleThreshold: '7d', logRetentionCap: '1gib' },
    'a cap-only set keeps the persisted threshold');

  // Now change ONLY the threshold → the cap '1gib' survives.
  const afterThreshold = await ipc.invoke(LIFECYCLE_CHANNELS.setSettings, { autoStopIdleThreshold: '6h' });
  assert.deepEqual(afterThreshold, { autoStopIdleThreshold: '6h', logRetentionCap: '1gib' },
    'a threshold-only set keeps the persisted cap');

  assert.deepEqual(h.broadcasts, [
    { autoStopIdleThreshold: '7d', logRetentionCap: '1gib' },
    { autoStopIdleThreshold: '6h', logRetentionCap: '1gib' },
  ]);
});

test('WP-7: an invalid partial field falls back without disturbing the sibling', async () => {
  const h = makeHarness();
  h.settings = { autoStopIdleThreshold: '3d', logRetentionCap: '5gib' };
  const ipc = makeIpc();
  registerLifecycleIpc(ipc, h.deps);
  // A garbage cap must not reset the threshold; the cap defaults to the
  // persisted '5gib' (validation is per-field).
  const r = await ipc.invoke(LIFECYCLE_CHANNELS.setSettings, { logRetentionCap: 'HUGE' });
  assert.deepEqual(r, { autoStopIdleThreshold: '3d', logRetentionCap: '5gib' });
});

// ── The sweep ────────────────────────────────────────────────────────────────

interface FakeClock {
  timers: Array<{ fn: () => void; ms: number; kind: 'timeout' | 'interval'; id: number }>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  setIntervalTimer(fn: () => void, ms: number): unknown;
  clearIntervalTimer(h: unknown): void;
  fire(kind: 'timeout' | 'interval'): void;
}
function makeClock(): FakeClock {
  let next = 1;
  const c: FakeClock = {
    timers: [],
    setTimer(fn, ms) { const id = next++; c.timers.push({ fn, ms, kind: 'timeout', id }); return id; },
    clearTimer(h) { c.timers = c.timers.filter((t) => t.id !== h); },
    setIntervalTimer(fn, ms) { const id = next++; c.timers.push({ fn, ms, kind: 'interval', id }); return id; },
    clearIntervalTimer(h) { c.timers = c.timers.filter((t) => t.id !== h); },
    // A real setTimeout is one-shot: it must not linger in the pending list.
    fire(kind) {
      const due = c.timers.filter((x) => x.kind === kind);
      if (kind === 'timeout') c.timers = c.timers.filter((x) => x.kind !== 'timeout');
      for (const t of due) t.fn();
    },
  };
  return c;
}

function makePower(): PowerFake { return new PowerFake(); }
class PowerFake {
  listeners = new Map<string, Set<() => void>>();
  on(ev: string, fn: () => void): void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
  }
  removeListener(ev: string, fn: () => void): void { this.listeners.get(ev)?.delete(fn); }
  emit(ev: string): void { for (const fn of this.listeners.get(ev) ?? []) fn(); }
  count(): number { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
}

function makeSweep(h: Harness, clock: FakeClock, power: PowerFake): IdleSweep {
  return new IdleSweep({
    ...h.deps,
    powerMonitor: power as unknown as { on(e: 'suspend' | 'resume', l: () => void): unknown; removeListener(e: 'suspend' | 'resume', l: () => void): unknown },
    log: (m: string) => { if (/failed/.test(m)) console.error(m); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    setIntervalTimer: clock.setIntervalTimer,
    clearIntervalTimer: clock.clearIntervalTimer,
  });
}

test('the sweep waits STARTUP_DELAY_MS, then runs on INTERVAL_MS', async () => {
  const h = makeHarness();
  const clock = makeClock();
  const sweep = makeSweep(h, clock, makePower());
  sweep.start();
  assert.deepEqual(clock.timers.map((t) => [t.kind, t.ms]), [['timeout', STARTUP_DELAY_MS]]);
  clock.fire('timeout');
  await sweep.runOnce();
  assert.deepEqual(clock.timers.map((t) => [t.kind, t.ms]), [['interval', INTERVAL_MS]]);
  await sweep.stop();
});

test("the sweep re-reads settings every run — 'never' is an immediate no-op", async () => {
  const h = makeHarness({ threshold: 'never' });
  const clock = makeClock();
  const sweep = makeSweep(h, clock, makePower());
  await sweep.runOnce();
  assert.equal(h.calls.length, 0, "'never' stops nothing");
  h.settings = { autoStopIdleThreshold: '24h' };
  await sweep.runOnce();
  assert.deepEqual(h.calls.map((c) => c.reason), ['automatic-stale-idle'],
    'the very next run picks the change up — no cached threshold');
  await sweep.stop();
});

test('the sweep is SINGLE-FLIGHT: a slow run is never joined by a second', async () => {
  const h = makeHarness();
  let running = 0;
  let peak = 0;
  const box: { release: (() => void) | null } = { release: null };
  h.deps.stopIfEligible = async (agentId, mode, reason) => {
    running++; peak = Math.max(peak, running);
    await new Promise<void>((r) => { box.release = r; });
    running--;
    h.calls.push({ agentId, mode, reason });
    return { agentId, result: 'stopped', codes: [] };
  };
  const sweep = makeSweep(h, makeClock(), makePower());
  const first = sweep.runOnce();
  await new Promise((r) => setImmediate(r));
  const second = sweep.runOnce();
  assert.equal(second, first, 'the second call returns the SAME in-flight run');
  box.release?.();
  await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.equal(h.calls.length, 1, 'the batch ran exactly once');
  await sweep.stop();
});

test('suspend disarms; resume re-arms a FRESH startup delay with no catch-up burst', async () => {
  const h = makeHarness();
  const clock = makeClock();
  const power = makePower();
  const sweep = makeSweep(h, clock, power);
  sweep.start();
  clock.fire('timeout'); // past the startup delay, now on the interval
  await sweep.runOnce();
  h.calls.length = 0;

  power.emit('suspend');
  assert.equal(clock.timers.length, 0, 'no timers survive suspend');
  await sweep.runOnce();
  assert.equal(h.calls.length, 0, 'nothing runs while suspended');

  power.emit('resume');
  assert.deepEqual(clock.timers.map((t) => [t.kind, t.ms]), [['timeout', STARTUP_DELAY_MS]],
    'a FRESH startup delay, not an immediate interval — no catch-up burst for the missed ticks');
  assert.equal(h.calls.length, 0, 'and nothing was stopped the instant the lid opened');
  await sweep.stop();
});

test('stop() clears timers, unhooks powerMonitor and drains the in-flight run', async () => {
  const h = makeHarness();
  const clock = makeClock();
  const power = makePower();
  let finished = false;
  const box: { release: (() => void) | null } = { release: null };
  h.deps.stopIfEligible = async (agentId) => {
    await new Promise<void>((r) => { box.release = r; });
    finished = true;
    return { agentId, result: 'stopped', codes: [] };
  };
  const sweep = makeSweep(h, clock, power);
  sweep.start();
  assert.equal(power.count(), 2);
  const run = sweep.runOnce();
  await new Promise((r) => setImmediate(r));
  const stopping = sweep.stop();
  box.release?.();
  await stopping;
  assert.equal(finished, true, 'shutdown waited for the in-flight kill instead of abandoning it');
  assert.deepEqual(clock.timers, []);
  assert.equal(power.count(), 0, 'power hooks unregistered');
  await run;
  await sweep.runOnce();
  assert.equal(h.calls.length, 0, 'a stopped sweep never runs again');
});

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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
  console.log(`\nlifecycle ipc/settings/sweep: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
