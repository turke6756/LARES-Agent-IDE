import * as fs from 'fs';
import * as path from 'path';
import type { FileCopyResult, FileMutationResult, PathType } from '../shared/types';
import { ensureWslPath } from './path-utils';
import { wslExecCommand } from './wsl-bridge';
import {
  normalizeWslPath,
  normalizeWindowsPath,
  assertInsideRoot,
} from './security/path-confinement';

const MAX_TEXT_WRITE_SIZE = 5 * 1024 * 1024;
const WSL_TIMEOUT = 10000;
const WSL_MAX_BUFFER = 1024 * 1024;
const DANGEROUS_CHARS = /[$`;&|]/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

type FileTemplate = 'text' | 'markdown' | 'notebook';

function errorResult(err: unknown, fallback: string): FileMutationResult {
  if (err instanceof Error) {
    return { ok: false, error: err.message || fallback };
  }
  return { ok: false, error: fallback };
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Name is required');
  if (trimmed !== name) throw new Error('Name cannot start or end with spaces');
  if (trimmed === '.' || trimmed === '..') throw new Error('Name cannot be "." or ".."');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Name cannot contain path separators');
  }
  if (/^[A-Za-z]:/.test(trimmed) || path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed)) {
    throw new Error('Name must not be an absolute path');
  }
  if (DANGEROUS_CHARS.test(trimmed)) {
    throw new Error('Name contains disallowed shell characters');
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error('Name contains control characters');
  }
  if (/[. ]$/.test(trimmed)) {
    throw new Error('Name cannot end with a space or dot');
  }
  return trimmed;
}

function sanitizeShellPath(p: string): string {
  if (DANGEROUS_CHARS.test(p)) {
    throw new Error('Path contains disallowed shell characters');
  }
  if (CONTROL_CHARS.test(p)) {
    throw new Error('Path contains control characters');
  }
  return p;
}

function shellQuote(p: string): string {
  const sanitized = sanitizeShellPath(p);
  return `'${sanitized.replace(/'/g, `'\\''`)}'`;
}

// normalizeWslPath / normalizeWindowsPath / assertInsideRoot (and the
// isInside predicates behind it) moved to security/path-confinement.ts in
// WP0.3 so the media:// and surface protocol handlers share them. Behavior
// is unchanged here.

function isSamePath(a: string, b: string, pathType: PathType): boolean {
  if (pathType === 'wsl') {
    return normalizeWslPath(ensureWslPath(a, 'wsl')) === normalizeWslPath(ensureWslPath(b, 'wsl'));
  }
  return normalizeWindowsPath(a).toLowerCase() === normalizeWindowsPath(b).toLowerCase();
}

function isStrictDescendant(targetPath: string, ancestorPath: string, pathType: PathType): boolean {
  if (pathType === 'wsl') {
    const target = normalizeWslPath(ensureWslPath(targetPath, 'wsl'));
    const ancestor = normalizeWslPath(ensureWslPath(ancestorPath, 'wsl'));
    if (target === ancestor) return false;
    if (ancestor === '/') return target.startsWith('/');
    return target.startsWith(`${ancestor}/`);
  }
  const target = normalizeWindowsPath(targetPath).toLowerCase();
  const ancestor = normalizeWindowsPath(ancestorPath).toLowerCase();
  if (target === ancestor) return false;
  return target.startsWith(ancestor + path.win32.sep);
}

function assertNotRoot(targetPath: string, rootDirectory: string, pathType: PathType, operation: string): void {
  if (isSamePath(targetPath, rootDirectory, pathType)) {
    throw new Error(`Cannot ${operation} the working directory root`);
  }
}

function assertWriteSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_TEXT_WRITE_SIZE) {
    throw new Error(`File is too large to write (${(bytes / 1024 / 1024).toFixed(1)}MB). Limit is 5MB.`);
  }
}

function joinPath(parentDir: string, name: string, pathType: PathType): string {
  if (pathType === 'wsl') {
    const parent = normalizeWslPath(ensureWslPath(parentDir, 'wsl'));
    return parent === '/' ? `/${name}` : `${parent}/${name}`;
  }
  return path.join(parentDir, name);
}

