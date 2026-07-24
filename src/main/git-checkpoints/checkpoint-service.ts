// checkpoint-service.ts — snapshot core: full raw capture + durable finalize
// (Git-Native WP-G1.3b). MAIN-PROCESS ONLY. **`cwd = repoRoot` always.**
//
// This is the most safety-critical package in the checkpoint engine: it turns a
// dirty (or clean) workspace into a byte-exact, recoverable git tree without ever
// touching HEAD, the real index, branch refs, or user config (invariant #1). It
// builds on the landed layers and REDEFINES none of them:
//   • git-command.runGit / runGitBlobToFile  — bounded exec + binary stream (G1.1)
//   • CheckpointQueue                          — per-object-db priority serialization
//                                                with eager deadline expiry (G1.2)
//   • ref-encoding.checkpointRef               — deterministic per-turn ref names (G1.3a)
//   • checkpoint-gating.gateCheckpoint /
//     enumerateScope                           — capability gate + full-scope
//                                                enumeration (gitlinks/unsupported/
//                                                filtered returned as DATA) (G1.3a)
//   • database turn_records accessors          — the durable finalize write target (A0)
//
// THE CAPTURE ALGORITHM (spec "Full raw snapshot sequence"):
//   1. temp GIT_INDEX_FILE `lares-idx-<uuid>` in OS temp, NEVER inside `.git/`.
//   2. seed: `read-tree HEAD` (repo) or `read-tree --empty` (unborn) — supplies the
//      out-of-scope entries so the tree is coherent; in-scope entries are overwritten.
//   3. modes: read seeded tracked-entry modes from `ls-files --stage` against the
//      temp index. Existing tracked path → PRESERVE its seeded mode (no filemode=false
//      downgrade of 100755); new untracked → derive from lstat (symlink 120000 /
//      exec 100755 / else 100644); gitlink 160000 → visible reject, never captured.
//   4. raw-hash every present in-scope regular/symlink path with
//      `hash-object --no-filters -w` in argv chunks bounded to a safe Windows
//      command-line length; a newline-containing path is hashed in its OWN invocation.
//   5. one NUL-safe `update-index -z --index-info` batch: `<mode> <oid>\t<path>` for
//      additions and the `0 <zero-oid>\t<path>` delete form for tracked-absent paths.
//   6. `write-tree` → `commit-tree` (buildGitEnv commit mode + `-c commit.gpgsign=false`).
//   7. `finally`: delete the temp index + any `<idx>.lock`, async + off the delivery path.
//
// Why byte-exact: `hash-object --no-filters` stores worktree bytes verbatim for EVERY
// in-scope path (clean or dirty), so a clean tracked file under autocrlf/LFS/git-crypt
// is captured as its on-disk bytes, never silently reverted to the canonical HEAD blob.
//
// THE WALL-CLOCK CONTRACT (spec "authoritative"): deadlineAt = enqueueTime + budget.
//   • Cancellable capture runs only while now ≤ deadlineAt − FINALIZE_ALLOWANCE_MS
//     (the allowance is carved OUT of the budget). Past that with no candidate →
//     abandon: nothing persisted, quality 'degraded', failure_reason 'budget-exceeded'.
//   • Finalize is durable-not-unbounded: once the candidate OID is persisted (ready=0)
//     the edge is never abandoned; if update-ref/verify/mark overrun the absolute
//     deadline, delivery is released anyway and the edge is left persisted-but-non-ready
//     for startup reconciliation (WP-G1.8) to finish. An edge is NEVER exposed as usable
//     before a live `rev-parse --verify` confirms the ref == the persisted candidate.
//
// Every git touch and the persistence layer are injectable seams so the whole thing
// is testable with real git in temp repos plus deterministic fakes.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import {
  BEFORE_CHECKPOINT_BUDGET_MS,
  AFTER_CHECKPOINT_BUDGET_MS,
  FINALIZE_ALLOWANCE_MS,
  CLEANUP_ALLOWANCE_MS,
} from '../../shared/constants';
import type { GitCapability } from '../../shared/types';
import type { TurnRecord } from '../database';
import {
  getTurnRecord as dbGetTurnRecord,
  updateTurnRecord as dbUpdateTurnRecord,
  listTurnRecords as dbListTurnRecords,
} from '../database';
import { buildGitEnv } from '../git/git-runtime';
import {
  gateCheckpoint,
  enumerateScope,
  type CapturableEntry,
  type EnumerationOutcome,
  type EnumerationResult,
  type LstatFn,
} from './checkpoint-gating';
import { runGit as realRunGit, type GitRunResult, type RunGitOptions, GitCommandError } from './git-command';
import { CheckpointQueue, type CheckpointPriority, type SkippedDeadline } from './checkpoint-queue';
import { checkpointRef, type CheckpointEdge } from './ref-encoding';

