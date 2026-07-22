// analytics-snapshot-argv.test — WP1 (G1) argv-branch purity tests.
//   npm run build:main
//   node dist/main/main/analytics-export/analytics-snapshot-argv.test.js
//
// Two halves: (1) the branch decision is a pure function over argv, exercised
// directly; (2) source-order assertions over src/main/index.ts proving the
// branch is evaluated BEFORE the single-instance lock and that the normal
// startup path (lock + whenReady body) is gated off in snapshot mode.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

import { parseAnalyticsSnapshotArgv, ANALYTICS_SNAPSHOT_FLAG } from './analytics-snapshot-argv';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// Compiled test lives at dist/main/main/analytics-export/ → repo root is 4 up.
const REPO_ROOT = nodePath.resolve(__dirname, '..', '..', '..', '..');
const INDEX_SRC = fs.readFileSync(nodePath.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf-8');

// ── pure function ─────────────────────────────────────────────────────────────

test('no flag → null (normal startup)', () => {
  assert.equal(parseAnalyticsSnapshotArgv(['C:\\app\\Lares.exe']), null);
  assert.equal(parseAnalyticsSnapshotArgv(['electron', '.', 'export']), null);
  assert.equal(parseAnalyticsSnapshotArgv([]), null);
});

test('packaged shape: flag first → everything after it', () => {
  assert.deepEqual(
    parseAnalyticsSnapshotArgv(['C:\\Program Files\\Lares\\Lares.exe', ANALYTICS_SNAPSHOT_FLAG, 'export', '--json']),
    ['export', '--json'],
  );
});

test('dev shape: injected switches before the flag are ignored', () => {
  assert.deepEqual(
    parseAnalyticsSnapshotArgv(['electron', '.', '--no-sandbox', ANALYTICS_SNAPSHOT_FLAG, 'export', '--workspace', 'C:\\ws']),
    ['export', '--workspace', 'C:\\ws'],
  );
});

test('flag with nothing after it → empty argv (usage error downstream, not startup)', () => {
  assert.deepEqual(parseAnalyticsSnapshotArgv(['Lares.exe', ANALYTICS_SNAPSHOT_FLAG]), []);
});

test('the decision is pure — same input, same output, input not mutated', () => {
  const argv = ['Lares.exe', ANALYTICS_SNAPSHOT_FLAG, 'diff', 'a', 'b'];
  const copy = [...argv];
  const r1 = parseAnalyticsSnapshotArgv(argv);
  const r2 = parseAnalyticsSnapshotArgv(argv);
  assert.deepEqual(r1, r2);
  assert.deepEqual(argv, copy);
});

// ── source-order assertions over src/main/index.ts ────────────────────────────

test('index.ts evaluates the analytics branch BEFORE the single-instance lock', () => {
  const branchAt = INDEX_SRC.indexOf('parseAnalyticsSnapshotArgv(process.argv)');
  const lockAt = INDEX_SRC.indexOf('requestSingleInstanceLock');
  assert.ok(branchAt >= 0, 'index.ts no longer evaluates parseAnalyticsSnapshotArgv(process.argv)');
  assert.ok(lockAt >= 0, 'index.ts no longer requests the single-instance lock');
  assert.ok(branchAt < lockAt, 'the analytics branch must be evaluated before the single-instance lock');
});

test('the single-instance lock is gated off in snapshot mode', () => {
  assert.match(
    INDEX_SRC,
    /if \(analyticsSnapshotArgv === null\) \{[\s\S]{0,400}requestSingleInstanceLock/,
    'requestSingleInstanceLock must sit inside the analyticsSnapshotArgv === null gate',
  );
});

test('the main whenReady body returns early in snapshot mode (no window, no supervisor)', () => {
  assert.match(
    INDEX_SRC,
    /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]{0,300}if \(analyticsSnapshotArgv !== null\) return;/,
    'the normal-startup whenReady handler must early-return in snapshot mode',
  );
});

test('the branch exits via app.exit(code) — codes pass through, quit() would erase them', () => {
  const branch = INDEX_SRC.slice(
    INDEX_SRC.indexOf('parseAnalyticsSnapshotArgv(process.argv)'),
    INDEX_SRC.indexOf('requestSingleInstanceLock'),
  );
  assert.ok(branch.includes('app.exit(code)'), 'snapshot branch must exit via app.exit(code)');
  assert.ok(branch.includes('runSnapshotCli'), 'snapshot branch must run the shared runSnapshotCli');
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (e) { failed += 1; console.error(`  FAIL  ${t.name}\n`, e); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
