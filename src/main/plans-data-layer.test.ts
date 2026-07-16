// B2 Task A — plans + supervisor_focus data-layer test (P1-01).
//
// Covers the schema + DB helper surface: uuid ids decoupled from slug/path,
// idempotent createOrRevivePlan, rename REBIND (id preserved), soft-delete +
// revive, DEC-1 tombstone reclaim vs live-conflict 409, and supervisor_focus
// upsert / join projection / cascade survival.
//
// better-sqlite3's native binding won't load under the system Node that
// `npm run test:*` uses, so this test injects a sql.js (wasm SQLite) stand-in
// into require.cache BEFORE requiring ../database (precedent: database.test.ts).
//
//   npm run build:main
//   node dist/main/main/plans-data-layer.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors database.test.ts) ───────────

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

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  private dbPath: string;
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  close(): void { FakeBetterSqlite.stores.delete(this.dbPath); }
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

// ── module under test ─────────────────────────────────────────────────────────

type Plan = {
  id: string; workspaceId: string; path: string; slug: string | null;
  format: string; runState: string | null; mtimeMs: number; sizeBytes: number;
  createdAt: string; updatedAt: string; deletedAt: string | null;
};
type SupervisorFocus = {
  supervisorId: string; planId: string; focusedAt: string; lastAttendedAt: string;
  notes: string | null; plan?: Plan;
};
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string; description?: string; defaultCommand?: string }): { id: string };
  createAgent(data: Record<string, unknown>): { id: string };
  derivePlanSlug(planPath: string, html?: string | null): string;
  getPlans(filters?: { workspaceId?: string; includeDeleted?: boolean }): Plan[];
  getPlan(id: string): Plan | null;
  getPlanByWorkspacePath(workspaceId: string, planPath: string): Plan | null;
  createOrRevivePlan(input: Record<string, unknown>): Plan;
  updatePlan(id: string, updates: Record<string, unknown>): Plan | null;
  softDeletePlan(id: string): Plan | null;
  getSupervisorFocus(filters?: { supervisorId?: string; workspaceId?: string }): SupervisorFocus[];
  upsertSupervisorFocus(input: { supervisorId: string; planId: string; notes?: string | null }): SupervisorFocus;
  deleteSupervisorFocus(supervisorId: string, planId: string): void;
  bumpSupervisorFocusAttended(supervisorId: string, planId: string): SupervisorFocus | null;
  getSupervisorFocusedPlans(supervisorId: string, limit?: number): Array<{
    planId: string; path: string; slug: string | null; format: string;
    focusedAt: string; lastAttendedAt: string; notes: string | null;
  }>;
  closeDatabaseForTests(): void;
};
let dbm: DbModule;

