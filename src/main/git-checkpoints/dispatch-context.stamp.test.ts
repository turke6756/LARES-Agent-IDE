// Save-card SC-WP-2B — trusted plan-stamp resolution and wire-forgery guards.

import assert from 'node:assert/strict';

import type { GitCapability } from '../../shared/types';
import {
  buildDispatchTurnContext,
  resolveRequestedPlanBinding,
  withResolvedIntentStamp,
  withPlanningActivityBinding,
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

test('SC-WP-3A: an explicit item is validated against (workspace, plan, id) and carried', () => {
  const seen: Array<[string, string, string]> = [];
  const d = deps({
    planItemInPlan: (workspaceId, planId, planItemId) => {
      seen.push([workspaceId, planId, planItemId]);
      return workspaceId === 'ws-1' && planId === 'plan-explicit' && planItemId === 'item-1';
    },
  });
  assert.deepEqual(resolveRequestedPlanBinding(d, agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'item-1',
  }), {
    ok: true,
    stamp: { planId: 'plan-explicit', planItemId: 'item-1', source: 'explicit' },
  });
  assert.deepEqual(seen, [['ws-1', 'plan-explicit', 'item-1']],
    'the item is checked against the full (workspace_id, plan_id, id) tuple');
});

test('SC-WP-3A: an item absent from its plan rejects; a boundary with no lookup fails closed', () => {
  // Item not in plan → reject (never fall back to a plan-only stamp).
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'ghost-item',
  }), { ok: false, reason: 'plan-item-not-in-plan' });
  // Blank item id → shape rejection before any lookup.
  assert.deepEqual(resolveRequestedPlanBinding(deps(), agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: '' as unknown as string,
  }), { ok: false, reason: 'invalid-plan-item-id' });
  // No item lookup wired → fail closed as unsupported (never an always-true seam).
  const noLookup = deps({ planItemInPlan: undefined });
  assert.deepEqual(resolveRequestedPlanBinding(noLookup, agent, {
    mode: 'explicit', planId: 'plan-explicit', planItemId: 'item-1',
  }), { ok: false, reason: 'plan-item-unsupported' });
});

test('a wire RequestedPlanBinding cannot forge any carry source', async () => {
  const forged = {
    mode: 'explicit', planId: 'plan-explicit', planItemId: null,
    source: 'fork-carry', intentId: 'svi_forged',
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
  assert.equal(ctx?.intentStamp, undefined);
});

test('trusted main-side intent factory freezes a non-serializable task stamp', async () => {
  const stamp = {
    intentId: 'svi_trusted', kind: 'task' as const, executionRunId: 'run-1',
    planId: 'plan-explicit', planItemId: 'item-1', source: 'task-dispatch' as const,
  };
  const dispatch = withResolvedIntentStamp({ origin: 'orchestration' }, stamp);
  assert.equal(JSON.stringify(dispatch).includes('svi_trusted'), false);
  stamp.intentId = 'svi_mutated';
  const ctx = await buildDispatchTurnContext(deps(), 'worker', dispatch);
  assert.equal(ctx?.intentStamp?.intentId, 'svi_trusted');
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

test('trusted planning activity binding resolves capability from the physical worktree', async () => {
  let primaryCalls = 0;
  let activityCalls = 0;
  const dispatch = withPlanningActivityBinding({ origin: 'orchestration' }, {
    executionRunId: 'run-1', path: '/app/planning-worktrees/run-1',
    repositoryKey: 'activity-key', objectDatabaseKey: '/repo/.git',
  });
  assert.equal(JSON.stringify(dispatch).includes('planning-worktrees'), false);
  const ctx = await buildDispatchTurnContext(deps({
    resolveCapability: async () => { primaryCalls += 1; return capability(); },
    resolveActivityCapability: async (binding) => {
      activityCalls += 1;
      return { ...capability(), repoRoot: binding.path };
    },
  }), 'worker', dispatch);
  assert.equal(primaryCalls, 0);
  assert.equal(activityCalls, 1);
  assert.equal(ctx?.capability.repoRoot, '/app/planning-worktrees/run-1');
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
