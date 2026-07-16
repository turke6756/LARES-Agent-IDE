// P0.2 detection helpers + design §4.4 behavior extraction + A8/A9 capture.
// Pure, IO-free, unit-tested against real fixtures (__fixtures__/).
//
// Given a parsed JSONL entry (+ per-stream context), this module derives:
//  - skill invocations (tool_use authoritative + slash best-effort)      [P0.2]
//  - tool-use classification incl. search normalization                  [P0.2]
//  - per-turn usage (four disjoint fields)                               [A8 §2.2]
//  - behavior events (tool_use/tool_result/file_touch/turn_outcome)      [design §4.4]
//    with access_mode (read/write/executed — Fix-7) and event_ordinal    [wp2b §1.1]
//  - trigger-phrase snippet selection (deterministic walk-back)          [A9 §3.2]
//
// NB: identity fields are DERIVED here but the DB writes live in parse-runner; the
// exactly-once guard is applied there, not here.

import crypto from 'crypto';
import { extractExecutedPaths, normalizeExecPath, type Shell } from './command-path-extractor';
import { workspaceRelativeOf } from '../context-optimizer/file-access-path';

// ── Entry shape (loose — mirrors claude-jsonl-reader.ts:577+) ──
export interface RawEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

export interface StreamCtx {
  jsonlPath: string;
  streamId: string;              // normalized jsonl_path (window key)
  slug?: string;
  sessionId?: string;
  subAgentName?: string | null;  // null for top-level
  isSubagent: boolean;
  workingDir?: string | null;    // stream launch cwd (first-entry) for path resolution
  workspaceRoot?: string | null; // WP-1B: folded workspace root, when known (else null → arg_path_workspace_rel stays null)
  lane: string;                  // 'supervisor'|'worker'|'researcher'|'legacy'|'unknown'
  knownSkills: Set<string>;      // P0.5 — for the slash secondary path
  firstLineHash?: string;        // no-UUID fallback discriminator (P0.2)
  resolveMcpToolset?: (toolName: string) => string | null; // §4.3 injected reverse map
}

// ── Id helper (P0.2) ──
export function mkId(entry: RawEntry, ctx: { jsonlPath: string; firstLineHash?: string }, lineStartOffset: number, blockIndex: number): string {
  const entryUuid = entry.uuid ?? `${ctx.jsonlPath}:${lineStartOffset}:${ctx.firstLineHash ?? ''}`;
  return `${entryUuid}#${blockIndex}`;
}
export function entryUuidOf(entry: RawEntry, ctx: { jsonlPath: string; firstLineHash?: string }, lineStartOffset: number): string {
  return entry.uuid ?? `${ctx.jsonlPath}:${lineStartOffset}:${ctx.firstLineHash ?? ''}`;
}

function tsMsOf(entry: RawEntry): number {
  if (!entry.timestamp) return 0;
  const t = Date.parse(entry.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ── Built-in slash commands that never match a skill dir (P0.5) ──
const BUILTIN_SLASH = new Set(['clear', 'compact', 'config', 'model', 'exit', 'help', 'cost', 'login', 'logout', 'quit', 'resume']);

// ─────────────────────────────────────────────────────────────────────────────
// P0.2 — skill invocation detection
// ─────────────────────────────────────────────────────────────────────────────
export interface SkillInvocationRaw {
  id: string;
  skillName: string;
  args: string | null;
  detector: 'tool_use' | 'slash_command';
  tsMs: number;
  blockIndex: number;
}

function collectUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
  }
  return '';
}

export function detectSkillInvocations(entry: RawEntry, ctx: StreamCtx, lineStartOffset: number): SkillInvocationRaw[] {
  const out: SkillInvocationRaw[] = [];
  const tsMs = tsMsOf(entry);
  const content = entry.message?.content;

  // tool_use path (authoritative)
  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const b: any = content[i];
      if (b && b.type === 'tool_use' && b.name === 'Skill') {
        const input = b.input || {};
        out.push({
          id: mkId(entry, ctx, lineStartOffset, i),
          skillName: String(input.skill ?? ''),
          args: input.args != null ? String(input.args) : null,
          detector: 'tool_use',
          tsMs,
          blockIndex: i,
        });
      }
    }
    return out;
  }

  // slash path (secondary, best-effort) — user entry text with <command-name>/X</command-name>
  if (entry.type === 'user') {
    const text = collectUserText(content);
    const uuid = entryUuidOf(entry, ctx, lineStartOffset);
    const re = /<command-name>\/([a-zA-Z0-9-]+)<\/command-name>/g;
    let m: RegExpExecArray | null;
    let matchIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const idx = matchIndex++;
      if (BUILTIN_SLASH.has(name.toLowerCase())) continue;      // built-ins dropped
      if (!ctx.knownSkills.has(name)) continue;                  // only emit known skills
      out.push({
        id: `${uuid}#slash:${idx}`,
        skillName: name,
        args: commandArgsFrom(text),
        detector: 'slash_command',
        tsMs,
        blockIndex: -1,
      });
    }
  }
  return out;
}

