import fs from 'fs';
import path from 'path';
import type {
  SessionEvent,
  UserTextEvent,
  AssistantTextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  UsageEvent,
  SystemInitEvent,
} from '../../../shared/session-events';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, CONTEXT_GAUGE_CAP_TOKENS, getContextWindowForModel } from '../../../shared/constants';
import type { AgentProvider } from '../../../shared/types';
import {
  flattenToolResultContent,
  resolveWindowsHomeSubdir,
  resolveWslHomeSubdir,
  truncateForChat,
  type ChatLogReader,
  type ChatLogReaderSession,
} from './types';
import { parseSqliteUtcMs } from '../sqlite-time';

interface ToolResultLocation {
  jsonlPath: string;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
}

const EOF_STREAK_REREGISTER = 3;
const STALE_SIGNAL_REEMIT_MS = 30_000;
const CLEAR_SUCCESSOR_HEAD_LINES = 8;

/** A session-pinned stale signal: a Claude agent's tailed `.jsonl` went quiet
 *  (EOF streak). The signal carries the session id that WAS being tailed so the
 *  rotation handler can reject a retry whose target session no longer matches
 *  the agent's current `resumeSessionId` (e.g. a stale EOF racing after the row
 *  already rotated). EOF/stale is only a retry trigger, NEVER the identity
 *  source — the successor candidate comes from the hook-bound session id. */
export interface ClaudeStaleSignal {
  agentId: string;
  staleSessionId: string;
  workingDirectory: string;
  observedAt: number;
}

/** Canonical `~/.claude/projects/<slug>` directory name for a working
 *  directory. Exported so the rotation guard can group agents by slug dir. */
export function makeClaudeProjectSlug(workingDirectory: string): string {
  return workingDirectory.replace(/[/\\:_.]/g, '-');
}

export class ClaudeJsonlReader implements ChatLogReader {
  readonly provider: AgentProvider = 'claude';

  // Base dirs resolve lazily and self-heal (see resolveWslHomeSubdir in
  // types.ts): a failed WSL discovery at app startup must not permanently
  // disable chat attach for WSL agents. Tri-state: `undefined` = not yet
  // resolved (accessors keep retrying), `null` = pinned absent (tests),
  // string = resolved (cached for the reader's lifetime).
  private windowsProjectsDir: string | null | undefined = undefined;
  private wslProjectsUncDir: string | null | undefined = undefined;

  private resolvedPaths = new Map<string, string>(); // agentId -> jsonlPath
  private fileOffsets = new Map<string, number>(); // jsonlPath -> byte offset
  private partialLines = new Map<string, string>(); // jsonlPath -> partial
  private seenEntryUuids = new Map<string, Set<string>>(); // agentId -> entry uuids
  private emittedSystemInit = new Set<string>(); // agentId
  private toolResultLocations = new Map<string, ToolResultLocation>(); // `${agentId}:${toolUseId}`
  private eofStreak = new Map<string, number>(); // agentId
  private pendingStale = new Map<string, ClaudeStaleSignal>(); // agentId — drained by dispatcher
  private lastStaleEmitAt = new Map<string, number>(); // agentId -> last emit ms (throttle)

  private getWindowsProjectsDir(): string | null {
    if (this.windowsProjectsDir !== undefined) return this.windowsProjectsDir;
    const dir = resolveWindowsHomeSubdir('.claude/projects');
    if (dir) this.windowsProjectsDir = dir;
    return dir;
  }

  private getWslProjectsDir(): string | null {
    if (this.wslProjectsUncDir !== undefined) return this.wslProjectsUncDir;
    const dir = resolveWslHomeSubdir('.claude/projects');
    if (dir) this.wslProjectsUncDir = dir;
    return dir;
  }

  invalidatePath(agentId: string): void {
    const cached = this.resolvedPaths.get(agentId);
    if (cached) {
      this.resolvedPaths.delete(agentId);
      this.fileOffsets.delete(cached);
      this.partialLines.delete(cached);
    }
    this.eofStreak.delete(agentId);
    this.pendingStale.delete(agentId);
    this.lastStaleEmitAt.delete(agentId);
  }

