// Windows `node` shim (bundled-node-exposure plan §1.1).
//
// THE PROBLEM. On a Node-free Windows machine every Lares-managed hook /
// status-line dies with `'node' is not recognized`. Lares ships a full Node
// runtime *inside* `Lares.exe` (`ELECTRON_RUN_AS_NODE=1`, see
// `src/main/node-runtime.ts`) but never exposes it to the PTYs its agents (and
// their hook subprocesses) run in — they resolve a bare `node` off the system
// PATH, where there is none.
//
// THE FIX. Generate a tiny `node` shim under `userData` and APPEND its directory
// to each agent PTY's PATH (§1.3). The shim re-execs `Lares.exe` as the bundled
// Node runtime. Because it is appended, a real project/system Node keeps
// precedence (§0.3 + §4); the shim is only a fallback.
//
// WHY userData, NOT a workspace scaffold. A scaffold file would contaminate the
// content-hash-keyed, shared-across-agent scaffold upgrade chain
// (`scaffold-writer.ts`). userData is per-user, writable, follows
// reinstall/relocation, and is completely separate from scaffolds.
//
// The absolute `Lares.exe` path is INLINED at generation time so nothing
// Lares-specific has to be added to the provider env, and `ELECTRON_RUN_AS_NODE`
// is confined to the shim process (§0.4) — it never enters the PTY / provider
// CLI environment.
//
// TODO(Phase 2, WSL): this module is Windows-only. A Windows `Lares.exe` cannot
// serve as a WSL runtime (Linux paths / child commands / fs semantics all
// differ, §0.5). WSL Node-free machines get a real bundled Linux Node,
// provisioned off the launch hot path — see plan §2 (`wsl-node-runtime.ts`).

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

let cachedDir: string | null = null;

/** Directory holding the generated `node` shims. Under userData: per-user,
 *  writable, and completely separate from workspace scaffolds. */
export function getNodeShimDir(): string {
  const base = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.lares-runtime');
  return path.join(base, 'node-shim');
}

/** Atomic write-if-content-differs. Exported so the sibling `git-shim` reuses
 *  the exact same idempotent write (WP-G0.4 — reuse, do not fork a shim-util). */
export function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) return;
  } catch { /* fall through to write */ }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.copyFileSync(tmp, file); } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
  }
}

/** Create the Windows `node.cmd` (and a best-effort POSIX `node`) that re-exec
 *  Lares.exe as the bundled Node runtime via ELECTRON_RUN_AS_NODE. Idempotent.
 *  Returns the shim dir, or throws if it cannot be written (caller decides).
 *  `execPath` defaults to Lares.exe (main-process process.execPath). */
export function ensureNodeShimDir(execPath = process.execPath): string {
  const dir = getNodeShimDir();
  fs.mkdirSync(dir, { recursive: true });

  // Shell-facing shim. `setlocal` is load-bearing: ELECTRON_RUN_AS_NODE exists
  // ONLY for the launched Lares.exe, never for the PTY / provider CLI. This is
  // what the Claude/Codex/Gemini hook + statusLine command strings resolve to
  // (they run through cmd.exe / the provider's hook shell).
  const cmd =
    '@echo off\r\n' +
    'setlocal\r\n' +
    'set "ELECTRON_RUN_AS_NODE=1"\r\n' +
    `"${execPath}" %*\r\n`;
  writeIfChanged(path.join(dir, 'node.cmd'), cmd);

  // Best-effort extensionless shim for Git-Bash / MSYS callers that resolve
  // `node` as a program (they will NOT pick up node.cmd via PATHEXT). Windows
  // exe path handed to the exec verbatim; the env flag is scoped to the exec.
  // NOTE: this shim's contract is only "validated" once the §1.5 Git-Bash
  // integration test passes. If that test cannot be made green, DELETE this
  // block and scope the Windows contract to node.cmd (see §1.5).
  const sh =
    '#!/bin/sh\n' +
    `ELECTRON_RUN_AS_NODE=1 exec "${execPath.replace(/\\/g, '\\\\')}" "$@"\n`;
  writeIfChanged(path.join(dir, 'node'), sh);

  cachedDir = dir;
  return dir;
}

/** The shim dir from the last successful {@link ensureNodeShimDir}, or null. */
export function getCachedNodeShimDir(): string | null {
  return cachedDir;
}

/** Append `shimDir` to a PATH-bearing env IN A COPY (system Node keeps
 *  precedence). Case-insensitive PATH key; preserves its original spelling;
 *  de-dupes. Returns a new env object — never mutates the input. */
export function withNodeShimOnPath(
  env: NodeJS.ProcessEnv,
  shimDir: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const cur = out[key] ?? '';
  const parts = cur.split(';').filter((p) => p.trim().length > 0);
  const already = parts.some((p) => p.trim().toLowerCase() === shimDir.toLowerCase());
  if (!already) parts.push(shimDir);
  out[key] = parts.join(';');
  return out;
}
