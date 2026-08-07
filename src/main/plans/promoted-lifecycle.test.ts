import assert from 'node:assert/strict';
import type { TurnRecord } from '../database';
import { derivePromotedLifecycle } from './promoted-lifecycle';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function turn(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'id'>): TurnRecord {
  return {
    workspaceId: 'ws-1',
    turnSeq: 1,
    agentId: null,
    agentTitle: null,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    planId: null,
    planItemId: null,
    planStampSource: 'legacy-unstamped',
    sessionId: null,
    taskLabel: null,
    startedAt: 1,
    endedAt: null,
    status: 'open',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
    beforeQuality: null,
    afterQuality: null,
    beforeRawFilterBypassed: false,
    beforeFilteredPaths: null,
    beforePrunedAt: null,
    afterPrunedAt: null,
    touched: null,
    diffStats: null,
    compactDiff: null,
    compactDiffProvenance: null,
    failureReason: null,
    ...overrides,
  };
}

test('all-done packages complete the rollup', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'ready', turns: [],
    packages: [{ state: 'done' }, { state: 'done' }],
  });
  assert.equal(result.lifecycle, 'ready');
  assert.deepEqual(result.rollup, { total: 2, landed: 2, remaining: 0, archived: 0, completed: true });
});

test('mixed done and archived packages do not complete the rollup', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'executing', turns: [],
    packages: [{ state: 'done' }, { state: 'archived' }],
  });
  assert.deepEqual(result.rollup, { total: 2, landed: 1, remaining: 0, archived: 1, completed: false });
});

test('all-archived packages do not complete the rollup', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'archived', turns: [],
    packages: [{ state: 'archived' }, { state: 'archived' }],
  });
  assert.equal(result.rollup?.completed, false);
  assert.equal(result.rollup?.landed, 0);
});

test('active count includes only open verified turns stamped to this plan', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: null, packages: [],
    turns: [
      turn({ id: 'active', planId: 'plan-1', planStampSource: 'explicit' }),
      turn({ id: 'other-plan', planId: 'plan-2', planStampSource: 'agent-default' }),
      turn({ id: 'legacy', planId: 'plan-1', planStampSource: 'legacy-unstamped' }),
      turn({ id: 'closed', planId: 'plan-1', planStampSource: 'explicit', status: 'accepted' }),
    ],
  });
  assert.equal(result.lifecycle, 'unknown');
  assert.equal(result.rollup, null);
  assert.equal(result.activeVerifiedTurnCount, 1);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { failed++; console.error(`  FAIL ${t.name}`); console.error(err); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