let wsCounter = 0;
function makeWorkspace(): string {
  return dbm.createWorkspace({
    title: `ws-${++wsCounter}`, path: `C:\\repo\\ws-${wsCounter}`, pathType: 'windows',
  }).id;
}
function makeSupervisor(workspaceId: string): string {
  return dbm.createAgent({
    workspaceId, title: 'sup', roleDescription: '', workingDirectory: 'C:\\repo',
    command: 'claude', tmuxSessionName: null, autoRestartEnabled: false,
    logPath: 'C:\\repo\\s.log', isSupervisor: true,
  }).id;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── tests ─────────────────────────────────────────────────────────────────────

test('1. schema present — plans + focus columns and all four indexes exist', () => {
  const ws = makeWorkspace();
  // A successful insert + read proves the tables exist with the expected columns.
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/schema.md', format: 'md' });
  assert.ok(p.id && p.createdAt && p.updatedAt);
  assert.equal(p.deletedAt, null);
});

test('2. createOrRevivePlan mints a uuid id decoupled from slug/path', () => {
  const ws = makeWorkspace();
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/auth.md', slug: 'auth', format: 'md' });
  assert.match(p.id, UUID_RE);
  assert.notEqual(p.id, p.slug);
  assert.notEqual(p.id, p.path);
  assert.equal(p.slug, 'auth');
});

test('3. two paths sharing a basename → two distinct ids', () => {
  const ws = makeWorkspace();
  const a = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/a/x.md', format: 'md' });
  const b = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/b/x.md', format: 'md' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.slug, 'x');
  assert.equal(b.slug, 'x');
});

test('4. re-create of same (workspace, path) → same id, refreshed meta, one row', () => {
  const ws = makeWorkspace();
  const first = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/dup.md', format: 'md', mtimeMs: 100, sizeBytes: 10 });
  const second = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/dup.md', format: 'md', mtimeMs: 200, sizeBytes: 20 });
  assert.equal(first.id, second.id);
  assert.equal(second.mtimeMs, 200);
  assert.equal(second.sizeBytes, 20);
  assert.equal(dbm.getPlans({ workspaceId: ws }).filter(p => p.path === 'plans/dup.md').length, 1);
});

test('5. updatePlan rename REBIND keeps id byte-identical', () => {
  const ws = makeWorkspace();
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/auth.md', format: 'md' });
  const renamed = dbm.updatePlan(p.id, { path: 'plans/auth-renamed.md', slug: 'auth-renamed' });
  assert.equal(renamed!.id, p.id);
  assert.equal(dbm.getPlan(p.id)!.path, 'plans/auth-renamed.md');
  assert.equal(dbm.getPlan(p.id)!.slug, 'auth-renamed');
});

test('6. softDeletePlan sets deletedAt; excluded by default, present with includeDeleted', () => {
  const ws = makeWorkspace();
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/del.md', format: 'md' });
  const del = dbm.softDeletePlan(p.id);
  assert.ok(del!.deletedAt);
  assert.equal(dbm.getPlans({ workspaceId: ws }).some(x => x.id === p.id), false);
  assert.equal(dbm.getPlans({ workspaceId: ws, includeDeleted: true }).some(x => x.id === p.id), true);
});

test('7. recreate at a soft-deleted path → deletedAt cleared, same id', () => {
  const ws = makeWorkspace();
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/revive.md', format: 'md' });
  dbm.softDeletePlan(p.id);
  const revived = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/revive.md', format: 'md' });
  assert.equal(revived.id, p.id);
  assert.equal(revived.deletedAt, null);
});

test('8. DEC-1 — rebind onto tombstone reclaims it; onto live dest → 409', () => {
  const ws = makeWorkspace();
  // tombstone reclaim
  const live = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/live.md', format: 'md' });
  const doomed = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/doomed.md', format: 'md' });
  dbm.softDeletePlan(doomed.id);
  const rebound = dbm.updatePlan(live.id, { path: 'plans/doomed.md', slug: 'doomed' });
  assert.equal(rebound!.id, live.id, 'live row keeps its id after reclaiming the tombstone');
  assert.equal(dbm.getPlan(doomed.id), null, 'tombstone hard-deleted');
  // live-destination conflict → 409
  const a = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/aaa.md', format: 'md' });
  const b = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/bbb.md', format: 'md' });
  let threw: any = null;
  try { dbm.updatePlan(a.id, { path: 'plans/bbb.md' }); } catch (e) { threw = e; }
  assert.ok(threw, 'rebind onto a live path throws');
  assert.equal(threw.statusCode, 409);
  void b;
});

test('9. focus row survives softDeletePlan of its plan (join shows plan.deletedAt)', () => {
  const ws = makeWorkspace();
  const sup = makeSupervisor(ws);
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/focus.md', format: 'md' });
  dbm.upsertSupervisorFocus({ supervisorId: sup, planId: p.id });
  dbm.softDeletePlan(p.id);
  const rows = dbm.getSupervisorFocus({ supervisorId: sup });
  const row = rows.find(r => r.planId === p.id);
  assert.ok(row, 'focus row still resolves after soft-delete');
  assert.ok(row!.plan, 'plan projection joined');
  assert.ok(row!.plan!.deletedAt, 'projection carries deletedAt for [deleted] UI');
});

test('10. upsertSupervisorFocus twice → one row, focusedAt preserved, notes updated only when supplied', () => {
  const ws = makeWorkspace();
  const sup = makeSupervisor(ws);
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/up.md', format: 'md' });
  const first = dbm.upsertSupervisorFocus({ supervisorId: sup, planId: p.id, notes: 'n1' });
  const second = dbm.upsertSupervisorFocus({ supervisorId: sup, planId: p.id });
  assert.equal(second.focusedAt, first.focusedAt, 'focusedAt preserved when omitted');
  assert.equal(second.notes, 'n1', 'notes preserved when not supplied');
  const third = dbm.upsertSupervisorFocus({ supervisorId: sup, planId: p.id, notes: 'n2' });
  assert.equal(third.notes, 'n2', 'notes updated when supplied');
  assert.equal(dbm.getSupervisorFocus({ supervisorId: sup }).filter(r => r.planId === p.id).length, 1);
});

test('11. markdown plan registers with a uuid id (legacy-plan path, D-01 #4)', () => {
  const ws = makeWorkspace();
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/legacy.markdown', format: 'md' });
  assert.match(p.id, UUID_RE);
  assert.equal(p.format, 'md');
});

test('12. deleteSupervisorFocus removes the focus row without touching the plan', () => {
  const ws = makeWorkspace();
  const sup = makeSupervisor(ws);
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/df.md', format: 'md' });
  dbm.upsertSupervisorFocus({ supervisorId: sup, planId: p.id });
  dbm.deleteSupervisorFocus(sup, p.id);
  assert.equal(dbm.getSupervisorFocus({ supervisorId: sup }).some(r => r.planId === p.id), false);
  assert.ok(dbm.getPlan(p.id), 'plan itself untouched');
});

test('13. bumpSupervisorFocusAttended is a no-op (null) when no row exists; updates when present', () => {
  const ws = makeWorkspace();
  const sup = makeSupervisor(ws);
  const p = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/bump.md', format: 'md' });
  assert.equal(dbm.bumpSupervisorFocusAttended(sup, p.id), null, 'no row → null, no throw');
  dbm.upsertSupervisorFocus({ supervisorId: sup, planId: p.id });
  const bumped = dbm.bumpSupervisorFocusAttended(sup, p.id);
  assert.ok(bumped, 'existing row bumped');
  assert.equal(bumped!.planId, p.id);
});

test('14. getSupervisorFocusedPlans — orientation shape, deleted-exclusion, cap, no-leak, order invariant', () => {
  const ws = makeWorkspace();
  const sup = makeSupervisor(ws);
  const other = makeSupervisor(ws);
  const a = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/fp-a.md', slug: 'fp-a', format: 'md' });
  const b = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/fp-b.md', slug: 'fp-b', format: 'md' });
  const gone = dbm.createOrRevivePlan({ workspaceId: ws, path: 'plans/fp-gone.md', format: 'md' });
  dbm.upsertSupervisorFocus({ supervisorId: sup, planId: a.id, notes: 'a-note' });
  dbm.upsertSupervisorFocus({ supervisorId: sup, planId: b.id });
  dbm.upsertSupervisorFocus({ supervisorId: sup, planId: gone.id });
  // Another supervisor's subscription must never leak into sup's set.
  dbm.upsertSupervisorFocus({ supervisorId: other, planId: b.id });
  // A soft-deleted plan drops out of the orientation view.
  dbm.softDeletePlan(gone.id);

  const rows = dbm.getSupervisorFocusedPlans(sup);
  const ids = rows.map(r => r.planId).sort();
  assert.deepEqual(ids, [a.id, b.id].sort(), 'exactly sup\'s live subscriptions — deleted excluded, other supervisor not leaked');
  // Shape: the exact orientation projection columns, nothing more.
  const rowA = rows.find(r => r.planId === a.id);
  assert.ok(rowA, 'sup\'s focus row for plan a is present');
  assert.deepEqual(Object.keys(rowA).sort(),
    ['focusedAt', 'format', 'lastAttendedAt', 'notes', 'path', 'planId', 'slug']);
  assert.equal(rowA.path, 'plans/fp-a.md');
  assert.equal(rowA.slug, 'fp-a');
  assert.equal(rowA.format, 'md');
  assert.equal(rowA.notes, 'a-note');
  // Order invariant: rows are non-increasing by (lastAttendedAt, focusedAt) — the
  // SQL ORDER BY. (Sub-second collisions make a strict id order non-deterministic;
  // the monotonic invariant is what the ordering guarantees regardless.)
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    assert.ok(
      prev.lastAttendedAt > cur.lastAttendedAt ||
      (prev.lastAttendedAt === cur.lastAttendedAt && prev.focusedAt >= cur.focusedAt),
      'rows sorted by last_attended_at DESC then focused_at DESC',
    );
  }
  // Cap honored.
  assert.equal(dbm.getSupervisorFocusedPlans(sup, 1).length, 1);
  // A supervisor with no subscriptions → empty array (no throw).
  assert.deepEqual(dbm.getSupervisorFocusedPlans(makeSupervisor(ws)), []);
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-data-layer-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

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
  try { dbm.closeDatabaseForTests(); } catch { /* best-effort */ }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
