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
import { DEFAULT_CONTEXT_WINDOW_TOKENS, getContextWindowForModel } from '../../../shared/constants';
import type { AgentProvider } from '../../../shared/types';
import {
  flattenToolResultContent,
  resolveHomeSubdir,
  truncateForChat,
  type ChatLogReader,
  type ChatLogReaderSession,
} from './types';

interface ToolResultLocation {
  jsonlPath: string;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
}

const EOF_STREAK_REREGISTER = 3;

export class ClaudeJsonlReader implements ChatLogReader {
  readonly provider: AgentProvider = 'claude';

  private windowsProjectsDir: string | null = null;
  private wslProjectsUncDir: string | null = null;

  private resolvedPaths = new Map<string, string>(); // agentId -> jsonlPath
  private fileOffsets = new Map<string, number>(); // jsonlPath -> byte offset
  private partialLines = new Map<string, string>(); // jsonlPath -> partial
  private seenEntryUuids = new Map<string, Set<string>>(); // agentId -> entry uuids
  private emittedSystemInit = new Set<string>(); // agentId
  private toolResultLocations = new Map<string, ToolResultLocation>(); // `${agentId}:${toolUseId}`
  private eofStreak = new Map<string, number>(); // agentId

  constructor() {
    const { windowsDir, wslUncDir } = resolveHomeSubdir('.claude/projects');
    this.windowsProjectsDir = windowsDir;
    this.wslProjectsUncDir = wslUncDir;
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
        const contextWindowMax = getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW_TOKENS;
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

    if (workingDirectory.startsWith('/') && this.wslProjectsUncDir) {
      const jsonlPath = path.join(this.wslProjectsUncDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        return jsonlPath;
      }
    }

    if (this.windowsProjectsDir) {
      const jsonlPath = path.join(this.windowsProjectsDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        return jsonlPath;
      }
    }

    const dirsToScan = [this.windowsProjectsDir, this.wslProjectsUncDir].filter(Boolean) as string[];
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
    return workingDirectory.replace(/[/\\:_.]/g, '-');
  }
}
