// parse-manager.ts + A6 backfill tests (wp2b §7, tests 22-27).
//
// Same sql.js (wasm SQLite) stand-in as parse-runner.test.ts — better-sqlite3's native
// binding won't load under the system Node that `npm run test:supervisor` uses, so we
// inject a FakeDb into require.cache BEFORE requiring ../database.
//
//   npm run build:main
//   node dist/main/main/skill-analytics/parse-backfill.test.js
//
// Test 22 (timed full backfill over the REAL ~/.claude/projects) is heavy and
// environment-dependent, so it self-gates behind RUN_CORPUS_BACKFILL=1 and otherwise
// logs "skipped". The fake-driven tests 23-27 are the always-on acceptance bar.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (named + positional params) ──────────
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
      get: (...args: unknown[]) => {
        const s = inner.prepare(sql);
        try { s.bind(toBind(args)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); }
      },
      all: (...args: unknown[]) => {
        const s = inner.prepare(sql);
        try {
          s.bind(toBind(args));
          const rows: Record<string, unknown>[] = [];
          while (s.step()) rows.push(s.getAsObject());
          return rows;
        } finally { s.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...a: A) => unknown) {
    return (...a: A) => {
      this.db.run('BEGIN');
      try { const r = fn(...a); this.db.run('COMMIT'); return r; }
      catch (e) { this.db.run('ROLLBACK'); throw e; }
    };
  }
}

// ── module handles (populated after cache injection) ──────────────────────────
type DbMod = { initDatabase(): void; getDb(): FakeDb };
let dbm: DbMod;
let mgr: typeof import('./parse-manager');
let scanner: typeof import('./jsonl-scanner');

// ── entry + file builders (mirror parse-runner.test.ts) ───────────────────────
const TS = '2026-07-06T00:00:00.000Z';
type Entry = Record<string, unknown>;
const WORKER_CWD = 'C:/proj/.dashboard/workers/claude';
const SUP_CWD = 'C:/proj/.dashboard/supervisor';

