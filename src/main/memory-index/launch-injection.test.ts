// launch-injection.test.ts — WP-C launch projection + provider-neutral delivery.
//
// Runs as plain Node after `npm run build:main`:
//   node dist/main/main/memory-index/launch-injection.test.js
// Registered in scripts/run-main-tests.mjs.
//
// Covers the WP-C acceptance criteria that live in the shared launch projection
// (computeSupervisorMemoryInjection) + the composition/predicate helpers the
// index.ts delivery adapters call:
//   • valid current parse → injectText carries the index; putIndexState persists
//     the last-good SOURCE and CLEARS a prior last_runtime_error; findings are
//     upserted + reconciled; MEMORY.md bytes/mtime are untouched; a repeat launch
//     does not duplicate queue rows.
//   • RUNTIME (read/parse threw) → nothing injected, putRuntimeError set, launch
//     proceeds (fail-open), the last-good SOURCE is left intact.
//   • HARD-invalid current parse → fallback is RE-VALIDATED with I/O and
//     re-projected TODAY (a since-expired entry is absent); a since-missing
//     pointer makes the fallback itself invalid → banner-only; no prior good →
//     banner-only. Reconciliation never runs/clears against an invalid current
//     parse.
//   • the provider-neutral compose helper: index-only when no base message,
//     merged ahead of one when present.
//   • the lane predicate (hasSupervisorPrivilege) injects for supervisors +
//     supervisor-privilege personas and EXCLUDES supervised workers, researchers,
//     and plain workers.
//   • WP-C gate regression: every live *_CLAUDE_SETTINGS_JSON blob keeps
//     autoMemoryEnabled === false (app-owned injection stays provider-blind; the
//     harness auto-memory must never turn on).
//
// The exactly-once DELIVERY matrix (Claude fresh → sysprompt; Codex fresh
// with/without prompt, resume, revive → single-slot pending rail; worker/
// researcher → nothing) is enforced BY CONSTRUCTION in src/main/supervisor/
// index.ts — provider-gated call sites + the single-slot pendingInitialPrompts
// map — and is exercised there; this suite pins the pure projection + the
// index-agnostic composition/predicate the adapters share.
//
// better-sqlite3's native binding is built against Electron's ABI and won't load
// under the system Node the test runner uses, so this test injects a sql.js
// (wasm SQLite) stand-in into require.cache BEFORE requiring ../database (same
// precedent as review-store.test.ts).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasSupervisorPrivilege } from '../../shared/types';
import {
  SUPERVISOR_CLAUDE_SETTINGS_JSON,
  SUPERVISOR_PERSONA_CLAUDE_SETTINGS_JSON,
  WORKER_CLAUDE_SETTINGS_JSON,
  RESEARCHER_CLAUDE_SETTINGS_JSON,
} from '../../shared/constants';
import { DISCLOSURE_FORMAT_MARKER } from '../../shared/memory-index-core';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors review-store.test.ts) ────────
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

// ── module under test + store (loaded after cache injection) ───────────────────
type InjModule = typeof import('./launch-injection');
type StoreModule = typeof import('./review-store');
let inj: InjModule;
let store: StoreModule;

// ── index fixtures (mirror io-validate.test.ts) ────────────────────────────────
const MARKER = DISCLOSURE_FORMAT_MARKER;
function ACTIVE(id: string, over: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    status: 'active',
    date: '2026-07-28',
    owner: 'super',
    consequence: 'things break silently',
    state: 'constraint X holds',
    'open-loop': 'finish Y',
    'read-if': 'before editing the schema',
    detail: `memory/details/${id}.md`,
    ...over,
  };
  const lines = [`## ${id}: Title`];
  for (const [k, v] of Object.entries(f)) if (v !== '') lines.push(`- ${k}: ${v}`);
  return lines.join('\n');
}
function idx(...blocks: string[]): string {
  return `${MARKER}\n\n${blocks.join('\n\n')}\n`;
}

