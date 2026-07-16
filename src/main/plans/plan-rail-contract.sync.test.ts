// GT-C Decision 2 (§2.3) — full-equality drift guard across the TS/JS boundary.
//
// The canonical rail contract lives in TS (plan-rail-contract.ts); the MCP
// scripts require a byte-identical CommonJS mirror (scripts/lib/plan-rail-contract.js)
// because tsconfig.main.json sets no allowJs and excludes scripts/. This test
// compiles the TS canonical (via build:main) and require()s the JS mirror, then
// asserts FULL STRING EQUALITY of both block builders for representative inputs.
// Any drift between the two files fails CI here.
//
//   npm run build:main
//   node dist/main/main/plans/plan-rail-contract.sync.test.js

import assert from 'node:assert/strict';
import path from 'node:path';
import {
  planRailContractBlock as tsWriter,
  planClaimConventionBlock as tsNonWriter,
  PLAN_EVENT_STATUSES as tsStatuses,
} from './plan-rail-contract';

// Resolve the JS mirror at the repo root relative to the compiled test location
// (dist/main/main/plans/ → repo root is four levels up).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const js = require(path.resolve(__dirname, '../../../../scripts/lib/plan-rail-contract.js')) as {
  planRailContractBlock(planId: string, sectionAnchor: string): string;
  planClaimConventionBlock(planId: string, sectionAnchor: string): string;
  PLAN_EVENT_STATUSES: string[];
};

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// Representative (planId, anchor) inputs — a plain one and one with punctuation.
const CASES: Array<[string, string]> = [
  ['plan-abc123', 'sec_exectr'],
  ['2d3003b3-001b-4b7e-9700-11e163736a9a', 'sec_a1b2c3'],
];

test('PLAN_EVENT_STATUSES vocab is identical (TS vs JS mirror)', () => {
  assert.deepEqual([...tsStatuses], js.PLAN_EVENT_STATUSES);
});

for (const [planId, anchor] of CASES) {
  test(`planRailContractBlock full-equality (${planId}, ${anchor})`, () => {
    assert.equal(tsWriter(planId, anchor), js.planRailContractBlock(planId, anchor));
  });
  test(`planClaimConventionBlock full-equality (${planId}, ${anchor})`, () => {
    assert.equal(tsNonWriter(planId, anchor), js.planClaimConventionBlock(planId, anchor));
  });
}

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
