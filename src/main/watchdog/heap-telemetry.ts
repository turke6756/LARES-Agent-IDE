// Main-process V8 heap telemetry (crash diagnosability "Layer 3", 2026-07-25).
//
// Motivation: the main process died with a V8 fatal error (heap OOM) that both
// existing crash layers were blind to — Crashpad captures native crashes and the
// uncaughtException handler captures thrown JS, but a V8 fatal abort bypasses
// both, and the watchdog MemorySampler only samples SYSTEM commit + app working
// set, never this process's own V8 heap. This sampler closes that gap: every
// tick it reads `v8.getHeapStatistics()` and appends one compact JSONL line to
// `<userData>/logs/heap-telemetry.jsonl`, so after a fatal abort we still have
// the heap growth curve leading up to it. It also logs a one-shot console
// warning as heapUsed crosses 75% and 90% of the heap size limit.
//
// Every dependency is injected (clock, heap reader, file append/size/rotate,
// logger) so the whole thing is unit-testable with no timers, no fs, and no v8.
// A fs-backed wiring is provided by `createHeapTelemetry` for index.ts.
//
// ── JSONL line kinds ─────────────────────────────────────────────────────────
// The file is a stream of newline-terminated JSON objects, discriminated by a
// `kind` field. Every line carries an ISO `t` timestamp. The kinds are ADDITIVE:
// a reader that only understands `heap` still works, and OLD lines predating the
// `kind` field (no `kind` at all) are read as `heap`. Never repurpose an existing
// field — only add.
//
//   {kind:"heap",       t, heapUsed, heapTotal, heapLimit, external, malloced}
//       The whole-process V8 heap curve (one per tick, ~15 s). This is the ONE
//       kind emitted with no extra deps wired, so it is always present.
//   {kind:"processes",  t, procs:[{type, pid, rss}]}
//       Per-Electron-process working set from app.getAppMetrics() (main / GPU /
//       each renderer). Separates "the UI is bloating" from "main is leaking".
//   {kind:"subsystems", t, gauges:[{name, count, bytes?}]}
//       Cheap O(1) reads of specific in-main-process structures (chat ring,
//       terminal RAM rings, supervisor maps, …) so growth can be blamed on a
//       named structure, not just "the heap".
//   {kind:"agents",     t, perAgent:[{agentId, rss, pidCount?, source?}]}
//       Per-agent child-process working set, read from the attribution cache on
//       a SLOWER cadence (default 60 s) — no per-tick process-tree walk.
//   {kind:"log-retention-sweep", t, beforeBytes, afterBytes, removedFiles,
//                        reclaimedBytes, reclaimedAgents, targetBytes, outcome,
//                        durationMs, scanErrors}
//       One line per completed terminal-log retention sweep (WP-8). NOT on a
//       timer — emitted by the scheduler's scan-complete sink. Every counter is
//       an ACTUAL before/after result, never a plan/estimate. Goes through the
//       SAME single writer as every other kind (`writeLine`) so the file the
//       memory-hardening analysis depends on is never corrupted by a second
//       rotator.
//
// ── Reading it back ──────────────────────────────────────────────────────────
// `node scripts/analyze-heap-telemetry.mjs [path]` reads the live file + its
// rotated `.1`, tolerates mixed old/new lines, and prints heap/subsystem/process
// trend tables with a flat / grew-then-stabilized / monotonic-growth-suspect
// verdict per series. Run it to answer "is anything leaking, and what?".

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';

/** One reading of the main process's V8 heap. Bytes throughout. */
export interface HeapSample {
  /** Live heap in use (v8 used_heap_size). */
  heapUsed: number;
  /** Total allocated heap (v8 total_heap_size). */
  heapTotal: number;
  /** The hard ceiling — an OOM abort fires as heapUsed approaches this
   *  (v8 heap_size_limit). This is the value the % warnings are measured against. */
  heapSizeLimit: number;
  /** Off-heap memory bound to JS objects (v8 external_memory), 0 if unavailable. */
  external: number;
  /** Memory malloced by V8 (v8 malloced_memory), 0 if unavailable. */
  malloced: number;
}

/** Warn/critical crossing levels for the once-per-crossing console warning. */
type HeapLevel = 'normal' | 'warn' | 'critical';

/** One Electron process's working set, for the `processes` line. */
export interface ProcessSample {
  /** ProcessMetric.type — 'Browser' (main), 'GPU', 'Tab' (renderer), 'Utility'… */
  type: string;
  pid: number;
  /** Resident/working-set bytes. */
  rss: number;
}

/** One named subsystem gauge reading, for the `subsystems` line. A gauge reports
 *  a `count` (entries/agents/…) and, when the structure tracks it cheaply, `bytes`. */
