// Embedded-browser history store (overhaul WP4-HIST-MAIN).
//
// Thin persistence service over the `browser_history` table (declared in
// src/main/database.ts). The browser manager records a visit ONLY for
// user-partition navigations that pass the M6 scheme gate — this module never
// sees agent-partition URLs by construction. It just persists/queries what it
// is given (persistence half of the M9 discipline).
//
// Statements are prepared per-call (not at module load) because the shared db
// handle does not exist until initDatabase() runs.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { HistoryEntry } from '../../shared/browser';

function rowToHistoryEntry(row: any): HistoryEntry {
  return {
    id: row.id,
    url: row.url,
    title: row.title ?? '',
    visitedAt: row.visited_at,
    visitCount: row.visit_count,
    favicon: row.favicon ?? null,
  };
}

/** Record a visit, deduped by URL. If the URL already exists, bump its
 *  visit_count, refresh visited_at, and update the title (titles can change
 *  between visits / resolve after navigation). Otherwise insert a new row with
 *  visit_count = 1. */
export function recordVisit(url: string, title: string, favicon?: string | null): void {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare('SELECT id FROM browser_history WHERE url = ?')
    .get(url) as { id: string } | undefined;
  if (existing) {
    // Keep a known favicon when this visit has none (COALESCE keeps the old one
    // rather than blanking it on a favicon-less navigation event).
    db.prepare(
      'UPDATE browser_history SET visit_count = visit_count + 1, visited_at = ?, title = ?, favicon = COALESCE(?, favicon) WHERE id = ?'
    ).run(now, title, favicon ?? null, existing.id);
  } else {
    db.prepare(
      'INSERT INTO browser_history (id, url, title, visited_at, visit_count, favicon) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(uuidv4(), url, title, now, favicon ?? null);
  }
}

/** List history newest-first. When `query` is given, filter to rows whose
 *  title OR url contains it (LIKE substring match). Defaults: limit 100,
 *  offset 0. */
export function listHistory(q: { query?: string; limit?: number; offset?: number }): HistoryEntry[] {
  const db = getDb();
  const limit = q.limit ?? 100;
  const offset = q.offset ?? 0;
  const query = q.query?.trim();
  if (query) {
    const like = `%${query}%`;
    return db
      .prepare(
        'SELECT * FROM browser_history WHERE title LIKE ? OR url LIKE ? ORDER BY visited_at DESC LIMIT ? OFFSET ?'
      )
      .all(like, like, limit, offset)
      .map(rowToHistoryEntry);
  }
  return db
    .prepare('SELECT * FROM browser_history ORDER BY visited_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset)
    .map(rowToHistoryEntry);
}

/** Slice-6 (omnibox): history rows matching `query` (title OR url LIKE),
 *  ranked by FREQUENCY (visit_count DESC) then RECENCY (visited_at DESC) — the
 *  ordering the omnibox suggester wants, distinct from listHistory's pure
 *  newest-first. An empty query returns nothing (the omnibox only queries when
 *  the user has typed something). USER-PARTITION ONLY by construction. */
export function searchHistoryRanked(query: string, limit = 30): HistoryEntry[] {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q}%`;
  return getDb()
    .prepare(
      'SELECT * FROM browser_history WHERE title LIKE ? OR url LIKE ? ORDER BY visit_count DESC, visited_at DESC LIMIT ?',
    )
    .all(like, like, limit)
    .map(rowToHistoryEntry);
}

/** Slice-8 (premium browser): the most-visited user-partition sites, ordered by
 *  FREQUENCY (visit_count DESC) then RECENCY (visited_at DESC). Consumed by the
 *  NTP top-sites grid (Slice-9). USER-PARTITION ONLY by construction — agent
 *  navigations are never written to this table. */
export function topSites(limit = 8): HistoryEntry[] {
  return getDb()
    .prepare(
      'SELECT * FROM browser_history ORDER BY visit_count DESC, visited_at DESC LIMIT ?',
    )
    .all(limit)
    .map(rowToHistoryEntry);
}

export function deleteHistory(id: string): void {
  getDb().prepare('DELETE FROM browser_history WHERE id = ?').run(id);
}

export function clearHistory(): void {
  getDb().prepare('DELETE FROM browser_history').run();
}
