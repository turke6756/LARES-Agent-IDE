// batch-publisher.test.ts — WP-F2 publish_lessons_batch state machine + launch
// recovery. Covers every WP-F2 batch acceptance criterion:
//   - all lesson rows + the batch row are inserted `pending` BEFORE any fs write
//     (a pending-insert failure leaves the filesystem untouched and drops rows);
//   - the happy path lands every copy of every lesson and activates the batch +
//     rows in one shot; receipts enumerate every created path + preexisted flag;
//   - a differing on-disk target makes the WHOLE batch a conflict, unwinding
//     copies already committed for earlier lessons (conflict protection is
//     independent of preexisted);
//   - launch recovery of a crashed `pending` batch: forward-completes the WHOLE
//     batch when every target is hash-clean, and rolls back the ENTIRE batch
//     (removing created copies + lesson rows) when any target conflicts.
//
// sql.js better-sqlite3 stand-in + a real temp filesystem (windows pathType),
// same harness as publisher.test.ts.
//   npm run build:main
//   node dist/main/main/memory-index/batch-publisher.test.js

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

type BatchModule = typeof import('./batch-publisher');
type StoreModule = typeof import('./review-store');
type ProvModule = typeof import('./skill-provisioning');
let batch: BatchModule;
let store: StoreModule;
let prov: ProvModule;

const PT = 'windows';
const NOW = '2026-07-28T00:00:00Z';
function mkWorkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-')); }
function full(wd: string, rel: string): string { return path.join(wd, rel); }
function writeAt(wd: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(full(wd, rel)), { recursive: true });
  fs.writeFileSync(full(wd, rel), content, 'utf8');
}
const two = [
  { name: 'lesson-a', description: 'when A', body: 'do A' },
  { name: 'lesson-b', description: 'when B', body: 'do B' },
];

// ── happy path ───────────────────────────────────────────────────────────────
test('a batch lands every copy of every lesson and activates the batch + rows', () => {
  const ws = 'ws-happy', wd = mkWorkDir();
  const res = batch.publishLessonsBatch(ws, wd, PT, { batchId: 'b1', snapshotId: 'snap1', lessons: two }, NOW);
  assert.equal(res.ok, true);
  assert.equal((res as { status: string }).status, 'active');
  for (const l of two) {
    const content = prov.buildLessonSkillContent(l.name, l.description, l.body);
    for (const rel of prov.lessonTargetRelPaths(l.name)) {
      assert.equal(fs.readFileSync(full(wd, rel), 'utf8'), content, `${rel} landed`);
      assert.ok(!fs.existsSync(full(wd, `${rel}.tmp`)), `${rel}.tmp cleaned`);
    }
  }
  assert.equal(store.getLessonBatch('b1')?.status, 'active', 'batch row active');
  assert.equal(store.listLessons(ws, 'active').length, 2, 'both lesson rows active');
  // receipts enumerate every created path (4 roots × 2 lessons).
  const created = (res as { receipts: Array<{ createdPaths: string[] }> }).receipts.flatMap((r) => r.createdPaths);
  assert.equal(created.length, 8, 'receipts enumerate every created copy');
});

// ── pending rows precede any fs write ────────────────────────────────────────
test('a pending-insert failure leaves the filesystem untouched and drops rows', () => {
  const ws = 'ws-insertfail', wd = mkWorkDir();
  const res = batch.publishLessonsBatch(ws, wd, PT, { batchId: 'b2', lessons: two }, NOW, { failPendingInsert: true });
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'pending_insert_failed');
  for (const l of two) for (const rel of prov.lessonTargetRelPaths(l.name)) {
    assert.ok(!fs.existsSync(full(wd, rel)), `${rel} not written`);
    assert.ok(!fs.existsSync(full(wd, `${rel}.tmp`)), `${rel}.tmp not written`);
  }
  assert.equal(store.listLessonsByBatch('b2').length, 0, 'no lesson rows survive a failed insert');
  assert.equal(store.getLessonBatch('b2')?.status, 'conflict', 'batch marked conflict');
});

// ── validation is pure/pre-write ─────────────────────────────────────────────
test('an invalid lesson in the batch rejects the WHOLE batch pre-write', () => {
  const ws = 'ws-invalid', wd = mkWorkDir();
  const lessons = [{ name: 'good-one', description: 'd', body: 'b' }, { name: 'Bad Name!', description: 'd', body: 'b' }];
  const res = batch.publishLessonsBatch(ws, wd, PT, { batchId: 'b3', lessons }, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'invalid_name');
  assert.ok(!fs.existsSync(full(wd, '.lares')), 'no fs tree for a rejected batch');
  assert.equal(store.listLessonsByBatch('b3').length, 0, 'no rows inserted for a rejected batch');
});

