// mcp-tool-usage-queries.ts — read-only QUERY LAYER for per-MCP-tool usage
// (wave2-mcp-tool-observability §2.1). Pure SQL over the WP2 parse foundation:
// `behavior_events` rows with `kind='tool_use' AND tool_kind='mcp'`, joined to
// `stream_lane_stats` (lane / workspace / slug) and — for per-agent attribution
// — `agent_sessions → agents → workspaces`.
//
// HONESTY INVARIANTS (feedback req #5, verified against the live corpus):
//   1. Per-agent attribution is SESSION-BASED. A call maps to a dashboard agent
//      ONLY when `session_id → agent_sessions` hits (all agent/workspace joins
//      are LEFT). Unmatched streams keep their rows in a visible "(unattributed)"
//      bucket — NEVER dropped, NEVER implied to be a specific agent (this honors
//      the CLAUDE.md shared-cwd invariant). Live: ~93% of MCP calls are
//      unattributed, so that bucket dominates and must stay first-class.
//   2. Workspace scope degrades honestly. `stream_lane_stats.workspace_id` and
//      `.workspace_root` are unpopulated today (verified: 0/2050 rows), so the
//      workspace dimension resolves to the authoritative `workspaces.title` when
//      a session joins, else the Claude project slug. `scopeMeta` flags the proxy.
//   3. No per-tool error counts here — `tool_result` rows carry no `tool_name`
//      link (§3.5 roadmap), so we never invent an error rate.
//
// The DB handle is injected (getDb() in production, the sql.js fake in tests) so
// this stays unit-testable under the system-Node runner.

import type {
  McpToolUsageQuery,
  McpToolUsageResult,
  McpToolLaneCell,
  McpToolRow,
  McpToolsetRollup,
  McpUsageGroupRow,
  WorkspaceAttributionBreakdown,
  WorkspaceAttributionTier,
} from '../../shared/types';
import type { QueryDb } from './queries';
import { buildToolsetLaneGrants, classifyAttribution } from '../context-optimizer/lane-attribution';
import { emptyTierBreakdown, rollUpAttribution } from '../context-optimizer/attribution';

const TIMELINE_CAP = 5000;
const SESSION_ROW_CAP = 100; // bySession can be large (one row per stream); cap the breakdown.

function num(v: unknown): number { return typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0; }

function emptyWorkspaceBreakdown(): WorkspaceAttributionBreakdown {
  return {
    'workspace-explicit': 0,
    'workspace-from-launch-session': 0,
    'workspace-from-root': 0,
    'workspace-slug-proxy': 0,
    'workspace-unattributed': 0,
  };
}

// The workspace-tier CASE — SEPARATE from the four lane tiers. Precedence, strongest
// real identity first: a session→agent join (from-launch-session) > a directly-witnessed
// launch association (explicit; reserved) > a folded-root id (from-root) > the slug proxy
// > nothing. Every column is join-qualified; reused by the breakdown + honesty flag.
const WORKSPACE_TIER_CASE = `
  CASE
    WHEN ag.workspace_id IS NOT NULL THEN 'workspace-from-launch-session'
    WHEN sls.workspace_id IS NOT NULL AND sls.workspace_attribution_method = 'explicit' THEN 'workspace-explicit'
    WHEN sls.workspace_id IS NOT NULL THEN 'workspace-from-root'
    WHEN COALESCE(be.slug, sls.slug) IS NOT NULL THEN 'workspace-slug-proxy'
    ELSE 'workspace-unattributed'
  END`;

/** Strip the `mcp__<server>__` prefix (server names may contain hyphens; tool
 *  names may contain single underscores — the separator is a double underscore). */
export function toolShortName(toolName: string): string {
  const parts = toolName.split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : toolName;
}

// One row per stream, one per session (deduped so a shared session_id can't
// fan-out and double-count), one per agent, one per workspace — so COUNT(*)
// stays the true behavior_events row count across the LEFT JOINs.
const JOINS = `
  FROM behavior_events be
  LEFT JOIN stream_lane_stats sls ON sls.stream_id = be.stream_id
  LEFT JOIN (
    SELECT session_id, MIN(dashboard_agent_id) AS dashboard_agent_id
    FROM agent_sessions GROUP BY session_id
  ) asx ON asx.session_id = be.session_id
  LEFT JOIN agents ag ON ag.id = asx.dashboard_agent_id
  LEFT JOIN workspaces ws ON ws.id = ag.workspace_id
`;

