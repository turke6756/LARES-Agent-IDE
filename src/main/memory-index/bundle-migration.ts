// bundle-migration.ts — the supervisor-only, guarded memory-bundle migration
// operations WP-I2 drives (Memory & Lessons v2 WP-F2): `replace_memory_bundle`
// (swap the whole memory index + its detail set to a signed proposal) and
// `restore_memory_bundle` (roll the whole bundle back to the archived
// pre-migration state). Approve/apply IPC is WP-H3; these are the pure operations.
//
// The WP-I1 archive does not exist yet, so the archived pre-migration bundle is
// passed in as a SEAM — a `MigrationArchive { indexText, details }` value — rather
// than read from a WP-I1-specific on-disk format. This module invents nothing
// about that format beyond {the archived index text, the archived detail bodies
// keyed by basename} — exactly what the §WP-F2 restore/removal steps require.
//
// Guarantees (plans/memory-lessons-v2-implementation.md §WP-F2):
//   • replace_memory_bundle VALIDATES the proposed index against the PROPOSED
//     detail set (full pure + I/O via WP-A2's readValidateProject, run over a
//     throwaway temp mirror) and independently rejects ANY hard finding, ANY
//     escaping detail path, and orphan details — before any live mutation.
//   • Under the workspace lock, one bundle transaction: stage all details + the
//     index; hash-guarded removal of every live detail absent from the proposal
//     (removed ONLY if it hashes to a known archived body — a concurrently-written
//     detail is a CONFLICT, never clobbered); CAS-check `expected_prior_hash`;
//     rename the index LAST. On ANY failure, restore the index + every detail
//     (including removed obsolete ones) from the archive.
//   • restore_memory_bundle hash-guarded-restores the archived index + full prior
//     detail inventory; requires the approval + snapshot + `expected_live_hash`.
//
// Both require a recorded migration approval for (ws, snapshot_id) — the human
// sign-off gate. The route additionally binds the caller's workspace via
// X-Workspace-Id, so a bundle can only ever be written inside its own workspace.

import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MEMORY_DETAILS_DIR } from '../../shared/memory-index-core';
import { readValidateProject } from './io';
import {
  acquireWorkspaceLock,
  readScaffoldText,
  atomicWriteScaffoldText,
  deleteScaffoldFile,
  stageTextFile,
  commitStagedRename,
  listScaffoldDir,
} from '../scaffold-writer';
import { getMigrationApproval } from './review-store';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Workspace-relative locations, derived from the ONE ratified layout constant.
/** `.lares/supervisor/memory/details/` (trailing slash). */
const DETAILS_REL = MEMORY_DETAILS_DIR;
/** `.lares/supervisor/memory/MEMORY.md`. */
const INDEX_REL = MEMORY_DETAILS_DIR.replace(/details\/?$/, 'MEMORY.md');

/** The archived pre-migration bundle (WP-I1 seam). `details` is keyed by detail
 *  basename (e.g. `mb-2026-07-28-x.md`). */
export interface MigrationArchive {
  indexText: string;
  details: Record<string, string>;
}

/** One proposed detail file. `relPath` is workspace-relative and MUST live under
 *  `MEMORY_DETAILS_DIR` (validated). */
export interface ProposedDetail {
  relPath: string;
  content: string;
}

export interface ReplaceBundleInput {
  snapshotId: string;
  indexSource: string;
  detailFiles: ProposedDetail[];
  expectedPriorHash: string;
}

export interface RestoreBundleInput {
  snapshotId: string;
  expectedLiveHash: string;
}

export type BundleErrorCode =
  | 'no_approval'
  | 'invalid_detail_path'
  | 'hard_invalid'
  | 'cas_mismatch'
  | 'conflict'
  | 'write_error';

export interface BundleOk {
  ok: true;
  /** detail basenames removed as obsolete (hash-matched an archived body). */
  removed: string[];
  /** proposed detail relPaths written/renamed into place. */
  written: string[];
}
export interface BundleErr {
  ok: false;
  code: BundleErrorCode;
  message: string;
  /** the HARD findings when `code === 'hard_invalid'`. */
  findings?: Array<{ cls: string; id: string | null; message: string }>;
}
export type BundleResult = BundleOk | BundleErr;

const detailBasename = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1);

/** True iff `relPath` is a workspace-relative path STRICTLY beneath
 *  `MEMORY_DETAILS_DIR` with no traversal — the proposed-set containment gate. */
function isDetailPathContained(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (norm.includes('..')) return false;
  if (!norm.startsWith(DETAILS_REL)) return false;
  const tail = norm.slice(DETAILS_REL.length);
  // exactly one path segment beneath details/ (a bare `<id>.md`, no subdirs).
  return tail.length > 0 && !tail.includes('/');
}

