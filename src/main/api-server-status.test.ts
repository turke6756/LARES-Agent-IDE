// Tests for POST /api/agents/:id/status — Class IV worker hook endpoint.
// P1 contract (plans/p1-hook-spool-multi-transport.md §2): every valid body is
// normalized into a ParsedHookEvent and handed to
// AgentSupervisor.applyHookStatusEvent(agentId, event, 'http'); v≤6 bodies
// (no hookEventName meta) are flagged legacy with a synthesized host-clock ts;
// anything else → HTTP 400.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/api-server-status.test.js

import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import type { AgentSupervisor } from './supervisor';
import type { ParsedHookEvent, HookTransport } from './supervisor';
import { makeAgent } from './supervisor/test-helpers/fake-bridge-deps';
import type { Agent } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

function patchDb(agents: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('./database') as Record<string, unknown>;
  const orig = {
    getAgent: db.getAgent,
  };
  db.getAgent = (id: string) => agents.get(id) ?? null;
  return () => {
    db.getAgent = orig.getAgent;
  };
}

interface RouteResult {
  status: number;
  body: any;
}

async function callRoute(
  api: ApiServer,
  method: string,
  pathname: string,
  body?: any,
): Promise<RouteResult> {
  const url = new URL(pathname, 'http://localhost:24678');
  const req = new http.IncomingMessage(null as any);
  req.method = method;
  req.url = pathname;
  // Push the JSON body and end the stream so readBody resolves.
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  try {
    const result = await (api as unknown as {
      route: (m: string, u: URL, r: http.IncomingMessage) => Promise<any>;
    }).route(method, url, req);
    return { status: 200, body: result };
  } catch (err: any) {
    return { status: err.statusCode ?? 500, body: { error: err.message } };
  }
}

function makeApi(opts: { agent: Agent }): {
  api: ApiServer;
  recorded: Array<{ agentId: string; event: ParsedHookEvent; transport: HookTransport }>;
  cleanup: () => void;
} {
  const agents = new Map<string, Agent>([[opts.agent.id, opts.agent]]);
  const restoreDb = patchDb(agents);
  const recorded: Array<{ agentId: string; event: ParsedHookEvent; transport: HookTransport }> = [];
  const fakeSupervisor = {
    applyHookStatusEvent: (id: string, event: ParsedHookEvent, transport: HookTransport) => {
      recorded.push({ agentId: id, event, transport });
      return 'applied';
    },
    isInputInFlight: () => false,
    getContextStats: () => null,
  } as unknown as AgentSupervisor;
  const api = new ApiServer(fakeSupervisor, 24678);
  return {
    api,
    recorded,
    cleanup: () => { restoreDb(); },
  };
}

