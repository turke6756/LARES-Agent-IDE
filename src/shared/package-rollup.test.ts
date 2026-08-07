import assert from 'node:assert/strict';
import { derivePackageRollup } from './package-rollup';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('all-done packages are completed', () => {
  const rollup = derivePackageRollup({ ready: 0, executing: 0, blocked: 0, done: 4, archived: 0 });
  assert.equal(rollup.completed, true);
});

test('mixed done and archived packages are not completed', () => {
  const rollup = derivePackageRollup({ ready: 0, executing: 0, blocked: 0, done: 3, archived: 1 });
  assert.equal(rollup.completed, false);
});

test('all-archived packages with zero done are not completed', () => {
  const rollup = derivePackageRollup({ ready: 0, executing: 0, blocked: 0, done: 0, archived: 4 });
  assert.equal(rollup.completed, false);
});

test('zero total is not completed', () => {
  const rollup = derivePackageRollup({ ready: 0, executing: 0, blocked: 0, done: 0, archived: 0 });
  assert.equal(rollup.completed, false);
});

test('counts sum into total, landed, remaining, and archived', () => {
  const rollup = derivePackageRollup({ ready: 2, executing: 3, blocked: 5, done: 7, archived: 11 });
  assert.deepEqual(rollup, {
    total: 28,
    landed: 7,
    remaining: 10,
    archived: 11,
    completed: false,
  });
});

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
