// behavior-store.ts — the thin QUERY ABSTRACTION over the WP2 parse foundation
// (behavior-grounded-optimizer-design.md §4.3). The occurrence classifier + ADD
// generator read a *behavior model* through this, never raw tool rows.
//
// Internally it unions `behavior_events` + `search_events` and JOINs
// `stream_lane_stats` for lane, and derives per-stream / per-lane token spend from
// `turn_usage` (per §2.1: freshSpend = input + cache_creation + output; cache_read
// is kept SEPARATE and NEVER summed into spend). No raw log text is stored here —
// snippet citations resolve on demand from disk via `byte_offset` elsewhere.
//
// The DB handle is injected (getDb() in production, a sql.js fake in tests) so this
// stays unit-testable under system Node.

import { OPTIMIZER_CONFIG } from './optimizer-config';

// ── Minimal read-only DB surface (real handle OR the sql.js test fake) ──
export interface QueryDb {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

export type Lane = 'supervisor' | 'worker' | 'researcher' | 'legacy' | 'unknown';

// ── Spend model (§2.1 single source of truth) ──
export interface Spend {
  freshSpend: number;   // input + cache_creation + output — the marginal cost
  freshInput: number;   // input + cache_creation
  output: number;
  cacheRead: number;    // resident re-read — reported SEPARATELY, never spend
  turns: number;
}
function emptySpend(): Spend { return { freshSpend: 0, freshInput: 0, output: 0, cacheRead: 0, turns: 0 }; }

// ── Predicates the classifier matches (design §5.2) ──
export type FileAccessMode = 'read' | 'write' | 'executed';

/** WP-1B (Priority 0) — the semantically richer successor to `path-touch`. Matches
 *  on cwd-RESOLVED identity (canonical absolute first, then root-anchored
 *  workspace-relative) and constrains `access_mode`. Deliberately does NO basename /
 *  suffix matching, so an unresolved guidance path can never be counted as touched.
 *  `path-touch` is retained for the legacy glob-based consumers (file-coverage,
 *  knowledge enrichment, parity gate). */
export interface FileAccessPredicate {
  kind: 'file-access';
  path: {
    raw: string;
    canonicalAbs?: string;        // canonical absolute identity (LOWER() is the key)
    workspaceRelative?: string;   // root-anchored workspace-relative identity (fwd-slash)
    base: 'agent-cwd' | 'workspace-root' | 'source-dir' | 'unknown';
  };
  /** Required access mode(s). Empty ⇒ any touch (ambiguous instruction — the
   *  classifier keeps such actions candidate-only, never an observed-safe subtract). */
  modes: FileAccessMode[];
  /** Timing intent. `session-start` windows are NOT yet implemented (brief §5) — the
   *  compiler labels behaviour-derived predicates `unverified` rather than treating any
   *  lifetime touch as session-start compliance. Informational; does not gate the query. */
  timing?: 'session-start' | 'any' | 'unverified';
}

export type BehaviorPredicate =
  | { kind: 'tool-invocation'; toolName: string }
  | { kind: 'toolset-usage'; toolset: string }
  | { kind: 'command-family'; family: string }
  | { kind: 'path-touch'; pathGlob: string }
  | FileAccessPredicate
  | { kind: 'search-pattern'; signatureHash: string }
  | { kind: 'skill-invocation'; skillName: string };

export interface MatchCount {
  occurrences: number;
  distinctStreams: number;
  distinctSlugs: number;
  lastTsMs: number | null;
}

export interface Exposure {
  lane: Lane;
  turnCount: number;      // Σ end_turn (exposure denominator)
  distinctStreams: number;
  distinctSlugs: number;
}

// file_touch usage for a path, split by access_mode (WP3 file-reference stats).
export interface FilePathUsage {
  touches: number;
  reads: number;
  writes: number;
  executes: number;
  distinctStreams: number;
  lastTsMs: number | null;
}

// ── WP-1A (Priority 0) evidence-query shapes ──
/** Epoch/subagent window for the evidence read methods. `lo`/`hi` = epoch bounds
 *  (null ⇒ unbounded on that side), mirroring the exposure resolver. */
export interface EvidenceWindowOpts { includeSubagents: boolean; lo: number | null; hi: number | null }
/** Numerator occurrence sample — byte-locators only (reproducible, redaction-safe). */
export interface EvidenceSampleEvent { streamId: string; entryUuid: string; blockIndex: number; byteOffset: number }
/** Denominator exposure sample — proof the guidance WAS exposed. */
export interface EvidenceSampleStream { streamId: string; turns: number; lane: string }
/** Per-provider (tool_kind) capture coverage + honest lossiness counters. */
export interface CaptureCoverage {
  providers: Record<string, { streams: number; pathEventsSupported: boolean }>;
  unknownToolEvents: number;
  unresolvedPathEvents: number;
}

export interface Cluster {
  lane: Lane;
  dimension: 'command_family' | 'input_shape_hash' | 'search_signature_hash';
  key: string;
  count: number;
  distinctStreams: number;
}

export interface HistogramRow { lane: Lane; key: string; count: number }

// ── R2 WP-4B (Step 3) exemplar-drill shapes ──────────────────────────────────
/** A byte-locator for one exemplar-backing event (redaction-safe: identifiers only,
 *  resolves a snippet on demand from disk). */
export interface ClusterExemplarEventRef { entryUuid: string; blockIndex: number; byteOffset: number }
/** One redacted STRUCTURAL exemplar behind a hash-only cluster rollup. NEVER carries a
 *  raw prompt or input value — only:
 *   - input_shape_hash: the tool SHORT name + the sorted input KEY NAMES (`inputKeys`);
 *   - search_signature_hash: normalized (already path-redacted) search TERMS.
 *  `count`/`distinctStreams` are the cluster's cross-session recurrence; `eventRefs` are
 *  capped byte-locators for on-demand citation. */
export interface ClusterExemplar {
  ref: string;                    // the opaque hash key (input_shape_hash / search_signature_hash)
  toolShortName?: string;         // input_shape_hash only
  inputKeys?: string[];           // input_shape_hash only — sorted key NAMES (never values)
  searchTerms?: string[];         // search_signature_hash only — normalized terms (already redacted)
  count: number;
  distinctStreams: number;
  eventRefs: ClusterExemplarEventRef[];
}
export interface ClusterExemplarPage { exemplars: ClusterExemplar[]; nextCursor?: string }

/** Tool DISPLAY short name: strip a leading `mcp__<server>__` prefix down to the tool's
 *  last segment (so `mcp__agent-dashboard__read_agent_chat` → `read_agent_chat`);
 *  otherwise return the name unchanged. */
export function shortToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts[parts.length - 1] || name;
  }
  return name;
}

