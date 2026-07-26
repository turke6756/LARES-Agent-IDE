import { EventEmitter } from 'events';
import path from 'path';
import { ContextStats, FileOperation } from '../../shared/types';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, getContextWindowForModel } from '../../shared/constants';
import type { UsageEvent, ToolUseEvent, ToolResultEvent } from '../../shared/session-events';
import { SessionLogReader } from './session-log-reader';
import { parseShellCommand, parseApplyPatch, shellResultIndicatesSuccess, type ParsedShellActivity } from './codex-shell-parser';

export interface JsonlFileActivity {
  agentId: string;
  filePath: string;
  operation: FileOperation;
}

// WP-1b (memory hardening P1): cap grow-forever per-agent/global structures with
// insertion-ordered Set/Map eviction (oldest-first FIFO). A Set/Map preserves
// insertion order, so `values()/keys().next().value` is always the oldest live
// entry — no parallel order arrays needed. 6000 matches the reader/dispatcher
// dedup windows; eviction beyond the window can at worst re-emit one duplicate,
// the accepted bounded-dedup tradeoff vs unbounded growth.
const SEEN_UUID_MAX = 6000;
const SEEN_FILES_MAX = 6000;
const PENDING_SHELL_MAX = 6000;

const TOOL_MAP: Record<string, FileOperation> = {
  // Claude
  'Read': 'read',
  'Edit': 'write',
  'Write': 'create',
  'Glob': 'read',
  'Grep': 'read',
  // Gemini — args field is `file_path`, passed through as `input` by the reader.
  // (`glob` and `search_file_content` omitted: their args have no specific path.)
  'read_file': 'read',
  'read_many_files': 'read',
  'write_file': 'create',
  'replace': 'write',
};

export class ContextStatsMonitor extends EventEmitter {
  private stats = new Map<string, ContextStats>();
  private seenUuids = new Map<string, Set<string>>(); // per agentId
  // Fix rec-3: per-agent capture dedupe, TOOL-USE-ID scoped (key
  // `${toolUseId}\0${op}\0${normalizedPath}`), NOT agent-lifetime `op:path`.
  // A genuine repeat read/edit in a LATER turn carries a distinct toolUseId and
  // therefore re-emits (→ persists, subject only to the DB's own 5s same-session
  // window); only an intra-call duplicate path or a replay of the SAME tool-use
  // event (same id) is suppressed here.
  private seenFiles = new Map<string, Set<string>>(); // per agentId
  // Codex shell-command activity is parsed at tool-use time but only emitted
  // once the matching tool-result confirms success. Keyed `${agentId}:${toolUseId}`.
  private pendingShellActivity = new Map<string, ParsedShellActivity[]>();
  private reader: SessionLogReader;
  private started = false;
  // Fix rec-4: resolves an agent's FROZEN launch workspace root so relative
  // structured-tool paths are canonicalized to absolute AT CAPTURE TIME (before
  // addFileActivity), never inferred later from a shared cwd. Optional so tests
  // (and any non-wired caller) get raw pass-through.
  private resolveWorkspaceRoot?: (agentId: string) => string | null;

  constructor(reader: SessionLogReader, resolveWorkspaceRoot?: (agentId: string) => string | null) {
    super();
    this.reader = reader;
    this.resolveWorkspaceRoot = resolveWorkspaceRoot;
  }

  start(): void {
    if (this.started) return;
    this.reader.on('usage', this.handleUsage);
    this.reader.on('tool-use', this.handleToolUse);
    this.reader.on('tool-result', this.handleToolResult);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.reader.off('usage', this.handleUsage);
    this.reader.off('tool-use', this.handleToolUse);
    this.reader.off('tool-result', this.handleToolResult);
    this.started = false;
  }

  getStats(agentId: string): ContextStats | null {
    return this.stats.get(agentId) || null;
  }

  /** Layer-3 memory telemetry gauges: O(1) `.size` reads of the retained maps.
   *  `seenUuidEntries`/`seenFileEntries` sum the per-agent Set sizes (bounded by
   *  live-agent count × the per-agent SEEN_* caps) so growth beyond the agent
   *  count is visible without any byte accounting. */
  getGaugeCounts(): {
    statsAgents: number;
    seenUuidEntries: number;
    seenFileEntries: number;
    pendingShellActivity: number;
  } {
    let seenUuidEntries = 0;
    for (const set of this.seenUuids.values()) seenUuidEntries += set.size;
    let seenFileEntries = 0;
    for (const set of this.seenFiles.values()) seenFileEntries += set.size;
    return {
      statsAgents: this.stats.size,
      seenUuidEntries,
      seenFileEntries,
      pendingShellActivity: this.pendingShellActivity.size,
    };
  }

  /** Force an immediate poll — delegates to the underlying reader. */
  pollNow(): void {
    this.reader.pollNow();
  }

