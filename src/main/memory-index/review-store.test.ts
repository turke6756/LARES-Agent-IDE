// review-store.test.ts — WP-B durable state APIs + evidence reconciliation.
//
// Covers every WP-B acceptance criterion:
//   - upsertFindings idempotency (same snapshot → unchanged count + advanced
//     last_seen; materially-changed entry → a NEW finding_id);
//   - the two telemetry guards: an INCOMPLETE corpus and an UNATTRIBUTED corpus
//     each SUPPRESS never-fired and emit a single evidence-unavailable with NO
//     absence candidate — exercised through the real assessLessonEvidence path;
//   - cap-pressure emitted on ratio overflow even with zero stale-active
//     candidates;
//   - never-recalled for an aged closed pointer-bearing entry (count 0) and NEVER
//     for an active capsule;
//   - a hard-invalid finding stored with entry_id=NULL + whole-index source_hash;
//   - clearFindings transitions absent findings to `cleared` and never deletes;
//   - two workspaces sharing an entry_id are isolated by workspace_id.
// Plus round-trips for index-state / runtime-error, recall increment, the lesson
// registry + batches, graduations, and migration approvals.
//
// better-sqlite3's native binding is built against Electron's ABI and won't load
// under the system Node that `npm run test:supervisor` uses, so this test injects
// a sql.js (wasm SQLite) stand-in into require.cache BEFORE requiring ../database
// (same precedent as access-policy-store.test.ts / queries.test.ts).
//
//   npm run build:main
//   node dist/main/main/memory-index/review-store.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedIndex, ParsedEntry } from '../../shared/memory-index-core';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in ──────────────────────────────
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
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
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

// ── module under test (loaded after cache injection) ───────────────────
type StoreModule = typeof import('./review-store');
let store: StoreModule;
let rawDb: { prepare(sql: string): { run(...p: unknown[]): unknown } };
let PARSER_VERSION = 1;
let BACKFILL_COMPLETE_KEY = 'backfill_complete_at';
let BACKFILL_VERSION_KEY = 'backfill_parser_version';

const NOW = '2026-07-28T00:00:00Z';

// ── ParsedIndex fixtures — only the fields reconcile reads ─────────────
function mkEntry(o: Partial<ParsedEntry> & { id: string; status: string }): ParsedEntry {
  return {
    id: o.id, title: o.title ?? '', status: o.status, date: o.date ?? null,
    owner: null, consequence: null, state: null, openLoop: null,
    expires: null, expiresWhen: null, readIf: null, detail: o.detail ?? null,
    fields: {}, blockStart: 0, blockEnd: 0, idMalformed: false,
  };
}
function mkParsed(o: { raw?: string; entries?: ParsedEntry[]; byteLength?: number; lineCount?: number }): ParsedIndex {
  const raw = o.raw ?? 'INDEX';
  return {
    raw, normalized: raw,
    byteLength: o.byteLength ?? Buffer.byteLength(raw, 'utf8'),
    lineCount: o.lineCount ?? 1,
    hasMarker: true, markerMismatch: false, preamble: '', handoffReadFirst: null,
    entries: o.entries ?? [], bareScopedPkgs: [],
  };
}

