// WP-3b — serialize-checkpoint sidecar I/O.
//
// A checkpoint is a single `${logPath}.checkpoint` JSON sidecar holding the
// `@xterm/addon-serialize` output captured when a terminal view is evicted, plus
// the epoch it was captured under and the `.log` byte offset already applied to
// that serialized buffer. One file per agent ⇒ inherently bounded; reclaimed on
// delete (WP-1 `SIDECARS`) and on fresh launch / rebound.
//
// These functions are PURE FILE I/O. Epoch / degraded / cutoff validation is the
// supervisor's job (`saveTerminalCheckpoint` / `loadTerminalCheckpoint`) — never
// duplicated here.

import * as fs from 'fs';

export interface TerminalCheckpoint {
  /** Terminal epoch the serialized buffer was captured under. */
  epoch: string;
  /** `@xterm/addon-serialize` output. */
  serialized: string;
  /** `.log` byte offset already reflected in `serialized`. */
  appliedOffset: number;
}

const checkpointPath = (logPath: string): string => logPath + '.checkpoint';
const checkpointTmpPath = (logPath: string): string => logPath + '.checkpoint.tmp';

/** WP-3b SAVE guard (pure). A checkpoint may be persisted ONLY when its capture
 *  epoch equals the agent's current epoch AND the epoch is not degraded. A null
 *  current epoch (agent never launched this process) is always a reject. Kept
 *  pure so the guard is unit-testable without the supervisor. */
export function checkpointSaveAllowed(
  saveEpoch: string,
  currentEpoch: string | null,
  offsetsReliable: boolean,
): boolean {
  return currentEpoch !== null && saveEpoch === currentEpoch && offsetsReliable;
}

/** WP-3b LOAD guard (pure). A stored checkpoint is valid to apply ONLY when its
 *  epoch equals the current epoch AND its `appliedOffset` is within the durable
 *  attach cutoff (it must not claim bytes past what attach proved readable). A
 *  null current epoch is always a reject. */
export function checkpointLoadValid(
  cp: TerminalCheckpoint,
  currentEpoch: string | null,
  snapshotCutoff: number,
): boolean {
  return currentEpoch !== null && cp.epoch === currentEpoch && cp.appliedOffset <= snapshotCutoff;
}

/** Persist a checkpoint atomically: write `${logPath}.checkpoint.tmp` then rename
 *  over `${logPath}.checkpoint`. On ANY failure the `.tmp` is removed and the
 *  error rethrown, so a partial write never survives as a live checkpoint. The
 *  caller MUST have validated epoch + non-degraded before calling. */
export async function writeTerminalCheckpoint(logPath: string, cp: TerminalCheckpoint): Promise<void> {
  const tmp = checkpointTmpPath(logPath);
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(cp), 'utf8');
    await fs.promises.rename(tmp, checkpointPath(logPath));
  } catch (err) {
    // Best-effort cleanup of the partial tmp; surface the original failure.
    try { await fs.promises.unlink(tmp); } catch { /* ENOENT or racing unlink — ignore */ }
    throw err;
  }
}

/** Read + parse the checkpoint sidecar. Returns null on ENOENT OR on a malformed
 *  / incomplete payload — a corrupt checkpoint is treated as absent (fail-safe:
 *  the renderer falls back to cold-tail / `.scrollback`), never thrown at a
 *  caller mid-rehydrate. */
export async function readTerminalCheckpoint(logPath: string): Promise<TerminalCheckpoint | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(checkpointPath(logPath), 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const p = JSON.parse(raw);
    if (
      p && typeof p.epoch === 'string' &&
      typeof p.serialized === 'string' &&
      typeof p.appliedOffset === 'number' && Number.isFinite(p.appliedOffset)
    ) {
      return { epoch: p.epoch, serialized: p.serialized, appliedOffset: p.appliedOffset };
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the checkpoint sidecar AND any stale `.checkpoint.tmp`. ENOENT-safe and
 *  idempotent — used for fresh-launch / rebound bounded cleanup. Delete-time
 *  reclamation goes through WP-1's `reclaimAgentLogFiles` SIDECARS list instead. */
export async function unlinkTerminalCheckpoint(logPath: string): Promise<void> {
  for (const p of [checkpointPath(logPath), checkpointTmpPath(logPath)]) {
    try {
      await fs.promises.unlink(p);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error(`[checkpoint] unlink ${p}:`, err);
    }
  }
}
