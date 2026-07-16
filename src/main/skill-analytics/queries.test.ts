// queries.test.ts — the WP3 read-only query layer + two-tier effectiveness (§P2.4)
// + A8 cost rollup. Seeds hand-crafted `skill_invocations` window rows directly
// (the finalize-time signals scoring reads) so the scoring/cost math is exercised
// deterministically. Uses the same sql.js better-sqlite3 stand-in as
// behavior-store.test.ts / parse-runner.test.ts, because better-sqlite3's native
// binding won't load under the system Node that `npm run test:supervisor` uses.
//
//   npm run build:main
//   node dist/main/main/skill-analytics/queries.test.js

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
let Q: typeof import('./queries');

// ── row builder — a finalized (or open) skill window with the scoring signals ──
let seq = 0;
interface InvOpts {
  skill: string;
  tsMs?: number;
  streamId?: string;
  sessionId?: string | null;
  slug?: string | null;
  workingDir?: string | null;
  workspaceRoot?: string | null;
  detector?: string;
  windowOpen?: number;
  toolCalls?: number;
  errorResults?: number;
  endedWithQuestion?: number | null;
  repeatedSearch?: number | null;
  windowTruncated?: number;
  freshInput?: number;
  output?: number;
  cacheRead?: number;
  usageTurns?: number;
  args?: string | null;
}
function insertInv(o: InvOpts): void {
  const id = `inv${seq++}`;
  dbm.getDb().prepare(
    `INSERT INTO skill_invocations
      (id, stream_id, jsonl_path, session_id, ts_ms, skill_name, args, detector, slug, working_dir, workspace_root,
       window_open, window_tool_calls, window_error_results, ended_with_question, repeated_search,
       window_truncated, window_fresh_input_tokens, window_usage_output_tokens,
       window_cache_read_tokens, window_usage_turns)
     VALUES (@id, @stream_id, @jsonl_path, @session_id, @ts_ms, @skill_name, @args, @detector, @slug, @working_dir, @workspace_root,
       @window_open, @window_tool_calls, @window_error_results, @ended_with_question, @repeated_search,
       @window_truncated, @window_fresh_input_tokens, @window_usage_output_tokens,
       @window_cache_read_tokens, @window_usage_turns)`,
  ).run({
    id,
    stream_id: o.streamId ?? `s-${id}`,
    jsonl_path: `/p/${id}.jsonl`,
    session_id: o.sessionId === undefined ? null : o.sessionId,
    ts_ms: o.tsMs ?? 1000,
    skill_name: o.skill,
    args: o.args ?? null,
    detector: o.detector ?? 'tool_use',
    slug: o.slug === undefined ? 'projA' : o.slug,   // honor an explicit null (coalesce-fallback test)
    working_dir: o.workingDir ?? 'C:/projA/.dashboard/workers/claude',
    workspace_root: o.workspaceRoot ?? null,
    window_open: o.windowOpen ?? 0,
    window_tool_calls: o.toolCalls ?? 0,
    window_error_results: o.errorResults ?? 0,
    ended_with_question: o.endedWithQuestion ?? null,
    repeated_search: o.repeatedSearch ?? null,
    window_truncated: o.windowTruncated ?? 0,
    window_fresh_input_tokens: o.freshInput ?? 0,
    window_usage_output_tokens: o.output ?? 0,
    window_cache_read_tokens: o.cacheRead ?? 0,
    window_usage_turns: o.usageTurns ?? 0,
  });
}
// Seed the single home of `lane` (stream_lane_stats). Skill-legibility B1 joins
// every aggregate to this table, so agent-type / lane-filter tests must seed it.
function insertLane(streamId: string, lane: string, opts: { slug?: string | null; workingDir?: string | null } = {}): void {
  dbm.getDb().prepare(
    `INSERT INTO stream_lane_stats (stream_id, lane, slug, working_dir, turn_count)
     VALUES (@stream_id, @lane, @slug, @working_dir, @turn_count)`,
  ).run({
    stream_id: streamId,
    lane,
    slug: opts.slug ?? null,
    working_dir: opts.workingDir ?? null,
    turn_count: 1,
  });
}
// Seed the agents-join (session_id → agent_sessions → agents → workspaces) — the WP-D
// authoritative workspace attribution, mirroring the sibling mcp-tool-usage test.
function insertAgentSession(o: { agentId: string; sessionId: string; generation?: number }): void {
  dbm.getDb().prepare(
    `INSERT INTO agent_sessions (dashboard_agent_id, generation, session_id, working_directory, provider)
     VALUES (@a, @g, @s, @wd, @p)`,
  ).run({ a: o.agentId, g: o.generation ?? 1, s: o.sessionId, wd: '/cwd', p: 'claude' });
}
function insertAgent(o: { id: string; title: string; workspaceId: string }): void {
  dbm.getDb().prepare(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command)
     VALUES (@id, @ws, @title, @slug, @wd, @cmd)`,
  ).run({ id: o.id, ws: o.workspaceId, title: o.title, slug: 'ag', wd: '/cwd', cmd: 'claude' });
}
function insertWorkspace(o: { id: string; title: string }): void {
  dbm.getDb().prepare(
    `INSERT INTO workspaces (id, title, path, path_type) VALUES (@id, @title, @path, @pt)`,
  ).run({ id: o.id, title: o.title, path: '/ws', pt: 'windows' });
}
function queries(): import('./queries').SkillUsageQueries {
  return new Q.SkillUsageQueries(dbm.getDb() as unknown as import('./queries').QueryDb);
}

// ── scoreObservable unit math (§P2.4) ──
test('scoreObservable — clean productive window scores the ceiling (1.0)', () => {
  const s = Q.scoreObservable({ skill: 'x', windowOpen: 0, toolCalls: 3, errorResults: 0, endedWithQuestion: 0, repeatedSearch: 0, windowTruncated: 0, freshInput: 0, output: 0, cacheRead: 0, usageTurns: 1 });
  assert.equal(s, 1.0);
});
test('scoreObservable — penalties subtract; open window is not scorable (null)', () => {
  const w = { skill: 'x', windowOpen: 0, toolCalls: 3, errorResults: 2, endedWithQuestion: 1, repeatedSearch: 1, windowTruncated: 0, freshInput: 0, output: 0, cacheRead: 0, usageTurns: 1 };
  // base .5 + positive .5 (toolCalls-errors=1 clean) - error .25 - repeat .15 - question .15 = 0.45
  assert.ok(Math.abs((Q.scoreObservable(w) as number) - 0.45) < 1e-9);
  assert.equal(Q.scoreObservable({ ...w, windowOpen: 1 }), null);
});
test('scoreObservable — stale window (no clean end_turn) forfeits the positive', () => {
  const s = Q.scoreObservable({ skill: 'x', windowOpen: 0, toolCalls: 3, errorResults: 0, endedWithQuestion: 0, repeatedSearch: 0, windowTruncated: 1, freshInput: 0, output: 0, cacheRead: 0, usageTurns: 1 });
  assert.equal(s, 0.5); // base only
});

// ── effectiveness aggregation — two tiers, never blended ──
test('effectiveness — observable composite is the mean over finalized windows; raw inputs surfaced', () => {
  insertInv({ skill: 'alpha', toolCalls: 2, errorResults: 0, windowTruncated: 0 });            // 1.0
  insertInv({ skill: 'alpha', toolCalls: 2, errorResults: 1, windowTruncated: 0 });            // clean+positive(1) -error = .75
  insertInv({ skill: 'alpha', windowOpen: 1 });                                                // not scorable
  const eff = queries().effectiveness({});
  const a = eff.find((e) => e.skill === 'alpha')!;
  assert.equal(a.scoredInvocations, 2, 'the open window is excluded from scoring');
  assert.ok(Math.abs(a.observableScore! - (1.0 + 0.75) / 2) < 1e-9);
  assert.equal(a.positiveWindows, 2);
  assert.equal(a.errorWindows, 1);
  assert.deepEqual(a.heuristic, { userCorrection: 0, workflowFollowed: 0 }, 'heuristic tier surfaced (empty), never folded in');
});

test('effectiveness — cache-read spend never moves the observable score (never-blend)', () => {
  insertInv({ skill: 'beta', toolCalls: 1, errorResults: 0, windowTruncated: 0, cacheRead: 0, freshInput: 10, output: 5 });
  insertInv({ skill: 'gamma', toolCalls: 1, errorResults: 0, windowTruncated: 0, cacheRead: 9_000_000, freshInput: 10, output: 5 });
  const eff = queries().effectiveness({});
  const b = eff.find((e) => e.skill === 'beta')!;
  const g = eff.find((e) => e.skill === 'gamma')!;
  assert.equal(b.observableScore, g.observableScore, 'huge cache_read leaves the composite identical');
});

// ── A8 cost rollup — median + spread, four fields separate, never blended ──
test('cost — per-skill median + IQR; fresh input separate from output and cache reads', () => {
  for (const [fi, o, cr] of [[100, 10, 5000], [200, 20, 6000], [300, 30, 7000]] as const) {
    insertInv({ skill: 'delta', freshInput: fi, output: o, cacheRead: cr, usageTurns: 1 });
  }
  insertInv({ skill: 'delta', windowOpen: 0, usageTurns: 0, freshInput: 999999 }); // no usage → excluded from cost
  const cost = queries().cost({});
  const d = cost.find((c) => c.skill === 'delta')!;
  assert.equal(d.invocations, 3, 'the zero-usage window is excluded');
  assert.equal(d.freshMedian, 220, 'median of fresh spend (110,220,330)');   // (fi+o): 110,220,330
  assert.equal(d.freshP25, 165);
  assert.equal(d.freshP75, 275);
  assert.equal(d.freshInputMedian, 200);
  assert.equal(d.outputMedian, 20);
  assert.equal(d.cacheReadMedian, 6000);
});

// ── mostUsed / timeline / groupings / filters ──
test('mostUsed — counts, avgEffectiveness, lastUsedMs', () => {
  insertInv({ skill: 'eps', tsMs: 100, toolCalls: 1, windowTruncated: 0 });   // 1.0
  insertInv({ skill: 'eps', tsMs: 300, toolCalls: 1, windowTruncated: 1 });   // 0.5
  const res = queries().run({});
  const e = res.mostUsed.find((m) => m.skill === 'eps')!;
  assert.equal(e.count, 2);
  assert.equal(e.lastUsedMs, 300);
  assert.ok(Math.abs(e.avgEffectiveness! - 0.75) < 1e-9);
});

test('timeline — ascending, not truncated for a small corpus', () => {
  insertInv({ skill: 'zeta', tsMs: 500 });
  insertInv({ skill: 'zeta', tsMs: 200 });
  const res = queries().run({});
  const tl = res.timeline.filter((r) => r.skill === 'zeta');
  assert.deepEqual(tl.map((r) => r.tsMs), [200, 500], 'ascending');
  assert.equal(res.timelineTruncated, false);
});

test('groupings — byWorkspace (slug proxy), byAgentDir, byInvoker(detector)', () => {
  insertInv({ skill: 'eta', slug: 'projX', workingDir: '/dirA', detector: 'tool_use' });
  insertInv({ skill: 'eta', slug: 'projX', workingDir: '/dirB', detector: 'slash_command' });
  const res = queries().run({});
  assert.ok(res.byWorkspace.find((g) => g.key === 'projX')!.count >= 2);
  assert.ok(res.byAgentDir.find((g) => g.key === '/dirA'));
  assert.ok(res.byInvoker.find((g) => g.key === 'slash_command'));
});

test('filters — slug + time window narrow the result', () => {
  insertInv({ skill: 'theta', slug: 'in', tsMs: 1000 });
  insertInv({ skill: 'theta', slug: 'out', tsMs: 1000 });
  insertInv({ skill: 'theta', slug: 'in', tsMs: 5000 });
  const bySlug = queries().run({ slug: 'in' });
  assert.equal(bySlug.mostUsed.find((m) => m.skill === 'theta')!.count, 2);
  const byWindow = queries().run({ slug: 'in', sinceMs: 2000, untilMs: 6000 });
  assert.equal(byWindow.mostUsed.find((m) => m.skill === 'theta')!.count, 1);
});

test('contextSamples — carries args + detector for the panel', () => {
  insertInv({ skill: 'iota', detector: 'slash_command', args: '{"q":"hi"}' });
  const res = queries().run({ slug: 'projA' });
  const s = res.contextSamples.find((c) => c.skill === 'iota')!;
  assert.equal(s.detector, 'slash_command');
  assert.equal(s.args, '{"q":"hi"}');
});

// ── skill-legibility B1/B2 — lane (agent-type) join + filter ──
test('byAgentType — comes straight from sls.lane; no lane row → unknown', () => {
  for (const lane of ['supervisor', 'worker', 'researcher', 'legacy'] as const) {
    const sid = `atype-${lane}`;
    insertInv({ skill: `at-${lane}`, streamId: sid, slug: `atslug-${lane}` });
    insertLane(sid, lane, { slug: `atslug-${lane}` });
  }
  insertInv({ skill: 'at-none', streamId: 'atype-none', slug: 'atslug-none' }); // no lane row
  const res = queries().run({ slug: undefined });
  const byType = new Map(res.byAgentType.map((g) => [g.key, g.count]));
  for (const lane of ['supervisor', 'worker', 'researcher', 'legacy']) {
    assert.ok((byType.get(lane) ?? 0) >= 1, `byAgentType has ${lane}`);
  }
  assert.ok((byType.get('unknown') ?? 0) >= 1, 'stream with no lane row groups under unknown');
});

test('lane filter — narrows every aggregate to that lane', () => {
  insertInv({ skill: 'lf-w', streamId: 'lf-w1', slug: 'lfW' });
  insertLane('lf-w1', 'worker', { slug: 'lfW' });
  insertInv({ skill: 'lf-s', streamId: 'lf-s1', slug: 'lfS' });
  insertLane('lf-s1', 'supervisor', { slug: 'lfS' });
  const res = queries().run({ lane: 'worker' });
  assert.ok(res.mostUsed.find((m) => m.skill === 'lf-w'), 'worker skill present');
  assert.ok(!res.mostUsed.find((m) => m.skill === 'lf-s'), 'supervisor skill excluded');
  assert.ok(res.timeline.every((r) => r.lane === 'worker'), 'timeline is worker-only');
  assert.equal(res.scopeMeta.appliedLane, 'worker');
});

test("lane:'unknown' — returns only streams with no/unknown lane, not everything", () => {
  insertInv({ skill: 'lu-known', streamId: 'lu-k1', slug: 'luK' });
  insertLane('lu-k1', 'worker', { slug: 'luK' });
  insertInv({ skill: 'lu-unknown', streamId: 'lu-u1', slug: 'luU' }); // no lane row
  const res = queries().run({ lane: 'unknown' });
  assert.ok(res.mostUsed.find((m) => m.skill === 'lu-unknown'), 'unattributed present');
  assert.ok(!res.mostUsed.find((m) => m.skill === 'lu-known'), 'worker excluded from unknown');
});

// ── skill-legibility B4 — enriched timeline rows ──
test('timeline rows carry lane, workspaceKey, detector, id, jsonlPath', () => {
  insertInv({ skill: 'tlrich', streamId: 'tl-r1', slug: 'tlSlug', detector: 'slash_command', tsMs: 4242 });
  insertLane('tl-r1', 'researcher', { slug: 'tlSlug' });
  const res = queries().run({ slug: 'tlSlug' });
  const r = res.timeline.find((x) => x.skill === 'tlrich')!;
  assert.equal(r.lane, 'researcher');
  assert.equal(r.workspaceKey, 'tlSlug');
  assert.equal(r.detector, 'slash_command');
  assert.ok(r.id && r.id.length > 0, 'carries a source id');
  assert.ok(r.jsonlPath && r.jsonlPath.includes('.jsonl'), 'carries the source jsonl path');
});

// ── skill-legibility B5 — truthful scope accounting ──
test('scopeMeta — echoes the query and flags the slug proxy', () => {
  insertInv({ skill: 'sm', slug: 'smSlug', tsMs: 3000 });
  const res = queries().run({ slug: 'smSlug', sinceMs: 100, untilMs: 9000 });
  assert.equal(res.scopeMeta.workspaceKeyIsSlugProxy, true);
  assert.equal(res.scopeMeta.appliedSlug, 'smSlug');
  assert.equal(res.scopeMeta.windowSinceMs, 100);
  assert.equal(res.scopeMeta.windowUntilMs, 9000);
  assert.equal(res.scopeMeta.appliedLane, null);
});

// ── skill-legibility B2 — workspace coalesce fallback to sls.slug ──
test('byWorkspace — falls back to sls.slug when si.slug is null', () => {
  insertInv({ skill: 'wsfall', streamId: 'ws-f1', slug: null, workspaceRoot: null });
  insertLane('ws-f1', 'worker', { slug: 'lanedSlug' });
  const res = queries().run({});
  assert.ok(res.byWorkspace.find((g) => g.key === 'lanedSlug'), 'groups under the sls.slug, not (unknown)');
});

// ── WP-D fix leg — authoritative agents-join workspace scoping + dropped-count ──
test('workspaceId — scopes via the agents-join; unattributed rows disclosed, not hidden', () => {
  // Unique slug isolates this test's rows from the shared accumulating DB.
  const SL = 'wsScopeTest';
  insertWorkspace({ id: 'wsD', title: 'AgentDashboard' });
  insertAgent({ id: 'agentD', title: 'Worker', workspaceId: 'wsD' });
  insertAgentSession({ agentId: 'agentD', sessionId: 'sess-D1' });
  insertInv({ skill: 'run', streamId: 'wd-1', slug: SL, sessionId: 'sess-D1' });  // attributed → wsD
  insertInv({ skill: 'run', streamId: 'wd-2', slug: SL, sessionId: null });        // unattributed (no session)
  insertInv({ skill: 'gws', streamId: 'wd-3', slug: SL, sessionId: 'sess-none' }); // session not linked → unattributed

  const scoped = queries().run({ workspaceId: 'wsD', slug: SL });
  assert.equal(scoped.totalInvocations, 1, 'only the agents-join-attributed row is in scope');
  assert.equal(scoped.scopeMeta.appliedWorkspaceId, 'wsD');
  assert.equal(scoped.scopeMeta.droppedUnattributedCount, 2, 'the 2 no-workspace rows are disclosed');
  assert.equal(scoped.scopeMeta.hasAnyInvocations, true);

  const unscoped = queries().run({ slug: SL });
  assert.equal(unscoped.totalInvocations, 3, 'unscoped sees all three rows');
  assert.equal(unscoped.scopeMeta.droppedUnattributedCount, 0, 'nothing dropped when unscoped');
  assert.equal(unscoped.scopeMeta.appliedWorkspaceId, null);
});

test('workspaceId — the old dead-column path is gone: a scoped call no longer excludes every row', () => {
  // Regression guard for the WP-D bug: filtering on the structurally-NULL workspace_root
  // returned []. With agents-join scoping, a workspace with an attributed row sees it.
  const SL = 'wsDeadCol';
  insertWorkspace({ id: 'wsE', title: 'E' });
  insertAgent({ id: 'agentE', title: 'E', workspaceId: 'wsE' });
  insertAgentSession({ agentId: 'agentE', sessionId: 'sess-E1' });
  insertInv({ skill: 'deep-research', streamId: 'we-1', slug: SL, sessionId: 'sess-E1', workspaceRoot: null });
  const res = queries().run({ workspaceId: 'wsE', slug: SL });
  assert.equal(res.totalInvocations, 1, 'row surfaces despite workspace_root being NULL');
  assert.ok(res.mostUsed.find((m) => m.skill === 'deep-research'), 'the attributed skill is present');
});

// ── WP-2B — scopeMode parity (strict default preserved; include-proxy is opt-in) ──
test('scopeMode include-proxy — unique slug admits the proxy row; strict default excludes it', () => {
  const SL = 'wsProxyUniq';
  insertWorkspace({ id: 'wsF', title: 'F' });
  insertAgent({ id: 'agentF', title: 'F', workspaceId: 'wsF' });
  insertAgentSession({ agentId: 'agentF', sessionId: 'sess-F1' });
  insertInv({ skill: 'run', streamId: 'wf-1', slug: SL, sessionId: 'sess-F1' }); // attributed → wsF (real id)
  insertInv({ skill: 'run', streamId: 'wf-2', slug: SL, sessionId: null });      // unattributed (real id NULL), proxy candidate

  // Default is strict — the proxy row stays out and is disclosed, not admitted.
  const strict = queries().run({ workspaceId: 'wsF', slug: SL });
  assert.equal(strict.totalInvocations, 1, 'strict default excludes the proxy row');
  assert.equal(strict.scopeMeta.appliedScopeMode, 'strict');
  assert.equal(strict.scopeMeta.proxyIncludedCount, 0);
  assert.equal(strict.scopeMeta.droppedUnattributedCount, 1, 'the unattributed row is disclosed');

  // include-proxy — slug maps uniquely to wsF, so the proxy row is admitted.
  const proxy = queries().run({ workspaceId: 'wsF', slug: SL, scopeMode: 'include-proxy' });
  assert.equal(proxy.totalInvocations, 2, 'include-proxy admits the uniquely-mapping proxy row');
  assert.equal(proxy.scopeMeta.appliedScopeMode, 'include-proxy');
  assert.equal(proxy.scopeMeta.proxyIncludedCount, 1);
  assert.equal(proxy.scopeMeta.droppedUnattributedCount, 0, 'the admitted proxy row is no longer dropped');
});

test('scopeMode include-proxy — ambiguous slug is denied; no cross-workspace leakage', () => {
  const SL = 'wsProxyAmbig';
  insertWorkspace({ id: 'wsG', title: 'G' });
  insertWorkspace({ id: 'wsH', title: 'H' });
  insertAgent({ id: 'agentG', title: 'G', workspaceId: 'wsG' });
  insertAgent({ id: 'agentH', title: 'H', workspaceId: 'wsH' });
  insertAgentSession({ agentId: 'agentG', sessionId: 'sess-G1' });
  insertAgentSession({ agentId: 'agentH', sessionId: 'sess-H1' });
  insertInv({ skill: 'run', streamId: 'wg-1', slug: SL, sessionId: 'sess-G1' }); // → wsG (real id)
  insertInv({ skill: 'run', streamId: 'wh-1', slug: SL, sessionId: 'sess-H1' }); // → wsH (real id) — the leak source
  insertInv({ skill: 'run', streamId: 'wx-1', slug: SL, sessionId: null });      // unattributed proxy candidate

  // The slug maps to TWO workspaces, so the proxy leg is denied → falls back to strict.
  const res = queries().run({ workspaceId: 'wsG', slug: SL, scopeMode: 'include-proxy' });
  assert.equal(res.totalInvocations, 1, 'only the real wsG row — the ambiguous proxy row is NOT admitted');
  assert.equal(res.scopeMeta.appliedScopeMode, 'include-proxy');
  assert.equal(res.scopeMeta.proxyIncludedCount, 0, 'ambiguous slug never rescues a proxy row');
});

test('scopeMode global-diagnostic — ignores the workspace filter entirely', () => {
  const SL = 'wsGlobalDiag';
  insertWorkspace({ id: 'wsI', title: 'I' });
  insertWorkspace({ id: 'wsJ', title: 'J' });
  insertAgent({ id: 'agentI', title: 'I', workspaceId: 'wsI' });
  insertAgent({ id: 'agentJ', title: 'J', workspaceId: 'wsJ' });
  insertAgentSession({ agentId: 'agentI', sessionId: 'sess-I1' });
  insertAgentSession({ agentId: 'agentJ', sessionId: 'sess-J1' });
  insertInv({ skill: 'run', streamId: 'wi-1', slug: SL, sessionId: 'sess-I1' }); // → wsI
  insertInv({ skill: 'run', streamId: 'wj-1', slug: SL, sessionId: 'sess-J1' }); // → wsJ
  insertInv({ skill: 'run', streamId: 'wk-1', slug: SL, sessionId: null });      // unattributed

  const res = queries().run({ workspaceId: 'wsI', slug: SL, scopeMode: 'global-diagnostic' });
  assert.equal(res.totalInvocations, 3, 'global-diagnostic sees all three rows regardless of workspaceId');
  assert.equal(res.scopeMeta.appliedScopeMode, 'global-diagnostic');
  assert.equal(res.scopeMeta.droppedUnattributedCount, 0, 'nothing is dropped under global-diagnostic');
  assert.equal(res.scopeMeta.proxyIncludedCount, 0);
});

// ── runner ──
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'queries-test-'));
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
  Q = require('./queries');

  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
