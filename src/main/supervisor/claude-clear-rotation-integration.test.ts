// Claude /clear-rotation integration test — wires a REAL SessionLogDispatcher +
// ContextStatsMonitor + a FakeClaudeReader (provider 'claude') + a Map-backed
// agent store and installs the same handler chain the supervisor runs in
// production (index.ts):
//
//   hook (UserPromptSubmit, working, sessionId)
//     → pendingClaudeClearCandidates.set(agentId, sessionId)
//     → maybeRotateClaudeSession(agentId, { kind:'hook', candidateSessionId })
//   dispatcher 'session-stale'
//     → maybeRotateClaudeSession(agentId, { kind:'stale', staleSessionId,
//                                           candidateSessionId: pending })
//   maybeRotateClaudeSession → decideClearRotation(validateSuccessor=
//       dispatcher.validateClearSuccessor) → updateResumeSessionId
//       + dispatcher.rebindAgent → dispatcher 'agent-rebound'
//       → contextStatsMonitor.invalidateAgent
//
// The defining invariant under shared cwds: every rotation is driven by a
// candidate session id ALREADY bound to a specific agent (its own hook / its
// own stale retry), never discovered by a cwd/slug scan. So two active Claude
// agents in ONE cwd that /clear near-simultaneously each rotate to their OWN
// successor and the validator is NEVER asked to bind A's candidate to B.
//
// The real better-sqlite3 binding can't load under a plain `node` runner, so
// the DB role (getAgent / updateResumeSessionId) is played by a Map-backed
// store — the hermetic shape BUG-26's integration test established.
//
//   npm run build:main
//   node dist/main/main/supervisor/claude-clear-rotation-integration.test.js

import assert from 'node:assert/strict';
import { SessionLogDispatcher, type SessionStaleEvent } from './session-log-dispatcher';
import { ContextStatsMonitor } from './context-stats-monitor';
import { decideClearRotation, type ClearRotationAgent, type ClearRotationTrigger } from './claude-clear-rotation';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';
import type { SessionEvent, UsageEvent } from '../../shared/session-events';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

// Claude reader stub: emits queued events, drains a one-shot session-pinned
// stale signal, and answers validateClearSuccessor from an injectable map of
// currentSessionId → set of valid successor candidate ids. Crucially it
// validates the EXACT candidate it's handed — it never "discovers" a successor.
class FakeClaudeReader implements ChatLogReader {
  readonly provider = 'claude' as const;
  queue: SessionEvent[] = [];
  staleQueue: SessionStaleEvent[][] = [];
  /** currentSessionId -> set of candidate ids that validate as a successor. */
  validSuccessors = new Map<string, Set<string>>();
  pollSession(_session: ChatLogReaderSession): SessionEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  invalidatePath(_agentId: string): void {}
  drainStaleSignals(): SessionStaleEvent[] {
    return this.staleQueue.length ? this.staleQueue.shift()! : [];
  }
  validateClearSuccessor(_wd: string, currentSessionId: string, candidateSessionId: string, _started?: string): boolean {
    return this.validSuccessors.get(currentSessionId)?.has(candidateSessionId) ?? false;
  }
  /** Convenience: mark `cand` a valid successor of `cur`. */
  allow(cur: string, cand: string): void {
    let set = this.validSuccessors.get(cur);
    if (!set) { set = new Set(); this.validSuccessors.set(cur, set); }
    set.add(cand);
  }
}

function makeUsage(agentId: string, sessionId: string, uuid: string, percentage: number, inputTokens: number): UsageEvent {
  return {
    type: 'usage',
    uuid,
    timestamp: '2026-06-20T10:00:00.000Z',
    agentId,
    sessionId,
    model: 'claude-opus',
    inputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 100,
    cumulativeContextTokens: inputTokens + 100,
    contextWindowMax: 200_000,
    contextPercentage: percentage,
  };
}

function staleSignal(agentId: string, staleSessionId: string, workingDirectory: string): SessionStaleEvent {
  return { agentId, staleSessionId, workingDirectory, observedAt: 1_700_000_000_000 };
}

