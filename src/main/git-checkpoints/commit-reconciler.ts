// Save-card SC-WP-2G — commit-protection ledger writer + HEAD reconciler.
//
// This module never creates commits or mutates refs/index/worktree. It records
// exact evidence supplied by Lares' commit coordinator and conservatively notes
// externally-created HEAD commits without manufacturing path/turn attribution.

import {
  getCommitRecord as dbGetCommitRecord,
  recordCommitLedger as dbRecordCommitLedger,
  type CommitLedgerWrite,
  type CommitPathLink,
  type CommitRecord,
  type CommitTurnLink,
} from '../database';
import {
  runGit as realRunGit,
  type GitRunResult,
  type RunGitOptions,
} from './git-command';

const GIT_TIMEOUT_MS = 10_000;
const OID_RE = /^[0-9a-f]{40,64}$/;

export type CommitReconcilerRunGit = (
  cwd: string,
  args: string[],
  options: RunGitOptions,
) => Promise<GitRunResult>;

export interface CommitLedgerStore {
  getCommitRecord(repositoryKey: string, commitOid: string): CommitRecord | null;
  recordCommitLedger(write: CommitLedgerWrite): void;
}

const DATABASE_STORE: CommitLedgerStore = {
  getCommitRecord: dbGetCommitRecord,
  recordCommitLedger: dbRecordCommitLedger,
};

export interface ReconcilerGitOptions {
  repoRoot: string;
  gitExe?: string;
  runGit?: CommitReconcilerRunGit;
  /** for-each-ref patterns; defaults to every remote-tracking ref. */
  remoteRefPatterns?: readonly string[];
}

/** Cached hint only. Protection reads independently recompute reachability. */
export async function countConfiguredRemoteRefsContainingCommit(
  commitOid: string,
  options: ReconcilerGitOptions,
): Promise<number> {
  if (!OID_RE.test(commitOid)) return 0;
  const patterns = options.remoteRefPatterns ?? ['refs/remotes'];
  if (patterns.length === 0) return 0;
  const runGit = options.runGit ?? realRunGit;
  const result = await runGit(
    options.repoRoot,
    ['for-each-ref', '--format=%(refname)', `--contains=${commitOid}`, ...patterns],
    {
      gitExe: options.gitExe,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: 16 << 20,
    },
  );
  if (result.code !== 0) return 0;
  return new Set(
    result.stdout.split(/\r?\n/).filter((ref) => ref.startsWith('refs/')),
  ).size;
}

export interface RecordLaresCommitInput extends ReconcilerGitOptions {
  repositoryKey: string;
  commitOid: string;
  parentOid: string | null;
  observedAt?: number;
  turnLinks: readonly Omit<CommitTurnLink, 'repositoryKey' | 'commitOid'>[];
  pathLinks: readonly Omit<CommitPathLink, 'repositoryKey' | 'commitOid'>[];
  store?: CommitLedgerStore;
  now?: () => number;
}

function assertExactLaresInput(input: RecordLaresCommitInput): void {
  if (!input.repositoryKey || !OID_RE.test(input.commitOid)) {
    throw new Error('Lares commit ledger write requires a repository key and valid commit OID.');
  }
  for (const link of input.turnLinks) {
    if (link.relation === 'metadata_only') {
      throw new Error('Lares exact commit links cannot use metadata_only relation.');
    }
  }
  for (const link of input.pathLinks) {
    const present = link.expectedState === 'present';
    if (present !== Boolean(link.commitBlobOid && link.commitMode)) {
      throw new Error('Commit path link state must agree with its frozen commit tree entry.');
    }
  }
}

/** Atomically persist the exact consumed-snapshot evidence for a Lares commit. */
export async function recordLaresCommit(input: RecordLaresCommitInput): Promise<CommitRecord> {
  assertExactLaresInput(input);
  const now = input.now ?? Date.now;
  const reconciledAt = now();
  const pushedRemoteCount = await countConfiguredRemoteRefsContainingCommit(input.commitOid, input)
    .catch(() => 0);
  const record: CommitRecord = {
    repositoryKey: input.repositoryKey,
    commitOid: input.commitOid,
    parentOid: input.parentOid,
    observedAt: input.observedAt ?? reconciledAt,
    source: 'lares',
    pushedRemoteCount,
    lastReconciledAt: reconciledAt,
  };
  (input.store ?? DATABASE_STORE).recordCommitLedger({
    record,
    turnLinks: input.turnLinks.map((link) => ({
      ...link,
      repositoryKey: input.repositoryKey,
      commitOid: input.commitOid,
    })),
    pathLinks: input.pathLinks.map((link) => ({
      ...link,
      repositoryKey: input.repositoryKey,
      commitOid: input.commitOid,
    })),
  });
  return record;
}

