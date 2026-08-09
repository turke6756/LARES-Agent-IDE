// Planning-surface WP-P2A — proposals table + plans folder/promotion columns +
// partial unique indexes. DDL idempotency + constraint proofs.
//
//   npm run build:main
//   node dist/main/main/database.proposals.test.js

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
  static lastPath = '';
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    FakeBetterSqlite.lastPath = dbPath;
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

  // Raw access to the live store for schema-level assertions the accessor layer
  // does not surface (e.g. writing the P3-owned plans columns to prove their
  // partial unique indexes reject collisions).
  private static store(): SqlJsDatabase {
    const s = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath);
    if (!s) throw new Error('no store for last path');
    return s;
  }
  static rawExec(sql: string): void { FakeBetterSqlite.store().exec(sql); }
  static rawRun(sql: string, params: unknown[] = []): void { FakeBetterSqlite.store().run(sql, params); }
  static rawAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = FakeBetterSqlite.store().prepare(sql);
    try {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }
}

type ProposalRecord = {
  id: string;
  artifactId: string | null;
  workspaceId: string;
  path: string;
  slug: string | null;
  title: string | null;
  state: 'proposal' | 'promoted' | 'archived';
  authorAgentId: string | null;
  authorRole: 'supervisor' | 'worker' | 'unknown';
  authorDisplay: string | null;
  authoredAt: number | null;
  createdAt: number;
  updatedAt: number;
  mtimeMs: number | null;
  sizeBytes: number | null;
  promotedToPlanId: string | null;
  deletedAt: number | null;
};

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  insertProposalRecord(rec: ProposalRecord): void;
  getProposalByWorkspacePath(workspaceId: string, path: string): ProposalRecord | null;
  listProposalsByWorkspace(workspaceId: string): ProposalRecord[];
};

let dbm: DbModule;

function makeProposal(over: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'prop-1', artifactId: null, workspaceId: 'ws-1',
    path: '.lares/proposals/2026-08-03-a.md', slug: '2026-08-03-a', title: 'A',
    state: 'proposal', authorAgentId: null, authorRole: 'unknown', authorDisplay: null,
    authoredAt: null, createdAt: 1000, updatedAt: 1000, mtimeMs: 500, sizeBytes: 42,
    promotedToPlanId: null, deletedAt: null,
    ...over,
  };
}

