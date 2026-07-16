// WP-P5-A — selection_comments schema + CRUD helpers
// (plans/selection-to-agent-primitive-plan.md §5).
//
// Covers:
//   - the table matches plan §5 exactly (column set — no generic target_id —
//     and both CHECK constraints enforced);
//   - createSelectionComment roundtrips every field, defaults status 'draft';
//   - get/list (workspace+file filter, oldest-first order) / delete;
//   - updateSelectionComment + resolveSelectionComment + the comments:send
//     mark* helpers all maintain updated_at explicitly (the SQLite column
//     default is insert-only);
//   - initDatabase is idempotent (CREATE IF NOT EXISTS re-run).
//
// better-sqlite3's native binding is built against Electron's ABI and won't
// load under the system Node that `npm run test:supervisor` uses, so this
// test injects a sql.js (wasm SQLite) stand-in with the same Database surface
// into require.cache BEFORE requiring ../database. Real SQL still executes —
// CREATE TABLE, CHECKs, datetime('now') defaults — just on wasm instead of
// the native addon.
//
//   npm run build:main
//   node dist/main/main/selection-comments-db.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SelectionComment } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in ────────────────────────────

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
// The instance initDatabase() creates, captured so tests can run raw SQL
// (e.g. backdating updated_at to prove the helpers maintain it).
let liveDb: FakeBetterSqlite | null = null;

class FakeBetterSqlite {
  // Keyed by path so a re-run of initDatabase() reopens the same store, like
  // the real file-backed better-sqlite3 (exercised by the idempotency test).
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

function raw(sql: string, params: unknown[] = []): void {
  liveDb!.prepare(sql).run(...params);
}
function rawAll(sql: string): Record<string, unknown>[] {
  return liveDb!.prepare(sql).all() as Record<string, unknown>[];
}

// ── database module under test (loaded after the cache injection) ────

type DbModule = {
  initDatabase(): void;
  createSelectionComment(input: Record<string, unknown>): SelectionComment;
  getSelectionComment(id: string): SelectionComment | null;
  listSelectionComments(workspaceId: string, filePath: string): SelectionComment[];
  updateSelectionComment(id: string, updates: Record<string, unknown>): SelectionComment | null;
  deleteSelectionComment(id: string): void;
  resolveSelectionComment(id: string): SelectionComment | null;
  markSelectionCommentsQueued(ids: string[], agentId: string | null): void;
  markSelectionCommentsSent(ids: string[], agentId: string): void;
  markSelectionCommentsSendFailed(ids: string[]): void;
};
let dbm: DbModule;

const BACKDATE = '2000-01-01 00:00:00';

function makeInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'ws-1',
    filePath: 'C:\\repo\\doc.md',
    pathType: 'windows',
    rootDirectory: 'C:\\repo',
    docHash: 'hash-abc',
    anchorStart: 100,
    anchorEnd: 140,
    lineStart: 41,
    lineEnd: 58,
    prefix: 'context before the quote, ~32 ch',
    suffix: 'context after the quote, ~32 cha',
    quotedText: 'the quoted text,\nwith a line break',
    body: 'fact check this section',
    ...over,
  };
}

function backdate(id: string): void {
  raw(`UPDATE selection_comments SET updated_at = '${BACKDATE}' WHERE id = ?`, [id]);
}

// ── schema ───────────────────────────────────────────────────────────

test('table columns match plan §5 exactly — no generic target_id', () => {
  const cols = rawAll('PRAGMA table_info(selection_comments)').map((r) => r.name);
  assert.deepEqual(cols, [
    'id', 'workspace_id', 'target_type',
    'file_path', 'path_type', 'root_directory', 'doc_hash',
    'anchor_start', 'anchor_end', 'line_start', 'line_end', 'prefix', 'suffix',
    'quoted_text', 'body', 'status', 'sent_to_agent_id',
    'created_at', 'updated_at', 'sent_at', 'resolved_at',
    // appended by the highlight-feature migration (ALTER TABLE ADD COLUMN)
    'kind',
    // appended by the PDF dual-viewer trunk migration (plan Part 1.4)
    'anchor_type', 'anchor_json',
  ]);
});

test('both plan §5 indexes exist', () => {
  const names = rawAll(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'selection_comments'"
  ).map((r) => r.name);
  assert.ok(names.includes('idx_selcomments_ws_file'), 'workspace+file+status index');
  assert.ok(names.includes('idx_selcomments_agent'), 'sent_to_agent_id index');
});

