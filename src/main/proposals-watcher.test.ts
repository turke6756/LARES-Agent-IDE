// WP-P2B — proposals-watcher: witnessed attribution, adopt/mint, duplicate +
// malformed policies, dir-ensure. Compiled-node test (mirrors
// database.proposals.test.ts's fake-better-sqlite3 harness):
//
//   npm run build:main
//   node dist/main/main/proposals-watcher.test.js
//
// NOT registered in scripts/run-main-tests.mjs here — the stage-end gate (P2Z)
// owns that edit.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

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
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
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
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
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
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

// ── Types mirrored off the real modules (structural) ─────────────────────────
type ProposalRecord = {
  id: string; artifactId: string | null; workspaceId: string; path: string;
  slug: string | null; title: string | null;
  state: 'proposal' | 'promoted' | 'archived';
  authorAgentId: string | null; authorRole: 'supervisor' | 'worker' | 'unknown';
  authorDisplay: string | null; authoredAt: number | null;
  createdAt: number; updatedAt: number; mtimeMs: number | null; sizeBytes: number | null;
  promotedToPlanId: string | null; deletedAt: number | null;
};

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createAgent(data: Record<string, unknown>): { id: string; title: string };
  addFileActivity(agentId: string, filePath: string, operation: string): unknown;
  getProposalByWorkspacePath(workspaceId: string, path: string): ProposalRecord | null;
  listProposalsByWorkspace(workspaceId: string): ProposalRecord[];
};

type Diagnostic = {
  kind: 'duplicate-artifact-id' | 'malformed-frontmatter' | 'non-contract-artifact-id';
  workspaceId: string; relPath: string; otherRelPath?: string; detail: string;
};
type ReconcileResult = { registered: ProposalRecord[]; diagnostics: Diagnostic[] };
type Ws = { id: string; path: string; pathType: string };

type WatcherModule = {
  ProposalsWatcher: new (opts?: { now?: () => number }) => {
    reconcileWorkspace(ws: Ws): ReconcileResult;
  };
  ensureProposalsDir(ws: Ws): void;
  analyzeFrontmatter(raw: string): { kind: 'present' | 'absent' | 'malformed'; fields?: Record<string, string> };
  insertArtifactId(raw: string, id: string): string | null;
  mintArtifactId(): string;
};

let dbm: DbModule;
let wm: WatcherModule;
let wsRoot = '';
let ws: Ws;

// Deterministic clock for created_at/updated_at.
let clock = 1000;
function newWatcher() { return new wm.ProposalsWatcher({ now: () => clock }); }

// ── Fixture helpers ──────────────────────────────────────────────────────────
function proposalsDir(): string { return path.join(wsRoot, '.lares', 'proposals'); }
function writeProposal(name: string, content: string): string {
  const abs = path.join(proposalsDir(), name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}
function makeSupervisor(title: string): { id: string; title: string } {
  return dbm.createAgent({
    workspaceId: ws.id, title, roleDescription: 'sup', workingDirectory: wsRoot,
    command: 'x', isSupervisor: true, tmuxSessionName: null, autoRestartEnabled: false, logPath: 'x.log',
  });
}

// ── Pure-helper tests ────────────────────────────────────────────────────────
test('analyzeFrontmatter classifies present / absent / malformed', () => {
  assert.equal(wm.analyzeFrontmatter('---\ntitle: A\n---\n\nbody').kind, 'present');
  assert.equal(wm.analyzeFrontmatter('# no frontmatter\n').kind, 'absent');
  assert.equal(wm.analyzeFrontmatter('---\ntitle: A\n\n# body, no close').kind, 'malformed');
});

test('insertArtifactId is additive, idempotent, and CRLF-preserving', () => {
  // Absent → fresh block prepended.
  const fromAbsent = wm.insertArtifactId('# Body only\n', 'prop_x');
  assert.ok(fromAbsent && /^---\nartifact_id: prop_x\n---\n/.test(fromAbsent));
  assert.ok(fromAbsent!.endsWith('# Body only\n'));

  // Present-without-id → inserted into the existing block; body untouched.
  const present = '---\ntitle: T\n---\n\nBODY';
  const withId = wm.insertArtifactId(present, 'prop_y')!;
  assert.ok(withId.includes('artifact_id: prop_y'));
  assert.ok(withId.includes('title: T') && withId.endsWith('BODY'));

  // Already has an id → unchanged (idempotent).
  assert.equal(wm.insertArtifactId(withId, 'prop_z'), withId);

  // Malformed → refuse (never rewrite).
  assert.equal(wm.insertArtifactId('---\ntitle: T\nno close', 'prop_q'), null);

  // CRLF preserved.
  const crlf = wm.insertArtifactId('---\r\ntitle: T\r\n---\r\n\r\nBODY', 'prop_c')!;
  assert.ok(crlf.includes('artifact_id: prop_c\r\n'));
  assert.ok(!crlf.includes('artifact_id: prop_c\n\r') && crlf.includes('\r\n'));
});

// ── Watcher behavior ─────────────────────────────────────────────────────────
test('ensureProposalsDir creates the resolved dir without a supervisor launch', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ensure-'));
  const w: Ws = { id: 'ws-ensure', path: fresh, pathType: 'windows' };
  assert.equal(fs.existsSync(path.join(fresh, '.lares', 'proposals')), false);
  wm.ensureProposalsDir(w);
  assert.equal(fs.existsSync(path.join(fresh, '.lares', 'proposals')), true);
  fs.rmSync(fresh, { recursive: true, force: true });
});

