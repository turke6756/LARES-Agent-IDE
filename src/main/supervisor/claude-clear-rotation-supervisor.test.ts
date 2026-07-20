// Supervisor-level /clear-rotation tests — exercise the REAL AgentSupervisor
// hook + stale + reconcile wiring (index.ts) end-to-end, with a Map-backed DB
// (better-sqlite3 can't load under a plain `node` runner) and a fake Claude
// reader registered into the real SessionLogDispatcher to control
// validateClearSuccessor.
//
// What this file proves that the pure / dispatcher / reader suites cannot:
//   - `applyHookStatusEvent` step-9 binds the hook's session id to THIS agent
//     and rotates only that agent — even when MANY active Claude agents share
//     ONE cwd (the architectural invariant of this app).
//   - Two same-cwd agents that /clear near-simultaneously each adopt their OWN
//     successor; the validator is never asked to bind A's candidate to B.
//   - The 'session-stale' handler is only a RETRY of a previously hook-bound
//     candidate, session-pinned so a late EOF for a rotated-away session no-ops.
//   - Reconcile rediscovery selects an agent-bound hook session id from the
//     durable spool (never cwd/slug/newest-file) and validates it before adopt.
//
//   npm run build:main
//   node dist/main/main/supervisor/claude-clear-rotation-supervisor.test.js

import assert from 'node:assert/strict';
import { patchApplyStatusTransition } from './test-helpers/patch-apply-transition';
import { AgentSupervisor, parseLatestClaudeHookSessionFromSpool } from './index';
import type { ParsedHookEvent } from './index';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';
import type { SessionEvent } from '../../shared/session-events';
import type { Agent, AgentStatus } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

interface AuditRow { agentId: string; type: string; payload: string }

// ── DB patch (mirrors multi-transport-matrix.test.ts, but updateAgentResume-
//    SessionId MUTATES the store so rotation is observable, and a no-op
//    deleteFileActivitiesForAgent so the rebind→agent-rebound handler doesn't
//    touch the unloadable real DB). ──────────────────────────────────────
function patchDb(agentsMap: Map<string, Agent>, audit: AuditRow[]): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'applyStatusTransition', 'updateAgentHookStatus', 'updateAgentPid', 'getAgent',
    'addEvent', 'updateAgentLastOutput', 'updateAgentExitCode',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent', 'addFileActivity',
    'updateAgentResumeSessionId', 'getWorkspace', 'createAgent',
    'getTeamMembership', 'getAgentTemplate', 'deleteFileActivitiesForAgent',
    'pruneFileActivitiesToRecentSessions',
    // Phase 1 lineage capture: maybeRotateClaudeSession now closes the outgoing
    // session and inserts the successor row. The Map-backed store has no real DB,
    // so stub these to no-ops (the pure/db suites cover their SQL).
    'closeAgentSession', 'insertAgentSession',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];

  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id); if (a) a.status = status;
  };
  db.updateAgentHookStatus = (id: string, hookStatus: NonNullable<Agent['hookStatus']>, lastHookEventAt?: number) => {
    const a = agentsMap.get(id);
    if (a) { a.hookStatus = hookStatus; if (lastHookEventAt !== undefined) a.lastHookEventAt = lastHookEventAt; }
  };
  db.updateAgentPid = () => {};
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = (id: string, type: string, payload?: string | null) => {
    audit.push({ agentId: id, type, payload: payload ?? '' });
  };
  db.updateAgentLastOutput = () => {};
  db.updateAgentExitCode = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  db.addFileActivity = () => null;
  db.updateAgentResumeSessionId = (id: string, sessionId: string) => {
    const a = agentsMap.get(id); if (a) a.resumeSessionId = sessionId;
  };
  db.getWorkspace = () => undefined;
  db.createAgent = () => { throw new Error('createAgent unused'); };
  db.getTeamMembership = () => null;
  db.getAgentTemplate = () => null;
  db.deleteFileActivitiesForAgent = () => {};
  db.pruneFileActivitiesToRecentSessions = () => ({ prunedRows: 0, prunedSessions: 0 });
  db.closeAgentSession = () => {};
  db.insertAgentSession = () => {};

  // §B3 — status writes route through applyStatusTransition; keep them in the fake.
  patchApplyStatusTransition(db as unknown as Record<string, unknown>);

  return () => { for (const k of keys) db[k] = orig[k]; };
}

