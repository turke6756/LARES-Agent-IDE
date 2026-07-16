// queries.ts — the read-only QUERY LAYER for the Skill Usage Analytics panel
// (dashboard-skill-observability-tools.md §P2.1 / master WP3). Pure SQL over the
// WP2 parse foundation: `skill_invocations` (window rows + per-window usage
// rollup) and `turn_usage` (four-field spend). No raw log text is read here.
//
// TWO HARD SPEC RULES this module encodes (§P2.4 + A8):
//   1. Effectiveness is TWO TIERS that are NEVER blended into one number. The
//      advisory composite `observableScore ∈ [0,1]` is computed from the
//      OBSERVABLE tier only; heuristic signals are surfaced with raw counts but
//      never folded into the score. Every input is returned beside the score.
//   2. COST (A8) is a SEPARATE display/ranking dimension rendered BESIDE
//      effectiveness — per-skill tokens-per-invocation (median + spread), with
//      fresh input/output kept SEPARATE from cache reads (four-field model).
//      Cost is NEVER blended into the effectiveness composite (same never-blend
//      rule as the tiers).
//
// SCHEMA REALITY (verified against parse-runner, not assumed):
//   - `skill_invocations.slug` / `working_dir` / `detector` ARE populated.
//   - `skill_invocations.workspace_root` is written NULL by WP2 (A10 population
//     is deferred — FU-D1). WP-D fix leg: we NO LONGER filter on that dead column
//     (a value there excluded EVERY row, reading as "skills unused"). Workspace
//     scope is now the authoritative agents-join (session_id → agents.workspace_id);
//     rows that attribute to no workspace are disclosed via
//     scopeMeta.droppedUnattributedCount, and "byWorkspace" grouping still degrades
//     to COALESCE(workspace_root, slug) — the best available display proxy.
//   - `effectiveness_score` and `skill_effectiveness_signals` are NOT written by
//     WP2; scoring is entirely computed HERE from the persisted window signals
//     (window_error_results / repeated_search / ended_with_question / …).
//
// The DB handle is injected (getDb() in production, the sql.js fake in tests) so
// this stays unit-testable under the system Node `test:supervisor` uses.

import type {
  SkillUsageQuery,
  SkillUsageResult,
  SkillMostUsedRow,
  SkillTimelineRow,
  SkillGroupRow,
  SkillContextSample,
  SkillEffectiveness,
  SkillCostRollup,
  WorkspaceScopeMode,
} from '../../shared/types';

