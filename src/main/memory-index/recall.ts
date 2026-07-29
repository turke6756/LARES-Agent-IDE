// recall.ts — the on-demand memory-detail fetch behind the `recall_memory` MCP
// tool + POST /api/memory/recall route (WP-D). Progressive disclosure: an ACTIVE
// capsule lives inline in the injected index, so recall only ever fetches CLOSED
// history/evidence — the capsule's DECLARED `detail:` pointer, resolved from the
// parsed index, never a synthesized `<id>.md`.
//
// It composes the landed pieces and never re-implements them:
//   • memory-index-core.ts (WP-A1) — parseIndex, isValidMemoryId,
//     safeUtf8Truncate, utf8ByteLength, RECALL_DETAIL_MAX_BYTES, MEMORY_DETAILS_DIR.
//   • review-store.ts (WP-B)       — bumpRecall (recall telemetry; fires ONLY on
//                                     a successful ok:true fetch).
//
// Security contract (plans/memory-lessons-v2-implementation.md §WP-D):
//   1. Validate `id` against MEMORY_ID_GRAMMAR BEFORE touching disk (a traversal /
//      `..` / separator id fails the grammar → invalid_id, no disk read, no bump).
//   2. Take the entry's declared `detail:` pointer + `status` from the PARSED
//      capsule. An absent pointer, a pointer whose file is missing, or one whose
//      realpath resolves OUTSIDE the exact MEMORY_DETAILS_DIR → not_found (never a
//      disk-content leak, never a bump). Realpath-bound before any read.
//   3. UTF-8-safe-truncate the BODY ONLY to RECALL_DETAIL_MAX_BYTES (the cap
//      excludes the JSON envelope/metadata; `truncated:true` when clipped).
//   4. Structured result codes (invalid_id / not_found / read_error) — NEVER a
//      throw. `archived` capsules are served with `{ ok:true, archived:true }`.
//   5. `bumpRecall` fires ONLY on `ok:true` (recallMemoryDetailWithTelemetry).
//
// Workspace isolation is structural: the caller (the route) resolves
// `workspaceRoot` SOLELY from the authenticated X-Workspace-Id header, so two
// workspaces holding the same memory id read from disjoint trees and increment
// disjoint per-workspace counters.

import * as fs from 'fs';
import * as path from 'path';
import {
  parseIndex,
  isValidMemoryId,
  safeUtf8Truncate,
  utf8ByteLength,
  RECALL_DETAIL_MAX_BYTES,
  MEMORY_DETAILS_DIR,
} from '../../shared/memory-index-core';
import { bumpRecall } from './review-store';

export type RecallErrorCode = 'invalid_id' | 'not_found' | 'read_error';

export interface RecallOk {
  ok: true;
  id: string;
  /** the capsule's `status:` value from the parsed index. */
  status: string;
  /** true iff `status === 'archived'` (served, but flagged for the reader). */
  archived: boolean;
  /** the detail-file body, UTF-8-safe-truncated to RECALL_DETAIL_MAX_BYTES. */
  body: string;
  /** true iff the on-disk body exceeded the cap and was clipped. */
  truncated: boolean;
  /** UTF-8 byte length of the (possibly truncated) `body`. */
  bytes: number;
}

export interface RecallErr {
  ok: false;
  code: RecallErrorCode;
}

export type RecallResult = RecallOk | RecallErr;

/** Realpath `p`, or null if it does not exist / cannot be resolved. Mirrors the
 *  io.ts helper (the recall path deliberately keeps a small local copy rather
 *  than importing across the pure/io seam). */
function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** True iff absolute `target` lies STRICTLY beneath absolute `dir`. Both inputs
 *  must already be realpath-resolved so a symlink escape is caught before this
 *  lexical check runs. */
function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The supervisor cwd / details dir / index path for a workspace root, derived
 *  from the ratified MEMORY_DETAILS_DIR constant (one source of the layout). */
