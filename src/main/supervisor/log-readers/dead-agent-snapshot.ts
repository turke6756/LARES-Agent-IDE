// WP-3c — dead-agent historical snapshot with STRUCTURED truncation metadata.
//
// A `done`/`crashed` agent has no live ring; its history is reconstructed from
// disk. Two sources, in order of fidelity:
//
//   1. `<logPath>.scrollback` — the bounded ring the runner flushed on exit.
//      This is what the terminal viewer should replay (raw `.log` replays
//      alt-screen toggles and renders visually empty in xterm). But because the
//      ring is BOUNDED, a `.log` larger than the `.scrollback` proves earlier
//      history was dropped from the ring → mark `truncated`.
//   2. No `.scrollback` (pre-BUG-15 agents) — a rune-aligned tail of the raw
//      `.log`, capped at `maxBytes`, carrying `readFileTail`'s own `truncated`.
//
// Conservative-by-design: a false-positive truncation banner (we mark truncated
// when in doubt) is always preferred over silently claiming completeness. No new
// persisted sidecar — sizes are compared from files that already exist, so there
// is nothing extra for delete-time reclamation to unlink.

import * as fsp from 'fs/promises';
import { readFileTail } from './tail-file';

export interface DeadAgentSnapshot {
  /** History text to replay into xterm (`.scrollback`, else a `.log` tail). */
  text: string;
  /** True when earlier history was provably dropped (ring-bounded, or the tail
   *  hit its byte cap). Drives the renderer's structured truncation banner. */
  truncated: boolean;
  /** Bytes actually retained in `text` (for the "retained vs total" banner). */
  retainedBytes: number;
  /** WP-6: true ONLY when BOTH `.scrollback` and `.log` are absent (both
   *  `sizeOrNull` → null). NEVER inferred from an empty read / `retainedBytes 0`
   *  — an empty-but-present `.log` is size 0 yet `missing:false`. This is the
   *  "history-unavailable" signal, orthogonal to the retention-reclaimed marker. */
  missing: boolean;
}

/** stat().size, or null on ENOENT (distinguishes "missing" from "empty"). */
async function sizeOrNull(filePath: string): Promise<number | null> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Build a dead agent's replay snapshot from disk. Prefers the bounded
 * `.scrollback`; falls back to a capped rune-aligned `.log` tail. Never reads a
 * whole `.log` (WP-2 invariant) — the fallback goes through `readFileTail`.
 */
export async function readDeadAgentSnapshot(
  logPath: string,
  maxBytes: number,
): Promise<DeadAgentSnapshot> {
  const scrollbackPath = `${logPath}.scrollback`;
  const sbSize = await sizeOrNull(scrollbackPath);

  if (sbSize !== null) {
    // `.scrollback` is runner-bounded (~MAX_RING_BYTES), so a full-file tail
    // returns all of it; `readFileTail`'s cap is a defensive ceiling only.
    const sb = await readFileTail(scrollbackPath, maxBytes);
    const logSize = (await sizeOrNull(logPath)) ?? 0;
    // Earlier history dropped from the bounded ring iff the raw log outgrew it.
    // (A `.scrollback` itself larger than maxBytes also counts as truncated.)
    const truncated = logSize > sbSize || sb.truncated;
    // `.scrollback` is present here, so history is NOT missing regardless of the
    // `.log` (an empty-but-present `.scrollback` still means we have the ring).
    return { text: sb.bytes.toString('utf8'), truncated, retainedBytes: sb.bytes.length, missing: false };
  }

  // No scrollback — cold tail of the raw `.log`. `missing` iff the `.log` is ALSO
  // absent (both fallback files gone). A stat-only check, never a whole-file read.
  const logSize = await sizeOrNull(logPath);
  const tail = await readFileTail(logPath, maxBytes);
  return {
    text: tail.bytes.toString('utf8'),
    truncated: tail.truncated,
    retainedBytes: tail.endOffset - tail.startOffset,
    missing: logSize === null,
  };
}
