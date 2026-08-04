// WP-P5D — executing supervisor-active-plan dispatch default.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/dispatch-default.activePlan.test.js

import assert from 'node:assert/strict';

import {
  resolveRequestedPlanBinding,
  type DispatchAgentInfo,
  type DispatchDeps,
} from './dispatch-context';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const target: DispatchAgentInfo = {
  workspaceId: 'ws-1',
  planId: 'stale-target-plan',
};

function deps(activePlanId: string | null, over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    getAgent: () => null,
    resolveCapability: async () => null,
    planInWorkspace: (_workspaceId, planId) => planId === 'explicit-plan',
    planItemInPlan: () => true,
    resolveActivePlanDefault: () => activePlanId,
    planImplementGate: (planId) => ({
      isStructured: true,
      hasActiveExecutionRun: planId === activePlanId,
    }),
    ...over,
  };
}

test('before Implement, agent-default binds no plan and never reuses agents.plan_id', () => {
  assert.deepEqual(resolveRequestedPlanBinding(deps(null), target, undefined), {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'agent-default' },
  });
});

test('after Implement, agent-default stamps the executing active plan without an item', () => {
  assert.deepEqual(resolveRequestedPlanBinding(deps('active-plan'), target, undefined), {
    ok: true,
    stamp: { planId: 'active-plan', planItemId: null, source: 'agent-default' },
  });
});

test('explicit validated plan wins and the active-plan source is not consulted', () => {
  let defaultReads = 0;
  const d = deps('active-plan', {
    resolveActivePlanDefault: () => { defaultReads += 1; return 'active-plan'; },
    planImplementGate: () => ({ isStructured: true, hasActiveExecutionRun: true }),
  });
  assert.deepEqual(resolveRequestedPlanBinding(d, target, {
    mode: 'explicit', planId: 'explicit-plan', planItemId: null,
  }), {
    ok: true,
    stamp: { planId: 'explicit-plan', planItemId: null, source: 'explicit' },
  });
  assert.equal(defaultReads, 0);
});

test('stale focus/default-source failure fails closed instead of falling back', () => {
  const throwing = deps('active-plan', {
    resolveActivePlanDefault: () => { throw new Error('db unavailable'); },
  });
  assert.deepEqual(resolveRequestedPlanBinding(throwing, target, { mode: 'agent-default' }), {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'agent-default' },
  });
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
