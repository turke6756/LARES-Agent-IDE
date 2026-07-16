// optimizer-surface unit tests (WP6 human surface — analyze runner + the two
// human-gated writers). Pure — system-Node runner over a sql.js better-sqlite3
// stand-in (mirrors config-epoch-backfill.test.ts):
//   npm run build:main
//   node dist/main/main/context-optimizer/optimizer-surface.test.js
//
// Coverage: the honest EMPTY analyze result (no lanes wired); Mark-applied inserts an
// intent row with an immutable target_json + predicate hash and the §4.6
// unverified_at_apply stamp; the G2 sign-off inserts a `verified` derivation row and
// upserts on re-sign. NEITHER writer touches a config file (nothing to assert there —
// the surface has no fs path at all).

import assert from 'node:assert/strict';
import type {
  MarkOptimizerActionAppliedRequest,
  SignOptimizerDerivationRequest,
} from '../../shared/types';
import {
  runOptimizerAnalyze,
  markOptimizerActionApplied,
  signOptimizerDerivation,
  type OptimizerWriterDb,
} from './optimizer-surface';

// ── sql.js better-sqlite3 stand-in (mirrors config-epoch-backfill.test.ts) ──────
interface SqlJsStatement { bind(p: unknown): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; }
interface SqlJsDatabase { run(sql: string, params?: unknown): unknown; prepare(sql: string): SqlJsStatement; getRowsModified(): number; }
let SQLCtor: { new (): SqlJsDatabase };
function toBind(args: unknown[]): unknown {
  return args.map((v) => (v === undefined ? null : v));
}
class FakeDb {
  private db: SqlJsDatabase;
  constructor() { this.db = new SQLCtor(); }
  exec(sql: string): this { this.db.run(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...args: unknown[]) => { inner.run(sql, toBind(args)); return { changes: inner.getRowsModified() }; },
      get: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); const rows: Record<string, unknown>[] = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    };
  }
}

// The two tables the writers touch (verbatim from database.ts DDL).
const DDL = `
  CREATE TABLE IF NOT EXISTS optimizer_actions (
    id TEXT PRIMARY KEY, proposal_id TEXT, kind TEXT NOT NULL, lane TEXT,
    target_json TEXT NOT NULL, target_predicate_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'marked_applied', applied_at_ms INTEGER NOT NULL,
    detected_at_ms INTEGER, after_start_ms INTEGER, reverted_at_ms INTEGER, note TEXT,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS optimizer_derivation_verifications (
    gate_name TEXT PRIMARY KEY, lane TEXT NOT NULL, status TEXT NOT NULL,
    parser_version INTEGER NOT NULL, compiler_version INTEGER NOT NULL,
    corpus_fingerprint TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
    toolset_inventory_fingerprint TEXT NOT NULL, empirical_report_fingerprint TEXT NOT NULL,
    signed_histogram_json TEXT NOT NULL, signed_split_json TEXT NOT NULL,
    artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL,
    signed_off_by TEXT, signed_off_at_ms INTEGER, notes TEXT);
`;

function newDb(): FakeDb & OptimizerWriterDb {
  const db = new FakeDb();
  db.exec(DDL);
  return db as unknown as FakeDb & OptimizerWriterDb;
}

const T0 = 1_700_000_000_000;

function markReq(over: Partial<MarkOptimizerActionAppliedRequest> = {}): MarkOptimizerActionAppliedRequest {
  return {
    proposalId: 'p-1',
    kind: 'subtract-dead-guidance',
    lane: 'supervisor',
    target: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', lineStart: 40, lineEnd: 60,
              lane: 'supervisor', mutable: 'scaffold-managed' },
    proposedEdit: { summary: 'Remove dead section' },
    watchLanes: ['supervisor'],
    includeSubagents: false,
    unverifiedAtApply: false,
    ...over,
  };
}

function signReq(over: Partial<SignOptimizerDerivationRequest> = {}): SignOptimizerDerivationRequest {
  return {
    gateName: 'supervisor-compiler-parity',
    lane: 'supervisor',
    parserVersion: 3,
    compilerVersion: 2,
    corpusFingerprint: 'corpus-a',
    configFingerprint: 'config-a',
    toolsetInventoryFingerprint: 'tools-a',
    empiricalReportFingerprint: 'emp-a',
    signedHistogramJson: '{"supervisor":10}',
    signedSplitJson: '{"occurs":5,"never":2,"insufficient":1,"unobservable":0}',
    artifactPath: 'plans/optimizer-parity/supervisor-parity.json',
    artifactSha256: 'sha-a',
    signedOffBy: 'edward',
    notes: 'looks right',
    ...over,
  };
}

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// ── analyze ────────────────────────────────────────────────────────────────────

