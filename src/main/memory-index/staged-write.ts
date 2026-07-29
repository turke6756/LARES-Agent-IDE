// staged-write.ts — the transactional multi-copy writer behind dynamic memory
// publication (Memory & Lessons v2 WP-F1). A lesson (and, in WP-F2, a whole
// batch) is written to SEVERAL provider skill roots at once; if any copy fails
// to land, the whole set must unwind so the workspace never keeps a partial,
// half-provisioned skill.
//
// The primitive is `stagedMultiWrite(targets, pathType, acquireLock)`:
//   1. acquire the workspace lock (publication SHARES the scaffold lock, so it
//      serializes against a concurrent scaffold refresh — WP-F1 §Lock),
//   2. STAGE every copy to `<target>.tmp` (write, no rename) AND capture each
//      target's prior on-disk state (existed? prior bytes?) for rollback,
//      NEVER overwriting a target that already holds DIFFERING content
//      (a differing target is a conflict — reported, never clobbered),
//   3. RENAME every staged tmp over its final target,
//   4. on ANY rename failure, RESTORE every already-renamed target (prior bytes
//      if it pre-existed, else delete the freshly-created file) and delete every
//      leftover tmp — then rethrow.
//
// It composes the scaffold-writer primitives (WP-F1 additions
// `stageTextFile`/`commitStagedRename` + the existing `acquireWorkspaceLock`,
// `readScaffoldText`, `scaffoldFileExists`, `deleteScaffoldFile`,
// `atomicWriteScaffoldText`) and never re-implements the WSL-aware IO or the
// mkdir-atomic lock.

import {
  stageTextFile,
  commitStagedRename,
  readScaffoldText,
  scaffoldFileExists,
  deleteScaffoldFile,
  atomicWriteScaffoldText,
} from '../scaffold-writer';

/** One copy to write. `relPath` is workspace-relative (e.g.
 *  `.lares/supervisor/.claude/skills/foo/SKILL.md`). All targets in a call share
 *  one `workDir`/workspace + lock. */
export interface StageTarget {
  workDir: string;
  relPath: string;
  content: string;
  executable?: boolean;
}

/** Rollback receipt for one target — the durable record of what publication did
 *  to it, so a later unwind (or WP-F2 batch rollback) knows whether to delete a
 *  freshly-created file or restore prior bytes. */
export interface StageReceipt {
  relPath: string;
  /** the target already existed on disk before this write. */
  preexisted: boolean;
  /** prior on-disk bytes (null if absent or unreadable) — restored on rollback. */
  priorContent: string | null;
  /** true iff this target was successfully renamed into place this call. */
  committed: boolean;
}

export interface StagedWriteResult {
  receipts: StageReceipt[];
}

/** Thrown when a target already holds content DIFFERING from the intended bytes.
 *  Publication NEVER overwrites a differing target (conflict protection is
 *  independent of whether the target pre-existed); the caller maps this to a
 *  `conflict` state rather than clobbering a foreign edit. */
export class StagedWriteConflictError extends Error {
  constructor(public readonly relPath: string) {
    super(`staged write conflict: ${relPath} already holds differing content`);
    this.name = 'StagedWriteConflictError';
  }
}

const tmpRelOf = (relPath: string): string => `${relPath}.tmp`;

/**
 * Transactionally write every target under one workspace lock. Returns the
 * per-target rollback receipts on success. On a conflict (a target holds
 * differing content) or any rename failure, unwinds every already-committed
 * target and every staged tmp, then throws (StagedWriteConflictError for a
 * conflict; the original error otherwise). `acquireLock` returns a release fn —
 * pass an acquirer bound to `acquireWorkspaceLock(workDir, pathType)` so
 * publication shares the scaffold lock.
 */
export function stagedMultiWrite(
  targets: StageTarget[],
  pathType: string,
  acquireLock: () => () => void,
): StagedWriteResult {
  const release = acquireLock();
  const receipts: StageReceipt[] = [];
  const staged: StageTarget[] = [];
  try {
    // ── Phase 1: capture prior state + stage every tmp (no final mutation yet).
    // Conflict protection runs HERE, before any rename, so a differing target
    // aborts the whole set before anything is committed.
    for (const t of targets) {
      const preexisted = scaffoldFileExists(t.workDir, t.relPath, pathType);
      const priorContent = preexisted ? readScaffoldText(t.workDir, t.relPath, pathType) : null;
      if (preexisted && priorContent !== null && priorContent !== t.content) {
        throw new StagedWriteConflictError(t.relPath);
      }
      receipts.push({ relPath: t.relPath, preexisted, priorContent, committed: false });
      stageTextFile(t.workDir, tmpRelOf(t.relPath), t.content, !!t.executable, pathType);
      staged.push(t);
    }

    // ── Phase 2: rename every staged tmp over its final target. On the first
    // failure, restore the targets already renamed this loop, then rethrow.
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try {
        commitStagedRename(t.workDir, tmpRelOf(t.relPath), t.relPath, pathType);
        receipts[i].committed = true;
      } catch (err) {
        restoreCommitted(targets, receipts, pathType);
        throw err;
      }
    }

    return { receipts };
  } catch (err) {
    // Conflict (or any Phase-1 failure) reaches here with nothing committed;
    // Phase-2 failures already restored. Either way, drop leftover tmps below.
    if (err instanceof StagedWriteConflictError) restoreCommitted(targets, receipts, pathType);
    throw err;
  } finally {
    // Delete every staged tmp (a committed one was renamed away → no-op).
    for (const t of staged) {
      try { deleteScaffoldFile(t.workDir, tmpRelOf(t.relPath), pathType); } catch { /* best-effort */ }
    }
    release();
  }
}

/** Restore every target flagged `committed`: rewrite prior bytes if it
 *  pre-existed, else delete the freshly-created file (removing its now-empty
 *  skill dir). Clears the `committed` flag as it goes so a double-call is safe. */
function restoreCommitted(targets: StageTarget[], receipts: StageReceipt[], pathType: string): void {
  for (let i = 0; i < targets.length; i++) {
    const r = receipts[i];
    if (!r || !r.committed) continue;
    const t = targets[i];
    try {
      if (r.preexisted && r.priorContent !== null) {
        atomicWriteScaffoldText(t.workDir, t.relPath, r.priorContent, !!t.executable, pathType);
      } else {
        deleteScaffoldFile(t.workDir, t.relPath, pathType);
      }
    } catch { /* best-effort restore */ }
    r.committed = false;
  }
}
