// Embedded-browser per-site zoom store (Slice 15 — per-site zoom + find-in-page
// upgrades). A thin persistence service over the `browser_zoom` table (declared
// in src/main/database.ts). Zoom is keyed by ORIGIN (new URL(url).origin) and is
// USER-PARTITION ONLY by contract — the browser manager applies the persisted
// factor on a committed USER-tab navigation (fallback 100% when no row) and
// writes a row only for a user tab's origin. Agent zoom stays per-tab and is
// NEVER persisted (cross-cutting rule #1 / persistence half of M9).
//
// Statements are prepared per-call (the shared db handle does not exist until
// initDatabase() runs; better-sqlite3 caches prepared statements internally, so
// this is cheap). Mirrors the downloads-store / session-store / history-store
// idiom — the lazy getDb() require keeps this importable by plain-node tests
// without pulling in the Electron-ABI better-sqlite3 binary.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../database').getDb();
}

/** One persisted per-origin zoom row. */
export interface ZoomEntry {
  origin: string;
  zoomFactor: number;
  updatedAt: number;
}

/** The persisted zoom factor for an origin, or undefined when none is stored
 *  (the manager falls back to 100% / 1.0). */
export function getZoom(origin: string): number | undefined {
  const row = db()
    .prepare('SELECT zoom_factor FROM browser_zoom WHERE origin = ?')
    .get(origin) as { zoom_factor: number } | undefined;
  return row ? row.zoom_factor : undefined;
}

/** Upsert the zoom factor for an origin (USER partition only — the manager
 *  gates the partition before calling). */
export function setZoom(origin: string, zoomFactor: number, now = Date.now()): void {
  db()
    .prepare(
      `INSERT INTO browser_zoom (origin, zoom_factor, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(origin) DO UPDATE SET zoom_factor = excluded.zoom_factor,
                                         updated_at  = excluded.updated_at`,
    )
    .run(origin, zoomFactor, now);
}

/** Clear the stored zoom for an origin → it reverts to 100% on next navigation
 *  ("Reset" semantics). No-op when no row exists. */
export function clearZoom(origin: string): void {
  db().prepare('DELETE FROM browser_zoom WHERE origin = ?').run(origin);
}

/** All persisted per-origin zoom rows (newest first). */
export function listZoom(): ZoomEntry[] {
  return (
    db()
      .prepare('SELECT origin, zoom_factor, updated_at FROM browser_zoom ORDER BY updated_at DESC')
      .all() as Array<{ origin: string; zoom_factor: number; updated_at: number }>
  ).map((r) => ({ origin: r.origin, zoomFactor: r.zoom_factor, updatedAt: r.updated_at }));
}

/** Test helper: empty the table. */
export function clearAllZoom(): void {
  db().prepare('DELETE FROM browser_zoom').run();
}
