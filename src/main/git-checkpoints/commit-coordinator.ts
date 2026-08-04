// Save-card SC-WP-4D — CommitCoordinator core. MAIN-PROCESS ONLY.
//
// The ONE component allowed to write the real Git index. It consumes a minted
// candidate token, reassembles + revalidates live state, and lands EXACTLY the
// previewed bytes with a single path-scoped `git commit --only`, then classifies
// the observed repository state into a normative `CommitOutcome` (contract §9.4).
//
// TWO COMPLEMENTARY SERIALIZATION SEAMS (contract §10 D-2), never interchangeable:
//   1. the COMPOSE LOCK (`ComposeLockRegistry`, keyed by `repositoryKey`) grants
//      index EXCLUSIVITY — at most one `consuming` candidate per real index. It is
//      acquired SYNCHRONOUSLY before the token CAS and held through commit +
//      post-commit verify.
//   2. `CheckpointQueue.withLock(objectDatabaseKey, …)` (uninterrupted RESTORE
//      priority, infinite deadline) serializes the worktree/index MUTATION against
//      restore, which is the other compound real-index mutation. Commit and restore
//      must never interleave.
//
// ORDERING (contract §9.2, WP-4D — reversed so a losing race never consumes):
//   1. resolve the token read-only (repositoryKey + contract-version gate);
//   2. synchronously TRY-ACQUIRE the compose lock;
//   3. lock unavailable ⇒ return `compose-in-flight` BEFORE the CAS (token stays
//      `issued`);
//   4. CAS `issued → consuming`;
//   5. CAS fails (same-token double-click / already consumed) ⇒ release the lock
//      IMMEDIATELY, nothing consumed;
//   6. only then the async reassembly / Git work.
//
// ABORT-NEVER-REPAIR (D-6): no checkout / restore / clean / reset / stash on ANY
// path, including a post-commit integrity incident. A real marked commit is never
// discarded or auto-rolled-back.
//
// The heavy live-reassembly + per-member re-read are INJECTED seams (production
// wiring — CommitCandidateService + temp-index reads — is WP-4E's job); the
// coordinator OWNS the ordering, the identity/byte revalidation verdict, the exact
// `git commit --only` invocation, reflog-marked commit identification, outcome
// classification, and temp-file cleanup, all of which are exercised here.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CandidateMember,
  CommitOutcome,
  EncodedGitPath,
} from '../../shared/commit-candidates';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type {
  CommitAttemptResolution,
  PendingCommitAttempt,
} from '../database';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { parseStageEntries } from '../commit-candidates/commit-representation';
import { gitArgsPrefix } from '../git/git-runtime';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { CheckpointQueue, type SkippedDeadline } from './checkpoint-queue';
import type {
  GitRunBytesResult,
  GitRunResult,
  RunGitOptions,
} from './git-command';

const COMMIT_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 30_000;
const READ_MAX_BYTES = 64 << 20;
const SMALL_MAX_BYTES = 1 << 20;
const OID_RE = /^[0-9a-f]{40,64}$/;
const MAX_MESSAGE_CHARS = 20_000;

// ── Injected seams ────────────────────────────────────────────────────────────

/** Structurally `git-command.runGit`. */
export type CoordinatorRunGit = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;
/** Structurally `git-command.runGitBytes`. */
export type CoordinatorRunGitBytes = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunBytesResult>;

/** The read-only + CAS token surface the coordinator needs. In production this is
 *  satisfied by `CommitCandidateService.{resolveCandidateToken, tryMarkTokenConsuming,
 *  markTokenConsumed}` (WP-4B). */
export interface CoordinatorTokenStore {
  /** Non-consuming resolve; null for unknown / expired / not-`issued`. */
  resolve(tokenId: string): CandidateTokenSnapshot | null;
  /** Atomic `issued → consuming` CAS; null when the token is not freshly issued. */
  tryConsume(tokenId: string): CandidateTokenSnapshot | null;
  /** Terminal `consuming → consumed`; single-use invalidation. */
  markConsumed(tokenId: string): boolean;
}

/** The durable attempt ledger (WP-4C `insertPendingCommitAttempt` / `resolveCommitAttempt`). */
export interface CoordinatorAttemptStore {
  insertPending(attempt: PendingCommitAttempt): void;
  resolve(attemptId: string, resolution: CommitAttemptResolution): void;
}

/** A live member re-derived at consume time. `commitPathspecs` (every old/new path a
 *  rename/delete/copy needs) is NOT on the frozen `CandidateMember`, so it must come
 *  from the fresh reassembly — the coordinator writes exactly these raw bytes. */
export interface LiveMember {
  entryId: string;
  path: EncodedGitPath;
  commitPathspecs: EncodedGitPath[];
  expectedWorktreeState: 'present' | 'absent';
  rawWorktreeBlobOid: string | null;
}

