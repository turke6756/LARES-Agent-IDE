import fs from 'fs';
import path from 'path';
import type {
  SessionEvent,
  UserTextEvent,
  AssistantTextEvent,
  AssistantTextPatchEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  UsageEvent,
  SystemInitEvent,
} from '../../../shared/session-events';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, getContextWindowForModel } from '../../../shared/constants';
import { resolveContextGaugeCap } from '../../context-gauge/context-gauge-cap';
import { parseSqliteUtcMs } from '../sqlite-time';
import type { AgentProvider } from '../../../shared/types';
import {
  resolveWindowsHomeSubdir,
  resolveWslHomeSubdir,
  truncateForChat,
  type ChatLogReader,
  type ChatLogReaderSession,
} from './types';

const EOF_STREAK_REREGISTER = 3;
// Filename/opened-at timestamps are second-granular and clocks skew; give a
// session dir this much slack before rejecting it against the agent start.
const START_FLOOR_SLACK_MS = 2_000;

interface FullToolResultLocation {
  jsonlPath: string;
  startOffset: number;
  endOffset: number;
}

/** One row of `~/.grok/active_sessions.json`. */
interface GrokActiveSession {
  session_id: string;
  cwd: string;
  opened_at?: string;
}

/**
 * Reads Grok Build (xAI CLI) session logs at:
 *   ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl
 *
 * `updates.jsonl` is the authoritative ACP session-update stream. Each line is
 * `{ timestamp, method, params:{ sessionId, update:{ sessionUpdate, ... },
 * _meta:{ eventId, agentTimestampMs, promptId, ... } } }`. The `method` is
 * either `session/update` (conversation content) or `_x.ai/session/update`
 * (hooks, turn_completed, session_recap); we discriminate purely on
 * `params.update.sessionUpdate`, ignoring `method`.
 *
 * Record → SessionEvent mapping:
 *   user_message_chunk   → user-text        (update.content.text)
 *   agent_message_chunk  → assistant-text   (update.content.text; coalesced —
 *                                            grok persists ONE line per turn,
 *                                            not streaming deltas)
 *   agent_thought_chunk  → thinking         (update.content.text)
 *   tool_call            → tool-use         (toolCallId, title, rawInput)
 *   tool_call_update     → tool-result      (only on status completed/failed;
 *                                            in_progress lines are dropped)
 *   turn_completed       → tags the turn's assistant-text (turnComplete +
 *                          stopReason) and emits a usage event from usage
 *   hook_execution       → dropped
 *   session_recap        → dropped
 *
 * A `system-init` is synthesized once per agent from the session's
 * `summary.json` (grok's updates.jsonl has no session-meta line of its own),
 * carrying `model = current_model_id` and `cwd = info.cwd`.
 *
 * Discovery: grok mints its own UUIDv7 session ids and the dashboard does not
 * bind them (grok is not session-addressable), so the tail is resolved from the
 * working directory. `~/.grok/active_sessions.json` maps live session ids to
 * their cwd; when it names a live session for the agent's cwd we prefer it,
 * otherwise we take the newest `updates.jsonl` under the cwd's encoded group
 * dir (respecting the agent start floor). This mirrors the gemini reader's
 * cwd-match-newest strategy and carries the same shared-cwd caveat.
 */
export class GrokSessionReader implements ChatLogReader {
  readonly provider: AgentProvider = 'grok';

  // `.grok` home roots. Base dirs resolve lazily and self-heal (see
  // resolveWslHomeSubdir in types.ts). Tri-state: `undefined` = not yet
  // resolved (accessors keep retrying), `null` = pinned absent (tests),
  // string = resolved (cached for the reader's lifetime).
  private windowsGrokDir: string | null | undefined = undefined;
  private wslGrokDir: string | null | undefined = undefined;

