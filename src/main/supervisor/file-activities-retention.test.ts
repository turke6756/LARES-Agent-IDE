// Regression coverage for the file-activities retention prune + the
// anti-stranding guard around it. This is the coverage hole that let a NUL
// byte ship in `pruneFileActivitiesToRecentSessions`'s SQL: the supervisor
// suite STUBS the real prune (claude-clear-rotation-supervisor.test.ts sets
// `db.pruneFileActivitiesToRecentSessions = () => (...)`), so the corrupted
// SQL never executed in CI. These tests run the REAL function against a REAL
// (sql.js-backed) database so a broken sentinel throws here.
//
// TEST A — pruneFileActivitiesToRecentSessions over real SQL (catches the NUL):
//   seeds multiple sessions incl. the NULL-session legacy bucket and asserts
//   it does not throw, returns correct {prunedRows, prunedSessions}, collapses
//   the NULL bucket as a unit (COALESCE(session_id,' null')), and early-returns
//   {0,0} when keepN >= sessionCount.
// TEST B — anti-stranding: the `agent-rebound` listener now wraps the prune in
//   try/catch and still emits `fileActivitiesGenerationAdvanced`. Seam choice:
//   we reuse the REAL supervisor + dispatcher wiring and drive the actual
//   public `sessionLogReader.rebindAgent(agentId)` (which synchronously emits
//   'agent-rebound' → the listener), rather than unit-testing an inline
//   listener we'd have to copy. We force the prune to THROW and assert the
//   rebind still completes and the re-partition event still fires.
// TEST C — source NUL guard: database.ts contains zero 0x00 bytes.
//
// better-sqlite3's native binding is built against Electron's ABI and won't
// load under the system Node that `npm run test:supervisor` uses, so we inject
// the sql.js stand-in into require.cache BEFORE requiring ../database (same
// precedent as continuation-lifecycle.test.ts / database.test.ts).
//
//   npm run build:main
//   node dist/main/main/supervisor/file-activities-retention.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (continuation-lifecycle precedent) ──

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

// ── modules under test (loaded in the runner, after the cache injection) ──────

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string; path: string };
  pruneFileActivitiesToRecentSessions(agentId: string, keepSessions: number): { prunedRows: number; prunedSessions: number };
};
let dbm: DbModule;
let dbAny: Record<string, unknown>;

type SupervisorLike = Record<string, unknown> & {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  sessionLogReader: { rebindAgent(agentId: string): void };
};
let makeSupervisor: () => SupervisorLike;

