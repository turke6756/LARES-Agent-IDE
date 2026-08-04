// Save-card SC-WP-2G — commit-protection ledger writer + HEAD reconciler.
//
// This module never creates commits or mutates refs/index/worktree. It records
// exact evidence supplied by Lares' commit coordinator and conservatively notes
// externally-created HEAD commits without manufacturing path/turn attribution.

import {
  getCommitRecord as dbGetCommitRecord,
  getPackageFinalization as dbGetPackageFinalization,
  listCommitPathLinks as dbListCommitPathLinks,
  markPackageFinalizationCommitted as dbMarkPackageFinalizationCommitted,
  recordCommitLedger as dbRecordCommitLedger,
  getDb,
  setPackageFinalizationBoundaryStatus as dbSetBoundaryStatus,
  type CommitLedgerWrite,
  type CommitPathLink,
  type CommitRecord,
  type CommitTurnLink,
  type FinalizationBoundaryStatus,
  type PackageFinalization,
} from '../database';
import type {
  CandidateMember,
  CommitOutcome,
  FinalizationMemberDisposition,
} from '../../shared/commit-candidates';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type { FrozenManifestMember } from '../commit-candidates/finalization-service';
import {
  runGit as realRunGit,
  runGitBytes as realRunGitBytes,
  type GitRunBytesResult,
  type GitRunResult,
  type RunGitOptions,
} from './git-command';
import {
  enumerateFinalizationRefs,
  resolveFinalizationRef,
  deleteFinalizationRefs,
} from './finalization-refs';

const GIT_TIMEOUT_MS = 10_000;
const OID_RE = /^[0-9a-f]{40,64}$/;

export type CommitReconcilerRunGit = (
  cwd: string,
  args: string[],
  options: RunGitOptions,
) => Promise<GitRunResult>;

export type CommitReconcilerRunGitBytes = (
  cwd: string,
  args: string[],
  options: RunGitOptions,
) => Promise<GitRunBytesResult>;

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

// ── Save-card SC-WP-4G — committed-candidate ledger + finalization closure ────

export interface CommitClosureStore extends CommitLedgerStore {
  getPackageFinalization(id: string): PackageFinalization | null;
  listCommitPathLinks(repositoryKey: string, pathBytesBase64: readonly string[]): CommitPathLink[];
  markPackageFinalizationCommitted(id: string, releasedAt: number): void;
}

const DATABASE_COMMIT_CLOSURE_STORE: CommitClosureStore = {
  ...DATABASE_STORE,
  getPackageFinalization: dbGetPackageFinalization,
  listCommitPathLinks: dbListCommitPathLinks,
  markPackageFinalizationCommitted: dbMarkPackageFinalizationCommitted,
};

export interface FinalizationClosureMemberResult {
  pathBytesBase64: string;
  /** Null means the member was evaluated but has no exact-content commit proof. */
  disposition: FinalizationMemberDisposition | null;
}

export interface FinalizationClosureResult {
  finalizationId: string;
  closed: boolean;
  lifecycleStatus: 'active' | 'committed';
  members: FinalizationClosureMemberResult[];
}

export type CommitReconciliationErrorCode =
  | 'outcome-not-committed'
  | 'invalid-snapshot'
  | 'parent-mismatch'
  | 'tree-unverifiable'
  | 'tree-mismatch'
  | 'ledger-write-failed'
  | 'closure-failed';

export type ReconcileCommittedCandidateResult =
  | {
      ok: true;
      record: CommitRecord;
      finalizations: FinalizationClosureResult[];
    }
  | {
      ok: false;
      error: { code: CommitReconciliationErrorCode; message: string };
    };

export interface ReconcileCommittedCandidateInput extends ReconcilerGitOptions {
  outcome: CommitOutcome;
  snapshot: CandidateTokenSnapshot;
  runGitBytes?: CommitReconcilerRunGitBytes;
  store?: CommitClosureStore;
  observedAt?: number;
  now?: () => number;
}

interface CommitTreeEntry { mode: string; oid: string; }

