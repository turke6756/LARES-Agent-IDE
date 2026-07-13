// Startup orphan sweep (incident-2026-07-11 D4 item 4). Surfaces leftover CLI
// process trees from PRIOR app epochs (rows whose instanceEpoch ≠ current — the
// named jobs are already gone, so these can only be recovered via the verified
// tree walk) plus current-epoch rows whose agent is terminal/missing, and offers
// a bulk "Reap now" action. This is the main-process API; the renderer surface is
// a minimal list (follow-on) — see the Patch summary.

import { OwnershipStore } from './ownership-store';
import { ProcessInfo, ProcessLister } from './types';

export interface OrphanCandidate {
  agentId: string;
  instanceEpoch: string;
  transport: 'conpty' | 'wsl';
  rootPid: number | null;
  tmuxSession: string | null;
  /** Whether the row is from a prior app instance. */
  priorEpoch: boolean;
  /** Verified-tree classification: 'tree' (live orphan), 'no-tree' (already
   *  gone), 'unverifiable' (native/creation-time missing → manual only), or
   *  'wsl' (tmux-owned, not walkable). */
  status: 'tree' | 'no-tree' | 'unverifiable' | 'wsl';
  /** PIDs in the verified tree (best-effort memory-estimate proxy: a count of
   *  processes; a byte estimate would require another native/WMIC pass, deferred
   *  per the plan's "counts if estimates aren't cheap"). */
  pids: number[];
}

/**
 * Enumerate orphan candidates: prior-epoch rows plus current-epoch rows for
 * agents the caller marks terminal/missing (`isReapable`). Classifies each
 * against a single process snapshot. Does NOT kill anything.
 */
export async function listOrphanCandidates(
  store: OwnershipStore,
  processLister: ProcessLister,
  isReapable: (agentId: string) => boolean,
): Promise<OrphanCandidate[]> {
  const rows = store.listOwnershipRows();
  const currentEpoch = store.instanceEpoch;
  const relevant = rows.filter((r) => r.instanceEpoch !== currentEpoch || isReapable(r.agentId));
  if (relevant.length === 0) return [];

  let processes: ProcessInfo[] = [];
  const needsWalk = relevant.some((r) => r.transport === 'conpty');
  if (needsWalk) {
    try {
      processes = await processLister.list();
    } catch {
      processes = [];
    }
  }

  return relevant.map((r) => {
    if (r.transport === 'wsl') {
      return {
        agentId: r.agentId,
        instanceEpoch: r.instanceEpoch,
        transport: r.transport,
        rootPid: null,
        tmuxSession: r.tmuxSession,
        priorEpoch: r.instanceEpoch !== currentEpoch,
        status: 'wsl' as const,
        pids: [],
      };
    }
    const c = store.classifyTree(r, processes);
    return {
      agentId: r.agentId,
      instanceEpoch: r.instanceEpoch,
      transport: r.transport,
      rootPid: r.rootPid,
      tmuxSession: null,
      priorEpoch: r.instanceEpoch !== currentEpoch,
      status: c.status,
      pids: c.pids,
    };
  });
}

export interface ReapOrphansResult {
  agentId: string;
  action: string;
  pids: number[];
}

/**
 * Bulk-reap the named orphan agents' trees (the "Reap now" action). Each is
 * verified again before any kill; unverifiable owners are left in place.
 */
export async function reapOrphans(
  store: OwnershipStore,
  agentIds: string[],
  processLister: ProcessLister,
  kill: (pid: number) => void,
  killTmux?: (session: string) => void | Promise<void>,
): Promise<ReapOrphansResult[]> {
  const results: ReapOrphansResult[] = [];
  let processes: ProcessInfo[] | null = null;
  for (const agentId of agentIds) {
    const row = store.getOwnership(agentId);
    if (!row) {
      results.push({ agentId, action: 'not-found', pids: [] });
      continue;
    }
    if (row.transport === 'wsl') {
      if (killTmux && row.tmuxSession) {
        try {
          await killTmux(row.tmuxSession);
          store.deleteOwnership(agentId);
          results.push({ agentId, action: 'wsl-terminated', pids: [] });
        } catch {
          results.push({ agentId, action: 'wsl-skipped', pids: [] });
        }
      } else {
        results.push({ agentId, action: 'wsl-skipped', pids: [] });
      }
      continue;
    }
    // Prior-epoch (or native-off) rows have no live job → tree walk is the path.
    let out = store.reapViaJob(row);
    if (out.action === 'unavailable') {
      if (processes === null) {
        try { processes = await processLister.list(); } catch { processes = []; }
      }
      out = store.reapViaTreeWalk(row, processes, kill);
    }
    if (out.action !== 'unverifiable') store.deleteOwnership(agentId);
    results.push({ agentId, action: out.action, pids: out.pids });
  }
  return results;
}