interface ValidateCall { agentId: string; cur: string; cand: string; }

// Map-backed DB stub + the production handler wiring (index.ts analogue).
function wire(initialAgents: ClearRotationAgent[]): {
  dispatcher: SessionLogDispatcher;
  monitor: ContextStatsMonitor;
  reader: FakeClaudeReader;
  store: Map<string, ClearRotationAgent>;
  rotatedTo: Map<string, string>;
  validateCalls: ValidateCall[];
  /** Hook analogue: a UserPromptSubmit(working) hook carrying THIS agent's id +
   *  Claude's current session id. */
  applyHook(agentId: string, sessionId: string): void;
} {
  const store = new Map<string, ClearRotationAgent>();
  for (const a of initialAgents) store.set(a.id, a);

  const reader = new FakeClaudeReader();
  const dispatcher = new SessionLogDispatcher(() =>
    [...store.values()].map(a => ({
      agentId: a.id,
      sessionId: a.resumeSessionId || '',
      workingDirectory: a.workingDirectory,
      provider: a.provider,
      startedAt: a.createdAt,
    })),
  );
  dispatcher.register(reader);

  const monitor = new ContextStatsMonitor(dispatcher as any);
  monitor.start();

  // Supervisor's 'agent-rebound' listener (index.ts) → invalidate stats.
  dispatcher.on('agent-rebound', ({ agentId }) => {
    monitor.invalidateAgent(agentId);
  });

  const pendingCandidates = new Map<string, string>();
  const rotatedTo = new Map<string, string>();
  const validateCalls: ValidateCall[] = [];

  // index.ts maybeRotateClaudeSession analogue.
  function maybeRotate(agentId: string, trigger: ClearRotationTrigger): boolean {
    const agent = store.get(agentId);
    if (!agent) return false;
    const successor = decideClearRotation({
      agent,
      trigger,
      validateSuccessor: (wd, cur, cand, started) => {
        validateCalls.push({ agentId, cur, cand });
        return dispatcher.validateClearSuccessor('claude', wd, cur, cand, started);
      },
    });
    if (!successor) return false;
    agent.resumeSessionId = successor; // updateAgentResumeSessionId
    pendingCandidates.delete(agentId);
    dispatcher.rebindAgent(agentId); // drops ring + offsets, emits agent-rebound
    rotatedTo.set(agentId, successor);
    return true;
  }

  // Supervisor's 'session-stale' listener (index.ts) — stale is a RETRY of a
  // previously hook-bound candidate; pinned to the session that went quiet.
  dispatcher.on('session-stale', (signal) => {
    const candidate = pendingCandidates.get(signal.agentId);
    maybeRotate(signal.agentId, {
      kind: 'stale',
      staleSessionId: signal.staleSessionId,
      candidateSessionId: candidate,
    });
  });

  // applyHookStatusEvent step-9 analogue: bind the hook's session id to THIS
  // agent and attempt an immediate rotation.
  function applyHook(agentId: string, sessionId: string): void {
    pendingCandidates.set(agentId, sessionId);
    maybeRotate(agentId, { kind: 'hook', candidateSessionId: sessionId });
  }

  return { dispatcher, monitor, reader, store, rotatedTo, validateCalls, applyHook };
}

function agent(id: string, cwd: string, sid: string): ClearRotationAgent {
  return { id, provider: 'claude', workingDirectory: cwd, resumeSessionId: sid, createdAt: '2026-06-20T09:00:00.000Z' };
}