// ── Minimal read-only DB surface (real handle OR the sql.js test fake) ──
export interface QueryDb {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

// ── §P2.4 effectiveness config (single source, panel-overridable). Windows are
// documented semantics; parse-runner already bounds each window to its closing
// end_turn / next-skill, so the persisted signals ARE the in-window aggregates. ──
export const EFFECTIVENESS_CONFIG = {
  turn_count_window: 5,
  wall_clock_window_ms: 600_000,
  repeat_min_cluster: 3,
  repeat_similarity: 0.9,
  // Observable composite weights (documented inline; the score never hides them).
  // base + positive = 1.0 ceiling; penalties subtract; result clamped to [0,1].
  weights: {
    base: 0.5,
    positive: 0.5,          // window produced ≥1 non-error tool_result AND a clean end_turn
    error: 0.25,            // window_error_results > 0
    repeatedSearch: 0.15,   // repeated_search in-window
    endedWithQuestion: 0.15,
  },
} as const;

// ── result caps (no silent truncation — the result flags when it clipped) ──
const TIMELINE_CAP = 5000;
const CONTEXT_SAMPLE_CAP = 50;

// WP-D fix leg — the shared FROM + joins for EVERY aggregate. The agents-join
// (`session_id → agent_sessions → agents`) is the authoritative workspace
// attribution: `skill_invocations.workspace_root` is written NULL by WP2 (A10
// deferred), so filtering on it excludes every row. The agent_sessions dedup
// subquery (MIN(dashboard_agent_id) per session_id) prevents COUNT fan-out when a
// session_id maps to more than one agent row — mirrors the vetted sibling
// mcp-tool-usage-queries.ts. Both joins are LEFT so unattributed rows survive.
const SKILL_JOINS = `FROM skill_invocations si
       LEFT JOIN stream_lane_stats sls ON sls.stream_id = si.stream_id
       LEFT JOIN (
         SELECT session_id, MIN(dashboard_agent_id) AS dashboard_agent_id
         FROM agent_sessions GROUP BY session_id
       ) asx ON asx.session_id = si.session_id
       LEFT JOIN agents ag ON ag.id = asx.dashboard_agent_id`;

// The authoritative workspace scope expression (agents-join first, then the sls
// column if A10 ever populates it). Precedence matches the sibling surface.
const WORKSPACE_SCOPE_EXPR = `COALESCE(ag.workspace_id, sls.workspace_id)`;

function num(v: unknown): number { return typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Median / quartile over an ascending-sorted numeric array (linear interpolation).
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// A finalized skill window as it feeds scoring + cost (one row per invocation).
interface WindowRow {
  skill: string;
  windowOpen: number;
  toolCalls: number;
  errorResults: number;
  endedWithQuestion: number;   // 0/1/null→0
  repeatedSearch: number;      // 0/1/null→0
  windowTruncated: number;     // 1 = stale-finalized (never saw a clean end_turn)
  freshInput: number;
  output: number;
  cacheRead: number;
  usageTurns: number;
}

/**
 * Observable composite for ONE finalized window ∈ [0,1] (§P2.4). Only the
 * observable tier feeds this; heuristic signals never do. Returns null for a
 * still-open window (not yet scorable).
 */
export function scoreObservable(w: WindowRow): number | null {
  if (w.windowOpen === 1) return null;
  const wgt = EFFECTIVENESS_CONFIG.weights;
  const producedWork = w.toolCalls - w.errorResults >= 1;
  const cleanEnd = w.windowTruncated === 0;         // closed on a real end_turn / next-skill
  let s = wgt.base;
  if (producedWork && cleanEnd) s += wgt.positive;
  if (w.errorResults > 0) s -= wgt.error;
  if (w.repeatedSearch === 1) s -= wgt.repeatedSearch;
  if (w.endedWithQuestion === 1) s -= wgt.endedWithQuestion;
  return clamp01(s);
}

export class SkillUsageQueries {
  constructor(private db: QueryDb) {}

  /** The NON-workspace predicate (lane / slug / window), shared by the scoped
   *  filter and the dropped-count probe so the two can never drift. Every clause is
   *  `si.`/`sls.`-qualified because every query reads from the joined FROM
   *  (skill-legibility B1) — the lane filter lives on the stream_lane_stats join,
   *  so it must narrow ALL aggregates. */
  private baseClauses(q: SkillUsageQuery): { clauses: string[]; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.slug) { clauses.push(`COALESCE(si.slug, sls.slug) = ?`); params.push(q.slug); }
    if (q.lane) {
      if (q.lane === 'unknown') clauses.push(`(sls.lane IS NULL OR sls.lane = 'unknown')`);
      else { clauses.push(`sls.lane = ?`); params.push(q.lane); }
    }
    if (q.sinceMs != null) { clauses.push(`si.ts_ms >= ?`); params.push(q.sinceMs); }
    if (q.untilMs != null) { clauses.push(`si.ts_ms <= ?`); params.push(q.untilMs); }
    return { clauses, params };
  }

  /** Base predicate + the workspace-scope predicate for the applied scopeMode (WP-2B).
   *  `global-diagnostic` applies NO workspace filter; `strict` (the vetted default here)
   *  matches only a real agents-join id; `include-proxy` additionally admits slug-proxy
   *  rows (real id NULL) when the slug uniquely maps to the caller workspace — the leak
   *  firewall. `q` is expected to be scope-resolved (see run()). Mirrors the sibling
   *  mcp-tool-usage-queries.ts.whereAndParams. */
  private filterClauses(q: SkillUsageQuery): { clauses: string[]; params: unknown[] } {
    const { clauses, params } = this.baseClauses(q);
    if (q.workspaceId && q.scopeMode !== 'global-diagnostic') {
      if (this.proxyLegActive(q)) {
        clauses.push(
          `(${WORKSPACE_SCOPE_EXPR} = ? OR (${WORKSPACE_SCOPE_EXPR} IS NULL AND COALESCE(si.slug, sls.slug) = ?))`,
        );
        params.push(q.workspaceId, q.slug);
      } else {
        clauses.push(`${WORKSPACE_SCOPE_EXPR} = ?`);
        params.push(q.workspaceId);
      }
    }
    return { clauses, params };
  }

  /** True when the include-proxy slug leg is active for this (scope-resolved) query. */
  private proxyLegActive(q: SkillUsageQuery): boolean {
    return !!(q.workspaceId && q.scopeMode === 'include-proxy' && q.slug && q.slugUniqueToWorkspace);
  }

  /** Whether `slug` maps to EXACTLY the caller workspace and no other. Data-driven: the
   *  slug is safe to admit as a proxy only when every REAL-workspace-id row carrying it
   *  belongs to `workspaceId` (and at least one does). Zero evidence → not unique →
   *  denied, so proxy admission never guesses a cross-workspace link. */
  private slugMapsUniquelyTo(workspaceId: string, slug: string, q: SkillUsageQuery): boolean {
    const { clauses, params } = this.baseClauses(q);
    clauses.push(`COALESCE(si.slug, sls.slug) = ?`); params.push(slug);
    clauses.push(`${WORKSPACE_SCOPE_EXPR} IS NOT NULL`);
    const where = ' WHERE ' + clauses.join(' AND ');
    const rows = this.db.prepare(
      `SELECT DISTINCT ${WORKSPACE_SCOPE_EXPR} AS ws ${SKILL_JOINS}${where}`,
    ).all(...params);
    return rows.length === 1 && String(rows[0].ws) === workspaceId;
  }

  /** Rows admitted into the scoped result ONLY via the slug-proxy leg (real id NULL,
   *  slug matches). 0 unless the proxy leg is active. */
  private proxyIncludedCount(q: SkillUsageQuery): number {
    if (!this.proxyLegActive(q)) return 0;
    const { clauses, params } = this.baseClauses(q);
    clauses.push(`${WORKSPACE_SCOPE_EXPR} IS NULL`);
    clauses.push(`COALESCE(si.slug, sls.slug) = ?`); params.push(q.slug);
    const where = ' WHERE ' + clauses.join(' AND ');
    const row = this.db.prepare(`SELECT COUNT(*) AS n ${SKILL_JOINS}${where}`).get(...params);
    return num(row?.n);
  }

  /** Resolve scope defaults: default scopeMode to 'strict' (skill usage's vetted honest
   *  agents-join scope — the WP-D invariant; NOT the MCP surface's include-proxy default)
   *  and, when the caller did not pre-compute it, decide whether the slug uniquely maps to
   *  the workspace (which unlocks the proxy leg under include-proxy). */
  private resolveScope(q: SkillUsageQuery): SkillUsageQuery {
    const scopeMode: WorkspaceScopeMode = q.scopeMode ?? 'strict';
    let slugUniqueToWorkspace = q.slugUniqueToWorkspace ?? false;
    if (scopeMode === 'include-proxy' && q.workspaceId && q.slug && q.slugUniqueToWorkspace === undefined) {
      slugUniqueToWorkspace = this.slugMapsUniquelyTo(q.workspaceId, q.slug, q);
    }
    return { ...q, scopeMode, slugUniqueToWorkspace };
  }

  /** The filter as a leading `WHERE …` clause (empty string when unfiltered). */
  private filter(q: SkillUsageQuery): { sql: string; params: unknown[] } {
    const { clauses, params } = this.filterClauses(q);
    return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
  }

  /** Count of rows the workspace filter silently drops because they attribute to NO
   *  workspace (`COALESCE(ag.workspace_id, sls.workspace_id) IS NULL`) — they can
   *  never match any `workspaceId`, so scoping hides them regardless of which
   *  workspace is chosen. Surfaced in scopeMeta instead of vanishing. Returns 0 when
   *  no workspace scope is applied (nothing is being dropped on this axis). */
  private droppedUnattributedCount(q: SkillUsageQuery): number {
    if (!q.workspaceId || q.scopeMode === 'global-diagnostic') return 0;
    const { clauses, params } = this.baseClauses(q);
    clauses.push(`${WORKSPACE_SCOPE_EXPR} IS NULL`);
    const where = ' WHERE ' + clauses.join(' AND ');
    const row = this.db.prepare(`SELECT COUNT(*) AS n ${SKILL_JOINS}${where}`).get(...params);
    return num(row?.n) - this.proxyIncludedCount(q);
  }

  /** Whether `skill_invocations` holds ANY row at all — lets the DTO reserve the
   *  `empty_not_instrumented` state for a truly empty table (WB-01). */
  private hasAnyInvocations(): boolean {
    const row = this.db.prepare(`SELECT EXISTS(SELECT 1 FROM skill_invocations) AS n`).get();
    return num(row?.n) > 0;
  }

  /** All finalized+open window rows in scope — grouped in JS for scoring + cost. */
  private windowRows(q: SkillUsageQuery): WindowRow[] {
    const f = this.filter(q);
    const rows = this.db.prepare(
      `SELECT si.skill_name AS skill, si.window_open, si.window_tool_calls, si.window_error_results,
              si.ended_with_question, si.repeated_search, si.window_truncated,
              si.window_fresh_input_tokens, si.window_usage_output_tokens,
              si.window_cache_read_tokens, si.window_usage_turns
       ${SKILL_JOINS}${f.sql}`,
    ).all(...f.params);
    return rows.map((r) => ({
      skill: String(r.skill),
      windowOpen: num(r.window_open),
      toolCalls: num(r.window_tool_calls),
      errorResults: num(r.window_error_results),
      endedWithQuestion: r.ended_with_question == null ? 0 : num(r.ended_with_question),
      repeatedSearch: r.repeated_search == null ? 0 : num(r.repeated_search),
      windowTruncated: num(r.window_truncated),
      freshInput: num(r.window_fresh_input_tokens),
      output: num(r.window_usage_output_tokens),
      cacheRead: num(r.window_cache_read_tokens),
      usageTurns: num(r.window_usage_turns),
    }));
  }

  /** §P2.4 — two-tier effectiveness per skill. Observable composite is the ONLY
   *  scored number; heuristic counts are surfaced but never folded in. */
  effectiveness(q: SkillUsageQuery, rows?: WindowRow[]): SkillEffectiveness[] {
    const wr = rows ?? this.windowRows(q);
    const bySkill = new Map<string, WindowRow[]>();
    for (const w of wr) {
      const arr = bySkill.get(w.skill) ?? [];
      arr.push(w);
      bySkill.set(w.skill, arr);
    }
    // Heuristic tier (§P2.4): user_correction / workflow_followed live in
    // `skill_effectiveness_signals`. WP2 doesn't populate it yet, so counts read
    // 0 today — the tier is still surfaced (its inputs are shown, not hidden).
    const heuristic = this.heuristicCounts(q);
    const out: SkillEffectiveness[] = [];
    for (const [skill, ws] of bySkill) {
      const scores: number[] = [];
      let positive = 0, error = 0, repeat = 0, question = 0;
      for (const w of ws) {
        const s = scoreObservable(w);
        if (s == null) continue;   // open window — not scorable
        scores.push(s);
        if (w.toolCalls - w.errorResults >= 1 && w.windowTruncated === 0) positive++;
        if (w.errorResults > 0) error++;
        if (w.repeatedSearch === 1) repeat++;
        if (w.endedWithQuestion === 1) question++;
      }
      const observableScore = scores.length
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : null;
      const h = heuristic.get(skill) ?? { userCorrection: 0, workflowFollowed: 0 };
      out.push({
        skill,
        observableScore,
        scoredInvocations: scores.length,
        positiveWindows: positive,
        errorWindows: error,
        repeatedSearchWindows: repeat,
        endedWithQuestionWindows: question,
        heuristic: h,
      });
    }
    out.sort((a, b) => (b.observableScore ?? -1) - (a.observableScore ?? -1));
    return out;
  }

  /** Heuristic-tier raw counts per skill from `skill_effectiveness_signals`
   *  (tier='heuristic'). Returns an empty map when the table has no rows. */
  private heuristicCounts(q: SkillUsageQuery): Map<string, { userCorrection: number; workflowFollowed: number }> {
    const map = new Map<string, { userCorrection: number; workflowFollowed: number }>();
    let rows: Record<string, unknown>[];
    try {
      // Signals key on invocation_id; join back to skill_invocations for the skill
      // + to honor the same scope filter (aliased to `si.`).
      const { clauses, params } = this.filterClauses(q);
      const where = ["ses.tier = 'heuristic'", ...clauses].join(' AND ');
      rows = this.db.prepare(
        `SELECT si.skill_name AS skill, ses.signal AS signal, COUNT(*) AS n
         FROM skill_effectiveness_signals ses
         JOIN skill_invocations si ON si.id = ses.invocation_id
         LEFT JOIN stream_lane_stats sls ON sls.stream_id = si.stream_id
         LEFT JOIN (
           SELECT session_id, MIN(dashboard_agent_id) AS dashboard_agent_id
           FROM agent_sessions GROUP BY session_id
         ) asx ON asx.session_id = si.session_id
         LEFT JOIN agents ag ON ag.id = asx.dashboard_agent_id
         WHERE ${where}
         GROUP BY si.skill_name, ses.signal`,
      ).all(...params);
    } catch {
      return map;   // table empty / absent — heuristic tier simply has no data
    }
    for (const r of rows) {
      const skill = String(r.skill);
      const cur = map.get(skill) ?? { userCorrection: 0, workflowFollowed: 0 };
      if (r.signal === 'user_correction') cur.userCorrection += num(r.n);
      else if (r.signal === 'workflow_followed') cur.workflowFollowed += num(r.n);
      map.set(skill, cur);
    }
    return map;
  }

  /** A8 — per-skill token cost rollup (median + spread), rendered BESIDE
   *  effectiveness and NEVER blended into it. Fresh input / output kept separate
   *  from cache reads (four-field model). Only windows that carried usage count. */
  cost(q: SkillUsageQuery, rows?: WindowRow[]): SkillCostRollup[] {
    const wr = (rows ?? this.windowRows(q)).filter((w) => w.usageTurns > 0);
    const bySkill = new Map<string, WindowRow[]>();
    for (const w of wr) {
      const arr = bySkill.get(w.skill) ?? [];
      arr.push(w);
      bySkill.set(w.skill, arr);
    }
    const out: SkillCostRollup[] = [];
    for (const [skill, ws] of bySkill) {
      const fresh = ws.map((w) => w.freshInput + w.output).sort((a, b) => a - b);
      const finput = ws.map((w) => w.freshInput).sort((a, b) => a - b);
      const outp = ws.map((w) => w.output).sort((a, b) => a - b);
      const cread = ws.map((w) => w.cacheRead).sort((a, b) => a - b);
      out.push({
        skill,
        invocations: ws.length,
        freshMedian: Math.round(quantile(fresh, 0.5)),
        freshP25: Math.round(quantile(fresh, 0.25)),
        freshP75: Math.round(quantile(fresh, 0.75)),
        freshInputMedian: Math.round(quantile(finput, 0.5)),
        outputMedian: Math.round(quantile(outp, 0.5)),
        cacheReadMedian: Math.round(quantile(cread, 0.5)),
      });
    }
    out.sort((a, b) => b.freshMedian - a.freshMedian);
    return out;
  }

  private mostUsed(q: SkillUsageQuery, effMap: Map<string, number | null>): SkillMostUsedRow[] {
    const f = this.filter(q);
    const rows = this.db.prepare(
      `SELECT si.skill_name AS skill, COUNT(*) AS count, MAX(si.ts_ms) AS last
       ${SKILL_JOINS}${f.sql}
       GROUP BY si.skill_name ORDER BY count DESC`,
    ).all(...f.params);
    return rows.map((r) => ({
      skill: String(r.skill),
      count: num(r.count),
      avgEffectiveness: effMap.has(String(r.skill)) ? effMap.get(String(r.skill))! : null,
      lastUsedMs: r.last != null ? num(r.last) : null,
    }));
  }

  private timeline(q: SkillUsageQuery): { rows: SkillTimelineRow[]; truncated: boolean } {
    const f = this.filter(q);
    // Enriched (skill-legibility B4): lane / workspaceKey / detector / id /
    // jsonlPath so the click-drill can show a real source identifier per bar
    // with NO renderer-side lane derivation.
    const rows = this.db.prepare(
      `SELECT si.ts_ms, si.skill_name AS skill, si.slug, si.id, si.jsonl_path,
              si.detector,
              COALESCE(sls.lane, 'unknown') AS lane,
              COALESCE(si.workspace_root, si.slug, sls.slug, '(unknown)') AS workspace_key
       ${SKILL_JOINS}${f.sql}
       ORDER BY si.ts_ms DESC LIMIT ?`,
    ).all(...f.params, TIMELINE_CAP + 1);
    const truncated = rows.length > TIMELINE_CAP;
    const clipped = truncated ? rows.slice(0, TIMELINE_CAP) : rows;
    // Return ascending for the timeline chart.
    return {
      rows: clipped
        .map((r) => ({
          tsMs: num(r.ts_ms),
          skill: String(r.skill),
          slug: r.slug == null ? null : String(r.slug),
          lane: String(r.lane ?? 'unknown'),
          workspaceKey: String(r.workspace_key ?? '(unknown)'),
          detector: String(r.detector ?? 'tool_use'),
          id: String(r.id),
          jsonlPath: r.jsonl_path == null ? null : String(r.jsonl_path),
        }))
        .sort((a, b) => a.tsMs - b.tsMs),
      truncated,
    };
  }

  private group(q: SkillUsageQuery, expr: string): SkillGroupRow[] {
    const f = this.filter(q);
    const rows = this.db.prepare(
      `SELECT ${expr} AS key, COUNT(*) AS count
       ${SKILL_JOINS}${f.sql}
       GROUP BY ${expr} ORDER BY count DESC`,
    ).all(...f.params);
    return rows.map((r) => ({ key: r.key == null ? '(unknown)' : String(r.key), count: num(r.count) }));
  }

  private contextSamples(q: SkillUsageQuery): SkillContextSample[] {
    const f = this.filter(q);
    const rows = this.db.prepare(
      `SELECT si.skill_name AS skill, si.ts_ms, si.slug, si.working_dir, si.detector, si.args,
              COALESCE(sls.lane, 'unknown') AS lane
       ${SKILL_JOINS}${f.sql}
       ORDER BY si.ts_ms DESC LIMIT ?`,
    ).all(...f.params, CONTEXT_SAMPLE_CAP);
    return rows.map((r) => ({
      skill: String(r.skill),
      tsMs: num(r.ts_ms),
      slug: r.slug == null ? null : String(r.slug),
      workingDir: r.working_dir == null ? null : String(r.working_dir),
      lane: String(r.lane ?? 'unknown'),
      detector: String(r.detector ?? 'tool_use'),
      args: r.args == null ? null : String(r.args),
    }));
  }

  /** The one entrypoint the IPC handler calls (after ensuring the index). */
  run(q0: SkillUsageQuery): SkillUsageResult {
    const q = this.resolveScope(q0);              // default strict; compute slug uniqueness
    const rows = this.windowRows(q);              // fetched once, reused for eff + cost
    const eff = this.effectiveness(q, rows);
    const cost = this.cost(q, rows);
    const effMap = new Map<string, number | null>(eff.map((e) => [e.skill, e.observableScore]));
    const tl = this.timeline(q);
    const total = rows.length;
    return {
      mostUsed: this.mostUsed(q, effMap),
      timeline: tl.rows,
      timelineTruncated: tl.truncated,
      byWorkspace: this.group(q, `COALESCE(si.workspace_root, si.slug, sls.slug, '(unknown)')`),
      byAgentType: this.group(q, `COALESCE(sls.lane, 'unknown')`),
      byAgentDir: this.group(q, `COALESCE(si.working_dir, sls.working_dir, '(unknown)')`),
      byInvoker: this.group(q, 'si.detector'),
      contextSamples: this.contextSamples(q),
      effectiveness: eff,
      cost,
      totalInvocations: total,
      scopeMeta: {
        // WP2 leaves workspace_root NULL → byWorkspace keys on slug. Never claim
        // a workspace figure the pipeline can't defend (cross-cutting req 5).
        workspaceKeyIsSlugProxy: true,
        windowSinceMs: q.sinceMs ?? null,
        windowUntilMs: q.untilMs ?? null,
        appliedLane: q.lane ?? null,
        appliedSlug: q.slug ?? null,
        // WP-D fix leg — honest agents-join workspace scoping.
        appliedWorkspaceId: q.workspaceId ?? null,
        droppedUnattributedCount: this.droppedUnattributedCount(q),
        hasAnyInvocations: this.hasAnyInvocations(),
        // WP-2B — workspace scope policy disclosure (parity with the MCP surface).
        appliedScopeMode: q.scopeMode,
        proxyIncludedCount: this.proxyIncludedCount(q),
      },
      generatedAtIso: new Date().toISOString(),
    };
  }
}

/** Convenience free function (production wires the parse-first step at the IPC
 *  runner — see `skill-usage-runner.ts` — so this stays pure/testable). */
export function querySkillUsage(db: QueryDb, q: SkillUsageQuery): SkillUsageResult {
  return new SkillUsageQueries(db).run(q);
}
