// batch-publisher.ts — the durable batch-level `publish_lessons_batch` state
// machine + its launch-time crash recovery (Memory & Lessons v2 WP-F2). WP-I2's
// signed migration publishes ALL of the triaged-survivor lessons at once; a batch
// is ATOMIC — either every lesson across every provider skill root lands and the
// whole batch activates, or the whole batch unwinds. This reuses WP-F1's
// machinery wholesale (staged-write.ts multi-copy writer, skill-provisioning.ts
// roots/content, review-store.ts batch + lesson registries) and never
// re-implements the WSL-aware IO, the lock, or the single-lesson state machine.
//
// State machine (plans/memory-lessons-v2-implementation.md §WP-F2):
//   1. Insert the `memory_lesson_batches` row status='pending'.
//   2. Insert ALL lesson rows status='pending' under that batch_id (canonical_hash,
//      copies_json, preexisted_json) — BEFORE any filesystem mutation.
//   3. stageTextFile + rename every copy for every lesson (under the shared lock).
//   4. Flip all lesson rows AND the batch row to active in ONE SQLite transaction.
//
// On ANY in-flight failure (a conflict — a target holds differing content — or a
// write error) the WHOLE batch unwinds by hash-guarded logic: every already-
// committed copy is restored (prior bytes if it pre-existed, else deleted) and
// every `memory_lessons` row this batch created is removed, leaving the workspace
// exactly as it was before the batch. Conflict protection is INDEPENDENT of
// `preexisted` — a differing target is never overwritten.

import crypto from 'crypto';
import { LESSON_SLUG_GRAMMAR } from '../../shared/memory-index-core';
import {
  acquireWorkspaceLock,
  readScaffoldText,
  scaffoldFileExists,
  deleteScaffoldFile,
  atomicWriteScaffoldText,
} from '../scaffold-writer';
import {
  createLessonBatch,
  registerLesson,
  activateLessonBatch,
  listLessonsByBatch,
  listLessonBatches,
  removeBatchLessons,
  setLessonBatchStatus,
  type LessonRow,
} from './review-store';
import { stagedMultiWrite, StagedWriteConflictError, type StageReceipt, type StageTarget } from './staged-write';
import {
  lessonTargetRelPaths,
  isReservedSkillName,
  buildLessonSkillContent,
} from './skill-provisioning';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface BatchLessonInput {
  name: string;
  description: string;
  body: string;
}

export interface PublishBatchInput {
  /** The durable batch key (crash-recovery record). */
  batchId: string;
  /** The migration snapshot this batch belongs to (WP-I2), or null. */
  snapshotId?: string | null;
  lessons: BatchLessonInput[];
}

export type BatchErrorCode =
  | 'empty_batch'
  | 'invalid_name'
  | 'reserved_name'
  | 'invalid_body'
  | 'duplicate_name'
  | 'conflict'
  | 'pending_insert_failed'
  | 'write_error';

/** Per-lesson rollback receipt (the durable record of what the batch did to each
 *  target). `createdPaths` are the targets this batch freshly created (committed
 *  and not pre-existing) — the paths a rollback would delete. */
export interface LessonReceipt {
  lessonId: string;
  name: string;
  canonicalHash: string;
  targets: Array<{ relPath: string; preexisted: boolean; committed: boolean }>;
  createdPaths: string[];
}

export interface PublishBatchOk {
  ok: true;
  batchId: string;
  status: 'active';
  receipts: LessonReceipt[];
}
export interface PublishBatchErr {
  ok: false;
  code: BatchErrorCode;
  message: string;
  batchId: string;
  /** Receipts as of the failure (empty when the batch was rejected pre-write). */
  receipts: LessonReceipt[];
}
export type PublishBatchResult = PublishBatchOk | PublishBatchErr;

/** Test-only crash-injection hooks (unused in production). */
export interface BatchInjections {
  /** simulate the pending row inserts failing so tests can assert the filesystem
   *  is left untouched and the rows are removed. */
  failPendingInsert?: boolean;
}

