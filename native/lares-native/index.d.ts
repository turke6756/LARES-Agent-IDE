// Type declarations for lares-native — the Windows Job Object + commit-telemetry
// N-API foundation (incident-remediation plan §5 step 0). Windows-only surface;
// on other platforms every operation throws and `supported` is false.

/**
 * Opaque handle to a Windows Job Object. Backed by a native `external`; closing
 * the JS handle (GC) does NOT terminate the job — the named job survives while
 * any member process runs (KILL_ON_JOB_CLOSE is intentionally unset).
 */
export type JobHandle = object;

/** System commit + physical-memory snapshot from `GlobalMemoryStatusEx`. */
export interface CommitStatus {
  /** Commit limit (`ullTotalPageFile`), bytes. */
  commitLimitBytes: number;
  /** Available commit headroom (`ullAvailPageFile`), bytes. */
  commitAvailableBytes: number;
  /** Current commit charge = limit − available, bytes. */
  commitChargeBytes: number;
  /** Total physical RAM, bytes. */
  physicalTotalBytes: number;
  /** Available physical RAM, bytes. */
  physicalAvailableBytes: number;
  /** Windows' approximate memory-load percentage (`dwMemoryLoad`). */
  memoryLoadPercent: number;
}

export interface LaresNative {
  /** True when the compiled Windows addon loaded and is usable. */
  readonly supported: boolean;
  /** Native-reported platform support (false on the stub / non-Windows). */
  platformSupported(): boolean;
  /** If `supported` is false, the reason the addon did not load (else null). */
  readonly loadError: string | null;

  /** Canonical named-job string: `Local\Lares.agent.<agentId>.<instanceEpoch>`. */
  jobName(agentId: string, instanceEpoch: string): string;

  /**
   * Create a named Job Object without KILL_ON_JOB_CLOSE and with breakaway
   * denied (descendants stay in the job). Idempotent: an existing named job of
   * the same name is reopened. Throws on failure.
   */
  createNamedJob(name: string): JobHandle;

  /**
   * Reopen an existing named job (e.g. from a fresh process after the creator
   * died). Returns null if no such named job exists (no live members). Throws
   * on other failures.
   */
  openNamedJob(name: string): JobHandle | null;

  /** Assign a process (by PID) to the job. Returns true; throws on failure. */
  assignPid(job: JobHandle, pid: number): boolean;

  /** PIDs currently in the job (including descendants). Throws on failure. */
  listJobPids(job: JobHandle): number[];

  /** Terminate every process in the job. Returns true; throws on failure. */
  terminateJob(job: JobHandle): boolean;

  /**
   * Process creation time as a decimal string of the raw FILETIME (100ns ticks
   * since 1601) — used with the PID for reuse-safe identity. Returns null if the
   * process is gone or inaccessible. (String, not number: FILETIME exceeds 2^53.)
   */
  pidCreationTime(pid: number): string | null;

  /** System commit + physical-memory snapshot. Throws on syscall failure. */
  getCommitStatus(): CommitStatus;
}

declare const laresNative: LaresNative;
export = laresNative;
