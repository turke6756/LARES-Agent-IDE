// Tests for the Pipeline B turn-latch behavior added in M2A (P1A-01).
// Covers BR-11, BR-16, BR-17, BR-18 from the agent-lifecycle hardening plan.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/status-monitor.test.js

import assert from 'node:assert/strict';
import { StatusMonitor } from './status-monitor';
import {
  makeStatusMonitorFakes,
  patchDatabaseModule,
  makeAgent,
} from './test-helpers/fake-status-deps';
import {
  IDLE_LATCH_TIMEOUT_MS,
  WAITING_LATCH_TIMEOUT_MS,
  WORKING_THRESHOLD_MS,
  WORKING_LATCH_MODEL_PENDING_MS,
  WORKING_LATCH_TOOL_PENDING_MS,
  WORKING_LATCH_THINKING_PENDING_MS,
  WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS,
  WORKING_LATCH_TOOL_PENDING_UNSUPERVISED_MS,
  WORKING_LATCH_THINKING_PENDING_UNSUPERVISED_MS,
  SUPERVISOR_WORKING_LATCH_MS,
  LAUNCH_SETTLE_TIMEOUT_MS,
  LAUNCH_SETTLE_OVERRUN_GRACE_MS,
  START_HOOK_SILENCE_WARN_MS,
  START_HOOK_RESEND_AFTER_MS,
  START_HOOK_RESEND_INTERVAL_MS,
  START_HOOK_RESEND_MAX_ATTEMPTS,
  HOOK_CANARY_WINDOW_MS,
  CONFIRM_WINDOW_FIRST_MS,
  CONFIRM_POLL_MS,
  MAX_SUBMIT_RETRIES,
} from '../../shared/constants';
import type { Agent } from '../../shared/types';
import type { StatusChangedEvent } from './status-events';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// Default worker fixture for inference-behavior tests. The shared `makeAgent`
// from fake-bridge-deps defaults to provider:'claude' + isSupervised:true.
// Post §12.5 the Class IV skip is gated on `isSupervised` (any provider), so
// any supervised fixture would short-circuit inference. Existing tests are
// about generic latch / TTL behavior and read more cleanly when run against
// a fixture whose inference is NOT short-circuited — unsupervised codex is
// the simplest such shape. Tests that specifically exercise the supervised
// lanes (Class IV, watchdog, supervisor short-latch) import makeAgent
// directly and set the supervision flags explicitly.
function makeWorker(id: string, overrides: Partial<Agent> = {}): Agent {
  return makeAgent(id, { provider: 'codex', isSupervised: false, ...overrides });
}

function makeMonitor(opts: {
  fakes: ReturnType<typeof makeStatusMonitorFakes>;
  agent: Agent;
  alive?: boolean;
  ringTails?: Map<string, string>;
}) {
  const { fakes, agent } = opts;
  const alive = opts.alive ?? true;
  fakes.agents.set(agent.id, agent);
  fakes.aliveOverride.set(agent.id, alive);
  // Default: PTY says "active right now" — we let tests override per scenario.
  fakes.lastOutputAt.set(agent.id, fakes.now.value);
  const ringTails = opts.ringTails ?? new Map<string, string>();
  const monitor = new StatusMonitor(
    async (a) => fakes.aliveOverride.get(a.id) ?? true,
    (id) => fakes.lastOutputAt.get(id) ?? 0,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
    (id) => ringTails.get(id) ?? '',
    // BUG-09 §3.5 — raw PTY signal. Defaults to `lastOutputAt` so legacy
    // tests behave as before; new dual-signal tests override
    // `lastRawOutputAt` directly.
    (id) => fakes.lastRawOutputAt.get(id) ?? fakes.lastOutputAt.get(id) ?? 0,
  );
  monitor.on('statusChanged', (payload: StatusChangedEvent) => {
    fakes.emissions.push(payload);
  });
  return monitor;
}

// Tiny accessor for the private inferStatus — the same shape `poll()` exercises.
function inferStatus(monitor: StatusMonitor, agent: Agent): Promise<string | null> {
  return (monitor as any).inferStatus(agent);
}

// ── BR-11 ────────────────────────────────────────────────────────────
test('BR-11: turnComplete → forceIdle fires even while statusHoldUntil is active', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Plant a hold 5s in the future to simulate a debounce window.
    (monitor as any).statusHoldUntil.set(agent.id, fakes.now.value + 5_000);

    monitor.forceIdle(agent.id, 'turnComplete');

    assert.equal(fakes.updates.length, 1, 'BR-11: status write happened');
    assert.equal(fakes.updates[0].status, 'idle');
    assert.equal(fakes.emissions.length, 1, 'BR-11: statusChanged emitted');
    assert.equal(fakes.emissions[0].status, 'idle');
    assert.equal(fakes.emissions[0].fromStatus, 'working');
    assert.equal(fakes.emissions[0].source, 'monitor');

    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'idle', 'BR-11: latch armed to idle');
  } finally {
    restore();
  }
});

test('forceIdle no-ops on terminal status (crashed)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'crashed', lastExitCode: 1 });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    monitor.forceIdle(agent.id, 'turnComplete');

    assert.equal(fakes.updates.length, 0, 'crashed → forceIdle is a no-op');
    assert.equal(fakes.emissions.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'no latch set on terminal');
  } finally {
    restore();
  }
});

test('forceIdle no-ops on transitional status (launching)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'launching' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    assert.equal(fakes.updates.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

test('BR-16 corollary (BUG-09 inverted): forceWorking overwrites the prior latch with a working entry', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    const idleLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(idleLatch && idleLatch.state === 'idle', 'idle latch set');

    // A real new turn arrives. Per BUG-09 §3.1 the latch is now a tagged
    // `working` entry rather than being deleted — chat-stream truth keeps
    // governing the agent across the Coalescing window that PTY can't see.
    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });
    const workingLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(workingLatch && workingLatch.state === 'working',
      'forceWorking installed a working latch');
    assert.equal(agent.status, 'working');
  } finally {
    restore();
  }
});

// ── Misc invariants ──────────────────────────────────────────────────
test('BUG-09 §3.1: forceWorking on already-working agent installs working latch (no DB write)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    // Seed a stale idle latch.
    (monitor as any).turnLatch.set(agent.id, { state: 'idle', setAt: fakes.now.value });

    monitor.forceWorking(agent.id, {
      source: 'tool-use',
      toolUseId: 'tu-1',
      ttlClass: 'tool-pending',
    });
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working',
      'BUG-09: forceWorking overwrites the stale idle latch with a working one');
    assert.equal(latch.outstandingToolIds.size, 1);
    assert.ok(latch.outstandingToolIds.has('tu-1'));
    assert.equal(fakes.updates.length, 0, 'no DB write when already working');
    assert.equal(fakes.emissions.length, 0, 'no event when already working');
  } finally {
    restore();
  }
});

// ── BUG-09 §3.1 / §3.7 (Bundle 1) ────────────────────────────────────

test('BUG-09 §3.1 / C7: forceWorking refreshes refreshedAt on an already-working latch', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });
    const first = monitor.getLatchSnapshot(agent.id);
    assert.ok(first && first.state === 'working');
    const refreshedAt1 = first.refreshedAt;

    fakes.now.value += 5_000;
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'X', ttlClass: 'tool-pending' });
    const second = monitor.getLatchSnapshot(agent.id);
    assert.ok(second && second.state === 'working');
    assert.ok(second.refreshedAt > refreshedAt1,
      'C7: refreshedAt advances on subsequent forceWorking calls');
    assert.equal(second.setAt, first.setAt,
      'setAt is preserved across refresh — only refreshedAt advances');
    assert.ok(second.outstandingToolIds.has('X'),
      'tool-use toolUseId is now in the outstanding set');
  } finally {
    restore();
  }
});

test('BUG-09 §3.1 / C8: forceIdle overwrites a working latch (does not delete)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    monitor.forceIdle(agent.id, 'turnComplete');

    const idleLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(idleLatch && idleLatch.state === 'idle',
      'C8: idle latch overwrote the working latch instead of deleting it');
  } finally {
    restore();
  }
});

