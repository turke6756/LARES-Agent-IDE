import { EventEmitter } from 'events';
import { ContextStats, FileOperation } from '../../shared/types';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../shared/constants';
import type { UsageEvent, ToolUseEvent, ToolResultEvent } from '../../shared/session-events';
import { SessionLogReader } from './session-log-reader';
import { parseShellCommand, parseApplyPatch, shellResultIndicatesSuccess, type ParsedShellActivity } from './codex-shell-parser';

export interface JsonlFileActivity {
  agentId: string;
  filePath: string;
  operation: FileOperation;
}

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
  private seenFiles = new Map<string, Set<string>>(); // per agentId: "op:path" dedup
  // Codex shell-command activity is parsed at tool-use time but only emitted
  // once the matching tool-result confirms success. Keyed `${agentId}:${toolUseId}`.
  private pendingShellActivity = new Map<string, ParsedShellActivity[]>();
  private reader: SessionLogReader;
  private started = false;

  constructor(reader: SessionLogReader) {
    super();
    this.reader = reader;
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
   * Also clears the per-agent `seenFiles` dedupe so a previously-emitted
   * `(op, path)` will re-emit a `fileActivity` event when the freshly-bound
   * rollout's tool-use lands — important after `deleteFileActivitiesForAgent`
   * wipes the DB rows, since otherwise the dedupe set would prevent the
   * re-insertion of the agent's own (now-correctly-attributed) activity.
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
      }
      return;
    }

    // Claude/Gemini structured tools — emit immediately.
    const operation = TOOL_MAP[e.toolName];
    if (!operation) return;

    const filePaths = extractStructuredToolPaths(e.input);
    if (filePaths.length === 0) return;

    let seen = this.seenFiles.get(e.agentId);
    if (!seen) {
      seen = new Set();
      this.seenFiles.set(e.agentId, seen);
    }
    for (const filePath of filePaths) {
      const key = `${operation}:${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      this.emit('fileActivity', { agentId: e.agentId, filePath, operation } as JsonlFileActivity);
    }
  };

  private handleToolResult = (e: ToolResultEvent): void => {
    const key = `${e.agentId}:${e.toolUseId}`;
    const pending = this.pendingShellActivity.get(key);
    if (!pending) return;
    this.pendingShellActivity.delete(key);

    if (e.isError) return;
    if (!shellResultIndicatesSuccess(e.content)) return;

    let seen = this.seenFiles.get(e.agentId);
    if (!seen) {
      seen = new Set();
      this.seenFiles.set(e.agentId, seen);
    }
    for (const a of pending) {
      const dedupKey = `${a.operation}:${a.filePath}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      this.emit('fileActivity', { agentId: e.agentId, filePath: a.filePath, operation: a.operation } as JsonlFileActivity);
    }
  };
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