// Seed a file_activities row with full control over session_id (incl. NULL)
// and timestamp — bypasses addFileActivity's dedup/stamp so tests are explicit.
function seed(agentId: string, filePath: string, sessionId: string | null, timestamp: string, op = 'read', gen = 0): void {
  liveDb!.prepare(
    'INSERT INTO file_activities (agent_id, file_path, operation, generation, session_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agentId, filePath, op, gen, sessionId, timestamp);
}
function countRows(agentId: string, whereSession: string): number {
  const row = liveDb!.prepare(
    `SELECT COUNT(*) AS n FROM file_activities WHERE agent_id = ? AND ${whereSession}`
  ).get(agentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ── TEST A: real prune over multi-session data incl. the NULL bucket ──────────

test('A1: prune does not throw and drops exactly the oldest session (3 sessions, keep 2)', () => {
  const a = 'agA';
  seed(a, 'f1.ts', 's1', '2026-01-01 00:00:00'); // oldest
  seed(a, 'f2.ts', 's1', '2026-01-01 00:00:01');
  seed(a, 'f3.ts', 's2', '2026-01-02 00:00:00');
  seed(a, 'f4.ts', 's3', '2026-01-03 00:00:00'); // newest
  // Real SQL — a NUL/broken sentinel would throw SqliteError here.
  const res = dbm.pruneFileActivitiesToRecentSessions(a, 2);
  assert.equal(res.prunedSessions, 1, 'exactly one (oldest) session pruned');
  assert.equal(res.prunedRows, 2, 'both rows of the oldest session removed');
  assert.equal(countRows(a, "session_id = 's1'"), 0, 'oldest session gone');
  assert.equal(countRows(a, "session_id = 's2'"), 1, 's2 kept');
  assert.equal(countRows(a, "session_id = 's3'"), 1, 's3 kept');
});

test('A2: the NULL-session bucket collapses to ONE session and is pruned as a unit when oldest', () => {
  const a = 'agB';
  // NULL bucket is the OLDEST — two legacy rows that must collapse to one skey.
  seed(a, 'legacy1.ts', null, '2026-01-01 00:00:00');
  seed(a, 'legacy2.ts', null, '2026-01-01 00:00:05');
  seed(a, 'f3.ts', 's2', '2026-01-02 00:00:00');
  seed(a, 'f4.ts', 's3', '2026-01-03 00:00:00');
  const res = dbm.pruneFileActivitiesToRecentSessions(a, 2);
  assert.equal(res.prunedSessions, 1, 'the NULL bucket counts as ONE session, not two');
  assert.equal(res.prunedRows, 2, 'both NULL-session rows deleted together');
  assert.equal(countRows(a, 'session_id IS NULL'), 0, 'NULL bucket fully pruned');
  assert.equal(countRows(a, "session_id = 's2'"), 1, 's2 kept');
  assert.equal(countRows(a, "session_id = 's3'"), 1, 's3 kept');
});

test('A3: the NULL-session bucket SURVIVES as a unit when it is not the oldest', () => {
  const a = 'agC';
  seed(a, 'f1.ts', 's1', '2026-01-01 00:00:00'); // oldest → pruned
  seed(a, 'f2.ts', 's2', '2026-01-02 00:00:00');
  // NULL bucket is the NEWEST here — must be kept whole.
  seed(a, 'legacy1.ts', null, '2026-01-03 00:00:00');
  seed(a, 'legacy2.ts', null, '2026-01-03 00:00:01');
  const res = dbm.pruneFileActivitiesToRecentSessions(a, 2);
  assert.equal(res.prunedSessions, 1, 'only the oldest non-NULL session pruned');
  assert.equal(res.prunedRows, 1, 's1 had a single row');
  assert.equal(countRows(a, "session_id = 's1'"), 0, 's1 gone');
  assert.equal(countRows(a, 'session_id IS NULL'), 2, 'NULL bucket survived intact');
  assert.equal(countRows(a, "session_id = 's2'"), 1, 's2 kept');
});

test('A4: keepN >= sessionCount early-returns {0,0} and prunes nothing', () => {
  const a = 'agD';
  seed(a, 'f1.ts', 's1', '2026-01-01 00:00:00');
  seed(a, 'f2.ts', 's2', '2026-01-02 00:00:00');
  const before = countRows(a, '1 = 1');
  const eq = dbm.pruneFileActivitiesToRecentSessions(a, 2);
  assert.deepEqual(eq, { prunedRows: 0, prunedSessions: 0 }, 'keepN == sessionCount is a no-op');
  const over = dbm.pruneFileActivitiesToRecentSessions(a, 5);
  assert.deepEqual(over, { prunedRows: 0, prunedSessions: 0 }, 'keepN > sessionCount is a no-op');
  assert.equal(countRows(a, '1 = 1'), before, 'no rows deleted');
});

// ── TEST B: a throwing prune must NOT abort the rebind (anti-stranding) ────────

test('B: agent-rebound survives a throwing prune and still fires fileActivitiesGenerationAdvanced', () => {
  const sup = makeSupervisor();
  const agentId = 'agent-rebind-guard';

  const advanced: string[] = [];
  sup.on('fileActivitiesGenerationAdvanced', (id: unknown) => { advanced.push(id as string); });

  // Force the retention prune to blow up (simulates the shipped NUL-byte SQL
  // error, or any future prune failure). The compiled listener reads the fn
  // through the module namespace at call time, so patching dbAny takes effect.
  const orig = dbAny.pruneFileActivitiesToRecentSessions;
  dbAny.pruneFileActivitiesToRecentSessions = () => { throw new Error('simulated prune failure (e.g. corrupted SQL)'); };
  try {
    // Real public path: rebindAgent synchronously emits 'agent-rebound'.
    assert.doesNotThrow(
      () => sup.sessionLogReader.rebindAgent(agentId),
      'a throwing prune must not propagate out of the rebind',
    );
  } finally {
    dbAny.pruneFileActivitiesToRecentSessions = orig;
  }

  assert.deepEqual(advanced, [agentId], 're-partition event still fires after the guarded prune failure');
});

// ── TEST C: no NUL bytes in the database source (belt-and-suspenders) ─────────

test('C: src/main/database.ts contains zero NUL (0x00) bytes', () => {
  // Walk up from the compiled test location to the repo root, then read source.
  // dist/main/main/supervisor/file-activities-retention.test.js → repo root is
  // four dirs up from dist/main/main/supervisor.
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const src = path.join(repoRoot, 'src', 'main', 'database.ts');
  assert.ok(fs.existsSync(src), `database.ts found at ${src}`);
  const bytes = fs.readFileSync(src);
  let nul = 0;
  for (const b of bytes) if (b === 0x00) nul++;
  assert.equal(nul, 0, 'database.ts must contain no NUL bytes (a NUL truncates SQL and breaks the prune)');
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'file-activities-retention-'));
  process.env.APPDATA = tmpAppData;
  process.env.DASHBOARD_RECONCILE_STAGGER_MS = '1';

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
  dbm = require('../database') as DbModule;
  dbAny = dbm as unknown as Record<string, unknown>;
  dbm.initDatabase();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const supIndex = require('./index') as { AgentSupervisor: new () => SupervisorLike };
  makeSupervisor = () => {
    const s = new supIndex.AgentSupervisor();
    (s as Record<string, unknown>).writeAgentRegistry = () => {};
    (s as Record<string, unknown>).resolveWslGatewayIp = () => '10.0.0.42';
    return s;
  };

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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