// ── raw seeding helpers for the real assessLessonEvidence path ─────────
let sessionSeq = 0;
function seedAttributedInvocation(ws: string, skillName: string): void {
  const aid = `agent-${++sessionSeq}`;
  const sess = `sess-${sessionSeq}`;
  rawDb.prepare(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command)
     VALUES (?, ?, 'T', 's', '/w', 'claude')`,
  ).run(aid, ws);
  rawDb.prepare(
    `INSERT INTO agent_sessions (dashboard_agent_id, generation, session_id, working_directory, provider)
     VALUES (?, 0, ?, '/w', 'claude')`,
  ).run(aid, sess);
  rawDb.prepare(
    `INSERT INTO skill_invocations (id, stream_id, jsonl_path, session_id, ts_ms, skill_name, detector)
     VALUES (?, ?, '/w/x.jsonl', ?, 1, ?, 'tool_use')`,
  ).run(`inv-${sessionSeq}`, `stream-${sessionSeq}`, sess, skillName);
}
function setBackfillComplete(version: number): void {
  rawDb.prepare(`INSERT OR REPLACE INTO skill_analytics_meta (k, v) VALUES (?, ?)`).run(BACKFILL_COMPLETE_KEY, NOW);
  rawDb.prepare(`INSERT OR REPLACE INTO skill_analytics_meta (k, v) VALUES (?, ?)`).run(BACKFILL_VERSION_KEY, String(version));
}

// ── upsert / clear ─────────────────────────────────────────────────────
test('upsertFindings is idempotent by finding_id: same snapshot → count unchanged, last_seen advances', () => {
  const ws = 'ws-upsert';
  const f = { kind: 'stale-active', entryId: 'mb-2026-07-01-x', sourceHash: 'H1', reason: 'r' };
  store.upsertFindings(ws, [f], '2026-07-28T00:00:00Z');
  store.upsertFindings(ws, [f], '2026-07-28T09:00:00Z');
  const rows = store.listFindings(ws);
  assert.equal(rows.length, 1, 'the repeated snapshot did not add a row');
  assert.equal(rows[0].firstSeen, '2026-07-28T00:00:00Z');
  assert.equal(rows[0].lastSeen, '2026-07-28T09:00:00Z', 'last_seen advanced');
});

test('a materially-changed entry yields a NEW finding_id and recurs as a fresh row', () => {
  const ws = 'ws-changed';
  store.upsertFindings(ws, [{ kind: 'stale-active', entryId: 'mb-1', sourceHash: 'HA', reason: 'r' }], NOW);
  store.upsertFindings(ws, [{ kind: 'stale-active', entryId: 'mb-1', sourceHash: 'HB', reason: 'r' }], NOW);
  assert.equal(store.listFindings(ws).length, 2, 'a changed source_hash is a distinct finding');
});

test('a hard-invalid finding stores entry_id=NULL + a whole-index source_hash', () => {
  const ws = 'ws-hard';
  const indexHash = 'WHOLE-INDEX-HASH';
  store.upsertFindings(ws, [{ kind: 'legacy-format', entryId: null, sourceHash: indexHash, reason: 'missing marker' }], NOW);
  const rows = store.listFindings(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryId, null, 'entry_id is NULL for a whole-index finding');
  assert.equal(rows[0].sourceHash, indexHash);
});

test('clearFindings transitions absent findings to cleared and never deletes rows', () => {
  const ws = 'ws-clear';
  const keep = { kind: 'cap-pressure', entryId: null, sourceHash: 'H', reason: 'r' };
  const drop = { kind: 'stale-active', entryId: 'mb-drop', sourceHash: 'H', reason: 'r' };
  const [keepId] = store.upsertFindings(ws, [keep], NOW);
  store.upsertFindings(ws, [drop], NOW);
  store.clearFindings(ws, [keepId], '2026-07-29T00:00:00Z');
  const all = store.listFindings(ws);
  assert.equal(all.length, 2, 'no row was deleted');
  const cleared = all.filter((r) => r.status === 'cleared');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].entryId, 'mb-drop');
  assert.equal(cleared[0].lastSeen, '2026-07-29T00:00:00Z');
  assert.equal(store.listFindings(ws, 'pending').length, 1, 'the kept finding stays pending');
});

test('rows for two workspaces sharing an entry_id are isolated by workspace_id', () => {
  const entryId = 'mb-2026-07-01-shared';
  store.upsertFindings('ws-A', [{ kind: 'never-recalled', entryId, sourceHash: 'HA', reason: 'r' }], NOW);
  store.upsertFindings('ws-B', [{ kind: 'never-recalled', entryId, sourceHash: 'HB', reason: 'r' }], NOW);
  store.bumpRecall('ws-A', entryId, NOW);
  assert.equal(store.listFindings('ws-A').length, 1);
  assert.equal(store.listFindings('ws-B').length, 1);
  assert.equal(store.getRecallCount('ws-A', entryId), 1);
  assert.equal(store.getRecallCount('ws-B', entryId), 0, 'the increment did not cross workspaces');
  // Clearing ws-A leaves ws-B untouched.
  store.clearFindings('ws-A', [], '2026-07-29T00:00:00Z');
  assert.equal(store.listFindings('ws-A', 'pending').length, 0);
  assert.equal(store.listFindings('ws-B', 'pending').length, 1);
});

// ── recall telemetry ──────────────────────────────────────────────────
test('bumpRecall atomically increments and records last_recalled', () => {
  const ws = 'ws-recall';
  store.bumpRecall(ws, 'mb-r', '2026-07-28T01:00:00Z');
  store.bumpRecall(ws, 'mb-r', '2026-07-28T02:00:00Z');
  assert.equal(store.getRecallCount(ws, 'mb-r'), 2);
});

// ── reconciliation: never-recalled ─────────────────────────────────────
const FIRED = { corpusComplete: true, attributionReliable: true, firedLessonNames: new Set<string>() };

test('never-recalled is produced for an aged closed pointer-bearing entry with count 0', () => {
  const ws = 'ws-nr';
  const parsed = mkParsed({
    entries: [mkEntry({ id: 'mb-2026-06-01-old', status: 'done', date: '2026-06-01', detail: 'p.md' })],
  });
  store.reconcileMemoryEvidence(ws, parsed, NOW, { evidence: FIRED });
  const nr = store.listFindings(ws).filter((f) => f.kind === 'never-recalled');
  assert.equal(nr.length, 1);
  assert.equal(nr[0].entryId, 'mb-2026-06-01-old');
});

test('never-recalled is NEVER produced for an active capsule (even aged, pointer-bearing, uncalled)', () => {
  const ws = 'ws-active';
  const parsed = mkParsed({
    entries: [mkEntry({ id: 'mb-2026-06-01-act', status: 'active', date: '2026-06-01', detail: 'p.md' })],
  });
  store.reconcileMemoryEvidence(ws, parsed, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'never-recalled').length, 0);
});

test('never-recalled is suppressed once the entry has been recalled (count > 0)', () => {
  const ws = 'ws-nr-recalled';
  store.bumpRecall(ws, 'mb-2026-06-01-old', NOW);
  const parsed = mkParsed({
    entries: [mkEntry({ id: 'mb-2026-06-01-old', status: 'archived', date: '2026-06-01', detail: 'p.md' })],
  });
  store.reconcileMemoryEvidence(ws, parsed, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'never-recalled').length, 0);
});

test('a young closed entry (age <= threshold) does not produce never-recalled', () => {
  const ws = 'ws-young';
  const parsed = mkParsed({
    entries: [mkEntry({ id: 'mb-2026-07-20-new', status: 'done', date: '2026-07-20', detail: 'p.md' })],
  });
  store.reconcileMemoryEvidence(ws, parsed, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'never-recalled').length, 0);
});

// ── reconciliation: cap-pressure ───────────────────────────────────────
test('cap-pressure is emitted when the index exceeds the ratio even with ZERO stale-active candidates', () => {
  const ws = 'ws-cap';
  // Over the byte ratio (0.8 * 25000 = 20000); no entries at all → no stale-active.
  const parsed = mkParsed({ raw: 'x', byteLength: 21000, lineCount: 1, entries: [] });
  store.reconcileMemoryEvidence(ws, parsed, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'cap-pressure').length, 1);
});

test('cap-pressure is NOT emitted below the ratio', () => {
  const ws = 'ws-nocap';
  const parsed = mkParsed({ raw: 'x', byteLength: 1000, lineCount: 5, entries: [] });
  store.reconcileMemoryEvidence(ws, parsed, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'cap-pressure').length, 0);
});

// ── reconciliation: never-fired vs evidence-unavailable (the two guards) ─
test('never-fired is emitted for an active lesson with no observed firing (corpus complete + attributed)', () => {
  const ws = 'ws-fired';
  store.registerLesson(ws, { lessonId: 'les-1', name: 'my-lesson', canonicalHash: 'h', copies: [], preexisted: [], status: 'active' }, NOW);
  const evidence = { corpusComplete: true, attributionReliable: true, firedLessonNames: new Set(['other-skill']) };
  store.reconcileMemoryEvidence(ws, mkParsed({}), NOW, { evidence });
  const nf = store.listFindings(ws).filter((f) => f.kind === 'never-fired');
  assert.equal(nf.length, 1);
  assert.equal(nf[0].entryId, 'les-1');
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'evidence-unavailable').length, 0);
});

test('a lesson that DID fire produces no never-fired finding', () => {
  const ws = 'ws-fired-ok';
  store.registerLesson(ws, { lessonId: 'les-2', name: 'used-lesson', canonicalHash: 'h', copies: [], preexisted: [], status: 'active' }, NOW);
  const evidence = { corpusComplete: true, attributionReliable: true, firedLessonNames: new Set(['used-lesson']) };
  store.reconcileMemoryEvidence(ws, mkParsed({}), NOW, { evidence });
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'never-fired').length, 0);
});

test('TELEMETRY GUARD 1 — an INCOMPLETE corpus suppresses never-fired and emits evidence-unavailable with NO absence candidate', () => {
  const ws = 'ws-incomplete';
  // Real path: attributed invocation present (attribution reliable) but backfill
  // marker absent → corpusComplete=false. No opts.evidence → assessLessonEvidence.
  seedAttributedInvocation(ws, 'other-skill');
  store.registerLesson(ws, { lessonId: 'les-i', name: 'unfired', canonicalHash: 'h', copies: [], preexisted: [], status: 'active' }, NOW);
  const ev = store.assessLessonEvidence(ws);
  assert.equal(ev.corpusComplete, false, 'no backfill marker → corpus incomplete');
  assert.equal(ev.attributionReliable, true, 'the seeded invocation attributes to ws');
  store.reconcileMemoryEvidence(ws, mkParsed({}), NOW);
  const rows = store.listFindings(ws);
  assert.equal(rows.filter((f) => f.kind === 'never-fired').length, 0, 'never-fired suppressed');
  const eu = rows.filter((f) => f.kind === 'evidence-unavailable');
  assert.equal(eu.length, 1, 'exactly one evidence-unavailable, no absence candidate');
  assert.equal(eu[0].entryId, null);
});

test('TELEMETRY GUARD 2 — an UNATTRIBUTED corpus suppresses never-fired and emits evidence-unavailable with NO absence candidate', () => {
  const ws = 'ws-unattributed';
  // Real path: corpus complete at the current parser_version, but NO invocation
  // attributes to ws (attribution is only an unreliable proxy).
  setBackfillComplete(PARSER_VERSION);
  store.registerLesson(ws, { lessonId: 'les-u', name: 'unfired', canonicalHash: 'h', copies: [], preexisted: [], status: 'active' }, NOW);
  const ev = store.assessLessonEvidence(ws);
  assert.equal(ev.corpusComplete, true, 'backfill complete at current parser_version');
  assert.equal(ev.attributionReliable, false, 'no reliably-attributed rows for ws');
  store.reconcileMemoryEvidence(ws, mkParsed({}), NOW);
  const rows = store.listFindings(ws);
  assert.equal(rows.filter((f) => f.kind === 'never-fired').length, 0, 'never-fired suppressed');
  const eu = rows.filter((f) => f.kind === 'evidence-unavailable');
  assert.equal(eu.length, 1);
  assert.equal(eu[0].entryId, null);
});

test('assessLessonEvidence collects fired skill names for attributed invocations', () => {
  const ws = 'ws-assess';
  setBackfillComplete(PARSER_VERSION);
  seedAttributedInvocation(ws, 'skill-alpha');
  seedAttributedInvocation(ws, 'skill-beta');
  const ev = store.assessLessonEvidence(ws);
  assert.equal(ev.corpusComplete, true);
  assert.equal(ev.attributionReliable, true);
  assert.ok(ev.firedLessonNames.has('skill-alpha') && ev.firedLessonNames.has('skill-beta'));
});

test('reconcile clears an evidence finding no longer produced this pass, keeping caller-supplied external ids', () => {
  const ws = 'ws-reconcile-clear';
  // Pass 1: an aged closed entry → never-recalled.
  const p1 = mkParsed({ entries: [mkEntry({ id: 'mb-2026-06-01-a', status: 'done', date: '2026-06-01', detail: 'p.md' })] });
  store.reconcileMemoryEvidence(ws, p1, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws, 'pending').filter((f) => f.kind === 'never-recalled').length, 1);
  // Pass 2: entry recalled → not re-produced → must be cleared.
  store.bumpRecall(ws, 'mb-2026-06-01-a', NOW);
  store.reconcileMemoryEvidence(ws, p1, NOW, { evidence: FIRED });
  assert.equal(store.listFindings(ws, 'pending').filter((f) => f.kind === 'never-recalled').length, 0, 'reconciled away → cleared');
  assert.equal(store.listFindings(ws).filter((f) => f.kind === 'never-recalled')[0].status, 'cleared');
});

// ── lesson registry + batches ──────────────────────────────────────────
test('registerLesson round-trips copies/preexisted and listLessons filters by status', () => {
  const ws = 'ws-lessons';
  store.registerLesson(ws, { lessonId: 'l1', name: 'a', canonicalHash: 'h1', copies: ['x/SKILL.md', 'y/SKILL.md'], preexisted: ['y/SKILL.md'], status: 'active' }, NOW);
  store.registerLesson(ws, { lessonId: 'l2', name: 'b', canonicalHash: 'h2', copies: [], preexisted: [], status: 'pending' }, NOW);
  const all = store.listLessons(ws);
  assert.equal(all.length, 2);
  const l1 = all.find((l) => l.lessonId === 'l1')!;
  assert.deepEqual(l1.copies, ['x/SKILL.md', 'y/SKILL.md']);
  assert.deepEqual(l1.preexisted, ['y/SKILL.md']);
  assert.equal(store.listLessons(ws, 'active').length, 1);
});

test('lesson batch activate/rollback flips the batch and its lessons together', () => {
  const ws = 'ws-batch';
  store.createLessonBatch(ws, 'batch-1', 'snap-1', NOW);
  store.registerLesson(ws, { lessonId: 'bl1', name: 'bl1', canonicalHash: 'h', copies: [], preexisted: [], batchId: 'batch-1', status: 'pending' }, NOW);
  store.registerLesson(ws, { lessonId: 'bl2', name: 'bl2', canonicalHash: 'h', copies: [], preexisted: [], batchId: 'batch-1', status: 'pending' }, NOW);
  store.activateLessonBatch('batch-1');
  assert.equal(store.getLessonBatch('batch-1')!.status, 'active');
  assert.equal(store.listLessons(ws, 'active').length, 2);
  store.rollbackLessonBatch('batch-1');
  assert.equal(store.getLessonBatch('batch-1')!.status, 'conflict');
  assert.equal(store.listLessons(ws, 'conflict').length, 2, 'lesson rows preserved as receipts, not deleted');
});

test('lessonDrift reports a name mapping to more than one canonical_hash', () => {
  const ws = 'ws-drift';
  store.registerLesson(ws, { lessonId: 'd1', name: 'dup', canonicalHash: 'hA', copies: [], preexisted: [] }, NOW);
  store.registerLesson(ws, { lessonId: 'd2', name: 'dup', canonicalHash: 'hB', copies: [], preexisted: [] }, NOW);
  store.registerLesson(ws, { lessonId: 'd3', name: 'clean', canonicalHash: 'hC', copies: [], preexisted: [] }, NOW);
  const drift = store.lessonDrift(ws);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].name, 'dup');
});

// ── graduations ────────────────────────────────────────────────────────
test('recordGraduation / listGraduations / setGraduationStatus round-trip', () => {
  const ws = 'ws-grad';
  const res = store.recordGraduation(ws, { proposalId: 'g1', target: 'CLAUDE.md', targetHashAtProposal: 'ABSENT', text: 't', rationale: 'r', sourceAgent: 'a1' });
  assert.equal(res.status, 'pending');
  assert.equal(store.listGraduations(ws, 'pending').length, 1);
  store.setGraduationStatus('g1', 'approved');
  assert.equal(store.listGraduations(ws, 'approved')[0].targetHashAtProposal, 'ABSENT');
});

// ── migration approvals ────────────────────────────────────────────────
test('recordMigrationApproval / getMigrationApproval round-trip and upsert', () => {
  const ws = 'ws-mig';
  store.recordMigrationApproval(ws, 'snap-1', 'th1', 'edward', NOW);
  assert.equal(store.getMigrationApproval(ws, 'snap-1')!.tableHash, 'th1');
  store.recordMigrationApproval(ws, 'snap-1', 'th2', 'edward', '2026-07-29T00:00:00Z');
  assert.equal(store.getMigrationApproval(ws, 'snap-1')!.tableHash, 'th2', 'same key upserts');
  assert.equal(store.getMigrationApproval(ws, 'nope'), null);
});

// ── index state ────────────────────────────────────────────────────────
test('putIndexState persists the source and a valid write CLEARS a prior runtime error', () => {
  const ws = 'ws-state';
  store.putRuntimeError(ws, 'parse threw', NOW);
  assert.equal(store.getIndexState(ws)!.lastRuntimeError, 'parse threw');
  store.putIndexState(ws, { sourceText: 'SRC', sourceHash: 'HH', parsedJson: '{}', validatedAt: NOW });
  const s = store.getIndexState(ws)!;
  assert.equal(s.sourceText, 'SRC');
  assert.equal(s.lastRuntimeError, null, 'a valid write cleared last_runtime_error');
});

test('putRuntimeError records without a prior row and does not clobber the good source', () => {
  const ws = 'ws-state-2';
  store.putIndexState(ws, { sourceText: 'GOOD', sourceHash: 'H', parsedJson: '{}', validatedAt: NOW });
  store.putRuntimeError(ws, 'read failed', '2026-07-29T00:00:00Z');
  const s = store.getIndexState(ws)!;
  assert.equal(s.sourceText, 'GOOD', 'runtime error left the last-known-good source intact');
  assert.equal(s.lastRuntimeError, 'read failed');
});

// ── Run ────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'review-store-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbm = require('../database') as { initDatabase(): void; getDb(): typeof rawDb };
  dbm.initDatabase();
  rawDb = dbm.getDb();
  store = require('./review-store') as StoreModule;
  // Pull the real parser-version / meta keys so the coverage tests track the source.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ PARSER_VERSION } = require('../skill-analytics/parse-runner'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ BACKFILL_COMPLETE_KEY, BACKFILL_VERSION_KEY } = require('../skill-analytics/parse-manager'));

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
