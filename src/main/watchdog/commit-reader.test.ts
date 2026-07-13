// Real-deps commit reader + AdmissionError tests (incident-2026-07-11 §5 D5-lite).
//   npm run build:main
//   node dist/main/main/watchdog/commit-reader.test.js

import assert from 'node:assert/strict';
import { createCommitReader, type NativeCommitProvider } from './commit-reader';
import { AdmissionError } from './types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function fakeNative(over?: Partial<{ supported: boolean; throws: boolean }>): NativeCommitProvider {
  const supported = over?.supported ?? true;
  return {
    supported,
    getCommitStatus: () => {
      if (over?.throws) throw new Error('syscall failed');
      return {
        commitLimitBytes: 128 * 1024 ** 3,
        commitAvailableBytes: 64 * 1024 ** 3,
        commitChargeBytes: 64 * 1024 ** 3,
        physicalTotalBytes: 32 * 1024 ** 3,
        physicalAvailableBytes: 8 * 1024 ** 3,
      };
    },
  };
}

// The reader delegates platform selection to the pure readCommit(); here we only
// verify the glue wires the native provider correctly on the ACTUAL platform this
// runs on. On Windows a supported provider yields a windows-native reading; a
// null / unsupported provider yields a sampler failure (null) on Windows.
if (process.platform === 'win32') {
  test('win32: a supported native provider yields a windows-native reading', () => {
    const read = createCommitReader(fakeNative());
    const r = read();
    assert.ok(r, 'reading is present');
    assert.equal(r!.source, 'windows-native');
    assert.equal(r!.commitLimitBytes, 128 * 1024 ** 3);
  });

  test('win32: a null native provider is a sampler failure (null)', () => {
    const read = createCommitReader(null);
    assert.equal(read(), null, 'no native module on Windows ⇒ null (fail-open on commit, fail-closed on caps)');
  });

  test('win32: an unsupported native provider is a sampler failure (null)', () => {
    const read = createCommitReader(fakeNative({ supported: false }));
    assert.equal(read(), null);
  });

  test('win32: a throwing getCommitStatus is caught as a sampler failure (null)', () => {
    const read = createCommitReader(fakeNative({ throws: true }));
    assert.equal(read(), null, 'a native throw never propagates — it degrades to null');
  });
} else {
  // Non-Windows: the native provider is ignored; the reader uses /proc or the
  // macOS fallback. We only assert it returns a value or null without throwing.
  test('non-win32: reader never throws', () => {
    const read = createCommitReader(null);
    const r = read();
    assert.ok(r === null || typeof r.commitLimitBytes === 'number');
  });
}

// ── AdmissionError shape (the machine-readable refusal contract) ──────────────

test('AdmissionError carries the decision code, statusCode 503, and reason', () => {
  const err = new AdmissionError({ allowed: false, code: 'memory-critical', reason: 'boom' });
  assert.equal(err.name, 'AdmissionError');
  assert.equal(err.code, 'memory-critical');
  assert.equal(err.statusCode, 503);
  assert.equal(err.message, 'boom');
  assert.ok(err instanceof Error);
});

test('AdmissionError defaults to memory-capacity when no code is given', () => {
  const err = new AdmissionError({ allowed: false });
  assert.equal(err.code, 'memory-capacity');
  assert.ok(err.message.length > 0, 'a default human-readable message is present');
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
