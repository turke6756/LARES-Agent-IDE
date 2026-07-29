import * as fs from 'fs';
import * as path from 'path';
import { getAllAgents } from '../../database';

const SIDECARS = ['', '.scrollback', '.checkpoint', '.checkpoint.tmp']; // '' = the .log itself
const norm = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

/** WP-3 return contract. `validated` is false only when path/shared-reference
 *  validation refuses; `removed`/`failed` reflect ACTUAL unlink outcomes and
 *  `removed[].bytes` come from the pre-unlink stat. */
export interface ReclaimResult {
  validated: boolean;
  refusedReason?: 'out-of-scope' | 'shared-reference';
  removed: Array<{ path: string; bytes: number }>;
  failed: Array<{ path: string; code: string }>;
}

/** Unlink an agent's stored log + known sidecars. Refuses out-of-scope or shared
 *  paths. Excludes `agentId` from the shared-reference scan (its row is still present
 *  at call time). Never reconstructs a path from agentId.
 *
 *  WP-3 — worklist-first, hook-only-when-a-file-will-be-unlinked. The optional
 *  `beforeFirstUnlink` hook fires **iff at least one file will actually be
 *  unlinked**, exactly once and synchronously, so a reclaimed-marker written in
 *  the hook can never lie. Exact order:
 *    1. path + shared-reference validation → refusal returns `validated:false`,
 *       hook NOT called.
 *    2. statSync all four managed paths into a synchronous worklist; ENOENT is
 *       omitted; a non-ENOENT stat error is pushed to `failed` and omitted from
 *       the worklist.
 *    3. empty worklist → return `validated:true` WITHOUT calling the hook.
 *    4. call `beforeFirstUnlink()` exactly once, synchronously (a throw means no
 *       unlink begins).
 *    5. unlinkSync each worklist entry, recording actual `removed`/`failed`. */
export function reclaimAgentLogFiles(
  logPath: string,
  agentId: string,
  approvedLogsDir: string,
  hooks?: { beforeFirstUnlink?: () => void },
): ReclaimResult {
  // ── Step 1: path + shared-reference validation (hook not called on refusal) ──
  const target = norm(logPath);
  if (path.dirname(target) !== norm(approvedLogsDir)) {
    console.warn(`[reclaim] refusing out-of-scope path: ${logPath}`);
    return { validated: false, refusedReason: 'out-of-scope', removed: [], failed: [] };
  }
  if (getAllAgents().some(a => a.id !== agentId && a.logPath && norm(a.logPath) === target)) {
    console.warn(`[reclaim] ${logPath} still referenced by another agent — skipping`);
    return { validated: false, refusedReason: 'shared-reference', removed: [], failed: [] };
  }

  // ── Step 2: statSync the four managed paths into a synchronous worklist ──
  const worklist: Array<{ path: string; bytes: number }> = [];
  const failed: Array<{ path: string; code: string }> = [];
  for (const s of SIDECARS) {
    const p = logPath + s;
    try {
      const st = fs.statSync(p);
      worklist.push({ path: p, bytes: st.size });
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue; // absent → omit
      console.error(`[reclaim] stat ${p}:`, e);
      failed.push({ path: p, code: e?.code ?? 'UNKNOWN' });
    }
  }

  // ── Step 3: nothing to unlink → return WITHOUT firing the hook or marking ──
  if (worklist.length === 0) {
    return { validated: true, removed: [], failed };
  }

  // ── Step 4: fire the hook exactly once, synchronously (a throw aborts unlink) ──
  hooks?.beforeFirstUnlink?.();

  // ── Step 5: unlink each worklist entry, recording ACTUAL removed/failed ──
  const removed: Array<{ path: string; bytes: number }> = [];
  for (const entry of worklist) {
    try {
      fs.unlinkSync(entry.path);
      removed.push({ path: entry.path, bytes: entry.bytes });
    } catch (e: any) {
      console.error(`[reclaim] unlink ${entry.path}:`, e);
      failed.push({ path: entry.path, code: e?.code ?? 'UNKNOWN' });
    }
  }

  return { validated: true, removed, failed };
}
