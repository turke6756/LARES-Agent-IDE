// Memory watchdog sampler + admission engine (incident-2026-07-11 §5 D5-lite).
//
// Samples system commit every 15 s off the hot path, maintains a hysteretic
// pressure band (Warn 75/70, Critical 88/80), tracks Electron
// process/agent/view counts, and answers admission checks
// for new agent launches and new agent tabs. Enforcement is split exactly as the
// plan requires:
//   • Static caps (max live agents, max Electron processes) are fail-CLOSED —
//     enforced from local state even when the sampler is down.
//   • Commit-threshold rules (Critical refusal, auto-reload suppression) are
//     fail-OPEN — suspended when the sampler fails; the meter shows "unknown".
//
// Every dependency is injected (clock, commit reader, counts, logger, snapshot
// sink) so the whole state machine is unit-testable with no timers or electron.

import {
  DEFAULT_WATCHDOG_CONFIG,
  type AdmissionDecision,
  type CommitReading,
  type MemorySnapshot,
  type PressureLevel,
  type WatchdogConfig,
} from './types';

export interface MemorySamplerDeps {
  /** Platform commit reader; null ⇒ sampler failure this tick. */
  readCommit: () => CommitReading | null;
  /** Main-process V8 heap reader (bytes) for the fail-CLOSED heap admission gate.
   *  Required: unlike the commit reader this is a deterministic in-process V8 call
   *  (`v8.getHeapStatistics()`), so any failure to obtain a valid reading DENIES
   *  admission rather than failing open — a wiring regression must not silently
   *  drop the safety net. */
  readHeapStats: () => { heapUsed: number; heapSizeLimit: number };
  /** Registered live (non-terminal) agent count — local state, no telemetry. */
  getLiveAgentCount: () => number;
  /** Live agent tabs/views count. */
  getAgentViewCount: () => number;
  /** Electron process count (app.getAppMetrics().length) — local, no syscall. */
  getElectronProcessCount: () => number;
  /** Approximate app-owned memory in bytes (sum of getAppMetrics working sets). */
  getAppMemoryBytes: () => number;
  /** Monotonic-ish clock (ms). Injected so tests drive time deterministically. */
  now: () => number;
  /** Called on every computed snapshot (renderer push). Optional. */
  onSnapshot?: (snapshot: MemorySnapshot) => void;
  /** Log sink (level transitions + one-shot sampler-failure line). */
  log?: (msg: string) => void;
  config?: Partial<WatchdogConfig>;
}

export class MemorySampler {
  private readonly cfg: WatchdogConfig;
  private readonly deps: MemorySamplerDeps;

