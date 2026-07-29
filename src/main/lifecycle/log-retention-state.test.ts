// WP-5 (terminal-log retention) — durable scheduler state.
//
//   npm run build:main
//   node dist/main/main/lifecycle/log-retention-state.test.js
//
// Covers the atomic round-trip, corrupt-→-defaults hardening, and the pure
// mutation transforms — most importantly `recordFirstSweepIfReclaimed`'s
// CREATE-ONCE, bytes>0-only immutability (a zero-byte scan raises no banner; a
// later reclaiming scan never overwrites the first notice's agents/bytes).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readState,
  writeState,
  applyFullScan,
  applyFirstSweepIfReclaimed,
  applyAcknowledge,
  recordFullScan,
  recordFirstSweepIfReclaimed,
  acknowledgeFirstSweepNotice,
  DEFAULT_LOG_RETENTION_STATE,
  logRetentionStatePath,
} from './log-retention-state';
import type { LogRetentionState } from '../../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'retention-state-'));
}
function withDir(fn: (dir: string) => void): void {
  const dir = tmpDir();
  try { fn(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// ── Atomic disk round-trip ──────────────────────────────────────────────────

test('round-trip: writeState → readState returns an equal, reconstructed state', () => {
  withDir((dir) => {
    const state: LogRetentionState = {
      lastFullScanAt: '2026-07-20T10:00:00.000Z',
      firstSweepNotice: { completedAt: '2026-07-20T10:00:00.000Z', agents: 3, bytes: 4096, acknowledgedAt: null },
    };
    writeState(state, dir);
    assert.deepEqual(readState(dir), state);
    // No stray tmp file left behind.
    assert.ok(!fs.existsSync(`${logRetentionStatePath(dir)}.tmp`), 'tmp cleaned by rename');
  });
});

test('first run (no file) → defaults', () => {
  withDir((dir) => {
    assert.deepEqual(readState(dir), DEFAULT_LOG_RETENTION_STATE);
    assert.equal(readState(dir).lastFullScanAt, null);
  });
});

test('corrupt JSON → defaults (never a bogus lastFullScanAt)', () => {
  withDir((dir) => {
    fs.writeFileSync(logRetentionStatePath(dir), '{not json');
    assert.deepEqual(readState(dir), DEFAULT_LOG_RETENTION_STATE);
  });
});

test('wrong-typed fields → defaults', () => {
  withDir((dir) => {
    // lastFullScanAt a number, firstSweepNotice missing agents.
    fs.writeFileSync(logRetentionStatePath(dir), JSON.stringify({ lastFullScanAt: 123, firstSweepNotice: { completedAt: 'x', bytes: 1, acknowledgedAt: null } }));
    assert.deepEqual(readState(dir), DEFAULT_LOG_RETENTION_STATE);
  });
});

test('a stray extra property does not ride into memory', () => {
  withDir((dir) => {
    fs.writeFileSync(logRetentionStatePath(dir), JSON.stringify({ lastFullScanAt: '2026-01-01T00:00:00.000Z', firstSweepNotice: null, hacked: true }));
    const s = readState(dir) as unknown as Record<string, unknown>;
    assert.equal(s.lastFullScanAt, '2026-01-01T00:00:00.000Z');
    assert.equal('hacked' in s, false, 'reconstructed from validated fields only');
  });
});

// ── Pure transforms ─────────────────────────────────────────────────────────

test('applyFullScan stamps lastFullScanAt without disturbing the notice', () => {
  const before: LogRetentionState = { lastFullScanAt: null, firstSweepNotice: { completedAt: 'c', agents: 1, bytes: 1, acknowledgedAt: null } };
  const after = applyFullScan(before, '2026-07-27T00:00:00.000Z');
  assert.equal(after.lastFullScanAt, '2026-07-27T00:00:00.000Z');
  assert.deepEqual(after.firstSweepNotice, before.firstSweepNotice);
});

test('applyFirstSweepIfReclaimed: a zero-byte scan creates NO notice', () => {
  const s = applyFirstSweepIfReclaimed(DEFAULT_LOG_RETENTION_STATE, { completedAt: 'c', agents: 5, bytes: 0 });
  assert.equal(s.firstSweepNotice, null, 'no bytes reclaimed → no banner');
});

test('applyFirstSweepIfReclaimed: bytes>0 creates the notice once', () => {
  const s = applyFirstSweepIfReclaimed(DEFAULT_LOG_RETENTION_STATE, { completedAt: 'c1', agents: 2, bytes: 100 });
  assert.deepEqual(s.firstSweepNotice, { completedAt: 'c1', agents: 2, bytes: 100, acknowledgedAt: null });
});

test('applyFirstSweepIfReclaimed IMMUTABILITY: a later scan never overwrites agents/bytes', () => {
  const first = applyFirstSweepIfReclaimed(DEFAULT_LOG_RETENTION_STATE, { completedAt: 'c1', agents: 2, bytes: 100 });
  const second = applyFirstSweepIfReclaimed(first, { completedAt: 'c2', agents: 99, bytes: 999999 });
  assert.deepEqual(second.firstSweepNotice, first.firstSweepNotice, 'first payload preserved verbatim');
  assert.equal(second.firstSweepNotice?.agents, 2);
  assert.equal(second.firstSweepNotice?.bytes, 100);
});

test('applyFirstSweepIfReclaimed preserves an already-acknowledged notice', () => {
  const ack: LogRetentionState = { lastFullScanAt: null, firstSweepNotice: { completedAt: 'c1', agents: 2, bytes: 100, acknowledgedAt: '2026-07-21T00:00:00.000Z' } };
  const next = applyFirstSweepIfReclaimed(ack, { completedAt: 'c2', agents: 9, bytes: 9 });
  assert.deepEqual(next.firstSweepNotice, ack.firstSweepNotice);
});

test('applyAcknowledge sets only acknowledgedAt; no-op when no notice', () => {
  assert.deepEqual(applyAcknowledge(DEFAULT_LOG_RETENTION_STATE, 'now'), DEFAULT_LOG_RETENTION_STATE, 'no notice → no-op');
  const withNotice: LogRetentionState = { lastFullScanAt: 'x', firstSweepNotice: { completedAt: 'c', agents: 1, bytes: 1, acknowledgedAt: null } };
  const acked = applyAcknowledge(withNotice, '2026-07-27T00:00:00.000Z');
  assert.equal(acked.firstSweepNotice?.acknowledgedAt, '2026-07-27T00:00:00.000Z');
  assert.equal(acked.firstSweepNotice?.agents, 1, 'payload untouched');
  assert.equal(acked.lastFullScanAt, 'x');
});

// ── Disk-bound wrappers ─────────────────────────────────────────────────────

test('recordFullScan / recordFirstSweepIfReclaimed / acknowledge round-trip via disk', () => {
  withDir((dir) => {
    recordFullScan('2026-07-27T00:00:00.000Z', dir);
    assert.equal(readState(dir).lastFullScanAt, '2026-07-27T00:00:00.000Z');

    // Zero-byte: no notice created.
    recordFirstSweepIfReclaimed({ completedAt: 'c0', agents: 1, bytes: 0 }, dir);
    assert.equal(readState(dir).firstSweepNotice, null);

    // First reclaiming scan creates the notice.
    recordFirstSweepIfReclaimed({ completedAt: 'c1', agents: 4, bytes: 512 }, dir);
    assert.deepEqual(readState(dir).firstSweepNotice, { completedAt: 'c1', agents: 4, bytes: 512, acknowledgedAt: null });

    // A later reclaiming scan does NOT overwrite the payload.
    recordFirstSweepIfReclaimed({ completedAt: 'c2', agents: 40, bytes: 5120 }, dir);
    assert.deepEqual(readState(dir).firstSweepNotice, { completedAt: 'c1', agents: 4, bytes: 512, acknowledgedAt: null });

    acknowledgeFirstSweepNotice('2026-07-28T00:00:00.000Z', dir);
    assert.equal(readState(dir).firstSweepNotice?.acknowledgedAt, '2026-07-28T00:00:00.000Z');
    // The full-scan stamp survives all of the above.
    assert.equal(readState(dir).lastFullScanAt, '2026-07-27T00:00:00.000Z');
  });
});

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