const roots: string[] = [];
function makeWorkspace(): { root: string; detailsDir: string; memoryMd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-launch-'));
  roots.push(root);
  const detailsDir = path.join(root, '.lares', 'supervisor', 'memory', 'details');
  fs.mkdirSync(detailsDir, { recursive: true });
  return { root, detailsDir, memoryMd: path.join(detailsDir, '..', 'MEMORY.md') };
}
function writeIndex(memoryMd: string, body: string): void { fs.writeFileSync(memoryMd, body, 'utf8'); }
function writeDetail(detailsDir: string, id: string): void {
  fs.writeFileSync(path.join(detailsDir, `${id}.md`), `# ${id}\nclosed history\n`, 'utf8');
}

const NOW = '2026-07-28T00:00:00Z';
let wsSeq = 0;
const nextWs = () => `ws-launch-${++wsSeq}`;

// ── lane predicate ──────────────────────────────────────────────────────────
test('hasSupervisorPrivilege injects for supervisors + privilege personas, excludes workers/researchers', () => {
  assert.equal(hasSupervisorPrivilege({ isSupervisor: true }), true, 'a structural supervisor is injected');
  assert.equal(hasSupervisorPrivilege({ privilegeLane: 'supervisor' }), true, 'a supervisor-privilege persona is injected');
  assert.equal(hasSupervisorPrivilege({ isSupervisor: false }), false, 'a supervised worker gets NOTHING');
  assert.equal(hasSupervisorPrivilege({}), false, 'a plain worker / researcher gets NOTHING');
});

// ── compose helper (Codex pending rail) ────────────────────────────────────────
test('composeMemoryPending: index-only with no base, merged ahead of a base message', () => {
  assert.equal(inj.composeMemoryPending('IDX', ''), 'IDX', 'no initial prompt → index-only pending message');
  assert.equal(inj.composeMemoryPending('IDX', 'BASE'), 'IDX\n\nBASE', 'an initial prompt → single merged message');
  assert.equal(inj.composeMemoryPending('', 'BASE'), 'BASE', 'empty projection leaves the base untouched');
  assert.equal(inj.composeMemoryPending('', ''), '', 'nothing to stage');
});

// ── valid current parse ────────────────────────────────────────────────────────
test('valid index → injects the projected text, persists last-good source, upserts + reconciles', () => {
  const ws = nextWs();
  const { root, detailsDir, memoryMd } = makeWorkspace();
  const id = 'mb-2026-07-28-clean';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);

  const bytesBefore = fs.readFileSync(memoryMd);
  const mtimeBefore = fs.statSync(memoryMd).mtimeMs;

  const r = inj.computeSupervisorMemoryInjection(ws, root, NOW);
  assert.equal(r.outcome, 'valid');
  assert.ok(r.injectText.includes(id), 'the clean capsule rides injectText');

  const state = store.getIndexState(ws)!;
  assert.ok(state.sourceText && state.sourceText.includes(id), 'the last-good SOURCE was persisted');
  assert.equal(state.lastRuntimeError, null);
  // reconcile ran against the valid source (empty corpus ⇒ evidence-unavailable).
  assert.ok(store.listFindings(ws, 'pending').length >= 1, 'reconciliation produced at least one finding');

  // MEMORY.md is read-only across a launch.
  assert.deepEqual(fs.readFileSync(memoryMd), bytesBefore, 'MEMORY.md bytes unchanged');
  assert.equal(fs.statSync(memoryMd).mtimeMs, mtimeBefore, 'MEMORY.md mtime unchanged');
});

test('a repeat launch does not duplicate review-queue rows', () => {
  const ws = nextWs();
  const { root, detailsDir, memoryMd } = makeWorkspace();
  const id = 'mb-2026-06-01-stale'; // aged active → stale-active finding too
  writeIndex(memoryMd, idx(ACTIVE(id, { date: '2026-06-01' })));
  writeDetail(detailsDir, id);

  inj.computeSupervisorMemoryInjection(ws, root, NOW);
  const after1 = store.listFindings(ws).length;
  inj.computeSupervisorMemoryInjection(ws, root, NOW);
  const after2 = store.listFindings(ws).length;
  assert.equal(after1, after2, 'idempotent finding_ids ⇒ no duplicate rows on relaunch');
  assert.ok(store.listFindings(ws, 'pending').some((f) => f.kind === 'stale-active' && f.entryId === id),
    'the aged active entry surfaced as a stale-active review finding');
});