function parseCommitTree(stdout: Buffer): Map<string, CommitTreeEntry> {
  const entries = new Map<string, CommitTreeEntry>();
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i < stdout.length && stdout[i] !== 0) continue;
    if (i === start) { start = i + 1; continue; }
    const record = stdout.subarray(start, i);
    start = i + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Malformed ls-tree record: missing TAB.');
    const meta = record.subarray(0, tab).toString('ascii').split(' ');
    if (meta.length !== 3 || !OID_RE.test(meta[2])) {
      throw new Error('Malformed ls-tree metadata.');
    }
    entries.set(record.subarray(tab + 1).toString('base64'), { mode: meta[0], oid: meta[2] });
  }
  return entries;
}

function candidateMemberMatchesTree(
  member: CandidateMember,
  tree: ReadonlyMap<string, CommitTreeEntry>,
): boolean {
  const entry = tree.get(member.path.pathBytesBase64);
  if (member.expectedWorktreeState === 'absent') return entry === undefined;
  return entry !== undefined
    && entry.oid === member.expectedCommitBlobOid
    && entry.mode === member.expectedCommitMode;
}

function manifestMemberIsValid(member: FrozenManifestMember): boolean {
  if (!member.pathBytesBase64 || !['present', 'absent'].includes(member.expectedState)) return false;
  if (member.expectedState === 'absent') {
    return member.commitBlobOid === null && member.commitMode === null;
  }
  return typeof member.commitBlobOid === 'string'
    && OID_RE.test(member.commitBlobOid)
    && typeof member.commitMode === 'string'
    && member.commitMode.length > 0;
}

function selectedMatchesManifest(member: CandidateMember, frozen: FrozenManifestMember): boolean {
  return member.expectedWorktreeState === frozen.expectedState
    && member.expectedCommitBlobOid === frozen.commitBlobOid
    && member.expectedCommitMode === frozen.commitMode;
}

function priorLinkMatchesManifest(link: CommitPathLink, frozen: FrozenManifestMember): boolean {
  return link.expectedState === frozen.expectedState
    && link.commitBlobOid === frozen.commitBlobOid
    && link.commitMode === frozen.commitMode;
}

function parseManifest(json: string): FrozenManifestMember[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || value.length === 0 || !value.every(manifestMemberIsValid)) {
    throw new Error('Finalization member manifest is malformed.');
  }
  const seen = new Set<string>();
  for (const member of value) {
    if (seen.has(member.pathBytesBase64)) throw new Error('Finalization manifest contains a duplicate path.');
    seen.add(member.pathBytesBase64);
  }
  return value;
}

function buildExactLinks(snapshot: CandidateTokenSnapshot): {
  turnLinks: Omit<CommitTurnLink, 'repositoryKey' | 'commitOid'>[];
  pathLinks: Omit<CommitPathLink, 'repositoryKey' | 'commitOid'>[];
} {
  const turnById = new Map<string, Omit<CommitTurnLink, 'repositoryKey' | 'commitOid'>>();
  for (const association of snapshot.associations) {
    for (const turnId of association.contributingTurnIds) {
      const link = {
        turnId,
        planId: association.planId,
        planItemId: association.planItemId,
        relation: 'candidate_member' as const,
        captureQuality: null,
      };
      const prior = turnById.get(turnId);
      if (prior && (prior.planId !== link.planId || prior.planItemId !== link.planItemId)) {
        throw new Error(`Turn ${turnId} has conflicting frozen attribution.`);
      }
      turnById.set(turnId, link);
    }
  }

  const pathLinks = snapshot.candidate.members.map((member) => {
    const contributingTurnIds = [...new Set(
      snapshot.associations
        .filter((association) => association.memberEntryIds.includes(member.entryId))
        .flatMap((association) => association.contributingTurnIds),
    )].sort();
    return {
      pathBytesBase64: member.path.pathBytesBase64,
      expectedState: member.expectedWorktreeState,
      rawBlobOidAtCommit: member.rawWorktreeBlobOid,
      commitBlobOid: member.expectedCommitBlobOid,
      commitMode: member.expectedCommitMode,
      contributingTurnIds,
      overlapCount: contributingTurnIds.length,
    };
  });

  return {
    turnLinks: [...turnById.values()].sort((a, b) => a.turnId.localeCompare(b.turnId)),
    pathLinks,
  };
}

async function verifyCommitParentAndTree(
  input: ReconcileCommittedCandidateInput,
  commitOid: string,
): Promise<
  | { ok: true; parentOid: string | null }
  | { ok: false; code: 'parent-mismatch' | 'tree-unverifiable' | 'tree-mismatch'; message: string }