// ── injectable seams ──────────────────────────────────────────────────────────

/** The git-command.runGit shape (cwd, args, opts). */
export type RunGitLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;

/** The subset of the WP-A0 turn_records accessors the finalize write order needs.
 *  Defaults bind to the real database.ts exports; tests inject an in-memory fake so
 *  the ready=0 → ref → verify → ready=1 ordering is observable. */
export interface CheckpointTurnStore {
  getTurnRecord(id: string): TurnRecord | null;
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null;
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[];
}

const DEFAULT_TURN_STORE: CheckpointTurnStore = {
  getTurnRecord: dbGetTurnRecord,
  updateTurnRecord: (id, updates) => dbUpdateTurnRecord(id, updates as never),
  listTurnRecords: dbListTurnRecords,
};

/** Timing constants — injectable so the timing tests use scaled-down REAL budgets
 *  (the queue and this service both key off the real wall clock). */
export interface CheckpointTiming {
  beforeBudgetMs: number;
  afterBudgetMs: number;
  finalizeAllowanceMs: number;
  cleanupAllowanceMs: number;
}

const DEFAULT_TIMING: CheckpointTiming = {
  beforeBudgetMs: BEFORE_CHECKPOINT_BUDGET_MS,
  afterBudgetMs: AFTER_CHECKPOINT_BUDGET_MS,
  finalizeAllowanceMs: FINALIZE_ALLOWANCE_MS,
  cleanupAllowanceMs: CLEANUP_ALLOWANCE_MS,
};

export interface CheckpointServiceOptions {
  queue: CheckpointQueue;
  /** Resolved absolute git exe (cached `resolveInternalGit()` in production). */
  gitExe: string;
  runGit?: RunGitLike;
  store?: CheckpointTurnStore;
  timing?: Partial<CheckpointTiming>;
  /** OS temp dir for the per-op index (defaults to os.tmpdir()). NEVER `.git/`. */
  tmpDir?: string;
  /** now() seam — defaults to Date.now. Kept in lockstep with the queue's clock. */
  now?: () => number;
  /** Enumeration seam — defaults to G1.3a enumerateScope. Injected in tests that
   *  need a synthetic gitlink/unsupported scope without creating one on disk. */
  enumerate?: (opts: {
    repoRoot: string;
    workspacePrefix: string;
    runGit: RunGitLike;
    gitExe?: string;
    lstat?: LstatFn;
  }) => Promise<EnumerationOutcome>;
  platform?: NodeJS.Platform;
}

// ── result / outcome types ──────────────────────────────────────────────────────

export type EdgeCaptureStatus =
  | 'ready' // fully finalized: ref created + verified == candidate, ready=1
  | 'persisted-non-ready' // candidate persisted (ready=0); finalize overran/failed → reconciliation finishes it
  | 'abandoned' // no candidate persisted (deadline before candidate, or capture error) → degraded
  | 'skipped'; // capability gate or enumeration skip (non-repo/oversized/protected/…)

export interface EdgeCaptureResult {
  status: EdgeCaptureStatus;
  edge: CheckpointEdge;
  turnId: string;
  oid: string | null;
  ref: string | null;
  ready: boolean;
  quality: string | null;
  failureReason: string | null;
  /** BEFORE edge only — content-semantics diagnostics (invariant #15). */
  rawFilterBypassed?: boolean;
  filteredPaths?: string[];
  /** Diagnostics — gitlinks (visible reject) + unsupported entry types excluded. */
  rejectedGitlinks?: string[];
  unsupportedPaths?: string[];
  /** Skip diagnostics. */
  skipReason?: string;
  detail?: string | null;
}

export interface CaptureEdgeParams {
  edge: CheckpointEdge;
  turnId: string;
  workspaceId: string;
  /** Launch identity — NEVER a cwd/slug (invariant #4). */
  agentId: string;
  capability: GitCapability;
  /** Success-case quality: before = guaranteed|late|degraded; after = hook|
   *  session-log|terminal|idle-fallback|none. The coordinator (G1.5) decides it;
   *  the service records it verbatim on the ready edge. */
  quality: string;
  /** commit-tree label. */
  label?: string;
  /** Absolute enqueue time (defaults now()). deadlineAt = enqueueTime + budget. */
  enqueueTime?: number;
  /** lstat seam for enumeration (tests). */
  lstat?: LstatFn;
}