  /**
   * BUG-26 Layer 3: drop every cached scrap of derived state for an agent
   * whose chat-side session id was just (re)bound. Called from the
   * supervisor's `'agent-rebound'` listener so the next `getStats(agentId)`
   * returns `null` instead of last-writer-wins misattributed stats from a
   * wrong rollout. Subsequent legitimate `usage` / `tool-use` / `tool-result`
   * events repopulate.
   *
   * No `'statsChanged'` emission — the cleared state is the absence of
   * stats, not a new stats snapshot, and the next legitimate `handleUsage`
   * will fire `'statsChanged'` with real numbers.
   *
   * Also clears the per-agent `seenFiles` dedupe so a REPLAY of an
   * already-seen tool-use event (same `toolUseId`) will re-emit a `fileActivity`
   * — important after `deleteFileActivitiesForAgent` wipes the DB rows, since
   * otherwise the dedupe set would prevent re-insertion of the agent's own
   * (now-correctly-attributed) activity.
   */
  invalidateAgent(agentId: string): void {
    this.stats.delete(agentId);
    this.seenUuids.delete(agentId);
    this.seenFiles.delete(agentId);
    const prefix = `${agentId}:`;
    for (const key of this.pendingShellActivity.keys()) {
      if (key.startsWith(prefix)) this.pendingShellActivity.delete(key);
    }
  }

  /**
   * Context Window Warning: re-derive each cached reading's window under a new
   * per-role gauge cap and re-emit `statsChanged` for any that moved. Live
   * effect for the settings sliders — without this, an idle agent's gauge
   * would keep the old denominator until its next usage event.
   *
   * `capForAgent` returns the configured cap in tokens, or null to leave that
   * agent's window untouched (unknown agent, or a provider the readers never
   * cap — gemini). The effective window stays `min(model window, cap)`, the
   * same formula the readers apply at event time.
   */
  recomputeContextWindows(capForAgent: (agentId: string) => number | null): void {
    for (const stats of this.stats.values()) {
      const cap = capForAgent(stats.agentId);
      if (cap === null) continue;
      const windowMax = Math.min(
        getContextWindowForModel(stats.model) || DEFAULT_CONTEXT_WINDOW_TOKENS,
        cap,
      );
      if (windowMax === stats.contextWindowMax) continue;
      stats.contextWindowMax = windowMax;
      stats.contextPercentage = Math.min(
        100,
        Math.round((stats.totalContextTokens / windowMax) * 100),
      );
      this.emit('statsChanged', stats);
    }
  }

  private handleUsage = (e: UsageEvent): void => {
    // Dedupe by event uuid — the reader already byte-offset tails, but
    // invalidatePath() + pollNow could theoretically replay.
    let seen = this.seenUuids.get(e.agentId);
    if (!seen) {
      seen = new Set();
      this.seenUuids.set(e.agentId, seen);
    }
    if (seen.has(e.uuid)) return;
    seen.add(e.uuid);
    // WP-1b: insertion-ordered eviction — drop the oldest UUIDs past the cap.
    while (seen.size > SEEN_UUID_MAX) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }

    let stats = this.stats.get(e.agentId);
    if (!stats) {
      stats = {
        agentId: e.agentId,
        sessionId: e.sessionId,
        model: e.model,
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalOutputTokens: 0,
        totalContextTokens: 0,
        contextWindowMax: e.contextWindowMax || DEFAULT_CONTEXT_WINDOW_TOKENS,
        contextPercentage: 0,
        turnCount: 0,
        lastUpdatedAt: e.timestamp,
      };
    }

    stats.sessionId = e.sessionId;
    stats.model = e.model;
    stats.inputTokens = e.inputTokens;
    stats.cacheCreationTokens = e.cacheCreationTokens;
    stats.cacheReadTokens = e.cacheReadTokens;
    stats.outputTokens = e.outputTokens;
    stats.totalOutputTokens += e.outputTokens;
    stats.turnCount += 1;
    stats.totalContextTokens = e.cumulativeContextTokens;
    stats.contextWindowMax = e.contextWindowMax || DEFAULT_CONTEXT_WINDOW_TOKENS;
    stats.contextPercentage = e.contextPercentage;
    stats.lastUpdatedAt = e.timestamp;

