// Integration tests for the EventBridge + StatusMonitor wiring (P3-02 of
// plans/agent-lifecycle-hardening-plan.md, M4). Layers on top of
// event-bridge.test.ts (unit) but uses REAL EventBridge + REAL StatusMonitor
// instances, wired together the same way `AgentSupervisor.constructor` does
// in production (`src/main/supervisor/index.ts:255-296`):
//
//   monitor.on('statusChanged') → emitter.emit('statusChanged' + source:'monitor')
//                                → void bridge.onStatusChanged({ ...data, source:'monitor' })
//   emitter.on('statusChanged')  → void bridge.onStatusChanged(data)
//                                  (skips when source==='monitor' to avoid double-fire)
//
// What this asserts that the unit tests don't:
//   * Pipeline B (`onChatEvents`) end-to-end: bridge dispatches to
//     `statusMonitor.forceWaiting/forceIdle` → monitor emits `statusChanged`
//     with the right payload (waitingKind, waitingExcerpt) → bridge picks it
//     up → supervisor receives `[DASHBOARD EVENT] Agent waiting for input`.
//   * tty-pattern path (BR-14): real `StatusMonitor.inferStatus` runs the
//     PromptPatternDetector against a synthetic PTY ring tail; on match it
//     calls `forceWaiting` → status event → supervisor receives the dashboard
//     event with `waitingKind: 'tty-pattern'`. The unit tests stub the monitor
//     so this round-trip is uncovered there.
//   * Runner-exit crashes (BR-02b end-to-end): direct `emitter.emit` with
//     `source:'runner-exit'` reaches the bridge and bypasses cooldown.
//
// Multi-supervisor scenarios MS-01..MS-05 from docs/SUPERVISOR_ROUTING_SEAMS.md
// are gated behind `MULTI_SUPERVISOR=1`. They are written against the
// post-migration contract (per-`supervisorId` owner resolution, per-supervisor
// queue isolation) and are EXPECTED TO FAIL today — they're the acceptance
// criteria for migration tickets P1-03 / P1-04.
//
// Cross-references with the unit `event-bridge.test.ts`: the unit BRs
// (BR-01..BR-20) test each bridge method in isolation with stubs. This file
// re-exercises only the BR-IDs whose wiring crosses module boundaries
// (BR-02b, BR-13, BR-14, BR-15, BR-19, BR-20) to avoid double-coverage.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/event-bridge.integration.test.js

import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { EventBridge, EventBridgeDeps } from './event-bridge';
import { StatusMonitor } from './status-monitor';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import { patchDatabaseModule, makeStatusMonitorFakes } from './test-helpers/fake-status-deps';
import {
  SUPERVISOR_EVENT_COOLDOWN_MS,
  WORKING_THRESHOLD_MS,
} from '../../shared/constants';
import type { Agent, ContextStats } from '../../shared/types';
import type { StatusChangedEvent } from './status-events';
import type {
  AssistantTextEvent,
  ChatEventBatch,
} from '../../shared/session-events';

// ── MS-01..MS-05 gate ────────────────────────────────────────────────
// MS-XX scenarios target the post-migration contract; flip the env flag on
// once P1-03 / P1-04 have landed. Until then they fail loudly so the
// migration agent knows when it's done.
//
// Grep anchors: MS-01 MS-02 MS-03 MS-04 MS-05  MULTI_SUPERVISOR
const RUN_MS = process.env.MULTI_SUPERVISOR === '1';

// ── Harness ─────────────────────────────────────────────────────────

interface SendInputRecord { agentId: string; text: string; }
interface AuditRecord    { agentId: string; type: string; payload: string; }

interface Harness {
  monitor: StatusMonitor;
  bridge: EventBridge;
  emitter: EventEmitter;
  agents: Map<string, Agent>;
  ringTails: Map<string, string>;
  lastOutput: Map<string, number>;
  alive: Map<string, boolean>;
  contextStats: Map<string, ContextStats>;
  logs: Map<string, string>;
  sendInputCalls: SendInputRecord[];
  audits: AuditRecord[];
  now: { value: number };
  /** Override the bridge's `getSupervisorForWorker` dep (MS-XX uses this to
   *  install post-migration `supervisorId`-based resolution). */
  setOwnerResolver(fn: ((worker: Agent) => Agent | null) | null): void;
  /** Mirror of `AgentSupervisor.this.emit('statusChanged', …)` for direct
   *  emits like `runner-exit` that bypass the monitor. */
  emitDirect(data: StatusChangedEvent): void;
  /** Yield until queued microtasks have settled (bridge uses `void this.deliver(…)`
   *  fire-and-forget). */
  settle(): Promise<void>;
  dispose(): void;
}