test('status CHECK constraint rejects values outside the plan list', () => {
  const c = dbm.createSelectionComment(makeInput());
  assert.throws(() => dbm.updateSelectionComment(c.id, { status: 'bogus' }));
  // Row unchanged after the rejected update.
  assert.equal(dbm.getSelectionComment(c.id)!.status, 'draft');
  dbm.deleteSelectionComment(c.id);
});

test('target_type CHECK constraint rejects unknown discriminators', () => {
  assert.throws(() => dbm.createSelectionComment(makeInput({ targetType: 'terminal' })));
});

test('initDatabase is idempotent (CREATE IF NOT EXISTS re-run keeps rows)', () => {
  const c = dbm.createSelectionComment(makeInput());
  dbm.initDatabase(); // second pass over the same fake-injected module state
  assert.ok(dbm.getSelectionComment(c.id), 'row survives a re-init');
  dbm.deleteSelectionComment(c.id);
});

// ── create / get / list / delete ─────────────────────────────────────

test('createSelectionComment roundtrips every field and defaults status draft', () => {
  const c = dbm.createSelectionComment(makeInput());
  assert.ok(c.id.length > 0);
  assert.equal(c.workspaceId, 'ws-1');
  assert.equal(c.targetType, 'file');
  assert.equal(c.filePath, 'C:\\repo\\doc.md');
  assert.equal(c.pathType, 'windows');
  assert.equal(c.rootDirectory, 'C:\\repo');
  assert.equal(c.docHash, 'hash-abc');
  assert.equal(c.anchorStart, 100);
  assert.equal(c.anchorEnd, 140);
  assert.equal(c.lineStart, 41);
  assert.equal(c.lineEnd, 58);
  assert.equal(c.prefix, 'context before the quote, ~32 ch');
  assert.equal(c.suffix, 'context after the quote, ~32 cha');
  assert.equal(c.quotedText, 'the quoted text,\nwith a line break');
  assert.equal(c.body, 'fact check this section');
  assert.equal(c.status, 'draft');
  assert.equal(c.sentToAgentId, null);
  assert.ok(c.createdAt.startsWith('20'), 'created_at stamped');
  assert.equal(c.updatedAt, c.createdAt);
  assert.equal(c.sentAt, null);
  assert.equal(c.resolvedAt, null);
  dbm.deleteSelectionComment(c.id);
});

test('optional fields default to null', () => {
  const c = dbm.createSelectionComment({
    workspaceId: 'ws-1',
    filePath: 'C:\\repo\\doc.md',
    quotedText: 'q',
    body: '',
  });
  assert.equal(c.pathType, null);
  assert.equal(c.rootDirectory, null);
  assert.equal(c.docHash, null);
  assert.equal(c.anchorStart, null);
  assert.equal(c.anchorEnd, null);
  assert.equal(c.lineStart, null);
  assert.equal(c.lineEnd, null);
  assert.equal(c.prefix, null);
  assert.equal(c.suffix, null);
  assert.equal(c.body, '');
  dbm.deleteSelectionComment(c.id);
});

test('getSelectionComment returns null for unknown ids', () => {
  assert.equal(dbm.getSelectionComment('nope'), null);
});

test('listSelectionComments filters by workspace+file and orders oldest-first', () => {
  const a = dbm.createSelectionComment(makeInput({ body: 'first' }));
  const b = dbm.createSelectionComment(makeInput({ body: 'second' }));
  const otherFile = dbm.createSelectionComment(makeInput({ filePath: 'C:\\repo\\other.md' }));
  const otherWs = dbm.createSelectionComment(makeInput({ workspaceId: 'ws-2' }));
  // Force distinct created_at so the ORDER BY is actually exercised.
  raw(`UPDATE selection_comments SET created_at = '2026-06-12 00:00:01' WHERE id = ?`, [a.id]);
  raw(`UPDATE selection_comments SET created_at = '2026-06-12 00:00:00' WHERE id = ?`, [b.id]);

  const listed = dbm.listSelectionComments('ws-1', 'C:\\repo\\doc.md');
  assert.deepEqual(listed.map((c) => c.body), ['second', 'first'], 'oldest first');

  for (const id of [a.id, b.id, otherFile.id, otherWs.id]) dbm.deleteSelectionComment(id);
});

test('deleteSelectionComment removes the row', () => {
  const c = dbm.createSelectionComment(makeInput());
  dbm.deleteSelectionComment(c.id);
  assert.equal(dbm.getSelectionComment(c.id), null);
});

// ── update / resolve maintain updated_at explicitly ──────────────────