> {
  const runGit = input.runGit ?? realRunGit;
  const parentResult = await runGit(
    input.repoRoot,
    ['rev-list', '--parents', '-n', '1', commitOid],
    { gitExe: input.gitExe, allowNonzero: true, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 4096 },
  ).catch(() => null);
  if (!parentResult || parentResult.code !== 0) {
    return { ok: false, code: 'parent-mismatch', message: 'Unable to verify the marked commit parent.' };
  }
  const words = parentResult.stdout.trim().split(/\s+/);
  const parentOid = words.length === 2 && OID_RE.test(words[1]) ? words[1] : null;
  const expectedParent = input.snapshot.pinnedHeadOid;
  const parentMatches = words[0] === commitOid
    && (expectedParent === null ? words.length === 1 : words.length === 2 && parentOid === expectedParent);
  if (!parentMatches) {
    return { ok: false, code: 'parent-mismatch', message: 'Marked commit parent does not match the pinned HEAD.' };
  }

  const runGitBytes = input.runGitBytes ?? realRunGitBytes;
  const treeResult = await runGitBytes(
    input.repoRoot,
    ['ls-tree', '-r', '-z', '--full-tree', commitOid],
    { gitExe: input.gitExe, allowNonzero: true, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 << 20 },
  ).catch(() => null);
  if (!treeResult || treeResult.code !== 0) {
    return { ok: false, code: 'tree-unverifiable', message: 'Unable to read the marked commit tree.' };
  }
  let tree: Map<string, CommitTreeEntry>;
  try {
    tree = parseCommitTree(treeResult.stdout);
  } catch (error) {
    return { ok: false, code: 'tree-unverifiable', message: error instanceof Error ? error.message : String(error) };
  }
  const mismatch = input.snapshot.candidate.members.find((member) => !candidateMemberMatchesTree(member, tree));
  if (mismatch) {
    return {
      ok: false,
      code: 'tree-mismatch',
      message: `Marked commit tree does not contain the frozen bytes for ${mismatch.path.displayPath}.`,
    };
  }
  return { ok: true, parentOid };
}

/**
 * Synchronous response-path reconciliation after WP-4D returns `committed`.
 * Parent/tree verification gates the exact ledger write; closure then evaluates
 * every member of every frozen finalization manifest. No failure is swallowed.
 */