function makeHarness(): Harness {
  const fakes = makeStatusMonitorFakes();
  const restoreDb = patchDatabaseModule(fakes);

  const ringTails = new Map<string, string>();
  const lastOutput = new Map<string, number>();
  const alive = new Map<string, boolean>();
  const contextStats = new Map<string, ContextStats>();
  const logs = new Map<string, string>();
  const sendInputCalls: SendInputRecord[] = [];
  const audits: AuditRecord[] = [];
  let ownerResolver: ((worker: Agent) => Agent | null) | null = null;

  const monitor = new StatusMonitor(
    async (agent) => alive.get(agent.id) ?? true,
    (id) => lastOutput.get(id) ?? fakes.now.value,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
    (id) => ringTails.get(id) ?? '',
  );

  const bridgeDeps: EventBridgeDeps = {
    getAgent: (id) => fakes.agents.get(id) ?? null,
    // Production default mirrors `getSupervisorAgent(workspaceId)`: newest
    // supervisor in worker's workspace. MS-XX tests overwrite this with a
    // `worker.supervisorId`-based resolver via `setOwnerResolver`.
    getSupervisorForWorker: (worker) => {
      if (ownerResolver) return ownerResolver(worker);
      const candidates: Agent[] = [];
      for (const a of fakes.agents.values()) {
        if (a.isSupervisor && a.workspaceId === worker.workspaceId) candidates.push(a);
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return candidates[0];
    },
    sendInput: async (agentId, text) => {
      sendInputCalls.push({ agentId, text });
    },
    addAuditEvent: (agentId, type, payload) => {
      audits.push({ agentId, type, payload });
    },
    getAgentLog: async (id, _lines) => logs.get(id) ?? '',
    getContextStats: (id) => contextStats.get(id) ?? null,
    now: () => fakes.now.value,
    scheduleDrain: (ms, fn) => {
      const handle = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(handle) };
    },
    statusMonitor: {
      forceIdle: (id, source) => monitor.forceIdle(id, source),
      forceWaiting: (id, kind, excerpt) => monitor.forceWaiting(id, kind, excerpt),
      forceWorking: (id, source) => monitor.forceWorking(id, source),
    },
  };
  const bridge = new EventBridge(bridgeDeps);

  // Production wiring from `AgentSupervisor.constructor` (index.ts:278-296).
  const emitter = new EventEmitter();
  monitor.on('statusChanged', (data: StatusChangedEvent) => {
    const tagged = { ...data, source: 'monitor' as const };
    emitter.emit('statusChanged', tagged);
    void bridge.onStatusChanged(tagged);
  });
  emitter.on('statusChanged', (data: StatusChangedEvent | undefined) => {
    if (data && data.source && data.source !== 'monitor') {
      void bridge.onStatusChanged(data);
    }
  });

  return {
    monitor,
    bridge,
    emitter,
    agents: fakes.agents,
    ringTails,
    lastOutput,
    alive,
    contextStats,
    logs,
    sendInputCalls,
    audits,
    now: fakes.now,
    setOwnerResolver: (fn) => { ownerResolver = fn; },
    emitDirect: (data) => { emitter.emit('statusChanged', data); },
    settle: () => new Promise<void>((r) => setImmediate(r)),
    dispose: () => {
      monitor.stop();
      restoreDb();
    },
  };
}

function makeWorker(id: string, overrides: Partial<Agent> = {}): Agent {
  return makeAgent(id, { status: 'working', isSupervised: true, ...overrides });
}
function makeSup(id: string, overrides: Partial<Agent> = {}): Agent {
  return makeAgent(id, {
    isSupervisor: true,
    isSupervised: false,
    status: 'idle',
    ...overrides,
  });
}