// ── the zero OID (delete form) ──────────────────────────────────────────────────

const SHA1_ZERO = '0'.repeat(40);

/** ~30 000 chars — a conservative bound well under the Windows CreateProcess
 *  command-line limit (32 767 UTF-16 units) once the exe + fixed flags are counted. */
const MAX_ARG_CHARS = 30_000;

/** Result of the raw-capture phase — the still-cancellable half. */
interface SnapshotOutcome {
  candidateOid: string;
  treeOid: string;
  rawFilterBypassed: boolean;
  filteredPaths: string[];
  rejectedGitlinks: string[];
  unsupportedPaths: string[];
}

export class CheckpointService {
  private readonly queue: CheckpointQueue;
  private readonly gitExe: string;
  private readonly runGit: RunGitLike;
  private readonly store: CheckpointTurnStore;
  private readonly timing: CheckpointTiming;
  private readonly tmpDir: string;
  private readonly now: () => number;
  private readonly enumerate: NonNullable<CheckpointServiceOptions['enumerate']>;
  private readonly platform: NodeJS.Platform;
  /** Fire-and-forget cleanup promises — awaitable by tests via settleCleanups(). */
  private readonly cleanups: Promise<void>[] = [];

  constructor(opts: CheckpointServiceOptions) {
    this.queue = opts.queue;
    this.gitExe = opts.gitExe;
    this.runGit = opts.runGit ?? realRunGit;
    this.store = opts.store ?? DEFAULT_TURN_STORE;
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
    this.tmpDir = opts.tmpDir ?? os.tmpdir();
    this.now = opts.now ?? Date.now;
    this.enumerate = opts.enumerate ?? ((o) => enumerateScope(o));
    this.platform = opts.platform ?? process.platform;
  }

  // ── public: capture one edge ──────────────────────────────────────────────────

  /**
   * Capture the before/after edge for a turn: gate → enumerate → full raw snapshot
   * → durable finalize, all serialized on the repo's object database at the edge's
   * priority under the wall-clock contract. The turn row (already allocated + open
   * by the coordinator) is filled via the WP-A0 accessors.
   */
  async captureEdge(params: CaptureEdgeParams): Promise<EdgeCaptureResult> {
    const { edge, turnId } = params;
    const enqueueTime = params.enqueueTime ?? this.now();
    const budget = edge === 'before' ? this.timing.beforeBudgetMs : this.timing.afterBudgetMs;
    const deadlineAt = enqueueTime + budget;
    const priority: CheckpointPriority = edge === 'before' ? 'BEFORE' : 'AFTER';

    // Gate is pure + instantaneous — decide before spending a queue slot.
    const gate = gateCheckpoint(params.capability);
    if (!gate.ok) {
      // The before edge fails OPEN at the coordinator; the after edge simply has no
      // recoverable state. Either way we persist no candidate and no ref.
      return {
        status: 'skipped',
        edge,
        turnId,
        oid: null,
        ref: null,
        ready: false,
        quality: null,
        failureReason: null,
        skipReason: gate.skipped,
        detail: gate.detail,
      };
    }

    const key = params.capability.commonDirQueueKey;
    if (!key) {
      // gate.ok guarantees a repoRoot; a null queue key is an internal inconsistency.
      return this.abandon(edge, turnId, 'missing-queue-key', deadlineAt);
    }

    const settled = await this.queue.withPriority(
      key,
      { priority, deadlineAt },
      () => this.runCapture({ ...params, enqueueTime, deadlineAt, gate }),
    );

    if (isSkippedDeadline(settled)) {
      // The queue expired the item before it ever started — a long AFTER holding the
      // key must never delay a BEFORE past its deadline. No candidate exists.
      return this.abandon(edge, turnId, 'budget-exceeded', deadlineAt);
    }
    return settled;
  }

  // ── the cancellable capture + durable finalize (runs while holding the key) ─────

