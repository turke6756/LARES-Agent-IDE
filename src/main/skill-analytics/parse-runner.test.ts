// parse-runner.ts tests — the P0.4 streaming hub (P0.8 + wp2b §2/§3 acceptance).
//
// better-sqlite3's native binding won't load under the system Node that
// `npm run test:supervisor` uses, so this test injects a sql.js (wasm SQLite)
// stand-in into require.cache BEFORE requiring ../database (same precedent as
// database.test.ts). The stand-in additionally supports better-sqlite3's
// NAMED-parameter object binding (@col), which parse-runner leans on.
//
//   npm run build:main
//   node dist/main/main/skill-analytics/parse-runner.test.js

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
let runner: typeof import('./parse-runner');
let scanner: typeof import('./jsonl-scanner');

// ── entry + file builders ─────────────────────────────────────────────────────
const TS = '2026-07-06T00:00:00.000Z';
type Entry = Record<string, unknown>;

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
function assistantTool(uuid: string, name: string, input: unknown, opts: { stop?: string; usage?: unknown; cwd?: string } = {}): Entry {
  return {
    type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd,
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: opts.stop ?? 'tool_use', usage: opts.usage,
      content: [{ type: 'tool_use', name, id: `${uuid}-tu`, input }] },
  };
}
function assistantEnd(uuid: string, text: string, opts: { usage?: unknown; cwd?: string } = {}): Entry {
  return {
    type: 'assistant', uuid, timestamp: TS, cwd: opts.cwd,
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: opts.usage,
      content: [{ type: 'text', text }] },
  };
}
function userToolResult(uuid: string, isError = false): Entry {
  return { type: 'user', uuid, timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: isError, content: 'ok' }] } };
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

const SUP_CWD = 'C:/proj/.dashboard/supervisor';
const WORKER_CWD = 'C:/proj/.dashboard/workers/claude';

function baseDeps(files: Map<string, Buffer>, streams: import('./jsonl-scanner').StreamMeta[], over: Partial<import('./parse-runner').ParseDeps> = {}): import('./parse-runner').ParseDeps {
  return {
    db: dbm.getDb() as unknown as import('./parse-runner').ParseDb,
    streams,
    readNewLines: makeReader(files),
    knownSkills: new Set(['deep-research', 'verify']),
    resolveMcpToolset: () => null,
    nowMs: Date.parse(TS) + 1000,
    ...over,
  };
}

function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return (dbm.getDb().prepare(sql).all(...params) as unknown) as T[];
}
function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return dbm.getDb().prepare(sql).get(...params) as T | undefined;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('A: full window finalize + usage attribution + snippet + lane', () => {
  const p = 'C:/home/.claude/projects/proj/A.jsonl';
  const files = new Map([[p, vfile([
    userMsg('u1', 'Please run the deep research skill on WP2 tokens', SUP_CWD),
    assistantSkill('a1', 'deep-research', { stop: 'tool_use', cwd: SUP_CWD,
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 30 } }),
    userToolResult('u2'),
    assistantEnd('a2', 'Here is the summary.', {
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 40 } }),
  ])]]);
  const res = runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  assert.equal(res.invocationsAdded, 1);

  const inv = one(`SELECT * FROM skill_invocations WHERE stream_id = ?`, scanner.normalizeStreamId(p))!;
  assert.equal(inv.skill_name, 'deep-research');
  assert.equal(inv.detector, 'tool_use');
  assert.equal(Number(inv.window_open), 0, 'window finalized on end_turn');
  assert.equal(Number(inv.window_usage_turns), 2);
  assert.equal(Number(inv.window_usage_output_tokens), 70, 'output 30+40');
  assert.equal(Number(inv.window_output_tokens), 70, 'Fix-4 equality: window_output_tokens == usage output');
  assert.equal(Number(inv.window_fresh_input_tokens), 130, 'fresh input (100+20)+(10+0)');
  assert.equal(Number(inv.window_cache_read_tokens), 1100, 'cache_read 500+600 kept separate');

  const usage = q(`SELECT * FROM turn_usage WHERE stream_id = ? ORDER BY turn_index`, scanner.normalizeStreamId(p));
  assert.equal(usage.length, 2);
  for (const row of usage) assert.equal(row.invocation_id, inv.id, 'both turns bill to the window');
  assert.equal(Number(usage[1].input_tokens), 10, 'input stored as-is, NOT input−cache_read');

  const snip = one(`SELECT * FROM trigger_snippets WHERE event_id = ?`, inv.id)!;
  assert.equal(snip.event_type, 'skill_invocation');
  assert.equal(snip.source_kind, 'user_message');
  assert.match(String(snip.snippet), /deep research/i);

  const lane = one(`SELECT * FROM stream_lane_stats WHERE stream_id = ?`, scanner.normalizeStreamId(p))!;
  assert.equal(lane.lane, 'supervisor');
  assert.equal(Number(lane.turn_count), 1, 'one end_turn = exposure denominator');
});