// Fake Claude reader registered into the real dispatcher. validateClearSuccessor
// answers from an allow-map (currentSessionId -> set of valid candidate ids) and
// records every call so cross-binding can be asserted absent.
class FakeClaudeReader implements ChatLogReader {
  readonly provider = 'claude' as const;
  validSuccessors = new Map<string, Set<string>>();
  calls: Array<{ cur: string; cand: string }> = [];
  pollSession(_session: ChatLogReaderSession): SessionEvent[] { return []; }
  invalidatePath(_agentId: string): void {}
  drainStaleSignals(): never[] { return []; }
  validateClearSuccessor(_wd: string, cur: string, cand: string, _started?: string): boolean {
    this.calls.push({ cur, cand });
    return this.validSuccessors.get(cur)?.has(cand) ?? false;
  }
  allow(cur: string, cand: string): void {
    let set = this.validSuccessors.get(cur);
    if (!set) { set = new Set(); this.validSuccessors.set(cur, set); }
    set.add(cand);
  }
}

interface Env {
  supervisor: AgentSupervisor;
  agents: Map<string, Agent>;
  audit: AuditRow[];
  reader: FakeClaudeReader;
  cleanup(): void;
}

function makeEnv(initial: Array<Partial<Agent> & { id: string }>): Env {
  const agents = new Map<string, Agent>();
  const audit: AuditRow[] = [];
  const restoreDb = patchDb(agents, audit);
  for (const spec of initial) {
    agents.set(spec.id, makeAgent(spec.id, {
      provider: 'claude', isWorker: true, isSupervised: false, status: 'working',
      ...spec,
    }));
  }
  const supervisor = new AgentSupervisor();
  (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const reader = new FakeClaudeReader();
  // Register the fake into the real dispatcher so validateClearSuccessor('claude')
  // delegates here and rebindAgent → 'agent-rebound' fires the real handler.
  (supervisor as unknown as { sessionLogReader: { register(r: ChatLogReader): void } })
    .sessionLogReader.register(reader);
  return { supervisor, agents, audit, reader, cleanup: () => restoreDb() };
}

let tsCounter = 1_700_000_000_000;
function nextTs(): number { return ++tsCounter; }

/** A UserPromptSubmit `working` hook event carrying THIS agent's id + Claude's
 *  current session id (the candidate). */
function hook(agentId: string, sessionId: string, ts = nextTs()): ParsedHookEvent {
  return {
    agentId, state: 'working', source: 'hook-start', ts,
    hookEventName: 'UserPromptSubmit', turnId: `t-${ts}`, sessionId,
  } as ParsedHookEvent;
}

function applyHook(env: Env, agentId: string, sessionId: string, ts = nextTs()): string {
  return (env.supervisor as unknown as {
    applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
  }).applyHookStatusEvent(agentId, hook(agentId, sessionId, ts), 'spool');
}

/** Fire the real dispatcher 'session-stale' handler the supervisor registered. */
function emitStale(env: Env, agentId: string, staleSessionId: string, workingDirectory = 'C:\\shared'): void {
  (env.supervisor as unknown as { sessionLogReader: { emit(ev: string, p: unknown): void } })
    .sessionLogReader.emit('session-stale', {
      agentId, staleSessionId, workingDirectory, observedAt: nextTs(),
    });
}

function resume(env: Env, id: string): string | null { return env.agents.get(id)!.resumeSessionId; }
function rotatedEvents(env: Env, id: string): AuditRow[] {
  return env.audit.filter(r => r.agentId === id && r.type === 'clear_session_rotated');
}

const SHARED = 'C:\\shared';

// ── Supervisor hook/rotation matrix (plan §"Supervisor Hook/Rotation Tests") ──

test('1: many active claude agents share ONE cwd; hook {A,S_A} rotates ONLY A', () => {
  const env = makeEnv([
    { id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' },
    { id: 'B', workingDirectory: SHARED, resumeSessionId: 'curB' },
    { id: 'C', workingDirectory: SHARED, resumeSessionId: 'curC' },
  ]);
  try {
    env.reader.allow('curA', 'S_A');
    const result = applyHook(env, 'A', 'S_A');
    assert.equal(result, 'applied', 'the UserPromptSubmit hook applies');
    assert.equal(resume(env, 'A'), 'S_A', 'A rotated to its own successor');
    assert.equal(resume(env, 'B'), 'curB', 'B untouched');
    assert.equal(resume(env, 'C'), 'curC', 'C untouched');
    assert.equal(rotatedEvents(env, 'A').length, 1, 'one clear_session_rotated event for A');
  } finally { env.cleanup(); }
});

test('2: hook for A with a candidate the validator rejects → no rotation', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    // 'S_X' is NOT registered as a valid successor of 'curA'.
    const result = applyHook(env, 'A', 'S_X');
    assert.equal(result, 'applied', 'the hook still applies as a heartbeat');
    assert.equal(resume(env, 'A'), 'curA', 'unvalidated candidate → bar stays frozen, not wrong');
    assert.deepEqual(env.reader.calls, [{ cur: 'curA', cand: 'S_X' }], 'validator consulted exactly once');
  } finally { env.cleanup(); }
});

