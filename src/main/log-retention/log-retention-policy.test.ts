// Terminal-log retention WP-2 — pure bundle summarization + sweep selection.
//
// Zero-IO unit tests: no filesystem, no database, no Electron. Runs as a plain
// node script (no test framework), matching the main-suite convention.
//
//   npm run build:main
//   node dist/main/main/log-retention/log-retention-policy.test.js

import assert from 'node:assert/strict';
import {
  summarizeManagedBundle,
  planRetentionSweep,
  isManagedLogPath,
  norm,
  type RetentionBundle,
  type ManagedStatEntry,
} from './log-retention-policy';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── test fixture helpers ─────────────────────────────────────────────────────

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000; // fixed "now" — no Date.now() anywhere.
const MIN_AGE = 7 * DAY;

function bundle(over: Partial<RetentionBundle> & { agentId: string }): RetentionBundle {
  return {
    totalBytes: 100,
    fileCount: 1,
    newestMtimeMs: NOW - 30 * DAY, // old by default
    preliminaryEligible: true,
    ...over,
  };
}

// ── summarizeManagedBundle ───────────────────────────────────────────────────

test('summarizeManagedBundle: newest mtime is the MAX (new .checkpoint beats old .log)', () => {
  const entries: ManagedStatEntry[] = [
    { suffix: '', size: 10, mtimeMs: 1000 }, // .log — old
    { suffix: '.checkpoint', size: 5, mtimeMs: 9999 }, // .checkpoint — newest
    { suffix: '.scrollback', size: 7, mtimeMs: 5000 },
  ];
  const s = summarizeManagedBundle('a1', entries);
  // Kills the min-instead-of-newest mutation: min would be 1000.
  assert.strictEqual(s.newestMtimeMs, 9999, 'newestMtimeMs must be the maximum mtime');
  assert.strictEqual(s.totalBytes, 22, 'totalBytes is the byte sum');
  assert.strictEqual(s.fileCount, 3, 'fileCount is the number of present entries');
  assert.strictEqual(s.agentId, 'a1');
});

test('summarizeManagedBundle: order-independent (suffix ordering does not change the result)', () => {
  const a = summarizeManagedBundle('x', [
    { suffix: '.checkpoint.tmp', size: 3, mtimeMs: 200 },
    { suffix: '', size: 4, mtimeMs: 800 },
  ]);
  const b = summarizeManagedBundle('x', [
    { suffix: '', size: 4, mtimeMs: 800 },
    { suffix: '.checkpoint.tmp', size: 3, mtimeMs: 200 },
  ]);
  assert.deepStrictEqual(a, b, 'summary is deterministic regardless of entry order');
  assert.strictEqual(a.newestMtimeMs, 800);
});

test('summarizeManagedBundle: empty bundle → newestMtimeMs null (never a synthetic 0/Infinity/now)', () => {
  const s = summarizeManagedBundle('empty', []);
  assert.strictEqual(s.newestMtimeMs, null, 'empty bundle has null newest mtime');
  assert.strictEqual(s.totalBytes, 0);
  assert.strictEqual(s.fileCount, 0);
  // Explicitly assert the synthetic-floor mutations are absent.
  assert.notStrictEqual(s.newestMtimeMs, 0);
  assert.notStrictEqual(s.newestMtimeMs, NOW);
});

// ── planRetentionSweep: age boundary ─────────────────────────────────────────

