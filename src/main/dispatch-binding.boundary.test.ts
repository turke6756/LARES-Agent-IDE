// Save-card SC-WP-2C — API/IPC plan-binding boundary acceptance.

import assert from 'node:assert/strict';
import http from 'node:http';

import { ApiServer, resolvePlanBindingAtBoundary } from './api-server';
import type { AgentSupervisor } from './supervisor';
import type { Agent, GitCapability, Plan, SendOutcome } from '../shared/types';
import type { DispatchContext, DispatchDeps } from './git-checkpoints/dispatch-context';
import { buildDispatchTurnContext } from './git-checkpoints/dispatch-context';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const WS_TARGET = 'ws-target';
const target = {
  id: 'worker', workspaceId: WS_TARGET, planId: 'plan-default', status: 'idle',
  title: 'Worker', resumeSessionId: null, continuationGeneration: 0,
} as unknown as Agent;
const plans = new Map<string, Plan>([
  ['plan-valid', { id: 'plan-valid', workspaceId: WS_TARGET, deletedAt: null } as Plan],
  ['plan-foreign', { id: 'plan-foreign', workspaceId: 'ws-other', deletedAt: null } as Plan],
]);

function capability(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo', commonDir: '/repo/.git', commonDirQueueKey: '/repo',
    repoRoot: '/repo', workspacePrefix: '', protectedRoot: false, reason: 'ok', detail: null,
  };
}

async function stampFrom(dispatch: DispatchContext): Promise<unknown> {
  const deps: DispatchDeps = {
    getAgent: (id) => id === target.id ? target : null,
    resolveCapability: async () => capability(),
    // The trusted stamp must bypass this fail-closed seam.
    planInWorkspace: () => false,
  };
  return (await buildDispatchTurnContext(deps, target.id, dispatch))?.planStamp;
}

interface Harness {
  api: ApiServer;
  sends: Array<{ agentId: string; text: string; dispatch?: DispatchContext }>;
  outcomeSends: Array<{ agentId: string; text: string; dispatch?: DispatchContext }>;
  subscriptions: number;
  cleanup(): void;
}

function makeHarness(sendOutcome?: SendOutcome): Harness {
  // Patch the CommonJS export read by api-server's database import. This keeps
  // the boundary test isolated from the real application database.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const originalGetAgent = db.getAgent;
  const originalGetPlan = db.getPlan;
  db.getAgent = (id: string) => id === target.id ? target : null;
  db.getPlan = (id: string) => plans.get(id) ?? null;

  const sends: Harness['sends'] = [];
  const outcomeSends: Harness['outcomeSends'] = [];
  let subscriptions = 0;
  const supervisor = {
    isInputInFlight: () => false,
    registerTransientTurnSubscription: () => { subscriptions++; return { registered: true }; },
    cancelTransientTurnSubscriptionsForPair: () => {},
    sendInput: async (agentId: string, text: string, _opts: unknown, dispatch?: DispatchContext) => {
      sends.push({ agentId, text, dispatch });
      return true;
    },
    sendInputWithOutcome: async (agentId: string, text: string, _opts: unknown, dispatch?: DispatchContext) => {
      outcomeSends.push({ agentId, text, dispatch });
      return sendOutcome ?? { disposition: 'confirmed', agentId, delivered: true, confirmationSource: 'hook', completedAt: Date.now() };
    },
    sendInputConfirmed: async () => ({ delivered: true, confirmed: true, mode: 'hook' }),
  } as unknown as AgentSupervisor;
  const api = new ApiServer(supervisor, 24679);

  return {
    api, sends, outcomeSends,
    get subscriptions() { return subscriptions; },
    cleanup() { db.getAgent = originalGetAgent; db.getPlan = originalGetPlan; },
  };
}

async function callInput(api: ApiServer, body: unknown): Promise<{ status: number; body: any }> {
  const pathname = `/api/agents/${target.id}/input`;
  const req = new http.IncomingMessage(null as any);
  req.method = 'POST';
  req.url = pathname;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  try {
    const result = await (api as unknown as {
      route: (method: string, url: URL, req: http.IncomingMessage, identity: unknown) => Promise<any>;
    }).route('POST', new URL(pathname, 'http://localhost:24679'), req, {
      workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null,
    });
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message, code: err.code } };
  }
}