function userMsg(uuid: string, text: unknown, cwd?: string): Entry {
  return { type: 'user', uuid, timestamp: TS, cwd, message: { role: 'user', content: text } };
}
function assistantSkill(uuid: string, skill: string, opts: { stop?: string; usage?: unknown; cwd?: string }): Entry {
  return {
    type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd,
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: opts.stop ?? 'tool_use', usage: opts.usage,
      content: [{ type: 'tool_use', name: 'Skill', id: `${uuid}-tu`, input: { skill, args: null } }] },
  };
}
function assistantEnd(uuid: string, text: string, opts: { usage?: unknown; cwd?: string } = {}): Entry {
  return {
    type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd,
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: opts.usage,
      content: [{ type: 'text', text }] },
  };
}
function vfile(entries: Entry[]): Buffer {
  return Buffer.from(entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}
function metaFor(p: string, over: Partial<import('./jsonl-scanner').StreamMeta> = {}): import('./jsonl-scanner').StreamMeta {
  return {
    streamId: scanner.normalizeStreamId(p), jsonlPath: p, slug: 'proj', sessionId: 'sess1',
    subAgentName: null, parentSessionId: null, isSubagent: false, ...over,
  };
}

/** A small, well-formed worker stream: one skill window that opens, does a turn, closes. */
function streamContent(seed: string): Buffer {
  return vfile([
    userMsg(`${seed}-u1`, `Implement work item ${seed} and land tests`, WORKER_CWD),
    assistantSkill(`${seed}-a1`, 'verify', { stop: 'tool_use', cwd: WORKER_CWD, usage: { input_tokens: 12, cache_creation_input_tokens: 4, cache_read_input_tokens: 300, output_tokens: 9 } }),
    assistantEnd(`${seed}-a2`, `done ${seed}`, { usage: { input_tokens: 3, output_tokens: 6 } }),
  ]);
}

/** Build an N-file synthetic corpus under a path prefix; returns (files, streams). */
function buildCorpus(prefix: string, n: number): { files: Map<string, Buffer>; streams: import('./jsonl-scanner').StreamMeta[] } {
  const files = new Map<string, Buffer>();
  const streams: import('./jsonl-scanner').StreamMeta[] = [];
  for (let i = 0; i < n; i++) {
    const p = `C:/home/.claude/projects/proj/${prefix}-${i}.jsonl`;
    files.set(p, streamContent(`${prefix}${i}`));
    streams.push(metaFor(p, { sessionId: `${prefix}-${i}` }));
  }
  return { files, streams };
}

function makeReader(files: Map<string, Buffer>) {
  return (p: string, off: number) => {
    const buf = files.get(p) ?? Buffer.alloc(0);
    const size = buf.length;
    const first = size ? scanner.splitCompleteLines(buf, 0).lines[0]?.text ?? '' : '';
    const firstFingerprint = scanner.computeFingerprint(first);
    if (off >= size) return { lines: [], nextOffset: off > size ? size : off, sizeBytes: size, firstFingerprint };
    const { lines, nextOffset } = scanner.splitCompleteLines(buf.subarray(off), off);
    return { lines, nextOffset, sizeBytes: size, firstFingerprint };
  };
}

interface Harness {
  deps: import('./parse-manager').ManagerDeps;
  clock: { t: number };
  progress: import('./parse-runner').IndexProgress[];
  sizes: Map<string, number>; // statSize overrides (default = buffer length)
}
function harness(
  files: Map<string, Buffer>,
  streams: import('./jsonl-scanner').StreamMeta[],
  over: Partial<import('./parse-manager').ManagerDeps> = {},
): Harness {
  const clock = { t: Date.parse(TS) + 1_000_000 }; // far past historical TS → stale-finalize fires
  const progress: import('./parse-runner').IndexProgress[] = [];
  const sizes = new Map<string, number>();
  const deps: import('./parse-manager').ManagerDeps = {
    db: dbm.getDb() as unknown as import('./parse-runner').ParseDb,
    listStreams: () => streams,
    readNewLines: makeReader(files),
    statSize: (p) => sizes.get(p) ?? (files.get(p)?.length ?? 0),
    knownSkills: new Set(['verify', 'deep-research']),
    resolveMcpToolset: () => null,
    onProgress: (pr) => { progress.push(pr); },
    nowMs: () => clock.t,
    scheduleYield: (fn) => fn(), // synchronous drive by default
    ...over,
  };
  return { deps, clock, progress, sizes };
}

function count(sql: string, ...params: unknown[]): number {
  const row = dbm.getDb().prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row ? Number(row.c ?? Object.values(row)[0] ?? 0) : 0;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('23: first-run ensureIndexed returns {indexing} immediately; NO main-thread full parse', async () => {
  const { files, streams } = buildCorpus('t23', 5);
  // Real setImmediate so the async loop truly defers past the synchronous return.
  const h = harness(files, streams, { scheduleYield: (fn) => { setImmediate(fn); } });
  const m = new mgr.ParseManager(h.deps);

  const st = m.ensureIndexed();
  assert.equal(st.ready, false);
  assert.equal((st as { status: string }).status, 'indexing');
  assert.ok((st as { progress: unknown }).progress, 'carries a progress payload');
  // Synchronous prefix set totals but ran ZERO batches: no parsed rows yet.
  assert.equal(count(`SELECT COUNT(*) c FROM skill_invocations`), 0, 'no skill rows parsed synchronously');
  assert.equal(m.isBackfillComplete(), false);

  await m.whenBackfillDone();
  assert.equal(m.isBackfillComplete(), true, 'marker set after the async pass');
  assert.equal(count(`SELECT COUNT(*) c FROM skill_invocations`), 5, 'all 5 windows parsed');
});

test('24: progress increases monotonically and ends at filesTotal', async () => {
  const { files, streams } = buildCorpus('t24', 60); // >2 batches (BATCH_FILES=25)
  const h = harness(files, streams);
  const m = new mgr.ParseManager(h.deps);
  m.startBackfill();
  await m.whenBackfillDone();

  assert.ok(h.progress.length >= 3, 'multiple progress emissions across batches');
  let lastFiles = -1;
  let lastBytes = -1;
  for (const p of h.progress) {
    assert.ok(p.filesDone >= lastFiles, `filesDone monotonic (${p.filesDone} >= ${lastFiles})`);
    assert.ok(p.bytesDone >= lastBytes, `bytesDone monotonic (${p.bytesDone} >= ${lastBytes})`);
    assert.equal(p.filesTotal, 60);
    lastFiles = p.filesDone;
    lastBytes = p.bytesDone;
  }
  const final = h.progress[h.progress.length - 1];
  assert.equal(final.filesDone, 60, 'ends at filesTotal');
});

test('25: kill mid-backfill → resume from cursors → identical counts, zero dupes (§5.3)', async () => {
  // Baseline: an uninterrupted full backfill of 30 identical-content files.
  const base = buildCorpus('t25base', 30);
  const hb = harness(base.files, base.streams);
  const mb = new mgr.ParseManager(hb.deps);
  mb.startBackfill();
  await mb.whenBackfillDone();
  const baseInv = count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t25base-%');
  const baseUsage = count(`SELECT COUNT(*) c FROM turn_usage WHERE stream_id LIKE ?`, '%t25base-%');
  const baseBe = count(`SELECT COUNT(*) c FROM behavior_events WHERE stream_id LIKE ?`, '%t25base-%');
  assert.equal(baseInv, 30);

  // The completion marker is a single GLOBAL key (one real corpus → one marker); the
  // baseline set it. Wipe it to simulate a fresh first-run for the interrupted scenario.
  dbm.getDb().prepare(`DELETE FROM skill_analytics_meta`).run();

  // Interrupted: same content, distinct paths. Kill by throwing on the 2nd yield (before batch 2).
  const kill = buildCorpus('t25kill', 30);
  let yields = 0;
  const hk = harness(kill.files, kill.streams, {
    scheduleYield: (fn) => { yields += 1; if (yields === 2) throw new Error('killed'); fn(); },
  });
  const mk = new mgr.ParseManager(hk.deps);
  mk.startBackfill();
  await mk.whenBackfillDone(); // rejection is swallowed inside startBackfill
  assert.equal(mk.isBackfillComplete(), false, 'partial run did NOT set the completion marker');
  const afterKill = count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t25kill-%');
  assert.ok(afterKill > 0 && afterKill < 30, `partial progress committed (${afterKill}/30 via per-file atomicity)`);

  // Resume with a fresh manager over the same DB + files.
  const hk2 = harness(kill.files, kill.streams);
  const mk2 = new mgr.ParseManager(hk2.deps);
  mk2.startBackfill();
  await mk2.whenBackfillDone();
  assert.equal(mk2.isBackfillComplete(), true);
  assert.equal(count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t25kill-%'), baseInv, 'resumed inv count == uninterrupted');
  assert.equal(count(`SELECT COUNT(*) c FROM turn_usage WHERE stream_id LIKE ?`, '%t25kill-%'), baseUsage, 'resumed usage count == uninterrupted');
  assert.equal(count(`SELECT COUNT(*) c FROM behavior_events WHERE stream_id LIKE ?`, '%t25kill-%'), baseBe, 'resumed behavior count == uninterrupted');

  // Idempotency: a third run adds ZERO rows and drifts ZERO counters.
  const hk3 = harness(kill.files, kill.streams);
  const mk3 = new mgr.ParseManager(hk3.deps);
  mk3.startBackfill();
  await mk3.whenBackfillDone();
  assert.equal(count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t25kill-%'), baseInv, 're-run adds zero invocation rows');
  assert.equal(count(`SELECT COUNT(*) c FROM turn_usage WHERE stream_id LIKE ?`, '%t25kill-%'), baseUsage, 're-run adds zero usage rows');
});

test('26: large tail → stale offload; small tail → sync parse; repeat within debounce short-circuits', async () => {
  const { files, streams } = buildCorpus('t26', 4);
  const h = harness(files, streams);
  const m = new mgr.ParseManager(h.deps);
  m.startBackfill();
  await m.whenBackfillDone();
  assert.equal(m.isBackfillComplete(), true);

  // Small tail: append a new complete window to one file; advance past debounce → sync parse.
  const p0 = streams[0].jsonlPath;
  const grown = Buffer.concat([files.get(p0)!, vfile([
    userMsg('t26-tail-u', 'follow up', WORKER_CWD),
    assistantSkill('t26-tail-a', 'verify', { stop: 'end_turn', cwd: WORKER_CWD, usage: { input_tokens: 2, output_tokens: 2 } }),
  ])]);
  files.set(p0, grown);
  h.clock.t += mgr.PARSE_DEBOUNCE_MS + 1;
  const invBefore = count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t26-%');
  const st1 = m.ensureIndexed();
  assert.equal(st1.ready, true);
  assert.ok(!(st1 as { stale?: boolean }).stale, 'small tail is not a stale offload');
  const invAfter = count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t26-%');
  assert.equal(invAfter, invBefore + 1, 'small tail parsed synchronously on main');

  // Debounce: append another tail but DO NOT advance the clock → repeat query short-circuits.
  files.set(p0, Buffer.concat([grown, vfile([
    userMsg('t26-tail2-u', 'again', WORKER_CWD),
    assistantSkill('t26-tail2-a', 'verify', { stop: 'end_turn', cwd: WORKER_CWD, usage: { input_tokens: 1, output_tokens: 1 } }),
  ])]));
  const st2 = m.ensureIndexed();
  assert.equal(st2.ready, true);
  assert.equal(count(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id LIKE ?`, '%t26-%'), invAfter, 'debounced: tail NOT parsed within PARSE_DEBOUNCE_MS');

  // Large tail: report a >1MB unparsed tail via statSize → offload, return stale:true.
  h.clock.t += mgr.PARSE_DEBOUNCE_MS + 1;
  h.sizes.set(p0, (files.get(p0)?.length ?? 0) + mgr.STEADY_PARSE_MAX_NEW_BYTES + 1);
  const st3 = m.ensureIndexed();
  assert.equal(st3.ready, true);
  assert.equal((st3 as { stale?: boolean }).stale, true, 'large tail flagged stale');
  assert.equal((st3 as { status?: string }).status, 'indexing', 'large tail offloaded to the chunked driver');
  await m.whenBackfillDone();
});

test('27: one parser_version + one backfill marker across the whole landing (Fix-5)', async () => {
  const { files, streams } = buildCorpus('t27', 6);
  const h = harness(files, streams);
  const m = new mgr.ParseManager(h.deps);
  m.startBackfill();
  await m.whenBackfillDone();

  const meta = dbm.getDb().prepare(`SELECT k, v FROM skill_analytics_meta`).all() as Record<string, unknown>[];
  const byKey = new Map(meta.map((r) => [String(r.k), String(r.v)]));
  assert.ok(byKey.has(mgr.BACKFILL_COMPLETE_KEY), 'completion marker present');
  assert.equal(Number(byKey.get(mgr.BACKFILL_VERSION_KEY)), 1, 'marker recorded at parser_version 1');
  // Every cursor for this corpus carries the single parser_version.
  const versions = dbm.getDb().prepare(
    `SELECT DISTINCT parser_version v FROM skill_parse_cursors WHERE jsonl_path LIKE ?`,
  ).all('%t27-%') as Record<string, unknown>[];
  assert.equal(versions.length, 1, 'exactly one parser_version across the corpus');
  assert.equal(Number(versions[0].v), 1);
});

test('22: TIMED full backfill over the REAL ~/.claude/projects (gated: RUN_CORPUS_BACKFILL=1)', async () => {
  if (process.env.RUN_CORPUS_BACKFILL !== '1') {
    console.log('       (skipped — set RUN_CORPUS_BACKFILL=1 to run the real-corpus acceptance)');
    return;
  }
  // This suite shares ONE singleton DB across all tests; the synthetic corpora from
  // tests 23-27 already wrote rows. Wipe every skill-analytics table (INCLUDING cursors
  // + meta, else the fresh backfill would think it is already done) so the measurement
  // reflects the REAL corpus ONLY.
  for (const tbl of ['skill_invocations', 'behavior_events', 'turn_usage', 'search_events',
    'trigger_snippets', 'skill_window_events', 'stream_lane_stats', 'skill_parse_cursors',
    'skill_analytics_meta']) {
    dbm.getDb().prepare(`DELETE FROM ${tbl}`).run();
  }

  const scanMod = scanner;
  const dirs = scanMod.resolveProjectsDirs();
  const streams = dirs.flatMap((d) => scanMod.listJsonlStreams(d));
  console.log(`       corpus: ${streams.length} streams across ${dirs.length} projects dir(s)`);
  assert.ok(streams.length > 0, 'found real streams');

  // The REAL tool_name→toolset resolver (design §4.3, same defs P1 sizes with) so
  // behavior_events.mcp_toolset populates and the flagship histogram below is real.
  // Lazy-required here so the default (skipped) path never loads the ipc-deps graph.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildMcpToolsetReverseMap } = require('./mcp-toolset-map');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makeToolsetDefsProvider } = require('../context-overhead/ipc-deps');
  const toolsetResolver = buildMcpToolsetReverseMap(makeToolsetDefsProvider());
  const resolveMcpToolset = (n: string): string | null => toolsetResolver.resolve(n);

  let maxChunkMs = 0;
  const h = harness(new Map(), streams, {
    listStreams: () => streams,
    readNewLines: scanMod.readNewLines,
    statSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    resolveMcpToolset,
    nowMs: () => Date.now(),
    scheduleYield: (fn) => { setImmediate(fn); },
    onProgress: () => { /* silent — measured below */ },
  });
  const m = new mgr.ParseManager(h.deps);

  const t0 = Date.now();
  // Drive chunk-by-chunk to measure max stall between yields.
  let tPrev = Date.now();
  const origYield = h.deps.scheduleYield!;
  h.deps.scheduleYield = (fn) => { const dt = Date.now() - tPrev; if (dt > maxChunkMs) maxChunkMs = dt; tPrev = Date.now(); origYield(fn); };
  m.startBackfill();
  await m.whenBackfillDone();
  const totalMs = Date.now() - t0;

  const invs = count(`SELECT COUNT(*) c FROM skill_invocations`);
  const be = count(`SELECT COUNT(*) c FROM behavior_events`);
  const tu = count(`SELECT COUNT(*) c FROM turn_usage`);
  const streamsWithRows = count(`SELECT COUNT(DISTINCT stream_id) c FROM turn_usage`);
  console.log(`       TIMED backfill: ${totalMs} ms total, maxChunk≈${maxChunkMs} ms`);
  console.log(`       rows: skill_invocations=${invs}, behavior_events=${be}, turn_usage=${tu}, streams_with_usage=${streamsWithRows}`);

  // Flagship regression (master §4 WP2): the orchestration MCP toolset concentrates
  // in the SUPERVISOR lane and is ~0 elsewhere. This is the report's 239-supervisor/
  // 0-elsewhere signal — an ORCHESTRATION TOOL-CALL histogram out of `behavior_events`
  // (mcp_toolset='orchestration'), NOT a `skill_invocations` count. The absolute number
  // has grown past 239 (larger corpus + the full orchestration toolset, not just the
  // report's 4 tools), so the load-bearing assertion is the lane SHAPE, not the count.
  // Asserted against the FIRST backfill (before the idempotency re-run) so a live,
  // still-writing corpus can't shift it out from under the check.
  const hist = dbm.getDb().prepare(
    `SELECT sls.lane AS lane, COUNT(*) AS c
     FROM behavior_events be JOIN stream_lane_stats sls ON sls.stream_id = be.stream_id
     WHERE be.mcp_toolset = 'orchestration'
     GROUP BY sls.lane ORDER BY c DESC`,
  ).all() as Array<{ lane: string; c: number }>;
  console.log('       orchestration (behavior_events) histogram by lane:');
  for (const r of hist) console.log(`         ${r.lane}: ${r.c}`);
  const orchTotal = hist.reduce((s, r) => s + Number(r.c), 0);
  const supRow = hist.find((r) => r.lane === 'supervisor');
  const supervisor = supRow ? Number(supRow.c) : 0;
  const nonSupervisor = orchTotal - supervisor;
  const topLane = hist.length ? Number(hist[0].c) : 0; // hist is ORDER BY c DESC
  assert.ok(orchTotal > 0, 'orchestration mcp_toolset populated — resolver wired (design §4.3)');
  assert.ok(supervisor > 0 && supervisor === topLane, 'orchestration calls concentrate in the supervisor lane');
  assert.ok(nonSupervisor <= orchTotal * 0.15,
    `orchestration is ~0 outside supervisor (got non-supervisor=${nonSupervisor} of ${orchTotal})`);

  // Idempotency: a re-run adds ZERO rows. NOTE: strict only on a FROZEN corpus — under
  // a live dashboard, agents may append jsonl between the two passes, so allow a small
  // upward drift (the re-run must never LOSE or duplicate wholesale).
  const h2 = harness(new Map(), streams, {
    listStreams: () => streams, readNewLines: scanMod.readNewLines,
    statSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    resolveMcpToolset,
    nowMs: () => Date.now(), scheduleYield: (fn) => { setImmediate(fn); },
  });
  const m2 = new mgr.ParseManager(h2.deps);
  m2.startBackfill();
  await m2.whenBackfillDone();
  const DRIFT = 200; // generous ceiling for concurrent live-corpus appends during the run
  const assertIdempotent = (table: string, base: number): void => {
    const after = count(`SELECT COUNT(*) c FROM ${table}`);
    assert.ok(after >= base && after - base <= DRIFT,
      `re-run adds ~zero ${table} (frozen: 0; live drift allowed ≤${DRIFT}; base=${base} after=${after})`);
  };
  assertIdempotent('skill_invocations', invs);
  assertIdempotent('behavior_events', be);
  assertIdempotent('turn_usage', tu);
});

// ── runner ──────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-backfill-'));
  if (process.env.RUN_CORPUS_BACKFILL !== '1') process.env.APPDATA = tmpAppData; // isolate scanner dirs unless real run

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  dbm.initDatabase();
  mgr = require('./parse-manager');
  scanner = require('./jsonl-scanner');

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
