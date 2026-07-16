// GT-C Decision 2 (§2.7) — rail contract generator unit tests.
//
//   npm run build:main
//   node dist/main/main/plans/plan-rail-contract.test.js

import assert from 'node:assert/strict';
import {
  planRailContractBlock,
  planClaimConventionBlock,
  PLAN_EVENT_STATUSES,
} from './plan-rail-contract';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const PLAN = 'plan-xyz-42';
const ANCHOR = 'sec_deadbe';
const VOCAB = PLAN_EVENT_STATUSES.join(' | ');
const SENTINEL = '<!--PLAN-EVENT';
const FAIL_OPEN = 'a wrong/omitted `claimed_section_anchor` only shows as a diagnostic, never changes attribution';

test('writer block contains plan id, anchor, sentinel, vocab, fail-open sentence', () => {
  const b = planRailContractBlock(PLAN, ANCHOR);
  assert.ok(b.includes(PLAN), 'plan id threaded in words');
  assert.ok(b.includes(ANCHOR), 'section anchor present');
  assert.ok(b.includes(SENTINEL), 'PLAN-EVENT sentinel example present');
  assert.ok(b.includes(VOCAB), 'full status vocabulary present');
  assert.ok(b.includes(FAIL_OPEN), 'fail-open sentence present');
});

test('writer block additionally contains raw+editWindow edit discipline', () => {
  const b = planRailContractBlock(PLAN, ANCHOR);
  assert.ok(b.includes('raw+editWindow'), 'writer block carries the read-before-edit discipline');
  assert.ok(b.includes('Edit'), 'writer block mentions native Edit');
  assert.ok(b.includes('data-anchor'), 'writer block warns against changing a data-anchor');
});

test('non-writer block contains plan id, anchor, sentinel, vocab, fail-open sentence', () => {
  const b = planClaimConventionBlock(PLAN, ANCHOR);
  assert.ok(b.includes(PLAN), 'plan id threaded in words');
  assert.ok(b.includes(ANCHOR), 'section anchor present');
  assert.ok(b.includes(SENTINEL), 'PLAN-EVENT sentinel example present');
  assert.ok(b.includes(VOCAB), 'full status vocabulary present');
  assert.ok(b.includes(FAIL_OPEN), 'fail-open sentence present');
});

test('non-writer block omits the edit discipline (claim-only)', () => {
  const b = planClaimConventionBlock(PLAN, ANCHOR);
  assert.ok(!b.includes('raw+editWindow'), 'non-writer block must NOT carry edit discipline');
  assert.ok(b.includes('NOT writing a section'), 'non-writer block states it is not a write turn');
});

test('both builders are deterministic across calls', () => {
  assert.equal(planRailContractBlock(PLAN, ANCHOR), planRailContractBlock(PLAN, ANCHOR));
  assert.equal(planClaimConventionBlock(PLAN, ANCHOR), planClaimConventionBlock(PLAN, ANCHOR));
});

test('status vocabulary is the settled seven-value set', () => {
  assert.deepEqual([...PLAN_EVENT_STATUSES], [
    'integrated', 'reviewed', 'deliberating', 'blocked', 'rejected', 'scope-changed', 'transition',
  ]);
});

// ── Runner ───────────────────────────────────────────────────────────
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
