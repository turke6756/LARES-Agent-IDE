// Baseline tests for EventBridge — covers BR-01 through BR-10 from the
// agent-lifecycle hardening plan §2.7, plus BR-02b (P1B-01: runner-exit
// cooldown bypass). BR-04 is the HEAD-baseline variant: drain does not
// re-check `isAttached` (drain-on-detach is a deferred ticket).
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/event-bridge.test.js

import assert from 'node:assert/strict';
import { EventBridge } from './event-bridge';
import {
  makeFakeBridgeDeps,
  makeAgent,
  flushMicrotasks,
} from './test-helpers/fake-bridge-deps';
import {
  SUPERVISOR_EVENT_COOLDOWN_MS,
  SUPERVISOR_USER_TYPING_QUIESCENT_MS,
  TRANSIENT_SUB_TTL_MS,
  TRANSIENT_SUB_PENDING_START_TIMEOUT_MS,
  TRANSIENT_SUB_MAX_PER_TARGET,
} from '../../shared/constants';
import type { ContextStats } from '../../shared/types';
import type {
  AssistantTextEvent,
  AssistantTextPatchEvent,
  ChatEventBatch,
  TaskStartedEvent,
  ToolUseEvent,
  UserTextEvent,
} from '../../shared/session-events';

function statsAt(agentId: string, pct: number, turn: number): ContextStats {
  return {
    agentId,
    sessionId: 's-1',
    model: 'sonnet',
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalOutputTokens: 0,
    totalContextTokens: 1_000 * pct,
    contextWindowMax: 100_000,
    contextPercentage: pct,
    turnCount: turn,
    lastUpdatedAt: '2026-05-16T00:00:00Z',
  };
}

async function BR_01_happyPath(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'last line of output\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 1, 'BR-01: sendInput called exactly once');
  assert.equal(f.sendInputCalls[0].agentId, supervisor.id);
  assert.ok(
    f.sendInputCalls[0].text.includes('[DASHBOARD EVENT] Agent status changed'),
    'BR-01: payload contains status-change header',
  );
  assert.equal(f.auditEvents.length, 1);
  assert.equal(f.auditEvents[0].type, 'supervisor_event');
  console.log('  BR-01 ✓ worker idle happy path');
}

async function BR_02_crashViaRunnerExit(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working', lastExitCode: 137 });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'crashed',
    fromStatus: 'working',
    source: 'runner-exit',
  });

  assert.equal(f.sendInputCalls.length, 1, 'BR-02: runner-exit reaches the bridge');
  assert.ok(
    f.sendInputCalls[0].text.includes('Exit code: 137'),
    'BR-02: payload renders the exit code line',
  );
  console.log('  BR-02 ✓ runner-exit crash payload');
}

async function BR_02b_runnerExitBypassesCooldown(): Promise<void> {
  // P1B-01: two runner-exit events for the same agent within the 10s cooldown
  // window must BOTH deliver. A crash isn't a flicker (D-06). Monitor-source
  // duplicates inside 10s are still dropped — that's BR-05.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working', lastExitCode: 137 });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'crashed',
    fromStatus: 'working',
    source: 'runner-exit',
  });
  assert.equal(f.sendInputCalls.length, 1, 'BR-02b: first runner-exit delivered');

  // Move the clock forward but stay inside the 10s cooldown window.
  f.setNow(f.getNow() + 5_000);
  // Simulate a follow-up exit event (e.g. restart attempt also crashed).
  worker.status = 'working';
  worker.lastExitCode = 1;
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'crashed',
    fromStatus: 'working',
    source: 'runner-exit',
  });

  assert.equal(f.sendInputCalls.length, 2, 'BR-02b: second runner-exit also delivered (cooldown bypassed)');
  assert.ok(
    f.sendInputCalls[1].text.includes('Exit code: 1'),
    'BR-02b: second payload renders the new exit code',
  );
  console.log('  BR-02b ✓ runner-exit bypasses 10s cooldown');
}

async function BR_03_queueAndConsolidate(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'working' });
  const w1 = makeAgent('w-1', { status: 'working' });
  const w2 = makeAgent('w-2', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(w1.id, w1);
  f.agents.set(w2.id, w2);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: w1.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: w2.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 0, 'BR-03: nothing sent while supervisor is working');
  assert.equal(bridge.getQueueSnapshot().length, 2, 'BR-03: both events queued');
  assert.equal(f.scheduler.pendingCount(), 1, 'BR-03: a single drain task is scheduled');

  supervisor.status = 'idle';
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 1, 'BR-03: drain produced one consolidated send');
  assert.ok(
    f.sendInputCalls[0].text.includes('2 events occurred'),
    'BR-03: consolidated header present',
  );
  assert.equal(f.auditEvents.length, 1);
  assert.equal(f.auditEvents[0].type, 'supervisor_event_batch');
  console.log('  BR-03 ✓ queue + consolidated drain');
}

async function BR_04_attachedQueueDrains(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // Supervisor idle but user is attached — bridge queues instead of injecting.
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
    isAttached: true,
  });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 0, 'BR-04: no immediate send to attached supervisor');
  assert.equal(bridge.getQueueSnapshot().length, 1, 'BR-04: event queued');
  assert.equal(f.scheduler.pendingCount(), 1, 'BR-04: drain scheduled');

  // HEAD baseline: drain does NOT re-check `isAttached`. When the timer
  // fires while supervisor is still idle, it dumps the queue.
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 1, 'BR-04: drain delivered (HEAD baseline — no isAttached re-check)');
  console.log('  BR-04 ✓ attached supervisor queue + timer drain (HEAD baseline)');
}

async function BR_05_cooldownDropsDup(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 1, 'BR-05: first event delivered');

  f.setNow(f.getNow() + 5_000); // still inside the 10s cooldown
  await bridge.onStatusChanged({ agentId: worker.id, status: 'crashed', fromStatus: 'idle', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 1, 'BR-05: second event suppressed by cooldown');
  console.log('  BR-05 ✓ per-agent cooldown drops duplicates inside 10s');
}

async function BR_06_cooldownClearsAfter10s(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  f.setNow(f.getNow() + SUPERVISOR_EVENT_COOLDOWN_MS + 1);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'crashed', fromStatus: 'idle', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 2, 'BR-06: second event delivered once cooldown has elapsed');
  console.log('  BR-06 ✓ cooldown clears after 10s');
}

async function BR_07_contextThresholdOrdering(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  // Noise reduction: the tiers collapsed from [80, 90, 95] to a single 95%
  // advisory. Everything under it is silent — that is the whole point.
  bridge.onContextStatsChanged(statsAt(worker.id, 80, 1));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 0, 'BR-07: 80% no longer notifies (sub-threshold)');

  bridge.onContextStatsChanged(statsAt(worker.id, 90, 2));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 0, 'BR-07: 90% no longer notifies (sub-threshold)');

  bridge.onContextStatsChanged(statsAt(worker.id, 95, 3));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 1, 'BR-07: crossing 95 fires once');

  bridge.onContextStatsChanged(statsAt(worker.id, 98, 4));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 1, 'BR-07: still in the 95 bucket — no repeat');
  console.log('  BR-07 ✓ single 95% tier: 80/90 silent, 95 fires once, 98 does not repeat');
}

async function BR_08_consolidatedMixesKinds(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'working' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.onContextStatsChanged(statsAt(worker.id, 95, 1));
  await flushMicrotasks();
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 0, 'BR-08: nothing delivered while supervisor is working');
  assert.equal(bridge.getQueueSnapshot().length, 2, 'BR-08: both event kinds queued');

  supervisor.status = 'idle';
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 1, 'BR-08: drain emitted one consolidated payload');
  const payload = f.sendInputCalls[0].text;
  assert.ok(payload.includes('context at 95%'), 'BR-08: context_threshold rendered');
  assert.ok(/working → idle/.test(payload), 'BR-08: status_change rendered');
  console.log('  BR-08 ✓ consolidated batch mixes status + context');
}

async function BR_09_sendInputRejects(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  f.setSendInputError(new Error('pty dead'));

  // The bridge must not propagate the rejection — it catches and logs.
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 1, 'BR-09: sendInput attempt was made');
  assert.equal(f.sendInputCalls[0].resolved, false, 'BR-09: send recorded as rejected');
  // HEAD behavior: addAuditEvent runs only after a successful sendInput.
  assert.equal(f.auditEvents.length, 0, 'BR-09: no audit event when send fails');

  // Bridge stays usable for the next event from a different worker.
  const other = makeAgent('w-2', { status: 'working' });
  f.agents.set(other.id, other);
  await bridge.onStatusChanged({ agentId: other.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 2, 'BR-09: bridge still routes subsequent events');
  assert.equal(f.sendInputCalls[1].resolved, true);
  console.log('  BR-09 ✓ sendInput rejection is swallowed and logged');
}

