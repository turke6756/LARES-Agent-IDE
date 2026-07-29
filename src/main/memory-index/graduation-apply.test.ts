// graduation-apply.test.ts — WP-H3 graduation apply (the only applier).
//
// Covers every WP-H3 apply acceptance criterion:
//   - apply is a CAS on target_hash_at_proposal; a mismatch → needs_reapproval
//     with the new current hash surfaced and NO write;
//   - the append occurs ONLY inside the Lares start/end markers; an unmarked
//     `## Graduated notes` heading → conflict, no write;
//   - UTF-8 ± BOM and LF/CRLF are preserved; any other encoding is rejected
//     without writing;
//   - a symlink / ancestor escape on the target is rejected (fs seam);
//   - apply is idempotent on an equal line;
//   - concurrent proposals serialize — the second re-approves against the first's
//     resulting hash;
//   - an ABSENT-sentinel target is created with ONLY the marked section.
//
// sql.js better-sqlite3 stand-in (for the graduation_proposals store) + a real
// temp filesystem (windows pathType).
//   npm run build:main
//   node dist/main/main/memory-index/graduation-apply.test.js

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

type ApplyModule = typeof import('./graduation-apply');
type StoreModule = typeof import('./review-store');
type GradModule = typeof import('./graduation');
let applyMod: ApplyModule;
let store: StoreModule;
let ABSENT: string;

const PT = 'windows';
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function mkWorkDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'grad-')); }

let seq = 0;
/** Record a pending graduation proposal directly in the store. */
function recordProp(ws: string, target: string, hash: string, text: string): string {
  const id = `grad-${++seq}`;
  store.recordGraduation(ws, { proposalId: id, target, targetHashAtProposal: hash, text, rationale: 'because', sourceAgent: 'agent-x' });
  return id;
}

const START = '<!-- lares:graduated-notes:start -->';
const END = '<!-- lares:graduated-notes:end -->';

// ── happy path: fresh marked section is appended ──────────────────────────────
test('apply appends a fresh marked section to an existing target', () => {
  const ws = 'ws-fresh', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  const original = '# Project\n\nSome always-true text.\n';
  fs.writeFileSync(target, original, 'utf8');
  const id = recordProp(ws, 'CLAUDE.md', sha(original), 'Always run the migration before deploying.');

  const res = applyMod.applyGraduation(ws, wd, PT, id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((res as { applied: boolean }).applied, true);
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(after.startsWith(original), 'original content is preserved verbatim');
  assert.ok(after.includes('## Graduated notes'), 'heading written');
  assert.ok(after.includes(START) && after.includes(END), 'managed markers written');
  assert.ok(after.indexOf('Always run the migration before deploying.') > after.indexOf(START), 'text inside the block');
  assert.ok(after.indexOf('Always run the migration before deploying.') < after.indexOf(END), 'text before the end marker');
  assert.equal(store.getGraduation(id)!.status, 'applied');
});

// ── CAS mismatch → needs_reapproval, no write ─────────────────────────────────
test('apply CAS mismatch yields needs_reapproval with the new hash and no write', () => {
  const ws = 'ws-cas', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  const original = '# Project\n';
  fs.writeFileSync(target, original, 'utf8');
  // Proposal captured a STALE hash (the doc has since changed).
  const id = recordProp(ws, 'CLAUDE.md', sha('STALE CONTENT'), 'a note');

  const res = applyMod.applyGraduation(ws, wd, PT, id);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'needs_reapproval');
  assert.equal((res as { currentHash: string }).currentHash, sha(original), 'the current hash is surfaced');
  assert.equal(fs.readFileSync(target, 'utf8'), original, 'target untouched');
  const row = store.getGraduation(id)!;
  assert.equal(row.status, 'needs-reapproval');
  assert.equal(row.targetHashAtProposal, sha(original), 'stored hash advanced to the current bytes');
});

