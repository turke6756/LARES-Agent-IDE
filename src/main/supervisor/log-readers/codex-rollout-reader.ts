import fs from 'fs';
import path from 'path';
import type {
  SessionEvent,
  UserTextEvent,
  AssistantTextEvent,
  AssistantTextPatchEvent,
  TaskStartedEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  UsageEvent,
  SystemInitEvent,
} from '../../../shared/session-events';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, getContextWindowForModel } from '../../../shared/constants';
import type { AgentProvider } from '../../../shared/types';
import {
  flattenToolResultContent,
  resolveHomeSubdir,
  truncateForChat,
  type ChatLogReader,
  type ChatLogReaderSession,
} from './types';

const PINNED_CLI_VERSION = '0.128.0';
const EOF_STREAK_REREGISTER = 3;
const RECENT_CWD_DISCOVERY_DAYS = 2;

interface FullToolResultLocation {
  jsonlPath: string;
  startOffset: number;
  endOffset: number;
}

export type CodexSessionHome = 'windows' | 'wsl';

export interface CodexRolloutFile {
  path: string;
  filename: string;
  sessionId: string;
  home: CodexSessionHome;
  mtimeMs: number;
}

export interface CodexSessionMeta {
  id: string | null;
  cwd: string | null;
  cliVersion: string | null;
}

/**
 * Reads Codex CLI rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`.
 *
 * Resolution strategy:
 *  1. If `session.sessionId` is set, scan all dated rollout dirs for that id.
 *  2. Otherwise (post-launch, before discovery resolves) use cwd-match: read first line
 *     (`session_meta`) of recent rollouts and pick newest whose `payload.cwd` matches
 *
 * Per-turn duplicate handling: Codex 0.128 emits user/assistant text via BOTH
 * `event_msg/{user_message,agent_message}` AND `response_item/message role=user/assistant`.
 * We pick one source per role to avoid double-emit:
 *  - user-text: from `event_msg/user_message` (clean string, no env_context wrapper)
 *  - assistant-text: from `response_item/message role=assistant output_text` (richer block structure)
 */
export class CodexRolloutReader implements ChatLogReader {
  readonly provider: AgentProvider = 'codex';

  private windowsSessionsDir: string | null = null;
  private wslSessionsUncDir: string | null = null;

  private resolvedPaths = new Map<string, string>(); // agentId -> jsonlPath
  private fileOffsets = new Map<string, number>(); // jsonlPath -> byte offset
  private partialLines = new Map<string, string>(); // jsonlPath -> partial
  private emittedSystemInit = new Set<string>(); // agentId
  private modelContextWindow = new Map<string, number>(); // agentId -> window from task_started
  private currentModel = new Map<string, string>(); // agentId -> "<provider>/<cli_version>"
  private toolResultLocations = new Map<string, FullToolResultLocation>(); // `${agentId}:${callId}`
  private eofStreak = new Map<string, number>(); // agentId
  private warnedNewerVersion = new Set<string>(); // cli_version values we've warned about
  // Per-agent reference to the last `assistant-text` emitted in any prior
  // batch. Codex split-batches can deliver `task_complete` after the
  // assistant-text it should mark; without this we can't tag turn end
  // when the events land in different polls (see §2.1.3 / D-05).
  private lastAssistantTextEvent = new Map<string, AssistantTextEvent>();

  constructor() {
    const { windowsDir, wslUncDir } = resolveHomeSubdir('.codex/sessions');
    this.windowsSessionsDir = windowsDir;
    this.wslSessionsUncDir = wslUncDir;
  }

  invalidatePath(agentId: string): void {
    const cached = this.resolvedPaths.get(agentId);
    if (cached) {
      this.resolvedPaths.delete(agentId);
      this.fileOffsets.delete(cached);
      this.partialLines.delete(cached);
    }
    this.eofStreak.delete(agentId);
  }