interface PreparedLesson {
  name: string;
  content: string;
  canonicalHash: string;
  targets: string[];
}

/** Validate + render every lesson PURELY (no DB, no fs) so an invalid batch is
 *  rejected before anything is inserted or written. Returns the prepared lessons
 *  or a structured error. */
function prepareLessons(lessons: BatchLessonInput[]): { ok: true; prepared: PreparedLesson[] } | { ok: false; code: BatchErrorCode; message: string } {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return { ok: false, code: 'empty_batch', message: 'a batch must contain at least one lesson' };
  }
  const prepared: PreparedLesson[] = [];
  const seen = new Set<string>();
  for (const l of lessons) {
    const name = l?.name;
    if (typeof name !== 'string' || !LESSON_SLUG_GRAMMAR.test(name)) {
      return { ok: false, code: 'invalid_name', message: `invalid lesson name: ${String(name)}` };
    }
    if (isReservedSkillName(name)) {
      return { ok: false, code: 'reserved_name', message: `"${name}" collides with a shipped skill` };
    }
    if (typeof l.description !== 'string' || typeof l.body !== 'string' || !l.body.trim()) {
      return { ok: false, code: 'invalid_body', message: `lesson "${name}" needs a description and a non-empty body` };
    }
    if (seen.has(name)) {
      return { ok: false, code: 'duplicate_name', message: `lesson "${name}" appears more than once in the batch` };
    }
    seen.add(name);
    const content = buildLessonSkillContent(name, l.description, l.body);
    prepared.push({ name, content, canonicalHash: sha256Hex(content), targets: lessonTargetRelPaths(name) });
  }
  return { ok: true, prepared };
}

/** Restore a set of already-committed staged writes in reverse: rewrite prior
 *  bytes if the target pre-existed, else delete the freshly-created file. Mirrors
 *  staged-write's private `restoreCommitted` at BATCH scope (across lessons). */
function restoreBatch(
  workDir: string,
  pathType: string,
  committed: Array<{ relPath: string; receipt: StageReceipt }>,
): void {
  for (let i = committed.length - 1; i >= 0; i--) {
    const { relPath, receipt } = committed[i];
    try {
      if (receipt.preexisted && receipt.priorContent !== null) {
        atomicWriteScaffoldText(workDir, relPath, receipt.priorContent, false, pathType);
      } else {
        deleteScaffoldFile(workDir, relPath, pathType);
      }
    } catch { /* best-effort restore */ }
  }
}

function toReceipt(name: string, canonicalHash: string, stage: StageReceipt[]): LessonReceipt {
  return {
    lessonId: name,
    name,
    canonicalHash,
    targets: stage.map((r) => ({ relPath: r.relPath, preexisted: r.preexisted, committed: r.committed })),
    createdPaths: stage.filter((r) => r.committed && !r.preexisted).map((r) => r.relPath),
  };
}

/**
 * Publish an atomic batch of lessons under `workDir` for workspace `ws`. Never
 * throws — every failure path returns a structured `{ ok:false, code }`. Reuses
 * WP-F1's transactional multi-copy writer per lesson, all under ONE hold of the
 * shared scaffold lock, so the whole batch serializes against a scaffold refresh
 * and against a single-lesson publish.
 */