/** The freshly reassembled candidate state (production: full CommitCandidateService
 *  pipeline). `candidateId` cryptographically binds the member manifest + topology +
 *  pinned HEAD + index fingerprint (§4.2), so an equal `candidateId` proves the
 *  manifest unchanged; `componentTopologyDigest` + `eligible` are compared alongside
 *  it belt-and-suspenders per the WP ordering. */
export interface LiveReassembly {
  candidateId: string;
  componentTopologyDigest: string;
  eligible: boolean;
  ineligibleReason: string | null;
  members: LiveMember[];
  pinnedHeadOid: string | null;
}

/** One selected path's CURRENT raw + clean-filtered representation, re-read WITHOUT
 *  the object-db queue (the coordinator already holds `withLock`, so re-entering the
 *  queue on the same key would deadlock). Structurally `CommitRepresentation`. */
export interface MemberRepresentation {
  expectedState: 'present' | 'absent';
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

export interface ReadMemberRepresentationInput {
  repoRoot: string;
  gitExe?: string;
  pinnedHeadOid: string | null;
  member: LiveMember;
}

export interface CommitCoordinatorDeps {
  composeLocks: ComposeLockRegistry;
  queue: CheckpointQueue;
  tokens: CoordinatorTokenStore;
  attempts: CoordinatorAttemptStore;
  runGit: CoordinatorRunGit;
  runGitBytes: CoordinatorRunGitBytes;
  /** Rebuild live candidate state from the immutable snapshot. */
  reassemble(snapshot: CandidateTokenSnapshot): Promise<LiveReassembly>;
  /** Re-read one member's current raw + clean-filtered representation (no queue). */
  readMemberRepresentation(input: ReadMemberRepresentationInput): Promise<MemberRepresentation>;
  /** Resolve the on-disk repo root + git exe for a snapshot (raw paths never live in
   *  the RepositoryIdentity DTO). */
  locateRepository(snapshot: CandidateTokenSnapshot): { repoRoot: string; gitExe?: string };
  now?(): number;
  newAttemptId?(): string;
  /** Temp dir root for the pathspec + message files (default `os.tmpdir()`). */
  tmpDir?: string;
  platform?: NodeJS.Platform;
  /** Base env for the commit (default `process.env`); GIT_REFLOG_ACTION is layered on. */
  env?: NodeJS.ProcessEnv;
  /** Server-side message validation (default: trim, non-empty, bounded, no NUL). */
  validateMessage?(raw: string): string;
  /** Server-derived `Lares-*` trailers from the immutable snapshot (default below);
   *  NEVER renderer-trusted. */
  deriveTrailers?(snapshot: CandidateTokenSnapshot): string[];
  contractVersion?: number;
}

export interface CommitRequest {
  tokenId: string;
  /** Renderer-supplied, separately validated user message (NOT trailers). */
  message: string;
}

/** The coordinator's result. `outcome` is present only once a `commit_attempts` row
 *  exists (i.e. the token was consumed); the pre-CAS rejections never mint an attempt. */
export type CommitCoordinatorResult =
  | { kind: 'token-unresolved' }
  | { kind: 'invalid-message'; reason: string }
  | { kind: 'compose-in-flight' }
  | { kind: 'outcome'; outcome: CommitOutcome };

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultValidateMessage(raw: string): string {
  if (typeof raw !== 'string') throw new Error('commit message must be a string');
  if (raw.includes('\0')) throw new Error('commit message must not contain NUL');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (normalized.trim().length === 0) throw new Error('commit message must not be empty');
  if (normalized.length > MAX_MESSAGE_CHARS) throw new Error('commit message exceeds the length cap');
  return normalized;
}

/** Deterministic, server-only trailer block from the immutable snapshot. Renderer
 *  input never contributes; this reads ONLY the frozen associations + candidateId. */
function defaultDeriveTrailers(snapshot: CandidateTokenSnapshot): string[] {
  const turnIds = new Set<string>();
  const planIds = new Set<string>();
  for (const association of snapshot.associations) {
    for (const turnId of association.contributingTurnIds) turnIds.add(turnId);
    if (association.planId) planIds.add(association.planId);
  }
  const trailers = [`Lares-Candidate: ${snapshot.candidate.candidateId}`];
  for (const turnId of [...turnIds].sort()) trailers.push(`Lares-Turn: ${turnId}`);
  for (const planId of [...planIds].sort()) trailers.push(`Lares-Plan: ${planId}`);
  return trailers;
}

// ── Pure byte helpers ─────────────────────────────────────────────────────────

function pathBytes(encoded: EncodedGitPath): Buffer {
  const bytes = Buffer.from(encoded.pathBytesBase64, 'base64');
  if (bytes.length === 0 || bytes.includes(0) || bytes.toString('base64') !== encoded.pathBytesBase64) {
    throw new Error('Git path bytes must be canonical base64, non-empty, and contain no NUL.');
  }
  return bytes;
}

function nulDelimited(paths: readonly EncodedGitPath[]): Buffer {
  return Buffer.concat(paths.flatMap((encoded) => [pathBytes(encoded), Buffer.from([0])]));
}

/** One `git update-index --index-info -z` record: `<mode> <oid>\t<pathbytes>\0`.
 *  The path is transported as RAW bytes (like every other pathspec seam here) so a
 *  spaced / leading-dash / non-UTF-8 name is never re-split into an argv token. */
function indexInfoRecord(mode: string, oid: string, encoded: EncodedGitPath): Buffer {
  return Buffer.concat([Buffer.from(`${mode} ${oid}\t`, 'ascii'), pathBytes(encoded), Buffer.from([0])]);
}

/** Union of every member's commitPathspecs, deduped by path bytes, deterministically
 *  sorted — the exact bytes written to the NUL pathspec file AND the set excluded from
 *  the post-commit index-integrity comparison. */
function commitPathspecUnion(members: readonly LiveMember[]): EncodedGitPath[] {
  const byBytes = new Map<string, EncodedGitPath>();
  for (const member of members) {
    for (const spec of member.commitPathspecs) byBytes.set(spec.pathBytesBase64, spec);
  }
  return [...byBytes.values()].sort((a, b) => (a.pathBytesBase64 < b.pathBytesBase64 ? -1 : a.pathBytesBase64 > b.pathBytesBase64 ? 1 : 0));
}

interface TreeEntry { mode: string; oid: string; }

/** Parse `git ls-tree -r -z --full-tree` output: `<mode> <type> <oid>\t<path>\0`. */
function parseLsTreeZ(stdout: Buffer): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i !== stdout.length && stdout[i] !== 0) continue;
    if (i === start) { start = i + 1; continue; }
    const record = stdout.subarray(start, i);
    start = i + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Malformed ls-tree record: missing TAB.');
    const meta = record.subarray(0, tab).toString('ascii').split(' ');
    if (meta.length !== 3) throw new Error('Malformed ls-tree metadata.');
    map.set(record.subarray(tab + 1).toString('base64'), { mode: meta[0], oid: meta[2] });
  }
  return map;
}

