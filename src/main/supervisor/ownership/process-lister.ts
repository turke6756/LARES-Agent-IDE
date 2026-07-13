// Production `ProcessLister` (incident-2026-07-11 D4). Enumerates live Win32
// processes for the verified tree walk. This is the ONE place that shells out —
// and only on rare events (startup reconcile, reaper fallback), NEVER per-sample
// (per D5, per-sample spawns are exactly what fails under memory pressure).
//
// A single `Get-CimInstance Win32_Process` query returns ProcessId +
// ParentProcessId + CreationDate as CSV. CreationDate is kept only for
// diagnostics; identity verification always goes through the native
// `pidCreationTime` syscall (a consistent FILETIME), never this CIM string.

import { spawn } from 'child_process';
import { ProcessInfo, ProcessLister } from './types';

const PS_COMMAND =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,CreationDate | ' +
  'ConvertTo-Csv -NoTypeInformation';

/** Parse the CSV `ConvertTo-Csv` emits (header row + quoted fields). */
function parseCsv(out: string): ProcessInfo[] {
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const rows: ProcessInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Fields are quoted ("123","456","2026...") — strip quotes, split on ','.
    const cells = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    const pid = Number(cells[0]);
    const parentPid = Number(cells[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(parentPid)) continue;
    rows.push({ pid, parentPid, creationTime: cells[2] || null });
  }
  return rows;
}

export function createProcessLister(): ProcessLister {
  return {
    list(): Promise<ProcessInfo[]> {
      if (process.platform !== 'win32') return Promise.resolve([]);
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
        child.on('error', () => resolve([])); // spawn failed (e.g. under pressure)
        child.on('close', () => {
          if (stderr.trim()) console.warn('[ownership] process-lister stderr:', stderr.trim().slice(0, 200));
          try {
            resolve(parseCsv(stdout));
          } catch (e) {
            console.warn('[ownership] process-lister parse failed:', e);
            resolve([]);
          }
        });
      });
    },
  };
}
