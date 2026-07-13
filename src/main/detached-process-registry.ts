// Detached-process transparency registry (incident-2026-07-11 §5 Wave 5).
//
// Agents can launch *detached* OS processes — long-running jobs that outlive the
// turn that spawned them and are NOT owned by the CLI Job Object the watchdog
// tracks. By convention each such process self-registers a JSON descriptor at
//   <workspace>/.dashboard/detached/<something>.json
// and refreshes it on every state write (flipping `running:false` on any clean
// exit path).
//
// The load-bearing caveat, by design of the format: a *hard* kill (SIGKILL / OS
// terminate / crash) never gets to flip `running:false`, so a descriptor can
// claim `running:true` for a process that is long gone. Therefore this module
// NEVER trusts the recorded flag alone — for every descriptor that claims to be
// running it probes the live PID and (where the platform allows) compares the
// live command line against the recorded one to catch PID reuse. The verdict:
//
//   running  — flag true, PID alive, command line matches (trusted alive)
//   ended    — flag false (a clean exit path recorded it)
//   dead     — flag true but the PID is NOT alive (hard-killed; stale file)
//   reused   — flag true, PID alive, but the live command line does NOT match
//              the recorded one (the PID was recycled by an unrelated process)
//   unknown  — cannot verify (no PID, probe unavailable, or malformed file)
//
// Everything the classifier needs is injected (dir listing, file read, PID
// probe), so it is unit-testable with no real processes or filesystem. The
// default real deps live at the bottom for the index.ts IPC wiring.

import { promises as fsp } from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import type { DetachedProcessDto, DetachedLiveness } from '../shared/types';

/** Per-PID probe result: is it alive, and (best-effort) its live command line. */
export interface DetachedProbeResult {
  alive: boolean;
  /** Live command line of the PID, or null when the platform can't read it. */
  commandLine: string | null;
}

export interface DetachedRegistryDeps {
  /** Basenames in `dir`; rejects when the directory does not exist. */
  listFiles: (dir: string) => Promise<string[]>;
  /** Read one descriptor file (utf8). */
  readFile: (file: string) => Promise<string>;
  /** Probe a set of PIDs at once (batched so the real impl is one query). */
  probe: (pids: number[]) => Promise<Map<number, DetachedProbeResult>>;
}

/** Parsed descriptor fields, before liveness is decided. `error` is set when the
 *  JSON was unreadable/malformed — such a row still surfaces (display-only). */
interface ParsedRecord {
  file: string;
  pid: number | null;
  command: string | null;
  agentId: string | null;
  startTime: number | null;
  phase: string | null;
  stateFile: string | null;
  logFile: string | null;
  stopFile: string | null;
  runningFlag: boolean;
  error: string | null;
}

/** First defined string value among the given keys; null when none present. */
function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Parse a `startTime`-shaped value: epoch-ms number or ISO/date string. */
function parseStart(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/** Parse one descriptor's raw JSON into a normalized record. Never throws;
 *  malformed input yields a record with `error` set and empty fields. */
export function parseDetachedRecord(file: string, raw: string): ParsedRecord {
  const base: ParsedRecord = {
    file, pid: null, command: null, agentId: null, startTime: null, phase: null,
    stateFile: null, logFile: null, stopFile: null, runningFlag: false, error: null,
  };
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...base, error: 'descriptor is not a JSON object' };
    }
    obj = parsed as Record<string, unknown>;
  } catch (e) {
    return { ...base, error: `malformed JSON: ${(e as Error).message}` };
  }
  const pidRaw = obj.pid;
  const pid = typeof pidRaw === 'number' && Number.isFinite(pidRaw) && pidRaw > 0
    ? Math.trunc(pidRaw)
    : (typeof pidRaw === 'string' && /^\d+$/.test(pidRaw.trim()) ? Number(pidRaw.trim()) : null);
  return {
    file,
    pid,
    command: pickStr(obj, ['command', 'commandLine', 'cmd', 'commandline']),
    agentId: pickStr(obj, ['agentId', 'agent_id', 'AGENT_ID']),
    startTime: parseStart(obj, ['startTime', 'start_time', 'startedAt', 'started_at']),
    phase: pickStr(obj, ['phase', 'currentPhase', 'status']),
    stateFile: pickStr(obj, ['stateFile', 'state_file', 'state']),
    logFile: pickStr(obj, ['logFile', 'log_file', 'log']),
    stopFile: pickStr(obj, ['stopFile', 'stop_file', 'stop', 'STOP']),
    runningFlag: obj.running === true,
    error: null,
  };
}