async function BR_10_multiSupervisorIsolation(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supA = makeAgent('sup-A', { workspaceId: 'ws-A', isSupervisor: true, isSupervised: false, status: 'idle' });
  const supB = makeAgent('sup-B', { workspaceId: 'ws-B', isSupervisor: true, isSupervised: false, status: 'idle' });
  const workerA = makeAgent('wkA', { workspaceId: 'ws-A', status: 'working', title: 'Worker A' });
  const workerB = makeAgent('wkB', { workspaceId: 'ws-B', status: 'working', title: 'Worker B' });
  f.agents.set(supA.id, supA);
  f.agents.set(supB.id, supB);
  f.agents.set(workerA.id, workerA);
  f.agents.set(workerB.id, workerB);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: workerA.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: workerB.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 2, 'BR-10: each supervisor received exactly one send');
  const aCall = f.sendInputCalls.find(c => c.agentId === supA.id);
  const bCall = f.sendInputCalls.find(c => c.agentId === supB.id);
  assert.ok(aCall, 'BR-10: supervisor A received a send');
  assert.ok(bCall, 'BR-10: supervisor B received a send');
  assert.ok(aCall!.text.includes('Worker A'), 'BR-10: supA payload mentions Worker A');
  assert.ok(!aCall!.text.includes('Worker B'), 'BR-10: supA payload does NOT mention Worker B');
  assert.ok(bCall!.text.includes('Worker B'), 'BR-10: supB payload mentions Worker B');
  assert.ok(!bCall!.text.includes('Worker A'), 'BR-10: supB payload does NOT mention Worker A');
  console.log('  BR-10 ✓ multi-supervisor workspace isolation');
}

async function BR_QUEUE_recipientScoped(): Promise<void> {
  // Increment 0 regression: two independently-busy supervisors must NOT share
  // one queue/drain handle. Each owns a distinct worker in its own workspace;
  // a status event for each must land in its own recipient queue only, and
  // draining one must not touch the other.
  const f = makeFakeBridgeDeps();
  const supA = makeAgent('sup-A', { workspaceId: 'ws-A', isSupervisor: true, isSupervised: false, status: 'working' });
  const supB = makeAgent('sup-B', { workspaceId: 'ws-B', isSupervisor: true, isSupervised: false, status: 'working' });
  const workerA = makeAgent('wkA', { workspaceId: 'ws-A', status: 'working', title: 'Worker A' });
  const workerB = makeAgent('wkB', { workspaceId: 'ws-B', status: 'working', title: 'Worker B' });
  f.agents.set(supA.id, supA);
  f.agents.set(supB.id, supB);
  f.agents.set(workerA.id, workerA);
  f.agents.set(workerB.id, workerB);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: workerA.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: workerB.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 0, 'BR_QUEUE: nothing sent while both supervisors busy');
  assert.equal(bridge.getQueueSnapshot(supA.id).length, 1, 'BR_QUEUE: supA queue holds exactly one event');
  assert.equal(bridge.getQueueSnapshot(supB.id).length, 1, 'BR_QUEUE: supB queue holds exactly one event');
  assert.equal(bridge.getQueueSnapshot(supA.id)[0].agentId, workerA.id, 'BR_QUEUE: supA queue holds only its own worker event');
  assert.equal(bridge.getQueueSnapshot(supB.id)[0].agentId, workerB.id, 'BR_QUEUE: supB queue holds only its own worker event');

  // Flip supA idle and drain it; supB's queue must be untouched.
  supA.status = 'idle';
  await bridge.drainPendingFor(supA.id);

  assert.equal(f.sendInputCalls.length, 1, 'BR_QUEUE: supA drained exactly its event');
  assert.equal(f.sendInputCalls[0].agentId, supA.id);
  assert.ok(f.sendInputCalls[0].text.includes('Worker A'), 'BR_QUEUE: supA payload mentions Worker A');
  assert.equal(bridge.getQueueSnapshot(supA.id).length, 0, 'BR_QUEUE: supA queue emptied after drain');
  assert.equal(bridge.getQueueSnapshot(supB.id).length, 1, 'BR_QUEUE: supB queue untouched by supA drain');
  console.log('  BR_QUEUE ✓ recipient-scoped queue + drain isolation');
}

// ── M2A: onChatEvents dispatch table (BR-19 + supporting coverage) ──

function batchFor(agentId: string, events: ChatEventBatch['events']): ChatEventBatch {
  return { agentId, events };
}

function assistantText(agentId: string, overrides: Partial<AssistantTextEvent> = {}): AssistantTextEvent {
  return {
    type: 'assistant-text',
    uuid: `a:${Math.random()}`,
    timestamp: new Date().toISOString(),
    agentId,
    text: 'hi',
    ...overrides,
  };
}

async function onChatEvents_codexTurnComplete(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // Unsupervised: the chat stream is the working/idle source for this lane.
  // Worker-lane (supervised/isWorker) claude/codex derive working/idle from
  // hooks only (event-bridge.ts:193), so the chat-stream dispatch is exercised
  // here on the lane that actually uses it.
  const codex = makeAgent('cx-1', { provider: 'codex', status: 'working', isSupervised: false });
  f.agents.set(codex.id, codex);
  const bridge = new EventBridge(f.deps);

  bridge.onChatEvents(batchFor(codex.id, [
    assistantText(codex.id, { turnComplete: true }),
  ]));

  assert.equal(f.statusForceCalls.length, 1);
  assert.equal(f.statusForceCalls[0].method, 'forceIdle');
  assert.equal(f.statusForceCalls[0].agentId, codex.id);
  assert.equal(f.statusForceCalls[0].source, 'turnComplete');
  console.log('  onChatEvents ✓ codex assistant-text+turnComplete → forceIdle(turnComplete)');
}

async function onChatEvents_dispatchTable(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // Unsupervised lane — see onChatEvents_codexTurnComplete. The event→force*
  // dispatch table is bypassed for worker-lane claude/codex (hooks own status).
  const claude = makeAgent('cl-1', { provider: 'claude', status: 'working', isSupervised: false });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  const userEv: UserTextEvent = {
    type: 'user-text', uuid: 'u', timestamp: '', agentId: claude.id, text: 'go',
  };
  const toolEv: ToolUseEvent = {
    type: 'tool-use', uuid: 't', timestamp: '', agentId: claude.id,
    toolUseId: 'tu1', toolName: 'Read', input: {},
  };
  const tsEv: TaskStartedEvent = {
    type: 'task-started', uuid: 'ts', timestamp: '', agentId: claude.id,
  };
  const stopReasonEv = assistantText(claude.id, { stopReason: 'tool_use' });
  const patchEv: AssistantTextPatchEvent = {
    type: 'assistant-text-patch',
    uuid: 'atp',
    timestamp: '',
    agentId: claude.id,
    targetUuid: 'a:prior',
    turnComplete: true,
    stopReason: 'task_complete',
  };

  bridge.onChatEvents(batchFor(claude.id, [
    userEv, toolEv, tsEv, stopReasonEv, patchEv,
  ]));

  // user-text is NO LONGER status-bearing (hooks are the sole turn-start
  // authority; the dashboard's own send-echo produces a user-text event and
  // must never manufacture a 'working' flip). So the 5 events above yield only
  // 4 force calls — user-text drops out.
  assert.equal(f.statusForceCalls.length, 4);
  // BUG-09 §3.3 — assistant-text without turnComplete now refreshes via the
  // generic `assistant-text` source (was `turnContinues`, conditioned on
  // stopReason === 'tool_use'). All forceWorking calls now carry typed opts.
  assert.deepEqual(
    f.statusForceCalls.map(c => `${c.method}:${c.source ?? c.kind}`),
    [
      'forceWorking:tool-use',
      'forceWorking:task-started',
      'forceWorking:assistant-text',
      'forceIdle:turnComplete',
    ],
  );
  // Spot-check that tool-use carries toolUseId on its opts.
  const toolCall = f.statusForceCalls.find(c => c.source === 'tool-use')!;
  assert.equal(toolCall.workingOpts?.toolUseId, 'tu1',
    'BUG-09: tool-use forceWorking propagates toolUseId for latch pairing');
  assert.equal(toolCall.workingOpts?.ttlClass, 'tool-pending');
  console.log('  onChatEvents ✓ dispatch table maps each event type per §2.1');
}

// ── BUG-09 §3.8 — initialLoad replay suppression ─────────────────────

async function onChatEvents_initialLoadSuppressesForceCalls(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const claude = makeAgent('cl-il', { provider: 'claude', status: 'idle' });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  const toolEv: ToolUseEvent = {
    type: 'tool-use', uuid: 't', timestamp: '', agentId: claude.id,
    toolUseId: 'tu-replay', toolName: 'Read', input: {},
  };
  const userEv: UserTextEvent = {
    type: 'user-text', uuid: 'u', timestamp: '', agentId: claude.id, text: 'old',
  };

  // BUG-09 §3.8 — initial-load batch (disk replay) must NOT touch the latch.
  bridge.onChatEvents({
    agentId: claude.id,
    events: [toolEv, userEv],
    initialLoad: true,
  });

  assert.equal(f.statusForceCalls.length, 0,
    'BUG-09 §3.8: initialLoad=true suppresses all force* calls');
  console.log('  onChatEvents ✓ initialLoad batch suppresses force* (BUG-09 §3.8)');
}

async function onChatEvents_secondBatchIsNotInitialLoad(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // Unsupervised lane — worker-lane claude/codex skip the chat-stream dispatch.
  const claude = makeAgent('cl-il2', { provider: 'claude', status: 'idle', isSupervised: false });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  // First batch: explicit initialLoad=true → suppressed.
  bridge.onChatEvents({
    agentId: claude.id,
    events: [{ type: 'tool-use', uuid: 't1', timestamp: '', agentId: claude.id,
              toolUseId: 'tu-old', toolName: 'Read', input: {} }],
    initialLoad: true,
  });
  assert.equal(f.statusForceCalls.length, 0);

  // Second batch: no initialLoad flag → real-time, drives the latch.
  bridge.onChatEvents({
    agentId: claude.id,
    events: [{ type: 'tool-use', uuid: 't2', timestamp: '', agentId: claude.id,
              toolUseId: 'tu-live', toolName: 'Read', input: {} }],
  });
  assert.equal(f.statusForceCalls.length, 1,
    'second non-initial batch drives the latch normally');
  assert.equal(f.statusForceCalls[0].method, 'forceWorking');
  assert.equal(f.statusForceCalls[0].workingOpts?.toolUseId, 'tu-live');
  console.log('  onChatEvents ✓ post-initial batches behave normally (BUG-09 §3.8)');
}