  private async runCapture(
    params: CaptureEdgeParams & {
      enqueueTime: number;
      deadlineAt: number;
      gate: { repoState: 'repo' | 'unborn'; repoRoot: string; workspacePrefix: string };
    },
  ): Promise<EdgeCaptureResult> {
    const { edge, turnId, gate, deadlineAt } = params;
    const captureDeadline = deadlineAt - this.timing.finalizeAllowanceMs;

    // Cancellable capture may start only while now ≤ deadlineAt − FINALIZE_ALLOWANCE_MS.
    if (this.now() > captureDeadline) {
      return this.abandon(edge, turnId, 'budget-exceeded', deadlineAt);
    }

    let snap: SnapshotOutcome;
    try {
      snap = await this.rawSnapshot({
        repoRoot: gate.repoRoot,
        repoState: gate.repoState,
        workspacePrefix: gate.workspacePrefix,
        captureDeadline,
        label: params.label ?? `lares:${edge}:${turnId}`,
        lstat: params.lstat,
      });
    } catch (err) {
      // A deadline/timeout kill during capture, an oversized skip, or any capture
      // failure lands here BEFORE a candidate is persisted → abandon (degraded).
      if (err instanceof EnumerationSkipError) {
        return {
          status: 'skipped',
          edge,
          turnId,
          oid: null,
          ref: null,
          ready: false,
          quality: null,
          failureReason: null,
          skipReason: err.reason,
          detail: err.detail,
        };
      }
      const reason =
        err instanceof GitCommandError && (err.kind === 'deadline' || err.kind === 'timeout')
          ? 'budget-exceeded'
          : 'snapshot-failed';
      return this.abandon(edge, turnId, reason, deadlineAt, describeError(err));
    }

    // We have a candidate. From here the edge is durable-not-unbounded: it is never
    // abandoned, only left persisted-non-ready if finalize overruns the deadline.
    return this.finalize({ edge, turnId, params, snap, deadlineAt });
  }

  // ── steps 1–6: full raw snapshot (still cancellable) ───────────────────────────

  private async rawSnapshot(args: {
    repoRoot: string;
    repoState: 'repo' | 'unborn';
    workspacePrefix: string;
    captureDeadline: number;
    label: string;
    lstat?: LstatFn;
  }): Promise<SnapshotOutcome> {
    const { repoRoot, repoState, workspacePrefix, captureDeadline, label } = args;

    // Enumerate the full scope (G1.3a) — gitlinks/unsupported/filtered come back as data.
    const enumeration = await this.enumerate({
      repoRoot,
      workspacePrefix,
      runGit: this.runGit,
      gitExe: this.gitExe,
      lstat: args.lstat,
    });
    if (enumeration.kind === 'skipped') {
      throw new EnumerationSkipError(enumeration.reason, JSON.stringify(enumeration.observed));
    }
    const scope: EnumerationResult = enumeration;

    // 1. Unique temp GIT_INDEX_FILE outside `.git/`.
    const indexFile = path.join(this.tmpDir, `lares-idx-${randomUUID()}`);
    try {
      // 2. Seed the temp index: HEAD tree (repo) or empty (unborn).
      const seedArgs = repoState === 'unborn' ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'];
      await this.git(repoRoot, seedArgs, { indexFile, deadlineAt: captureDeadline });

      // 3. Seeded tracked-entry modes (against the temp index), NUL-safe.
      const seededModes = await this.readSeededModes(repoRoot, indexFile, captureDeadline);

      // 3+4. Derive filemode per path + raw-hash worktree bytes. Gitlinks rejected.
      const rejectedGitlinks: string[] = [...scope.gitlinks];
      const toHash: CapturableEntry[] = [];
      const modeByPath = new Map<string, string>();
      for (const entry of scope.capturable) {
        const seeded = seededModes.get(entry.path);
        if (seeded === '160000') {
          // A seeded gitlink surfacing as a capturable path — never hash a submodule.
          rejectedGitlinks.push(entry.path);
          continue;
        }
        const mode = seeded ?? this.deriveMode(entry);
        if (mode === '160000') {
          rejectedGitlinks.push(entry.path);
          continue;
        }
        modeByPath.set(entry.path, mode);
        toHash.push(entry);
      }

      const oidByPath = await this.hashPaths(repoRoot, toHash.map((e) => e.path), captureDeadline);

      // 5. One NUL-safe update-index --index-info batch: additions + deletions.
      const additions: string[] = [];
      let sampleOidLen = 0;
      for (const entry of toHash) {
        const oid = oidByPath.get(entry.path);
        const mode = modeByPath.get(entry.path);
        if (!oid || !mode) continue;
        if (sampleOidLen === 0) sampleOidLen = oid.length;
        additions.push(`${mode} ${oid}\t${entry.path}`);
      }
      const zeroOid = sampleOidLen > 0 ? '0'.repeat(sampleOidLen) : SHA1_ZERO;
      const deletions = scope.deletions.map((p) => `0 ${zeroOid}\t${p}`);
      const indexInfo = [...additions, ...deletions];
      if (indexInfo.length > 0) {
        const stdin = indexInfo.map((line) => `${line}\0`).join('');
        await this.git(repoRoot, ['update-index', '-z', '--index-info'], {
          indexFile,
          stdin,
          deadlineAt: captureDeadline,
        });
      }

      // 6. write-tree → commit-tree (identity from buildGitEnv commit; gpgsign off).
      const treeOid = (
        await this.git(repoRoot, ['write-tree'], { indexFile, deadlineAt: captureDeadline })
      ).stdout.trim();

      const commitTopLevel = this.longpaths().concat(['-c', 'commit.gpgsign=false']);
      const commitOid = (
        await this.git(repoRoot, [...commitTopLevel, 'commit-tree', treeOid, '-m', label], {
          mode: 'commit',
          deadlineAt: captureDeadline,
        })
      ).stdout.trim();

      return {
        candidateOid: commitOid,
        treeOid,
        rawFilterBypassed: scope.beforeRawFilterBypassed,
        filteredPaths: scope.filteredPaths,
        rejectedGitlinks,
        unsupportedPaths: scope.unsupported,
      };
    } finally {
      // 7. Async, off the delivery path — never delays return / delivery.
      this.scheduleCleanup(indexFile);
    }
  }

