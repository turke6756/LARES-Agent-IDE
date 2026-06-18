// Embedded-browser session store (Slice 10/11 — session restore + persistent
// reopen stack).
//
// Thin persistence service over the `browser_session` and `browser_closed_tabs`
// tables (declared in src/main/database.ts). The browser MANAGER — not this
// module — enforces the USER-PARTITION-ONLY invariant and supplies the data
// (cross-cutting rule #1: agent URLs/favicons never reach SQLite). This store
// just persists/queries what it is given; the DB `partition` CHECK is a final
// defense-in-depth wall.
//
// Statements are prepared per-call (not at module load) because the shared db
// handle does not exist until initDatabase() runs; better-sqlite3 caches
// prepared statements internally, so the per-call prepare is cheap. Mirrors the
// bookmarks-store / history-store idiom.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

/** One restored/persisted session tab. USER PARTITION ONLY by construction. */
export interface SessionTabRow {
  tabId: string;
  workspaceId: string | null;
  url: string;
  title: string;
  favicon?: string;
  pinned: boolean;
  sortOrder: number;
  groupId: string | null;
  active: boolean;
  scrollY?: number;
}

/** One row of the persistent reopen stack. USER PARTITION ONLY. */
export interface ClosedTabRow {
  id: string;
  workspaceId: string | null;
  url: string;
  title: string;
  favicon?: string;
  groupId: string | null;
  closedAt: number;
}

function rowToSessionTab(row: any): SessionTabRow {
  return {
    tabId: row.tab_id,
    workspaceId: row.workspace_id ?? null,
    url: row.url,
    title: row.title ?? '',
    favicon: row.favicon ?? undefined,
    pinned: !!row.pinned,
    sortOrder: row.sort_order,
    groupId: row.group_id ?? null,
    active: !!row.active,
    scrollY: row.scroll_y == null ? undefined : row.scroll_y,
  };
}

/** The persisted session tabs in display order (sort_order ASC). */
export function loadSession(): SessionTabRow[] {
  return getDb()
    .prepare('SELECT * FROM browser_session ORDER BY sort_order ASC')
    .all()
    .map(rowToSessionTab);
}

/** Full rewrite of the session set in ONE transaction: DELETE all + bulk INSERT.
 *  The live+frozen set is small, so a wholesale replace is simplest + correct. */
export function replaceSession(rows: SessionTabRow[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO browser_session
       (tab_id, workspace_id, url, title, favicon, partition, pinned, sort_order, group_id, active, scroll_y, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction((toWrite: SessionTabRow[]) => {
    db.prepare('DELETE FROM browser_session').run();
    for (const r of toWrite) {
      insert.run(
        r.tabId,
        r.workspaceId,
        r.url,
        r.title ?? '',
        r.favicon ?? null,
        r.pinned ? 1 : 0,
        r.sortOrder,
        r.groupId ?? null,
        r.active ? 1 : 0,
        r.scrollY == null ? null : r.scrollY,
        now,
      );
    }
  });
  tx(rows);
}

/** Push a closed tab onto the persistent reopen stack and evict so no workspace
 *  keeps more than 25 (FIFO — oldest closed_at dropped), all in one txn. Uses
 *  `IS` for the nullable workspace match so the null/unscoped bucket caps too. */
export function pushClosedTab(row: Omit<ClosedTabRow, 'id'>): void {
  const db = getDb();
  const id = uuidv4();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO browser_closed_tabs
         (id, workspace_id, url, title, favicon, partition, group_id, closed_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`,
    ).run(
      id,
      row.workspaceId,
      row.url,
      row.title ?? '',
      row.favicon ?? null,
      row.groupId ?? null,
      row.closedAt,
    );
    db.prepare(
      `DELETE FROM browser_closed_tabs
        WHERE workspace_id IS ?
          AND id NOT IN (
            SELECT id FROM browser_closed_tabs
             WHERE workspace_id IS ?
             ORDER BY closed_at DESC
             LIMIT 25
          )`,
    ).run(row.workspaceId, row.workspaceId);
  });
  tx();
}

function rowToClosedTab(row: any): ClosedTabRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? null,
    url: row.url,
    title: row.title ?? '',
    favicon: row.favicon ?? undefined,
    groupId: row.group_id ?? null,
    closedAt: row.closed_at,
  };
}

/** Pop the newest closed tab for a workspace (by closed_at), deleting it. Null
 *  when the workspace's stack is empty. One transaction (read-then-delete). */
export function popClosedTab(workspaceId: string | null): ClosedTabRow | null {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        'SELECT * FROM browser_closed_tabs WHERE workspace_id IS ? ORDER BY closed_at DESC LIMIT 1',
      )
      .get(workspaceId) as any;
    if (!row) return null;
    db.prepare('DELETE FROM browser_closed_tabs WHERE id = ?').run(row.id);
    return rowToClosedTab(row);
  });
  return tx();
}

/** The closed_at of the newest closed tab for a workspace, or null if empty.
 *  Used by the reopen merge to compare the user (SQLite) side against the agent
 *  (in-memory) side without mutating the stack. */
export function peekNewestClosedAt(workspaceId: string | null): number | null {
  const row = getDb()
    .prepare(
      'SELECT closed_at FROM browser_closed_tabs WHERE workspace_id IS ? ORDER BY closed_at DESC LIMIT 1',
    )
    .get(workspaceId) as { closed_at: number } | undefined;
  return row ? row.closed_at : null;
}

/** Test helper: empty both tables. */
export function clearSession(): void {
  const db = getDb();
  db.prepare('DELETE FROM browser_session').run();
  db.prepare('DELETE FROM browser_closed_tabs').run();
}