function memoryDirs(workspaceRoot: string): { supervisorDir: string; detailsDir: string; memoryMd: string } {
  const detailsDir = path.join(workspaceRoot, ...MEMORY_DETAILS_DIR.split('/').filter(Boolean));
  const supervisorDir = path.resolve(detailsDir, '..', '..');
  const memoryMd = path.join(supervisorDir, 'memory', 'MEMORY.md');
  return { supervisorDir, detailsDir, memoryMd };
}

/**
 * Resolve + read a memory detail for `id` under `workspaceRoot`. PURE of the DB
 * (no telemetry) so it is unit-testable without a database handle; the route
 * wraps it with the recall-count increment. Never throws — every failure path
 * returns a structured `{ ok:false, code }`.
 */
export function recallMemoryDetail(workspaceRoot: string, id: unknown): RecallResult {
  // (1) Grammar BEFORE disk. A non-string, or a traversal/`..`/separator id, is
  // rejected here with no filesystem access whatsoever.
  if (typeof id !== 'string' || !isValidMemoryId(id)) {
    return { ok: false, code: 'invalid_id' };
  }

  const { supervisorDir, detailsDir, memoryMd } = memoryDirs(workspaceRoot);

  // Read + parse the index. A missing/unreadable index means the entry cannot be
  // located → not_found (there is nothing to recall).
  let indexText: string;
  try {
    indexText = fs.readFileSync(memoryMd, 'utf8');
  } catch {
    return { ok: false, code: 'not_found' };
  }
  const parsed = parseIndex(indexText);
  const entry = parsed.entries.find((e) => e.id === id);
  if (!entry) return { ok: false, code: 'not_found' };

  // (2) DECLARED pointer from the parsed capsule — never a synthesized <id>.md.
  const pointer = entry.detail;
  if (!pointer) return { ok: false, code: 'not_found' };

  const candidate = path.resolve(supervisorDir, pointer);
  const real = tryRealpath(candidate);
  if (real === null) return { ok: false, code: 'not_found' }; // missing detail file

  // Realpath-bound: must land STRICTLY beneath the exact details dir. A symlink
  // escape, a `..` traversal in the pointer, or a location merely under memory/
  // but outside details/ all resolve outside → refuse (never leak content).
  const canonicalDetailsDir = tryRealpath(detailsDir);
  if (canonicalDetailsDir === null || !isInsideDir(real, canonicalDetailsDir)) {
    return { ok: false, code: 'not_found' };
  }

  // (3) Read + UTF-8-safe-truncate the BODY ONLY. A genuine read failure at this
  // point (permissions, mid-read IO error) is a read_error, distinct from a
  // missing file.
  let rawBody: string;
  try {
    rawBody = fs.readFileSync(real, 'utf8');
  } catch {
    return { ok: false, code: 'read_error' };
  }

  const truncated = utf8ByteLength(rawBody) > RECALL_DETAIL_MAX_BYTES;
  const body = truncated ? safeUtf8Truncate(rawBody, RECALL_DETAIL_MAX_BYTES) : rawBody;

  return {
    ok: true,
    id,
    status: entry.status,
    archived: entry.status === 'archived',
    body,
    truncated,
    bytes: utf8ByteLength(body),
  };
}

/**
 * The route-level entry point: resolve + read the detail, and on a SUCCESSFUL
 * fetch (`ok:true`, including archived) atomically increment the per-workspace
 * recall count. `bumpRecall` fires ONLY on ok:true — an invalid_id / not_found /
 * read_error never touches telemetry. `ws` is the opaque workspaces.id PK
 * (authenticated X-Workspace-Id); `workspaceRoot` is that workspace's on-disk
 * root, so the read and the increment are both workspace-scoped.
 */
export function recallMemoryDetailWithTelemetry(
  ws: string,
  workspaceRoot: string,
  id: unknown,
  nowISO: string,
): RecallResult {
  const result = recallMemoryDetail(workspaceRoot, id);
  if (result.ok) {
    bumpRecall(ws, result.id, nowISO);
  }
  return result;
}
