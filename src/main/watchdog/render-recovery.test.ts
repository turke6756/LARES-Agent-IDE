// D1 render-recovery policy unit tests (incident §5 D1).
//   npm run build:main
//   node dist/main/main/watchdog/render-recovery.test.js

import assert from 'node:assert/strict';
import { RenderRecoveryPolicy } from './render-recovery';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('below Critical, the first crash reloads', () => {
  const p = new RenderRecoveryPolicy();
  const d = p.registerCrashAndDecide(1000, false);
  assert.equal(d.action, 'reload');
  assert.equal(d.reason, 'reload');
});

test('Critical pressure short-circuits to a dialog (no reload)', () => {
  const p = new RenderRecoveryPolicy();
  const d = p.registerCrashAndDecide(1000, true);
  assert.equal(d.action, 'dialog');
  assert.equal(d.reason, 'critical-pressure');
  // A Critical decision does NOT consume the reload budget.
  assert.equal(p.attemptsInWindow(1000), 0);
});

test('bounded at 3 reloads per 5 minutes, then dialog', () => {
  const p = new RenderRecoveryPolicy(); // 3 / 5min
  let t = 0;
  assert.equal(p.registerCrashAndDecide(t += 1000, false).action, 'reload');
  assert.equal(p.registerCrashAndDecide(t += 1000, false).action, 'reload');
  assert.equal(p.registerCrashAndDecide(t += 1000, false).action, 'reload');
  const fourth = p.registerCrashAndDecide(t += 1000, false);
  assert.equal(fourth.action, 'dialog', '4th crash within the window falls to a dialog');
  assert.equal(fourth.reason, 'retries-exhausted');
});

test('the reload budget refills after the window slides past', () => {
  const p = new RenderRecoveryPolicy({ maxAttempts: 3, windowMs: 5 * 60_000 });
  let t = 1_000;
  p.registerCrashAndDecide(t, false);
  p.registerCrashAndDecide(t += 1000, false);
  p.registerCrashAndDecide(t += 1000, false);
  assert.equal(p.registerCrashAndDecide(t += 1000, false).action, 'dialog', 'budget exhausted');
  // Jump past the 5-min window — the old attempts age out.
  t += 5 * 60_000 + 1;
  assert.equal(p.registerCrashAndDecide(t, false).action, 'reload', 'budget refilled after window');
});

test('onRecovered resets the budget immediately', () => {
  const p = new RenderRecoveryPolicy({ maxAttempts: 1, windowMs: 5 * 60_000 });
  assert.equal(p.registerCrashAndDecide(1000, false).action, 'reload');
  assert.equal(p.registerCrashAndDecide(2000, false).action, 'dialog', 'budget of 1 exhausted');
  p.onRecovered();
  assert.equal(p.registerCrashAndDecide(3000, false).action, 'reload', 'reset re-opens the budget');
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