export interface GaugeReading {
  name: string;
  count: number;
  bytes?: number;
}

/** A cheap injected subsystem gauge. `read()` MUST be an O(1)-ish read of an
 *  already-maintained counter — never a heavy scan on the sampling path. It may
 *  return one reading or several (e.g. a per-runner breakdown). A throwing
 *  provider is caught, its name reported once, and the rest of the batch still
 *  emits — a bad gauge can never take down telemetry or the app. */
export interface GaugeProvider {
  /** Stable id used only for once-per-failure logging attribution. */
  name: string;
  read: () => GaugeReading | GaugeReading[];
}

/** One completed terminal-log retention sweep, for the `log-retention-sweep`
 *  line (WP-8). Every field is an ACTUAL before/after result of the sweep just
 *  run, never a plan or estimate: `beforeBytes`/`afterBytes` are the managed
 *  disk total before and after, and `removedFiles`/`reclaimedBytes`/
 *  `reclaimedAgents` are the executor's real removals. */
export interface LogRetentionSweepEvent {
  /** Managed terminal-log disk total BEFORE the sweep (bytes). */
  beforeBytes: number;
  /** Managed terminal-log disk total AFTER the sweep (bytes). */
  afterBytes: number;
  /** Files actually unlinked this sweep. */
  removedFiles: number;
  /** Bytes actually reclaimed this sweep. */
  reclaimedBytes: number;
  /** Agents that had at least one file removed this sweep. */
  reclaimedAgents: number;
  /** The configured cap in bytes (`unlimited` ⇒ +∞, serialized as null). */
  targetBytes: number;
  outcome: 'under-target' | 'swept-to-target' | 'target-unmet';
  /** Wall-clock from scan start to this emission. */
  durationMs: number;
  /** Non-ENOENT stat errors seen during the inventory pass. */
  scanErrors: number;
}

/** One agent's child-process working set, for the `agents` line. */
export interface AgentMemSample {
  agentId: string;
  /** Working-set bytes of the agent's resolved process tree. */
  rss: number;
  pidCount?: number;
  source?: string;
}

export interface HeapTelemetryDeps {
  /** Read the current V8 heap statistics. */
  readHeap: () => HeapSample;
  /** Monotonic-ish wall clock (ms epoch). Injected so tests drive time. */
  now: () => number;
  /** Append one already-newline-terminated line to the telemetry file. */
  append: (line: string) => void;
  /** Current telemetry file size in bytes (0 if the file is missing). */
  size: () => number;
  /** Rotate: move the current file aside (to `.1`, replacing any prior) and
   *  start fresh. Called just before an append that would exceed `maxBytes`. */
  rotate: () => void;
  /** Log sink for the threshold-crossing warnings. Defaults to console.warn. */
  log?: (msg: string) => void;
  /** Rotate when the file reaches this size. Default 5 MiB. */
  maxBytes?: number;
  /** heapUsed/heapSizeLimit percent that trips the Warn crossing. Default 75. */
  warnPercent?: number;
  /** …that trips the Critical crossing. Default 90. */
  criticalPercent?: number;
  /** Sample cadence (ms). Default 15 s — matches the MemorySampler. */
  sampleIntervalMs?: number;

  // ── Optional per-part providers (backward compatible: absent ⇒ that line kind
  //    is simply never emitted, and existing heap-only wirings are unchanged) ──

  /** Per-Electron-process working sets (app.getAppMetrics()). Emits a
   *  `processes` line each tick. */
  readProcesses?: () => ProcessSample[];
  /** Injected subsystem gauges. Emits a `subsystems` line each tick with every
   *  successful reading. */
  gauges?: GaugeProvider[];
  /** Per-agent child-process working set, read from an already-computed cache
   *  (no process-tree walk here). Emits an `agents` line on the SLOWER
   *  `agentSampleIntervalMs` cadence. */
  readAgents?: () => AgentMemSample[];
  /** Cadence (ms) of the per-agent line. Default 60 s — deliberately slower than
   *  the heap tick so it can piggyback on a slow attribution cache. */
  agentSampleIntervalMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_WARN_PERCENT = 75;
const DEFAULT_CRITICAL_PERCENT = 90;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_AGENT_INTERVAL_MS = 60_000;

export class HeapTelemetry {
  private readonly deps: HeapTelemetryDeps;
  private readonly maxBytes: number;
  private readonly warnPercent: number;
  private readonly criticalPercent: number;
  private readonly intervalMs: number;
  private readonly agentIntervalMs: number;

