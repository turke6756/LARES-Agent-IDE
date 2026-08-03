// SC-WP-2E — lifecycle producers freeze plan stamps into the pending-prompt
// rail. This test intentionally exercises the real trusted dispatch carrier;
// no turn-history accessor participates in fork/revive resolution.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor } from './index';
import { buildDispatchTurnContext, type DispatchContext } from '../git-checkpoints/dispatch-context';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent, GitCapability } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

interface PendingPrompt { text: string; expiresAt: number; dispatch: DispatchContext; }

function pending(supervisor: AgentSupervisor, agentId: string): PendingPrompt | undefined {
  return (supervisor as unknown as {
    pendingInitialPrompts: Map<string, PendingPrompt>;
  }).pendingInitialPrompts.get(agentId);
}

async function stampOf(agent: Agent, dispatch: DispatchContext) {
  const ctx = await buildDispatchTurnContext({
    getAgent: (id) => id === agent.id ? agent : null,
    resolveCapability: async () => ({ repoRoot: agent.workingDirectory } as unknown as GitCapability),
    planInWorkspace: () => true,
  }, agent.id, dispatch);
  assert.ok(ctx, 'trusted pending dispatch must build a turn context');
  return ctx.planStamp;
}

function patchDatabase(workspacePath: string, agents: Agent[]) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'getAgent', 'getWorkspace', 'getAgentsByWorkspace', 'createAgent',
    'updateAgentResumeSessionId', 'addEvent', 'getPlan', 'planItemInPlan',
  ];
  const original: Record<string, unknown> = {};
  for (const key of keys) original[key] = db[key];

  let forkSeq = 0;
  db.getAgent = (id: string) => agents.find(agent => agent.id === id) ?? null;
  db.getWorkspace = (id: string) => ({ id, path: workspacePath, defaultCommand: 'claude' });
  db.getAgentsByWorkspace = (workspaceId: string) => agents.filter(agent => agent.workspaceId === workspaceId);
  db.createAgent = (input: Partial<Agent>) => {
    const created = makeAgent(`fork-${++forkSeq}`, {
      ...input,
      workspaceId: input.workspaceId ?? 'ws-1',
      workingDirectory: input.workingDirectory ?? workspacePath,
      resumeSessionId: null,
      status: 'idle',
    });
    agents.push(created);
    return created;
  };
  db.updateAgentResumeSessionId = (id: string, sessionId: string) => {
    const agent = agents.find(candidate => candidate.id === id);
    if (agent) agent.resumeSessionId = sessionId;
  };
  db.addEvent = () => {};
  db.getPlan = (id: string) => id === 'plan-b'
    ? { id, workspaceId: 'ws-1', path: 'plan-b.md' }
    : null;
  // SC-WP-3A: item-in-plan lookup — only (ws-1, plan-b, item-1) is a valid item.
  db.planItemInPlan = (workspaceId: string, planId: string, planItemId: string) =>
    workspaceId === 'ws-1' && planId === 'plan-b' && planItemId === 'item-1';

  return () => { for (const key of keys) db[key] = original[key]; };
}

function quietSupervisor(): AgentSupervisor {
  const supervisor = new AgentSupervisor();
  const mutable = supervisor as unknown as Record<string, unknown>;
  mutable.launchWindowsAgent = async () => {};
  mutable.assertResumable = () => {};
  mutable.reconcileGate = { resolve: async () => ({ action: 'proceed', reason: 'test', pids: [] }) };
  mutable.stopAgentLocked = async () => ({ outcome: 'already_stopped' });
  mutable.resumeAgentAfterStopLocked = async () => {};
  return supervisor;
}