// Opaque offset cursor for the exemplar drill (base64 of the numeric OFFSET). Simple by
// design — the exemplar page order is a stable count-desc/ref-asc, so an offset is a
// sound resume point. Malformed / negative decodes to 0 (fail-open to page 1).
function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`ofs:${offset}`, 'utf8').toString('base64');
}
function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const m = /^ofs:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    const n = m ? parseInt(m[1], 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

// Glob → SQL LIKE (case-insensitive; `*`→`%`, `?`→`_`; escape existing LIKE metachars).
function globToLike(glob: string): string {
  return glob.replace(/[%_\\]/g, (c) => '\\' + c).replace(/\*/g, '%').replace(/\?/g, '_').toLowerCase();
}

// Build a `stream_id IN (…)` lane filter fragment + params (empty → no filter).
function laneFilter(lanes: Lane[] | undefined, col = 'sls.lane'): { sql: string; params: string[] } {
  if (!lanes || lanes.length === 0) return { sql: '', params: [] };
  const placeholders = lanes.map(() => '?').join(', ');
  return { sql: ` AND ${col} IN (${placeholders})`, params: lanes as string[] };
}

export class BehaviorStore {
  constructor(private db: QueryDb) {}

  /** design §5.2 — occurrences of a predicate across the given lanes (all lanes if omitted). */
  countMatching(pred: BehaviorPredicate, lanes?: Lane[], sinceMs?: number): MatchCount {
    const since = sinceMs != null ? ` AND ev.ts_ms >= ?` : '';
    const sinceParam = sinceMs != null ? [sinceMs] : [];

    if (pred.kind === 'search-pattern') {
      const lf = laneFilter(lanes);
      const row = this.db.prepare(
        `SELECT COUNT(*) AS occ, COUNT(DISTINCT ev.stream_id) AS ds, COUNT(DISTINCT sls.slug) AS dg, MAX(ev.ts_ms) AS last
         FROM search_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
         WHERE ev.search_signature_hash = ?${lf.sql}${since}`,
      ).get(pred.signatureHash, ...lf.params, ...sinceParam);
      return toMatchCount(row);
    }

    if (pred.kind === 'skill-invocation') {
      const lf = laneFilter(lanes);
      const row = this.db.prepare(
        `SELECT COUNT(*) AS occ, COUNT(DISTINCT ev.stream_id) AS ds, COUNT(DISTINCT sls.slug) AS dg, MAX(ev.ts_ms) AS last
         FROM skill_invocations ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
         WHERE ev.skill_name = ?${lf.sql}${sinceMs != null ? ' AND ev.ts_ms >= ?' : ''}`,
      ).get(pred.skillName, ...lf.params, ...sinceParam);
      return toMatchCount(row);
    }

    if (pred.kind === 'file-access') {
      // Resolved-identity match: canonical absolute OR root-anchored workspace-rel.
      // NULL columns (historical / unresolved rows) never satisfy `LOWER(col)=?`, so
      // they are excluded — no suffix/basename fallback. An unresolved predicate
      // (no identity at all) matches nothing (candidate-only).
      const idParts: string[] = [];
      const idParams: string[] = [];
      if (pred.path.canonicalAbs) { idParts.push(`LOWER(ev.arg_path_canonical) = ?`); idParams.push(pred.path.canonicalAbs.toLowerCase()); }
      if (pred.path.workspaceRelative != null) { idParts.push(`LOWER(ev.arg_path_workspace_rel) = ?`); idParams.push(pred.path.workspaceRelative.toLowerCase()); }
      if (idParts.length === 0) return toMatchCount(undefined);
      const modeSql = pred.modes.length ? ` AND ev.access_mode IN (${pred.modes.map(() => '?').join(', ')})` : '';
      const lf = laneFilter(lanes);
      const row = this.db.prepare(
        `SELECT COUNT(*) AS occ, COUNT(DISTINCT ev.stream_id) AS ds, COUNT(DISTINCT sls.slug) AS dg, MAX(ev.ts_ms) AS last
         FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
         WHERE ev.kind = 'file_touch' AND (${idParts.join(' OR ')})${modeSql}${lf.sql}${since}`,
      ).get(...idParams, ...pred.modes, ...lf.params, ...sinceParam);
      return toMatchCount(row);
    }

    // behavior_events-backed predicates
    let where = '';
    let param: unknown;
    switch (pred.kind) {
      case 'tool-invocation': where = `ev.kind = 'tool_use' AND ev.tool_name = ?`; param = pred.toolName; break;
      case 'toolset-usage':   where = `ev.mcp_toolset = ?`; param = pred.toolset; break;
      case 'command-family':  where = `ev.command_family = ?`; param = pred.family; break;
      case 'path-touch':      where = `ev.kind = 'file_touch' AND LOWER(ev.arg_path) LIKE ? ESCAPE '\\'`; param = globToLike(pred.pathGlob); break;
    }
    const lf = laneFilter(lanes);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS occ, COUNT(DISTINCT ev.stream_id) AS ds, COUNT(DISTINCT sls.slug) AS dg, MAX(ev.ts_ms) AS last
       FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
       WHERE ${where}${lf.sql}${since}`,
    ).get(param, ...lf.params, ...sinceParam);
    return toMatchCount(row);
  }

  /** WP3 — file_touch usage for a path glob across the given lanes, split by
   *  access_mode (read/write/executed). Mirrors the `path-touch` branch of
   *  `countMatching` but keeps the r/w/x breakdown + total distinct streams so the
   *  knowledge panel can show how a file-reference is actually exercised. */
  usageForFilePath(pathGlob: string, lanes?: Lane[], sinceMs?: number): FilePathUsage {
    const like = globToLike(pathGlob);
    const lf = laneFilter(lanes);
    const since = sinceMs != null ? ` AND ev.ts_ms >= ?` : '';
    const sinceParam = sinceMs != null ? [sinceMs] : [];
    const where = `ev.kind = 'file_touch' AND LOWER(ev.arg_path) LIKE ? ESCAPE '\\'`;
    // Per-mode counts (a stream can touch in >1 mode, so distinct-stream totals come
    // from a separate ungrouped roll-up to avoid double counting).
    const modeRows = this.db.prepare(
      `SELECT ev.access_mode AS mode, COUNT(*) AS occ
       FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
       WHERE ${where}${lf.sql}${since}
       GROUP BY ev.access_mode`,
    ).all(like, ...lf.params, ...sinceParam);
    const total = this.db.prepare(
      `SELECT COUNT(*) AS occ, COUNT(DISTINCT ev.stream_id) AS ds, MAX(ev.ts_ms) AS last
       FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
       WHERE ${where}${lf.sql}${since}`,
    ).get(like, ...lf.params, ...sinceParam);
    let reads = 0, writes = 0, executes = 0;
    for (const r of modeRows) {
      const occ = num(r.occ);
      switch (String(r.mode)) {
        case 'read': reads += occ; break;
        case 'write': writes += occ; break;
        case 'executed': executes += occ; break;
        default: break; // null/unknown access_mode counts toward touches only
      }
    }
    return {
      touches: num(total?.occ),
      reads, writes, executes,
      distinctStreams: num(total?.ds),
      lastTsMs: total?.last != null ? num(total.last) : null,
    };
  }

  // ── WP-1A (Priority 0) — fail-closed `never` evidence backing ─────────────────
  // Three read methods the production EvidenceResolver composes into an auditable
  // OccurrenceEvidenceV1: numerator occurrence samples, denominator exposure samples,
  // and per-provider capture coverage. All lane/epoch-window scoped and identifiers-
  // only (no raw path text) so the audit payload is redaction-safe.

  /** Numerator: sampled matching events for a predicate, carrying the byte-locators
   *  (`stream_id, entry_uuid, block_index, byte_offset`) that make a match reproducible.
   *  For a zero-match `never` this is empty BY CONSTRUCTION (numerator is 0) — kept for
   *  the occurs-side / near-miss audit. Only behavior_events-backed predicates carry
   *  these columns; `search-pattern`/`skill-invocation` return [] (no byte-offset cols). */
  sampleMatchingEvents(
    pred: BehaviorPredicate, lanes: Lane[], opts: EvidenceWindowOpts, cap: number,
  ): EvidenceSampleEvent[] {
    if (!lanes.length || cap <= 0) return [];
    let where = '';
    const params: unknown[] = [];
    if (pred.kind === 'file-access') {
      const idParts: string[] = [];
      if (pred.path.canonicalAbs) { idParts.push(`LOWER(ev.arg_path_canonical) = ?`); params.push(pred.path.canonicalAbs.toLowerCase()); }
      if (pred.path.workspaceRelative != null) { idParts.push(`LOWER(ev.arg_path_workspace_rel) = ?`); params.push(pred.path.workspaceRelative.toLowerCase()); }
      if (idParts.length === 0) return [];
      const modeSql = pred.modes.length ? ` AND ev.access_mode IN (${pred.modes.map(() => '?').join(', ')})` : '';
      where = `ev.kind = 'file_touch' AND (${idParts.join(' OR ')})${modeSql}`;
      params.push(...pred.modes);
    } else if (pred.kind === 'tool-invocation') { where = `ev.kind = 'tool_use' AND ev.tool_name = ?`; params.push(pred.toolName); }
    else if (pred.kind === 'toolset-usage') { where = `ev.mcp_toolset = ?`; params.push(pred.toolset); }
    else if (pred.kind === 'command-family') { where = `ev.command_family = ?`; params.push(pred.family); }
    else if (pred.kind === 'path-touch') { where = `ev.kind = 'file_touch' AND LOWER(ev.arg_path) LIKE ? ESCAPE '\\'`; params.push(globToLike(pred.pathGlob)); }
    else return []; // search-pattern / skill-invocation — no byte-offset columns
    const w = this.windowClause(lanes, opts);
    const rows = this.db.prepare(
      `SELECT ev.stream_id AS sid, ev.entry_uuid AS uuid, ev.block_index AS bidx, ev.byte_offset AS boff
         FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ${where}${w.sql}
        ORDER BY ev.ts_ms DESC, ev.stream_id ASC
        LIMIT ?`,
    ).all(...params, ...w.params, cap);
    return rows.map((r) => ({
      streamId: String(r.sid ?? ''),
      entryUuid: String(r.uuid ?? ''),
      blockIndex: num(r.bidx),
      byteOffset: num(r.boff),
    }));
  }

  /** Denominator: sampled EXPOSURE streams (proof the guidance WAS exposed), mirroring
   *  the epoch-bounded exposure resolver but per-stream. These are exposure streams,
   *  NOT matching streams (numerator is 0 for a true `never`). */
  sampleExposureStreams(lanes: Lane[], opts: EvidenceWindowOpts, cap: number): EvidenceSampleStream[] {
    if (!lanes.length || cap <= 0) return [];
    const w = this.windowClause(lanes, opts);
    const rows = this.db.prepare(
      `SELECT ev.stream_id AS sid, COUNT(*) AS turns, sls.lane AS lane
         FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind = 'turn_outcome'${w.sql}
        GROUP BY ev.stream_id, sls.lane
        ORDER BY turns DESC, ev.stream_id ASC
        LIMIT ?`,
    ).all(...w.params, cap);
    return rows.map((r) => ({ streamId: String(r.sid ?? ''), turns: num(r.turns), lane: String(r.lane ?? 'unknown') }));
  }

  /** Capture coverage over the denominator window: which provider buckets (keyed by
   *  `tool_kind`, since there is no `provider` column) emitted events, whether each
   *  bucket emits resolvable file paths, and the honest lossiness counters. This is the
   *  provider-column-free proxy the fail-closed gates read. */
  captureCoverageFor(lanes: Lane[], opts: EvidenceWindowOpts): CaptureCoverage {
    const empty: CaptureCoverage = { providers: {}, unknownToolEvents: 0, unresolvedPathEvents: 0 };
    if (!lanes.length) return empty;
    const w = this.windowClause(lanes, opts);
    // providers: only tool/file activity carries a provider identity (turn_outcome
    // rows have no tool_kind and would pollute an 'unknown' bucket).
    const provRows = this.db.prepare(
      `SELECT COALESCE(ev.tool_kind, 'unknown') AS bucket,
              COUNT(DISTINCT ev.stream_id) AS streams,
              MAX(CASE WHEN ev.kind = 'file_touch' AND ev.arg_path_canonical IS NOT NULL THEN 1 ELSE 0 END) AS pathok
         FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind IN ('tool_use', 'file_touch')${w.sql}
        GROUP BY bucket`,
    ).all(...w.params);
    const providers: CaptureCoverage['providers'] = {};
    for (const r of provRows) {
      providers[String(r.bucket)] = { streams: num(r.streams), pathEventsSupported: num(r.pathok) === 1 };
    }
    const unknownRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind = 'tool_use' AND ev.tool_kind IS NULL${w.sql}`,
    ).get(...w.params);
    const unresolvedRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.kind = 'file_touch' AND ev.arg_path_canonical IS NULL AND ev.arg_path_workspace_rel IS NULL${w.sql}`,
    ).get(...w.params);
    return { providers, unknownToolEvents: num(unknownRow?.c), unresolvedPathEvents: num(unresolvedRow?.c) };
  }

  /** Shared lane + subagent + epoch-window clause (mirrors the exposure resolver's
   *  `(? = 1 OR sls.is_subagent = 0)` + `(? IS NULL OR ev.ts_ms …)` shape). */
  private windowClause(lanes: Lane[], opts: EvidenceWindowOpts): { sql: string; params: unknown[] } {
    const placeholders = lanes.map(() => '?').join(', ');
    return {
      sql: ` AND sls.lane IN (${placeholders})`
        + ` AND (? = 1 OR sls.is_subagent = 0)`
        + ` AND (? IS NULL OR ev.ts_ms >= ?)`
        + ` AND (? IS NULL OR ev.ts_ms <= ?)`,
      params: [...lanes, opts.includeSubagents ? 1 : 0, opts.lo, opts.lo, opts.hi, opts.hi],
    };
  }

  /** design §4.3 — exposure denominator for a lane (Σ turn_count + distinct streams/slugs). */
  exposureForLane(lane: Lane): Exposure {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(turn_count), 0) AS tc, COUNT(*) AS ds, COUNT(DISTINCT slug) AS dg
       FROM stream_lane_stats WHERE lane = ?`,
    ).get(lane);
    return {
      lane,
      turnCount: num(row?.tc),
      distinctStreams: num(row?.ds),
      distinctSlugs: num(row?.dg),
    };
  }

  /**
   * Per-lane histogram over one behavior dimension. `dimension`:
   *  - 'tool_name' | 'mcp_toolset' | 'command_family' → behavior_events
   *  - 'skill_name' → skill_invocations (reproduces the 239-supervisor orchestration histogram)
   */
  laneHistogram(dimension: 'tool_name' | 'mcp_toolset' | 'command_family' | 'skill_name'): HistogramRow[] {
    const table = dimension === 'skill_name' ? 'skill_invocations' : 'behavior_events';
    const kindFilter = dimension === 'tool_name' ? ` AND ev.kind = 'tool_use'` : '';
    const rows = this.db.prepare(
      `SELECT sls.lane AS lane, ev.${dimension} AS key, COUNT(*) AS count
       FROM ${table} ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
       WHERE ev.${dimension} IS NOT NULL${kindFilter}
       GROUP BY sls.lane, ev.${dimension}
       ORDER BY count DESC`,
    ).all();
    return rows.map((r) => ({ lane: (r.lane as Lane) ?? 'unknown', key: String(r.key), count: num(r.count) }));
  }

  /**
   * design §5.3 — repeated-behavior clusters in a lane, grouped by command_family /
   * input_shape_hash / search_signature_hash. Kept only when count ≥ minCount AND
   * distinctStreams ≥ minStreams (cross-session — one agent's tic doesn't qualify).
   */
  improvisationClusters(lane: Lane, opts: { minCount: number; minStreams: number }): Cluster[] {
    const out: Cluster[] = [];
    const push = (dimension: Cluster['dimension'], rows: Record<string, unknown>[]): void => {
      for (const r of rows) {
        out.push({ lane, dimension, key: String(r.key), count: num(r.count), distinctStreams: num(r.ds) });
      }
    };
    const beGroup = (col: string, extra = ''): Record<string, unknown>[] =>
      this.db.prepare(
        `SELECT ev.${col} AS key, COUNT(*) AS count, COUNT(DISTINCT ev.stream_id) AS ds
         FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
         WHERE sls.lane = ? AND ev.${col} IS NOT NULL${extra}
         GROUP BY ev.${col}
         HAVING count >= ? AND ds >= ?`,
      ).all(lane, opts.minCount, opts.minStreams);
    push('command_family', beGroup('command_family'));
    push('input_shape_hash', beGroup('input_shape_hash', ` AND ev.kind = 'tool_use'`));
    push('search_signature_hash', this.db.prepare(
      `SELECT ev.search_signature_hash AS key, COUNT(*) AS count, COUNT(DISTINCT ev.stream_id) AS ds
       FROM search_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
       WHERE sls.lane = ? AND ev.search_signature_hash IS NOT NULL AND ev.search_signature_hash <> ''
       GROUP BY ev.search_signature_hash
       HAVING count >= ? AND ds >= ?`,
    ).all(lane, opts.minCount, opts.minStreams));
    return out;
  }

  /**
   * R2 WP-4B (Step 3) — the real, REDACTED exemplar drill behind a hash-only cluster
   * rollup. Given a lane + hash dimension, returns one structural exemplar per distinct
   * hash key (paginated, count-desc/ref-asc), NEVER a raw prompt or input value:
   *   - `input_shape_hash`: the tool short name + the sorted input KEY NAMES (from the
   *     `input_key_set` column — the same set that produced the hash; NULL on pre-WP4B
   *     rows → the exemplar honestly degrades to the tool short name only).
   *   - `search_signature_hash`: the normalized (already path-redacted at ingest) search
   *     TERMS from `normalized_query`.
   * Each exemplar carries capped byte-locator `eventRefs` for on-demand citation. The
   * cursor is an opaque OFFSET (stable page order). `command_family` is not a hash-only
   * dimension (it carries a readable key) → an empty page.
   */
  clusterExemplars(
    lane: Lane,
    dimension: Cluster['dimension'],
    opts: { cursor?: string; limit?: number } = {},
  ): ClusterExemplarPage {
    if (dimension === 'command_family') return { exemplars: [] };
    const limit = Math.max(1, Math.min(
      opts.limit ?? OPTIMIZER_CONFIG.CLUSTER_EXEMPLARS_DEFAULT_LIMIT,
      OPTIMIZER_CONFIG.CLUSTER_EXEMPLARS_MAX_LIMIT));
    const offset = decodeOffsetCursor(opts.cursor);
    const refsCap = OPTIMIZER_CONFIG.CLUSTER_EXEMPLAR_EVENT_REFS_CAP;
    const keysCap = OPTIMIZER_CONFIG.CLUSTER_EXEMPLAR_INPUT_KEYS_CAP;
    const termsCap = OPTIMIZER_CONFIG.CLUSTER_EXEMPLAR_SEARCH_TERMS_CAP;

    // Fetch limit+1 to detect a further page without a second COUNT query.
    const exemplars: ClusterExemplar[] = [];
    if (dimension === 'input_shape_hash') {
      // Bare (tool_name, input_key_set) are constant within a hash group by construction
      // (the hash folds both); MAX() is deterministic and prefers a non-null key set.
      const rows = this.db.prepare(
        `SELECT ev.input_shape_hash AS ref, MAX(ev.tool_name) AS tool, MAX(ev.input_key_set) AS keyset,
                COUNT(*) AS count, COUNT(DISTINCT ev.stream_id) AS ds
           FROM behavior_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
          WHERE sls.lane = ? AND ev.kind = 'tool_use' AND ev.input_shape_hash IS NOT NULL
          GROUP BY ev.input_shape_hash
          ORDER BY count DESC, ref ASC
          LIMIT ? OFFSET ?`,
      ).all(lane, limit + 1, offset);
      for (const r of rows.slice(0, limit)) {
        const ref = String(r.ref);
        exemplars.push({
          ref,
          toolShortName: shortToolName(String(r.tool ?? '')),
          inputKeys: String(r.keyset ?? '').split(',').filter(Boolean).slice(0, keysCap),
          count: num(r.count),
          distinctStreams: num(r.ds),
          eventRefs: this.exemplarEventRefs('behavior_events', 'input_shape_hash', ref, lane, refsCap),
        });
      }
      return this.pageOf(exemplars, rows.length > limit, offset, limit);
    }

    // search_signature_hash — normalized_query is ALREADY redacted at ingest (paths→<path>).
    const rows = this.db.prepare(
      `SELECT ev.search_signature_hash AS ref, MAX(ev.normalized_query) AS nq,
              COUNT(*) AS count, COUNT(DISTINCT ev.stream_id) AS ds
         FROM search_events ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE sls.lane = ? AND ev.search_signature_hash IS NOT NULL AND ev.search_signature_hash <> ''
        GROUP BY ev.search_signature_hash
        ORDER BY count DESC, ref ASC
        LIMIT ? OFFSET ?`,
    ).all(lane, limit + 1, offset);
    for (const r of rows.slice(0, limit)) {
      const ref = String(r.ref);
      exemplars.push({
        ref,
        searchTerms: String(r.nq ?? '').split(/\s+/).filter(Boolean).slice(0, termsCap),
        count: num(r.count),
        distinctStreams: num(r.ds),
        eventRefs: this.exemplarEventRefs('search_events', 'search_signature_hash', ref, lane, refsCap),
      });
    }
    return this.pageOf(exemplars, rows.length > limit, offset, limit);
  }

  /** Capped byte-locators for one exemplar's backing events, lane-scoped (earliest first
   *  for a stable sample). Identifiers only — the snippet resolves on demand from disk. */
  private exemplarEventRefs(
    table: 'behavior_events' | 'search_events', hashCol: string, ref: string, lane: Lane, cap: number,
  ): ClusterExemplarEventRef[] {
    const kindFilter = table === 'behavior_events' ? ` AND ev.kind = 'tool_use'` : '';
    const rows = this.db.prepare(
      `SELECT ev.entry_uuid AS uuid, ev.block_index AS bidx, ev.byte_offset AS boff
         FROM ${table} ev JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
        WHERE ev.${hashCol} = ? AND sls.lane = ?${kindFilter}
        ORDER BY ev.ts_ms ASC
        LIMIT ?`,
    ).all(ref, lane, cap);
    return rows.map((r) => ({ entryUuid: String(r.uuid ?? ''), blockIndex: num(r.bidx), byteOffset: num(r.boff) }));
  }

  private pageOf(exemplars: ClusterExemplar[], hasMore: boolean, offset: number, limit: number): ClusterExemplarPage {
    return hasMore ? { exemplars, nextCursor: encodeOffsetCursor(offset + limit) } : { exemplars };
  }

  /** Per-stream token spend, DERIVED from turn_usage (never a stored accumulator). */
  streamSpend(streamId: string): Spend {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(input_tokens + cache_creation_tokens + output_tokens), 0) AS fresh,
              COALESCE(SUM(input_tokens + cache_creation_tokens), 0) AS finput,
              COALESCE(SUM(output_tokens), 0) AS out,
              COALESCE(SUM(cache_read_tokens), 0) AS cread,
              COUNT(*) AS turns
       FROM turn_usage WHERE stream_id = ?`,
    ).get(streamId);
    return spendFromRow(row);
  }

  /** Per-lane token spend, DERIVED — Σ over the lane's streams. */
  laneSpend(lane: Lane): Spend {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(tu.input_tokens + tu.cache_creation_tokens + tu.output_tokens), 0) AS fresh,
              COALESCE(SUM(tu.input_tokens + tu.cache_creation_tokens), 0) AS finput,
              COALESCE(SUM(tu.output_tokens), 0) AS out,
              COALESCE(SUM(tu.cache_read_tokens), 0) AS cread,
              COUNT(*) AS turns
       FROM turn_usage tu JOIN stream_lane_stats sls ON sls.stream_id = tu.stream_id
       WHERE sls.lane = ?`,
    ).get(lane);
    return spendFromRow(row);
  }

  /** Per-window usage rollup (fast read off skill_invocations; turn_usage is authoritative). */
  windowUsage(invocationId: string): { freshInput: number; output: number; cacheRead: number; turns: number; freshSpend: number } | null {
    const row = this.db.prepare(
      `SELECT window_fresh_input_tokens AS finput, window_usage_output_tokens AS out,
              window_cache_read_tokens AS cread, window_usage_turns AS turns
       FROM skill_invocations WHERE id = ?`,
    ).get(invocationId);
    if (!row) return null;
    const freshInput = num(row.finput);
    const output = num(row.out);
    return { freshInput, output, cacheRead: num(row.cread), turns: num(row.turns), freshSpend: freshInput + output };
  }
}

// ── helpers ──
function num(v: unknown): number { return typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0; }
function toMatchCount(row: Record<string, unknown> | undefined): MatchCount {
  return {
    occurrences: num(row?.occ),
    distinctStreams: num(row?.ds),
    distinctSlugs: num(row?.dg),
    lastTsMs: row?.last != null ? num(row.last) : null,
  };
}
function spendFromRow(row: Record<string, unknown> | undefined): Spend {
  return {
    freshSpend: num(row?.fresh),
    freshInput: num(row?.finput),
    output: num(row?.out),
    cacheRead: num(row?.cread),
    turns: num(row?.turns),
  };
}