test('direct-human dispatch freezes the target agent default with no owner or item', async () => {
  const dispatch = resolvePlanBindingAtBoundary(
    { getPlanById: (id) => plans.get(id) ?? null }, target, 'human-terminal', undefined,
  );
  const ctx = await buildDispatchTurnContext({
    getAgent: (id) => id === target.id ? target : null,
    resolveCapability: async () => capability(),
  }, target.id, dispatch);
  assert.equal(dispatch.origin, 'human-terminal');
  assert.deepEqual(ctx?.planStamp, {
    planId: 'plan-default', planItemId: null, source: 'agent-default',
  });
  assert.equal(ctx?.ownerAgentId, null);
});

test('API valid explicit binding is frozen and carried into the delivery call', async () => {
  const h = makeHarness();
  try {
    const res = await callInput(h.api, {
      text: 'do it', requestedPlanBinding: {
        mode: 'explicit', planId: 'plan-valid', planItemId: null,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(h.sends.length, 1);
    assert.deepEqual(await stampFrom(h.sends[0].dispatch!), {
      planId: 'plan-valid', planItemId: null, source: 'explicit',
    });
  } finally { h.cleanup(); }
});

test('API confirmed explicit binding uses the context-carrying outcome path', async () => {
  const h = makeHarness();
  try {
    const res = await callInput(h.api, {
      text: 'do it', confirm: true, requestedPlanBinding: {
        mode: 'explicit', planId: 'plan-valid', planItemId: null,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(h.sends.length, 0);
    assert.equal(h.outcomeSends.length, 1);
    assert.deepEqual(await stampFrom(h.outcomeSends[0].dispatch!), {
      planId: 'plan-valid', planItemId: null, source: 'explicit',
    });
  } finally { h.cleanup(); }
});

test('API confirmed delivery preserves an interactive sign-in teaching hint', async () => {
  const h = makeHarness({
    disposition: 'failed',
    agentId: target.id,
    delivered: false,
    reason: 'interactive-prompt',
    prompt: { kind: 'sign-in', label: 'Antigravity CLI sign-in', excerpt: 'You are currently not signed in' },
    completedAt: Date.now(),
  });
  try {
    const res = await callInput(h.api, {
      text: 'do it', confirm: true, requestedPlanBinding: {
        mode: 'explicit', planId: 'plan-valid', planItemId: null,
      },
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'delivery-failed');
    assert.match(res.body.error, /Open the terminal to finish signing in, then resend the message\./);
    assert.equal(h.outcomeSends.length, 1);
  } finally { h.cleanup(); }
});

test('cross-workspace explicit plan rejects 400 with no fallback or side effects', async () => {
  const h = makeHarness();
  try {
    const res = await callInput(h.api, {
      text: 'do it', senderAgentId: 'sender', requestedPlanBinding: {
        mode: 'explicit', planId: 'plan-foreign', planItemId: null,
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid-plan-binding');
    assert.match(res.body.error, /plan-not-in-workspace/);
    assert.equal(h.sends.length, 0, 'no PTY delivery was enqueued');
    assert.equal(h.outcomeSends.length, 0, 'no confirmed delivery was enqueued');
    assert.equal(h.subscriptions, 0, 'validation precedes subscription side effects');
  } finally { h.cleanup(); }
});

test('explicit item is rejected whether its plan is missing, valid, or mismatched', async () => {
  for (const planId of ['', 'plan-valid', 'plan-foreign']) {
    const h = makeHarness();
    try {
      const res = await callInput(h.api, {
        text: 'do it', requestedPlanBinding: {
          mode: 'explicit', planId, planItemId: 'item-1',
        },
      });
      assert.equal(res.status, 400, `plan ${planId}`);
      assert.equal(h.sends.length + h.outcomeSends.length, 0, `plan ${planId} must not enqueue`);
    } finally { h.cleanup(); }
  }
});

test('malformed explicit id rejects before delivery, so no PTY bytes or turn-open path can run', async () => {
  const h = makeHarness();
  try {
    const res = await callInput(h.api, {
      text: 'do it', requestedPlanBinding: { mode: 'explicit', planId: '', planItemId: null },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid-plan-id/);
    assert.equal(h.sends.length + h.outcomeSends.length, 0);
  } finally { h.cleanup(); }
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
