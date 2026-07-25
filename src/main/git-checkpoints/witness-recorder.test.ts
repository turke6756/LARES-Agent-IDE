// Git-Native WP-G1.7 — witness-recorder + witness-join tests.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/witness-recorder.test.js
//
// Two layers:
//   1. PURE — normalizeWitnessPath (repo-relative, scope/traversal rejection) and
//      WitnessRecorder.observe (write/create only, open-turn gating, dedupe-agnostic
//      forwarding).
//   2. DB-JOIN — the real database.ts choke point: setWitnessObserver fires at the
//      TOP of addFileActivity, ABOVE the 5-second live-cache dedupe (so two same-path
//      writes 1s apart BOTH reach the observer), and recordWitnessedActivity dedupes
//      (turnId, path, op) into the open turn's touched[]. Both a "Claude PTY Edit"
//      and a "structured Codex/Gemini" event are just addFileActivity calls at this
//      convergence point, so one path proves both sources.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WitnessRecorder, normalizeWitnessPath, type WitnessTarget } from './witness-recorder';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── 1. PURE: normalizeWitnessPath ───────────────────────────────────────────────

const REPO = path.resolve('wr-fixture-repo');

test('normalizeWitnessPath: absolute in-scope path → repo-relative POSIX', () => {
  const target: WitnessTarget = { turnId: 't1', repoRoot: REPO, workspacePrefix: '' };
  assert.equal(normalizeWitnessPath(target, path.join(REPO, 'src', 'a.ts')), 'src/a.ts');
});

test('normalizeWitnessPath: workspacePrefix keeps the path repo-relative (incl. the prefix)', () => {
  const target: WitnessTarget = { turnId: 't1', repoRoot: REPO, workspacePrefix: 'sub' };
  // In-scope (under <repo>/sub) → repo-relative includes the prefix.
  assert.equal(normalizeWitnessPath(target, path.join(REPO, 'sub', 'x.ts')), 'sub/x.ts');
  // Out-of-scope: under the repo but OUTSIDE the workspace prefix → rejected.
  assert.equal(normalizeWitnessPath(target, path.join(REPO, 'other', 'y.ts')), null);
});

test('normalizeWitnessPath: traversal + out-of-repo rejected', () => {
  const target: WitnessTarget = { turnId: 't1', repoRoot: REPO, workspacePrefix: '' };
  assert.equal(normalizeWitnessPath(target, path.join(REPO, '..', 'escape.ts')), null);
  assert.equal(normalizeWitnessPath(target, path.resolve('totally-elsewhere', 'z.ts')), null);
  // The repo root itself is not a witnessable file.
  assert.equal(normalizeWitnessPath(target, REPO), null);
  assert.equal(normalizeWitnessPath(target, ''), null);
});

// ── 1. PURE: WitnessRecorder.observe ────────────────────────────────────────────

function makeRecorder(target: WitnessTarget | null) {
  const records: { turnId: string; path: string; op: string }[] = [];
  const rec = new WitnessRecorder({
    currentWitnessTarget: () => target,
    record: (turnId, p, op) => { records.push({ turnId, path: p, op }); return true; },
  });
  return { rec, records };
}

test('observe: only write/create are recorded; read is ignored', () => {
  const target: WitnessTarget = { turnId: 't7', repoRoot: REPO, workspacePrefix: '' };
  const { rec, records } = makeRecorder(target);
  rec.observe('A', path.join(REPO, 'a.ts'), 'read');
  assert.equal(records.length, 0, 'read is never recovery-relevant');
  rec.observe('A', path.join(REPO, 'a.ts'), 'write');
  rec.observe('A', path.join(REPO, 'b.ts'), 'create');
  assert.deepEqual(records, [
    { turnId: 't7', path: 'a.ts', op: 'write' },
    { turnId: 't7', path: 'b.ts', op: 'create' },
  ]);
});

test('observe: no open turn → nothing recorded', () => {
  const { rec, records } = makeRecorder(null);
  rec.observe('A', path.join(REPO, 'a.ts'), 'write');
  assert.equal(records.length, 0);
});

test('observe: out-of-scope path → rejected (not recorded)', () => {
  const target: WitnessTarget = { turnId: 't7', repoRoot: REPO, workspacePrefix: '' };
  const { rec, records } = makeRecorder(target);
  rec.observe('A', path.resolve('outside', 'a.ts'), 'write');
  assert.equal(records.length, 0);
});