// ── M3: P2-03 waiting_for_input wiring (BR-13, BR-15, BR-20) ────────

async function BR_13_endsWithQuestionNoLongerFiresWaitingForHookWorker(): Promise<void> {
  // New rule: `waiting` means a real Notification hook ONLY. A hook-backed
  // worker (claude/codex) that ends its turn with a question is just a normal
  // turn end — the Stop hook drives it to idle and the chat-stream writes no
  // status. So no force* call fires here at all.
  const f = makeFakeBridgeDeps();
  const worker = makeAgent('w-q1', { provider: 'claude', status: 'working' });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.onChatEvents(batchFor(worker.id, [
    assistantText(worker.id, {
      text: 'Long preamble. Did that resolve it?',
      turnComplete: true,
      endsWithQuestion: true,
    }),
  ]));

  assert.equal(f.statusForceCalls.length, 0,
    'BR-13: endsWithQuestion fires no force* for a hook-backed worker (status is hook-owned)');
  console.log('  BR-13 ✓ endsWithQuestion no longer maps to waiting (hook-owned worker)');
}

async function BR_15_notifyUserInputClearsLatchOnWaiting(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // Unsupervised so the paste-race-fix gate does not short-circuit.
  const worker = makeAgent('w-w1', { provider: 'claude', status: 'waiting', isSupervised: false });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.notifyUserInputDelivered(worker.id);

  assert.equal(f.statusForceCalls.length, 1, 'BR-15: one force call');
  assert.equal(f.statusForceCalls[0].method, 'forceWorking');
  assert.equal(f.statusForceCalls[0].agentId, worker.id);
  assert.equal(f.statusForceCalls[0].source, 'user-input');
  console.log('  BR-15 ✓ sendInput on waiting agent clears latch via forceWorking');
}

async function BR_15_notifyUserInputNoopWhenNotWaiting(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const worker = makeAgent('w-w2', { provider: 'claude', status: 'working', isSupervised: false });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.notifyUserInputDelivered(worker.id);
  assert.equal(f.statusForceCalls.length, 0, 'BR-15: no-op when target is not waiting');
  console.log('  BR-15 ✓ notifyUserInputDelivered is a no-op outside waiting');
}

async function BR_15_notifyUserInputSkippedForSupervised(): Promise<void> {
  // Paste-race fix (BUG-10): supervised workers' idle→working is owned
  // exclusively by the UserPromptSubmit hook. notifyUserInputDelivered must
  // NOT seed a working latch even when the agent is currently waiting.
  const f = makeFakeBridgeDeps();
  const worker = makeAgent('w-w3', { provider: 'claude', status: 'waiting', isSupervised: true });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.notifyUserInputDelivered(worker.id);
  assert.equal(f.statusForceCalls.length, 0,
    'supervised + waiting: forceWorking must be skipped (start hook owns the transition)');
  console.log('  BR-15 ✓ supervised → notifyUserInputDelivered is a no-op');
}

async function BR_20_waitingToWorkingIsSuppressed(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-r1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  // First: simulate the waiting transition itself — the supervisor SHOULD be notified.
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'waiting',
    fromStatus: 'working',
    source: 'monitor',
    waitingKind: 'notification',
    waitingExcerpt: 'Are you sure?',
  });
  assert.equal(f.sendInputCalls.length, 1, 'BR-20: waiting transition fires');
  assert.ok(
    f.sendInputCalls[0].text.includes('[DASHBOARD EVENT] Agent waiting for input'),
    'BR-20: waiting payload renders the dedicated header',
  );
  assert.ok(
    f.sendInputCalls[0].text.includes('Waiting kind: notification'),
    'BR-20: waiting kind line present',
  );
  assert.ok(
    f.sendInputCalls[0].text.includes('Are you sure?'),
    'BR-20: excerpt rendered',
  );

  // Bump time past the per-agent cooldown so the next event would otherwise pass.
  f.setNow(f.getNow() + SUPERVISOR_EVENT_COOLDOWN_MS + 100);

  // Then: waiting → working (user answered). MUST be suppressed.
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'working',
    fromStatus: 'waiting',
    source: 'monitor',
  });
  assert.equal(f.sendInputCalls.length, 1,
    'BR-20: waiting → working does NOT fire a notification (filtered)');
  console.log('  BR-20 ✓ waiting → working transition is filtered');
}

// ── launching → idle suppression ────────────────────────────────────────

async function launchingToIdle_isSuppressed(): Promise<void> {
  // launching → idle is launch-complete noise (agent booted, awaiting its
  // first instruction) — the supervisor must NOT be notified. A later
  // working → idle from the same agent is a real turn-end and must still
  // deliver, proving the guard is transition-scoped, not status-scoped.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-l1', { status: 'launching' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'launching',
    source: 'monitor',
  });
  assert.equal(f.sendInputCalls.length, 0,
    'launching → idle must be suppressed (pure launch-complete noise)');
  assert.equal(bridge.getQueueSnapshot().length, 0,
    'launching → idle must not even be queued');

  // The suppressed event must not have armed the per-agent cooldown either —
  // a real working → idle shortly after launch still delivers.
  worker.status = 'working';
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });
  assert.equal(f.sendInputCalls.length, 1,
    'working → idle from the same agent still fires');
  assert.ok(
    f.sendInputCalls[0].text.includes('Status: working → idle'),
    'delivered payload renders the working → idle transition',
  );
  console.log('  launching→idle ✓ suppressed; working→idle still fires');
}

async function launchingToOtherStatuses_stillFire(): Promise<void> {
  // The guard is exactly (launching, idle) — launching → crashed (boot
  // failure) and launching → waiting (trust prompt at startup) are real
  // events the supervisor must hear about.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-l2', { status: 'launching', lastExitCode: 127 });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'crashed',
    fromStatus: 'launching',
    source: 'runner-exit',
  });
  assert.equal(f.sendInputCalls.length, 1,
    'launching → crashed still fires (boot failure is not noise)');

  const worker2 = makeAgent('w-l3', { status: 'launching' });
  f.agents.set(worker2.id, worker2);
  await bridge.onStatusChanged({
    agentId: worker2.id,
    status: 'waiting',
    fromStatus: 'launching',
    source: 'monitor',
    waitingKind: 'y-n',
    waitingExcerpt: 'Trust this folder?',
  });
  assert.equal(f.sendInputCalls.length, 2,
    'launching → waiting still fires (startup prompt needs the supervisor)');
  console.log('  launching→idle ✓ guard is transition-exact (crashed/waiting from launching still fire)');
}

async function done_isNeverNotified(): Promise<void> {
  // 'done' is no longer a trigger status AT ALL. A clean exit (code 0) is never
  // the actionable signal: working → idle already delivered the worker's
  // hand-off, and the process exiting afterwards adds nothing to react to. This
  // used to suppress only (idle → done), which still left working → done and
  // every stop_agent teardown waking the owner for a non-event.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-d1', { status: 'idle' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'done',
    fromStatus: 'idle',
    source: 'monitor',
  });
  // working → done (a worker that exits cleanly mid-turn) is equally silent —
  // the rule is status-scoped now, not transition-scoped.
  const worker2 = makeAgent('w-d2', { status: 'working' });
  f.agents.set(worker2.id, worker2);
  await bridge.onStatusChanged({
    agentId: worker2.id,
    status: 'done',
    fromStatus: 'working',
    source: 'runner-exit',
  });
  assert.equal(f.sendInputCalls.length, 0,
    'no → done transition may notify (idle → done AND working → done)');
  assert.equal(bridge.getQueueSnapshot().length, 0,
    '→ done must not even be queued');

  // A non-clean exit is 'crashed', not 'done' — that one still delivers, which
  // is what keeps this a noise cut rather than a signal loss.
  const worker3 = makeAgent('w-d3', { status: 'working' });
  f.agents.set(worker3.id, worker3);
  await bridge.onStatusChanged({
    agentId: worker3.id,
    status: 'crashed',
    fromStatus: 'working',
    source: 'runner-exit',
  });
  assert.equal(f.sendInputCalls.length, 1,
    'working → crashed still fires (real failure, must reach the owner)');
  console.log('  done ✓ never notified (any transition); crashed still fires');
}

// ── BUG-11: user-typing deferral ────────────────────────────────────────

async function BR_11a_deliverDefersWhileUserTyping(): Promise<void> {
  // Supervisor is idle and NOT attached. Without BUG-11 this would send
  // immediately. With BUG-11, a recent `writeToAgent` stamp must queue
  // instead so the event doesn't collide with the user's in-progress
  // PTY input buffer.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
    isAttached: false,
  });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  // Simulate the user typing one character "now" — well inside the
  // SUPERVISOR_USER_TYPING_QUIESCENT_MS window.
  f.setLastUserPtyWriteAt(supervisor.id, f.getNow());

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(
    f.sendInputCalls.length,
    0,
    'BR-11a: no immediate send while the user is typing into the supervisor PTY',
  );
  assert.equal(bridge.getQueueSnapshot().length, 1, 'BR-11a: event queued');
  assert.equal(f.scheduler.pendingCount(), 1, 'BR-11a: drain scheduled');
  console.log('  BR-11a ✓ deliver() defers on recent user PTY-write (BUG-11)');
}