    this.stats.set(e.agentId, stats);
    this.emit('statsChanged', stats);
  };

  private handleToolUse = (e: ToolUseEvent): void => {
    // Codex shell_command / apply_patch — parse the command string for
    // file-touch shapes; stash by toolUseId and emit on successful tool-result.
    if (e.toolName === 'shell_command' || e.toolName === 'apply_patch') {
      const input = e.input as { command?: unknown; input?: unknown; workdir?: unknown } | null | undefined;
      const workdir = typeof input?.workdir === 'string' ? input.workdir : '';
      let parsed: ParsedShellActivity[] = [];
      if (e.toolName === 'shell_command' && typeof input?.command === 'string') {
        parsed = parseShellCommand(input.command, workdir);
      } else if (e.toolName === 'apply_patch' && typeof input?.input === 'string') {
        parsed = parseApplyPatch(input.input, workdir);
      }
      if (parsed.length > 0) {
        this.pendingShellActivity.set(`${e.agentId}:${e.toolUseId}`, parsed);
        // WP-1b: global FIFO cap. pendingShellActivity grows forever when a
        // matching tool-result never arrives; bound it by evicting the oldest
        // pending entries (insertion-ordered Map keys).
        while (this.pendingShellActivity.size > PENDING_SHELL_MAX) {
          const oldest = this.pendingShellActivity.keys().next().value;
          if (oldest === undefined) break;
          this.pendingShellActivity.delete(oldest);
        }
      }
      return;
    }

    // Claude/Gemini structured tools — emit immediately.
    const operation = TOOL_MAP[e.toolName];
    if (!operation) return;

    const filePaths = extractStructuredToolPaths(e.input);
    if (filePaths.length === 0) return;

    for (const filePath of filePaths) {
      this.captureFileActivity(e.agentId, filePath, operation, e.toolUseId);
    }
  };

  /**
   * Single capture chokepoint (Fix rec-3 + rec-4): normalize the path against the
   * agent's frozen workspace root, quarantine impossible (empty) paths, then dedupe
   * per tool-use id before emitting. Both the structured-tool and shell/apply_patch
   * paths flow through here so ingress normalization + scoping stay identical.
   */
  private captureFileActivity(
    agentId: string,
    rawPath: string,
    operation: FileOperation,
    toolUseId: string,
  ): void {
    const root = this.resolveWorkspaceRoot ? this.resolveWorkspaceRoot(agentId) : null;
    const filePath = normalizeCapturedPath(rawPath, root);
    if (!filePath) return; // impossible / empty path — quarantined, never persisted

    let seen = this.seenFiles.get(agentId);
    if (!seen) {
      seen = new Set();
      this.seenFiles.set(agentId, seen);
    }
    // JSON tuple key: toolUseId / op / path are opaque and may contain a colon
    // — a stringified array is unambiguous where a plain join is not.
    const key = JSON.stringify([toolUseId, operation, filePath]);
    if (seen.has(key)) return;
    seen.add(key);
    // WP-1b: insertion-ordered eviction — drop the oldest keys past the cap.
    while (seen.size > SEEN_FILES_MAX) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }

    this.emit('fileActivity', { agentId, filePath, operation } as JsonlFileActivity);
  }

  private handleToolResult = (e: ToolResultEvent): void => {
    const key = `${e.agentId}:${e.toolUseId}`;
    const pending = this.pendingShellActivity.get(key);
    if (!pending) return;
    this.pendingShellActivity.delete(key);

    if (e.isError) return;
    if (!shellResultIndicatesSuccess(e.content)) return;

    for (const a of pending) {
      this.captureFileActivity(e.agentId, a.filePath, a.operation, e.toolUseId);
    }
  };
}

/**
 * Fix rec-4: canonicalize a captured transcript path AT INGRESS.
 *
 * - Absolute paths (Windows drive, UNC, POSIX/WSL) pass through verbatim; the
 *   downstream relativizer (`repo-activity.toRel`) handles separators + case.
 * - Relative paths are resolved against the agent's FROZEN launch workspace root
 *   so `plans/example.html` / `.lares/state.json` become absolute and are
 *   correctly hit by the plan-file and `.lares/**` exclusions instead of
 *   being misclassified as outside-workspace evidence.
 * - Empty / whitespace-only ("impossible") paths are rejected → `null` (caller
 *   drops them; nothing is persisted).
 * - With no known root a relative path can't be safely resolved, so it is kept
 *   verbatim (best-effort) — `repo-activity`'s defensive relative-path exclusion
 *   still catches the plan/`.lares` cases for such legacy/unresolved rows.
 */
export function normalizeCapturedPath(rawPath: string, workspaceRoot: string | null): string | null {
  const raw = rawPath.trim();
  if (!raw) return null;

  const isAbsolute =
    path.isAbsolute(raw) ||
    /^[a-zA-Z]:[\\/]/.test(raw) || // Windows drive
    raw.startsWith('/') ||          // POSIX / WSL
    raw.startsWith('\\\\');        // UNC
  if (isAbsolute) return raw;

  if (!workspaceRoot) return raw;

  const rel = raw.replace(/^\.[\\/]/, ''); // strip a leading './' or '.\'
  // WSL/POSIX root → forward-slash join (host path.resolve would inject '\').
  if (workspaceRoot.startsWith('/')) {
    return workspaceRoot.replace(/\/+$/, '') + '/' + rel.replace(/\\/g, '/');
  }
  return path.resolve(workspaceRoot, rel);
}

function extractStructuredToolPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as {
    file_path?: unknown;
    path?: unknown;
    file_paths?: unknown;
    paths?: unknown;
  };
  const out: string[] = [];
  if (typeof obj.file_path === 'string') out.push(obj.file_path);
  if (typeof obj.path === 'string') out.push(obj.path);
  if (Array.isArray(obj.file_paths)) {
    for (const p of obj.file_paths) {
      if (typeof p === 'string') out.push(p);
    }
  }
  if (Array.isArray(obj.paths)) {
    for (const p of obj.paths) {
      if (typeof p === 'string') out.push(p);
    }
  }
  return out;
}