test('BUG-09 §3.7: forgetAgent drops latch + statusHoldUntil', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    (monitor as any).statusHoldUntil.set(agent.id, fakes.now.value + 10_000);
    assert.ok(monitor.getLatchSnapshot(agent.id), 'latch seeded');
    assert.ok((monitor as any).statusHoldUntil.has(agent.id), 'hold seeded');

    monitor.forgetAgent(agent.id);

    assert.equal(monitor.getLatchSnapshot(agent.id), undefined, 'latch dropped');
    assert.ok(!(monitor as any).statusHoldUntil.has(agent.id), 'hold dropped');
  } finally {
    restore();
  }
});

test('latch invalidation: a second forceIdle/forceWaiting overwrites the prior latch state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceIdle(agent.id, 'turnComplete');
    const t1 = monitor.getLatchSnapshot(agent.id);
    assert.ok(t1 && t1.state === 'idle');

    fakes.now.value += 1_000;
    monitor.forceWaiting(agent.id, 'enter', 'Press Enter');
    const t2 = monitor.getLatchSnapshot(agent.id);
    assert.ok(t2 && t2.state === 'waiting' && t2.waitingExcerpt === 'Press Enter');
    assert.ok(t2.setAt > t1.setAt, 'latch setAt advances on overwrite');
  } finally {
    restore();
  }
});

// ── Hook-driven `waiting` (Notification hook) un-latch sequence ──────
// See plans/hook-driven-waiting-status.md. A Notification hook drives
// forceWaiting(agentId, 'notification', excerpt); the next UserPromptSubmit
// hook (forceWorking string-source / forceWorkingFromHook) overwrites the
// latch to working; the Stop hook (forceIdle) overwrites it to idle. The
// waiting latch entry carries waitingKind 'notification'.
test('hook waiting: forceWaiting notification arms a waiting latch + emits statusChanged(waiting, kind=notification)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWaiting(agent.id, 'notification', 'Bash tool requires permission');

    assert.equal(agent.status, 'waiting', 'agent record flipped to waiting');
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'waiting', 'waiting latch armed');
    assert.equal(latch.waitingKind, 'notification', 'latch carries kind notification');
    assert.equal(latch.waitingExcerpt, 'Bash tool requires permission');

    assert.equal(fakes.emissions.length, 1, 'one statusChanged emitted');
    const emit = fakes.emissions[0] as StatusChangedEvent;
    assert.equal(emit.status, 'waiting');
    assert.equal(emit.fromStatus, 'working');
    assert.equal(emit.source, 'monitor');
    assert.equal(emit.waitingKind, 'notification',
      'emission carries waitingKind notification for the supervisor payload');
    assert.equal(emit.waitingExcerpt, 'Bash tool requires permission');
  } finally {
    restore();
  }
});

test('hook waiting: UserPromptSubmit (forceWorking string-source) overwrites the waiting latch to working', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWaiting(agent.id, 'notification', 'Approve?');
    const waitingLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(waitingLatch && waitingLatch.state === 'waiting');

    // UserPromptSubmit hook path — the string-source overload routes to
    // forceWorkingFromHook, which overwrites the latch with a working entry.
    monitor.forceWorking(agent.id, 'user-input-submitted');

    const workingLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(workingLatch && workingLatch.state === 'working',
      'waiting latch overwritten by a working latch');
    assert.equal(agent.status, 'working', 'agent record flipped back to working');

    const workingEmits = fakes.emissions.filter(e => e.status === 'working');
    assert.equal(workingEmits.length, 1, 'one working transition fired (waiting → working)');
    assert.equal(workingEmits[0].fromStatus, 'waiting');
  } finally {
    restore();
  }
});

test('hook waiting: Stop (forceIdle) overwrites the waiting latch to idle', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWaiting(agent.id, 'notification', 'Continue?');
    assert.ok(monitor.getLatchSnapshot(agent.id)?.state === 'waiting');

    // Stop hook — forceIdle overwrites the waiting latch with an idle entry.
    monitor.forceIdle(agent.id, 'turnComplete');

    const idleLatch = monitor.getLatchSnapshot(agent.id);
    assert.ok(idleLatch && idleLatch.state === 'idle',
      'waiting latch overwritten by an idle latch');
    assert.equal(agent.status, 'idle', 'agent record flipped to idle');

    const idleEmits = fakes.emissions.filter(e => e.status === 'idle');
    assert.equal(idleEmits.length, 1, 'one idle transition fired (waiting → idle)');
    assert.equal(idleEmits[0].fromStatus, 'waiting');
  } finally {
    restore();
  }
});

// ── BUG-18 Changes 1, 2, 3 ───────────────────────────────────────────

// Removed §12.5: two BUG-18 Change 3 tests that asserted turnInFlight
// promotes the effective TTL to tool-pending past the model-pending
// ceiling. That promotion only lives in the supervised-non-supervisor
// branch of inferStatus (status-monitor.ts:689-692), which is no longer
// reachable now that the Class IV skip returns null for any supervised
// worker. The Change 3 latch-state recording (sticky turnInFlight, no
// auto-clear on refresh) is still covered by the two tests below.

test('BUG-18 Change 3: turnInFlight is sticky-true across refreshes that omit the flag', async () => {
  // The bridge sets turnInFlight=true on tool-use/task-started/non-terminal
  // assistant-text. Other refreshes (tool-result, user-text) don't set it.
  // Sticky semantics: once true, subsequent refreshes preserve it until
  // forceIdle clears the whole latch.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'task-started',
      ttlClass: 'model-pending',
      turnInFlight: true,
    });
    let latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working' && latch.turnInFlight === true);

    // A refresh without turnInFlight (e.g. tool-result) must NOT clear it.
    monitor.forceWorking(agent.id, {
      source: 'tool-result',
      resolvedToolUseId: 'X',
      ttlClass: 'tool-pending',
    });
    latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.turnInFlight, true,
      'turnInFlight stays true across a refresh that omits the flag');
  } finally {
    restore();
  }
});

test('BUG-18 Change 3: turnInFlight stays false when never set (no impact on legacy paths)', () => {
  // Regression guard: forceWorking calls that don't carry turnInFlight (e.g.
  // direct `notifyUserInputDelivered` from sendInput on a waiting agent)
  // must not silently flip the override on.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('w-1', { status: 'working' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, {
      source: 'user-input',
      ttlClass: 'model-pending',
    });
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working');
    assert.equal(latch.turnInFlight, false,
      'turnInFlight defaults to false when the caller omits the flag');
  } finally {
    restore();
  }
});

// Removed (liveness-only inferStatus): the "Tightened TTLs for unsupervised
// non-supervisor agents" cluster (model/tool/thinking-pending ceilings,
// outstanding-tool floor, turnInFlight non-promotion). inferStatus no longer
// reads the latch for alive agents — it returns null — so those TTL-ceiling
// assertions have no behavior to exercise. The latch write path itself stays
// covered by the forceWorking / getLatchSnapshot tests above.

// Removed §12.5: "supervised Codex still uses 900 s tool-pending" and
// "supervised Gemini still uses 900 s thinking-pending". Both are
// directly contradicted by the broadened Class IV skip — any supervised
// worker now bypasses inference entirely, so the supervised-tier TTL
// branch (status-monitor.ts:684) is no longer reachable for non-supervisor
// agents. The Class IV section below covers the new behavior.

