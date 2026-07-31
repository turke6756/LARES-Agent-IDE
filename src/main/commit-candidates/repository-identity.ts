// SC-WP-1A — repository identity (bundle contract v1 §1). MAIN-PROCESS ONLY.
//
// Derives the per-worktree `repositoryKey` — the topology + compose-latch key —
// from the REAL index path, and carries `objectDatabaseKey` (the shared
// object-db serialization key) through VERBATIM from the capability probe.
//
// Contract §1 derivation (normative):
//   1. `git rev-parse --absolute-git-dir` and `git rev-parse --git-path index`.
//   2. realpath-canonicalize both where the target exists.
//   3. Normalize Windows drive-letter case + separators consistently with the
//      existing capability probe (`commonDirQueueKey` idiom, git-runtime.ts:608).
//   4. Reject bare repositories.
//   5. `repositoryKey = sha256(canonical absolute index path)` — the index is the
//      mutable resource the latch protects.
//
// `objectDatabaseKey ← capability.commonDirQueueKey` VERBATIM (already
// case-folded on win32; NEVER re-normalized here). Linked worktrees differ in
// `repositoryKey` (distinct index) but SHARE `objectDatabaseKey` (one common
// object db); multiple Lares-workspace aliases of ONE worktree collapse (via
// realpath) to ONE `repositoryKey`.
//
// EVERYTHING that shells out routes through the injected `runGit` seam (the
// git-runtime `RunGit` type), so the unit tests never touch a real git.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { RunGit } from '../git/git-runtime';
import type { GitCapability } from '../../shared/types';

/** How the index path was canonicalized — an EXPLICIT record so an absent /
 *  non-canonicalizable index target is a visible outcome, never a silent crash.
 *  - `realpath`            — the index file itself existed and was realpath'd.
 *  - `directory-fallback`  — the index file was ABSENT; its (existing) parent dir
 *                            was realpath'd and the basename re-joined.
 *  - `normalized-fallback` — neither existed / realpath threw; best-effort
 *                            separator+case normalization only (still deterministic). */
export type IndexCanonicalization = 'realpath' | 'directory-fallback' | 'normalized-fallback';

export type RepositoryIdentityOutcome =
  | {
      ok: true;
      repositoryKey: string;       // sha256(canonical absolute index path)
      objectDatabaseKey: string;   // capability.commonDirQueueKey, VERBATIM
      gitObjectFormat: 'sha1' | 'sha256';
      canonicalIndexPath: string;  // MAIN-PROCESS ONLY — never leaves into a renderer DTO
      indexCanonicalization: IndexCanonicalization;
    }
  | {
      ok: false;
      reason: 'bare-repo' | 'not-a-repo' | 'index-unresolvable' | 'object-db-unavailable';
      detail: string;
    };

/** Injectable filesystem/exec seam. Mirrors `ProbeDeps` in git-runtime so tests
 *  drive derivation with canned git output + a fake realpath — no real git, no
 *  real disk. `realpath` is best-effort (may throw ENOENT); callers here always
 *  guard it. */
export interface RepositoryIdentityDeps {
  runGit: RunGit;
  platform: NodeJS.Platform;
  realpath(p: string): string;
  fileExists(p: string): boolean;
}

/** Default deps against the real filesystem. `runGit` MUST be supplied by the
 *  caller (bound to the workspace dir + internal git); there is no ambient git. */
export function defaultRepositoryIdentityDeps(runGit: RunGit): RepositoryIdentityDeps {
  return {
    runGit,
    platform: process.platform,
    realpath: (p) => fs.realpathSync.native(p),
    fileExists: (p) => fs.existsSync(p),
  };
}

/** Native-separator + win32 case normalization — IDENTICAL idiom to the
 *  capability probe's `commonDirQueueKey` (git-runtime.ts:608: native separators,
 *  then `.toLowerCase()` on win32). This is the ONLY place the index path is
 *  case-folded; the input is expected to already be realpath-canonical where the
 *  target existed. */