interface StageKeyed { mode: string; oid: string; }

function indexByPathStage(stdout: Buffer): Map<string, StageKeyed> {
  const map = new Map<string, StageKeyed>();
  for (const entry of parseStageEntries(stdout)) {
    map.set(`${entry.pathBytesBase64} ${entry.stage}`, { mode: entry.mode, oid: entry.oid });
  }
  return map;
}

export interface IndexIntegrityResult {
  status: 'verified' | 'mismatch' | 'unavailable';
  mismatchedPaths: EncodedGitPath[];
}

/** Unrelated pre-existing staged entries must remain BYTE-FOR-BYTE identical across
 *  the commit; selected (member) paths may legitimately change to reflect the new
 *  HEAD and are excluded (contract §9.4 post-commit index verification). */
function compareIndexIntegrity(
  before: Buffer,
  after: Buffer,
  memberPathBytes: ReadonlySet<string>,
): IndexIntegrityResult {
  const beforeMap = indexByPathStage(before);
  const afterMap = indexByPathStage(after);
  const mismatched = new Map<string, EncodedGitPath>();
  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const pathBytesBase64 = key.slice(0, key.indexOf(' '));
    if (memberPathBytes.has(pathBytesBase64)) continue;
    const b = beforeMap.get(key);
    const a = afterMap.get(key);
    if (!b || !a || b.mode !== a.mode || b.oid !== a.oid) {
      mismatched.set(pathBytesBase64, encodeGitPath(Buffer.from(pathBytesBase64, 'base64')));
    }
  }
  return {
    status: mismatched.size ? 'mismatch' : 'verified',
    mismatchedPaths: [...mismatched.values()],
  };
}

function representationMatches(rep: MemberRepresentation, member: CandidateMember): boolean {
  return rep.expectedState === member.expectedWorktreeState
    && rep.rawBlobOid === member.rawWorktreeBlobOid
    && rep.commitBlobOid === member.expectedCommitBlobOid
    && rep.commitMode === member.expectedCommitMode;
}

// ── The locked mutation result (internal) ─────────────────────────────────────