// Insert a plans row directly, exercising the real plans schema (incl. the five
// WP-P2A columns) without an accessor that does not exist yet (P3B writes them).
function rawInsertPlan(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'plan-x', workspace_id: 'ws-1', path: '.lares/plans/x/plan.md', slug: 'x',
    format: 'structured', run_state: 'hardening', mtime_ms: 1, size_bytes: 1,
    artifact_id: null, source_proposal_id: null, promoted_at: null,
    promoted_content_hash: null, folder_rel_path: null,
    ...over,
  };
  const cols = Object.keys(row);
  FakeBetterSqlite.rawRun(
    `INSERT INTO plans (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  );
}

test('a proposal round-trips through insert / get / list', () => {
  const p = makeProposal({ id: 'prop-rt', path: '.lares/proposals/rt.md', artifactId: 'prop_abc' });
  dbm.insertProposalRecord(p);
  assert.deepEqual(dbm.getProposalByWorkspacePath('ws-1', '.lares/proposals/rt.md'), p);
  assert.deepEqual(dbm.getProposalByWorkspacePath('ws-1', '.lares/proposals/none.md'), null);
  assert.ok(dbm.listProposalsByWorkspace('ws-1').some((r) => r.id === 'prop-rt'));
});

test('UNIQUE(workspace_id, path) rejects a duplicate path', () => {
  dbm.insertProposalRecord(makeProposal({ id: 'prop-u1', path: '.lares/proposals/dup.md' }));
  assert.throws(() => dbm.insertProposalRecord(makeProposal({ id: 'prop-u2', path: '.lares/proposals/dup.md' })));
});

test('the (workspace_id, artifact_id) index is partial — unique when present, many NULLs allowed', () => {
  dbm.insertProposalRecord(makeProposal({ id: 'prop-a1', path: '.lares/proposals/a1.md', artifactId: 'prop_dupid' }));
  // Same artifact_id in the same workspace → rejected.
  assert.throws(() => dbm.insertProposalRecord(
    makeProposal({ id: 'prop-a2', path: '.lares/proposals/a2.md', artifactId: 'prop_dupid' })));
  // Same artifact_id in a DIFFERENT workspace → allowed (index is per-workspace).
  dbm.insertProposalRecord(makeProposal({ id: 'prop-a3', workspaceId: 'ws-2', path: '.lares/proposals/a3.md', artifactId: 'prop_dupid' }));
  // Multiple NULL artifact_ids in one workspace → allowed (partial index skips NULLs).
  dbm.insertProposalRecord(makeProposal({ id: 'prop-a4', path: '.lares/proposals/a4.md', artifactId: null }));
  dbm.insertProposalRecord(makeProposal({ id: 'prop-a5', path: '.lares/proposals/a5.md', artifactId: null }));
});

test('the (promoted_to_plan_id) index is partial — unique when present, many NULLs allowed', () => {
  dbm.insertProposalRecord(makeProposal({ id: 'prop-p1', path: '.lares/proposals/p1.md', promotedToPlanId: 'plan-shared' }));
  assert.throws(() => dbm.insertProposalRecord(
    makeProposal({ id: 'prop-p2', path: '.lares/proposals/p2.md', promotedToPlanId: 'plan-shared' })));
  // NULLs never collide.
  dbm.insertProposalRecord(makeProposal({ id: 'prop-p3', path: '.lares/proposals/p3.md', promotedToPlanId: null }));
  dbm.insertProposalRecord(makeProposal({ id: 'prop-p4', path: '.lares/proposals/p4.md', promotedToPlanId: null }));
});

test('the state CHECK rejects an unknown state with no row', () => {
  assert.throws(() => dbm.insertProposalRecord(
    makeProposal({ id: 'prop-badstate', path: '.lares/proposals/bs.md', state: 'draft' as any })));
  assert.equal(dbm.getProposalByWorkspacePath('ws-1', '.lares/proposals/bs.md'), null);
});

test('the author_role CHECK rejects an unknown role with no row', () => {
  assert.throws(() => dbm.insertProposalRecord(
    makeProposal({ id: 'prop-badrole', path: '.lares/proposals/br.md', authorRole: 'human' as any })));
  assert.equal(dbm.getProposalByWorkspacePath('ws-1', '.lares/proposals/br.md'), null);
});

test('plans carries exactly the five WP-P2A columns (present + writable)', () => {
  const cols = FakeBetterSqlite.rawAll(`PRAGMA table_info(plans)`).map((r) => String(r.name));
  for (const c of ['artifact_id', 'source_proposal_id', 'promoted_at', 'promoted_content_hash', 'folder_rel_path']) {
    assert.ok(cols.includes(c), `plans must have column ${c}`);
  }
  // responsible_supervisor_id is P3A's, added by its own inline FK — now landed.
  assert.ok(cols.includes('responsible_supervisor_id'), 'responsible_supervisor_id belongs to P3A (landed)');
});

test('plans(workspace_id, artifact_id) partial unique index rejects a same-workspace collision', () => {
  rawInsertPlan({ id: 'pl-art-1', path: '.lares/plans/art1/plan.md', artifact_id: 'plan_dup' });
  assert.throws(() => rawInsertPlan({ id: 'pl-art-2', path: '.lares/plans/art2/plan.md', artifact_id: 'plan_dup' }));
  // Different workspace → allowed; NULLs → allowed.
  rawInsertPlan({ id: 'pl-art-3', workspace_id: 'ws-2', path: '.lares/plans/art3/plan.md', artifact_id: 'plan_dup' });
  rawInsertPlan({ id: 'pl-art-4', path: '.lares/plans/art4/plan.md', artifact_id: null });
  rawInsertPlan({ id: 'pl-art-5', path: '.lares/plans/art5/plan.md', artifact_id: null });
});

test('plans(source_proposal_id) partial unique index rejects a duplicate source', () => {
  rawInsertPlan({ id: 'pl-src-1', path: '.lares/plans/src1/plan.md', source_proposal_id: 'prop_src' });
  assert.throws(() => rawInsertPlan({ id: 'pl-src-2', path: '.lares/plans/src2/plan.md', source_proposal_id: 'prop_src' }));
  rawInsertPlan({ id: 'pl-src-3', path: '.lares/plans/src3/plan.md', source_proposal_id: null });
  rawInsertPlan({ id: 'pl-src-4', path: '.lares/plans/src4/plan.md', source_proposal_id: null });
});

test('plans(workspace_id, folder_rel_path) is unique per workspace only when present', () => {
  rawInsertPlan({ id: 'pl-f-1', path: '.lares/plans/f1/plan.md', folder_rel_path: '.lares/plans/shared' });
  // Same folder_rel_path in the same workspace → rejected.
  assert.throws(() => rawInsertPlan({ id: 'pl-f-2', path: '.lares/plans/f2/plan.md', folder_rel_path: '.lares/plans/shared' }));
  // Same folder_rel_path across workspaces → allowed.
  rawInsertPlan({ id: 'pl-f-3', workspace_id: 'ws-2', path: '.lares/plans/f3/plan.md', folder_rel_path: '.lares/plans/shared' });
  // NULL folder_rel_path (legacy rows) never collide.
  rawInsertPlan({ id: 'pl-f-4', path: '.lares/plans/f4/plan.md', folder_rel_path: null });
  rawInsertPlan({ id: 'pl-f-5', path: '.lares/plans/f5/plan.md', folder_rel_path: null });
});

test('WP-ID1 reviewed exact mapping backfills source_proposal_id and leaves unrelated history unbound', () => {
  const proposalPath = '.lares/proposals/2026-08-03-test-only-keyboard-shortcut-cheat-sheet.md';
  dbm.insertProposalRecord(makeProposal({
    id: 'reviewed-proposal-row', artifactId: 'prop_e3a91c4f', path: proposalPath,
  }));
  rawInsertPlan({
    id: 'reviewed-plan-row', artifact_id: 'plan_e3a91c4f',
    path: '.lares/plans/2026-08-03-test-only-keyboard-shortcut-cheat-sheet-overlay-e3a91c4f/plan.md',
    folder_rel_path: '.lares/plans/2026-08-03-test-only-keyboard-shortcut-cheat-sheet-overlay-e3a91c4f',
  });
  rawInsertPlan({
    id: 'unreviewed-plan-row', artifact_id: 'plan_deadbeef',
    path: '.lares/plans/unreviewed/plan.md', folder_rel_path: '.lares/plans/unreviewed',
  });
  FakeBetterSqlite.rawRun(
    `INSERT INTO orchestrations
      (run_id, name, mode, status, workspace_id, supervisor_id, topic, plan_path,
       lead_provider, reviewer_provider, turn_timeout_ms, started_at, updated_at, plan_id)
     VALUES (?, 'groupthink', 'parallel', 'complete', 'ws-1', 'sup-1', 'legacy', ?,
       'codex', 'claude', 600000, ?, ?, ?)`,
    ['a1bacc4a', '.lares/plans/unreviewed/plan.md', '2026-08-06T00:00:00Z',
      '2026-08-06T00:00:00Z', 'unreviewed-plan-row'],
  );

  dbm.initDatabase();

  const reviewed = FakeBetterSqlite.rawAll(
    'SELECT source_proposal_id FROM plans WHERE id = ?', ['reviewed-plan-row'],
  )[0];
  assert.equal(reviewed.source_proposal_id, 'reviewed-proposal-row');
  assert.equal(FakeBetterSqlite.rawAll(
    'SELECT source_proposal_id FROM plans WHERE id = ?', ['unreviewed-plan-row'],
  )[0].source_proposal_id, null, 'unreviewed plan is untouched');
  assert.equal(FakeBetterSqlite.rawAll(
    'SELECT planning_intent_id FROM orchestrations WHERE run_id = ?', ['a1bacc4a'],
  )[0].planning_intent_id, null, 'historical a1bacc4a remains legacy-unbound');

  dbm.initDatabase();
  assert.equal(FakeBetterSqlite.rawAll(
    'SELECT source_proposal_id FROM plans WHERE id = ?', ['reviewed-plan-row'],
  )[0].source_proposal_id, 'reviewed-proposal-row', 'guarded rerun is idempotent');
});

test('re-running initDatabase is idempotent (tables + indexes survive a double run)', () => {
  // A second migration pass over the same store must not throw (CREATE ... IF NOT
  // EXISTS + guarded ALTER try/catch) and must leave the data intact.
  const before = dbm.listProposalsByWorkspace('ws-1').length;
  dbm.initDatabase();
  assert.equal(dbm.listProposalsByWorkspace('ws-1').length, before);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-'));
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

  // A workspace row so any FK-shaped reads have a real parent to point at.
  try { dbm.createWorkspace({ title: 'ws-1', path: tmpAppData, pathType: 'local' }); } catch { /* best-effort */ }

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