export async function reconcileCommittedCandidate(
  input: ReconcileCommittedCandidateInput,
): Promise<ReconcileCommittedCandidateResult> {
  if (input.outcome.status !== 'committed') {
    return {
      ok: false,
      error: { code: 'outcome-not-committed', message: `Cannot reconcile outcome ${input.outcome.status}.` },
    };
  }
  const commitOid = input.outcome.commitOid;
  if (!OID_RE.test(commitOid) || input.snapshot.repositoryKey !== input.snapshot.candidate.repository.repositoryKey) {
    return { ok: false, error: { code: 'invalid-snapshot', message: 'Commit or repository identity is invalid.' } };
  }

  const verified = await verifyCommitParentAndTree(input, commitOid);
  if (!verified.ok) return { ok: false, error: { code: verified.code, message: verified.message } };

  const store = input.store ?? DATABASE_COMMIT_CLOSURE_STORE;
  const selectedByPath = new Map(
    input.snapshot.candidate.members.map((member) => [member.path.pathBytesBase64, member]),
  );
  const candidateFinalizationIds = new Set(
    input.snapshot.candidate.finalizations.map((ref) => ref.finalizationId),
  );

  let closureInputs: Array<{
    row: PackageFinalization;
    manifest: FrozenManifestMember[];
    priorLinks: CommitPathLink[];
  }>;
  try {
    const frozenFinalizationIds = new Set(
      input.snapshot.finalizationManifests.map((frozen) => frozen.finalizationId),
    );
    if (
      candidateFinalizationIds.size !== input.snapshot.finalizationManifests.length
      || frozenFinalizationIds.size !== input.snapshot.finalizationManifests.length
      || [...candidateFinalizationIds].some((id) => !frozenFinalizationIds.has(id))
    ) {
      throw new Error('Candidate finalization refs and frozen manifests disagree.');
    }
    closureInputs = input.snapshot.finalizationManifests.map((frozen) => {
      if (!candidateFinalizationIds.has(frozen.finalizationId)) {
        throw new Error(`Frozen manifest ${frozen.finalizationId} is not covered by the candidate.`);
      }
      const row = store.getPackageFinalization(frozen.finalizationId);
      if (!row || row.repositoryKey !== input.snapshot.repositoryKey) {
        throw new Error(`Finalization ${frozen.finalizationId} is missing or belongs to another repository.`);
      }
      if (row.lifecycleStatus !== 'active' && row.lifecycleStatus !== 'committed') {
        throw new Error(`Finalization ${frozen.finalizationId} is ${row.lifecycleStatus}, not closable.`);
      }
      if (row.memberManifestJson !== frozen.memberManifestJson) {
        throw new Error(`Finalization ${frozen.finalizationId} changed after token mint.`);
      }
      const manifest = parseManifest(frozen.memberManifestJson);
      const priorLinks = store.listCommitPathLinks(
        input.snapshot.repositoryKey,
        manifest.map((member) => member.pathBytesBase64),
      ).filter((link) => link.commitOid !== commitOid);
      return { row, manifest, priorLinks };
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: 'invalid-snapshot', message: error instanceof Error ? error.message : String(error) },
    };
  }

  let exactLinks: ReturnType<typeof buildExactLinks>;
  try {
    exactLinks = buildExactLinks(input.snapshot);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'invalid-snapshot', message: error instanceof Error ? error.message : String(error) },
    };
  }

  let record: CommitRecord;
  try {
    record = await recordLaresCommit({
      repositoryKey: input.snapshot.repositoryKey,
      repoRoot: input.repoRoot,
      gitExe: input.gitExe,
      runGit: input.runGit,
      remoteRefPatterns: input.remoteRefPatterns,
      commitOid,
      parentOid: verified.parentOid,
      observedAt: input.observedAt,
      turnLinks: exactLinks.turnLinks,
      pathLinks: exactLinks.pathLinks,
      store,
      now: input.now,
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: 'ledger-write-failed', message: error instanceof Error ? error.message : String(error) },
    };
  }

  const releasedAt = (input.now ?? Date.now)();
  const finalizations: FinalizationClosureResult[] = [];
  try {
    for (const { row, manifest, priorLinks } of closureInputs) {
      const members = manifest.map((frozen): FinalizationClosureMemberResult => {
        const selected = selectedByPath.get(frozen.pathBytesBase64);
        if (selected && selected.coveringFinalizationIds.includes(row.id)) {
          if (!selectedMatchesManifest(selected, frozen)) {
            throw new Error(`Selected member disagrees with finalization ${row.id}.`);
          }
          return {
            pathBytesBase64: frozen.pathBytesBase64,
            disposition: { state: 'selected-in-candidate', entryId: selected.entryId },
          };
        }
        const prior = priorLinks.find((link) => priorLinkMatchesManifest(link, frozen));
        return {
          pathBytesBase64: frozen.pathBytesBase64,
          disposition: prior
            ? { state: 'already-locally-committed', commitOid: prior.commitOid }
            : null,
        };
      });
      const closed = members.every((member) => member.disposition !== null);
      if (closed && row.lifecycleStatus === 'active') {
        store.markPackageFinalizationCommitted(row.id, releasedAt);
      }
      finalizations.push({
        finalizationId: row.id,
        closed,
        lifecycleStatus: closed ? 'committed' : 'active',
        members,
      });
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: 'closure-failed', message: error instanceof Error ? error.message : String(error) },
    };
  }

  return { ok: true, record, finalizations };
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

// ── Save-card SC-WP-3C — finalization boundary-ref startup reconciliation ─────────
//
// Ref creation and the SQLite finalization row are not one transaction, so a crash
// between them can leave an ORPHAN ref (created, no row) — and retention/pruning or
// an external `git` can delete a ref out from under a still-`ready` row. Startup
// reconciles both directions for one repo:
//   • delete every `refs/lares/finalizations/*` ref with NO active finalization row
//     (orphans — safe: nothing references them);
//   • downgrade a `ready` active row whose durable ref no longer resolves to
//     `unavailable` (the boundary is gone → non-committable until re-finalized).
//
// Ref RELEASE (a committed/superseded finalization's ref) is WP-3F's retention job;
// this pass only GCs orphans and downgrades dangling `ready` rows.

/** The minimal active-finalization projection the finalization reconciler needs. A
 *  FOCUSED read (five columns), not the full-row accessor: the shared `database.ts`
 *  carries a parallel lane's uncommitted work, so WP-3C reads through `getDb()`
 *  rather than adding an accessor to it. */
