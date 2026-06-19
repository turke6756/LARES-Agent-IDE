// Embedded-browser downloads store (Slice 13 — user-only downloads with the
// decision gate APPROVED+EXTENDED 2026-06-17: agents may download only from
// allowlisted origins; user downloads require a trusted-chrome confirmation;
// ALL downloads are audited, saved into an app-managed dir, with filenames
// normalized / path-traversal blocked).
//
// Two responsibilities, deliberately co-located so the security-critical
// filename normalization is a PURE, separately-testable function with no
// Electron / DB coupling:
//
//   1. normalizeDownloadFilename() / isPathWithinDir() — the path-traversal
//      chokepoint. PURE (only `path`); unit-tested in downloads.test.ts. The
//      manager calls these before ever handing a save path to Electron.
//   2. A thin persistence service over the `browser_downloads` table (declared
//      in src/main/database.ts). Statements are prepared per-call (the shared db
//      handle does not exist until initDatabase() runs; better-sqlite3 caches
//      prepared statements internally, so this is cheap). Mirrors the
//      session-store / history-store idiom.
//
// Security: this table lives in the dashboard DB under userData — NOT
// agent-writable. The manager enforces the runtime decision gate; this store
// just persists/queries what it is given (the DB CHECKs are a final wall).

import path from 'path';
import type { BrowserDownload, BrowserDownloadState, BrowserPartition } from '../../shared/browser';

/** Fallback name when the suggested filename is empty / pure-dots / unusable. */
const DEFAULT_DOWNLOAD_NAME = 'download';
/** Conservative cap well under the common 255-byte filesystem limit. */
const MAX_FILENAME_LEN = 200;

/**
 * Normalize an untrusted suggested download filename into a SAFE basename that
 * cannot escape the downloads dir. The single path-traversal chokepoint:
 *   - take only the basename (split on BOTH '/' and '\' so a Windows-style or
 *     POSIX-style path component cannot survive);
 *   - strip control chars and characters illegal on common filesystems
 *     (<>:"|?* and NUL..0x1f) → '_';
 *   - collapse surrounding whitespace;
 *   - reject pure-dot names ('', '.', '..', '...') → the default name;
 *   - strip LEADING dots (so '..foo' / '.htaccess' can't reintroduce traversal
 *     or a hidden-file surprise);
 *   - cap the length, preserving any extension.
 * The result NEVER contains a path separator, is never '.' or '..', and never
 * starts with a dot — so path.join(dir, result) is always strictly inside dir.
 */
export function normalizeDownloadFilename(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  // basename only — drop every directory component (POSIX + Windows separators).
  const parts = name.split(/[/\\]/);
  name = parts[parts.length - 1] ?? '';
  // illegal / control characters → underscore.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f<>:"|?*]/g, '_');
  name = name.trim();
  // pure-dot names (incl. '.', '..', '...') carry no real name → default.
  if (name === '' || /^\.+$/.test(name)) return DEFAULT_DOWNLOAD_NAME;
  // strip leading dots so a residual '..'-prefix or hidden-file form is defused.
  name = name.replace(/^\.+/, '');
  if (name === '') return DEFAULT_DOWNLOAD_NAME;
  if (name.length > MAX_FILENAME_LEN) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, Math.max(1, MAX_FILENAME_LEN - ext.length)) + ext;
  }
  return name;
}

/**
 * Defense-in-depth confinement check: is `target` strictly inside `dir`?
 * Returns false for the dir itself, for any '..' escape, and for an absolute
 * path that resolves elsewhere. The manager uses this AFTER joining a
 * normalized filename — belt-and-braces atop normalizeDownloadFilename().
 */
export function isPathWithinDir(target: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ── DB persistence ───────────────────────────────────────────────────────────
// Lazy getDb() require keeps the pure helpers above importable by a plain-node
// test WITHOUT pulling in better-sqlite3 (which is built against Electron's ABI
// and won't load under the system Node the supervisor test runner uses).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../database').getDb();
}

export interface DownloadInsert {
  id: string;
  url: string;
  filename: string;
  savePath: string;
  partition: BrowserPartition;
  workspaceId: string | null;
  origin: string;
  totalBytes: number;
  startedAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDownload(row: any): BrowserDownload {
  return {
    id: row.id,
    url: row.url,
    filename: row.filename,
    savePath: row.save_path,
    partition: row.partition,
    workspaceId: row.workspace_id ?? null,
    origin: row.origin ?? '',
    bytesReceived: row.bytes_received ?? 0,
    totalBytes: row.total_bytes ?? 0,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
  };
}

/** Insert a fresh in-progress download record. */
export function insertDownload(input: DownloadInsert): BrowserDownload {
  db()
    .prepare(
      `INSERT INTO browser_downloads
         (id, url, filename, save_path, partition, workspace_id, origin,
          bytes_received, total_bytes, state, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'in-progress', ?, NULL)`,
    )
    .run(
      input.id,
      input.url,
      input.filename,
      input.savePath,
      input.partition,
      input.workspaceId,
      input.origin,
      input.totalBytes,
      input.startedAt,
    );
  return {
    id: input.id,
    url: input.url,
    filename: input.filename,
    savePath: input.savePath,
    partition: input.partition,
    workspaceId: input.workspaceId,
    origin: input.origin,
    bytesReceived: 0,
    totalBytes: input.totalBytes,
    state: 'in-progress',
    startedAt: input.startedAt,
    endedAt: null,
  };
}

/** Update byte progress for an in-flight download. Returns the fresh record
 *  (or undefined if the id is unknown / already removed). */
export function updateDownloadProgress(
  id: string,
  bytesReceived: number,
  totalBytes: number,
): BrowserDownload | undefined {
  db()
    .prepare('UPDATE browser_downloads SET bytes_received = ?, total_bytes = ? WHERE id = ?')
    .run(bytesReceived, totalBytes, id);
  return getDownload(id);
}

/** Flip a download's terminal state and stamp ended_at. */
export function setDownloadState(
  id: string,
  state: BrowserDownloadState,
  endedAt: number | null,
): BrowserDownload | undefined {
  db()
    .prepare('UPDATE browser_downloads SET state = ?, ended_at = ? WHERE id = ?')
    .run(state, endedAt, id);
  return getDownload(id);
}

export function getDownload(id: string): BrowserDownload | undefined {
  const row = db().prepare('SELECT * FROM browser_downloads WHERE id = ?').get(id);
  return row ? rowToDownload(row) : undefined;
}

/** All downloads, newest first (capped). */
export function listDownloads(limit = 200): BrowserDownload[] {
  return db()
    .prepare('SELECT * FROM browser_downloads ORDER BY started_at DESC LIMIT ?')
    .all(limit)
    .map(rowToDownload);
}

export function removeDownload(id: string): void {
  db().prepare('DELETE FROM browser_downloads WHERE id = ?').run(id);
}

/** Test helper: empty the table. */
export function clearDownloads(): void {
  db().prepare('DELETE FROM browser_downloads').run();
}
