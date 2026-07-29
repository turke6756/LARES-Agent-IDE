// recall-tool.test.ts — WP-D `recall_memory` detail fetch + recall telemetry.
//
// Covers every WP-D acceptance criterion:
//   - a declared `detail:` pointer whose basename ≠ <id>.md still resolves (the
//     DECLARED pointer from the parsed capsule is used, never a synthesized name);
//   - traversal / `..` / separator ids are rejected by MEMORY_ID_GRAMMAR with NO
//     disk read and NO increment (invalid_id);
//   - a missing detail file → not_found with no increment; an absent pointer →
//     not_found; a pointer escaping MEMORY_DETAILS_DIR → not_found (no leak);
//   - an archived capsule is served with { ok:true, archived:true } and DOES bump;
//   - an oversize body is UTF-8-safe-truncated (truncated:true) without splitting
//     a multibyte sequence;
//   - `bumpRecall` fires ONLY on ok:true;
//   - TWO workspaces holding the same memory id cannot cross-read or
//     cross-increment (structural isolation by workspaceRoot + workspace_id).
//
// better-sqlite3's native binding is built against Electron's ABI and won't load
// under the system Node the main-test runner uses, so this test injects a sql.js
// (wasm SQLite) stand-in into require.cache BEFORE requiring ../database — the
// same precedent as review-store.test.ts. recall.ts imports review-store (for
// bumpRecall), so the fake must be in place before recall.ts is required too.
//
//   npm run build:main
//   node dist/main/main/memory-index/recall-tool.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RECALL_DETAIL_MAX_BYTES, MEMORY_DETAILS_DIR } from '../../shared/memory-index-core';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors review-store.test.ts) ──
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

// ── modules under test (loaded after cache injection) ───────────────────
type RecallModule = typeof import('./recall');
type StoreModule = typeof import('./review-store');
let recall: RecallModule;
let store: StoreModule;

const NOW = '2026-07-28T00:00:00Z';

// ── on-disk fixture builders ────────────────────────────────────────────
const MARKER = '<!-- disclosure-format: v2 -->';

interface CapsuleSpec {
  id: string;
  status: string;
  /** the `detail:` pointer value; omit for a capsule with no detail line. */
  detail?: string;
}

/** Create a workspace root with a MEMORY.md holding the given capsules, plus a
 *  details dir. Returns { root, detailsDir }. Detail bodies are written separately. */
function makeWorkspace(capsules: CapsuleSpec[]): { root: string; detailsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-ws-'));
  const detailsDir = path.join(root, ...MEMORY_DETAILS_DIR.split('/').filter(Boolean));
  fs.mkdirSync(detailsDir, { recursive: true });
  const memoryMd = path.resolve(detailsDir, '..', 'MEMORY.md');
  let text = `${MARKER}\n\n`;
  for (const c of capsules) {
    text += `## ${c.id}: ${c.id} title\n`;
    text += `- status: ${c.status}\n`;
    text += `- consequence: c\n- state: s\n- read-if: r\n`;
    if (c.detail !== undefined) text += `- detail: ${c.detail}\n`;
    text += '\n';
  }
  fs.writeFileSync(memoryMd, text, 'utf8');
  return { root, detailsDir };
}

/** Write a detail body file under a workspace's details dir. */
function writeDetail(detailsDir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(detailsDir, name), body, 'utf8');
}

// ── AC1: the DECLARED pointer resolves, even when basename ≠ <id>.md ──────
test('AC1 — a declared pointer whose basename ≠ <id>.md still resolves via the declared pointer', () => {
  const id = 'mb-2026-07-28-alpha';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'done', detail: 'memory/details/custom-basename.md' }]);
  writeDetail(detailsDir, 'custom-basename.md', 'ALPHA BODY');
  // A synthesized <id>.md is deliberately NOT written — only custom-basename.md.
  const r = recall.recallMemoryDetail(root, id);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.body, 'ALPHA BODY');
    assert.equal(r.status, 'done');
    assert.equal(r.archived, false);
    assert.equal(r.truncated, false);
  }
});

