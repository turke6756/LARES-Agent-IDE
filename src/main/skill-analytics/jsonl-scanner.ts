// P0.3 — historical `.jsonl` scanner + monotonic byte cursor.
//
// Two layers:
//   • PURE core (unit-tested under system node): stream-metadata derivation,
//     complete-line splitting (the partial-line cursor rule), first-line
//     fingerprint, and the rebuild-vs-additive-tail decision.
//   • THIN FS wrappers: resolve the projects dirs, recurse `**/*.jsonl`, read a
//     byte range. IO is confined here so the DB-free core stays testable.
//
// The window key is the normalized absolute `jsonl_path` (stream_id) — NEVER a
// cwd-derived slug (honors the shared-cwd / one-agent-per-cwd-is-false invariant).
// Reads are strictly read-only; nothing here writes into ~/.claude/projects.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveWindowsHomeSubdir, resolveWslHomeSubdir } from '../supervisor/log-readers/types';

// ─────────────────────────────────────────────────────────────────────────────
// Stream metadata (pure)
// ─────────────────────────────────────────────────────────────────────────────
export interface StreamMeta {
  streamId: string;              // normalized absolute jsonl_path — the window key
  jsonlPath: string;             // as given
  slug: string | null;           // first path segment under projects/
  sessionId: string | null;      // enclosing session-uuid dir, or filename stem (top-level)
  subAgentName: string | null;   // `agent-*` stem when under subagents/, else null
  parentSessionId: string | null;// session-uuid dir when a subagent file, else null
  isSubagent: boolean;
}

/** Deterministic, stable window key: uppercase a drive letter, backslash-separate.
 *  WSL UNC paths (`\\wsl.localhost\…`) are left structurally intact. */