  private forgetResolvedPath(agentId: string): void {
    const cached = this.resolvedPaths.get(agentId);
    if (cached) {
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
        const line = buf.toString('utf-8').trim();
        if (!line) return null;
        const entry = JSON.parse(line);
        const payload = entry?.payload;
        if (
          !payload ||
          (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output')
        ) {
          return null;
        }
        return flattenToolResultContent(payload.output);
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
    const timestamp: string = entry.timestamp || new Date().toISOString();
    const baseUuid = `${jsonlPath}:${lineStartOffset}`;
    const mkEventUuid = (suffix: string) => `${baseUuid}#${suffix}`;
    const type: string | undefined = entry.type;
    const payload = entry.payload || {};
    const payloadType: string | undefined = payload.type;

    if (type === 'session_meta') {
      const cliVersion: string = payload.cli_version || 'unknown';
      const modelProvider: string = payload.model_provider || 'codex';
      const model = `${modelProvider}/${cliVersion}`;
      this.currentModel.set(session.agentId, model);

      if (cliVersion !== PINNED_CLI_VERSION && !this.warnedNewerVersion.has(cliVersion)) {
        this.warnedNewerVersion.add(cliVersion);
        if (this.isNewerThanPinned(cliVersion)) {
          console.warn(
            `[CodexRolloutReader] cli_version ${cliVersion} newer than pinned ${PINNED_CLI_VERSION} — proceeding`
          );
        }
      }

      if (!this.emittedSystemInit.has(session.agentId)) {
        const ev: SystemInitEvent = {
          type: 'system-init',
          uuid: mkEventUuid('init'),
          timestamp,
          agentId: session.agentId,
          model,
          cwd: payload.cwd,
        };
        out.push(ev);
        this.emittedSystemInit.add(session.agentId);
      }
      return;
    }

    if (type === 'event_msg') {
      if (payloadType === 'user_message') {
        const text = (payload.message || '').trim();
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

      if (payloadType === 'task_started') {
        const window = payload.model_context_window;
        if (typeof window === 'number' && window > 0) {
          this.modelContextWindow.set(session.agentId, window);
        }
        const ev: TaskStartedEvent = {
          type: 'task-started',
          uuid: mkEventUuid('ts'),
          timestamp,
          agentId: session.agentId,
        };
        out.push(ev);
        return;
      }

      if (payloadType === 'token_count') {
        this.emitUsageFromTokenCount(session, mkEventUuid, timestamp, payload, out);
        return;
      }

      if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
        // Primary: mark the last assistant-text event in this batch.
        for (let i = out.length - 1; i >= 0; i--) {
          const ev = out[i];
          if (ev.type === 'assistant-text') {
            ev.turnComplete = true;
            ev.stopReason = payloadType;
            this.lastAssistantTextEvent.delete(session.agentId);
            return;
          }
        }
        // Fallback (split-batch): patch the prior batch's assistant-text via
        // the dispatcher's in-place ring mutation. See §2.1.3.
        const prior = this.lastAssistantTextEvent.get(session.agentId);
        if (prior) {
          const patch: AssistantTextPatchEvent = {
            type: 'assistant-text-patch',
            uuid: mkEventUuid('atp'),
            timestamp,
            agentId: session.agentId,
            targetUuid: prior.uuid,
            turnComplete: true,
            stopReason: payloadType,
          };
          out.push(patch);
          this.lastAssistantTextEvent.delete(session.agentId);
        }
        return;
      }

      // event_msg/agent_message: drop (response_item/message role=assistant carries same text with richer structure)
      // event_msg/exec_command_end, patch_apply_end, task_complete, turn_aborted, item_completed: drop
      return;
    }

    if (type === 'response_item') {
      if (payloadType === 'message') {
        const role = payload.role;
        if (role === 'assistant') {
          const blocks = Array.isArray(payload.content) ? payload.content : [];
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'output_text' && typeof block.text === 'string') {
              const text = block.text.trim();
              if (text.length === 0) continue;
              const model = this.currentModel.get(session.agentId);
              const ev: AssistantTextEvent = {
                type: 'assistant-text',
                uuid: mkEventUuid(`a${i}`),
                timestamp,
                agentId: session.agentId,
                text,
                ...(model ? { model } : {}),
              };
              out.push(ev);
              this.lastAssistantTextEvent.set(session.agentId, ev);
            }
          }
        }
        // role=user: drop (event_msg/user_message is the clean source)
        // role=developer: drop (system prompt echo / permissions instructions)
        return;
      }

      if (payloadType === 'reasoning') {
        const summary = Array.isArray(payload.summary) ? payload.summary : [];
        const parts: string[] = [];
        for (const s of summary) {
          if (s && typeof s === 'object' && typeof (s as any).text === 'string') {
            const t = (s as any).text.trim();
            if (t.length > 0) parts.push(t);
          }
        }
        if (parts.length === 0) return; // skip empty reasoning bubbles
        const ev: ThinkingEvent = {
          type: 'thinking',
          uuid: mkEventUuid('think'),
          timestamp,
          agentId: session.agentId,
          text: parts.join('\n\n'),
        };
        out.push(ev);
        return;
      }

      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        const toolUseId: string = payload.call_id || '';
        const toolName: string = payload.name || 'unknown';
        let input: unknown = payload.arguments ?? payload.input;
        if (payloadType === 'custom_tool_call' && toolName === 'apply_patch') {
          input = {
            input: typeof payload.input === 'string' ? payload.input : '',
            workdir: session.workingDirectory,
          };
        } else if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            // leave as raw string on parse failure
          }
        }
        const ev: ToolUseEvent = {
          type: 'tool-use',
          uuid: mkEventUuid('tu'),
          timestamp,
          agentId: session.agentId,
          toolUseId,
          toolName,
          input,
        };
        out.push(ev);
        return;
      }

      if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        const toolUseId: string = payload.call_id || '';
        const rawContent = flattenToolResultContent(payload.output);
        const { content, truncated } = truncateForChat(rawContent);
        const ev: ToolResultEvent = {
          type: 'tool-result',
          uuid: mkEventUuid('tr'),
          timestamp,
          agentId: session.agentId,
          toolUseId,
          content,
          truncated,
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
      return;
    }

    // turn_context, unknown — drop
  }

  private emitUsageFromTokenCount(
    session: ChatLogReaderSession,
    mkEventUuid: (s: string) => string,
    timestamp: string,
    payload: any,
    out: SessionEvent[]
  ): void {
    const info = payload.info;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let totalTokens = 0;
    let windowFromInfo: number | undefined;

    if (info && typeof info === 'object') {
      const usage = info.total_token_usage || info.last_token_usage;
      if (usage && typeof usage === 'object') {
        inputTokens = numOr0(usage.input_tokens);
        outputTokens = numOr0(usage.output_tokens);
        cachedTokens = numOr0(usage.cached_input_tokens ?? usage.cached_tokens);
        totalTokens = numOr0(usage.total_tokens) || (inputTokens + outputTokens + cachedTokens);
      }
      if (typeof info.model_context_window === 'number') {
        windowFromInfo = info.model_context_window;
      }
    } else if (info === null || info === undefined) {
      // 0.128 emits an early `token_count` with `info: null` at task start. Skip.
      const flatInput = numOr0(payload.input_tokens);
      const flatOutput = numOr0(payload.output_tokens);
      const flatCached = numOr0(payload.cached_tokens ?? payload.cached_input_tokens);
      const flatTotal = numOr0(payload.total_tokens);
      if (flatInput === 0 && flatOutput === 0 && flatCached === 0 && flatTotal === 0) {
        return;
      }
      inputTokens = flatInput;
      outputTokens = flatOutput;
      cachedTokens = flatCached;
      totalTokens = flatTotal || (flatInput + flatOutput + flatCached);
    }

    if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && totalTokens === 0) {
      return;
    }

    const model = this.currentModel.get(session.agentId) || 'codex/unknown';
    const stashWindow = this.modelContextWindow.get(session.agentId);
    const contextWindowMax =
      stashWindow ?? windowFromInfo ?? getContextWindowForModel(model) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const cumulativeContextTokens = totalTokens || (inputTokens + outputTokens + cachedTokens);
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
      totalTokens: totalTokens || cumulativeContextTokens,
    };
    out.push(ev);
  }

  // ── Path resolution ──────────────────────────────────────────────────

  private resolveJsonlPath(session: ChatLogReaderSession): string | null {
    const cached = this.resolvedPaths.get(session.agentId);
    if (cached) {
      if (fs.existsSync(cached)) return cached;
      this.resolvedPaths.delete(session.agentId);
    }

    const baseDirs = this.candidateBaseDirs(session);
    if (baseDirs.length === 0) return null;

    if (session.sessionId) {
      // Primary: glob rollout-*-<sessionId>.jsonl across all date dirs so old
      // agents can reload history long after launch.
      const found = this.findBySessionId(baseDirs, session.sessionId);
      if (found) {
        this.resolvedPaths.set(session.agentId, found);
        return found;
      }
    }

    // Fallback: cwd-match — newest rollout whose session_meta.cwd matches workingDirectory
    const found = this.findByCwd(baseDirs, RECENT_CWD_DISCOVERY_DAYS, session.workingDirectory);
    if (found) {
      this.resolvedPaths.set(session.agentId, found);
      return found;
    }

    return null;
  }

  private candidateBaseDirs(session: ChatLogReaderSession): string[] {
    // WSL sessions live under WSL home; Windows-host under Windows USERPROFILE.
    // Prefer the matching home first; fall back to the other if the agent's
    // working directory doesn't exist there.
    const wslFirst = session.workingDirectory.startsWith('/');
    const dirs: string[] = [];
    if (wslFirst) {
      if (this.wslSessionsUncDir) dirs.push(this.wslSessionsUncDir);
      if (this.windowsSessionsDir) dirs.push(this.windowsSessionsDir);
    } else {
      if (this.windowsSessionsDir) dirs.push(this.windowsSessionsDir);
      if (this.wslSessionsUncDir) dirs.push(this.wslSessionsUncDir);
    }
    return dirs;
  }

  private findBySessionId(
    baseDirs: string[],
    sessionId: string
  ): string | null {
    let best: { p: string; mtime: number } | null = null;
    for (const baseDir of baseDirs) {
      for (const file of listRolloutsInBaseDir(baseDir, 'all')) {
        if (file.sessionId !== sessionId) continue;
        if (best === null || file.mtimeMs > best.mtime) {
          best = { p: file.path, mtime: file.mtimeMs };
        }
      }
    }
    return best ? best.p : null;
  }

  private findByCwd(baseDirs: string[], daysBack: number, workingDirectory: string): string | null {
    type Candidate = { p: string; mtime: number };
    const candidates: Candidate[] = [];
    for (const baseDir of baseDirs) {
      for (const file of listRolloutsInBaseDir(baseDir, daysBack)) {
        candidates.push({ p: file.path, mtime: file.mtimeMs });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);

    const target = normalizeCwd(workingDirectory);
    for (const c of candidates) {
      const meta = readCodexSessionMeta(c.p);
      if (meta.cwd && normalizeCwd(meta.cwd) === target) return c.p;
    }
    return null;
  }

  private isNewerThanPinned(version: string): boolean {
    const a = version.split('.').map((n) => parseInt(n, 10));
    const b = PINNED_CLI_VERSION.split('.').map((n) => parseInt(n, 10));
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] || 0;
      const bv = b[i] || 0;
      if (av !== bv) return av > bv;
    }
    return false;
  }
}