async function BR_11b_drainRedefersWhileUserStillTyping(): Promise<void> {
  // Queue an event with the user typing, then advance the clock so the
  // drain timer would fire — but the user is STILL typing (write timestamp
  // updated to the new now). drain() must re-arm, not ship.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
    isAttached: false,
  });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  f.setLastUserPtyWriteAt(supervisor.id, f.getNow());
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });
  assert.equal(bridge.getQueueSnapshot().length, 1);
  assert.equal(f.scheduler.pendingCount(), 1);

  // Time passes; user has continued typing the whole time (stamp is fresh).
  f.setNow(f.getNow() + 20_000);
  f.setLastUserPtyWriteAt(supervisor.id, f.getNow());

  await bridge.drainPendingFor(supervisor.id);

  assert.equal(
    f.sendInputCalls.length,
    0,
    'BR-11b: drain refuses to ship while the user is still typing',
  );
  assert.equal(bridge.getQueueSnapshot().length, 1, 'BR-11b: event remains queued');
  assert.equal(
    f.scheduler.pendingCount(),
    1,
    'BR-11b: drain re-armed for a later attempt',
  );
  console.log('  BR-11b ✓ drain() re-arms while user still typing (BUG-11)');
}

async function BR_11c_drainShipsOnceUserQuiet(): Promise<void> {
  // Same setup as BR-11b, but the user has stopped typing long enough that
  // the quiescent window has elapsed. drain() must ship.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
    isAttached: false,
  });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  const typedAt = f.getNow();
  f.setLastUserPtyWriteAt(supervisor.id, typedAt);
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });
  assert.equal(bridge.getQueueSnapshot().length, 1);

  // User stopped typing; advance the clock past the quiescent window.
  f.setNow(typedAt + SUPERVISOR_USER_TYPING_QUIESCENT_MS + 1);

  await bridge.drainPendingFor(supervisor.id);

  assert.equal(
    f.sendInputCalls.length,
    1,
    'BR-11c: drain ships once the user has been quiet long enough',
  );
  console.log('  BR-11c ✓ drain() flushes once user typing has quiesced (BUG-11)');
}

async function BR_11d_idleSupervisorNoTypingShipsImmediately(): Promise<void> {
  // Non-regression for BR-01: when there's no user-typing signal at all
  // (getLastUserPtyWriteAt returns undefined), deliver() must still go
  // through the immediate-send path. The BUG-11 gate is strictly additive.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
    isAttached: false,
  });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  // No setLastUserPtyWriteAt — user has never typed.
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 1, 'BR-11d: idle + no typing → immediate send');
  console.log('  BR-11d ✓ idle supervisor with no typing signal still auto-submits (BUG-11 non-regression)');
}

// ── BUG-18 Change 1 + Change 3 — event-bridge wiring ───────────────────

async function BUG_18_thinkingForceWorkingUsesThinkingPending(): Promise<void> {
  // Change 1: the `thinking` chat event now refreshes the latch with
  // ttlClass='thinking-pending' (was 'model-pending'). Verify the bridge
  // passes the new class through and does NOT mark turnInFlight (only
  // tool-use/task-started/assistant-text do that — thinking is high-
  // cadence positive evidence but doesn't itself begin a turn).
  const f = makeFakeBridgeDeps();
  // Unsupervised lane: worker-lane claude/codex derive working/idle from hooks,
  // so the chat-stream dispatch under test is exercised on the unsupervised lane.
  const claude = makeAgent('cl-bug18-1', { provider: 'claude', status: 'working', isSupervised: false });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  bridge.onChatEvents(batchFor(claude.id, [
    { type: 'thinking', uuid: 'tk', timestamp: '', agentId: claude.id, text: '' },
  ]));

  assert.equal(f.statusForceCalls.length, 1);
  const call = f.statusForceCalls[0];
  assert.equal(call.method, 'forceWorking');
  assert.equal(call.workingOpts?.ttlClass, 'thinking-pending',
    'BUG-18 Change 1: thinking now refreshes with ttlClass=thinking-pending');
  assert.notEqual(call.workingOpts?.turnInFlight, true,
    'thinking event does not mark the turn in-flight by itself');
  console.log('  BUG-18 Change 1 ✓ thinking → forceWorking(ttlClass: thinking-pending)');
}

async function BUG_18_endToEndTurnInFlightSetAndCleared(): Promise<void> {
  // Change 3: across a representative turn — task-started → tool-use →
  // tool-result → assistant-text (turnComplete) — verify turnInFlight is
  // marked on the right events and that the terminal turnComplete fires
  // forceIdle (which clears the latch entirely in the real monitor).
  const f = makeFakeBridgeDeps();
  const claude = makeAgent('cl-bug18-2', { provider: 'claude', status: 'working', isSupervised: false });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  const taskStarted: TaskStartedEvent = {
    type: 'task-started', uuid: 'ts', timestamp: '', agentId: claude.id,
  };
  const toolUse: ToolUseEvent = {
    type: 'tool-use', uuid: 'tu', timestamp: '', agentId: claude.id,
    toolUseId: 'X', toolName: 'Read', input: {},
  };
  const toolResult = {
    type: 'tool-result' as const, uuid: 'tr', timestamp: '', agentId: claude.id,
    toolUseId: 'X', content: 'ok', truncated: false, isError: false,
  };
  const midText = assistantText(claude.id, { text: 'thinking out loud' });
  const finalText = assistantText(claude.id, {
    text: 'done', turnComplete: true,
  });

  bridge.onChatEvents(batchFor(claude.id, [
    taskStarted, toolUse, toolResult, midText, finalText,
  ]));

  const opts = (i: number) => f.statusForceCalls[i].workingOpts;
  assert.equal(f.statusForceCalls.length, 5,
    'one force call per event in the batch');

  // task-started: turnInFlight=true, model-pending
  assert.equal(f.statusForceCalls[0].source, 'task-started');
  assert.equal(opts(0)?.turnInFlight, true,
    'task-started marks the turn in-flight (Change 3)');
  assert.equal(opts(0)?.ttlClass, 'model-pending');

  // tool-use: turnInFlight=true, tool-pending, toolUseId pairing intact
  assert.equal(f.statusForceCalls[1].source, 'tool-use');
  assert.equal(opts(1)?.turnInFlight, true,
    'tool-use marks the turn in-flight (Change 3)');
  assert.equal(opts(1)?.ttlClass, 'tool-pending');
  assert.equal(opts(1)?.toolUseId, 'X');

  // tool-result: does NOT set turnInFlight (sticky-true in the real monitor
  // handles preservation; the bridge omits the flag on tool-result).
  assert.equal(f.statusForceCalls[2].source, 'tool-result');
  assert.notEqual(opts(2)?.turnInFlight, true,
    'tool-result does not redundantly set turnInFlight; monitor stickiness handles it');
  assert.equal(opts(2)?.resolvedToolUseId, 'X');

  // non-terminal assistant-text: turnInFlight=true, model-pending
  assert.equal(f.statusForceCalls[3].source, 'assistant-text');
  assert.equal(opts(3)?.turnInFlight, true,
    'non-terminal assistant-text marks the turn in-flight (Change 3)');
  assert.equal(opts(3)?.ttlClass, 'model-pending');

  // assistant-text + turnComplete → forceIdle('turnComplete'); the real
  // monitor's forceIdle overwrites the latch with idle, clearing
  // turnInFlight (test verified in status-monitor.test.ts).
  assert.equal(f.statusForceCalls[4].method, 'forceIdle');
  assert.equal(f.statusForceCalls[4].source, 'turnComplete');
  console.log('  BUG-18 Change 3 ✓ end-to-end turn: turnInFlight set on task-started/tool-use/assistant-text, cleared by turnComplete');
}

async function userTextIsNotStatusBearing(): Promise<void> {
  // Hooks are the sole authority for turn-start (owner decision 2026-07-27).
  // A user-text chat event — indistinguishable from the dashboard's own echo
  // of a just-sent prompt — must NEVER write status on ANY provider. It used
  // to forceWorking('user-turn'); that false turn-start is the GroupThink
  // stall root cause. Verify the bridge now emits ZERO force calls for a lone
  // user-text event, even on a hookless-fallthrough lane (unsupervised claude).
  const f = makeFakeBridgeDeps();
  const claude = makeAgent('cl-bug18-3', { provider: 'claude', status: 'working', isSupervised: false });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  const userEv: UserTextEvent = {
    type: 'user-text', uuid: 'u', timestamp: '', agentId: claude.id, text: 'go',
  };
  bridge.onChatEvents(batchFor(claude.id, [userEv]));

  assert.equal(f.statusForceCalls.length, 0,
    'user-text is not status-bearing — hooks are the sole turn-start authority');
  console.log('  status ✓ user-text writes no status (hooks own turn-start; send-echo cannot forge working)');
}

// ── BUG-22 Step 1: tmux_new_session_failed bridge wiring ───────────────

