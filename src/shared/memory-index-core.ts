// Memory-index v2 — the ONE canonical pure-logic implementation (WP-A1).
//
// PURE: no `fs`, no `realpath`, no Node-only I/O. This same TypeScript source is
//   (a) imported in-process by main (compiled to CommonJS in dist/main), and
//   (b) esbuild-bundled — verbatim, via scripts/memory-index-cli-entry.ts — into
//       the scaffolded .lares/scripts/memory-index.mjs (one source of logic).
// The I/O-only findings (nonexistent detail file, escaping realpath,
// orphan-details) are WP-A2's io.ts adapter, NOT here. A test grep-asserts this
// file imports no `fs`/`realpath`.
//
// Byte/line helpers use TextEncoder/TextDecoder (portable to both Node and the
// renderer bundle) rather than Buffer, so pulling this module into a renderer
// graph never drags in a Node-only global.

// ── Ratified constants (source of truth; re-exported by WP-B/WP-C/WP-D/WP-G) ──
export const MEMORY_INDEX_BUDGET_BYTES = 25000;
export const MEMORY_INDEX_BUDGET_LINES = 200;
export const STALE_ACTIVE_DAYS = 14;
export const NEVER_RECALLED_MIN_AGE_DAYS = 21;
export const CAP_PRESSURE_RATIO = 0.8;
export const RECALL_DETAIL_MAX_BYTES = 16384;
export const DISCLOSURE_FORMAT_MARKER = '<!-- disclosure-format: v2 -->';
export const MEMORY_ID_GRAMMAR = /^mb-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
export const LESSON_SLUG_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MEMORY_DETAILS_DIR = '.lares/supervisor/memory/details/';