test('3: ordinary prompt hook with the SAME session id → no rotation, validator not called', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    // A normal (non-/clear) prompt: Claude's session id is unchanged.
    const result = applyHook(env, 'A', 'curA');
    assert.equal(result, 'applied');
    assert.equal(resume(env, 'A'), 'curA', 'no rotation for an ordinary same-session prompt');
    assert.deepEqual(env.reader.calls, [], 'candidate === current short-circuits before validation');
  } finally { env.cleanup(); }
});

test('4: ordinary prompt hook with a NEW non-/clear session id → validator false → no rotation', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    // A different session id but NOT a signed /clear root (validator says false).
    applyHook(env, 'A', 'resume-elsewhere');
    assert.equal(resume(env, 'A'), 'curA', 'a non-/clear successor is rejected');
    assert.deepEqual(env.reader.calls, [{ cur: 'curA', cand: 'resume-elsewhere' }]);
  } finally { env.cleanup(); }
});

test('5: two same-cwd agents /clear near-simultaneously (A then B) → A→S_A, B→S_B, no cross-bind', () => {
  const env = makeEnv([
    { id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' },
    { id: 'B', workingDirectory: SHARED, resumeSessionId: 'curB' },
  ]);
  try {
    env.reader.allow('curA', 'S_A');
    env.reader.allow('curB', 'S_B');
    applyHook(env, 'A', 'S_A');
    applyHook(env, 'B', 'S_B');
    assert.equal(resume(env, 'A'), 'S_A');
    assert.equal(resume(env, 'B'), 'S_B');
    // The validator was NEVER asked to bind A's candidate to B's session or v.v.
    const cross = env.reader.calls.filter(c =>
      (c.cur === 'curA' && c.cand === 'S_B') || (c.cur === 'curB' && c.cand === 'S_A'));
    assert.deepEqual(cross, [], 'no cwd-sibling cross-binding');
    assert.deepEqual(env.reader.calls, [
      { cur: 'curA', cand: 'S_A' },
      { cur: 'curB', cand: 'S_B' },
    ]);
  } finally { env.cleanup(); }
});

test('6: same setup, REVERSE delivery order (B then A) → still A→S_A, B→S_B, no cross-bind', () => {
  const env = makeEnv([
    { id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' },
    { id: 'B', workingDirectory: SHARED, resumeSessionId: 'curB' },
  ]);
  try {
    env.reader.allow('curA', 'S_A');
    env.reader.allow('curB', 'S_B');
    applyHook(env, 'B', 'S_B');
    applyHook(env, 'A', 'S_A');
    assert.equal(resume(env, 'A'), 'S_A');
    assert.equal(resume(env, 'B'), 'S_B');
    const cross = env.reader.calls.filter(c =>
      (c.cur === 'curA' && c.cand === 'S_B') || (c.cur === 'curB' && c.cand === 'S_A'));
    assert.deepEqual(cross, [], 'reverse order is equally safe');
  } finally { env.cleanup(); }
});

test('7: duplicate hook transport after a rotation → no second rotation (dedupe returns duplicate)', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    env.reader.allow('curA', 'S_A');
    const ev = hook('A', 'S_A');
    const apply = (e: ParsedHookEvent) => (env.supervisor as unknown as {
      applyHookStatusEvent: (id: string, e: ParsedHookEvent, t: 'http' | 'spool' | 'tmux-option') => string;
    }).applyHookStatusEvent('A', e, 'spool');

    assert.equal(apply(ev), 'applied');
    assert.equal(resume(env, 'A'), 'S_A', 'first delivery rotates');
    const callsAfterFirst = env.reader.calls.length;

    // The SAME event redelivered over a second transport: byte-identical dedupe
    // key → 'duplicate', step 9 not reached, no re-validation, no re-rotation.
    assert.equal(apply(ev), 'duplicate', 'second transport is deduped');
    assert.equal(env.reader.calls.length, callsAfterFirst, 'no extra validation on the duplicate');
    assert.equal(rotatedEvents(env, 'A').length, 1, 'still exactly one rotation');
  } finally { env.cleanup(); }
});