  private resolvedPaths = new Map<string, string>(); // agentId -> updates.jsonl path
  private fileOffsets = new Map<string, number>(); // jsonlPath -> byte offset
  private partialLines = new Map<string, string>(); // jsonlPath -> partial
  private emittedSystemInit = new Set<string>(); // agentId
  private currentModel = new Map<string, string>(); // agentId -> model id
  private toolResultLocations = new Map<string, FullToolResultLocation>(); // `${agentId}:${callId}`
  private eofStreak = new Map<string, number>(); // agentId
  // Per-agent reference to the last `assistant-text` emitted in any prior
  // batch. A `turn_completed` that lands in a later poll than the
  // `agent_message_chunk` it should mark is reconciled via an
  // `assistant-text-patch` targeting this event (mirrors the codex reader).
  private lastAssistantTextEvent = new Map<string, AssistantTextEvent>();

  private getWindowsGrokDir(): string | null {
    if (this.windowsGrokDir !== undefined) return this.windowsGrokDir;
    const dir = resolveWindowsHomeSubdir('.grok');
    if (dir) this.windowsGrokDir = dir;
    return dir;
  }

  private getWslGrokDir(): string | null {
    if (this.wslGrokDir !== undefined) return this.wslGrokDir;
    const dir = resolveWslHomeSubdir('.grok');
    if (dir) this.wslGrokDir = dir;
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
    this.emittedSystemInit.delete(agentId);
    this.currentModel.delete(agentId);
    this.lastAssistantTextEvent.delete(agentId);
    const prefix = `${agentId}:`;
    for (const key of this.toolResultLocations.keys()) {
      if (key.startsWith(prefix)) this.toolResultLocations.delete(key);
    }
  }

