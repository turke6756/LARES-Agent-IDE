// Workspace state-dir resolution + one-time `.dashboard` → `.lares` migration.
//
// The workspace state folder was renamed from `.dashboard/` to `.lares/`
// (Lares rebrand). Existing workspaces are migrated by renaming the folder in
// place the first time the app touches the workspace. All LIVE path
// construction should go through this module (or LARES_DIR_NAME for plain
// name comparisons); code that CLASSIFIES paths from historical records (old
// session transcripts, analytics backfills) must keep recognizing BOTH names.
//
// Branches (per workspace, decided once per process and cached):
//   - `.lares/` exists, `.dashboard/` doesn't  → use `.lares` (already migrated).
//   - Neither exists                            → use `.lares` (fresh workspace).
//   - Only `.dashboard/` exists                 → fs.rename it to `.lares/`.
//       On Windows the rename can fail while files are locked (running PTYs,
//       watchers); in that case log a warning and continue this session on
//       `.dashboard` — never crash, never copy/merge.
//   - BOTH exist → prefer `.lares`, leave `.dashboard` untouched, warn. Never
//       delete or merge; the human decides what to salvage from the leftover.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { LARES_DIR_NAME, LEGACY_LARES_DIR_NAME } from '../shared/constants';

export interface StateDirResolution {
  /** Folder name in use for this workspace this session: '.lares' or '.dashboard'. */
  dirName: string;
  /** True when THIS call performed the on-disk rename. */
  migrated: boolean;
  /** Set on the warn branches (both-exist, rename failure). */
  warning?: string;
}

/** Per-process cache: workspace root → resolved state-dir name. The decision
 *  is sticky for the session so a mid-session unlock can't split state across
 *  two folders. */
const resolvedDirNames = new Map<string, string>();

function cacheKey(workspaceRoot: string): string {
  // Windows paths are case-insensitive; normalize separators + case so the
  // same root spelled two ways can't get two different sticky decisions.
  return workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function joinFor(workspaceRoot: string, name: string, pathType: string): string {
  if (pathType === 'wsl') return `${workspaceRoot}/${name}`;
  return path.join(workspaceRoot, name);
}

function dirExists(full: string, pathType: string): boolean {
  if (pathType === 'wsl') {
    try {
      execFileSync('wsl.exe', ['bash', '-lc', `test -d '${full}'`], { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function renameDir(from: string, to: string, pathType: string): void {
  if (pathType === 'wsl') {
    execFileSync('wsl.exe', ['bash', '-lc', `mv -T '${from}' '${to}'`], { timeout: 10000, stdio: 'ignore' });
    return;
  }
  fs.renameSync(from, to);
}

/** Resolve (and, first time, migrate) the state dir for a workspace. Safe to
 *  call from any code path that is about to touch `<root>/.lares/...` — the
 *  migration is idempotent and the result is cached per process. */
export function migrateWorkspaceStateDir(workspaceRoot: string, pathType: string = 'windows'): StateDirResolution {
  const key = cacheKey(workspaceRoot);
  const cached = resolvedDirNames.get(key);
  if (cached) return { dirName: cached, migrated: false };

  const laresFull = joinFor(workspaceRoot, LARES_DIR_NAME, pathType);
  const legacyFull = joinFor(workspaceRoot, LEGACY_LARES_DIR_NAME, pathType);

  let dirName = LARES_DIR_NAME;
  let migrated = false;
  let warning: string | undefined;

  try {
    const laresExists = dirExists(laresFull, pathType);
    const legacyExists = dirExists(legacyFull, pathType);

    if (laresExists && legacyExists) {
      warning =
        `both ${LARES_DIR_NAME}/ and legacy ${LEGACY_LARES_DIR_NAME}/ exist in ${workspaceRoot}; ` +
        `using ${LARES_DIR_NAME}/ and leaving ${LEGACY_LARES_DIR_NAME}/ untouched (never merged or deleted)`;
      console.warn(`[state-dir] ${warning}`);
    } else if (!laresExists && legacyExists) {
      try {
        renameDir(legacyFull, laresFull, pathType);
        migrated = true;
        console.log(`[state-dir] Migrated ${legacyFull} → ${laresFull}`);
      } catch (err) {
        // Windows: EPERM/EBUSY while agent PTYs / watchers hold the folder.
        // Continue this session on the legacy dir; retry naturally next launch.
        dirName = LEGACY_LARES_DIR_NAME;
        warning =
          `could not rename ${legacyFull} → ${laresFull} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `continuing on ${LEGACY_LARES_DIR_NAME}/ for this session`;
        console.warn(`[state-dir] ${warning}`);
      }
    }
    // laresExists-only and neither-exists both fall through to '.lares'.
  } catch (err) {
    // Existence probing itself failed (permissions, dead UNC mount). Default
    // to the live name — construction will surface the real error later.
    console.warn(`[state-dir] Could not probe state dir in ${workspaceRoot}:`, err);
  }

  resolvedDirNames.set(key, dirName);
  return { dirName, migrated, warning };
}

/** State-dir NAME for a workspace ('.lares', or '.dashboard' on the
 *  rename-failed fallback). Cached; performs the one-time migration on first
 *  call for a root. */
export function workspaceStateDirName(workspaceRoot: string, pathType: string = 'windows'): string {
  return migrateWorkspaceStateDir(workspaceRoot, pathType).dirName;
}

/** Absolute path of the workspace state dir (path-type aware join). */
export function workspaceStateDir(workspaceRoot: string, pathType: string = 'windows'): string {
  return joinFor(workspaceRoot, workspaceStateDirName(workspaceRoot, pathType), pathType);
}

/** Translate a `.lares/...`-prefixed workspace-relative path to the state dir
 *  actually in use for this workspace (identity except on the rename-failed
 *  fallback, where the prefix becomes `.dashboard/...`). Non-state-dir paths
 *  pass through untouched. */
export function translateStateRelPath(workspaceRoot: string, relPath: string, pathType: string = 'windows'): string {
  const norm = relPath.replace(/\\/g, '/');
  if (norm !== LARES_DIR_NAME && !norm.startsWith(`${LARES_DIR_NAME}/`)) return relPath;
  const dirName = workspaceStateDirName(workspaceRoot, pathType);
  if (dirName === LARES_DIR_NAME) return relPath;
  return dirName + relPath.slice(LARES_DIR_NAME.length);
}

/** Test hook: clear the per-process cache so each test case re-probes disk. */
export function resetWorkspaceStateDirCacheForTests(): void {
  resolvedDirNames.clear();
}
