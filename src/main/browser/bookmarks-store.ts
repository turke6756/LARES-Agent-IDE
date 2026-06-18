// Embedded-browser bookmarks store (overhaul WP3-BM-MAIN).
//
// Thin persistence service over the `browser_bookmarks` table (declared in
// src/main/database.ts). The browser manager calls these; the manager — not
// this module — enforces the USER-PARTITION-ONLY invariant and validates the
// URL scheme (M6 defense-in-depth) before calling insertBookmark. This store
// just persists what it is given.
//
// Statements are prepared per-call (not at module load) because the shared db
// handle does not exist until initDatabase() runs; better-sqlite3 caches
// prepared statements internally, so the per-call prepare is cheap.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { Bookmark } from '../../shared/browser';

function rowToBookmark(row: any): Bookmark {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    createdAt: row.created_at,
    sortOrder: row.sort_order,
  };
}

/** All bookmarks in display order (sort_order ASC, then creation order). */
export function listBookmarks(): Bookmark[] {
  return getDb()
    .prepare('SELECT * FROM browser_bookmarks ORDER BY sort_order ASC, created_at ASC')
    .all()
    .map(rowToBookmark);
}

/** Insert a bookmark at the end of the list. Generates the id, stamps
 *  created_at = Date.now(), and assigns sort_order = max(existing) + 1. */
export function insertBookmark(input: { title: string; url: string }): Bookmark {
  const db = getDb();
  const id = uuidv4();
  const createdAt = Date.now();
  const { max } = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM browser_bookmarks')
    .get() as { max: number };
  const sortOrder = max + 1;
  db.prepare(
    'INSERT INTO browser_bookmarks (id, title, url, created_at, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(id, input.title, input.url, createdAt, sortOrder);
  return { id, title: input.title, url: input.url, createdAt, sortOrder };
}

export function deleteBookmark(id: string): void {
  getDb().prepare('DELETE FROM browser_bookmarks WHERE id = ?').run(id);
}

/** Persist a full manual ordering: orderedIds[i] gets sort_order = i. Ids not
 *  present in the table are silently ignored; ids omitted from the array keep
 *  their old sort_order (callers pass the complete set). */
export function reorderBookmarks(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE browser_bookmarks SET sort_order = ? WHERE id = ?');
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, i) => stmt.run(i, id));
  });
  tx(orderedIds);
}