// ── AC2: traversal / .. / separator ids → invalid_id, no disk read, no bump ─
test('AC2 — traversal / .. / separator ids are rejected (invalid_id) with no disk read and no increment', () => {
  const ws = 'ws-invalid';
  // A NONEXISTENT root proves no disk read is required to reject a bad id.
  const bogusRoot = path.join(os.tmpdir(), 'does-not-exist-recall-root');
  for (const badId of [
    'mb-2026-07-28-../../etc/passwd',
    'mb-2026-07-28-a/b',
    '../mb-2026-07-28-x',
    'mb-2026-07-28-CAPS',
    'not-a-memory-id',
    'mb-2026-7-28-x', // non-zero-padded → fails the grammar
  ]) {
    const r = recall.recallMemoryDetailWithTelemetry(ws, bogusRoot, badId, NOW);
    assert.equal(r.ok, false, `${badId} must be rejected`);
    if (!r.ok) assert.equal(r.code, 'invalid_id', `${badId} → invalid_id`);
  }
  // A non-string id is likewise invalid_id.
  const rNull = recall.recallMemoryDetailWithTelemetry(ws, bogusRoot, undefined, NOW);
  assert.equal(rNull.ok, false);
  if (!rNull.ok) assert.equal(rNull.code, 'invalid_id');
  // No increment for any rejected id (the whole workspace tally stays empty).
  assert.equal(store.getRecallCount(ws, 'mb-2026-07-28-CAPS'), 0);
});

// ── AC3a: missing detail file / absent pointer → not_found, no increment ──
test('AC3a — a missing detail file → not_found with no increment', () => {
  const ws = 'ws-missing';
  const id = 'mb-2026-07-28-gone';
  const { root } = makeWorkspace([{ id, status: 'done', detail: 'memory/details/never-written.md' }]);
  const r = recall.recallMemoryDetailWithTelemetry(ws, root, id, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'not_found');
  assert.equal(store.getRecallCount(ws, id), 0, 'a not_found never increments');
});

test('AC3a — an id absent from the index → not_found', () => {
  const id = 'mb-2026-07-28-present';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'done', detail: 'memory/details/p.md' }]);
  writeDetail(detailsDir, 'p.md', 'body');
  const r = recall.recallMemoryDetail(root, 'mb-2026-07-28-absent');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'not_found');
});

test('AC3a — a capsule with NO detail pointer → not_found (never a synthesized <id>.md)', () => {
  const id = 'mb-2026-07-28-nodetail';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'done' }]);
  // Even if a file named <id>.md exists on disk, an absent pointer is not_found.
  writeDetail(detailsDir, `${id}.md`, 'MUST NOT BE SERVED');
  const r = recall.recallMemoryDetail(root, id);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'not_found');
});

test('a pointer escaping MEMORY_DETAILS_DIR → not_found (no content leak, no increment)', () => {
  const ws = 'ws-escape';
  const id = 'mb-2026-07-28-escape';
  const { root } = makeWorkspace([{ id, status: 'done', detail: 'memory/../../../outside-secret.md' }]);
  // Write the escape target on disk so a resolution that failed to bound would leak it.
  fs.writeFileSync(path.join(root, 'outside-secret.md'), 'SECRET', 'utf8');
  const r = recall.recallMemoryDetailWithTelemetry(ws, root, id, NOW);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'not_found');
  assert.equal(store.getRecallCount(ws, id), 0);
});

// ── AC3b: archived served with the flag, and it bumps ─────────────────────
test('AC3b — an archived capsule is served with { ok:true, archived:true } and increments', () => {
  const ws = 'ws-archived';
  const id = 'mb-2026-07-28-arch';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'archived', detail: 'memory/details/arch.md' }]);
  writeDetail(detailsDir, 'arch.md', 'ARCHIVED BODY');
  const r = recall.recallMemoryDetailWithTelemetry(ws, root, id, NOW);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.archived, true);
    assert.equal(r.status, 'archived');
    assert.equal(r.body, 'ARCHIVED BODY');
  }
  assert.equal(store.getRecallCount(ws, id), 1, 'a successful recall (incl. archived) bumps exactly once');
});

