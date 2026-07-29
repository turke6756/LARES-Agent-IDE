// Shared, versioned scaffold-map writer + IO primitives.
//
// Extracted verbatim (D1 of plans/persona-productization-impl.md) from
// AgentSupervisor so both the supervisor scaffold path and the persona
// scaffolder (src/main/persona-scanner.ts) can write managed files through the
// SAME atomic-write + content-hash-migration + workspace-lock algorithm — no
// forked copy of a load-bearing, security-sensitive routine.
//
// Every function here is a free function: the IO primitives referenced no
// instance state in their original form (`pathType` was always an explicit
// param), so the move is a pure no-op extraction. `AgentSupervisor.writeScaffoldMap`
// is now a one-line delegator into `writeScaffoldMap` below.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { LARES_DIR_NAME, LEGACY_LARES_DIR_NAME } from '../shared/constants';
import { translateStateRelPath } from './workspace-state-dir';

/** A managed scaffold-map entry. Per-file `version` is hand-bumped when the
 *  bundled `content` changes; `previousHashes` maps old version numbers to
 *  SHA-256 hex of the exact bundled content shipped at that version. Lets
 *  writeScaffoldMap distinguish "user-modified file" from "known managed
 *  v(n-1) file that just needs a silent upgrade." */
export interface ScaffoldFile {
  content: string;
  executable?: boolean;
  version: number;
  previousHashes?: Record<number, string>;
  /** Retirement entry: the bundled "content" for this version is the file's
   *  ABSENCE. On upgrade, a pristine on-disk copy (hash matches any
   *  previousHashes value) is deleted silently; a user-modified copy is backed
   *  up to `.bak.<ts>` first, then deleted. The removal is recorded in the
   *  sidecar at `version`, so a file the user later creates at this path is
   *  never touched again. `content` is ignored (pass ''). Keep the entry (and
   *  its previousHashes) in the map permanently — dropping it would strand
   *  not-yet-upgraded workspaces with the retired file. */
  removed?: boolean;
}

/** Sidecar tracks the on-disk version of every managed scaffold file in a
 *  workspace. Keyed by path relative to the state dir (`.lares/`), no leading
 *  slash, forward slashes always — the prefix is stripped so sidecar keys
 *  written under the legacy `.dashboard/` name stay valid after the folder
 *  rename. */
export const SCAFFOLD_SIDECAR_REL = `${LARES_DIR_NAME}/.scaffold-versions.json`;
export const SCAFFOLD_LOCK_REL = `${LARES_DIR_NAME}/.scaffold-versions.lock`;

/** D15 `.bak` retention: after a new backup is written, at most this many
 *  CANONICAL `.bak` siblings (copies of a known shipped scaffold body) are kept
 *  per logical target — the newest few by timestamped filename. Backups that
 *  match NO known managed body (possible user edits) are never counted here and
 *  never pruned. */
export const SCAFFOLD_BAK_RETENTION = 3;
const SCAFFOLD_LOCK_STALE_MS = 60_000;
const SCAFFOLD_LOCK_POLL_MS = 100;
const SCAFFOLD_LOCK_TIMEOUT_MS = 5_000;

