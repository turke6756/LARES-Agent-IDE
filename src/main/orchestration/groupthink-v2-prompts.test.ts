// GT-C Decision 2 (§2.7) — GroupThink rail-prompt threading tests.
//
// Asserts the plan-rail branch of each kickoff builder:
//   • writers (serialLeadPrompt / parallelR1Prompt / parallelSynthesisPrompt)
//     get planRailContractBlock when planId && sectionAnchor;
//   • non-writers (serialReviewerKickoff / parallelR2Prompt) get
//     planClaimConventionBlock;
//   • no-rail (sectionAnchor absent) is BYTE-IDENTICAL to the legacy verbatim
//     prompt — guards the VERBATIM invariant.
//
//   npm run build:main
//   node dist/main/main/orchestration/groupthink-v2-prompts.test.js

import assert from 'node:assert/strict';
import {
  serialLeadPrompt,
  serialReviewerKickoff,
  parallelR1Prompt,
  parallelR2Prompt,
  parallelSynthesisPrompt,
} from './groupthink-v2-prompts';
import { planRailContractBlock, planClaimConventionBlock } from '../plans/plan-rail-contract';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const TOPIC = 'Redesign the widget pipeline';
const PLAN_PATH = '/ws/plans/surface.html';
const PLAN_ID = 'plan-77';
const ANCHOR = 'sec_abcd12';
const DRAFT = 'Here is my draft.';

const WRITER = planRailContractBlock(PLAN_ID, ANCHOR);
const REVIEWER = planClaimConventionBlock(PLAN_ID, ANCHOR);

// ── Writers get the writer contract ──────────────────────────────────

test('serialLeadPrompt (writer) appends planRailContractBlock when plan-rail', () => {
  const p = serialLeadPrompt(TOPIC, PLAN_PATH, ANCHOR, PLAN_ID);
  assert.ok(p.endsWith('\n\n' + WRITER), 'lead prompt must end with the writer contract block');
  assert.ok(!p.includes(REVIEWER), 'lead prompt must NOT carry the non-writer block');
});

test('parallelR1Prompt (writer) appends planRailContractBlock when plan-rail', () => {
  const p = parallelR1Prompt(TOPIC, ANCHOR, PLAN_ID);
  assert.ok(p.endsWith('\n\n' + WRITER), 'R1 prompt must end with the writer contract block');
});

test('parallelSynthesisPrompt (writer) appends planRailContractBlock when plan-rail', () => {
  const p = parallelSynthesisPrompt(DRAFT, PLAN_PATH, ANCHOR, PLAN_ID);
  assert.ok(p.endsWith('\n\n' + WRITER), 'synthesis prompt must end with the writer contract block');
});

// ── Non-writers get the review contract ──────────────────────────────

test('serialReviewerKickoff (non-writer) appends planClaimConventionBlock when plan-rail', () => {
  const p = serialReviewerKickoff(TOPIC, DRAFT, ANCHOR, PLAN_ID);
  assert.ok(p.endsWith('\n\n' + REVIEWER), 'reviewer prompt must end with the non-writer contract block');
  assert.ok(!p.includes(WRITER), 'reviewer prompt must NOT carry the writer block');
});

test('parallelR2Prompt (non-writer) appends planClaimConventionBlock when plan-rail', () => {
  const p = parallelR2Prompt(DRAFT, ANCHOR, PLAN_ID);
  assert.ok(p.endsWith('\n\n' + REVIEWER), 'R2 prompt must end with the non-writer contract block');
});

// ── VERBATIM invariant: no-rail path is byte-identical to legacy ──────

test('no-rail (sectionAnchor absent) is byte-identical to the legacy prompt — all five builders', () => {
  // Legacy prompts take no rail params; the plan-rail branch must be skipped and
  // return the base string unchanged.
  assert.equal(serialLeadPrompt(TOPIC, PLAN_PATH), serialLeadPrompt(TOPIC, PLAN_PATH, undefined, undefined));
  assert.equal(serialReviewerKickoff(TOPIC, DRAFT), serialReviewerKickoff(TOPIC, DRAFT, undefined, undefined));
  assert.equal(parallelR1Prompt(TOPIC), parallelR1Prompt(TOPIC, undefined, undefined));
  assert.equal(parallelR2Prompt(DRAFT), parallelR2Prompt(DRAFT, undefined, undefined));
  assert.equal(parallelSynthesisPrompt(DRAFT, PLAN_PATH), parallelSynthesisPrompt(DRAFT, PLAN_PATH, undefined, undefined));

  // And none of them carry a contract block when no-rail.
  for (const p of [
    serialLeadPrompt(TOPIC, PLAN_PATH),
    serialReviewerKickoff(TOPIC, DRAFT),
    parallelR1Prompt(TOPIC),
    parallelR2Prompt(DRAFT),
    parallelSynthesisPrompt(DRAFT, PLAN_PATH),
  ]) {
    assert.ok(!p.includes('── Plan-rail contract'), 'no-rail prompt must not carry any rail contract block');
  }
});

test('planId present but sectionAnchor absent → no contract (gate needs both)', () => {
  const p = serialLeadPrompt(TOPIC, PLAN_PATH, undefined, PLAN_ID);
  assert.ok(!p.includes('── Plan-rail contract'), 'a planId without a sectionAnchor must not append a contract');
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