test('POST /api/agents/:id/status with v6-style idle body → legacy event via applyHookStatusEvent', async () => {
  const agent = makeAgent('a-1');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/status', {
      state: 'idle',
      source: 'hook-stop',
      ts: 1234, // v6 sends ts but no hookEventName → still legacy
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.recorded.length, 1);
    const { agentId, event, transport } = h.recorded[0];
    assert.equal(agentId, 'a-1');
    assert.equal(transport, 'http');
    assert.equal(event.state, 'idle');
    assert.equal(event.source, 'hook-stop');
    assert.equal(event.legacy, true, 'a body without hookEventName is legacy');
    assert.equal(event.hookEventName, 'Stop', 'legacy synthesizes the argv-style event name');
    assert.notEqual(event.ts, 1234, 'legacy synthesizes a host-clock ts, never trusts the body ts');
    assert.equal(res.body.result, 'applied', 'the applier verdict rides on the response');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with state="working" dispatches a working event', async () => {
  const agent = makeAgent('a-2');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-2/status', {
      state: 'working',
      source: 'hook-start',
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0].event.state, 'working');
    assert.equal(h.recorded[0].event.source, 'hook-start');
    assert.equal(h.recorded[0].event.hookEventName, 'UserPromptSubmit');
    assert.equal(h.recorded[0].event.legacy, true);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with full v7 meta → non-legacy event, ts passed through', async () => {
  const agent = makeAgent('a-7');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-7/status', {
      v: 1,
      agentId: 'a-7',
      state: 'idle',
      source: 'hook-stop',
      ts: 1717171717171,
      hookEventName: 'Stop',
      turnId: 'turn-9',
      sessionId: 'sess-3',
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.recorded.length, 1);
    const { event } = h.recorded[0];
    assert.equal(event.legacy, false, 'a v7 body with hookEventName+ts is NOT legacy');
    assert.equal(event.ts, 1717171717171, 'v7 ts is passed through verbatim (dedupe key clock)');
    assert.equal(event.hookEventName, 'Stop');
    assert.equal(event.turnId, 'turn-9');
    assert.equal(event.sessionId, 'sess-3');
    assert.equal(event.agentId, 'a-7');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with full waiting body → applied, excerpt + notificationType threaded', async () => {
  const agent = makeAgent('a-w');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-w/status', {
      state: 'waiting',
      source: 'hook-notification',
      ts: 1717171717999,
      hookEventName: 'Notification',
      excerpt: 'pick one',
      notificationType: 'permission_prompt',
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.recorded.length, 1);
    const { event } = h.recorded[0];
    assert.equal(event.state, 'waiting');
    assert.equal(event.source, 'hook-notification');
    assert.equal(event.legacy, false, 'a waiting body with hookEventName+ts is NOT legacy');
    assert.equal(event.ts, 1717171717999, 'waiting ts is passed through verbatim');
    assert.equal(event.hookEventName, 'Notification');
    assert.equal((event as any).waitingExcerpt, 'pick one', 'the excerpt rides onto the event as waitingExcerpt');
    assert.equal((event as any).notificationType, 'permission_prompt', 'notificationType is threaded onto the event');
    assert.equal(res.body.result, 'applied', 'the applier verdict rides on the response');
    assert.equal(res.body.state, 'waiting');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with legacy waiting body (no ts/hookEventName) synthesizes hookEventName="Notification"', async () => {
  const agent = makeAgent('a-wl');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-wl/status', {
      state: 'waiting',
      source: 'hook-notification',
      excerpt: 'needs human input',
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.recorded.length, 1);
    const { event } = h.recorded[0];
    assert.equal(event.state, 'waiting');
    assert.equal(event.legacy, true, 'a waiting body without hookEventName/ts is legacy');
    assert.equal(event.hookEventName, 'Notification', 'legacy waiting synthesizes the Notification event name');
    assert.equal((event as any).waitingExcerpt, 'needs human input', 'the excerpt is still threaded on the legacy path');
    assert.equal(res.body.result, 'applied');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with state="banana" returns 400 and dispatches nothing', async () => {
  const agent = makeAgent('a-b');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-b/status', {
      state: 'banana',
      source: 'whatever',
    });
    assert.equal(res.status, 400, `expected 400; got ${res.status}`);
    assert.equal(h.recorded.length, 0, 'no supervisor dispatch on a genuinely-unknown state');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with state="bogus" returns 400 and dispatches nothing', async () => {
  const agent = makeAgent('a-3');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-3/status', {
      state: 'bogus',
      source: 'whatever',
    });
    assert.equal(res.status, 400, `expected 400; got ${res.status}`);
    assert.equal(h.recorded.length, 0, 'no supervisor dispatch on rejected state');
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/:id/status with unknown agent returns 404', async () => {
  const agent = makeAgent('a-4');
  const h = makeApi({ agent });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/does-not-exist/status', {
      state: 'idle',
      source: 'hook-stop',
    });
    assert.equal(res.status, 404, `expected 404; got ${res.status}`);
    assert.equal(h.recorded.length, 0);
  } finally {
    h.cleanup();
  }
});

// ── POST /input transient-subscription wiring (tests 15–20 + unconfirmed) ──

interface InputApiCalls {
  register: Array<{ targetAgentId: string; subscriberAgentId: string; ttlMs?: number }>;
  cancel: Array<{ targetAgentId: string; subscriberAgentId: string }>;
  sendInput: Array<{ agentId: string; text: string }>;
  sendInputConfirmed: Array<{ agentId: string; text: string }>;
}

function makeInputApi(opts: {
  agent: Agent;
  registerResult?: { registered: boolean; reason?: string };
  confirmedResult?: { delivered: boolean; confirmed: boolean; mode: string };
  confirmedThrows?: Error;
  inputInFlight?: boolean;
}): { api: ApiServer; calls: InputApiCalls; cleanup: () => void } {
  const agents = new Map<string, Agent>([[opts.agent.id, opts.agent]]);
  const restoreDb = patchDb(agents);
  const calls: InputApiCalls = { register: [], cancel: [], sendInput: [], sendInputConfirmed: [] };
  const fakeSupervisor = {
    isInputInFlight: () => opts.inputInFlight ?? false,
    registerTransientTurnSubscription: (input: { targetAgentId: string; subscriberAgentId: string; ttlMs?: number }) => {
      calls.register.push(input);
      return opts.registerResult ?? { registered: true };
    },
    cancelTransientTurnSubscriptionsForPair: (targetAgentId: string, subscriberAgentId: string) => {
      calls.cancel.push({ targetAgentId, subscriberAgentId });
    },
    sendInputConfirmed: async (agentId: string, text: string) => {
      calls.sendInputConfirmed.push({ agentId, text });
      if (opts.confirmedThrows) throw opts.confirmedThrows;
      return opts.confirmedResult ?? { delivered: true, confirmed: true, mode: 'hook' };
    },
    sendInput: async (agentId: string, text: string) => { calls.sendInput.push({ agentId, text }); },
    getContextStats: () => null,
  } as unknown as AgentSupervisor;
  const api = new ApiServer(fakeSupervisor, 24678);
  return { api, calls, cleanup: () => { restoreDb(); } };
}