  /** Throttled accumulation of a /clear-rotation stale signal. The dispatcher
   *  drains `pendingStale` once per tick. Throttle bounds re-scan cost when a
   *  file stays quiet (idle agent that did NOT /clear). The signal is pinned to
   *  the session id that was being tailed so a stale retry can't rotate an
   *  agent whose row has since moved on to a different session. */
  private recordStaleSignal(session: ChatLogReaderSession): void {
    const now = Date.now();
    const last = this.lastStaleEmitAt.get(session.agentId) || 0;
    if (now - last < STALE_SIGNAL_REEMIT_MS) return;
    this.lastStaleEmitAt.set(session.agentId, now);
    this.pendingStale.set(session.agentId, {
      agentId: session.agentId,
      staleSessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
      observedAt: now,
    });
  }

  /** Drain the session-pinned stale signals accumulated since the last drain.
   *  The dispatcher re-emits these as `'session-stale'`. */
  drainStaleSignals(): ClaudeStaleSignal[] {
    if (this.pendingStale.size === 0) return [];
    const out = [...this.pendingStale.values()];
    this.pendingStale.clear();
    return out;
  }

  /** Locate the on-disk `.jsonl` for a working dir + session id WITHOUT
   *  touching the resolved-path cache. Mirrors `resolveJsonlPath`'s lookup
   *  order. Returns the full path or null. */
  private locateSessionFile(workingDirectory: string, sessionId: string): string | null {
    const slug = this.makeSlug(workingDirectory);
    const fileName = `${sessionId}.jsonl`;
    const wslDir = this.getWslProjectsDir();
    const windowsDir = this.getWindowsProjectsDir();

    if (workingDirectory.startsWith('/') && wslDir) {
      const p = path.join(wslDir, slug, fileName);
      if (fs.existsSync(p)) return p;
    }
    if (windowsDir) {
      const p = path.join(windowsDir, slug, fileName);
      if (fs.existsSync(p)) return p;
    }
    for (const baseDir of [windowsDir, wslDir].filter(Boolean) as string[]) {
      try {
        for (const dir of fs.readdirSync(baseDir)) {
          const p = path.join(baseDir, dir, fileName);
          if (fs.existsSync(p)) return p;
        }
      } catch {
        // can't read directory
      }
    }
    return null;
  }

  /** Validate that an ALREADY-agent-bound candidate session id is a genuine
   *  `/clear` successor of `currentSessionId`. The candidate is supplied by the
   *  hook (which carries both the dashboard agentId and Claude's new
   *  session_id), so this method NEVER scans the directory to *discover* a
   *  successor — cwd is only a filesystem scope to validate one specific
   *  candidate. That is what makes rotation BUG-26-safe under shared cwds: a
   *  cwd sibling's successor can never be adopted because it was never bound to
   *  this agent.
   *
   *  Accept iff ALL hold:
   *   - candidate id differs from the current id,
   *   - `<currentDir>/<candidate>.jsonl` exists (same Claude project dir as the
   *     current session file — a same-named file in another slug dir is NOT
   *     reachable, so cross-slug collisions are rejected),
   *   - candidate mtime is newer than the current file's mtime,
   *   - candidate mtime is not older than `startedAt` (when parseable),
   *   - candidate head carries the `/clear` signature bound to its own id.
   *  Bounded work: two stats + one 8 KB head read. */
  validateClearSuccessor(
    workingDirectory: string,
    currentSessionId: string,
    candidateSessionId: string,
    startedAt?: string
  ): boolean {
    if (!candidateSessionId || candidateSessionId === currentSessionId) return false;

    const currentPath = this.locateSessionFile(workingDirectory, currentSessionId);
    if (!currentPath) return false;
    let currentMtimeMs: number;
    try { currentMtimeMs = fs.statSync(currentPath).mtimeMs; } catch { return false; }

    // Build the candidate path in the SAME directory as the current file; do
    // NOT scan other slug directories for candidate adoption.
    const candidatePath = path.join(path.dirname(currentPath), `${candidateSessionId}.jsonl`);
    let candidateMtimeMs: number;
    try { candidateMtimeMs = fs.statSync(candidatePath).mtimeMs; } catch { return false; }

    if (candidateMtimeMs <= currentMtimeMs) return false;
    const startedAtMs = parseSqliteUtcMs(startedAt);
    if (startedAtMs !== null && candidateMtimeMs < startedAtMs) return false;
    if (!this.hasClearSignature(candidatePath, candidateSessionId)) return false;
    return true;
  }