export class McpToolUsageQueries {
  constructor(private db: QueryDb) {}

  /** The non-workspace predicate shared by the scoped query and the dropped-count
   *  probe, so the two can never drift. Every column is join-qualified. */
  private baseClauses(q: McpToolUsageQuery): { clauses: string[]; params: unknown[] } {
    const clauses: string[] = [`be.kind = 'tool_use'`, `be.tool_kind = 'mcp'`];
    const params: unknown[] = [];
    // `slug` is a HARD filter only when NO workspace scope is applied (the honest
    // slug-degrade view). Under a workspace scope it is instead the proxy KEY consumed
    // by the scope predicate (whereAndParams), so it must NOT double as a hard filter.
    if (q.slug && !q.workspaceId) { clauses.push(`COALESCE(be.slug, sls.slug) = ?`); params.push(q.slug); }
    if (q.lane) { clauses.push(`COALESCE(sls.lane, 'unknown') = ?`); params.push(q.lane); }
    if (q.agentId) { clauses.push(`asx.dashboard_agent_id = ?`); params.push(q.agentId); }
    if (q.sinceMs != null) { clauses.push(`be.ts_ms >= ?`); params.push(q.sinceMs); }
    if (q.untilMs != null) { clauses.push(`be.ts_ms <= ?`); params.push(q.untilMs); }
    return { clauses, params };
  }

  /** Base predicate + the workspace-scope predicate for the applied scopeMode (WP-2B).
   *  Every column is join-qualified. `global-diagnostic` applies NO workspace filter;
   *  `strict` matches only a real workspace id; `include-proxy` additionally admits
   *  slug-proxy rows (those with NO real id) when the slug uniquely maps to the caller
   *  workspace — the leak firewall. `q` is expected to be scope-resolved (see run()). */
  private whereAndParams(q: McpToolUsageQuery): { where: string; params: unknown[] } {
    const { clauses, params } = this.baseClauses(q);
    const real = `COALESCE(ag.workspace_id, sls.workspace_id)`;
    if (q.workspaceId && q.scopeMode !== 'global-diagnostic') {
      if (this.proxyLegActive(q)) {
        clauses.push(`(${real} = ? OR (${real} IS NULL AND COALESCE(be.slug, sls.slug) = ?))`);
        params.push(q.workspaceId, q.slug);
      } else {
        clauses.push(`${real} = ?`);
        params.push(q.workspaceId);
      }
    }
    return { where: 'WHERE ' + clauses.join(' AND '), params };
  }

  /** True when the include-proxy slug leg is active for this (scope-resolved) query. */
  private proxyLegActive(q: McpToolUsageQuery): boolean {
    return !!(q.workspaceId && q.scopeMode === 'include-proxy' && q.slug && q.slugUniqueToWorkspace);
  }

  /** Whether `slug` maps to EXACTLY the caller workspace and no other. Data-driven: the
   *  slug is safe to admit as a proxy only when every REAL-workspace-id row carrying it
   *  belongs to `workspaceId` (and at least one does). Zero evidence → not unique →
   *  denied, so proxy admission never guesses a cross-workspace link. */
  private slugMapsUniquelyTo(workspaceId: string, slug: string, q: McpToolUsageQuery): boolean {
    const { clauses, params } = this.baseClauses(q);
    clauses.push(`COALESCE(be.slug, sls.slug) = ?`); params.push(slug);
    clauses.push(`COALESCE(ag.workspace_id, sls.workspace_id) IS NOT NULL`);
    const where = 'WHERE ' + clauses.join(' AND ');
    const rows = this.db.prepare(
      `SELECT DISTINCT COALESCE(ag.workspace_id, sls.workspace_id) AS ws ${JOINS} ${where}`,
    ).all(...params);
    return rows.length === 1 && String(rows[0].ws) === workspaceId;
  }

  /** Rows admitted into the scoped result ONLY via the slug-proxy leg (real id NULL,
   *  slug matches). 0 unless the proxy leg is active. */
  private proxyIncludedCount(q: McpToolUsageQuery): number {
    if (!this.proxyLegActive(q)) return 0;
    const { clauses, params } = this.baseClauses(q);
    clauses.push(`COALESCE(ag.workspace_id, sls.workspace_id) IS NULL`);
    clauses.push(`COALESCE(be.slug, sls.slug) = ?`); params.push(q.slug);
    const where = 'WHERE ' + clauses.join(' AND ');
    const row = this.db.prepare(`SELECT COUNT(*) AS n ${JOINS} ${where}`).get(...params);
    return num(row?.n);
  }

