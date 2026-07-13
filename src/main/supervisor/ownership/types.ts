// Durable CLI-process ownership — shared types (incident-2026-07-11 D4, rev-4
// "Option B"). The DB ownership row is the durable cross-instance handle; named
// Job Objects are a live-instance-only mechanism (a job's name dies with its last
// handle, so it can never survive a forced main-process death — Wave-0 spike-3).
//
// Everything here is provider/OS-agnostic and dependency-injected so the pure
// logic (tree-walk, store decisions, reaper, reconcile-gate) is unit-testable
// without live processes or a real native module.

/** How the runner's process tree is owned. ConPTY (Windows) tracks a root PID +
 *  creation time + named Job Object; WSL has no Win32 PID (Linux procs aren't
 *  assignable to a Windows job — spike-6), so its ownership handle is the tmux
 *  session identity and its recovery path is tmux reattach. */
export type OwnershipTransport = 'conpty' | 'wsl';

/** Opaque native Job Object handle (backed by a native `external`). Held live
 *  in-memory for the app-instance lifetime — that open handle is what keeps the
 *  named job reopenable (spike-3: name released on last-handle close). */
export type JobHandle = object;

/** The durable ownership record persisted at spawn. One live row per agent
 *  (agent_id PRIMARY KEY); a respawn upserts it with the current epoch. Rows from
 *  prior epochs linger until reconciled/reaped — they are the cross-instance
 *  orphan trail. */
export interface OwnershipRow {
  agentId: string;
  /** Root PID of the runner tree. Null for WSL (no Win32 PID). */
  rootPid: number | null;
  /** Raw FILETIME (100ns ticks since 1601) as a decimal string — PID-reuse
   *  disambiguator. Null for WSL, or when the native module failed at spawn. */
  pidCreationTime: string | null;
  /** App-launch UUID. Distinguishes rows written by a prior Lares instance. */
  instanceEpoch: string;
  /** `Local\Lares.agent.<agentId>.<instanceEpoch>`. Null for WSL / native-off. */
  jobName: string | null;
  transport: OwnershipTransport;
  /** WSL ownership handle (tmux session name). Null for ConPTY. */
  tmuxSession: string | null;
  /** Epoch-ms the row was written. */
  createdAt: number;
}

/** A live OS process as seen by the process lister (Win32_Process). Only pid +
 *  parentPid are load-bearing for tree enumeration; creationTime is best-effort
 *  and NOT used for identity verification (that always goes through the native
 *  `pidCreationTime` syscall — a consistent FILETIME representation). */
export interface ProcessInfo {
  pid: number;
  parentPid: number;
  creationTime?: string | null;
}

/** Enumerate live OS processes. Injected so tests supply a fixed table and
 *  production spawns a single Win32_Process query (rare — startup/reap only,
 *  never per-sample). */
export interface ProcessLister {
  list(): Promise<ProcessInfo[]>;
}

/** The subset of `native/lares-native` the ownership subsystem consumes. Mirrors
 *  the shipped surface (Wave-0, commit ac60898); typed here so the store/reaper
 *  depend on an interface, not the concrete module, and tests inject a fake. */
export interface NativeJobSurface {
  readonly supported: boolean;
  readonly loadError: string | null;
  jobName(agentId: string, instanceEpoch: string): string;
  createNamedJob(name: string): JobHandle;
  /** Same-instance reopen ONLY (spike-3). Null if no such named job exists. */
  openNamedJob(name: string): JobHandle | null;
  assignPid(job: JobHandle, pid: number): boolean;
  listJobPids(job: JobHandle): number[];
  terminateJob(job: JobHandle): boolean;
  /** FILETIME decimal string, or null if the process is gone/inaccessible. */
  pidCreationTime(pid: number): string | null;
}
