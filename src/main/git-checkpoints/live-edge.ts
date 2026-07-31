// Shared live checkpoint-edge verification.
//
// A persisted ready bit is only a hint. The authority is a live Git lookup of
// the stored ref, peeled to a commit, whose result exactly matches the stored
// OID. Callers that intentionally require a ready hint (retention) must apply
// that separate policy before calling this verifier.

import type { GitRunResult, RunGitOptions } from './git-command';

/** Injectable seam, structurally identical to git-command.runGit. */
export type LiveEdgeRunGit = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunResult>;

export interface VerifyLiveEdgeOptions {
  repoRoot: string;
  ref: string | null;
  oid: string | null;
  runGit: LiveEdgeRunGit;
  gitExe?: string;
}

/**
 * Return true only when `<ref>^{commit}` resolves live to exactly `oid`.
 * Missing metadata and every Git failure are an unusable edge, never a throw.
 */
export async function verifyLiveEdge(options: VerifyLiveEdgeOptions): Promise<boolean> {
  const { repoRoot, ref, oid, runGit, gitExe } = options;
  if (!ref || !oid) return false;

  try {
    const result = await runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
      gitExe,
      allowNonzero: true,
      timeoutMs: 10_000,
      maxBytes: 1 << 20,
    });
    return result.code === 0 && result.stdout.trim() === oid;
  } catch {
    return false;
  }
}
