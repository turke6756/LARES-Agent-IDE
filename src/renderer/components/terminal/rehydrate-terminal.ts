// WP-3c — unified epoch/cursor terminal rehydrate.
//
// This module owns the "reopen a terminal and replay its history EXACTLY ONCE"
// logic, factored out of the React component so it can be unit-tested against
// plain injected deps (no xterm, no IPC, no DOM). The component wires the real
// `window.api.terminal.*` calls + the xterm write coordinator into `deps` and
// feeds it the live chunks it buffered while the async attach round-tripped.
//
// The append-only `.log` byte offset is the replay CURSOR. Every chunk (history
// pages, buffered live bytes, steady-state live bytes) carries the logical end
// offset it occupies in the `.log`; dedup is a pure offset comparison. That is
// what makes replay exact-once across the attach round-trip, range paging, and
// the range→straddle→live seam without dropping or double-writing a byte.
//
// Three history sources, selected by the attach result:
//   3a DEGRADED  — a log-write error this epoch invalidated the offset↔file
//                  mapping; recover from the runner's in-memory ring snapshot +
//                  its LOGICAL cursor, never `.log` replay. Show a history
//                  warning (distinct from truncation).
//   3b HEALTHY   — a valid checkpoint (+ exact range catch-up to the cutoff),
//                  else a live cold tail, else a dead-agent snapshot. Show a
//                  truncation banner when a byte bound was hit.

import type {
  HistoryNotice,
  TerminalAttachResult,
  TerminalCheckpointLoad,
  TerminalLogRange,
  TerminalLogTail,
  TerminalRingSnapshot,
  TerminalDeadSnapshot,
} from '../../../shared/types';

/** A live PTY chunk buffered during (or after) the attach round-trip.
 *  `startOffset` / `endOffset` are the chunk's logical byte span in the `.log`.
 *  A chunk whose offsets are unknown uses ±Infinity so it is always treated as
 *  fresh (never silently deduped away). */
export interface BufferedChunk {
  data: string;
  startOffset: number;
  endOffset: number;
}

export type ChunkAction =
  | { kind: 'drop' }
  | { kind: 'write'; data: string | Uint8Array; endOffset: number };

/**
 * Reconcile ONE chunk against the applied replay cursor. Pure. This is the
 * exact-once heart of the rehydrate:
 *   - fully behind the cursor (endOffset <= applied)      → drop (duplicate)
 *   - fully ahead of the cursor (startOffset >= applied)  → write whole
 *   - straddling the cursor (start < applied < end)       → write only the
 *     not-yet-applied BYTE suffix (offset arithmetic is on UTF-8 bytes, so the
 *     trim is byte-exact and joins losslessly with the already-applied prefix
 *     in xterm's streaming decoder).
 */
export function reconcileChunk(
  chunk: BufferedChunk,
  appliedOffset: number,
  encode: (s: string) => Uint8Array,
): ChunkAction {
  if (chunk.endOffset <= appliedOffset) return { kind: 'drop' };
  if (chunk.startOffset >= appliedOffset) {
    return { kind: 'write', data: chunk.data, endOffset: chunk.endOffset };
  }
  const trimmed = encode(chunk.data).subarray(appliedOffset - chunk.startOffset);
  return { kind: 'write', data: trimmed, endOffset: chunk.endOffset };
}

/** Mutable cursor state the orchestrator advances. The component passes its
 *  cache entry (structurally compatible) so the fields land on the live entry. */
export interface RehydrateState {
  appliedOffset: number;
  logOffsetsReliable: boolean;
  epoch: string;
}

export interface RehydrateDeps {
  attach(): Promise<TerminalAttachResult>;
  loadCheckpoint(snapshotCutoff: number): Promise<TerminalCheckpointLoad | null>;
  readLogRange(start: number, end: number): Promise<TerminalLogRange>;
  readLogTail(maxBytes: number, endExclusive: number): Promise<TerminalLogTail>;
  getRingSnapshot(): Promise<TerminalRingSnapshot | null>;
  readDeadAgentSnapshot(): Promise<TerminalDeadSnapshot>;
  /** Apply bytes to xterm (always cursor-neutral — the orchestrator owns the
   *  cursor via `state`). Returns when xterm has consumed the write. */
  write(data: string | Uint8Array): Promise<void>;
  showTruncationBanner(b: { retainedBytes: number; snapshotTotal: number }): void;
  showHistoryWarning(): void;
  /** WP-7: reclaimed-history disclosure (the DB marker travelled through a DTO's
   *  `historyNotice`). Surfaced as an OVERLAY, never written into the xterm
   *  stream. Called at most once per reopen (deduped in the orchestrator). */
  showReclaimedBanner(b: { reclaimedAt: string }): void;
  /** WP-7: a dead agent whose `.scrollback` AND `.log` are both absent
   *  (`TerminalDeadSnapshot.missing`) — a distinct warning from the reclaimed
   *  notice. Also an overlay only. */
  showHistoryUnavailable(): void;
  maxReplayBytes: number;
}

