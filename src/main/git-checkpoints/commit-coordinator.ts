// Save-card SC-WP-4D — CommitCoordinator core. MAIN-PROCESS ONLY.
//
// The ONE component allowed to write the real Git index. It consumes a minted
// candidate token, reassembles + revalidates live state, and lands EXACTLY the
// previewed object IDs with a temporary index + `commit-tree`, then classifies
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
// coordinator OWNS the ordering, the identity/byte revalidation verdict, exact-object
// commit construction, reflog-marked commit identification, outcome
// classification, and temp-file cleanup, all of which are exercised here.
//
// SAVE-PATH HOOK/SIGNING CONTRACT (Edward ruling 2026-08-06, option 1): Lares
// saves deliberately bypass pre-commit and commit-msg hooks and do not request
// commit signing. `commit-tree` consumes the reviewed tree/message directly; do
// not replace it with `git commit` or add hook/index mutation without a new ruling.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CandidateCommitPolicy,
  CandidateMember,
  CommitOutcome,
  EncodedGitPath,
  NormalizedCommitEffect,
} from '../../shared/commit-candidates';
import { BUNDLE_CONTRACT_VERSION } from '../../shared/constants';
import type { CandidateTokenSnapshot } from '../commit-candidates/candidate-service';
import type {
  CommitAttemptResolution,
  IntentCommitLedgerWrite,
  PendingCommitAttempt,
} from '../database';
import { writeIntentCommitLedger } from '../database';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { parseStageEntries } from '../commit-candidates/commit-representation';
import {
  candidateCommitSigningArgs,
  readCandidateCommitPolicy,
  validateCandidateTree,
  type CandidatePolicyInput,
  type CandidateTreeValidationInput,
  type CandidateTreeValidationResult,
} from '../commit-candidates/candidate-validation';
import { ComposeLockRegistry } from '../commit-candidates/compose-lock-registry';
import { CheckpointQueue, type SkippedDeadline } from './checkpoint-queue';
import { advancePlanningActivityHead as advanceActivityHead } from './planning-worktree-service';
import type { PlanningActivityWorktree } from '../database';
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
const REVALIDATION_CONCURRENCY = 8;

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
  /** Temp dir root for the isolated index + message file (default `os.tmpdir()`). */
  tmpDir?: string;
  platform?: NodeJS.Platform;
  /** Base env for the commit (default `process.env`); GIT_REFLOG_ACTION is layered on. */
  env?: NodeJS.ProcessEnv;
  /** Server-side message validation (default: trim, non-empty, bounded, no NUL). */
  validateMessage?(raw: string): string;
  /** Production database transaction; injectable only to prove the post-CAS ledger boundary. */
  writeIntentLedger?(write: IntentCommitLedgerWrite): void;
  /** Server-derived `Lares-*` trailers from the immutable snapshot (default below);
   *  NEVER renderer-trusted. */
  deriveTrailers?(snapshot: CandidateTokenSnapshot): string[] | Promise<string[]>;
  /** WP-D6 seams default to the production local-repository policy and exact-tree
   * validator. Tests may inject them to isolate refusal ordering. */
  resolveCandidateCommitPolicy?(input: CandidatePolicyInput): Promise<CandidateCommitPolicy>;
  validateCandidateTree?(input: CandidateTreeValidationInput): Promise<CandidateTreeValidationResult>;
  contractVersion?: number;
  /** WP-6 production Save seam: activity repositories advance detached HEAD and
   * their durable activity ref in one CAS, then eagerly promote after ledgering. */
  resolvePlanningActivity?(repositoryKey: string): PlanningActivityWorktree | null;
  advancePlanningActivityHead?: typeof advanceActivityHead;
  promotePlanningActivity?(executionRunId: string): Promise<unknown>;
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
export function deriveSnapshotTrailers(
  snapshot: CandidateTokenSnapshot,
  assistedByEnabled = true,
): string[] {
  const turnIds = new Set<string>();
  const planIds = new Set<string>();
  for (const association of snapshot.associations) {
    for (const turnId of association.contributingTurnIds) turnIds.add(turnId);
    if (association.planId) planIds.add(association.planId);
  }
  const trailers = [`Lares-Candidate: ${snapshot.candidate.candidateId}`];
  for (const turnId of [...turnIds].sort()) trailers.push(`Lares-Turn: ${turnId}`);
  for (const planId of [...planIds].sort()) trailers.push(`Lares-Plan: ${planId}`);
  const provenance = snapshot.witnessedProvenance;
  if (assistedByEnabled) {
    for (const identity of provenance?.assistedBy ?? []) {
      if (!/^[A-Za-z0-9._/-]+$/.test(identity.provider)
        || !/^[A-Za-z0-9._/+:-]+$/.test(identity.model)) continue;
      trailers.push(`Assisted-by: ${identity.provider}:${identity.model}`);
    }
  }
  for (const ref of provenance?.localCheckpointRefs ?? []) {
    if (/^refs\/lares\/[A-Za-z0-9._/-]+$/.test(ref)) {
      trailers.push(`Lares-Checkpoint-Ref-Local: ${ref}`);
    }
  }
  return trailers;
}