export function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Strip the leading state-dir segment (`.lares/`, or the legacy
 *  `.dashboard/`) from a scaffold-map relPath so the sidecar key is stable
 *  across map reshuffles AND across the `.dashboard` → `.lares` folder
 *  rename (a migrated workspace's existing sidecar keys keep matching). `\`
 *  is normalized to `/` to keep Windows and WSL keys identical. */
export function normalizeManagedKey(relPath: string): string {
  let s = relPath.replace(/\\/g, '/');
  if (s.startsWith(`${LARES_DIR_NAME}/`)) s = s.slice(`${LARES_DIR_NAME}/`.length);
  else if (s.startsWith(`${LEGACY_LARES_DIR_NAME}/`)) s = s.slice(`${LEGACY_LARES_DIR_NAME}/`.length);
  return s.replace(/^\/+/, '');
}

function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${process.pid}`;
}

/** Shared file-map writer used by the supervisor, worker, researcher, and
 *  persona scaffold paths. Returns the number of files written or upgraded
 *  (managed upgrades count as writes). Behavior per
 *  plans/scaffold-version-migration.md §Algorithm:
 *
 *  - Missing file → write bundled content, record version in sidecar.
 *  - Sidecar says current version → skip.
 *  - Disk content matches current bundled content (sidecar drift) → update
 *    sidecar only, no write or backup.
 *  - Disk content matches a known old managed hash → silent upgrade.
 *  - Disk content differs and no hash matches → back up to `.bak.<ts>` then
 *    overwrite (treat as user-modified — preserves the edit but takes the
 *    file off the user's hands).
 *  - Sidecar says future version (> bundled) → leave unchanged, warn.
 *
 *  Atomic per-file replacement (write-to-tmp + rename) on both platforms.
 *  Workspace-scoped lock (`.dashboard/.scaffold-versions.lock`) serializes
 *  concurrent scaffold calls so two writers can't race the sidecar
 *  read/modify/write. `opts.logPrefix` tags all console output (the supervisor
 *  delegator passes `'[supervisor]'`; the persona path passes `'[persona]'`). */
export function writeScaffoldMap(
  workDir: string,
  files: Record<string, ScaffoldFile>,
  pathType: string,
  opts?: { logPrefix?: string },
): number {
  const logPrefix = opts?.logPrefix ?? '[scaffold]';
  const lockReleased = acquireWorkspaceLock(workDir, pathType, SCAFFOLD_LOCK_REL, logPrefix);
  try {
    const sidecar = readScaffoldSidecar(workDir, pathType, logPrefix);
    let changed = 0;

    for (const [relPath, file] of Object.entries(files)) {
      const managedKey = normalizeManagedKey(relPath);
      const bundledVersion = file.version;
      const diskVersion = Number.isInteger(sidecar[managedKey]) ? sidecar[managedKey] : 0;

      try {
        // Retirement entries — the managed file is being REMOVED, not updated.
        if (file.removed) {
          if (diskVersion >= bundledVersion) continue; // removal already applied (or future) — a later user-created file here is theirs
          if (!scaffoldFileExists(workDir, relPath, pathType)) {
            sidecar[managedKey] = bundledVersion; // record so nothing re-checks (or later deletes a user's new file)
            changed++;
            continue;
          }
          const diskContent = readScaffoldText(workDir, relPath, pathType);
          const diskHash = diskContent === null ? null : sha256Hex(diskContent);
          const knownManaged = diskHash !== null &&
            Object.values(file.previousHashes ?? {}).includes(diskHash);
          if (!knownManaged) {
            // User-modified (or unreadable) — preserve the bytes before removal,
            // mirroring the backup-then-overwrite path below.
            const bakRel = `${relPath}.bak.${timestampForFilename()}`;
            try { copyScaffoldForBackup(workDir, relPath, bakRel, pathType); } catch (bakErr) {
              console.warn(`${logPrefix} Could not back up ${managedKey} before removal:`, bakErr);
            }
            console.warn(`${logPrefix} Scaffold file ${managedKey} differed from known managed content; backed up to ${bakRel} and removed (retired at v${bundledVersion})`);
            pruneScaffoldBackups(workDir, relPath, file, pathType, logPrefix);
          } else {
            console.log(`${logPrefix} Scaffold file ${managedKey} removed (retired at v${bundledVersion}; matched known managed hash)`);
          }
          deleteScaffoldFile(workDir, relPath, pathType);
          sidecar[managedKey] = bundledVersion;
          changed++;
          continue;
        }

        if (!scaffoldFileExists(workDir, relPath, pathType)) {
          atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
          sidecar[managedKey] = bundledVersion;
          changed++;
          continue;
        }

        if (diskVersion === bundledVersion) {
          continue;
        }

        if (diskVersion > bundledVersion) {
          console.warn(`${logPrefix} Scaffold file ${managedKey} has future version ${diskVersion}; leaving unchanged (bundled v${bundledVersion})`);
          continue;
        }

        const diskContent = readScaffoldText(workDir, relPath, pathType);
        if (diskContent === null) {
          // File reported exists but unreadable — treat as missing and write.
          atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
          sidecar[managedKey] = bundledVersion;
          changed++;
          continue;
        }
        const diskHash = sha256Hex(diskContent);

        // Sidecar drift safety: if the file content is already the current
        // bundled content, just record the version and move on — no write,
        // no backup. Covers "user deleted sidecar but didn't touch files."
        if (diskHash === sha256Hex(file.content)) {
          sidecar[managedKey] = bundledVersion;
          changed++;
          continue;
        }

        const knownOldHash = file.previousHashes?.[diskVersion] ?? file.previousHashes?.[1];
        const matchesKnownManagedOld = !!knownOldHash && diskHash === knownOldHash;

        if (matchesKnownManagedOld) {
          atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
          sidecar[managedKey] = bundledVersion;
          console.log(`${logPrefix} Scaffold file ${managedKey} upgraded ${diskVersion} → ${bundledVersion} (matched known managed hash)`);
          changed++;
          continue;
        }

        // User-modified (or unknown previous version we don't have a hash
        // for). Back up before overwrite so the edit is recoverable.
        const bakRel = `${relPath}.bak.${timestampForFilename()}`;
        copyScaffoldForBackup(workDir, relPath, bakRel, pathType);
        console.warn(
          `${logPrefix} Scaffold file ${managedKey} differed from known managed content; ` +
          `backed up to ${bakRel} and upgraded to v${bundledVersion}`,
        );
        pruneScaffoldBackups(workDir, relPath, file, pathType, logPrefix);
        atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
        sidecar[managedKey] = bundledVersion;
        changed++;
      } catch (err) {
        console.error(`${logPrefix} Failed to upgrade scaffold file ${relPath}:`, err);
      }
    }

    if (changed > 0) {
      try {
        writeScaffoldSidecar(workDir, sidecar, pathType);
      } catch (err) {
        console.error(`${logPrefix} Failed to persist scaffold sidecar:`, err);
      }
    }

    return changed;
  } finally {
    lockReleased();
  }
}

// ── Scaffold IO primitives ────────────────────────────────────────────

/** Resolve a workspace-relative path to its absolute form for the given
 *  pathType. Windows uses path.join (handles backslashes); WSL/Linux uses
 *  forward slashes throughout. `.lares/`-prefixed paths are translated to the
 *  workspace's ACTUAL state dir first, so a rename-failed workspace (still on
 *  `.dashboard/` this session) keeps its scaffolds in one folder. */
function scaffoldFullPath(workDir: string, relPath: string, pathType: string): string {
  const effectiveRel = translateStateRelPath(workDir, relPath, pathType);
  if (pathType === 'wsl') return `${workDir}/${effectiveRel}`;
  return path.join(workDir, effectiveRel);
}

export function scaffoldFileExists(workDir: string, relPath: string, pathType: string): boolean {
  const full = scaffoldFullPath(workDir, relPath, pathType);
  if (pathType === 'wsl') {
    try {
      execFileSync('wsl.exe', ['bash', '-lc', `test -f '${full}'`], { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(full);
}

export function readScaffoldText(workDir: string, relPath: string, pathType: string): string | null {
  const full = scaffoldFullPath(workDir, relPath, pathType);
  if (pathType === 'wsl') {
    try {
      const b64 = execFileSync('wsl.exe', ['bash', '-lc', `base64 -w0 '${full}'`], {
        encoding: 'utf-8', timeout: 5000,
      });
      return Buffer.from(b64.trim(), 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

/** Write `content` atomically: write to `<target>.tmp.<pid>.<ts>`, then
 *  rename over the target. `executable=true` adds chmod +x (WSL only —
 *  Windows ignores +x). Creates parent dirs as needed. */
export function atomicWriteScaffoldText(
  workDir: string,
  relPath: string,
  content: string,
  executable: boolean,
  pathType: string,
): void {
  const full = scaffoldFullPath(workDir, relPath, pathType);
  if (pathType === 'wsl') {
    const dir = full.substring(0, full.lastIndexOf('/'));
    const tmp = `${full}.tmp.${process.pid}.${Date.now()}`;
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    const chmod = executable ? ` && chmod +x '${tmp}'` : '';
    const cmd = `mkdir -p '${dir}' && echo '${b64}' | base64 -d > '${tmp}'${chmod} && mv -f '${tmp}' '${full}'`;
    execFileSync('wsl.exe', ['bash', '-lc', cmd], { timeout: 5000 });
    return;
  }
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${full}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, full);
  } catch (err) {
    // Windows can fail to rename over an open file. Fall back to copy + unlink.
    try { fs.copyFileSync(tmp, full); } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'EEXIST' && (err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EACCES') {
      throw err;
    }
  }
}

/** Low-level STAGING write (Memory & Lessons v2 WP-F1): write `content` to
 *  `tempRel` and STOP — no rename to any final target. The transactional commit
 *  (rename tmp → final) is the caller's separate step (`commitStagedRename`), so
 *  a crash between staging and committing leaves only a `.tmp` sibling, never a
 *  half-written final file. WSL-aware — the WSL branch mirrors
 *  `atomicWriteScaffoldText`'s base64 pipe but omits the final `mv`. Creates the
 *  parent dir; `executable` adds chmod +x on WSL (Windows ignores +x). */
export function stageTextFile(
  workDir: string,
  tempRel: string,
  content: string,
  executable: boolean,
  pathType: string,
): void {
  const full = scaffoldFullPath(workDir, tempRel, pathType);
  if (pathType === 'wsl') {
    const dir = full.substring(0, full.lastIndexOf('/'));
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    const chmod = executable ? ` && chmod +x '${full}'` : '';
    const cmd = `mkdir -p '${dir}' && echo '${b64}' | base64 -d > '${full}'${chmod}`;
    execFileSync('wsl.exe', ['bash', '-lc', cmd], { timeout: 5000 });
    return;
  }
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** Commit a staged file: rename `tempRel` OVER `finalRel` (WSL-aware). Unlike
 *  `atomicWriteScaffoldText`, this THROWS on a rename failure rather than
 *  silently falling back to copy+unlink — the caller (`stagedMultiWrite`) needs a
 *  hard failure to trigger its restore-and-unwind, so a genuinely blocked target
 *  can never be reported as a successful publish. Creates the final parent dir. */
export function commitStagedRename(
  workDir: string,
  tempRel: string,
  finalRel: string,
  pathType: string,
): void {
  const tmpFull = scaffoldFullPath(workDir, tempRel, pathType);
  const finalFull = scaffoldFullPath(workDir, finalRel, pathType);
  if (pathType === 'wsl') {
    const dir = finalFull.substring(0, finalFull.lastIndexOf('/'));
    execFileSync('wsl.exe', ['bash', '-lc', `mkdir -p '${dir}' && mv -f '${tmpFull}' '${finalFull}'`], {
      timeout: 5000,
    });
    return;
  }
  fs.mkdirSync(path.dirname(finalFull), { recursive: true });
  fs.renameSync(tmpFull, finalFull);
}

/** Delete a managed scaffold file (retirement path). Best-effort removes the
 *  now-empty parent directory too (e.g. a retired skill's folder) — rmdir on a
 *  non-empty dir (a .bak sibling, other files) just no-ops. */
export function deleteScaffoldFile(workDir: string, relPath: string, pathType: string): void {
  const full = scaffoldFullPath(workDir, relPath, pathType);
  if (pathType === 'wsl') {
    const dir = full.substring(0, full.lastIndexOf('/'));
    execFileSync('wsl.exe', ['bash', '-lc', `rm -f '${full}'; rmdir '${dir}' 2>/dev/null || true`], {
      timeout: 5000, stdio: 'ignore',
    });
    return;
  }
  fs.rmSync(full, { force: true });
  try { fs.rmdirSync(path.dirname(full)); } catch { /* non-empty or shared dir — leave it */ }
}

/** List the FILE basenames directly under a managed scaffold directory
 *  (workspace-relative `relDir`). WSL-aware. A missing directory yields `[]`.
 *  Only regular files are returned (no subdirectories) — the sole caller
 *  (Memory & Lessons v2 WP-F2 bundle migration) compares the live memory
 *  `details/` inventory against a signed proposal, and detail bodies are files. */
export function listScaffoldDir(workDir: string, relDir: string, pathType: string): string[] {
  const full = scaffoldFullPath(workDir, relDir, pathType);
  if (pathType === 'wsl') {
    try {
      // -p appends '/' to directories so they can be filtered out; entries are
      // NUL-free basenames (memory ids), so newline-splitting is safe.
      const out = execFileSync('wsl.exe', ['bash', '-lc', `ls -p '${full}' 2>/dev/null`], {
        encoding: 'utf-8', timeout: 5000,
      });
      return out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0 && !s.endsWith('/'));
    } catch {
      return [];
    }
  }
  try {
    return fs.readdirSync(full, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
}

function copyScaffoldForBackup(workDir: string, srcRel: string, dstRel: string, pathType: string): void {
  const src = scaffoldFullPath(workDir, srcRel, pathType);
  const dst = scaffoldFullPath(workDir, dstRel, pathType);
  if (pathType === 'wsl') {
    execFileSync('wsl.exe', ['bash', '-lc', `cp -p '${src}' '${dst}'`], { timeout: 5000 });
    return;
  }
  fs.copyFileSync(src, dst);
}

/** Delete a single `.bak` file (D15 retention prune). Unlike
 *  `deleteScaffoldFile`, it does NOT attempt to rmdir the parent — a `.bak`
 *  always sits beside a live target (or a freshly-written newer `.bak`), so the
 *  directory is never ours to remove. Throws on IO failure so the caller can log
 *  and keep the file. */
function deleteScaffoldBakFile(workDir: string, relPath: string, pathType: string): void {
  const full = scaffoldFullPath(workDir, relPath, pathType);
  if (pathType === 'wsl') {
    execFileSync('wsl.exe', ['bash', '-lc', `rm -f '${full}'`], { timeout: 5000, stdio: 'ignore' });
    return;
  }
  fs.rmSync(full, { force: true });
}

/** Split a forward-slash scaffold-map relPath into [dirRel, basename]. Map keys
 *  always use `/` (Windows and WSL alike), so this is byte-exact and avoids
 *  path.win32 backslash surprises. A path with no `/` yields ['', relPath]. */
function splitRel(relPath: string): [string, string] {
  const slash = relPath.lastIndexOf('/');
  if (slash === -1) return ['', relPath];
  return [relPath.slice(0, slash), relPath.slice(slash + 1)];
}

/** The set of SHA-256 hashes that identify a KNOWN shipped body for this target:
 *  the current bundled-content hash (omitted for a retired target, whose current
 *  "content" is absence) plus every recorded `previousHashes` value. A `.bak`
 *  whose content hashes to one of these is a canonical (redundant) copy; one that
 *  matches none is a possible user edit. Hashes suffice — previous *bodies* are
 *  never materialized. */
function canonicalBodyHashes(file: ScaffoldFile): Set<string> {
  const hashes = new Set<string>(Object.values(file.previousHashes ?? {}));
  if (!file.removed) hashes.add(sha256Hex(file.content));
  return hashes;
}

/** D15 retention. After a fresh `.bak` is written for `relPath`, classify every
 *  existing `.bak` sibling by SHA-256 against `canonicalBodyHashes(file)` and
 *  prune the redundant tail:
 *
 *  - A `.bak` matching a known managed body is CANONICAL (a copy of a shipped
 *    scaffold body — recoverable from constants, safe to drop).
 *  - A `.bak` matching NONE is a possible user edit → ALWAYS preserved.
 *  - If ANY `.bak` can't be read/hashed, classification is uncertain → preserve
 *    ALL (prune nothing). Likewise if there is no known body to compare against
 *    (a retired target with no `previousHashes`): nothing can be deemed
 *    canonical, so everything stays.
 *
 *  Among canonical matches, only the newest `SCAFFOLD_BAK_RETENTION` (by the
 *  fixed-width `.bak.<ts>` filename, which sorts chronologically) survive; older
 *  canonical copies are deleted. Every step is best-effort — an IO failure logs
 *  and leaves the file in place. Never materializes previous bodies. */
function pruneScaffoldBackups(
  workDir: string,
  relPath: string,
  file: ScaffoldFile,
  pathType: string,
  logPrefix: string,
): void {
  const canonical = canonicalBodyHashes(file);
  // No known body to compare against → cannot classify anything as canonical.
  if (canonical.size === 0) return;

  const [dirRel, base] = splitRel(relPath);
  const prefix = `${base}.bak.`;
  let entries: string[];
  try {
    entries = listScaffoldDir(workDir, dirRel, pathType).filter((n) => n.startsWith(prefix));
  } catch {
    return; // can't enumerate → leave everything alone
  }
  if (entries.length <= SCAFFOLD_BAK_RETENTION) return; // never more than we'd keep

  const canonicalBaks: string[] = [];
  for (const entry of entries) {
    const bakRel = dirRel ? `${dirRel}/${entry}` : entry;
    const body = readScaffoldText(workDir, bakRel, pathType);
    if (body === null) return; // unreadable → uncertain → preserve ALL
    if (canonical.has(sha256Hex(body))) canonicalBaks.push(entry);
    // else: matches no known body → possible user edit → preserved (untouched)
  }

  if (canonicalBaks.length <= SCAFFOLD_BAK_RETENTION) return;

  // Newest-first: the `YYYYMMDD-HHMMSS-pid` suffix is fixed-width, so a plain
  // descending string sort is chronological. Keep the head, delete the tail.
  canonicalBaks.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const entry of canonicalBaks.slice(SCAFFOLD_BAK_RETENTION)) {
    const bakRel = dirRel ? `${dirRel}/${entry}` : entry;
    try {
      deleteScaffoldBakFile(workDir, bakRel, pathType);
      console.log(`${logPrefix} Pruned redundant scaffold backup ${entry} (canonical; kept newest ${SCAFFOLD_BAK_RETENTION})`);
    } catch (err) {
      console.warn(`${logPrefix} Could not prune scaffold backup ${entry}:`, err);
    }
  }
}

/** Read the workspace sidecar. Missing file or unparseable JSON both yield
 *  an empty record; corrupt content also logs a warning so users can see
 *  the migration treated their sidecar as missing. */
export function readScaffoldSidecar(workDir: string, pathType: string, logPrefix = '[scaffold]'): Record<string, number> {
  const raw = readScaffoldText(workDir, SCAFFOLD_SIDECAR_REL, pathType);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isInteger(v)) out[k] = v;
      }
      return out;
    }
    console.warn(`${logPrefix} Scaffold sidecar at ${SCAFFOLD_SIDECAR_REL} is not an object; treating as empty`);
    return {};
  } catch {
    console.warn(`${logPrefix} Scaffold sidecar at ${SCAFFOLD_SIDECAR_REL} is unparseable JSON; treating as empty`);
    return {};
  }
}

function writeScaffoldSidecar(workDir: string, sidecar: Record<string, number>, pathType: string): void {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(sidecar).sort()) sorted[key] = sidecar[key];
  const content = JSON.stringify(sorted, null, 2) + '\n';
  atomicWriteScaffoldText(workDir, SCAFFOLD_SIDECAR_REL, content, false, pathType);
}

/** Acquire a workspace-scoped lock (mkdir-atomic, WSL-aware). Returns a release
 *  function that callers MUST invoke in a finally. Falls back to a no-op release
 *  if the lock can't be acquired within the timeout (worst case: two writers race
 *  — atomic writes still keep individual files intact).
 *
 *  Generalized from the original private scaffold-lock helper (Memory & Lessons
 *  v2 WP-F1): `lockRel` defaults to `SCAFFOLD_LOCK_REL`, so the scaffold writer
 *  and any other caller share the SAME lock by default. Dynamic lesson
 *  publication (staged-write.ts) acquires this with the default rel, so a
 *  publication serializes against a concurrent scaffold refresh — there is no
 *  separate fallback publication lock. The lock dir always lives under `.lares/`
 *  (its parent is created here) regardless of `lockRel`. */
export function acquireWorkspaceLock(
  workDir: string,
  pathType: string,
  lockRel: string = SCAFFOLD_LOCK_REL,
  logPrefix = '[scaffold]',
): () => void {
  const lockFull = scaffoldFullPath(workDir, lockRel, pathType);
  const dashboardDir = scaffoldFullPath(workDir, LARES_DIR_NAME, pathType);
  const start = Date.now();

  while (Date.now() - start < SCAFFOLD_LOCK_TIMEOUT_MS) {
    if (tryAcquireScaffoldLock(dashboardDir, lockFull, pathType)) {
      return () => releaseScaffoldLock(lockFull, pathType);
    }
    const ageMs = scaffoldLockAgeMs(lockFull, pathType);
    if (ageMs !== null && ageMs > SCAFFOLD_LOCK_STALE_MS) {
      console.warn(`${logPrefix} Scaffold lock at ${lockFull} is stale (${Math.round(ageMs / 1000)}s); clearing`);
      try { releaseScaffoldLock(lockFull, pathType); } catch { /* best effort */ }
    }
    const waitMs = SCAFFOLD_LOCK_POLL_MS + Math.floor(Math.random() * SCAFFOLD_LOCK_POLL_MS);
    // Synchronous sleep — writeScaffoldMap is a sync method.
    const wakeAt = Date.now() + waitMs;
    while (Date.now() < wakeAt) { /* spin briefly */ }
  }
  console.warn(`${logPrefix} Could not acquire scaffold lock at ${lockFull} within ${SCAFFOLD_LOCK_TIMEOUT_MS}ms; proceeding without lock`);
  return () => { /* no-op */ };
}

function tryAcquireScaffoldLock(dashboardDir: string, lockFull: string, pathType: string): boolean {
  if (pathType === 'wsl') {
    try {
      execFileSync('wsl.exe', ['bash', '-lc', `mkdir -p '${dashboardDir}' && mkdir '${lockFull}'`], {
        timeout: 5000, stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.mkdirSync(lockFull);
    return true;
  } catch {
    return false;
  }
}

function releaseScaffoldLock(lockFull: string, pathType: string): void {
  if (pathType === 'wsl') {
    try {
      execFileSync('wsl.exe', ['bash', '-lc', `rmdir '${lockFull}'`], { timeout: 5000, stdio: 'ignore' });
    } catch { /* best effort */ }
    return;
  }
  try { fs.rmdirSync(lockFull); } catch { /* best effort */ }
}

function scaffoldLockAgeMs(lockFull: string, pathType: string): number | null {
  if (pathType === 'wsl') {
    try {
      const out = execFileSync('wsl.exe', ['bash', '-lc', `stat -c %Y '${lockFull}'`], {
        encoding: 'utf-8', timeout: 5000,
      });
      const epochS = Number.parseInt(out.trim(), 10);
      if (!Number.isFinite(epochS)) return null;
      return Date.now() - epochS * 1000;
    } catch {
      return null;
    }
  }
  try {
    const stat = fs.statSync(lockFull);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}