export interface ActiveFinalizationRow {
  id: string;
  packageId: string;
  packageRevision: number;
  boundaryRef: string | null;
  boundaryStatus: FinalizationBoundaryStatus;
}

export interface FinalizationReconcileStore {
  /** Every `lifecycle_status='active'` finalization for a repository key. */
  listActiveFinalizations(repositoryKey: string): ActiveFinalizationRow[];
  setPackageFinalizationBoundaryStatus(id: string, status: FinalizationBoundaryStatus): void;
}

const DATABASE_FINALIZATION_RECONCILE_STORE: FinalizationReconcileStore = {
  listActiveFinalizations: (repositoryKey) =>
    (getDb()
      .prepare(
        `SELECT id, package_id, package_revision, boundary_ref, boundary_status
           FROM package_finalizations
          WHERE repository_key = ? AND lifecycle_status = 'active'`,
      )
      .all(repositoryKey) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      packageId: r.package_id as string,
      packageRevision: r.package_revision as number,
      boundaryRef: (r.boundary_ref as string | null) ?? null,
      boundaryStatus: r.boundary_status as FinalizationBoundaryStatus,
    })),
  setPackageFinalizationBoundaryStatus: dbSetBoundaryStatus,
};

export interface ReconcileFinalizationRefsDeps {
  repoRoot: string;
  /** The repository key whose active rows scope the downgrade probe. A `ready` row is
   *  only downgraded when ITS repo's ref does not resolve — never another repo's. */
  repositoryKey: string;
  gitExe?: string;
  runGit?: CommitReconcilerRunGit;
  store?: FinalizationReconcileStore;
  logger?: { info(m: string): void; warn(m: string): void };
}

export interface ReconcileFinalizationRefsResult {
  /** Orphan refs (no active row) deleted in one atomic batch. */
  deletedOrphanRefs: string[];
  /** Finalization ids downgraded `ready`→`unavailable` (their ref no longer resolves). */
  downgraded: string[];
}

/**
 * Reconcile finalization boundary refs for one repo against its active rows: GC
 * orphan refs and downgrade `ready` rows whose ref vanished. Repo-global refs are
 * matched to active rows by exact ref string (package ids are globally unique, so a
 * ref can never bleed across repos). Never throws on the downgrade path — an
 * unusable repo aborts enumeration visibly, but a single unresolved ref is a normal
 * downgrade, not a failure.
 */
export async function reconcileFinalizationRefs(
  deps: ReconcileFinalizationRefsDeps,
): Promise<ReconcileFinalizationRefsResult> {
  const runGit = deps.runGit ?? realRunGit;
  const store = deps.store ?? DATABASE_FINALIZATION_RECONCILE_STORE;
  const active = store.listActiveFinalizations(deps.repositoryKey);
  const activeRefs = new Set(
    active.map((row) => row.boundaryRef).filter((ref): ref is string => ref !== null),
  );

  const refs = await enumerateFinalizationRefs({
    repoRoot: deps.repoRoot,
    gitExe: deps.gitExe,
    runGit,
  });
  const orphans = refs.filter((ref) => !activeRefs.has(ref));
  if (orphans.length > 0) {
    const del = await deleteFinalizationRefs({
      repoRoot: deps.repoRoot,
      gitExe: deps.gitExe,
      refs: orphans,
      runGit,
    });
    if (!del.ok) {
      deps.logger?.warn(
        `[finalization-reconcile] orphan-ref delete failed (code ${del.code}): ${del.stderr}`,
      );
    }
  }

  const downgraded: string[] = [];
  for (const row of active) {
    if (row.boundaryStatus !== 'ready' || !row.boundaryRef) continue;
    const oid = await resolveFinalizationRef({
      repoRoot: deps.repoRoot,
      gitExe: deps.gitExe,
      ref: row.boundaryRef,
      runGit,
    });
    if (oid === null) {
      store.setPackageFinalizationBoundaryStatus(row.id, 'unavailable');
      downgraded.push(row.id);
    }
  }

  if (orphans.length || downgraded.length) {
    deps.logger?.info(
      `[finalization-reconcile] ${deps.repoRoot}: GC'd ${orphans.length} orphan ref(s), ` +
        `downgraded ${downgraded.length} dangling ready row(s)`,
    );
  }
  return { deletedOrphanRefs: orphans, downgraded };
}
