// Memory-watchdog shared types + tunables (incident-2026-07-11 §5 D5-lite).
//
// This file is deliberately electron-/native-free so the API server, the
// supervisor, and the browser manager can import the admission-error codes and
// the decision shape WITHOUT dragging the whole sampler (and its electron/app
// dependencies) into their module graph.

/** Hysteretic pressure band. `unknown` is a distinct meter state used ONLY when
 *  the commit sampler failed — it is never a threshold band. */
export type PressureLevel = 'normal' | 'warn' | 'critical';

/** A single platform commit + physical-memory reading. Bytes throughout.
 *  `commitLimit`/`commitCharge` are the load-bearing pair (Windows commit; on
 *  Linux the `/proc/meminfo` CommitLimit/Committed_AS pair; on macOS an
 *  approximate physical-memory analog — see commit-source.ts). */
export interface CommitReading {
  source: 'windows-native' | 'linux-proc' | 'macos-fallback';
  commitLimitBytes: number;
  commitChargeBytes: number;
  commitAvailableBytes: number;
  physicalTotalBytes: number;
  physicalAvailableBytes: number;
}

/** The periodically-computed watchdog snapshot: the exact contract the D1
 *  recovery gate, the admission checks, and the (follow-on) status-bar meter +
 *  banner consume. Pushed to the renderer over `memory:pressure` and returned by
 *  the `memory:get-snapshot` IPC handle. */
export interface MemorySnapshot {
  level: PressureLevel;
  /** false ⇒ the commit sampler failed this tick; the meter shows "unknown" and
   *  commit-threshold enforcement is suspended (static caps still apply). */
  commitKnown: boolean;
  /** Commit charge as a percentage of the commit limit (0–100), or null when
   *  `commitKnown` is false. */
  commitPercent: number | null;
  commitLimitBytes: number | null;
  commitChargeBytes: number | null;
  /** Electron process count (app.getAppMetrics().length) — local, no syscall. */
  appProcessCount: number;
  /** Approximate app-owned memory (sum of app.getAppMetrics working sets), bytes. */
  appMemoryBytes: number;
  /** Registered live (non-terminal) agents. */
  liveAgentCount: number;
  /** Live agent tabs/views. */
  agentViewCount: number;
  /** Projected minutes until commit hits the limit from the 5-min rolling slope;
   *  null when the slope is flat/negative or the window is too short. */
  projectedMinutesToLimit: number | null;
  /** true when the sampler is degraded to static-caps-only (commit unknown). */
  staticCapsOnly: boolean;
  at: number;
}

/** Machine-readable admission failure classes. Surfaced to the calling
 *  agent/orchestrator at the API/MCP layer (see api-server API_ERROR_CODES). */
export type AdmissionCode = 'memory-critical' | 'memory-capacity';

export interface AdmissionDecision {
  allowed: boolean;
  code?: AdmissionCode;
  /** Agent-/human-readable explanation (goes into the thrown Error message). */
  reason?: string;
}

/** The admission surface the sampler exposes and the supervisor / browser
 *  manager consume. Kept electron-free so both can depend on it without pulling
 *  the sampler's platform deps into their module graph. */
export interface AdmissionController {
  canLaunchAgent(): AdmissionDecision;
  canOpenAgentTab(): AdmissionDecision;
}

/** Error thrown when admission is refused. `code` is one of the machine-readable
 *  `AdmissionCode`s (both are registered in api-server's `API_ERROR_CODES`), and
 *  `statusCode` is 503 so the API layer answers Service-Unavailable rather than a
 *  bare 500 — the calling agent/orchestrator receives a structured "no" it can
 *  branch on (plan §5 D5-lite: "a structured error that the calling agent/
 *  orchestrator also receives"). Electron-free: a plain Error subclass. */
export class AdmissionError extends Error {
  readonly code: AdmissionCode;
  readonly statusCode = 503;
  constructor(decision: AdmissionDecision) {
    super(decision.reason ?? 'Refused: the machine is out of memory headroom.');
    this.name = 'AdmissionError';
    this.code = decision.code ?? 'memory-capacity';
  }
}

/** Watchdog tunables. Defaults per plan §5 D5-lite. */
export interface WatchdogConfig {
  /** Sample cadence (ms). */
  sampleIntervalMs: number;
  /** Warn band trip / clear (percent of commit limit). */
  warnOnPercent: number;
  warnClearPercent: number;
  /** Critical band trip / clear (percent of commit limit). */
  criticalOnPercent: number;
  criticalClearPercent: number;
  /** Rolling window for the growth-rate slope (ms). */
  slopeWindowMs: number;
  /** Minimum span of samples before the slope is trusted (ms). */
  slopeMinSpanMs: number;
  /** Growth-rate Critical trip: projected minutes-to-limit below this trips
   *  Critical even below `criticalOnPercent`. */
  projectionCriticalMinutes: number;
  /** Fail-closed static caps — enforced from local state even when the sampler
   *  is down. */
  maxLiveAgents: number;
  maxElectronProcesses: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  sampleIntervalMs: 15_000,
  warnOnPercent: 75,
  warnClearPercent: 70,
  criticalOnPercent: 88,
  criticalClearPercent: 80,
  slopeWindowMs: 5 * 60_000,
  slopeMinSpanMs: 60_000,
  projectionCriticalMinutes: 30,
  maxLiveAgents: 32,
  maxElectronProcesses: 350,
};
