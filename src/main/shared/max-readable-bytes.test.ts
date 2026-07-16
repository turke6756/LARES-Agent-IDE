// max-readable-bytes unit tests (base plan §3.4). Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/shared/max-readable-bytes.test.js

import assert from 'node:assert/strict';
import { MAX_READABLE_BYTES, truncateToMaxBytes } from './max-readable-bytes';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('cap is 1 MB', () => {
  assert.equal(MAX_READABLE_BYTES, 1024 * 1024);
});

test('under cap → untouched, truncated=false, originalBytes exact', () => {
  const r = truncateToMaxBytes('hello', 1024);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
  assert.equal(r.originalBytes, 5);
});

test('exactly at cap → not truncated', () => {
  const r = truncateToMaxBytes('abcd', 4);
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'abcd');
});

test('over cap → truncated to <= maxBytes, flagged, originalBytes preserved', () => {
  const r = truncateToMaxBytes('abcdef', 4);
  assert.equal(r.truncated, true);
  assert.equal(r.text, 'abcd');
  assert.equal(Buffer.byteLength(r.text, 'utf8'), 4);
  assert.equal(r.originalBytes, 6);
});

test('never splits a multi-byte UTF-8 sequence (backs off to char boundary)', () => {
  // '€' is 3 bytes (E2 82 AC). Cap at 2 lands mid-sequence → back off to empty.
  const r = truncateToMaxBytes('€', 2);
  assert.equal(r.truncated, true);
  assert.equal(r.text, '');
  // No replacement char leaks in.
  assert.equal(r.text.includes('�'), false);
});

test('keeps whole codepoints up to the boundary', () => {
  // Two euros = 6 bytes. Cap 4 → keep first (3 bytes), drop the partial second.
  const r = truncateToMaxBytes('€€', 4);
  assert.equal(r.text, '€');
  assert.equal(r.truncated, true);
});

test('deterministic — same input twice yields identical output', () => {
  const a = truncateToMaxBytes('the quick brown fox', 7);
  const b = truncateToMaxBytes('the quick brown fox', 7);
  assert.deepEqual(a, b);
  assert.equal(a.text, 'the qui');
});

test('defaults to MAX_READABLE_BYTES when no cap passed', () => {
  const r = truncateToMaxBytes('small');
  assert.equal(r.truncated, false);
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
