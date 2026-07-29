// publisher.ts — the transactional `publish_lesson` state machine + its
// launch-time crash recovery (Memory & Lessons v2 WP-F1). A published lesson is
// the agent-facing write path: the `remember` skill's lesson branch calls
// `publish_lesson`, which provisions the lesson's `SKILL.md` to EVERY
// lane/provider skill root (skill-provisioning.ts) through the transactional
// multi-copy writer (staged-write.ts), keeping a durable `memory_lessons` row as
// the crash-recovery record.
//
// Published lessons are DELIBERATELY NOT entered into the managed scaffold
// version sidecar — they are dynamic/user content, and the sidecar's
// upgrade/.bak lifecycle would fight them. The `memory_lessons` DB registry is
// their sole record (single enumeration source; enables cross-provider drift
// repair).
//
// State machine (WP-F1 §publish_lesson):
//   1. Validate `name` against LESSON_SLUG_GRAMMAR BEFORE any path construction;
//      reject collision with `remember` / any shipped skill / a DIFFERING
//      existing lesson.
//   2. Insert the `memory_lessons` row status='pending' with canonical_hash,
//      intended copies, and which copies pre-existed — BEFORE any filesystem
//      write. If this insert fails, no filesystem write occurs.
//   3. Stage every copy to `<target>.tmp`, then rename each to its target
//      (staged-write.ts, under the shared scaffold lock).
//   4. Transition the row to 'active'.
//
// Conflict protection is INDEPENDENT of `preexisted`: publication NEVER
// overwrites a target whose current on-disk content differs from the intended
// body — always a conflict — regardless of whether that target pre-existed
// (`preexisted` governs rollback only: delete a newly-created target vs restore a
// prior one).

import crypto from 'crypto';
import { LESSON_SLUG_GRAMMAR } from '../../shared/memory-index-core';
import {
  acquireWorkspaceLock,
  readScaffoldText,
  scaffoldFileExists,
  deleteScaffoldFile,
  atomicWriteScaffoldText,
} from '../scaffold-writer';
import { registerLesson, setLessonStatus, listLessons } from './review-store';
import { stagedMultiWrite, StagedWriteConflictError, type StageTarget } from './staged-write';
import {
  lessonTargetRelPaths,
  isReservedSkillName,
  buildLessonSkillContent,
} from './skill-provisioning';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface PublishLessonInput {
  name: string;
  description: string;
  body: string;
}

export type PublishErrorCode =
  | 'invalid_name'
  | 'reserved_name'
  | 'invalid_body'
  | 'collision'
  | 'conflict'
  | 'pending_insert_failed'
  | 'write_error';

export interface PublishOk {
  ok: true;
  lessonId: string;
  status: 'active';
  copies: string[];
}
export interface PublishErr {
  ok: false;
  code: PublishErrorCode;
  message: string;
}
export type PublishResult = PublishOk | PublishErr;

/** Test-only crash-injection hooks (unused in production). `failPendingInsert`
 *  simulates the row insert failing so tests can assert the filesystem is left
 *  untouched. */
export interface PublishInjections {
  failPendingInsert?: boolean;
}

/**
 * Publish a lesson under `workDir` for workspace `ws`. `pathType` is the
 * workspace's write dialect ('windows' | 'wsl'). Never throws — every failure
 * path returns a structured `{ ok:false, code }`. Idempotent for an identical
 * re-publish (same name + same canonical content).
 */
