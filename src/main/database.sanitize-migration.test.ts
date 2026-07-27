// Checkpoint Surface Hardening WP2 — historical witness-path sanitize migration.
//
// Contract-level tests against the REAL schema (via the sql.js better-sqlite3
// stand-in, same precedent as database.file-activity-ingress.test.ts). Seeds each
// witness-bearing store with intact / ambiguous / collision fixtures (including a
// NULL-`session_id`-bearing collision), runs `sanitizeHistoricalWitnessPaths`
// TWICE, and asserts:
//   - polluted values are cleaned to the correct per-store canonical form;
//   - ambiguous values are quarantined (file_activities row DELETED / JSON entry
//     removed) — never guessed;
//   - post-normalization collisions merge to the LOWEST id (production dedupe
//     identity, null-safe session_id);
//   - re-dedupe `(path, op)` inside `touched[]` / the recovery arrays;
//   - aggregate `{ repaired, discarded, merged }` counts per table;
//   - already-clean rows/entries are left byte-for-byte untouched;
//   - the SECOND run is a total no-op (all counts zero, data identical) — idempotent.
//
//   npm run build:main
//   node dist/main/main/database.sanitize-migration.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (database.file-activity-ingress.test.ts) ──

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
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
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

type SanitizeCounts = { repaired: number; discarded: number; merged: number };
type DbHandle = {
  prepare(sql: string): {
    run: (...p: unknown[]) => unknown;
    get: (...p: unknown[]) => Record<string, unknown> | undefined;
    all: (...p: unknown[]) => Record<string, unknown>[];
  };
};
type DbModule = {
  initDatabase(): void;
  getDb(): DbHandle;
  sanitizeHistoricalWitnessPaths(handle: DbHandle): {
    file_activities: SanitizeCounts;
    turn_records: SanitizeCounts;
    recovery_operations: SanitizeCounts;
  };
};
let dbm: DbModule;

const ESC = '\x1b';
const ST = ESC + '\\';

/** Build an intact ST-terminated OSC-8 hyperlink whose display text is `display`. */
function osc8(uri: string, display: string): string {
  return `${ESC}]8;id=1;${uri}${ST}${display}${ESC}]8;;${ST}`;
}
/** A nested / multi-link value → ambiguous recovery (three `]8;` markers). */
function ambiguousLink(): string {
  return `${ESC}]8;id=1;file:///C:/a${ST}A${ESC}]8;id=2;file:///C:/b${ST}B${ESC}]8;;${ST}`;
}

const AGENT = 'agent-wp2';
const WS = 'ws-wp2';

