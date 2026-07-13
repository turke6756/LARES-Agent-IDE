// Platform commit-source unit tests (incident §5 D5-lite measurement).
//   npm run build:main
//   node dist/main/main/watchdog/commit-source.test.js

import assert from 'node:assert/strict';
import { readCommit, type CommitSourceDeps } from './commit-source';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const baseDeps: CommitSourceDeps = {
  platform: 'linux',
  nativeGetCommitStatus: null,
  readProcMeminfo: () => null,
  systemMemoryInfo: () => null,
};

test('Windows: reads the native getCommitStatus snapshot', () => {
  const reading = readCommit({
    ...baseDeps,
    platform: 'win32',
    nativeGetCommitStatus: () => ({
      commitLimitBytes: 100,
      commitAvailableBytes: 40,
      commitChargeBytes: 60,
      physicalTotalBytes: 32,
      physicalAvailableBytes: 8,
    }),
  });
  assert.ok(reading);
  assert.equal(reading!.source, 'windows-native');
  assert.equal(reading!.commitChargeBytes, 60);
  assert.equal(reading!.commitLimitBytes, 100);
});

test('Windows: a native throw is a sampler failure (null)', () => {
  const reading = readCommit({
    ...baseDeps,
    platform: 'win32',
    nativeGetCommitStatus: () => { throw new Error('syscall failed'); },
  });
  assert.equal(reading, null);
});

test('Windows: a missing native module is a sampler failure (null)', () => {
  const reading = readCommit({ ...baseDeps, platform: 'win32', nativeGetCommitStatus: null });
  assert.equal(reading, null);
});

test('Linux: parses CommitLimit/Committed_AS (kB → bytes)', () => {
  const meminfo = [
    'MemTotal:       32000000 kB',
    'MemAvailable:    4000000 kB',
    'CommitLimit:    64000000 kB',
    'Committed_AS:   48000000 kB',
  ].join('\n');
  const reading = readCommit({ ...baseDeps, platform: 'linux', readProcMeminfo: () => meminfo });
  assert.ok(reading);
  assert.equal(reading!.source, 'linux-proc');
  assert.equal(reading!.commitLimitBytes, 64000000 * 1024);
  assert.equal(reading!.commitChargeBytes, 48000000 * 1024);
  assert.equal(reading!.commitAvailableBytes, (64000000 - 48000000) * 1024);
});

test('Linux: a missing CommitLimit field is a sampler failure (null)', () => {
  const reading = readCommit({
    ...baseDeps,
    platform: 'linux',
    readProcMeminfo: () => 'MemTotal: 32000000 kB',
  });
  assert.equal(reading, null);
});

test('macOS: approximates commit from getSystemMemoryInfo (incl. swap)', () => {
  const reading = readCommit({
    ...baseDeps,
    platform: 'darwin',
    systemMemoryInfo: () => ({ total: 16_000_000, free: 4_000_000, swapTotal: 8_000_000, swapFree: 6_000_000 }),
  });
  assert.ok(reading);
  assert.equal(reading!.source, 'macos-fallback');
  // limit = (16M+8M)kB, available = (4M+6M)kB, charge = limit-available = 14MkB.
  assert.equal(reading!.commitLimitBytes, 24_000_000 * 1024);
  assert.equal(reading!.commitChargeBytes, 14_000_000 * 1024);
});

test('macOS: a null memory info is a sampler failure (null)', () => {
  const reading = readCommit({ ...baseDeps, platform: 'darwin', systemMemoryInfo: () => null });
  assert.equal(reading, null);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
