// P0.4 — parse orchestration (the integration hub).
//
// Streaming per-pass algorithm over the historical `.jsonl` corpus:
//   1. Rehydrate open windows (skill_invocations.window_open=1) → per-stream active window.
//   2. For each file, for each newly-parsed entry IN ORDER, apply the §2.3 intra-entry
//      order: skill-open → window-affecting tool events (P0.7 guard) → usage → end_turn
//      finalize. Snippets (A9), executed-file/behavior events (A1/§4.4), and search rows
//      are emitted along the way.
//   3. After all files, stale-finalize any window idle > WINDOW_STALE_MS (window_truncated=1).
//
// Every write is `INSERT OR IGNORE` on a deterministic id (exactly-once, rebuild-safe);
// per-stream aggregates (stream_lane_stats, window rollups) are RECOMPUTED from the
// deduped rows rather than blindly incremented, so a re-run drifts ZERO counters.
// Each file's rows + its cursor advance commit in ONE transaction (§5.3 resume invariant).
//
// This module owns NO filesystem policy: the caller injects `readNewLines` and the
// stream list, so tests drive it with in-memory line data and a sql.js DB stand-in.
// Reads are strictly read-only; nothing here writes into ~/.claude/projects.

import {
  detectSkillInvocations,
  classifyToolUse,
  extractBehaviorEvents,
  extractTurnUsage,
  isEndTurn,
  endsWithQuestion,
  isSubstantiveUserEntry,
  selectTriggerSnippet,
  type RawEntry,
  type StreamCtx,
  type PriorUserEntry,
  type BehaviorEventRaw,
} from './skill-events';
import {
  rebuildDecision,
  type StreamMeta,
  type TailRead,
  type CursorState,
} from './jsonl-scanner';
import { laneForWorkingDir } from '../context-optimizer/lane-attribution';
import { WORKSPACE_LINEAGE_VERSION, type WorkspaceLineage } from './workspace-lineage';

// ONE parser_version across the whole WP2 landing (A8/A9/A1 ship together — Fix-5).
// A *post-ship* extraction change bumps this; A/B/C amendments do NOT each bump it.
export const PARSER_VERSION = 1;

// A window with no event for this long is stale-finalized (window_truncated=1). P0.4.
export const WINDOW_STALE_MS = 10 * 60 * 1000;

// Cap the in-pass prior-user ring; selectTriggerSnippet only looks back 8 entries.
const PRIOR_USER_RING_CAP = 32;

