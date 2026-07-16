// workspace-lineage-backfill.test.ts — database.backfillStreamWorkspaceLineage +
// workspaceLineageIndexState (Priority 0 / WP-2B, brief item 3).
//
// Same sql.js (wasm SQLite) stand-in as parse-backfill.test.ts — better-sqlite3's native
// binding won't load under the system Node `npm run test:supervisor` uses, so we inject a
// FakeDb into require.cache BEFORE requiring ../database, then drive the REAL DDL via
// initDatabase so the backfill SQL is exercised on the true schema.
//
//   npm run build:main
//   node dist/main/main/skill-analytics/workspace-lineage-backfill.test.js
//
// initDatabase() runs the one-time backfill on the (empty) tables and stamps the
// completion marker; every test that wants to observe a live pass wipes that marker
// first (mirrors parse-backfill.test.ts's meta reset).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js better-sqlite3 stand-in (named + positional params) ──
let SQLCtor: { new (): SqlJsDatabase };
interface SqlJsStatement { bind(p: unknown): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; }
interface SqlJsDatabase { run(sql: string, params?: unknown): unknown; prepare(sql: string): SqlJsStatement; getRowsModified(): number; }
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
}
function toBind(args: unknown[]): unknown {
  if (args.length === 1 && isPlainObject(args[0])) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args[0])) o['@' + k] = v === undefined ? null : v;
    return o;
  }
  return args.map((v) => (v === undefined ? null : v));
}
class FakeDb {
  private db: SqlJsDatabase;
  constructor() { this.db = new SQLCtor(); }
  pragma(): void { /* no-op */ }
  exec(sql: string): this { this.db.run(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...args: unknown[]) => { inner.run(sql, toBind(args)); return { changes: inner.getRowsModified() }; },
      get: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); const rows: Record<string, unknown>[] = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    };
  }
  transaction<A extends unknown[]>(fn: (...a: A) => unknown) {
    return (...a: A) => { this.db.run('BEGIN'); try { const r = fn(...a); this.db.run('COMMIT'); return r; } catch (e) { this.db.run('ROLLBACK'); throw e; } };
  }
}

type DbMod = {
  initDatabase(): void;
  getDb(): FakeDb;
  backfillStreamWorkspaceLineage(): void;
  workspaceLineageIndexState(): { done: boolean; version: number; resolved: number; remaining: number };
};
let dbm: DbMod;

// ── seed helpers ──
function insertWorkspace(o: { id: string; path: string; title?: string }): void {
  dbm.getDb().prepare(
    `INSERT INTO workspaces (id, title, path, path_type) VALUES (@id, @title, @path, @pt)`,
  ).run({ id: o.id, title: o.title ?? o.id, path: o.path, pt: 'windows' });
}
function insertSls(o: { streamId: string; workingDir: string | null; workspaceId?: string | null }): void {
  dbm.getDb().prepare(
    `INSERT INTO stream_lane_stats (stream_id, lane, working_dir, workspace_id)
     VALUES (@stream_id, @lane, @working_dir, @workspace_id)`,
  ).run({ stream_id: o.streamId, lane: 'worker', working_dir: o.workingDir, workspace_id: o.workspaceId ?? null });
}
function sls(streamId: string): { id: string | null; method: string | null; version: number | null } {
  const r = dbm.getDb().prepare(
    `SELECT workspace_id AS id, workspace_attribution_method AS method, workspace_attribution_version AS version
     FROM stream_lane_stats WHERE stream_id = ?`,
  ).get(streamId) as Record<string, unknown> | undefined;
  return {
    id: r?.id == null ? null : String(r.id),
    method: r?.method == null ? null : String(r.method),
    version: r?.version == null ? null : Number(r.version),
  };
}
/** Wipe the completion marker so the next backfill runs a live pass (init stamped it). */
function armFreshPass(): void {
  dbm.getDb().prepare(`DELETE FROM skill_analytics_meta`).run();
}

// ── tests ──