export interface ExternalTurnMetadata {
  turnId: string;
  planId?: string | null;
  planItemId?: string | null;
  captureQuality?: string | null;
}

export interface ReconcileCommitHeadInput extends ReconcilerGitOptions {
  repositoryKey: string;
  previousHeadOid: string | null;
  currentHeadOid?: string | null;
  inferredTurns?: readonly ExternalTurnMetadata[];
  store?: CommitLedgerStore;
  now?: () => number;
}

export interface ReconcileCommitHeadResult {
  moved: boolean;
  currentHeadOid: string | null;
  record: CommitRecord | null;
}

async function readHead(runGit: CommitReconcilerRunGit, input: ReconcileCommitHeadInput): Promise<string | null> {
  if (input.currentHeadOid !== undefined) return input.currentHeadOid;
  const result = await runGit(input.repoRoot, ['rev-parse', '--verify', 'HEAD'], {
    gitExe: input.gitExe,
    allowNonzero: true,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: 4096,
  });
  const oid = result.stdout.trim();
  return result.code === 0 && OID_RE.test(oid) ? oid : null;
}

async function readFirstParent(
  runGit: CommitReconcilerRunGit,
  input: ReconcileCommitHeadInput,
  commitOid: string,
): Promise<string | null> {
  const result = await runGit(input.repoRoot, ['rev-list', '--parents', '-n', '1', commitOid], {
    gitExe: input.gitExe,
    allowNonzero: true,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: 4096,
  });
  if (result.code !== 0) return null;
  const words = result.stdout.trim().split(/\s+/);
  return words.length > 1 && OID_RE.test(words[1]) ? words[1] : null;
}

/**
 * Detect a HEAD change relative to the caller's last observation. External
 * commits receive only metadata_only turn rows and no path rows: overlap is a
 * discovery hint, never evidence that the commit contains a turn's bytes.
 */
export async function reconcileCommitHead(
  input: ReconcileCommitHeadInput,
): Promise<ReconcileCommitHeadResult> {
  const runGit = input.runGit ?? realRunGit;
  const currentHeadOid = await readHead(runGit, input);
  if (currentHeadOid === input.previousHeadOid) {
    return { moved: false, currentHeadOid, record: null };
  }
  if (currentHeadOid === null || !OID_RE.test(currentHeadOid)) {
    return { moved: true, currentHeadOid: null, record: null };
  }

  const store = input.store ?? DATABASE_STORE;
  const existing = store.getCommitRecord(input.repositoryKey, currentHeadOid);
  const reconciledAt = (input.now ?? Date.now)();
  const pushedRemoteCount = await countConfiguredRemoteRefsContainingCommit(currentHeadOid, input)
    .catch(() => 0);
  const record: CommitRecord = {
    repositoryKey: input.repositoryKey,
    commitOid: currentHeadOid,
    parentOid: existing?.parentOid ?? await readFirstParent(runGit, input, currentHeadOid),
    observedAt: existing?.observedAt ?? reconciledAt,
    source: existing?.source ?? 'external',
    pushedRemoteCount,
    lastReconciledAt: reconciledAt,
  };
  store.recordCommitLedger({
    record,
    turnLinks: existing
      ? []
      : (input.inferredTurns ?? []).map((turn) => ({
          repositoryKey: input.repositoryKey,
          commitOid: currentHeadOid,
          turnId: turn.turnId,
          planId: turn.planId ?? null,
          planItemId: turn.planItemId ?? null,
          relation: 'metadata_only' as const,
          captureQuality: turn.captureQuality ?? null,
        })),
    // Never infer commit-path evidence for an external commit.
    pathLinks: [],
  });
  return { moved: true, currentHeadOid, record };
}

export const reconcileCommitHeadMovement = reconcileCommitHead;