  /** Last crossing level, so the warning fires once per upward crossing, not
   *  every tick. Resets downward as usage recovers, so a re-cross re-warns. */
  private level: HeapLevel = 'normal';
  private timer: ReturnType<typeof setInterval> | null = null;
  private agentTimer: ReturnType<typeof setInterval> | null = null;
  /** Provider/subsystem failure keys already logged, so a persistently broken
   *  gauge warns once per process, not every tick. */
  private readonly loggedFailures = new Set<string>();

  constructor(deps: HeapTelemetryDeps) {
    this.deps = deps;
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
    this.warnPercent = deps.warnPercent ?? DEFAULT_WARN_PERCENT;
    this.criticalPercent = deps.criticalPercent ?? DEFAULT_CRITICAL_PERCENT;
    this.intervalMs = deps.sampleIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.agentIntervalMs = deps.agentSampleIntervalMs ?? DEFAULT_AGENT_INTERVAL_MS;
  }

  /** Begin the sampling loop. Takes one immediate sample so the first line lands
   *  before the first interval elapses. Idempotent. The per-agent line runs on
   *  its own slower timer, its first emission deferred one interval so a cold
   *  attribution cache isn't sampled as "0 agents". */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    // The heap telemetry must never keep the event loop (or the app) alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
    if (this.deps.readAgents) {
      this.agentTimer = setInterval(() => this.sampleAgents(), this.agentIntervalMs);
      (this.agentTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.agentTimer) {
      clearInterval(this.agentTimer);
      this.agentTimer = null;
    }
  }

  /** Take one sample: rotate-if-full, append one JSONL line, and fire the
   *  threshold warning on an upward crossing. Exposed (not just the timer) so
   *  tests step deterministically. Never throws — telemetry must not be able to
   *  make a memory-pressure situation worse by crashing the process. */
  sample(): HeapSample {
    const s = this.deps.readHeap();
    // Existing field names/meanings are FROZEN for backward compatibility; only
    // the discriminant `kind` was added. Readers that predate `kind` (old lines)
    // read a line with no `kind` as a heap sample.
    this.writeLine({
      kind: 'heap',
      t: this.iso(),
      heapUsed: s.heapUsed,
      heapTotal: s.heapTotal,
      heapLimit: s.heapSizeLimit,
      external: s.external,
      malloced: s.malloced,
    });
    this.checkThresholds(s);
    // Per-part lines only emit when their providers are wired — an unwired
    // sampler is byte-for-byte the original heap-only stream.
    this.emitProcesses();
    this.emitSubsystems();
    return s;
  }

  /** Emit one `processes` line from the per-Electron-process provider. A provider
   *  failure is logged once and skips only this line. */
  private emitProcesses(): void {
    if (!this.deps.readProcesses) return;
    let procs: ProcessSample[];
    try {
      procs = this.deps.readProcesses();
    } catch (e) {
      this.logOnce('processes', `[heap] process-metrics provider failed; skipping process line: ${errText(e)}`);
      return;
    }
    this.writeLine({ kind: 'processes', t: this.iso(), procs });
  }

  /** Emit one `subsystems` line from every wired gauge. Each provider is isolated:
   *  a throwing gauge is caught, its name logged once, and the remaining gauges
   *  still report — one bad provider never blanks the batch. */
  private emitSubsystems(): void {
    const gauges = this.deps.gauges;
    if (!gauges || gauges.length === 0) return;
    const readings: GaugeReading[] = [];
    for (const g of gauges) {
      try {
        const r = g.read();
        if (Array.isArray(r)) readings.push(...r);
        else readings.push(r);
      } catch (e) {
        this.logOnce(`gauge:${g.name}`, `[heap] subsystem gauge "${g.name}" failed; skipping it: ${errText(e)}`);
      }
    }
    if (readings.length > 0) {
      this.writeLine({ kind: 'subsystems', t: this.iso(), gauges: readings });
    }
  }

  /** Emit one `agents` line from the per-agent provider (a cache read, not a
   *  process walk). Public so the slow timer AND tests can drive it. Never throws. */
  sampleAgents(): void {
    if (!this.deps.readAgents) return;
    let perAgent: AgentMemSample[];
    try {
      perAgent = this.deps.readAgents();
    } catch (e) {
      this.logOnce('agents', `[heap] per-agent memory provider failed; skipping agents line: ${errText(e)}`);
      return;
    }
    this.writeLine({ kind: 'agents', t: this.iso(), perAgent });
  }

