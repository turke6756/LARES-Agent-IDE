// Verified Win32_Process tree walk (incident-2026-07-11 D4, rev-4). The PRIMARY
// cross-instance recovery path: seed from a recorded rootPid, VERIFY the root's
// identity by creation time (never kill on PID match alone), then enumerate the
// subtree by ParentProcessId. Pure functions over an injected process table +
// a creation-time getter (native `pidCreationTime` in production).

import { ProcessInfo } from './types';

/**
 * Every PID in the subtree rooted at `rootPid` (inclusive of the root when it is
 * present), following ParentProcessId edges. Cycle-safe. Does NOT verify
 * identity — callers must gate with `verifyRoot` first.
 *
 * If the root process is absent from the table, its former children have been
 * reparented away and are unreachable through this walk, so the result is empty
 * — i.e. "no surviving tree", which is the correct, safe outcome.
 */
export function collectTree(rootPid: number, processes: ProcessInfo[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  const present = new Set<number>();
  for (const p of processes) {
    present.add(p.pid);
    const arr = childrenByParent.get(p.parentPid);
    if (arr) arr.push(p.pid);
    else childrenByParent.set(p.parentPid, [p.pid]);
  }
  if (!present.has(rootPid)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (present.has(pid)) out.push(pid);
    const kids = childrenByParent.get(pid);
    if (kids) for (const k of kids) if (!seen.has(k)) stack.push(k);
  }
  return out;
}

export type VerifyReason =
  | 'match' // root PID still refers to the recorded process
  | 'root-gone' // no process with that PID → nothing to kill
  | 'creation-mismatch' // PID reused by an unrelated process → nothing to kill
  | 'no-stored-creation' // we never recorded a creation time (native-off at spawn)
  | 'no-creation-source'; // cannot obtain a current creation time (native-off now)

export interface VerifyResult {
  verified: boolean;
  reason: VerifyReason;
  currentCreationTime: string | null;
}

/**
 * Confirm `rootPid` still refers to the SAME process we recorded, by comparing
 * its live creation time to the stored one. This is the PID-reuse guard: a reused
 * PID has a different creation time and therefore does NOT verify — the reaper /
 * gate must never kill it.
 *
 * `getCreationTime` returns the FILETIME decimal string for a PID (native
 * `pidCreationTime`), null if the process is gone, or throws if no source is
 * available (native module unloaded) — the latter yields `no-creation-source`,
 * which callers treat as fail-closed (unverifiable), never as a kill.
 */
export function verifyRoot(
  rootPid: number,
  storedCreationTime: string | null,
  getCreationTime: (pid: number) => string | null,
): VerifyResult {
  if (!storedCreationTime) {
    return { verified: false, reason: 'no-stored-creation', currentCreationTime: null };
  }
  let current: string | null;
  try {
    current = getCreationTime(rootPid);
  } catch {
    return { verified: false, reason: 'no-creation-source', currentCreationTime: null };
  }
  if (current === null) {
    return { verified: false, reason: 'root-gone', currentCreationTime: null };
  }
  if (current !== storedCreationTime) {
    return { verified: false, reason: 'creation-mismatch', currentCreationTime: current };
  }
  return { verified: true, reason: 'match', currentCreationTime: current };
}

export type TreeStatus =
  | 'no-tree' // root gone or PID reused → safe: nothing to terminate, gate may open
  | 'tree' // verified live tree → pids populated, terminate them
  | 'unverifiable'; // cannot verify (no creation source/time) → fail-closed

export interface FindTreeResult {
  status: TreeStatus;
  pids: number[];
  verify: VerifyResult;
}

/**
 * Resolve whether a recorded owner has a verified surviving process tree.
 *
 * - `no-tree`   — the root is gone or its PID was reused; there is nothing of
 *                 ours to kill. Safe for the reconcile gate to open.
 * - `tree`      — the root verified; `pids` is the full subtree to terminate.
 * - `unverifiable` — we could not obtain a creation time to compare (native
 *                 module unavailable, or no creation time was ever stored). The
 *                 caller must fail closed: do NOT kill on PID match alone, do NOT
 *                 open the gate; surface for manual reconciliation.
 */
export function findVerifiedTree(
  owner: { rootPid: number | null; pidCreationTime: string | null },
  processes: ProcessInfo[],
  getCreationTime: (pid: number) => string | null,
): FindTreeResult {
  if (owner.rootPid == null) {
    // No Win32 root (e.g. a WSL row mis-routed here) — nothing to walk.
    return {
      status: 'no-tree',
      pids: [],
      verify: { verified: false, reason: 'root-gone', currentCreationTime: null },
    };
  }
  const verify = verifyRoot(owner.rootPid, owner.pidCreationTime, getCreationTime);
  switch (verify.reason) {
    case 'root-gone':
    case 'creation-mismatch':
      return { status: 'no-tree', pids: [], verify };
    case 'no-stored-creation':
    case 'no-creation-source':
      return { status: 'unverifiable', pids: [], verify };
    case 'match':
    default: {
      // The root verified alive via its creation time. Enumerate the subtree —
      // but the native `pidCreationTime` syscall and the Win32_Process snapshot
      // are independent, so the root can verify alive yet be missing from a
      // slightly-stale process table. Guarantee the verified-alive root is always
      // in the kill set so we never "proceed" past a live orphan.
      const pids = collectTree(owner.rootPid, processes);
      return { status: 'tree', pids: pids.length > 0 ? pids : [owner.rootPid], verify };
    }
  }
}