test('B: split-line boundary — invocation emitted once, only after the line completes', () => {
  const p = 'C:/home/.claude/projects/proj/B.jsonl';
  const full = vfile([
    userMsg('bu1', 'kick off', WORKER_CWD),
    assistantSkill('ba1', 'verify', { stop: 'end_turn', cwd: WORKER_CWD,
      usage: { input_tokens: 5, output_tokens: 5 } }),
  ]);
  // First pass: truncate the buffer mid-second-line (drop the trailing '\n' and part of it).
  const cut = full.length - 20;
  const files = new Map([[p, full.subarray(0, cut)]]);
  const r1 = runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  assert.equal(r1.invocationsAdded, 0, 'fragment line not yet parsed');
  assert.equal(one(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id=?`, scanner.normalizeStreamId(p))!.c, 0);

  // Second pass: file now complete → invocation emitted once.
  files.set(p, full);
  const r2 = runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  assert.equal(r2.invocationsAdded, 1);
  // Third pass: nothing new.
  const r3 = runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  assert.equal(r3.invocationsAdded, 0);
  assert.equal(one(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id=?`, scanner.normalizeStreamId(p))!.c, 1);
});

test('C: cursor reset + reparse → ZERO counter drift, no window reopened (caution 1)', () => {
  const p = 'C:/home/.claude/projects/proj/C.jsonl';
  const files = new Map([[p, vfile([
    userMsg('cu1', 'do the thing', WORKER_CWD),
    assistantTool('ca1', 'Bash', { command: 'node scripts/build.js' }, { cwd: WORKER_CWD }),
    assistantSkill('ca2', 'verify', { stop: 'tool_use', cwd: WORKER_CWD, usage: { input_tokens: 8, output_tokens: 3 } }),
    userToolResult('cu2', true),
    assistantEnd('ca3', 'done', { usage: { input_tokens: 2, output_tokens: 4 } }),
  ])]]);
  const sid = scanner.normalizeStreamId(p);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));

  const before = {
    inv: q(`SELECT id,window_open,window_tool_calls,window_error_results,window_output_tokens FROM skill_invocations WHERE stream_id=?`, sid),
    be: one(`SELECT COUNT(*) c FROM behavior_events WHERE stream_id=?`, sid)!.c,
    tu: one(`SELECT COUNT(*) c, COALESCE(SUM(output_tokens),0) s FROM turn_usage WHERE stream_id=?`, sid)!,
  };

  // Manually reset the cursor to 0 (simulate a re-read) and re-run.
  dbm.getDb().prepare(`UPDATE skill_parse_cursors SET byte_offset = 0 WHERE jsonl_path = ?`).run(p);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));

  const after = {
    inv: q(`SELECT id,window_open,window_tool_calls,window_error_results,window_output_tokens FROM skill_invocations WHERE stream_id=?`, sid),
    be: one(`SELECT COUNT(*) c FROM behavior_events WHERE stream_id=?`, sid)!.c,
    tu: one(`SELECT COUNT(*) c, COALESCE(SUM(output_tokens),0) s FROM turn_usage WHERE stream_id=?`, sid)!,
  };
  assert.deepEqual(after.inv, before.inv, 'window counters unchanged, no window reopened');
  assert.equal(after.be, before.be, 'behavior_events count unchanged');
  assert.deepEqual(after.tu, before.tu, 'turn_usage unchanged');
  for (const row of after.inv) assert.equal(Number(row.window_open), 0, 'finalized window stays closed');
});

