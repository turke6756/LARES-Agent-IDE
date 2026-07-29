// bundle-migration.test.ts — WP-F2 replace_memory_bundle / restore_memory_bundle.
//
// Covers every WP-F2 bundle acceptance criterion:
//   - a HARD-invalid proposed index+detail set is rejected before any live
//     mutation (independent validation via WP-A2's readValidateProject);
//   - a bundle op without a recorded migration approval is refused;
//   - a successful replace removes obsolete live details (hash-guarded) so NO
//     orphan-details remain, requires a matching expected_prior_hash CAS, and
//     leaves details/ == exactly the signed set;
//   - a wrong expected_prior_hash → cas_mismatch (live untouched);
//   - a live detail that is NOT a known archived body → conflict (never
//     clobbered; the archived bundle is restored);
//   - restore_memory_bundle restores the index + full prior detail inventory and
//     requires approval + expected_live_hash.
//
// sql.js better-sqlite3 stand-in (for getMigrationApproval) + a real temp
// filesystem (windows pathType).
//   npm run build:main
//   node dist/main/main/memory-index/bundle-migration.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; };
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
    return (...args: A) => { this.db.exec('BEGIN'); try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (err) { this.db.exec('ROLLBACK'); throw err; } };
  }
}

type BundleModule = typeof import('./bundle-migration');
type StoreModule = typeof import('./review-store');
type CoreModule = typeof import('../../shared/memory-index-core');
let bundle: BundleModule;
let store: StoreModule;
let MARKER: string;

const PT = 'windows';
const NOW = '2026-07-28T00:00:00Z';
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const INDEX_REL = '.lares/supervisor/memory/MEMORY.md';
const DETAILS_REL = '.lares/supervisor/memory/details/';

function mkWorkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-')); }
function full(wd: string, rel: string): string { return path.join(wd, ...rel.split('/')); }
function writeAt(wd: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(full(wd, rel)), { recursive: true });
  fs.writeFileSync(full(wd, rel), content, 'utf8');
}
function readAt(wd: string, rel: string): string { return fs.readFileSync(full(wd, rel), 'utf8'); }
function detailNames(wd: string): string[] {
  try { return fs.readdirSync(full(wd, DETAILS_REL)).sort(); } catch { return []; }
}

/** A well-formed active capsule (mirrors io-validate.test.ts). */
function ACTIVE(id: string, over: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    status: 'active', date: '2026-07-28', owner: 'super',
    consequence: 'things break silently', state: 'constraint X holds',
    'open-loop': 'finish Y', 'read-if': 'before editing the schema',
    detail: `memory/details/${id}.md`, ...over,
  };
  const lines = [`## ${id}: Title`];
  for (const [k, v] of Object.entries(f)) if (v !== '') lines.push(`- ${k}: ${v}`);
  return lines.join('\n');
}
function idx(...blocks: string[]): string { return `${MARKER}\n\n${blocks.join('\n\n')}\n`; }

const KEEP = 'mb-2026-07-28-keep';
const OBSOLETE = 'mb-2026-07-28-obsolete';

interface Archive { indexText: string; details: Record<string, string>; }

/** Seed a live pre-migration workspace: an index with keep+obsolete, both detail
 *  files present, plus the matching archive. Returns the archive + live index. */
function seedLive(wd: string): { archive: Archive; liveIndex: string } {
  const liveIndex = idx(ACTIVE(KEEP), ACTIVE(OBSOLETE));
  const keepBody = `# ${KEEP}\nold keep body\n`;
  const obsoleteBody = `# ${OBSOLETE}\nclosed obsolete body\n`;
  writeAt(wd, INDEX_REL, liveIndex);
  writeAt(wd, `${DETAILS_REL}${KEEP}.md`, keepBody);
  writeAt(wd, `${DETAILS_REL}${OBSOLETE}.md`, obsoleteBody);
  const archive = { indexText: liveIndex, details: { [`${KEEP}.md`]: keepBody, [`${OBSOLETE}.md`]: obsoleteBody } };
  return { archive, liveIndex };
}