/** Allowed `status:` values. */
export const MEMORY_STATUSES = ['active', 'done', 'note', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

// ── Finding severity ─────────────────────────────────────────────────────────
export type FindingSeverity = 'hard' | 'advisory';

/** A single validation finding. `id` is null for whole-index findings
 *  (legacy-format, budgets, a bare `@scope/pkg` in free prose). */
export interface Finding {
  cls: string;
  severity: FindingSeverity;
  id: string | null;
  message: string;
}

// ── Parsed shapes ─────────────────────────────────────────────────────────────
export interface ParsedEntry {
  id: string;
  title: string;
  status: string;
  date: string | null;
  owner: string | null;
  consequence: string | null;
  state: string | null;
  openLoop: string | null;
  expires: string | null;
  expiresWhen: string | null;
  readIf: string | null;
  detail: string | null;
  fields: Record<string, string>;
  /** exact [start,end) offsets of this capsule block within `normalized`. */
  blockStart: number;
  blockEnd: number;
  /** id fails MEMORY_ID_GRAMMAR (heading present but the id token is malformed). */
  idMalformed: boolean;
}

export interface ParsedIndex {
  raw: string;
  normalized: string;
  byteLength: number;
  lineCount: number;
  hasMarker: boolean;
  /** a `disclosure-format:` marker exists but is not the v2 marker. */
  markerMismatch: boolean;
  preamble: string;
  handoffReadFirst: string[] | null;
  entries: ParsedEntry[];
  bareScopedPkgs: Array<{ token: string }>;
}

// ── Byte / line helpers (portable) ─────────────────────────────────────────────
const _enc = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8ByteLength(str: string): number {
  return _enc.encode(str).length;
}

/** Line count: normalize CRLF→LF, count LF + 1. Empty string → 1. */
export function countLines(text: string): number {
  const n = text.replace(/\r\n/g, '\n');
  let count = 1;
  for (let i = 0; i < n.length; i++) if (n.charCodeAt(i) === 10) count++;
  return count;
}

/** Truncate `str` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 *  multibyte sequence. Backs up over trailing continuation bytes (0b10xxxxxx). */
export function safeUtf8Truncate(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = _enc.encode(str);
  if (bytes.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder('utf-8').decode(bytes.slice(0, end));
}

/** True iff `id` matches the frozen memory-id grammar. */
export function isValidMemoryId(id: string): boolean {
  return MEMORY_ID_GRAMMAR.test(id);
}

// ── Bare `@scope/pkg` detection ─────────────────────────────────────────────────
//
// A bare `@scope/pkg` token in index PROSE parses as a Claude `@import`
// (verified upstream semantics). Rule: backtick every package/@ token. Detection
// strips fenced (```…```) blocks and inline `code` spans FIRST, then matches the
// npm-scoped-package grammar so a backticked or fenced token is clean.
const _SCOPED_PKG_RE = /@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*/g;

/** Return the bare (un-backticked, un-fenced) `@scope/pkg` tokens in `text`. */
export function detectBareScopedPkg(text: string): string[] {
  // Strip fenced code blocks, then inline code spans. Order matters: fenced
  // first so a stray backtick inside a fence cannot mask a real prose token.
  const noFenced = text.replace(/```[\s\S]*?```/g, ' ');
  const noInline = noFenced.replace(/`[^`\n]*`/g, ' ');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  _SCOPED_PKG_RE.lastIndex = 0;
  while ((m = _SCOPED_PKG_RE.exec(noInline)) !== null) out.push(m[0]);
  return out;
}

// ── Parsing ─────────────────────────────────────────────────────────────────────
const _CAPSULE_HEADING = /^##\s+(mb-\S+?):\s*(.*)$/;
const _FIELD_LINE = /^-\s+([a-z][a-z-]*):\s*(.*)$/;

/** Parse an index into a structural model. Never throws on content; a caller
 *  that catches an exception here maps it to a RUNTIME (exit 2) condition. */
export function parseIndex(text: string): ParsedIndex {
  const raw = text;
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  // Marker: present (exact v2) / mismatched (a different disclosure-format) / absent.
  let hasMarker = false;
  let markerMismatch = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === DISCLOSURE_FORMAT_MARKER) { hasMarker = true; break; }
    if (/^<!--\s*disclosure-format:/.test(t)) markerMismatch = true;
  }

  // Locate capsule headings by character offset so blocks can be sliced exactly.
  const headingOffsets: Array<{ offset: number; lineIdx: number }> = [];
  {
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      if (_CAPSULE_HEADING.test(lines[i])) headingOffsets.push({ offset, lineIdx: i });
      offset += lines[i].length + 1; // +1 for the split-out '\n'
    }
  }

  const firstCapsuleOffset = headingOffsets.length ? headingOffsets[0].offset : normalized.length;
  const preamble = normalized.slice(0, firstCapsuleOffset);

  // handoff-read-first: an ordered list under a `## handoff-read-first` heading
  // in the preamble.
  const handoffReadFirst = parseHandoff(preamble);

  const entries: ParsedEntry[] = [];
  for (let h = 0; h < headingOffsets.length; h++) {
    const blockStart = headingOffsets[h].offset;
    const blockEnd = h + 1 < headingOffsets.length ? headingOffsets[h + 1].offset : normalized.length;
    const block = normalized.slice(blockStart, blockEnd);
    const blockLines = block.split('\n');
    const hm = blockLines[0].match(_CAPSULE_HEADING)!;
    const id = hm[1];
    const title = hm[2].trim();

    const fields: Record<string, string> = {};
    for (let i = 1; i < blockLines.length; i++) {
      const fm = blockLines[i].match(_FIELD_LINE);
      if (fm) {
        const key = fm[1];
        if (!(key in fields)) fields[key] = fm[2].trim();
      }
    }

    entries.push({
      id,
      title,
      status: fields['status'] ?? '',
      date: fields['date'] ?? null,
      owner: fields['owner'] ?? null,
      consequence: fields['consequence'] ?? null,
      state: fields['state'] ?? null,
      openLoop: fields['open-loop'] ?? null,
      expires: fields['expires'] ?? null,
      expiresWhen: fields['expires-when'] ?? null,
      readIf: fields['read-if'] ?? null,
      detail: fields['detail'] ?? null,
      fields,
      blockStart,
      blockEnd,
      idMalformed: !isValidMemoryId(id),
    });
  }

  return {
    raw,
    normalized,
    byteLength: utf8ByteLength(raw),
    lineCount: countLines(raw),
    hasMarker,
    markerMismatch,
    preamble,
    handoffReadFirst,
    entries,
    bareScopedPkgs: detectBareScopedPkg(normalized).map((token) => ({ token })),
  };
}

/** Parse the `## handoff-read-first` ordered list from the preamble; null if
 *  no such section exists. */
function parseHandoff(preamble: string): string[] | null {
  const lines = preamble.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^##\s+handoff-read-first\s*$/.test(lines[i].trim() ? lines[i] : '')) break;
  }
  if (i >= lines.length) return null;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (/^##\s+/.test(line)) break; // next heading ends the section
    const m = line.match(/^\s*\d+\.\s+(\S+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// ── Validation (pure classes only) ───────────────────────────────────────────────
export interface ValidateResult {
  hard: Finding[];
  advisory: Finding[];
}

function hard(cls: string, id: string | null, message: string): Finding {
  return { cls, severity: 'hard', id, message };
}
function advisory(cls: string, id: string | null, message: string): Finding {
  return { cls, severity: 'advisory', id, message };
}

/** Pure validation: all HARD/ADVISORY classes computable without the filesystem.
 *  I/O classes (nonexistent detail, escaping realpath, orphan-details) are WP-A2. */
export function validateParsed(parsed: ParsedIndex): ValidateResult {
  const hardFindings: Finding[] = [];
  const advisoryFindings: Finding[] = [];

  // legacy-format: missing OR mismatched disclosure-format marker.
  if (!parsed.hasMarker) {
    hardFindings.push(
      hard(
        'legacy-format',
        null,
        parsed.markerMismatch
          ? `disclosure-format marker mismatched; expected ${DISCLOSURE_FORMAT_MARKER}`
          : `missing ${DISCLOSURE_FORMAT_MARKER}`,
      ),
    );
  }

  // Per-entry schema.
  const seen = new Set<string>();
  for (const e of parsed.entries) {
    if (e.idMalformed) {
      hardFindings.push(hard('malformed-schema', e.id, `malformed memory id: ${e.id}`));
    } else if (seen.has(e.id)) {
      hardFindings.push(hard('duplicate-id', e.id, `duplicate memory id: ${e.id}`));
    }
    seen.add(e.id);

    if (!MEMORY_STATUSES.includes(e.status as MemoryStatus)) {
      hardFindings.push(hard('malformed-schema', e.id, `invalid status "${e.status}" for ${e.id}`));
    }

    // Required-everywhere fields.
    for (const [key, val] of [
      ['consequence', e.consequence],
      ['state', e.state],
      ['read-if', e.readIf],
    ] as const) {
      if (!val) hardFindings.push(hard('missing-field', e.id, `missing required field "${key}" on ${e.id}`));
    }

    // Active entries MUST name a way to die: one of expires / expires-when / open-loop.
    if (e.status === 'active' && !e.expires && !e.expiresWhen && !e.openLoop) {
      hardFindings.push(
        hard('missing-field', e.id, `active entry ${e.id} names no exit (expires / expires-when / open-loop)`),
      );
    }

    // handoff-read-first ordering, if present, is validated at index level (below).
  }

  // handoff-read-first: max 5, each a valid + present memory id.
  if (parsed.handoffReadFirst) {
    const idSet = new Set(parsed.entries.map((e) => e.id));
    if (parsed.handoffReadFirst.length > 5) {
      hardFindings.push(hard('invalid-handoff', null, `handoff-read-first exceeds 5 entries`));
    }
    for (const hid of parsed.handoffReadFirst) {
      if (!isValidMemoryId(hid) || !idSet.has(hid)) {
        hardFindings.push(hard('invalid-handoff', hid, `handoff-read-first references unknown/invalid id: ${hid}`));
      }
    }
  }

  // Bare `@scope/pkg` in prose.
  for (const { token } of parsed.bareScopedPkgs) {
    hardFindings.push(hard('bare-scoped-pkg', null, `unbackticked package token in prose: ${token}`));
  }

  // Budgets.
  if (parsed.byteLength > MEMORY_INDEX_BUDGET_BYTES) {
    hardFindings.push(
      hard('byte-budget', null, `index is ${parsed.byteLength} bytes (budget ${MEMORY_INDEX_BUDGET_BYTES})`),
    );
  }
  if (parsed.lineCount > MEMORY_INDEX_BUDGET_LINES) {
    hardFindings.push(
      hard('line-budget', null, `index is ${parsed.lineCount} lines (budget ${MEMORY_INDEX_BUDGET_LINES})`),
    );
  }

  // cap-pressure (advisory): bytes OR lines over the ratio.
  if (
    parsed.byteLength / MEMORY_INDEX_BUDGET_BYTES > CAP_PRESSURE_RATIO ||
    parsed.lineCount / MEMORY_INDEX_BUDGET_LINES > CAP_PRESSURE_RATIO
  ) {
    advisoryFindings.push(
      advisory('cap-pressure', null, `index over ${Math.round(CAP_PRESSURE_RATIO * 100)}% of a budget`),
    );
  }

  return { hard: hardFindings, advisory: advisoryFindings };
}

// ── Projection ───────────────────────────────────────────────────────────────────
export interface ProjectionBudget {
  bytes: number;
  lines: number;
  byteBudget: number;
  lineBudget: number;
  byteRatio: number;
  lineRatio: number;
  overBudget: boolean;
}

export interface ProjectionResult {
  injectText: string;
  dropped: string[];
  conditionReview: string[];
  staleActive: string[];
  budget: ProjectionBudget;
  hard: Finding[];
}

/** ISO date (YYYY-MM-DD) → epoch-day count; NaN if unparseable. */
function epochDay(dateStr: string): number {
  const ms = Date.parse(dateStr + 'T00:00:00Z');
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 86400000);
}

/** Project a parsed index to the injectable text + lifecycle findings.
 *  Deterministic: identical (input, nowISO) → byte-identical output. Never
 *  mutates its input, never touches the filesystem. */
export function projectParsed(parsed: ParsedIndex, opts: { nowISO: string }): ProjectionResult {
  const { hard: hardFindings } = validateParsed(parsed);
  const today = opts.nowISO.slice(0, 10);
  const todayDay = epochDay(today);

  const dropped: string[] = [];
  const conditionReview: string[] = [];
  const staleActive: string[] = [];
  const dropRanges: Array<[number, number]> = [];

  for (const e of parsed.entries) {
    if (e.status !== 'active') continue;

    // Projection transform: a literal PAST `expires:` date drops from injectText.
    if (e.expires) {
      const ed = epochDay(e.expires);
      if (!Number.isNaN(ed) && !Number.isNaN(todayDay) && ed < todayDay) {
        dropped.push(e.id);
        dropRanges.push([e.blockStart, e.blockEnd]);
        continue; // dropped entries do not also count as stale/condition-review
      }
    }

    // `expires-when` stays in injectText; surfaced only in conditionReview.
    if (e.expiresWhen) conditionReview.push(e.id);

    // stale-active stays in injectText; age from the capsule `date`.
    if (e.date) {
      const dd = epochDay(e.date);
      if (!Number.isNaN(dd) && !Number.isNaN(todayDay) && todayDay - dd > STALE_ACTIVE_DAYS) {
        staleActive.push(e.id);
      }
    }
  }

  // injectText: never inject a HARD-invalid index. Otherwise splice out the
  // dropped capsule blocks (exact-byte preservation of everything kept).
  let injectText = '';
  if (hardFindings.length === 0) {
    if (dropRanges.length === 0) {
      injectText = parsed.normalized;
    } else {
      dropRanges.sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      const parts: string[] = [];
      for (const [start, end] of dropRanges) {
        parts.push(parsed.normalized.slice(cursor, start));
        cursor = end;
      }
      parts.push(parsed.normalized.slice(cursor));
      injectText = parts.join('');
    }
  }

  const budget: ProjectionBudget = {
    bytes: parsed.byteLength,
    lines: parsed.lineCount,
    byteBudget: MEMORY_INDEX_BUDGET_BYTES,
    lineBudget: MEMORY_INDEX_BUDGET_LINES,
    byteRatio: parsed.byteLength / MEMORY_INDEX_BUDGET_BYTES,
    lineRatio: parsed.lineCount / MEMORY_INDEX_BUDGET_LINES,
    overBudget: parsed.byteLength > MEMORY_INDEX_BUDGET_BYTES || parsed.lineCount > MEMORY_INDEX_BUDGET_LINES,
  };

  return { injectText, dropped, conditionReview, staleActive, budget, hard: hardFindings };
}