// ── conflict unwinds the whole batch ─────────────────────────────────────────
test('a differing on-disk target makes the whole batch a conflict and unwinds earlier lessons', () => {
  const ws = 'ws-conflict', wd = mkWorkDir();
  // lesson-b's second copy already holds foreign content → conflict when b is
  // staged, AFTER lesson-a fully committed. lesson-a's copies must be unwound.
  const bTargets = prov.lessonTargetRelPaths('lesson-b');
  writeAt(wd, bTargets[1], 'FOREIGN EDIT');
  const res = batch.publishLessonsBatch(ws, wd, PT, { batchId: 'b4', lessons: two }, NOW);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'conflict');
  // lesson-a's copies were unwound (it committed first, then b conflicted).
  for (const rel of prov.lessonTargetRelPaths('lesson-a')) {
    assert.ok(!fs.existsSync(full(wd, rel)), `${rel} unwound after the batch conflict`);
  }
  assert.equal(fs.readFileSync(full(wd, bTargets[1]), 'utf8'), 'FOREIGN EDIT', 'the foreign target was never overwritten');
  assert.equal(store.listLessonsByBatch('b4').length, 0, 'lesson rows removed on conflict rollback');
  assert.equal(store.getLessonBatch('b4')?.status, 'conflict', 'batch marked conflict');
});

// ── recovery: forward-complete ───────────────────────────────────────────────
function seedPendingBatch(ws: string, batchId: string): typeof two {
  store.createLessonBatch(ws, batchId, null, NOW);
  for (const l of two) {
    const content = prov.buildLessonSkillContent(l.name, l.description, l.body);
    store.registerLesson(ws, {
      lessonId: l.name, name: l.name, canonicalHash: crypto.createHash('sha256').update(content).digest('hex'),
      copies: prov.lessonTargetRelPaths(l.name), preexisted: [], status: 'pending', batchId,
    }, NOW);
  }
  return two;
}

test('recovery forward-completes a pending batch when every target is hash-clean', () => {
  const ws = 'ws-rec-fwd', wd = mkWorkDir();
  seedPendingBatch(ws, 'rb1');
  // Simulate a crash between renames: lesson-a fully written, lesson-b staged tmps only.
  for (const rel of prov.lessonTargetRelPaths('lesson-a')) writeAt(wd, rel, prov.buildLessonSkillContent('lesson-a', 'when A', 'do A'));
  for (const rel of prov.lessonTargetRelPaths('lesson-b')) writeAt(wd, `${rel}.tmp`, prov.buildLessonSkillContent('lesson-b', 'when B', 'do B'));
  const out = batch.recoverPendingBatches(ws, wd, PT, NOW);
  assert.deepEqual(out.recovered, ['rb1']);
  for (const l of two) for (const rel of prov.lessonTargetRelPaths(l.name)) {
    assert.ok(fs.existsSync(full(wd, rel)), `${rel} present after forward-completion`);
    assert.ok(!fs.existsSync(full(wd, `${rel}.tmp`)), `${rel}.tmp cleaned`);
  }
  assert.equal(store.getLessonBatch('rb1')?.status, 'active');
  assert.equal(store.listLessons(ws, 'active').length, 2);
});

test('recovery rolls back the ENTIRE batch when any target conflicts', () => {
  const ws = 'ws-rec-conflict', wd = mkWorkDir();
  seedPendingBatch(ws, 'rb2');
  // lesson-a fully written (clean); lesson-b has a DIFFERING target → whole-batch
  // rollback: lesson-a's created copies must be removed too.
  for (const rel of prov.lessonTargetRelPaths('lesson-a')) writeAt(wd, rel, prov.buildLessonSkillContent('lesson-a', 'when A', 'do A'));
  const bTargets = prov.lessonTargetRelPaths('lesson-b');
  writeAt(wd, bTargets[0], 'FOREIGN EDIT');
  const out = batch.recoverPendingBatches(ws, wd, PT, NOW);
  assert.deepEqual(out.conflicts, ['rb2']);
  for (const rel of prov.lessonTargetRelPaths('lesson-a')) {
    assert.ok(!fs.existsSync(full(wd, rel)), `${rel} removed on whole-batch rollback`);
  }
  assert.equal(fs.readFileSync(full(wd, bTargets[0]), 'utf8'), 'FOREIGN EDIT', 'the foreign target was never clobbered');
  assert.equal(store.listLessonsByBatch('rb2').length, 0, 'lesson rows removed on rollback');
  assert.equal(store.getLessonBatch('rb2')?.status, 'conflict');
});

test('recovery is a no-op when nothing is pending', () => {
  const ws = 'ws-rec-idle', wd = mkWorkDir();
  const out = batch.recoverPendingBatches(ws, wd, PT, NOW);
  assert.deepEqual(out, { recovered: [], conflicts: [] });
});

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-appdata-'));
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
  batch = require('./batch-publisher') as BatchModule;
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