test('unsupervised non-regression: supervised Claude agent does NOT pick up unsupervised ceilings (Plan 1 short-circuits)', async () => {
  // Originally written under Plan 2 to assert "supervised Claude retains
  // the 180 s supervised ceiling." Re-classified once Plan 1 landed: a
  // supervised Claude worker now hits the Class IV inference-skip at the
  // top of inferStatus and returns null (the latch-driven status wins).
  // The semantic intent is preserved — the unsupervised tightening still
  // must not leak into the supervised-Claude lane — but the verification
  // shape changed from "supervised TTL fires" to "no inference flip at all."
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'task-started', ttlClass: 'model-pending' });

    // Same setup as before — past unsupervised model-pending, inside the
    // old supervised model-pending. With Plan 1 the lane is now skipped.
    fakes.now.value += WORKING_LATCH_MODEL_PENDING_UNSUPERVISED_MS + 5_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Claude bypasses inference entirely (Plan 1 §2.1) — ' +
      'unsupervised tightening did not leak into this lane');
  } finally {
    restore();
  }
});

// ── Class IV inference-skip for supervised workers ─────────────────
// See plans/disable-inference-for-supervised-claude-workers.md +
// plans/class-iv-worker-hook-scaffold.md §12.5 (broadening). inferStatus
// returns null for `isSupervised` (any provider), letting the Stop-hook +
// notifyUserInputDelivered latch state become the sole truth source. The
// alive check above the short-circuit preserves done/crashed detection.
// Unsupervised workers and the supervisor itself keep their existing
// inference behavior. Gemini supervised workers also hit the skip even
// though their hook scaffold isn't landed yet (§12.2) — that's the
// intentional trade-off so missing scaffolds are visible, not masked.

test('Class IV: supervised Claude worker — inferStatus returns null (short-circuit)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    // No latch armed, PTY stale on both signals — under the unsupervised or
    // supervised codex/gemini lanes this would return 'idle'. With Plan 1
    // the lane is skipped and inference returns null (latch wins).
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Claude bypasses inference — null signals "no change" to the poll loop');
  } finally {
    restore();
  }
});

test('Class IV: supervised Claude worker — alive check still produces done on exit 0', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
      lastExitCode: 0,
    });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'done',
      'alive check runs above the Class IV short-circuit; done/crashed detection preserved');
  } finally {
    restore();
  }
});

test('Class IV: supervised Claude worker — alive check still produces crashed on non-zero exit', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
      lastExitCode: 137,
    });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, 'crashed',
      'crashed detection preserved for supervised Claude (alive check above the short-circuit)');
  } finally {
    restore();
  }
});

test('Class IV: supervised Codex worker — inference is now skipped (broadened §12.5)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-codex', {
      status: 'working',
      isSupervised: true,
      provider: 'codex',
    });
    const monitor = makeMonitor({ fakes, agent });

    // Even with a working-latch armed and PTY signals stale (which would
    // previously promote idle via inference), the Class IV skip now returns
    // null — the Stop-hook is the sole idle-truth source for codex too.
    monitor.forceWorking(agent.id, { source: 'tool-use', toolUseId: 'A', ttlClass: 'tool-pending' });
    fakes.now.value += 60_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Codex bypasses inference (Class IV gate broadened per §12.5)');
  } finally {
    restore();
  }
});

test('Class IV: supervised Gemini worker — inference is now skipped (broadened §12.5)', async () => {
  // Gemini has no hook scaffold yet (§12.2 follow-up), so a supervised
  // Gemini worker has NO idle-truth source after this broadening except
  // chat-stream/turn-complete events. The user explicitly accepts that —
  // they want missing scaffolds visible. Test asserts the skip semantics,
  // not the downstream consequence.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-gemini', {
      status: 'working',
      isSupervised: true,
      provider: 'gemini',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, { source: 'thinking', ttlClass: 'thinking-pending' });
    fakes.now.value += 300_000;
    fakes.lastOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null,
      'supervised Gemini bypasses inference (Class IV gate broadened per §12.5)');
  } finally {
    restore();
  }
});

// ── Liveness-only inferStatus contract ───────────────────────────────
// inferStatus is liveness-only except for agy's probe-mandated, demotion-only
// PTY-quiet fallback: transitional → null; not-alive → done/crashed; other live
// agents → null. The latch is bookkeeping and is not a generic inference input.

test('inferStatus returns null for an alive agent regardless of an armed idle/working/waiting latch', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    // idle latch armed
    const idleAgent = makeWorker('live-idle', { status: 'idle' });
    const m1 = makeMonitor({ fakes, agent: idleAgent });
    m1.forceIdle(idleAgent.id, 'turnComplete');
    assert.ok(m1.getLatchSnapshot(idleAgent.id)?.state === 'idle', 'idle latch armed');
    assert.equal(await inferStatus(m1, idleAgent), null,
      'alive + idle latch → inferStatus is a no-op (null)');

    // working latch armed
    const workingAgent = makeWorker('live-working', { status: 'working' });
    const m2 = makeMonitor({ fakes, agent: workingAgent });
    m2.forceWorking(workingAgent.id, { source: 'task-started', ttlClass: 'model-pending' });
    assert.ok(m2.getLatchSnapshot(workingAgent.id)?.state === 'working', 'working latch armed');
    // Even pushed well past any historical TTL, an alive agent infers null.
    fakes.now.value += WORKING_LATCH_TOOL_PENDING_UNSUPERVISED_MS + 60_000;
    fakes.lastOutputAt.set(workingAgent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    fakes.lastRawOutputAt.set(workingAgent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1_000);
    assert.equal(await inferStatus(m2, workingAgent), null,
      'alive + working latch (any age) → null');

    // waiting latch armed
    const waitingAgent = makeWorker('live-waiting', { status: 'waiting' });
    const m3 = makeMonitor({ fakes, agent: waitingAgent });
    m3.forceWaiting(waitingAgent.id, 'question', 'Are you sure?');
    assert.ok(m3.getLatchSnapshot(waitingAgent.id)?.state === 'waiting', 'waiting latch armed');
    assert.equal(await inferStatus(m3, waitingAgent), null,
      'alive + waiting latch → null');
  } finally {
    restore();
  }
});

test('inferStatus returns null for an alive agent even with a (y/N) ring tail (PTY pattern detection removed)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeWorker('live-yn', { status: 'working' });
    const ringTails = new Map<string, string>();
    ringTails.set(agent.id, 'Continue? (y/N) ');
    const monitor = makeMonitor({ fakes, agent, ringTails });

    // PTY long quiet — the deleted PromptPatternDetector would have fired
    // forceWaiting here. It must not now.
    fakes.lastOutputAt.set(agent.id, fakes.now.value - 5_000);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - 5_000);

    const inferred = await inferStatus(monitor, agent);
    assert.equal(inferred, null, 'a (y/N) ring tail no longer manufactures a waiting status');

    // inferStatus must not have armed a waiting latch or emitted waiting.
    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(!latch || latch.state !== 'waiting',
      'no waiting latch produced by inferStatus from the ring tail');
    assert.equal(fakes.emissions.filter((e) => e.status === 'waiting').length, 0,
      'no waiting emission produced by inferStatus from the ring tail');
  } finally {
    restore();
  }
});

test('Agy status: PreInvocation working stays working while hook/raw PTY evidence is fresh', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('agy-fresh', {
      provider: 'agy', isWorker: true, isSupervised: false, status: 'working',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookEventAt(agent.id, fakes.now.value);
    fakes.lastRawOutputAt.set(agent.id, fakes.now.value - WORKING_THRESHOLD_MS - 1);

    fakes.now.value += WORKING_THRESHOLD_MS - 1;
    assert.equal(await inferStatus(monitor, agent), null, 'fresh PreInvocation keeps the turn working');

    fakes.lastRawOutputAt.set(agent.id, fakes.now.value);
    fakes.now.value += WORKING_THRESHOLD_MS - 1;
    assert.equal(await inferStatus(monitor, agent), null, 'fresh raw PTY output keeps the turn working');
  } finally {
    restore();
  }
});

test('Agy status: an already-working worker demotes to idle after hook + raw PTY quiet', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('agy-quiet', {
      provider: 'agy', isWorker: true, isSupervised: false, status: 'working',
    });
    const monitor = makeMonitor({ fakes, agent });
    const stale = fakes.now.value - WORKING_THRESHOLD_MS;
    monitor.recordHookEventAt(agent.id, stale);
    fakes.lastRawOutputAt.set(agent.id, stale);

    assert.equal(await inferStatus(monitor, agent), 'idle');
  } finally {
    restore();
  }
});