test('8: stale EOF for the OLD session AFTER a hook rotation → ignored (session-pinned)', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    env.reader.allow('curA', 'S_A');
    applyHook(env, 'A', 'S_A');
    assert.equal(resume(env, 'A'), 'S_A');
    const callsBefore = env.reader.calls.length;

    // A late EOF for the now-dead 'curA' file. staleSessionId 'curA' no longer
    // equals A's current session 'S_A' → decideClearRotation drops it before
    // ever validating.
    emitStale(env, 'A', 'curA');
    assert.equal(resume(env, 'A'), 'S_A', 'no re-rotation from a stale OLD-session EOF');
    assert.equal(env.reader.calls.length, callsBefore, 'stale-after-rotate never re-validates');
  } finally { env.cleanup(); }
});

test('9: stale EOF BEFORE the hook arrives → no rotation; the later hook rotates exactly', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    env.reader.allow('curA', 'S_A');
    // No hook yet → no pending candidate → stale retry is a safe no-op.
    emitStale(env, 'A', 'curA');
    assert.equal(resume(env, 'A'), 'curA', 'stale with no bound candidate does nothing');
    assert.deepEqual(env.reader.calls, [], 'no candidate → validator not called');

    // The hook then arrives and rotates exactly once.
    applyHook(env, 'A', 'S_A');
    assert.equal(resume(env, 'A'), 'S_A', 'hook rotates after the earlier stale no-op');
  } finally { env.cleanup(); }
});

test('10: stale EOF for an IDLE same-cwd sibling while A has a pending candidate → sibling no-ops', () => {
  const env = makeEnv([
    { id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' },
    { id: 'idle', workingDirectory: SHARED, resumeSessionId: 'curIdle' },
  ]);
  try {
    // A has a pending hook candidate (validator not yet true → not rotated).
    applyHook(env, 'A', 'S_A');
    assert.equal(resume(env, 'A'), 'curA', 'A not rotated (candidate not valid yet)');
    assert.equal((env.supervisor as unknown as {
      pendingClaudeClearCandidates: Map<string, string>;
    }).pendingClaudeClearCandidates.get('A'), 'S_A', 'A has a pending candidate bound');

    // The idle sibling's own file goes quiet. It has NO pending candidate, so
    // the stale retry can't borrow A's candidate (candidates are keyed by id).
    emitStale(env, 'idle', 'curIdle');
    assert.equal(resume(env, 'idle'), 'curIdle', 'idle sibling never rotates');
  } finally { env.cleanup(); }
});

// ── Reconcile rediscovery (plan §"Reconcile Rediscovery Tests") ──────────
//
// parseLatestClaudeHookSessionFromSpool is the pure selector reconcile uses to
// recover an agent-bound hook session id from the durable spool — never a
// cwd/slug/mtime/newest-file choice. Adoption still runs validateClearSuccessor.

function spoolLine(rec: Record<string, unknown>): string { return JSON.stringify(rec) + '\n'; }
function upsRecord(agentId: string, sessionId: string, ts: number): string {
  return spoolLine({ v: 1, agentId, state: 'working', source: 'hook-start', ts, hookEventName: 'UserPromptSubmit', turnId: `t-${ts}`, sessionId });
}
const LAUNCH = 1_700_000_500_000;

test('R1: two same-cwd agents — spool holds A=S_A and B=S_B → each parses to its OWN candidate', () => {
  const content =
    upsRecord('A', 'S_A', LAUNCH + 10) +
    upsRecord('B', 'S_B', LAUNCH + 20);
  assert.equal(parseLatestClaudeHookSessionFromSpool(content, 'A', LAUNCH), 'S_A');
  assert.equal(parseLatestClaudeHookSessionFromSpool(content, 'B', LAUNCH), 'S_B');
});

test('R2: spool holds only A → B parses to null (B stays on its old session)', () => {
  const content = upsRecord('A', 'S_A', LAUNCH + 10);
  assert.equal(parseLatestClaudeHookSessionFromSpool(content, 'A', LAUNCH), 'S_A');
  assert.equal(parseLatestClaudeHookSessionFromSpool(content, 'B', LAUNCH), null, 'no B record → null');
});

test('R3: a parsed candidate that fails validation → maybeRotateClaudeSession(rediscovery) no-ops', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    // Validator rejects 'resume-elsewhere' (not a signed /clear root).
    const rotated = (env.supervisor as unknown as {
      maybeRotateClaudeSession: (id: string, t: { kind: 'rediscovery'; candidateSessionId: string }) => boolean;
    }).maybeRotateClaudeSession('A', { kind: 'rediscovery', candidateSessionId: 'resume-elsewhere' });
    assert.equal(rotated, false, 'rediscovery validates exactly like a hook — false → no-op');
    assert.equal(resume(env, 'A'), 'curA');
  } finally { env.cleanup(); }
});

