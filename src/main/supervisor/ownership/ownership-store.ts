// Durable CLI-process ownership store (incident-2026-07-11 D4, rev-4 "Option B").
//
// The DB row is the durable cross-instance handle: {agentId, rootPid,
// pidCreationTime, instanceEpoch, jobName}. Named Job Objects are created and
// held live ONLY for the current app instance (a job's name is released when its
// last handle closes — spike-3 — so it can't survive a forced main-process
// death). Same-instance reaps go through the held job handle; cross-instance and
// native-failure paths go through the verified `Win32_Process` tree walk.
//
// All OS/DB/native access is injected so the decision logic is unit-testable.

import type Database from 'better-sqlite3';
import { FindTreeResult, findVerifiedTree, verifyRoot, VerifyResult } from './tree-walk';
import {
  JobHandle,
  NativeJobSurface,
  OwnershipRow,
  ProcessInfo,
} from './types';

export interface OwnershipStoreDeps {
  db: Database.Database;
  native: NativeJobSurface;
  /** App-launch UUID — stamped on every row written this instance. */
  instanceEpoch: string;
  now: () => number; // epoch-ms
  log: (msg: string) => void;
}

export type ReapAction =
  | 'terminated' // killed a verified tree / job
  | 'gone' // nothing alive to kill (root gone, PID reused into nothing, job name released)
  | 'reused' // PID reused by an unrelated process → declined to kill
  | 'unavailable' // native path not usable here → caller should fall back to the tree walk
  | 'unverifiable'; // fail-closed: could not verify identity, left for manual reconciliation

export interface ReapOutcome {
  action: ReapAction;
  pids: number[];
}

/** Idempotent schema creation — the store owns its own table so no seam in
 *  database.ts is required (CREATE TABLE IF NOT EXISTS, house guarded-ALTER
 *  idiom). Called from the constructor. Exported for tests. */
