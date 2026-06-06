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
import type { AgentProvider } from '../../../shared/types';
import {
  flattenToolResultContent,
  resolveWindowsHomeSubdir,
  resolveWslHomeSubdir,
  truncateForChat,
  type ChatLogReader,
  type ChatLogReaderSession,
} from './types';

const EOF_STREAK_REREGISTER = 3;

interface FullToolResultLocation {
  jsonlPath: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Reads gemini-cli JSONL transcripts at:
 *   ~/.gemini/tmp/<project-slug>/chats/session-<ISO-ts>-<sessionId-prefix-8>.jsonl
 *
 * Project resolution: each `~/.gemini/tmp/<slug>/` contains a plain-text file
 * `.project_root` whose contents are the absolute, lowercased cwd. We match
 * the agent's workingDirectory against those.
 *
 * **Mutating-line semantics (critical):** unlike codex/claude rollouts, gemini
 * rewrites the same turn `id` multiple times to the same JSONL — first without
 * `toolCalls`, then again with `toolCalls + result` populated as they arrive.
 * Byte-offset tailing still works for *reading*, but emit-side dedup keyed on
 * `(turnId, sub-event)` is required so the dispatcher doesn't double-render.
 *
 * Resolution strategy: cwd-match-newest after agent start. Filename only carries the 8-char
 * sessionId prefix, which collides across resumes — so session-id discovery
 * doesn't actually narrow further than "newest jsonl in the matching slug dir."
 */
export class GeminiTranscriptReader implements ChatLogReader {
  readonly provider: AgentProvider = 'gemini';

  // Base dirs resolve lazily and self-heal (see resolveWslHomeSubdir in
  // types.ts): a failed WSL discovery at app startup must not permanently
  // disable transcript attach for WSL agents. Tri-state: `undefined` = not
  // yet resolved (accessors keep retrying), `null` = pinned absent (tests),
  // string = resolved (cached for the reader's lifetime).
  private windowsTmpDir: string | null | undefined = undefined;
  private wslTmpUncDir: string | null | undefined = undefined;

  private resolvedPaths = new Map<string, string>(); // agentId -> jsonlPath
  private fileOffsets = new Map<string, number>(); // jsonlPath -> byte offset
  private partialLines = new Map<string, string>(); // jsonlPath -> partial
  private emittedSystemInit = new Set<string>(); // agentId
  private currentModel = new Map<string, string>(); // agentId -> model
  private eofStreak = new Map<string, number>(); // agentId

  // Mutating-line dedup state (per-agent → per-turn).
  private emittedTextByTurn = new Map<string, Set<string>>(); // agentId -> Set<turnId>
  /** BUG-09 §3.9 — per-turn flag: have we already emitted an assistant event
   *  with `turnComplete: true` for this turn? Used to gate the
   *  `assistant-text-patch` that flips the flag once Gemini's transcript
   *  catches up with tool-results + usage. */
  private emittedTurnCompleteByTurn = new Map<string, Set<string>>(); // agentId -> Set<turnId>
  private emittedThinkingCountByTurn = new Map<string, Map<string, number>>(); // agentId -> turnId -> count
  private emittedToolCallByTurn = new Map<string, Set<string>>(); // agentId -> Set<`${turnId}:${toolCallId}`>
  private emittedToolResultByTurn = new Map<string, Set<string>>(); // agentId -> Set<`${turnId}:${toolCallId}`>
  private emittedTokensByTurn = new Map<string, Set<string>>(); // agentId -> Set<turnId>
  private emittedInfoIds = new Map<string, Set<string>>(); // agentId -> Set<infoId>
  private emittedUserIds = new Map<string, Set<string>>(); // agentId -> Set<userId>

  private toolResultLocations = new Map<string, FullToolResultLocation>(); // `${agentId}:${callId}`

  private getWindowsTmpDir(): string | null {
    if (this.windowsTmpDir !== undefined) return this.windowsTmpDir;
    const dir = resolveWindowsHomeSubdir('.gemini/tmp');
    if (dir) this.windowsTmpDir = dir;
    return dir;
  }

