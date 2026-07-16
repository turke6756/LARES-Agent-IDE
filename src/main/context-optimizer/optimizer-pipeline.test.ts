// optimizer-pipeline.ts tests — the WP6 production-wiring composition layer.
//
// Pure-composition style over the sql.js better-sqlite3 stand-in (same idiom as
// behavior-store.test.ts / config-epoch-backfill.test.ts): seed the real schema
// directly, then assert the seam queries + the pipeline's ORDER / seam-substitution
// / determinism guarantees. No parse-runner ingest — the seams are DB reads, so we
// seed only the rows each one touches.
//
//   npm run build:main
//   node dist/main/main/context-optimizer/optimizer-pipeline.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js better-sqlite3 stand-in (named + positional) ──
let SQLCtor: { new (): SqlJsDatabase };
interface SqlJsStatement { bind(p: unknown): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; }
interface SqlJsDatabase { run(sql: string, params?: unknown): unknown; prepare(sql: string): SqlJsStatement; getRowsModified(): number; }
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
}
function toBind(args: unknown[]): unknown {
  if (args.length === 1 && isPlainObject(args[0])) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args[0])) o['@' + k] = v === undefined ? null : v;
    return o;
  }
  return args.map((v) => (v === undefined ? null : v));
}
class FakeDb {
  private db: SqlJsDatabase;
  constructor() { this.db = new SQLCtor(); }
  pragma(): void { /* no-op */ }
  exec(sql: string): this { this.db.run(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...args: unknown[]) => { inner.run(sql, toBind(args)); return { changes: inner.getRowsModified() }; },
      get: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); const rows: Record<string, unknown>[] = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    };
  }
  transaction<A extends unknown[]>(fn: (...a: A) => unknown) {
    return (...a: A) => { this.db.run('BEGIN'); try { const r = fn(...a); this.db.run('COMMIT'); return r; } catch (e) { this.db.run('ROLLBACK'); throw e; } };
  }
}

type DbMod = { initDatabase(): void; getDb(): FakeDb };
let dbm: DbMod;
let pipeline: typeof import('./optimizer-pipeline');
let backfillMod: typeof import('./config-epoch-backfill');

// ── raw seeders (only the columns each seam reads; NOT NULL cols satisfied) ──
function db(): FakeDb { return dbm.getDb(); }

function seedStream(streamId: string, lane: string, opts: { slug?: string; isSub?: 0 | 1 } = {}): void {
  db().prepare(
    `INSERT OR REPLACE INTO stream_lane_stats (stream_id, lane, slug, turn_count, is_subagent)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(streamId, lane, opts.slug ?? null, opts.isSub ?? 0);
}

let beSeq = 0;
function seedBehaviorEvent(o: {
  streamId: string; kind: string; tsMs: number;
  toolName?: string; argPath?: string; accessMode?: string; argPathConfidence?: string;
}): string {
  const id = `be-${beSeq++}`;
  db().prepare(
    `INSERT INTO behavior_events (id, stream_id, byte_offset, ts_ms, kind, tool_name, arg_path, access_mode, arg_path_confidence)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, o.streamId, o.tsMs, o.kind, o.toolName ?? null, o.argPath ?? null, o.accessMode ?? null, o.argPathConfidence ?? null);
  return id;
}

function seedEpoch(id: string, o: { sectionKey?: string; firstSeenMs?: number; lastSeenMs?: number | null; contentHash?: string }): void {
  db().prepare(
    `INSERT INTO config_epochs
      (id, section_key, anchor_uid, target_type, target_key, lanes_json, source_kind, source_path,
       content_hash, semantic_fingerprint, first_seen_ms, first_seen_source, first_seen_confidence,
       last_seen_ms, parser_version, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'anc', 'markdown_section', 'tk', '["worker"]', 'ignored_scaffold', '/x.md',
             ?, 'sfp', ?, 'git_section_history', 'high', ?, 1, 0, 0)`,
  ).run(id, o.sectionKey ?? 'sec', o.contentHash ?? 'h', o.firstSeenMs ?? 0, o.lastSeenMs ?? null);
}