// ── Module helpers ────────────────────────────────────────────────────

function numOr0(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function recentDateDirs(daysBack: number): string[][] {
  const out: string[][] = [];
  const now = new Date();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const year = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push([year, month, day]);
  }
  return out;
}

function allDateDirs(baseDir: string): string[][] {
  const out: string[][] = [];
  for (const year of safeReaddir(baseDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = path.join(baseDir, year);
    for (const month of safeReaddir(yearDir)) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthDir = path.join(yearDir, month);
      for (const day of safeReaddir(monthDir)) {
        if (/^\d{2}$/.test(day)) out.push([year, month, day]);
      }
    }
  }
  return out;
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

export function readCodexSessionMeta(jsonlPath: string): CodexSessionMeta {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      // Read up to 1MB; session_meta payloads can be large due to base_instructions.
      const buf = Buffer.alloc(1024 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf-8', 0, bytesRead);
      const newlineIdx = text.indexOf('\n');
      const firstLine = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
      const entry = JSON.parse(firstLine);
      if (entry.type !== 'session_meta') return { id: null, cwd: null, cliVersion: null };
      const id = entry?.payload?.id;
      const cwd = entry?.payload?.cwd;
      const cliVersion = entry?.payload?.cli_version;
      return {
        id: typeof id === 'string' ? id : null,
        cwd: typeof cwd === 'string' ? cwd : null,
        cliVersion: typeof cliVersion === 'string' ? cliVersion : null,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { id: null, cwd: null, cliVersion: null };
  }
}

function listRolloutsInBaseDir(baseDir: string, daysBack: number | 'all'): CodexRolloutFile[] {
  const out: CodexRolloutFile[] = [];
  const dateDirs = daysBack === 'all' ? allDateDirs(baseDir) : recentDateDirs(daysBack);
  for (const [year, month, day] of dateDirs) {
    const dir = path.join(baseDir, year, month, day);
    for (const filename of safeReaddir(dir)) {
      if (!filename.endsWith('.jsonl') || !filename.startsWith('rollout-')) continue;
      const sessionId = extractSessionIdFromFilename(filename);
      if (!sessionId) continue;
      const full = path.join(dir, filename);
      const mtimeMs = safeMtime(full);
      if (mtimeMs == null) continue;
      out.push({
        path: full,
        filename,
        sessionId,
        home: 'windows',
        mtimeMs,
      });
    }
  }
  return out;
}

/** Snapshot helper used by `session-id-discovery.ts`. Lists rollout files
 *  under Windows and/or WSL Codex homes. */
export function listCodexRolloutFiles(options: {
  home?: CodexSessionHome;
  daysBack?: number | 'all';
} = {}): CodexRolloutFile[] {
  const daysBack = options.daysBack ?? RECENT_CWD_DISCOVERY_DAYS;
  const { windowsDir, wslUncDir } = resolveHomeSubdir('.codex/sessions');
  const roots: Array<{ home: CodexSessionHome; dir: string | null }> = [
    { home: 'windows', dir: windowsDir },
    { home: 'wsl', dir: wslUncDir },
  ];
  const out: CodexRolloutFile[] = [];
  for (const root of roots) {
    if (!root.dir) continue;
    if (options.home && options.home !== root.home) continue;
    for (const file of listRolloutsInBaseDir(root.dir, daysBack)) {
      out.push({ ...file, home: root.home });
    }
  }
  return out;
}

/** Extract the session UUID from a rollout filename. Returns null on shape mismatch. */
export function extractSessionIdFromFilename(filename: string): string | null {
  // rollout-<ISO-ts>-<uuid>.jsonl where uuid is 8-4-4-4-12 hex
  const m = filename.match(/^rollout-.+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}
