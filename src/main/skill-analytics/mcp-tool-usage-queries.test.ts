// mcp-tool-usage-queries.test.ts — per-MCP-tool usage query layer
// (wave2-mcp-tool-observability §2.1 / §6). Seeds `behavior_events`,
// `stream_lane_stats`, `agent_sessions`, `agents`, `workspaces` against the REAL
// DDL (via database.initDatabase over the sql.js better-sqlite3 stand-in) so the
// SQL is exercised on the true schema — a build/tsc pass cannot catch a wrong
// column name (WB-06).
//
//   npm run build:main
//   node dist/main/main/skill-analytics/mcp-tool-usage-queries.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js better-sqlite3 stand-in (mirrors queries.test.ts) ──
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
let M: typeof import('./mcp-tool-usage-queries');

// ── seed helpers ──
let seq = 0;
function insertBe(o: {
  streamId: string; toolName: string; toolset?: string | null; sessionId?: string | null;
  slug?: string | null; tsMs?: number; kind?: string; toolKind?: string;
}): void {
  const id = `be${seq++}`;
  dbm.getDb().prepare(
    `INSERT INTO behavior_events (id, stream_id, byte_offset, ts_ms, kind, tool_name, tool_kind, mcp_toolset, session_id, slug)
     VALUES (@id, @stream_id, @byte_offset, @ts_ms, @kind, @tool_name, @tool_kind, @mcp_toolset, @session_id, @slug)`,
  ).run({
    id, stream_id: o.streamId, byte_offset: seq, ts_ms: o.tsMs ?? 1000,
    kind: o.kind ?? 'tool_use', tool_name: o.toolName, tool_kind: o.toolKind ?? 'mcp',
    mcp_toolset: o.toolset === undefined ? null : o.toolset, session_id: o.sessionId ?? null, slug: o.slug ?? null,
  });
}
function insertSls(o: { streamId: string; lane: string; slug?: string | null; workingDir?: string | null; turnCount?: number; workspaceId?: string | null; workspaceRoot?: string | null; workspaceAttributionMethod?: string | null; }): void {
  dbm.getDb().prepare(
    `INSERT INTO stream_lane_stats (stream_id, lane, slug, working_dir, turn_count, workspace_id, workspace_root, workspace_attribution_method)
     VALUES (@stream_id, @lane, @slug, @working_dir, @turn_count, @workspace_id, @workspace_root, @workspace_attribution_method)`,
  ).run({
    stream_id: o.streamId, lane: o.lane, slug: o.slug ?? null, working_dir: o.workingDir ?? null,
    turn_count: o.turnCount ?? 0, workspace_id: o.workspaceId ?? null, workspace_root: o.workspaceRoot ?? null,
    workspace_attribution_method: o.workspaceAttributionMethod ?? null,
  });
}
function insertAgentSession(o: { agentId: string; sessionId: string; generation?: number; }): void {
  dbm.getDb().prepare(
    `INSERT INTO agent_sessions (dashboard_agent_id, generation, session_id, working_directory, provider)
     VALUES (@a, @g, @s, @wd, @p)`,
  ).run({ a: o.agentId, g: o.generation ?? 1, s: o.sessionId, wd: '/cwd', p: 'claude' });
}
function insertAgent(o: { id: string; title: string; workspaceId: string; slug?: string; }): void {
  dbm.getDb().prepare(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command)
     VALUES (@id, @ws, @title, @slug, @wd, @cmd)`,
  ).run({ id: o.id, ws: o.workspaceId, title: o.title, slug: o.slug ?? 'ag', wd: '/cwd', cmd: 'claude' });
}
function insertWorkspace(o: { id: string; title: string; path?: string; }): void {
  dbm.getDb().prepare(
    `INSERT INTO workspaces (id, title, path, path_type) VALUES (@id, @title, @path, @pt)`,
  ).run({ id: o.id, title: o.title, path: o.path ?? '/ws', pt: 'windows' });
}
function q(): import('./mcp-tool-usage-queries').McpToolUsageQueries {
  return new M.McpToolUsageQueries(dbm.getDb() as unknown as import('./queries').QueryDb);
}

// ── toolShortName unit ──
test('toolShortName strips the mcp__<server>__ prefix (server may have hyphens)', () => {
  assert.equal(M.toolShortName('mcp__agent-dashboard__browser_read_page'), 'browser_read_page');
  assert.equal(M.toolShortName('mcp__claude-in-chrome__navigate'), 'navigate');
  assert.equal(M.toolShortName('not_prefixed'), 'not_prefixed');
});

// ── byTool: counts, distinctStreams, toolset, toolShort ──
test('byTool — per-tool count, distinctStreams, toolset, short name', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertSls({ streamId: 's2', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__browser_open_url', toolset: 'browser' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__browser_open_url', toolset: 'browser' });
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__browser_open_url', toolset: 'browser' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  const res = q().run({});
  const open = res.byTool.find((t) => t.toolShort === 'browser_open_url')!;
  assert.equal(open.count, 3);
  assert.equal(open.distinctStreams, 2);
  assert.equal(open.toolset, 'browser');
  assert.equal(open.toolName, 'mcp__agent-dashboard__browser_open_url');
  assert.equal(res.totalCalls, 4);
});

// ── byToolset assembled from byTool with drill children ──
test('byToolset — drill children come from byTool grouped by toolset', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__browser_open_url', toolset: 'browser' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__browser_read_page', toolset: 'browser' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  const res = q().run({});
  const browser = res.byToolset.find((r) => r.toolset === 'browser')!;
  assert.equal(browser.count, 2);
  assert.equal(browser.tools.length, 2);
  assert.ok(browser.tools.every((t) => t.toolset === 'browser'));
});

// ── null toolset (unresolved MCP tool) stays visible, keyed on null ──
test('byToolset — an unresolved tool keeps a null-toolset bucket (never dropped)', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__mystery_tool', toolset: null });
  const res = q().run({});
  const nullBucket = res.byToolset.find((r) => r.toolset === null)!;
  assert.ok(nullBucket, 'null-toolset bucket present');
  assert.equal(nullBucket.count, 1);
});

// ── byAgent: attributed via session join; unmatched → (unattributed), not dropped ──
test('byAgent — session join attributes; unmatched streams collapse to (unattributed)', () => {
  insertWorkspace({ id: 'ws1', title: 'Workspace One' });
  insertAgent({ id: 'agentA', title: 'Alpha Worker', workspaceId: 'ws1' });
  insertAgentSession({ agentId: 'agentA', sessionId: 'sess-A' });
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertSls({ streamId: 's2', lane: 'worker', slug: 'projA' });
  // attributed (session resolves to agentA)
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  // unattributed (session not in agent_sessions)
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-orphan' });
  const res = q().run({});
  const alpha = res.byAgent.find((r) => r.agentId === 'agentA')!;
  assert.equal(alpha.label, 'Alpha Worker');
  assert.equal(alpha.count, 2);
  const un = res.byAgent.find((r) => r.agentId == null)!;
  assert.equal(un.key, '(unattributed)');
  assert.equal(un.count, 1);
  assert.equal(res.totalCalls, 3);
  assert.equal(res.attributedCalls, 2);
});

// ── filters: lane / slug / agentId / workspaceId / window narrow everything ──
test('filters — lane narrows every aggregate', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertSls({ streamId: 's2', lane: 'supervisor', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  const res = q().run({ lane: 'worker' });
  assert.equal(res.totalCalls, 1);
  assert.equal(res.byLane.length, 1);
  assert.equal(res.byLane[0].key, 'worker');
});

test('filters — agentId restricts to that agent’s attributed calls', () => {
  insertWorkspace({ id: 'ws1', title: 'W1' });
  insertAgent({ id: 'agentA', title: 'Alpha', workspaceId: 'ws1' });
  insertAgentSession({ agentId: 'agentA', sessionId: 'sess-A' });
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertSls({ streamId: 's2', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-orphan' });
  const res = q().run({ agentId: 'agentA' });
  assert.equal(res.totalCalls, 1);
});

test('filters — workspaceId matches the authoritative agents-join workspace', () => {
  insertWorkspace({ id: 'ws1', title: 'W1' });
  insertAgent({ id: 'agentA', title: 'Alpha', workspaceId: 'ws1' });
  insertAgentSession({ agentId: 'agentA', sessionId: 'sess-A' });
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-orphan' });
  const res = q().run({ workspaceId: 'ws1' });
  assert.equal(res.totalCalls, 1, 'only the session-attributed call matches the workspace');
  const byWs = q().run({}).byWorkspace.find((r) => r.label === 'W1');
  assert.ok(byWs, 'attributed calls group under the authoritative workspace title');
});

// ── HONESTY: a workspace scope must not silently swallow unattributable rows ──
// (adversarial-review finding #2 / Tail T2). Rows that attribute to NO workspace
// (COALESCE(ag.workspace_id, sls.workspace_id) IS NULL) can never match a
// workspaceId, so scoping hides them; scopeMeta.droppedUnattributedCalls surfaces
// exactly how many, keeping "shown + dropped" reconcilable with the global total.
test('scopeMeta.droppedUnattributedCalls — scoped query discloses hidden unattributable rows', () => {
  insertWorkspace({ id: 'ws1', title: 'W1' });
  insertAgent({ id: 'agentA', title: 'Alpha', workspaceId: 'ws1' });
  insertAgentSession({ agentId: 'agentA', sessionId: 'sess-A' });
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' }); // attributes to ws1 via session
  insertSls({ streamId: 's2', lane: 'worker', slug: 'projB' }); // session orphaned → no workspace
  insertSls({ streamId: 's3', lane: 'worker', slug: 'projC' }); // no session at all → no workspace
  // 2 attributable-to-ws1 calls
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  // 3 + 1 = 4 unattributable-to-any-workspace calls
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-orphan' });
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-orphan' });
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-orphan' });
  insertBe({ streamId: 's3', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });

  const globalTotal = q().run({}).totalCalls; // 6, no scope
  const scoped = q().run({ workspaceId: 'ws1' });
  assert.equal(scoped.totalCalls, 2, 'only ws1-attributed calls survive the scope');
  assert.equal(scoped.attributedCalls, 2, 'all shown calls resolved to an agent');
  assert.equal(scoped.scopeMeta.droppedUnattributedCalls, 4, 'the 4 no-workspace calls are disclosed, not vanished');
  // Reconciliation: with no other-workspace rows present, shown + dropped == global total.
  assert.equal(scoped.totalCalls + scoped.scopeMeta.droppedUnattributedCalls, globalTotal);
  // And it equals (global total − scoped attributable), the review's formula.
  assert.equal(scoped.scopeMeta.droppedUnattributedCalls, globalTotal - scoped.totalCalls);
});

test('scopeMeta.droppedUnattributedCalls — is 0 when no workspace scope is applied', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' }); // unattributable
  // No workspaceId → nothing is being dropped on the workspace axis.
  assert.equal(q().run({}).scopeMeta.droppedUnattributedCalls, 0);
  assert.equal(q().run({ lane: 'worker' }).scopeMeta.droppedUnattributedCalls, 0);
});

test('filters — time window narrows', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', tsMs: 1000 });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', tsMs: 5000 });
  assert.equal(q().run({ sinceMs: 2000 }).totalCalls, 1);
});

// ── byWorkspace slug degrade for unattributed streams ──
test('byWorkspace — degrades to slug when no session/workspace resolves', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projSlug' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  const res = q().run({});
  assert.ok(res.byWorkspace.find((r) => r.key === 'projSlug'), 'slug is the workspace proxy');
  assert.equal(res.scopeMeta.workspaceKeyIsSlugProxy, true);
});

// ── timeline ascending ──
test('timeline — ascending, not truncated for a small corpus', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', tsMs: 500 });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__browser_open_url', toolset: 'browser', tsMs: 200 });
  const res = q().run({});
  assert.deepEqual(res.timeline.map((r) => r.tsMs), [200, 500]);
  assert.equal(res.timeline[0].toolShort, 'browser_open_url');
  assert.equal(res.timelineTruncated, false);
});

// ── scopeMeta echoes the query + honesty flags ──
test('scopeMeta — echoes the query and flags session-based attribution', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  const res = q().run({ lane: 'worker', slug: 'projA' });
  assert.equal(res.scopeMeta.appliedLane, 'worker');
  assert.equal(res.scopeMeta.appliedSlug, 'projA');
  assert.equal(res.scopeMeta.attributionIsSessionBased, true);
  assert.equal(res.scopeMeta.workspaceKeyIsSlugProxy, true);
});

// ── builtin/skill rows are excluded (base predicate) ──
test('base predicate — non-mcp tool_use rows are excluded', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'Bash', toolKind: 'builtin' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolKind: 'mcp', toolset: 'observability' });
  assert.equal(q().run({}).totalCalls, 1);
});

// ══ Four-tier attribution cross-tab (WP-C / P2) ══
// byToolLane / tierBreakdown / attributionCoveragePct enrich the result with an
// honest four-tier attribution, keeping the unattributed bucket first-class.

// ── tier 1: agent-attributed (session resolves) ──
test('attribution — a session-resolved call is agent-attributed', () => {
  insertWorkspace({ id: 'ws1', title: 'W1' });
  insertAgent({ id: 'agentA', title: 'Alpha', workspaceId: 'ws1' });
  insertAgentSession({ agentId: 'agentA', sessionId: 'sess-A' });
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability', sessionId: 'sess-A' });
  const res = q().run({});
  assert.equal(res.tierBreakdown['agent-attributed'], 1);
  assert.equal(res.attributedCount, 1);
  assert.equal(res.unattributedCount, 0);
  assert.equal(res.attributionCoveragePct, 100);
  const cell = res.byToolLane.find((c) => c.toolShort === 'list_agents')!;
  assert.equal(cell.tier, 'agent-attributed');
  assert.equal(cell.lane, 'worker');
  // agent-tier count matches the legacy session-based attributedCalls.
  assert.equal(res.tierBreakdown['agent-attributed'], res.attributedCalls);
});

// ── tier 2: lane-attributed-explicit (no agent, explicit lane) ──
test('attribution — an unattributed call with an explicit lane is lane-attributed-explicit', () => {
  insertSls({ streamId: 's1', lane: 'supervisor', slug: 'projA' });
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability' });
  const res = q().run({});
  assert.equal(res.tierBreakdown['lane-attributed-explicit'], 1);
  assert.equal(res.attributedCount, 1);
  assert.equal(res.attributionCoveragePct, 100);
  const cell = res.byToolLane[0];
  assert.equal(cell.tier, 'lane-attributed-explicit');
  assert.equal(cell.lane, 'supervisor');
});

// ── tier 3: lane-inferred-from-current-grant (no agent, no lane, single-lane toolset) ──
test('attribution — no lane + single-lane toolset infers lane-inferred-from-current-grant', () => {
  // No sls row → sls.lane is NULL; no session → no agent. Toolset 'browser' is
  // researcher-exclusive today, so the lane is inferred from the grant topology.
  insertBe({ streamId: 's-orphan', toolName: 'mcp__agent-dashboard__browser_read_page', toolset: 'browser' });
  const res = q().run({});
  assert.equal(res.tierBreakdown['lane-inferred-from-current-grant'], 1);
  const cell = res.byToolLane[0];
  assert.equal(cell.tier, 'lane-inferred-from-current-grant');
  assert.equal(cell.lane, 'researcher');
});

// ── tier 3 GATING: a multi-lane toolset with no lane MUST stay unattributed ──
test('attribution — no lane + multi-lane toolset stays unattributed (no false inference)', () => {
  // 'observability-core' is granted to BOTH supervisor and worker (WP-F split), so
  // it must NOT infer a lane. No sls row + no session → the honest bucket is (unattributed).
  insertBe({ streamId: 's-orphan', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability-core' });
  const res = q().run({});
  assert.equal(res.tierBreakdown['lane-inferred-from-current-grant'], 0);
  assert.equal(res.tierBreakdown.unattributed, 1);
  assert.equal(res.unattributedCount, 1);
  assert.equal(res.attributedCount, 0);
  assert.equal(res.attributionCoveragePct, 0);
  const cell = res.byToolLane[0];
  assert.equal(cell.tier, 'unattributed');
  assert.equal(cell.lane, '(unattributed)');
});

// ── tierBreakdown reconciles with totalCalls across a mixed corpus ──
test('attribution — the four tiers sum to totalCalls (nothing dropped)', () => {
  insertWorkspace({ id: 'ws1', title: 'W1' });
  insertAgent({ id: 'agentA', title: 'Alpha', workspaceId: 'ws1' });
  insertAgentSession({ agentId: 'agentA', sessionId: 'sess-A' });
  insertSls({ streamId: 's1', lane: 'worker', slug: 'projA' });   // agent
  insertSls({ streamId: 's2', lane: 'supervisor', slug: 'projA' }); // explicit lane
  insertBe({ streamId: 's1', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability-core', sessionId: 'sess-A' });
  insertBe({ streamId: 's2', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability-core' });
  insertBe({ streamId: 's3', toolName: 'mcp__agent-dashboard__browser_read_page', toolset: 'browser' });   // inferred researcher
  insertBe({ streamId: 's4', toolName: 'mcp__agent-dashboard__list_agents', toolset: 'observability-core' });   // unattributed (core is multi-lane)
  const res = q().run({});
  const tb = res.tierBreakdown;
  const sum = tb['agent-attributed'] + tb['lane-attributed-explicit']
    + tb['lane-inferred-from-current-grant'] + tb.unattributed;
  assert.equal(sum, res.totalCalls);
  assert.equal(res.attributedCount + res.unattributedCount, res.totalCalls);
  assert.equal(tb['agent-attributed'], 1);
  assert.equal(tb['lane-attributed-explicit'], 1);
  assert.equal(tb['lane-inferred-from-current-grant'], 1);
  assert.equal(tb.unattributed, 1);
  assert.equal(res.attributionCoveragePct, 75); // 3 of 4 attributed
});

// ══ WP-2B — workspace lineage: tier resolution + scopeMode + leak firewall ══

const TOOL = 'mcp__agent-dashboard__list_agents';

// ── tier resolution: every workspace tier buckets honestly over the base population ──
test('workspaceAttribution — each tier buckets honestly (launch-session / from-root / slug-proxy / unattributed)', () => {
  // launch-session: session → agent → workspace resolves (ag.workspace_id NOT NULL).
  insertWorkspace({ id: 'wsL', title: 'Launch WS' });
  insertAgent({ id: 'agentL', title: 'L', workspaceId: 'wsL' });
  insertAgentSession({ agentId: 'agentL', sessionId: 'sess-L' });
  insertSls({ streamId: 'sL', lane: 'worker', slug: 'slL' });
  insertBe({ streamId: 'sL', toolName: TOOL, toolset: 'observability', sessionId: 'sess-L' });

  // from-root: sls.workspace_id set by a folded-root backfill (method='root'), no session.
  insertSls({ streamId: 'sR', lane: 'worker', slug: 'slR', workspaceId: 'wsR', workspaceRoot: 'C:/r', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 'sR', toolName: TOOL, toolset: 'observability' });

  // explicit: sls.workspace_id set with method='explicit' (reserved tier).
  insertSls({ streamId: 'sE', lane: 'worker', slug: 'slE', workspaceId: 'wsE', workspaceRoot: 'C:/e', workspaceAttributionMethod: 'explicit' });
  insertBe({ streamId: 'sE', toolName: TOOL, toolset: 'observability' });

  // slug-proxy: no real id anywhere, but a slug is present.
  insertSls({ streamId: 'sP', lane: 'worker', slug: 'slP' });
  insertBe({ streamId: 'sP', toolName: TOOL, toolset: 'observability' });

  // unattributed: no session, no sls row, no slug at all.
  insertBe({ streamId: 'sU', toolName: TOOL, toolset: 'observability' });

  const wa = q().run({}).scopeMeta.workspaceAttribution!;
  assert.equal(wa['workspace-from-launch-session'], 1, 'session join → launch-session tier');
  assert.equal(wa['workspace-from-root'], 1, 'folded-root id → from-root tier');
  assert.equal(wa['workspace-explicit'], 1, 'method=explicit → explicit tier');
  assert.equal(wa['workspace-slug-proxy'], 1, 'slug-only → slug-proxy tier');
  assert.equal(wa['workspace-unattributed'], 1, 'no signal → unattributed tier');
});

// ── with any real id present, the workspace key is NOT a slug proxy ──
test('workspaceKeyIsSlugProxy — false once ANY row carries a real workspace id', () => {
  insertSls({ streamId: 'sR', lane: 'worker', slug: 'slR', workspaceId: 'wsR', workspaceRoot: 'C:/r', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 'sR', toolName: TOOL, toolset: 'observability' });
  assert.equal(q().run({}).scopeMeta.workspaceKeyIsSlugProxy, false);
});

// ── strict: real id only; the slug proxy is excluded ──
test('scopeMode strict — a workspace scope admits only real-id rows, never the slug proxy', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'S', workspaceId: 'ws1', workspaceRoot: 'C:/1', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's1', toolName: TOOL, toolset: 'observability' }); // real ws1
  insertSls({ streamId: 's2', lane: 'worker', slug: 'S' });               // proxy — no real id
  insertBe({ streamId: 's2', toolName: TOOL, toolset: 'observability' });
  const res = q().run({ workspaceId: 'ws1', slug: 'S', scopeMode: 'strict' });
  assert.equal(res.totalCalls, 1, 'only the real-id row survives strict scope');
  assert.equal(res.scopeMeta.proxyIncludedCalls, 0, 'strict never rescues a proxy row');
  assert.equal(res.scopeMeta.appliedScopeMode, 'strict');
});

// ── include-proxy: admits the proxy ONLY when the slug maps uniquely to the caller ──
test('scopeMode include-proxy — admits the slug proxy when the slug uniquely maps to ONE workspace', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'S', workspaceId: 'ws1', workspaceRoot: 'C:/1', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's1', toolName: TOOL, toolset: 'observability' }); // real ws1, slug S
  insertSls({ streamId: 's2', lane: 'worker', slug: 'S' });               // proxy row, slug S, no id
  insertBe({ streamId: 's2', toolName: TOOL, toolset: 'observability' });
  const res = q().run({ workspaceId: 'ws1', slug: 'S', scopeMode: 'include-proxy' });
  assert.equal(res.totalCalls, 2, 'real-id row + uniquely-mapped proxy row both admitted');
  assert.equal(res.scopeMeta.proxyIncludedCalls, 1, 'exactly the proxy row was rescued');
  assert.equal(res.scopeMeta.appliedScopeMode, 'include-proxy');
});

// ── include-proxy leak firewall: a slug shared across TWO real workspaces admits NEITHER
//    the other workspace's rows NOR the proxy into a single-workspace scope ──
test('scopeMode include-proxy — a slug shared by TWO workspaces denies the proxy (no cross-workspace leakage)', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'S', workspaceId: 'ws1', workspaceRoot: 'C:/1', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's1', toolName: TOOL, toolset: 'observability' }); // ws1 carries slug S
  insertSls({ streamId: 's2', lane: 'worker', slug: 'S', workspaceId: 'ws2', workspaceRoot: 'C:/2', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's2', toolName: TOOL, toolset: 'observability' }); // ws2 ALSO carries slug S
  insertSls({ streamId: 's3', lane: 'worker', slug: 'S' });               // proxy row, slug S
  insertBe({ streamId: 's3', toolName: TOOL, toolset: 'observability' });
  const res = q().run({ workspaceId: 'ws1', slug: 'S', scopeMode: 'include-proxy' });
  assert.equal(res.totalCalls, 1, 'only ws1 real rows — the ambiguous slug never rescues the proxy or ws2');
  assert.equal(res.scopeMeta.proxyIncludedCalls, 0, 'ambiguous slug → proxy leg stays closed');
});

// ── default scopeMode is include-proxy (auto-resolves slug uniqueness) ──
test('scopeMode default — omitting scopeMode defaults to include-proxy and auto-resolves uniqueness', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'S', workspaceId: 'ws1', workspaceRoot: 'C:/1', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's1', toolName: TOOL, toolset: 'observability' });
  insertSls({ streamId: 's2', lane: 'worker', slug: 'S' });
  insertBe({ streamId: 's2', toolName: TOOL, toolset: 'observability' });
  const res = q().run({ workspaceId: 'ws1', slug: 'S' });
  assert.equal(res.scopeMeta.appliedScopeMode, 'include-proxy');
  assert.equal(res.totalCalls, 2, 'default admits the uniquely-mapped proxy');
});

// ── global-diagnostic: no workspace filter; nothing dropped on the workspace axis ──
test('scopeMode global-diagnostic — ignores the workspace filter entirely', () => {
  insertSls({ streamId: 's1', lane: 'worker', slug: 'S', workspaceId: 'ws1', workspaceRoot: 'C:/1', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's1', toolName: TOOL, toolset: 'observability' });
  insertSls({ streamId: 's2', lane: 'worker', slug: 'S', workspaceId: 'ws2', workspaceRoot: 'C:/2', workspaceAttributionMethod: 'root' });
  insertBe({ streamId: 's2', toolName: TOOL, toolset: 'observability' });
  insertSls({ streamId: 's3', lane: 'worker', slug: 'S' });
  insertBe({ streamId: 's3', toolName: TOOL, toolset: 'observability' });
  const res = q().run({ workspaceId: 'ws1', scopeMode: 'global-diagnostic' });
  assert.equal(res.totalCalls, 3, 'every row is in scope regardless of workspace');
  assert.equal(res.scopeMeta.droppedUnattributedCalls, 0, 'nothing is dropped on the workspace axis');
  assert.equal(res.scopeMeta.appliedScopeMode, 'global-diagnostic');
});

// ── runner ──
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-usage-test-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  M = require('./mcp-tool-usage-queries');

  let passed = 0; let failed = 0;
  for (const t of tests) {
    // fresh schema per test (isolated seeds) — re-init the in-memory DB.
    dbm.initDatabase();
    seq = 0;
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
