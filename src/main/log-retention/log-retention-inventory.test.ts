// WP-5 (terminal-log retention) — on-disk bundle inventory.
//
//   npm run build:main
//   node dist/main/main/log-retention/log-retention-inventory.test.js
//
// The single fs-touching scan step. These tests are the executable form of its
// three hard rules: validate-before-stat (invalid path never statted, never a
// bundle), shared-path → shared-reference counted once and never selectable,
// and ENOENT-is-the-only-absence (any other stat error → stat-error bundle +
// scanErrors, never a size-0 masquerade).

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { inventoryBundles, type InventoryRow, type StatFn } from './log-retention-inventory';
import { planRetentionSweep } from './log-retention-policy';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const DIR = path.join(path.sep === '\\' ? 'C:\\logs' : '/logs');
const managed = (id: string): string => path.join(DIR, `${id}.log`);

/** Build a statFn from a per-path table. Value shapes:
 *    {size,mtimeMs} → present; 'ENOENT' → absent (null); 'THROW' → non-ENOENT error. */
function statTable(table: Record<string, { size: number; mtimeMs: number } | 'ENOENT' | 'THROW'>): StatFn {
  return (p: string) => {
    const v = table[p];
    if (v === undefined || v === 'ENOENT') return null;
    if (v === 'THROW') { const e: any = new Error('EACCES'); e.code = 'EACCES'; throw e; }
    return v;
  };
}

// ── Validate before stat ────────────────────────────────────────────────────

test('out-of-scope stored path → invalidCount, never statted, never a bundle', () => {
  let statted = false;
  const statFn: StatFn = (p) => { statted = true; void p; return null; };
  const rows: InventoryRow[] = [
    { agentId: 'stray', status: 'done', logPath: path.join(path.sep === '\\' ? 'C:\\elsewhere' : '/elsewhere', 'stray.log'), hasRunner: false },
    { agentId: 'nullpath', status: 'done', logPath: null, hasRunner: false },
  ];
  const res = inventoryBundles(rows, DIR, statFn);
  assert.equal(res.invalidCount, 2);
  assert.deepEqual(res.bundles, [], 'no bundles for out-of-scope rows');
  assert.equal(statted, false, 'a corrupt row is NEVER statted');
});

// ── Single-owner eligibility classification ─────────────────────────────────

test('terminal, no runner, present files → preliminaryEligible, no blocker', () => {
  const p = managed('a');
  const res = inventoryBundles(
    [{ agentId: 'a', status: 'done', logPath: p, hasRunner: false }],
    DIR,
    statTable({ [p]: { size: 100, mtimeMs: 1000 }, [p + '.scrollback']: { size: 20, mtimeMs: 2000 } }),
  );
  assert.equal(res.bundles.length, 1);
  const b = res.bundles[0];
  assert.equal(b.preliminaryEligible, true);
  assert.equal(b.blocker, undefined);
  assert.equal(b.totalBytes, 120);
  assert.equal(b.fileCount, 2);
  assert.equal(b.newestMtimeMs, 2000, 'newest = max mtime');
});

test('non-terminal status → not-terminal blocker, ineligible', () => {
  const p = managed('busy');
  const res = inventoryBundles(
    [{ agentId: 'busy', status: 'working', logPath: p, hasRunner: false }],
    DIR,
    statTable({ [p]: { size: 100, mtimeMs: 1000 } }),
  );
  assert.equal(res.bundles[0].preliminaryEligible, false);
  assert.equal(res.bundles[0].blocker, 'not-terminal');
});

test('live runner → live-runner blocker, ineligible (preliminary; executor stays authoritative)', () => {
  const p = managed('live');
  const res = inventoryBundles(
    [{ agentId: 'live', status: 'done', logPath: p, hasRunner: true }],
    DIR,
    statTable({ [p]: { size: 100, mtimeMs: 1000 } }),
  );
  assert.equal(res.bundles[0].preliminaryEligible, false);
  assert.equal(res.bundles[0].blocker, 'live-runner');
});

test('empty bundle (all ENOENT) → empty blocker, ineligible, null mtime', () => {
  const p = managed('empty');
  const res = inventoryBundles(
    [{ agentId: 'empty', status: 'done', logPath: p, hasRunner: false }],
    DIR,
    statTable({}), // everything ENOENT
  );
  const b = res.bundles[0];
  assert.equal(b.fileCount, 0);
  assert.equal(b.newestMtimeMs, null, 'no synthetic mtime for an empty bundle');
  assert.equal(b.preliminaryEligible, false);
  assert.equal(b.blocker, 'empty');
  assert.equal(res.scanErrors, 0);
});

// ── ENOENT vs a real stat error ─────────────────────────────────────────────

test('non-ENOENT stat error → stat-error blocker + scanErrors++, NEVER size 0', () => {
  const p = managed('broken');
  const res = inventoryBundles(
    [{ agentId: 'broken', status: 'done', logPath: p, hasRunner: false }],
    DIR,
    // .log throws EACCES; .scrollback is a real present file.
    statTable({ [p]: 'THROW', [p + '.scrollback']: { size: 50, mtimeMs: 3000 } }),
  );
  const b = res.bundles[0];
  assert.equal(res.scanErrors, 1, 'the non-ENOENT failure is counted');
  assert.equal(b.preliminaryEligible, false, 'a broken bundle is never reclaimed');
  assert.equal(b.blocker, 'stat-error');
  // The present sidecar still contributes real bytes — the errored file is NOT
  // recorded as size 0.
  assert.equal(b.totalBytes, 50);
});

