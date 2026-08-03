// Planning-surface WP-P2A — md-row policy. A legacy plans(format='md') row is a
// hidden, preserved historical record: it is never shown as a plan and never
// duplicated into `proposals`. When the same path later registers as a proposals
// row (reader/watcher, WP-P2B), the md row stays put — no dup, no mutation — and
// the diagnostic inventory count is the sole surface of its existence.
//
//   npm run build:main
//   node dist/main/main/md-row-adoption.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

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

  pragma(_sql: string): unknown { return undefined; }
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

type ProposalRecord = {
  id: string; artifactId: string | null; workspaceId: string; path: string;
  slug: string | null; title: string | null;
  state: 'proposal' | 'promoted' | 'archived';
  authorAgentId: string | null; authorRole: 'supervisor' | 'worker' | 'unknown';
  authorDisplay: string | null; authoredAt: number | null;
  createdAt: number; updatedAt: number; mtimeMs: number | null;
  sizeBytes: number | null; promotedToPlanId: string | null; deletedAt: number | null;
};

type Plan = { id: string; path: string; format: string; deletedAt?: string | null };

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createOrRevivePlan(input: { workspaceId: string; path: string; format: string; slug?: string | null; runState?: string | null; mtimeMs?: number; sizeBytes?: number }): Plan;
  getPlans(filters?: { workspaceId?: string; includeDeleted?: boolean }): Plan[];
  insertProposalRecord(rec: ProposalRecord): void;
  getProposalByWorkspacePath(workspaceId: string, path: string): ProposalRecord | null;
  listProposalsByWorkspace(workspaceId: string): ProposalRecord[];
  countHiddenMdPlanRows(workspaceId?: string): number;
};

let dbm: DbModule;
let wsId: string;

function makeProposal(over: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'prop-1', artifactId: null, workspaceId: wsId,
    path: '.lares/proposals/x.md', slug: 'x', title: 'X', state: 'proposal',
    authorAgentId: null, authorRole: 'unknown', authorDisplay: null, authoredAt: null,
    createdAt: 2000, updatedAt: 2000, mtimeMs: 10, sizeBytes: 20,
    promotedToPlanId: null, deletedAt: null,
    ...over,
  };
}

test('an md plan row is counted by the diagnostic inventory and NOT by an html plan', () => {
  dbm.createOrRevivePlan({ workspaceId: wsId, path: 'plans/legacy-a.md', format: 'md', mtimeMs: 1, sizeBytes: 1 });
  dbm.createOrRevivePlan({ workspaceId: wsId, path: 'plans/legacy-b.html', format: 'html', mtimeMs: 1, sizeBytes: 1 });
  assert.equal(dbm.countHiddenMdPlanRows(wsId), 1, 'only the md row is counted');
  assert.equal(dbm.countHiddenMdPlanRows(), 1, 'unscoped count matches');
});

test('an md row whose path later registers as a proposal stays hidden, preserved, and unduplicated', () => {
  const sharedPath = '.lares/proposals/2026-08-03-shared.md';

  // 1. A legacy md plan row exists at the shared path.
  dbm.createOrRevivePlan({ workspaceId: wsId, path: sharedPath, format: 'md', mtimeMs: 5, sizeBytes: 5 });
  const mdBefore = dbm.countHiddenMdPlanRows(wsId);
  assert.ok(mdBefore >= 1, 'md row present before adoption');

  // 2. The reader/watcher later registers the SAME path as a proposals row (WP-P2B
  //    behavior, simulated here at the schema layer). This is a separate table —
  //    the md row is neither converted nor consulted.
  dbm.insertProposalRecord(makeProposal({ id: 'prop-shared', path: sharedPath, artifactId: 'prop_shared' }));

  // 3. Exactly ONE proposals row exists at the path — no duplicate minted.
  const atPath = dbm.listProposalsByWorkspace(wsId).filter((p) => p.path === sharedPath);
  assert.equal(atPath.length, 1, 'exactly one proposals row — no dup');
  assert.equal(dbm.getProposalByWorkspacePath(wsId, sharedPath)?.id, 'prop-shared');

  // 4. The md row is preserved untouched — still counted, never surfaced as a plan.
  assert.equal(dbm.countHiddenMdPlanRows(wsId), mdBefore, 'md inventory unchanged — row preserved, not deleted or duplicated');
  const shownPlans = dbm.getPlans({ workspaceId: wsId }).filter((p) => p.format === 'md');
  // The md row is still present in the raw store (preserved historical record);
  // higher layers exclude format='md' from any user-facing gallery (P2C). At the
  // schema layer we assert it was not deleted as a side effect of adoption.
  assert.ok(shownPlans.some((p) => p.path === sharedPath), 'md row still present (preserved), never dropped');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-row-'));
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
  wsId = dbm.createWorkspace({ title: 'ws', path: tmpAppData, pathType: 'local' }).id;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