export interface RehydrateResult {
  /** true when a live subscription exists and buffered/live chunks must be
   *  drained against `state.appliedOffset` (healthy-live and degraded paths);
   *  false for a dead reopen (no live bytes will arrive). */
  live: boolean;
}

/**
 * Apply a reopened terminal's history into xterm, advancing `state` to the
 * exact byte cursor the caller must dedup live chunks against. Never writes a
 * byte twice and never drops one silently — over-budget history surfaces as a
 * structured banner.
 */
export async function rehydrateTerminalHistory(
  state: RehydrateState,
  deps: RehydrateDeps,
): Promise<RehydrateResult> {
  const att = await deps.attach();

  // WP-7 — surface the reclaimed-history overlay IMMEDIATELY, before ANY later
  // read (ring snapshot, checkpoint, range, tail, dead snapshot) can throw. The
  // marker is DISCLOSURE, never a gate: a revived agent carries the marker AND
  // real post-reclamation bytes, so we still replay below and only ADD the
  // overlay here. Deduped: at most one call per reopen, even though later reads
  // also carry the notice.
  let reclaimedSurfaced = false;
  const surfaceNotice = (notice: HistoryNotice | undefined): void => {
    if (!notice || notice.kind !== 'retention-reclaimed') return;
    // Locked-types contract: accept the marker ONLY when it is a non-empty
    // string, so `reclaimedAt: NaN`/'' can never reach the overlay.
    if (typeof notice.reclaimedAt !== 'string' || notice.reclaimedAt === '') return;
    if (reclaimedSurfaced) return;
    reclaimedSurfaced = true;
    deps.showReclaimedBanner({ reclaimedAt: notice.reclaimedAt });
  };
  surfaceNotice(att.historyNotice);

  const cutoff = att.snapshotCutoff ?? 0;
  state.epoch = att.terminalEpoch ?? '';

  // ── 3a. Degraded recovery ────────────────────────────────────────────
  // The `.log` offsets are no longer valid replay positions this epoch. Use the
  // runner's atomic ring snapshot + its LOGICAL cursor; every reopen this epoch
  // repeats this (no checkpoint, no `.log` replay).
  if (att.live && att.degraded) {
    const snap = await deps.getRingSnapshot();
    const text = snap?.text ?? '';
    const logicalCutoff = snap?.logicalCutoff ?? cutoff;
    await deps.write(text);
    state.appliedOffset = logicalCutoff;
    state.logOffsetsReliable = false;
    deps.showHistoryWarning();
    return { live: true };
  }

  // ── 3b. Healthy ──────────────────────────────────────────────────────
  const ckpt = await deps.loadCheckpoint(cutoff);
  if (ckpt && cutoff - ckpt.appliedOffset <= deps.maxReplayBytes) {
    // Serialized buffer FIRST, then page EXACT ranges to the cutoff so nothing
    // between the checkpoint and now is lost. Advance by endOffset, never
    // fileSize (which grows during replay).
    await deps.write(ckpt.serialized);
    state.appliedOffset = ckpt.appliedOffset;
    let pos = ckpt.appliedOffset;
    while (pos < cutoff) {
      const r = await deps.readLogRange(pos, Math.min(pos + deps.maxReplayBytes, cutoff));
      surfaceNotice(r.historyNotice);
      await deps.write(r.bytes);
      if (r.endOffset <= pos) break; // no forward progress (EOF/short) — stop
      pos = r.endOffset;
      state.appliedOffset = pos;
    }
    state.appliedOffset = cutoff;
    return { live: att.live === true };
  }

  if (att.live) {
    // No / rejected checkpoint → cold tail, rune-aligned at the head by
    // `readFileTail`. `appliedOffset` becomes the tail's real end (== cutoff).
    const tail = await deps.readLogTail(deps.maxReplayBytes, cutoff);
    surfaceNotice(tail.historyNotice);
    await deps.write(tail.bytes);
    state.appliedOffset = tail.endOffset;
    if (tail.truncated) {
      deps.showTruncationBanner({
        retainedBytes: cutoff - tail.startOffset,
        snapshotTotal: cutoff,
      });
    }
    return { live: true };
  }

  // Dead, no valid checkpoint → `.scrollback` else a capped `.log` tail.
  const s = await deps.readDeadAgentSnapshot();
  surfaceNotice(s.historyNotice);
  // WP-7: both fallback files absent → a distinct "history unavailable" warning
  // (never inferred from an empty snapshot — see `TerminalDeadSnapshot.missing`).
  if (s.missing) deps.showHistoryUnavailable();
  await deps.write(s.text);
  state.appliedOffset = cutoff;
  if (s.truncated) {
    deps.showTruncationBanner({ retainedBytes: s.retainedBytes, snapshotTotal: cutoff });
  }
  return { live: false };
}