test('Agy status: PTY activity never promotes idle, and quiet inference stays agy-only', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const idleAgy = makeAgent('agy-idle', {
      provider: 'agy', isWorker: true, isSupervised: false, status: 'idle',
    });
    const agyMonitor = makeMonitor({ fakes, agent: idleAgy });
    fakes.lastRawOutputAt.set(idleAgy.id, fakes.now.value);
    assert.equal(await inferStatus(agyMonitor, idleAgy), null, 'PTY bytes cannot start an agy turn');

    const quietCodex = makeAgent('codex-quiet', {
      provider: 'codex', isWorker: true, isSupervised: false, status: 'working',
    });
    const codexMonitor = makeMonitor({ fakes, agent: quietCodex });
    fakes.lastRawOutputAt.set(quietCodex.id, fakes.now.value - WORKING_THRESHOLD_MS - 1);
    assert.equal(await inferStatus(codexMonitor, quietCodex), null, 'other providers remain hook-owned');
  } finally {
    restore();
  }
});

test("inferStatus returns 'done' on exit 0 and 'crashed' on non-zero when not alive", async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const doneAgent = makeWorker('exit-0', { status: 'working', lastExitCode: 0 });
    const mDone = makeMonitor({ fakes, agent: doneAgent, alive: false });
    assert.equal(await inferStatus(mDone, doneAgent), 'done',
      'not alive + exit 0 → done');

    const crashedAgent = makeWorker('exit-1', { status: 'working', lastExitCode: 1 });
    const mCrashed = makeMonitor({ fakes, agent: crashedAgent, alive: false });
    assert.equal(await inferStatus(mCrashed, crashedAgent), 'crashed',
      'not alive + non-zero exit → crashed');
  } finally {
    restore();
  }
});

// Removed (liveness-only inferStatus): "Class IV: unsupervised Claude agent —
// inference still runs" and "Class IV: isSupervisor + provider Claude — still
// uses supervisor short-latch". Both asserted a non-null 'idle' inference for
// an alive agent via the (now-removed) unsupervised / supervisor short-latch
// lanes. inferStatus is liveness-only and returns null for any alive agent.

// ── Class IV §2.2 hook-silence watchdog (BUG-23 reframe) ────────────

/** Capture console.warn calls for the duration of a watchdog test. Restored
 *  in finally. Tests assert against the captured array. */
function captureWarn(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

/** Test seam — invoke the private watchdog directly. Mirrors the inferStatus
 *  accessor pattern above. */
function checkWatchdog(monitor: StatusMonitor, agent: Agent): void {
  (monitor as any).checkHookSilenceWatchdog(agent);
}

test('watchdog: supervised Claude idle >15 min after input delivered with NO hook ever fires a warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    // Input delivered 20 minutes ago; never any Stop-hook event.
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 1,
      'BUG-23 reframe: scaffold-broken signature (input in, no hook ever) fires once');
    assert.match(warn.warnings[0], /\[class-iv\]/, 'warning is tagged for Class IV scaffold');
    assert.match(warn.warnings[0], /w-claude/, 'warning identifies the agent');
    assert.match(warn.warnings[0], /no Stop-hook event has ever been recorded/,
      'warning explains the scaffold-broken signature directly');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: any prior hook recorded suppresses warning (scaffold works)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);
    // Hook fired ever, even long ago — scaffold is proven working.
    monitor.recordHookEventAt(agent.id, fakes.now.value - 16 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 0,
      'any prior hook proves scaffold works — watchdog stays silent');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: no input delivered yet → no warning (hook absence is expected pre-input)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
      createdAt: new Date(fakes.now.value - 60 * 60 * 1000).toISOString(),
    });
    const monitor = makeMonitor({ fakes, agent });

    // Agent has existed for an hour but never received input. No hook
    // expected; no warning warranted.
    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 0,
      'no input delivered → hook absence is expected → no warning');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: dedupes repeated polls within the cooldown window', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);
    fakes.now.value += 1_000;
    checkWatchdog(monitor, agent);
    fakes.now.value += 1_000;
    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 1,
      'three checks inside the cooldown produce a single warning');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: supervised Codex idle >15 min with NO hook fires a warning (broadened §12.5)', () => {
  // Codex now has a Stop-hook scaffold (§12.1) — the watchdog must catch a
  // codex-side scaffold break (missing .codex/config.toml, missing env, etc.)
  // the same way it catches a Claude-side break.
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-codex', {
      status: 'idle',
      isSupervised: true,
      provider: 'codex',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 1,
      'supervised Codex now also has a Stop-hook scaffold — watchdog fires on silence');
    assert.match(warn.warnings[0], /\[class-iv\]/, 'warning is tagged for Class IV scaffold');
    assert.match(warn.warnings[0], /supervised codex worker/,
      'warning attributes the silent-hook signal to codex specifically');
    assert.match(warn.warnings[0], /w-codex/, 'warning identifies the agent');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: unsupervised Claude is NOT watched (out of scope)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('u-claude', {
      status: 'idle',
      isSupervised: false,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);

    assert.equal(warn.warnings.length, 0,
      'unsupervised Claude has no hook scaffold — watchdog must not fire');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: status flipping out of idle clears the dedupe; back to idle re-arms', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordInputDelivered(agent.id, fakes.now.value - 20 * 60 * 1000);

    checkWatchdog(monitor, agent);
    assert.equal(warn.warnings.length, 1, 'first warning fires');

    // Status flips to working (the user manually intervened, or another
    // input went in) — must clear dedupe.
    agent.status = 'working';
    checkWatchdog(monitor, agent);
    assert.equal(warn.warnings.length, 1, 'no warning while working');

    // Back to idle with still no hook ever fired.
    agent.status = 'idle';
    fakes.now.value += 1_000;
    checkWatchdog(monitor, agent);
    assert.equal(warn.warnings.length, 2,
      'fresh idle re-entry with still no hook re-arms the warning');
  } finally {
    warn.restore();
    restore();
  }
});

test('watchdog: forgetAgent clears the hook-event + input-delivered + dedupe state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'idle',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordHookEventAt(agent.id, fakes.now.value);
    monitor.recordInputDelivered(agent.id, fakes.now.value);
    assert.equal(monitor.getLastHookEventAt(agent.id), fakes.now.value);

    monitor.forgetAgent(agent.id);
    assert.equal(monitor.getLastHookEventAt(agent.id), undefined,
      'forgetAgent drops the hook-event timestamp — no stale state across restarts');
    // Re-arming a watchdog test after forgetAgent should produce no warning
    // because lastInputDeliveredAt was cleared too.
    const warn = captureWarn();
    try {
      fakes.now.value += 20 * 60 * 1000;
      checkWatchdog(monitor, agent);
      assert.equal(warn.warnings.length, 0,
        'forgetAgent also clears lastInputDeliveredAt so no false warning fires');
    } finally {
      warn.restore();
    }
  } finally {
    restore();
  }
});

// ── BUG-23 launch settle timer + promoteFromLaunching ───────────────────

/** Test seam — invoke the private poll() once. */
async function pollOnce(monitor: StatusMonitor): Promise<void> {
  await (monitor as any).poll();
}

test('BUG-23: supervised Claude in launching → idle at settle (no hook fires)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Just before the budget — no promotion yet.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude - 1;
    await pollOnce(monitor);
    assert.equal(agent.status, 'launching', 'still launching just before budget');
    assert.equal(fakes.emissions.length, 0, 'no emission before budget');

    // Cross the budget threshold — should promote on the next tick.
    fakes.now.value += 2;
    await pollOnce(monitor);
    assert.equal(agent.status, 'idle', 'promoted to idle after settle');
    assert.equal(fakes.emissions.length, 1);
    assert.equal(fakes.emissions[0].status, 'idle');
    assert.equal(fakes.emissions[0].fromStatus, 'launching');
    assert.equal(fakes.emissions[0].source, 'monitor');
    // The audit row carries the source descriptor.
    const audit = fakes.audit.find(r => r.type === 'status_change');
    assert.ok(audit && audit.payload.includes('launch-settle'),
      'status_change audit row records the launch-settle source');
  } finally {
    restore();
  }
});

