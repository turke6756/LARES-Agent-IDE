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
}

/** Sidecar tracks the on-disk version of every managed scaffold file in a
 *  workspace. Keyed by path relative to the state dir (`.lares/`), no leading
 *  slash, forward slashes always — the prefix is stripped so sidecar keys
 *  written under the legacy `.dashboard/` name stay valid after the folder
 *  rename. */
export const SCAFFOLD_SIDECAR_REL = `${LARES_DIR_NAME}/.scaffold-versions.json`;
export const SCAFFOLD_LOCK_REL = `${LARES_DIR_NAME}/.scaffold-versions.lock`;
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
  const lockReleased = acquireScaffoldLock(workDir, pathType, logPrefix);
  try {
    const sidecar = readScaffoldSidecar(workDir, pathType, logPrefix);
    let changed = 0;

    for (const [relPath, file] of Object.entries(files)) {
      const managedKey = normalizeManagedKey(relPath);
      const bundledVersion = file.version;
      const diskVersion = Number.isInteger(sidecar[managedKey]) ? sidecar[managedKey] : 0;

      try {
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

function copyScaffoldForBackup(workDir: string, srcRel: string, dstRel: string, pathType: string): void {
  const src = scaffoldFullPath(workDir, srcRel, pathType);
  const dst = scaffoldFullPath(workDir, dstRel, pathType);
  if (pathType === 'wsl') {
    execFileSync('wsl.exe', ['bash', '-lc', `cp -p '${src}' '${dst}'`], { timeout: 5000 });
    return;
  }
  fs.copyFileSync(src, dst);
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

/** Acquire the workspace-scoped scaffold lock. Returns a release function
 *  that callers MUST invoke in a finally. Falls back to a no-op release if
 *  the lock can't be acquired within the timeout (worst case: two writers
 *  race the sidecar — atomic writes still keep individual files intact). */
function acquireScaffoldLock(workDir: string, pathType: string, logPrefix = '[scaffold]'): () => void {
  const lockFull = scaffoldFullPath(workDir, SCAFFOLD_LOCK_REL, pathType);
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
