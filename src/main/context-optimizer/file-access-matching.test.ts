// file-access-matching.test.ts — WP-1B end-to-end: ingest → canonical store match →
// classifier. Includes the PERMANENT corpus acceptance fixture built from the REAL
// supervisor Memory section (`.dashboard/supervisor/CLAUDE.md` "## Memory"), which
// must classify as OCCURS (not the historical `never` false-positive) once a read
// under the canonical absolute path exists.
//
// Integration-style, same sql.js better-sqlite3 stand-in as behavior-store.test.ts.
//   npm run build:main
//   node dist/main/main/context-optimizer/file-access-matching.test.js

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
let compilerMod: typeof import('./guidance-action-model');
let classifierMod: typeof import('./occurrence-classifier');

// ── builders ──
const TS = '2026-07-06T00:00:00.000Z';
type Entry = Record<string, unknown>;
function userMsg(uuid: string, text: unknown, cwd?: string): Entry { return { type: 'user', uuid, timestamp: TS, cwd, message: { role: 'user', content: text } }; }
function assistantTool(uuid: string, name: string, input: unknown, opts: { stop?: string; cwd?: string } = {}): Entry {
  return { type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd, message: { role: 'assistant', model: 'm', stop_reason: opts.stop ?? 'tool_use', content: [{ type: 'tool_use', name, id: `${uuid}-t`, input }] } };
}
function assistantEnd(uuid: string, text: string): Entry {
  return { type: 'assistant', uuid, timestamp: TS, message: { role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text }] } };
}
function vfile(entries: Entry[]): Buffer { return Buffer.from(entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'); }
function metaFor(p: string, slug: string, over: Partial<import('../skill-analytics/jsonl-scanner').StreamMeta> = {}): import('../skill-analytics/jsonl-scanner').StreamMeta {
  return { streamId: scanner.normalizeStreamId(p), jsonlPath: p, slug, sessionId: 's', subAgentName: null, parentSessionId: null, isSubagent: false, ...over };
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

// Workspace roots + agent cwds (two DISTINCT workspaces, same MEMORY.md basename).
const SUP_CWD = 'C:/projA/.dashboard/supervisor';
const WORKER_CWD = 'C:/projB/.dashboard/workers/claude';
const SUP_MEMORY_ABS = 'C:/projA/.dashboard/supervisor/memory/MEMORY.md';   // what the supervisor actually reads
const WORKER_MEMORY_ABS = 'C:/projB/.dashboard/workers/claude/memory/MEMORY.md'; // same basename, other workspace
// Canonical (Windows-folded) identity the compiler resolves `./memory/MEMORY.md` to.
const SUP_MEMORY_CANON = 'C:\\projA\\.dashboard\\supervisor\\memory\\MEMORY.md';

function ingestCorpus(): void {
  const files = new Map<string, Buffer>();
  const streams: import('../skill-analytics/jsonl-scanner').StreamMeta[] = [];

  // Supervisor stream — reads its Memory index at the canonical absolute path.
  const sp = 'C:/home/.claude/projects/projA/sup.jsonl';
  files.set(sp, vfile([
    userMsg('su1', 'Coordinate', SUP_CWD),
    assistantTool('sa1', 'Read', { file_path: SUP_MEMORY_ABS }, {}),
    assistantEnd('sa2', 'ok'),
  ]));
  streams.push(metaFor(sp, 'projA'));

  // Worker stream (DIFFERENT workspace) — reads a same-basename MEMORY.md + writes a file.
  const wp = 'C:/home/.claude/projects/projB/w.jsonl';
  files.set(wp, vfile([
    userMsg('w1', 'Build', WORKER_CWD),
    assistantTool('w2', 'Read', { file_path: WORKER_MEMORY_ABS }, {}),
    assistantTool('w3', 'Write', { file_path: 'C:/projB/src/out.ts' }, {}),
    assistantEnd('w4', 'done'),
  ]));
  streams.push(metaFor(wp, 'projB'));

  runner.runIncrementalParse({
    db: dbm.getDb() as unknown as import('../skill-analytics/parse-runner').ParseDb,
    streams,
    readNewLines: makeReader(files),
    knownSkills: new Set<string>(),
    resolveMcpToolset: () => null,
    nowMs: Date.parse(TS) + 1000,
  });

  // A HISTORICAL row with NO recorded cwd → arg_path_canonical stays NULL. It shares
  // the supervisor lane + memory basename; it must NEVER be suffix-matched (WP-1B).
  const db = dbm.getDb();
  db.prepare(`INSERT INTO stream_lane_stats (stream_id, lane, slug, turn_count) VALUES (?,?,?,?)`)
    .run('legacy-stream', 'supervisor', 'projA', 0);
  db.prepare(
    `INSERT INTO behavior_events (id, stream_id, byte_offset, ts_ms, kind, arg_path, arg_path_canonical, access_mode, observable, event_ordinal)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('legacy#0:file_touch:0', 'legacy-stream', 0, Date.parse(TS), 'file_touch', 'c:\\proja\\.dashboard\\supervisor\\memory\\memory.md', null, 'read', 1, 0);

  // A row carrying an explicit workspace-relative identity (Phase-2 ingestion will
  // populate this column; here we seed one to prove the workspace-rel matcher fires).
  db.prepare(
    `INSERT INTO behavior_events (id, stream_id, byte_offset, ts_ms, kind, arg_path, arg_path_workspace_rel, access_mode, observable, event_ordinal)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('wsrel#0:file_touch:0', 'sa1-stream-wsrel', 0, Date.parse(TS), 'file_touch', SUP_MEMORY_ABS, '.dashboard/supervisor/memory/MEMORY.md', 'read', 1, 0);
  db.prepare(`INSERT INTO stream_lane_stats (stream_id, lane, slug, turn_count) VALUES (?,?,?,?)`)
    .run('sa1-stream-wsrel', 'supervisor', 'projA', 0);
}

function store(): import('./behavior-store').BehaviorStore {
  return new storeMod.BehaviorStore(dbm.getDb() as unknown as import('./behavior-store').QueryDb);
}
function fileAccess(over: Partial<import('./behavior-store').FileAccessPredicate['path']> & { modes?: import('./behavior-store').FileAccessMode[] } = {}): import('./behavior-store').FileAccessPredicate {
  const { modes, ...path } = over;
  return { kind: 'file-access', path: { raw: 'x', base: 'agent-cwd', ...path }, modes: modes ?? [] };
}

// ── behavior-store matching ───────────────────────────────────────────────────
test('canonical-abs match: the supervisor Memory read is found; the same-basename worker read is NOT', () => {
  const s = store();
  const m = s.countMatching(fileAccess({ canonicalAbs: SUP_MEMORY_CANON }), ['supervisor', 'worker']);
  assert.equal(m.occurrences, 1, 'exactly the supervisor read matches — no basename leak from the worker workspace');
  assert.equal(m.distinctStreams, 1);
});

test('NULL-canonical historical row is never matched (no suffix/basename fallback)', () => {
  const s = store();
  // Legacy path-touch LIKE would catch the historical basename row; file-access must not.
  const m = s.countMatching(fileAccess({ canonicalAbs: SUP_MEMORY_CANON }), ['supervisor']);
  assert.equal(m.occurrences, 1, 'only the resolved read — the NULL-canonical row is excluded');
});

test('access_mode constraint: read predicate matches the read, write predicate does not', () => {
  const s = store();
  assert.equal(s.countMatching(fileAccess({ canonicalAbs: SUP_MEMORY_CANON, modes: ['read'] }), ['supervisor']).occurrences, 1);
  assert.equal(s.countMatching(fileAccess({ canonicalAbs: SUP_MEMORY_CANON, modes: ['write'] }), ['supervisor']).occurrences, 0);
});

test('access_mode constraint on a written file: write matches, read does not', () => {
  const s = store();
  const canon = 'C:\\projB\\src\\out.ts';
  assert.equal(s.countMatching(fileAccess({ canonicalAbs: canon, modes: ['write'] }), ['worker']).occurrences, 1);
  assert.equal(s.countMatching(fileAccess({ canonicalAbs: canon, modes: ['read'] }), ['worker']).occurrences, 0);
});

test('an unresolved predicate (no identity at all) matches nothing', () => {
  const s = store();
  assert.equal(s.countMatching(fileAccess({}), ['supervisor', 'worker']).occurrences, 0);
});

test('workspace-relative identity matches the seeded workspace-rel row', () => {
  const s = store();
  const m = s.countMatching(fileAccess({ workspaceRelative: '.dashboard/supervisor/memory/MEMORY.md' }), ['supervisor']);
  assert.equal(m.occurrences, 1);
});

// ── corpus acceptance: the REAL supervisor "## Memory" section ─────────────────
const MEMORY_LINE = 'Check `./memory/MEMORY.md` at session start for context from prior runs. Save important observations there. Your memory is isolated from other Claude Code sessions in this workspace via `autoMemoryEnabled: false` in your `./.claude/settings.json` — repo-wide auto-memory is off, so the manual index is your only memory source.';
const MEMORY_SECTION = ['## Memory', '', MEMORY_LINE].join('\n');
const SUP_CLAUDE_MD = 'C:/projA/.dashboard/supervisor/CLAUDE.md';

function compileMemoryActions(): import('./guidance-action-model').PredictedAction[] {
  const target: import('./resident-inventory').ResidentTarget = {
    targetType: 'markdown_section', targetKey: SUP_CLAUDE_MD, sourceKind: 'ignored_scaffold',
    sourcePath: SUP_CLAUDE_MD, sourceSymbol: null, lanes: ['supervisor'], text: MEMORY_SECTION,
  };
  const node: import('../../shared/types').KnowledgeNode = {
    type: 'file-reference', label: './memory/MEMORY.md', detail: MEMORY_LINE,
    source: { absPath: SUP_CLAUDE_MD, lineStart: 3, lineEnd: 3 },
  } as import('../../shared/types').KnowledgeNode;
  return compilerMod.compileGuidanceActions([node], {
    residentTargets: [target],
    estimateTokens: (t) => t.length,
    representativeAgentCwd: () => SUP_CWD,          // resolve `./…` against the AGENT cwd
    workspaceRootForLanes: () => 'C:/projA',
  });
}

test('compiler resolves the real Memory `./memory/MEMORY.md` to the canonical absolute path', () => {
  const actions = compileMemoryActions();
  const pt = actions.find((a) => a.kind === 'path-touch');
  assert.ok(pt, 'a path-touch action is emitted for the Memory reference');
  assert.ok(pt!.fileAccess, 'it carries resolved fileAccess');
  assert.equal(pt!.fileAccess!.canonicalAbs, SUP_MEMORY_CANON);
  assert.equal(pt!.fileAccess!.workspaceRelative, '.dashboard/supervisor/memory/MEMORY.md');
  // "Check … Save …" names both senses → ambiguous → any-touch (candidate-only).
  assert.deepEqual(pt!.fileAccess!.modes, []);
});

test('ACCEPTANCE: the real Memory section classifies as OCCURS, not the `never` false-positive', () => {
  const actions = compileMemoryActions();
  const pt = actions.find((a) => a.kind === 'path-touch')!;
  const deps: import('./occurrence-classifier').ClassifyDeps = {
    occurrence: classifierMod.defaultOccurrenceCounter(store()),
    exposure: classifierMod.defaultExposureResolver(store()),
  };
  const verdict = classifierMod.classifyAction(pt, deps);
  assert.equal(verdict.status, 'occurs', 'the read under the canonical path is credited as compliance');
  assert.ok(verdict.occurrences >= 1);
  assert.notEqual(verdict.status, 'never');
  assert.equal(verdict.predicate?.kind, 'file-access');
});

test('a Memory reference whose read never happened would be never/insufficient, not falsely occurs', () => {
  // Sanity counter-check: an unrelated resolved path with no matching event.
  const actions = compileMemoryActions();
  const pt = { ...actions.find((a) => a.kind === 'path-touch')! };
  pt.fileAccess = { ...pt.fileAccess!, canonicalAbs: 'C:\\projA\\.dashboard\\supervisor\\memory\\NOPE.md', workspaceRelative: undefined };
  const deps: import('./occurrence-classifier').ClassifyDeps = {
    occurrence: classifierMod.defaultOccurrenceCounter(store()),
    exposure: classifierMod.defaultExposureResolver(store()),
    config: { MIN_EXPOSURE_TURNS: 0, MIN_STREAMS: 0 },
  };
  const verdict = classifierMod.classifyAction(pt, deps);
  assert.equal(verdict.occurrences, 0);
  assert.equal(verdict.status, 'never', 'zero occurrences above the (zeroed) floor → never — the mechanism still works');
});

// ── runner ──
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;
  // Inject the sql.js FakeDb in place of the native better-sqlite3 addon, which won't
  // load under the system Node that `npm run test:supervisor` uses.
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;
  /* eslint-disable @typescript-eslint/no-var-requires */
  dbm = require('../database') as unknown as DbMod;
  dbm.initDatabase();
  runner = require('../skill-analytics/parse-runner');
  scanner = require('../skill-analytics/jsonl-scanner');
  storeMod = require('./behavior-store');
  compilerMod = require('./guidance-action-model');
  classifierMod = require('./occurrence-classifier');
  /* eslint-enable @typescript-eslint/no-var-requires */

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