test('E: assistant entry without usage → no turn_usage row', () => {
  const p = 'C:/home/.claude/projects/proj/E.jsonl';
  const files = new Map([[p, vfile([
    userMsg('eu1', 'go', WORKER_CWD),
    assistantTool('ea1', 'Read', { file_path: 'C:/proj/x.ts' }, { cwd: WORKER_CWD }), // no usage
    assistantEnd('ea2', 'done', { usage: { input_tokens: 3, output_tokens: 2 } }),
  ])]]);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  const rows = q(`SELECT * FROM turn_usage WHERE stream_id=?`, scanner.normalizeStreamId(p));
  assert.equal(rows.length, 1, 'only the entry that carried usage produced a row');
});

test('F: search inside a window → search_events row; repeated signature → repeated_search=1', () => {
  const p = 'C:/home/.claude/projects/proj/F.jsonl';
  const files = new Map([[p, vfile([
    userMsg('fu1', 'find it', WORKER_CWD),
    assistantSkill('fa1', 'verify', { stop: 'tool_use', cwd: WORKER_CWD }),
    assistantTool('fa2', 'Grep', { pattern: 'needle' }, {}),
    assistantTool('fa3', 'Grep', { pattern: 'needle' }, { stop: 'end_turn' }),
  ])]]);
  const sid = scanner.normalizeStreamId(p);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  const searches = q(`SELECT * FROM search_events WHERE stream_id=?`, sid);
  assert.equal(searches.length, 2);
  for (const s of searches) assert.ok(s.invocation_id, 'search attributed to open window');
  const inv = one(`SELECT repeated_search FROM skill_invocations WHERE stream_id=?`, sid)!;
  assert.equal(Number(inv.repeated_search), 1, 'identical second search flags repeated_search');
});

test('G: brief classification — worker→supervisor_brief, subagent→subagent_brief, [DASHBOARD EVENT] skipped', () => {
  // worker stream: first substantive user turn is the supervisor brief.
  const pw = 'C:/home/.claude/projects/proj/G-worker.jsonl';
  const fw = new Map([[pw, vfile([
    userMsg('gw0', '[DASHBOARD EVENT] status idle', WORKER_CWD),
    userMsg('gw1', 'Implement the parser and land tests', WORKER_CWD),
    assistantSkill('gwa1', 'verify', { stop: 'end_turn', cwd: WORKER_CWD, usage: { input_tokens: 1, output_tokens: 1 } }),
  ])]]);
  runner.runIncrementalParse(baseDeps(fw, [metaFor(pw)]));
  const invW = one(`SELECT id FROM skill_invocations WHERE stream_id=?`, scanner.normalizeStreamId(pw))!;
  const snW = one(`SELECT * FROM trigger_snippets WHERE event_id=?`, invW.id)!;
  assert.equal(snW.source_kind, 'supervisor_brief');
  assert.match(String(snW.snippet), /Implement the parser/);

  // subagent stream: first substantive user turn is the subagent brief.
  const ps = 'C:/home/.claude/projects/proj/sess1/subagents/agent-x.jsonl';
  const fs2 = new Map([[ps, vfile([
    userMsg('gs1', 'Research token pricing', 'C:/proj'),
    assistantSkill('gsa1', 'verify', { stop: 'end_turn', cwd: 'C:/proj', usage: { input_tokens: 1, output_tokens: 1 } }),
  ])]]);
  runner.runIncrementalParse(baseDeps(fs2, [metaFor(ps, { subAgentName: 'agent-x', parentSessionId: 'sess1', isSubagent: true })]));
  const invS = one(`SELECT id FROM skill_invocations WHERE stream_id=?`, scanner.normalizeStreamId(ps))!;
  const snS = one(`SELECT * FROM trigger_snippets WHERE event_id=?`, invS.id)!;
  assert.equal(snS.source_kind, 'subagent_brief');
});