  private forgetResolvedPath(agentId: string): void {
    this.resolvedPaths.delete(agentId);
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
        const line = buf.toString('utf-8').trim();
        if (!line) return null;
        const entry = JSON.parse(line);
        const update = entry?.params?.update;
        if (!update || update.sessionUpdate !== 'tool_call_update') return null;
        return extractToolResultText(update);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /** One-shot PURE read of a prior session's structured chat straight from
   *  disk, mirroring the codex/claude readers. A terminal grok agent has no
   *  live tail and its ring is released, so its chat survives only as the
   *  session's `updates.jsonl` on disk (readers never unlink).
   *
   *  Requires a session id: the caller (agent-chat-history.ts) only invokes
   *  this when the agent carries a `resumeSessionId`. Since the dashboard does
   *  not bind grok session ids today, terminal grok agents usually degrade to
   *  `source: 'unavailable'` — acceptable per scope; this path is here so that
   *  history works for any grok agent that DOES carry a bound id.
   *
   *  Side-effect free with respect to the live tail: parses under an ephemeral
   *  scope id and clears the scope's per-agent rows in `finally`, never touches
   *  `fileOffsets` / `partialLines` / `resolvedPaths`. */
  readSessionEventsOnce(workingDirectory: string, sessionId: string): SessionEvent[] | null {
    if (!sessionId) return null;

    const scopeId = `__prior-session__:${sessionId}`;
    const session: ChatLogReaderSession = {
      agentId: scopeId,
      sessionId,
      workingDirectory,
      provider: this.provider,
      subscribed: false,
    };

    const jsonlPath = this.findUpdatesById(session);
    if (!jsonlPath) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      return null;
    }

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
      this.emittedSystemInit.delete(scopeId);
      this.currentModel.delete(scopeId);
      this.lastAssistantTextEvent.delete(scopeId);
      const prefix = `${scopeId}:`;
      for (const key of this.toolResultLocations.keys()) {
        if (key.startsWith(prefix)) this.toolResultLocations.delete(key);
      }
    }
    return out;
  }

  pollSession(session: ChatLogReaderSession): SessionEvent[] {
    const jsonlPath = this.resolveUpdatesPath(session);
    if (!jsonlPath) return [];

    let fileSize: number;
    try {
      fileSize = fs.statSync(jsonlPath).size;
    } catch {
      return [];
    }

    const lastOffset = this.fileOffsets.get(jsonlPath) || 0;

    // Rotation/replacement (file shrank) — restart the tail from byte 0.
    if (fileSize < lastOffset) {
      this.fileOffsets.set(jsonlPath, 0);
      this.partialLines.delete(jsonlPath);
      return this.pollSession(session);
    }

    if (fileSize === lastOffset) {
      const streak = (this.eofStreak.get(session.agentId) || 0) + 1;
      this.eofStreak.set(session.agentId, streak);
      // Subscribed + quiet: re-resolve in case the agent rolled to a new
      // session dir (e.g. /new). forgetResolvedPath also clears the streak so
      // this re-arms every EOF_STREAK_REREGISTER polls.
      if (streak >= EOF_STREAK_REREGISTER && session.subscribed) {
        this.forgetResolvedPath(session.agentId);
      }
      return [];
    }
    this.eofStreak.delete(session.agentId);

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
    const partialBytes = Buffer.byteLength(partial, 'utf-8');
    let cursor = readStart - partialBytes;

    const lines = combined.split('\n');
    const maybeLast = lines.pop() || '';
    this.partialLines.set(jsonlPath, maybeLast);

    const newEvents: SessionEvent[] = [];
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
    const params = entry?.params;
    const update = params?.update;
    if (!update || typeof update !== 'object') return;
    const su: string | undefined = update.sessionUpdate;
    if (!su) return;

    const meta = params._meta || {};
    const eventId: string = typeof meta.eventId === 'string' && meta.eventId
      ? meta.eventId
      : `${jsonlPath}:${lineStartOffset}`;
    const timestamp = grokTimestamp(meta, entry);
    const mkEventUuid = (suffix: string) => `${eventId}#${suffix}`;

    // Lazily synthesize a system-init from summary.json the first time we see
    // any content for this agent (grok's updates.jsonl has no session-meta).
    this.ensureSystemInit(session, jsonlPath, timestamp, out);

    switch (su) {
      case 'user_message_chunk': {
        const modelId = update._meta?.modelId;
        if (typeof modelId === 'string' && modelId) this.currentModel.set(session.agentId, modelId);
        const text = contentText(update.content).trim();
        if (text.length === 0) return;
        const ev: UserTextEvent = {
          type: 'user-text',
          uuid: mkEventUuid('u'),
          timestamp,
          agentId: session.agentId,
          text,
        };
        out.push(ev);
        return;
      }

      case 'agent_message_chunk': {
        const text = contentText(update.content).trim();
        if (text.length === 0) return;
        const model = this.currentModel.get(session.agentId);
        const ev: AssistantTextEvent = {
          type: 'assistant-text',
          uuid: mkEventUuid('a'),
          timestamp,
          agentId: session.agentId,
          text,
          ...(model ? { model } : {}),
        };
        out.push(ev);
        this.lastAssistantTextEvent.set(session.agentId, ev);
        return;
      }

      case 'agent_thought_chunk': {
        const text = contentText(update.content).trim();
        if (text.length === 0) return;
        const ev: ThinkingEvent = {
          type: 'thinking',
          uuid: mkEventUuid('think'),
          timestamp,
          agentId: session.agentId,
          text,
        };
        out.push(ev);
        return;
      }

      case 'tool_call': {
        const toolUseId: string = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        const toolName: string = xaiToolName(update) || update.title || 'unknown';
        const ev: ToolUseEvent = {
          type: 'tool-use',
          uuid: mkEventUuid('tu'),
          timestamp,
          agentId: session.agentId,
          toolUseId,
          toolName,
          input: update.rawInput ?? {},
        };
        out.push(ev);
        return;
      }

      case 'tool_call_update': {
        // Grok streams multiple tool_call_update lines per call (pending →
        // in_progress → completed). Emit exactly one tool-result, on the
        // terminal status, so chat doesn't render partial duplicates.
        const status = update.status;
        if (status !== 'completed' && status !== 'failed') return;
        const toolUseId: string = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        const rawContent = extractToolResultText(update);
        const { content, truncated } = truncateForChat(rawContent);
        const ev: ToolResultEvent = {
          type: 'tool-result',
          uuid: mkEventUuid('tr'),
          timestamp,
          agentId: session.agentId,
          toolUseId,
          content,
          truncated,
          isError: status === 'failed',
        };
        out.push(ev);
        if (toolUseId) {
          this.toolResultLocations.set(`${session.agentId}:${toolUseId}`, {
            jsonlPath,
            startOffset: lineStartOffset,
            endOffset: lineEndOffset,
          });
        }
        return;
      }

      case 'turn_completed': {
        const stopReason: string = typeof update.stop_reason === 'string' ? update.stop_reason : 'end_turn';
        this.markTurnComplete(session, mkEventUuid, timestamp, stopReason, out);
        this.emitUsage(session, mkEventUuid, timestamp, update.usage, out);
        return;
      }

      // hook_execution, session_recap, and any unknown update — drop.
      default:
        return;
    }
  }

  /** Tag the turn's assistant-text with turnComplete/stopReason. In-batch:
   *  walk back `out` for the last assistant-text. Split-batch: emit an
   *  assistant-text-patch targeting the prior batch's assistant-text. */
  private markTurnComplete(
    session: ChatLogReaderSession,
    mkEventUuid: (s: string) => string,
    timestamp: string,
    stopReason: string,
    out: SessionEvent[]
  ): void {
    for (let i = out.length - 1; i >= 0; i--) {
      const ev = out[i];
      if (ev.type === 'assistant-text') {
        ev.turnComplete = true;
        ev.stopReason = stopReason;
        const trimmed = ev.text.trimEnd();
        ev.endsWithQuestion = trimmed.length > 0 && trimmed.endsWith('?');
        this.lastAssistantTextEvent.delete(session.agentId);
        return;
      }
    }
    const prior = this.lastAssistantTextEvent.get(session.agentId);
    if (prior) {
      const trimmed = prior.text.trimEnd();
      const endsWithQuestion = trimmed.length > 0 && trimmed.endsWith('?');
      const patch: AssistantTextPatchEvent = {
        type: 'assistant-text-patch',
        uuid: mkEventUuid('atp'),
        timestamp,
        agentId: session.agentId,
        targetUuid: prior.uuid,
        turnComplete: true,
        stopReason,
        endsWithQuestion,
      };
      out.push(patch);
      this.lastAssistantTextEvent.delete(session.agentId);
    }
  }

  private emitUsage(
    session: ChatLogReaderSession,
    mkEventUuid: (s: string) => string,
    timestamp: string,
    usage: any,
    out: SessionEvent[]
  ): void {
    if (!usage || typeof usage !== 'object') return;
    const inputTokens = numOr0(usage.inputTokens);
    const outputTokens = numOr0(usage.outputTokens);
    // cachedReadTokens is a subset of inputTokens (the cache-hit portion), not
    // additional — surface it as `cachedTokens`, never add it to the total.
    const cachedTokens = numOr0(usage.cachedReadTokens);
    const totalTokens = numOr0(usage.totalTokens) || inputTokens + outputTokens;
    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return;

    const model = this.currentModel.get(session.agentId) || 'grok';
    // Gauge policy (matches codex/claude): 100% = the per-role configured cap
    // (default 200K) even though grok's real window is larger (500K for
    // grok-4.5, which turn_completed does not report). Context occupancy is the
    // full resent prompt, i.e. inputTokens.
    const contextWindowMax = Math.min(
      getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW_TOKENS,
      resolveContextGaugeCap(session.role)
    );
    const cumulativeContextTokens = inputTokens || totalTokens;
    const contextPercentage = Math.min(
      100,
      Math.round((cumulativeContextTokens / contextWindowMax) * 100)
    );

    const ev: UsageEvent = {
      type: 'usage',
      uuid: mkEventUuid('use'),
      timestamp,
      agentId: session.agentId,
      sessionId: session.sessionId,
      model,
      inputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens,
      cumulativeContextTokens,
      contextWindowMax,
      contextPercentage,
      cachedTokens,
      totalTokens,
    };
    out.push(ev);
  }

  private ensureSystemInit(
    session: ChatLogReaderSession,
    jsonlPath: string,
    timestamp: string,
    out: SessionEvent[]
  ): void {
    if (this.emittedSystemInit.has(session.agentId)) return;
    this.emittedSystemInit.add(session.agentId);
    const meta = readGrokSummary(path.dirname(jsonlPath));
    const model = meta.model || 'grok';
    this.currentModel.set(session.agentId, model);
    const ev: SystemInitEvent = {
      type: 'system-init',
      uuid: `${jsonlPath}:summary#init`,
      timestamp,
      agentId: session.agentId,
      model,
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
    };
    out.push(ev);
  }

  // ── Path resolution ────────────────────────────────────────────────────

  private resolveUpdatesPath(session: ChatLogReaderSession): string | null {
    const cached = this.resolvedPaths.get(session.agentId);
    if (cached) {
      if (fs.existsSync(cached)) return cached;
      this.resolvedPaths.delete(session.agentId);
    }

    // Exact session id (when the agent record carries one).
    if (session.sessionId) {
      const byId = this.findUpdatesById(session);
      if (byId) {
        this.resolvedPaths.set(session.agentId, byId);
        return byId;
      }
    }

    // cwd discovery — the common grok path (session ids aren't bound).
    const byCwd = this.findUpdatesByCwd(session);
    if (byCwd) {
      this.resolvedPaths.set(session.agentId, byCwd);
      return byCwd;
    }
    return null;
  }

  private candidateGrokDirs(session: ChatLogReaderSession): string[] {
    const wslFirst = session.workingDirectory.startsWith('/');
    const wslDir = this.getWslGrokDir();
    const windowsDir = this.getWindowsGrokDir();
    const dirs: string[] = [];
    if (wslFirst) {
      if (wslDir) dirs.push(wslDir);
      if (windowsDir) dirs.push(windowsDir);
    } else {
      if (windowsDir) dirs.push(windowsDir);
      if (wslDir) dirs.push(wslDir);
    }
    return dirs;
  }

  /** Locate `<grok>/sessions/<group>/<sessionId>/updates.jsonl`. Tries the
   *  encoded-cwd group first, then scans all groups for the id (covers the
   *  slug+hash group naming and cwd drift). */
  private findUpdatesById(session: ChatLogReaderSession): string | null {
    const sid = session.sessionId;
    for (const grokDir of this.candidateGrokDirs(session)) {
      const sessionsDir = path.join(grokDir, 'sessions');
      const group = path.join(sessionsDir, encodeURIComponent(session.workingDirectory));
      const direct = path.join(group, sid, 'updates.jsonl');
      if (fs.existsSync(direct)) return direct;
      for (const groupName of safeReaddir(sessionsDir)) {
        const p = path.join(sessionsDir, groupName, sid, 'updates.jsonl');
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }

  /** cwd-match-newest: find the group dir for the cwd, then the newest
   *  `updates.jsonl` among its session subdirs. Live sessions named in
   *  `active_sessions.json` for this cwd win; the agent start floor rejects
   *  stale prior sessions. */
  private findUpdatesByCwd(session: ChatLogReaderSession): string | null {
    const startFloorMs = parseIsoMs(session.startedAt);
    let best: { p: string; mtime: number; live: boolean } | null = null;

    for (const grokDir of this.candidateGrokDirs(session)) {
      const sessionsDir = path.join(grokDir, 'sessions');
      const groupDir = findGroupDirForCwd(sessionsDir, session.workingDirectory);
      if (!groupDir) continue;

      const liveIds = readActiveSessionIdsForCwd(grokDir, session.workingDirectory);

      for (const sid of safeReaddir(groupDir)) {
        const updatesPath = path.join(groupDir, sid, 'updates.jsonl');
        const mtime = safeMtime(updatesPath);
        if (mtime == null) continue;
        if (startFloorMs != null && mtime + START_FLOOR_SLACK_MS < startFloorMs) continue;
        const live = liveIds.has(sid);
        // Prefer a live session; among equals prefer newest updates.jsonl.
        if (
          best == null ||
          (live && !best.live) ||
          (live === best.live && mtime > best.mtime)
        ) {
          best = { p: updatesPath, mtime, live };
        }
      }
    }
    return best ? best.p : null;
  }
}

// ── Module helpers ──────────────────────────────────────────────────────

function numOr0(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// `startedAt` arrives from the agents table as a SQLite `datetime('now')`
// space-form UTC string ("YYYY-MM-DD HH:MM:SS", no zone marker). Bare
// `Date.parse` reads that as LOCAL time and skews the start floor by the full
// TZ offset — on a UTC-7 host the floor lands ~7h in the future and rejects
// every live session. Delegate to the shared UTC-aware parser (ISO-Z values
// still pass through unchanged).
function parseIsoMs(value: string | undefined): number | null {
  return parseSqliteUtcMs(value);
}

/** ISO timestamp for a grok update: prefer `_meta.agentTimestampMs` (ms),
 *  fall back to the line's unix-second `timestamp`, then to now. */
function grokTimestamp(meta: any, entry: any): string {
  const ms = meta?.agentTimestampMs;
  if (typeof ms === 'number' && isFinite(ms)) return new Date(ms).toISOString();
  const sec = entry?.timestamp;
  if (typeof sec === 'number' && isFinite(sec)) return new Date(sec * 1000).toISOString();
  return new Date().toISOString();
}

/** Flatten a grok ACP `content` value to text. Handles a single
 *  `{type:'text', text}` block and an array of `{type:'content',
 *  content:{type:'text', text}}` blocks (the tool_call_update shape). */
function contentText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) parts.push(contentText(block));
    return parts.join('');
  }
  if (typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    if (c.content && typeof c.content === 'object') return contentText(c.content);
  }
  return '';
}