function commandArgsFrom(text: string): string | null {
  const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const v = m ? m[1].trim() : '';
  return v.length ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// P0.2 — tool_use classification (window counting + search normalization)
// ─────────────────────────────────────────────────────────────────────────────
export type ToolKind = 'builtin' | 'mcp' | 'skill';
export interface ToolUseInfo {
  blockIndex: number;
  toolUseId: string;
  toolName: string;
  toolKind: ToolKind;
  input: any;
  isSearch: boolean;
  normalizedQuery?: string;
  searchSignatureHash?: string;
}

const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch']);

export function toolKindOf(name: string): ToolKind {
  if (name === 'Skill') return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'builtin';
}

function normalizeQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s'"]*/g, '<path>')   // windows abs path
    .replace(/\/(?:mnt\/)?[a-z0-9._-]+(?:\/[^\s'"]*)+/g, '<path>') // posix abs path
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyToolUse(entry: RawEntry): ToolUseInfo[] {
  const out: ToolUseInfo[] = [];
  const content = entry.message?.content;
  if (entry.type !== 'assistant' || !Array.isArray(content)) return out;
  for (let i = 0; i < content.length; i++) {
    const b: any = content[i];
    if (!b || b.type !== 'tool_use') continue;
    const toolName = String(b.name ?? 'unknown');
    const info: ToolUseInfo = {
      blockIndex: i,
      toolUseId: String(b.id ?? ''),
      toolName,
      toolKind: toolKindOf(toolName),
      input: b.input,
      isSearch: SEARCH_TOOLS.has(toolName),
    };
    if (info.isSearch) {
      const raw = String((b.input && (b.input.pattern ?? b.input.query ?? b.input.url ?? '')) || '');
      info.normalizedQuery = normalizeQuery(raw);
      info.searchSignatureHash = sha256(`${toolName}:${info.normalizedQuery}`).slice(0, 16);
    }
    out.push(info);
  }
  return out;
}

// ── usage + turn signals ──
export function extractUsageOutputTokens(entry: RawEntry): number {
  return entry.message?.usage?.output_tokens ?? 0;
}

export interface TurnUsageRaw {
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  model: string | null;
}
/** A8 §2.2 — the four DISJOINT fields, stored raw. Returns null when no usage. */
export function extractTurnUsage(entry: RawEntry): TurnUsageRaw | null {
  const u = entry.message?.usage;
  if (!u) return null;
  return {
    input_tokens: u.input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    model: entry.message?.model ?? null,
  };
}

export function isEndTurn(entry: RawEntry): boolean {
  return entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn';
}
/** endsWithQuestion — assistant text ends with '?' on end_turn (claude-jsonl-reader.ts:534). */
export function endsWithQuestion(entry: RawEntry): boolean {
  if (!isEndTurn(entry)) return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  const texts = content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text.trimEnd());
  const last = texts[texts.length - 1];
  return !!last && last.length > 0 && last.endsWith('?');
}

// ─────────────────────────────────────────────────────────────────────────────
// design §4.4 — behavior events (generic histogram) + A1 executed-file capture
// ─────────────────────────────────────────────────────────────────────────────
export type AccessMode = 'read' | 'write' | 'executed';
export interface BehaviorEventRaw {
  entryUuid: string;
  blockIndex: number;
  byteOffset: number;
  tsMs: number;
  kind: 'tool_use' | 'tool_result' | 'file_touch' | 'turn_outcome';
  eventOrdinal: number;
  toolName?: string | null;
  toolKind?: ToolKind | null;
  mcpToolset?: string | null;
  commandFamily?: string | null;
  argPath?: string | null;
  argPathRaw?: string | null;
  argPathConfidence?: string | null;
  // WP-1B (Priority 0): cwd-RESOLVED identity for the guidance→file-access match.
  argPathCanonical?: string | null;     // raw arg resolved vs stream cwd + Win/WSL/POSIX-folded (null when unresolved)
  argPathWorkspaceRel?: string | null;  // root-anchored workspace-relative form (fwd-slash), when workspace known
  accessMode?: AccessMode | null;
  inputShapeHash?: string | null;
  // R2 WP-4B (Step 3): sorted input KEY NAMES (comma-joined) behind `inputShapeHash` —
  // redaction-safe, the same set that produced the hash. Null on non-tool_use events.
  inputKeySet?: string | null;
  outcome?: string | null;
  observable: number;
}

const READ_TOOLS: Record<string, string> = { Read: 'file_path', Glob: 'path', Grep: 'path' };
const WRITE_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** The SORTED input key NAMES for a tool call — the ONE source of truth shared by
 *  `shapeHash` (which hashes them) and `inputKeySet` (which stores them verbatim), so the
 *  stored set is provably the same set that produced the hash. Key names only, never a
 *  value — redaction-safe. */
function sortedInputKeys(input: any): string[] {
  return input && typeof input === 'object' ? Object.keys(input).sort() : [];
}

function shapeHash(toolName: string, input: any): string {
  return sha256(`${toolName}:${sortedInputKeys(input).join(',')}`).slice(0, 16);
}

/** R2 WP-4B (Step 3) — the redaction-safe input-key set stored alongside
 *  `input_shape_hash`: comma-joined SORTED key names (the same set `shapeHash` folds into
 *  the hash). Empty string when the input carries no keys (still redaction-safe). Powers
 *  the cluster-exemplar drill: it turns an opaque shape hash into "tool X called with keys
 *  {a,b,c}" without ever exposing a value. */
export function inputKeySet(input: any): string {
  return sortedInputKeys(input).join(',');
}

/**
 * Emit behavior events for one entry (design §4.4). One tool_use per tool block,
 * one tool_result per result block, file_touch for path-bearing tools + executed
 * scripts (A1), and a turn_outcome on end_turn. event_ordinal disambiguates
 * same-(uuid,block,kind) events (wp2b §1.1) — e.g. two scripts in one Bash block.
 * Searches also emit a generic tool_use here; the rich search row is separate
 * (parse-runner writes search_events from classifyToolUse).
 */
export function extractBehaviorEvents(entry: RawEntry, ctx: StreamCtx, lineStartOffset: number): BehaviorEventRaw[] {
  const out: BehaviorEventRaw[] = [];
  const tsMs = tsMsOf(entry);
  const uuid = entryUuidOf(entry, ctx, lineStartOffset);
  const content = entry.message?.content;

  // assistant tool_use blocks
  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const b: any = content[i];
      if (!b || b.type !== 'tool_use') continue;
      const toolName = String(b.name ?? 'unknown');
      const toolKind = toolKindOf(toolName);
      const mcpToolset = toolKind === 'mcp' && ctx.resolveMcpToolset ? ctx.resolveMcpToolset(toolName) : null;
      const input = b.input || {};

      // generic tool_use event (every tool)
      const toolUseEvent: BehaviorEventRaw = {
        entryUuid: uuid, blockIndex: i, byteOffset: lineStartOffset, tsMs,
        kind: 'tool_use', eventOrdinal: 0,
        toolName, toolKind, mcpToolset,
        inputShapeHash: shapeHash(toolName, input),
        inputKeySet: inputKeySet(input),
        observable: 1,
      };
      out.push(toolUseEvent);

      // file_touch: read/write path-bearing tools
      const readKey = READ_TOOLS[toolName];
      const writeKey = WRITE_TOOLS[toolName];
      if (readKey && typeof input[readKey] === 'string') {
        out.push(fileTouch(uuid, i, lineStartOffset, tsMs, 0, input[readKey], input[readKey], 'exact', 'read', ctx));
      } else if (writeKey && typeof input[writeKey] === 'string') {
        out.push(fileTouch(uuid, i, lineStartOffset, tsMs, 0, input[writeKey], input[writeKey], 'exact', 'write', ctx));
      }

      // executed scripts (A1) — Bash / PowerShell command strings
      if (toolName === 'Bash' || toolName === 'PowerShell') {
        const shell: Shell = toolName === 'PowerShell' ? 'powershell' : 'bash';
        const cmd = String(input.command ?? '');
        const res = extractExecutedPaths(cmd, shell, ctx.workingDir ?? null);
        let ord = 0;
        for (const p of res.paths) {
          // Executed paths are already cwd-resolved + folded by the extractor, so the
          // canonical column reuses `normalizedPath` (null when the token was unresolvable).
          const canonical = p.normalizedPath ?? null;
          out.push({
            entryUuid: uuid, blockIndex: i, byteOffset: lineStartOffset, tsMs,
            kind: 'file_touch', eventOrdinal: ord++,
            toolName, toolKind, commandFamily: res.commandFamily,
            argPath: p.normalizedPath, argPathRaw: p.rawPath, argPathConfidence: p.confidence,
            argPathCanonical: canonical,
            argPathWorkspaceRel: wsRelFor(canonical, ctx),
            accessMode: 'executed', observable: 1,
          });
        }
        // no resolved script but a pm-script family (npm run …) → tag the tool_use event's family
        if (!res.paths.length && res.commandFamily) {
          toolUseEvent.commandFamily = res.commandFamily;
        }
      }
    }
  }

  // user tool_result blocks
  if (entry.type === 'user' && Array.isArray(content)) {
    let ord = 0;
    for (let i = 0; i < content.length; i++) {
      const b: any = content[i];
      if (!b || b.type !== 'tool_result') continue;
      out.push({
        entryUuid: uuid, blockIndex: i, byteOffset: lineStartOffset, tsMs,
        kind: 'tool_result', eventOrdinal: ord++,
        outcome: b.is_error === true ? 'error' : 'ok',
        observable: 1,
      });
    }
  }

  // turn_outcome on end_turn
  if (isEndTurn(entry)) {
    out.push({
      entryUuid: uuid, blockIndex: 0, byteOffset: lineStartOffset, tsMs,
      kind: 'turn_outcome', eventOrdinal: 0,
      outcome: endsWithQuestion(entry) ? 'ended_with_question' : 'end_turn',
      observable: 1,
    });
  }
  return out;
}

function fileTouch(uuid: string, blockIndex: number, byteOffset: number, tsMs: number, ord: number, raw: string, path: string, confidence: string, mode: AccessMode, ctx: StreamCtx): BehaviorEventRaw {
  // Resolve the raw tool arg against the stream's recorded cwd → canonical identity.
  // A relative arg with no recorded cwd stays unresolved (null) and is NEVER
  // suffix-matched into a subtract (WP-1B honesty boundary).
  const canonical = normalizeExecPath(raw, ctx.workingDir ?? null).normalizedPath ?? null;
  return {
    entryUuid: uuid, blockIndex, byteOffset, tsMs,
    kind: 'file_touch', eventOrdinal: ord,
    argPath: path, argPathRaw: raw, argPathConfidence: confidence,
    argPathCanonical: canonical,
    argPathWorkspaceRel: wsRelFor(canonical, ctx),
    accessMode: mode, observable: 1,
  };
}

/** Workspace-relative form of a canonical path, when a workspace root is recorded
 *  on the stream. Delegates to the shared `workspaceRelativeOf` so ingestion and the
 *  guidance compiler produce identical workspace-relative keys. */
function wsRelFor(canonical: string | null, ctx: StreamCtx): string | null {
  if (!canonical || !ctx.workspaceRoot) return null;
  return workspaceRelativeOf(canonical, ctx.workspaceRoot) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// A9 §3.2 — trigger-phrase snippet selection (deterministic walk-back)
// ─────────────────────────────────────────────────────────────────────────────
export const TRIGGER_LOOKBACK_ENTRIES = 8;
export const TRIGGER_SNIPPET_MAX_CHARS = 280;

export type SnippetSourceKind = 'user_message' | 'supervisor_brief' | 'subagent_brief' | 'command_args' | 'none';
export interface TriggerSnippetResult {
  snippet: string | null;
  snippetHash: string | null;
  sourceKind: SnippetSourceKind;
  sourceEntryUuid: string | null;
  sourceByteOffset: number | null;
  distanceEntries: number | null;
  selectionReason: 'matched' | 'no_qualifying_user_message';
  srcTsMs: number | null;
}

/** A prior user entry captured during the parse pass (ring buffer, most-recent last). */
export interface PriorUserEntry {
  entry: RawEntry;
  entryUuid: string;
  byteOffset: number;
  tsMs: number;
  isFirstSubstantiveUser: boolean; // stream's first non-skipped user turn
}

function stripWrappers(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ');
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizeSnippetText(text: string): string {
  // CRLF→LF, collapse whitespace, trim, strip a leading list marker / heading '#'
  let s = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[#>\-*]+\s*/, '');
  return s;
}

function hasCommandName(content: unknown): boolean {
  const t = typeof content === 'string' ? content : collectUserText(content);
  return /<command-name>/.test(t);
}
function isPureToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((b: any) => b && b.type === 'tool_result');
}

type Qualified = { accept: true; text: string; source: SnippetSourceKind } | { accept: false };

function qualifyUserEntry(pe: PriorUserEntry, ctx: StreamCtx): Qualified {
  const entry = pe.entry;
  if (entry.isMeta === true) return { accept: false };
  const content = entry.message?.content;
  if (isPureToolResult(content)) return { accept: false };
  const rawText = typeof content === 'string' ? content : collectUserText(content);
  const stripped = stripWrappers(rawText);
  const norm = normalizeWhitespace(stripped);
  // A slash-command turn (`<command-name>/x</command-name> … <command-args>…`) is
  // ALL wrappers, so it is empty after stripping. Classify it (command_args) BEFORE
  // the empty-after-strip guard below — otherwise that guard preempts this branch and
  // the `command_args` source-kind is dead for its only real input (wp2b §7 #13).
  if (hasCommandName(content)) {
    const args = commandArgsFrom(typeof content === 'string' ? content : collectUserText(content));
    const text = normalizeWhitespace(args ?? norm); // /clear etc. carry empty <command-args>
    if (text === '') return { accept: false };      // nothing to snippet (empty args, no residual prose)
    return { accept: true, text, source: 'command_args' };
  }
  if (norm === '') return { accept: false };
  // dashboard telemetry is not a query — check AFTER stripping wrappers
  const lines = norm.split('\n').map((l) => l.trim()).filter((l) => l.length);
  if (lines.length && lines.every((l) => l.startsWith('[DASHBOARD EVENT]'))) return { accept: false };
  if (ctx.isSubagent && pe.isFirstSubstantiveUser) return { accept: true, text: norm, source: 'subagent_brief' };
  if (ctx.lane === 'worker' && pe.isFirstSubstantiveUser) return { accept: true, text: norm, source: 'supervisor_brief' };
  return { accept: true, text: norm, source: 'user_message' };
}

/**
 * True when a user entry is a substantive natural-language turn (not meta, not a
 * pure tool_result turn, non-empty after wrapper-strip, not [DASHBOARD EVENT]-only).
 * parse-runner tags the stream's FIRST substantive user turn with this so the brief
 * source-kinds (supervisor_brief / subagent_brief) resolve in the walk-back (§3.2).
 * Mirrors qualifyUserEntry's accept/skip gate minus the source classification.
 */
export function isSubstantiveUserEntry(entry: RawEntry): boolean {
  if (entry.type !== 'user') return false;
  if (entry.isMeta === true) return false;
  const content = entry.message?.content;
  if (isPureToolResult(content)) return false;
  const rawText = typeof content === 'string' ? content : collectUserText(content);
  const norm = normalizeWhitespace(stripWrappers(rawText));
  if (norm === '') return false;
  const lines = norm.split('\n').map((l) => l.trim()).filter((l) => l.length);
  if (lines.length && lines.every((l) => l.startsWith('[DASHBOARD EVENT]'))) return false;
  return true;
}

/**
 * A9 §3.2 — select the qualifying trigger snippet for an event by walking BACKWARDS
 * over already-parsed user entries of the same stream (most-recent first), capped
 * at TRIGGER_LOOKBACK_ENTRIES. Always returns a result (row is always written).
 */
export function selectTriggerSnippet(priorUserEntries: PriorUserEntry[], ctx: StreamCtx): TriggerSnippetResult {
  const window = priorUserEntries.slice(-TRIGGER_LOOKBACK_ENTRIES);
  for (let d = 0; d < window.length; d++) {
    const pe = window[window.length - 1 - d]; // most-recent first
    const q = qualifyUserEntry(pe, ctx);
    if (q.accept) {
      const full = normalizeSnippetText(q.text);
      const snippet = full.length > TRIGGER_SNIPPET_MAX_CHARS ? full.slice(0, TRIGGER_SNIPPET_MAX_CHARS) + '…' : full;
      return {
        snippet,
        snippetHash: sha256(full),
        sourceKind: q.source,
        sourceEntryUuid: pe.entryUuid,
        sourceByteOffset: pe.byteOffset,
        distanceEntries: d,
        selectionReason: 'matched',
        srcTsMs: pe.tsMs,
      };
    }
  }
  return {
    snippet: null, snippetHash: null, sourceKind: 'none',
    sourceEntryUuid: null, sourceByteOffset: null, distanceEntries: null,
    selectionReason: 'no_qualifying_user_message', srcTsMs: null,
  };
}