test('an adopted proposal with no witnessed write registers as author_role=unknown', () => {
  writeProposal('adopt.md', '---\nartifact_id: prop_ada0beef\ntitle: Adopt Me\nauthored_at: 2026-08-01T10:00:00Z\n---\n\nbody');
  clock = 2000;
  const res = newWatcher().reconcileWorkspace(ws);
  const row = dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/adopt.md');
  assert.ok(row, 'registered');
  assert.equal(row!.artifactId, 'prop_ada0beef');   // adopted, not minted
  assert.equal(row!.title, 'Adopt Me');
  assert.equal(row!.authorRole, 'unknown');       // no witness ⇒ unknown
  assert.equal(row!.authorAgentId, null);
  assert.equal(row!.createdAt, 2000);
  assert.equal(row!.authoredAt, Date.parse('2026-08-01T10:00:00Z'));
  assert.ok(res.registered.some((r) => r.path === '.lares/proposals/adopt.md'));
});

test('created_at stays stable across an edit (date-grouping key)', () => {
  writeProposal('stable.md', '---\nartifact_id: prop_57ab1e00\ntitle: One\n---\n\nv1');
  clock = 3000;
  newWatcher().reconcileWorkspace(ws);
  const first = dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/stable.md')!;
  assert.equal(first.createdAt, 3000);
  // Edit the file → new mtime/size; reconcile at a later clock.
  writeProposal('stable.md', '---\nartifact_id: prop_57ab1e00\ntitle: One edited longer body\n---\n\nv2 much longer');
  clock = 9999;
  newWatcher().reconcileWorkspace(ws);
  const second = dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/stable.md')!;
  assert.equal(second.createdAt, 3000, 'created_at unchanged');
  assert.equal(second.updatedAt, 9999, 'updated_at refreshed');
  assert.equal(second.title, 'One edited longer body');
});

test('a witnessed supervisor write attributes author_role=supervisor + display', () => {
  const abs = writeProposal('witnessed.md', '---\nartifact_id: prop_017e55ed\ntitle: Witnessed\n---\n\nbody');
  const sup = makeSupervisor('Planning Supervisor');
  dbm.addFileActivity(sup.id, abs, 'write');
  clock = 4000;
  newWatcher().reconcileWorkspace(ws);
  const row = dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/witnessed.md')!;
  assert.equal(row.authorRole, 'supervisor');
  assert.equal(row.authorAgentId, sup.id);
  assert.equal(row.authorDisplay, 'Planning Supervisor');
});

