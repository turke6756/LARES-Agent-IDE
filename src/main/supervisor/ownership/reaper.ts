// Orphan reaper (incident-2026-07-11 D4 item 2). Periodic sweep that terminates
// the CLI process trees of agents that have been in a TERMINAL status
// (done/crashed) longer than a grace period, then drops their ownership rows.
//
// Hard invariants:
//   • Only TERMINAL agents are ever considered — the injected
//     `listTerminalAgents` returns done/crashed agents only, so idle/working
//     agents are structurally unreachable here. **Idle is a healthy live status
//     in Lares** and must never be reaped.
//   • Disabled entirely while the app is `shuttingDown` (drain-time survival is
//     intentional — reconcile respawns those agents next launch).
//   • Same-instance reaps go through the held Job Object; only when that path is
//     unavailable (native off) does the sweep fall back to the verified tree
//     walk, and an unverifiable owner is left in place (fail-closed).

import { OwnershipStore, ReapAction } from './ownership-store';
import { ProcessInfo, ProcessLister } from './types';

/** A terminal (done/crashed) agent and when it entered a terminal status
 *  (epoch-ms). The supervisor derives `terminalSinceMs` from the agent row. */
export interface TerminalAgentRef {
  agentId: string;
  terminalSinceMs: number;
}

export interface ReaperDeps {
  store: OwnershipStore;
  processLister: ProcessLister;
  /** Terminate a single PID (fallback tree-walk path). Production: process.kill. */
  kill: (pid: number) => void;
  /** Terminate a WSL tmux session (optional). When absent, WSL terminal owners
   *  are left for tmux/reconcile to handle rather than force-killed here. */
  killTmux?: (session: string) => void | Promise<void>;
  /** MUST return ONLY terminal (done/crashed) agents — the idle-safety boundary. */
  listTerminalAgents: () => TerminalAgentRef[];
  isShuttingDown: () => boolean;
  now: () => number;
  /** Terminal-status dwell before an agent is eligible (default 15 min). */
  graceMs: number;
  /** Sweep cadence for start()/stop(). */
  intervalMs: number;
  log: (msg: string) => void;
}

export interface ReapRecord {
  agentId: string;
  action: ReapAction | 'wsl-terminated' | 'wsl-skipped';
  pids: number[];
}

export interface SweepResult {
  skipped?: 'shutting-down';
  eligible: number;
  reaped: ReapRecord[];
}

export class Reaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: ReaperDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Never overlap sweeps; swallow errors so the interval survives.
      void this.tick();
    }, this.deps.intervalMs);
    // Do not keep the event loop alive solely for the reaper.
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sweepOnce();
    } catch (e) {
      this.deps.log(`[reaper] sweep failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** One sweep. Pure of timers — the unit-test entry point. */
  async sweepOnce(): Promise<SweepResult> {
    if (this.deps.isShuttingDown()) {
      return { skipped: 'shutting-down', eligible: 0, reaped: [] };
    }
    const now = this.deps.now();
    const eligible = this.deps
      .listTerminalAgents()
      .filter((t) => now - t.terminalSinceMs >= this.deps.graceMs);

    const reaped: ReapRecord[] = [];
    let processes: ProcessInfo[] | null = null; // fetched lazily, at most once

    for (const t of eligible) {
      const row = this.deps.store.getOwnership(t.agentId);
      if (!row) continue; // predates ownership / already reaped — nothing to do

      if (row.transport === 'wsl') {
        if (this.deps.killTmux && row.tmuxSession) {
          try {
            await this.deps.killTmux(row.tmuxSession);
            this.deps.store.deleteOwnership(t.agentId);
            reaped.push({ agentId: t.agentId, action: 'wsl-terminated', pids: [] });
          } catch (e) {
            this.deps.log(`[reaper] killTmux(${row.tmuxSession}) failed: ${String(e)}`);
            reaped.push({ agentId: t.agentId, action: 'wsl-skipped', pids: [] });
          }
        } else {
          reaped.push({ agentId: t.agentId, action: 'wsl-skipped', pids: [] });
        }
        continue;
      }

      let out = this.deps.store.reapViaJob(row);
      if (out.action === 'unavailable') {
        if (processes === null) {
          try {
            processes = await this.deps.processLister.list();
          } catch (e) {
            this.deps.log(`[reaper] process list failed: ${String(e)}`);
            processes = [];
          }
        }
        out = this.deps.store.reapViaTreeWalk(row, processes, this.deps.kill);
      }

      switch (out.action) {
        case 'terminated':
        case 'gone':
        case 'reused':
          this.deps.store.deleteOwnership(t.agentId);
          this.deps.log(
            `[reaper] ${t.agentId}: ${out.action}` +
              (out.pids.length ? ` (pids ${out.pids.join(',')})` : ''),
          );
          break;
        case 'unverifiable':
          // Fail-closed: keep the row so the startup orphan sweep / manual "Reap
          // now" can resolve it once a creation-time source is available.
          this.deps.log(`[reaper] ${t.agentId}: unverifiable — left for manual reconciliation`);
          break;
        default:
          break;
      }
      reaped.push({ agentId: t.agentId, action: out.action, pids: out.pids });
    }

    return { eligible: eligible.length, reaped };
  }
}