test('planRetentionSweep: age === minAge is eligible (boundary inclusive)', () => {
  const exactlyMinAge = bundle({ agentId: 'edge', totalBytes: 100, newestMtimeMs: NOW - MIN_AGE });
  const plan = planRetentionSweep([exactlyMinAge], { targetBytes: 0, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.strictEqual(plan.toSweep.length, 1, 'a bundle whose age equals minAge is eligible');
  assert.strictEqual(plan.toSweep[0].agentId, 'edge');
});

test('planRetentionSweep: one ms too young is NOT eligible, counted as a too-young blocker', () => {
  const tooYoung = bundle({ agentId: 'young', totalBytes: 100, newestMtimeMs: NOW - MIN_AGE + 1 });
  const plan = planRetentionSweep([tooYoung], { targetBytes: 0, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.strictEqual(plan.toSweep.length, 0, 'a bundle one ms under minAge is not swept');
  assert.strictEqual(plan.blockers['too-young'], 1);
  assert.strictEqual(plan.outcome, 'target-unmet');
});

// ── planRetentionSweep: totals include ineligible bundles ────────────────────

test('planRetentionSweep: ineligible bundles count toward totals but never enter toSweep', () => {
  const live = bundle({ agentId: 'live', totalBytes: 500, fileCount: 2, preliminaryEligible: false, blocker: 'live-runner' });
  const young = bundle({ agentId: 'young', totalBytes: 300, newestMtimeMs: NOW - 1 * DAY });
  const plan = planRetentionSweep([live, young], { targetBytes: 0, minAgeMs: MIN_AGE, nowMs: NOW });

  // Kills the exclude-ineligible-from-totals mutation: 500 + 300 must both count.
  assert.strictEqual(plan.managedTotalBytes, 800, 'both ineligible bundles contribute to disk pressure');
  assert.strictEqual(plan.managedFileCount, 3, 'file counts of ineligible bundles still count');
  assert.strictEqual(plan.toSweep.length, 0, 'neither ineligible bundle is swept');
  assert.strictEqual(plan.blockers['live-runner'], 1);
  assert.strictEqual(plan.blockers['too-young'], 1);
});

test('planRetentionSweep: empty bundle is never selectable even if flagged eligible and over target', () => {
  // Adversarial: an empty bundle marked preliminaryEligible=true. hasFiles is
  // false (null mtime), so it can never be swept — guards against a synthetic
  // mtime resurrecting an empty bundle.
  const empty = bundle({ agentId: 'empty', totalBytes: 0, fileCount: 0, newestMtimeMs: null, preliminaryEligible: true });
  const heavyBlocked = bundle({ agentId: 'blocked', totalBytes: 999, preliminaryEligible: false, blocker: 'stat-error' });
  const plan = planRetentionSweep([empty, heavyBlocked], { targetBytes: 10, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.ok(plan.managedTotalBytes > plan.managedTotalBytes - 1); // sanity
  assert.strictEqual(plan.toSweep.length, 0, 'the empty bundle is never swept, even over target');
  assert.strictEqual(plan.blockers['empty'], 1);
});

// ── planRetentionSweep: ordering + accumulation ──────────────────────────────

test('planRetentionSweep: sweeps oldest-first and stops once under target', () => {
  const b1 = bundle({ agentId: 'newest', totalBytes: 100, newestMtimeMs: NOW - 8 * DAY });
  const b2 = bundle({ agentId: 'middle', totalBytes: 100, newestMtimeMs: NOW - 20 * DAY });
  const b3 = bundle({ agentId: 'oldest', totalBytes: 100, newestMtimeMs: NOW - 40 * DAY });
  // total 300, target 150 → need to free ≥150 → sweep two oldest (300 - 200 = 100 ≤ 150).
  const plan = planRetentionSweep([b1, b2, b3], { targetBytes: 150, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.deepStrictEqual(plan.toSweep.map((b) => b.agentId), ['oldest', 'middle'], 'oldest-first accumulation');
  assert.strictEqual(plan.projectedFreedBytes, 200);
  assert.strictEqual(plan.remainingOverageBytes, 0);
  assert.strictEqual(plan.outcome, 'swept-to-target');
});

test('planRetentionSweep: equal mtimes tiebreak deterministically by agentId', () => {
  const t = NOW - 30 * DAY;
  const b = bundle({ agentId: 'b', totalBytes: 100, newestMtimeMs: t });
  const a = bundle({ agentId: 'a', totalBytes: 100, newestMtimeMs: t });
  const plan = planRetentionSweep([b, a], { targetBytes: 0, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.deepStrictEqual(plan.toSweep.map((x) => x.agentId), ['a', 'b'], 'agentId ascending tiebreak');
});

// ── planRetentionSweep: outcomes ─────────────────────────────────────────────

test('planRetentionSweep: under-target when nothing needs sweeping', () => {
  const small = bundle({ agentId: 's', totalBytes: 10 });
  const plan = planRetentionSweep([small], { targetBytes: 1000, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.strictEqual(plan.outcome, 'under-target');
  assert.strictEqual(plan.toSweep.length, 0);
  assert.strictEqual(plan.remainingOverageBytes, 0);
});

test('planRetentionSweep: unlimited cap (Infinity) sweeps nothing but still reports totals', () => {
  const big = bundle({ agentId: 'big', totalBytes: 5_000_000_000 });
  const plan = planRetentionSweep([big], { targetBytes: Number.POSITIVE_INFINITY, minAgeMs: MIN_AGE, nowMs: NOW });
  assert.strictEqual(plan.outcome, 'under-target');
  assert.strictEqual(plan.toSweep.length, 0, 'unlimited cap disables deletion');
  assert.strictEqual(plan.managedTotalBytes, 5_000_000_000, 'observability totals still reported');
});

test('planRetentionSweep: target-unmet reports honest overage + blockers', () => {
  // 400 bytes of eligible (swept) + 600 bytes locked behind live/young/path blockers,
  // target 100 → cannot reach it. Overage and blocker census must be honest.
  const elig = bundle({ agentId: 'elig', totalBytes: 400, newestMtimeMs: NOW - 30 * DAY });
  const live = bundle({ agentId: 'live', totalBytes: 300, preliminaryEligible: false, blocker: 'live-runner' });
  const bad = bundle({ agentId: 'bad', totalBytes: 300, preliminaryEligible: false, blocker: 'invalid-path' });
  const plan = planRetentionSweep([elig, live, bad], { targetBytes: 100, minAgeMs: MIN_AGE, nowMs: NOW });

  assert.strictEqual(plan.managedTotalBytes, 1000);
  assert.strictEqual(plan.projectedFreedBytes, 400, 'only the eligible bundle is freed');
  // remaining = 1000 - 400 - 100 = 500, honestly non-zero.
  assert.strictEqual(plan.remainingOverageBytes, 500);
  assert.strictEqual(plan.outcome, 'target-unmet');
  assert.strictEqual(plan.blockers['live-runner'], 1);
  assert.strictEqual(plan.blockers['invalid-path'], 1);
});

// ── isManagedLogPath ─────────────────────────────────────────────────────────

test('isManagedLogPath: accepts the exact managed path', () => {
  const dir = process.platform === 'win32' ? 'C:\\logs' : '/logs';
  const p = norm(dir + (process.platform === 'win32' ? '\\a1.log' : '/a1.log'));
  assert.strictEqual(isManagedLogPath(p, 'a1', dir), true);
});

test('isManagedLogPath: rejects a wrong basename', () => {
  const dir = process.platform === 'win32' ? 'C:\\logs' : '/logs';
  // Wrong-agent basename and a sidecar-suffixed basename must both be rejected —
  // kills the "wrong basename accepted" mutation.
  const wrongAgent = norm(dir + (process.platform === 'win32' ? '\\a2.log' : '/a2.log'));
  const sidecar = norm(dir + (process.platform === 'win32' ? '\\a1.scrollback' : '/a1.scrollback'));
  assert.strictEqual(isManagedLogPath(wrongAgent, 'a1', dir), false, 'a different agentId basename is rejected');
  assert.strictEqual(isManagedLogPath(sidecar, 'a1', dir), false, 'a sidecar basename is not the .log');
});

test('isManagedLogPath: rejects a sibling directory', () => {
  const dir = process.platform === 'win32' ? 'C:\\logs' : '/logs';
  const sibling = process.platform === 'win32' ? 'C:\\other\\a1.log' : '/other/a1.log';
  assert.strictEqual(isManagedLogPath(sibling, 'a1', dir), false, 'same basename in a different dir is rejected');
});

if (process.platform === 'win32') {
  test('isManagedLogPath: accepts a win32 case variant (case-insensitive)', () => {
    assert.strictEqual(isManagedLogPath('C:\\LOGS\\A1.LOG', 'a1', 'C:\\logs'), true, 'win32 path compare is case-folded');
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
