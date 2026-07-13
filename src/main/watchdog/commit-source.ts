// Platform commit-charge reader (incident-2026-07-11 §5 D5-lite "Measurement").
//
// One reading, three platforms:
//   • Windows — the in-process `GlobalMemoryStatusEx` syscall via the Wave-0
//     native module (`getCommitStatus`). NEVER a PowerShell/wmic spawn — process
//     spawns are exactly what fails under memory pressure.
//   • Linux   — `/proc/meminfo` CommitLimit / Committed_AS.
//   • macOS   — no true system commit; approximate via physical-memory pressure
//     from `process.getSystemMemoryInfo()` (documented as a fallback).
//
// Every dependency is injected so this stays unit-testable with zero platform or
// electron coupling; index.ts wires the real sources (native module + fs +
// Electron `process.getSystemMemoryInfo`).

import type { CommitReading } from './types';

/** The raw Windows native shape (subset of lares-native CommitStatus we use). */
export interface NativeCommitStatus {
  commitLimitBytes: number;
  commitAvailableBytes: number;
  commitChargeBytes: number;
  physicalTotalBytes: number;
  physicalAvailableBytes: number;
}

/** Electron's `process.getSystemMemoryInfo()` shape (KB fields). */
export interface SystemMemoryInfo {
  total: number;
  free: number;
  swapTotal?: number;
  swapFree?: number;
}

export interface CommitSourceDeps {
  platform: NodeJS.Platform;
  /** Windows: native `getCommitStatus`; may throw. null when the module is
   *  unavailable (non-Windows build / binary missing). */
  nativeGetCommitStatus: (() => NativeCommitStatus) | null;
  /** Linux: raw `/proc/meminfo` text; null on read failure. */
  readProcMeminfo: () => string | null;
  /** macOS: `process.getSystemMemoryInfo()`; null on failure. */
  systemMemoryInfo: () => SystemMemoryInfo | null;
}

/** Parse a `/proc/meminfo` field (value is in kB) → bytes, or null if absent. */
function meminfoBytes(text: string, key: string): number | null {
  // Lines look like: "CommitLimit:    66876543 kB"
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  if (!m) return null;
  return Number(m[1]) * 1024;
}

/**
 * Read a single commit snapshot for the current platform, or null when the
 * sampler failed (native throw, missing /proc field, or unusable numbers). A
 * null return is the sampler-failure signal the watchdog fails-open on for
 * commit rules and fails-closed on for static caps.
 */
export function readCommit(deps: CommitSourceDeps): CommitReading | null {
  try {
    if (deps.platform === 'win32') {
      if (!deps.nativeGetCommitStatus) return null;
      const s = deps.nativeGetCommitStatus();
      if (!s || !(s.commitLimitBytes > 0)) return null;
      return {
        source: 'windows-native',
        commitLimitBytes: s.commitLimitBytes,
        commitChargeBytes: s.commitChargeBytes,
        commitAvailableBytes: s.commitAvailableBytes,
        physicalTotalBytes: s.physicalTotalBytes,
        physicalAvailableBytes: s.physicalAvailableBytes,
      };
    }

    if (deps.platform === 'linux') {
      const text = deps.readProcMeminfo();
      if (!text) return null;
      const limit = meminfoBytes(text, 'CommitLimit');
      const committed = meminfoBytes(text, 'Committed_AS');
      const memTotal = meminfoBytes(text, 'MemTotal');
      const memAvail = meminfoBytes(text, 'MemAvailable');
      if (limit === null || committed === null || !(limit > 0)) return null;
      return {
        source: 'linux-proc',
        commitLimitBytes: limit,
        commitChargeBytes: committed,
        commitAvailableBytes: Math.max(0, limit - committed),
        physicalTotalBytes: memTotal ?? 0,
        physicalAvailableBytes: memAvail ?? 0,
      };
    }

    // macOS (and any other platform): physical-memory pressure analog. There is
    // no system commit limit, so model limit = physical (+ swap) and charge =
    // used. This is intentionally approximate — the watchdog treats it as the
    // best available headroom signal on macOS.
    const info = deps.systemMemoryInfo();
    if (!info || !(info.total > 0)) return null;
    const totalBytes = info.total * 1024;
    const freeBytes = info.free * 1024;
    const swapTotalBytes = (info.swapTotal ?? 0) * 1024;
    const swapFreeBytes = (info.swapFree ?? 0) * 1024;
    const limitBytes = totalBytes + swapTotalBytes;
    const availableBytes = freeBytes + swapFreeBytes;
    return {
      source: 'macos-fallback',
      commitLimitBytes: limitBytes,
      commitChargeBytes: Math.max(0, limitBytes - availableBytes),
      commitAvailableBytes: availableBytes,
      physicalTotalBytes: totalBytes,
      physicalAvailableBytes: freeBytes,
    };
  } catch {
    // Any syscall/parse failure → sampler failure (fail-closed on static caps).
    return null;
  }
}