test('1: end-to-end /clear via hook — stats high, hook rotates, bar clears, then refills small', () => {
  const { reader, store, monitor, dispatcher, rotatedTo, applyHook } =
    wire([agent('agent-1', 'C:\\repo', 'old')]);
  reader.allow('old', 'new');

  // Seed an old usage event → stats populated high.
  reader.queue.push(makeUsage('agent-1', 'old', 'old-usage', 72, 140_000));
  dispatcher.pollNow();
  const before = monitor.getStats('agent-1');
  assert.ok(before, 'stats populated from old session');
  assert.equal(before.contextPercentage, 72);
  assert.equal(before.sessionId, 'old');

  // The /clear hook fires carrying agent-1's id + the new session id.
  applyHook('agent-1', 'new');

  // Rotation happened: DB repointed + stats cleared via rebind.
  assert.equal(store.get('agent-1')!.resumeSessionId, 'new', 'resumeSessionId rotated to successor');
  assert.equal(rotatedTo.get('agent-1'), 'new');
  assert.equal(monitor.getStats('agent-1'), null, 'context bar cleared after rebind');

  // First usage from the new (post-clear) file repopulates the bar small.
  reader.queue.push(makeUsage('agent-1', 'new', 'new-usage', 2, 3_000));
  dispatcher.pollNow();
  const after = monitor.getStats('agent-1');
  assert.ok(after, 'bar refills from new session');
  assert.equal(after.sessionId, 'new');
  assert.equal(after.contextPercentage, 2, 'bar reset to a small value');
  assert.equal(after.turnCount, 1, 'turn count fresh after invalidate');
});

test('2: hook arrives before the successor is valid → no rotation; later stale retry rotates', () => {
  const { reader, store, monitor, dispatcher, rotatedTo, applyHook } =
    wire([agent('agent-1', 'C:\\repo', 'old')]);

  reader.queue.push(makeUsage('agent-1', 'old', 'u-old', 50, 100_000));
  dispatcher.pollNow();
  assert.ok(monitor.getStats('agent-1'));

  // Hook lands while Claude hasn't finished writing the signed successor head:
  // validateClearSuccessor returns false → no rotation, but the candidate is
  // bound to agent-1 for a later retry.
  applyHook('agent-1', 'new');
  assert.equal(rotatedTo.has('agent-1'), false, 'no rotation while candidate not yet valid');
  assert.equal(store.get('agent-1')!.resumeSessionId, 'old');

  // The successor head is now signed/valid, and the old file goes quiet (EOF).
  reader.allow('old', 'new');
  reader.staleQueue.push([staleSignal('agent-1', 'old', 'C:\\repo')]);
  dispatcher.pollNow();

  assert.equal(store.get('agent-1')!.resumeSessionId, 'new', 'stale retry adopts the now-valid candidate');
  assert.equal(rotatedTo.get('agent-1'), 'new');
  assert.equal(monitor.getStats('agent-1'), null, 'bar cleared by the stale-driven rebind');
});

test('3: two agents share ONE cwd, near-simultaneous hooks → A→S_A, B→S_B, never cross-bound', () => {
  const { reader, store, rotatedTo, validateCalls, applyHook } = wire([
    agent('agent-A', 'C:\\shared', 'curA'),
    agent('agent-B', 'C:\\shared', 'curB'),
  ]);
  reader.allow('curA', 'S_A');
  reader.allow('curB', 'S_B');

  // Both /clear within the same window; the hooks deliver in A,B order.
  applyHook('agent-A', 'S_A');
  applyHook('agent-B', 'S_B');

  assert.equal(store.get('agent-A')!.resumeSessionId, 'S_A', 'A adopts its own successor');
  assert.equal(store.get('agent-B')!.resumeSessionId, 'S_B', 'B adopts its own successor');
  assert.equal(rotatedTo.get('agent-A'), 'S_A');
  assert.equal(rotatedTo.get('agent-B'), 'S_B');

  // The validator was NEVER asked to bind A's candidate to B or vice-versa.
  const crossBound = validateCalls.filter(c =>
    (c.agentId === 'agent-A' && c.cand === 'S_B') ||
    (c.agentId === 'agent-B' && c.cand === 'S_A'));
  assert.deepEqual(crossBound, [], 'no cross-binding of a cwd sibling\'s candidate');
  // Each agent only ever validated its own candidate.
  assert.deepEqual(validateCalls, [
    { agentId: 'agent-A', cur: 'curA', cand: 'S_A' },
    { agentId: 'agent-B', cur: 'curB', cand: 'S_B' },
  ]);
});