test('a valid launch CLEARS a previously-set last_runtime_error', () => {
  const ws = nextWs();
  const { root, detailsDir, memoryMd } = makeWorkspace();
  const id = 'mb-2026-07-28-recover';
  store.putRuntimeError(ws, 'earlier read failed', NOW);
  assert.equal(store.getIndexState(ws)!.lastRuntimeError, 'earlier read failed');

  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);
  const r = inj.computeSupervisorMemoryInjection(ws, root, NOW);
  assert.equal(r.outcome, 'valid');
  assert.equal(store.getIndexState(ws)!.lastRuntimeError, null, 'a valid write retired the runtime error');
});

// ── RUNTIME (read/parse threw) ─────────────────────────────────────────────────
test('a missing MEMORY.md → RUNTIME: nothing injected, error recorded, last-good source intact', () => {
  const ws = nextWs();
  const { root } = makeWorkspace(); // no MEMORY.md written
  // Seed a prior good source so we can prove the runtime path does not clobber it.
  store.putIndexState(ws, { sourceText: 'PRIOR-GOOD', sourceHash: 'H', parsedJson: '{}', validatedAt: NOW });

  const r = inj.computeSupervisorMemoryInjection(ws, root, '2026-07-29T00:00:00Z');
  assert.equal(r.outcome, 'runtime');
  assert.equal(r.injectText, '', 'a runtime failure injects nothing (fail-open)');
  const state = store.getIndexState(ws)!;
  assert.equal(state.sourceText, 'PRIOR-GOOD', 'the last-known-good source survived the runtime failure');
  assert.ok(state.lastRuntimeError && /ENOENT|no such file/i.test(state.lastRuntimeError), 'the runtime error was recorded');
});

// ── HARD-invalid current parse → re-validated fallback, re-projected today ──────
test('HARD-invalid live index → re-validated fallback re-projected TODAY drops a since-expired entry', () => {
  const ws = nextWs();
  const { root, detailsDir, memoryMd } = makeWorkspace();
  const keep = 'mb-2026-07-28-keep';
  const exp = 'mb-2026-07-28-exp';
  // Seed a VALID last-good source at 2026-07-28: both entries active, both with
  // detail files. `exp` expires 2026-08-15.
  writeIndex(memoryMd, idx(
    ACTIVE(keep, { expires: '2027-01-01' }),
    ACTIVE(exp, { expires: '2026-08-15' }),
  ));
  writeDetail(detailsDir, keep);
  writeDetail(detailsDir, exp);
  const seed = inj.computeSupervisorMemoryInjection(ws, root, NOW);
  assert.equal(seed.outcome, 'valid');

  // Now the LIVE index becomes HARD-invalid (marker stripped) — detail files kept
  // so the fallback source still I/O-validates.
  writeIndex(memoryMd, idx(ACTIVE(keep)).replace(`${MARKER}\n\n`, ''));

  // Re-project the fallback at a date AFTER exp's expiry.
  const later = '2026-09-01T00:00:00Z';
  const r = inj.computeSupervisorMemoryInjection(ws, root, later);
  assert.equal(r.outcome, 'fallback');
  assert.ok(r.injectText.startsWith('<!-- ⚠ MEMORY INDEX WARNING'), 'a loud banner is prefixed');
  assert.ok(r.injectText.includes(keep), 'the still-current entry rides the fallback');
  assert.ok(!r.injectText.includes(exp), 'the since-expired entry is dropped by the today re-projection');
});

