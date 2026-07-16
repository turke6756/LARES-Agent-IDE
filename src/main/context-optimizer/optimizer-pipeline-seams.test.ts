// optimizer-pipeline-seams.test.ts — WP6 acceptance leg. Unit coverage for the
// SEAM #9 remainder readers + aggregators added to optimizer-pipeline.ts:
//   • aggregateFileTouches  — per-event rows → one FileTouch per distinct path
//   • toBypassExecEvents    — raw executed rows → narrowed BypassExecEvent[]
//   • querySkillInvocationWindows / querySkillLaneExposures / laneTurnTotal — real SQL
//
// The DB-touching helpers are exercised against the REAL better-sqlite3 DDL via the
// same sql.js (wasm SQLite) stand-in the skill-analytics suites use — so a wrong
// column name (which `tsc` cannot catch) fails here rather than at runtime.
//
//   npm run build:main
//   node dist/main/main/context-optimizer/optimizer-pipeline-seams.test.js

import assert from 'node:assert/strict';

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

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

type DbMod = { initDatabase(): void; getDb(): FakeDb };
let dbm: DbMod;
let pipeline: typeof import('./optimizer-pipeline');
let assemble: typeof import('./optimizer-assemble');
let resident: typeof import('./resident-assets');

// ── WP-3 (P3) fixtures: a minimal AgentContextOverhead carrying only `mcpServers`
//    (the sole field buildToolsetResidentTokens reads). ─────────────────────────
type McpServerOverhead = import('../../shared/types').McpServerOverhead;
type AgentContextOverhead = import('../../shared/types').AgentContextOverhead;
function srv(displayName: string, tokens: number, over: Partial<McpServerOverhead> = {}): McpServerOverhead {
  return {
    id: `dashboard:${displayName}`, displayName, source: 'dashboard-injected', configPath: null,
    grantedToAgent: true, excludedByStrictMode: false, schemaSourced: true,
    total: { tokens } as unknown as McpServerOverhead['total'], tools: [], warnings: [],
    ...over,
  };
}
function agentWith(servers: McpServerOverhead[]): AgentContextOverhead {
  return { mcpServers: servers } as unknown as AgentContextOverhead;
}

// ── row insert helpers ─────────────────────────────────────────────────────────
function lane(streamId: string, laneName: string, isSub = 0): void {
  dbm.getDb().prepare(
    `INSERT INTO stream_lane_stats (stream_id, lane, turn_count, is_subagent) VALUES (?, ?, 0, ?)`,
  ).run(streamId, laneName, isSub);
}
// stream_lane_stats row carrying workspace identity (WP-4A scoping fixtures).
function laneWs(streamId: string, laneName: string, o: { workspaceId?: string; method?: string; slug?: string }): void {
  dbm.getDb().prepare(
    `INSERT INTO stream_lane_stats (stream_id, lane, turn_count, is_subagent, workspace_id, workspace_attribution_method, slug)
     VALUES (?, ?, 0, 0, ?, ?, ?)`,
  ).run(streamId, laneName, o.workspaceId ?? null, o.method ?? null, o.slug ?? null);
}
let evtSeq = 0;
function fileTouch(o: {
  stream: string; ts: number; path: string; access: string; conf?: string; sub?: string | null;
}): void {
  dbm.getDb().prepare(
    `INSERT INTO behavior_events
       (id, stream_id, byte_offset, ts_ms, kind, arg_path, access_mode, arg_path_confidence, sub_agent_name, observable)
     VALUES (?, ?, 0, ?, 'file_touch', ?, ?, ?, ?, 1)`,
  ).run(`ft${evtSeq++}`, o.stream, o.ts, o.path, o.access, o.conf ?? 'exact', o.sub ?? null);
}
function turnOutcome(stream: string, ts: number): void {
  dbm.getDb().prepare(
    `INSERT INTO behavior_events (id, stream_id, byte_offset, ts_ms, kind, observable)
     VALUES (?, ?, 0, ?, 'turn_outcome', 1)`,
  ).run(`to${evtSeq++}`, stream, ts);
}
function skillInv(o: { stream: string; skill: string; ts: number; start?: number; end?: number }): void {
  dbm.getDb().prepare(
    `INSERT INTO skill_invocations
       (id, stream_id, jsonl_path, ts_ms, skill_name, detector, start_ts_ms, end_ts_ms, window_last_ts)
     VALUES (?, ?, ?, ?, ?, 'tool_use', ?, ?, ?)`,
  ).run(`si${evtSeq++}`, o.stream, `/x/${o.stream}.jsonl`, o.ts, o.skill, o.start ?? null, o.end ?? null, o.end ?? null);
}

