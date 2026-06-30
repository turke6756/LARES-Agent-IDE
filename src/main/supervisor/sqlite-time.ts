/**
 * Parse a SQLite `datetime('now')` timestamp ("YYYY-MM-DD HH:MM:SS", UTC, no
 * zone marker) to epoch ms. `Date.parse` treats the bare space-form as LOCAL
 * time, which skews any age computation by the full timezone offset, so we
 * normalize to ISO-UTC first. Falls through to plain `Date.parse` for any
 * already-ISO value (e.g. a stored `...Z` string); returns null when unparseable.
 *
 * Consumers needing epoch math should call this (or, if a stored numeric is
 * ever wanted, a derived `createdAtMs` field) — never re-stamp the `createdAt`
 * string itself: its space-form is load-bearing for display + lexical sort.
 */
export function parseSqliteUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
    ? Date.parse(s.replace(' ', 'T') + 'Z')
    : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
