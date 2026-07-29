// WP-6 — the reclaimed-history disclosure seam shared by every reader DTO.
//
// TWO invariants live here, and both are load-bearing:
//
//   1. The DB marker (`terminal_history_reclaimed_at`) is the ONE authority for
//      reclaimed state. NEVER derive it from ENOENT / a missing file / an empty
//      read — a file can be absent for many reasons; only the marker means "we
//      reclaimed it". The marker is an ISO string end-to-end: accept it ONLY as
//      a non-empty string. No epoch / `Date.parse` conversion ever happens, so
//      `reclaimedAt: NaN` is impossible (a corrupt / empty-string marker → null).
//
//   2. Fetch the marker AFTER the bounded read, never before. The marker is
//      written before the first unlink (WP-3 `beforeFirstUnlink`), so a read
//      that races a deletion must return empty bytes PLUS the notice. Fetching
//      before the read loses exactly that race — `readWithHistoryNotice`
//      enforces the order structurally.

import type { HistoryNotice } from '../../../shared/types';

/** Normalize a raw DB marker value into a `HistoryNotice`. Accepts ONLY a
 *  non-empty string (the column is ISO-8601, verbatim). `null` / `undefined` /
 *  empty string / any non-string → `null`. This is the sole reclaimed-state
 *  authority; callers must NOT infer it from missing files. */
export function historyNoticeFromMarker(marker: unknown): HistoryNotice {
  if (typeof marker === 'string' && marker.length > 0) {
    return { kind: 'retention-reclaimed', reclaimedAt: marker };
  }
  return null;
}

/** Run a bounded read, THEN fetch the marker, and attach it to the result. The
 *  ordering is the point: `noticeAfter` is invoked only after `read` resolves,
 *  so a marker written mid-read (a deletion racing this read) is still surfaced.
 *  The read's own empty-on-ENOENT contract supplies the empty bytes. */
export async function readWithHistoryNotice<T extends object>(
  read: () => Promise<T>,
  noticeAfter: () => HistoryNotice,
): Promise<T & { historyNotice: HistoryNotice }> {
  const result = await read();
  const historyNotice = noticeAfter();
  return { ...result, historyNotice };
}