  private level: PressureLevel = 'normal';
  private commitKnown = false;
  private samplerFailureLogged = false;
  private lastSnapshot: MemorySnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MemorySamplerDeps) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_WATCHDOG_CONFIG, ...(deps.config ?? {}) };
  }

  /** Begin the 15 s sampling loop. Takes one immediate sample so the first
   *  snapshot exists before the first interval elapses. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.cfg.sampleIntervalMs);
    // Don't keep the event loop alive on account of the watchdog.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Take one sample and recompute the snapshot. Exposed (not just the timer) so
   *  tests can step deterministically. */
  sample(): MemorySnapshot {
    const now = this.deps.now();
    const reading = this.deps.readCommit();

    let commitPercent: number | null = null;

    if (reading) {
      // Sampler recovered (or is healthy) — reset the one-shot failure latch.
      if (!this.commitKnown && this.samplerFailureLogged) {
        this.log(`[watchdog] commit sampler recovered (source=${reading.source})`);
      }
      this.commitKnown = true;
      this.samplerFailureLogged = false;

      commitPercent =
        reading.commitLimitBytes > 0
          ? (reading.commitChargeBytes / reading.commitLimitBytes) * 100
          : 0;

      this.transition(this.computeLevel(commitPercent), commitPercent);
    } else {
      // Sampler failure: commit rules suspend (fail-open); static caps stay
      // enforced elsewhere. Meter shows "unknown". Log exactly once per episode.
      this.commitKnown = false;
      if (!this.samplerFailureLogged) {
        this.log('[watchdog] commit sampler unavailable — commit-threshold enforcement suspended; static caps still enforced; meter=unknown');
        this.samplerFailureLogged = true;
      }
    }

    const snapshot: MemorySnapshot = {
      level: this.commitKnown ? this.level : 'normal',
      commitKnown: this.commitKnown,
      commitPercent: this.commitKnown ? round1(commitPercent ?? 0) : null,
      commitLimitBytes: reading ? reading.commitLimitBytes : null,
      commitChargeBytes: reading ? reading.commitChargeBytes : null,
      appProcessCount: safeCount(this.deps.getElectronProcessCount),
      appMemoryBytes: safeCount(this.deps.getAppMemoryBytes),
      liveAgentCount: safeCount(this.deps.getLiveAgentCount),
      agentViewCount: safeCount(this.deps.getAgentViewCount),
      staticCapsOnly: !this.commitKnown,
      at: now,
    };
    this.lastSnapshot = snapshot;
    try {
      this.deps.onSnapshot?.(snapshot);
    } catch {
      // A renderer-push failure must never break sampling.
    }
    return snapshot;
  }

  /** Last computed snapshot (for D1's pressure gate + the meter). */
  getSnapshot(): MemorySnapshot | null {
    return this.lastSnapshot;
  }

  /** Current hysteretic band. `normal` when the commit sampler is down. */
  getLevel(): PressureLevel {
    return this.commitKnown ? this.level : 'normal';
  }

  /** True only when commit is KNOWN and we are in the Critical band. This is the
   *  commit-based rule D1 consults — fail-open when the sampler is down (unknown
   *  ⇒ false ⇒ auto-reload permitted). */
  isCriticalPressure(): boolean {
    return this.commitKnown && this.level === 'critical';
  }

  /** D1: suppress the automatic shell reload under Critical commit pressure. */
  shouldSuppressAutoReload(): boolean {
    return this.isCriticalPressure();
  }

  /** Admission gate for a new agent launch. Ordered static caps → heap → commit;
   *  the first refusal wins so the caller receives exactly one machine-readable
   *  code. */
  canLaunchAgent(): AdmissionDecision {
    const cap = this.staticCapDenial('agent-launch');
    if (cap) return cap;
    const heap = this.heapDenial();
    if (heap) return heap;
    return this.commitDenial() ?? { allowed: true };
  }

  /** Admission gate for a new agent tab/view. Same static caps → heap → commit
   *  ordering as `canLaunchAgent`. */
  canOpenAgentTab(): AdmissionDecision {
    const cap = this.staticCapDenial('agent-tab');
    if (cap) return cap;
    const heap = this.heapDenial();
    if (heap) return heap;
    return this.commitDenial() ?? { allowed: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Fail-CLOSED static caps — evaluated from local counts, no telemetry, so
   *  they hold even when the commit sampler is down. */
  private staticCapDenial(kind: 'agent-launch' | 'agent-tab'): AdmissionDecision | null {
    const procs = safeCount(this.deps.getElectronProcessCount);
    if (procs >= this.cfg.maxElectronProcesses) {
      return {
        allowed: false,
        code: 'memory-capacity',
        reason:
          `Electron process count ${procs} is at/above the static cap ` +
          `${this.cfg.maxElectronProcesses}; refusing new ${kind === 'agent-launch' ? 'agent launch' : 'agent tab'}.`,
      };
    }
    if (kind === 'agent-launch') {
      const agents = safeCount(this.deps.getLiveAgentCount);
      if (agents >= this.cfg.maxLiveAgents) {
        return {
          allowed: false,
          code: 'memory-capacity',
          reason: `Live agent count ${agents} is at/above the static cap ${this.cfg.maxLiveAgents}; refusing new agent launch.`,
        };
      }
    }
    return null;
  }

  /** Fail-OPEN commit rule — only denies when commit is KNOWN and Critical. */
  private commitDenial(): AdmissionDecision | null {
    if (!this.commitKnown) return null; // fail-open: commit rules suspended
    if (this.level !== 'critical') return null;
    const pct = this.lastSnapshot?.commitPercent ?? null;
    return {
      allowed: false,
      code: 'memory-critical',
      reason:
        `System memory is under Critical commit pressure` +
        (pct !== null ? ` (${pct}% of commit limit)` : '') +
        `; refusing new agents/tabs until pressure clears. Wait and retry, or reap idle agents.`,
    };
  }

  /** Fail-CLOSED main-process V8 heap gate. `v8.getHeapStatistics()` is a
   *  deterministic in-process call that is expected to succeed, so — unlike the
   *  fail-OPEN commit rule — ANY of a thrown read, a non-positive limit, a
   *  non-finite value, or a negative `heapUsed` DENIES admission (refuses new
   *  agents/tabs). A wiring regression must not silently drop this safety net.
   *  A valid reading denies only at/above `heapAdmissionPercent`. */
  private heapDenial(): AdmissionDecision | null {
    let heapUsed: number;
    let heapSizeLimit: number;
    try {
      const h = this.deps.readHeapStats();
      heapUsed = h.heapUsed;
      heapSizeLimit = h.heapSizeLimit;
    } catch {
      return this.heapUnavailableDenial();
    }
    if (
      !Number.isFinite(heapUsed) ||
      !Number.isFinite(heapSizeLimit) ||
      heapSizeLimit <= 0 ||
      heapUsed < 0
    ) {
      return this.heapUnavailableDenial();
    }
    const pct = (heapUsed / heapSizeLimit) * 100;
    if (pct >= this.cfg.heapAdmissionPercent) {
      const usedMiB = Math.round(heapUsed / (1024 * 1024));
      const limitMiB = Math.round(heapSizeLimit / (1024 * 1024));
      return {
        allowed: false,
        code: 'memory-heap',
        reason:
          `Main-process V8 heap is at ${round1(pct)}% (${usedMiB} MiB of ${limitMiB} MiB), ` +
          `at/above the ${this.cfg.heapAdmissionPercent}% admission threshold; ` +
          `refusing new agents/tabs until the main heap drains.`,
      };
    }
    return null;
  }

  /** The single fail-closed refusal shape for an unusable heap reading. */
  private heapUnavailableDenial(): AdmissionDecision {
    return {
      allowed: false,
      code: 'memory-heap',
      reason:
        'Main-process V8 heap reading unavailable; refusing new agents/tabs (fail-closed safety net).',
    };
  }

  /** Hysteretic band selection. */
  private computeLevel(pct: number): PressureLevel {
    const cfg = this.cfg;
    const criticalTrip = pct >= cfg.criticalOnPercent;
    const criticalHold = pct >= cfg.criticalClearPercent;
    const warnTrip = pct >= cfg.warnOnPercent;
    const warnHold = pct >= cfg.warnClearPercent;

    switch (this.level) {
      case 'critical':
        if (criticalHold) return 'critical';
        return warnHold ? 'warn' : 'normal';
      case 'warn':
        if (criticalTrip) return 'critical';
        return warnHold ? 'warn' : 'normal';
      case 'normal':
      default:
        if (criticalTrip) return 'critical';
        return warnTrip ? 'warn' : 'normal';
    }
  }

  private transition(next: PressureLevel, pct: number): void {
    if (next === this.level) return;
    this.log(`[watchdog] pressure ${this.level} → ${next} (commit=${round1(pct)}%)`);
    this.level = next;
  }

  private log(msg: string): void {
    try {
      (this.deps.log ?? ((m: string) => console.warn(m)))(msg);
    } catch {
      /* logging must never throw into the sampler */
    }
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A count provider must never throw into the sampler; treat a throw as 0. */
function safeCount(fn: () => number): number {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