test('BUG-23: Stop hook arriving mid-settle promotes via hook path; settle no-ops next tick', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Half-way through the settle window: hook fires.
    fakes.now.value += Math.floor(LAUNCH_SETTLE_TIMEOUT_MS.claude / 2);
    const ok = monitor.promoteFromLaunching(agent.id, 'stop-hook');
    assert.equal(ok, true, 'hook promotion returns true');
    assert.equal(agent.status, 'idle', 'hook drove the agent to idle inside settle');
    const audit = fakes.audit.find(r => r.type === 'status_change');
    assert.ok(audit && audit.payload.includes('stop-hook'),
      'status_change audit row records the stop-hook source');
    const emissionsBefore = fakes.emissions.length;

    // Cross the budget. The settle check must NOT emit a second status_change.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude;
    await pollOnce(monitor);
    assert.equal(fakes.emissions.length, emissionsBefore,
      'launchedAt was cleared by promoteFromLaunching — settle timer no-ops');
  } finally {
    restore();
  }
});

test('BUG-23: non-supervised codex promotes at codex settle (25s default)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-codex', {
      status: 'launching',
      isSupervised: false,
      provider: 'codex',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.codex - 1;
    await pollOnce(monitor);
    assert.equal(agent.status, 'launching', 'still launching just before codex budget');

    fakes.now.value += 2;
    await pollOnce(monitor);
    assert.equal(agent.status, 'idle', 'promoted at codex settle budget');
    assert.equal(LAUNCH_SETTLE_TIMEOUT_MS.codex, 25_000,
      'codex default budget matches spec');
  } finally {
    restore();
  }
});

test('BUG-23: terminal exit during launch — clearLaunch wipes settle timer; no spurious promote on next tick', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    // Simulate "runner exited and the runner.on('exit') handler wrote crashed".
    // getActiveAgents excludes crashed/done, but we directly exercise
    // checkLaunchSettle's defensive behavior via clearLaunch.
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Crash happens mid-launch.
    agent.status = 'crashed';
    monitor.clearLaunch(agent.id);

    // Even if poll() were called against this agent, promotion must not fire
    // — agent is no longer launching, and the stamp was cleared.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude * 2;
    await pollOnce(monitor);
    assert.equal(agent.status, 'crashed', 'stays crashed; no promotion');
    const promoteEmissions = fakes.emissions.filter(e => e.status === 'idle');
    assert.equal(promoteEmissions.length, 0, 'no idle promotion emitted');
  } finally {
    restore();
  }
});

test('BUG-23: forgetAgent clears launchedAt + lastLaunchOverrunWarnAt', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    monitor.forgetAgent(agent.id);

    // After forgetAgent, the agent has no stamp. promoteFromLaunching from a
    // launch-settle source should still work as a logical promotion if the
    // agent is in 'launching' state — but checkLaunchSettle skips entirely
    // when no stamp is set (the "reconnect / no recordLaunch" lane), so no
    // promotion fires.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude * 3;
    await pollOnce(monitor);
    assert.equal(agent.status, 'launching',
      'forgetAgent dropped the stamp → settle check no-ops on the launching agent');
  } finally {
    restore();
  }
});

test('BUG-23: promoteFromLaunching refuses when not in launching status', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'working',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });

    const ok = monitor.promoteFromLaunching(agent.id, 'stop-hook');
    assert.equal(ok, false, 'guard blocks bypass when not in launching');
    assert.equal(agent.status, 'working', 'status unchanged');
    assert.equal(fakes.emissions.length, 0, 'no emission');
  } finally {
    restore();
  }
});

test('BUG-23: promoteFromLaunching with source="other" refuses (canForceTransition gate)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    const ok = monitor.promoteFromLaunching(agent.id, 'other');
    assert.equal(ok, false, 'only launch-settle and stop-hook bypass the guard');
    assert.equal(agent.status, 'launching', 'status unchanged');
  } finally {
    restore();
  }
});

test('BUG-23: settle-overrun grace fires the narrow timer-misbehaving warning', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', {
      status: 'launching',
      isSupervised: true,
      provider: 'claude',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);

    // Force the agent past budget + grace. To trigger the warning rather
    // than have promoteFromLaunching succeed and clear the stamp, we
    // pre-empt promotion by flipping the in-memory agent record's status
    // back to 'launching' right before poll (simulating a DB lag scenario).
    // Simpler: just verify checkLaunchSettle path warns when overrun is
    // present by calling it directly with a stamp deep in the past, then
    // assert the warning shape.
    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude + LAUNCH_SETTLE_OVERRUN_GRACE_MS + 100;
    // Re-stamp launch into the past so the elapsed delta is meaningful.
    // (recordLaunch defaults to now(); we need it stale.)
    (monitor as any).launchedAt.set(agent.id, fakes.now.value - (LAUNCH_SETTLE_TIMEOUT_MS.claude + LAUNCH_SETTLE_OVERRUN_GRACE_MS + 100));
    await pollOnce(monitor);

    assert.equal(agent.status, 'idle',
      'still promotes on the same tick (warning is belt-and-suspenders)');
    assert.ok(warn.warnings.length >= 1,
      'overrun warning emitted at least once');
    assert.ok(warn.warnings.some(w => w.includes('launch-settle overrun')),
      'narrow warning carries the bug-23 tag');
  } finally {
    warn.restore();
    restore();
  }
});

// ── Class IV UserPromptSubmit start-hook forceWorking + watchdog ──────

function checkStartHookSilence(monitor: StatusMonitor, agent: Agent): void {
  (monitor as any).checkStartHookSilence(agent);
}

test('forceWorking(source) string overload: idle → working flips status + arms working latch', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, 'hook-start');

    assert.equal(fakes.updates.length, 1, 'status write happened');
    assert.equal(fakes.updates[0].status, 'working');
    assert.equal(fakes.emissions.length, 1);
    assert.equal(fakes.emissions[0].status, 'working');
    assert.equal(fakes.emissions[0].fromStatus, 'idle');
    assert.equal(fakes.emissions[0].source, 'monitor');

    const latch = monitor.getLatchSnapshot(agent.id);
    assert.ok(latch && latch.state === 'working', 'working latch armed');
  } finally {
    restore();
  }
});

test('forceWorking(source) string overload: no-op on terminal status', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'crashed', isSupervised: true, provider: 'claude', lastExitCode: 1 });
    const monitor = makeMonitor({ fakes, agent, alive: false });

    monitor.forceWorking(agent.id, 'hook-start');

    assert.equal(fakes.updates.length, 0, 'crashed → forceWorking(source) is a no-op');
    assert.equal(fakes.emissions.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

test('forceWorking(source) string overload: no-op on transitional status (launching)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'launching', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.forceWorking(agent.id, 'hook-start');

    assert.equal(fakes.updates.length, 0);
    assert.equal(monitor.getLatchSnapshot(agent.id), undefined);
  } finally {
    restore();
  }
});