/** Stamp `supervisorId` on an Agent. The field is added by migration P1-01
 *  (`agents.supervisor_id` column); the Agent type does not yet include it,
 *  so the MS-XX tests attach it via a typed view. The bridge's owner resolver
 *  reads it as `(worker as Agent & { supervisorId?: string }).supervisorId`. */
function ownBy(worker: Agent, supervisorId: string): Agent {
  (worker as Agent & { supervisorId?: string }).supervisorId = supervisorId;
  return worker;
}

function batchOf(agentId: string, events: ChatEventBatch['events']): ChatEventBatch {
  return { agentId, events };
}
function assistantText(agentId: string, overrides: Partial<AssistantTextEvent> = {}): AssistantTextEvent {
  return {
    type: 'assistant-text',
    uuid: `a:${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    agentId,
    text: 'hello',
    ...overrides,
  };
}
function statsAt(agentId: string, pct: number, turn = 1): ContextStats {
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

// ── Single-supervisor scenarios ──────────────────────────────────────
// One scenario per trigger type. Each asserts the supervisor's `sendInput`
// received a payload starting with `[DASHBOARD EVENT]` and carrying the
// scenario-specific fields. Cross-ref BR-IDs from §2.7.

async function single_idle(): Promise<void> {
  // Trigger: chat-stream `turnComplete:true` on a Codex worker → bridge
  //          dispatches forceIdle → monitor emits statusChanged
  //          (working → idle) → bridge delivers to supervisor.
  // Covers the wiring path between BR-11 (latch) and BR-01 (delivery) that
  // the unit tests exercise independently.
  const h = makeHarness();
  try {
    const sup = makeSup('sup-int-1');
    const worker = makeWorker('w-int-idle', { provider: 'codex' });
    h.agents.set(sup.id, sup);
    h.agents.set(worker.id, worker);

    h.bridge.onChatEvents(batchOf(worker.id, [
      assistantText(worker.id, { turnComplete: true }),
    ]));
    await h.settle();

    assert.equal(worker.status, 'idle',
      'single/idle: monitor wrote through to in-memory agent record');
    assert.equal(h.sendInputCalls.length, 1,
      'single/idle: supervisor received exactly one dashboard event');
    assert.equal(h.sendInputCalls[0].agentId, sup.id);
    const payload = h.sendInputCalls[0].text;
    assert.match(payload, /\[DASHBOARD EVENT\] Agent status changed/,
      'single/idle: dashboard-event header present');
    assert.match(payload, /working → idle/,
      'single/idle: from→to rendered');
    console.log('  single/idle ✓ chat turnComplete → forceIdle → supervisor notified');
  } finally { h.dispose(); }
}

async function single_crash_BR_02b(): Promise<void> {
  // BR-02b end-to-end: a runner-exit emit reaches the bridge through the
  // direct `emitter` path (bypassing the monitor's source-tagging). The
  // cooldown-bypass is the unit BR-02b assertion; here we exercise the
  // wiring that the unit test can't reach (the emitter listener at
  // index.ts:292-296).
  const h = makeHarness();
  try {
    const sup = makeSup('sup-int-2');
    const worker = makeWorker('w-int-crash', { lastExitCode: 137 });
    h.agents.set(sup.id, sup);
    h.agents.set(worker.id, worker);

    h.emitDirect({
      agentId: worker.id,
      status: 'crashed',
      fromStatus: 'working',
      source: 'runner-exit',
    });
    await h.settle();

    assert.equal(h.sendInputCalls.length, 1, 'single/crash: one delivery');
    assert.match(h.sendInputCalls[0].text, /Exit code: 137/,
      'single/crash: exit code rendered (BR-02 payload)');

    // BR-02b — second runner-exit inside the 10s cooldown still delivers.
    h.now.value += 5_000;
    worker.lastExitCode = 1;
    h.emitDirect({
      agentId: worker.id,
      status: 'crashed',
      fromStatus: 'working',
      source: 'runner-exit',
    });
    await h.settle();

    assert.equal(h.sendInputCalls.length, 2,
      'single/crash: second runner-exit bypasses cooldown (BR-02b)');
    assert.match(h.sendInputCalls[1].text, /Exit code: 1/,
      'single/crash: second payload renders the new exit code');
    console.log('  single/crash ✓ runner-exit reaches bridge via emitter, cooldown bypassed (BR-02b)');
  } finally { h.dispose(); }
}

async function single_contextThreshold(): Promise<void> {
  // Trigger: `onContextStatsChanged` with pct >= 80. Covers BR-07's wiring
  // end-to-end (the unit test asserts threshold ordering against a stub
  // supervisor; this asserts the dashboard-event header reaches the real
  // sendInput dep).
  const h = makeHarness();
  try {
    const sup = makeSup('sup-int-3');
    const worker = makeWorker('w-int-ctx');
    h.agents.set(sup.id, sup);
    h.agents.set(worker.id, worker);

    h.bridge.onContextStatsChanged(statsAt(worker.id, 80));
    await h.settle();

    assert.equal(h.sendInputCalls.length, 1, 'single/ctx: one delivery on 80% crossing');
    assert.match(h.sendInputCalls[0].text, /\[DASHBOARD EVENT\] Context threshold crossed/,
      'single/ctx: context-threshold dashboard header rendered');
    assert.match(h.sendInputCalls[0].text, /Context: 80%/,
      'single/ctx: percentage line rendered');

    // Same bucket → no new event (BR-07 ordering verified end-to-end).
    h.bridge.onContextStatsChanged(statsAt(worker.id, 82));
    await h.settle();
    assert.equal(h.sendInputCalls.length, 1, 'single/ctx: 82% in same bucket — no new event');
    console.log('  single/ctx ✓ context threshold crossing → supervisor notified');
  } finally { h.dispose(); }
}

async function single_waiting_question_BR_13_20(): Promise<void> {
  // BR-13 + BR-20 end-to-end: an assistant-text with endsWithQuestion=true
  // routes through bridge → StatusMonitor.forceWaiting → monitor emits
  // statusChanged with waitingKind+waitingExcerpt → bridge filters/delivers
  // the "Agent waiting for input" payload.
  const h = makeHarness();
  try {
    const sup = makeSup('sup-int-4');
    const worker = makeWorker('w-int-q');
    h.agents.set(sup.id, sup);
    h.agents.set(worker.id, worker);

    h.bridge.onChatEvents(batchOf(worker.id, [
      assistantText(worker.id, {
        text: 'Long preamble explaining the situation. Did that resolve it?',
        turnComplete: true,
        endsWithQuestion: true,
      }),
    ]));
    await h.settle();

    assert.equal(worker.status, 'waiting',
      'single/waiting-q: agent record flipped to waiting');
    assert.equal(h.sendInputCalls.length, 1, 'single/waiting-q: one delivery');
    const payload = h.sendInputCalls[0].text;
    assert.match(payload, /\[DASHBOARD EVENT\] Agent waiting for input/,
      'single/waiting-q: waiting dashboard header rendered');
    assert.match(payload, /Waiting kind: question/,
      'single/waiting-q: kind=question (BR-13)');
    assert.match(payload, /Did that resolve it\?/,
      'single/waiting-q: excerpt is the tail of the assistant text');

    // BR-20 (negative side): waiting → working transition is suppressed.
    h.now.value += SUPERVISOR_EVENT_COOLDOWN_MS + 100;
    h.monitor.forceWorking(worker.id, 'user-input');
    await h.settle();
    assert.equal(h.sendInputCalls.length, 1,
      'single/waiting-q: waiting → working did NOT fire a notification (BR-20)');
    console.log('  single/waiting-q ✓ endsWithQuestion → forceWaiting → supervisor notified (BR-13, BR-20)');
  } finally { h.dispose(); }
}

async function single_waiting_ttyPattern_BR_14(): Promise<void> {
  // BR-14 end-to-end: real StatusMonitor.inferStatus runs the PromptPatternDetector
  // against a synthetic PTY ring tail. On match it calls forceWaiting → status
  // event → bridge delivers "[DASHBOARD EVENT] Agent waiting for input" with
  // waitingKind:'y-n' (PromptKind for `(y/N)` patterns; the monitor maps this
  // to the WaitingKind union directly).
  const h = makeHarness();
  try {
    const sup = makeSup('sup-int-5');
    const worker = makeWorker('w-int-tty');
    h.agents.set(sup.id, sup);
    h.agents.set(worker.id, worker);

    // PTY tail looks like a (y/N) prompt. Backdate lastOutput so the
    // 2s "PTY quiet" gate is satisfied.
    h.ringTails.set(worker.id, 'About to overwrite file. Continue? (y/N) ');
    h.lastOutput.set(worker.id, h.now.value - 5_000);

    // Drive a poll tick by reaching into the private inferStatus. The
    // dispatcher in `poll()` then no-ops because inferStatus already wrote
    // the status via forceWaiting (working → waiting), so the visible side
    // effects are the forceWaiting call's own statusChanged emission and
    // the resulting bridge delivery — exactly what we want to assert.
    const inferred = await (h.monitor as unknown as {
      inferStatus(a: Agent): Promise<string | null>;
    }).inferStatus(worker);
    assert.equal(inferred, 'waiting', 'single/waiting-tty: inferStatus returned waiting');
    await h.settle();

    assert.equal(worker.status, 'waiting',
      'single/waiting-tty: agent record flipped to waiting via forceWaiting');
    assert.equal(h.sendInputCalls.length, 1, 'single/waiting-tty: one delivery');
    const payload = h.sendInputCalls[0].text;
    assert.match(payload, /\[DASHBOARD EVENT\] Agent waiting for input/,
      'single/waiting-tty: waiting dashboard header rendered');
    assert.match(payload, /Waiting kind: y-n/,
      'single/waiting-tty: PTY-pattern detector reported kind=y-n (BR-14)');
    assert.match(payload, /\(y\/N\)/,
      'single/waiting-tty: excerpt is the matched prompt');
    console.log('  single/waiting-tty ✓ PTY (y/N) pattern → forceWaiting → supervisor notified (BR-14)');
  } finally { h.dispose(); }
}

// ── MS-01..MS-05 (multi-supervisor) ─────────────────────────────────
// Acceptance criteria for migration tickets P1-03 / P1-04. Gated behind
// MULTI_SUPERVISOR=1. Run with:
//   MULTI_SUPERVISOR=1 npm run test:supervisor
//
// Each MS-XX targets one or two seams from docs/SUPERVISOR_ROUTING_SEAMS.md
// and FAILS against today's bridge wiring (the harness defaults the
// `getSupervisorForWorker` dep to the production "workspace's newest"
// behavior, mirroring HEAD).
//
// Two MS-XX (MS-02, MS-04) test the bridge's internal queue state in
// isolation from the resolver and install a post-migration
// `supervisorId`-based resolver via `installSupervisorIdResolver` so the
// queue is the only thing being tested. The other three (MS-01, MS-03,
// MS-05) test the resolver itself against HEAD wiring and DO NOT install
// the helper — they fail because today's wiring picks workspace newest,
// not `worker.supervisorId`.

function installSupervisorIdResolver(h: Harness): void {
  h.setOwnerResolver((worker) => {
    const sid = (worker as Agent & { supervisorId?: string }).supervisorId;
    if (!sid) return null;
    return h.agents.get(sid) ?? null;
  });
}

async function MS_01_workerEventRoutesToOwningSupervisor(): Promise<void> {
  // MS-01 — Two supervisors A+B in the same workspace; worker owned by A
  // via `worker.supervisorId`; an idle event must reach A and NOT B.
  // Seams exercised: #3 (owner-lookup wiring), #4 (status_change owner call).
  //
  // Pre-migration failure: the harness default `getSupervisorForWorker`
  // mirrors `getSupervisorAgent(workspaceId)` (newest-by-workspace), so the
  // event routes to supB (newer), not the worker's actual owner supA. This
  // is the bug migration ticket P1-04 fixes by rewiring the dep to
  // `(worker) => worker.supervisorId ? getAgent(worker.supervisorId) : null`.
  const h = makeHarness();
  try {
    const supA = makeSup('sup-A', { workspaceId: 'ws-shared', createdAt: '2026-05-15T00:00:00Z' });
    const supB = makeSup('sup-B', { workspaceId: 'ws-shared', createdAt: '2026-05-16T00:00:00Z' });
    const worker = ownBy(makeWorker('w-MS-01', { workspaceId: 'ws-shared' }), supA.id);
    h.agents.set(supA.id, supA);
    h.agents.set(supB.id, supB);
    h.agents.set(worker.id, worker);
    // INTENTIONALLY no installSupervisorIdResolver — testing HEAD wiring.

    h.bridge.onChatEvents(batchOf(worker.id, [
      assistantText(worker.id, { turnComplete: true, text: 'done' }),
    ]));
    await h.settle();

    assert.equal(h.sendInputCalls.length, 1, 'MS-01: exactly one delivery');
    assert.equal(h.sendInputCalls[0].agentId, supA.id,
      'MS-01: event must route to supA (worker.supervisorId), not workspace newest supB');
    console.log('  MS-01 ✓ worker event routes to owning supervisor (post-migration)');
  } finally { h.dispose(); }
}

async function MS_02_perSupervisorQueueIsolation(): Promise<void> {
  // MS-02 — Both supervisors busy; both workers emit events; both queues
  // fill; drain to A does NOT drain B's queue (and consolidated payloads
  // do not mix owners). Seams: #7 (singleton queue → per-supervisor map),
  // #12 (per-queue buildConsolidatedPayload invariant).
  const h = makeHarness();
  try {
    const supA = makeSup('sup-A-q', { status: 'working' });
    const supB = makeSup('sup-B-q', { status: 'working', workspaceId: 'ws-B' });
    const workerA = ownBy(makeWorker('w-A-q', { title: 'WorkerA' }), supA.id);
    const workerB = ownBy(makeWorker('w-B-q', { workspaceId: 'ws-B', title: 'WorkerB' }), supB.id);
    h.agents.set(supA.id, supA);
    h.agents.set(supB.id, supB);
    h.agents.set(workerA.id, workerA);
    h.agents.set(workerB.id, workerB);
    installSupervisorIdResolver(h);

    h.bridge.onChatEvents(batchOf(workerA.id, [
      assistantText(workerA.id, { turnComplete: true }),
    ]));
    h.bridge.onChatEvents(batchOf(workerB.id, [
      assistantText(workerB.id, { turnComplete: true }),
    ]));
    await h.settle();

    assert.equal(h.sendInputCalls.length, 0,
      'MS-02: nothing sent while both supervisors are working');

    // Drain A only; B should still have its event queued.
    supA.status = 'idle';
    await h.bridge.drainPendingFor(supA.id);

    const aSends = h.sendInputCalls.filter(c => c.agentId === supA.id);
    const bSends = h.sendInputCalls.filter(c => c.agentId === supB.id);
    assert.equal(aSends.length, 1, 'MS-02: supA drained one consolidated batch');
    assert.equal(bSends.length, 0, 'MS-02: supB queue untouched by A drain');
    assert.doesNotMatch(aSends[0].text, /WorkerB/,
      'MS-02: A payload does not mention WorkerB (no cross-owner pollution in consolidated batch)');
    console.log('  MS-02 ✓ per-supervisor queue isolation on drain');
  } finally { h.dispose(); }
}

async function MS_03_perSupervisorThresholdIsolation(): Promise<void> {
  // MS-03 — Two workers under different supervisors (same workspace) each
  // cross 80%; each supervisor receives only its own worker's threshold
  // event. Per the ticket text, this also asserts "per-supervisor
  // `lastContextThreshold` state isolated" — that map is already per-worker
  // today, so the real failure surface is the routing seam.
  // Seams exercised: #3 (owner-lookup wiring), #5 (context_threshold call).
  //
  // Pre-migration failure: both events route to workspace's newest (supB),
  // so supA receives 0 events and supB receives 2.
  const h = makeHarness();
  try {
    const supA = makeSup('sup-A-t', { workspaceId: 'ws-shared', createdAt: '2026-05-15T00:00:00Z' });
    const supB = makeSup('sup-B-t', { workspaceId: 'ws-shared', createdAt: '2026-05-16T00:00:00Z' });
    const workerA = ownBy(makeWorker('w-A-t', { workspaceId: 'ws-shared', title: 'WorkerA' }), supA.id);
    const workerB = ownBy(makeWorker('w-B-t', { workspaceId: 'ws-shared', title: 'WorkerB' }), supB.id);
    h.agents.set(supA.id, supA);
    h.agents.set(supB.id, supB);
    h.agents.set(workerA.id, workerA);
    h.agents.set(workerB.id, workerB);
    // INTENTIONALLY no installSupervisorIdResolver — testing HEAD wiring.

    h.bridge.onContextStatsChanged(statsAt(workerA.id, 80));
    h.bridge.onContextStatsChanged(statsAt(workerB.id, 80));
    await h.settle();

    const aSends = h.sendInputCalls.filter(c => c.agentId === supA.id);
    const bSends = h.sendInputCalls.filter(c => c.agentId === supB.id);
    assert.equal(aSends.length, 1, 'MS-03: supA received exactly one threshold event (its own worker)');
    assert.equal(bSends.length, 1, 'MS-03: supB received exactly one threshold event (its own worker)');
    assert.match(aSends[0].text, /WorkerA/, 'MS-03: supA payload references WorkerA');
    assert.match(bSends[0].text, /WorkerB/, 'MS-03: supB payload references WorkerB');
    console.log('  MS-03 ✓ per-supervisor threshold delivery isolated (post-migration)');
  } finally { h.dispose(); }
}

async function MS_04_forgetAgentOnlyOwningQueue(): Promise<void> {
  // MS-04 — `forgetAgent` cleans only the OWNING supervisor's queue
  // entries; queues for other supervisors remain intact AND the drain
  // for the deleted worker's owner must not pick up another owner's
  // events. Seams exercised: #7 (singleton queue), #16 (forgetAgent
  // consequential edit).
  //
  // Pre-migration failure: there is one singleton queue. When supA
  // drains, it ships supB's queued event to supA because the queue is
  // shared. forgetAgent only filters by worker agentId, which is not
  // enough — the cross-owner pollution comes from drain, not forget.
  // Migration P1-03 splits the queue per-supervisor; both `drain` and
  // `forgetAgent` then operate on a single owner's scope.
  //
  // Uses different workspaces so the workspace-newest resolver still
  // routes correctly — isolating the failure to the queue, not routing.
  const h = makeHarness();
  try {
    const supA = makeSup('sup-A-f', { status: 'working' });
    const supB = makeSup('sup-B-f', { status: 'working', workspaceId: 'ws-B' });
    const workerA = ownBy(makeWorker('w-A-f', { title: 'WorkerA' }), supA.id);
    const workerB = ownBy(makeWorker('w-B-f', { workspaceId: 'ws-B', title: 'WorkerB' }), supB.id);
    h.agents.set(supA.id, supA);
    h.agents.set(supB.id, supB);
    h.agents.set(workerA.id, workerA);
    h.agents.set(workerB.id, workerB);
    installSupervisorIdResolver(h);

    // Both supervisors busy; both workers emit events that queue.
    h.bridge.onChatEvents(batchOf(workerA.id, [
      assistantText(workerA.id, { turnComplete: true }),
    ]));
    h.bridge.onChatEvents(batchOf(workerB.id, [
      assistantText(workerB.id, { turnComplete: true }),
    ]));
    await h.settle();

    // Forget A. Today's forgetAgent filters the singleton queue by
    // workerA.agentId, removing only A's event; B's event survives.
    h.bridge.forgetAgent(workerA.id);

    // Drain supA — should be empty under the post-migration per-supervisor
    // queue. Today the singleton queue still holds B's event and supA
    // drains it (wrong).
    supA.status = 'idle';
    await h.bridge.drainPendingFor(supA.id);
    const aSends = h.sendInputCalls.filter(c => c.agentId === supA.id);
    assert.equal(aSends.length, 0,
      'MS-04: supA queue cleaned (no cross-owner leak; B\'s event must not drain to A)');

    // Drain supB — B's event must still be deliverable.
    supB.status = 'idle';
    await h.bridge.drainPendingFor(supB.id);
    const bSends = h.sendInputCalls.filter(c => c.agentId === supB.id);
    assert.equal(bSends.length, 1, 'MS-04: supB drained its event after A was forgotten');
    assert.match(bSends[0].text, /WorkerB/, 'MS-04: B payload references WorkerB');
    console.log('  MS-04 ✓ forgetAgent scoped to owning supervisor; drain stays within owner');
  } finally { h.dispose(); }
}

async function MS_05_mcpLaunchedWorkerWithExplicitSupervisorId(): Promise<void> {
  // MS-05 — MCP-launched worker carries an explicit `supervisorId` (set
  // by the launching supervisor's MCP context). The bridge must route by
  // that ID, not by workspace's newest. Seams: #3 (resolver wiring) +
  // #15 (mcp-supervisor.js launch propagation — covered separately by the
  // migration ticket P1-06).
  //
  // Pre-migration failure: the workspace contains a newer supervisor
  // (e.g. one the user just spun up after the MCP-launched worker started),
  // so the workspace-newest resolver routes to supNewer; the worker is
  // effectively orphaned from its real owner supOlder.
  const h = makeHarness();
  try {
    const supOlder  = makeSup('sup-older', { workspaceId: 'ws-mcp', createdAt: '2026-05-10T00:00:00Z' });
    const supNewer  = makeSup('sup-newer', { workspaceId: 'ws-mcp', createdAt: '2026-05-16T00:00:00Z' });
    // The MCP-launched worker tags itself as owned by the OLDER supervisor.
    const worker = ownBy(
      makeWorker('w-mcp', { workspaceId: 'ws-mcp', title: 'McpWorker' }),
      supOlder.id,
    );
    h.agents.set(supOlder.id, supOlder);
    h.agents.set(supNewer.id, supNewer);
    h.agents.set(worker.id, worker);
    // INTENTIONALLY no installSupervisorIdResolver — testing HEAD wiring.

    h.bridge.onChatEvents(batchOf(worker.id, [
      assistantText(worker.id, { turnComplete: true }),
    ]));
    await h.settle();

    assert.equal(h.sendInputCalls.length, 1, 'MS-05: one delivery');
    assert.equal(h.sendInputCalls[0].agentId, supOlder.id,
      'MS-05: must route to launching supervisor (supOlder via worker.supervisorId), not workspace newest (supNewer)');
    console.log('  MS-05 ✓ MCP-launched worker routes by explicit supervisorId');
  } finally { h.dispose(); }
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('event-bridge.integration.test: running single-supervisor scenarios');
  await single_idle();
  await single_crash_BR_02b();
  await single_contextThreshold();
  await single_waiting_question_BR_13_20();
  await single_waiting_ttyPattern_BR_14();

  if (RUN_MS) {
    console.log('event-bridge.integration.test: MULTI_SUPERVISOR=1 — running MS-01..MS-05');
    // Each MS-XX runs independently so a failure in MS-02 does not mask the
    // status of MS-03..MS-05. Failures are expected today; the migration
    // tickets P1-03 / P1-04 flip them green. The runner still exits non-zero
    // at the end if any MS-XX failed.
    const msResults: Array<{ id: string; ok: boolean; err?: unknown }> = [];
    const msScenarios: Array<[string, () => Promise<void>]> = [
      ['MS-01', MS_01_workerEventRoutesToOwningSupervisor],
      ['MS-02', MS_02_perSupervisorQueueIsolation],
      ['MS-03', MS_03_perSupervisorThresholdIsolation],
      ['MS-04', MS_04_forgetAgentOnlyOwningQueue],
      ['MS-05', MS_05_mcpLaunchedWorkerWithExplicitSupervisorId],
    ];
    for (const [id, fn] of msScenarios) {
      try {
        await fn();
        msResults.push({ id, ok: true });
      } catch (err) {
        msResults.push({ id, ok: false, err });
        console.error(`  ${id} ✗ FAILED (expected pre-migration):`);
        if (err instanceof Error) {
          // Trim the assertion to first 3 lines for compact reporting.
          const msg = (err.stack ?? err.message ?? String(err)).split('\n').slice(0, 6).join('\n');
          console.error(msg.replace(/^/gm, '      '));
        } else {
          console.error('      ' + String(err));
        }
      }
    }
    const failed = msResults.filter(r => !r.ok);
    console.log(`event-bridge.integration.test: MS-XX summary — ${msResults.length - failed.length}/${msResults.length} passed (failures expected pre-migration)`);
    if (failed.length > 0) {
      console.log(`event-bridge.integration.test: ${failed.map(f => f.id).join(', ')} failed — acceptance criteria for P1-03 / P1-04`);
      process.exit(1);
    }
  } else {
    console.log('event-bridge.integration.test: MS-01..MS-05 SKIPPED (set MULTI_SUPERVISOR=1 to run)');
  }

  console.log('event-bridge.integration.test: all enabled scenarios passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
