import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { AgentProvider } from '../../../shared/types';
import type {
  AssistantTextEvent,
  SessionEvent,
  SystemInitEvent,
  ThinkingEvent,
  ToolResultEvent,
  ToolUseEvent,
  UsageEvent,
  UserTextEvent,
} from '../../../shared/session-events';
import { resolveContextGaugeCap } from '../../context-gauge/context-gauge-cap';
import {
  resolveWindowsHomeSubdir,
  truncateForChat,
  type ChatLogReader,
  type ChatLogReaderSession,
} from './types';

const START_FLOOR_SLACK_MS = 2_000;
const HISTORY_TAIL_BYTES = 512 * 1024;
const TERMINAL_STEP_STATUSES = new Set([3, 7]);
const COMPLETED_STEP_STATUS = 3;
const USER_STEP_TYPE = 14;
const ASSISTANT_STEP_TYPE = 15;
const TOOL_STEP_TYPE = 21;
const FINAL_ASSISTANT_KIND = 2;
const AGY_MODEL = 'antigravity';
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WireValue = bigint | Buffer;
type WireMessage = Map<number, WireValue[]>;

interface AgyStepRow {
  idx: number;
  step_type: number;
  status: number;
  step_payload: Buffer | null;
  error_details: Buffer | null;
}

export interface AgyConversationMetadata {
  conversationId: string;
  cwd: string;
  createdAtMs: number;
}

/*
 * Antigravity 1.1.10 store schema (verified 2026-08-03): one WAL-mode SQLite
 * database per conversation under ~/.gemini/antigravity-cli/conversations.
 * `steps` is the ordered turn stream; idx is stable, step_type 14 is user text,
 * 15 is an assistant generation, 21 is a tool execution, 23 is recap noise,
 * and 98 is executor setup. Status 3 is completed and 7 is terminal failure.
 * Payload/metadata columns are protobuf wire messages: the top-level payload's
 * field 5 is step metadata (field 1 Timestamp, field 9 usage, field 4 tool
 * call), while fields 19/20/28 carry user/assistant/tool-result content.
 * `trajectory_metadata_blob(id='main')` supplies workspace URI, creation time,
 * and conversation UUID. The separate conversation_summaries.db was stale in
 * the live CLI fixture; history.jsonl had the strongest cwd->UUID binding after
 * prompt two, and brain/<uuid> only mirrored UUID-owned artifacts. settings.json
 * held trust configuration, not session identity.
 */

interface ParsedConversation {
  metadata: AgyConversationMetadata;
  events: SessionEvent[];
  toolResults: Map<string, string>;
}

function readVarint(buffer: Buffer, start: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  const limit = Math.min(buffer.length, start + 10);
  for (let offset = start; offset < limit; offset++) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset + 1];
    shift += 7n;
  }
  throw new Error('invalid protobuf varint');
}

/** Minimal schema-independent protobuf wire decoder. Agy persists generated
 * protobuf messages but does not ship descriptors; the stable field numbers
 * below were verified against the live 1.1.10 store and synthesized fixtures. */
export function decodeAgyWireMessage(buffer: Buffer): WireMessage {
  const fields: WireMessage = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    let tag: bigint;
    [tag, offset] = readVarint(buffer, offset);
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (field <= 0) throw new Error('invalid protobuf field number');

    let value: WireValue;
    if (wireType === 0) {
      [value, offset] = readVarint(buffer, offset);
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error('truncated protobuf fixed64');
      value = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      let rawLength: bigint;
      [rawLength, offset] = readVarint(buffer, offset);
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) {
        throw new Error('truncated protobuf bytes');
      }
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error('truncated protobuf fixed32');
      value = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
    const list = fields.get(field) ?? [];
    list.push(value);
    fields.set(field, list);
  }
  return fields;
}

function bytesField(message: WireMessage | null, field: number, index = 0): Buffer | null {
  const value = message?.get(field)?.[index];
  return Buffer.isBuffer(value) ? value : null;
}