  /** Context-brick Phase 2 — one-shot PURE read of a *prior* session's
   *  structured chat straight from disk. A continuation/`/clear` rebind wiped
   *  the live in-memory ring (`SessionLogDispatcher.rebindAgent`), so a prior
   *  session survives only as its `<sessionId>.jsonl` on disk (readers never
   *  unlink). This reads the whole file once and returns its `SessionEvent[]`.
   *
   *  It is deliberately side-effect free with respect to the live tail:
   *   - does NOT touch `fileOffsets` / `partialLines` (never calls pollSession),
   *   - does NOT subscribe or emit,
   *   - parses under an EPHEMERAL scope id so the per-agent dedup maps
   *     (`seenEntryUuids` / `emittedSystemInit` / `toolResultLocations`) of any
   *     LIVE agent sharing this cwd/slug are never touched, and the scope rows
   *     are cleared afterward so no residue leaks.
   *
   *  Returns `null` when the JSONL cannot be located or read (pruned/missing) so
   *  the caller can degrade to "previous session unavailable"; returns `[]` for a
   *  located-but-empty session. */
  readSessionEventsOnce(workingDirectory: string, sessionId: string): SessionEvent[] | null {
    const jsonlPath = this.locateSessionFile(workingDirectory, sessionId);
    if (!jsonlPath) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      return null;
    }

    // Ephemeral parse scope: parseEntry keys its dedup maps on session.agentId.
    // A synthetic per-read id keeps this fully isolated from any live agent that
    // shares this cwd/slug (shared-cwd invariant), and is cleared in `finally`.
    const scopeId = `__prior-session__:${sessionId}`;
    const session: ChatLogReaderSession = {
      agentId: scopeId,
      sessionId,
      workingDirectory,
      provider: this.provider,
      subscribed: false,
    };