// ── unmarked `## Graduated notes` heading is user-owned → conflict ─────────────
test('apply refuses to write when an unmarked "## Graduated notes" heading exists', () => {
  const ws = 'ws-conflict', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  const original = '# Project\n\n## Graduated notes\n\nUser hand-wrote this section.\n';
  fs.writeFileSync(target, original, 'utf8');
  const id = recordProp(ws, 'CLAUDE.md', sha(original), 'a note');

  const res = applyMod.applyGraduation(ws, wd, PT, id);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'conflict');
  assert.equal(fs.readFileSync(target, 'utf8'), original, 'user-owned section untouched');
  assert.equal(store.getGraduation(id)!.status, 'pending', 'proposal not marked applied');
});

// ── BOM + CRLF preserved; append inside existing markers ──────────────────────
test('apply preserves a BOM and CRLF newlines and appends inside existing markers', () => {
  const ws = 'ws-bom', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  const original = `﻿# Project\r\n\r\n## Graduated notes\r\n${START}\r\nfirst note\r\n${END}\r\n`;
  fs.writeFileSync(target, original, 'utf8');
  const id = recordProp(ws, 'CLAUDE.md', sha(original), 'second note');

  const res = applyMod.applyGraduation(ws, wd, PT, id);
  assert.equal(res.ok, true, JSON.stringify(res));
  const raw = fs.readFileSync(target);
  assert.deepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf], 'BOM preserved');
  const afterStr = raw.toString('utf8');
  assert.ok(afterStr.includes('second note\r\n'), 'appended with CRLF');
  assert.ok(!afterStr.includes('second note\n\n'), 'no LF-only line introduced');
  assert.ok(afterStr.includes('first note'), 'existing note kept');
  assert.ok(afterStr.indexOf('second note') < afterStr.indexOf(END), 'appended before the end marker');
});

// ── non-UTF-8 encoding is rejected without writing ────────────────────────────
test('apply rejects a non-UTF-8 target without writing', () => {
  const ws = 'ws-badbytes', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  const rawBytes = Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x0a]); // 'Hi' + invalid UTF-8
  fs.writeFileSync(target, rawBytes);
  const id = recordProp(ws, 'CLAUDE.md', sha(rawBytes.toString('utf8')), 'a note');

  const res = applyMod.applyGraduation(ws, wd, PT, id);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'bad_encoding');
  assert.deepEqual(fs.readFileSync(target), rawBytes, 'target bytes untouched');
});

// ── symlink target is rejected (fs seam) ──────────────────────────────────────
test('apply rejects a symlinked target', () => {
  const ws = 'ws-sym', wd = mkWorkDir();
  fs.writeFileSync(path.join(wd, 'CLAUDE.md'), '# x\n', 'utf8');
  const id = recordProp(ws, 'CLAUDE.md', sha('# x\n'), 'a note');
  const fakeFs = { ...applyMod.nodeGraduationFs, lstatIsSymlink: () => true };

  const res = applyMod.applyGraduation(ws, wd, PT, id, fakeFs);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'symlink');
  assert.equal(fs.readFileSync(path.join(wd, 'CLAUDE.md'), 'utf8'), '# x\n', 'target untouched');
});

// ── ancestor escape is rejected (fs seam) ─────────────────────────────────────
test('apply rejects a target whose parent resolves outside the workspace root', () => {
  const ws = 'ws-esc', wd = mkWorkDir();
  fs.writeFileSync(path.join(wd, 'CLAUDE.md'), '# x\n', 'utf8');
  const id = recordProp(ws, 'CLAUDE.md', sha('# x\n'), 'a note');
  // containmentError calls realpath(root) then realpath(dirname(target)); for a
  // bare basename both args are `wd`, so distinguish by call order — the root
  // resolves to wd, the target's parent resolves ELSEWHERE (a symlinked ancestor).
  let calls = 0;
  const fakeFs = {
    ...applyMod.nodeGraduationFs,
    realpath: () => (calls++ === 0 ? wd : path.join(os.tmpdir(), 'elsewhere')),
  };

  const res = applyMod.applyGraduation(ws, wd, PT, id, fakeFs);
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, 'escape');
});

