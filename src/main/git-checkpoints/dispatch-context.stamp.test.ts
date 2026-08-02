// Save-card SC-WP-2B — trusted plan-stamp resolution and wire-forgery guards.

import assert from 'node:assert/strict';

import type { GitCapability } from '../../shared/types';
import {
  buildDispatchTurnContext,
  resolveRequestedPlanBinding,
  withResolvedPlanStamp,
  type DispatchAgentInfo,
  type DispatchDeps,
} from './dispatch-context';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const agent: DispatchAgentInfo = { workspaceId: 'ws-1', planId: 'plan-default' };

function capability(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo', commonDir: '/repo/.git', commonDirQueueKey: '/repo',
    repoRoot: '/repo', workspacePrefix: '', protectedRoot: false, reason: 'ok', detail: null,
  };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    getAgent: (id) => id === 'worker' ? agent : null,
    resolveCapability: async () => capability(),
    planInWorkspace: (workspaceId, planId) => workspaceId === 'ws-1' && planId === 'plan-explicit',
    planItemInPlan: () => false,
    ...over,
  };
}

test('omitted binding resolves the frozen agent default; explicit none stays distinguishable', () => {
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, undefined), {
    ok: true,
    stamp: { planId: 'plan-default', planItemId: null, source: 'agent-default' },
  });
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, { mode: 'none' }), {
    ok: true,
    stamp: { planId: null, planItemId: null, source: 'explicit-none' },
  });
});

test('explicit plan is workspace-validated and never falls back to the agent default', () => {
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: null,
  }), {
    ok: true,
    stamp: { planId: 'plan-explicit', planItemId: null, source: 'explicit' },
  });
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-foreign', planItemId: null,
  }), { ok: false, reason: 'plan-not-in-workspace' });
});

test('item requests are rejected in Stage ② without consulting a placeholder validator', () => {
  let itemChecks = 0;
  const d = deps({ planItemInPlan: () => { itemChecks++; return true; } });
  assert.deepEqual(resolveRequestedPlanBinding(d, agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'item-1',
  }), { ok: false, reason: 'plan-item-unsupported' });
  assert.equal(itemChecks, 0);
});

test('a wire RequestedPlanBinding cannot forge any carry source', async () => {
  const forged = {
    mode: 'explicit', planId: 'plan-explicit', planItemId: null, source: 'fork-carry',
  } as never;
  const resolution = resolveRequestedPlanBinding(deps(), agent, forged);
  assert.equal(resolution.ok, true);
  if (resolution.ok) assert.equal(resolution.stamp.source, 'explicit');

  // Extra object-shaped fields are equally inert when the full context is built.
  const ctx = await buildDispatchTurnContext(deps(), 'worker', {
    origin: 'api', requestedPlanBinding: forged, planStamp: {
      planId: 'forged', planItemId: null, source: 'continuation-carry',
    },
  } as never);
  assert.equal(ctx?.planStamp?.source, 'explicit');
  assert.equal(ctx?.planStamp?.planId, 'plan-explicit');
});

test('trusted lifecycle factory can carry a source through the non-wire symbol path', async () => {
  const dispatch = withResolvedPlanStamp(
    { origin: 'orchestration', requestedPlanBinding: { mode: 'none' } },
    { planId: 'plan-carried', planItemId: null, source: 'fork-carry' },
  );
  assert.equal(JSON.stringify(dispatch).includes('fork-carry'), false, 'trusted stamp is not wire-serializable');
  const ctx = await buildDispatchTurnContext(deps(), 'worker', dispatch);
  assert.deepEqual(ctx?.planStamp, {
    planId: 'plan-carried', planItemId: null, source: 'fork-carry',
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