// ── tests ───────────────────────────────────────────────────────────────────────

test('aggregateFileTouches rolls reads/writes/executes + distinct streams per path (pure)', () => {
  const rows: import('./optimizer-pipeline').FileTouchRow[] = [
    { streamId: 's1', tsMs: 1, path: '/a.py', lane: 'worker', subAgentName: null, accessMode: 'executed', argPathConfidence: 'exact' },
    { streamId: 's2', tsMs: 2, path: '/a.py', lane: 'worker', subAgentName: null, accessMode: 'executed', argPathConfidence: 'exact' },
    { streamId: 's1', tsMs: 3, path: '/a.py', lane: 'worker', subAgentName: null, accessMode: 'read', argPathConfidence: 'exact' },
    { streamId: 's1', tsMs: 4, path: '/b.md', lane: 'worker', subAgentName: null, accessMode: 'write', argPathConfidence: 'exact' },
  ];
  const out = pipeline.aggregateFileTouches(rows);
  assert.equal(out.length, 2);
  const a = out.find((t) => t.path === '/a.py')!;
  assert.deepEqual([a.reads, a.writes, a.executes, a.distinctStreams], [1, 0, 2, 2]);
  const b = out.find((t) => t.path === '/b.md')!;
  assert.deepEqual([b.reads, b.writes, b.executes, b.distinctStreams], [0, 1, 0, 1]);
  // sorted by path
  assert.deepEqual(out.map((t) => t.path), ['/a.py', '/b.md']);
});

test('toBypassExecEvents keeps only executed rows + narrows arg_path_confidence (pure)', () => {
  const rows: import('./optimizer-pipeline').FileTouchRow[] = [
    { streamId: 's1', tsMs: 1, path: '/a.py', lane: 'worker', subAgentName: null, accessMode: 'executed', argPathConfidence: 'exact' },
    { streamId: 's1', tsMs: 2, path: '/a.py', lane: 'worker', subAgentName: null, accessMode: 'read', argPathConfidence: 'exact' },
    { streamId: 's2', tsMs: 3, path: '/a.py', lane: 'worker', subAgentName: null, accessMode: 'executed', argPathConfidence: 'unresolved' },
  ];
  const out = pipeline.toBypassExecEvents(rows);
  assert.equal(out.length, 2, 'read row dropped');
  assert.equal(out[0].argPathConfidence, 'exact');
  assert.equal(out[1].argPathConfidence, 'unknown', 'unresolved → unknown (G1 drops it)');
  assert.ok(out.every((e) => e.accessMode === 'executed'));
});

test('queryFileTouches + queryBypassExecEvents read the real behavior_events schema', () => {
  lane('w1', 'worker');
  lane('w2', 'worker');
  lane('sup1', 'supervisor');
  fileTouch({ stream: 'w1', ts: 100, path: '/repo/.dashboard/skills/read-comments/read-comments.py', access: 'executed' });
  fileTouch({ stream: 'w2', ts: 101, path: '/repo/.dashboard/skills/read-comments/read-comments.py', access: 'executed' });
  fileTouch({ stream: 'w1', ts: 102, path: '/repo/src/app.ts', access: 'read' });
  fileTouch({ stream: 'sup1', ts: 103, path: '/repo/other.py', access: 'executed' });

  const workerTouches = pipeline.queryFileTouches(dbm.getDb() as unknown as import('./optimizer-pipeline').PipelineDb, 'worker');
  assert.equal(workerTouches.length, 3, 'only worker-lane rows');
  // arg_path is LOWER()ed by the reader.
  assert.ok(workerTouches.every((t) => t.path === t.path.toLowerCase()));

  const exec = pipeline.queryBypassExecEvents(dbm.getDb() as unknown as import('./optimizer-pipeline').PipelineDb, 'worker');
  assert.equal(exec.length, 2, 'only executed worker rows');
  assert.ok(exec.every((e) => e.accessMode === 'executed'));
});

