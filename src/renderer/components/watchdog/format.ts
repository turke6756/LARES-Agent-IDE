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

/** "in ~12 min" / "in ~2 h" for the projected-time-to-limit hint; null → "". */
export function formatMinutesToLimit(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 90) return `~${Math.round(minutes)} min to limit`;
  return `~${(minutes / 60).toFixed(1)} h to limit`;
}