type LockedResult =
  | { kind: 'stale'; reason: string; resolvedHeadOid: string | null }
  | { kind: 'aborted-error'; reason: string; resolvedHeadOid: string | null }
  | { kind: 'uncertain'; identifiedCommitOid: string | null; resolvedHeadOid: string }
  | {
      kind: 'committed';
      commitOid: string;
      integrity: IndexIntegrityResult;
      resolvedHeadOid: string;
      mismatchedTreePaths: EncodedGitPath[];
    };

// ── Coordinator ───────────────────────────────────────────────────────────────

export class CommitCoordinator {
  private readonly d: CommitCoordinatorDeps;
  private readonly now: () => number;
  private readonly newAttemptId: () => string;
  private readonly validateMessage: (raw: string) => string;
  private readonly deriveTrailers: (snapshot: CandidateTokenSnapshot) => string[];
  private readonly contractVersion: number;
  private readonly platform: NodeJS.Platform;

  constructor(deps: CommitCoordinatorDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.newAttemptId = deps.newAttemptId ?? (() => randomUUID());
    this.validateMessage = deps.validateMessage ?? defaultValidateMessage;
    this.deriveTrailers = deps.deriveTrailers ?? defaultDeriveTrailers;
    this.contractVersion = deps.contractVersion ?? BUNDLE_CONTRACT_VERSION;
    this.platform = deps.platform ?? process.platform;
  }

  /**
   * Consume `request.tokenId` and land the previewed bytes. See the file header for
   * the exact ordering; the compose lock is acquired before the CAS and the CAS
   * happens before any async Git work, so a losing race never consumes the token.
   */
  async commit(request: CommitRequest): Promise<CommitCoordinatorResult> {
    // 1. Resolve read-only + contract-version gate (no lock, no CAS).
    const snapshot = this.d.tokens.resolve(request.tokenId);
    if (!snapshot) return { kind: 'token-unresolved' };
    if (snapshot.candidate.contractVersion !== this.contractVersion) return { kind: 'token-unresolved' };

    // Message is renderer input, independent of repo state — validate before we
    // touch the lock so a bad message never consumes or serializes anything.
    let message: string;
    try {
      message = this.validateMessage(request.message);
    } catch (error) {
      return { kind: 'invalid-message', reason: error instanceof Error ? error.message : String(error) };
    }

    // 2. Synchronously try-acquire the compose lock (index exclusivity).
    const lease = this.d.composeLocks.tryAcquire(snapshot.repositoryKey);
    // 3. Unavailable ⇒ compose-in-flight BEFORE the CAS; token stays `issued`.
    if (!lease) return { kind: 'compose-in-flight' };

    // 4. CAS issued → consuming.
    const consuming = this.d.tokens.tryConsume(request.tokenId);
    if (!consuming) {
      // 5. CAS lost (same-token double-click / already consumed) ⇒ release now.
      lease.release();
      return { kind: 'token-unresolved' };
    }

    // 6. Async reassembly / Git work. Once `consuming`, the token is consumed
    //    regardless of outcome (contract §9.2).
    try {
      const outcome = await this.runConsume(snapshot, message);
      return { kind: 'outcome', outcome };
    } finally {
      this.d.tokens.markConsumed(request.tokenId);
      lease.release();
    }
  }

