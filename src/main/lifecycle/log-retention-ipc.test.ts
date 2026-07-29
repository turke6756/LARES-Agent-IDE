// WP-8 (terminal-log retention) — first-sweep IPC + broadcast + scan-complete
// sinks.
//
//   npm run build:main
//   node dist/main/main/lifecycle/log-retention-ipc.test.js
//
// Covers the four delivery/wiring seams and the mutations WP-8 must kill:
//   - broadcast reaches MULTIPLE windows and SKIPS destroyed ones
//     (single-window-broadcast mutation);
//   - get-state pulls; acknowledge persists + rebroadcasts;
//   - the sweep-event carries ACTUAL before/after results (never estimates);
//   - the sinks read the LIVE telemetry via an accessor, so the scheduler can be
//     constructed before telemetry yet started only after — a sink bound to the
//     null telemetry at construction (the "start before sinks assigned"
//     mutation) would drop every sweep line.

import assert from 'node:assert/strict';
import {
  LOG_RETENTION_CHANNELS,
  broadcastLogRetentionState,
  registerLogRetentionIpc,
  buildLogRetentionSweepEvent,
  makeRetentionSinks,
  type BroadcastWindowLike,
  type LogRetentionIpcLike,
} from './log-retention-ipc';
import type { LogRetentionState } from '../../shared/types';
import type { RetentionScanSummary } from '../log-retention/log-retention-scheduler';
import type { LogRetentionSweepEvent } from '../watchdog/heap-telemetry';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface FakeWindow extends BroadcastWindowLike {
  sent: Array<{ channel: string; state: LogRetentionState }>;
}
function fakeWindow(destroyed = false): FakeWindow {
  const sent: FakeWindow['sent'] = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, state: unknown) => { sent.push({ channel, state: state as LogRetentionState }); } },
  };
}

function noticeState(over?: Partial<NonNullable<LogRetentionState['firstSweepNotice']>>): LogRetentionState {
  return {
    lastFullScanAt: '2026-07-27T00:00:00.000Z',
    firstSweepNotice: { completedAt: '2026-07-27T00:00:00.000Z', agents: 3, bytes: 4096, acknowledgedAt: null, ...over },
  };
}

function summary(over?: Partial<RetentionScanSummary>): RetentionScanSummary {
  return {
    scannedAt: '2026-07-27T09:00:00.000Z',
    managedFileCount: 10,
    managedBytes: 5000,
    filesRemoved: 4,
    bytesReclaimed: 2000,
    agentsReclaimed: 2,
    scanErrors: 0,
    invalidCount: 0,
    outcome: 'swept-to-target',
    ...over,
  };
}

// ── broadcast: every window, skip destroyed ────────────────────────────────────

test('broadcast reaches EVERY live window (not just the first)', () => {
  const a = fakeWindow(); const b = fakeWindow(); const c = fakeWindow();
  const state = noticeState();
  broadcastLogRetentionState(() => [a, b, c], state);
  for (const w of [a, b, c]) {
    assert.equal(w.sent.length, 1, 'each live window received exactly one push');
    assert.equal(w.sent[0].channel, LOG_RETENTION_CHANNELS.stateChanged);
    assert.deepEqual(w.sent[0].state, state);
  }
});

test('broadcast SKIPS a destroyed window (never sends to it)', () => {
  const live = fakeWindow(false);
  const dead = fakeWindow(true);
  broadcastLogRetentionState(() => [live, dead], noticeState());
  assert.equal(live.sent.length, 1, 'the live window got the push');
  assert.equal(dead.sent.length, 0, 'the destroyed window was skipped');
});

// ── IPC: pull + acknowledge ────────────────────────────────────────────────────

function fakeIpc(): { ipc: LogRetentionIpcLike; handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    handlers,
  };
}

test('get-state returns the current durable state (PULL)', () => {
  const { ipc, handlers } = fakeIpc();
  const state = noticeState();
  registerLogRetentionIpc(ipc, {
    readState: () => state,
    acknowledge: () => {},
    broadcast: () => {},
    now: () => Date.parse('2026-07-27T10:00:00.000Z'),
  });
  const got = handlers.get(LOG_RETENTION_CHANNELS.getState)!(null);
  assert.deepEqual(got, state);
});