export function normalizeStreamId(p: string): string {
  let s = p.replace(/\//g, '\\');
  s = s.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  return s;
}

function splitSegments(rel: string): string[] {
  return rel.split(/[\\/]/).filter(Boolean);
}

/**
 * Derive stream metadata from a `.jsonl` path and its enclosing projects dir.
 * Layouts:
 *   top-level:  projects/<slug>/<sessionUuid>.jsonl
 *   subagent:   projects/<slug>/<parentSessionUuid>/subagents/agent-*.jsonl
 */
export function deriveStreamMeta(jsonlPath: string, projectsDir: string): StreamMeta {
  const streamId = normalizeStreamId(jsonlPath);
  const rel = path.relative(projectsDir, jsonlPath);
  const segs = splitSegments(rel);
  const slug = segs.length ? segs[0] : null;
  const stem = path.basename(jsonlPath).replace(/\.jsonl$/i, '');

  const subIdx = segs.indexOf('subagents');
  if (subIdx >= 1) {
    const parentSessionId = segs[subIdx - 1] ?? null; // uuid dir directly above subagents/
    return {
      streamId,
      jsonlPath,
      slug,
      sessionId: parentSessionId, // subagent's enclosing session-uuid dir
      subAgentName: stem,          // `agent-*`
      parentSessionId,
      isSubagent: true,
    };
  }

  return {
    streamId,
    jsonlPath,
    slug,
    sessionId: stem,               // top-level: filename stem is the session uuid
    subAgentName: null,
    parentSessionId: null,
    isSubagent: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Complete-line splitting — the partial-line cursor rule (pure, byte-accurate)
// ─────────────────────────────────────────────────────────────────────────────
export interface ScannedLine {
  text: string;      // one JSONL line (trailing \r stripped), utf8-decoded
  byteOffset: number;// absolute byte offset of the line's first byte
}
export interface SplitResult {
  lines: ScannedLine[];
  nextOffset: number; // byte after the last complete `\n`; a trailing fragment is left unconsumed
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * Split a buffer read starting at `startByteOffset` into complete lines. Any
 * trailing bytes lacking a terminating `\n` are DISCARDED (re-read next pass once
 * the line completes) and `nextOffset` advances only to the byte after the last
 * complete `\n`. `\n` never occurs inside a multi-byte UTF-8 sequence, so byte
 * offsets are UTF-8-safe. Blank lines yield `text:''` and are the caller's to skip.
 */
export function splitCompleteLines(buf: Buffer, startByteOffset: number): SplitResult {
  const lines: ScannedLine[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF) {
      let end = i; // exclusive of \n
      if (end > lineStart && buf[end - 1] === CR) end -= 1; // CRLF safety
      const text = buf.subarray(lineStart, end).toString('utf8');
      lines.push({ text, byteOffset: startByteOffset + lineStart });
      lineStart = i + 1;
    }
  }
  return { lines, nextOffset: startByteOffset + lineStart };
}

/** Short fingerprint of a file's first (session-root) line — rotation discriminator. */
export function computeFingerprint(firstLine: string): string {
  return crypto.createHash('sha256').update(firstLine).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebuild-vs-additive decision (pure) — P0.3 reconciled triggers
// ─────────────────────────────────────────────────────────────────────────────
export interface CursorState {
  byteOffset: number;
  firstFingerprint: string;
  parserVersion: number;
}
export type RebuildReason = 'truncation' | 'fingerprint' | 'parser_version' | null;

/**
 * Decide whether `streamId` needs a controlled rebuild (delete rows, reset
 * byte_offset=0, re-parse) or a cheap additive tail. Never rebuild on mtime alone.
 */
export function rebuildDecision(
  cursor: CursorState,
  sizeBytes: number,
  currentFingerprint: string,
  currentParserVersion: number,
): RebuildReason {
  if (sizeBytes < cursor.byteOffset) return 'truncation';
  if (cursor.firstFingerprint && currentFingerprint && cursor.firstFingerprint !== currentFingerprint) {
    return 'fingerprint';
  }
  if (cursor.parserVersion !== currentParserVersion) return 'parser_version';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FS layer (thin; read-only)
// ─────────────────────────────────────────────────────────────────────────────

/** Both projects roots that exist (Windows host + WSL UNC). */
export function resolveProjectsDirs(): string[] {
  const dirs: string[] = [];
  const win = resolveWindowsHomeSubdir('.claude/projects');
  if (win) dirs.push(win);
  const wsl = resolveWslHomeSubdir('.claude/projects');
  if (wsl) dirs.push(wsl);
  return dirs;
}

/** Recurse a projects dir, returning stream metadata for every `*.jsonl`. */
export function listJsonlStreams(projectsDir: string): StreamMeta[] {
  const out: StreamMeta[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.jsonl')) {
        out.push(deriveStreamMeta(full, projectsDir));
      }
    }
  };
  walk(projectsDir);
  return out;
}

/** Read the first complete line of a file (for the fingerprint) without reading it whole. */
export function readFirstFingerprint(jsonlPath: string, probeBytes = 65536): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(probeBytes);
    const n = fs.readSync(fd, buf, 0, probeBytes, 0);
    const { lines } = splitCompleteLines(buf.subarray(0, n), 0);
    if (lines.length) return computeFingerprint(lines[0].text);
    // no newline within the probe — hash the raw prefix as a best-effort discriminator
    return computeFingerprint(buf.subarray(0, n).toString('utf8'));
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export interface TailRead {
  lines: ScannedLine[];
  nextOffset: number;
  sizeBytes: number;
  firstFingerprint: string;
}

/**
 * Read complete new lines from `[byteOffset, size)` of a file. Returns the parsed
 * complete lines, the advanced cursor (`nextOffset`), the current file size, and
 * the current first-line fingerprint. Read-only.
 */
export function readNewLines(jsonlPath: string, byteOffset: number): TailRead {
  const firstFingerprint = readFirstFingerprint(jsonlPath);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(jsonlPath).size;
  } catch {
    return { lines: [], nextOffset: byteOffset, sizeBytes: 0, firstFingerprint };
  }
  if (byteOffset >= sizeBytes) {
    return { lines: [], nextOffset: byteOffset, sizeBytes, firstFingerprint };
  }
  const length = sizeBytes - byteOffset;
  const buf = Buffer.alloc(length);
  let fd: number | null = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const n = fs.readSync(fd, buf, 0, length, byteOffset);
    const { lines, nextOffset } = splitCompleteLines(buf.subarray(0, n), byteOffset);
    return { lines, nextOffset, sizeBytes, firstFingerprint };
  } catch {
    return { lines: [], nextOffset: byteOffset, sizeBytes, firstFingerprint };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
