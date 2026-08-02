// Context-brick Inc 4 — continuation lifecycle over a REAL (sql.js-backed)
// database (plans/context-brick-implementation-final.md §INCREMENT 4).
//
// Covers what api-identity.test.ts's route stubs deliberately don't — the SQL
// and supervisor-side mechanics themselves:
//   - attempt lifecycle: successorGen allocation (= agent gen + 1), one-open-
//     max at the DB level, open→committed→relaunched, and the atomic
//     commitContinuationRelaunch transaction (session + generation + close).
//   - brick append+supersede (soft superseded_at, NO hard delete),
//     getCurrentBrick, getLatestBrickForAttempt source filtering, byte_len.
//   - hasRunningOrchestrationForSupervisor status set ('starting'|'running'
//     block; stalled/aborted/complete/error don't).
//   - builder-gate three-clause matrix via buildContinuationBrickBlock
//     (resume kills; stale generation kills; committed-only kills; relaunched
//     + generation match renders; rendered A+B+C over the render cap → null).
//   - boot-reconcile discriminator (4.9): relaunched attempt at current gen +
//     session file ABSENT → re-drive ONLY the launch tail with the brick,
//     exactly once, no new attempt row; file PRESENT → plain resume.
//   - restartAgent regression: still resume=true on the OLD session, touches
//     no continuation state.
//
// better-sqlite3's native binding is built against Electron's ABI, so this
// injects the sql.js stand-in into require.cache BEFORE requiring ./database
// (same precedent as database.test.ts / selection-comments-db.test.ts).
//
//   npm run build:main
//   node dist/main/main/continuation-lifecycle.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── sql.js-backed better-sqlite3 stand-in (database.test.ts precedent) ───────

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};

let sqlJsCtor: new () => SqlJsDatabase;
let liveDb: FakeBetterSqlite | null = null;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
    liveDb = this;
  }
  pragma(_s: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

function rawOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  return (liveDb!.prepare(sql) as { get: (...p: unknown[]) => Record<string, unknown> | undefined }).get(...params);
}
function rawAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return (liveDb!.prepare(sql) as { all: (...p: unknown[]) => Record<string, unknown>[] }).all(...params);
}

// ── modules under test (loaded in the runner, after the cache injection) ─────

type Attempt = {
  id: string; dashboardAgentId: string; generation: number; startedAt: string;
  closedAt: string | null; status: string; reason: string | null; thresholdContextPct: number | null;
};
type Brick = {
  id: string; dashboardAgentId: string; handoffAttemptId: string; generation: number;
  note: string; noteSource: string; byteLen: number; writtenAt: string; supersededAt: string | null;
};
type DbAgentRow = {
  id: string; workspaceId: string; status: string; provider: string;
  continuationGeneration?: number; resumeSessionId?: string | null;
  workingDirectory: string; title: string; isSupervisor: boolean;
};
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string; path: string };
  createAgent(data: Record<string, unknown>): DbAgentRow;
  getAgent(id: string): DbAgentRow | null;
  getActiveAgents(): DbAgentRow[];
  updateAgentResumeSessionId(id: string, sessionId: string): void;
  setContinuationGeneration(agentId: string, gen: number): void;
  createContinuationHandoffAttempt(agentId: string, opts?: { reason?: string; thresholdContextPct?: number }): Attempt;
  freezeContinuationAttemptBinding(attemptId: string, binding: {
    planId: string | null; planItemId: null; source: 'continuation-carry';
  }): unknown;
  getContinuationAttempt(id: string): Attempt | null;
  getLatestContinuationAttempt(agentId: string, status?: string): Attempt | null;
  getOpenContinuationAttempt(agentId: string): Attempt | null;
  closeContinuationHandoffAttempt(id: string, status: string): void;
  insertContinuationBrick(input: { agentId: string; handoffAttemptId: string; generation: number; note: string; noteSource: 'tool' | 'scrape' }): string;
  getLatestBrickForAttempt(agentId: string, attemptId: string, opts?: { source?: 'tool' | 'scrape' }): Brick | null;
  getCurrentBrick(agentId: string): Brick | null;
  commitContinuationRelaunch(agentId: string, newSessionId: string, successorGen: number, attemptId: string): void;
  hasRunningOrchestrationForSupervisor(supervisorId: string): boolean;
  updateAgentStatus(id: string, status: string): void;
  // Slice 1 §3.3 — boot reconcile of orphaned 'open' attempts.
  getAllOpenContinuationAttempts(): Attempt[];
  reconcileStaleOpenContinuationAttempts(): {
    aborted: Array<{ agentId: string; attemptId: string; reason: string }>;
    resumable: Array<{ agentId: string; attemptId: string }>;
  };
  // Phase 1 — durable session lineage.
  insertAgentSession(agentId: string, generation: number, sessionId: string, cwd: string, provider: string): void;
  closeAgentSession(agentId: string, sessionId: string): void;
  getAgentSessions(agentId: string): AgentSessionRowT[];
  getPriorSession(agentId: string, beforeSessionRowId: number): AgentSessionRowT | null;
  backfillAgentSessionsFromEvents(): void;
  addEvent(agentId: string, eventType: string, payload?: string): void;
};
type AgentSessionRowT = {
  id: number; dashboardAgentId: string; generation: number; sessionId: string;
  workingDirectory: string; provider: string; startedAt: string;
  endedAt: string | null; jsonlPresent: number | null;
};
let dbm: DbModule;
// The db module namespace, for patching getActiveAgents in the reconcile tests
// (compiled named imports read through this object at call time).
let dbAny: Record<string, unknown>;