test('analyze with no lanes → honest empty result (no crash, no fabricated proposals)', () => {
  const res = runOptimizerAnalyze({ generatedAtIso: '2026-07-06T00:00:00.000Z', nowMs: T0 });
  assert.equal(res.proposals.length, 0);
  assert.equal(res.fileHeat.length, 0);
  assert.equal(res.modelStats.behaviorEvents, 0);
  assert.equal(res.generatedAtIso, '2026-07-06T00:00:00.000Z');
  assert.ok(Array.isArray(res.meta.tierGroups));
});

// ── mark applied ─────────────────────────────────────────────────────────────--

test('markApplied inserts one marked_applied intent row with immutable target_json', () => {
  const db = newDb();
  const out = markOptimizerActionApplied(db, markReq(), T0);
  assert.ok(out.actionId.startsWith('oa_'));
  assert.ok(out.targetPredicateHash.length > 0);

  const row = db.prepare('SELECT * FROM optimizer_actions WHERE id = ?').get(out.actionId) as Record<string, unknown>;
  assert.equal(row.status, 'marked_applied');
  assert.equal(row.kind, 'subtract-dead-guidance');
  assert.equal(row.lane, 'supervisor');
  assert.equal(row.proposal_id, 'p-1');
  assert.equal(row.applied_at_ms, T0);
  assert.equal(row.target_predicate_hash, out.targetPredicateHash);
  assert.equal(row.note, null); // verified → no unverified stamp

  const target = JSON.parse(String(row.target_json));
  assert.equal(target.schemaVersion, 1);
  assert.equal(target.actionKind, 'subtract-dead-guidance');
  assert.equal(target.watch.predicateKind, 'predicted_action'); // no cluster/skill evidence
  assert.equal(target.watch.includeSubagents, false);
});

test('markApplied stamps [unverified_at_apply] into the note for candidate-unverified', () => {
  const db = newDb();
  const out = markOptimizerActionApplied(db, markReq({ unverifiedAtApply: true, note: 'edward note' }), T0);
  const row = db.prepare('SELECT note FROM optimizer_actions WHERE id = ?').get(out.actionId) as Record<string, unknown>;
  assert.ok(String(row.note).startsWith('[unverified_at_apply]'));
  assert.ok(String(row.note).includes('edward note'));
});

test('markApplied toolset subtract pins includeSubagents=true in the snapshot (Bug-4)', () => {
  const db = newDb();
  const out = markOptimizerActionApplied(
    db,
    markReq({ kind: 'subtract-unused-toolset', includeSubagents: true }),
    T0,
  );
  const row = db.prepare('SELECT target_json FROM optimizer_actions WHERE id = ?').get(out.actionId) as Record<string, unknown>;
  const target = JSON.parse(String(row.target_json));
  assert.equal(target.watch.includeSubagents, true);
  assert.equal(target.watch.predicateKind, 'toolset_grant');
});

// ── sign derivation (G2) ────────────────────────────────────────────────────────

test('signDerivation inserts a verified row with signed_off_at_ms stamped', () => {
  const db = newDb();
  const out = signOptimizerDerivation(db, signReq(), T0);
  assert.equal(out.gateName, 'supervisor-compiler-parity');
  const row = db.prepare('SELECT * FROM optimizer_derivation_verifications WHERE gate_name = ?')
    .get('supervisor-compiler-parity') as Record<string, unknown>;
  assert.equal(row.status, 'verified');
  assert.equal(row.lane, 'supervisor');
  assert.equal(row.parser_version, 3);
  assert.equal(row.corpus_fingerprint, 'corpus-a');
  assert.equal(row.signed_off_by, 'edward');
  assert.equal(row.signed_off_at_ms, T0);
});

test('signDerivation upserts on re-sign (INSERT OR REPLACE), never a second row', () => {
  const db = newDb();
  signOptimizerDerivation(db, signReq(), T0);
  signOptimizerDerivation(db, signReq({ corpusFingerprint: 'corpus-b', notes: 're-signed' }), T0 + 1000);
  const rows = db.prepare('SELECT corpus_fingerprint, signed_off_at_ms, notes FROM optimizer_derivation_verifications WHERE gate_name = ?')
    .all('supervisor-compiler-parity') as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].corpus_fingerprint, 'corpus-b');
  assert.equal(rows[0].signed_off_at_ms, T0 + 1000);
  assert.equal(rows[0].notes, 're-signed');
});

// ── runner ──────────────────────────────────────────────────────────────────────
(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
    catch (e) { failed++; console.error(`  ✗ ${t.name}\n    ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`\noptimizer-surface: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
