// SC-WP-3G — index fingerprint (bundle contract v1 §9.3). MAIN-PROCESS ONLY.
//
// `indexFingerprint = sha256( JCS( parsed `git ls-files --stage -z` entries ) )`.
// The fingerprint detects pre-existing staged content and preserves it exactly
// through a candidate commit: two assemblies over the same staged index produce
// the same fingerprint, and any staged mutation flips it.
//
//   • Paths are transported as authoritative bytes (base64 of the raw `-z` record),
//     NEVER string-decoded — a non-UTF-8 staged path still fingerprints exactly.
//   • Unmerged stages (stage != 0) make the candidate INELIGIBLE. We surface
//     `hasUnmerged` rather than throwing so the assembler can render the entry and
//     mark the candidate ineligible (`unsupported-git-state`) with the rest intact.
//   • `write-tree` is an OPTIONAL secondary check (a tree OID) kept where producible;
//     it is NOT the fingerprint — `write-tree` fails on unmerged entries and loses
//     the per-entry shape (mode/oid/stage) the fingerprint binds. It is skipped when
//     the index is unmerged or when no text git seam is provided.

import { createHash } from 'node:crypto';

import { canonicalize } from './jcs';
import { parseStageEntries } from './commit-representation';
import type {
  GitRunBytesResult,
  GitRunResult,
  RunGitOptions,
} from '../git-checkpoints/git-command';

/** Injectable binary git seam — structurally `git-command.runGitBytes`. */
export type IndexFingerprintRunGitBytes = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunBytesResult>;

/** Injectable text git seam — structurally `git-command.runGit` (ascii output). */
export type IndexFingerprintRunGit = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunResult>;

/** One parsed `ls-files --stage -z` record. `stage` is a single porcelain digit;
 *  `pathBytesBase64` is the authoritative path transport form. */
export interface IndexStageEntry {
  mode: string;
  oid: string;
  stage: string;
  pathBytesBase64: string;
}

export interface IndexFingerprintResult {
  /** sha256(JCS(sorted stage entries)); stable across identical staged indexes. */
  fingerprint: string;
  /** The parsed, deterministically sorted stage entries the fingerprint binds. */
  entries: IndexStageEntry[];
  /** TRUE when any entry is at a non-zero (unmerged) stage ⇒ candidate ineligible. */
  hasUnmerged: boolean;
  /** Optional secondary `write-tree` OID; null when unmerged or not producible. */
  writeTreeOid: string | null;
}

/** Repository-wide gate consumed immediately by a fresh sweep iteration. This
 * projection intentionally has no path argument: an unmerged stage anywhere in
 * the index blocks every package in the repository. */
export interface FreshIndexGate {
  fingerprint: string;
  hasUnmerged: boolean;
}

export function freshIndexGate(result: IndexFingerprintResult): FreshIndexGate {
  return {
    fingerprint: result.fingerprint,
    hasUnmerged: result.hasUnmerged,
  };
}

export interface ComputeIndexFingerprintOptions {
  /** Repo-root cwd for git; the real index is read (no `GIT_INDEX_FILE` override). */
  repoRoot: string;
  runGitBytes: IndexFingerprintRunGitBytes;
  /** Provide to enable the optional `write-tree` secondary; omit to skip it. */
  runGit?: IndexFingerprintRunGit;
  gitExe?: string;
  deadlineAt?: number;
  maxBytes?: number;
  /** Default true. When false, the `write-tree` secondary is never attempted. */
  withWriteTree?: boolean;
}

const DEFAULT_MAX_BYTES = 64 << 20;
const LS_FILES_TIMEOUT_MS = 30_000;
const WRITE_TREE_TIMEOUT_MS = 30_000;
const WRITE_TREE_MAX_BYTES = 1 << 20;
const OID_RE = /^[0-9a-f]{40,64}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic order independent of git's emission order: path bytes, then stage. */
function sortEntries(entries: readonly IndexStageEntry[]): IndexStageEntry[] {
  return [...entries].sort((left, right) =>
    compareStrings(left.pathBytesBase64, right.pathBytesBase64)
    || compareStrings(left.stage, right.stage),
  );
}

/**
 * Read the real index's staged entries and canonically fingerprint them. Unmerged
 * stages are surfaced (not thrown) so the caller can render + mark ineligible. The
 * optional `write-tree` secondary is attempted only over a fully-merged index.
 */
export async function computeIndexFingerprint(
  options: ComputeIndexFingerprintOptions,
): Promise<IndexFingerprintResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const staged = await options.runGitBytes(
    options.repoRoot,
    ['ls-files', '--stage', '-z'],
    {
      gitExe: options.gitExe,
      deadlineAt: options.deadlineAt,
      timeoutMs: LS_FILES_TIMEOUT_MS,
      maxBytes,
    },
  );
  if (staged.code !== 0) {
    throw new Error(`git ls-files --stage exited ${staged.code} while fingerprinting the index.`);
  }

  const entries = sortEntries(parseStageEntries(staged.stdout));
  const hasUnmerged = entries.some((entry) => entry.stage !== '0');
  const fingerprint = sha256(canonicalize(
    entries.map((entry) => ({
      mode: entry.mode,
      oid: entry.oid,
      stage: entry.stage,
      pathBytesBase64: entry.pathBytesBase64,
    })),
  ));

  let writeTreeOid: string | null = null;
  if (options.withWriteTree !== false && options.runGit && !hasUnmerged) {
    try {
      const tree = await options.runGit(options.repoRoot, ['write-tree'], {
        gitExe: options.gitExe,
        deadlineAt: options.deadlineAt,
        allowNonzero: true,
        timeoutMs: WRITE_TREE_TIMEOUT_MS,
        maxBytes: WRITE_TREE_MAX_BYTES,
      });
      const oid = tree.stdout.trim();
      if (tree.code === 0 && OID_RE.test(oid)) writeTreeOid = oid;
    } catch {
      // `write-tree` is a best-effort secondary; a failure never invalidates the
      // authoritative fingerprint. Leave the secondary null.
      writeTreeOid = null;
    }
  }

  return { fingerprint, entries, hasUnmerged, writeTreeOid };
}