function seedFileActivities(): void {
  const db = dbm.getDb();
  const ins = db.prepare(
    'INSERT INTO file_activities (id, agent_id, file_path, operation, generation, session_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // 1: intact-ST polluted → clean absolute native path (repaired, survives).
  ins.run(1, AGENT, osc8('file:///C:/repo/src/main.ts', 'C:\\repo\\src\\main.ts'), 'write', 0, 's1');
  // 2: ambiguous nested link → DELETED (quarantine == delete).
  ins.run(2, AGENT, ambiguousLink(), 'write', 0, 's1');
  // 3: polluted value recovering only to a RELATIVE path, no cwd → DELETED.
  ins.run(3, AGENT, osc8('file:src/rel.ts', 'src\\rel.ts'), 'write', 0, 's1');
  // 100/101: NULL-session collision — both recover to the same absolute path.
  ins.run(100, AGENT, osc8('file:///C:/repo/dup.ts', 'C:\\repo\\dup.ts'), 'write', 0, null);
  ins.run(101, AGENT, osc8('file:///C:/repo/dup.ts', 'C:\\repo\\dup.ts'), 'write', 0, null);
  // 200 (already-clean) + 201 (polluted) collide on the same non-null session →
  // lowest id (the clean 200) survives, the repaired 201 is merged away.
  ins.run(200, AGENT, 'C:\\repo\\shared.ts', 'write', 0, 's2');
  ins.run(201, AGENT, osc8('file:///C:/repo/shared.ts', 'C:\\repo\\shared.ts'), 'write', 0, 's2');
  // 300: standalone already-clean row, unique identity → must be left untouched.
  ins.run(300, AGENT, 'C:\\repo\\clean.ts', 'read', 0, 's9');
}

function seedTurnRecords(): void {
  const db = dbm.getDb();
  const ins = db.prepare(
    'INSERT INTO turn_records (id, workspace_id, turn_seq, status, touched) VALUES (?, ?, ?, ?, ?)'
  );
  // Already-clean row → untouched.
  ins.run('t-clean', WS, 1, 'closed', JSON.stringify([{ path: 'src/keep.ts', op: 'write' }]));
  // Polluted row: valid, duplicate-of-valid (merged), ambiguous (discarded),
  // absolute (discarded).
  const touched = [
    { path: osc8('file:///src/b.ts', 'src/b.ts'), op: 'write' },
    { path: osc8('file:///src/b.ts', 'src/b.ts'), op: 'write' }, // dup (path, op)
    { path: ambiguousLink(), op: 'write' },                       // ambiguous → drop
    { path: osc8('file:///C:/x.ts', 'C:\\x.ts'), op: 'create' },  // absolute → drop
  ];
  ins.run('t-dirty', WS, 2, 'closed', JSON.stringify(touched));
}

function seedRecoveryOperations(): void {
  const db = dbm.getDb();
  const ins = db.prepare(
    `INSERT INTO recovery_operations
       (id, workspace_id, kind, actor, status, pre_included_paths, requested_paths, completed_paths)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Already-clean row → untouched.
  ins.run('r-clean', WS, 'restore_paths', 'human-ipc', 'completed',
    JSON.stringify([{ path: 'lib/keep.ts', state: 'modified' }]),
    JSON.stringify(['lib/keep.ts']),
    JSON.stringify(['lib/keep.ts']));
  // Polluted row.
  const preIncluded = [
    { path: osc8('file:///lib/c.ts', 'lib/c.ts'), state: 'modified' }, // valid
    { path: ambiguousLink(), state: 'deleted' },                        // ambiguous → drop
  ];
  const requested = [
    osc8('file:///lib/d.ts', 'lib/d.ts'),  // valid
    osc8('file:///lib/d.ts', 'lib/d.ts'),  // dup → merged
    osc8('file:///C:/y.ts', 'C:\\y.ts'),   // absolute → drop
  ];
  ins.run('r-dirty', WS, 'restore_paths', 'human-ipc', 'completed',
    JSON.stringify(preIncluded), JSON.stringify(requested), null);
}

function faRows(): Array<{ id: number; file_path: string; session_id: string | null }> {
  return dbm.getDb()
    .prepare('SELECT id, file_path, session_id FROM file_activities ORDER BY id ASC')
    .all() as Array<{ id: number; file_path: string; session_id: string | null }>;
}
function touchedOf(id: string): unknown {
  const row = dbm.getDb().prepare('SELECT touched FROM turn_records WHERE id = ?').get(id) as { touched: string };
  return JSON.parse(row.touched);
}
function recoveryOf(id: string): { pre: unknown; req: unknown; done: string | null } {
  const row = dbm.getDb()
    .prepare('SELECT pre_included_paths, requested_paths, completed_paths FROM recovery_operations WHERE id = ?')
    .get(id) as { pre_included_paths: string; requested_paths: string; completed_paths: string | null };
  return {
    pre: JSON.parse(row.pre_included_paths),
    req: JSON.parse(row.requested_paths),
    done: row.completed_paths,
  };
}

// ── shared migration results (single first run captured in the runner) ─────────
// The migration processes every store on each call, so per-table assertions must
// come from ONE first-run result; a second run drives the idempotency assertions.
let firstRun: ReturnType<DbModule['sanitizeHistoricalWitnessPaths']>;
let afterFirst: { fa: ReturnType<typeof faRows>; tDirty: unknown; tClean: unknown; rDirty: ReturnType<typeof recoveryOf>; rClean: ReturnType<typeof recoveryOf> };
let secondRun: ReturnType<DbModule['sanitizeHistoricalWitnessPaths']>;

// ── tests ───────────────────────────────────────────────────────────────────

test('file_activities: repaired / discarded / null-session merge with lowest-id kept', () => {
  // 1, 100, 101, 201 repaired (normalized in place); 101 & 201 then merged away.
  assert.deepEqual(firstRun.file_activities, { repaired: 4, discarded: 2, merged: 2 }, 'file_activities counts');

  const rows = afterFirst.fa;
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, [1, 100, 200, 300], 'ambiguous(2)/relative(3) deleted; lowest-id kept per collision (100 over 101, 200 over 201)');

  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(1)!.file_path, 'C:\\repo\\src\\main.ts', 'intact-ST → absolute native');
  assert.equal(byId.get(100)!.file_path, 'C:\\repo\\dup.ts', 'null-session survivor is lowest id');
  assert.equal(byId.get(100)!.session_id, null, 'survivor keeps NULL session');
  assert.equal(byId.get(200)!.file_path, 'C:\\repo\\shared.ts', 'clean row (lowest id) survives collision, unchanged');
  assert.equal(byId.get(300)!.file_path, 'C:\\repo\\clean.ts', 'standalone clean row untouched');
});

test('turn_records.touched: unwrap + structural reject + (path, op) re-dedupe', () => {
  assert.deepEqual(firstRun.turn_records, { repaired: 1, discarded: 2, merged: 1 }, 'turn_records counts');

  assert.deepEqual(afterFirst.tDirty, [{ path: 'src/b.ts', op: 'write' }],
    'only the single valid workspace-relative POSIX entry survives');
  assert.deepEqual(afterFirst.tClean, [{ path: 'src/keep.ts', op: 'write' }],
    'already-clean touched left untouched');
});

test('recovery_operations arrays: unwrap + structural reject + re-dedupe', () => {
  assert.deepEqual(firstRun.recovery_operations, { repaired: 1, discarded: 2, merged: 1 }, 'recovery_operations counts');

  const dirty = afterFirst.rDirty;
  assert.deepEqual(dirty.pre, [{ path: 'lib/c.ts', state: 'modified' }], 'object array: valid entry kept, ambiguous dropped, other fields preserved');
  assert.deepEqual(dirty.req, ['lib/d.ts'], 'string array: valid kept, dup merged, absolute dropped');
  assert.equal(dirty.done, null, 'null column untouched');

  const clean = afterFirst.rClean;
  assert.deepEqual(clean.pre, [{ path: 'lib/keep.ts', state: 'modified' }], 'already-clean row untouched');
  assert.deepEqual(clean.req, ['lib/keep.ts']);
});

test('idempotent: a second run is a total no-op (all counts zero, data identical)', () => {
  assert.deepEqual(secondRun.file_activities, { repaired: 0, discarded: 0, merged: 0 }, 'file_activities no-op');
  assert.deepEqual(secondRun.turn_records, { repaired: 0, discarded: 0, merged: 0 }, 'turn_records no-op');
  assert.deepEqual(secondRun.recovery_operations, { repaired: 0, discarded: 0, merged: 0 }, 'recovery_operations no-op');

  assert.deepEqual(faRows(), afterFirst.fa, 'file_activities rows unchanged on re-run');
  assert.deepEqual(touchedOf('t-dirty'), afterFirst.tDirty, 'touched unchanged on re-run');
  assert.deepEqual(recoveryOf('r-dirty'), afterFirst.rDirty, 'recovery arrays unchanged on re-run');
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-sanitize-'));
  process.env.APPDATA = tmpAppData;

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
  dbm.initDatabase();

  // Seed AFTER init so the boot-time migration ran on an empty table; the explicit
  // sanitize calls below are the migration-under-test.
  seedFileActivities();
  seedTurnRecords();
  seedRecoveryOperations();

  // First run — captured for per-table count + post-state assertions.
  firstRun = dbm.sanitizeHistoricalWitnessPaths(dbm.getDb());
  afterFirst = {
    fa: faRows(),
    tDirty: touchedOf('t-dirty'),
    tClean: touchedOf('t-clean'),
    rDirty: recoveryOf('r-dirty'),
    rClean: recoveryOf('r-clean'),
  };
  // Second run — drives the idempotency assertions.
  secondRun = dbm.sanitizeHistoricalWitnessPaths(dbm.getDb());

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