test('fork copies source.planId and freezes fork-carry; explicit none clears only the wake stamp', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-stamp-'));
  const source = makeAgent('source', {
    workspaceId: 'ws-1', workingDirectory: workspacePath, command: 'claude',
    provider: 'claude', resumeSessionId: 'session-source', planId: 'plan-a',
  });
  const agents = [source];
  const restore = patchDatabase(workspacePath, agents);
  try {
    const supervisor = quietSupervisor();
    const carried = await supervisor.forkAgent(source.id, { message: 'continue the fork' });
    assert.equal(carried.planId, 'plan-a', 'fork agent persists the source frozen plan binding');
    const carriedPending = pending(supervisor, carried.id);
    assert.ok(carriedPending?.dispatch, 'fork wake retains dispatch metadata');
    source.planId = 'latest-turn-must-not-win';
    assert.deepEqual(await stampOf(carried, carriedPending.dispatch), {
      planId: 'plan-a', planItemId: null, source: 'fork-carry',
    });

    const cleared = await supervisor.forkAgent(source.id, {
      message: 'unbound fork wake', requestedPlanBinding: { mode: 'none' },
    });
    const clearedPending = pending(supervisor, cleared.id);
    assert.ok(clearedPending?.dispatch);
    assert.deepEqual(await stampOf(cleared, clearedPending.dispatch), {
      planId: null, planItemId: null, source: 'explicit-none',
    });
  } finally {
    restore();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('revive freezes carry/explicit/none, validates explicit items (SC-WP-3A), and delivers the same dispatch', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-stamp-'));
  const agent = makeAgent('revive-target', {
    workspaceId: 'ws-1', workingDirectory: workspacePath, command: 'claude',
    provider: 'claude', resumeSessionId: 'session-revive', status: 'done', planId: 'plan-a',
  });
  const agents = [agent];
  const restore = patchDatabase(workspacePath, agents);
  try {
    const supervisor = quietSupervisor();
    await supervisor.reviveAgent(agent.id, { message: 'default wake' });
    const carried = pending(supervisor, agent.id);
    assert.ok(carried?.dispatch);
    agent.planId = 'changed-after-staging';
    assert.deepEqual(await stampOf(agent, carried.dispatch), {
      planId: 'plan-a', planItemId: null, source: 'revive-carry',
    });

    await supervisor.reviveAgent(agent.id, {
      message: 'explicit wake',
      requestedPlanBinding: { mode: 'explicit', planId: 'plan-b', planItemId: null },
    });
    const explicit = pending(supervisor, agent.id);
    assert.ok(explicit?.dispatch);
    assert.deepEqual(await stampOf(agent, explicit.dispatch), {
      planId: 'plan-b', planItemId: null, source: 'explicit',
    });

    await supervisor.reviveAgent(agent.id, {
      message: 'clear wake', requestedPlanBinding: { mode: 'none' },
    });
    const cleared = pending(supervisor, agent.id);
    assert.ok(cleared?.dispatch);
    assert.deepEqual(await stampOf(agent, cleared.dispatch), {
      planId: null, planItemId: null, source: 'explicit-none',
    });

    // SC-WP-3A: a valid explicit item override is now accepted and frozen.
    await supervisor.reviveAgent(agent.id, {
      message: 'explicit item wake',
      requestedPlanBinding: { mode: 'explicit', planId: 'plan-b', planItemId: 'item-1' },
    });
    const explicitItem = pending(supervisor, agent.id);
    assert.ok(explicitItem?.dispatch);
    assert.deepEqual(await stampOf(agent, explicitItem.dispatch), {
      planId: 'plan-b', planItemId: 'item-1', source: 'explicit',
    });

    // An item absent from the plan is still rejected, before any stop/relaunch.
    let stops = 0;
    (supervisor as unknown as { stopAgentLocked: unknown }).stopAgentLocked = async () => {
      stops++;
      return { outcome: 'already_stopped' };
    };
    await assert.rejects(
      supervisor.reviveAgent(agent.id, {
        message: 'ghost item',
        requestedPlanBinding: { mode: 'explicit', planId: 'plan-b', planItemId: 'ghost-item' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'plan-item-not-in-plan',
    );
    assert.equal(stops, 0, 'invalid-item rejection happens before stop/relaunch');

    // Stage one more frozen carry, then mutate the live default before delivery.
    agent.planId = 'plan-delivery';
    await supervisor.reviveAgent(agent.id, { message: 'deliver me' });
    const staged = pending(supervisor, agent.id);
    assert.ok(staged);
    agent.planId = 'mutated-before-delivery';
    let deliveredDispatch: DispatchContext | undefined;
    (supervisor as unknown as { sendInput: unknown }).sendInput = (
      _id: string, _text: string, _opts: unknown, dispatch: DispatchContext,
    ) => {
      deliveredDispatch = dispatch;
      return Promise.resolve(true);
    };
    (supervisor as unknown as { windowsRunners: Map<string, unknown> }).windowsRunners.set(agent.id, {});
    (supervisor as unknown as { maybeDeliverInitialUserPrompt: (id: string, status: string) => void })
      .maybeDeliverInitialUserPrompt(agent.id, 'idle');
    assert.equal(deliveredDispatch, staged.dispatch, 'delivery receives the exact frozen dispatch object');
    assert.deepEqual(await stampOf(agent, deliveredDispatch!), {
      planId: 'plan-delivery', planItemId: null, source: 'revive-carry',
    });
  } finally {
    restore();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

async function main(): Promise<void> {
  let failures = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failures++;
      console.error(`not ok - ${entry.name}`);
      console.error(error);
    }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`\n${tests.length} supervisor fork/revive stamp tests passed.`);
}

void main();
