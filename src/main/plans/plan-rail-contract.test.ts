// WP-P0B (§2.7 amended) — rail orientation generator unit tests.
//
// After the ceremony subtraction the blocks are pure orientation: they name the
// plan + the section, and carry NO mandatory `PLAN-EVENT` sentinel and NO
// read-before-edit discipline. These tests grep the EMITTED block strings (not
// just the helper names) so a reintroduction of either ceremony fails here.
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

// The retired ceremony, in emitted-string form — none of these may survive.
const RETIRED = [
  '<!--PLAN-EVENT',              // the mandatory per-turn sentinel example
  'End EVERY',                   // "End EVERY ... turn with a PLAN-EVENT sentinel"
  'raw+editWindow',             // the read-before-edit mandate
  'read_plan_section',           // read-FIRST instruction
  'data-anchor',                 // edit-discipline text
  'claimed_section_anchor',      // sentinel field
];

test('writer block is orientation only: names plan + section, edits natively', () => {
  const b = planRailContractBlock(PLAN, ANCHOR);
  assert.ok(b.includes('── Plan-rail contract ──'), 'header preserved');
  assert.ok(b.includes(PLAN), 'plan id threaded in words');
  assert.ok(b.includes(ANCHOR), 'section anchor present');
  assert.ok(b.includes('native `Edit`'), 'still names the native-edit write path');
});

test('writer block obligates NO per-turn sentinel and NO read-before-edit (grep emitted string)', () => {
  const b = planRailContractBlock(PLAN, ANCHOR);
  for (const ceremony of RETIRED) {
    assert.ok(!b.includes(ceremony), `retired ceremony "${ceremony}" must be absent from the writer block`);
  }
});

test('non-writer block is orientation only: names plan + section, states not-a-write-turn', () => {
  const b = planClaimConventionBlock(PLAN, ANCHOR);
  assert.ok(b.includes('── Plan-rail contract (review turn) ──'), 'review header preserved');
  assert.ok(b.includes(PLAN), 'plan id threaded in words');
  assert.ok(b.includes(ANCHOR), 'section anchor present');
  assert.ok(b.includes('NOT writing a section'), 'states it is not a write turn');
});

test('non-writer block obligates NO per-turn sentinel (grep emitted string)', () => {
  const b = planClaimConventionBlock(PLAN, ANCHOR);
  for (const ceremony of RETIRED) {
    assert.ok(!b.includes(ceremony), `retired ceremony "${ceremony}" must be absent from the non-writer block`);
  }
});

test('both builders are deterministic across calls', () => {
  assert.equal(planRailContractBlock(PLAN, ANCHOR), planRailContractBlock(PLAN, ANCHOR));
  assert.equal(planClaimConventionBlock(PLAN, ANCHOR), planClaimConventionBlock(PLAN, ANCHOR));
});

test('PLAN_EVENT_STATUSES vocabulary is retained for the fail-open parser (unchanged seven-value set)', () => {
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
