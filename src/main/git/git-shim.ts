// Windows `git` shim (Git-Native WP-G0.4) — a narrow parallel to node-shim.ts.
//
// THE PROBLEM. On a git-free Windows machine an agent that types `git` in its
// PTY gets `'git' is not recognized`. Lares can bundle its own MinGit (WP-G0.5)
// and uses it internally for checkpointing, but the agent's SHELL resolves a
// bare `git` off PATH, where there is none.
//
// THE FIX. When — and ONLY when — Lares' internal resolution fell back to the
// BUNDLED git (i.e. the machine has no compatible system git), generate a tiny
// `git` shim that re-execs the bundled `git.exe`, and drop it into the SAME
// userData dir node-shim already appends to every agent PTY's PATH
// (`getNodeShimDir()`). Because that dir is APPENDED, and because we write the
// shim only in the bundled case, a real system git always keeps precedence — the
// shim never shadows it.
//
// WHY THE GUARD IS LOAD-BEARING (system-git-first). If we wrote a bundled-git
// shim unconditionally it would sit on PATH next to the user's real git. Even
// appended, that is a landmine the day the user installs git and we haven't
// re-resolved: the stale shim would answer first for tools that scan the shim
// dir. So: write in the bundled case; in the system/none case, actively REMOVE a
// previously-written shim (our own generated files — trivially safe to delete).
//
// The absolute bundled `git.exe` path is INLINED at generation time; nothing
// git-specific has to be added to the provider env. Resolution shells out
// (WP-G0.2), so this is async; the write itself is idempotent (writeIfChanged).

import fs from 'fs';
import path from 'path';

import type { GitResolution } from '../../shared/types';
import { getNodeShimDir, writeIfChanged } from '../node-shim';
import { resolveInternalGit } from './git-runtime';

/** The two generated shim basenames written into the node-shim dir. */
const GIT_SHIM_CMD = 'git.cmd';
const GIT_SHIM_POSIX = 'git';

export interface EnsureGitShimOptions {
  /** The resolved internal git. Injected in tests so no real resolution runs;
   *  when the property is ABSENT, {@link resolveInternalGit} is used. `null`
   *  (provided) means "no compatible git" and, like a system pick, writes nothing
   *  (and removes any stale shim). */
  internal?: GitResolution['internal'];
  /** Target shim dir. Defaults to {@link getNodeShimDir} — the exact directory
   *  already appended to agent PATHs — so both shims share ONE appended entry.
   *  Injected in tests to avoid touching real userData. */
  shimDir?: string;
}

/** The Windows `git.cmd` — forward every arg to the bundled git verbatim. No env
 *  scoping is needed (unlike node-shim, which must confine ELECTRON_RUN_AS_NODE):
 *  the bundled `git.exe` is an ordinary program. */
function gitCmdContent(gitExe: string): string {
  return '@echo off\r\n' + `"${gitExe}" %*\r\n`;
}

/** Best-effort extensionless shim for Git-Bash / MSYS shells, which resolve
 *  `git` as a program and will NOT pick up `git.cmd` via PATHEXT. Mirrors
 *  node-shim's POSIX shim, including backslash-escaping the Windows path. */
function gitPosixContent(gitExe: string): string {
  return '#!/bin/sh\n' + `exec "${gitExe.replace(/\\/g, '\\\\')}" "$@"\n`;
}

function removeIfPresent(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort — a leftover shim is not fatal, and PATH-appended it never
       shadows a real git anyway */
  }
}

/** Ensure the `git` shim state in the node-shim dir matches the internal
 *  resolution, and return that dir. Never throws (best-effort, like node-shim's
 *  caller contract): a failed write/remove degrades the shim, not the launch.
 *
 *  - internal.source === 'bundled' → write `git.cmd` + `git` pointing at the
 *    bundled `git.exe` (idempotent via writeIfChanged).
 *  - internal.source === 'system', or null → write NOTHING, and remove any shim
 *    we previously wrote (never shadow a real git with a stale bundled pointer).
 */
export async function ensureGitShimDir(opts: EnsureGitShimOptions = {}): Promise<string> {
  const shimDir = opts.shimDir ?? getNodeShimDir();
  try {
    const internal = 'internal' in opts ? opts.internal : await resolveInternalGit();

    const cmdPath = path.join(shimDir, GIT_SHIM_CMD);
    const posixPath = path.join(shimDir, GIT_SHIM_POSIX);

    if (internal && internal.source === 'bundled') {
      fs.mkdirSync(shimDir, { recursive: true });
      writeIfChanged(cmdPath, gitCmdContent(internal.execPath));
      writeIfChanged(posixPath, gitPosixContent(internal.execPath));
    } else {
      // System git wins, or no git at all: our shim must not exist. Removing our
      // own generated files is trivially safe (WP-G0.4 guard).
      removeIfPresent(cmdPath);
      removeIfPresent(posixPath);
    }
  } catch {
    /* never throw — the launch proceeds with whatever shim state exists */
  }
  return shimDir;
}