export function normalizeIndexKeyPath(p: string, platform: NodeJS.Platform): string {
  const native = platform === 'win32' ? p.replace(/\//g, '\\') : p;
  return platform === 'win32' ? native.toLowerCase() : native;
}

function makeAbsolute(raw: string, workspaceDir: string, platform: NodeJS.Platform): string {
  // git prints forward slashes even on Windows; `--git-path index` is relative to
  // the run cwd (the workspace dir) unless already absolute.
  const native = platform === 'win32' ? raw.replace(/\//g, '\\') : raw;
  return path.isAbsolute(native) ? native : path.resolve(workspaceDir, native);
}

/** Canonicalize the absolute index path, degrading EXPLICITLY when the target is
 *  absent or realpath throws — never crashing. */
function canonicalizeIndexPath(
  indexAbs: string,
  deps: RepositoryIdentityDeps,
): { canonical: string; mode: IndexCanonicalization } {
  if (deps.fileExists(indexAbs)) {
    try {
      return { canonical: deps.realpath(indexAbs), mode: 'realpath' };
    } catch {
      /* fall through to directory / normalized fallback */
    }
  }
  const dir = path.dirname(indexAbs);
  const base = path.basename(indexAbs);
  if (deps.fileExists(dir)) {
    try {
      return { canonical: path.join(deps.realpath(dir), base), mode: 'directory-fallback' };
    } catch {
      /* fall through */
    }
  }
  return { canonical: indexAbs, mode: 'normalized-fallback' };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Derive the `repositoryKey` (and carry `objectDatabaseKey`) for a single
 * workspace's worktree. Bare repos are rejected; an absent / non-canonicalizable
 * index target degrades to an explicit `indexCanonicalization` mode (still a
 * deterministic key), never a throw.
 *
 * @param workspaceDir  the canonical workspace directory `runGit` is bound to
 *                      (used only to make a relative `--git-path index` absolute).
 * @param capability    the capability probe result — the SOLE source of
 *                      `objectDatabaseKey` (`commonDirQueueKey`, used verbatim).
 */
export async function deriveRepositoryIdentity(
  workspaceDir: string,
  capability: Pick<GitCapability, 'commonDirQueueKey'>,
  deps: RepositoryIdentityDeps,
): Promise<RepositoryIdentityOutcome> {
  // These four rev-parse reads are independent. Start them together, then apply
  // the same authoritative result precedence as the former sequential probes:
  // bare rejection, repository validation, index validation, format fallback.
  // This changes only request latency; each value still comes from its original
  // command and is interpreted exactly as before.
  type ProbeResult = Awaited<ReturnType<RepositoryIdentityDeps['runGit']>>;
  type SettledProbe =
    | { ok: true; value: ProbeResult }
    | { ok: false; error: unknown };
  const settle = async (args: string[]): Promise<SettledProbe> => {
    try {
      return { ok: true, value: await deps.runGit(args) };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const unwrap = (probe: SettledProbe): ProbeResult => {
    if (!probe.ok) throw probe.error;
    return probe.value;
  };
  const [bareProbe, gitDirProbe, idxProbe, fmtProbe] = await Promise.all([
    settle(['rev-parse', '--is-bare-repository']),
    settle(['rev-parse', '--absolute-git-dir']),
    settle(['rev-parse', '--git-path', 'index']),
    settle(['rev-parse', '--show-object-format']),
  ]);

  // 4. Reject bare repositories (authoritative live probe; a bare repo has no
  //    work tree and thus no worktree index to latch on).
  const bare = unwrap(bareProbe);
  if (bare.code === 0 && bare.stdout.trim() === 'true') {
    return { ok: false, reason: 'bare-repo', detail: 'Bare repositories have no worktree index and are never assembled.' };
  }

  // 1. Absolute git dir — also confirms this is a repo at all.
  const gitDir = unwrap(gitDirProbe);
  if (gitDir.code !== 0 || !gitDir.stdout.trim()) {
    return { ok: false, reason: 'not-a-repo', detail: (gitDir.stderr.trim() || 'not a git repository').slice(0, 300) };
  }

  // 1. Index path (per-worktree; linked worktrees resolve to their own index).
  const idx = unwrap(idxProbe);
  if (idx.code !== 0 || !idx.stdout.trim()) {
    return { ok: false, reason: 'index-unresolvable', detail: (idx.stderr.trim() || 'could not resolve index path').slice(0, 300) };
  }

  // `objectDatabaseKey` comes STRAIGHT from the probe (already case-folded on
  // win32). A repo with no common-dir queue key is not assemblable.
  const objectDatabaseKey = capability.commonDirQueueKey;
  if (!objectDatabaseKey) {
    return { ok: false, reason: 'object-db-unavailable', detail: 'Capability probe produced no commonDirQueueKey for this workspace.' };
  }

  // 2 + 3. Canonicalize the index path (where it exists) then normalize
  //         separators/case exactly as the probe does for the common dir.
  const indexAbs = makeAbsolute(idx.stdout.trim(), workspaceDir, deps.platform);
  const { canonical, mode } = canonicalizeIndexPath(indexAbs, deps);
  const canonicalIndexPath = normalizeIndexKeyPath(canonical, deps.platform);

  // Object format is for validating Git OIDs ONLY; candidate IDs are always
  // sha256. Best-effort — default sha1 when the probe fails.
  const fmt = unwrap(fmtProbe);
  const gitObjectFormat: 'sha1' | 'sha256' =
    fmt.code === 0 && fmt.stdout.trim() === 'sha256' ? 'sha256' : 'sha1';

  // 5. repositoryKey = sha256(canonical absolute index path).
  return {
    ok: true,
    repositoryKey: sha256Hex(canonicalIndexPath),
    objectDatabaseKey,
    gitObjectFormat,
    canonicalIndexPath,
    indexCanonicalization: mode,
  };
}