test('a missing artifact_id is minted, inserted into the file, and registered', () => {
  const abs = writeProposal('mint.md', '---\ntitle: Needs An Id\n---\n\nbody');
  clock = 5000;
  const res = newWatcher().reconcileWorkspace(ws);
  const row = dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/mint.md')!;
  assert.ok(row.artifactId && row.artifactId.startsWith('prop_'), 'minted id present in DB');
  // The id was written back into the file (idempotent adopt next scan).
  const onDisk = fs.readFileSync(abs, 'utf8');
  assert.ok(onDisk.includes(`artifact_id: ${row.artifactId}`), 'id inserted into frontmatter');
  assert.ok(onDisk.includes('title: Needs An Id') && onDisk.trimEnd().endsWith('body'));
  assert.equal(res.diagnostics.length, 0);
  // Re-scan adopts the now-present id (no second mint, no duplicate).
  clock = 5001;
  const res2 = newWatcher().reconcileWorkspace(ws);
  assert.equal(res2.diagnostics.filter((d) => d.relPath === '.lares/proposals/mint.md').length, 0);
  assert.equal(dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/mint.md')!.artifactId, row.artifactId);
});

test('a duplicate artifact_id leaves the second file unregistered with a both-paths diagnostic', () => {
  writeProposal('dup-a.md', '---\nartifact_id: prop_d00fd00f\ntitle: A\n---\n\nbody');
  writeProposal('dup-b.md', '---\nartifact_id: prop_d00fd00f\ntitle: B\n---\n\nbody');
  clock = 6000;
  const res = newWatcher().reconcileWorkspace(ws);
  // a sorts before b → a is canonical, b is the duplicate.
  assert.ok(dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/dup-a.md'), 'canonical registered');
  assert.equal(dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/dup-b.md'), null, 'duplicate NOT registered');
  const diag = res.diagnostics.find((d) => d.kind === 'duplicate-artifact-id' && d.relPath === '.lares/proposals/dup-b.md');
  assert.ok(diag, 'duplicate diagnostic surfaced');
  assert.equal(diag!.otherRelPath, '.lares/proposals/dup-a.md');
});

test('malformed frontmatter is quarantined — not registered, never rewritten', () => {
  const abs = writeProposal('broken.md', '---\ntitle: Broken\nno closing fence here\n# body');
  const before = fs.readFileSync(abs, 'utf8');
  clock = 7000;
  const res = newWatcher().reconcileWorkspace(ws);
  assert.equal(dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/broken.md'), null, 'not registered');
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'file untouched (never rewritten)');
  assert.ok(res.diagnostics.some((d) => d.kind === 'malformed-frontmatter' && d.relPath === '.lares/proposals/broken.md'));
});

test('a non-contract artifact_id is visibly quarantined and never registered', () => {
  const abs = writeProposal('non-contract.md', '---\nartifact_id: prop_pigt5a83\ntitle: Legacy shape\n---\n\nbody');
  const before = fs.readFileSync(abs, 'utf8');
  const res = newWatcher().reconcileWorkspace(ws);
  assert.equal(dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/non-contract.md'), null);
  assert.equal(fs.readFileSync(abs, 'utf8'), before, 'quarantine never rewrites identity');
  assert.ok(res.diagnostics.some((d) => d.kind === 'non-contract-artifact-id'
    && d.relPath === '.lares/proposals/non-contract.md'));
});

test('a vanished proposal is soft-deleted (row survives with deleted_at)', () => {
  const abs = writeProposal('ephemeral.md', '---\nartifact_id: prop_e9eea111\ntitle: Bye\n---\n\nbody');
  clock = 8000;
  newWatcher().reconcileWorkspace(ws);
  assert.ok(dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/ephemeral.md'));
  fs.rmSync(abs);
  clock = 8500;
  newWatcher().reconcileWorkspace(ws);
  const row = dbm.getProposalByWorkspacePath(ws.id, '.lares/proposals/ephemeral.md')!;
  assert.ok(row, 'row survives');
  assert.equal(row.deletedAt, 8500, 'stamped deleted_at');
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-appdata-'));
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  wm = require('./proposals-watcher') as WatcherModule;
  dbm.initDatabase();

  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ws-'));
  const created = dbm.createWorkspace({ title: 'ws', path: wsRoot, pathType: 'windows' });
  ws = { id: created.id, path: wsRoot, pathType: 'windows' };

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