test('populates workspace_id for streams whose folded cwd is owned by EXACTLY one workspace', () => {
  insertWorkspace({ id: 'ws1', path: 'C:/proj' });
  insertWorkspace({ id: 'ws2', path: 'C:/other' });
  insertSls({ streamId: 'sA', workingDir: 'C:/proj/.dashboard/workers/claude' });   // → ws1
  insertSls({ streamId: 'sB', workingDir: 'C:/other/.dashboard/supervisor' });       // → ws2
  insertSls({ streamId: 'sC', workingDir: 'C:/nowhere/.dashboard/supervisor' });      // → no owner
  insertSls({ streamId: 'sD', workingDir: null });                                    // no cwd

  armFreshPass();
  dbm.backfillStreamWorkspaceLineage();

  const a = sls('sA');
  assert.equal(a.id, 'ws1', 'unique owner → workspace_id persisted');
  assert.equal(a.method, 'root', 'the folding backfill only ever claims method=root');
  assert.equal(a.version, dbm.workspaceLineageIndexState().version, 'stamped with the resolver version');
  assert.equal(sls('sB').id, 'ws2');
  assert.equal(sls('sC').id, null, 'no owning workspace → stays NULL (never guesses)');
  assert.equal(sls('sD').id, null, 'no launch cwd → stays NULL');
});

test('ambiguous ownership (folded root owned by TWO workspaces) stays NULL', () => {
  insertWorkspace({ id: 'wsX', path: 'C:/dup' });
  insertWorkspace({ id: 'wsY', path: 'C:/dup' }); // same path → ambiguous
  insertSls({ streamId: 'sAmb', workingDir: 'C:/dup/.dashboard/supervisor' });

  armFreshPass();
  dbm.backfillStreamWorkspaceLineage();
  assert.equal(sls('sAmb').id, null, 'a root two workspaces own is never attributed to either');
});

test('idempotent — a re-run over a fresh pass touches only still-NULL rows and drifts nothing', () => {
  insertWorkspace({ id: 'ws1', path: 'C:/proj' });
  insertSls({ streamId: 'sA', workingDir: 'C:/proj/.dashboard/workers/claude' });
  armFreshPass();
  dbm.backfillStreamWorkspaceLineage();
  const first = sls('sA');
  assert.equal(first.id, 'ws1');

  // Re-arm and run again: sA is already non-NULL so the WHERE workspace_id IS NULL guard
  // skips it — identical result, zero drift.
  armFreshPass();
  dbm.backfillStreamWorkspaceLineage();
  assert.deepEqual(sls('sA'), first, 'a resolved row is never re-written or duplicated');
});

test('version-gated no-op — once complete at the current version, a later NULL row is left alone', () => {
  insertWorkspace({ id: 'ws1', path: 'C:/proj' });
  // First pass stamps the completion marker at the current version.
  armFreshPass();
  dbm.backfillStreamWorkspaceLineage();
  assert.equal(dbm.workspaceLineageIndexState().done, true, 'marker stamped at current version');

  // A new resolvable NULL row arrives; without re-arming, the version-gated guard short-
  // circuits the whole pass, so it is intentionally left unresolved until a version bump.
  insertSls({ streamId: 'sLate', workingDir: 'C:/proj/.dashboard/supervisor' });
  dbm.backfillStreamWorkspaceLineage();
  assert.equal(sls('sLate').id, null, 'complete-at-version → strict no-op, no re-walk');
});

test('workspaceLineageIndexState — reports done/version/resolved/remaining honestly', () => {
  insertWorkspace({ id: 'ws1', path: 'C:/proj' });
  insertSls({ streamId: 'sA', workingDir: 'C:/proj/.dashboard/workers/claude' }); // resolvable → ws1
  insertSls({ streamId: 'sC', workingDir: 'C:/nowhere/.dashboard/supervisor' });   // resolvable candidate, no owner

  armFreshPass();
  // Before the pass: not done, both rows are NULL-with-cwd candidates.
  const before = dbm.workspaceLineageIndexState();
  assert.equal(before.done, false, 'marker wiped → not done');
  assert.equal(before.resolved, 0, 'no workspace_id set yet');
  assert.equal(before.remaining, 2, 'both NULL-workspace rows carry a working_dir');

  dbm.backfillStreamWorkspaceLineage();
  const after = dbm.workspaceLineageIndexState();
  assert.equal(after.done, true, 'marker stamped after the pass');
  assert.ok(after.version >= 1);
  assert.equal(after.resolved, 1, 'exactly the uniquely-owned row resolved');
  assert.equal(after.remaining, 1, 'the no-owner row remains an (unresolvable) candidate');
});

// ── runner ──
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-lineage-backfill-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;

  let passed = 0; let failed = 0;
  for (const t of tests) {
    dbm.initDatabase(); // fresh schema per test (isolated seeds)
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
