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

  bridge.onContextStatsChanged(statsAt(worker.id, 80, 1));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 1, 'BR-07: crossing 80 fires once');

  bridge.onContextStatsChanged(statsAt(worker.id, 82, 2));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 1, 'BR-07: still in 80 bucket — no new event');

  bridge.onContextStatsChanged(statsAt(worker.id, 90, 3));
  await flushMicrotasks();
  assert.equal(f.sendInputCalls.length, 2, 'BR-07: crossing 90 fires a new event');
  console.log('  BR-07 ✓ context threshold ordering 80 → 80 → 90');
}

async function BR_08_consolidatedMixesKinds(): Promise<void> {
  const f = makeFakeBridgeDeps();
  const supervisor = makeAgent('sup-1', { isSupervisor: true, isSupervised: false, status: 'working' });
  const worker = makeAgent('w-1', { status: 'working' });
  f.agents.set(supervisor.id, supervisor);
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.onContextStatsChanged(statsAt(worker.id, 80, 1));
  await flushMicrotasks();
  await bridge.onStatusChanged({ agentId: worker.id, status: 'idle', fromStatus: 'working', source: 'monitor' });

  assert.equal(f.sendInputCalls.length, 0, 'BR-08: nothing delivered while supervisor is working');
  assert.equal(bridge.getQueueSnapshot().length, 2, 'BR-08: both event kinds queued');

  supervisor.status = 'idle';
  await bridge.drainPendingFor(supervisor.id);

  assert.equal(f.sendInputCalls.length, 1, 'BR-08: drain emitted one consolidated payload');
  const payload = f.sendInputCalls[0].text;
  assert.ok(payload.includes('context at 80%'), 'BR-08: context_threshold rendered');
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

async function BR_19_geminiTurnCompleteFiresForceIdle_postBug09(): Promise<void> {
  // BUG-09 §3.9 inverts BR-19. Pre-bug-09 the D-07 gate suppressed
  // forceIdle for Gemini because the reader hardcoded turnComplete=true on
  // every emission. With the gemini reader now gating turnComplete on
  // allToolsResolved && usageLanded, Gemini routes through forceIdle on
  // the same path as Claude/Codex.
  const f = makeFakeBridgeDeps();
  const gem = makeAgent('gem-1', { provider: 'gemini', status: 'working' });
  f.agents.set(gem.id, gem);
  const bridge = new EventBridge(f.deps);

  bridge.onChatEvents(batchFor(gem.id, [
    assistantText(gem.id, { turnComplete: true }),
  ]));

  assert.equal(f.statusForceCalls.length, 1,
    'BUG-09 §3.9: Gemini turnComplete now fires forceIdle (D-07 removed)');
  assert.equal(f.statusForceCalls[0].method, 'forceIdle');
  assert.equal(f.statusForceCalls[0].source, 'turnComplete');
  console.log('  BR-19 (BUG-09 §3.9) ✓ Gemini turnComplete fires forceIdle');
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

  assert.equal(f.statusForceCalls.length, 5);
  // BUG-09 §3.3 — assistant-text without turnComplete now refreshes via the
  // generic `assistant-text` source (was `turnContinues`, conditioned on
  // stopReason === 'tool_use'). All forceWorking calls now carry typed opts.
  assert.deepEqual(
    f.statusForceCalls.map(c => `${c.method}:${c.source ?? c.kind}`),
    [
      'forceWorking:user-turn',
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

async function onChatEvents_geminiToolUseStillRoutes(): Promise<void> {
  // BR-19 is only about the assistant-text+turnComplete branch. Gemini's
  // other events (tool-use, task-started, user-text) still drive the latch.
  const f = makeFakeBridgeDeps();
  const gem = makeAgent('gem-2', { provider: 'gemini', status: 'idle' });
  f.agents.set(gem.id, gem);
  const bridge = new EventBridge(f.deps);

  const tool: ToolUseEvent = {
    type: 'tool-use', uuid: 't', timestamp: '', agentId: gem.id,
    toolUseId: 'gx', toolName: 'Read', input: {},
  };
  bridge.onChatEvents(batchFor(gem.id, [tool]));

  assert.equal(f.statusForceCalls.length, 1);
  assert.equal(f.statusForceCalls[0].method, 'forceWorking');
  assert.equal(f.statusForceCalls[0].source, 'tool-use');
  console.log('  onChatEvents ✓ Gemini tool-use still routes through bridge (D-07 is narrow)');
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

async function BR_13_endsWithQuestionFiresForceWaiting(): Promise<void> {
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

  assert.equal(f.statusForceCalls.length, 1, 'BR-13: one force call');
  assert.equal(f.statusForceCalls[0].method, 'forceWaiting');
  assert.equal(f.statusForceCalls[0].agentId, worker.id);
  assert.equal(f.statusForceCalls[0].kind, 'question');
  // Excerpt is text.slice(-300); for a short text that's the whole body.
  assert.equal(f.statusForceCalls[0].excerpt, 'Long preamble. Did that resolve it?');
  console.log('  BR-13 ✓ endsWithQuestion=true → forceWaiting(question, tail)');
}

async function BR_13_endsWithQuestionTakesPriorityOverTurnComplete(): Promise<void> {
  // Branch order check: endsWithQuestion=true must short-circuit ahead of the
  // turnComplete=true → forceIdle branch.
  const f = makeFakeBridgeDeps();
  const worker = makeAgent('w-q2', { provider: 'codex', status: 'working' });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.onChatEvents(batchFor(worker.id, [
    assistantText(worker.id, { text: 'OK?', turnComplete: true, endsWithQuestion: true }),
  ]));

  assert.equal(f.statusForceCalls.length, 1);
  assert.equal(f.statusForceCalls[0].method, 'forceWaiting',
    'BR-13: endsWithQuestion wins over turnComplete');
  console.log('  BR-13 ✓ endsWithQuestion priority over turnComplete');
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
    waitingKind: 'question',
    waitingExcerpt: 'Are you sure?',
  });
  assert.equal(f.sendInputCalls.length, 1, 'BR-20: waiting transition fires');
  assert.ok(
    f.sendInputCalls[0].text.includes('[DASHBOARD EVENT] Agent waiting for input'),
    'BR-20: waiting payload renders the dedicated header',
  );
  assert.ok(
    f.sendInputCalls[0].text.includes('Waiting kind: question'),
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

async function BUG_18_userTextDoesNotMarkTurnInFlight(): Promise<void> {
  // Verify the bridge is selective: user-text is a refresh source but it
  // does NOT begin a model turn (the next task-started / first assistant
  // event does). Marking it would over-extend the latch on aborted turns.
  const f = makeFakeBridgeDeps();
  const claude = makeAgent('cl-bug18-3', { provider: 'claude', status: 'working', isSupervised: false });
  f.agents.set(claude.id, claude);
  const bridge = new EventBridge(f.deps);

  const userEv: UserTextEvent = {
    type: 'user-text', uuid: 'u', timestamp: '', agentId: claude.id, text: 'go',
  };
  bridge.onChatEvents(batchFor(claude.id, [userEv]));

  assert.equal(f.statusForceCalls.length, 1);
  assert.equal(f.statusForceCalls[0].source, 'user-turn');
  assert.notEqual(f.statusForceCalls[0].workingOpts?.turnInFlight, true,
    'user-text does not begin an in-flight turn');
  console.log('  BUG-18 Change 3 ✓ user-text omits turnInFlight (non-regression)');
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

async function main(): Promise<void> {
  console.log('event-bridge.test: running BR-01..BR-20 + BUG-18 + BUG-22');
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
  await BR_13_endsWithQuestionFiresForceWaiting();
  await BR_13_endsWithQuestionTakesPriorityOverTurnComplete();
  await BR_15_notifyUserInputClearsLatchOnWaiting();
  await BR_15_notifyUserInputNoopWhenNotWaiting();
  await BR_15_notifyUserInputSkippedForSupervised();
  await BR_19_geminiTurnCompleteFiresForceIdle_postBug09();
  await BR_20_waitingToWorkingIsSuppressed();
  await launchingToIdle_isSuppressed();
  await launchingToOtherStatuses_stillFire();
  await onChatEvents_codexTurnComplete();
  await onChatEvents_dispatchTable();
  await onChatEvents_geminiToolUseStillRoutes();
  await onChatEvents_initialLoadSuppressesForceCalls();
  await onChatEvents_secondBatchIsNotInitialLoad();
  await BR_11a_deliverDefersWhileUserTyping();
  await BR_11b_drainRedefersWhileUserStillTyping();
  await BR_11c_drainShipsOnceUserQuiet();
  await BR_11d_idleSupervisorNoTypingShipsImmediately();
  await BUG_18_thinkingForceWorkingUsesThinkingPending();
  await BUG_18_endToEndTurnInFlightSetAndCleared();
  await BUG_18_userTextDoesNotMarkTurnInFlight();
  await BUG_22_tmuxFailureDeliversWithDistinctHeader();
  await BUG_22_tmuxFailureForSupervisorIsNoOpAtBridge();
  await BUG_22_tmuxFailureQueuesWhenSupervisorBusy();
  console.log('event-bridge.test: all tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