  private getWslTmpDir(): string | null {
    if (this.wslTmpUncDir !== undefined) return this.wslTmpUncDir;
    const dir = resolveWslHomeSubdir('.gemini/tmp');
    if (dir) this.wslTmpUncDir = dir;
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
    this.emittedTextByTurn.delete(agentId);
    this.emittedTurnCompleteByTurn.delete(agentId);
    this.emittedThinkingCountByTurn.delete(agentId);
    this.emittedToolCallByTurn.delete(agentId);
    this.emittedToolResultByTurn.delete(agentId);
    this.emittedTokensByTurn.delete(agentId);
    this.emittedInfoIds.delete(agentId);
    this.emittedUserIds.delete(agentId);
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
        if (entry?.type !== 'gemini' || !Array.isArray(entry.toolCalls)) return null;
        const tc = entry.toolCalls.find((c: any) => c?.id === toolUseId);
        if (!tc) return null;
        return flattenToolResultContent(tc.result);
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

    // Detect file rotation/replacement — clear all per-turn dedup state.
    if (fileSize < lastOffset) {
      this.fileOffsets.set(jsonlPath, 0);
      this.partialLines.delete(jsonlPath);
      this.clearTurnState(session.agentId);
      return this.pollSession(session);
    }

    if (fileSize === lastOffset) {
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
    // $set patches — drop.
    if (entry && entry.$set) return;

    const timestamp: string = entry?.timestamp || new Date().toISOString();

    // Session header: {sessionId, projectHash, kind: "main", startTime}
    if (entry && entry.kind === 'main' && typeof entry.sessionId === 'string') {
      if (!this.emittedSystemInit.has(session.agentId)) {
        const ev: SystemInitEvent = {
          type: 'system-init',
          uuid: `${jsonlPath}:header#init`,
          timestamp,
          agentId: session.agentId,
          model: 'gemini/unknown',
        };
        out.push(ev);
        this.emittedSystemInit.add(session.agentId);
      }
      return;
    }

    const type: string | undefined = entry?.type;

    // {type: "info", id, content} — drop after dedup.
    if (type === 'info') {
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!id) return;
      let seen = this.emittedInfoIds.get(session.agentId);
      if (!seen) {
        seen = new Set();
        this.emittedInfoIds.set(session.agentId, seen);
      }
      seen.add(id);
      return;
    }

    // {type: "user", id, content: [{text}], timestamp}
    if (type === 'user') {
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!id) return;
      let seenUsers = this.emittedUserIds.get(session.agentId);
      if (!seenUsers) {
        seenUsers = new Set();
        this.emittedUserIds.set(session.agentId, seenUsers);
      }
      if (seenUsers.has(id)) return;

      const blocks = Array.isArray(entry.content) ? entry.content : [];
      const parts: string[] = [];
      for (const b of blocks) {
        if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
      }
      const text = parts.join('').trim();
      if (text.length === 0) return;

      seenUsers.add(id);
      const ev: UserTextEvent = {
        type: 'user-text',
        uuid: `${jsonlPath}:${id}#u`,
        timestamp,
        agentId: session.agentId,
        text,
      };
      out.push(ev);
      return;
    }