function messageField(message: WireMessage | null, field: number, index = 0): WireMessage | null {
  const bytes = bytesField(message, field, index);
  if (!bytes) return null;
  try {
    return decodeAgyWireMessage(bytes);
  } catch {
    return null;
  }
}

function stringField(message: WireMessage | null, field: number, index = 0): string {
  const bytes = bytesField(message, field, index);
  if (!bytes) return '';
  const text = bytes.toString('utf8');
  return text.includes('\ufffd') ? '' : text;
}

function numberField(message: WireMessage | null, field: number, index = 0): number {
  const value = message?.get(field)?.[index];
  return typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

function timestampFrom(message: WireMessage | null, field: number): string {
  const stamp = messageField(message, field);
  const seconds = numberField(stamp, 1);
  const nanos = numberField(stamp, 2);
  const millis = seconds * 1_000 + Math.floor(nanos / 1_000_000);
  return new Date(millis > 0 ? millis : 0).toISOString();
}

function timestampMsFrom(message: WireMessage | null, field: number): number {
  const stamp = messageField(message, field);
  return numberField(stamp, 1) * 1_000 + Math.floor(numberField(stamp, 2) / 1_000_000);
}

function normalizeCwd(value: string): string {
  return path.win32.normalize(decodeCwd(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function decodeCwd(value: string): string {
  let decoded = value.trim();
  if (/^file:\/\//i.test(decoded)) {
    try {
      const url = new URL(decoded);
      decoded = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
    } catch {
      decoded = decoded.replace(/^file:\/\/\/?/i, '');
    }
  }
  return path.win32.normalize(decoded.replace(/\//g, '\\')).replace(/[\\/]+$/, '');
}

function cwdMatches(left: string, right: string): boolean {
  return !!left && !!right && normalizeCwd(left) === normalizeCwd(right);
}

function parseConversationMetadata(db: Database.Database, fallbackId: string): AgyConversationMetadata | null {
  const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as
    | { data?: Buffer }
    | undefined;
  if (!Buffer.isBuffer(row?.data)) return null;
  let meta: WireMessage;
  try {
    meta = decodeAgyWireMessage(row.data);
  } catch {
    return null;
  }
  const workspace = messageField(meta, 1);
  const cwd = decodeCwd(stringField(workspace, 1) || stringField(meta, 7));
  const conversationId = stringField(meta, 6) || fallbackId;
  return { conversationId, cwd, createdAtMs: timestampMsFrom(meta, 2) };
}

function parseJsonInput(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function printableStrings(message: WireMessage | null, depth = 0): string[] {
  if (!message || depth > 5) return [];
  const out: string[] = [];
  for (const values of message.values()) {
    for (const value of values) {
      if (!Buffer.isBuffer(value) || value.length === 0) continue;
      const text = value.toString('utf8');
      if (!text.includes('\ufffd') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
        out.push(text);
      }
      try {
        out.push(...printableStrings(decodeAgyWireMessage(value), depth + 1));
      } catch {
        // Ordinary UTF-8 leaf, not a nested protobuf.
      }
    }
  }
  return out;
}

function extractToolResult(payload: WireMessage, errorDetails: Buffer | null): string {
  if (errorDetails) {
    try {
      const error = stringField(decodeAgyWireMessage(errorDetails), 1);
      if (error) return error;
    } catch {
      // Fall through to the step payload.
    }
  }
  const result = messageField(payload, 28);
  if (!result) return '';

  // run_command stores its prompt-safe output at result field 21, nested field
  // 1. Other tools use different result variants, so fall back to the longest
  // printable leaf after trying that observed canonical path.
  const outputContainer = messageField(result, 21);
  const canonical = stringField(outputContainer, 1);
  if (canonical) return canonical;
  const strings = printableStrings(result).filter((text) => text.trim().length > 0);
  return strings.sort((a, b) => b.length - a.length)[0] ?? '';
}

function eventBase(session: ChatLogReaderSession, conversationId: string, idx: number, suffix: string, timestamp: string) {
  return {
    uuid: `agy:${conversationId}:step:${idx}:${suffix}`,
    timestamp,
    agentId: session.agentId,
  };
}

function parseStep(
  row: AgyStepRow,
  session: ChatLogReaderSession,
  conversationId: string,
  model: string,
  toolResults: Map<string, string>,
): SessionEvent[] {
  if (!Buffer.isBuffer(row.step_payload) || !TERMINAL_STEP_STATUSES.has(row.status)) return [];
  let payload: WireMessage;
  try {
    payload = decodeAgyWireMessage(row.step_payload);
  } catch {
    return [];
  }
  const metadata = messageField(payload, 5);
  const timestamp = timestampFrom(metadata, 1);

  if (row.step_type === USER_STEP_TYPE) {
    const content = messageField(payload, 19);
    const text = stringField(content, 2) || stringField(messageField(content, 3), 1);
    if (!text) return [];
    return [{
      type: 'user-text',
      ...eventBase(session, conversationId, row.idx, 'user', timestamp),
      text,
    } satisfies UserTextEvent];
  }

  if (row.step_type === ASSISTANT_STEP_TYPE) {
    const content = messageField(payload, 20);
    const text = stringField(content, 1) || stringField(content, 8);
    const contentKind = numberField(content, 12);
    const out: SessionEvent[] = [];
    if (text) {
      if (contentKind && contentKind !== FINAL_ASSISTANT_KIND) {
        out.push({
          type: 'thinking',
          ...eventBase(session, conversationId, row.idx, 'thinking', timestamp),
          text,
        } satisfies ThinkingEvent);
      } else {
        out.push({
          type: 'assistant-text',
          ...eventBase(session, conversationId, row.idx, 'assistant', timestamp),
          text,
          model,
          turnComplete: true,
          stopReason: row.status === COMPLETED_STEP_STATUS ? 'end_turn' : 'error',
          endsWithQuestion: text.trimEnd().endsWith('?'),
        } satisfies AssistantTextEvent);
      }
    }

    const usage = messageField(metadata, 9);
    const inputTokens = numberField(usage, 2);
    const outputTokens = numberField(usage, 3);
    const cachedTokens = numberField(usage, 5);
    if (inputTokens || outputTokens || cachedTokens) {
      const cap = resolveContextGaugeCap(session.role);
      out.push({
        type: 'usage',
        ...eventBase(session, conversationId, row.idx, 'usage', timestamp),
        sessionId: conversationId,
        model,
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cachedTokens,
        totalTokens: inputTokens + outputTokens,
        cumulativeContextTokens: inputTokens,
        contextWindowMax: cap,
        contextPercentage: Math.min(100, (inputTokens / cap) * 100),
      } satisfies UsageEvent);
    }
    return out;
  }

  if (row.step_type === TOOL_STEP_TYPE) {
    const tool = messageField(metadata, 4);
    const toolUseId = stringField(tool, 1) || `step-${row.idx}`;
    const toolName = stringField(tool, 2) || stringField(tool, 9) || 'tool';
    const input = parseJsonInput(stringField(tool, 3));
    const fullResult = extractToolResult(payload, row.error_details);
    const truncated = truncateForChat(fullResult);
    toolResults.set(toolUseId, fullResult);
    return [
      {
        type: 'tool-use',
        ...eventBase(session, conversationId, row.idx, 'tool-use', timestamp),
        toolUseId,
        toolName,
        input,
      } satisfies ToolUseEvent,
      {
        type: 'tool-result',
        ...eventBase(session, conversationId, row.idx, 'tool-result', timestamp),
        toolUseId,
        content: truncated.content,
        truncated: truncated.truncated,
        isError: row.status !== COMPLETED_STEP_STATUS,
      } satisfies ToolResultEvent,
    ];
  }

  // Types 23 (recap/transcript bookkeeping) and 98 (executor setup), plus any
  // unknown future internal records, are intentionally noise-dropped.
  return [];
}

function openReadOnly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 50');
  return db;
}

function parseConversation(
  dbPath: string,
  session: ChatLogReaderSession,
  includeSystemInit: boolean,
): ParsedConversation | null {
  let db: Database.Database | null = null;
  try {
    db = openReadOnly(dbPath);
    const fallbackId = path.basename(dbPath, '.db');
    const metadata = parseConversationMetadata(db, fallbackId);
    if (!metadata) return null;
    const rows = db.prepare(
      'SELECT idx, step_type, status, step_payload, error_details FROM steps ORDER BY idx ASC',
    ).all() as AgyStepRow[];
    const toolResults = new Map<string, string>();
    const events: SessionEvent[] = [];
    if (includeSystemInit) {
      events.push({
        type: 'system-init',
        ...eventBase(
          session,
          metadata.conversationId,
          -1,
          'system-init',
          new Date(metadata.createdAtMs || 0).toISOString(),
        ),
        model: AGY_MODEL,
        cwd: metadata.cwd,
      } satisfies SystemInitEvent);
    }
    for (const row of rows) {
      events.push(...parseStep(row, session, metadata.conversationId, AGY_MODEL, toolResults));
    }
    return { metadata, events, toolResults };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED' && code !== 'SQLITE_CANTOPEN') {
      console.warn(`[agy-session-reader] unable to read ${dbPath}:`, error);
    }
    // The dispatcher's ring remains the last-good snapshot. Returning no delta
    // on SQLITE_BUSY/LOCKED prevents duplication and retries on the next poll.
    return null;
  } finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }
}

function conversationDbPath(root: string, conversationId: string): string {
  return path.join(root, 'conversations', `${conversationId}.db`);
}

function tailUtf8(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const text = buffer.toString('utf8');
    return stat.size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Strongest available live binding. Agy writes conversationId on history
 * rows after the first prompt in a conversation, alongside the exact cwd. */
export function readAgyHistoryBinding(root: string, cwd: string, startedAt?: string): string | null {
  const historyPath = path.join(root, 'history.jsonl');
  let raw: string;
  try {
    raw = tailUtf8(historyPath, HISTORY_TAIL_BYTES);
  } catch {
    return null;
  }
  const floor = startedAt ? Date.parse(startedAt) - START_FLOOR_SLACK_MS : 0;
  let best: { id: string; timestamp: number } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = typeof row.conversationId === 'string' ? row.conversationId : '';
      const workspace = typeof row.workspace === 'string' ? row.workspace : '';
      const timestamp = typeof row.timestamp === 'number' ? row.timestamp : 0;
      if (!CONVERSATION_ID_RE.test(id) || !cwdMatches(workspace, cwd) || timestamp < floor) continue;
      if (!best || timestamp > best.timestamp) best = { id, timestamp };
    } catch {
      // Ignore malformed history rows.
    }
  }
  return best?.id ?? null;
}

export class AgySessionReader implements ChatLogReader {
  readonly provider: AgentProvider = 'agy';
  private windowsAgyRoot: string | null | undefined = undefined;
  private resolvedPaths = new Map<string, string>();
  private emittedEventIds = new Map<string, Set<string>>();
  private fullToolResults = new Map<string, string>();

  private getWindowsAgyRoot(): string | null {
    if (this.windowsAgyRoot !== undefined) return this.windowsAgyRoot;
    const dir = resolveWindowsHomeSubdir('.gemini/antigravity-cli');
    if (dir) this.windowsAgyRoot = dir;
    return dir;
  }

  invalidatePath(agentId: string): void {
    this.resolvedPaths.delete(agentId);
    this.emittedEventIds.delete(agentId);
    const prefix = `${agentId}:`;
    for (const key of this.fullToolResults.keys()) {
      if (key.startsWith(prefix)) this.fullToolResults.delete(key);
    }
  }

  async getFullToolResult(agentId: string, toolUseId: string): Promise<string | null> {
    return this.fullToolResults.get(`${agentId}:${toolUseId}`) ?? null;
  }

  sessionFileExists(workingDirectory: string, sessionId: string): boolean {
    const root = this.getWindowsAgyRoot();
    if (!root || !CONVERSATION_ID_RE.test(sessionId)) return false;
    const dbPath = conversationDbPath(root, sessionId);
    if (!fs.existsSync(dbPath)) return false;
    const probe: ChatLogReaderSession = {
      agentId: '__exists__', sessionId, workingDirectory, provider: 'agy', subscribed: false,
    };
    const parsed = parseConversation(dbPath, probe, false);
    return !!parsed && cwdMatches(parsed.metadata.cwd, workingDirectory);
  }

  readSessionEventsOnce(workingDirectory: string, sessionId: string): SessionEvent[] | null {
    const root = this.getWindowsAgyRoot();
    if (!root || !CONVERSATION_ID_RE.test(sessionId)) return null;
    const dbPath = conversationDbPath(root, sessionId);
    if (!fs.existsSync(dbPath)) return null;
    const session: ChatLogReaderSession = {
      agentId: `__prior-session__:${sessionId}`,
      sessionId,
      workingDirectory,
      provider: 'agy',
      subscribed: false,
    };
    const parsed = parseConversation(dbPath, session, true);
    if (!parsed || !cwdMatches(parsed.metadata.cwd, workingDirectory)) return null;
    return parsed.events;
  }

  pollSession(session: ChatLogReaderSession): SessionEvent[] {
    const dbPath = this.resolveDbPath(session);
    if (!dbPath) return [];
    const parsed = parseConversation(dbPath, session, true);
    if (!parsed || !cwdMatches(parsed.metadata.cwd, session.workingDirectory)) return [];

    let emitted = this.emittedEventIds.get(session.agentId);
    if (!emitted) {
      emitted = new Set();
      this.emittedEventIds.set(session.agentId, emitted);
    }
    const delta: SessionEvent[] = [];
    for (const event of parsed.events) {
      if (emitted.has(event.uuid)) continue;
      emitted.add(event.uuid);
      delta.push(event);
    }
    for (const [toolUseId, content] of parsed.toolResults) {
      this.fullToolResults.set(`${session.agentId}:${toolUseId}`, content);
    }
    return delta;
  }

  private resolveDbPath(session: ChatLogReaderSession): string | null {
    const cached = this.resolvedPaths.get(session.agentId);
    if (cached && fs.existsSync(cached)) return cached;
    const root = this.getWindowsAgyRoot();
    if (!root) return null;

    const candidates: string[] = [];
    if (CONVERSATION_ID_RE.test(session.sessionId)) candidates.push(conversationDbPath(root, session.sessionId));
    const historyId = readAgyHistoryBinding(root, session.workingDirectory, session.startedAt);
    if (historyId && historyId !== session.sessionId) candidates.push(conversationDbPath(root, historyId));

    const conversationsDir = path.join(root, 'conversations');
    try {
      const floor = session.startedAt ? Date.parse(session.startedAt) - START_FLOOR_SLACK_MS : 0;
      const newest = fs.readdirSync(conversationsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.db$/i.test(entry.name))
        .map((entry) => {
          const dbPath = path.join(conversationsDir, entry.name);
          try { return { dbPath, mtimeMs: fs.statSync(dbPath).mtimeMs }; } catch { return null; }
        })
        .filter((entry): entry is { dbPath: string; mtimeMs: number } => !!entry && entry.mtimeMs >= floor)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      candidates.push(...newest.map((entry) => entry.dbPath));
    } catch {
      // Missing/unreadable conversation directory.
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate) || !fs.existsSync(candidate)) continue;
      seen.add(candidate);
      const parsed = parseConversation(candidate, session, false);
      if (!parsed || !cwdMatches(parsed.metadata.cwd, session.workingDirectory)) continue;
      this.resolvedPaths.set(session.agentId, candidate);
      return candidate;
    }
    return null;
  }
}