  /** WP-8: append one `log-retention-sweep` line for a completed retention
   *  sweep. Routed through the SINGLE existing writer (`writeLine`) — there is
   *  deliberately no second appender/rotator, so this line rotates with (and
   *  never corrupts) the rest of the heap-telemetry stream. Never throws. */
  emitLogRetentionSweep(ev: LogRetentionSweepEvent): void {
    this.writeLine({ kind: 'log-retention-sweep', t: this.iso(), ...ev });
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /** Rotate-if-full then append one JSONL object. Every line kind goes through
   *  here, so the whole multi-kind stream stays bounded at `maxBytes` and no
   *  single write can throw out of the sampler. */
  private writeLine(obj: Record<string, unknown>): void {
    // Rotate BEFORE the append so the live file never grows unbounded past the
    // cap. A rotation failure must not stop us from writing this line.
    try {
      if (this.deps.size() >= this.maxBytes) this.deps.rotate();
    } catch {
      /* rotation is best-effort */
    }
    try {
      this.deps.append(JSON.stringify(obj) + '\n');
    } catch {
      /* a telemetry write failure must never break the app */
    }
  }

  private logOnce(key: string, msg: string): void {
    if (this.loggedFailures.has(key)) return;
    this.loggedFailures.add(key);
    this.log(msg);
  }

  private checkThresholds(s: HeapSample): void {
    const pct = s.heapSizeLimit > 0 ? (s.heapUsed / s.heapSizeLimit) * 100 : 0;
    const next: HeapLevel =
      pct >= this.criticalPercent ? 'critical' : pct >= this.warnPercent ? 'warn' : 'normal';

    // Only warn on an UPWARD crossing (normal→warn, warn→critical, or a direct
    // normal→critical jump), and only once until usage recovers past the band.
    if (rank(next) > rank(this.level)) {
      this.log(
        `[heap] main-process V8 heap at ${round1(pct)}% of limit ` +
        `(${mib(s.heapUsed)} MiB / ${mib(s.heapSizeLimit)} MiB used) — ${next.toUpperCase()}`
      );
    }
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

function rank(level: HeapLevel): number {
  return level === 'critical' ? 2 : level === 'warn' ? 1 : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mib(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read the live V8 heap statistics into a `HeapSample`. Fields absent on older
 *  Node/V8 (`external_memory`, `malloced_memory`) degrade to 0. */
export function readV8Heap(): HeapSample {
  const h = v8.getHeapStatistics() as v8.HeapInfo & {
    external_memory?: number;
    malloced_memory?: number;
  };
  return {
    heapUsed: h.used_heap_size ?? 0,
    heapTotal: h.total_heap_size ?? 0,
    heapSizeLimit: h.heap_size_limit ?? 0,
    external: h.external_memory ?? 0,
    malloced: h.malloced_memory ?? 0,
  };
}

/**
 * Wire a HeapTelemetry around a real on-disk JSONL file at `filePath`. The
 * parent directory is created on construction. `rotate` renames the file to
 * `<filePath>.1` (replacing any prior rotation) and lets the next append start
 * fresh. All fs work is guarded so a telemetry problem can never crash startup.
 */
export function createHeapTelemetry(opts: {
  filePath: string;
  now?: () => number;
  log?: (msg: string) => void;
  readHeap?: () => HeapSample;
  maxBytes?: number;
  sampleIntervalMs?: number;
  /** Optional per-part providers (see HeapTelemetryDeps). Omitting all of them
   *  yields the original heap-only stream. */
  readProcesses?: () => ProcessSample[];
  gauges?: GaugeProvider[];
  readAgents?: () => AgentMemSample[];
  agentSampleIntervalMs?: number;
}): HeapTelemetry {
  const { filePath } = opts;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* if the dir can't be made, the appends below simply no-op */
  }
  const rotatedPath = `${filePath}.1`;
  return new HeapTelemetry({
    readHeap: opts.readHeap ?? readV8Heap,
    now: opts.now ?? (() => Date.now()),
    append: (line) => fs.appendFileSync(filePath, line),
    size: () => {
      try {
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    },
    rotate: () => {
      try {
        fs.rmSync(rotatedPath, { force: true });
      } catch {
        /* best-effort */
      }
      fs.renameSync(filePath, rotatedPath);
    },
    log: opts.log,
    maxBytes: opts.maxBytes,
    sampleIntervalMs: opts.sampleIntervalMs,
    readProcesses: opts.readProcesses,
    gauges: opts.gauges,
    readAgents: opts.readAgents,
    agentSampleIntervalMs: opts.agentSampleIntervalMs,
  });
}

/** Map an Electron `app.getAppMetrics()` array into `ProcessSample[]`. Pulled out
 *  (and electron injected) so it stays unit-testable without electron. Working
 *  set arrives in KiB from Electron; we normalise to bytes. */
export function readProcessMetrics(
  metrics: Array<{ pid: number; type: string; memory?: { workingSetSize?: number } }>,
): ProcessSample[] {
  return metrics.map((m) => ({
    type: m.type,
    pid: m.pid,
    rss: (m.memory?.workingSetSize ?? 0) * 1024,
  }));
}