export function publishLessonsBatch(
  ws: string,
  workDir: string,
  pathType: string,
  input: PublishBatchInput,
  nowISO: string,
  injections?: BatchInjections,
): PublishBatchResult {
  const batchId = input?.batchId;
  if (typeof batchId !== 'string' || !batchId) {
    return { ok: false, code: 'pending_insert_failed', message: 'batchId is required', batchId: String(batchId), receipts: [] };
  }

  // (0) Validate + render every lesson before ANY durable state changes.
  const prep = prepareLessons(input.lessons);
  if (!prep.ok) return { ok: false, code: prep.code, message: prep.message, batchId, receipts: [] };
  const prepared = prep.prepared;

  // (1) The durable batch row (idempotent ON CONFLICT DO NOTHING).
  createLessonBatch(ws, batchId, input.snapshotId ?? null, nowISO);

  const release = acquireWorkspaceLock(workDir, pathType);
  try {
    // (2) Insert EVERY lesson row 'pending' BEFORE any filesystem write. If any
    // insert fails, remove the rows already inserted and leave the fs untouched.
    try {
      if (injections?.failPendingInsert) throw new Error('injected pending-insert failure');
      for (const p of prepared) {
        const preexisted = p.targets.filter((rel) => scaffoldFileExists(workDir, rel, pathType));
        registerLesson(
          ws,
          { lessonId: p.name, name: p.name, canonicalHash: p.canonicalHash, copies: p.targets, preexisted, status: 'pending', batchId },
          nowISO,
        );
      }
    } catch (err) {
      removeBatchLessons(batchId);
      setLessonBatchStatus(batchId, 'conflict');
      return { ok: false, code: 'pending_insert_failed', message: err instanceof Error ? err.message : String(err), batchId, receipts: [] };
    }

    // (3) Stage + rename every copy of every lesson. Accumulate committed staged
    // writes across ALL lessons so a mid-batch failure unwinds the WHOLE batch.
    const receipts: LessonReceipt[] = [];
    const committed: Array<{ relPath: string; receipt: StageReceipt }> = [];
    for (const p of prepared) {
      const stageTargets: StageTarget[] = p.targets.map((rel) => ({ workDir, relPath: rel, content: p.content }));
      try {
        // The lock is already held; pass a no-op acquirer (mkdir lock is not reentrant).
        const res = stagedMultiWrite(stageTargets, pathType, () => () => { /* lock held */ });
        receipts.push(toReceipt(p.name, p.canonicalHash, res.receipts));
        for (const r of res.receipts) if (r.committed) committed.push({ relPath: r.relPath, receipt: r });
      } catch (err) {
        // This lesson's own copies were already unwound by stagedMultiWrite; unwind
        // every EARLIER lesson that fully committed, then drop all batch rows.
        restoreBatch(workDir, pathType, committed);
        removeBatchLessons(batchId);
        setLessonBatchStatus(batchId, 'conflict');
        const code: BatchErrorCode = err instanceof StagedWriteConflictError ? 'conflict' : 'write_error';
        return { ok: false, code, message: err instanceof Error ? err.message : String(err), batchId, receipts };
      }
    }

    // (4) Flip all lesson rows AND the batch row to active in one transaction.
    activateLessonBatch(batchId);
    return { ok: true, batchId, status: 'active', receipts };
  } finally {
    release();
  }
}

// ── Launch recovery ────────────────────────────────────────────────────────────
export interface BatchRecoveryResult {
  recovered: string[];
  conflicts: string[];
}

/** A hash-clean on-disk source for a lesson's canonical body — a present final
 *  copy OR a leftover `<target>.tmp` (staged-but-uncommitted before a crash). */
function candidateContent(workDir: string, targets: string[], pathType: string, canonicalHash: string): string | null {
  for (const rel of targets) {
    for (const p of [rel, `${rel}.tmp`]) {
      const c = readScaffoldText(workDir, p, pathType);
      if (c !== null && sha256Hex(c) === canonicalHash) return c;
    }
  }
  return null;
}

/** True iff any target holds a PRESENT final copy whose content DIFFERS from the
 *  intended canonical body — a conflict (never overwritten). */
function hasConflictingTarget(workDir: string, targets: string[], pathType: string, canonicalHash: string): boolean {
  for (const rel of targets) {
    const c = readScaffoldText(workDir, rel, pathType);
    if (c !== null && sha256Hex(c) !== canonicalHash) return true;
  }
  return false;
}

