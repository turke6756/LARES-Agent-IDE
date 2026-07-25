// git-init.ts — Git-Native WP-G3.4: the human-only `git init` consent action.
// MAIN-PROCESS ONLY.
//
// A non-repo workspace is the honest-disabled checkpoint state (G2): Lares never
// creates a `.git` silently and never keeps a shadow repo. This module turns that
// into an EXPLICIT, human-driven consent action — the person clicks, and only then
// does Lares run `git init` at the workspace root.
//
// It is deliberately a pure decision + one bounded git call, with NO cache
// invalidation of its own: the caller (engine-bootstrap's HumanCheckpointRoutes)
// owns the WP-G0.2/G0.3 seams it must poke on success (the per-workspace capability
// cache + the prerequisite report cache), so the init/invalidate wiring lives next
// to those caches, not here.
//
// Honesty rules:
//   – It re-uses the WP-G0.2 probe (`probeWorkspaceGit`) as the single source of
//     truth for repo-state, protected-root, and git usability — no parallel probe.
//   – It REFUSES (a clean no-op that leaves nothing on disk) for anything other
//     than a healthy non-repo: an existing repo, a protected root, or an unusable
//     git each return a typed non-`ok` result.
//   – `git init` runs through the WP-G1.1 bounded machinery (`runGit`) with the
//     resolved internal git exe — never a raw child_process, never a shell.

import type { GitInitResult } from '../../shared/types';
import { probeWorkspaceGit } from '../git/git-runtime';
import { runGit, GitCommandError } from './git-command';

/** `git init` is a local, near-instant metadata write; a generous bound so a wedged
 *  filesystem degrades to an honest error rather than hanging the IPC call. */
const INIT_TIMEOUT_MS = 10_000;
/** `git init` prints a line or two; a small cap is plenty and keeps output bounded. */
const INIT_MAX_BYTES = 64 * 1024;

/** Injectable seams so the decision matrix + the failure path are unit-testable
 *  without always spawning a real git (the happy path still uses one). */
export interface InitDeps {
  probe?: typeof probeWorkspaceGit;
  runGitFn?: typeof runGit;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the consent action against an ALREADY-canonicalized workspace directory.
 * Probes first, refuses anything but a healthy non-repo, else runs `git init`.
 * Never throws — every outcome is a typed {@link GitInitResult}.
 */
export async function initWorkspaceGitRepo(
  canonicalWorkspaceDir: string,
  gitExe: string,
  deps: InitDeps = {},
): Promise<GitInitResult> {
  const probe = deps.probe ?? probeWorkspaceGit;
  const run = deps.runGitFn ?? runGit;

  let cap;
  try {
    cap = await probe(canonicalWorkspaceDir);
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      message: 'Lares could not inspect this workspace before initializing Git. Nothing was created.',
      detail: errMsg(err),
    };
  }

  // Protected root wins over everything (invariant §8): even a healthy git must
  // never seed a repo at $HOME / Desktop / a drive root.
  if (cap.protectedRoot) {
    return {
      ok: false,
      status: 'protected-root',
      message:
        'This workspace is a protected root (your home folder, Desktop, Documents, Downloads, or a drive/filesystem root). Lares will not create a Git repository here — open a specific project subfolder instead.',
      detail: cap.detail ?? undefined,
    };
  }

  // Git itself must be usable for THIS workspace (binary present + version floor +
  // safe.directory + a supported, non-WSL path). A degraded reason means `git init`
  // could not run cleanly, so refuse rather than attempt it.
  if (cap.reason !== 'ok') {
    return {
      ok: false,
      status: 'unusable-git',
      message:
        'Git is not usable for this workspace, so it cannot be initialized here. See the runtime prerequisites for the specific reason.',
      detail: cap.detail ?? undefined,
    };
  }

  // Only a genuine non-repo may be initialized. An existing repo (or unborn HEAD,
  // nested, spans-boundary) already has — or is governed by — a `.git`; creating
  // another would be exactly the silent shadow-repo we forbid.
  if (cap.repoState !== 'non-repo') {
    return {
      ok: false,
      status: 'already-repo',
      message: 'This workspace is already a Git repository — checkpoints are already enabled.',
    };
  }

  try {
    await run(canonicalWorkspaceDir, ['init'], {
      gitExe,
      maxBytes: INIT_MAX_BYTES,
      timeoutMs: INIT_TIMEOUT_MS,
      mode: 'read', // init needs no committer identity
    });
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      message: 'git init failed — no repository was created.',
      detail: err instanceof GitCommandError ? err.stderrTail || err.message : errMsg(err),
    };
  }

  return {
    ok: true,
    status: 'initialized',
    message: 'Created a Git repository at the workspace root. Checkpoints are now enabled for this workspace.',
  };
}
