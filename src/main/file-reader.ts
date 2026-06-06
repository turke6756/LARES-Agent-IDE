import * as fs from 'fs';
import * as path from 'path';
import type { PathType, FileContent, DirectoryEntry } from '../shared/types';
import { ensureWslPath } from './path-utils';
import { wslExecCommand } from './wsl-bridge';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_NOTEBOOK_SIZE = 5 * 1024 * 1024; // 5MB for notebook JSON files
const WSL_TIMEOUT = 10000;

const DANGEROUS_CHARS = /[$`;&|]/;

function sanitizePath(p: string): string {
  if (DANGEROUS_CHARS.test(p)) {
    throw new Error('Path contains disallowed characters');
  }
  return p;
}

function shellQuote(p: string): string {
  return `'${sanitizePath(p).replace(/'/g, "'\\''")}'`;
}

function parseWslDirectoryEntries(raw: string, wslPath: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [type, sizeStr, mtimeStr, ctimeStr] = parts;
    const name = parts.slice(4).join('\t');
    if (!name) continue;
    const isDirectory = type === 'd';
    const entryPath = wslPath.endsWith('/') ? `${wslPath}${name}` : `${wslPath}/${name}`;
    const mtimeMs = Math.round(parseFloat(mtimeStr) * 1000);
    const ctimeMs = Math.round(parseFloat(ctimeStr) * 1000);
    entries.push({
      name,
      path: entryPath,
      isDirectory,
      size: parseInt(sizeStr, 10) || 0,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : undefined,
      // find(1) cannot print birth time; status-change time equals creation
      // time for freshly created files, which is what the UI sorts by.
      birthtimeMs: Number.isFinite(ctimeMs) ? ctimeMs : undefined,
    });
  }
  return entries;
}

function listWindowsDirectoryEntries(dirPath: string): DirectoryEntry[] {
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  const entries: DirectoryEntry[] = items.map((item) => {
    const fullPath = path.join(dirPath, item.name);
    let size = 0;
    let mtimeMs: number | undefined;
    let birthtimeMs: number | undefined;
    try {
      const stat = fs.statSync(fullPath);
      if (!item.isDirectory()) {
        size = stat.size;
      }
      mtimeMs = stat.mtimeMs;
      birthtimeMs = stat.birthtimeMs;
    } catch { /* skip */ }
    return {
      name: item.name,
      path: fullPath,
      isDirectory: item.isDirectory(),
      size,
      mtimeMs,
      birthtimeMs,
    };
  });
  // Dirs first, then alpha
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return entries;
}

export async function readFileContents(filePath: string, pathType: PathType): Promise<FileContent> {
  try {
    const lowerPath = filePath.toLowerCase();
    const isNotebook = lowerPath.endsWith('.ipynb') || lowerPath.endsWith('.pynb');
    const sizeLimit = isNotebook ? MAX_NOTEBOOK_SIZE : MAX_FILE_SIZE;

    if (pathType === 'wsl') {
      const wslPath = ensureWslPath(filePath, pathType);
      // Check size first
      const statResult = await wslExecCommand(`stat -c '%s' ${shellQuote(wslPath)}`, {
        timeout: WSL_TIMEOUT,
        maxBuffer: 1024,
        throwOnError: true,
      });
      const size = parseInt(statResult.stdout, 10);
      if (isNaN(size)) {
        return { path: filePath, content: '', encoding: 'utf-8', size: 0, error: 'Could not determine file size' };
      }
      if (size > sizeLimit) {
        return { path: filePath, content: '', encoding: 'utf-8', size, error: `File too large (${(size / 1024 / 1024).toFixed(1)}MB). Open in VS Code instead.` };
      }
      const contentResult = await wslExecCommand(`cat ${shellQuote(wslPath)}`, {
        timeout: WSL_TIMEOUT,
        maxBuffer: sizeLimit + 1024,
        throwOnError: true,
        trimOutput: false,
      });
      return { path: filePath, content: contentResult.stdout, encoding: 'utf-8', size };
    } else {
      // Windows path
      const stat = fs.statSync(filePath);
      if (stat.size > sizeLimit) {
        return { path: filePath, content: '', encoding: 'utf-8', size: stat.size, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Open in VS Code instead.` };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return { path: filePath, content, encoding: 'utf-8', size: stat.size };
    }
  } catch (err: any) {
    if (err.message?.includes('disallowed characters')) {
      return { path: filePath, content: '', encoding: 'utf-8', size: 0, error: err.message };
    }
    return { path: filePath, content: '', encoding: 'utf-8', size: 0, error: err.message || 'Failed to read file' };
  }
}

export async function listDirectoryEntriesAsync(dirPath: string, pathType: PathType): Promise<DirectoryEntry[]> {
  if (pathType !== 'wsl') {
    return listWindowsDirectoryEntries(dirPath);
  }

  const wslPath = sanitizePath(ensureWslPath(dirPath, pathType));
  const result = await wslExecCommand(
    `find ${shellQuote(wslPath)} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%C@\\t%f\\n' 2>/dev/null | sort -t$'\\t' -k1,1r -k5,5f`,
    { timeout: WSL_TIMEOUT, throwOnError: true, trimOutput: false }
  );
  return parseWslDirectoryEntries(result.stdout, wslPath);
}