/** Hash-guarded removal of a rolled-back batch's on-disk copies: delete each
 *  target the batch CREATED (present, hashes to canonical, NOT pre-existing) and
 *  drop every leftover tmp. A pre-existing target is left untouched (the batch
 *  never overwrote it — conflict protection guaranteed identical-or-abort). */
function removeBatchCopies(workDir: string, pathType: string, lessons: LessonRow[]): void {
  for (const l of lessons) {
    const canonicalHash = l.canonicalHash;
    const preexisted = new Set(l.preexisted);
    for (const rel of l.copies) {
      try { deleteScaffoldFile(workDir, `${rel}.tmp`, pathType); } catch { /* best-effort */ }
      if (preexisted.has(rel)) continue;
      const c = readScaffoldText(workDir, rel, pathType);
      if (c !== null && canonicalHash && sha256Hex(c) === canonicalHash) {
        try { deleteScaffoldFile(workDir, rel, pathType); } catch { /* best-effort */ }
      }
    }
  }
}

/**
 * Launch-time recovery for `memory_lesson_batches` rows stuck in `pending` (a
 * crash between the pending inserts and the single-transaction activation). For
 * each pending batch, the WHOLE batch moves together:
 *   - if EVERY target across every lesson is hash-clean (present-and-matching or
 *     reconstructable from a committed copy / leftover .tmp), write every MISSING
 *     copy idempotently, delete leftover tmps, and flip the batch + rows to active
 *     in one transaction (forward completion);
 *   - otherwise (any target holds DIFFERING content, or a lesson has no hash-clean
 *     source to reconstruct from) roll back the ENTIRE batch — hash-guarded
 *     removal of every created copy, then removal of all the batch's lesson rows,
 *     and mark the batch `conflict`.
 * Idempotent + fail-open (a per-batch failure never aborts the sweep). Runs under
 * the shared scaffold lock.
 */
export function recoverPendingBatches(
  ws: string,
  workDir: string,
  pathType: string,
  _nowISO: string,
): BatchRecoveryResult {
  const out: BatchRecoveryResult = { recovered: [], conflicts: [] };
  const pending = listLessonBatches(ws, 'pending');
  if (!pending.length) return out;

  const release = acquireWorkspaceLock(workDir, pathType);
  try {
    for (const batch of pending) {
      try {
        const lessons = listLessonsByBatch(batch.batchId);

        // Decide the whole-batch verdict first (atomic): any conflicting target,
        // any lesson missing both a hash + targets, or any lesson with no
        // reconstructable source → the batch rolls back.
        let rollback = lessons.length === 0;
        for (const l of lessons) {
          if (!l.canonicalHash || !l.copies.length) { rollback = true; break; }
          if (hasConflictingTarget(workDir, l.copies, pathType, l.canonicalHash)) { rollback = true; break; }
          if (candidateContent(workDir, l.copies, pathType, l.canonicalHash) === null) { rollback = true; break; }
        }

        if (rollback) {
          removeBatchCopies(workDir, pathType, lessons);
          removeBatchLessons(batch.batchId);
          setLessonBatchStatus(batch.batchId, 'conflict');
          out.conflicts.push(batch.batchId);
          continue;
        }

        // Forward-complete: write every missing copy from a hash-clean source,
        // delete leftover tmps.
        for (const l of lessons) {
          const content = candidateContent(workDir, l.copies, pathType, l.canonicalHash!)!;
          for (const rel of l.copies) {
            if (readScaffoldText(workDir, rel, pathType) === null) {
              atomicWriteScaffoldText(workDir, rel, content, false, pathType);
            }
            try { deleteScaffoldFile(workDir, `${rel}.tmp`, pathType); } catch { /* best-effort */ }
          }
        }
        activateLessonBatch(batch.batchId);
        out.recovered.push(batch.batchId);
      } catch (err) {
        console.error(`[memory-index] batch recovery failed for ${batch.batchId}:`, err);
      }
    }
  } finally {
    release();
  }
  return out;
}
