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
import crypto from 'crypto';
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

// ─────────────────────────────────────────────────────────────────────────────
// P0.2 — legacy `launch.vbs` security sweep (EDR-safety hardening plan).
//
// Early Lares/AgentDashboard builds wrote a launcher `.vbs` into workspace
// roots that spawned a hidden `cmd` via `WScript.Shell` — a shape EDR
// heuristics flag. The FILENAME is machine-local and arbitrary (real-incident
// evidence shows e.g. `Launch-Lares.vbs`, not `launch.vbs`), so only the
// CONTENT is the signature: on workspace open (same first-touch moment as the
// state-dir migration) we enumerate top-level `*.vbs` files in the workspace
// root (no recursion), DETECT matches by CONTENT (never name-only), surface a
// dashboard security notice per match with path + SHA-256, and offer an
// explicit user-authorized "Remove legacy launcher" action that moves it to
// the Recycle Bin (Electron shell.trashItem, injected here so this module
// stays electron-free and unit-testable). We NEVER execute, reference, or
// silently delete the file — it may be wanted as incident evidence.
//
// The same sweep also lists scaffold-migration backup files
// (`CLAUDE.md.bak.*` / `SKILL.md.bak.*` under the state dir) whose text still
// quotes the old hidden-launch recipe. Those are inert prompt text, not
// executables, so they are only REPORTED in the notice (informational) — the
// removal action stays scoped to the flagged launcher `.vbs` files alone.

export interface LegacyLauncherNotice {
  workspaceRoot: string;
  /** Absolute path of the flagged `<workspaceRoot>/<name>.vbs` (one notice
   *  per matching file — the name is arbitrary, the content is the flag). */
  filePath: string;
  /** SHA-256 (hex) of the flagged file's raw bytes, for the notice/log. */
  sha256: string;
  title: string;
  detail: string;
  /** Scaffold-migration `.bak` files under the state dir that still carry the
   *  old hidden-launch recipe TEXT. Inert (never executed) — reported only. */
  inertBackups: string[];
}

/** Legacy-launcher content predicate (the exact P0.2 spec): the normalized
 *  content must contain BOTH `WScript.Shell` AND a `cmd` invocation.
 *  Normalization = lowercase + collapse runs of whitespace. Content match
 *  only — the caller decides which file to read; a `.vbs` that fails this
 *  predicate is the user's unrelated file and is left alone. */
export function isLegacyLauncherContent(content: string): boolean {
  const norm = content.toLowerCase().replace(/\s+/g, ' ');
  return norm.includes('wscript.shell') && /\bcmd(\.exe)?\b/.test(norm);
}

/** Markers of the old hidden-launch RECIPE TEXT quoted in scaffold prompts
 *  (used only for the inert `.bak` report, never for the launcher predicate). */
function hasHiddenLaunchRecipeText(content: string): boolean {
  const norm = content.toLowerCase();
  return (
    norm.includes('wscript.shell') ||
    /-?windowstyle\s+hidden/.test(norm) ||
    /start-process\b/.test(norm)
  );
}

const MAX_SCAN_BYTES = 1_000_000; // a real launcher/backup is a few KB; skip blobs

function readSmallFile(full: string): string | null {
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return null;
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

/** Bounded walk of the state dir for `CLAUDE.md.bak.*` / `SKILL.md.bak.*`
 *  scaffold-migration backups whose text still quotes the hidden-launch
 *  recipe. Depth-limited and skips the heavyweight per-session folders. */
function sweepScaffoldBackups(stateDirFull: string, depth = 0): string[] {
  if (depth > 6) return [];
  const SKIP_DIRS = new Set(['sessions', 'research', 'node_modules', '.git']);
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDirFull, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(stateDirFull, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...sweepScaffoldBackups(full, depth + 1));
    } else if (/^(CLAUDE|SKILL)\.md\.bak\./i.test(e.name)) {
      const content = readSmallFile(full);
      if (content !== null && hasHiddenLaunchRecipeText(content)) out.push(full);
    }
  }
  return out;
}

/** Pending notices for this process, keyed like the state-dir cache so the
 *  sweep runs once per workspace per session (empty array = clean workspace).
 *  The renderer pulls the list on mount (`workspace:security-notices`) and
 *  main pushes on workspace create. */
const securitySweepDone = new Map<string, LegacyLauncherNotice[]>();

export const LEGACY_LAUNCHER_NOTICE_TITLE =
  'Legacy launcher detected — known EDR false-positive trigger';

/** Pure detection: enumerate `*.vbs` files in the workspace ROOT (top level
 *  only, no recursion — the legacy launcher only ever lived there), apply the
 *  content predicate to each, and build one notice per match (the FILENAME is
 *  arbitrary/machine-local — e.g. `Launch-Lares.vbs` in the real incident —
 *  so name-only matching stays out; a non-matching `.vbs` is ignored). The
 *  inert-backup sweep runs once and is attached to every notice. Never
 *  executes or mutates anything. WSL-rooted workspaces are skipped — the
 *  legacy launcher was only ever written into Windows workspace roots, and
 *  this module reads WSL paths via wsl.exe only for existence probes. */
