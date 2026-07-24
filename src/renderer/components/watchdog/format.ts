// Small formatting helpers for the memory-watchdog surfaces (incident-2026-07-11
// §5 D5). Kept local to the watchdog folder — no shared util exists and these are
// only used by the meter / banner / orphan-sweep panel.

/** Human-readable bytes: "1.4 GB", "812 MB", "0 B". Never throws. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Compact "how long has this been idle" from a registry idleSince string:
 *  "42m", "3h", "2d"; "unknown" when unparseable. */
export function idleFor(idleSince: string): string {
  // SQLite `datetime('now')` has no zone marker and must not be read as local.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(idleSince)
    ? `${idleSince.replace(' ', 'T')}Z`
    : idleSince;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return 'unknown';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}