test('R4: stale PRE-launch A record + fresh POST-launch A record → only the post-launch one is selected', () => {
  const content =
    upsRecord('A', 'S_pre', LAUNCH - 60_000) +   // a previous pane occupant, before launch
    upsRecord('A', 'S_post', LAUNCH + 5_000);    // this launch
  // minTs gates out anything before (launch - skew). With minTs = LAUNCH the
  // pre-launch record is excluded; the post-launch one is returned.
  assert.equal(parseLatestClaudeHookSessionFromSpool(content, 'A', LAUNCH), 'S_post');
});

test('R5: malformed lines and foreign agent ids are skipped', () => {
  const content =
    'this is not json\n' +
    spoolLine({ v: 1, agentId: 'OTHER', state: 'working', hookEventName: 'UserPromptSubmit', ts: LAUNCH + 1, sessionId: 'S_other' }) +
    spoolLine({ v: 1, agentId: 'A', state: 'idle', hookEventName: 'Stop', ts: LAUNCH + 2 }) +        // wrong state/event
    spoolLine({ v: 1, agentId: 'A', state: 'working', hookEventName: 'UserPromptSubmit', ts: LAUNCH + 3 }) + // no sessionId
    '{ partial truncated line without newline at tail' +
    '\n' + upsRecord('A', 'S_good', LAUNCH + 4);
  assert.equal(parseLatestClaudeHookSessionFromSpool(content, 'A', LAUNCH), 'S_good',
    'only the well-formed A UserPromptSubmit record with a sessionId is selected');
});

test('R6: two /clears for A while the app was down → newest valid A session selected, then validated+adopted', () => {
  const env = makeEnv([{ id: 'A', workingDirectory: SHARED, resumeSessionId: 'curA' }]);
  try {
    const content =
      upsRecord('A', 'S_first', LAUNCH + 100) +
      upsRecord('A', 'S_second', LAUNCH + 200); // newest
    const candidate = parseLatestClaudeHookSessionFromSpool(content, 'A', LAUNCH);
    assert.equal(candidate, 'S_second', 'newest A hook session wins (newest-to-oldest scan, not file mtime)');

    // Reconcile then validates the rediscovered candidate against the OLD DB
    // session before adopting.
    env.reader.allow('curA', 'S_second');
    const rotated = (env.supervisor as unknown as {
      maybeRotateClaudeSession: (id: string, t: { kind: 'rediscovery'; candidateSessionId: string }) => boolean;
    }).maybeRotateClaudeSession('A', { kind: 'rediscovery', candidateSessionId: candidate! });
    assert.equal(rotated, true);
    assert.equal(resume(env, 'A'), 'S_second', 'adopted only after validateClearSuccessor passed');
    assert.deepEqual(env.reader.calls, [{ cur: 'curA', cand: 'S_second' }]);
  } finally { env.cleanup(); }
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