    const out: SessionEvent[] = [];
    try {
      let cursor = 0;
      for (const line of raw.split('\n')) {
        const lineBytes = Buffer.byteLength(line, 'utf-8');
        const lineStartOffset = cursor;
        const lineEndOffset = cursor + lineBytes;
        cursor = lineEndOffset + 1; // +1 for the split-consumed '\n'

        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: any;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }

        this.parseEntry(session, jsonlPath, entry, lineStartOffset, lineEndOffset, out);
      }
    } finally {
      this.seenEntryUuids.delete(scopeId);
      this.emittedSystemInit.delete(scopeId);
      const prefix = `${scopeId}:`;
      for (const key of this.toolResultLocations.keys()) {
        if (key.startsWith(prefix)) this.toolResultLocations.delete(key);
      }
    }
    return out;
  }

  /** True if the first CLEAR_SUCCESSOR_HEAD_LINES lines of a `.jsonl` carry the
   *  fresh `/clear` signature, bound to the candidate file's own session id:
   *   - a self-rooted entry (`parentUuid === null`, `sessionId === candidate`),
   *   - a `user` entry (`sessionId === candidate`) whose content contains
   *     `<command-name>/clear</command-name>`.
   *  Binding every checked line to the candidate sessionId excludes
   *  concatenated/foreign heads. Restricting to the head excludes conversation
   *  text that merely mentions "/clear" deep in the file. Requiring the command
   *  marker excludes forks / `--fork-session` / `--resume`-elsewhere roots.
   *  We deliberately do NOT pin `type === 'mode'` on line 1 — that is the
   *  element most likely to drift across Claude Code versions, and a silent
   *  hard-fail there would read as "the fix stopped working." */
  private hasClearSignature(jsonlPath: string, candidateSessionId: string): boolean {
    let head: string;
    try {
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const bytes = fs.readSync(fd, buf, 0, 8192, 0);
        head = buf.toString('utf-8', 0, bytes);
      } finally { fs.closeSync(fd); }
    } catch { return false; }

    const lines = head.split('\n').slice(0, CLEAR_SUCCESSOR_HEAD_LINES);
    let sawFreshRoot = false;
    let sawClearCommand = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let entry: any;
      try { entry = JSON.parse(t); } catch { continue; }
      if (entry.sessionId !== candidateSessionId) continue; // bind to this file's own id
      if (entry.parentUuid === null) sawFreshRoot = true;
      if (entry.type === 'user') {
        const raw = entry.message?.content ?? entry.content;
        const text = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
            : '';
        if (text.includes('<command-name>/clear</command-name>')) sawClearCommand = true;
      }
    }
    return sawFreshRoot && sawClearCommand;
  }

  /** Return true if a Claude session JSONL exists on disk for the given working
   *  directory + session id. Mirrors the lookup strategy of `resolveJsonlPath`
   *  but without caching — used by resume-launch validation in supervisor/index.ts
   *  to fall back to a fresh launch when the recorded resumeSessionId points at
   *  a file Claude never managed to write. */
  sessionFileExists(workingDirectory: string, sessionId: string): boolean {
    const slug = this.makeSlug(workingDirectory);
    const fileName = `${sessionId}.jsonl`;

    const wslDir = this.getWslProjectsDir();
    const windowsDir = this.getWindowsProjectsDir();

    if (workingDirectory.startsWith('/') && wslDir) {
      const jsonlPath = path.join(wslDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) return true;
    }

    if (windowsDir) {
      const jsonlPath = path.join(windowsDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) return true;
    }

    const dirsToScan = [windowsDir, wslDir].filter(Boolean) as string[];
    for (const baseDir of dirsToScan) {
      try {
        const dirs = fs.readdirSync(baseDir);
        for (const dir of dirs) {
          const candidatePath = path.join(baseDir, dir, fileName);
          if (fs.existsSync(candidatePath)) return true;
        }
      } catch {
        // can't read directory
      }
    }

    return false;
  }

  private forgetResolvedPath(agentId: string): void {
    if (this.resolvedPaths.has(agentId)) {
      this.resolvedPaths.delete(agentId);
    }
    this.eofStreak.delete(agentId);
  }

  async getFullToolResult(agentId: string, toolUseId: string): Promise<string | null> {
    const loc = this.toolResultLocations.get(`${agentId}:${toolUseId}`);
    if (!loc) return null;

    try {
      const fd = fs.openSync(loc.jsonlPath, 'r');
      try {
        const length = loc.endOffset - loc.startOffset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, loc.startOffset);
        const line = buf.toString('utf-8');
        const entry = JSON.parse(line);
        const content = entry?.message?.content;
        if (!Array.isArray(content)) return null;
        const block = content[loc.blockIndex];
        if (!block || block.type !== 'tool_result') return null;
        return flattenToolResultContent(block.content);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  pollSession(session: ChatLogReaderSession): SessionEvent[] {
    const jsonlPath = this.resolveJsonlPath(session);
    if (!jsonlPath) return [];

    let fileSize: number;
    try {
      fileSize = fs.statSync(jsonlPath).size;
    } catch {
      return [];
    }

    const lastOffset = this.fileOffsets.get(jsonlPath) || 0;
    if (fileSize <= lastOffset) {
      const streak = (this.eofStreak.get(session.agentId) || 0) + 1;
      this.eofStreak.set(session.agentId, streak);
      if (streak >= EOF_STREAK_REREGISTER) {
        // /clear-rotation signal — throttled internally; fires for subscribed
        // AND unsubscribed agents (Decision 1: the context bar is list-level).
        this.recordStaleSignal(session);
        if (session.subscribed) {
          // Existing subscribed-only same-session re-resolution. NOTE:
          // forgetResolvedPath() also deletes the eofStreak entry, so this
          // branch naturally re-arms and re-enters every EOF_STREAK_REREGISTER
          // polls (unchanged behavior).
          this.forgetResolvedPath(session.agentId);
        } else {
          // Unsubscribed: re-arm the streak explicitly so this branch re-enters
          // on the same cadence (the stale emit itself is time-throttled).
          this.eofStreak.set(session.agentId, 0);
        }
      }
      return [];
    }
    this.eofStreak.delete(session.agentId);
    // File advanced — any pending stale signal is moot, and a future quiet
    // episode should be free to re-signal promptly.
    this.pendingStale.delete(session.agentId);
    this.lastStaleEmitAt.delete(session.agentId);

    const fd = fs.openSync(jsonlPath, 'r');
    let readStart: number;
    let rawText: string;
    try {
      const bytesToRead = fileSize - lastOffset;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, lastOffset);
      readStart = lastOffset;
      rawText = buffer.toString('utf-8');
      this.fileOffsets.set(jsonlPath, fileSize);
    } finally {
      fs.closeSync(fd);
    }

    const partial = this.partialLines.get(jsonlPath) || '';
    const combined = partial + rawText;

    const newEvents: SessionEvent[] = [];
    const partialBytes = Buffer.byteLength(partial, 'utf-8');
    let cursor = readStart - partialBytes;

    const lines = combined.split('\n');
    const maybeLast = lines.pop() || '';
    this.partialLines.set(jsonlPath, maybeLast);

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      const lineStartOffset = cursor;
      const lineEndOffset = cursor + lineBytes;
      cursor = lineEndOffset + 1;

      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      this.parseEntry(session, jsonlPath, entry, lineStartOffset, lineEndOffset, newEvents);
    }

    return newEvents;
  }

  private parseEntry(
    session: ChatLogReaderSession,
    jsonlPath: string,
    entry: any,
    lineStartOffset: number,
    lineEndOffset: number,
    out: SessionEvent[]
  ): void {
    const entryUuid: string | undefined = entry.uuid;
    if (entryUuid) {
      let seen = this.seenEntryUuids.get(session.agentId);
      if (!seen) {
        seen = new Set();
        this.seenEntryUuids.set(session.agentId, seen);
      }
      if (seen.has(entryUuid)) return;
      seen.add(entryUuid);
    }

    const timestamp: string = entry.timestamp || new Date().toISOString();
    const baseUuid = entryUuid || `${jsonlPath}:${lineStartOffset}`;
    const mkEventUuid = (suffix: string) => `${baseUuid}#${suffix}`;

    if (entry.type === 'system') {
      if (!this.emittedSystemInit.has(session.agentId)) {
        const ev: SystemInitEvent = {
          type: 'system-init',
          uuid: mkEventUuid('init'),
          timestamp,
          agentId: session.agentId,
          model: entry.model || entry.subtype || 'unknown',
          cwd: entry.cwd,
        };
        out.push(ev);
        this.emittedSystemInit.add(session.agentId);
      }
      return;
    }

    if (entry.type === 'user') {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        const text = content.trim();
        if (text.length > 0) {
          const ev: UserTextEvent = {
            type: 'user-text',
            uuid: mkEventUuid('u'),
            timestamp,
            agentId: session.agentId,
            text,
          };
          out.push(ev);
        }
        return;
      }
      if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const block = content[i];
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text.length === 0) continue;
            const ev: UserTextEvent = {
              type: 'user-text',
              uuid: mkEventUuid(`u${i}`),
              timestamp,
              agentId: session.agentId,
              text,
            };
            out.push(ev);
          } else if (block.type === 'tool_result') {
            const rawContent = flattenToolResultContent(block.content);
            const { content: truncatedContent, truncated } = truncateForChat(rawContent);
            const toolUseId = block.tool_use_id || '';
            const ev: ToolResultEvent = {
              type: 'tool-result',
              uuid: mkEventUuid(`r${i}`),
              timestamp,
              agentId: session.agentId,
              toolUseId,
              content: truncatedContent,
              truncated,
              isError: block.is_error === true,
            };
            out.push(ev);
            if (toolUseId) {
              this.toolResultLocations.set(`${session.agentId}:${toolUseId}`, {
                jsonlPath,
                blockIndex: i,
                startOffset: lineStartOffset,
                endOffset: lineEndOffset,
              });
            }
          }
        }
      }
      return;
    }

    if (entry.type === 'assistant') {
      const msg = entry.message;
      if (!msg) return;
      const model: string = msg.model || 'unknown';
      const content = msg.content;
      const stopReason: string | undefined = msg.stop_reason;
      const turnComplete = stopReason === 'end_turn';

      if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const block = content[i];
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text.length === 0) continue;
            const ev: AssistantTextEvent = {
              type: 'assistant-text',
              uuid: mkEventUuid(`a${i}`),
              timestamp,
              agentId: session.agentId,
              text,
              model,
              turnComplete,
              stopReason,
            };
            // P2-01: compute on turnComplete only. Mid-turn assistant chunks
            // can end on '?' inside a longer monologue and shouldn't surface.
            if (turnComplete) {
              const trimmed = text.trimEnd();
              ev.endsWithQuestion = trimmed.length > 0 && trimmed.endsWith('?');
            }
            out.push(ev);
          } else if (block.type === 'thinking') {
            const text = (block.thinking || '').trim();
            if (text.length === 0) continue;
            const ev: ThinkingEvent = {
              type: 'thinking',
              uuid: mkEventUuid(`t${i}`),
              timestamp,
              agentId: session.agentId,
              text,
            };
            out.push(ev);
          } else if (block.type === 'tool_use') {
            const ev: ToolUseEvent = {
              type: 'tool-use',
              uuid: mkEventUuid(`tu${i}`),
              timestamp,
              agentId: session.agentId,
              toolUseId: block.id || '',
              toolName: block.name || 'unknown',
              input: block.input,
            };
            out.push(ev);
          }
        }
      }

      const usage = msg.usage;
      if (usage) {
        // Gauge policy: 100% = 200K even on 1M-window models.
        const contextWindowMax = Math.min(
          getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW_TOKENS,
          CONTEXT_GAUGE_CAP_TOKENS
        );
        const inputTokens = usage.input_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cumulativeContextTokens = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;
        const contextPercentage = Math.min(100, Math.round((cumulativeContextTokens / contextWindowMax) * 100));
        const ev: UsageEvent = {
          type: 'usage',
          uuid: mkEventUuid('use'),
          timestamp,
          agentId: session.agentId,
          sessionId: session.sessionId,
          model,
          inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          outputTokens,
          cumulativeContextTokens,
          contextWindowMax,
          contextPercentage,
        };
        out.push(ev);
      }
    }
  }

  // ── JSONL path resolution ────────────────────────────────────────────
  // Mirrors context-stats-monitor.ts:261-311

  private resolveJsonlPath(session: ChatLogReaderSession): string | null {
    const cached = this.resolvedPaths.get(session.agentId);
    if (cached) {
      if (fs.existsSync(cached)) return cached;
      this.resolvedPaths.delete(session.agentId);
    }

    const { workingDirectory, sessionId } = session;
    const slug = this.makeSlug(workingDirectory);
    const fileName = `${sessionId}.jsonl`;

    const wslDir = this.getWslProjectsDir();
    const windowsDir = this.getWindowsProjectsDir();

    if (workingDirectory.startsWith('/') && wslDir) {
      const jsonlPath = path.join(wslDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        return jsonlPath;
      }
    }

    if (windowsDir) {
      const jsonlPath = path.join(windowsDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        return jsonlPath;
      }
    }

    const dirsToScan = [windowsDir, wslDir].filter(Boolean) as string[];
    for (const baseDir of dirsToScan) {
      try {
        const dirs = fs.readdirSync(baseDir);
        for (const dir of dirs) {
          const candidatePath = path.join(baseDir, dir, fileName);
          if (fs.existsSync(candidatePath)) {
            this.resolvedPaths.set(session.agentId, candidatePath);
            return candidatePath;
          }
        }
      } catch {
        // can't read directory
      }
    }

    return null;
  }

  private makeSlug(workingDirectory: string): string {
    return makeClaudeProjectSlug(workingDirectory);
  }
}