test('start-hook watchdog: supervised idle, input delivered ≥3s ago, no start hook → warns once + emits status-change', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);

    assert.equal(warn.warnings.length, 1, 'fired exactly once');
    assert.match(warn.warnings[0], /\[bug-10\]/, 'warning is tagged for the paste-race fix');
    assert.match(warn.warnings[0], /UserPromptSubmit/);

    const startEmissions = fakes.emissions.filter((e) => e.source === 'start-hook-silence-watchdog');
    assert.equal(startEmissions.length, 1, 'one watchdog event emitted');
    assert.equal(startEmissions[0].status, 'idle');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: dedupes per input delivery (no re-warn within the same turn)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);
    fakes.now.value += 1_500;
    checkStartHookSilence(monitor, agent);
    fakes.now.value += 1_500;
    checkStartHookSilence(monitor, agent);

    assert.equal(warn.warnings.length, 1, 'one warning across multiple polls within the same turn');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: fresh input delivery re-arms after a prior warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 1, 'first warning fires');

    fakes.now.value += 10_000;
    monitor.recordInputDelivered(agent.id, fakes.now.value);
    fakes.now.value += START_HOOK_SILENCE_WARN_MS + 500;
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 2, 'second input delivery re-arms the watchdog');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: start hook landing after input silences the warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    const inputAt = fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500);
    monitor.recordInputDelivered(agent.id, inputAt);
    monitor.recordStartHookEventAt(agent.id, inputAt + 100);

    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 0, 'a start-hook arrival silences the watchdog');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: prior Stop-hook does NOT satisfy a missed UserPromptSubmit', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    monitor.recordHookEventAt(agent.id, fakes.now.value);

    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 1,
      'a Stop-hook arrival cannot mask a missing UserPromptSubmit — the bug we are detecting');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: status !== idle → no warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'working', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);

    assert.equal(warn.warnings.length, 0, 'no warning when the dashboard is not lying (status != idle)');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: under the threshold → no warning', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS - 500));
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 0,
      'inside the START_HOOK_SILENCE_WARN_MS budget — too early to warn');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: unsupervised agents are NOT watched', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('u-claude', { status: 'idle', isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_SILENCE_WARN_MS + 500));
    checkStartHookSilence(monitor, agent);
    assert.equal(warn.warnings.length, 0,
      'unsupervised agents do not run the supervised hook scaffold — out of scope');
  } finally {
    warn.restore();
    restore();
  }
});

test('start-hook watchdog: forgetAgent clears the start-hook + dedupe state', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });

    monitor.recordStartHookEventAt(agent.id, fakes.now.value);
    assert.equal(monitor.getLastStartHookEventAt(agent.id), fakes.now.value);

    monitor.forgetAgent(agent.id);
    assert.equal(monitor.getLastStartHookEventAt(agent.id), undefined,
      'forgetAgent drops the start-hook timestamp');
  } finally {
    restore();
  }
});

// ── BUG-10 Enter-resend recovery (checkStartHookResend) ──────────────
/** Test seam — invoke the private resend recovery directly. */
function checkStartHookResend(monitor: StatusMonitor, agent: Agent): void {
  (monitor as any).checkStartHookResend(agent);
}

/** Wire a recording resubmit handler; returns the array it pushes agent ids into. */
function armResubmit(monitor: StatusMonitor): string[] {
  const resends: string[] = [];
  monitor.setResubmitHandler((id) => resends.push(id));
  return resends;
}

test('resend: claude worker idle ≥3s after input with no start hook → resends Enter', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [agent.id], 'exactly one Enter resend fired');
    assert.match(warn.warnings.join('\n'), /\[bug-10\] resending Enter/, 'logs the resend');
  } finally {
    warn.restore();
    restore();
  }
});

test('resend: no resend before START_HOOK_RESEND_AFTER_MS elapses', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS - 500));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'genuine hook still has time to round-trip — no resend yet');
  } finally {
    restore();
  }
});

test('resend: a UserPromptSubmit hook since the input cancels the resend', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    const inputAt = fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100);
    monitor.recordInputDelivered(agent.id, inputAt);
    monitor.recordStartHookEventAt(agent.id, inputAt + 50); // submit took
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'the start hook proves the submit landed — nothing to resend');
  } finally {
    restore();
  }
});

test('resend: working status (hook already flipped it) → no resend', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-claude', { status: 'working', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'working means the submit took — never resend');
  } finally {
    restore();
  }
});

test('resend: bounded at START_HOOK_RESEND_MAX_ATTEMPTS, spaced by the interval', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    // Hammer the watchdog every 1.5s well past the budget; only MAX attempts fire.
    for (let i = 0; i < 10; i++) {
      checkStartHookResend(monitor, agent);
      fakes.now.value += START_HOOK_RESEND_INTERVAL_MS;
    }

    assert.equal(resends.length, START_HOOK_RESEND_MAX_ATTEMPTS,
      `resends cap at ${START_HOOK_RESEND_MAX_ATTEMPTS} then defer to the warn-only watchdog`);
  } finally {
    warn.restore();
    restore();
  }
});

test('resend: a fresh input delivery re-arms the attempt budget', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const warn = captureWarn();
  try {
    const agent = makeAgent('w-claude', { status: 'idle', isWorker: true, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    // Exhaust the budget on turn 1.
    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    for (let i = 0; i < 10; i++) {
      checkStartHookResend(monitor, agent);
      fakes.now.value += START_HOOK_RESEND_INTERVAL_MS;
    }
    const afterTurn1 = resends.length;

    // Turn 2: new input delivery resets the counter.
    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.equal(resends.length, afterTurn1 + 1, 'a new turn gets a fresh resend budget');
  } finally {
    warn.restore();
    restore();
  }
});

test('resend: gemini worker is NOT resent (no UserPromptSubmit hook to gate on)', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('w-gemini', { status: 'idle', isWorker: true, isSupervised: false, provider: 'gemini' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'gemini has no start hook, so idle is not evidence of a dropped Enter');
  } finally {
    restore();
  }
});

test('resend: non-worker unsupervised agent is NOT resent', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('u-claude', { status: 'idle', isWorker: false, isSupervised: false, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    const resends = armResubmit(monitor);

    monitor.recordInputDelivered(agent.id, fakes.now.value - (START_HOOK_RESEND_AFTER_MS + 100));
    checkStartHookResend(monitor, agent);

    assert.deepEqual(resends, [], 'non-worker agents derive working from inference, not the hook');
  } finally {
    restore();
  }
});

// ── Launch-time hook canary (HOOK_SYSTEM_DESIGN.md §5.4 / B5) ──────────

// Drive a poll tick the same way the live loop does.
function poll(monitor: StatusMonitor): Promise<void> {
  return (monitor as any).poll();
}

test('canary: marks hook_status=broken after the window with no hook event', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cw-1', { provider: 'codex', isSupervised: true, status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value);

    // Before the window elapses: poll must not flip anything.
    await poll(monitor);
    assert.equal(fakes.hookUpdates.length, 0, 'no hook-status write before the window elapses');
    assert.ok(monitor.isHookCanaryArmed(agent.id), 'canary stays armed before the window');

    // Window elapses with no hook → broken.
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(fakes.hookUpdates.length, 1, 'canary writes hook_status exactly once');
    assert.equal(fakes.hookUpdates[0].agentId, agent.id);
    assert.equal(fakes.hookUpdates[0].hookStatus, 'broken');
    assert.ok(!monitor.isHookCanaryArmed(agent.id), 'canary disarms after firing');

    // The canary must NOT touch `status` (no status write to anything else).
    assert.ok(
      !fakes.updates.some((u) => u.agentId === agent.id),
      `canary must not change status; got updates ${JSON.stringify(fakes.updates)}`,
    );

    // A second poll must not re-fire.
    await poll(monitor);
    assert.equal(fakes.hookUpdates.length, 1, 'canary fires at most once per arm');
  } finally {
    restore();
  }
});

test('canary: WP2 — the broken flip emits hookStatusChanged for a DTO refresh', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cw-hsc', { provider: 'claude', isSupervised: true, status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });
    const emitted: Array<{ agentId: string }> = [];
    monitor.on('hookStatusChanged', (d) => emitted.push(d));

    monitor.recordHookCanary(agent.id, fakes.now.value);
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(emitted.length, 1, 'exactly one hookStatusChanged on the broken flip');
    assert.equal(emitted[0].agentId, agent.id);

    // Idempotent: a second poll neither re-flips nor re-emits.
    await poll(monitor);
    assert.equal(emitted.length, 1, 'no duplicate hookStatusChanged after disarm');
  } finally {
    restore();
  }
});