test('querySkillInvocationWindows returns ts bounds; falls back when start/end null', () => {
  lane('k1', 'researcher');
  skillInv({ stream: 'k1', skill: 'read-comments', ts: 500, start: 500, end: 560 });
  skillInv({ stream: 'k1', skill: 'deep-research', ts: 700 }); // no start/end → fall back to ts
  const wins = pipeline.querySkillInvocationWindows(dbm.getDb() as unknown as import('./optimizer-pipeline').PipelineDb, 'researcher');
  assert.equal(wins.length, 2);
  const rc = wins.find((w) => w.skillName === 'read-comments')!;
  assert.deepEqual([rc.startTsMs, rc.endTsMs], [500, 560]);
  const dr = wins.find((w) => w.skillName === 'deep-research')!;
  assert.deepEqual([dr.startTsMs, dr.endTsMs], [700, 700], 'null bounds fall back to ts_ms');
});

test('laneTurnTotal + querySkillLaneExposures: resident skill exposed every lane turn', () => {
  lane('t1', 'supervisor');
  lane('t2', 'supervisor');
  turnOutcome('t1', 10); turnOutcome('t1', 20); turnOutcome('t2', 30);
  const db = dbm.getDb() as unknown as import('./optimizer-pipeline').PipelineDb;
  assert.equal(pipeline.laneTurnTotal(db, 'supervisor'), 3);
  const exp = pipeline.querySkillLaneExposures(db, 'supervisor', ['run-orchestration', 'run-orchestration', 'create-persona']);
  assert.equal(exp.length, 2, 'de-duped skill names');
  assert.ok(exp.every((e) => e.exposureTurns === 3 && e.lane === 'supervisor'));
});

test('buildToolsetResidentTokens keys by resolved toolset, skips strict-excluded + zero (pure, WP-3 P3)', () => {
  const agent = agentWith([
    srv('orchestration', 9000),
    srv('browser', 1500),
    srv('teams', 4000, { excludedByStrictMode: true }),        // strict-excluded ⇒ omitted
    srv('empty-toolset', 0),                                     // zero-token ⇒ omitted
    srv('some-global', 700, { source: 'user-global', schemaSourced: false }), // unknown resolution ⇒ display key
  ]);
  // Dashboard toolsets resolve display→toolset (identity); globals resolve to null.
  const resolve = (display: string) =>
    (['orchestration', 'browser'].includes(display) ? display : null);
  const map = assemble.buildToolsetResidentTokens(agent, resolve);
  assert.deepEqual(map, { orchestration: 9000, browser: 1500, 'some-global': 700 });
  assert.equal('teams' in map, false, 'strict-excluded server carries no schema cost');
  assert.equal('empty-toolset' in map, false, 'zero-token server omitted (fallback is honest)');
});

// ── WP-3 (P3) resident-assets: buildResidentAssets (pure) + join (DB) ────────────

type OverheadSource = import('../../shared/types').OverheadSource;
type ResidentAsset = import('../../shared/types').ResidentAsset;
type QueryDb = import('./behavior-store').QueryDb;

function hdr(kind: string, resolvedPath: string, tokens: number): OverheadSource {
  return { kind, resolvedPath, estimate: { tokens } } as unknown as OverheadSource;
}
function agentWithSources(servers: McpServerOverhead[], flatSources: OverheadSource[]): AgentContextOverhead {
  return { mcpServers: servers, flatSources } as unknown as AgentContextOverhead;
}

