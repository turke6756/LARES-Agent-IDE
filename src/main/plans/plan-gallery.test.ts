// WP-P2C — unified gallery projection + safe proposal read.
//   npm run build:main
//   node dist/main/main/plans/plan-gallery.test.js
//
// Proves the acceptance items: the three row types render; `md` is excluded;
// legacy HTML rows are present + labeled "Legacy Plan"; `hasFolder` set for
// folder plans; the owner chip reflects plan.json responsibility (never labeled
// "author"); structured-folder author is `unknown` unless witnessed;
// `proposal:read` enforces containment + a byte cap. Empty tables are a valid
// state (WP-P2B/WP-P2B-folder land in parallel).
//
// Uses the sql.js-backed better-sqlite3 fake (mirrors database.proposals.test)
// so the REAL database module + the REAL plan-gallery module run against a live
// schema, plus a real temp workspace on disk for the fs-backed reads.

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

  private static store(): SqlJsDatabase {
    const s = FakeBetterSqlite.stores.get(FakeBetterSqlite.lastPath);
    if (!s) throw new Error('no store for last path');
    return s;
  }
  static rawRun(sql: string, params: unknown[] = []): void { FakeBetterSqlite.store().run(sql, params); }
}

type ProposalRecord = {
  id: string; artifactId: string | null; workspaceId: string; path: string;
  slug: string | null; title: string | null;
  state: 'proposal' | 'promoted' | 'archived';
  authorAgentId: string | null; authorRole: 'supervisor' | 'worker' | 'unknown';
  authorDisplay: string | null; authoredAt: number | null;
  createdAt: number; updatedAt: number; mtimeMs: number | null; sizeBytes: number | null;
  promotedToPlanId: string | null; deletedAt: number | null;
};

type PlanGalleryOptions = { includeArchived?: boolean; includePromoted?: boolean };
type PlanGalleryRow = {
  id: string; type: 'proposal' | 'structured' | 'legacy'; typeLabel: string;
  title: string; state: string | null; dateGroup: string;
  folderRelPath: string | null; hasFolder: boolean;
  author: { role: string; display: string | null };
  owner: { display: string | null; agentId: string | null; source: string | null } | null;
};
type PlanGalleryResult = { rows: PlanGalleryRow[]; warnings: string[] };
type ProposalReadResult = { id: string; name: string; content: string; truncated: boolean; sizeBytes: number };

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  insertProposalRecord(rec: ProposalRecord): void;
};
type GalleryModule = {
  buildPlanGallery(workspaceId: string, opts?: PlanGalleryOptions, deps?: any): PlanGalleryResult;
  readProposalDocument(proposalId: string, deps?: any): ProposalReadResult | { error: string };
  toDateGroup(v: string | number | null | undefined): string;
  resetPlanGalleryCachesForTests(): void;
};

let dbm: DbModule;
let gallery: GalleryModule;
let wsRoot: string;   // real temp workspace root on disk (windows pathType)
let wsId: string;

const nowMs = 1_722_600_000_000; // fixed epoch-ms for deterministic date grouping

function proposal(over: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'prop-1', artifactId: null, workspaceId: wsId,
    path: '.lares/proposals/2026-08-03-a.md', slug: '2026-08-03-a', title: 'Proposal A',
    state: 'proposal', authorAgentId: null, authorRole: 'unknown', authorDisplay: null,
    authoredAt: null, createdAt: nowMs, updatedAt: nowMs, mtimeMs: nowMs, sizeBytes: 10,
    promotedToPlanId: null, deletedAt: null,
    ...over,
  };
}