/**
 * Validate a proposed index against a proposed detail set by materializing both
 * into a throwaway temp workspace mirror and running WP-A2's full
 * `readValidateProject` (pure `validateParsed` + I/O `validateIO` + projection)
 * over it — the SAME validation launch/recall use, never a re-implementation.
 * Returns the combined HARD findings ([] when clean). Never throws.
 */
export function validateProposedBundle(
  indexSource: string,
  detailFiles: ProposedDetail[],
  nowISO: string,
): Array<{ cls: string; id: string | null; message: string }> {
  let tmpRoot: string | null = null;
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-validate-'));
    const supervisorDir = path.join(tmpRoot, '.lares', 'supervisor', 'memory');
    fs.mkdirSync(path.join(supervisorDir, 'details'), { recursive: true });
    fs.writeFileSync(path.join(supervisorDir, 'MEMORY.md'), indexSource, 'utf8');
    for (const d of detailFiles) {
      // relPath is contained (caller checked); mirror it under the temp root.
      const dest = path.join(tmpRoot, ...d.relPath.replace(/\\/g, '/').split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, d.content, 'utf8');
    }
    const res = readValidateProject(tmpRoot, nowISO);
    return res.hard.map((f) => ({ cls: f.cls, id: f.id, message: f.message }));
  } catch (err) {
    // A read/mkdir failure is treated as a hard finding so the migration aborts
    // rather than proceeding on unvalidated content.
    return [{ cls: 'validation-error', id: null, message: err instanceof Error ? err.message : String(err) }];
  } finally {
    if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

/**
 * Restore the workspace's memory bundle to the archived pre-migration state:
 * rewrite the archived index + every archived detail body, and remove any live
 * detail whose basename is NOT in the archive (a migration-created detail). The
 * index is written LAST so a crash mid-restore never leaves a fresh index over
 * stale details. Runs under the caller's already-held lock (never acquires its
 * own — both entry points hold the workspace lock across the whole operation).
 */
function restoreArchive(workDir: string, pathType: string, archive: MigrationArchive): void {
  const archivedNames = new Set(Object.keys(archive.details));
  // Remove migration-created details (present live, absent from the archive).
  for (const name of listScaffoldDir(workDir, DETAILS_REL, pathType)) {
    if (!archivedNames.has(name)) {
      try { deleteScaffoldFile(workDir, `${DETAILS_REL}${name}`, pathType); } catch { /* best-effort */ }
    }
  }
  // Restore every archived detail body.
  for (const [name, body] of Object.entries(archive.details)) {
    atomicWriteScaffoldText(workDir, `${DETAILS_REL}${name}`, body, false, pathType);
  }
  // Index last.
  atomicWriteScaffoldText(workDir, INDEX_REL, archive.indexText, false, pathType);
}

/**
 * Replace the whole memory bundle with a signed proposal. Never throws — every
 * failure returns a structured `{ ok:false, code }`. `workDir` is the workspace
 * on-disk root; `pathType` its write dialect.
 */
export function replaceMemoryBundle(
  ws: string,
  workDir: string,
  pathType: string,
  input: ReplaceBundleInput,
  archive: MigrationArchive,
  nowISO: string,
): BundleResult {
  // (a) Approval gate — the human sign-off for this snapshot must be recorded.
  if (!getMigrationApproval(ws, input.snapshotId)) {
    return { ok: false, code: 'no_approval', message: `no recorded migration approval for snapshot ${input.snapshotId}` };
  }

  // (b) Every proposed detail path must be contained beneath MEMORY_DETAILS_DIR.
  for (const d of input.detailFiles) {
    if (!isDetailPathContained(d.relPath)) {
      return { ok: false, code: 'invalid_detail_path', message: `detail path escapes ${MEMORY_DETAILS_DIR}: ${d.relPath}` };
    }
  }

  // (c) Validate the proposed index AGAINST the proposed detail set (pure + I/O).
  // ANY hard finding (bad schema, budget overflow, dangling/escaping pointer,
  // orphan detail, …) rejects the whole bundle before any live mutation.
  const findings = validateProposedBundle(input.indexSource, input.detailFiles, nowISO);
  if (findings.length > 0) {
    return { ok: false, code: 'hard_invalid', message: `proposed bundle has ${findings.length} hard finding(s)`, findings };
  }

  const proposedNames = new Set(input.detailFiles.map((d) => detailBasename(d.relPath)));
  const archiveBodyHashes = new Set(Object.values(archive.details).map(sha256Hex));

  const release = acquireWorkspaceLock(workDir, pathType);
  const removed: string[] = [];
  try {
    // (d) CAS the live index against expected_prior_hash BEFORE any destructive
    // step (fail fast — nothing to restore on a clean early abort). The lock is
    // held, so no lock-respecting writer can change it before the final rename.
    const liveIndex = readScaffoldText(workDir, INDEX_REL, pathType) ?? '';
    if (sha256Hex(liveIndex) !== input.expectedPriorHash) {
      return { ok: false, code: 'cas_mismatch', message: 'live memory index has changed since the proposal (expected_prior_hash mismatch)' };
    }

    // (e) Stage every proposed detail + the new index (no final mutation yet).
    for (const d of input.detailFiles) stageTextFile(workDir, `${d.relPath}.tmp`, d.content, false, pathType);
    stageTextFile(workDir, `${INDEX_REL}.tmp`, input.indexSource, false, pathType);

    // (f) Hash-guarded removal of every live detail absent from the proposal.
    // A live obsolete detail is removed ONLY if it hashes to a known archived
    // body; anything else (a concurrently-written / unknown detail) is a CONFLICT
    // — never clobbered. This keeps post-migration details/ == exactly the signed
    // set, so nothing becomes an immediate orphan-details.
    const liveNames = listScaffoldDir(workDir, DETAILS_REL, pathType);
    for (const name of liveNames) {
      if (name.endsWith('.tmp')) continue; // our own staging artifact (renamed in step g)
      if (proposedNames.has(name)) continue; // carried forward (staged tmp will overwrite)
      const body = readScaffoldText(workDir, `${DETAILS_REL}${name}`, pathType);
      if (body !== null && archiveBodyHashes.has(sha256Hex(body))) {
        deleteScaffoldFile(workDir, `${DETAILS_REL}${name}`, pathType);
        removed.push(name);
      } else {
        // Unknown live detail — abort and restore the archived bundle.
        restoreArchive(workDir, pathType, archive);
        cleanupTmps(workDir, pathType, input);
        return { ok: false, code: 'conflict', message: `live detail ${name} is not a known archived body (concurrently written?); refusing to clobber` };
      }
    }

    // (g) Commit: rename every staged detail into place, then the index LAST.
    for (const d of input.detailFiles) commitStagedRename(workDir, `${d.relPath}.tmp`, d.relPath, pathType);
    commitStagedRename(workDir, `${INDEX_REL}.tmp`, INDEX_REL, pathType);

    return { ok: true, removed, written: input.detailFiles.map((d) => d.relPath) };
  } catch (err) {
    // Any failure (a stage/rename IO error, a removal error) → restore the whole
    // archived bundle (index + every detail, including removed obsolete ones).
    try { restoreArchive(workDir, pathType, archive); } catch { /* best-effort */ }
    cleanupTmps(workDir, pathType, input);
    return { ok: false, code: 'write_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    release();
  }
}

/** Drop any leftover staged tmp files (best-effort) after an abort/restore. */
function cleanupTmps(workDir: string, pathType: string, input: ReplaceBundleInput): void {
  for (const d of input.detailFiles) {
    try { deleteScaffoldFile(workDir, `${d.relPath}.tmp`, pathType); } catch { /* best-effort */ }
  }
  try { deleteScaffoldFile(workDir, `${INDEX_REL}.tmp`, pathType); } catch { /* best-effort */ }
}

/**
 * Restore the archived pre-migration bundle (index + full prior detail inventory)
 * under `workDir`. Requires the recorded approval for `snapshot_id` and a live
 * index whose hash matches `expected_live_hash` (CAS — the caller restores a
 * KNOWN post-migration state, never a moving target). Never throws.
 */
export function restoreMemoryBundle(
  ws: string,
  workDir: string,
  pathType: string,
  input: RestoreBundleInput,
  archive: MigrationArchive,
): BundleResult {
  if (!getMigrationApproval(ws, input.snapshotId)) {
    return { ok: false, code: 'no_approval', message: `no recorded migration approval for snapshot ${input.snapshotId}` };
  }

  const release = acquireWorkspaceLock(workDir, pathType);
  try {
    const liveIndex = readScaffoldText(workDir, INDEX_REL, pathType) ?? '';
    if (sha256Hex(liveIndex) !== input.expectedLiveHash) {
      return { ok: false, code: 'cas_mismatch', message: 'live memory index does not match expected_live_hash' };
    }
    const before = new Set(listScaffoldDir(workDir, DETAILS_REL, pathType));
    restoreArchive(workDir, pathType, archive);
    const removed = [...before].filter((n) => !(n in archive.details));
    return { ok: true, removed, written: Object.keys(archive.details).map((n) => `${DETAILS_REL}${n}`) };
  } catch (err) {
    return { ok: false, code: 'write_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    release();
  }
}
