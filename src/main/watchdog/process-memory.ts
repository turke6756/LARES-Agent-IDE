// Per-PID memory snapshot for full-D5 attribution (incident-2026-07-11 §5,
// Wave 4).
//
// "Use what exists, no new native call" (plan's per-PID-memory constraint): the
// ONE extra column set Win32_Process already carries — WorkingSetSize (bytes)
// and PrivatePageCount (bytes, best-effort commit proxy) — pulled in a SINGLE
// query alongside ProcessId/ParentProcessId. This is the same rare shell-out
// discipline as the ownership tree-walk lister: startup / on-demand attribution
// and orphan-list refreshes only, NEVER per-sample (a per-sample spawn is exactly
// what fails under memory pressure — the sampler uses the in-process native
// commit syscall for that).
//
// The parsed snapshot doubles as a `ProcessInfo[]` source for the verified tree
// walk, so one query serves both the tree resolution and the byte lookup.

import { spawn } from 'child_process';
import type { ProcessInfo } from '../supervisor/ownership/types';

export interface ProcessMemEntry extends ProcessInfo {
  workingSetBytes: number | null;
  commitBytes: number | null;
}

export interface ProcessMemorySnapshot {
  /** All rows — a `ProcessInfo[]` for the verified tree walk. */
  processes: ProcessMemEntry[];
  workingSetBytes(pid: number): number | null;
  commitBytes(pid: number): number | null;
}

const PS_COMMAND =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ' +
  'ConvertTo-Csv -NoTypeInformation';

/** Parse the `ConvertTo-Csv` output (header + quoted numeric fields). */
export function parseProcessMemCsv(out: string): ProcessMemEntry[] {
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const rows: ProcessMemEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    // `Number('')` is 0, not NaN — treat an empty cell as missing explicitly so a
    // blank pid drops the row and a blank memory column becomes null (not 0).
    const num = (s: string | undefined): number => (s ? Number(s) : NaN);
    const pid = num(cells[0]);
    const parentPid = num(cells[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(parentPid)) continue;
    const ws = num(cells[2]);
    const commit = num(cells[3]);
    rows.push({
      pid,
      parentPid,
      workingSetBytes: Number.isFinite(ws) ? ws : null,
      commitBytes: Number.isFinite(commit) ? commit : null,
    });
  }
  return rows;
}

/** Build a lookup snapshot from parsed rows (last write wins on a duplicate PID). */
export function makeSnapshot(processes: ProcessMemEntry[]): ProcessMemorySnapshot {
  const byPid = new Map<number, ProcessMemEntry>();
  for (const p of processes) byPid.set(p.pid, p);
  return {
    processes,
    workingSetBytes: (pid) => byPid.get(pid)?.workingSetBytes ?? null,
    commitBytes: (pid) => byPid.get(pid)?.commitBytes ?? null,
  };
}

const EMPTY: ProcessMemorySnapshot = makeSnapshot([]);

/** Take one process-memory snapshot. Resolves to an empty snapshot off-Windows
 *  or on any spawn/parse failure (never rejects — attribution degrades to
 *  "unknown", the fail-open path). */
export function readProcessMemorySnapshot(): Promise<ProcessMemorySnapshot> {
  if (process.platform !== 'win32') return Promise.resolve(EMPTY);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_COMMAND],
      { windowsHide: true },
    );
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => resolve(EMPTY)); // spawn failed (e.g. under pressure)
    child.on('close', () => {
      if (stderr.trim()) console.warn('[attribution] process-memory stderr:', stderr.trim().slice(0, 200));
      try {
        resolve(makeSnapshot(parseProcessMemCsv(stdout)));
      } catch (e) {
        console.warn('[attribution] process-memory parse failed:', e);
        resolve(EMPTY);
      }
    });
  });
}