test('updateSelectionComment writes fields and bumps updated_at', () => {
  const c = dbm.createSelectionComment(makeInput());
  backdate(c.id);

  const updated = dbm.updateSelectionComment(c.id, {
    body: 'rewritten',
    status: 'orphaned',
    anchorStart: null,
    anchorEnd: null,
    docHash: 'hash-new',
  })!;
  assert.equal(updated.body, 'rewritten');
  assert.equal(updated.status, 'orphaned');
  assert.equal(updated.anchorStart, null);
  assert.equal(updated.anchorEnd, null);
  assert.equal(updated.docHash, 'hash-new');
  assert.equal(updated.quotedText, c.quotedText, 'untouched fields stay');
  assert.notEqual(updated.updatedAt, BACKDATE, 'updated_at maintained explicitly');
  dbm.deleteSelectionComment(c.id);
});

test('updateSelectionComment with no fields is a no-op (updated_at untouched)', () => {
  const c = dbm.createSelectionComment(makeInput());
  backdate(c.id);
  const updated = dbm.updateSelectionComment(c.id, {})!;
  assert.equal(updated.updatedAt, BACKDATE, 'no phantom bump on an empty update');
  dbm.deleteSelectionComment(c.id);
});

test('resolveSelectionComment sets status, resolved_at and updated_at', () => {
  const c = dbm.createSelectionComment(makeInput());
  backdate(c.id);
  const resolved = dbm.resolveSelectionComment(c.id)!;
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolvedAt, 'resolved_at stamped');
  assert.notEqual(resolved.updatedAt, BACKDATE, 'updated_at maintained');
  dbm.deleteSelectionComment(c.id);
});

// ── comments:send mark* helpers ──────────────────────────────────────

test('markSelectionCommentsQueued sets status + agent id (or null) on every row', () => {
  const a = dbm.createSelectionComment(makeInput());
  const b = dbm.createSelectionComment(makeInput());
  backdate(a.id);

  dbm.markSelectionCommentsQueued([a.id, b.id], 'agent-9');
  const qa = dbm.getSelectionComment(a.id)!;
  const qb = dbm.getSelectionComment(b.id)!;
  assert.equal(qa.status, 'queued');
  assert.equal(qb.status, 'queued');
  assert.equal(qa.sentToAgentId, 'agent-9');
  assert.notEqual(qa.updatedAt, BACKDATE, 'updated_at maintained');

  dbm.markSelectionCommentsQueued([a.id], null);
  assert.equal(dbm.getSelectionComment(a.id)!.sentToAgentId, null, 'new-agent sends queue with null agent id');

  dbm.deleteSelectionComment(a.id);
  dbm.deleteSelectionComment(b.id);
});

test('markSelectionCommentsSent sets status, agent id, sent_at and updated_at', () => {
  const c = dbm.createSelectionComment(makeInput());
  dbm.markSelectionCommentsQueued([c.id], null);
  backdate(c.id);

  dbm.markSelectionCommentsSent([c.id], 'agent-new');
  const sent = dbm.getSelectionComment(c.id)!;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentToAgentId, 'agent-new', 'late-bound agent id (new-agent launch)');
  assert.ok(sent.sentAt, 'sent_at stamped');
  assert.notEqual(sent.updatedAt, BACKDATE, 'updated_at maintained');
  dbm.deleteSelectionComment(c.id);
});

test('markSelectionCommentsSendFailed sets status and updated_at, keeps sent_at null', () => {
  const c = dbm.createSelectionComment(makeInput());
  dbm.markSelectionCommentsQueued([c.id], 'agent-9');
  backdate(c.id);

  dbm.markSelectionCommentsSendFailed([c.id]);
  const failedRow = dbm.getSelectionComment(c.id)!;
  assert.equal(failedRow.status, 'send_failed');
  assert.equal(failedRow.sentAt, null);
  assert.equal(failedRow.sentToAgentId, 'agent-9', 'agent id preserved for retry context');
  assert.notEqual(failedRow.updatedAt, BACKDATE, 'updated_at maintained');
  dbm.deleteSelectionComment(c.id);
});

// ── PDF anchor columns (plan Part 1.4) ───────────────────────────────

const PDF_ANCHOR = {
  version: 1,
  fingerprint: 'fp-xyz',
  prefix: 'context before',
  suffix: 'context after',
  pages: [
    {
      pageIndex: 2,
      pageLabel: '3',
      start: { itemIndex: 0, charOffset: 0 },
      end: { itemIndex: 1, charOffset: 3 },
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
    },
  ],
};