function blankNotebookJson(): string {
  return JSON.stringify({
    cells: [],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2) + '\n';
}

function templateContent(template?: FileTemplate): string {
  if (template === 'notebook') return blankNotebookJson();
  return '';
}

async function runWsl(command: string, input?: string): Promise<string> {
  const result = await wslExecCommand(command, {
    input,
    timeout: WSL_TIMEOUT,
    maxBuffer: WSL_MAX_BUFFER,
    throwOnError: true,
    trimOutput: false,
  });
  return result.stdout;
}

async function wslPathExists(wslPath: string): Promise<boolean> {
  try {
    await runWsl(`test -e ${shellQuote(wslPath)}`);
    return true;
  } catch {
    return false;
  }
}

async function wslIsDirectory(wslPath: string): Promise<boolean> {
  try {
    await runWsl(`test -d ${shellQuote(wslPath)}`);
    return true;
  } catch {
    return false;
  }
}

async function assertWslParentDirectory(targetPath: string): Promise<void> {
  const parent = path.posix.dirname(targetPath);
  if (!await wslIsDirectory(parent)) {
    throw new Error('Parent directory does not exist');
  }
}

export async function writeFileContents(
  filePath: string,
  rootDirectory: string,
  pathType: PathType,
  content: string,
): Promise<FileMutationResult> {
  try {
    assertWriteSize(content);
    assertInsideRoot(filePath, rootDirectory, pathType);

    if (pathType === 'wsl') {
      const wslPath = normalizeWslPath(ensureWslPath(filePath, pathType));
      assertInsideRoot(wslPath, rootDirectory, pathType);
      await assertWslParentDirectory(wslPath);
      await runWsl(`cat > ${shellQuote(wslPath)}`, content);
      return { ok: true, path: wslPath };
    }

    const resolved = normalizeWindowsPath(filePath);
    const parent = path.dirname(resolved);
    if (!fs.statSync(parent).isDirectory()) {
      throw new Error('Parent directory does not exist');
    }
    fs.writeFileSync(resolved, content, { encoding: 'utf-8', flag: 'w' });
    return { ok: true, path: resolved };
  } catch (err) {
    return errorResult(err, 'Failed to write file');
  }
}

export async function createFile(
  parentDir: string,
  rootDirectory: string,
  pathType: PathType,
  name: string,
  template?: FileTemplate,
): Promise<FileMutationResult> {
  try {
    const safeName = sanitizeName(name);
    assertInsideRoot(parentDir, rootDirectory, pathType);
    const targetPath = joinPath(parentDir, safeName, pathType);
    assertInsideRoot(targetPath, rootDirectory, pathType);
    const content = templateContent(template);
    assertWriteSize(content);

    if (pathType === 'wsl') {
      const wslParent = normalizeWslPath(ensureWslPath(parentDir, pathType));
      const wslTarget = normalizeWslPath(targetPath);
      if (!await wslIsDirectory(wslParent)) throw new Error('Parent directory does not exist');
      if (await wslPathExists(wslTarget)) throw new Error('A file or folder with that name already exists');
      await runWsl(`cat > ${shellQuote(wslTarget)}`, content);
      return { ok: true, path: wslTarget };
    }

    const resolvedParent = normalizeWindowsPath(parentDir);
    if (!fs.statSync(resolvedParent).isDirectory()) {
      throw new Error('Parent directory does not exist');
    }
    const resolvedTarget = normalizeWindowsPath(targetPath);
    fs.writeFileSync(resolvedTarget, content, { encoding: 'utf-8', flag: 'wx' });
    return { ok: true, path: resolvedTarget };
  } catch (err) {
    return errorResult(err, 'Failed to create file');
  }
}

export async function createDirectory(
  parentDir: string,
  rootDirectory: string,
  pathType: PathType,
  name: string,
): Promise<FileMutationResult> {
  try {
    const safeName = sanitizeName(name);
    assertInsideRoot(parentDir, rootDirectory, pathType);
    const targetPath = joinPath(parentDir, safeName, pathType);
    assertInsideRoot(targetPath, rootDirectory, pathType);

    if (pathType === 'wsl') {
      const wslParent = normalizeWslPath(ensureWslPath(parentDir, pathType));
      const wslTarget = normalizeWslPath(targetPath);
      if (!await wslIsDirectory(wslParent)) throw new Error('Parent directory does not exist');
      await runWsl(`mkdir -- ${shellQuote(wslTarget)}`);
      return { ok: true, path: wslTarget };
    }

    const resolvedParent = normalizeWindowsPath(parentDir);
    if (!fs.statSync(resolvedParent).isDirectory()) {
      throw new Error('Parent directory does not exist');
    }
    const resolvedTarget = normalizeWindowsPath(targetPath);
    fs.mkdirSync(resolvedTarget, { recursive: false });
    return { ok: true, path: resolvedTarget };
  } catch (err) {
    return errorResult(err, 'Failed to create folder');
  }
}

export async function renameEntry(
  oldPath: string,
  rootDirectory: string,
  pathType: PathType,
  newName: string,
): Promise<FileMutationResult> {
  try {
    const safeName = sanitizeName(newName);
    assertInsideRoot(oldPath, rootDirectory, pathType);
    assertNotRoot(oldPath, rootDirectory, pathType, 'rename');
    const parentDir = pathType === 'wsl'
      ? path.posix.dirname(normalizeWslPath(ensureWslPath(oldPath, pathType)))
      : path.dirname(normalizeWindowsPath(oldPath));
    const newPath = joinPath(parentDir, safeName, pathType);
    assertInsideRoot(newPath, rootDirectory, pathType);

    if (pathType === 'wsl') {
      const wslOld = normalizeWslPath(ensureWslPath(oldPath, pathType));
      const wslNew = normalizeWslPath(newPath);
      if (!await wslPathExists(wslOld)) throw new Error('Target does not exist');
      if (await wslPathExists(wslNew)) throw new Error('A file or folder with that name already exists');
      await runWsl(`mv -- ${shellQuote(wslOld)} ${shellQuote(wslNew)}`);
      return { ok: true, path: wslNew };
    }

    const resolvedOld = normalizeWindowsPath(oldPath);
    const resolvedNew = normalizeWindowsPath(newPath);
    if (!fs.existsSync(resolvedOld)) throw new Error('Target does not exist');
    if (fs.existsSync(resolvedNew)) throw new Error('A file or folder with that name already exists');
    fs.renameSync(resolvedOld, resolvedNew);
    return { ok: true, path: resolvedNew };
  } catch (err) {
    return errorResult(err, 'Failed to rename entry');
  }
}

export async function moveEntry(
  srcPath: string,
  rootDirectory: string,
  pathType: PathType,
  destDir: string,
): Promise<FileMutationResult> {
  try {
    assertInsideRoot(srcPath, rootDirectory, pathType);
    assertInsideRoot(destDir, rootDirectory, pathType);
    assertNotRoot(srcPath, rootDirectory, pathType, 'move');

    if (isSamePath(srcPath, destDir, pathType)) {
      throw new Error('Cannot move a folder into itself');
    }
    if (isStrictDescendant(destDir, srcPath, pathType)) {
      throw new Error('Cannot move a folder into one of its own subfolders');
    }

    const srcParent = pathType === 'wsl'
      ? path.posix.dirname(normalizeWslPath(ensureWslPath(srcPath, pathType)))
      : path.dirname(normalizeWindowsPath(srcPath));
    if (isSamePath(srcParent, destDir, pathType)) {
      throw new Error('Item is already in that folder');
    }

    const srcName = pathType === 'wsl'
      ? path.posix.basename(normalizeWslPath(ensureWslPath(srcPath, pathType)))
      : path.basename(normalizeWindowsPath(srcPath));
    const newPath = joinPath(destDir, srcName, pathType);
    assertInsideRoot(newPath, rootDirectory, pathType);

    if (pathType === 'wsl') {
      const wslSrc = normalizeWslPath(ensureWslPath(srcPath, pathType));
      const wslDestDir = normalizeWslPath(ensureWslPath(destDir, pathType));
      const wslNew = normalizeWslPath(newPath);
      if (!await wslPathExists(wslSrc)) throw new Error('Source does not exist');
      if (!await wslIsDirectory(wslDestDir)) throw new Error('Destination folder does not exist');
      if (await wslPathExists(wslNew)) throw new Error('A file or folder with that name already exists at the destination');
      await runWsl(`mv -- ${shellQuote(wslSrc)} ${shellQuote(wslNew)}`);
      return { ok: true, path: wslNew };
    }

    const resolvedSrc = normalizeWindowsPath(srcPath);
    const resolvedDestDir = normalizeWindowsPath(destDir);
    const resolvedNew = normalizeWindowsPath(newPath);
    if (!fs.existsSync(resolvedSrc)) throw new Error('Source does not exist');
    if (!fs.existsSync(resolvedDestDir) || !fs.statSync(resolvedDestDir).isDirectory()) {
      throw new Error('Destination folder does not exist');
    }
    if (fs.existsSync(resolvedNew)) throw new Error('A file or folder with that name already exists at the destination');
    fs.renameSync(resolvedSrc, resolvedNew);
    return { ok: true, path: resolvedNew };
  } catch (err) {
    return errorResult(err, 'Failed to move entry');
  }
}

/**
 * Copy OS files (dropped from Explorer) into a directory inside the
 * workspace. Single regular files only — directories, symlinks and other
 * special files are rejected. All validation (existence, file type,
 * collisions) runs before anything is copied; collisions always fail,
 * nothing is ever overwritten.
 *
 * Source paths are Windows-native (Explorer drops). For WSL targets only
 * drive-letter sources (C:\...) are supported — they are converted to
 * /mnt/<drive>/... and copied WSL-side with `cp`.
 */
export async function copyFiles(
  sourcePaths: string[],
  rootDirectory: string,
  pathType: PathType,
  destDir: string,
): Promise<FileCopyResult> {
  try {
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      throw new Error('No files to copy');
    }
    assertInsideRoot(destDir, rootDirectory, pathType);

    if (pathType === 'wsl') {
      const wslDest = normalizeWslPath(ensureWslPath(destDir, pathType));
      if (!await wslIsDirectory(wslDest)) throw new Error('Destination folder does not exist');
    } else {
      const resolvedDest = normalizeWindowsPath(destDir);
      if (!fs.existsSync(resolvedDest) || !fs.statSync(resolvedDest).isDirectory()) {
        throw new Error('Destination folder does not exist');
      }
    }

    // Preflight every source before copying anything.
    const problems: Array<{ sourcePath: string; error: string }> = [];
    const seenNames = new Set<string>();
    const jobs: Array<{ sourcePath: string; name: string; targetPath: string }> = [];
    for (const sourcePath of sourcePaths) {
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(sourcePath);
      } catch {
        problems.push({ sourcePath, error: 'Source does not exist' });
        continue;
      }
      if (st.isDirectory()) {
        problems.push({ sourcePath, error: "Folder drops aren't supported yet — drop individual files" });
        continue;
      }
      if (!st.isFile()) {
        problems.push({ sourcePath, error: 'Only regular files can be copied (symlinks are not supported)' });
        continue;
      }
      if (pathType === 'wsl' && !/^[A-Za-z]:[\\/]/.test(sourcePath)) {
        problems.push({ sourcePath, error: 'Only drive-letter sources (e.g. C:\\...) can be copied into a WSL workspace' });
        continue;
      }
      const name = path.win32.basename(sourcePath);
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) {
        problems.push({ sourcePath, error: `Duplicate file name "${name}" in the same drop` });
        continue;
      }
      seenNames.add(nameKey);
      const targetPath = joinPath(destDir, name, pathType);
      assertInsideRoot(targetPath, rootDirectory, pathType);
      jobs.push({ sourcePath, name, targetPath });
    }

    // Collision preflight: never overwrite, fail before copying anything.
    for (const job of jobs) {
      const exists = pathType === 'wsl'
        ? await wslPathExists(job.targetPath)
        : fs.existsSync(normalizeWindowsPath(job.targetPath));
      if (exists) {
        problems.push({ sourcePath: job.sourcePath, error: `"${job.name}" already exists at the destination` });
      }
    }
    if (problems.length > 0) {
      const detail = problems.map((p) => `${path.win32.basename(p.sourcePath)}: ${p.error}`).join('\n');
      return { ok: false, error: `Nothing was copied:\n${detail}`, failed: problems };
    }

    const copied: string[] = [];
    const failed: Array<{ sourcePath: string; error: string }> = [];
    for (const job of jobs) {
      try {
        if (pathType === 'wsl') {
          const wslSrc = ensureWslPath(job.sourcePath, 'windows');
          await runWsl(`cp -- ${shellQuote(wslSrc)} ${shellQuote(job.targetPath)}`);
          copied.push(job.targetPath);
        } else {
          const resolvedTarget = normalizeWindowsPath(job.targetPath);
          await fs.promises.copyFile(job.sourcePath, resolvedTarget, fs.constants.COPYFILE_EXCL);
          copied.push(resolvedTarget);
        }
      } catch (err) {
        failed.push({
          sourcePath: job.sourcePath,
          error: err instanceof Error ? err.message || 'Copy failed' : 'Copy failed',
        });
      }
    }
    if (failed.length > 0) {
      const detail = failed.map((f) => `${path.win32.basename(f.sourcePath)}: ${f.error}`).join('\n');
      return { ok: false, error: `Copied ${copied.length} of ${jobs.length} file(s):\n${detail}`, copied, failed };
    }
    return { ok: true, copied };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message || 'Failed to copy files' : 'Failed to copy files',
    };
  }
}

export async function deleteEntry(
  entryPath: string,
  rootDirectory: string,
  pathType: PathType,
  recursive: boolean,
): Promise<FileMutationResult> {
  try {
    assertInsideRoot(entryPath, rootDirectory, pathType);
    assertNotRoot(entryPath, rootDirectory, pathType, 'delete');

    if (pathType === 'wsl') {
      const wslPath = normalizeWslPath(ensureWslPath(entryPath, pathType));
      if (!await wslPathExists(wslPath)) throw new Error('Target does not exist');
      const isDirectory = await wslIsDirectory(wslPath);
      if (isDirectory && !recursive) {
        throw new Error('Folder deletion requires recursive confirmation');
      }
      await runWsl(`${isDirectory ? 'rm -r' : 'rm'} -- ${shellQuote(wslPath)}`);
      return { ok: true, path: wslPath };
    }

    const resolved = normalizeWindowsPath(entryPath);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory() && !recursive) {
      throw new Error('Folder deletion requires recursive confirmation');
    }
    fs.rmSync(resolved, { recursive: stat.isDirectory(), force: false });
    return { ok: true, path: resolved };
  } catch (err) {
    return errorResult(err, 'Failed to delete entry');
  }
}
