// Startup reconcile gate (incident-2026-07-11 D4 item 3) — duplicate-CLI
// prevention. `reconcile()` respawns with `--continue`/`--resume`; on
// Windows/ConPTY that can NEVER reattach, so a surviving orphan tree from a prior
// (force-killed) instance + an unconditional respawn = TWO CLIs on one session.
//
// Before each agent's respawn we resolve ownership per agent, choosing exactly
// one of:
//   • proceed                 — no surviving tree → respawn normally (fast path).
//   • reattach                — WSL/tmux transport → the phantom-reconnect path
//                               genuinely reattaches; do not kill, do not block.
//   • terminate-then-continue — ConPTY default: kill the VERIFIED orphan tree,
//                               then respawn --resume/--continue.
//   • leave-unmanaged         — explicit user opt-out: mark unmanaged, DO NOT
//                               respawn until the user resolves it.
//   • blocked                 — fail-closed: could not verify the owner (native
//                               module failure with a possibly-live orphan). DO
//                               NOT respawn — a duplicate CLI must never happen.
//
// The gate is per-agent; an agent with no ownership row / no surviving tree
// passes straight through (`proceed`).

import { OwnershipStore } from './ownership-store';
import { ProcessInfo, ProcessLister } from './types';

export type GateAction =
  | 'proceed'
  | 'reattach'
  | 'terminate-then-continue'
  | 'leave-unmanaged'
  | 'blocked';

export interface GateResolution {
  action: GateAction;
  reason: string;
  /** PIDs terminated (only for terminate-then-continue). */
  pids: number[];
}

/** Per-agent user override for the gate. `null`/absent → the ConPTY default
 *  (terminate-then-continue). `unmanaged` → the explicit opt-out. */
export type UserResolution = 'terminate' | 'unmanaged' | null;

export interface ReconcileGateDeps {
  store: OwnershipStore;
  processLister: ProcessLister;
  kill: (pid: number) => void;
  /** Explicit per-agent user decision, if any. */
  getUserResolution?: (agentId: string) => UserResolution;
  now: () => number;
  /** Cache TTL for the process list across a staggered reconcile pass (ms). */
  processCacheTtlMs?: number;
  log: (msg: string) => void;
}

export class ReconcileGate {
  private processCache: { at: number; procs: ProcessInfo[] } | null = null;

  constructor(private readonly deps: ReconcileGateDeps) {}

  private async processes(): Promise<ProcessInfo[]> {
    const ttl = this.deps.processCacheTtlMs ?? 10_000;
    const now = this.deps.now();
    if (this.processCache && now - this.processCache.at < ttl) {
      return this.processCache.procs;
    }
    let procs: ProcessInfo[] = [];
    try {
      procs = await this.deps.processLister.list();
    } catch (e) {
      this.deps.log(`[reconcile-gate] process list failed: ${String(e)}`);
      procs = [];
    }
    this.processCache = { at: now, procs };
    return procs;
  }

  /**
   * Resolve ownership for one agent about to be respawned. The ownership row read
   * here is the leftover from the PRIOR instance (this instance has not spawned
   * the agent yet), so its epoch differs from ours — that is expected.
   */
  async resolve(agentId: string): Promise<GateResolution> {
    const row = this.deps.store.getOwnership(agentId);

    // No ownership record → nothing could survive; respawn freely.
    if (!row) {
      return { action: 'proceed', reason: 'no ownership row', pids: [] };
    }

    // WSL/tmux: the reattach path owns recovery. Never force-kill here.
    if (row.transport === 'wsl') {
      return { action: 'reattach', reason: 'wsl/tmux reattach path', pids: [] };
    }

    // Native module failed to load entirely → we cannot verify a possibly-live
    // orphan. Fail-closed: do NOT respawn (would risk a duplicate CLI).
    if (!this.deps.store.nativeSupported()) {
      return {
        action: 'blocked',
        reason: 'native module unavailable — cannot verify orphan (fail-closed)',
        pids: [],
      };
    }

    const procs = await this.processes();
    const classify = this.deps.store.classifyTree(row, procs);
    const user = this.deps.getUserResolution?.(agentId) ?? null;

    switch (classify.status) {
      case 'no-tree':
        // Root gone or PID reused — no conflicting tree. Respawn freely.
        this.deps.store.deleteOwnership(agentId);
        return { action: 'proceed', reason: 'no surviving tree', pids: [] };
      case 'unverifiable':
        // Possibly-live orphan we cannot verify → fail-closed.
        return {
          action: 'blocked',
          reason: 'unverifiable owner (native call/stored-ctime missing) — fail-closed',
          pids: [],
        };
      case 'tree': {
        // A verified live orphan tree exists.
        if (user === 'unmanaged') {
          return {
            action: 'leave-unmanaged',
            reason: 'user opted out — orphan left running, no respawn',
            pids: [],
          };
        }
        // Default (or explicit 'terminate'): kill the verified tree, then continue.
        const done = this.deps.store.reapViaTreeWalk(row, procs, this.deps.kill);
        this.deps.store.deleteOwnership(agentId);
        return {
          action: 'terminate-then-continue',
          reason: 'verified orphan tree terminated before --resume',
          pids: done.pids,
        };
      }
      default:
        return { action: 'proceed', reason: `unexpected classify ${classify.status}`, pids: [] };
    }
  }
}