test('acknowledge sets acknowledgedAt (via the injected writer), rebroadcasts, and returns the fresh state', () => {
  const { ipc, handlers } = fakeIpc();
  let current = noticeState();
  const broadcasts: LogRetentionState[] = [];
  let ackIso: string | null = null;
  registerLogRetentionIpc(ipc, {
    readState: () => current,
    acknowledge: (nowIso) => { ackIso = nowIso; current = noticeState({ acknowledgedAt: nowIso }); },
    broadcast: (s) => broadcasts.push(s),
    now: () => Date.parse('2026-07-27T10:30:00.000Z'),
  });
  const returned = handlers.get(LOG_RETENTION_CHANNELS.acknowledgeNotice)!(null) as LogRetentionState;
  assert.equal(ackIso, '2026-07-27T10:30:00.000Z', 'acknowledge received the injected now as ISO');
  assert.equal(returned.firstSweepNotice?.acknowledgedAt, '2026-07-27T10:30:00.000Z');
  assert.equal(broadcasts.length, 1, 'acknowledgement rebroadcasts so a second window clears too');
  assert.deepEqual(broadcasts[0], returned, 'the broadcast carries the fresh (acknowledged) state');
});

// ── sweep-event mapping: ACTUAL before/after ───────────────────────────────────

test('buildLogRetentionSweepEvent maps ACTUAL before/after + honest duration', () => {
  const ev = buildLogRetentionSweepEvent(summary(), 2 * 1024 ** 3, Date.parse('2026-07-27T09:00:02.500Z'));
  assert.equal(ev.beforeBytes, 5000, 'beforeBytes = managed disk total the scan measured');
  assert.equal(ev.afterBytes, 3000, 'afterBytes = before - reclaimed');
  assert.equal(ev.reclaimedBytes, 2000);
  assert.equal(ev.removedFiles, 4);
  assert.equal(ev.reclaimedAgents, 2);
  assert.equal(ev.targetBytes, 2 * 1024 ** 3);
  assert.equal(ev.outcome, 'swept-to-target');
  assert.equal(ev.scanErrors, 0);
  assert.equal(ev.durationMs, 2500, 'duration = emit time − scan start (scannedAt)');
});

test('buildLogRetentionSweepEvent: afterBytes floors at 0 and an unparseable scan time → duration 0', () => {
  const ev = buildLogRetentionSweepEvent(
    summary({ managedBytes: 100, bytesReclaimed: 999, scannedAt: 'not-a-date' }),
    1024, NaN,
  );
  assert.equal(ev.afterBytes, 0, 'never negative');
  assert.equal(ev.durationMs, 0, 'unparseable/absent scan time yields 0, never NaN');
});

// ── sinks: LIVE telemetry accessor (ordering mutation) ─────────────────────────

test('emitSweepEvent reads the LIVE telemetry accessor — a sweep before telemetry exists is a safe no-op, one after is delivered', () => {
  const emitted: LogRetentionSweepEvent[] = [];
  // Start with NO telemetry (the scheduler-started-before-telemetry world).
  let telemetry: { emitLogRetentionSweep(ev: LogRetentionSweepEvent): void } | null = null;
  const sinks = makeRetentionSinks({
    getHeapTelemetry: () => telemetry,
    getTargetBytes: () => 2 * 1024 ** 3,
    now: () => Date.parse('2026-07-27T09:00:01.000Z'),
    readState: () => noticeState(),
    broadcast: () => {},
  });
  // A scan firing while telemetry is still null must NOT throw and must record
  // nothing — this is exactly what the "start scheduler before telemetry" bug
  // would produce, and it must be tolerated (never crash) but is a data loss the
  // index.ts ordering exists to avoid.
  assert.doesNotThrow(() => sinks.emitSweepEvent(summary()));
  assert.equal(emitted.length, 0, 'no telemetry yet → nothing recorded');
  // Now telemetry is constructed (the correct order). Because the sink reads it
  // LIVE, the next sweep is delivered. A sink that captured telemetry BY VALUE
  // at construction (null) would still record nothing here — this assertion
  // kills that mutation.
  telemetry = { emitLogRetentionSweep: (ev) => emitted.push(ev) };
  sinks.emitSweepEvent(summary());
  assert.equal(emitted.length, 1, 'the live accessor picks up the later-assigned telemetry');
  assert.equal(emitted[0].reclaimedBytes, 2000, 'the ACTUAL removal reached the writer');
});

test('onScanComplete broadcasts the durable state the scheduler just persisted', () => {
  const broadcasts: LogRetentionState[] = [];
  const persisted = noticeState();
  const sinks = makeRetentionSinks({
    getHeapTelemetry: () => null,
    getTargetBytes: () => 2 * 1024 ** 3,
    now: () => 0,
    readState: () => persisted,
    broadcast: (s) => broadcasts.push(s),
  });
  sinks.onScanComplete(summary());
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], persisted, 'the just-persisted state is what renderers receive');
});

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