/** Tool-result body from a completed tool_call_update: prefer the CLI-rendered
 *  `rawOutput.output_for_prompt`, else flatten the `content` blocks. */
function extractToolResultText(update: any): string {
  const rawOut = update?.rawOutput;
  if (rawOut && typeof rawOut === 'object' && typeof rawOut.output_for_prompt === 'string') {
    return rawOut.output_for_prompt;
  }
  return contentText(update?.content);
}

function xaiToolName(update: any): string | null {
  const tool = update?._meta?.['x.ai/tool'];
  if (tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name) {
    return tool.name;
  }
  return null;
}

interface GrokSummaryMeta {
  model: string | null;
  cwd: string | null;
}

/** Read `summary.json` from a session dir for the model id + cwd used to
 *  synthesize a system-init. Returns nulls on any failure. */
export function readGrokSummary(sessionDir: string): GrokSummaryMeta {
  try {
    const text = fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf-8');
    const json = JSON.parse(text);
    const model = json?.current_model_id;
    const cwd = json?.info?.cwd;
    return {
      model: typeof model === 'string' ? model : null,
      cwd: typeof cwd === 'string' ? cwd : null,
    };
  } catch {
    return { model: null, cwd: null };
  }
}

/** Resolve the group dir under `<grok>/sessions` for a working directory.
 *  Grok names the group by URL-encoding the cwd (encodeURIComponent), and for
 *  cwds whose encoding exceeds 255 bytes it uses a slug+hash and records the
 *  original path in a group-level `.cwd` file. The fast path is the encoded
 *  name; the fallback scans groups and matches either the decoded name or the
 *  `.cwd` file. */