export function ensureOwnershipSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_process_ownership (
      agent_id          TEXT PRIMARY KEY,
      root_pid          INTEGER,
      pid_creation_time TEXT,
      instance_epoch    TEXT NOT NULL,
      job_name          TEXT,
      transport         TEXT NOT NULL DEFAULT 'conpty' CHECK (transport IN ('conpty','wsl')),
      tmux_session      TEXT,
      created_at        INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ownership_epoch ON agent_process_ownership(instance_epoch)`);
}

function rowToOwnership(r: any): OwnershipRow {
  return {
    agentId: r.agent_id,
    rootPid: r.root_pid ?? null,
    pidCreationTime: r.pid_creation_time ?? null,
    instanceEpoch: r.instance_epoch,
    jobName: r.job_name ?? null,
    transport: r.transport,
    tmuxSession: r.tmux_session ?? null,
    createdAt: r.created_at,
  };
}

export class OwnershipStore {
  /** Live named-job handles for THIS instance (agentId → handle). Holding the
   *  handle is what keeps the named job reopenable; dropping it releases the
   *  name. Never populated cross-instance. */
  private readonly jobHandles = new Map<string, JobHandle>();
  private nativeDegradedLogged = false;

  constructor(private readonly deps: OwnershipStoreDeps) {
    ensureOwnershipSchema(deps.db);
  }

  get instanceEpoch(): string {
    return this.deps.instanceEpoch;
  }

  nativeSupported(): boolean {
    return this.deps.native.supported;
  }

  /** A creation-time getter for verification. Uses the native syscall when the
   *  module is loaded; otherwise throws so verification resolves to
   *  `unverifiable` (fail-closed) rather than a false match. */
  private creationTimeGetter(): (pid: number) => string | null {
    const { native } = this.deps;
    if (native.supported) return (pid) => native.pidCreationTime(pid);
    return () => { throw new Error('lares-native unavailable'); };
  }

  private logNativeDegraded(msg: string): void {
    if (this.nativeDegradedLogged) return;
    this.nativeDegradedLogged = true;
    this.deps.log(`[ownership] native degraded — falling back to tree walk: ${msg}`);
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  /** Persist ownership for a ConPTY (Windows) runner at spawn, and — best effort
   *  — create + assign its named Job Object. The DB row is ALWAYS written (it is
   *  the durable handle); native failure only means the live-instance job
   *  primitives are unavailable, which downgrades reaps to the tree walk. */
  recordWindowsSpawn(agentId: string, rootPid: number): OwnershipRow {
    const { native, instanceEpoch } = this.deps;
    let pidCreationTime: string | null = null;
    let jobName: string | null = null;
    if (native.supported) {
      try {
        pidCreationTime = native.pidCreationTime(rootPid);
      } catch (e) {
        this.logNativeDegraded(`pidCreationTime(${rootPid}) failed: ${String(e)}`);
      }
      try {
        const name = native.jobName(agentId, instanceEpoch);
        const job = native.createNamedJob(name);
        native.assignPid(job, rootPid);
        this.jobHandles.set(agentId, job);
        jobName = name;
      } catch (e) {
        this.logNativeDegraded(`createNamedJob/assignPid failed for ${agentId} pid=${rootPid}: ${String(e)}`);
        jobName = null;
      }
    }
    const row: OwnershipRow = {
      agentId,
      rootPid,
      pidCreationTime,
      instanceEpoch,
      jobName,
      transport: 'conpty',
      tmuxSession: null,
      createdAt: this.deps.now(),
    };
    this.upsert(row);
    return row;
  }

  /** Persist ownership for a WSL runner. Linux processes have no Win32 PID, so
   *  the tmux session name is the ownership handle and tmux reattach is the
   *  recovery path (no Job Object). */
  recordWslSpawn(agentId: string, tmuxSession: string): OwnershipRow {
    const row: OwnershipRow = {
      agentId,
      rootPid: null,
      pidCreationTime: null,
      instanceEpoch: this.deps.instanceEpoch,
      jobName: null,
      transport: 'wsl',
      tmuxSession,
      createdAt: this.deps.now(),
    };
    this.upsert(row);
    return row;
  }

  private upsert(row: OwnershipRow): void {
    // Positional params (not named) so the sql.js wasm shim used by the unit
    // tests binds identically to the native better-sqlite3 build.
    this.deps.db
      .prepare(
        `INSERT INTO agent_process_ownership
           (agent_id, root_pid, pid_creation_time, instance_epoch, job_name, transport, tmux_session, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           root_pid          = excluded.root_pid,
           pid_creation_time = excluded.pid_creation_time,
           instance_epoch    = excluded.instance_epoch,
           job_name          = excluded.job_name,
           transport         = excluded.transport,
           tmux_session      = excluded.tmux_session,
           created_at        = excluded.created_at`,
      )
      .run(
        row.agentId,
        row.rootPid,
        row.pidCreationTime,
        row.instanceEpoch,
        row.jobName,
        row.transport,
        row.tmuxSession,
        row.createdAt,
      );
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  getOwnership(agentId: string): OwnershipRow | null {
    const r = this.deps.db
      .prepare(`SELECT * FROM agent_process_ownership WHERE agent_id = ?`)
      .get(agentId);
    return r ? rowToOwnership(r) : null;
  }

  listOwnershipRows(): OwnershipRow[] {
    return this.deps.db
      .prepare(`SELECT * FROM agent_process_ownership`)
      .all()
      .map(rowToOwnership);
  }

  /** Ownership rows written by a PRIOR app instance (epoch ≠ current). These are
   *  the cross-instance orphan candidates surfaced by the startup sweep. */
  listPriorEpochRows(): OwnershipRow[] {
    return this.deps.db
      .prepare(`SELECT * FROM agent_process_ownership WHERE instance_epoch <> ?`)
      .all(this.deps.instanceEpoch)
      .map(rowToOwnership);
  }

  deleteOwnership(agentId: string): void {
    this.deps.db.prepare(`DELETE FROM agent_process_ownership WHERE agent_id = ?`).run(agentId);
    const job = this.jobHandles.get(agentId);
    if (job) this.jobHandles.delete(agentId);
  }

  hasLiveJobHandle(agentId: string): boolean {
    return this.jobHandles.has(agentId);
  }

  /** WAVE-4 SEAM (full-D5 attribution): read-only live PID set for an agent whose
   *  named Job Object we still hold a handle to (same-instance only). Returns null
   *  when there is no live handle (prior-epoch / native-off rows → the caller uses
   *  the verified tree walk instead). Never kills; never opens by name. */
  getLiveJobPids(agentId: string): number[] | null {
    const job = this.jobHandles.get(agentId);
    if (!job || !this.deps.native.supported) return null;
    try {
      return this.deps.native.listJobPids(job);
    } catch (e) {
      this.deps.log(`[ownership] getLiveJobPids(${agentId}) failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * Idle-agent lifecycle §B4 — can we establish, without killing anything, that
   * we own a terminable handle on this agent's process?
   *
   * This is the SAME verification `terminateVerifiedAgent` (§B5) runs, so
   * eligibility and termination can never disagree about what "verified" means.
   * The mapping is the one `findVerifiedTree` already uses:
   *
   *  - no row                          → `gone`
   *  - WSL row with a tmux session     → `wsl-tmux` (tmux is the authority there)
   *  - root gone / PID reused          → `gone`   (nothing of ours survives)
   *  - root verified + a usable job    → `verified-job`
   *  - root verified, no usable job    → `verified-tree` (the Win32 tree walk)
   *  - creation time unobtainable      → `unverifiable` (fail-closed)
   *
   * Deliberately NOT a failure: the named Job Object being absent/released. A
   * released job name means its members are already gone, and the tree walk is
   * always available as the verified fallback — so job absence downgrades the
   * kind, it never makes an agent ineligible. The only `unverifiable` source is
   * the creation-time identity check (nothing stored, or no native source now),
   * which is exactly what stops us from killing a recycled PID.
   */
  verifyStopOwnership(agentId: string): { kind: 'verified-job' | 'verified-tree' | 'wsl-tmux' | 'gone' | 'unverifiable' } {
    const row = this.getOwnership(agentId);
    if (!row) return { kind: 'gone' };
    if (row.transport === 'wsl') {
      return { kind: row.tmuxSession ? 'wsl-tmux' : 'gone' };
    }
    if (row.rootPid == null) return { kind: 'gone' };
    const { native } = this.deps;
    const getter = native.supported
      ? (pid: number) => native.pidCreationTime(pid)
      : () => { throw new Error('lares-native unavailable'); };
    let v: VerifyResult;
    try {
      v = verifyRoot(row.rootPid, row.pidCreationTime, getter);
    } catch {
      return { kind: 'unverifiable' };
    }
    switch (v.reason) {
      case 'root-gone':
      case 'creation-mismatch':
        return { kind: 'gone' };
      case 'no-stored-creation':
      case 'no-creation-source':
        return { kind: 'unverifiable' };
      default: {
        const jobUsable = native.supported && !!row.jobName && row.instanceEpoch === this.deps.instanceEpoch;
        return { kind: jobUsable ? 'verified-job' : 'verified-tree' };
      }
    }
  }

  // ── termination ───────────────────────────────────────────────────────────────

  /**
   * Same-instance reap via the named Job Object. Re-verifies the root's identity
   * by creation time FIRST (PID-reuse guard) so a recycled PID is never killed,
   * then terminates the whole job atomically. Returns `unavailable` when the
   * native job path can't be used here (module off, no job name, or the row's
   * epoch is not ours) so the caller falls back to the tree walk.
   */
  reapViaJob(row: OwnershipRow): ReapOutcome {
    const { native } = this.deps;
    if (!native.supported || !row.jobName || row.instanceEpoch !== this.deps.instanceEpoch) {
      return { action: 'unavailable', pids: [] };
    }
    const v = verifyRoot(row.rootPid ?? -1, row.pidCreationTime, (p) => native.pidCreationTime(p));
    if (v.reason === 'root-gone') return { action: 'gone', pids: [] };
    if (v.reason === 'creation-mismatch') return { action: 'reused', pids: [] };
    if (!v.verified) return { action: 'unavailable', pids: [] };

    let job = this.jobHandles.get(row.agentId) ?? null;
    if (!job) {
      try {
        job = native.openNamedJob(row.jobName);
      } catch (e) {
        this.deps.log(`[ownership] openNamedJob(${row.jobName}) failed: ${String(e)}`);
        job = null;
      }
    }
    // Null here means the name is already released (members gone) — nothing to do.
    if (!job) return { action: 'gone', pids: [] };

    let pids: number[] = [];
    try {
      pids = native.listJobPids(job);
    } catch (e) {
      this.deps.log(`[ownership] listJobPids failed for ${row.agentId}: ${String(e)}`);
    }
    try {
      native.terminateJob(job);
    } catch (e) {
      this.deps.log(`[ownership] terminateJob failed for ${row.agentId}: ${String(e)}`);
    }
    this.jobHandles.delete(row.agentId);
    return { action: 'terminated', pids };
  }

  /**
   * Classify a recorded owner against a process snapshot WITHOUT killing:
   * `tree` (verified live tree — `pids` are the members), `no-tree` (root gone
   * or PID reused — safe), or `unverifiable` (fail-closed). Used by the
   * reconcile gate to decide before it acts.
   */
  classifyTree(row: OwnershipRow, processes: ProcessInfo[]): FindTreeResult {
    return findVerifiedTree(row, processes, this.creationTimeGetter());
  }

  /**
   * Cross-instance / native-fallback reap via the verified `Win32_Process` tree
   * walk. Verifies the root by creation time before killing anything; a reused or
   * absent PID yields `gone` (safe), and an unverifiable owner (native off / no
   * stored creation time) yields `unverifiable` (fail-closed — never kills).
   * `kill` terminates a single PID (injected: production uses `process.kill`).
   */
  reapViaTreeWalk(row: OwnershipRow, processes: ProcessInfo[], kill: (pid: number) => void): ReapOutcome {
    const res = findVerifiedTree(row, processes, this.creationTimeGetter());
    if (res.status === 'no-tree') return { action: 'gone', pids: [] };
    if (res.status === 'unverifiable') return { action: 'unverifiable', pids: [] };
    const killed: number[] = [];
    for (const pid of res.pids) {
      try {
        kill(pid);
        killed.push(pid);
      } catch (e) {
        this.deps.log(`[ownership] kill(${pid}) failed for ${row.agentId}: ${String(e)}`);
      }
    }
    return { action: 'terminated', pids: killed };
  }
}