/** Lowercase + collapse whitespace for command-line comparison. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** First token's basename (drops path + surrounding quotes) — the executable. */
function exeToken(normalized: string): string {
  const first = normalized.split(' ')[0]?.replace(/^["']|["']$/g, '') ?? '';
  const slash = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'));
  return slash >= 0 ? first.slice(slash + 1) : first;
}

/**
 * Does the live command line plausibly match the recorded one? Deliberately
 * lenient so formatting differences (full exe path vs relative, extra quoting)
 * don't raise a false PID-reuse alarm — a mismatch means the live process is
 * genuinely unrelated. Returns true when there is nothing to compare against
 * (missing recorded or missing live command), since absence of evidence is not
 * evidence of reuse.
 */
export function commandMatches(recorded: string | null, actual: string | null): boolean {
  if (!recorded || !actual) return true;
  const a = norm(recorded);
  const b = norm(actual);
  if (!a || !b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ea = exeToken(a);
  return ea.length > 0 && ea === exeToken(b);
}

/** Decide liveness for a parsed record given the batched probe results. */
export function classifyLiveness(
  rec: ParsedRecord,
  probes: Map<number, DetachedProbeResult>,
): { liveness: DetachedLiveness; actualCommand: string | null } {
  if (rec.error) return { liveness: 'unknown', actualCommand: null };
  if (!rec.runningFlag) return { liveness: 'ended', actualCommand: null };
  if (rec.pid == null) return { liveness: 'unknown', actualCommand: null };
  const probe = probes.get(rec.pid);
  if (!probe) return { liveness: 'unknown', actualCommand: null };
  if (!probe.alive) return { liveness: 'dead', actualCommand: null };
  if (probe.commandLine != null && !commandMatches(rec.command, probe.commandLine)) {
    return { liveness: 'reused', actualCommand: probe.commandLine };
  }
  return { liveness: 'running', actualCommand: probe.commandLine };
}

/**
 * List and verify every detached-process descriptor under `dir`. A missing
 * directory (or any listing failure) yields an empty list — the feature is
 * strictly additive and never errors the caller. Descriptors are returned in a
 * stable order (by filename) so the UI does not reshuffle between polls.
 */
export async function listDetachedProcesses(
  dir: string,
  deps: DetachedRegistryDeps,
): Promise<DetachedProcessDto[]> {
  let names: string[];
  try {
    names = await deps.listFiles(dir);
  } catch {
    return []; // directory absent / unreadable → nothing detached
  }
  const jsons = names.filter((n) => n.toLowerCase().endsWith('.json')).sort();

  const records: ParsedRecord[] = [];
  for (const name of jsons) {
    const full = path.join(dir, name);
    try {
      records.push(parseDetachedRecord(full, await deps.readFile(full)));
    } catch (e) {
      records.push({
        file: full, pid: null, command: null, agentId: null, startTime: null,
        phase: null, stateFile: null, logFile: null, stopFile: null,
        runningFlag: false, error: `read failed: ${(e as Error).message}`,
      });
    }
  }

  const pidsToProbe = [
    ...new Set(records.filter((r) => r.runningFlag && r.pid != null).map((r) => r.pid as number)),
  ];
  let probes = new Map<number, DetachedProbeResult>();
  if (pidsToProbe.length > 0) {
    try {
      probes = await deps.probe(pidsToProbe);
    } catch {
      probes = new Map(); // probe failure → every claimed-running row falls to 'unknown'
    }
  }

  return records.map((rec) => {
    const { liveness, actualCommand } = classifyLiveness(rec, probes);
    return {
      file: rec.file,
      pid: rec.pid,
      command: rec.command,
      agentId: rec.agentId,
      startTime: rec.startTime,
      phase: rec.phase,
      stateFile: rec.stateFile,
      logFile: rec.logFile,
      stopFile: rec.stopFile,
      runningFlag: rec.runningFlag,
      liveness,
      actualCommand,
      error: rec.error,
    };
  });
}

// ── default real deps (index.ts IPC wiring) ────────────────────────────────

/** True unless the PID is provably gone. `kill(pid, 0)` throws ESRCH when the
 *  process does not exist; EPERM means it exists but we lack rights (alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Batched Win32 command-line lookup for the given PIDs (one shell-out). Returns
 *  a map pid→commandLine for the PIDs that were found alive. Resolves to an
 *  empty map off-Windows or on any failure (callers fall back to `pidAlive`). */
function readWindowsCommandLines(pids: number[]): Promise<Map<number, string>> {
  if (process.platform !== 'win32' || pids.length === 0) return Promise.resolve(new Map());
  const filter = pids.map((p) => `ProcessId=${p}`).join(' or ');
  const cmd =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true },
    );
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve(new Map()));
    child.on('close', () => {
      const out = stdout.trim();
      if (!out) return resolve(new Map());
      try {
        const parsed = JSON.parse(out);
        const rows: any[] = Array.isArray(parsed) ? parsed : [parsed];
        const map = new Map<number, string>();
        for (const r of rows) {
          const pid = Number(r?.ProcessId);
          if (Number.isFinite(pid) && typeof r?.CommandLine === 'string') {
            map.set(pid, r.CommandLine);
          } else if (Number.isFinite(pid)) {
            map.set(pid, ''); // present (alive) but no readable command line
          }
        }
        resolve(map);
      } catch {
        resolve(new Map());
      }
    });
  });
}

/** The production deps: real fs + a Windows-batched command-line probe with a
 *  cross-platform `process.kill(pid,0)` liveness fallback. */
export function defaultDetachedRegistryDeps(): DetachedRegistryDeps {
  return {
    listFiles: (dir) => fsp.readdir(dir),
    readFile: (file) => fsp.readFile(file, 'utf8'),
    probe: async (pids) => {
      const cmdLines = await readWindowsCommandLines(pids);
      const map = new Map<number, DetachedProbeResult>();
      for (const pid of pids) {
        if (cmdLines.size > 0) {
          // The Win32 query is authoritative for liveness: a PID it did not
          // return is not running. A returned empty string means alive but no
          // readable command line (skip the reuse check).
          const cl = cmdLines.get(pid);
          if (cl === undefined) map.set(pid, { alive: false, commandLine: null });
          else map.set(pid, { alive: true, commandLine: cl.length > 0 ? cl : null });
        } else {
          // No Win32 result set (off-Windows or query failed) → liveness only.
          map.set(pid, { alive: pidAlive(pid), commandLine: null });
        }
      }
      return map;
    },
  };
}

/** Convenience for the IPC handler: resolve the detached dir under a workspace
 *  root and list it with the default deps. */
export function detachedDirFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.dashboard', 'detached');
}
