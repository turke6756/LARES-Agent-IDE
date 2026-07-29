// publisher.test.ts — WP-F1 publish_lesson state machine + launch recovery.
//
// Covers every WP-F1 acceptance criterion that lives at the publisher layer:
//   - slug validated PRE-path (an invalid slug writes nothing);
//   - collision with `remember` / a shipped skill / a DIFFERING existing lesson
//     is rejected;
//   - the happy path lands EVERY provisioned copy and flips the row to active;
//   - a pending-insert failure leaves the filesystem untouched;
//   - a differing on-disk target is a conflict (never overwritten);
//   - launch recovery from a crash BEFORE first rename (staged tmps only),
//     BETWEEN renames (some copies present), and BEFORE activation (all present)
//     each forward-completes to `active`; a pending row with a differing target is
//     marked `conflict` and never overwritten; recovery is a no-op when idle.
//
// The store touches the shared better-sqlite3 handle, so this injects a sql.js
// stand-in into require.cache BEFORE requiring ../database (same precedent as
// review-store.test.ts). Filesystem is real (windows pathType) against a temp dir.
//   npm run build:main
//   node dist/main/main/memory-index/publisher.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors review-store.test.ts) ──
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

// ── modules under test (loaded after cache injection) ────────────────────
type PublisherModule = typeof import('./publisher');
type StoreModule = typeof import('./review-store');
type ProvModule = typeof import('./skill-provisioning');
let pub: PublisherModule;
let store: StoreModule;
let prov: ProvModule;

const PT = 'windows';
const NOW = '2026-07-28T00:00:00Z';
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function mkWorkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-')); }
function full(wd: string, rel: string): string { return path.join(wd, rel); }
function writeAt(wd: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(full(wd, rel)), { recursive: true });
  fs.writeFileSync(full(wd, rel), content, 'utf8');
}

// ── publish happy path ───────────────────────────────────────────────────
test('publishLesson lands EVERY provisioned copy and flips the row to active', () => {
  const ws = 'ws-happy', wd = mkWorkDir();
  const res = pub.publishLesson(ws, wd, PT, { name: 'my-lesson', description: 'when X do Y', body: 'do the thing' }, NOW);
  assert.equal(res.ok, true);
  const expected = prov.buildLessonSkillContent('my-lesson', 'when X do Y', 'do the thing');
  const targets = prov.lessonTargetRelPaths('my-lesson');
  assert.equal(targets.length, 4, 'four provisioned roots');
  for (const rel of targets) {
    assert.equal(fs.readFileSync(full(wd, rel), 'utf8'), expected, `${rel} landed with canonical content`);
    assert.ok(!fs.existsSync(full(wd, `${rel}.tmp`)), `${rel}.tmp cleaned`);
  }
  const rows = store.listLessons(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  assert.deepEqual(rows[0].copies, targets, 'copies_json records the intended targets');
});

// ── slug validation pre-path ───────────────────────────────────────────────
test('an invalid slug is rejected with NO filesystem write and NO row', () => {
  const ws = 'ws-badslug', wd = mkWorkDir();
  const res = pub.publishLesson(ws, wd, PT, { name: 'Bad Name!', description: 'd', body: 'b' }, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'invalid_name');
  assert.ok(!fs.existsSync(full(wd, '.lares')), 'no .lares tree created for a rejected slug');
  assert.equal(store.listLessons(ws).length, 0, 'no pending row for a rejected slug');
});

// ── reserved-name collision ────────────────────────────────────────────────
test('a slug colliding with `remember` or a shipped skill is rejected', () => {
  const ws = 'ws-reserved', wd = mkWorkDir();
  assert.equal((pub.publishLesson(ws, wd, PT, { name: 'remember', description: 'd', body: 'b' }, NOW) as { code: string }).code, 'reserved_name');
  assert.equal((pub.publishLesson(ws, wd, PT, { name: 'read-comments', description: 'd', body: 'b' }, NOW) as { code: string }).code, 'reserved_name');
  assert.equal(store.listLessons(ws).length, 0);
});

// ── differing-lesson collision ─────────────────────────────────────────────
test('a differing existing lesson of the same name is rejected; the original is untouched', () => {
  const ws = 'ws-collide', wd = mkWorkDir();
  const first = pub.publishLesson(ws, wd, PT, { name: 'dup', description: 'd', body: 'ORIGINAL' }, NOW);
  assert.equal(first.ok, true);
  const rel0 = prov.lessonTargetRelPaths('dup')[0];
  const originalContent = fs.readFileSync(full(wd, rel0), 'utf8');
  const second = pub.publishLesson(ws, wd, PT, { name: 'dup', description: 'd', body: 'DIFFERENT' }, NOW);
  assert.equal(second.ok, false);
  assert.equal((second as { code: string }).code, 'collision');
  assert.equal(fs.readFileSync(full(wd, rel0), 'utf8'), originalContent, 'the original copy was not overwritten');
  // Idempotent re-publish of the SAME content is allowed.
  const same = pub.publishLesson(ws, wd, PT, { name: 'dup', description: 'd', body: 'ORIGINAL' }, NOW);
  assert.equal(same.ok, true, 'an identical re-publish is idempotent, not a collision');
});

// ── pending-insert failure leaves fs untouched ─────────────────────────────
test('a pending-insert failure leaves the filesystem untouched', () => {
  const ws = 'ws-insertfail', wd = mkWorkDir();
  const res = pub.publishLesson(ws, wd, PT, { name: 'no-write', description: 'd', body: 'b' }, NOW, { failPendingInsert: true });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'pending_insert_failed');
  for (const rel of prov.lessonTargetRelPaths('no-write')) {
    assert.ok(!fs.existsSync(full(wd, rel)), `${rel} not written`);
    assert.ok(!fs.existsSync(full(wd, `${rel}.tmp`)), `${rel}.tmp not written`);
  }
  assert.equal(store.listLessons(ws).length, 0, 'the failed insert persisted no row');
});