async function BUG_22_tmuxFailureDeliversWithDistinctHeader(): Promise<void> {
  // Supervised worker fails to launch under WSL. The runner emits
  // `tmuxNewSessionFailed`; the supervisor wires it into the bridge's
  // `onTmuxNewSessionFailed` method. The bridge must deliver the event to
  // the supervisor with the distinct dashboard header, not folded into
  // `Agent status changed`.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
  });
  const worker = makeAgent('w-1', { status: 'launching' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onTmuxNewSessionFailed({
    agent: worker,
    tmuxSessionName: 'cad__worker__w-1abcde',
    command: "cd '/wd' && claude --foo",
    tmuxExitCode: 1,
    tmuxStderr: 'bash: syntax error',
    tmuxCommand: "tmux new-session ...",
  });

  assert.equal(f.sendInputCalls.length, 1, 'BUG-22: failure event reaches supervisor exactly once');
  const sent = f.sendInputCalls[0];
  assert.equal(sent.agentId, supervisor.id);
  assert.ok(
    sent.text.startsWith('[DASHBOARD EVENT] WSL tmux session creation failed'),
    `BUG-22: must use the distinct header; got: ${sent.text.slice(0, 80)}`,
  );
  assert.match(sent.text, /cad__worker__w-1abcde/);
  assert.match(sent.text, /tmux exit code: 1/);
  assert.match(sent.text, /bash: syntax error/);

  // Audit row recorded so /events shows the failure independent of supervisor delivery state.
  assert.equal(f.auditEvents.length, 1);
  assert.equal(f.auditEvents[0].type, 'supervisor_event');
  const audit = JSON.parse(f.auditEvents[0].payload);
  assert.equal(audit.type, 'tmux_new_session_failed');
  assert.equal(audit.agentId, worker.id);
  console.log('  BUG-22 ✓ tmux_new_session_failed delivers to supervisor with distinct header');
}

async function BUG_22_tmuxFailureForSupervisorIsNoOpAtBridge(): Promise<void> {
  // A supervisor's own launch failure has no parent supervisor to notify.
  // The bridge must short-circuit cleanly (the addEvent audit + JSONL log
  // are handled by other layers). This guards against accidentally trying
  // to self-deliver, which would queue forever (the failing supervisor is
  // the would-be recipient).
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'launching',
  });
  f.agents.set(supervisor.id, supervisor);
  const bridge = new EventBridge(f.deps);

  await bridge.onTmuxNewSessionFailed({
    agent: supervisor,
    tmuxSessionName: 'cad__supervisor__sup-1',
    command: 'claude',
    tmuxExitCode: 1,
    tmuxStderr: 'fail',
    tmuxCommand: 'tmux',
  });

  assert.equal(f.sendInputCalls.length, 0, 'BUG-22: must not self-deliver a supervisor failure');
  assert.equal(f.auditEvents.length, 0, 'BUG-22: bridge does not write an audit row for the no-recipient case');
  console.log('  BUG-22 ✓ supervisor-side tmux failure is a no-op at the bridge');
}

async function BUG_22_tmuxFailureQueuesWhenSupervisorBusy(): Promise<void> {
  // Same shape as BR-03 for status_change events: when the supervisor is
  // working/launching, the failure event must queue and drain like any other
  // event — not be silently dropped.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', {
    isSupervisor: true,
    isSupervised: false,
    status: 'working',
  });
  const worker = makeAgent('w-1', { status: 'launching' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  await bridge.onTmuxNewSessionFailed({
    agent: worker,
    tmuxSessionName: 'cad__worker__w-1abcde',
    command: 'cmd',
    tmuxExitCode: 1,
    tmuxStderr: 'fail',
    tmuxCommand: 'tmux',
  });

  assert.equal(f.sendInputCalls.length, 0, 'BUG-22: queued, not delivered while supervisor busy');
  assert.equal(bridge.getQueueSnapshot().length, 1, 'BUG-22: event sitting in queue');

  supervisor.status = 'idle';
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 1, 'BUG-22: drained once supervisor goes idle');
  // Single-event drain uses buildEventPayload, so it retains the distinct
  // header rather than the consolidated digest format.
  assert.ok(
    f.sendInputCalls[0].text.startsWith('[DASHBOARD EVENT] WSL tmux session creation failed'),
    'BUG-22: drained payload keeps distinct header for single-event case',
  );
  console.log('  BUG-22 ✓ failure event queues + drains through normal path');
}

async function OWN_ownedNonSupervisedDeliversToOwner(): Promise<void> {
  // Agent-ownership primitive regression: an owned worker with isSupervised:false
  // is DROPPED under the old `!isSupervised` gate. The owner edge must route its
  // idle event directly to the launcher (a non-supervisor persona), with no
  // structural supervisor involved at all.
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', {
    isSupervised: false,
    isWorker: true,
    status: 'working',
    ownerAgentId: owner.id,
  });
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 1, 'OWN: owned non-supervised worker event delivers');
  assert.equal(f.sendInputCalls[0].agentId, owner.id, 'OWN: delivers to the OWNER, not a supervisor');
  console.log('  OWN ✓ owned isSupervised:false worker delivers to its owner');
}

async function OWN_terminalOwnerFallsBackToStructural(): Promise<void> {
  // When the explicit owner is terminal, the resolver backstops to the
  // structural workspace supervisor (operational visibility, not fanout).
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'done' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', ownerAgentId: owner.id });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 1, 'OWN: terminal-owner event still delivers (backstop)');
  assert.equal(f.sendInputCalls[0].agentId, supervisor.id, 'OWN: terminal owner falls back to structural supervisor');
  console.log('  OWN ✓ terminal owner falls back to structural supervisor');
}

async function OWN_busyOwnerQueuesDoesNotFallBack(): Promise<void> {
  // A busy (working) owner must QUEUE the event and drain when it frees — it
  // must NOT fall back to the structural supervisor. Falling back on a merely
  // busy owner would be the bug the spec explicitly guards against.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'working' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', ownerAgentId: owner.id });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 0, 'OWN: busy owner queues, does not deliver yet');
  assert.equal(bridge.getQueueSnapshot().length, 1, 'OWN: event sits in queue for the busy owner');

  owner.status = 'idle';
  await bridge.drainPendingFor(owner.id);
  assert.equal(f.sendInputCalls.length, 1, 'OWN: drains to the owner once it frees');
  assert.equal(f.sendInputCalls[0].agentId, owner.id, 'OWN: drained to the OWNER (never the structural supervisor)');
  console.log('  OWN ✓ busy owner queues + drains, never falls back');
}

// ── notifyOwner mute — decouple ownership from notification ──────────────────

async function MUTE_ownedMutedLiveOwnerDropped(): Promise<void> {
  // (a) An owned worker with notifyOwner:false whose explicit owner is LIVE:
  // the resolved recipient IS the owner → the mute fires → the event is dropped
  // entirely (not delivered, not even queued). Ownership is unchanged; only
  // notification is suppressed.
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', {
    isSupervised: false,
    isWorker: true,
    status: 'working',
    ownerAgentId: owner.id,
    notifyOwner: false,
  });
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 0, 'MUTE: muted worker with live owner delivers nothing');
  assert.equal(bridge.getQueueSnapshot().length, 0, 'MUTE: muted event is not even queued');
  console.log('  MUTE ✓ owned + notifyOwner:false + live owner → event dropped');
}

async function MUTE_defaultNotifyStillDelivers(): Promise<void> {
  // (b) The default (notifyOwner undefined ⇒ true) preserves ALL prior
  // behavior: the owner still receives the event. Asserted via a sibling worker
  // that is identical except for the (absent) mute flag.
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', {
    isSupervised: false,
    isWorker: true,
    status: 'working',
    ownerAgentId: owner.id,
    // notifyOwner omitted → defaults to notify.
  });
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });

  assert.equal(f.sendInputCalls.length, 1, 'MUTE: default-notify worker still delivers');
  assert.equal(f.sendInputCalls[0].agentId, owner.id, 'MUTE: default delivers to the owner (unchanged)');
  console.log('  MUTE ✓ default notifyOwner (undefined/true) → delivered to owner');
}

async function MUTE_terminalOwnerBackstopNotMuted(): Promise<void> {
  // (c) SUBTLETY: the mute fires ONLY when the recipient IS the explicit owner.
  // Here the muted worker's owner is terminal, so getOwnerForWorker falls back
  // to the structural supervisor — which is NOT the owner → NOT muted → the
  // backstop STILL delivers. A muted researcher whose owner dies still surfaces
  // its crash to the structural supervisor (safety net preserved).
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'idle' });
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'done' });
  const worker = makeAgent('w-1', {
    isSupervised: false,
    isWorker: true,
    status: 'working',
    ownerAgentId: owner.id,
    notifyOwner: false,
  });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'crashed',
    fromStatus: 'working',
    source: 'runner-exit',
  });

  assert.equal(f.sendInputCalls.length, 1, 'MUTE: muted worker with terminal owner STILL reaches the backstop');
  assert.equal(
    f.sendInputCalls[0].agentId,
    supervisor.id,
    'MUTE: backstop recipient is the structural supervisor, not the (muted) owner',
  );
  console.log('  MUTE ✓ muted worker + terminal owner → structural backstop still delivers');
}

async function MUTE_watchdogEventsBypassMute(): Promise<void> {
  // (d) Orchestration members launch with notifyOwner:false (commit 6e92334) to
  // spare the supervising agent routine idle/done turn-end noise. But that mute
  // must NOT swallow the "something is wrong" signals: worker_stalled and
  // handoff_failed are watchdog-class and bypass the mute, reaching the live
  // owner. Meanwhile an idle status_change from the SAME muted member stays
  // muted. Both assertions share one bridge so we prove the gate is per-event
  // class, not a blanket un-muting.
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', {
    isSupervised: false,
    isWorker: true,
    status: 'working',
    ownerAgentId: owner.id,
    notifyOwner: false,
  });
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  // worker_stalled — watchdog-class → bypasses the mute → delivered to owner.
  await bridge.onWorkerStalled({ agent: worker, stalledForMs: 600_000 });
  assert.equal(f.sendInputCalls.length, 1, 'MUTE: muted member worker_stalled bypasses the mute');
  assert.equal(f.sendInputCalls[0].agentId, owner.id, 'MUTE: watchdog event reaches the muted member\'s owner');
  assert.match(f.sendInputCalls[0].text, /stalled|Stalled|working/,
    'MUTE: delivered payload is the stall event');

  // handoff_failed — also watchdog-class → bypasses the mute.
  await bridge.onHandoffFailed({ agent: worker, attempts: 3, message: 'submit never confirmed' });
  assert.equal(f.sendInputCalls.length, 2, 'MUTE: muted member handoff_failed also bypasses the mute');
  assert.equal(f.sendInputCalls[1].agentId, owner.id);

  // idle turn-end noise from the SAME muted member — still muted (dropped).
  await bridge.onStatusChanged({
    agentId: worker.id,
    status: 'idle',
    fromStatus: 'working',
    source: 'monitor',
  });
  assert.equal(f.sendInputCalls.length, 2, 'MUTE: idle turn-end from the muted member stays muted');
  assert.equal(bridge.getQueueSnapshot().length, 0, 'MUTE: muted idle is not even queued');
  console.log('  MUTE ✓ watchdog events (worker_stalled/handoff_failed) bypass member mute; idle stays muted');
}