export function findGroupDirForCwd(sessionsDir: string, workingDirectory: string): string | null {
  const encoded = path.join(sessionsDir, encodeURIComponent(workingDirectory));
  if (fs.existsSync(encoded)) return encoded;

  const target = normalizeCwd(workingDirectory);
  for (const name of safeReaddir(sessionsDir)) {
    const groupDir = path.join(sessionsDir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(groupDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      decoded = null;
    }
    if (decoded && normalizeCwd(decoded) === target) return groupDir;
    // slug+hash group — the original path lives in a `.cwd` file.
    try {
      const cwdFile = fs.readFileSync(path.join(groupDir, '.cwd'), 'utf-8').trim();
      if (cwdFile && normalizeCwd(cwdFile) === target) return groupDir;
    } catch {
      // no `.cwd` file — not a slug+hash group.
    }
  }
  return null;
}

/** Session ids listed as live in `~/.grok/active_sessions.json` whose cwd
 *  matches the target. Empty set on any failure — discovery then falls back to
 *  newest-mtime, so a missing/garbled file never blocks the tail. */
export function readActiveSessionIdsForCwd(grokDir: string, workingDirectory: string): Set<string> {
  const out = new Set<string>();
  try {
    const text = fs.readFileSync(path.join(grokDir, 'active_sessions.json'), 'utf-8');
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) return out;
    const target = normalizeCwd(workingDirectory);
    for (const row of rows as GrokActiveSession[]) {
      if (row && typeof row.session_id === 'string' && typeof row.cwd === 'string') {
        if (normalizeCwd(row.cwd) === target) out.add(row.session_id);
      }
    }
  } catch {
    // missing / unreadable / malformed — fall back to newest-mtime.
  }
  return out;
}