test('bumpRecall fires ONLY on ok:true — a repeated success accumulates', () => {
  const ws = 'ws-bump';
  const id = 'mb-2026-07-28-bump';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'done', detail: 'memory/details/b.md' }]);
  writeDetail(detailsDir, 'b.md', 'B');
  recall.recallMemoryDetailWithTelemetry(ws, root, id, NOW);
  recall.recallMemoryDetailWithTelemetry(ws, root, id, '2026-07-28T01:00:00Z');
  assert.equal(store.getRecallCount(ws, id), 2);
});

// ── AC3c: oversize body UTF-8-safe-truncated without splitting a rune ──────
test('AC3c — an oversize body is truncated (truncated:true) without splitting a multibyte sequence', () => {
  const id = 'mb-2026-07-28-big';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'done', detail: 'memory/details/big.md' }]);
  // (RECALL_DETAIL_MAX_BYTES - 1) ASCII bytes, then a 3-byte '€' straddling the
  // cap boundary. A naive byte-slice at the cap would split the euro; the safe
  // truncate must back up over it, dropping the whole rune.
  const filler = 'a'.repeat(RECALL_DETAIL_MAX_BYTES - 1);
  writeDetail(detailsDir, 'big.md', filler + '€');
  const r = recall.recallMemoryDetail(root, id);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.body, 'utf8') <= RECALL_DETAIL_MAX_BYTES, 'body within the cap');
    assert.ok(!r.body.includes('�'), 'no replacement char — the rune was not split');
    assert.equal(r.body, filler, 'the incomplete euro was dropped whole, leaving only the filler');
    assert.equal(r.bytes, Buffer.byteLength(r.body, 'utf8'));
  }
});

test('a body exactly at the cap is NOT flagged truncated', () => {
  const id = 'mb-2026-07-28-exact';
  const { root, detailsDir } = makeWorkspace([{ id, status: 'done', detail: 'memory/details/exact.md' }]);
  writeDetail(detailsDir, 'exact.md', 'a'.repeat(RECALL_DETAIL_MAX_BYTES));
  const r = recall.recallMemoryDetail(root, id);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.truncated, false);
    assert.equal(r.bytes, RECALL_DETAIL_MAX_BYTES);
  }
});

// ── AC4: cross-workspace isolation ────────────────────────────────────────
test('AC4 — two workspaces holding the same memory id CANNOT cross-read or cross-increment', () => {
  const id = 'mb-2026-07-28-shared';
  const a = makeWorkspace([{ id, status: 'done', detail: 'memory/details/shared.md' }]);
  const b = makeWorkspace([{ id, status: 'done', detail: 'memory/details/shared.md' }]);
  writeDetail(a.detailsDir, 'shared.md', 'WORKSPACE-A-BODY');
  writeDetail(b.detailsDir, 'shared.md', 'WORKSPACE-B-BODY');
  const wsA = 'ws-A';
  const wsB = 'ws-B';

  const rA = recall.recallMemoryDetailWithTelemetry(wsA, a.root, id, NOW);
  const rB = recall.recallMemoryDetailWithTelemetry(wsB, b.root, id, NOW);
  assert.equal(rA.ok, true);
  assert.equal(rB.ok, true);
  // Cross-READ isolation: each workspace sees ONLY its own detail body.
  if (rA.ok) assert.equal(rA.body, 'WORKSPACE-A-BODY');
  if (rB.ok) assert.equal(rB.body, 'WORKSPACE-B-BODY');
  // Cross-INCREMENT isolation: A's recall did not touch B's counter and vice versa.
  recall.recallMemoryDetailWithTelemetry(wsA, a.root, id, NOW); // A → 2
  assert.equal(store.getRecallCount(wsA, id), 2);
  assert.equal(store.getRecallCount(wsB, id), 1, 'B was incremented exactly once — never by A');
});

// ── Run ────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-'));
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
  recall = require('./recall') as RecallModule;

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