function defaultDeriveTrailers(snapshot: CandidateTokenSnapshot): string[] {
  return deriveSnapshotTrailers(snapshot);
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Pure byte helpers ─────────────────────────────────────────────────────────

function pathBytes(encoded: EncodedGitPath): Buffer {
  const bytes = Buffer.from(encoded.pathBytesBase64, 'base64');
  if (bytes.length === 0 || bytes.includes(0) || bytes.toString('base64') !== encoded.pathBytesBase64) {
    throw new Error('Git path bytes must be canonical base64, non-empty, and contain no NUL.');
  }
  return bytes;
}

/** One `git update-index --index-info -z` record: `<mode> <oid>\t<pathbytes>\0`.
 *  The path is transported as RAW bytes (like every other pathspec seam here) so a
 *  spaced / leading-dash / non-UTF-8 name is never re-split into an argv token. */
function indexInfoRecord(mode: string, oid: string, encoded: EncodedGitPath): Buffer {
  return Buffer.concat([Buffer.from(`${mode} ${oid}\t`, 'ascii'), pathBytes(encoded), Buffer.from([0])]);
}

function effectPath(effect: NormalizedCommitEffect): EncodedGitPath {
  return encodeGitPath(Buffer.from(effect.pathBytesBase64, 'base64'));
}

function zeroOidFor(snapshot: CandidateTokenSnapshot): string {
  return '0'.repeat(snapshot.candidate.repository.gitObjectFormat === 'sha256' ? 64 : 40);
}

/** Raw index-info records built only from reviewed object IDs. No worktree read is
 * permitted here: deletes use Git's all-zero removal record; writes and retains use
 * the reviewed clean-filtered blob and mode carried by the minted token. */
function effectIndexRecords(
  effects: readonly NormalizedCommitEffect[],
  zeroOid: string,
): Buffer {
  const records: Buffer[] = [];
  for (const effect of effects) {
    const encoded = effectPath(effect);
    if (effect.operation === 'delete') {
      if (effect.expectedState !== 'absent' || effect.commitBlobOid !== null || effect.commitMode !== null) {
        throw new Error(`invalid reviewed delete effect for ${encoded.displayPath}`);
      }
      records.push(indexInfoRecord('0', zeroOid, encoded));
      continue;
    }
    if (effect.expectedState !== 'present'
      || !effect.commitBlobOid
      || !OID_RE.test(effect.commitBlobOid)
      || !effect.commitMode) {
      throw new Error(`invalid reviewed ${effect.operation} effect for ${encoded.displayPath}`);
    }
    records.push(indexInfoRecord(effect.commitMode, effect.commitBlobOid, encoded));
  }
  return Buffer.concat(records);
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
      activityExecutionRunId: string | null;
    };

// ── Coordinator ───────────────────────────────────────────────────────────────

export class CommitCoordinator {
  private readonly d: CommitCoordinatorDeps;
  private readonly now: () => number;
  private readonly newAttemptId: () => string;
  private readonly validateMessage: (raw: string) => string;
  private readonly deriveTrailers: (
    snapshot: CandidateTokenSnapshot,
  ) => string[] | Promise<string[]>;
  private readonly contractVersion: number;

  constructor(deps: CommitCoordinatorDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.newAttemptId = deps.newAttemptId ?? (() => randomUUID());
    this.validateMessage = deps.validateMessage ?? defaultValidateMessage;
    this.deriveTrailers = deps.deriveTrailers ?? defaultDeriveTrailers;
    this.contractVersion = deps.contractVersion
      ?? (process.env.LARES_INTENT_PACKAGING === '1' ? 2 : BUNDLE_CONTRACT_VERSION);
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
          // Post-construction evidence found selected-tree divergence: the commit
          // exists; classify it as an integrity mismatch, never auto-rollback (D-6).
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
        if (snapshot.token.contractVersion === 2) {
          try {
            const createdAt = this.now();
            const resolutions = snapshot.candidate.attributionResolutions ?? [];
            const resolutionForIntent = (intentId: string) => resolutions.find((resolution) =>
              resolution.intentIds.includes(intentId));
            (this.d.writeIntentLedger ?? writeIntentCommitLedger)({
              record: {
                repositoryKey: snapshot.repositoryKey, commitOid: locked.commitOid,
                parentOid: pinnedHeadOid, observedAt: createdAt, source: 'lares',
                pushedRemoteCount: 0, lastReconciledAt: createdAt,
              },
              turnLinks: [...new Map(snapshot.associations.flatMap((association) =>
                association.contributingTurnIds.map((turnId) => [turnId, {
                  repositoryKey: snapshot.repositoryKey, commitOid: locked.commitOid,
                  turnId, planId: association.planId, planItemId: association.planItemId,
                  relation: 'candidate_member' as const, captureQuality: null,
                }] as const))).values()],
              pathLinks: snapshot.candidate.members.map((member) => ({
                repositoryKey: snapshot.repositoryKey, commitOid: locked.commitOid,
                pathBytesBase64: member.path.pathBytesBase64,
                expectedState: member.expectedWorktreeState,
                rawBlobOidAtCommit: member.rawWorktreeBlobOid,
                commitBlobOid: member.expectedCommitBlobOid, commitMode: member.expectedCommitMode,
                contributingTurnIds: snapshot.associations
                  .filter((association) => association.memberEntryIds.includes(member.entryId))
                  .flatMap((association) => association.contributingTurnIds),
                overlapCount: snapshot.associations.filter((association) =>
                  association.memberEntryIds.includes(member.entryId)).length,
              })),
              intentLinks: (snapshot.candidate.saveIntentIds ?? []).map((intentId) => {
                const resolution = resolutionForIntent(intentId);
                const superseded = resolution?.resolution === 'superseded-intentionally'
                  && resolution.intentIds[0] === intentId;
                return {
                  repositoryKey: snapshot.repositoryKey, commitOid: locked.commitOid, intentId,
                  disposition: superseded ? 'superseded' as const : 'committed' as const,
                  resolutionId: resolution?.resolutionId ?? null, createdAt,
                };
              }),
              consumedResolutions: resolutions.map((resolution) => ({
                id: resolution.resolutionId, evidenceDigest: resolution.evidenceDigest,
                candidateId: snapshot.candidate.candidateId,
              })),
              finalizationIds: snapshot.candidate.finalizations.map((row) => row.finalizationId),
            });
          } catch {
            resolveAttempt(locked.resolvedHeadOid, locked.commitOid, 'repository-state-uncertain');
            return {
              status: 'repository-state-uncertain', pinnedHeadOid: pinnedHeadOid ?? '',
              resolvedHeadOid: locked.resolvedHeadOid, attemptId,
            };
          }
        }
        if (locked.activityExecutionRunId && this.d.promotePlanningActivity) {
          // Promotion is eager but non-transactional with the already-durable Save.
          // Any refusal/throw leaves the activity commit safe and projected as
          // "Saved in plan; promotion pending" for retry/conflict resolution.
          await this.d.promotePlanningActivity(locked.activityExecutionRunId).catch(() => undefined);
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

  /** Everything inside the object-db lock: final byte revalidation → reviewed
   *  object tree construction → ref CAS → selected-path index reconciliation. */
  private async runLockedCommit(
    snapshot: CandidateTokenSnapshot,
    live: LiveReassembly,
    message: string,
    repoRoot: string,
    gitExe: string | undefined,
    reflogAction: string,
    pinnedHeadOid: string | null,
  ): Promise<LockedResult> {
    const effects = snapshot.commitEffects;
    if (!effects) {
      return { kind: 'stale', reason: 'minted token has no reviewed commit-effect set', resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
    }
    if (effects.length === 0) {
      return { kind: 'aborted-error', reason: 'reviewed commit-effect set is empty', resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
    }
    const pathspecs = commitPathspecUnion(live.members);
    const effectPathBytes = new Set(effects.map((effect) => effect.pathBytesBase64));
    const livePathBytes = new Set(pathspecs.map((spec) => spec.pathBytesBase64));
    if (effectPathBytes.size !== effects.length
      || effectPathBytes.size !== livePathBytes.size
      || [...effectPathBytes].some((value) => !livePathBytes.has(value))) {
      return { kind: 'stale', reason: 'live pathspec closure diverged from reviewed commit effects', resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
    }
    const expectedByEntryId = new Map(snapshot.candidate.members.map((m) => [m.entryId, m]));

    // A readable pre-operation index snapshot is mandatory: after the ref CAS we
    // reconcile selected effects only, then prove every unrelated stage entry is
    // byte-identical to this snapshot.
    let beforeIndex: Buffer;
    try {
      beforeIndex = await this.readIndex(repoRoot, gitExe);
    } catch (error) {
      return { kind: 'aborted-error', reason: `cannot snapshot the real index: ${error instanceof Error ? error.message : String(error)}`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
    }

    // FINAL raw + clean-filtered byte-match revalidation, immediately before commit
    // (guards the gap between reassembly and this lock). Any drift ⇒ safe abort.
    const revalidated = await mapBounded(live.members, REVALIDATION_CONCURRENCY, async (member) => {
      const expected = expectedByEntryId.get(member.entryId);
      if (!expected) return { member, kind: 'missing' as const };
      try {
        const rep = await this.d.readMemberRepresentation({ repoRoot, gitExe, pinnedHeadOid, member });
        return representationMatches(rep, expected)
          ? { member, kind: 'matching' as const }
          : { member, kind: 'moved' as const };
      } catch (error) {
        return { member, kind: 'failed' as const, error };
      }
    });
    for (const result of revalidated) {
      if (result.kind === 'missing') {
        return { kind: 'stale', reason: `member ${result.member.entryId} vanished from the frozen manifest`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
      }
      if (result.kind === 'failed') {
        return { kind: 'stale', reason: `revalidation read failed for ${result.member.entryId}: ${result.error instanceof Error ? result.error.message : String(result.error)}`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
      }
      if (result.kind === 'moved') {
        return { kind: 'stale', reason: `selected bytes moved for ${result.member.path.displayPath}`, resolvedHeadOid: await this.readHead(repoRoot, gitExe) };
      }
    }

    // The temp index is isolated from the real index. It is seeded from the pinned
    // HEAD tree and receives only raw reviewed effects, so a worktree write after
    // the final read above cannot influence the tree or commit.
    const tempDir = await fs.promises.mkdtemp(path.join(this.d.tmpDir ?? os.tmpdir(), 'lares-commit-'));
    const nonce = randomUUID();
    const tempIndexFile = path.join(tempDir, `${nonce}.index`);
    const messageFile = path.join(tempDir, `${nonce}.msg`);
    const baseEnv = { ...(this.d.env ?? process.env) };

    try {
      const trailers = await this.deriveTrailers(snapshot);
      const body = `${message}\n\n${trailers.join('\n')}\n`;
      await fs.promises.writeFile(messageFile, body, 'utf8');

      await this.d.runGit(repoRoot, pinnedHeadOid ? ['read-tree', pinnedHeadOid] : ['read-tree', '--empty'], {
        gitExe, env: baseEnv, indexFile: tempIndexFile, timeoutMs: COMMIT_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES,
      });
      await this.d.runGit(repoRoot, ['update-index', '--add', '--remove', '-z', '--index-info'], {
        gitExe,
        env: baseEnv,
        indexFile: tempIndexFile,
        stdin: effectIndexRecords(effects, zeroOidFor(snapshot)),
        timeoutMs: COMMIT_TIMEOUT_MS,
        maxBytes: SMALL_MAX_BYTES,
      });
      const treeResult = await this.d.runGit(repoRoot, ['write-tree'], {
        gitExe, env: baseEnv, indexFile: tempIndexFile, timeoutMs: COMMIT_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES,
      });
      const treeOid = treeResult.stdout.trim();
      if (!OID_RE.test(treeOid)) throw new Error('write-tree returned an invalid object ID');
      const constructedTree = await this.readTree(repoRoot, gitExe, treeOid);
      if (!constructedTree) throw new Error('cannot read the constructed reviewed tree');
      const constructionMismatches = this.compareEffects(effects, constructedTree);
      if (constructionMismatches.length > 0) {
        throw new Error(`constructed tree diverged at ${constructionMismatches.map((entry) => entry.displayPath).join(', ')}`);
      }

      // WP-D6 is architecture-flagged and independently OFF by default per repo.
      // Validation sees a materialized copy of this exact tree OID, after construction
      // proof and before commit-object creation / ref CAS. It may only accept or refuse.
      const policy = process.env.LARES_INTENT_PACKAGING === '1'
        ? await (this.d.resolveCandidateCommitPolicy ?? readCandidateCommitPolicy)({
          repoRoot, gitExe, runGit: this.d.runGit,
        })
        : {
          validation: { enabled: false, commands: [], timeoutMs: 0 },
          signing: { enabled: false, signingKey: null },
        };
      const validation = await (this.d.validateCandidateTree ?? validateCandidateTree)({
        repoRoot,
        gitExe,
        runGit: this.d.runGit,
        treeOid,
        policy: policy.validation,
        env: baseEnv,
        tmpDir: this.d.tmpDir,
      });
      if (!validation.ok) {
        const command = validation.command ? ` (${validation.command})` : '';
        return {
          kind: 'aborted-error',
          reason: `candidate-tree validation refused${command}: ${validation.diagnostic}`,
          resolvedHeadOid: await this.readHead(repoRoot, gitExe),
        };
      }

      // Hooks remain bypassed. Explicit Lares repo policy may ask commit-tree to sign
      // the commit object; -S never changes the already-verified tree OID.
      const signingArgs = candidateCommitSigningArgs(policy.signing);
      const commitArgs = ['commit-tree', treeOid, ...(pinnedHeadOid ? ['-p', pinnedHeadOid] : []), ...signingArgs, '-F', messageFile];
      const commitResult = await this.d.runGit(repoRoot, commitArgs, {
        gitExe,
        mode: 'user-commit',
        env: baseEnv,
        timeoutMs: COMMIT_TIMEOUT_MS,
        maxBytes: SMALL_MAX_BYTES,
      });
      const commitOid = commitResult.stdout.trim();
      if (!OID_RE.test(commitOid)) throw new Error('commit-tree returned an invalid object ID');

      // Atomic old-OID compare-and-swap. A foreign HEAD move is a clean stale
      // refusal: our commit object may be dangling, but no Lares ref advanced.
      const expectedOldOid = pinnedHeadOid ?? zeroOidFor(snapshot);
      const activity = this.d.resolvePlanningActivity?.(snapshot.repositoryKey) ?? null;
      const activityAdvance = activity
        ? await (this.d.advancePlanningActivityHead ?? advanceActivityHead)({
          activityPath: repoRoot, activityHeadRef: activity.activityHeadRef,
          expectedOldOid, newOid: commitOid, gitExe, runGit: this.d.runGit,
        }).catch((error) => ({ ok: false, diagnostic: error instanceof Error ? error.message : String(error) }))
        : null;
      const updateResult = activityAdvance
        ? { code: activityAdvance.ok ? 0 : 1, stdout: '', stderr: activityAdvance.diagnostic ?? '' }
        : await this.d.runGit(repoRoot, ['update-ref', '-m', reflogAction, 'HEAD', commitOid, expectedOldOid], {
          gitExe, env: baseEnv, allowNonzero: true, timeoutMs: COMMIT_TIMEOUT_MS, maxBytes: SMALL_MAX_BYTES,
        }).catch((error) => ({
          code: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }));
      if (updateResult.code !== 0) {
        const resolvedHeadOid = (await this.readHead(repoRoot, gitExe)) ?? '';
        const reason = (updateResult.stderr.trim() || 'HEAD compare-and-swap failed').slice(0, 500);
        if (resolvedHeadOid === (pinnedHeadOid ?? '')) {
          return { kind: 'aborted-error', reason, resolvedHeadOid };
        }
        return {
          kind: 'stale',
          reason,
          resolvedHeadOid,
        };
      }

      // Reconcile only selected effect paths in the real index from the same reviewed
      // object IDs. Concurrent worktree bytes are deliberately left alone and remain
      // visibly dirty against these index entries.
      let reconciliationAvailable = true;
      try {
        await this.d.runGit(repoRoot, ['update-index', '--add', '--remove', '-z', '--index-info'], {
          gitExe,
          env: baseEnv,
          stdin: effectIndexRecords(effects, zeroOidFor(snapshot)),
          timeoutMs: COMMIT_TIMEOUT_MS,
          maxBytes: SMALL_MAX_BYTES,
        });
      } catch {
        reconciliationAvailable = false;
      }

      const resolvedHeadOid = (await this.readHead(repoRoot, gitExe)) ?? '';
      const marked = await this.findMarkedCommit(repoRoot, gitExe, reflogAction);
      if (marked !== commitOid || resolvedHeadOid !== commitOid) {
        return { kind: 'uncertain', identifiedCommitOid: commitOid, resolvedHeadOid };
      }

      // Post-commit parent/tree verification remains evidence in addition to the
      // pre-commit constructed-tree proof.
      const parent = await this.readParent(repoRoot, gitExe, commitOid);
      const parentOk = pinnedHeadOid ? parent === pinnedHeadOid : parent === null;
      const tree = await this.readTree(repoRoot, gitExe, commitOid);
      if (!parentOk || tree === null) {
        return { kind: 'uncertain', identifiedCommitOid: commitOid, resolvedHeadOid };
      }

      const mismatchedTreePaths = this.compareEffects(effects, tree);

      let integrity: IndexIntegrityResult;
      if (!reconciliationAvailable) {
        integrity = { status: 'unavailable', mismatchedPaths: [] };
      } else {
        try {
          const afterIndex = await this.readIndex(repoRoot, gitExe);
          integrity = compareIndexIntegrity(beforeIndex, afterIndex, effectPathBytes);
        } catch {
          integrity = { status: 'unavailable', mismatchedPaths: [] };
        }
      }

      return { kind: 'committed', commitOid, integrity, resolvedHeadOid, mismatchedTreePaths,
        activityExecutionRunId: activity?.executionRunId ?? null };
    } catch (error) {
      return {
        kind: 'aborted-error',
        reason: error instanceof Error ? error.message : String(error),
        resolvedHeadOid: await this.readHead(repoRoot, gitExe),
      };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
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

  /** Which reviewed effect entries diverge from the constructed/committed tree. */
  private compareEffects(effects: readonly NormalizedCommitEffect[], tree: Map<string, TreeEntry>): EncodedGitPath[] {
    const mismatched: EncodedGitPath[] = [];
    for (const effect of effects) {
      const encoded = effectPath(effect);
      const entry = tree.get(effect.pathBytesBase64);
      if (effect.expectedState === 'absent') {
        if (entry) mismatched.push(encoded);
        continue;
      }
      if (!entry || entry.oid !== effect.commitBlobOid || entry.mode !== effect.commitMode) {
        mismatched.push(encoded);
      }
    }
    return mismatched;
  }
}

function isSkipped(value: unknown): value is SkippedDeadline {
  return typeof value === 'object' && value !== null && (value as SkippedDeadline).skipped === 'deadline';
}