test('H: two streams under one parent session do not cross-attribute', () => {
  const p1 = 'C:/home/.claude/projects/proj/sess9/subagents/agent-1.jsonl';
  const p2 = 'C:/home/.claude/projects/proj/sess9/subagents/agent-2.jsonl';
  const files = new Map([
    [p1, vfile([userMsg('h1u', 'a', 'C:/proj'), assistantSkill('h1a', 'verify', { stop: 'tool_use', cwd: 'C:/proj' }),
      assistantTool('h1b', 'Bash', { command: 'ls' }, { stop: 'end_turn' })])],
    [p2, vfile([userMsg('h2u', 'b', 'C:/proj'), assistantTool('h2a', 'Bash', { command: 'pwd' }, { stop: 'end_turn' })])],
  ]);
  const streams = [
    metaFor(p1, { subAgentName: 'agent-1', parentSessionId: 'sess9', isSubagent: true }),
    metaFor(p2, { subAgentName: 'agent-2', parentSessionId: 'sess9', isSubagent: true }),
  ];
  runner.runIncrementalParse(baseDeps(files, streams));
  const inv1 = one(`SELECT stream_id, window_tool_calls FROM skill_invocations WHERE stream_id=?`, scanner.normalizeStreamId(p1))!;
  assert.equal(inv1.stream_id, scanner.normalizeStreamId(p1));
  // stream2 has no skill window, so its Bash tool_use never attributes to stream1's window.
  assert.equal(one(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id=?`, scanner.normalizeStreamId(p2))!.c, 0);
  assert.equal(Number(inv1.window_tool_calls), 1, 'only stream1 Bash counted (agent-2 excluded)');
});

test('I: rebuild on fingerprint change deletes old rows, no dupes', () => {
  const p = 'C:/home/.claude/projects/proj/I.jsonl';
  const v1 = vfile([userMsg('iu1', 'first', WORKER_CWD), assistantSkill('ia1', 'verify', { stop: 'end_turn', cwd: WORKER_CWD, usage: { input_tokens: 1, output_tokens: 1 } })]);
  const files = new Map([[p, v1]]);
  const sid = scanner.normalizeStreamId(p);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  assert.equal(one(`SELECT COUNT(*) c FROM skill_invocations WHERE stream_id=?`, sid)!.c, 1);

  // Rotate the file (different first line → fingerprint change) with new content.
  const v2 = vfile([userMsg('iu9', 'rotated', WORKER_CWD), assistantSkill('ia9', 'verify', { stop: 'end_turn', cwd: WORKER_CWD, usage: { input_tokens: 2, output_tokens: 2 } })]);
  files.set(p, v2);
  const res = runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  assert.equal(res.rebuilds, 1, 'fingerprint change triggered a rebuild');
  const invs = q(`SELECT id FROM skill_invocations WHERE stream_id=?`, sid);
  assert.equal(invs.length, 1, 'old invocation deleted, only the rotated one remains');
  assert.equal(invs[0].id, 'ia9#0');
});

test('J: cwd-less preamble (mode/permission-mode) does not strand lane at null; cwd from first cwd-bearing entry wins over a later cd (null-cwd regression)', () => {
  const p = 'C:/home/.claude/projects/proj/J.jsonl';
  const files = new Map([[p, vfile([
    { type: 'mode', uuid: 'jm', timestamp: TS },                   // launch preamble — no cwd
    { type: 'permission-mode', uuid: 'jp', timestamp: TS },        // no cwd
    { type: 'file-history-snapshot', uuid: 'jf', timestamp: TS },  // no cwd
    userMsg('ju1', 'Please run the deep research skill on WP2', SUP_CWD), // FIRST cwd = launch cwd
    assistantSkill('ja1', 'deep-research', { stop: 'end_turn', cwd: SUP_CWD, usage: { input_tokens: 1, output_tokens: 1 } }),
    assistantEnd('ja2', 'and now working from the repo root', { cwd: 'C:/proj', usage: { input_tokens: 1, output_tokens: 1 } }), // later cd — MUST NOT re-key lane
  ])]]);
  const sid = scanner.normalizeStreamId(p);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  const lane = one(`SELECT lane, working_dir FROM stream_lane_stats WHERE stream_id=?`, sid)!;
  assert.equal(lane.lane, 'supervisor', 'lane captured from first cwd-bearing entry, not stranded unknown by the cwd-less preamble');
  assert.equal(lane.working_dir, SUP_CWD, 'working_dir = launch cwd, not the later post-cd repo root');
});

test('K: lane back-filled across a chunk split — first chunk is cwd-less preamble only, cwd arrives in a later chunk', () => {
  const p = 'C:/home/.claude/projects/proj/K.jsonl';
  const preamble = vfile([
    { type: 'mode', uuid: 'km', timestamp: TS },
    { type: 'permission-mode', uuid: 'kp', timestamp: TS },
  ]);
  const full = Buffer.concat([preamble, vfile([
    userMsg('ku1', 'go', SUP_CWD),
    assistantSkill('ka1', 'deep-research', { stop: 'end_turn', cwd: SUP_CWD, usage: { input_tokens: 1, output_tokens: 1 } }),
  ])]);
  const sid = scanner.normalizeStreamId(p);
  // Pass 1: only the cwd-less preamble is present → row exists, honestly unknown/null.
  const files = new Map([[p, preamble]]);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  const mid = one(`SELECT lane, working_dir FROM stream_lane_stats WHERE stream_id=?`, sid)!;
  assert.equal(mid.lane, 'unknown', 'no cwd seen yet → honestly unknown');
  assert.equal(mid.working_dir, null, 'no working_dir committed from a cwd-less entry');
  // Pass 2: cwd-bearing entries arrive in a later chunk → lane back-filled (laneCwdLocked was false).
  files.set(p, full);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)]));
  const done = one(`SELECT lane, working_dir FROM stream_lane_stats WHERE stream_id=?`, sid)!;
  assert.equal(done.lane, 'supervisor', 'lane back-filled once the launch cwd appears in a later chunk');
  assert.equal(done.working_dir, SUP_CWD);
});

test('L: resolvable launch cwd persists workspace lineage AND activates arg_path_workspace_rel (WP-2B / WP-1B)', () => {
  const p = 'C:/home/.claude/projects/proj/L.jsonl';
  const files = new Map([[p, vfile([
    userMsg('lu1', 'read the app entrypoint', WORKER_CWD),
    assistantTool('la1', 'Read', { file_path: 'C:/proj/src/app.ts' }, { cwd: WORKER_CWD, stop: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
  ])]]);
  const sid = scanner.normalizeStreamId(p);
  // Inject a workspace-LEVEL resolver: the worker cwd folds to the workspace that owns it.
  const resolveWorkspaceLineage = () => ({ workspaceId: 'ws1', workspaceRoot: 'C:/proj', method: 'root' as const });
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)], { resolveWorkspaceLineage }));

  const lane = one(`SELECT workspace_id, workspace_root, workspace_attribution_method FROM stream_lane_stats WHERE stream_id=?`, sid)!;
  assert.equal(lane.workspace_id, 'ws1', 'unique-owner cwd fold persisted workspace_id at ingestion');
  assert.equal(lane.workspace_root, 'C:/proj', 'canonical workspace root persisted');
  assert.equal(lane.workspace_attribution_method, 'root', 'derived via cwd fold → method=root');

  const ft = one(`SELECT arg_path_workspace_rel r FROM behavior_events WHERE stream_id=? AND kind='file_touch'`, sid)!;
  assert.ok(ft, 'a file_touch behavior_event was emitted for the Read');
  assert.ok(ft.r != null, 'WP-1B workspace-relative path went live once ctx.workspaceRoot was set');
  assert.equal(String(ft.r).toLowerCase(), 'src/app.ts', 'path anchored under the resolved workspace root');
});

test('L2: WITHOUT a lineage resolver, workspace_id stays NULL and arg_path_workspace_rel is inert (honest degrade)', () => {
  const p = 'C:/home/.claude/projects/proj/L2.jsonl';
  const files = new Map([[p, vfile([
    userMsg('l2u1', 'read the app entrypoint', WORKER_CWD),
    assistantTool('l2a1', 'Read', { file_path: 'C:/proj/src/app.ts' }, { cwd: WORKER_CWD, stop: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
  ])]]);
  const sid = scanner.normalizeStreamId(p);
  runner.runIncrementalParse(baseDeps(files, [metaFor(p)])); // no resolveWorkspaceLineage dep
  const lane = one(`SELECT workspace_id FROM stream_lane_stats WHERE stream_id=?`, sid)!;
  assert.equal(lane.workspace_id, null, 'no resolver → no workspace attribution guessed');
  const ft = one(`SELECT arg_path_workspace_rel r FROM behavior_events WHERE stream_id=? AND kind='file_touch'`, sid)!;
  assert.equal(ft.r, null, 'no root known → workspace-relative leg stays inert (WP-1B)');
});

// ── runner ──────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-runner-'));
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
  runner = require('./parse-runner');
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