// AgentSupervisor is required lazily too (it transitively loads ./database).
type SupervisorLike = Record<string, unknown> & {
  restartAgent(agentId: string): Promise<void>;
  reconcile(): Promise<void>;
};
let makeSupervisor: () => SupervisorLike;

let wsId = '';
let wsPath = '';
let agentSeq = 0;
function makeDbAgent(over: Record<string, unknown> = {}): DbAgentRow {
  return dbm.createAgent({
    workspaceId: wsId,
    title: `cont-agent-${++agentSeq}`,
    roleDescription: '',
    workingDirectory: wsPath,
    command: 'claude --dangerously-skip-permissions',
    provider: 'claude',
    tmuxSessionName: null,
    autoRestartEnabled: false,
    logPath: path.join(wsPath, `agent-${agentSeq}.log`),
    ...over,
  });
}

// ── DB-level: attempt lifecycle ───────────────────────────────────────────────

test('attempt lifecycle: successorGen = gen+1, open→committed→relaunched, atomic commit bumps gen + session', () => {
  const agent = makeDbAgent();
  assert.equal(dbm.getAgent(agent.id)!.continuationGeneration ?? 0, 0, 'fresh agent starts at generation 0');

  const att1 = dbm.createContinuationHandoffAttempt(agent.id, { reason: 'context-pressure', thresholdContextPct: 80 });
  assert.equal(att1.generation, 1, 'attempt allocates successorGen = agent gen + 1');
  assert.equal(att1.status, 'open');
  assert.equal(att1.reason, 'context-pressure');
  assert.equal(att1.thresholdContextPct, 80);
  assert.ok(att1.startedAt, 'started_at stamped at open');
  assert.equal(att1.closedAt, null);

  dbm.closeContinuationHandoffAttempt(att1.id, 'committed');
  const committed = dbm.getContinuationAttempt(att1.id)!;
  assert.equal(committed.status, 'committed');
  assert.ok(committed.closedAt, 'closed_at stamped on close');

  dbm.commitContinuationRelaunch(agent.id, 'sess-new-1', att1.generation, att1.id);
  const after = dbm.getAgent(agent.id)!;
  assert.equal(after.continuationGeneration, 1, 'atomic commit bumps continuation_generation to successorGen');
  assert.equal(after.resumeSessionId, 'sess-new-1', 'atomic commit persists the fresh session id');
  assert.equal(dbm.getContinuationAttempt(att1.id)!.status, 'relaunched');

  const att2 = dbm.createContinuationHandoffAttempt(agent.id);
  assert.equal(att2.generation, 2, 'next attempt allocates gen+1 from the bumped agent row');
});

test('one-open-max at the DB level: second open attempt throws; close frees the slot', () => {
  const agent = makeDbAgent();
  const att1 = dbm.createContinuationHandoffAttempt(agent.id);
  assert.equal(dbm.getOpenContinuationAttempt(agent.id)!.id, att1.id);

  assert.throws(() => dbm.createContinuationHandoffAttempt(agent.id), /open attempt/);

  dbm.closeContinuationHandoffAttempt(att1.id, 'aborted');
  assert.equal(dbm.getOpenContinuationAttempt(agent.id), null);
  const att2 = dbm.createContinuationHandoffAttempt(agent.id);
  assert.equal(att2.generation, 1, "aborted attempt did NOT advance the generation — successorGen re-allocates from the unchanged agent row");
});

test('unknown agent cannot mint an attempt', () => {
  assert.throws(() => dbm.createContinuationHandoffAttempt('no-such-agent'), /no agent/);
});

// ── DB-level: bricks ─────────────────────────────────────────────────────────

test('brick append+supersede: prior row gets superseded_at, no hard delete; getCurrentBrick returns the survivor', () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);

  const brick1 = dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'first note', noteSource: 'tool',
  });
  const brick2 = dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'second note — supersedes', noteSource: 'tool',
  });

  const rows = rawAll('SELECT id, superseded_at FROM continuation_bricks WHERE dashboard_agent_id = ?', [agent.id]);
  assert.equal(rows.length, 2, 'append-only: both rows survive (no hard delete)');
  const r1 = rows.find(r => r.id === brick1)!;
  const r2 = rows.find(r => r.id === brick2)!;
  assert.ok(r1.superseded_at, 'prior brick is soft-superseded');
  assert.ok(!r2.superseded_at, 'latest brick is current');

  const current = dbm.getCurrentBrick(agent.id)!;
  assert.equal(current.id, brick2);
  assert.equal(current.note, 'second note — supersedes');
});

test('byte_len is UTF-8 bytes, not chars', () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  const note = '€€€'; // 3 chars, 9 bytes
  const id = dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation, note, noteSource: 'tool',
  });
  const brick = dbm.getLatestBrickForAttempt(agent.id, att.id)!;
  assert.equal(brick.id, id);
  assert.equal(brick.byteLen, 9);
});