// ── differing on-disk target → conflict (publish path) ─────────────────────
test('a differing on-disk target makes publish a conflict; the target is never overwritten', () => {
  const ws = 'ws-conflict', wd = mkWorkDir();
  const targets = prov.lessonTargetRelPaths('clash');
  writeAt(wd, targets[1], 'FOREIGN EDIT'); // a differing copy already on disk
  const res = pub.publishLesson(ws, wd, PT, { name: 'clash', description: 'd', body: 'MINE' }, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'conflict');
  assert.equal(fs.readFileSync(full(wd, targets[1]), 'utf8'), 'FOREIGN EDIT', 'the differing target was not overwritten');
  assert.ok(!fs.existsSync(full(wd, targets[0])), 'no copy committed on a conflict');
  assert.equal(store.listLessons(ws, 'conflict').length, 1, 'the row is durably marked conflict');
});

// ── recovery helpers ───────────────────────────────────────────────────────
function seedPending(ws: string, name: string, body: string): { targets: string[]; content: string } {
  const content = prov.buildLessonSkillContent(name, 'd', body);
  const targets = prov.lessonTargetRelPaths(name);
  store.registerLesson(ws, { lessonId: name, name, canonicalHash: sha(content), copies: targets, preexisted: [], status: 'pending' }, NOW);
  return { targets, content };
}

test('recovery — crash BEFORE first rename (staged tmps only) forward-completes to active', () => {
  const ws = 'ws-rec-tmp', wd = mkWorkDir();
  const { targets, content } = seedPending(ws, 'rec-a', 'B');
  for (const rel of targets) writeAt(wd, `${rel}.tmp`, content); // all staged, none renamed
  const out = pub.recoverPendingLessons(ws, wd, PT, NOW);
  assert.deepEqual(out.recovered, ['rec-a']);
  for (const rel of targets) {
    assert.equal(fs.readFileSync(full(wd, rel), 'utf8'), content, `${rel} forward-completed`);
    assert.ok(!fs.existsSync(full(wd, `${rel}.tmp`)), `${rel}.tmp cleaned`);
  }
  assert.equal(store.listLessons(ws, 'active').length, 1);
});

test('recovery — crash BETWEEN renames (some copies present) writes the missing ones and activates', () => {
  const ws = 'ws-rec-mid', wd = mkWorkDir();
  const { targets, content } = seedPending(ws, 'rec-b', 'B');
  writeAt(wd, targets[0], content);   // committed
  writeAt(wd, targets[1], content);   // committed
  // targets[2], targets[3] missing (crash mid-loop, tmps already cleaned by a partial finally)
  const out = pub.recoverPendingLessons(ws, wd, PT, NOW);
  assert.deepEqual(out.recovered, ['rec-b']);
  for (const rel of targets) assert.equal(fs.readFileSync(full(wd, rel), 'utf8'), content, `${rel} present`);
  assert.equal(store.listLessons(ws, 'active').length, 1);
});

test('recovery — crash BEFORE activation (all copies present) flips the pending row to active', () => {
  const ws = 'ws-rec-all', wd = mkWorkDir();
  const { targets, content } = seedPending(ws, 'rec-c', 'B');
  for (const rel of targets) writeAt(wd, rel, content);
  const out = pub.recoverPendingLessons(ws, wd, PT, NOW);
  assert.deepEqual(out.recovered, ['rec-c']);
  assert.equal(store.listLessons(ws, 'active').length, 1);
});

test('recovery — a pending row with a DIFFERING target is marked conflict and never overwritten', () => {
  const ws = 'ws-rec-conflict', wd = mkWorkDir();
  const { targets, content } = seedPending(ws, 'rec-d', 'B');
  // A hash-clean source EXISTS (targets[0]) alongside a DIFFERING target
  // (targets[1]). This isolates the conflict guard: without it, recovery would
  // find the clean source, forward-complete, and wrongly mark the row active —
  // so asserting `conflict` proves the differing target is detected, not merely
  // that no content source was found.
  writeAt(wd, targets[0], content);        // hash-clean source present
  writeAt(wd, targets[1], 'FOREIGN EDIT'); // differs from canonical
  const out = pub.recoverPendingLessons(ws, wd, PT, NOW);
  assert.deepEqual(out.conflicts, ['rec-d']);
  assert.equal(store.listLessons(ws, 'conflict').length, 1, 'the row is marked conflict, not active');
  assert.equal(store.listLessons(ws, 'active').length, 0);
  assert.equal(fs.readFileSync(full(wd, targets[1]), 'utf8'), 'FOREIGN EDIT', 'differing target untouched');
  assert.ok(!fs.existsSync(full(wd, targets[2])), 'no partial forward-write during a conflict');
});

test('recovery is a no-op when nothing is pending', () => {
  const ws = 'ws-rec-idle', wd = mkWorkDir();
  store.registerLesson(ws, { lessonId: 'live', name: 'live', canonicalHash: 'h', copies: [], preexisted: [], status: 'active' }, NOW);
  const out = pub.recoverPendingLessons(ws, wd, PT, NOW);
  assert.deepEqual(out, { recovered: [], conflicts: [] });
  assert.equal(store.listLessons(ws, 'active').length, 1);
});

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-appdata-'));
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
  pub = require('./publisher') as PublisherModule;
  prov = require('./skill-provisioning') as ProvModule;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