test('buildResidentAssets: resolved mcp-toolset keys (strict/zero skipped) + deduped skill-advertisement (zero-token/body skipped) (pure)', () => {
  const agent = agentWithSources(
    [
      srv('orchestration', 9000),
      srv('teams', 4000, { excludedByStrictMode: true }),  // strict-excluded ⇒ omitted
      srv('empty', 0),                                      // zero-token ⇒ omitted
    ],
    [
      hdr('skill-header', 'C:/ws/.claude/skills/deep-research/SKILL.md', 140),
      hdr('skill-header', 'C:/ws/.claude/skills/deep-research/SKILL.md', 90),  // dup skill, smaller ⇒ ignored
      hdr('skill-header', 'C:/ws/.claude/skills/gws/SKILL.md', 0),             // zero-token ⇒ skipped
      hdr('skill-body', 'C:/ws/.claude/skills/deep-research/SKILL.md', 500),   // not a header ⇒ skipped
    ],
  );
  const resolve = (d: string) => (d === 'orchestration' ? 'orchestration' : null);
  const assets = resident.buildResidentAssets(agent, 'supervisor', resolve);

  const toolsets = assets.filter((a) => a.kind === 'mcp-toolset');
  assert.equal(toolsets.length, 1, 'strict-excluded + zero-token toolsets dropped');
  assert.equal(toolsets[0].kind === 'mcp-toolset' && toolsets[0].toolset, 'orchestration');
  assert.equal(toolsets[0].kind === 'mcp-toolset' && toolsets[0].schemaTokens, 9000);

  const skills = assets.filter((a) => a.kind === 'skill-advertisement');
  assert.equal(skills.length, 1, 'deduped by skill; zero-token + body dropped');
  const s = skills[0];
  assert.equal(s.kind === 'skill-advertisement' && s.skillName, 'deep-research');
  assert.equal(s.kind === 'skill-advertisement' && s.headerTokens, 140, 'largest header wins on collision');
});

test('joinSkillAdvertisementUsage: coverage/uses/lastUsedAt from the strict spine; skill-advertisement only', () => {
  // Uses the otherwise-untouched 'legacy' lane so no earlier test's rows pollute the spine.
  lane('js1', 'legacy');
  lane('js2', 'legacy');
  lane('jsub', 'legacy', 1);                         // subagent ⇒ excluded from the strict spine
  turnOutcome('js1', 10); turnOutcome('js1', 20); turnOutcome('js2', 30);   // 3 top-level turns
  skillInv({ stream: 'js1', skill: 'deep-research', ts: 15 });
  skillInv({ stream: 'js1', skill: 'deep-research', ts: 25 });              // 2 uses, last=25, all in js1
  // js2 surfaces no captured skill ⇒ streamsWithSkills=1 of 2 ⇒ coverage 50%.

  const assets: ResidentAsset[] = [
    { kind: 'skill-advertisement', skillName: 'deep-research', headerTokens: 140, lanes: ['legacy'], sourcePath: '/x/deep-research/SKILL.md' },
    { kind: 'skill-advertisement', skillName: 'gws', headerTokens: 80, lanes: ['legacy'], sourcePath: '/x/gws/SKILL.md' },
    { kind: 'mcp-toolset', toolset: 'orchestration', schemaTokens: 9000, lane: 'legacy', members: [] },  // NOT joined
  ];
  const usage = resident.joinSkillAdvertisementUsage(dbm.getDb() as unknown as QueryDb, 'legacy', assets);
  assert.equal(usage.length, 2, 'only skill-advertisement assets are joined (toolset excluded)');

  const dr = usage.find((u) => u.asset.kind === 'skill-advertisement' && u.asset.skillName === 'deep-research')!;
  assert.equal(dr.observedUses, 2);
  assert.equal(dr.lastUsedAt, 25);
  assert.equal(dr.eligibleExposureTurns, 3, 'top-level turn_outcome count');
  assert.equal(dr.usageCoveragePct, 50, '1 of 2 top-level streams surfaces a skill');
  assert.equal(dr.exposureApproximate, true);
  assert.equal(dr.scopeMeta.workspaceKeyIsSlugProxy, true);

  const gws = usage.find((u) => u.asset.kind === 'skill-advertisement' && u.asset.skillName === 'gws')!;
  assert.equal(gws.observedUses, 0);
  assert.equal(gws.lastUsedAt, null);
  assert.equal(gws.usageCoveragePct, 50, 'coverage is lane-level, shared across skills');
});

// ── WP-4A (Phase 4) workspace-scoped queryFileTouchesScoped ──────────────────────
// Runs AFTER joinSkillAdvertisementUsage so the file-touch rows these tests add to the
// otherwise-empty 'legacy' lane never precede (and so never pollute) that lane's spine.