// ── idempotent on an equal line ───────────────────────────────────────────────
test('apply is idempotent when the text is already inside the managed block', () => {
  const ws = 'ws-idem', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  fs.writeFileSync(target, '# Project\n', 'utf8');
  // First proposal writes the note.
  const id1 = recordProp(ws, 'CLAUDE.md', sha('# Project\n'), 'the durable rule');
  assert.equal(applyMod.applyGraduation(ws, wd, PT, id1).ok, true);
  const afterFirst = fs.readFileSync(target);

  // A SECOND proposal with the SAME text, captured against the CURRENT hash.
  const id2 = recordProp(ws, 'CLAUDE.md', sha(afterFirst.toString('utf8')), 'the durable rule');
  const res = applyMod.applyGraduation(ws, wd, PT, id2);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((res as { applied: boolean }).applied, false, 'idempotent no-op');
  assert.deepEqual(fs.readFileSync(target), afterFirst, 'file bytes unchanged on the idempotent apply');
  assert.equal(store.getGraduation(id2)!.status, 'applied');
});

// ── concurrent proposals serialize; the second re-approves against the first ──
test('concurrent proposals serialize — the second re-approves against the first hash', () => {
  const ws = 'ws-conc', wd = mkWorkDir();
  const target = path.join(wd, 'CLAUDE.md');
  const original = '# Project\n';
  fs.writeFileSync(target, original, 'utf8');
  const h0 = sha(original);
  // Two proposals both authored against the ORIGINAL hash.
  const p1 = recordProp(ws, 'CLAUDE.md', h0, 'note ONE');
  const p2 = recordProp(ws, 'CLAUDE.md', h0, 'note TWO');

  // P1 applies first.
  assert.equal(applyMod.applyGraduation(ws, wd, PT, p1).ok, true);
  const h1 = sha(fs.readFileSync(target, 'utf8'));

  // P2 now CAS-fails against the stale h0 → needs_reapproval, hash advanced to h1.
  const stale = applyMod.applyGraduation(ws, wd, PT, p2);
  assert.equal(stale.ok, false);
  assert.equal((stale as { code: string }).code, 'needs_reapproval');
  assert.equal(store.getGraduation(p2)!.targetHashAtProposal, h1, 're-approves against the first result');

  // Re-approving P2 (its stored hash is now h1) applies cleanly.
  const res = applyMod.applyGraduation(ws, wd, PT, p2);
  assert.equal(res.ok, true, JSON.stringify(res));
  const final = fs.readFileSync(target, 'utf8');
  assert.ok(final.includes('note ONE') && final.includes('note TWO'), 'both notes land in one block');
  assert.equal((final.match(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, 'a single managed block');
});

// ── ABSENT-sentinel target is created with only the marked section ────────────
test('apply creates an absent target with only the marked section', () => {
  const ws = 'ws-absent', wd = mkWorkDir();
  const target = path.join(wd, 'AGENTS.md');
  assert.ok(!fs.existsSync(target), 'precondition: target absent');
  const id = recordProp(ws, 'AGENTS.md', ABSENT, 'the only note');

  const res = applyMod.applyGraduation(ws, wd, PT, id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(fs.existsSync(target), 'target created');
  const created = fs.readFileSync(target, 'utf8');
  assert.ok(created.startsWith('## Graduated notes\n'), 'starts with the heading, no other body');
  assert.ok(created.includes(START) && created.includes('the only note') && created.includes(END));
});

// ── unknown proposal / workspace mismatch ─────────────────────────────────────
test('apply rejects an unknown proposal id and a cross-workspace proposal', () => {
  const ws = 'ws-a', wd = mkWorkDir();
  fs.writeFileSync(path.join(wd, 'CLAUDE.md'), '# x\n', 'utf8');
  assert.equal((applyMod.applyGraduation(ws, wd, PT, 'nope') as { code: string }).code, 'not_found');
  const id = recordProp('ws-OTHER', 'CLAUDE.md', sha('# x\n'), 'a note');
  assert.equal((applyMod.applyGraduation(ws, wd, PT, id) as { code: string }).code, 'not_found');
});

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'grad-appdata-'));
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
  applyMod = require('./graduation-apply') as ApplyModule;
  ABSENT = (require('./graduation') as GradModule).ABSENT_TARGET_SENTINEL;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