    // {type: "gemini", id, content, thoughts?, tokens?, model, toolCalls?}
    if (type === 'gemini') {
      const turnId = typeof entry.id === 'string' ? entry.id : '';
      if (!turnId) return;

      if (typeof entry.model === 'string') this.currentModel.set(session.agentId, entry.model);

      // Thinking — emit only newly-arrived thoughts on rewrites.
      if (Array.isArray(entry.thoughts) && entry.thoughts.length > 0) {
        let perAgent = this.emittedThinkingCountByTurn.get(session.agentId);
        if (!perAgent) {
          perAgent = new Map();
          this.emittedThinkingCountByTurn.set(session.agentId, perAgent);
        }
        const prevCount = perAgent.get(turnId) || 0;
        for (let i = prevCount; i < entry.thoughts.length; i++) {
          const t = entry.thoughts[i];
          if (!t || typeof t !== 'object') continue;
          const subject = typeof t.subject === 'string' ? t.subject : '';
          const description = typeof t.description === 'string' ? t.description : '';
          const text = subject && description ? `${subject}\n\n${description}` : subject || description;
          if (!text) continue;
          const ev: ThinkingEvent = {
            type: 'thinking',
            uuid: `${jsonlPath}:${turnId}#think${i}`,
            timestamp,
            agentId: session.agentId,
            text,
          };
          out.push(ev);
        }
        perAgent.set(turnId, entry.thoughts.length);
      }

      // Assistant text — emit once per turn id, plus a follow-up patch when
      // the turn later becomes complete.
      if (typeof entry.content === 'string' && entry.content.trim().length > 0) {
        let seenText = this.emittedTextByTurn.get(session.agentId);
        if (!seenText) {
          seenText = new Set();
          this.emittedTextByTurn.set(session.agentId, seenText);
        }
        let seenTurnComplete = this.emittedTurnCompleteByTurn.get(session.agentId);
        if (!seenTurnComplete) {
          seenTurnComplete = new Set();
          this.emittedTurnCompleteByTurn.set(session.agentId, seenTurnComplete);
        }

        const model = this.currentModel.get(session.agentId);
        const text = entry.content.trim();
        const trimmed = text.trimEnd();
        const endsWithQuestion = trimmed.length > 0 && trimmed.endsWith('?');

        // BUG-09 §3.9 — gate `turnComplete` on tools-resolved + usage-landed.
        // Pre-Bundle-4 the reader hardcoded `turnComplete: true` on every
        // assistant emission, which is unsafe — Gemini rewrites the same
        // turn entry on later polls to add `toolCalls` and `tokens`. The
        // bridge had to opt Gemini out of `forceIdle` entirely (D-07) to
        // avoid premature idle flips. With this gate the flag tracks the
        // real terminal state of the transcript and D-07 can go away.
        const allToolsResolved = !Array.isArray(entry.toolCalls)
          || entry.toolCalls.every((tc: any) => tc?.result != null);
        const usageLanded = entry.tokens != null;
        const turnComplete = allToolsResolved && usageLanded;

        const uuid = `${jsonlPath}:${turnId}#a`;
        if (!seenText.has(turnId)) {
          seenText.add(turnId);
          if (turnComplete) seenTurnComplete.add(turnId);
          const ev: AssistantTextEvent = {
            type: 'assistant-text',
            uuid,
            timestamp,
            agentId: session.agentId,
            text,
            turnComplete,
            endsWithQuestion,
            ...(model ? { model } : {}),
          };
          out.push(ev);
        } else if (turnComplete && !seenTurnComplete.has(turnId)) {
          // Turn just transitioned to complete — emit a patch so the bridge
          // sees `turnComplete: true` and fires forceIdle. Mirrors the
          // Codex split-batch pattern at session-log-dispatcher.ts.
          seenTurnComplete.add(turnId);
          const patch: AssistantTextPatchEvent = {
            type: 'assistant-text-patch',
            uuid: `${jsonlPath}:${turnId}#a-patch`,
            timestamp,
            agentId: session.agentId,
            targetUuid: uuid,
            turnComplete: true,
            endsWithQuestion,
          };
          out.push(patch);
        }
      }

      // Tool calls — pass `args` through as `input` so downstream extractors
      // (ContextStatsMonitor) can read `input.file_path` uniformly.
      if (Array.isArray(entry.toolCalls)) {
        let seenCall = this.emittedToolCallByTurn.get(session.agentId);
        if (!seenCall) {
          seenCall = new Set();
          this.emittedToolCallByTurn.set(session.agentId, seenCall);
        }
        let seenResult = this.emittedToolResultByTurn.get(session.agentId);
        if (!seenResult) {
          seenResult = new Set();
          this.emittedToolResultByTurn.set(session.agentId, seenResult);
        }

        for (const tc of entry.toolCalls) {
          if (!tc || typeof tc !== 'object') continue;
          const toolUseId = typeof tc.id === 'string' ? tc.id : '';
          const toolName = typeof tc.name === 'string' ? tc.name : 'unknown';
          if (!toolUseId) continue;

          const key = `${turnId}:${toolUseId}`;
          if (!seenCall.has(key)) {
            seenCall.add(key);
            const ev: ToolUseEvent = {
              type: 'tool-use',
              uuid: `${jsonlPath}:${turnId}#tu:${toolUseId}`,
              timestamp,
              agentId: session.agentId,
              toolUseId,
              toolName,
              input: tc.args ?? {},
            };
            out.push(ev);
          }

          const status: string = typeof tc.status === 'string' ? tc.status : '';
          if ((status === 'success' || status === 'error') && tc.result != null) {
            if (!seenResult.has(key)) {
              seenResult.add(key);
              const rawContent = flattenToolResultContent(tc.result);
              const { content, truncated } = truncateForChat(rawContent);
              const ev: ToolResultEvent = {
                type: 'tool-result',
                uuid: `${jsonlPath}:${turnId}#tr:${toolUseId}`,
                timestamp,
                agentId: session.agentId,
                toolUseId,
                content,
                truncated,
                ...(status === 'error' ? { isError: true } : {}),
              };
              out.push(ev);
              this.toolResultLocations.set(`${session.agentId}:${toolUseId}`, {
                jsonlPath,
                startOffset: lineStartOffset,
                endOffset: lineEndOffset,
              });
            }
          }
        }
      }

      // Usage / tokens — once per turn.
      if (entry.tokens && typeof entry.tokens === 'object') {
        let seenTok = this.emittedTokensByTurn.get(session.agentId);
        if (!seenTok) {
          seenTok = new Set();
          this.emittedTokensByTurn.set(session.agentId, seenTok);
        }
        if (!seenTok.has(turnId)) {
          seenTok.add(turnId);
          this.emitUsageFromTokens(session, jsonlPath, turnId, timestamp, entry.tokens, out);
        }
      }
      return;
    }

