// git-history.ts — WP5 module 0. The ONLY git-touching helper in src/main
// (hardening-epochs-outcomes §0: "No git helper exists in src/main"). Spawns `git`
// via execFileSync and degrades to `null` on ANY failure (missing binary, not a
// repo, non-zero exit) so callers can fall back to blame → scaffold-constant →
// mtime → none (§3.2). Consumed EXCLUSIVELY by the one-shot cold-start backfill
// (config-epoch-backfill.ts); steady state never invokes git (§3.5).

import { execFileSync } from 'child_process';

/** Minimal git surface. Injectable so tests can drive a synthetic fixture repo or
 *  a fake. Returns stdout on success, `null` on any failure. */
export interface GitRunner {
  run(args: string[], cwd: string): string | null;
}

/** Real `git` via execFileSync. stderr is discarded — a failure IS the signal. */
export const execFileGitRunner: GitRunner = {
  run(args, cwd) {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return null;
    }
  },
};

export interface Revision {
  hash: string;
  committedMs: number;
}

/** Repo root (`git rev-parse --show-toplevel`) for a directory, or null when the
 *  directory is not inside a git work tree / git is unavailable. */
export function repoRootFor(git: GitRunner, dir: string): string | null {
  const out = git.run(['rev-parse', '--show-toplevel'], dir);
  const root = out?.trim();
  return root ? root : null;
}

/** `git log --follow --format=%H:%ct -- <relPath>`, returned OLDEST-FIRST so a
 *  caller scanning for the earliest section-hash match can short-circuit. Empty
 *  array when the path is untracked / has no history / git is unavailable. */
export function listRevisions(git: GitRunner, repoDir: string, relPath: string): Revision[] {
  const treePath = relPath.replace(/\\/g, '/');
  const out = git.run(['log', '--follow', '--format=%H:%ct', '--', treePath], repoDir);
  if (out == null) return [];
  const revs: Revision[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i < 0) continue;
    const hash = t.slice(0, i);
    const ct = Number(t.slice(i + 1));
    if (!hash || !Number.isFinite(ct)) continue;
    revs.push({ hash, committedMs: ct * 1000 });
  }
  // `git log` is newest-first; reverse to oldest-first.
  return revs.reverse();
}

/** `git show <hash>:<relPath>` — file content at a revision, or null (path absent
 *  at that revision, binary, or git failure). */
export function showFileAtRevision(
  git: GitRunner, repoDir: string, hash: string, relPath: string,
): string | null {
  const treePath = relPath.replace(/\\/g, '/');
  return git.run(['show', `${hash}:${treePath}`], repoDir);
}

/** §3.2.2 blame fallback: MAX committer time (ms) over the given 1-indexed line
 *  range's NON-BLANK lines, via `git blame --line-porcelain`. This is "when the
 *  current wording last began" (A2c). null when unavailable / no non-blank line. */
export function blameMaxCommitterMs(
  git: GitRunner, repoDir: string, relPath: string, lineStart: number, lineEnd: number,
): number | null {
  if (lineStart < 1 || lineEnd < lineStart) return null;
  const treePath = relPath.replace(/\\/g, '/');
  const out = git.run(
    ['blame', '--line-porcelain', '-L', `${lineStart},${lineEnd}`, '--', treePath],
    repoDir,
  );
  if (out == null) return null;
  let max = 0;
  let curMs = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('committer-time ')) {
      const ct = Number(line.slice('committer-time '.length).trim());
      curMs = Number.isFinite(ct) ? ct * 1000 : 0;
    } else if (line.startsWith('\t')) {
      // The tab-prefixed line is the actual source content for the current commit block.
      if (line.slice(1).trim() !== '' && curMs > 0) max = Math.max(max, curMs);
    }
  }
  return max > 0 ? max : null;
}