test("getLatestBrickForAttempt source filter: {source:'tool'} never returns a scrape row", () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'scraped from terminal', noteSource: 'scrape',
  });
  assert.equal(dbm.getLatestBrickForAttempt(agent.id, att.id, { source: 'tool' }), null,
    'scrape-only attempt has NO tool-sourced authority row');
  assert.equal(dbm.getLatestBrickForAttempt(agent.id, att.id, { source: 'scrape' })!.noteSource, 'scrape');

  const toolId = dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'tool note', noteSource: 'tool',
  });
  assert.equal(dbm.getLatestBrickForAttempt(agent.id, att.id, { source: 'tool' })!.id, toolId);
});

// ── DB-level: orchestration gate helper ──────────────────────────────────────

test("hasRunningOrchestrationForSupervisor: 'starting'/'running' block; stalled/aborted/complete/error do not", () => {
  for (const [status, blocks] of [
    ['starting', true], ['running', true],
    ['stalled', false], ['aborted', false], ['complete', false], ['error', false],
  ] as [string, boolean][]) {
    const supId = `orch-sup-${status}`;
    liveDb!.prepare(
      `INSERT INTO orchestrations (run_id, name, mode, status, workspace_id, supervisor_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(`run-${status}`, 'gt', 'serial', status, wsId, supId);
    assert.equal(dbm.hasRunningOrchestrationForSupervisor(supId), blocks,
      `status '${status}' should ${blocks ? 'block' : 'not block'}`);
  }
});

test('initDatabase is idempotent (continuation ALTER/CREATE re-run does not throw)', () => {
  assert.doesNotThrow(() => dbm.initDatabase());
});

// ── Builder gate: buildContinuationBrickBlock three-clause matrix ────────────

type BrickInput = { handoffAttemptId: string; noteId: string; reason?: string; note: string; workspaceId: string };
function gateBlock(sup: SupervisorLike, agentId: string, resume: boolean): string | null {
  const s = sup as unknown as {
    buildContinuationBrickBlock(agent: DbAgentRow, resume: boolean): string | null;
  };
  return s.buildContinuationBrickBlock(dbm.getAgent(agentId)!, resume);
}

test('builder gate: resume=true never renders — even with a pending in-memory brick', () => {
  const sup = makeSupervisor();
  const agent = makeDbAgent();
  const pending = (sup as unknown as { pendingContinuationBricks: Map<string, BrickInput> }).pendingContinuationBricks;
  pending.set(agent.id, { handoffAttemptId: 'x', noteId: 'y', note: 'n', workspaceId: wsId });
  try {
    assert.equal(gateBlock(sup, agent.id, true), null, 'a crash-resume stays byte-identical: no brick');
  } finally {
    pending.delete(agent.id);
  }
});

test('builder gate: stale generation → no render (brick gen ≠ agent current gen)', () => {
  const sup = makeSupervisor();
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id); // gen 1
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'gen-1 note', noteSource: 'tool',
  });
  // Agent generation stays 0 (no relaunch happened) → brick gen 1 is stale-forward;
  // equally covers a PRIOR attempt's brick after the gen has moved past it.
  assert.equal(gateBlock(sup, agent.id, false), null);
});

test('builder gate: committed-but-never-relaunched attempt → no render even at matching generation', () => {
  const sup = makeSupervisor();
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'committed only', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  // Force the generation to match WITHOUT the atomic relaunch transaction:
  // the note was saved but the relaunch never cleared the re-check.
  dbm.setContinuationGeneration(agent.id, att.generation);
  assert.equal(gateBlock(sup, agent.id, false), null,
    "terminal gate status is 'relaunched' ONLY — 'committed' must not render");
});

test('builder gate: relaunched attempt + generation match → renders Blocks A+B+C from the DB fallback', () => {
  const sup = makeSupervisor();
  const agent = makeDbAgent({ isSupervisor: true });
  const att = dbm.createContinuationHandoffAttempt(agent.id, { reason: 'context-pressure' });
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'phase: writing tests; next: run the chain', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  dbm.commitContinuationRelaunch(agent.id, 'sess-cont-1', att.generation, att.id);

  const block = gateBlock(sup, agent.id, false);
  assert.ok(block, 'DB fallback renders with no in-memory pending brick');
  assert.match(block!, /CONTINUATION #1 — a session reset, not a new assignment/);
  assert.match(block!, /Handoff reason: context-pressure/);
  assert.match(block!, new RegExp(`dashboard_agent_id=${agent.id}`));
  assert.match(block!, new RegExp(`supervisor_id=${agent.id}`), 'supervisor echo present for supervisor agents');
  assert.match(block!, /phase: writing tests; next: run the chain/, 'Block C carries the note verbatim');

  assert.equal(gateBlock(sup, agent.id, true), null, 'the SAME state on a resume launch renders nothing');
});

test('builder gate: pending in-memory brick renders on !resume without any DB fallback conditions', () => {
  const sup = makeSupervisor();
  const agent = makeDbAgent();
  const pending = (sup as unknown as { pendingContinuationBricks: Map<string, BrickInput> }).pendingContinuationBricks;
  pending.set(agent.id, {
    handoffAttemptId: 'att-mem', noteId: 'brick-mem', reason: 'mid-flight',
    note: 'in-memory handoff', workspaceId: wsId,
  });
  try {
    const block = gateBlock(sup, agent.id, false);
    assert.ok(block);
    assert.match(block!, /in-memory handoff/);
  } finally {
    pending.delete(agent.id);
  }
});

test('builder gate: rendered A+B+C over CONTINUATION_BRICK_RENDER_MAX_BYTES → rejected (null), overflow event logged', () => {
  const sup = makeSupervisor();
  const agent = makeDbAgent();
  const pending = (sup as unknown as { pendingContinuationBricks: Map<string, BrickInput> }).pendingContinuationBricks;
  // 8300-byte note guarantees blocks A+B push the render past 8192. (The
  // in-memory path is the only way here — the 6144 note cap screens the DB path.)
  pending.set(agent.id, {
    handoffAttemptId: 'att-big', noteId: 'brick-big', note: 'a'.repeat(8300), workspaceId: wsId,
  });
  try {
    assert.equal(gateBlock(sup, agent.id, false), null, 'reject, never truncate');
    const ev = rawOne(
      "SELECT payload FROM events WHERE agent_id = ? AND event_type = 'continuation_brick_render_overflow'",
      [agent.id],
    );
    assert.ok(ev, 'overflow surfaced as a dashboard event');
  } finally {
    pending.delete(agent.id);
  }
});

// ── Boot-reconcile discriminator (4.9) ───────────────────────────────────────

type ReconcileHarness = {
  sup: SupervisorLike;
  tailCalls: [string, string][];
  resumeLaunches: { resume: unknown; sessionId: unknown; freshSession: unknown }[];
  restore(): void;
};
function harnessReconcile(agent: DbAgentRow, sessionFileExists: boolean): ReconcileHarness {
  const sup = makeSupervisor();
  const s = sup as Record<string, unknown>;
  const tailCalls: [string, string][] = [];
  const resumeLaunches: { resume: unknown; sessionId: unknown; freshSession: unknown }[] = [];
  // Shadow the private methods on the INSTANCE (own property wins over the
  // prototype) so reconcile()'s `this.` calls land in the spies.
  s.continuationLaunchTail = (id: string, sess: string) => { tailCalls.push([id, sess]); };
  s.launchWindowsAgent = async (_a: DbAgentRow, resume?: boolean, _p?: unknown, sessionId?: string, _o?: unknown, freshSession?: boolean) => {
    resumeLaunches.push({ resume, sessionId, freshSession });
  };
  s.retireStaleRootMcpConfig = () => {};
  s.findLatestClaudeHookSessionFromSpool = () => null;
  (s.sessionLogReader as Record<string, unknown>).sessionFileExists = () => sessionFileExists;
  const origActive = dbAny.getActiveAgents;
  dbAny.getActiveAgents = () => [dbm.getAgent(agent.id)];
  return { sup, tailCalls, resumeLaunches, restore: () => { dbAny.getActiveAgents = origActive; } };
}

test('reconcile: relaunched attempt at current gen + session file ABSENT → re-drive tail once, no new attempt row', async () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'mid-handoff note', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  dbm.commitContinuationRelaunch(agent.id, 'sess-minted-never-written', att.generation, att.id);
  const attemptsBefore = rawAll(
    'SELECT id FROM continuation_handoff_attempts WHERE dashboard_agent_id = ?', [agent.id]).length;

  const h = harnessReconcile(dbm.getAgent(agent.id)!, /* sessionFileExists */ false);
  try {
    await h.sup.reconcile();
    assert.deepEqual(h.tailCalls, [[agent.id, 'sess-minted-never-written']],
      'EXACTLY one launch-tail re-drive with the minted session');
    assert.equal(h.resumeLaunches.length, 0, 'plain-resume path not taken');
    const attemptsAfter = rawAll(
      'SELECT id FROM continuation_handoff_attempts WHERE dashboard_agent_id = ?', [agent.id]).length;
    assert.equal(attemptsAfter, attemptsBefore, 'reconcile replays the launch, never the state transition');
    assert.equal(dbm.getAgent(agent.id)!.continuationGeneration, att.generation, 'no second successorGen');
    assert.ok(rawOne(
      "SELECT id FROM events WHERE agent_id = ? AND event_type = 'continuation_redriven'", [agent.id]));
    // The brick the successor renders is still reachable via the DB fallback.
    assert.equal(dbm.getCurrentBrick(agent.id)!.note, 'mid-handoff note');
  } finally {
    h.restore();
  }
});

test('reconcile: session file PRESENT (healthy continuation) → plain resume=true, no re-drive', async () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'healthy note', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  dbm.commitContinuationRelaunch(agent.id, 'sess-healthy', att.generation, att.id);

  const h = harnessReconcile(dbm.getAgent(agent.id)!, /* sessionFileExists */ true);
  try {
    await h.sup.reconcile();
    assert.equal(h.tailCalls.length, 0, 'no continuation re-drive');
    assert.equal(h.resumeLaunches.length, 1);
    assert.equal(h.resumeLaunches[0].resume, true, 'byte-identical plain resume');
    assert.equal(h.resumeLaunches[0].sessionId, undefined, 'no session override');
    assert.equal(h.resumeLaunches[0].freshSession, undefined, 'no fresh-session flag');
  } finally {
    h.restore();
  }
});

test('reconcile: aborted-below-ceiling attempt (no relaunch) → plain resume, no brick path', async () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.closeContinuationHandoffAttempt(att.id, 'aborted');
  // Generation never advanced; session untouched.
  dbm.updateAgentResumeSessionId(agent.id, 'sess-original');

  const h = harnessReconcile(dbm.getAgent(agent.id)!, /* sessionFileExists */ false);
  try {
    await h.sup.reconcile();
    assert.equal(h.tailCalls.length, 0, 'aborted attempt never re-drives a continuation');
    assert.equal(h.resumeLaunches.length, 1);
    assert.equal(h.resumeLaunches[0].resume, true);
  } finally {
    h.restore();
  }
});

// ── WP2 pre-stage: continuationRelaunch + reconcile re-drive seed the kickoff ─

test('WP2 pre-stage: a successful continuationRelaunch seeds pendingInitialPrompts with the kickoff', async () => {
  const agent = makeDbAgent({ isSupervisor: true });
  const att = dbm.createContinuationHandoffAttempt(agent.id, { reason: 'context-pressure' });
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'phase: writing tests; next: run the chain', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');

  const sup = makeSupervisor();
  const s = sup as Record<string, unknown>;
  // Neutralize every side effect of the relaunch tail so only the seed remains
  // observable (the WP1 flush delay still ticks — expect ~2s wall time).
  s.stopAgent = async () => {};
  s.continuationLaunchTail = () => {};
  (s.monitor as Record<string, unknown>).forgetAgent = () => {};
  (s.sessionLogReader as Record<string, unknown>).rebindAgent = () => {};

  const brick = {
    handoffAttemptId: att.id, noteId: 'brick-prestage', reason: 'context-pressure',
    note: 'phase: writing tests; next: run the chain', workspaceId: wsId,
  };
  await (sup as unknown as { continuationRelaunch(id: string, b: unknown): Promise<void> })
    .continuationRelaunch(agent.id, brick);

  const pending = (s.pendingInitialPrompts as Map<string, { text: string; expiresAt: number }>).get(agent.id);
  assert.ok(pending, 'relaunch seeds a pending initial prompt for the successor');
  assert.match(pending!.text, /\[DASHBOARD\] Continuation pre-stage/,
    'the kickoff builder text rides the initial-prompt rail');
  assert.ok(pending!.expiresAt > Date.now(), 'the seed carries a live (future) TTL');
});

test('WP2 pre-stage §4.1: the boot-reconcile re-drive ALSO seeds the kickoff (reconcile decision pinned)', async () => {
  const agent = makeDbAgent();
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.freezeContinuationAttemptBinding(att.id, {
    planId: null, planItemId: null, source: 'continuation-carry',
  });
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'redrive note', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  dbm.commitContinuationRelaunch(agent.id, 'sess-redrive', att.generation, att.id);

  const h = harnessReconcile(dbm.getAgent(agent.id)!, /* sessionFileExists */ false);
  try {
    await h.sup.reconcile();
    assert.deepEqual(h.tailCalls, [[agent.id, 'sess-redrive']], 'the re-drive fired exactly once');
    const pending = (h.sup as unknown as {
      pendingInitialPrompts: Map<string, { text: string; expiresAt: number }>;
    }).pendingInitialPrompts.get(agent.id);
    assert.ok(pending, 'the reconciled re-drive re-seeds the kickoff (§4.1: yes)');
    assert.match(pending!.text, /\[DASHBOARD\] Continuation pre-stage/);
    assert.ok(pending!.expiresAt > Date.now(), 'the seed carries a live (future) TTL');
  } finally {
    h.restore();
  }
});

// ── restartAgent regression — resume path untouched by Inc 4 ─────────────────

test('restartAgent regression: resume=true on the OLD session, continuation state untouched', async () => {
  const agent = makeDbAgent();
  // Give the agent live continuation history so drift would be visible.
  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.insertContinuationBrick({
    agentId: agent.id, handoffAttemptId: att.id, generation: att.generation,
    note: 'n', noteSource: 'tool',
  });
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  dbm.commitContinuationRelaunch(agent.id, 'sess-old', att.generation, att.id);

  const sup = makeSupervisor();
  const s = sup as Record<string, unknown>;
  const launches: { resume: unknown; args: unknown[] }[] = [];
  s.launchWindowsAgent = async (...args: unknown[]) => { launches.push({ resume: args[1], args }); };

  await sup.restartAgent(agent.id);
  await sleep(1400); // restartAgent's launch rides a 1s timer

  assert.equal(launches.length, 1, 'exactly one relaunch');
  assert.equal(launches[0].resume, true, 'restart resumes — never a fresh session');
  assert.equal(launches[0].args[3], undefined, 'no sessionId override');
  assert.equal(launches[0].args[5], undefined, 'no freshSession flag');

  const after = dbm.getAgent(agent.id)!;
  assert.equal(after.resumeSessionId, 'sess-old', 'old session id untouched');
  assert.equal(after.continuationGeneration, att.generation, 'generation not advanced by restart');
  assert.equal(dbm.getContinuationAttempt(att.id)!.status, 'relaunched', 'attempt state untouched');
  const pending = (sup as unknown as { pendingContinuationBricks: Map<string, unknown> }).pendingContinuationBricks;
  assert.equal(pending.size, 0, 'restart never stages a brick');
});

// ── Phase 1: durable session lineage ─────────────────────────────────────────

test('lineage: gen-0 insert is idempotent (ON CONFLICT DO NOTHING) — re-observe never duplicates', () => {
  const agent = makeDbAgent();
  dbm.insertAgentSession(agent.id, 0, 'sess-A', wsPath, 'claude');
  dbm.insertAgentSession(agent.id, 0, 'sess-A', wsPath, 'claude'); // plain restart re-observes
  const rows = dbm.getAgentSessions(agent.id);
  assert.equal(rows.length, 1, 'a re-observed gen-0 session is a no-op, not a duplicate row');
  assert.equal(rows[0].sessionId, 'sess-A');
  assert.equal(rows[0].generation, 0);
  assert.equal(rows[0].endedAt, null, 'the sole live session is open');
});

test('lineage: commitContinuationRelaunch appends the successor and closes the outgoing', () => {
  const agent = makeDbAgent();
  // gen-0 live session, mirrored into resume_session_id as the launch path does.
  dbm.insertAgentSession(agent.id, 0, 'sess-g0', wsPath, 'claude');
  dbm.updateAgentResumeSessionId(agent.id, 'sess-g0');

  const att = dbm.createContinuationHandoffAttempt(agent.id);
  dbm.closeContinuationHandoffAttempt(att.id, 'committed');
  dbm.commitContinuationRelaunch(agent.id, 'sess-g1', att.generation, att.id);

  const rows = dbm.getAgentSessions(agent.id);
  assert.equal(rows.length, 2, 'continuation appended a lineage row');
  assert.equal(rows[0].sessionId, 'sess-g0', 'ordered oldest-first by started_at,id');
  assert.equal(rows[1].sessionId, 'sess-g1');
  assert.equal(rows[1].generation, att.generation, 'successor stamped at the attempt successorGen');
  assert.ok(rows[0].endedAt, 'outgoing session closed on transition');
  assert.equal(rows[1].endedAt, null, 'successor is the live session (open)');
});

test('lineage: two same-generation /clear siblings stay distinct, disambiguated by session_id', () => {
  const agent = makeDbAgent();
  // /clear does NOT bump the generation — both siblings carry generation 2.
  dbm.insertAgentSession(agent.id, 2, 'sess-clear-1', wsPath, 'claude');
  dbm.closeAgentSession(agent.id, 'sess-clear-1');
  dbm.insertAgentSession(agent.id, 2, 'sess-clear-2', wsPath, 'claude');

  const rows = dbm.getAgentSessions(agent.id);
  assert.equal(rows.length, 2, 'same-generation siblings are distinct rows (keyed on session_id)');
  assert.equal(rows[0].generation, rows[1].generation, 'generation repeats — it is an ordering hint only');

  // getPriorSession walks back by row id/started_at, never by generation.
  const prior = dbm.getPriorSession(agent.id, rows[1].id);
  assert.ok(prior, 'a predecessor exists');
  assert.equal(prior!.sessionId, 'sess-clear-1', 'prior resolves the earlier sibling despite equal generation');
  assert.equal(dbm.getPriorSession(agent.id, rows[0].id), null, 'the head of the lineage has no predecessor');
});

test('lineage PIN: a plain restart (unchanged resume_session_id) does NOT advance the lineage', async () => {
  const agent = makeDbAgent();
  // Simulate the gen-0 launch record + resume pointer.
  dbm.insertAgentSession(agent.id, 0, 'sess-restart', wsPath, 'claude');
  dbm.updateAgentResumeSessionId(agent.id, 'sess-restart');
  const before = dbm.getAgentSessions(agent.id).length;
  assert.equal(before, 1, 'one gen-0 row pre-restart');

  const sup = makeSupervisor();
  const s = sup as Record<string, unknown>;
  s.launchWindowsAgent = async () => { /* stub — restart resumes the old session */ };

  await sup.restartAgent(agent.id);
  await sleep(1400); // restartAgent's launch rides a 1s timer

  const after = dbm.getAgentSessions(agent.id);
  assert.equal(after.length, before, 'COUNT(*) FROM agent_sessions is UNCHANGED by a plain restart');
  assert.equal(after[0].sessionId, 'sess-restart', 'the gen-0 session id is untouched');
  assert.equal(dbm.getAgent(agent.id)!.resumeSessionId, 'sess-restart', 'restart stays byte-identical (same session)');
});

test('lineage backfill: reconstructs from events chronologically, stamps started_at from the event, tolerates the gen-0 gap', () => {
  const agent = makeDbAgent();
  // An agent that already continued twice + /clear'd BEFORE this feature shipped:
  // its gen-0 original is unrecoverable (events record the switch TO, never FROM).
  // Insert events out of insertion order but with explicit chronological payloads;
  // the backfill must order by the event timestamps, not by row id.
  dbm.addEvent(agent.id, 'continuation', JSON.stringify({ generation: 1, newSession: 'bf-g1' }));
  dbm.addEvent(agent.id, 'clear_session_rotated', 'bf-clear');
  dbm.addEvent(agent.id, 'continuation', JSON.stringify({ generation: 2, newSession: 'bf-g2' }));
  // Stamp deterministic ascending created_at so ordering is assertable.
  const evs = rawAll('SELECT id FROM events WHERE agent_id = ? ORDER BY id', [agent.id]);
  const ts = ['2026-01-01 00:00:01', '2026-01-01 00:00:02', '2026-01-01 00:00:03'];
  evs.forEach((e, i) => liveDb!.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(ts[i], e.id));

  dbm.backfillAgentSessionsFromEvents();

  const rows = dbm.getAgentSessions(agent.id);
  assert.equal(rows.length, 3, 'three switched-to sessions reconstructed (gen-0 gap accepted)');
  assert.deepEqual(rows.map(r => r.sessionId), ['bf-g1', 'bf-clear', 'bf-g2'], 'ordered by event timestamp');
  assert.deepEqual(rows.map(r => r.startedAt), ts, 'started_at stamped from the SOURCE event, not now()');
  // /clear inherits the running generation (1), not a bump; the later continuation lifts it to 2.
  assert.deepEqual(rows.map(r => r.generation), [1, 1, 2], '/clear does not bump generation; continuation does');
  assert.equal(rows[0].endedAt, ts[1], 'each session ended when the next began');
  assert.equal(rows[1].endedAt, ts[2]);
  assert.equal(rows[2].endedAt, null, 'the newest reconstructed session stays open');
  assert.equal(rows[0].jsonlPresent, null, 'backfilled rows mark jsonl_present unknown (NULL)');

  // Idempotency: a second backfill pass (e.g. next boot) changes nothing.
  dbm.backfillAgentSessionsFromEvents();
  assert.equal(dbm.getAgentSessions(agent.id).length, 3, 'per-agent guard + ON CONFLICT keeps backfill idempotent');
});

// ── Slice 1 §3.3: boot reconcile of orphaned 'open' attempts ─────────────────
//
// An 'open' row is owned by an in-memory watcher cycle that dies with the
// process. Left alone it 409s every future attempt-open, permanently and
// silently disabling handoff for that agent — the "I clicked the arrow and
// nothing happened" poison. The sweep is NOT a blanket abort: a row that has
// already earned kill authorization (a tool-source brick written after it
// opened) is exactly the brick-committed→relaunch window, and aborting it would
// destroy a note the agent worked to write AND burn an escape-budget abort.

/** Open an attempt, then (optionally) commit a tool brick for it. The sleep is
 *  load-bearing: written_at > started_at is the authorization predicate and
 *  NOW_MS_SQL has millisecond grain. */
async function openAttemptWithBrick(
  agentId: string,
  brick: { source: 'tool' | 'scrape' } | null,
): Promise<Attempt> {
  const att = dbm.createContinuationHandoffAttempt(agentId, { reason: 'boot-reconcile fixture' });
  if (brick) {
    await sleep(5);
    dbm.insertContinuationBrick({
      agentId, handoffAttemptId: att.id, generation: att.generation,
      note: 'committed note', noteSource: brick.source,
    });
  }
  return att;
}

test('boot reconcile: open row, agent alive at current generation, NO brick → aborted with a reason', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const att = await openAttemptWithBrick(agent.id, null);

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  const mine = res.aborted.find(a => a.attemptId === att.id);
  assert.ok(mine, 'the orphaned row was aborted');
  assert.match(mine!.reason, /no continuation note was committed/);
  assert.equal(dbm.getContinuationAttempt(att.id)!.status, 'aborted');
  assert.equal(dbm.getOpenContinuationAttempt(agent.id), null, 'the 409 poison is gone');

  const ev = rawOne(
    "SELECT payload FROM events WHERE agent_id = ? AND event_type = 'continuation_aborted'",
    [agent.id],
  );
  assert.ok(ev, 'the abort is recorded on the timeline');
  assert.match(String(ev!.payload), /abandoned across app restart/);
});

test('boot reconcile: open row WITH a tool brick written after started_at → left OPEN and reported resumable', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const att = await openAttemptWithBrick(agent.id, { source: 'tool' });

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  assert.ok(res.resumable.some(r => r.attemptId === att.id), 'reported resumable');
  assert.ok(!res.aborted.some(a => a.attemptId === att.id), 'NOT aborted — that would destroy a committed brick');
  assert.equal(dbm.getContinuationAttempt(att.id)!.status, 'open', 'the row stays open for the watcher to adopt');
  assert.equal(dbm.getOpenContinuationAttempt(agent.id)!.id, att.id);

  const ev = rawOne(
    "SELECT payload FROM events WHERE agent_id = ? AND event_type = 'continuation_attempt_resumable'",
    [agent.id],
  );
  assert.ok(ev, 'a continuation_attempt_resumable event was recorded');
});

test('boot reconcile: a SCRAPE brick does not authorize — the row is aborted like a note-less one', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const att = await openAttemptWithBrick(agent.id, { source: 'scrape' });

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  const mine = res.aborted.find(a => a.attemptId === att.id);
  assert.ok(mine, 'scrape is never kill-authorization (isKillAuthorized parity)');
  assert.match(mine!.reason, /no continuation note was committed/);
});

test('boot reconcile: a tool brick written BEFORE started_at does not authorize', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const att = await openAttemptWithBrick(agent.id, { source: 'tool' });
  // Back-date the brick behind the attempt: a leftover from a PRIOR attempt
  // must never be read as authorization for this one.
  liveDb!.prepare('UPDATE continuation_bricks SET written_at = ? WHERE handoff_attempt_id = ?')
    .run('2000-01-01 00:00:00.000', att.id);

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  assert.ok(res.aborted.some(a => a.attemptId === att.id), 'written_at must be strictly after started_at');
});

test('boot reconcile: agent crashed → aborted even WITH a committed brick', async () => {
  const agent = makeDbAgent();
  const att = await openAttemptWithBrick(agent.id, { source: 'tool' });
  dbm.updateAgentStatus(agent.id, 'crashed');

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  const mine = res.aborted.find(a => a.attemptId === att.id);
  assert.ok(mine, 'a terminal agent has nothing to hand off');
  assert.match(mine!.reason, /agent is crashed/);
  assert.equal(dbm.getContinuationAttempt(att.id)!.status, 'aborted');
});

test("boot reconcile: agent 'done' → aborted", async () => {
  const agent = makeDbAgent();
  const att = await openAttemptWithBrick(agent.id, { source: 'tool' });
  dbm.updateAgentStatus(agent.id, 'done');

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  assert.match(res.aborted.find(a => a.attemptId === att.id)!.reason, /agent is done/);
});

test('boot reconcile: stale generation → aborted (the row targets a superseded successor)', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const att = await openAttemptWithBrick(agent.id, { source: 'tool' });
  assert.equal(att.generation, 1);
  // The agent moved on (e.g. a later cycle relaunched it); this row's successor
  // generation is no longer the next one.
  dbm.setContinuationGeneration(agent.id, 5);

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  const mine = res.aborted.find(a => a.attemptId === att.id);
  assert.ok(mine, 'a stale-generation row is aborted even with a brick');
  assert.match(mine!.reason, /stale generation 1 \(successor is 6\)/);
});

test("boot reconcile: 'committed' / 'relaunched' / 'aborted' rows are untouched", async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const closed: Array<{ id: string; status: string; closedAt: string | null }> = [];
  for (const status of ['committed', 'relaunched', 'aborted']) {
    const att = dbm.createContinuationHandoffAttempt(agent.id);
    dbm.closeContinuationHandoffAttempt(att.id, status);
    const row = dbm.getContinuationAttempt(att.id)!;
    closed.push({ id: att.id, status: row.status, closedAt: row.closedAt });
  }

  const res = dbm.reconcileStaleOpenContinuationAttempts();
  for (const c of closed) {
    assert.ok(!res.aborted.some(a => a.attemptId === c.id), `${c.status} row was not swept`);
    assert.ok(!res.resumable.some(r => r.attemptId === c.id), `${c.status} row was not reported resumable`);
    const after = dbm.getContinuationAttempt(c.id)!;
    assert.equal(after.status, c.status, `${c.status} status unchanged`);
    assert.equal(after.closedAt, c.closedAt, `${c.status} closed_at unchanged`);
  }
});

test('boot reconcile is an EXPLICIT lifecycle op: a second initDatabase() does not run it', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const att = await openAttemptWithBrick(agent.id, null);

  dbm.initDatabase();   // schema init only — must NOT sweep
  assert.equal(dbm.getContinuationAttempt(att.id)!.status, 'open',
    'initDatabase runs more than once in some processes; the sweep must be a separate boot call');

  dbm.reconcileStaleOpenContinuationAttempts();
  assert.equal(dbm.getContinuationAttempt(att.id)!.status, 'aborted', 'the explicit call does sweep');
});

test('boot reconcile: a fresh attempt opens successfully afterwards (the poison is actually cleared)', async () => {
  const agent = makeDbAgent();
  dbm.updateAgentStatus(agent.id, 'idle');
  const stale = await openAttemptWithBrick(agent.id, null);
  // Before the sweep, the one-open-max rule is what 409s every future press.
  assert.throws(() => dbm.createContinuationHandoffAttempt(agent.id), /open attempt/);

  dbm.reconcileStaleOpenContinuationAttempts();
  assert.equal(dbm.getContinuationAttempt(stale.id)!.status, 'aborted');

  const fresh = dbm.createContinuationHandoffAttempt(agent.id);
  assert.equal(fresh.status, 'open');
  assert.equal(fresh.generation, 1, 'an aborted attempt never advanced the generation');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile, and make the
  // reconcile stagger negligible (read at supervisor module load).
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-lifecycle-'));
  process.env.APPDATA = tmpAppData;
  process.env.DASHBOARD_RECONCILE_STAGGER_MS = '1';

  // sql.js init is async; resolve the wasm module first, then inject the
  // stand-in and load ./database + ./supervisor (which requires ./database).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbAny = dbm as unknown as Record<string, unknown>;
  dbm.initDatabase();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const supIndex = require('./supervisor/index') as { AgentSupervisor: new () => SupervisorLike };
  makeSupervisor = () => {
    const s = new supIndex.AgentSupervisor();
    (s as Record<string, unknown>).writeAgentRegistry = () => {};
    (s as Record<string, unknown>).resolveWslGatewayIp = () => '10.0.0.42';
    return s;
  };

  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-ws-'));
  const ws = dbm.createWorkspace({ title: 'cont-ws', path: wsDir, pathType: 'windows' });
  wsId = ws.id;
  wsPath = wsDir;

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
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
