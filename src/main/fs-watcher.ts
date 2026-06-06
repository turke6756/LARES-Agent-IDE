import chokidar, { FSWatcher } from 'chokidar';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';
import { wslSpawn, isInotifywaitAvailable } from './wsl-bridge';
import { listDirectoryEntriesAsync } from './file-reader';
import { ensureWslPath } from './path-utils';
import type { FsEvent, PathType } from '../shared/types';

type Listener = (event: FsEvent) => void;

interface Watcher {
  listeners: Set<Listener>;
  close: () => void;
}

const watchers = new Map<string, Watcher>();
const POLL_INTERVAL_MS = 2000;
const POLL_BACKOFF_MS = [POLL_INTERVAL_MS, 5000, 10000, 30000];

function keyFor(dirPath: string, pathType: PathType): string {
  return `${pathType}:${dirPath}`;
}

function backendPath(dirPath: string, pathType: PathType): string {
  return pathType === 'wsl' ? ensureWslPath(dirPath, pathType) : dirPath;
}

function emit(key: string, event: FsEvent): void {
  const w = watchers.get(key);
  if (!w) return;
  for (const cb of w.listeners) {
    try { cb(event); } catch (err) { console.error('fs-watcher listener error:', err); }
  }
}

function isMountedWindowsDrive(wslPath: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(wslPath);
}

function startWindowsWatcher(dirPath: string, key: string): () => void {
  const w = chokidar.watch(dirPath, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
  }) as FSWatcher;

  w.on('add', (p) => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* ignore */ }
    emit(key, { type: 'add', path: p, parentDir: dirPath, isDirectory: false, size });
  });
  w.on('addDir', (p) => {
    if (p === dirPath) return;
    emit(key, { type: 'add', path: p, parentDir: dirPath, isDirectory: true, size: 0 });
  });
  w.on('unlink', (p) => emit(key, { type: 'unlink', path: p, parentDir: dirPath }));
  w.on('unlinkDir', (p) => emit(key, { type: 'unlink', path: p, parentDir: dirPath }));
  w.on('change', (p) => emit(key, { type: 'change', path: p, parentDir: dirPath }));
  w.on('error', (err) => console.error('chokidar error:', err));

  return () => { void w.close(); };
}