export function publishLesson(
  ws: string,
  workDir: string,
  pathType: string,
  input: PublishLessonInput,
  nowISO: string,
  injections?: PublishInjections,
): PublishResult {
  // (1) Slug validation BEFORE any path construction.
  const name = input?.name;
  if (typeof name !== 'string' || !LESSON_SLUG_GRAMMAR.test(name)) {
    return { ok: false, code: 'invalid_name', message: `invalid lesson name: ${String(name)}` };
  }
  if (isReservedSkillName(name)) {
    return { ok: false, code: 'reserved_name', message: `"${name}" collides with a shipped skill` };
  }
  if (typeof input.description !== 'string' || typeof input.body !== 'string' || !input.body.trim()) {
    return { ok: false, code: 'invalid_body', message: 'description and a non-empty body are required' };
  }

  const content = buildLessonSkillContent(name, input.description, input.body);
  const canonicalHash = sha256Hex(content);
  const targets = lessonTargetRelPaths(name);

  // Collision with a DIFFERING existing lesson of the same name (same hash → an
  // idempotent re-publish, allowed to proceed).
  const existing = listLessons(ws).find((l) => l.lessonId === name);
  if (existing && existing.canonicalHash && existing.canonicalHash !== canonicalHash) {
    return { ok: false, code: 'collision', message: `lesson "${name}" already exists with different content` };
  }

  // Hold the shared scaffold lock across insert + write + activate so a
  // publication serializes against a concurrent scaffold refresh and against
  // another publication of the same slug.
  const release = acquireWorkspaceLock(workDir, pathType);
  try {
    // Which intended copies already exist on disk (rollback bookkeeping).
    const preexisted = targets.filter((rel) => scaffoldFileExists(workDir, rel, pathType));

    // (2) Durable pending row BEFORE any filesystem write. If this insert fails,
    // nothing is staged or renamed — the filesystem is left untouched.
    try {
      if (injections?.failPendingInsert) throw new Error('injected pending-insert failure');
      registerLesson(
        ws,
        { lessonId: name, name, canonicalHash, copies: targets, preexisted, status: 'pending', batchId: null },
        nowISO,
      );
    } catch (err) {
      return {
        ok: false,
        code: 'pending_insert_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // (3) Stage + rename every copy transactionally. The lock is already held, so
    // pass a no-op acquirer (the mkdir lock is not reentrant).
    const stageTargets: StageTarget[] = targets.map((rel) => ({ workDir, relPath: rel, content }));
    try {
      stagedMultiWrite(stageTargets, pathType, () => () => { /* lock already held */ });
    } catch (err) {
      if (err instanceof StagedWriteConflictError) {
        // A target holds differing content — never overwritten. Mark the row
        // conflict (durable, surfaces for review); the fs is already restored.
        setLessonStatus(ws, name, 'conflict');
        return { ok: false, code: 'conflict', message: err.message };
      }
      // Any other write failure: staged-write already unwound the filesystem;
      // leave the row pending so launch recovery can complete it forward.
      return {
        ok: false,
        code: 'write_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // (4) Activate.
    setLessonStatus(ws, name, 'active');
    return { ok: true, lessonId: name, status: 'active', copies: targets };
  } finally {
    release();
  }
}

// ── Launch recovery ────────────────────────────────────────────────────────────
export interface RecoveryResult {
  recovered: string[];
  conflicts: string[];
}

/** Find a hash-clean source for `canonicalHash` among a lesson's targets — a
 *  present final copy OR a leftover `<target>.tmp` (staged-but-uncommitted before
 *  a crash). Returns the content, or null if no on-disk source matches the hash. */
function candidateContent(
  workDir: string,
  targets: string[],
  pathType: string,
  canonicalHash: string,
): string | null {
  for (const rel of targets) {
    for (const p of [rel, `${rel}.tmp`]) {
      const c = readScaffoldText(workDir, p, pathType);
      if (c !== null && sha256Hex(c) === canonicalHash) return c;
    }
  }
  return null;
}

/** True iff any target holds a PRESENT final copy whose content differs from the
 *  intended canonical body — a conflict (never overwritten). */
function hasConflictingTarget(
  workDir: string,
  targets: string[],
  pathType: string,
  canonicalHash: string,
): boolean {
  for (const rel of targets) {
    const c = readScaffoldText(workDir, rel, pathType);
    if (c !== null && sha256Hex(c) !== canonicalHash) return true;
  }
  return false;
}

/**
 * Launch-time recovery for `memory_lessons` rows stuck in `pending` (a crash
 * between the pending insert and the activation flip). For each pending row:
 *   - if any target now holds DIFFERING content → mark `conflict` (never
 *     overwrite);
 *   - else if a hash-clean source exists on disk (a committed copy or a leftover
 *     `.tmp`), idempotently write every MISSING copy from it, delete leftover
 *     tmps, and flip the row to `active`;
 *   - else (no hash-clean source anywhere — a crash before any copy was staged)
 *     → mark `conflict` (cannot safely reconstruct the body).
 * A crash BEFORE the pending insert committed leaves no row and no fs state, so
 * there is nothing to recover. Idempotent + fail-open (a per-lesson failure never
 * aborts the sweep). Runs under the shared scaffold lock.
 */
export function recoverPendingLessons(
  ws: string,
  workDir: string,
  pathType: string,
  _nowISO: string,
): RecoveryResult {
  const out: RecoveryResult = { recovered: [], conflicts: [] };
  const pending = listLessons(ws, 'pending');
  if (!pending.length) return out;

  const release = acquireWorkspaceLock(workDir, pathType);
  try {
    for (const lesson of pending) {
      try {
        const targets = lesson.copies;
        const canonicalHash = lesson.canonicalHash;
        if (!canonicalHash || !targets.length) {
          setLessonStatus(ws, lesson.lessonId, 'conflict');
          out.conflicts.push(lesson.lessonId);
          continue;
        }
        if (hasConflictingTarget(workDir, targets, pathType, canonicalHash)) {
          setLessonStatus(ws, lesson.lessonId, 'conflict');
          out.conflicts.push(lesson.lessonId);
          continue;
        }
        const content = candidateContent(workDir, targets, pathType, canonicalHash);
        if (content === null) {
          setLessonStatus(ws, lesson.lessonId, 'conflict');
          out.conflicts.push(lesson.lessonId);
          continue;
        }
        for (const rel of targets) {
          if (readScaffoldText(workDir, rel, pathType) === null) {
            atomicWriteScaffoldText(workDir, rel, content, false, pathType);
          }
          try { deleteScaffoldFile(workDir, `${rel}.tmp`, pathType); } catch { /* best-effort */ }
        }
        setLessonStatus(ws, lesson.lessonId, 'active');
        out.recovered.push(lesson.lessonId);
      } catch (err) {
        console.error(`[memory-index] lesson recovery failed for ${lesson.lessonId}:`, err);
      }
    }
  } finally {
    release();
  }
  return out;
}