/** The signed proposal: keep only, with fresh content. */
function proposal(): { indexSource: string; detailFiles: Array<{ relPath: string; content: string }> } {
  return {
    indexSource: idx(ACTIVE(KEEP)),
    detailFiles: [{ relPath: `${DETAILS_REL}${KEEP}.md`, content: `# ${KEEP}\nnew keep body\n` }],
  };
}

function approve(ws: string, snap: string): void {
  store.recordMigrationApproval(ws, snap, 'table-hash', 'edward', NOW);
}

// ── no approval ──────────────────────────────────────────────────────────────
test('replace_memory_bundle without a recorded approval is refused', () => {
  const ws = 'ws-noappr', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  const p = proposal();
  const res = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: p.indexSource, detailFiles: p.detailFiles, expectedPriorHash: sha(liveIndex) }, archive, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'no_approval');
  assert.equal(readAt(wd, INDEX_REL), liveIndex, 'live index untouched');
  assert.deepEqual(detailNames(wd), [`${KEEP}.md`, `${OBSOLETE}.md`], 'live details untouched');
});

// ── hard-invalid proposal ─────────────────────────────────────────────────────
test('replace_memory_bundle rejects a HARD-invalid proposed bundle before any live mutation', () => {
  const ws = 'ws-hard', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  approve(ws, 's1');
  // Proposed index references a detail file NOT in the proposed set → detail-missing HARD.
  const badIndex = idx(ACTIVE(KEEP));
  const res = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: badIndex, detailFiles: [], expectedPriorHash: sha(liveIndex) }, archive, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'hard_invalid');
  assert.ok(((res as { findings?: unknown[] }).findings?.length ?? 0) > 0, 'the hard findings are surfaced');
  assert.equal(readAt(wd, INDEX_REL), liveIndex, 'live index untouched by a rejected proposal');
});

// ── escaping detail path ──────────────────────────────────────────────────────
test('replace_memory_bundle rejects an escaping detail path', () => {
  const ws = 'ws-escape', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  approve(ws, 's1');
  const p = proposal();
  p.detailFiles.push({ relPath: '.lares/supervisor/memory/evil.md', content: 'x' });
  const res = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: p.indexSource, detailFiles: p.detailFiles, expectedPriorHash: sha(liveIndex) }, archive, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'invalid_detail_path');
  assert.equal(readAt(wd, INDEX_REL), liveIndex, 'live index untouched');
});

// ── happy replace: obsolete removed, no orphan, CAS enforced ──────────────────
test('replace_memory_bundle removes obsolete details (hash-guarded) and leaves details/ == the signed set', () => {
  const ws = 'ws-happy', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  approve(ws, 's1');
  const p = proposal();
  const res = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: p.indexSource, detailFiles: p.detailFiles, expectedPriorHash: sha(liveIndex) }, archive, NOW);
  assert.equal(res.ok, true, `expected ok; got ${JSON.stringify(res)}`);
  assert.equal(readAt(wd, INDEX_REL), p.indexSource, 'index renamed to the proposed source');
  assert.deepEqual(detailNames(wd), [`${KEEP}.md`], 'obsolete detail removed; only the signed set remains (no orphan)');
  assert.equal(readAt(wd, `${DETAILS_REL}${KEEP}.md`), p.detailFiles[0].content, 'carried-forward detail updated to signed content');
  assert.deepEqual((res as { removed: string[] }).removed, [`${OBSOLETE}.md`], 'the removed obsolete detail is reported');
});

// ── CAS mismatch ──────────────────────────────────────────────────────────────
test('replace_memory_bundle with a wrong expected_prior_hash → cas_mismatch (live untouched)', () => {
  const ws = 'ws-cas', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  approve(ws, 's1');
  const p = proposal();
  const res = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: p.indexSource, detailFiles: p.detailFiles, expectedPriorHash: sha('SOMETHING ELSE') }, archive, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'cas_mismatch');
  assert.equal(readAt(wd, INDEX_REL), liveIndex, 'live index untouched');
  assert.deepEqual(detailNames(wd), [`${KEEP}.md`, `${OBSOLETE}.md`], 'live details untouched');
});