  private async runConsume(
    snapshot: CandidateTokenSnapshot,
    message: string,
  ): Promise<CommitOutcome> {
    const attemptId = this.newAttemptId();
    const reflogAction = `lares-commit:${attemptId}`;
    const pinnedHeadOid = snapshot.pinnedHeadOid;
    const { repoRoot, gitExe } = this.d.locateRepository(snapshot);

    // Persist the pending attempt row BEFORE any mutation (contract §9.4.1).
    this.d.attempts.insertPending({
      attemptId,
      repositoryKey: snapshot.repositoryKey,
      candidateId: snapshot.candidate.candidateId,
      tokenId: snapshot.token.tokenId,
      pinnedHeadOid: pinnedHeadOid ?? '',
      reflogAction,
      startedAt: this.now(),
    });

    const resolveAttempt = (
      resolvedHeadOid: string | null,
      identifiedCommitOid: string | null,
      outcomeStatus: CommitOutcome['status'],
    ): void => {
      this.d.attempts.resolve(attemptId, {
        resolvedHeadOid: resolvedHeadOid ?? '',
        identifiedCommitOid,
        outcomeStatus,
        endedAt: this.now(),
      });
    };

    // Reassemble live + identity compare (outside `withLock` — reassembly itself
    // uses the object-db queue, so it must not run while we hold that key's lock).
    let live: LiveReassembly;
    try {
      live = await this.d.reassemble(snapshot);
    } catch (error) {
      const head = await this.readHead(repoRoot, gitExe);
      resolveAttempt(head, null, 'aborted-error');
      return { status: 'aborted-error', reason: `reassembly failed: ${error instanceof Error ? error.message : String(error)}`, attemptId };
    }

    const identical =
      live.eligible
      && live.candidateId === snapshot.candidate.candidateId
      && live.componentTopologyDigest === snapshot.componentTopologyDigest
      && (live.pinnedHeadOid ?? null) === (pinnedHeadOid ?? null);
    if (!identical) {
      const head = await this.readHead(repoRoot, gitExe);
      const reason = !live.eligible
        ? `candidate no longer eligible: ${live.ineligibleReason ?? 'unknown'}`
        : 'candidate diverged since mint (stale topology / identity)';
      resolveAttempt(head, null, 'aborted-stale');
      return { status: 'aborted-stale', reason, attemptId };
    }

    // The compound worktree/index mutation runs uninterrupted under the object-db
    // key (RESTORE priority, infinite deadline) so commit and restore never
    // interleave. Direct git (no queue re-entry) inside — the key is held.
    const settled = await this.d.queue.withLock(
      snapshot.candidate.repository.objectDatabaseKey,
      () => this.runLockedCommit(snapshot, live, message, repoRoot, gitExe, reflogAction, pinnedHeadOid),
    );
    if (isSkipped(settled)) {
      const head = await this.readHead(repoRoot, gitExe);
      resolveAttempt(head, null, 'aborted-error');
      return { status: 'aborted-error', reason: 'object-db queue skipped the commit', attemptId };
    }
    const locked = settled;

    switch (locked.kind) {
      case 'stale':
        resolveAttempt(locked.resolvedHeadOid, null, 'aborted-stale');
        return { status: 'aborted-stale', reason: locked.reason, attemptId };
      case 'aborted-error':
        resolveAttempt(locked.resolvedHeadOid, null, 'aborted-error');
        return { status: 'aborted-error', reason: locked.reason, attemptId };
      case 'uncertain':
        // Preserve the identified OID as evidence, but create NO exact candidate
        // links (parent unexpected or tree unverifiable) — that is WP-4G's gate.
        resolveAttempt(locked.resolvedHeadOid, locked.identifiedCommitOid, 'repository-state-uncertain');
        return {
          status: 'repository-state-uncertain',
          pinnedHeadOid: pinnedHeadOid ?? '',
          resolvedHeadOid: locked.resolvedHeadOid,
          attemptId,
        };
      case 'committed': {
        const drift = locked.resolvedHeadOid !== locked.commitOid
          ? { resolvedHeadOid: locked.resolvedHeadOid }
          : undefined;
        const indexMismatchedPaths = locked.integrity.status === 'mismatch'
          ? locked.integrity.mismatchedPaths
          : undefined;
        if (locked.mismatchedTreePaths.length > 0) {
          // A hook altered SELECTED content: the commit exists; classify as an
          // integrity mismatch, never "commit failed", never auto-rollback (D-6).
          resolveAttempt(locked.resolvedHeadOid, locked.commitOid, 'committed-integrity-mismatch');
          return {
            status: 'committed-integrity-mismatch',
            commitOid: locked.commitOid,
            attemptId,
            mismatchedPaths: locked.mismatchedTreePaths,
            indexIntegrity: locked.integrity.status,
            ...(indexMismatchedPaths ? { indexMismatchedPaths } : {}),
            ...(drift ? { currentHeadDrift: drift } : {}),
          };
        }
        resolveAttempt(locked.resolvedHeadOid, locked.commitOid, 'committed');
        return {
          status: 'committed',
          commitOid: locked.commitOid,
          attemptId,
          indexIntegrity: locked.integrity.status,
          ...(indexMismatchedPaths ? { indexMismatchedPaths } : {}),
          ...(drift ? { currentHeadDrift: drift } : {}),
        };
      }
    }
  }

