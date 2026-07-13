// Real-platform commit reader (incident-2026-07-11 §5 D5-lite).
//
// Wires the pure `readCommit()` state machine (commit-source.ts) to the actual
// platform sources: the Wave-0 native module's `getCommitStatus()` on Windows,
// `/proc/meminfo` on Linux, and Electron's `process.getSystemMemoryInfo()` on
// macOS. The native module is INJECTED (index.ts resolves + requires it) so this
// file stays free of any require-by-path fragility and is unit-testable with a
// fake native provider.

import * as fs from 'node:fs';
import { readCommit, type CommitSourceDeps, type NativeCommitStatus } from './commit-source';
import type { CommitReading } from './types';

/** The subset of the lares-native surface the reader uses (see native/lares-native
 *  index.d.ts). `supported` gates whether `getCommitStatus` is callable. */
export interface NativeCommitProvider {
  supported: boolean;
  getCommitStatus(): NativeCommitStatus;
}

/**
 * Build the platform commit reader the sampler calls every tick. `native` is the
 * loaded lares-native surface (or null when unavailable / non-Windows); on
 * Windows a non-supported/absent module yields `nativeGetCommitStatus: null`,
 * which `readCommit` treats as a sampler failure (fail-open on commit rules,
 * fail-closed on static caps).
 */
export function createCommitReader(native: NativeCommitProvider | null): () => CommitReading | null {
  const deps: CommitSourceDeps = {
    platform: process.platform,
    nativeGetCommitStatus:
      native && native.supported ? () => native.getCommitStatus() : null,
    readProcMeminfo: () => {
      try {
        return fs.readFileSync('/proc/meminfo', 'utf8');
      } catch {
        return null;
      }
    },
    systemMemoryInfo: () => {
      try {
        // Electron augments `process` with getSystemMemoryInfo in the main
        // process; guard for the non-Electron test/runtime case.
        const p = process as unknown as {
          getSystemMemoryInfo?: () => { total: number; free: number; swapTotal?: number; swapFree?: number };
        };
        return typeof p.getSystemMemoryInfo === 'function' ? p.getSystemMemoryInfo() : null;
      } catch {
        return null;
      }
    },
  };
  return () => readCommit(deps);
}