  // ── the durable finalize write order (steps 2–5) ───────────────────────────────

  private async finalize(args: {
    edge: CheckpointEdge;
    turnId: string;
    params: CaptureEdgeParams;
    snap: SnapshotOutcome;
    deadlineAt: number;
  }): Promise<EdgeCaptureResult> {
    const { edge, turnId, params, snap, deadlineAt } = args;
    const repoRoot = params.capability.repoRoot as string;
    const ref = checkpointRef({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      turnId,
      edge,
    });

    // Step 2: persist candidate OID + deterministic ref name (ready=0). This STARTS
    // the durable finalize state — a persisted candidate is never abandoned.
    this.store.updateTurnRecord(turnId, this.persistCandidateFields(edge, snap.candidateOid, ref, snap));

    const nonReady = (failureReason: string | null): EdgeCaptureResult => ({
      status: 'persisted-non-ready',
      edge,
      turnId,
      oid: snap.candidateOid,
      ref,
      ready: false,
      quality: null,
      failureReason,
      rawFilterBypassed: edge === 'before' ? snap.rawFilterBypassed : undefined,
      filteredPaths: edge === 'before' ? snap.filteredPaths : undefined,
      rejectedGitlinks: snap.rejectedGitlinks,
      unsupportedPaths: snap.unsupportedPaths,
    });

    // Steps 3–4 carry the ABSOLUTE deadline: an overrun releases delivery anyway and
    // leaves the edge persisted-non-ready for reconciliation (WP-G1.8).
    try {
      // Step 3: create-only atomic update-ref (expected-zero old OID).
      await this.git(repoRoot, ['update-ref', ref, snap.candidateOid, SHA1_ZERO], {
        deadlineAt,
        allowNonzero: true,
      });

      // Step 4: verify the ref resolves to exactly the persisted candidate. This is
      // the ONLY gate that lets an edge become usable — a create-only collision or a
      // killed update-ref yields a mismatch → non-ready, never a false guarantee.
      const verify = await this.git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
        deadlineAt,
        allowNonzero: true,
      });
      if (verify.code !== 0 || verify.stdout.trim() !== snap.candidateOid) {
        return nonReady('finalize-verify-mismatch');
      }
    } catch (err) {
      return nonReady(describeError(err));
    }

    // Step 5: mark ready + assign quality. Only now is the edge a real guarantee.
    this.store.updateTurnRecord(turnId, this.readyFields(edge, params.quality));

    return {
      status: 'ready',
      edge,
      turnId,
      oid: snap.candidateOid,
      ref,
      ready: true,
      quality: params.quality,
      failureReason: null,
      rawFilterBypassed: edge === 'before' ? snap.rawFilterBypassed : undefined,
      filteredPaths: edge === 'before' ? snap.filteredPaths : undefined,
      rejectedGitlinks: snap.rejectedGitlinks,
      unsupportedPaths: snap.unsupportedPaths,
    };
  }

  private persistCandidateFields(
    edge: CheckpointEdge,
    oid: string,
    ref: string,
    snap: SnapshotOutcome,
  ): Record<string, unknown> {
    if (edge === 'before') {
      return {
        beforeOid: oid,
        beforeRef: ref,
        beforeReady: false,
        // Content-semantics fields are BEFORE-edge only (invariant #15).
        beforeRawFilterBypassed: snap.rawFilterBypassed,
        beforeFilteredPaths: snap.filteredPaths.length > 0 ? snap.filteredPaths : null,
      };
    }
    return { afterOid: oid, afterRef: ref, afterReady: false };
  }

  private readyFields(edge: CheckpointEdge, quality: string): Record<string, unknown> {
    return edge === 'before'
      ? { beforeReady: true, beforeQuality: quality }
      : { afterReady: true, afterQuality: quality };
  }

  // ── abandon: no candidate persisted → degraded ─────────────────────────────────

  private abandon(
    edge: CheckpointEdge,
    turnId: string,
    failureReason: string,
    deadlineAt: number,
    detail?: string,
  ): EdgeCaptureResult {
    // Record the degraded quality + exact reason WITHOUT a candidate/ref: the edge
    // claims no recovery guarantee and there is nothing for reconciliation to adopt.
    const fields =
      edge === 'before'
        ? { beforeQuality: 'degraded', failureReason }
        : { afterQuality: 'none', failureReason };
    try {
      this.store.updateTurnRecord(turnId, fields);
    } catch {
      /* the row may already be terminal (raced close) — abandon is best-effort here */
    }
    return {
      status: 'abandoned',
      edge,
      turnId,
      oid: null,
      ref: null,
      ready: false,
      quality: edge === 'before' ? 'degraded' : 'none',
      failureReason,
      detail: detail ?? null,
    };
  }

  // ── mode derivation ────────────────────────────────────────────────────────────

  /** Git filemode for a NEW untracked path from its lstat facts (invariant: only
   *  new paths derive; tracked paths preserve their seeded mode). */
  private deriveMode(entry: CapturableEntry): string {
    if (entry.type === 'symlink') return '120000';
    // POSIX owner-execute bit. On Windows lstat never reports it, so new files are
    // 100644 there — which is correct (a tracked 100755 is preserved via the seed).
    const executable = (entry.mode & 0o100) !== 0;
    return executable ? '100755' : '100644';
  }

  /** Parse `ls-files --stage -z` (against the temp index) → path → mode string. */
  private async readSeededModes(
    repoRoot: string,
    indexFile: string,
    deadlineAt: number,
  ): Promise<Map<string, string>> {
    const res = await this.git(repoRoot, ['ls-files', '--stage', '-z'], { indexFile, deadlineAt });
    const map = new Map<string, string>();
    for (const rec of res.stdout.split('\0')) {
      if (rec.length === 0) continue;
      // `<mode> SP <oid> SP <stage>\t<path>`
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const meta = rec.slice(0, tab);
      const p = rec.slice(tab + 1);
      const mode = meta.split(' ', 1)[0];
      if (mode) map.set(p, mode);
    }
    return map;
  }

  // ── step 4: chunked raw-hash ─────────────────────────────────────────────────────

  /** Raw-hash every path with `hash-object --no-filters -w`, byte-exact. Paths are
   *  chunked to a safe argv length; a newline-containing path is hashed alone (its
   *  own invocation) since --stdin-paths is newline-delimited and unsafe for it. */
  private async hashPaths(
    repoRoot: string,
    paths: string[],
    deadlineAt: number,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;

    const base = ['hash-object', '--no-filters', '-w', '--'];
    let chunk: string[] = [];
    let chunkLen = base.join(' ').length;

    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const res = await this.git(repoRoot, [...base, ...chunk], { deadlineAt });
      const oids = res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (oids.length !== chunk.length) {
        throw new Error(`hash-object returned ${oids.length} oids for ${chunk.length} paths`);
      }
      chunk.forEach((p, i) => out.set(p, oids[i]));
      chunk = [];
      chunkLen = base.join(' ').length;
    };

    for (const p of paths) {
      if (p.includes('\n')) {
        // Newline-in-name → its OWN invocation; flush any pending normal batch first.
        await flush();
        const res = await this.git(repoRoot, [...base, p], { deadlineAt });
        out.set(p, res.stdout.trim());
        continue;
      }
      const add = p.length + 1;
      if (chunk.length > 0 && chunkLen + add > MAX_ARG_CHARS) {
        await flush();
      }
      chunk.push(p);
      chunkLen += add;
    }
    await flush();
    return out;
  }

  // ── diff generation ──────────────────────────────────────────────────────────

  /**
   * The witnessed-path diff AND the raw-window diff, returned SEPARATELY and
   * labeled. Both require before_ready=1 AND after_ready=1 AND a live
   * `rev-parse --verify` that the stored refs still resolve to the stored OIDs — the
   * DB `*_pruned_at` timestamps are hints, never authority (users can delete/rewrite
   * `refs/lares/*`). If either edge is unusable both diffs come back unavailable.
   */
  async generateDiffs(
    turnId: string,
    repoRoot: string,
  ): Promise<{
    witnessed: DiffResult;
    window: DiffResult;
  }> {
    const row = this.store.getTurnRecord(turnId);
    if (!row) {
      const unavail: DiffResult = { available: false, reason: 'unknown-turn', label: '', text: null };
      return { witnessed: { ...unavail, label: 'witnessed changes' }, window: { ...unavail, label: 'unattributed changes in this window' } };
    }

    const beforeUsable = await this.isEdgeUsable(repoRoot, row.beforeReady, row.beforeRef, row.beforeOid);
    const afterUsable = await this.isEdgeUsable(repoRoot, row.afterReady, row.afterRef, row.afterOid);

    const witnessedLabel = 'witnessed changes';
    const windowLabel = 'unattributed changes in this window';
    if (!beforeUsable || !afterUsable) {
      const reason = !beforeUsable ? 'before-edge-unusable' : 'after-edge-unusable';
      return {
        witnessed: { available: false, reason, label: witnessedLabel, text: null },
        window: { available: false, reason, label: windowLabel, text: null },
      };
    }

    const beforeOid = row.beforeOid as string;
    const afterOid = row.afterOid as string;
    const witnessedPaths = (row.touched ?? [])
      .filter((e) => e.op === 'write' || e.op === 'create')
      .map((e) => e.path);

    // Witnessed-path diff — scoped to the canonical write/create set.
    const witnessedText =
      witnessedPaths.length > 0
        ? (await this.diff(repoRoot, beforeOid, afterOid, witnessedPaths)).stdout
        : '';

    // Raw-window diff — the WHOLE before→after delta, incl. unattributed changes.
    const windowText = (await this.diff(repoRoot, beforeOid, afterOid, null)).stdout;

    return {
      witnessed: { available: true, reason: null, label: witnessedLabel, text: witnessedText, provenance: 'witnessed' },
      window: { available: true, reason: null, label: windowLabel, text: windowText, provenance: 'raw-window' },
    };
  }

  /** `git --no-pager [--no-ext-diff --no-textconv] diff <before> <after> [-- paths]`. */
  private diff(
    repoRoot: string,
    beforeOid: string,
    afterOid: string,
    paths: string[] | null,
  ): Promise<GitRunResult> {
    const top = ['--no-pager', ...this.longpaths()];
    const args = [...top, 'diff', '--no-ext-diff', '--no-textconv', beforeOid, afterOid];
    if (paths && paths.length > 0) args.push('--', ...paths);
    return this.git(repoRoot, args, { mode: 'read', maxBytes: 32 << 20, timeoutMs: 30_000 });
  }

  /** An edge is usable ONLY when ready=1 AND the stored ref lives + resolves to the
   *  stored OID right now. Never trust ready=1 alone (refs are user-mutable). */
  private async isEdgeUsable(
    repoRoot: string,
    ready: boolean,
    ref: string | null,
    oid: string | null,
  ): Promise<boolean> {
    if (!ready || !ref || !oid) return false;
    try {
      const res = await this.git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`], {
        allowNonzero: true,
        timeoutMs: 10_000,
      });
      return res.code === 0 && res.stdout.trim() === oid;
    } catch {
      return false;
    }
  }

  // ── attribution enforcement (the validated path-set contract for restore) ──────

  /**
   * The canonical witnessed write/create set for a turn — the EXACT path set a
   * `revertTurn` may restore. Nothing outside a turn's witnessed writes is ever
   * revertable through this surface (whole-tree recovery is a separate human-only
   * surface, never here).
   */
  revertTurnPathSet(turnId: string): { turnId: string; paths: string[] } {
    const row = this.store.getTurnRecord(turnId);
    const paths = (row?.touched ?? [])
      .filter((e) => e.op === 'write' || e.op === 'create')
      .map((e) => e.path);
    return { turnId, paths: dedupe(paths) };
  }

  /**
   * Validate an agent-callable `restorePaths` request: the requested set must be a
   * SUBSET of the turn's canonical witnessed write/create set. Non-witnessed paths
   * are REJECTED (never restored). Same-path active contention is detected from OPEN
   * turn_records (not inferred from a git diff): another still-open turn that
   * witnessed one of these paths may still be writing it.
   */
  validateRestorePaths(
    turnId: string,
    requestedPaths: string[],
    workspaceId: string,
  ): RestorePathValidation {
    const witnessedSet = this.revertTurnPathSet(turnId).paths;
    const witnessed = new Set(witnessedSet);

    const validatedPaths: string[] = [];
    const rejectedPaths: string[] = [];
    for (const p of dedupe(requestedPaths)) {
      if (witnessed.has(p)) validatedPaths.push(p);
      else rejectedPaths.push(p);
    }

    // Same-path active contention from OPEN turn_records (excluding this turn).
    const requested = new Set(validatedPaths);
    const contention: { path: string; turnId: string }[] = [];
    for (const other of this.store.listTurnRecords(workspaceId)) {
      if (other.id === turnId || other.status !== 'open') continue;
      for (const e of other.touched ?? []) {
        if ((e.op === 'write' || e.op === 'create') && requested.has(e.path)) {
          contention.push({ path: e.path, turnId: other.id });
        }
      }
    }

    return {
      ok: rejectedPaths.length === 0,
      turnId,
      witnessedSet,
      validatedPaths,
      rejectedPaths,
      contention,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────────

  private longpaths(): string[] {
    return this.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  }

  /** runGit with the resolved exe + a default 30 s bound; callers override bounds. */
  private git(
    repoRoot: string,
    args: string[],
    opts: Partial<RunGitOptions> = {},
  ): Promise<GitRunResult> {
    return this.runGit(repoRoot, args, {
      gitExe: this.gitExe,
      maxBytes: 64 << 20,
      timeoutMs: 30_000,
      ...opts,
    });
  }

  private scheduleCleanup(indexFile: string): void {
    const p = this.cleanupIndex(indexFile);
    this.cleanups.push(p);
    // Bound the list so a long-lived service doesn't retain settled promises.
    if (this.cleanups.length > 64) this.cleanups.splice(0, this.cleanups.length - 64);
  }

  /** Delete the temp index + any `<idx>.lock`, bounded, best-effort, off the delivery
   *  path. Backstopped by the startup temp-artifact sweeper (WP-G1.8). */
  private async cleanupIndex(indexFile: string): Promise<void> {
    const deadline = this.now() + this.timing.cleanupAllowanceMs;
    for (const target of [indexFile, `${indexFile}.lock`]) {
      if (this.now() > deadline) return;
      try {
        await fs.promises.unlink(target);
      } catch {
        /* ENOENT / best-effort — the sweeper backstops any straggler */
      }
    }
  }

  /** Await all scheduled cleanups — TEST-ONLY hook so temp indexes don't leak. */
  async settleCleanups(): Promise<void> {
    await Promise.allSettled(this.cleanups.splice(0));
  }
}

// ── diff / validation DTOs ──────────────────────────────────────────────────────

export interface DiffResult {
  available: boolean;
  reason: string | null;
  /** Human label — witnessed vs. "unattributed changes in this window". */
  label: string;
  text: string | null;
  provenance?: 'witnessed' | 'raw-window';
}

export interface RestorePathValidation {
  ok: boolean;
  turnId: string;
  /** The canonical witnessed write/create set. */
  witnessedSet: string[];
  /** Requested paths accepted (subset of the witnessed set). */
  validatedPaths: string[];
  /** Requested paths NOT witnessed by this turn → rejected. */
  rejectedPaths: string[];
  /** Same-path contention from other OPEN turn_records. */
  contention: { path: string; turnId: string }[];
}

// ── internals ────────────────────────────────────────────────────────────────

/** Thrown out of rawSnapshot when enumeration returns an oversized skip. */
class EnumerationSkipError extends Error {
  constructor(readonly reason: string, readonly detail: string) {
    super(`enumeration skipped: ${reason}`);
    this.name = 'EnumerationSkipError';
  }
}

function isSkippedDeadline(v: unknown): v is SkippedDeadline {
  return typeof v === 'object' && v !== null && (v as SkippedDeadline).skipped === 'deadline';
}

function describeError(err: unknown): string {
  if (err instanceof GitCommandError) return `git-${err.kind}`;
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}