test('canary: a hook event before the window disarms it → never marked broken', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cw-2', { provider: 'codex', isSupervised: true, status: 'idle' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value);

    // A hook arrives inside the window — the supervisor's stampHookHealthy
    // calls clearHookCanary (emulated directly here).
    monitor.clearHookCanary(agent.id);
    assert.ok(!monitor.isHookCanaryArmed(agent.id), 'canary disarmed by the hook');

    // Window elapses; poll must NOT mark broken.
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);
    assert.equal(
      fakes.hookUpdates.filter((h) => h.hookStatus === 'broken').length,
      0,
      'a healthy hook before the window must prevent a broken verdict',
    );
  } finally {
    restore();
  }
});

test('canary: does not clobber a degraded (B2) hook_status', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    // B2 marked this codex worker degraded at launch; the canary was never
    // armed for it. Even if armed, the 'unknown'-only guard protects it.
    const agent = makeAgent('cw-3', { provider: 'codex', isSupervised: true, status: 'idle', hookStatus: 'degraded' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value);

    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(
      fakes.hookUpdates.filter((h) => h.hookStatus === 'broken').length,
      0,
      'canary must not overwrite a degraded status with broken',
    );
    assert.equal(agent.hookStatus, 'degraded', 'degraded status is preserved');
  } finally {
    restore();
  }
});

// ── Synchronous submit confirmation (plan §1 part 1, §2.3, §2.4, Q4) ─────
//
// confirmSubmission's POLL/WINDOW timing rides the injectable clock (advanced
// by a fake `sleep`); the CONFIRMATION COMPARISON
// (`getLastStartHookEventAt > priorStartHookAt`) is the Date.now-based recorded
// hook ts vs the pre-send baseline. These tests drive the fake clock + fire the
// start hook at chosen moments to exercise every branch.

interface ConfirmCtx {
  monitor: StatusMonitor;
  presses: { count: number };
  now: number;
}

/** Build a StatusMonitor wired for confirmSubmission tests: a fake `sleep`
 *  advances the fake clock and runs `onSleep`; the resubmit handler counts
 *  presses and runs `onPress`. */
function makeConfirmMonitor(
  fakes: ReturnType<typeof makeStatusMonitorFakes>,
  agent: Agent,
  opts: { onSleep?: (ctx: ConfirmCtx) => void; onPress?: (ctx: ConfirmCtx) => void } = {},
): { monitor: StatusMonitor; presses: { count: number } } {
  fakes.agents.set(agent.id, agent);
  fakes.aliveOverride.set(agent.id, true);
  const presses = { count: 0 };
  const monitor = new StatusMonitor(
    async () => true,
    (id) => fakes.lastOutputAt.get(id) ?? 0,
    (id) => fakes.agents.get(id) ?? null,
    () => fakes.now.value,
    () => '',
    (id) => fakes.lastRawOutputAt.get(id) ?? 0,
    async (ms: number) => {
      fakes.now.value += ms;
      opts.onSleep?.({ monitor, presses, now: fakes.now.value });
    },
  );
  monitor.setResubmitHandler(() => {
    presses.count++;
    opts.onPress?.({ monitor, presses, now: fakes.now.value });
  });
  return { monitor, presses };
}

test('confirm (a): submit confirmed inside the first window — no re-press', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-a', { provider: 'claude', isWorker: true, status: 'idle' });
    let sleepCount = 0;
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      onSleep: ({ monitor: m, now }) => {
        // Fire the start hook on the 2nd poll — well inside the 2000ms window.
        if (++sleepCount === 2) m.recordStartHookEventAt(agent.id, now);
      },
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, true, 'hook arriving in the first window confirms');
    assert.equal(presses.count, 0, 'no submit-only re-press when the first window confirms');
    assert.equal(monitor.isConfirmInFlight(agent.id), false, 'confirm-in-flight cleared on resolve');
  } finally {
    restore();
  }
});

test('confirm (b): submit confirmed on a retry window after a re-press', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-b', { provider: 'claude', isWorker: true, status: 'idle' });
    let firstPressDone = false;
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      onPress: () => { firstPressDone = true; },
      onSleep: ({ monitor: m, now }) => {
        // Only confirm once the first re-press has happened (i.e. in a retry
        // window, never the first window).
        if (firstPressDone) m.recordStartHookEventAt(agent.id, now);
      },
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, true, 'hook arriving after a re-press confirms');
    assert.equal(presses.count, 1, 'exactly one re-press was needed');
  } finally {
    restore();
  }
});

test('confirm (c): exhaustion → false after MAX_SUBMIT_RETRIES re-presses', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-c', { provider: 'claude', isWorker: true, status: 'idle' });
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      // Hook never fires.
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, false, 'no hook ever → exhausted → false');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES,
      `exactly MAX_SUBMIT_RETRIES (${MAX_SUBMIT_RETRIES}) submit-only re-presses`);
    assert.equal(monitor.isConfirmInFlight(agent.id), false, 'confirm-in-flight cleared even on exhaustion');
  } finally {
    restore();
  }
});

test('confirm (d): pre-send baseline race — a stale prior hook does NOT falsely confirm', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-d', { provider: 'claude', isWorker: true, status: 'idle' });
    const { monitor, presses } = makeConfirmMonitor(fakes, agent);
    // A hook from a PRIOR turn already exists at t=500. No NEW hook ever fires.
    monitor.recordStartHookEventAt(agent.id, 500);
    const prior = monitor.getLastStartHookEventAt(agent.id) ?? 0;
    assert.equal(prior, 500, 'baseline captures the prior hook');

    const confirmed = await monitor.confirmSubmission(agent.id, prior);
    assert.equal(confirmed, false,
      'a stale hook == baseline must not confirm (comparison is strict >, not >=)');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES, 'it retried rather than false-confirming on the stale hook');
  } finally {
    restore();
  }
});

test('confirm (e): the final retry IS polled before giving up', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-e', { provider: 'claude', isWorker: true, status: 'idle' });
    const { monitor, presses } = makeConfirmMonitor(fakes, agent, {
      onPress: ({ monitor: m, presses: p, now }) => {
        // Fire the hook only on the LAST re-press. If the loop pressed-then-
        // returned without polling the final press, this would never confirm.
        if (p.count === MAX_SUBMIT_RETRIES) m.recordStartHookEventAt(agent.id, now + 1);
      },
    });

    const confirmed = await monitor.confirmSubmission(agent.id, 0);
    assert.equal(confirmed, true, 'a hook landing on the final retry window still confirms');
    assert.equal(presses.count, MAX_SUBMIT_RETRIES, 'all retries used; the last one was polled');
  } finally {
    restore();
  }
});

test('confirm coordination: reactive resend skips contract providers + in-flight agents', () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('cc-coord', { provider: 'codex', isWorker: true, status: 'idle' });
    fakes.agents.set(agent.id, agent);
    fakes.aliveOverride.set(agent.id, true);
    let resends = 0;
    const monitor = makeMonitor({ fakes, agent });
    monitor.setResubmitHandler(() => { resends++; });

    // Arm the reactive-resend signature: input delivered long ago, still idle,
    // no start hook since.
    monitor.recordInputDelivered(agent.id, fakes.now.value - START_HOOK_RESEND_AFTER_MS - 1_000);

    // 1) Predicate says this agent is a contract provider → reactive path skips.
    monitor.setSubmitConfirmationPredicate(() => true);
    (monitor as any).checkStartHookResend(agent);
    assert.equal(resends, 0, 'contract providers re-press via the synchronous path only');

    // 2) Predicate false (fallback provider) but a confirm is in flight → still skip.
    monitor.setSubmitConfirmationPredicate(() => false);
    (monitor as any).confirmInFlight.add(agent.id);
    (monitor as any).checkStartHookResend(agent);
    assert.equal(resends, 0, 'no reactive re-press while a synchronous confirm is in flight');

    // 3) Predicate false + not in flight → the reactive fallback fires.
    (monitor as any).confirmInFlight.delete(agent.id);
    (monitor as any).checkStartHookResend(agent);
    assert.equal(resends, 1, 'non-contract provider falls back to the reactive resend');
  } finally {
    restore();
  }
});