test('15. confirmed send with sender_agent_id → transientSubscription registered, registry called once', async () => {
  const h = makeInputApi({ agent: makeAgent('a-1', { status: 'idle' }) });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', confirm: true, sender_agent_id: 'sup-x' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(res.body.transientSubscription.registered, true, 'response surfaces registered:true');
    assert.equal(h.calls.register.length, 1, 'registry called exactly once');
    assert.deepEqual(h.calls.register[0], { targetAgentId: 'a-1', subscriberAgentId: 'sup-x' });
  } finally { h.cleanup(); }
});

test('16. 409 (target working) send → throws 409, registry NEVER called', async () => {
  const h = makeInputApi({ agent: makeAgent('a-1', { status: 'working' }) });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', confirm: true, sender_agent_id: 'sup-x' });
    assert.equal(res.status, 409, `expected 409; got ${res.status}`);
    assert.equal(h.calls.register.length, 0, 'no registration on a 409-gated send');
  } finally { h.cleanup(); }
});

test('17. SubmitNotConfirmedError → 502 and cancelTransientTurnSubscriptionsForPair called once', async () => {
  const err = Object.assign(new Error('never started'), { name: 'SubmitNotConfirmedError' });
  const h = makeInputApi({ agent: makeAgent('a-1', { status: 'idle' }), confirmedThrows: err });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', confirm: true, sender_agent_id: 'sup-x' });
    assert.equal(res.status, 502, `expected 502; got ${res.status}`);
    assert.equal(h.calls.register.length, 1, 'subscription was registered before the throw');
    assert.equal(h.calls.cancel.length, 1, 'subscription cancelled on the throw');
    assert.deepEqual(h.calls.cancel[0], { targetAgentId: 'a-1', subscriberAgentId: 'sup-x' });
  } finally { h.cleanup(); }
});

test('18. submit:false body → registry not called; transientSubscription.registered false', async () => {
  const h = makeInputApi({ agent: makeAgent('a-1', { status: 'idle' }) });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', submit: false, sender_agent_id: 'sup-x' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.calls.register.length, 0, 'submit:false does not subscribe');
    assert.equal(res.body.transientSubscription.registered, false);
  } finally { h.cleanup(); }
});

test('19. no sender_agent_id → registry not called', async () => {
  const h = makeInputApi({ agent: makeAgent('a-1', { status: 'idle' }) });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', confirm: true });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.calls.register.length, 0, 'no sender id → no subscription');
    assert.equal(res.body.transientSubscription.registered, false);
  } finally { h.cleanup(); }
});

test('20. registry returns not-privileged → response surfaces it verbatim (pass-through)', async () => {
  const h = makeInputApi({ agent: makeAgent('a-1', { status: 'idle' }), registerResult: { registered: false, reason: 'not-privileged' } });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', confirm: true, sender_agent_id: 'plain' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(h.calls.register.length, 1, 'registry consulted (gate lives there)');
    assert.equal(res.body.transientSubscription.registered, false);
    assert.equal(res.body.transientSubscription.reason, 'not-privileged');
  } finally { h.cleanup(); }
});

test('17b. unconfirmed RESULT (not a throw) returns normally and KEEPS the subscription', async () => {
  const h = makeInputApi({
    agent: makeAgent('a-1', { status: 'idle' }),
    confirmedResult: { delivered: true, confirmed: false, mode: 'unconfirmed' },
  });
  try {
    const res = await callRoute(h.api, 'POST', '/api/agents/a-1/input', { text: 'hi', confirm: true, sender_agent_id: 'sup-x' });
    assert.equal(res.status, 200, `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.equal(res.body.confirmed, false, 'result is unconfirmed');
    assert.equal(res.body.transientSubscription.registered, true, 'subscription kept on an unconfirmed result');
    assert.equal(h.calls.cancel.length, 0, 'unconfirmed result does NOT cancel (start-watchdog handles it)');
    assert.equal(h.calls.register.length, 1);
  } finally { h.cleanup(); }
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
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
})();