  /** Count of rows the workspace filter drops because they attribute to NO workspace
   *  (`COALESCE(ag.workspace_id, sls.workspace_id) IS NULL`) AND were not rescued by the
   *  proxy leg — they can never match the `workspaceId`, so scoping hides them. Surfaced
   *  so "shown + dropped" reconciles with the global total. 0 with no workspace scope,
   *  or under global-diagnostic (nothing is dropped on this axis). */
  private droppedUnattributedCount(q: McpToolUsageQuery): number {
    if (!q.workspaceId || q.scopeMode === 'global-diagnostic') return 0;
    const { clauses, params } = this.baseClauses(q);
    clauses.push(`COALESCE(ag.workspace_id, sls.workspace_id) IS NULL`);
    const where = 'WHERE ' + clauses.join(' AND ');
    const row = this.db.prepare(`SELECT COUNT(*) AS n ${JOINS} ${where}`).get(...params);
    return num(row?.n) - this.proxyIncludedCount(q);
  }

  /** Per-workspace-tier counts over the BASE population (non-workspace-filtered), so
   *  the proxy/unattributed tiers are reported SEPARATELY from the real-identity tiers
   *  (brief item 4). `realIdCount` = rows with any real workspace id (explicit / launch-
   *  session / root) → drives the honest slug-proxy flag. */
  private workspaceBreakdown(q: McpToolUsageQuery): {
    breakdown: WorkspaceAttributionBreakdown; realIdCount: number;
  } {
    const { clauses, params } = this.baseClauses(q);
    const where = 'WHERE ' + clauses.join(' AND ');
    const rows = this.db.prepare(
      `SELECT ${WORKSPACE_TIER_CASE} AS wtier, COUNT(*) AS n ${JOINS} ${where} GROUP BY wtier`,
    ).all(...params);
    const breakdown = emptyWorkspaceBreakdown();
    for (const r of rows) {
      const tier = String(r.wtier) as WorkspaceAttributionTier;
      if (tier in breakdown) breakdown[tier] = num(r.n);
    }
    const realIdCount = breakdown['workspace-explicit']
      + breakdown['workspace-from-launch-session'] + breakdown['workspace-from-root'];
    return { breakdown, realIdCount };
  }

  /** Resolve scope defaults: default scopeMode to 'include-proxy' and, when the caller
   *  did not pre-compute it, decide whether the slug uniquely maps to the workspace
   *  (which unlocks the proxy leg). */
  private resolveScope(q: McpToolUsageQuery): McpToolUsageQuery {
    const scopeMode = q.scopeMode ?? 'include-proxy';
    let slugUniqueToWorkspace = q.slugUniqueToWorkspace ?? false;
    if (scopeMode === 'include-proxy' && q.workspaceId && q.slug && q.slugUniqueToWorkspace === undefined) {
      slugUniqueToWorkspace = this.slugMapsUniquelyTo(q.workspaceId, q.slug, q);
    }
    return { ...q, scopeMode, slugUniqueToWorkspace };
  }

  private byTool(where: string, params: unknown[]): McpToolRow[] {
    const rows = this.db.prepare(
      `SELECT be.tool_name AS tool_name, MIN(be.mcp_toolset) AS toolset,
              COUNT(*) AS count, COUNT(DISTINCT be.stream_id) AS distinct_streams,
              MAX(be.ts_ms) AS last
       ${JOINS} ${where}
       GROUP BY be.tool_name
       ORDER BY count DESC`,
    ).all(...params);
    return rows.map((r) => {
      const toolName = String(r.tool_name ?? '(unknown)');
      return {
        toolName,
        toolShort: toolShortName(toolName),
        toolset: r.toolset == null ? null : String(r.toolset),
        count: num(r.count),
        distinctStreams: num(r.distinct_streams),
        lastTsMs: r.last != null ? num(r.last) : null,
      };
    });
  }