test('queryFileTouchesScoped: strict scope keeps only the workspace + honest counts (WP-4A)', () => {
  type Db = import('./optimizer-pipeline').PipelineDb;
  const db = dbm.getDb() as unknown as Db;
  laneWs('lg_a1', 'legacy', { workspaceId: 'wsA', method: 'root' });
  laneWs('lg_a2', 'legacy', { workspaceId: 'wsA', method: 'root' });
  laneWs('lg_o1', 'legacy', { workspaceId: 'wsOther', method: 'root' });
  laneWs('lg_u1', 'legacy', {}); // unattributed
  fileTouch({ stream: 'lg_a1', ts: 200, path: '/wsa/x.ts', access: 'read' });
  fileTouch({ stream: 'lg_a2', ts: 201, path: '/wsa/y.ts', access: 'write' });
  fileTouch({ stream: 'lg_o1', ts: 202, path: '/other/z.ts', access: 'read' });
  fileTouch({ stream: 'lg_u1', ts: 203, path: '/none/w.ts', access: 'executed' });

  const strict = pipeline.queryFileTouchesScoped(db, 'legacy', { workspaceId: 'wsA', scopeMode: 'strict' });
  assert.deepEqual(strict.rows.map((r) => r.path).sort(), ['/wsa/x.ts', '/wsa/y.ts']);
  assert.equal(strict.scope.droppedUnattributed, 1);  // only lg_u1 (wsOther has a real id, just different)
  assert.equal(strict.scope.proxyIncluded, 0);
  assert.equal(strict.scope.realIdCount, 3);
  assert.equal(strict.scope.breakdown['workspace-from-root'], 3);
  assert.equal(strict.scope.breakdown['workspace-unattributed'], 1);

  const global = pipeline.queryFileTouchesScoped(db, 'legacy', { workspaceId: 'wsA', scopeMode: 'global-diagnostic' });
  assert.equal(global.rows.length, 4);
  assert.equal(global.scope.droppedUnattributed, 0);

  const unscoped = pipeline.queryFileTouchesScoped(db, 'legacy', {});
  assert.equal(unscoped.rows.length, 4);
  assert.equal(unscoped.scope.droppedUnattributed, 0);
});

test('queryFileTouchesScoped: include-proxy admits a uniquely-mapped slug (WP-4A)', () => {
  type Db = import('./optimizer-pipeline').PipelineDb;
  const db = dbm.getDb() as unknown as Db;
  // SHARES the DB with the strict test above (legacy lane already has lg_a1/a2/o1/u1). Use a
  // DISTINCT slug + streams and assert on row membership + proxy/strict deltas for THESE rows.
  laneWs('lg_b1', 'legacy', { workspaceId: 'wsB', method: 'root', slug: 'slug-b' });
  laneWs('lg_p1', 'legacy', { slug: 'slug-b' });   // proxy-only (no real id)
  fileTouch({ stream: 'lg_b1', ts: 300, path: '/wsb/a.ts', access: 'read' });
  fileTouch({ stream: 'lg_p1', ts: 301, path: '/wsb/b.ts', access: 'read' });

  const proxy = pipeline.queryFileTouchesScoped(db, 'legacy',
    { workspaceId: 'wsB', slug: 'slug-b', scopeMode: 'include-proxy' });
  const paths = new Set(proxy.rows.map((r) => r.path));
  assert.ok(paths.has('/wsb/a.ts') && paths.has('/wsb/b.ts'), 'proxy row rescued');
  assert.equal(proxy.scope.proxyIncluded, 1);

  const strict = pipeline.queryFileTouchesScoped(db, 'legacy',
    { workspaceId: 'wsB', slug: 'slug-b', scopeMode: 'strict' });
  assert.ok(new Set(strict.rows.map((r) => r.path)).has('/wsb/a.ts'));
  assert.ok(!new Set(strict.rows.map((r) => r.path)).has('/wsb/b.ts'), 'proxy row denied under strict');
});

// ── runner ──────────────────────────────────────────────────────────────────────
(async () => {
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
  assemble = require('./optimizer-assemble');
  resident = require('./resident-assets');

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