function startWslInotifyWatcher(dirPath: string, key: string): () => void {
  const quoted = dirPath.replace(/'/g, "'\\''");
  const fmt = '%e\\t%w%f';
  const events = 'create,delete,moved_to,moved_from,close_write,attrib';
  const cmd = `inotifywait -qm --format '${fmt}' -e ${events} '${quoted}'`;
  const proc: ChildProcess = wslSpawn(cmd);

  const rl = readline.createInterface({ input: proc.stdout! });
  rl.on('line', (line) => {
    const sep = line.indexOf('\t');
    if (sep < 0) return;
    const evsRaw = line.slice(0, sep);
    const fullPath = line.slice(sep + 1);
    if (!fullPath) return;
    const evs = new Set(evsRaw.split(','));
    const isDir = evs.has('ISDIR');

    if (evs.has('CREATE') || evs.has('MOVED_TO')) {
      let size = 0;
      if (!isDir) {
        try { size = fs.statSync(toUnc(dirPath, fullPath)).size; } catch { /* best-effort */ }
      }
      emit(key, { type: 'add', path: fullPath, parentDir: dirPath, isDirectory: isDir, size });
    } else if (evs.has('DELETE') || evs.has('MOVED_FROM')) {
      emit(key, { type: 'unlink', path: fullPath, parentDir: dirPath });
    } else if (evs.has('CLOSE_WRITE')) {
      emit(key, { type: 'change', path: fullPath, parentDir: dirPath });
    }
  });

  proc.stderr?.on('data', (buf) => {
    const text = buf.toString();
    if (text.trim()) console.error('inotifywait stderr:', text.trim());
  });
  proc.on('error', (err) => console.error('inotifywait spawn error:', err));

  return () => {
    try { proc.kill(); } catch { /* ignore */ }
    rl.close();
  };
}

function toUnc(wslDir: string, wslEntryPath: string): string {
  // Best-effort conversion for size stat. If it fails, we just skip sizing.
  // wslEntryPath may be absolute (e.g. /home/turke/foo/bar.txt). We don't know the distro,
  // so rely on \\wsl.localhost\Ubuntu\... by default. If this fails, size stays 0.
  const rel = wslEntryPath.startsWith(wslDir)
    ? wslEntryPath.slice(wslDir.length).replace(/^\//, '')
    : '';
  if (!rel) return '';
  return path.join('\\\\wsl.localhost\\Ubuntu', wslEntryPath.replace(/\//g, '\\'));
}

interface PollEntryMeta {
  isDirectory: boolean;
  size: number;
  mtimeMs?: number;
}

function startPollingWatcher(dirPath: string, pathType: PathType, key: string): () => void {
  let previous = new Map<string, PollEntryMeta>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let inFlight = false;
  let initialized = false;
  let consecutiveFailures = 0;

  const nextDelay = (): number =>
    POLL_BACKOFF_MS[Math.min(Math.max(consecutiveFailures - 1, 0), POLL_BACKOFF_MS.length - 1)];

  const schedule = (delay: number): void => {
    if (closed) return;
    timer = setTimeout(() => {
      void poll();
    }, delay);
  };

  const loadCurrent = async (): Promise<Map<string, PollEntryMeta>> => {
    const current = new Map<string, PollEntryMeta>();
    for (const e of await listDirectoryEntriesAsync(dirPath, pathType)) {
      current.set(e.path, { isDirectory: e.isDirectory, size: e.size, mtimeMs: e.mtimeMs });
    }
    return current;
  };

  const poll = async (): Promise<void> => {
    if (closed) return;
    if (inFlight) {
      schedule(nextDelay());
      return;
    }
    inFlight = true;
    try {
      const current = await loadCurrent();
      if (closed) return;
      consecutiveFailures = 0;

      if (!initialized) {
        previous = current;
        initialized = true;
        return;
      }

      // adds
      for (const [p, meta] of current) {
        const prev = previous.get(p);
        if (!prev) {
          emit(key, { type: 'add', path: p, parentDir: dirPath, isDirectory: meta.isDirectory, size: meta.size });
        } else if (!meta.isDirectory && (prev.size !== meta.size || prev.mtimeMs !== meta.mtimeMs)) {
          emit(key, { type: 'change', path: p, parentDir: dirPath });
        }
      }
      // removes
      for (const p of previous.keys()) {
        if (!current.has(p)) {
          emit(key, { type: 'unlink', path: p, parentDir: dirPath });
        }
      }
      previous = current;
    } catch (err) {
      consecutiveFailures += 1;
      console.error(`[fs-watcher] polling failed for ${dirPath}; retrying in ${nextDelay()}ms:`, err);
    } finally {
      inFlight = false;
      schedule(nextDelay());
    }
  };

  schedule(0);

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
  };
}

async function startBackend(dirPath: string, pathType: PathType, key: string): Promise<() => void> {
  const watchPath = backendPath(dirPath, pathType);
  if (pathType === 'windows') {
    return startWindowsWatcher(watchPath, key);
  }
  // WSL
  if (isMountedWindowsDrive(watchPath)) {
    return startPollingWatcher(watchPath, pathType, key);
  }
  const hasInotify = await isInotifywaitAvailable();
  if (!hasInotify) {
    console.warn(
      `[fs-watcher] inotifywait not found in WSL — falling back to polling for "${dirPath}". ` +
      `Install with: sudo apt install inotify-tools`
    );
    return startPollingWatcher(watchPath, pathType, key);
  }
  return startWslInotifyWatcher(watchPath, key);
}

export function subscribe(dirPath: string, pathType: PathType, listener: Listener): () => void {
  const key = keyFor(dirPath, pathType);
  let w = watchers.get(key);
  if (!w) {
    const placeholder: Watcher = { listeners: new Set(), close: () => {} };
    watchers.set(key, placeholder);
    w = placeholder;
    // Start backend async; if it errors, keep the watcher entry but without backend.
    startBackend(dirPath, pathType, key).then((close) => {
      const current = watchers.get(key);
      if (current) current.close = close;
      else close(); // already unsubscribed before backend finished starting
    }).catch((err) => {
      console.error(`[fs-watcher] failed to start backend for ${key}:`, err);
    });
  }
  w.listeners.add(listener);
  return () => {
    const current = watchers.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.close();
      watchers.delete(key);
    }
  };
}

export function closeAllWatchers(): void {
  for (const w of watchers.values()) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers.clear();
}