// ── Transient one-turn cross-agent subscription (Increment 1) ──────────
//
// Ordinary subscribers use privilegeLane:'supervisor' (NOT isSupervisor:true)
// so the fake owner resolution does not treat them as the structural backstop.
// isSupervisor:true is used only for supervisor-TARGET cases.

function bypassCooldown(f: ReturnType<typeof makeFakeBridgeDeps>): void {
  f.setNow(f.getNow() + SUPERVISOR_EVENT_COOLDOWN_MS + 1);
}
function countTo(f: ReturnType<typeof makeFakeBridgeDeps>, agentId: string): number {
  return f.sendInputCalls.filter(c => c.agentId === agentId).length;
}

async function TS01_fanOutAndConsume(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', ownerAgentId: owner.id, title: 'Worker One' });
  f.agents.set(owner.id, owner);
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  const reg = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  assert.equal(reg.registered, true, 'TS01: registration succeeds');

  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 0, 'TS01: working promotes but delivers nothing');

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 2, 'TS01: idle fans out to owner + subscriber');
  const ownerCall = f.sendInputCalls.find(c => c.agentId === owner.id);
  const subCall = f.sendInputCalls.find(c => c.agentId === subscriber.id);
  assert.ok(ownerCall, 'TS01: owner delivered');
  assert.ok(subCall, 'TS01: subscriber delivered');
  assert.ok(ownerCall!.text.includes('[DASHBOARD EVENT] Agent status changed'), 'TS01: owner gets the lifecycle header');
  assert.ok(subCall!.text.includes('Reply to your message'), 'TS01: subscriber payload framed as a reply');

  // Second idle: subscription consumed → owner only.
  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 3, 'TS01: second idle reaches owner only');
  assert.equal(f.sendInputCalls[2].agentId, owner.id, 'TS01: third delivery is the owner');
  console.log('  TS01 ✓ fan-out to owner + subscriber, then consume on terminal');
}

async function TS02_waitingCap(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', ownerAgentId: owner.id });
  f.agents.set(owner.id, owner);
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });

  await bridge.onStatusChanged({ agentId: worker.id, status: 'waiting', fromStatus: 'working', source: 'monitor', waitingKind: 'notification', waitingExcerpt: 'pick one' });
  assert.equal(countTo(f, subscriber.id), 1, 'TS02: first waiting delivered to subscriber');
  assert.equal(countTo(f, owner.id), 1, 'TS02: first waiting delivered to owner');

  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'waiting', fromStatus: 'working', source: 'monitor', waitingKind: 'notification', waitingExcerpt: 'again' });
  assert.equal(countTo(f, subscriber.id), 1, 'TS02: second waiting is capped for the subscriber');
  assert.equal(countTo(f, owner.id), 2, 'TS02: owner still gets the second waiting');

  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 2, 'TS02: later idle delivers to the (still-armed) subscriber');

  // Consumed now — another idle reaches owner only.
  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 2, 'TS02: subscription consumed by the idle');
  console.log('  TS02 ✓ waiting capped at one per subscription; idle consumes');
}

async function TS03_crashConsumes(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', lastExitCode: 1 });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });

  await bridge.onStatusChanged({ agentId: worker.id, status: 'crashed', fromStatus: 'working', source: 'runner-exit' });
  assert.equal(countTo(f, subscriber.id), 1, 'TS03: crash delivered to subscriber');

  // Pruned: a follow-up idle does not reach the subscriber.
  worker.status = 'working';
  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 1, 'TS03: subscription pruned by crash');
  console.log('  TS03 ✓ crash consumes + prunes the subscription');
}

async function TS04_workerStalledNonConsuming(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working' });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });

  await bridge.onWorkerStalled({ agent: worker, stalledForMs: 600_000 });
  assert.equal(countTo(f, subscriber.id), 1, 'TS04: worker_stalled delivered to subscriber');

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 2, 'TS04: later idle still delivers (stalled did not consume)');

  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 2, 'TS04: idle consumed the subscription');
  console.log('  TS04 ✓ worker_stalled is non-consuming; idle consumes');
}

async function TS05_supervisorTargetCarveOut(): Promise<void> {
  // Part A: supervisor target with a subscriber → subscriber only, no backstop.
  const f = makeFakeBridgeDeps();
  const supTarget = makeAgent('supT', { isSupervisor: true, isSupervised: false, status: 'working', title: 'Sup Target' });
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  f.agents.set(supTarget.id, supTarget);
  f.agents.set(subscriber.id, subscriber);
  f.logs.set(supTarget.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  const reg = bridge.registerTransientTurnSubscription({ targetAgentId: supTarget.id, subscriberAgentId: subscriber.id });
  assert.equal(reg.registered, true, 'TS05: supervisor target subscription registers');
  await bridge.onStatusChanged({ agentId: supTarget.id, status: 'working', fromStatus: 'idle', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: supTarget.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 1, 'TS05: supervisor target emits exactly to the subscriber');
  assert.equal(f.sendInputCalls[0].agentId, subscriber.id, 'TS05: not to any structural backstop');

  // Part B (regression): supervisor target, no subscriber → dropped entirely.
  const g = makeFakeBridgeDeps();
  const supT2 = makeAgent('supT2', { isSupervisor: true, isSupervised: false, status: 'working' });
  g.agents.set(supT2.id, supT2);
  const bridge2 = new EventBridge(g.deps);
  await bridge2.onStatusChanged({ agentId: supT2.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(g.sendInputCalls.length, 0, 'TS05: supervisor target with no subscriber drops the status');
  assert.equal(bridge2.getQueueSnapshot().length, 0, 'TS05: nothing queued for the dropped supervisor status');
  console.log('  TS05 ✓ supervisor-target carve-out (subscriber-only; drop when none)');
}

async function TS06_ownerDedupAtRegister(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // The owner is itself privileged so the dedup check (which runs AFTER the
  // privilege gate) is the one that fires.
  const owner = makeAgent('owner-1', { privilegeLane: 'supervisor', isSupervisor: false, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', ownerAgentId: owner.id });
  f.agents.set(owner.id, owner);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  const reg = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: owner.id });
  assert.equal(reg.registered, false, 'TS06: owner-as-subscriber is not registered');
  assert.equal(reg.reason, 'is-owner', 'TS06: reason is is-owner');

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, owner.id), 1, 'TS06: owner gets exactly one (owner-path) delivery');
  console.log('  TS06 ✓ owner dedup at register');
}

async function TS07_privilegeGate(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const plain = makeAgent('plain-1', { isSupervisor: false, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working' });
  f.agents.set(plain.id, plain);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  const reg = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: plain.id });
  assert.equal(reg.registered, false, 'TS07: non-privileged subscriber rejected');
  assert.equal(reg.reason, 'not-privileged', 'TS07: reason is not-privileged');
  console.log('  TS07 ✓ privilege gate blocks non-privileged subscribers');
}

async function TS08_startWatchdogPrunes(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'idle' });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  // Never promote (no 'working'); fire the start-watchdog.
  const fired = f.scheduler.runDue(f.getNow() + TRANSIENT_SUB_PENDING_START_TIMEOUT_MS);
  assert.ok(fired >= 1, 'TS08: the start-watchdog fired');

  // A subsequent unrelated idle must not reach the pruned (never-armed) sub.
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 0, 'TS08: pruned pending-start sub receives nothing');
  console.log('  TS08 ✓ start-watchdog prunes a never-started subscription');
}

async function TS09_ttlNotice(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle', title: 'Subby' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', title: 'Hung Worker' });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });

  // Never terminate; fire the TTL backstop.
  f.scheduler.runDue(f.getNow() + TRANSIENT_SUB_TTL_MS);
  await flushMicrotasks();

  assert.equal(countTo(f, subscriber.id), 1, 'TS09: TTL notice delivered to subscriber');
  const text = f.sendInputCalls.find(c => c.agentId === subscriber.id)!.text;
  assert.ok(/one-turn subscription to "Hung Worker"/.test(text), 'TS09: names the target');
  assert.ok(/expired/.test(text), 'TS09: says expired');
  assert.ok(!/still busy/i.test(text), 'TS09: does NOT claim the target is still busy');

  // Pruned: a later (post-hang) idle does not deliver again.
  worker.status = 'working';
  bypassCooldown(f);
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 1, 'TS09: subscription pruned after TTL');
  console.log('  TS09 ✓ TTL backstop notice (no "still busy" claim) + prune');
}

async function TS10_refreshNotStack(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working' });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  const r1 = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  assert.equal(r1.registered, true);
  assert.equal(f.scheduler.pendingCount(), 2, 'TS10: first register schedules ttl + watchdog');

  const r2 = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  assert.equal(r2.registered, true, 'TS10: refresh succeeds');
  assert.equal(f.scheduler.pendingCount(), 2, 'TS10: refresh resets timers (no stacking → still 2)');

  // Only ONE subscription exists: a single idle delivers exactly once.
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(f, subscriber.id), 1, 'TS10: refreshed pair delivers exactly once');
  console.log('  TS10 ✓ re-register refreshes (never stacks)');
}

