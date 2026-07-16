// behavior-store.ts tests — the query abstraction over the WP2 parse foundation.
//
// Integration-style: ingest a small hand-crafted multi-lane corpus through the real
// parse-runner (populating behavior_events / search_events / turn_usage /
// skill_invocations / stream_lane_stats), then assert behavior-store's reads. Uses
// the same sql.js better-sqlite3 stand-in (named + positional binding) as
// parse-runner.test.ts, because better-sqlite3's native binding won't load under the
// system Node that `npm run test:supervisor` uses.
//
//   npm run build:main
//   node dist/main/main/context-optimizer/behavior-store.test.js

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
let runner: typeof import('../skill-analytics/parse-runner');
let scanner: typeof import('../skill-analytics/jsonl-scanner');
let storeMod: typeof import('./behavior-store');

// ── builders ──
const TS = '2026-07-06T00:00:00.000Z';
type Entry = Record<string, unknown>;
function userMsg(uuid: string, text: unknown, cwd?: string): Entry { return { type: 'user', uuid, timestamp: TS, cwd, message: { role: 'user', content: text } }; }
function assistantSkill(uuid: string, skill: string, opts: { stop?: string; usage?: unknown; cwd?: string }): Entry {
  return { type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd, message: { role: 'assistant', model: 'm', stop_reason: opts.stop ?? 'tool_use', usage: opts.usage, content: [{ type: 'tool_use', name: 'Skill', id: `${uuid}-t`, input: { skill } }] } };
}
function assistantTool(uuid: string, name: string, input: unknown, opts: { stop?: string; usage?: unknown; cwd?: string } = {}): Entry {
  return { type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd, message: { role: 'assistant', model: 'm', stop_reason: opts.stop ?? 'tool_use', usage: opts.usage, content: [{ type: 'tool_use', name, id: `${uuid}-t`, input }] } };
}
function assistantEnd(uuid: string, text: string, opts: { usage?: unknown; cwd?: string } = {}): Entry {
  return { type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd, message: { role: 'assistant', model: 'm', stop_reason: 'end_turn', usage: opts.usage, content: [{ type: 'text', text }] } };
}
function vfile(entries: Entry[]): Buffer { return Buffer.from(entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'); }
function metaFor(p: string, over: Partial<import('../skill-analytics/jsonl-scanner').StreamMeta> = {}): import('../skill-analytics/jsonl-scanner').StreamMeta {
  return { streamId: scanner.normalizeStreamId(p), jsonlPath: p, slug: p.includes('/projA/') ? 'projA' : 'projB', sessionId: 's', subAgentName: null, parentSessionId: null, isSubagent: false, ...over };
}
function makeReader(files: Map<string, Buffer>) {
  return (p: string, off: number) => {
    const buf = files.get(p) ?? Buffer.alloc(0); const size = buf.length;
    const first = size ? scanner.splitCompleteLines(buf, 0).lines[0]?.text ?? '' : '';
    const firstFingerprint = scanner.computeFingerprint(first);
    if (off >= size) return { lines: [], nextOffset: off > size ? size : off, sizeBytes: size, firstFingerprint };
    const { lines, nextOffset } = scanner.splitCompleteLines(buf.subarray(off), off);
    return { lines, nextOffset, sizeBytes: size, firstFingerprint };
  };
}
const SUP_CWD = 'C:/projA/.dashboard/supervisor';
const WORKER_CWD = 'C:/projB/.dashboard/workers/claude';

// ── shared corpus (ingested once) ──
function ingestCorpus(): void {
  const files = new Map<string, Buffer>();
  const streams: import('../skill-analytics/jsonl-scanner').StreamMeta[] = [];

  // Supervisor stream — orchestration MCP calls + a skill invocation + heavy cache-read usage.
  const sp = 'C:/home/.claude/projects/projA/sup.jsonl';
  files.set(sp, vfile([
    userMsg('su1', 'Coordinate the workers', SUP_CWD),
    assistantSkill('sa0', 'run-orchestration', { stop: 'tool_use', cwd: SUP_CWD, usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 9000, output_tokens: 50 } }),
    assistantTool('sa1', 'mcp__agent-dashboard__list_agents', {}, {}),
    assistantTool('sa2', 'mcp__agent-dashboard__read_agent_chat', { agentId: 'x' }, {}),
    assistantEnd('sa3', 'ok', { usage: { input_tokens: 5, cache_read_input_tokens: 9000, output_tokens: 20 } }),
  ]));
  streams.push(metaFor(sp));

  // Two worker streams — repeated npm-run + repeated Grep + a path read.
  for (const n of [1, 2]) {
    const wp = `C:/home/.claude/projects/projB/w${n}.jsonl`;
    files.set(wp, vfile([
      userMsg(`w${n}u`, 'Build and test', WORKER_CWD),
      assistantTool(`w${n}a`, 'Bash', { command: 'npm run build' }, { cwd: WORKER_CWD }),
      assistantTool(`w${n}b`, 'Grep', { pattern: 'TODO' }, {}),
      assistantTool(`w${n}c`, 'Read', { file_path: 'C:/projB/src/index.ts' }, {}),
      assistantEnd(`w${n}d`, 'done', { usage: { input_tokens: 30, output_tokens: 15 } }),
    ]));
    streams.push(metaFor(wp));
  }

  runner.runIncrementalParse({
    db: dbm.getDb() as unknown as import('../skill-analytics/parse-runner').ParseDb,
    streams,
    readNewLines: makeReader(files),
    knownSkills: new Set(['run-orchestration']),
    resolveMcpToolset: (name: string) => (name.startsWith('mcp__agent-dashboard__') ? 'orchestration' : null),
    nowMs: Date.parse(TS) + 1000,
  });
}

function store(): import('./behavior-store').BehaviorStore {
  return new storeMod.BehaviorStore(dbm.getDb() as unknown as import('./behavior-store').QueryDb);
}

// ── tests ──
test('laneHistogram(mcp_toolset) reproduces the per-lane orchestration shape (supervisor>0, worker 0)', () => {
  const rows = store().laneHistogram('mcp_toolset');
  const sup = rows.find((r) => r.lane === 'supervisor' && r.key === 'orchestration');
  assert.ok(sup, 'supervisor has orchestration toolset usage');
  assert.equal(sup!.count, 2, 'two orchestration MCP calls in the supervisor lane');
  assert.equal(rows.filter((r) => r.lane === 'worker').length, 0, 'no orchestration usage elsewhere');
});

test('laneHistogram(skill_name) attributes the skill to its lane', () => {
  const rows = store().laneHistogram('skill_name');
  const sup = rows.find((r) => r.lane === 'supervisor' && r.key === 'run-orchestration');
  assert.ok(sup && sup.count === 1);
});

test('countMatching — lane-scoped tool / toolset / command / path / search / skill', () => {
  const s = store();
  assert.equal(s.countMatching({ kind: 'toolset-usage', toolset: 'orchestration' }, ['supervisor']).occurrences, 2);
  assert.equal(s.countMatching({ kind: 'toolset-usage', toolset: 'orchestration' }, ['worker']).occurrences, 0);
  assert.equal(s.countMatching({ kind: 'command-family', family: 'npm-run:build' }, ['worker']).distinctStreams, 2);
  const pathM = s.countMatching({ kind: 'path-touch', pathGlob: 'C:/projB/src/*.ts' }, ['worker']);
  assert.equal(pathM.occurrences, 2, 'both worker streams read the index path');
  assert.equal(s.countMatching({ kind: 'skill-invocation', skillName: 'run-orchestration' }).occurrences, 1);
  const tool = s.countMatching({ kind: 'tool-invocation', toolName: 'Grep' }, ['worker']);
  assert.equal(tool.occurrences, 2);
});

test('exposureForLane counts end_turns as the denominator', () => {
  const s = store();
  assert.equal(s.exposureForLane('supervisor').turnCount, 1);
  assert.equal(s.exposureForLane('worker').turnCount, 2, 'one end_turn per worker stream');
  assert.equal(s.exposureForLane('worker').distinctStreams, 2);
});

test('streamSpend / laneSpend derive freshSpend and keep cache_read SEPARATE', () => {
  const s = store();
  const sup = s.laneSpend('supervisor');
  // fresh = (100+10+50) + (5+0+20) = 185 ; cache_read = 9000+9000 = 18000 (never in spend)
  assert.equal(sup.freshSpend, 185);
  assert.equal(sup.cacheRead, 18000);
  assert.equal(sup.freshInput, 115); // (100+10)+(5+0) — cache_read excluded
  const worker = s.laneSpend('worker');
  assert.equal(worker.freshSpend, 2 * (30 + 15));
  assert.equal(worker.cacheRead, 0);
});

test('windowUsage rollup reads off skill_invocations', () => {
  const inv = dbm.getDb().prepare(`SELECT id FROM skill_invocations WHERE skill_name='run-orchestration'`).get() as { id: string };
  const wu = store().windowUsage(inv.id)!;
  // supervisor window spans both usage-bearing turns (invoking + end_turn).
  assert.equal(wu.output, 70);
  assert.equal(wu.freshInput, 115); // (100+10)+(5+0) — cache_read excluded
  assert.equal(wu.freshSpend, 185); // freshInput + output
  assert.equal(wu.cacheRead, 18000);
});

test('improvisationClusters — repeated command + search across ≥2 streams', () => {
  const clusters = store().improvisationClusters('worker', { minCount: 2, minStreams: 2 });
  const cmd = clusters.find((c) => c.dimension === 'command_family' && c.key === 'npm-run:build');
  assert.ok(cmd && cmd.count === 2 && cmd.distinctStreams === 2, 'npm-run:build cluster kept');
  const search = clusters.find((c) => c.dimension === 'search_signature_hash');
  assert.ok(search && search.distinctStreams === 2, 'repeated Grep signature clusters across streams');
});

// ── R2 WP-4B (Step 3): the redacted cluster-exemplar drill ────────────────────
test('clusterExemplars(input_shape_hash) — tool short name + input KEY set, never a raw value', () => {
  const page = store().clusterExemplars('worker', 'input_shape_hash', {});
  // Each worker stream ran Bash{command}, Grep{pattern}, Read{file_path} → 3 distinct shapes.
  assert.equal(page.exemplars.length, 3, 'three distinct input shapes for the worker lane');
  const grep = page.exemplars.find((e) => e.toolShortName === 'Grep');
  assert.ok(grep, 'Grep shape present');
  assert.deepEqual(grep!.inputKeys, ['pattern'], 'key NAMES only, never values');
  assert.equal(grep!.count, 2, 'seen across both worker streams');
  assert.equal(grep!.distinctStreams, 2);
  assert.ok(grep!.eventRefs.length > 0 && grep!.eventRefs.length <= 5, 'capped byte-locators');
  assert.ok(grep!.eventRefs.every((r) => r.entryUuid && typeof r.blockIndex === 'number' && typeof r.byteOffset === 'number'),
    'each ref is an identifier-only byte-locator');
  // NEVER a raw input value or user prompt anywhere in the serialized page.
  const json = JSON.stringify(page);
  for (const leak of ['TODO', 'npm run build', 'index.ts', 'Build and test', 'Coordinate the workers']) {
    assert.ok(!json.includes(leak), `exemplar page must not leak "${leak}"`);
  }
});

test('clusterExemplars(search_signature_hash) — normalized search terms, never the raw prompt', () => {
  const page = store().clusterExemplars('worker', 'search_signature_hash', {});
  assert.equal(page.exemplars.length, 1, 'one repeated Grep search signature for the worker lane');
  const ex = page.exemplars[0];
  assert.ok(ex.searchTerms && ex.searchTerms.length > 0, 'normalized terms present');
  assert.ok(ex.searchTerms!.includes('todo'), 'the normalized (lowercased) search term');
  assert.equal(ex.toolShortName, undefined, 'search exemplars carry no tool short name');
  assert.equal(ex.inputKeys, undefined, 'search exemplars carry no input keys');
  assert.equal(ex.count, 2);
  assert.equal(ex.distinctStreams, 2);
  assert.ok(!JSON.stringify(page).includes('Build and test'), 'never a raw user prompt');
});

test('clusterExemplars — command_family is not a hash dimension → empty page', () => {
  assert.deepEqual(store().clusterExemplars('worker', 'command_family', {}).exemplars, []);
});

test('clusterExemplars — opaque cursor paginates the three worker shapes (limit 1)', () => {
  const s = store();
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 3; i++) {
    const page = s.clusterExemplars('worker', 'input_shape_hash', { limit: 1, cursor });
    assert.equal(page.exemplars.length, 1, `page ${i} returns exactly one exemplar`);
    seen.push(page.exemplars[0].ref);
    cursor = page.nextCursor;
    if (i < 2) assert.ok(cursor, `page ${i} carries a next cursor`);
  }
  assert.equal(cursor, undefined, 'no cursor after the final page');
  assert.equal(new Set(seen).size, 3, 'three distinct shapes across the pages, no repeats');
});

// ── runner ──
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-store-'));
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
  runner = require('../skill-analytics/parse-runner');
  scanner = require('../skill-analytics/jsonl-scanner');
  storeMod = require('./behavior-store');

  ingestCorpus();

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