test('4: same shared-cwd setup, REVERSE hook delivery order → still A→S_A, B→S_B, no cross-binding', () => {
  const { reader, store, rotatedTo, validateCalls, applyHook } = wire([
    agent('agent-A', 'C:\\shared', 'curA'),
    agent('agent-B', 'C:\\shared', 'curB'),
  ]);
  reader.allow('curA', 'S_A');
  reader.allow('curB', 'S_B');

  applyHook('agent-B', 'S_B'); // B first this time
  applyHook('agent-A', 'S_A');

  assert.equal(store.get('agent-A')!.resumeSessionId, 'S_A');
  assert.equal(store.get('agent-B')!.resumeSessionId, 'S_B');
  assert.equal(rotatedTo.get('agent-A'), 'S_A');
  assert.equal(rotatedTo.get('agent-B'), 'S_B');
  const crossBound = validateCalls.filter(c =>
    (c.agentId === 'agent-A' && c.cand === 'S_B') ||
    (c.agentId === 'agent-B' && c.cand === 'S_A'));
  assert.deepEqual(crossBound, [], 'reverse order is equally safe');
});

test('5: shared cwd — an idle sibling going stale does NOT rotate (candidates are keyed by agent id)', () => {
  const { reader, store, dispatcher, rotatedTo, applyHook } = wire([
    agent('agent-A', 'C:\\shared', 'curA'),
    agent('agent-idle', 'C:\\shared', 'curIdle'),
  ]);
  // A genuine successor exists for A; the idle sibling never /cleared.
  reader.allow('curA', 'S_A');
  applyHook('agent-A', 'S_A');
  assert.equal(rotatedTo.get('agent-A'), 'S_A');

  // The idle sibling's OWN file goes quiet (idle EOF). It has no pending
  // candidate → the stale retry is a safe no-op; it must NOT adopt S_A.
  reader.staleQueue.push([staleSignal('agent-idle', 'curIdle', 'C:\\shared')]);
  dispatcher.pollNow();

  assert.equal(rotatedTo.has('agent-idle'), false, 'idle sibling never rotates');
  assert.equal(store.get('agent-idle')!.resumeSessionId, 'curIdle', 'idle sibling session unchanged');
});

test('6: duplicate hook after a rotation → no second rotation (candidate now equals current)', () => {
  const { reader, store, rotatedTo, validateCalls, applyHook } =
    wire([agent('agent-1', 'C:\\repo', 'old')]);
  reader.allow('old', 'new');

  applyHook('agent-1', 'new');
  assert.equal(store.get('agent-1')!.resumeSessionId, 'new');
  const callsAfterFirst = validateCalls.length;

  // The same UserPromptSubmit redelivered over a second transport. The current
  // session is now 'new', so candidate === current → decideClearRotation bails
  // BEFORE validation; no second rotation, no extra validate call.
  applyHook('agent-1', 'new');
  assert.equal(rotatedTo.get('agent-1'), 'new', 'still the single rotation');
  assert.equal(store.get('agent-1')!.resumeSessionId, 'new');
  assert.equal(validateCalls.length, callsAfterFirst, 'duplicate hook does not re-validate');
});

test('7: stale EOF for the OLD session after a hook rotation is ignored (session-pinned)', () => {
  const { reader, store, dispatcher, rotatedTo, applyHook } =
    wire([agent('agent-1', 'C:\\repo', 'old')]);
  reader.allow('old', 'new');

  applyHook('agent-1', 'new'); // rotates: resumeSessionId now 'new'
  assert.equal(store.get('agent-1')!.resumeSessionId, 'new');

  // A late EOF for the now-dead 'old' file races in. Its staleSessionId 'old'
  // no longer equals the agent's current session 'new', so decideClearRotation
  // drops it — even though 'new' is still in pendingCandidates? No: the hook
  // rotation cleared the pending candidate. Either way: no-op.
  reader.staleQueue.push([staleSignal('agent-1', 'old', 'C:\\repo')]);
  dispatcher.pollNow();

  assert.equal(store.get('agent-1')!.resumeSessionId, 'new', 'no re-rotation from a stale OLD-session EOF');
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