/** Insert a plans row directly (P3B writes these columns; no accessor yet). */
function insertPlan(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'plan-x', workspace_id: wsId, path: 'plans/x.html', slug: 'x',
    format: 'html', run_state: null, mtime_ms: nowMs, size_bytes: 1,
    created_at: '2026-08-03 12:00:00', updated_at: '2026-08-03 12:00:00',
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

/** Write a real proposal .md file under the workspace proposals home. */
function writeProposalFile(name: string, content: string): void {
  fs.writeFileSync(path.join(wsRoot, '.lares', 'proposals', name), content);
}

/** Write a plan folder with a plan.json carrying responsibility history. */
function writePlanFolder(sku: string, responsibilityEvents: any[]): string {
  const folderRel = `.lares/plans/${sku}`;
  const folderAbs = path.join(wsRoot, '.lares', 'plans', sku);
  fs.mkdirSync(folderAbs, { recursive: true });
  fs.writeFileSync(
    path.join(folderAbs, 'plan.json'),
    JSON.stringify({ schema_version: 1, plan_artifact_id: `plan_${sku}`, plan_sku: sku, responsibility_events: responsibilityEvents }),
  );
  fs.writeFileSync(path.join(folderAbs, 'plan.md'), `# ${sku}\n`);
  return folderRel;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('empty tables are a valid state (no rows, no warnings)', () => {
  const res = gallery.buildPlanGallery('ws-does-not-exist-yet');
  assert.deepEqual(res.rows, []);
});

test('toDateGroup normalizes epoch-ms and datetime text, degrades to unknown', () => {
  assert.equal(gallery.toDateGroup('2026-08-03 12:00:00'), '2026-08-03');
  assert.equal(gallery.toDateGroup(Date.UTC(2026, 7, 3, 6)), '2026-08-03');
  assert.equal(gallery.toDateGroup('not-a-date'), 'unknown');
  assert.equal(gallery.toDateGroup(null), 'unknown');
});

test('the three row types render; md excluded; legacy labeled "Legacy Plan"', () => {
  dbm.insertProposalRecord(proposal({ id: 'p-render', path: '.lares/proposals/render.md', slug: 'render', title: 'Render' }));
  insertPlan({ id: 'pl-html', path: 'plans/legacy.html', slug: 'legacy', format: 'html' });
  insertPlan({ id: 'pl-md', path: '.lares/proposals/hidden.md', slug: 'hidden', format: 'md' });
  const folderRel = writePlanFolder('2026-08-03-struct-abcd1234', [
    { event: 'assigned', agent_id: 'sup-1', display: 'Supervisor One', at: nowMs, source: 'manual-skill' },
  ]);
  insertPlan({ id: 'pl-struct', path: '.lares/plans/2026-08-03-struct-abcd1234/plan.md', slug: 'struct', format: 'structured', folder_rel_path: folderRel });

  const res = gallery.buildPlanGallery(wsId);
  const byId = new Map(res.rows.map((r) => [r.id, r]));

  assert.ok(byId.has('p-render'), 'proposal row present');
  assert.equal(byId.get('p-render')!.type, 'proposal');
  assert.equal(byId.get('p-render')!.typeLabel, 'Proposal');

  assert.ok(byId.has('pl-html'), 'legacy html row present');
  assert.equal(byId.get('pl-html')!.type, 'legacy');
  assert.equal(byId.get('pl-html')!.typeLabel, 'Legacy Plan');

  assert.ok(byId.has('pl-struct'), 'structured row present');
  assert.equal(byId.get('pl-struct')!.type, 'structured');
  assert.equal(byId.get('pl-struct')!.typeLabel, 'Plan');

  assert.equal(byId.has('pl-md'), false, 'md row excluded');
});

test('hasFolder + folderRelPath set for structured rows only', () => {
  const res = gallery.buildPlanGallery(wsId);
  const struct = res.rows.find((r) => r.id === 'pl-struct')!;
  assert.equal(struct.hasFolder, true);
  assert.ok(struct.folderRelPath && struct.folderRelPath.includes('struct-abcd1234'));
  const html = res.rows.find((r) => r.id === 'pl-html')!;
  assert.equal(html.hasFolder, false);
  assert.equal(html.folderRelPath, null);
});

test('owner chip reflects plan.json responsibility; structured author stays unknown', () => {
  const res = gallery.buildPlanGallery(wsId);
  const struct = res.rows.find((r) => r.id === 'pl-struct')!;
  // OWNER comes from plan.json — NOT author.
  assert.deepEqual(struct.owner, { display: 'Supervisor One', agentId: 'sup-1', source: 'manual-skill' });
  // AUTHOR is unknown for a folder-adopted row (responsibility != authorship).
  assert.equal(struct.author.role, 'unknown');
  assert.equal(struct.author.display, null);
  // Legacy + proposal rows never carry an owner chip.
  assert.equal(res.rows.find((r) => r.id === 'pl-html')!.owner, null);
});

test('owner reflects the LAST assigned event (append-only reassignment)', () => {
  gallery.resetPlanGalleryCachesForTests();
  const folderRel = writePlanFolder('2026-08-03-reassign-eeee0000', [
    { event: 'assigned', agent_id: 'sup-a', display: 'First', at: 1, source: 'manual-skill' },
    { event: 'assigned', agent_id: 'sup-b', display: 'Second', at: 2, source: 'promotion-service' },
  ]);
  insertPlan({ id: 'pl-reassign', path: '.lares/plans/2026-08-03-reassign-eeee0000/plan.md', slug: 'reassign', format: 'structured', folder_rel_path: folderRel });
  const struct = gallery.buildPlanGallery(wsId).rows.find((r) => r.id === 'pl-reassign')!;
  assert.equal(struct.owner!.display, 'Second');
  assert.equal(struct.owner!.agentId, 'sup-b');
});

test('proposal witnessed author is carried through', () => {
  dbm.insertProposalRecord(proposal({
    id: 'p-authored', path: '.lares/proposals/authored.md', slug: 'authored', title: 'Authored',
    authorRole: 'supervisor', authorDisplay: 'Sup Author',
  }));
  const row = gallery.buildPlanGallery(wsId).rows.find((r) => r.id === 'p-authored')!;
  assert.equal(row.author.role, 'supervisor');
  assert.equal(row.author.display, 'Sup Author');
});

test('default filter hides archived + promoted proposals; opt-in reveals', () => {
  dbm.insertProposalRecord(proposal({ id: 'p-arch', path: '.lares/proposals/arch.md', slug: 'arch', state: 'archived' }));
  dbm.insertProposalRecord(proposal({ id: 'p-prom', path: '.lares/proposals/prom.md', slug: 'prom', state: 'promoted' }));
  const def = gallery.buildPlanGallery(wsId).rows.map((r) => r.id);
  assert.equal(def.includes('p-arch'), false);
  assert.equal(def.includes('p-prom'), false);
  const all = gallery.buildPlanGallery(wsId, { includeArchived: true, includePromoted: true }).rows.map((r) => r.id);
  assert.ok(all.includes('p-arch') && all.includes('p-prom'));
});

test('proposal:read returns content, byte-capped + flagged', () => {
  writeProposalFile('render.md', '# Render body\nhello world\n');
  const ok = gallery.readProposalDocument('p-render') as ProposalReadResult;
  assert.equal((ok as any).error, undefined);
  assert.ok(ok.content.includes('Render body'));
  assert.equal(ok.name, 'render.md');
  // Cap forces truncation + the flag.
  const capped = gallery.readProposalDocument('p-render', { caps: { maxReadBytes: 5 } }) as ProposalReadResult;
  assert.equal(capped.truncated, true);
  assert.equal(capped.content.length, 5);
});

test('proposal:read rejects an unknown id', () => {
  const res = gallery.readProposalDocument('nope') as { error: string };
  assert.ok(res.error);
});

test('proposal:read containment holds even if the stored path tries to escape', () => {
  // A proposal whose stored path attempts traversal resolves by BASENAME inside
  // the proposals boundary — the escape components are dropped, never followed.
  dbm.insertProposalRecord(proposal({
    id: 'p-escape', path: '.lares/proposals/../../../../etc/passwd', slug: 'escape', title: 'Escape',
  }));
  const res = gallery.readProposalDocument('p-escape');
  // basename('.../passwd') = 'passwd'; no such file in the boundary → unreadable,
  // NOT a traversal read of a real /etc/passwd.
  assert.ok('error' in res && res.error === 'proposal unreadable or no longer present');
});

// ── runner ─────────────────────────────────────────────────────────────────────

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gallery-appdata-'));
  process.env.APPDATA = tmpAppData;

  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-gallery-ws-'));
  fs.mkdirSync(path.join(wsRoot, '.lares', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, '.lares', 'plans'), { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  gallery = require('./plan-gallery') as GalleryModule;

  // A workspace whose root is the real temp dir + windows pathType so the
  // fs-backed reads (plan.json owner, proposal:read) resolve.
  wsId = dbm.createWorkspace({ title: 'ws', path: wsRoot, pathType: 'windows' }).id;

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
  try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