// ── conflict: unknown live detail is never clobbered ──────────────────────────
test('replace_memory_bundle → conflict when a live obsolete detail is not a known archived body; the bundle is restored', () => {
  const ws = 'ws-conflict', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  approve(ws, 's1');
  // A concurrently-written detail, absent from the proposal AND absent from the
  // archive → not a known archived body → conflict.
  writeAt(wd, `${DETAILS_REL}mb-2026-07-28-foreign.md`, 'concurrently written, unknown\n');
  const p = proposal();
  const res = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: p.indexSource, detailFiles: p.detailFiles, expectedPriorHash: sha(liveIndex) }, archive, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'conflict');
  // Restored to the archived pre-migration bundle (index + keep + obsolete);
  // the foreign file (not in the archive) is swept as part of the restore.
  assert.equal(readAt(wd, INDEX_REL), archive.indexText, 'index restored from the archive');
  assert.deepEqual(detailNames(wd), [`${KEEP}.md`, `${OBSOLETE}.md`], 'archived inventory restored; foreign detail removed');
  assert.equal(readAt(wd, `${DETAILS_REL}${OBSOLETE}.md`), archive.details[`${OBSOLETE}.md`], 'obsolete restored from archive');
});

// ── restore_memory_bundle ─────────────────────────────────────────────────────
test('restore_memory_bundle restores the index + full prior detail inventory (approval + CAS required)', () => {
  const ws = 'ws-restore', wd = mkWorkDir();
  const { archive, liveIndex } = seedLive(wd);
  approve(ws, 's1');
  const p = proposal();
  // First migrate forward.
  const rep = bundle.replaceMemoryBundle(ws, wd, PT, { snapshotId: 's1', indexSource: p.indexSource, detailFiles: p.detailFiles, expectedPriorHash: sha(liveIndex) }, archive, NOW);
  assert.equal(rep.ok, true);
  const postIndex = readAt(wd, INDEX_REL);

  // A wrong expected_live_hash is refused.
  const bad = bundle.restoreMemoryBundle(ws, wd, PT, { snapshotId: 's1', expectedLiveHash: sha('nope') }, archive);
  assert.equal(bad.ok, false);
  assert.equal((bad as { code: string }).code, 'cas_mismatch');

  // The correct CAS restores the archived pre-migration bundle exactly.
  const res = bundle.restoreMemoryBundle(ws, wd, PT, { snapshotId: 's1', expectedLiveHash: sha(postIndex) }, archive);
  assert.equal(res.ok, true, `expected ok; got ${JSON.stringify(res)}`);
  assert.equal(readAt(wd, INDEX_REL), archive.indexText, 'index restored');
  assert.deepEqual(detailNames(wd), [`${KEEP}.md`, `${OBSOLETE}.md`], 'full prior detail inventory restored');
  assert.equal(readAt(wd, `${DETAILS_REL}${KEEP}.md`), archive.details[`${KEEP}.md`], 'keep restored to its archived body');
});

test('restore_memory_bundle without an approval is refused', () => {
  const ws = 'ws-restore-noappr', wd = mkWorkDir();
  const { archive } = seedLive(wd);
  const res = bundle.restoreMemoryBundle(ws, wd, PT, { snapshotId: 's1', expectedLiveHash: sha('anything') }, archive);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'no_approval');
});

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-appdata-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbm = require('../database') as { initDatabase(): void };
  dbm.initDatabase();
  store = require('./review-store') as StoreModule;
  bundle = require('./bundle-migration') as BundleModule;
  MARKER = (require('../../shared/memory-index-core') as CoreModule).DISCLOSURE_FORMAT_MARKER;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