export function detectLegacyLauncher(
  workspaceRoot: string,
  pathType: string = 'windows',
): LegacyLauncherNotice[] {
  if (pathType === 'wsl') return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: { filePath: string; sha256: string }[] = [];
  for (const e of entries.filter((e) => e.isFile() && /\.vbs$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(workspaceRoot, e.name);
    const content = readSmallFile(filePath);
    if (content === null || !isLegacyLauncherContent(content)) continue;
    matches.push({
      filePath,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    });
  }
  if (matches.length === 0) return [];

  // Sweep whichever state dir is live this session (plus a leftover legacy
  // dir on the both-exist branch — its backups are just as readable).
  const inertBackups: string[] = [];
  for (const name of [workspaceStateDirName(workspaceRoot, pathType), LEGACY_LARES_DIR_NAME]) {
    const dir = joinFor(workspaceRoot, name, pathType);
    if (dirExists(dir, pathType)) inertBackups.push(...sweepScaffoldBackups(dir));
  }
  const dedupedBackups = [...new Set(inertBackups)];
  return matches.map(({ filePath, sha256 }) => ({
    workspaceRoot,
    filePath,
    sha256,
    title: LEGACY_LAUNCHER_NOTICE_TITLE,
    detail:
      `${filePath} spawns a hidden cmd via WScript.Shell (SHA-256 ${sha256}). ` +
      `It is no longer used by Lares and is a known EDR false-positive trigger. ` +
      `It has not been run or modified; you can move it to the Recycle Bin, or keep it as incident evidence.`,
    inertBackups: dedupedBackups,
  }));
}

/** First-touch sweep, cached per process (call alongside the state-dir
 *  migration on workspace open). Never throws. */
export function checkWorkspaceSecurityOnOpen(
  workspaceRoot: string,
  pathType: string = 'windows',
): LegacyLauncherNotice[] {
  const key = cacheKey(workspaceRoot);
  const cached = securitySweepDone.get(key);
  if (cached) return cached;
  let notices: LegacyLauncherNotice[] = [];
  try {
    notices = detectLegacyLauncher(workspaceRoot, pathType);
  } catch (err) {
    console.warn(`[security] legacy-launcher sweep failed in ${workspaceRoot}:`, err);
  }
  for (const notice of notices) {
    console.warn(
      `[security] ${notice.title}: ${notice.filePath} (sha256 ${notice.sha256}); ` +
        `${notice.inertBackups.length} inert scaffold backup(s). Not executed; awaiting user decision.`,
    );
  }
  securitySweepDone.set(key, notices);
  return notices;
}

/** All notices pending in this process (for the renderer's mount-time pull). */
export function listPendingSecurityNotices(): LegacyLauncherNotice[] {
  return [...securitySweepDone.values()].flat();
}

/** User-authorized removal: `filePath` must be a `.vbs` this process's own
 *  sweep FLAGGED (workspace-root only — the sweep never flags anything
 *  deeper) and must STILL match the content predicate on re-read; then move
 *  it to the Recycle Bin via the injected `trashItem` (production: Electron
 *  `shell.trashItem`) and log the removal. Never a hard delete; refuses
 *  unflagged paths and anything that no longer matches (so this can never be
 *  aimed at an unrelated file). */
export async function removeLegacyLauncher(
  filePath: string,
  deps: { trashItem: (fullPath: string) => Promise<void> },
): Promise<{ removed: boolean; sha256?: string; reason?: string }> {
  if (path.extname(filePath).toLowerCase() !== '.vbs') {
    return { removed: false, reason: 'not a .vbs path' };
  }
  const flagged = [...securitySweepDone.values()].some((list) =>
    list.some((n) => n.filePath === filePath));
  if (!flagged) {
    return { removed: false, reason: 'path was not flagged by the security sweep' };
  }
  const content = readSmallFile(filePath);
  if (content === null) return { removed: false, reason: 'file unreadable or already gone' };
  if (!isLegacyLauncherContent(content)) {
    return { removed: false, reason: 'content no longer matches the legacy-launcher signature' };
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  await deps.trashItem(filePath);
  console.log(
    `[security] user-authorized removal: moved legacy launcher ${filePath} ` +
      `(sha256 ${sha256}) to the Recycle Bin`,
  );
  // Drop the file's pending notice so the surface clears (other flagged
  // launchers in the same workspace stay pending).
  for (const [key, notices] of securitySweepDone) {
    if (notices.some((n) => n.filePath === filePath)) {
      securitySweepDone.set(key, notices.filter((n) => n.filePath !== filePath));
    }
  }
  return { removed: true, sha256 };
}

/** Test hook: clear the per-process security-sweep cache. */
export function resetWorkspaceSecurityCacheForTests(): void {
  securitySweepDone.clear();
}