async function TS11_perTargetCap(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working' });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  for (let i = 0; i < TRANSIENT_SUB_MAX_PER_TARGET; i++) {
    const sub = makeAgent(`sub-${i}`, { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
    f.agents.set(sub.id, sub);
    const r = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: sub.id });
    assert.equal(r.registered, true, `TS11: subscriber ${i} within cap registers`);
  }
  const overflow = makeAgent('sub-overflow', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  f.agents.set(overflow.id, overflow);
  const r = bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: overflow.id });
  assert.equal(r.registered, false, 'TS11: the (MAX+1)th subscriber is rejected');
  assert.equal(r.reason, 'target-cap', 'TS11: reason is target-cap');
  console.log('  TS11 ✓ per-target subscriber cap');
}

async function TS12_forgetAgentBothDirections(): Promise<void> {
  // Forget the TARGET → list dropped + timers cancelled.
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working' });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  assert.equal(f.scheduler.pendingCount(), 2, 'TS12: timers scheduled');
  bridge.forgetAgent(worker.id);
  assert.equal(f.scheduler.pendingCount(), 0, 'TS12: forgetting the target cancels its subscription timers');

  // Forget the SUBSCRIBER → stripped from the target's list.
  const g = makeFakeBridgeDeps();
  const sub2 = makeAgent('sub-2', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const wk2 = makeAgent('w-2', { isSupervised: false, isWorker: true, status: 'working' });
  g.agents.set(sub2.id, sub2);
  g.agents.set(wk2.id, wk2);
  g.logs.set(wk2.id, 'tail\n');
  const bridge2 = new EventBridge(g.deps);
  bridge2.registerTransientTurnSubscription({ targetAgentId: wk2.id, subscriberAgentId: sub2.id });
  await bridge2.onStatusChanged({ agentId: wk2.id, status: 'working', fromStatus: 'idle', source: 'monitor' });
  bridge2.forgetAgent(sub2.id);
  assert.equal(g.scheduler.pendingCount(), 0, 'TS12: forgetting the subscriber cancels its timers');
  await bridge2.onStatusChanged({ agentId: wk2.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(countTo(g, sub2.id), 0, 'TS12: forgotten subscriber receives nothing');
  console.log('  TS12 ✓ forgetAgent cleans up both target and subscriber roles');
}

async function TS13_contextStatsSupervisorGuard(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supTarget = makeAgent('supT', { workspaceId: 'ws-A', isSupervisor: true, isSupervised: false, status: 'idle' });
  f.agents.set(supTarget.id, supTarget);
  const bridge = new EventBridge(f.deps);

  bridge.onContextStatsChanged(statsAt(supTarget.id, 95, 1));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 0, 'TS13: supervisor context-threshold delivers nothing');
  assert.equal(bridge.getQueueSnapshot().length, 0, 'TS13: nothing queued');

  // A worker in another workspace still crosses thresholds normally — proves
  // the supervisor early-return did not corrupt lastContextThreshold state.
  const supB = makeAgent('supB', { workspaceId: 'ws-B', isSupervisor: true, isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { workspaceId: 'ws-B', isSupervised: true, status: 'working' });
  f.agents.set(supB.id, supB);
  f.agents.set(worker.id, worker);
  bridge.onContextStatsChanged(statsAt(worker.id, 95, 1));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 1, 'TS13: worker threshold still delivers (no state corruption)');
  assert.equal(f.sendInputCalls[0].agentId, supB.id);
  console.log('  TS13 ✓ onContextStatsChanged keeps the supervisor early-return');
}

async function TS14_recipientScopedQueueUnderFanOut(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const owner = makeAgent('owner-1', { isSupervisor: false, isSupervised: false, status: 'working' });
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'idle' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', ownerAgentId: owner.id, title: 'Worker One' });
  f.agents.set(owner.id, owner);
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  // Owner busy → queued for owner; subscriber idle → immediate deliver.
  assert.equal(f.sendInputCalls.length, 1, 'TS14: one immediate send (to the idle subscriber)');
  assert.equal(f.sendInputCalls[0].agentId, subscriber.id);
  assert.ok(f.sendInputCalls[0].text.includes('Reply to your message'), 'TS14: subscriber payload framed as a reply');
  assert.equal(bridge.getQueueSnapshot(owner.id).length, 1, 'TS14: owner event queued in the owner-scoped queue');
  assert.equal(bridge.getQueueSnapshot(subscriber.id).length, 0, 'TS14: subscriber was delivered, not queued');
  console.log('  TS14 ✓ recipient-scoped queue holds the busy owner while subscriber delivers');
}

async function TS_consolidatedReplyDigest(): Promise<void> {
  // Review-resolution §3(b): a drained consolidated batch containing a
  // viaSubscription status event renders the "(reply to you)" digest line.
  const f = makeFakeBridgeDeps();
  const subscriber = makeAgent('sub-1', { privilegeLane: 'supervisor', isSupervised: false, status: 'working' });
  const worker = makeAgent('w-1', { isSupervised: false, isWorker: true, status: 'working', title: 'Worker One' });
  f.agents.set(subscriber.id, subscriber);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  bridge.registerTransientTurnSubscription({ targetAgentId: worker.id, subscriberAgentId: subscriber.id });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'working', fromStatus: 'idle', source: 'monitor' });

  // Subscriber busy → both events queue. worker_stalled (non-consuming) then
  // idle (status_change, viaSubscription) → 2 queued events → consolidated.
  await bridge.onWorkerStalled({ agent: worker, stalledForMs: 600_000 });
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(bridge.getQueueSnapshot(subscriber.id).length, 2, 'TS_consolidated: two events queued for the busy subscriber');

  subscriber.status = 'idle';
  await bridge.drainPendingFor(subscriber.id);
  assert.equal(f.sendInputCalls.length, 1, 'TS_consolidated: one consolidated send');
  const text = f.sendInputCalls[0].text;
  assert.ok(text.includes('events occurred'), 'TS_consolidated: consolidated header present');
  assert.ok(text.includes('(reply to you)'), 'TS_consolidated: status digest line carries the reply tag');
  console.log('  TS_consolidated ✓ consolidated digest tags viaSubscription status as reply');
}

// ── BUG-41: continuation-swap drop windows in the event bridge ─────────
//
// A supervisor mid-continuation-swap walks working → done → restarting →
// launching → idle under a STABLE agent id. Events about other workers keep
// arriving during that walk. Before the fix: 'restarting' and the sub-second
// 'done' window fell to deliver()'s "Dropped event" log, and a drain firing in
// the 'done' window PURGED the whole queue. After the fix: 'restarting' (always)
// and 'done' (only while a swap is in flight) are queue-statuses; a genuinely-
// stopped 'done' still purges; a throwing sendInput never loses the batch.

async function BUG41_restartingQueuesAndDrainsAfterIdle(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'restarting' });
  const worker = makeAgent('w-1', { status: 'working', title: 'Worker One' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 0, 'BUG41: nothing sent while recipient is restarting');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 1, 'BUG41: event queued during restarting');
  assert.equal(f.scheduler.pendingCount(), 1, 'BUG41: a drain is armed');

  // Swap settles: fresh session idle → the queue drains to the same agent id.
  supervisor.status = 'idle';
  await bridge.drainPendingFor(supervisor.id);
  assert.equal(f.sendInputCalls.length, 1, 'BUG41: queue drains to the fresh session once idle');
  assert.equal(f.sendInputCalls[0].agentId, supervisor.id);
  assert.ok(f.sendInputCalls[0].text.includes('Worker One'), 'BUG41: drained payload carries the worker event');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 0, 'BUG41: queue emptied after successful drain');
  console.log('  BUG41 ✓ event during restarting queues, then drains after status returns to idle');
}

async function BUG41_drainDuringRestartingPreservesQueue(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'working' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  // Queue an event while the supervisor is busy.
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 1, 'BUG41: event queued while working');

  // The drain timer fires WHILE the supervisor is now restarting (mid-swap).
  supervisor.status = 'restarting';
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 0, 'BUG41: drain does not flush into the being-replaced PTY during restarting');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 1, 'BUG41: drain preserves the queue during restarting');
  assert.equal(f.scheduler.pendingCount(), 1, 'BUG41: drain re-armed for a later attempt');
  console.log('  BUG41 ✓ drain firing during restarting preserves the queue (re-arms, never purges/flushes)');
}

async function BUG41_drainSendThrowDoesNotLoseEvents(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'working' });
  const w1 = makeAgent('w-1', { status: 'working', title: 'Worker One' });
  const w2 = makeAgent('w-2', { status: 'working', title: 'Worker Two' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(w1.id, w1);
  f.agents.set(w2.id, w2);
  f.logs.set(w1.id, 'tail\n');
  f.logs.set(w2.id, 'tail\n');
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: w1.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  await bridge.onStatusChanged({ agentId: w2.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 2, 'BUG41: both events queued');

  // Drain into a PTY whose write throws (no-op/absent PTY mid-swap).
  supervisor.status = 'idle';
  f.setSendInputError(new Error('pty absent'));
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 1, 'BUG41: send was attempted');
  assert.equal(f.sendInputCalls[0].resolved, false, 'BUG41: the send threw');
  assert.equal(f.auditEvents.length, 0, 'BUG41: no batch audit on a failed send');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 2, 'BUG41: the batch was re-queued, not lost');
  assert.equal(f.scheduler.pendingCount(), 1, 'BUG41: drain re-armed after the failed send');

  // Next drain (error cleared) delivers the preserved batch.
  await bridge.drainPendingFor(supervisor.id);
  assert.equal(f.sendInputCalls.length, 2, 'BUG41: retry delivered the preserved batch');
  assert.equal(f.sendInputCalls[1].resolved, true);
  assert.ok(f.sendInputCalls[1].text.includes('Worker One'), 'BUG41: retry payload still carries the first worker');
  assert.ok(f.sendInputCalls[1].text.includes('Worker Two'), 'BUG41: retry payload still carries the second worker');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 0, 'BUG41: queue emptied only after the successful send');
  console.log('  BUG41 ✓ a throwing sendInput on drain re-queues the batch (no events lost)');
}