test('a plain ENOENT is NOT a scan error', () => {
  const p = managed('partial');
  const res = inventoryBundles(
    [{ agentId: 'partial', status: 'done', logPath: p, hasRunner: false }],
    DIR,
    statTable({ [p]: { size: 10, mtimeMs: 1000 } }), // sidecars all ENOENT
  );
  assert.equal(res.scanErrors, 0);
  assert.equal(res.bundles[0].preliminaryEligible, true);
});

// ── Shared reference: counted once, neither selected ────────────────────────

test('a valid owner whose managed file a CORRUPT row also references → shared-reference, counted once, not selected', () => {
  // The realistic, cross-platform duplicate: agent `owner` legitimately owns
  // `owner.log`; a corrupt `dup` row (invalid managed path for its own id)
  // ALSO points at `owner.log`. The valid owner must be protected — exactly the
  // authoritative check the reclaim primitive performs.
  const p = managed('owner');
  const rows: InventoryRow[] = [
    { agentId: 'owner', status: 'done', logPath: p, hasRunner: false },
    { agentId: 'dup', status: 'done', logPath: p, hasRunner: false }, // p is not dup.log → invalid for dup
  ];
  const res = inventoryBundles(
    rows,
    DIR,
    statTable({ [p]: { size: 1000, mtimeMs: 1000 }, [p + '.checkpoint']: { size: 500, mtimeMs: 2000 } }),
  );
  assert.equal(res.invalidCount, 1, 'the corrupt duplicate is invalid, not a bundle');
  assert.equal(res.bundles.length, 1, 'only the valid owner is a bundle');
  const b = res.bundles[0];
  assert.equal(b.agentId, 'owner');
  assert.equal(b.preliminaryEligible, false);
  assert.equal(b.blocker, 'shared-reference', 'valid owner protected because another row references its file');
  assert.equal(b.totalBytes, 1500, 'physical bytes counted once');
  // Not selectable even with an aggressive target and old files.
  const plan = planRetentionSweep(res.bundles, { targetBytes: 0, minAgeMs: 0, nowMs: 1_000_000_000 });
  assert.deepEqual(plan.toSweep, [], 'the shared owner is never swept');
  assert.equal(plan.managedTotalBytes, 1500, 'pressure counts the shared bundle once');
});

if (process.platform === 'win32') {
  test('win32: two VALID rows colliding by id case-fold → BOTH shared-reference, counted ONCE, NEITHER selectable', () => {
    // On win32 `Shared.log` and `shared.log` normalize to one path, so both rows
    // are valid managed paths for their own ids yet reference one physical file.
    const upper = path.join(DIR, 'Shared.log');
    const lower = path.join(DIR, 'shared.log');
    const rows: InventoryRow[] = [
      { agentId: 'Shared', status: 'done', logPath: upper, hasRunner: false },
      { agentId: 'shared', status: 'done', logPath: lower, hasRunner: false },
    ];
    const res = inventoryBundles(rows, DIR, statTable({ [upper]: { size: 1000, mtimeMs: 1000 }, [upper + '.checkpoint']: { size: 500, mtimeMs: 2000 } }));
    assert.equal(res.bundles.length, 2, 'a bundle per associated valid row');
    for (const b of res.bundles) {
      assert.equal(b.preliminaryEligible, false);
      assert.equal(b.blocker, 'shared-reference');
    }
    const totalBytes = res.bundles.reduce((s, b) => s + b.totalBytes, 0);
    const totalFiles = res.bundles.reduce((s, b) => s + b.fileCount, 0);
    assert.equal(totalBytes, 1500, 'physical bytes counted exactly once (carrier holds them)');
    assert.equal(totalFiles, 2, 'physical files counted exactly once');
    const plan = planRetentionSweep(res.bundles, { targetBytes: 0, minAgeMs: 0, nowMs: 1_000_000_000 });
    assert.deepEqual(plan.toSweep, [], 'neither associated agent is swept');
    assert.equal(plan.managedTotalBytes, 1500);
  });
} else {
  test('(win32 id-case-collision shared test skipped on this platform)', () => { /* no-op */ });
}

// ── win32 case-fold ─────────────────────────────────────────────────────────

if (process.platform === 'win32') {
  test('win32: a case-variant stored path is still the managed path (validated, statted)', () => {
    const p = managed('CaseVary'); // C:\logs\CaseVary.log
    const upperDir = 'C:\\LOGS';
    const rows: InventoryRow[] = [{ agentId: 'CaseVary', status: 'done', logPath: path.join(upperDir, 'CaseVary.log'), hasRunner: false }];
    const res = inventoryBundles(rows, DIR, statTable({ [path.join(upperDir, 'CaseVary.log')]: { size: 7, mtimeMs: 1000 } }));
    assert.equal(res.invalidCount, 0, 'case variant accepted on win32');
    assert.equal(res.bundles[0].preliminaryEligible, true);
    void p;
  });
} else {
  test('(win32 case-fold test skipped on this platform)', () => { /* no-op */ });
}

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