function seedSkillInvocation(id: string, streamId: string, skillName: string, tsMs: number): void {
  db().prepare(
    `INSERT INTO skill_invocations (id, stream_id, jsonl_path, ts_ms, skill_name, detector)
     VALUES (?, ?, '/p.jsonl', ?, ?, 'tool_use')`,
  ).run(id, streamId, tsMs, skillName);
}

function seedTriggerSnippet(o: {
  eventId: string; eventType: string; streamId: string;
  snippet: string; snippetHash: string; sourceKind: string; selectionReason: string;
}): void {
  db().prepare(
    `INSERT INTO trigger_snippets (event_id, event_type, stream_id, snippet, snippet_hash, source_kind, selection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.eventId, o.eventType, o.streamId, o.snippet, o.snippetHash, o.sourceKind, o.selectionReason);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #2 — extractConstantTemplate (pure)
// ─────────────────────────────────────────────────────────────────────────────
test('extractConstantTemplate pulls a template-literal constant body, handles escapes, absent → null', () => {
  const src = [
    'export const OTHER = `nope`;',
    'export const SUPERVISOR_AGENT_MD = `# Sup',
    'body with \\` escaped backtick and \\${notInterp}`;',
    'export const AFTER = 1;',
  ].join('\n');
  const body = pipeline.extractConstantTemplate(src, 'SUPERVISOR_AGENT_MD');
  assert.ok(body != null, 'constant found');
  assert.ok(body!.startsWith('# Sup'), 'body starts at the template');
  assert.ok(body!.includes('` escaped backtick'), 'escaped backtick preserved literally');
  assert.ok(body!.includes('${notInterp}'), 'escaped interpolation preserved literally');
  assert.ok(!body!.includes('AFTER'), 'stops at the closing backtick');
  assert.equal(pipeline.extractConstantTemplate(src, 'MISSING_CONST'), null, 'absent constant → null');
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #3 — epoch-bounded, subagent-varying ExposureResolver
// ─────────────────────────────────────────────────────────────────────────────
test('makeEpochBoundedExposureResolver bounds by epoch window and filters subagents', () => {
  seedStream('w-top', 'worker', { slug: 'projA', isSub: 0 });
  seedStream('w-sub', 'worker', { slug: 'projA', isSub: 1 });
  // Epoch window [100, 300].
  seedEpoch('ep-bound', { firstSeenMs: 100, lastSeenMs: 300 });
  // turn_outcome events: two top-level inside window, one top-level BEFORE (excluded),
  // one subagent inside window.
  seedBehaviorEvent({ streamId: 'w-top', kind: 'turn_outcome', tsMs: 150 });
  seedBehaviorEvent({ streamId: 'w-top', kind: 'turn_outcome', tsMs: 250 });
  seedBehaviorEvent({ streamId: 'w-top', kind: 'turn_outcome', tsMs: 50 }); // before window
  seedBehaviorEvent({ streamId: 'w-sub', kind: 'turn_outcome', tsMs: 200 });

  const resolver = pipeline.makeEpochBoundedExposureResolver(db() as never);
  const paBound = { lanes: ['worker'], sourceEpochId: 'ep-bound' } as never;

  const excl = resolver.resolve(paBound, { includeSubagents: false });
  assert.equal(excl.exposureTurns, 2, 'only the 2 in-window top-level turns count');
  assert.equal(excl.distinctStreams, 1, 'only the top-level stream');

  const incl = resolver.resolve(paBound, { includeSubagents: true });
  assert.equal(incl.exposureTurns, 3, 'in-window subagent turn included when policy allows');
  assert.equal(incl.distinctStreams, 2, 'both streams');

  // Unresolved epoch id → unbounded (still subagent-filtered): all top-level turns.
  const paUnbounded = { lanes: ['worker'], sourceEpochId: '' } as never;
  const unb = resolver.resolve(paUnbounded, { includeSubagents: false });
  assert.equal(unb.exposureTurns, 3, 'all 3 top-level turn_outcome events (no epoch bound)');
});

test('makeEpochBoundedExposureResolver treats an OPEN epoch (last_seen NULL) as no upper bound', () => {
  seedStream('w-open', 'worker');
  seedEpoch('ep-open', { firstSeenMs: 1000, lastSeenMs: null });
  seedBehaviorEvent({ streamId: 'w-open', kind: 'turn_outcome', tsMs: 999 });   // before lo
  seedBehaviorEvent({ streamId: 'w-open', kind: 'turn_outcome', tsMs: 5000 });  // after lo, open top
  const resolver = pipeline.makeEpochBoundedExposureResolver(db() as never);
  const r = resolver.resolve({ lanes: ['worker'], sourceEpochId: 'ep-open' } as never, { includeSubagents: false });
  // 5000 counts; 999 excluded (before lo); plus the two in-window from the prior test's
  // 'w-top' stream would NOT count — different lane rows are the same lane 'worker'.
  assert.ok(r.exposureTurns >= 1, 'at-or-after lo turns count');
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #5 — phrase-gap corpus query, keyed by the bypass scriptPath
// ─────────────────────────────────────────────────────────────────────────────
test('queryPhraseGapInputsForBypass splits invocation vs bypass corpora and excludes brief relays', () => {
  seedStream('s-inv', 'worker');
  seedStream('s-byp', 'worker');
  // Invocation corpus: a matched user_message snippet on a skill_invocation.
  seedSkillInvocation('si-1', 's-inv', 'read-comments', 10);
  seedTriggerSnippet({ eventId: 'si-1', eventType: 'skill_invocation', streamId: 's-inv',
    snippet: 'please read the comments', snippetHash: 'inv-h', sourceKind: 'user_message', selectionReason: 'matched' });
  // A brief relay on the same skill — must be EXCLUDED (source_kind not qualifying).
  seedSkillInvocation('si-2', 's-inv', 'read-comments', 11);
  seedTriggerSnippet({ eventId: 'si-2', eventType: 'skill_invocation', streamId: 's-inv',
    snippet: 'supervisor said read comments', snippetHash: 'brief-h', sourceKind: 'supervisor_brief', selectionReason: 'matched' });
  // Bypass corpus: an executed_file behavior_event on the script, matched command_args.
  const beId = seedBehaviorEvent({ streamId: 's-byp', kind: 'file_touch', tsMs: 20,
    argPath: 'C:/proj/.claude/skills/read-comments/read-comments.py', accessMode: 'executed', argPathConfidence: 'exact' });
  seedTriggerSnippet({ eventId: beId, eventType: 'executed_file', streamId: 's-byp',
    snippet: 'python read-comments.py doc.md', snippetHash: 'byp-h', sourceKind: 'command_args', selectionReason: 'matched' });

  const proposal = {
    kind: 'tune-skill-trigger', skillName: 'read-comments', lane: 'worker',
    scriptPath: 'C:/proj/.claude/skills/read-comments/read-comments.py',
    matchConfidence: 'exact', execCount: 1, execStreams: 1, skillStreams: 1,
    citedStreams: ['s-byp'], disclosedSubagentExecs: 0, triggerMutability: 'user-owned',
    requiresDerivationGate: false,
  } as never;

  const inputs = pipeline.queryPhraseGapInputsForBypass(db() as never, [proposal]);
  assert.equal(inputs.length, 1, 'one unit per proposal');
  const u = inputs[0];
  assert.equal(u.scriptPath, 'C:/proj/.claude/skills/read-comments/read-comments.py', 'keyed by the proposal scriptPath VERBATIM');
  assert.equal(u.invocation.length, 1, 'only the qualifying invocation snippet');
  assert.equal(u.invocation[0].snippetHash, 'inv-h');
  assert.equal(u.bypass.length, 1, 'the executed-file bypass snippet');
  assert.equal(u.bypass[0].snippetHash, 'byp-h');
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #7 — fingerprint producers
// ─────────────────────────────────────────────────────────────────────────────
test('structuralCorpusFingerprint is STRUCTURAL (order-insensitive) and excludes counts', () => {
  const a = pipeline.structuralCorpusFingerprint({ laneSet: ['worker', 'supervisor'], rootSet: ['r1'], inclusionFilters: ['f1', 'f2'] });
  const b = pipeline.structuralCorpusFingerprint({ laneSet: ['supervisor', 'worker'], rootSet: ['r1'], inclusionFilters: ['f2', 'f1'] });
  assert.equal(a, b, 'same sets in any order → identical fingerprint');
  const c = pipeline.structuralCorpusFingerprint({ laneSet: ['worker'], rootSet: ['r1'], inclusionFilters: ['f1', 'f2'] });
  assert.notEqual(a, c, 'a different lane set flips the fingerprint');
});

test('configFingerprint reflects open-epoch content hashes and flips on a content edit', () => {
  seedEpoch('cfg-1', { sectionKey: 'sec-A', contentHash: 'hashA', lastSeenMs: null });
  const before = pipeline.configFingerprint(db() as never);
  seedEpoch('cfg-2', { sectionKey: 'sec-B', contentHash: 'hashB', lastSeenMs: null });
  const after = pipeline.configFingerprint(db() as never);
  assert.notEqual(before, after, 'adding an open epoch changes the config fingerprint');
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM #1/#4 — pipeline ORDER (backfill before classify), seam substitution, determinism
// ─────────────────────────────────────────────────────────────────────────────
function minimalLane() {
  const action = {
    id: 'a1', source: { absPath: 'C:/proj/CLAUDE.md', line: 3 }, sourceKind: 'tool',
    lanes: ['worker'], kind: 'tool-invocation', params: { toolName: 'Grep' },
    derivability: 'exact', residentTokens: 100, sourceSectionKey: 'sec-1',
    sourceEpochId: 'ep-1', requiresDerivationGate: true,
  };
  return {
    lane: 'worker',
    resident: { residentTokens: 100, claude: 100, mcp: 0, skillHeaders: 0, exposureTurns: 10, exposureStreams: 2, exposureSlugs: 1 },
    actions: [action],
    clusters: [],
    bypass: { proposals: [], watchItems: [] },
    drift: [],
    derivation: { lane: 'worker', verified: false, state: 'unverified-no-reference', staleReasons: [] },
  } as never;
}

test('runOptimizerPipeline runs the epoch backfill BEFORE the classifier pass (seam #1)', () => {
  let backfilledWhenCounted: boolean | null = null;
  const spyCounter = {
    count: () => {
      backfilledWhenCounted = backfillMod.isEpochsBackfilled(db() as never);
      return { occurrences: 0, distinctStreams: 0, distinctSlugs: 0, lastTsMs: null };
    },
  };
  let exposureCalls = 0;
  const spyExposure = {
    resolve: () => { exposureCalls++; return { exposureTurns: 50, distinctStreams: 5, distinctSlugs: 3 }; },
  };

  const outcome = pipeline.runOptimizerPipeline({
    db: db() as never,
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    nowMs: 1_000_000,
    backfillTargets: [],
    birthdayResolver: { resolve: () => ({ firstSeenMs: 0, source: 'none', confidence: 'low' }) } as never,
    lanes: [minimalLane()],
    exposureResolver: spyExposure as never,
    occurrenceCounter: spyCounter as never,
  });

  assert.equal(outcome.backfill.ran, true, 'the one-shot backfill ran on first pass');
  assert.equal(backfilledWhenCounted, true, 'the backfill marker was already set when the classifier queried occurrences');
  assert.ok(exposureCalls > 0, 'the injected (substituted) exposure resolver was used');
});

test('runOptimizerPipeline is deterministic (same seed → byte-identical result)', () => {
  const spyCounter = { count: () => ({ occurrences: 0, distinctStreams: 0, distinctSlugs: 0, lastTsMs: null }) };
  const spyExposure = { resolve: () => ({ exposureTurns: 50, distinctStreams: 5, distinctSlugs: 3 }) };
  const mk = () => pipeline.runOptimizerPipeline({
    db: db() as never,
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    nowMs: 1_000_000,
    backfillTargets: [],
    birthdayResolver: { resolve: () => ({ firstSeenMs: 0, source: 'none', confidence: 'low' }) } as never,
    lanes: [minimalLane()],
    exposureResolver: spyExposure as never,
    occurrenceCounter: spyCounter as never,
  });
  const r1 = mk();
  const r2 = mk();
  assert.equal(JSON.stringify(r1.result), JSON.stringify(r2.result), 'result is byte-identical across runs');
});

// ── runner ──
async function main(): Promise<void> {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-pipeline-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  dbm.initDatabase();
  pipeline = require('./optimizer-pipeline');
  backfillMod = require('./config-epoch-backfill');

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
void main();