async function BUG41_doneWithSwapInFlightQueuesAndDrainReArms(): Promise<void> {
  const f = makeFakeBridgeDeps();
  // Recipient is in the sub-second 'done' window mid-swap.
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'done' });
  const worker = makeAgent('w-1', { status: 'working', title: 'Worker One' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  f.setContinuationSwapInFlight(supervisor.id, true);
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 0, 'BUG41: nothing sent to a done-mid-swap recipient');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 1, 'BUG41: event queued (not dropped) during the done window');
  assert.equal(f.scheduler.pendingCount(), 1, 'BUG41: drain armed');

  // A drain firing while STILL done + swap-in-flight must re-arm, not purge.
  await bridge.drainPendingFor(supervisor.id);
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 1, 'BUG41: drain during done+swap preserves the queue');
  assert.equal(f.scheduler.pendingCount(), 1, 'BUG41: drain re-armed during done+swap');
  assert.equal(f.sendInputCalls.length, 0, 'BUG41: still nothing sent');

  // Swap completes: predicate clears, fresh session idle → the queue drains.
  f.setContinuationSwapInFlight(supervisor.id, false);
  supervisor.status = 'idle';
  await bridge.drainPendingFor(supervisor.id);
  assert.equal(f.sendInputCalls.length, 1, 'BUG41: drains to the fresh session after the swap');
  assert.ok(f.sendInputCalls[0].text.includes('Worker One'));
  console.log('  BUG41 ✓ done + swap-in-flight queues + re-arms, then drains after the swap');
}

async function BUG41_doneWithoutSwapPurges(): Promise<void> {
  // (a) delivery: a genuinely-stopped 'done' recipient (no swap) drops the
  // event at recipientsFor — never queued.
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'done' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  f.logs.set(worker.id, 'tail\n');
  // No setContinuationSwapInFlight → predicate is false.
  const bridge = new EventBridge(f.deps);

  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(f.sendInputCalls.length, 0, 'BUG41: nothing sent to a genuinely-done recipient');
  assert.equal(bridge.getQueueSnapshot(supervisor.id).length, 0, 'BUG41: genuinely-done recipient does not queue');

  // (b) drain: a queue that exists when the recipient is 'done' with no swap in
  // flight is PURGED (the classic terminal-recipient cleanup).
  const g = makeFakeBridgeDeps();
  const sup2 = makeAgent('sup-2', { isSupervisor: true, isSupervised: false, status: 'working' });
  const wk2 = makeAgent('wk-2', { status: 'working' });
  g.agents.set(sup2.id, sup2);
  g.agents.set(wk2.id, wk2);
  g.logs.set(wk2.id, 'tail\n');
  const bridge2 = new EventBridge(g.deps);

  await bridge2.onStatusChanged({ agentId: wk2.id, status: 'idle', fromStatus: 'working', source: 'monitor' });
  assert.equal(bridge2.getQueueSnapshot(sup2.id).length, 1, 'BUG41: event queued while working');

  sup2.status = 'done'; // genuinely stopped, no swap in flight
  await bridge2.drainPendingFor(sup2.id);
  assert.equal(bridge2.getQueueSnapshot(sup2.id).length, 0, 'BUG41: drain purges the queue for a genuinely-done recipient');
  assert.equal(g.sendInputCalls.length, 0, 'BUG41: nothing sent to the stopped recipient');
  console.log('  BUG41 ✓ genuinely-done (no swap) drops at delivery and purges on drain');
}

// ── WP7 (hook-absence-resilience) — hook-health-conditional skip ──────────

async function WP7_hooksUnavailableFallsThroughToTranscript(): Promise<void> {
  // A supervised claude worker with LIVE hooks: the chat-stream must NOT drive
  // status (hooks own it) — the turnComplete is skipped.
  const fHealthy = makeFakeBridgeDeps();
  const healthy = makeAgent('wp7-healthy', {
    provider: 'claude', status: 'working', isSupervised: true, isWorker: true,
    hooksUnavailable: false,
  });
  fHealthy.agents.set(healthy.id, healthy);
  new EventBridge(fHealthy.deps).onChatEvents(batchFor(healthy.id, [
    assistantText(healthy.id, { turnComplete: true }),
  ]));
  assert.equal(fHealthy.statusForceCalls.length, 0,
    'WP7: healthy hook-owned lane still skips the chat-stream status switch');

  // Same worker but the canary proved the hooks DEAD: it now falls through to the
  // transcript fallback and turnComplete → forceIdle.
  const fDead = makeFakeBridgeDeps();
  const dead = makeAgent('wp7-dead', {
    provider: 'claude', status: 'working', isSupervised: true, isWorker: true,
    hooksUnavailable: true,
  });
  fDead.agents.set(dead.id, dead);
  new EventBridge(fDead.deps).onChatEvents(batchFor(dead.id, [
    assistantText(dead.id, { turnComplete: true }),
  ]));
  assert.equal(fDead.statusForceCalls.length, 1, 'WP7: hooks-unavailable lane recovers status from the transcript');
  assert.equal(fDead.statusForceCalls[0].method, 'forceIdle');
  assert.equal(fDead.statusForceCalls[0].source, 'turnComplete');
  console.log('  WP7 ✓ hooksUnavailable falls through to transcript status routing; healthy still skips');
}

async function main(): Promise<void> {
  console.log('event-bridge.test: running BR-01..BR-20 + BUG-18 + BUG-22 + BUG-41 + TS-subscriptions');
  await BR_01_happyPath();
  await BR_02_crashViaRunnerExit();
  await BR_02b_runnerExitBypassesCooldown();
  await BR_03_queueAndConsolidate();
  await BR_04_attachedQueueDrains();
  await BR_05_cooldownDropsDup();
  await BR_06_cooldownClearsAfter10s();
  await BR_07_contextThresholdOrdering();
  await BR_08_consolidatedMixesKinds();
  await BR_09_sendInputRejects();
  await BR_10_multiSupervisorIsolation();
  await BR_QUEUE_recipientScoped();
  await BR_13_endsWithQuestionNoLongerFiresWaitingForHookWorker();
  await BR_15_notifyUserInputClearsLatchOnWaiting();
  await BR_15_notifyUserInputNoopWhenNotWaiting();
  await BR_15_notifyUserInputSkippedForSupervised();
  await BR_20_waitingToWorkingIsSuppressed();
  await launchingToIdle_isSuppressed();
  await launchingToOtherStatuses_stillFire();
  await done_isNeverNotified();
  await onChatEvents_codexTurnComplete();
  await onChatEvents_dispatchTable();
  await WP7_hooksUnavailableFallsThroughToTranscript();
  await onChatEvents_initialLoadSuppressesForceCalls();
  await onChatEvents_secondBatchIsNotInitialLoad();
  await BR_11a_deliverDefersWhileUserTyping();
  await BR_11b_drainRedefersWhileUserStillTyping();
  await BR_11c_drainShipsOnceUserQuiet();
  await BR_11d_idleSupervisorNoTypingShipsImmediately();
  await BUG_18_thinkingForceWorkingUsesThinkingPending();
  await BUG_18_endToEndTurnInFlightSetAndCleared();
  await userTextIsNotStatusBearing();
  await BUG_22_tmuxFailureDeliversWithDistinctHeader();
  await BUG_22_tmuxFailureForSupervisorIsNoOpAtBridge();
  await BUG_22_tmuxFailureQueuesWhenSupervisorBusy();
  await OWN_ownedNonSupervisedDeliversToOwner();
  await OWN_terminalOwnerFallsBackToStructural();
  await OWN_busyOwnerQueuesDoesNotFallBack();
  await MUTE_ownedMutedLiveOwnerDropped();
  await MUTE_defaultNotifyStillDelivers();
  await MUTE_terminalOwnerBackstopNotMuted();
  await MUTE_watchdogEventsBypassMute();
  await TS01_fanOutAndConsume();
  await TS02_waitingCap();
  await TS03_crashConsumes();
  await TS04_workerStalledNonConsuming();
  await TS05_supervisorTargetCarveOut();
  await TS06_ownerDedupAtRegister();
  await TS07_privilegeGate();
  await TS08_startWatchdogPrunes();
  await TS09_ttlNotice();
  await TS10_refreshNotStack();
  await TS11_perTargetCap();
  await TS12_forgetAgentBothDirections();
  await TS13_contextStatsSupervisorGuard();
  await TS14_recipientScopedQueueUnderFanOut();
  await TS_consolidatedReplyDigest();
  await BUG41_restartingQueuesAndDrainsAfterIdle();
  await BUG41_drainDuringRestartingPreservesQueue();
  await BUG41_drainSendThrowDoesNotLoseEvents();
  await BUG41_doneWithSwapInFlightQueuesAndDrainReArms();
  await BUG41_doneWithoutSwapPurges();
  console.log('event-bridge.test: all tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
