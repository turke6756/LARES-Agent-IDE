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
import { SUPERVISOR_EVENT_COOLDOWN_MS } from '../../shared/constants';
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
  const codex = makeAgent('cx-1', { provider: 'codex', status: 'working' });
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
  const claude = makeAgent('cl-1', { provider: 'claude', status: 'working' });
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
  const claude = makeAgent('cl-il2', { provider: 'claude', status: 'idle' });
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
  const worker = makeAgent('w-w1', { provider: 'claude', status: 'waiting' });
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
  const worker = makeAgent('w-w2', { provider: 'claude', status: 'working' });
  f.agents.set(worker.id, worker);
  const bridge = new EventBridge(f.deps);

  bridge.notifyUserInputDelivered(worker.id);
  assert.equal(f.statusForceCalls.length, 0, 'BR-15: no-op when target is not waiting');
  console.log('  BR-15 ✓ notifyUserInputDelivered is a no-op outside waiting');
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

async function main(): Promise<void> {
  console.log('event-bridge.test: running BR-01..BR-20');
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
  await BR_19_geminiTurnCompleteFiresForceIdle_postBug09();
  await BR_20_waitingToWorkingIsSuppressed();
  await onChatEvents_codexTurnComplete();
  await onChatEvents_dispatchTable();
  await onChatEvents_geminiToolUseStillRoutes();
  await onChatEvents_initialLoadSuppressesForceCalls();
  await onChatEvents_secondBatchIsNotInitialLoad();
  console.log('event-bridge.test: all tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