test('HARD-invalid live index + a since-missing fallback pointer → banner-only', () => {
  const ws = nextWs();
  const { root, detailsDir, memoryMd } = makeWorkspace();
  const id = 'mb-2026-07-28-a';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);
  assert.equal(inj.computeSupervisorMemoryInjection(ws, root, NOW).outcome, 'valid');

  // Live goes HARD-invalid AND the fallback's detail file disappears → the
  // fallback source is now itself I/O-invalid ⇒ never inject unvalidated bytes.
  writeIndex(memoryMd, idx(ACTIVE(id)).replace(`${MARKER}\n\n`, ''));
  fs.rmSync(path.join(detailsDir, `${id}.md`));

  const r = inj.computeSupervisorMemoryInjection(ws, root, '2026-08-01T00:00:00Z');
  assert.equal(r.outcome, 'banner-only');
  assert.equal(r.injectText, inj.BANNER_ONLY, 'no index — banner only');
});

test('HARD-invalid live index with NO prior good source → banner-only', () => {
  const ws = nextWs();
  const { root, memoryMd } = makeWorkspace();
  writeIndex(memoryMd, idx(ACTIVE('mb-2026-07-28-a')).replace(`${MARKER}\n\n`, '')); // no marker → HARD
  const r = inj.computeSupervisorMemoryInjection(ws, root, NOW);
  assert.equal(r.outcome, 'banner-only');
  assert.equal(r.injectText, inj.BANNER_ONLY);
});

test('reconciliation does NOT run or clear against a structurally-invalid current parse', () => {
  const ws = nextWs();
  const { root, detailsDir, memoryMd } = makeWorkspace();
  const id = 'mb-2026-06-01-stale';
  writeIndex(memoryMd, idx(ACTIVE(id, { date: '2026-06-01' })));
  writeDetail(detailsDir, id);
  inj.computeSupervisorMemoryInjection(ws, root, NOW); // seeds a pending stale-active finding
  assert.ok(store.listFindings(ws, 'pending').some((f) => f.kind === 'stale-active'), 'stale-active is pending');

  // Live goes HARD-invalid AND fallback becomes I/O-invalid (detail removed) →
  // banner-only ⇒ no reconcile ⇒ the prior pending finding is NOT cleared.
  writeIndex(memoryMd, idx(ACTIVE(id, { date: '2026-06-01' })).replace(`${MARKER}\n\n`, ''));
  fs.rmSync(path.join(detailsDir, `${id}.md`));
  const r = inj.computeSupervisorMemoryInjection(ws, root, NOW);
  assert.equal(r.outcome, 'banner-only');
  assert.ok(store.listFindings(ws, 'pending').some((f) => f.kind === 'stale-active'),
    'an invalid current parse never clears findings');
});

// ── WP-C gate: autoMemoryEnabled stays false across every live settings blob ────
test('WP-C gate: every live *_CLAUDE_SETTINGS_JSON keeps autoMemoryEnabled === false', () => {
  const blobs: Array<[string, string]> = [
    ['SUPERVISOR_CLAUDE_SETTINGS_JSON', SUPERVISOR_CLAUDE_SETTINGS_JSON],
    ['SUPERVISOR_PERSONA_CLAUDE_SETTINGS_JSON', SUPERVISOR_PERSONA_CLAUDE_SETTINGS_JSON],
    ['WORKER_CLAUDE_SETTINGS_JSON', WORKER_CLAUDE_SETTINGS_JSON],
    ['RESEARCHER_CLAUDE_SETTINGS_JSON', RESEARCHER_CLAUDE_SETTINGS_JSON],
  ];
  for (const [name, blob] of blobs) {
    const parsed = JSON.parse(blob) as { autoMemoryEnabled?: unknown };
    assert.equal(parsed.autoMemoryEnabled, false, `${name} must keep autoMemoryEnabled:false (app-owned injection stays provider-blind)`);
  }
});

// ── Run ────────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-inj-appdata-'));
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
  inj = require('./launch-injection') as InjModule;

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
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nlaunch-injection: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