test('observe: two same-path writes both forward (turn-level dedupe is the DB\'s job)', () => {
  const target: WitnessTarget = { turnId: 't7', repoRoot: REPO, workspacePrefix: '' };
  const { rec, records } = makeRecorder(target);
  rec.observe('A', path.join(REPO, 'a.ts'), 'write');
  rec.observe('A', path.join(REPO, 'a.ts'), 'write');
  assert.equal(records.length, 2, 'the recorder always forwards; dedupe happens in recordWitnessedActivity');
});

// ── 2. DB-JOIN: real database choke point (sql.js better-sqlite3 stand-in) ───────

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): { bind(params: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; };
};
let sqlJsCtor: new () => SqlJsDatabase;
class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); const rows: Record<string, unknown>[] = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: Record<string, unknown>): { id: string };
  addFileActivity(agentId: string, filePath: string, operation: string): unknown;
  allocateAndInsertTurn(workspaceId: string, fields?: Record<string, unknown>): { id: string };
  getTurnRecord(id: string): { touched: { path: string; op: string }[] | null } | null;
  recordWitnessedActivity(turnId: string, filePath: string, op: string): boolean;
  setWitnessObserver(fn: ((agentId: string, filePath: string, op: string) => void) | null): void;
  clearWitnessObserver(): void;
};
let dbm: DbModule;

test('DB-JOIN: observer fires ABOVE the 5s live-cache dedupe for two same-path writes; (turn,path,op) deduped', () => {
  const ws = dbm.createWorkspace({ title: 'wr-db', path: path.join(REPO, 'sub'), pathType: 'windows' }).id;
  const agentId = dbm.createAgent({
    workspaceId: ws, title: 'wr-agent', roleDescription: '', workingDirectory: REPO,
    command: 'claude', provider: 'claude', tmuxSessionName: null, autoRestartEnabled: false,
    logPath: path.join(REPO, 'a.log'),
  }).id;
  const turn = dbm.allocateAndInsertTurn(ws, { agentId });

  // Wire the real recorder against the real DB, with a fixed open-turn target.
  const target: WitnessTarget = { turnId: turn.id, repoRoot: REPO, workspacePrefix: 'sub' };
  const observerFires: string[] = [];
  const rec = new WitnessRecorder({
    currentWitnessTarget: () => target,
    record: (turnId, p, op) => { observerFires.push(`${p}:${op}`); return dbm.recordWitnessedActivity(turnId, p, op); },
  });
  dbm.setWitnessObserver(rec.observe as (a: string, f: string, o: string) => void);
  try {
    const wPath = path.join(REPO, 'sub', 'edit.ts');
    // A "Claude PTY Edit" then, 1s later, the SAME path again (structured event).
    // The 2nd addFileActivity dedupes at the file_activities layer (returns null),
    // but the observer must STILL fire (it is above the early-return).
    const first = dbm.addFileActivity(agentId, wPath, 'write');
    const second = dbm.addFileActivity(agentId, wPath, 'write');
    assert.notEqual(first, null, 'first write inserts a file_activities row');
    assert.equal(second, null, 'second same-path write within 5s is deduped at file_activities');
    assert.equal(observerFires.length, 2, 'the witness observer fired for BOTH writes (above the dedupe)');

    // A structured event for a DIFFERENT path also lands (both sources converge here).
    dbm.addFileActivity(agentId, path.join(REPO, 'sub', 'new.ts'), 'create');
    assert.equal(observerFires.length, 3);

    // Turn-level dedupe: same (path, op) collapsed → exactly two touched entries.
    const touched = dbm.getTurnRecord(turn.id)?.touched ?? [];
    assert.deepEqual(
      [...touched].sort((a, b) => a.path.localeCompare(b.path)),
      [{ path: 'sub/edit.ts', op: 'write' }, { path: 'sub/new.ts', op: 'create' }],
    );
  } finally {
    dbm.clearWitnessObserver();
  }
});

test('DB-JOIN: clearWitnessObserver detaches the choke point', () => {
  const ws = dbm.createWorkspace({ title: 'wr-db2', path: path.join(REPO, 'sub'), pathType: 'windows' }).id;
  const agentId = dbm.createAgent({
    workspaceId: ws, title: 'wr-agent2', roleDescription: '', workingDirectory: REPO,
    command: 'claude', provider: 'claude', tmuxSessionName: null, autoRestartEnabled: false,
    logPath: path.join(REPO, 'b.log'),
  }).id;
  let fires = 0;
  dbm.setWitnessObserver(() => { fires++; });
  dbm.clearWitnessObserver();
  dbm.addFileActivity(agentId, path.join(REPO, 'sub', 'z.ts'), 'write');
  assert.equal(fires, 0, 'no observer fires once cleared');
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-rec-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
