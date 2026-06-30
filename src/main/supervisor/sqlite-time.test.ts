// Targeted unit test for parseSqliteUtcMs (the /clear-rotation timezone fix).
// Expected values use Date.UTC(...) — never Date.parse of a space-form — so the
// assertions hold on any runner timezone (green on a UTC CI runner; proves the
// fix on a west-of-UTC dev machine).
//
//   npm run build:main
//   node dist/main/main/supervisor/sqlite-time.test.js

import assert from 'node:assert/strict';
import { parseSqliteUtcMs } from './sqlite-time';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

test('parses SQLite space-form as UTC (tz-independent)', () => {
  assert.equal(parseSqliteUtcMs('2026-06-20 09:00:00'), Date.UTC(2026, 5, 20, 9, 0, 0));
});

test('passes through ISO-with-Z form', () => {
  assert.equal(parseSqliteUtcMs('2026-06-20T09:00:00Z'), Date.UTC(2026, 5, 20, 9, 0, 0));
});

test('returns null for null / undefined / empty', () => {
  assert.equal(parseSqliteUtcMs(null), null);
  assert.equal(parseSqliteUtcMs(undefined), null);
  assert.equal(parseSqliteUtcMs(''), null);
});

test('returns null for an unparseable string', () => {
  assert.equal(parseSqliteUtcMs('not a date'), null);
});

// ── Runner ───────────────────────────────────────────────────────────

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