  /** Assemble toolset rollups from the per-tool rows so drill children come free. */
  private byToolset(byTool: McpToolRow[]): McpToolsetRollup[] {
    const map = new Map<string | null, McpToolsetRollup>();
    for (const t of byTool) {
      const cur = map.get(t.toolset) ?? { toolset: t.toolset, count: 0, distinctStreams: 0, tools: [] };
      cur.count += t.count;
      // distinctStreams is per-tool; a toolset-level exact distinct needs its own
      // query. Sum is an upper bound — expose the per-tool value on the children
      // and use the toolset sum only for ordering. Keep it as a sum-of-tools.
      cur.distinctStreams += t.distinctStreams;
      cur.tools.push(t);
      map.set(t.toolset, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  private byAgent(where: string, params: unknown[]): McpUsageGroupRow[] {
    const rows = this.db.prepare(
      `SELECT asx.dashboard_agent_id AS agent_id,
              COALESCE(ag.title, '(unattributed — session-based)') AS label,
              COUNT(*) AS count
       ${JOINS} ${where}
       GROUP BY asx.dashboard_agent_id
       ORDER BY count DESC`,
    ).all(...params);
    return rows.map((r) => ({
      key: r.agent_id == null ? '(unattributed)' : String(r.agent_id),
      label: String(r.label),
      count: num(r.count),
      agentId: r.agent_id == null ? null : String(r.agent_id),
    }));
  }

  private bySession(where: string, params: unknown[]): McpUsageGroupRow[] {
    const rows = this.db.prepare(
      `SELECT be.stream_id AS stream_id, COUNT(*) AS count
       ${JOINS} ${where}
       GROUP BY be.stream_id
       ORDER BY count DESC
       LIMIT ${SESSION_ROW_CAP}`,
    ).all(...params);
    return rows.map((r) => {
      const streamId = String(r.stream_id ?? '(unknown)');
      // Short, human-scannable label — last path/hash segment.
      const seg = streamId.split(/[\\/]/).pop() ?? streamId;
      const short = seg.length > 14 ? `…${seg.slice(-12)}` : seg;
      return { key: streamId, label: `session ${short}`, count: num(r.count) };
    });
  }

  private byWorkspace(where: string, params: unknown[]): McpUsageGroupRow[] {
    const rows = this.db.prepare(
      `SELECT COALESCE(ws.title, sls.slug, sls.workspace_root, '(unknown)') AS wk,
              COUNT(*) AS count
       ${JOINS} ${where}
       GROUP BY wk
       ORDER BY count DESC`,
    ).all(...params);
    return rows.map((r) => ({ key: String(r.wk), label: String(r.wk), count: num(r.count) }));
  }

  private byLane(where: string, params: unknown[]): McpUsageGroupRow[] {
    const rows = this.db.prepare(
      `SELECT COALESCE(sls.lane, 'unknown') AS lane, COUNT(*) AS count
       ${JOINS} ${where}
       GROUP BY lane
       ORDER BY count DESC`,
    ).all(...params);
    return rows.map((r) => ({ key: String(r.lane), label: String(r.lane), count: num(r.count) }));
  }

  private timeline(where: string, params: unknown[]): {
    rows: Array<{ tsMs: number; toolShort: string; toolset: string | null }>;
    truncated: boolean;
  } {
    const rows = this.db.prepare(
      `SELECT be.ts_ms AS ts, be.tool_name AS tool_name, be.mcp_toolset AS toolset
       ${JOINS} ${where}
       ORDER BY be.ts_ms DESC LIMIT ?`,
    ).all(...params, TIMELINE_CAP + 1);
    const truncated = rows.length > TIMELINE_CAP;
    const clipped = truncated ? rows.slice(0, TIMELINE_CAP) : rows;
    return {
      rows: clipped
        .map((r) => ({
          tsMs: num(r.ts),
          toolShort: toolShortName(String(r.tool_name ?? '(unknown)')),
          toolset: r.toolset == null ? null : String(r.toolset),
        }))
        .sort((a, b) => a.tsMs - b.tsMs),
      truncated,
    };
  }

  /** The four-tier attribution cross-tab (WP-C / P2). Groups every MCP call by
   *  (tool, toolset, explicit lane, whether the session resolved to an agent), then
   *  classifies each group into ONE honest attribution tier via the shared
   *  precedence classifier (agent > explicit-lane > exclusive-grant > unattributed).
   *  The unattributed bucket is kept first-class; no slug/cwd heuristic is used. */
  private byToolLaneAttribution(where: string, params: unknown[]): {
    byToolLane: McpToolLaneCell[];
    tierBreakdown: ReturnType<typeof emptyTierBreakdown>;
  } {
    const rows = this.db.prepare(
      `SELECT be.tool_name AS tool_name, be.mcp_toolset AS toolset,
              sls.lane AS lane,
              CASE WHEN asx.dashboard_agent_id IS NOT NULL THEN 1 ELSE 0 END AS attributed,
              COUNT(*) AS count
       ${JOINS} ${where}
       GROUP BY be.tool_name, be.mcp_toolset, sls.lane, attributed`,
    ).all(...params);

    const grants = buildToolsetLaneGrants();
    const tierBreakdown = emptyTierBreakdown();
    // Collapse to one cell per (tool, resolved-lane, tier) — several raw groups can
    // classify to the same lane/tier (e.g. explicit 'unknown' + null both fall to
    // the same bucket).
    const cells = new Map<string, McpToolLaneCell>();
    for (const r of rows) {
      const toolName = String(r.tool_name ?? '(unknown)');
      const toolset = r.toolset == null ? null : String(r.toolset);
      const explicitLane = r.lane == null ? null : String(r.lane);
      const hasAgent = num(r.attributed) > 0;
      const count = num(r.count);
      const outcome = classifyAttribution({ hasAgent, explicitLane, toolset }, grants);
      tierBreakdown[outcome.tier] += count;
      const key = `${toolName} ${outcome.lane} ${outcome.tier}`;
      const cur = cells.get(key);
      if (cur) {
        cur.count += count;
      } else {
        cells.set(key, {
          toolName,
          toolShort: toolShortName(toolName),
          toolset,
          lane: outcome.lane,
          tier: outcome.tier,
          count,
        });
      }
    }
    const byToolLane = [...cells.values()].sort(
      (a, b) => b.count - a.count || (a.toolShort < b.toolShort ? -1 : a.toolShort > b.toolShort ? 1 : 0),
    );
    return { byToolLane, tierBreakdown };
  }

  private totals(where: string, params: unknown[]): { total: number; attributed: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN asx.dashboard_agent_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed
       ${JOINS} ${where}`,
    ).get(...params);
    return { total: num(row?.total), attributed: num(row?.attributed) };
  }

  run(q0: McpToolUsageQuery): McpToolUsageResult {
    const q = this.resolveScope(q0);
    const { where, params } = this.whereAndParams(q);
    const { breakdown: workspaceAttribution, realIdCount } = this.workspaceBreakdown(q);
    const byTool = this.byTool(where, params);
    const tl = this.timeline(where, params);
    const { total, attributed } = this.totals(where, params);
    const { byToolLane, tierBreakdown } = this.byToolLaneAttribution(where, params);
    const rollup = rollUpAttribution(tierBreakdown);
    return {
      byTool,
      byToolset: this.byToolset(byTool),
      byAgent: this.byAgent(where, params),
      bySession: this.bySession(where, params),
      byWorkspace: this.byWorkspace(where, params),
      byLane: this.byLane(where, params),
      byToolLane,
      tierBreakdown,
      attributedCount: rollup.attributedCount,
      unattributedCount: rollup.unattributedCount,
      attributionCoveragePct: rollup.attributionCoveragePct,
      timeline: tl.rows,
      timelineTruncated: tl.truncated,
      totalCalls: total,
      attributedCalls: attributed,
      scopeMeta: {
        // Honest now that ingestion/backfill can populate real ids: the workspace
        // dimension degrades to the slug ONLY when NO row in the base population carries
        // a real workspace identity (WP-2B).
        workspaceKeyIsSlugProxy: realIdCount === 0,
        attributionIsSessionBased: true,
        droppedUnattributedCalls: this.droppedUnattributedCount(q),
        appliedLane: q.lane ?? null,
        appliedSlug: q.slug ?? null,
        appliedAgentId: q.agentId ?? null,
        windowSinceMs: q.sinceMs ?? null,
        windowUntilMs: q.untilMs ?? null,
        appliedScopeMode: q.scopeMode ?? 'include-proxy',
        workspaceAttribution,
        proxyIncludedCalls: this.proxyIncludedCount(q),
      },
      generatedAtIso: new Date().toISOString(),
    };
  }
}

/** Convenience free function (production wires ensureIndexed at the IPC layer). */
export function queryMcpToolUsage(db: QueryDb, q: McpToolUsageQuery): McpToolUsageResult {
  return new McpToolUsageQueries(db).run(q);
}