// ── Minimal better-sqlite3-shaped surface (real handle OR the sql.js test fake) ──
export interface ParseStmt {
  run(...params: unknown[]): { changes?: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface ParseDb {
  prepare(sql: string): ParseStmt;
  exec(sql: string): unknown;
  transaction<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => unknown;
}

export interface IndexProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  rowsAdded: number;
  currentFile: string;
}

export interface ParseDeps {
  db: ParseDb;
  streams: StreamMeta[];
  readNewLines(jsonlPath: string, byteOffset: number): TailRead;
  knownSkills: Set<string>;
  resolveMcpToolset?: (toolName: string) => string | null;
  // WP-2B — workspace-LEVEL lineage resolver: folds a launch cwd → the workspace that
  // owns it (or null when ambiguous). Injected (backed by the workspaces registry) so
  // the runner stays IO-free/testable; absent → workspace_id/root stay null and
  // WP-1B's arg_path_workspace_rel remains inert. NEVER per-agent (shared-cwd invariant).
  resolveWorkspaceLineage?: (workingDir: string | null) => WorkspaceLineage | null;
  nowMs?: number;                 // injectable clock (tests); defaults to Date.now()
  parserVersion?: number;         // override for tests; defaults to PARSER_VERSION
  onProgress?: (p: IndexProgress) => void;
  // Backfill chunking (parse-manager): when the full corpus is parsed in slices across
  // ticks, each slice passes `skipStaleFinalize: true` so a window still open at a chunk
  // boundary is not prematurely truncated; the manager runs one final stale pass at the end.
  skipStaleFinalize?: boolean;
}

export interface ParseResult {
  filesScanned: number;
  filesParsed: number;            // files that had new bytes
  rowsAdded: number;              // approximate (skill_invocations + behavior + usage + search)
  invocationsAdded: number;
  rebuilds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepared-statement bundle (built once per pass; reused across all files)
// ─────────────────────────────────────────────────────────────────────────────
interface Stmts {
  getCursor: ParseStmt;
  upsertCursor: ParseStmt;
  getInvocation: ParseStmt;
  insertInvocation: ParseStmt;
  finalizeInvocation: ParseStmt;
  markRepeatedSearch: ParseStmt;
  bumpWindowToolCall: ParseStmt;
  bumpWindowError: ParseStmt;
  touchWindowTs: ParseStmt;
  windowRollup: ParseStmt;
  getWindowEvent: ParseStmt;
  insertWindowEvent: ParseStmt;
  pruneWindowEvents: ParseStmt;
  insertBehavior: ParseStmt;
  insertSearch: ParseStmt;
  insertUsage: ParseStmt;
  insertSnippet: ParseStmt;
  ensureLaneStats: ParseStmt;
  updateLaneCwd: ParseStmt;
  updateLaneWorkspace: ParseStmt;
  recomputeLaneStats: ParseStmt;
  openWindowsAll: ParseStmt;
  // rebuild deletes
  delInvocations: ParseStmt;
  delBehavior: ParseStmt;
  delUsage: ParseStmt;
  delSearch: ParseStmt;
  delSnippets: ParseStmt;
  delWindowEvents: ParseStmt;
}

function buildStmts(db: ParseDb): Stmts {
  return {
    getCursor: db.prepare(
      `SELECT byte_offset, first_fingerprint, parser_version FROM skill_parse_cursors WHERE jsonl_path = ?`,
    ),
    upsertCursor: db.prepare(
      `INSERT INTO skill_parse_cursors (jsonl_path, first_fingerprint, byte_offset, size_bytes, parser_version, last_parsed_at)
       VALUES (@jsonl_path, @first_fingerprint, @byte_offset, @size_bytes, @parser_version, @last_parsed_at)
       ON CONFLICT(jsonl_path) DO UPDATE SET
         first_fingerprint = @first_fingerprint, byte_offset = @byte_offset, size_bytes = @size_bytes,
         parser_version = @parser_version, last_parsed_at = @last_parsed_at`,
    ),
    getInvocation: db.prepare(
      `SELECT id, window_open, window_last_ts, start_ts_ms, ts_ms, ended_with_question FROM skill_invocations WHERE id = ?`,
    ),
    insertInvocation: db.prepare(
      `INSERT OR IGNORE INTO skill_invocations
        (id, stream_id, jsonl_path, session_id, parent_session_id, sub_agent_name, working_dir, workspace_root, slug,
         ts_ms, skill_name, args, detector, window_open, window_last_ts, window_tool_calls, window_error_results,
         window_output_tokens, start_ts_ms, start_turn_index)
       VALUES
        (@id, @stream_id, @jsonl_path, @session_id, @parent_session_id, @sub_agent_name, @working_dir, @workspace_root, @slug,
         @ts_ms, @skill_name, @args, @detector, 1, @window_last_ts, 0, 0,
         0, @start_ts_ms, @start_turn_index)`,
    ),
    finalizeInvocation: db.prepare(
      `UPDATE skill_invocations SET
         window_open = 0, end_turn_index = @end_turn_index, end_ts_ms = @end_ts_ms, window_dur_ms = @window_dur_ms,
         window_output_tokens = @window_output_tokens, window_fresh_input_tokens = @window_fresh_input_tokens,
         window_cache_read_tokens = @window_cache_read_tokens, window_usage_output_tokens = @window_usage_output_tokens,
         window_usage_turns = @window_usage_turns, ended_with_question = @ended_with_question,
         window_truncated = @window_truncated
       WHERE id = @id`,
    ),
    markRepeatedSearch: db.prepare(`UPDATE skill_invocations SET repeated_search = 1 WHERE id = ?`),
    bumpWindowToolCall: db.prepare(
      `UPDATE skill_invocations SET window_tool_calls = window_tool_calls + 1, window_last_ts = ? WHERE id = ?`,
    ),
    bumpWindowError: db.prepare(
      `UPDATE skill_invocations SET window_error_results = window_error_results + 1, window_last_ts = ? WHERE id = ?`,
    ),
    touchWindowTs: db.prepare(`UPDATE skill_invocations SET window_last_ts = ? WHERE id = ?`),
    windowRollup: db.prepare(
      `SELECT COUNT(*) AS turns,
              COALESCE(SUM(input_tokens + cache_creation_tokens), 0) AS fresh_input,
              COALESCE(SUM(output_tokens), 0)                        AS output,
              COALESCE(SUM(cache_read_tokens), 0)                    AS cache_read
       FROM turn_usage WHERE stream_id = ? AND invocation_id = ?`,
    ),
    getWindowEvent: db.prepare(`SELECT id FROM skill_window_events WHERE id = ?`),
    insertWindowEvent: db.prepare(
      `INSERT OR IGNORE INTO skill_window_events (id, invocation_id, ts_ms) VALUES (?, ?, ?)`,
    ),
    pruneWindowEvents: db.prepare(`DELETE FROM skill_window_events WHERE invocation_id = ?`),
    insertBehavior: db.prepare(
      `INSERT OR IGNORE INTO behavior_events
        (id, stream_id, entry_uuid, block_index, byte_offset, ts_ms, session_id, sub_agent_name, slug,
         kind, tool_name, tool_kind, mcp_toolset, command_family, arg_path, input_shape_hash, outcome, observable,
         event_ordinal, access_mode, arg_path_raw, arg_path_confidence, arg_path_canonical, arg_path_workspace_rel,
         input_key_set)
       VALUES
        (@id, @stream_id, @entry_uuid, @block_index, @byte_offset, @ts_ms, @session_id, @sub_agent_name, @slug,
         @kind, @tool_name, @tool_kind, @mcp_toolset, @command_family, @arg_path, @input_shape_hash, @outcome, @observable,
         @event_ordinal, @access_mode, @arg_path_raw, @arg_path_confidence, @arg_path_canonical, @arg_path_workspace_rel,
         @input_key_set)`,
    ),
    insertSearch: db.prepare(
      `INSERT OR IGNORE INTO search_events
        (id, stream_id, invocation_id, slug, working_dir, ts_ms, tool_name, normalized_query, search_signature_hash,
         entry_uuid, block_index, byte_offset)
       VALUES
        (@id, @stream_id, @invocation_id, @slug, @working_dir, @ts_ms, @tool_name, @normalized_query, @search_signature_hash,
         @entry_uuid, @block_index, @byte_offset)`,
    ),
    insertUsage: db.prepare(
      `INSERT OR IGNORE INTO turn_usage
        (id, stream_id, invocation_id, session_id, is_subagent, ts_ms, turn_index, model,
         input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens)
       VALUES
        (@id, @stream_id, @invocation_id, @session_id, @is_subagent, @ts_ms, @turn_index, @model,
         @input_tokens, @cache_creation_tokens, @cache_read_tokens, @output_tokens)`,
    ),
    insertSnippet: db.prepare(
      `INSERT OR IGNORE INTO trigger_snippets
        (event_id, event_type, stream_id, snippet, snippet_hash, source_kind, source_entry_uuid, source_byte_offset,
         distance_entries, selection_reason, src_ts_ms)
       VALUES
        (@event_id, @event_type, @stream_id, @snippet, @snippet_hash, @source_kind, @source_entry_uuid, @source_byte_offset,
         @distance_entries, @selection_reason, @src_ts_ms)`,
    ),
    ensureLaneStats: db.prepare(
      `INSERT OR IGNORE INTO stream_lane_stats (stream_id, lane, slug, working_dir, turn_count, is_subagent)
       VALUES (@stream_id, @lane, @slug, @working_dir, 0, @is_subagent)`,
    ),
    // Correct lane/working_dir once the FIRST cwd-bearing entry is seen — the
    // mode/permission-mode/file-history-snapshot preamble carries no cwd, so the
    // row is first inserted null/unknown and back-filled here (see processEntry).
    updateLaneCwd: db.prepare(
      `UPDATE stream_lane_stats SET lane = @lane, working_dir = @working_dir WHERE stream_id = @stream_id`,
    ),
    // WP-2B — persist workspace lineage once the launch cwd folds to a uniquely-owned
    // workspace. workspace-LEVEL only (cwd → workspace, never agent); leaves the row's
    // lane/cwd untouched. Method+version stamp so a later correction can't pose as
    // direct identity.
    updateLaneWorkspace: db.prepare(
      `UPDATE stream_lane_stats SET
         workspace_id = @workspace_id, workspace_root = @workspace_root,
         workspace_attribution_method = @method, workspace_attribution_version = @version
       WHERE stream_id = @stream_id`,
    ),
    recomputeLaneStats: db.prepare(
      `UPDATE stream_lane_stats SET
         turn_count = (SELECT COUNT(*) FROM behavior_events WHERE stream_id = @sid AND kind = 'turn_outcome'),
         first_ts_ms = (SELECT MIN(ts_ms) FROM behavior_events WHERE stream_id = @sid),
         last_ts_ms  = (SELECT MAX(ts_ms) FROM behavior_events WHERE stream_id = @sid)
       WHERE stream_id = @sid`,
    ),
    openWindowsAll: db.prepare(
      `SELECT id, stream_id, window_last_ts, start_ts_ms, ts_ms FROM skill_invocations WHERE window_open = 1`,
    ),
    delInvocations: db.prepare(`DELETE FROM skill_invocations WHERE stream_id = ?`),
    delBehavior: db.prepare(`DELETE FROM behavior_events WHERE stream_id = ?`),
    delUsage: db.prepare(`DELETE FROM turn_usage WHERE stream_id = ?`),
    delSearch: db.prepare(`DELETE FROM search_events WHERE stream_id = ?`),
    delSnippets: db.prepare(`DELETE FROM trigger_snippets WHERE stream_id = ?`),
    delWindowEvents: db.prepare(
      `DELETE FROM skill_window_events WHERE invocation_id IN (SELECT id FROM skill_invocations WHERE stream_id = ?)`,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-stream runtime state (in-memory, one pass)
// ─────────────────────────────────────────────────────────────────────────────
interface StreamRuntime {
  openWindowId: string | null;
  turnIndex: number;                 // last-assigned assistant turn ordinal (−1 = none yet)
  priorUsers: PriorUserEntry[];      // ring buffer of prior user entries (this pass)
  sawFirstSubstantiveUser: boolean;
  windowSearchHashes: Set<string>;   // per-open-window search-signature dedupe (repeated_search)
  laneStatsEnsured: boolean;         // stream_lane_stats row exists (may be null cwd)
  laneCwdLocked: boolean;            // launch cwd captured → lane/working_dir final
}

function newRuntime(): StreamRuntime {
  return {
    openWindowId: null,
    turnIndex: -1,
    priorUsers: [],
    sawFirstSubstantiveUser: false,
    windowSearchHashes: new Set(),
    laneStatsEnsured: false,
    laneCwdLocked: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Window lifecycle
// ─────────────────────────────────────────────────────────────────────────────
function openWindow(
  stmts: Stmts,
  ctx: StreamCtx,
  meta: StreamMeta,
  rt: StreamRuntime,
  inv: { id: string; skillName: string; args: string | null; detector: string; tsMs: number },
  turnIndex: number,
): 'opened' | 'rehydrated' | 'replay-skip' {
  const existing = stmts.getInvocation.get(inv.id);
  if (existing) {
    // Worker caution 1 — a finalized window MUST NOT reopen; a still-open one is our active.
    if (Number(existing.window_open) === 1) {
      rt.openWindowId = inv.id;
      rt.windowSearchHashes = new Set();
      return 'rehydrated';
    }
    return 'replay-skip';
  }
  // New invocation: first close any window currently open on this stream (a new Skill closes the prior).
  if (rt.openWindowId) finalizeWindow(stmts, rt, meta.streamId, rt.openWindowId, turnIndex, false);
  stmts.insertInvocation.run({
    id: inv.id,
    stream_id: meta.streamId,
    jsonl_path: meta.jsonlPath,
    session_id: meta.sessionId ?? null,
    parent_session_id: meta.parentSessionId ?? null,
    sub_agent_name: meta.subAgentName ?? null,
    working_dir: ctx.workingDir ?? null,
    workspace_root: null,
    slug: meta.slug ?? null,
    ts_ms: inv.tsMs,
    skill_name: inv.skillName,
    args: inv.args,
    detector: inv.detector,
    window_last_ts: inv.tsMs,
    start_ts_ms: inv.tsMs,
    start_turn_index: turnIndex >= 0 ? turnIndex : null,
  });
  rt.openWindowId = inv.id;
  rt.windowSearchHashes = new Set();
  return 'opened';
}

function finalizeWindow(
  stmts: Stmts,
  rt: StreamRuntime,
  streamId: string,
  invId: string,
  endTurnIndex: number,
  stale: boolean,
): void {
  const inv = stmts.getInvocation.get(invId);
  if (!inv) {
    if (rt.openWindowId === invId) rt.openWindowId = null;
    return;
  }
  const roll = stmts.windowRollup.get(streamId, invId) ?? {};
  const startTs = inv.start_ts_ms != null ? Number(inv.start_ts_ms) : Number(inv.ts_ms ?? 0);
  const lastTs = inv.window_last_ts != null ? Number(inv.window_last_ts) : startTs;
  const freshInput = Number((roll as Record<string, unknown>).fresh_input ?? 0);
  const output = Number((roll as Record<string, unknown>).output ?? 0);
  const cacheRead = Number((roll as Record<string, unknown>).cache_read ?? 0);
  const turns = Number((roll as Record<string, unknown>).turns ?? 0);
  stmts.finalizeInvocation.run({
    id: invId,
    end_turn_index: endTurnIndex >= 0 ? endTurnIndex : null,
    end_ts_ms: lastTs,
    window_dur_ms: Math.max(0, lastTs - startTs),
    // Fix-4: window_output_tokens (P0 compat) === window_usage_output_tokens by construction.
    window_output_tokens: output,
    window_fresh_input_tokens: freshInput,
    window_cache_read_tokens: cacheRead,
    window_usage_output_tokens: output,
    window_usage_turns: turns,
    ended_with_question: inv.ended_with_question != null ? Number(inv.ended_with_question) : null,
    window_truncated: stale ? 1 : 0,
  });
  stmts.pruneWindowEvents.run(invId);
  if (rt.openWindowId === invId) {
    rt.openWindowId = null;
    rt.windowSearchHashes = new Set();
  }
}

// P0.7 exactly-once guard: SELECT-then-INSERT (fake-DB-agnostic; single-writer safe).
function guardApply(stmts: Stmts, evId: string, invId: string, ts: number): boolean {
  if (stmts.getWindowEvent.get(evId)) return false;
  stmts.insertWindowEvent.run(evId, invId, ts);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snippet writing (A9)
// ─────────────────────────────────────────────────────────────────────────────
function writeSnippet(
  stmts: Stmts,
  ctx: StreamCtx,
  rt: StreamRuntime,
  eventId: string,
  eventType: 'skill_invocation' | 'executed_file' | 'command' | 'search',
): void {
  const r = selectTriggerSnippet(rt.priorUsers, ctx);
  stmts.insertSnippet.run({
    event_id: eventId,
    event_type: eventType,
    stream_id: ctx.streamId,
    snippet: r.snippet,
    snippet_hash: r.snippetHash,
    source_kind: r.sourceKind,
    source_entry_uuid: r.sourceEntryUuid,
    source_byte_offset: r.sourceByteOffset,
    distance_entries: r.distanceEntries,
    selection_reason: r.selectionReason,
    src_ts_ms: r.srcTsMs,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-entry processing — the §2.3 intra-entry order
// ─────────────────────────────────────────────────────────────────────────────
function processEntry(
  stmts: Stmts,
  ctx: StreamCtx,
  meta: StreamMeta,
  rt: StreamRuntime,
  entry: RawEntry,
  byteOffset: number,
  resolveWorkspaceLineage?: (workingDir: string | null) => WorkspaceLineage | null,
): { invocationsAdded: number; rowsAdded: number } {
  let invocationsAdded = 0;
  let rowsAdded = 0;
  const tsMs = entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;

  // Ensure the stream_lane_stats row exists once (even before any cwd is seen).
  if (!rt.laneStatsEnsured) {
    stmts.ensureLaneStats.run({
      stream_id: meta.streamId,
      lane: ctx.lane,
      slug: meta.slug ?? null,
      working_dir: ctx.workingDir ?? null,
      is_subagent: meta.isSubagent ? 1 : 0,
    });
    rt.laneStatsEnsured = true;
  }
  // Lane is derived from the FIRST-entry (launch) cwd — but the literal first
  // entry is a cwd-less mode/permission-mode/file-history-snapshot preamble in
  // the modern jsonl format. Committing on it stranded ~half the corpus at
  // working_dir=null → 'unknown'. Capture from the first entry that actually
  // carries a cwd (still the launch cwd; the post-cd cwd only appears later).
  if (!rt.laneCwdLocked) {
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd : null;
    if (cwd) {
      ctx.workingDir = cwd;
      ctx.lane = laneForWorkingDir(cwd);
      stmts.updateLaneCwd.run({
        stream_id: meta.streamId,
        lane: ctx.lane,
        working_dir: ctx.workingDir,
      });
      // WP-2B — fold this launch cwd → its owning workspace (workspace-LEVEL; the
      // shared cwd identifies a WORKSPACE, never one agent). On a unique match, persist
      // the lineage AND activate WP-1B by setting ctx.workspaceRoot, so every
      // subsequent file-touch this pass persists arg_path_workspace_rel.
      const lineage = resolveWorkspaceLineage ? resolveWorkspaceLineage(cwd) : null;
      if (lineage) {
        ctx.workspaceRoot = lineage.workspaceRoot;
        stmts.updateLaneWorkspace.run({
          stream_id: meta.streamId,
          workspace_id: lineage.workspaceId,
          workspace_root: lineage.workspaceRoot,
          method: lineage.method,
          version: WORKSPACE_LINEAGE_VERSION,
        });
      }
      rt.laneCwdLocked = true;
    }
  }

  const isAssistant = entry.type === 'assistant';

  // Assign a monotonic turn ordinal to every assistant entry (ordering only — §2.2).
  if (isAssistant) rt.turnIndex += 1;
  const turnIndex = rt.turnIndex;

  // 1. Skill blocks → open windows (each closes the stream's prior open window).
  const invs = detectSkillInvocations(entry, ctx, byteOffset);
  for (const inv of invs) {
    const outcome = openWindow(stmts, ctx, meta, rt, inv, turnIndex);
    if (outcome === 'opened') {
      invocationsAdded += 1;
      rowsAdded += 1;
      writeSnippet(stmts, ctx, rt, inv.id, 'skill_invocation');
    }
  }

  // Generic behavior events (design §4.4) + A1 executed-file capture.
  const behaviorEvents = extractBehaviorEvents(entry, ctx, byteOffset);
  for (const be of behaviorEvents) {
    insertBehaviorEvent(stmts, ctx, meta, be);
    rowsAdded += 1;
    // Snippets: executed scripts + Bash/PowerShell command candidates (§3.1).
    if (be.kind === 'file_touch' && be.accessMode === 'executed') {
      writeSnippet(stmts, ctx, rt, behaviorEventId(be), 'executed_file');
    } else if (be.kind === 'tool_use' && (be.toolName === 'Bash' || be.toolName === 'PowerShell')) {
      writeSnippet(stmts, ctx, rt, behaviorEventId(be), 'command');
    }
  }

  // 2. Window-affecting tool events (P0.7 guard) + search rows.
  if (isAssistant) {
    for (const tu of classifyToolUse(entry)) {
      const uuid = behaviorEntryUuid(behaviorEvents, tu.blockIndex) ?? `${meta.jsonlPath}:${byteOffset}`;
      // window tool-call counter (guarded). Skip the Skill block itself — it OPENS the
      // window rather than being a call within it.
      if (rt.openWindowId && tu.toolKind !== 'skill') {
        if (guardApply(stmts, `${uuid}#${tu.blockIndex}:tool_use`, rt.openWindowId, tsMs)) {
          stmts.bumpWindowToolCall.run(tsMs, rt.openWindowId);
        }
      }
      // search rows (rich, separate from the generic tool_use behavior event)
      if (tu.isSearch) {
        const sid = `${uuid}#${tu.blockIndex}`;
        stmts.insertSearch.run({
          id: sid,
          stream_id: meta.streamId,
          invocation_id: rt.openWindowId,
          slug: meta.slug ?? null,
          working_dir: ctx.workingDir ?? null,
          ts_ms: tsMs,
          tool_name: tu.toolName,
          normalized_query: tu.normalizedQuery ?? '',
          search_signature_hash: tu.searchSignatureHash ?? '',
          entry_uuid: uuid,
          block_index: tu.blockIndex,
          byte_offset: byteOffset,
        });
        rowsAdded += 1;
        writeSnippet(stmts, ctx, rt, sid, 'search');
        // repeated_search: a signature already seen in this window
        if (rt.openWindowId && tu.searchSignatureHash) {
          if (rt.windowSearchHashes.has(tu.searchSignatureHash)) {
            stmts.markRepeatedSearch.run(rt.openWindowId);
          }
          rt.windowSearchHashes.add(tu.searchSignatureHash);
        }
      }
    }
  }

  // tool_result blocks live in user entries → attribute error results to the open window.
  if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
    const content = entry.message!.content as unknown[];
    const uuid = behaviorEntryUuid(behaviorEvents, 0) ?? entry.uuid ?? `${meta.jsonlPath}:${byteOffset}`;
    for (let i = 0; i < content.length; i++) {
      const b = content[i] as Record<string, unknown> | null;
      if (!b || b.type !== 'tool_result') continue;
      if (!rt.openWindowId) continue;
      const isErr = b.is_error === true;
      const kind = isErr ? 'tool_result_err' : 'tool_result_ok';
      if (guardApply(stmts, `${uuid}#${i}:${kind}`, rt.openWindowId, tsMs)) {
        if (isErr) stmts.bumpWindowError.run(tsMs, rt.openWindowId);
        else stmts.touchWindowTs.run(tsMs, rt.openWindowId);
      }
    }
  }

  // 3. Usage → turn_usage attributed to the stream's currently-open window (or null).
  if (isAssistant) {
    const u = extractTurnUsage(entry);
    if (u) {
      const uuid = entry.uuid ?? `${meta.jsonlPath}:${byteOffset}:${ctx.firstLineHash ?? ''}`;
      stmts.insertUsage.run({
        id: `${uuid}:usage`,
        stream_id: meta.streamId,
        invocation_id: rt.openWindowId,
        session_id: meta.sessionId ?? null,
        is_subagent: meta.isSubagent ? 1 : 0,
        ts_ms: tsMs,
        turn_index: turnIndex >= 0 ? turnIndex : 0,
        model: u.model,
        input_tokens: u.input_tokens,
        cache_creation_tokens: u.cache_creation_tokens,
        cache_read_tokens: u.cache_read_tokens,
        output_tokens: u.output_tokens,
      });
      rowsAdded += 1;
    }
  }

  // 4. end_turn → finalize the window this turn belongs to.
  if (isEndTurn(entry)) {
    if (rt.openWindowId) finalizeWindow(stmts, rt, meta.streamId, rt.openWindowId, turnIndex, false);
  }

  // Maintain the prior-user ring buffer AFTER processing (so an event never sees its own turn).
  if (entry.type === 'user') {
    const substantive = isSubstantiveUserEntry(entry);
    const isFirst = substantive && !rt.sawFirstSubstantiveUser;
    if (isFirst) rt.sawFirstSubstantiveUser = true;
    rt.priorUsers.push({
      entry,
      entryUuid: entry.uuid ?? `${meta.jsonlPath}:${byteOffset}`,
      byteOffset,
      tsMs,
      isFirstSubstantiveUser: isFirst,
    });
    if (rt.priorUsers.length > PRIOR_USER_RING_CAP) rt.priorUsers.shift();
  }

  return { invocationsAdded, rowsAdded };
}

// behavior_events id per wp2b §1.1
function behaviorEventId(be: BehaviorEventRaw): string {
  return `${be.entryUuid}#${be.blockIndex}:${be.kind}:${be.eventOrdinal}`;
}
function behaviorEntryUuid(events: BehaviorEventRaw[], blockIndex: number): string | null {
  const hit = events.find((e) => e.blockIndex === blockIndex);
  return hit ? hit.entryUuid : (events[0]?.entryUuid ?? null);
}

function insertBehaviorEvent(stmts: Stmts, ctx: StreamCtx, meta: StreamMeta, be: BehaviorEventRaw): void {
  stmts.insertBehavior.run({
    id: behaviorEventId(be),
    stream_id: meta.streamId,
    entry_uuid: be.entryUuid,
    block_index: be.blockIndex,
    byte_offset: be.byteOffset,
    ts_ms: be.tsMs,
    session_id: meta.sessionId ?? null,
    sub_agent_name: meta.subAgentName ?? null,
    slug: meta.slug ?? null,
    kind: be.kind,
    tool_name: be.toolName ?? null,
    tool_kind: be.toolKind ?? null,
    mcp_toolset: be.mcpToolset ?? null,
    command_family: be.commandFamily ?? null,
    arg_path: be.argPath ?? null,
    input_shape_hash: be.inputShapeHash ?? null,
    outcome: be.outcome ?? null,
    observable: be.observable,
    event_ordinal: be.eventOrdinal,
    access_mode: be.accessMode ?? null,
    arg_path_raw: be.argPathRaw ?? null,
    arg_path_confidence: be.argPathConfidence ?? null,
    arg_path_canonical: be.argPathCanonical ?? null,
    arg_path_workspace_rel: be.argPathWorkspaceRel ?? null,
    input_key_set: be.inputKeySet ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file atomic parse (the §5.3 resume invariant)
// ─────────────────────────────────────────────────────────────────────────────
interface FileParseOutcome {
  parsed: boolean;
  rebuilt: boolean;
  invocationsAdded: number;
  rowsAdded: number;
  bytesConsumed: number;
}

function parseOneFile(
  deps: ParseDeps,
  stmts: Stmts,
  meta: StreamMeta,
  openWindows: Map<string, string>,
  parserVersion: number,
): FileParseOutcome {
  const cursorRow = stmts.getCursor.get(meta.jsonlPath);
  const cursor: CursorState = {
    byteOffset: cursorRow ? Number(cursorRow.byte_offset) : 0,
    firstFingerprint: cursorRow ? String(cursorRow.first_fingerprint ?? '') : '',
    parserVersion: cursorRow ? Number(cursorRow.parser_version) : parserVersion,
  };

  // Peek size + fingerprint to decide rebuild vs additive tail.
  let read = deps.readNewLines(meta.jsonlPath, cursor.byteOffset);
  const reason = rebuildDecision(cursor, read.sizeBytes, read.firstFingerprint, parserVersion);
  let rebuilt = false;
  let startOffset = cursor.byteOffset;
  if (reason) {
    rebuilt = true;
    startOffset = 0;
    read = deps.readNewLines(meta.jsonlPath, 0);
  }

  if (read.lines.length === 0 && !rebuilt) {
    // Nothing new; still record the current size so steady-state stats are accurate.
    if (!cursorRow || Number(cursorRow.size_bytes ?? -1) !== read.sizeBytes) {
      stmts.upsertCursor.run({
        jsonl_path: meta.jsonlPath,
        first_fingerprint: read.firstFingerprint || cursor.firstFingerprint,
        byte_offset: cursor.byteOffset,
        size_bytes: read.sizeBytes,
        parser_version: parserVersion,
        last_parsed_at: deps.nowMs ?? Date.now(),
      });
    }
    return { parsed: false, rebuilt: false, invocationsAdded: 0, rowsAdded: 0, bytesConsumed: 0 };
  }

  const ctx: StreamCtx = {
    jsonlPath: meta.jsonlPath,
    streamId: meta.streamId,
    slug: meta.slug ?? undefined,
    sessionId: meta.sessionId ?? undefined,
    subAgentName: meta.subAgentName,
    isSubagent: meta.isSubagent,
    workingDir: cursorRow ? (cursorRow.working_dir as string | null) : null,
    lane: 'unknown',
    knownSkills: deps.knownSkills,
    firstLineHash: read.firstFingerprint,
    resolveMcpToolset: deps.resolveMcpToolset,
  };
  // On a tail parse the launch cwd/lane already live in stream_lane_stats — reuse them.
  const laneRow = rebuilt ? undefined : loadLane(deps.db, meta.streamId);
  if (laneRow) {
    ctx.workingDir = (laneRow.working_dir as string | null) ?? null;
    ctx.lane = String(laneRow.lane ?? 'unknown');
    // WP-2B — reuse the already-resolved workspace root so this tail's file-touch rows
    // persist arg_path_workspace_rel (WP-1B) without re-folding. Missing → re-resolved
    // in processEntry once the cwd is (re)confirmed.
    const persistedRoot = (laneRow.workspace_root as string | null) ?? null;
    if (persistedRoot) ctx.workspaceRoot = persistedRoot;
  }

  const rt = newRuntime();
  rt.laneStatsEnsured = !!laneRow;         // already have lane stats row → don't re-insert
  // Only treat the launch cwd as locked when a non-null one was already captured; a
  // row stranded at null cwd (e.g. a first chunk that split before the first cwd
  // entry) stays open so a later chunk can back-fill it — never re-derive from a mid-file cd.
  rt.laneCwdLocked = !!(laneRow && (laneRow.working_dir as string | null));
  const rehydrated = openWindows.get(meta.streamId);
  if (rehydrated) rt.openWindowId = rehydrated;

  const finalRead = read;
  const nowMs = deps.nowMs ?? Date.now();
  let invocationsAdded = 0;
  let rowsAdded = 0;

  const runTxn = deps.db.transaction(() => {
    // On rebuild, clear this stream's rows first (delete window events before invocations).
    if (rebuilt) {
      stmts.delWindowEvents.run(meta.streamId);
      stmts.delInvocations.run(meta.streamId);
      stmts.delBehavior.run(meta.streamId);
      stmts.delUsage.run(meta.streamId);
      stmts.delSearch.run(meta.streamId);
      stmts.delSnippets.run(meta.streamId);
      rt.openWindowId = null;
    }
    for (const line of finalRead.lines) {
      if (!line.text) continue;
      let entry: RawEntry;
      try {
        entry = JSON.parse(line.text) as RawEntry;
      } catch {
        continue; // malformed line — skip (byte cursor still advances past it)
      }
      const r = processEntry(stmts, ctx, meta, rt, entry, line.byteOffset, deps.resolveWorkspaceLineage);
      invocationsAdded += r.invocationsAdded;
      rowsAdded += r.rowsAdded;
    }
    stmts.recomputeLaneStats.run({ sid: meta.streamId });
    stmts.upsertCursor.run({
      jsonl_path: meta.jsonlPath,
      first_fingerprint: finalRead.firstFingerprint,
      byte_offset: finalRead.nextOffset,
      size_bytes: finalRead.sizeBytes,
      parser_version: parserVersion,
      last_parsed_at: nowMs,
    });
  });
  runTxn();

  // Reflect this stream's still-open window for the stale-finalize pass.
  if (rt.openWindowId) openWindows.set(meta.streamId, rt.openWindowId);
  else openWindows.delete(meta.streamId);

  return {
    parsed: true,
    rebuilt,
    invocationsAdded,
    rowsAdded,
    bytesConsumed: finalRead.nextOffset - startOffset,
  };
}

function loadLane(db: ParseDb, streamId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT lane, working_dir, workspace_root FROM stream_lane_stats WHERE stream_id = ?`).get(streamId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level pass
// ─────────────────────────────────────────────────────────────────────────────
export function runIncrementalParse(deps: ParseDeps): ParseResult {
  const parserVersion = deps.parserVersion ?? PARSER_VERSION;
  const stmts = buildStmts(deps.db);

  // 1. Rehydrate open windows → Map<stream_id, invocationId>.
  const openWindows = new Map<string, string>();
  for (const row of stmts.openWindowsAll.all()) {
    openWindows.set(String(row.stream_id), String(row.id));
  }

  const bytesTotal = deps.streams.reduce((a, s) => a + safeSize(deps, s), 0);
  let filesParsed = 0;
  let rowsAdded = 0;
  let invocationsAdded = 0;
  let rebuilds = 0;
  let bytesDone = 0;

  for (let i = 0; i < deps.streams.length; i++) {
    const meta = deps.streams[i];
    const out = parseOneFile(deps, stmts, meta, openWindows, parserVersion);
    if (out.parsed) filesParsed += 1;
    if (out.rebuilt) rebuilds += 1;
    rowsAdded += out.rowsAdded;
    invocationsAdded += out.invocationsAdded;
    bytesDone += out.bytesConsumed;
    if (deps.onProgress) {
      deps.onProgress({
        filesDone: i + 1,
        filesTotal: deps.streams.length,
        bytesDone,
        bytesTotal,
        rowsAdded,
        currentFile: meta.jsonlPath,
      });
    }
  }

  // 3. Stale-finalize any window still open past WINDOW_STALE_MS.
  const nowMs = deps.nowMs ?? Date.now();
  if (deps.skipStaleFinalize) {
    return { filesScanned: deps.streams.length, filesParsed, rowsAdded, invocationsAdded, rebuilds };
  }
  const staleTxn = deps.db.transaction(() => {
    for (const [streamId, invId] of openWindows) {
      const inv = stmts.getInvocation.get(invId);
      if (!inv || Number(inv.window_open) !== 1) continue;
      const lastTs = inv.window_last_ts != null ? Number(inv.window_last_ts) : Number(inv.ts_ms ?? 0);
      if (nowMs - lastTs > WINDOW_STALE_MS) {
        const rt = newRuntime();
        finalizeWindow(stmts, rt, streamId, invId, -1, true);
      }
    }
  });
  staleTxn();

  return {
    filesScanned: deps.streams.length,
    filesParsed,
    rowsAdded,
    invocationsAdded,
    rebuilds,
  };
}

function safeSize(deps: ParseDeps, meta: StreamMeta): number {
  try {
    return deps.readNewLines(meta.jsonlPath, Number.MAX_SAFE_INTEGER).sizeBytes;
  } catch {
    return 0;
  }
}