test('old-DB migration: ADD COLUMN … DEFAULT backfills legacy rows', () => {
  // A store predating the trunk migration: no anchor_type/anchor_json columns.
  const legacy = new sqlJsCtor();
  legacy.exec(`CREATE TABLE selection_comments (
    id TEXT PRIMARY KEY, workspace_id TEXT, target_type TEXT,
    file_path TEXT, quoted_text TEXT, body TEXT, status TEXT )`);
  legacy.run(
    `INSERT INTO selection_comments (id, workspace_id, target_type, file_path, quoted_text, body, status)
     VALUES ('old1','ws','file','f.md','q','b','draft')`
  );
  // The house additive-migration idiom, verbatim.
  legacy.exec(`ALTER TABLE selection_comments ADD COLUMN anchor_type TEXT NOT NULL DEFAULT 'text'`);
  legacy.exec(`ALTER TABLE selection_comments ADD COLUMN anchor_json TEXT`);

  const stmt = legacy.prepare(`SELECT anchor_type, anchor_json FROM selection_comments WHERE id = 'old1'`);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  assert.equal(row.anchor_type, 'text', 'legacy row backfilled to text');
  assert.equal(row.anchor_json, null, 'legacy anchor_json NULL');
});

test('text comments default anchorType text with a null pdfAnchor', () => {
  const c = dbm.createSelectionComment(makeInput());
  assert.equal(c.anchorType, 'text');
  assert.equal(c.pdfAnchor, null);
  dbm.deleteSelectionComment(c.id);
});

test('PDF anchor round-trips and pins doc_hash to the fingerprint', () => {
  const c = dbm.createSelectionComment(makeInput({ anchorType: 'pdf', pdfAnchor: PDF_ANCHOR, docHash: undefined }));
  assert.equal(c.anchorType, 'pdf');
  assert.deepEqual(c.pdfAnchor, PDF_ANCHOR);
  assert.equal(c.docHash, 'fp-xyz', 'fingerprint stored as doc_hash');
  // quoted_text/body still populated for UI/search/prompt compatibility.
  assert.equal(c.quotedText, 'the quoted text,\nwith a line break');
  dbm.deleteSelectionComment(c.id);
});

test('createSelectionComment rejects an invalid PDF anchor before write', () => {
  assert.throws(
    () => dbm.createSelectionComment(makeInput({
      anchorType: 'pdf',
      pdfAnchor: { version: 1, fingerprint: '', pages: [], prefix: '', suffix: '' },
    })),
    /Invalid PDF anchor/,
  );
  // anchorType 'pdf' with no anchor is also rejected.
  assert.throws(() => dbm.createSelectionComment(makeInput({ anchorType: 'pdf' })));
});

test('malformed stored anchor_json reads back as pdfAnchor null (no throw)', () => {
  const c = dbm.createSelectionComment(makeInput());
  raw(`UPDATE selection_comments SET anchor_type = 'pdf', anchor_json = '{not valid json' WHERE id = ?`, [c.id]);
  const back = dbm.getSelectionComment(c.id)!;
  assert.equal(back.anchorType, 'pdf');
  assert.equal(back.pdfAnchor, null, 'corrupt JSON degrades to no anchor');
  dbm.deleteSelectionComment(c.id);
});

test('updateSelectionComment attaches then clears a PDF anchor', () => {
  const c = dbm.createSelectionComment(makeInput());
  const withPdf = dbm.updateSelectionComment(c.id, { anchorType: 'pdf', pdfAnchor: PDF_ANCHOR })!;
  assert.equal(withPdf.anchorType, 'pdf');
  assert.deepEqual(withPdf.pdfAnchor, PDF_ANCHOR);
  assert.equal(withPdf.docHash, 'fp-xyz', 'doc_hash follows the fingerprint');

  const cleared = dbm.updateSelectionComment(c.id, { anchorType: 'text', pdfAnchor: null })!;
  assert.equal(cleared.anchorType, 'text');
  assert.equal(cleared.pdfAnchor, null);
  dbm.deleteSelectionComment(c.id);
});

test('updateSelectionComment rejects an invalid PDF anchor', () => {
  const c = dbm.createSelectionComment(makeInput());
  assert.throws(() => dbm.updateSelectionComment(c.id, {
    anchorType: 'pdf',
    pdfAnchor: { version: 1, fingerprint: 'fp', pages: [], prefix: '', suffix: '' },
  }));
  // Row untouched — still a text comment.
  assert.equal(dbm.getSelectionComment(c.id)!.anchorType, 'text');
  dbm.deleteSelectionComment(c.id);
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  // Keep initDatabase's mkdir off the real APPDATA profile.
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-p5-db-'));
  process.env.APPDATA = tmpAppData;

  // sql.js init is async; the fake constructor is sync, so resolve the wasm
  // module first, then inject the stand-in and load ../database.
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