  /** Everything inside the object-db lock: final byte revalidation → single
   *  `git commit --only` → reflog-marked identification → classification. */
  private async runLockedCommit(
    snapshot: CandidateTokenSnapshot,
    live: LiveReassembly,
    message: string,
    repoRoot: string,
    gitExe: string | undefined,
    reflogAction: string,
    pinnedHeadOid: string | null,
  ): Promise<LockedResult> {
    const pathspecs = commitPathspecUnion(live.members);
    const memberPathBytes = new Set(pathspecs.map((spec) => spec.pathBytesBase64));
    const expectedByEntryId = new Map(snapshot.candidate.members.map((m) => [m.entryId, m]));

    // Baseline index snapshot (raw) for the post-commit integrity comparison.
    let beforeIndex: Buffer | null = null;
    try {
      beforeIndex = await this.readIndex(repoRoot, gitExe);
    } catch {
      beforeIndex = null; // integrity becomes 'unavailable' below
    }

    // FINAL raw + clean-filtered byte-match revalidation, immediately before commit
    // (guards the gap between reassembly and this lock). Any drift ⇒ safe abort.
    for (const member of live.members) {
      const expected = expectedByEntryId.get(member.entryId);
      if (!expected) {
        return { kind: 'stale', reason: `member ${member.entryId} vanished from the frozen manifest`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
      }
      let rep: MemberRepresentation;
      try {
        rep = await this.d.readMemberRepresentation({ repoRoot, gitExe, pinnedHeadOid, member });
      } catch (error) {
        return { kind: 'stale', reason: `revalidation read failed for ${member.entryId}: ${error instanceof Error ? error.message : String(error)}`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
      }
      if (!representationMatches(rep, expected)) {
        return { kind: 'stale', reason: `selected bytes moved for ${member.path.displayPath}`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
      }
    }

    // Prepare the raw-byte pathspec file + the message temp file. Owned + unlinked
    // in the finally on EVERY outcome.
    const tempDir = await fs.promises.mkdtemp(path.join(this.d.tmpDir ?? os.tmpdir(), 'lares-commit-'));
    const nonce = randomUUID();
    const pathspecFile = path.join(tempDir, `${nonce}.paths`);
    const messageFile = path.join(tempDir, `${nonce}.msg`);

    // Seeded index entries we introduced so `git commit --only` accepts otherwise-
    // untracked members; force-removed again unless the commit actually lands. See
    // seedUntrackedMembers / rollbackSeeds.
    const seeded: EncodedGitPath[] = [];
    let commitLanded = false;

    try {
      // `git commit --only <pathspec>` matches its pathspecs ONLY against paths
      // already known to Git (index/HEAD); a brand-new untracked member (or a
      // rename whose destination is untracked) makes it refuse the whole commit.
      // Pre-seed each such member into the real index with its PINNED clean-filtered
      // blob/mode (the object was materialized during the revalidation read just
      // above, so it exists) — never the working-tree bytes — so the pathspec
      // matches. `commit --only` then re-reads the (already-revalidated-equal)
      // worktree, so the seed's OID does not decide the committed bytes; it only
      // makes the path committable. Every seed is rolled back below unless the
      // commit lands (§9.4 abort invariant). Foreign staged paths are never touched:
      // we seed strictly members that are absent from the real index.
      const seedError = await this.seedUntrackedMembers(
        repoRoot, gitExe, live.members, expectedByEntryId, beforeIndex, pinnedHeadOid, seeded,
      );
      if (seedError) {
        return { kind: 'aborted-error', reason: seedError, resolvedHeadOid: (await this.readHead(repoRoot, gitExe)) ?? '' };
      }

      await fs.promises.writeFile(pathspecFile, nulDelimited(pathspecs));
      const trailers = this.deriveTrailers(snapshot);
      const body = `${message}\n\n${trailers.join('\n')}\n`;
      await fs.promises.writeFile(messageFile, body, 'utf8');

      const commitRes = await this.d.runGit(
        repoRoot,
        [
          ...gitArgsPrefix('commit', this.platform),
          'commit',
          '--only',
          `--pathspec-from-file=${pathspecFile}`,
          '--pathspec-file-nul',
          '-F',
          messageFile,
        ],
        {
          gitExe,
          mode: 'user-commit',
          env: { ...(this.d.env ?? process.env), GIT_REFLOG_ACTION: reflogAction },
          allowNonzero: true,
          timeoutMs: COMMIT_TIMEOUT_MS,
          maxBytes: SMALL_MAX_BYTES,
        },
      ).catch((error) => {
        // A lock error (external index.lock) always rejects regardless of
        // allowNonzero; surface it as a non-zero-ish result for classification.
        return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) } as GitRunResult;
      });

      const resolvedHeadOid = (await this.readHead(repoRoot, gitExe)) ?? '';
      const marked = await this.findMarkedCommit(repoRoot, gitExe, reflogAction);

      if (!marked) {
        // No marked commit. HEAD unchanged ⇒ a clean abort; HEAD changed ⇒ a
        // foreign interleave we cannot attribute.
        if (resolvedHeadOid === (pinnedHeadOid ?? '')) {
          const reason = commitRes.code !== 0
            ? (commitRes.stderr.trim() || `git commit exited ${commitRes.code}`).slice(0, 500)
            : 'git commit produced no marked commit';
          return { kind: 'aborted-error', reason, resolvedHeadOid };
        }
        return { kind: 'uncertain', identifiedCommitOid: null, resolvedHeadOid };
      }

      // A marked commit exists ⇒ OUR commit landed and consumed any seeded entries
      // into committed history; never roll them back (D-6 abort-never-repair). Only
      // the no-marked-commit branches above reach the finally with commitLanded=false.
      commitLanded = true;

      // Verify parent == pinnedHeadOid AND the committed tree entries.
      const parent = await this.readParent(repoRoot, gitExe, marked);
      const parentOk = pinnedHeadOid ? parent === pinnedHeadOid : parent === null;
      const tree = await this.readTree(repoRoot, gitExe, marked);
      if (!parentOk || tree === null) {
        // Unexpected parent or unverifiable tree ⇒ uncertain (OID preserved, no
        // exact links).
        return { kind: 'uncertain', identifiedCommitOid: marked, resolvedHeadOid };
      }

      const mismatchedTreePaths = this.compareTree(snapshot.candidate.members, tree);

      // Post-commit index-integrity (unrelated staged entries byte-identical).
      let integrity: IndexIntegrityResult;
      if (!beforeIndex) {
        integrity = { status: 'unavailable', mismatchedPaths: [] };
      } else {
        try {
          const afterIndex = await this.readIndex(repoRoot, gitExe);
          integrity = compareIndexIntegrity(beforeIndex, afterIndex, memberPathBytes);
        } catch {
          integrity = { status: 'unavailable', mismatchedPaths: [] };
        }
      }

      return { kind: 'committed', commitOid: marked, integrity, resolvedHeadOid, mismatchedTreePaths };
    } finally {
      // No commit landed ⇒ undo every seed so an aborted-* / uncertain outcome
      // leaves the real index byte-identical to before (§9.4 abort invariant).
      // Best-effort: a rollback failure must not mask the classified outcome, and
      // no repair verb is available to do better (D-6).
      if (seeded.length > 0 && !commitLanded) {
        await this.rollbackSeeds(repoRoot, gitExe, seeded).catch(() => undefined);
      }
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Stage each present member that `git commit --only` would refuse — i.e. one that
   *  is GENUINELY UNTRACKED: absent from BOTH the real index AND the pinned HEAD tree
   *  (a brand-new file, or a rename destination). A member already known to Git via
   *  the index (foreign/own staged content) or via HEAD (e.g. removed from the index)
   *  needs no seed and is left untouched. Seeds with the member's PINNED clean-filtered
   *  `{expectedCommitBlobOid, expectedCommitMode}` — never working-tree bytes — so the
   *  seed only makes the pathspec matchable; `commit --only` then re-reads the
   *  already-revalidated-equal worktree for the committed bytes. Records each seeded
   *  path in `seeded` for rollback. Returns a reason string on failure (nothing left
   *  staged — `--index-info` is atomic), or null on success/no-op. */
  private async seedUntrackedMembers(
    repoRoot: string,
    gitExe: string | undefined,
    members: readonly LiveMember[],
    expectedByEntryId: Map<string, CandidateMember>,
    beforeIndex: Buffer | null,
    pinnedHeadOid: string | null,
    seeded: EncodedGitPath[],
  ): Promise<string | null> {
    // Without a readable baseline index we cannot tell tracked from untracked, so we
    // seed nothing rather than risk clobbering a member path's existing staged entry.
    if (!beforeIndex) return null;
    const indexPaths = new Set(parseStageEntries(beforeIndex).map((entry) => entry.pathBytesBase64));
    const indexAbsent = members.filter(
      (member) => member.expectedWorktreeState === 'present' && !indexPaths.has(member.path.pathBytesBase64),
    );
    if (indexAbsent.length === 0) return null;

    // A member absent from the index may still be known to Git via HEAD (which
    // `commit --only` accepts without a seed). Only paths absent from HEAD too are
    // truly untracked. If HEAD's tree is unreadable (unborn / corrupt) we cannot
    // prove untracked, so we seed nothing and let the commit proceed or abort itself.
    const headTree = pinnedHeadOid ? await this.readTree(repoRoot, gitExe, pinnedHeadOid) : null;
    if (!headTree) return null;

    const records: Buffer[] = [];
    for (const member of indexAbsent) {
      if (headTree.has(member.path.pathBytesBase64)) continue; // known to Git via HEAD
      const expected = expectedByEntryId.get(member.entryId);
      if (!expected || !expected.expectedCommitBlobOid || !expected.expectedCommitMode) {
        // A present member with no pinned clean-filtered blob/mode cannot be seeded
        // safely; refuse before any mutation so the index stays untouched.
        return `cannot stage untracked member ${member.path.displayPath}: no pinned commit blob/mode`;
      }
      seeded.push(member.path);
      records.push(indexInfoRecord(expected.expectedCommitMode, expected.expectedCommitBlobOid, member.path));
    }
    if (records.length === 0) return null;

    try {
      await this.d.runGit(repoRoot, ['update-index', '--add', '-z', '--index-info'], {
        gitExe,
        stdin: Buffer.concat(records),
        timeoutMs: COMMIT_TIMEOUT_MS,
        maxBytes: SMALL_MAX_BYTES,
      });
      return null;
    } catch (error) {
      // `--index-info` is atomic (a bad record aborts the whole batch), so nothing
      // was applied — but the finally still force-removes `seeded` defensively
      // (force-remove no-ops on an absent path). Report a clean abort.
      return `failed to stage untracked member(s): ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Remove seeded index entries. Every seeded path was absent from the index at
   *  seed time (seedUntrackedMembers only stages index-absent members), so
   *  `--force-remove` restores exactly that prior absent state; it is a no-op on any
   *  path that never actually got staged. Never touches the worktree (D-6). */
  private async rollbackSeeds(
    repoRoot: string,
    gitExe: string | undefined,
    seeded: readonly EncodedGitPath[],
  ): Promise<void> {
    if (seeded.length === 0) return;
    await this.d.runGit(repoRoot, ['update-index', '--force-remove', '-z', '--stdin'], {
      gitExe,
      stdin: nulDelimited(seeded),
      timeoutMs: COMMIT_TIMEOUT_MS,
      maxBytes: SMALL_MAX_BYTES,
    });
  }

  // ── git reads (never mutate) ──────────────────────────────────────────────

  private async readHead(repoRoot: string, gitExe: string | undefined): Promise<string | null> {
    const res = await this.d.runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      gitExe, allowNonzero: true, timeoutMs: READ_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES,
    }).catch(() => null);
    if (!res || res.code !== 0) return null;
    const oid = res.stdout.trim();
    return OID_RE.test(oid) ? oid : null;
  }

  private async readParent(repoRoot: string, gitExe: string | undefined, commitOid: string): Promise<string | null> {
    const res = await this.d.runGit(repoRoot, ['rev-list', '--parents', '-n', '1', commitOid], {
      gitExe, allowNonzero: true, timeoutMs: READ_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES,
    }).catch(() => null);
    if (!res || res.code !== 0) return null;
    const words = res.stdout.trim().split(/\s+/);
    return words.length > 1 && OID_RE.test(words[1]) ? words[1] : null;
  }

  /** Find the attempt's commit from the HEAD reflog marker (§9.4). The reflog subject
   *  carries `lares-commit:<attemptId>`; the entry's `%H` is the commit HEAD pointed
   *  to after that op. Searches ALL recent entries so a later external HEAD advance
   *  never hides our marked commit. */
  private async findMarkedCommit(repoRoot: string, gitExe: string | undefined, marker: string): Promise<string | null> {
    const res = await this.d.runGit(repoRoot, ['reflog', '--format=%H %gs'], {
      gitExe, allowNonzero: true, timeoutMs: READ_TIMEOUT_MS, maxBytes: READ_MAX_BYTES,
    }).catch(() => null);
    if (!res || res.code !== 0) return null;
    for (const line of res.stdout.split(/\r?\n/)) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const oid = line.slice(0, sp);
      if (!OID_RE.test(oid)) continue;
      if (line.slice(sp + 1).includes(marker)) return oid;
    }
    return null;
  }

  private async readTree(repoRoot: string, gitExe: string | undefined, commitOid: string): Promise<Map<string, TreeEntry> | null> {
    const res = await this.d.runGitBytes(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commitOid], {
      gitExe, allowNonzero: true, timeoutMs: READ_TIMEOUT_MS, maxBytes: READ_MAX_BYTES,
    }).catch(() => null);
    if (!res || res.code !== 0) return null;
    try {
      return parseLsTreeZ(res.stdout);
    } catch {
      return null;
    }
  }

  private async readIndex(repoRoot: string, gitExe: string | undefined): Promise<Buffer> {
    const res = await this.d.runGitBytes(repoRoot, ['ls-files', '--stage', '-z'], {
      gitExe, timeoutMs: READ_TIMEOUT_MS, maxBytes: READ_MAX_BYTES,
    });
    return res.stdout;
  }

  /** Which selected members' committed tree entries diverge from the frozen expected
   *  `{expectedCommitBlobOid, expectedCommitMode, expectedWorktreeState}`. */
  private compareTree(members: readonly CandidateMember[], tree: Map<string, TreeEntry>): EncodedGitPath[] {
    const mismatched: EncodedGitPath[] = [];
    for (const member of members) {
      const entry = tree.get(member.path.pathBytesBase64);
      if (member.expectedWorktreeState === 'absent') {
        if (entry) mismatched.push(member.path);
        continue;
      }
      if (!entry || entry.oid !== member.expectedCommitBlobOid || entry.mode !== member.expectedCommitMode) {
        mismatched.push(member.path);
      }
    }
    return mismatched;
  }
}

function isSkipped(value: unknown): value is SkippedDeadline {
  return typeof value === 'object' && value !== null && (value as SkippedDeadline).skipped === 'deadline';
}