    // Unknown — drop silently.
  }

  private emitUsageFromTokens(
    session: ChatLogReaderSession,
    jsonlPath: string,
    turnId: string,
    timestamp: string,
    tokens: any,
    out: SessionEvent[]
  ): void {
    const inputTokens = numOr0(tokens.input);
    const outputTokens = numOr0(tokens.output);
    const cachedTokens = numOr0(tokens.cached);
    const totalTokens = numOr0(tokens.total) || (inputTokens + outputTokens + cachedTokens);
    if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && totalTokens === 0) return;

    const model = this.currentModel.get(session.agentId) || 'gemini/unknown';
    const contextWindowMax = getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW_TOKENS;
    const cumulativeContextTokens = totalTokens;
    const contextPercentage = Math.min(
      100,
      Math.round((cumulativeContextTokens / contextWindowMax) * 100)
    );

    const ev: UsageEvent = {
      type: 'usage',
      uuid: `${jsonlPath}:${turnId}#use`,
      timestamp,
      agentId: session.agentId,
      sessionId: session.sessionId,
      model,
      inputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: cachedTokens,
      outputTokens,
      cumulativeContextTokens,
      contextWindowMax,
      contextPercentage,
      cachedTokens,
      totalTokens,
    };
    out.push(ev);
  }

  private clearTurnState(agentId: string): void {
    this.emittedTextByTurn.delete(agentId);
    this.emittedTurnCompleteByTurn.delete(agentId);
    this.emittedThinkingCountByTurn.delete(agentId);
    this.emittedToolCallByTurn.delete(agentId);
    this.emittedToolResultByTurn.delete(agentId);
    this.emittedTokensByTurn.delete(agentId);
    this.emittedInfoIds.delete(agentId);
    this.emittedUserIds.delete(agentId);
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

    const found = findGeminiTranscriptByCwd(baseDirs, session.workingDirectory, session.startedAt);
    if (found) {
      this.resolvedPaths.set(session.agentId, found);
      return found;
    }

    return null;
  }

  private candidateBaseDirs(session: ChatLogReaderSession): string[] {
    const wslFirst = session.workingDirectory.startsWith('/');
    const wslDir = this.getWslTmpDir();
    const windowsDir = this.getWindowsTmpDir();
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
}

// ── Module helpers ────────────────────────────────────────────────────

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

function readProjectRoot(slugDir: string): string | null {
  const candidate = path.join(slugDir, '.project_root');
  try {
    const text = fs.readFileSync(candidate, 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Find the newest gemini transcript jsonl whose `.project_root` matches the
 * agent's working directory. Returns null on miss.
 */
export function findGeminiTranscriptByCwd(
  baseDirs: string[],
  workingDirectory: string,
  notBefore?: string | number
): string | null {
  const target = normalizeCwd(workingDirectory);
  const notBeforeMs = parseNotBefore(notBefore);

  let best: { p: string; mtime: number } | null = null;
  for (const baseDir of baseDirs) {
    for (const slug of safeReaddir(baseDir)) {
      const slugDir = path.join(baseDir, slug);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(slugDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const projRoot = readProjectRoot(slugDir);
      if (!projRoot || normalizeCwd(projRoot) !== target) continue;

      const chatsDir = path.join(slugDir, 'chats');
      for (const filename of safeReaddir(chatsDir)) {
        if (!filename.startsWith('session-') || !filename.endsWith('.jsonl')) continue;
        const full = path.join(chatsDir, filename);
        const mtime = safeMtime(full);
        if (mtime == null) continue;
        if (notBeforeMs != null && mtime + 2000 < notBeforeMs) continue;
        if (best == null || mtime > best.mtime) {
          best = { p: full, mtime };
        }
      }
    }
  }
  return best ? best.p : null;
}

function parseNotBefore(value: string | number | undefined): number | null {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const normalizedUtc = value.trim().replace(' ', 'T');
    const asUtc = Date.parse(`${normalizedUtc}Z`);
    if (isFinite(asUtc)) return asUtc;
  }
  const direct = Date.parse(value);
  if (isFinite(direct)) return direct;
  return null;
}