// ── P1 §3 — hook-transport poller tick ordering (plan §5 E4) ─────────────

test('P1 tick ordering: transport poller runs BEFORE the canary — a spool SessionStart disarms it, no broken stamp that tick', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('tp-1', {
      status: 'idle',
      isWorker: true,
      isSupervised: false,
      provider: 'claude',
      hookStatus: 'unknown',
    });
    const monitor = makeMonitor({ fakes, agent });
    // Canary armed long enough ago that THIS tick would flip 'broken'.
    monitor.recordHookCanary(agent.id, fakes.now.value - HOOK_CANARY_WINDOW_MS - 1_000);

    // The poller simulates what the supervisor's spool drain does when the
    // spool holds a SessionStart for this agent: stamp healthy + disarm.
    // (The applier itself is unit-tested in agent-supervisor.test.ts; here
    // the contract under test is the ORDERING — poller before per-agent
    // canary evaluation in the same poll() tick.)
    monitor.setHookTransportPoller(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const db = require('../database') as { updateAgentHookStatus: (id: string, s: 'healthy', ts?: number) => void };
      db.updateAgentHookStatus(agent.id, 'healthy', fakes.now.value);
      monitor.clearHookCanary(agent.id);
    });

    await pollOnce(monitor);

    assert.equal(agent.hookStatus, 'healthy', 'the spool SessionStart won the tick');
    const brokenStamps = fakes.hookUpdates.filter((u) => u.hookStatus === 'broken');
    assert.equal(brokenStamps.length, 0,
      'the canary must NOT stamp broken on the same tick the transport delivered proof-of-load');
    assert.equal(monitor.isHookCanaryArmed(agent.id), false, 'canary disarmed');
  } finally {
    restore();
  }
});

test('P1 tick ordering CONTROL: without the transport poller the same tick flips broken (ordering is load-bearing)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('tp-2', {
      status: 'idle',
      isWorker: true,
      isSupervised: false,
      provider: 'claude',
      hookStatus: 'unknown',
    });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordHookCanary(agent.id, fakes.now.value - HOOK_CANARY_WINDOW_MS - 1_000);

    await pollOnce(monitor);

    const brokenStamps = fakes.hookUpdates.filter((u) => u.hookStatus === 'broken');
    assert.equal(brokenStamps.length, 1,
      'control: an expired canary with NO transport delivery flips broken — proving the ordering test is meaningful');
  } finally {
    restore();
  }
});

test('P1 tick ordering: the poller runs exactly ONCE per tick regardless of agent count', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const a1 = makeAgent('tp-n1', { status: 'idle', isWorker: true });
    const a2 = makeAgent('tp-n2', { status: 'idle', isWorker: true });
    const a3 = makeAgent('tp-n3', { status: 'idle', isWorker: true });
    const monitor = makeMonitor({ fakes, agent: a1 });
    for (const a of [a2, a3]) {
      fakes.agents.set(a.id, a);
      fakes.aliveOverride.set(a.id, true);
      fakes.lastOutputAt.set(a.id, fakes.now.value);
    }

    let pollerRuns = 0;
    monitor.setHookTransportPoller(() => { pollerRuns++; });

    await pollOnce(monitor);
    assert.equal(pollerRuns, 1, 'one tick, three agents → exactly one transport drain');
    await pollOnce(monitor);
    assert.equal(pollerRuns, 2, 'second tick → second drain');
  } finally {
    restore();
  }
});

test('P1 tick ordering: a throwing transport poller never breaks the poll loop', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const agent = makeAgent('tp-err', { status: 'launching', isSupervised: true, provider: 'claude' });
    const monitor = makeMonitor({ fakes, agent });
    monitor.recordLaunch(agent.id);
    monitor.setHookTransportPoller(() => { throw new Error('transport boom'); });

    fakes.now.value += LAUNCH_SETTLE_TIMEOUT_MS.claude + 1;
    await pollOnce(monitor);
    assert.equal(agent.status, 'idle',
      'per-agent work (settle promotion) still ran despite the poller throwing');
  } finally {
    console.warn = origWarn;
    restore();
  }
});

// ── WP7 (hook-absence-resilience) — launch resolution + ongoing PTY waiting ──

test('WP7: canary-broken while launching → promoteFromLaunching(hook-canary-degraded) to idle (no prompt)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('wp7-launch', { provider: 'claude', isWorker: true, status: 'launching', hookStatus: 'unknown' });
    const monitor = makeMonitor({ fakes, agent }); // empty ring tail → no prompt
    monitor.recordHookCanary(agent.id, fakes.now.value);
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(fakes.hookUpdates[0]?.hookStatus, 'broken', 'canary flips hook_status broken');
    assert.equal(agent.status, 'idle', 'the stuck launching spinner is resolved to idle');
    assert.ok(fakes.updates.some((u) => u.agentId === agent.id && u.status === 'idle'),
      'promoteFromLaunching wrote idle');
    assert.equal(monitor.getWaitingKind(agent.id), null, 'no blocking prompt → not waiting');
  } finally {
    restore();
  }
});

test('WP7: canary-broken while launching AT a trust dialog → launching→idle→waiting(approve)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('wp7-trust', { provider: 'claude', isWorker: true, status: 'launching', hookStatus: 'unknown' });
    const ringTails = new Map<string, string>([[agent.id, 'Do you trust the files in this folder?\n❯ 1. Yes  2. No']]);
    const monitor = makeMonitor({ fakes, agent, ringTails });
    monitor.recordHookCanary(agent.id, fakes.now.value);
    fakes.now.value += HOOK_CANARY_WINDOW_MS + 100;
    await poll(monitor);

    assert.equal(agent.status, 'waiting', 'a launch blocked on a trust dialog reads waiting, not a false idle');
    assert.equal(monitor.getWaitingKind(agent.id), 'approve', 'trust-dialog maps to the approve WaitingKind');
    const waitingEmit = fakes.emissions.find((e) => e.status === 'waiting');
    assert.ok(waitingEmit, 'a waiting statusChanged was emitted');
  } finally {
    restore();
  }
});

test('WP7: ongoing PTY waiting for a hooks-unavailable agent — stable prompt over two polls → waiting', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('wp7-pty', {
      provider: 'claude', isWorker: true, status: 'idle', hookStatus: 'broken', hooksUnavailable: true,
    });
    const ringTails = new Map<string, string>([[agent.id, 'Do you trust the files in this folder?']]);
    const monitor = makeMonitor({ fakes, agent, ringTails });

    // First poll records the signature but does not yet drive (stability gate).
    await poll(monitor);
    assert.notEqual(agent.status, 'waiting', 'first sighting must not drive status');
    // Second poll with the same signature drives waiting.
    await poll(monitor);
    assert.equal(agent.status, 'waiting', 'a stable prompt over two polls drives waiting');
    assert.equal(monitor.getWaitingKind(agent.id), 'approve');
  } finally {
    restore();
  }
});

test('WP7: ongoing PTY waiting is a NO-OP for a healthy hook-owned agent (regression guard)', async () => {
  const fakes = makeStatusMonitorFakes();
  const restore = patchDatabaseModule(fakes);
  try {
    const agent = makeAgent('wp7-healthy', {
      provider: 'claude', isWorker: true, status: 'idle', hookStatus: 'healthy', hooksUnavailable: false,
    });
    const ringTails = new Map<string, string>([[agent.id, 'Do you trust the files in this folder?']]);
    const monitor = makeMonitor({ fakes, agent, ringTails });

    await poll(monitor);
    await poll(monitor);
    assert.equal(agent.status, 'idle', 'healthy hooks own status — the classifier must not drive waiting');
    assert.equal(monitor.getWaitingKind(agent.id), null);
  } finally {
    restore();
  }
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
