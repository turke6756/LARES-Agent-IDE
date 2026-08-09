// Save-card architecture WP-6 — isolated planning-activity merge-back.
// MAIN-PROCESS ONLY. This module never runs `git merge` in a live worktree.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getActivityMergeAttempt,
  getPlanningActivityWorktree,
  getWorkspace,
  insertActivityMergeAttempt,
  listActivityMergeAttempts,
  listActivityMergeConflicts,
  replaceActivityMergeConflicts,
  recordPromotedCheckpointRefs,
  resolveActivityMergeConflict as persistResolution,
  updateActivityMergeAttempt,
  updatePlanningActivityWorktree,
  type ActivityMergeAttempt,
  type ActivityMergeConflict,
  type PlanningActivityWorktree,
} from '../database';
import { runGit as realRunGit, runGitBytes as realRunGitBytes, type GitRunBytesResult, type GitRunResult, type RunGitOptions } from './git-command';

const OID_RE = /^[0-9a-f]{40,64}$/;
const OPTS: RunGitOptions = { allowNonzero: true, timeoutMs: 60_000, maxBytes: 64 << 20 };

export type ActivityMergeRunGit = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;
export type ActivityMergeRunGitBytes = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunBytesResult>;

export interface ActivityMergeStore {
  getActivity(executionRunId: string): PlanningActivityWorktree | null;
  getAttempt(id: string): ActivityMergeAttempt | null;
  listAttempts(executionRunId: string): ActivityMergeAttempt[];
  listConflicts(attemptId: string): ActivityMergeConflict[];
  insertAttempt(row: ActivityMergeAttempt): ActivityMergeAttempt;
  updateAttempt(input: Parameters<typeof updateActivityMergeAttempt>[0]): ActivityMergeAttempt;
  replaceConflicts(attemptId: string, rows: readonly ActivityMergeConflict[]): void;
  resolveConflict(input: Parameters<typeof persistResolution>[0]): ActivityMergeConflict | null;
  updateActivity(input: Parameters<typeof updatePlanningActivityWorktree>[0]): PlanningActivityWorktree;
  recordPromotedCheckpointRefs?: typeof recordPromotedCheckpointRefs;
}

export interface ActivityMergeServiceDeps {
  gitExe?: string;
  runGit?: ActivityMergeRunGit;
  runGitBytes?: ActivityMergeRunGitBytes;
  tmpDir?: string;
  now?: () => number;
  newAttemptId?: () => string;
  resolvePrimaryPath?: (logicalWorkspaceId: string) => string | null;
  store?: ActivityMergeStore;
  afterTentativeCommit?: (attempt: ActivityMergeAttempt) => Promise<void> | void;
}

export type ActivityPromotionResult =
  | { status: 'promoted'; attemptId: string; primaryHeadOid: string }
  | { status: 'conflicted'; attemptId: string; conflicts: ActivityMergeConflict[] }
  | { status: 'stale'; attemptId: string }
  | { status: 'pending'; attemptId: string; reason: string }
  | { status: 'recovery-required'; attemptId: string; reason: string };

const defaultStore: ActivityMergeStore = {
  getActivity: getPlanningActivityWorktree,
  getAttempt: getActivityMergeAttempt,
  listAttempts: listActivityMergeAttempts,
  listConflicts: listActivityMergeConflicts,
  insertAttempt: insertActivityMergeAttempt,
  updateAttempt: updateActivityMergeAttempt,
  replaceConflicts: replaceActivityMergeConflicts,
  resolveConflict: persistResolution,
  updateActivity: updatePlanningActivityWorktree,
  recordPromotedCheckpointRefs,
};

function splitZero(bytes: Buffer): Buffer[] {
  const rows: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) continue;
    if (i > start) rows.push(bytes.subarray(start, i));
    start = i + 1;
  }
  return rows;
}

function parseUnmerged(bytes: Buffer, attemptId: string): ActivityMergeConflict[] {
  const byPath = new Map<string, ActivityMergeConflict>();
  for (const row of splitZero(bytes)) {
    const tab = row.indexOf(9);
    if (tab < 0) continue;
    const meta = row.subarray(0, tab).toString('ascii').split(' ');
    const stage = Number(meta[2]);
    const pathBytesBase64 = row.subarray(tab + 1).toString('base64');
    const current = byPath.get(pathBytesBase64) ?? {
      attemptId, pathBytesBase64, baseBlobOid: null, primaryBlobOid: null,
      activityBlobOid: null, resolutionBlobOid: null, resolution: null,
    };
    if (stage === 1) current.baseBlobOid = meta[1] ?? null;
    if (stage === 2) current.primaryBlobOid = meta[1] ?? null;
    if (stage === 3) current.activityBlobOid = meta[1] ?? null;
    byPath.set(pathBytesBase64, current);
  }
  return [...byPath.values()].sort((a, b) => a.pathBytesBase64.localeCompare(b.pathBytesBase64));
}

function displayPath(pathBytesBase64: string): string {
  return Buffer.from(pathBytesBase64, 'base64').toString('utf8');
}

function latestPromotionBase(activity: PlanningActivityWorktree, attempts: ActivityMergeAttempt[]): string {
  return attempts.find((row) => row.state === 'committed')?.activityHeadOid ?? activity.baselineOid;
}

export class ActivityMergeService {
  private readonly runGit: ActivityMergeRunGit;
  private readonly runGitBytes: ActivityMergeRunGitBytes;
  private readonly store: ActivityMergeStore;
  private readonly now: () => number;
  private readonly newAttemptId: () => string;

  constructor(private readonly deps: ActivityMergeServiceDeps = {}) {
    this.runGit = deps.runGit ?? realRunGit;
    this.runGitBytes = deps.runGitBytes ?? realRunGitBytes;
    this.store = deps.store ?? defaultStore;
    this.now = deps.now ?? Date.now;
    this.newAttemptId = deps.newAttemptId ?? randomUUID;
  }

  async promote(executionRunId: string): Promise<ActivityPromotionResult> {
    try {
      return await this.promoteInternal(executionRunId, null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.store.getActivity(executionRunId)) {
        this.store.updateActivity({ executionRunId, state: 'merge-pending',
          failureCode: reason.slice(0, 300), updatedAt: this.now() });
      }
      return { status: 'pending', attemptId: 'unstarted', reason };
    }
  }

  async resolveAndPromote(input: {
    attemptId: string;
    resolutions: Array<{ pathBytesBase64: string; resolution: 'keep-primary' | 'take-activity' | 'merged'; resolutionBlobOid?: string | null }>;
  }): Promise<ActivityPromotionResult> {
    const attempt = this.store.getAttempt(input.attemptId);
    if (!attempt || attempt.state !== 'conflicted') {
      throw new Error('activity-merge-attempt-not-conflicted');
    }
    const known = new Map(this.store.listConflicts(attempt.id).map((row) => [row.pathBytesBase64, row]));
    for (const resolution of input.resolutions) {
      const conflict = known.get(resolution.pathBytesBase64);
      if (!conflict) throw new Error('activity-merge-conflict-not-found');
      const oid = resolution.resolution === 'keep-primary' ? conflict.primaryBlobOid
        : resolution.resolution === 'take-activity' ? conflict.activityBlobOid
          : resolution.resolutionBlobOid ?? null;
      if (resolution.resolution === 'merged' && (!oid || !OID_RE.test(oid))) {
        throw new Error('merged-resolution-requires-valid-blob');
      }
      this.store.resolveConflict({ attemptId: attempt.id, pathBytesBase64: resolution.pathBytesBase64,
        resolution: resolution.resolution, resolutionBlobOid: oid });
    }
    const unresolved = this.store.listConflicts(attempt.id).filter((row) => !row.resolution);
    if (unresolved.length > 0) return { status: 'conflicted', attemptId: attempt.id, conflicts: unresolved };
    return this.promoteInternal(attempt.executionRunId, attempt);
  }

  private async promoteInternal(executionRunId: string, resumed: ActivityMergeAttempt | null): Promise<ActivityPromotionResult> {
    const activity = this.store.getActivity(executionRunId);
    if (!activity) throw new Error(`planning activity not found: ${executionRunId}`);
    const primaryPath = this.deps.resolvePrimaryPath?.(activity.logicalWorkspaceId)
      ?? getWorkspace(activity.logicalWorkspaceId)?.path ?? null;
    if (!primaryPath) throw new Error('primary-workspace-missing');
    const readOid = async (cwd: string, ref: string): Promise<string> => {
      const result = await this.runGit(cwd, ['rev-parse', '--verify', ref], { ...OPTS, gitExe: this.deps.gitExe });
      if (result.code !== 0 || !OID_RE.test(result.stdout.trim())) throw new Error(`missing-ref:${ref}`);
      return result.stdout.trim();
    };
    const [ours, theirs] = await Promise.all([
      readOid(primaryPath, 'HEAD'), readOid(activity.path, activity.activityHeadRef),
    ]);
    const base = latestPromotionBase(activity, this.store.listAttempts(executionRunId));

    if (resumed && (resumed.baseOid !== base || resumed.primaryHeadOid !== ours || resumed.activityHeadOid !== theirs)) {
      this.store.updateAttempt({ id: resumed.id, state: 'stale', endedAt: this.now() });
      this.store.updateActivity({ executionRunId, state: 'merge-pending', failureCode: 'merge-resolution-stale', updatedAt: this.now() });
      return { status: 'stale', attemptId: resumed.id };
    }
    if (base === theirs) {
      this.store.updateActivity({ executionRunId, promotedHeadOid: ours, state: 'active', failureCode: null, updatedAt: this.now() });
      return { status: 'promoted', attemptId: resumed?.id ?? 'already-promoted', primaryHeadOid: ours };
    }

    const attempt = resumed ?? this.store.insertAttempt({
      id: this.newAttemptId(), executionRunId, baseOid: base, primaryHeadOid: ours,
      activityHeadOid: theirs, proposedCommitOid: null, state: 'pending',
      startedAt: this.now(), endedAt: null,
    });
    this.store.updateActivity({ executionRunId, state: 'merge-pending', failureCode: null, updatedAt: this.now() });

    const tempDir = await fs.promises.mkdtemp(path.join(this.deps.tmpDir ?? os.tmpdir(), 'lares-activity-merge-'));
    const indexFile = path.join(tempDir, 'index');
    const opts = { ...OPTS, gitExe: this.deps.gitExe, indexFile };
    try {
      // `read-tree -m` is only a trivial blob-level merge and would falsely
      // conflict whenever both sides edit one file. `merge-tree --write-tree`
      // runs Git's real content merge without touching a worktree; its -z output
      // begins with the result tree and then exact stage records for real conflicts.
      const merged = await this.runGitBytes(primaryPath,
        ['merge-tree', '--write-tree', '--merge-base', base, '--messages', '-z', ours, theirs], opts);
      if (merged.code > 1) throw new Error(merged.stderr.trim() || 'merge-tree-three-way-failed');
      const mergeRecords = splitZero(merged.stdout);
      const mergeTreeOid = mergeRecords.shift()?.toString('ascii').trim() ?? '';
      if (!OID_RE.test(mergeTreeOid)) throw new Error('merge-tree-result-missing');
      const readTree = await this.runGit(primaryPath, ['read-tree', mergeTreeOid], opts);
      if (readTree.code !== 0) throw new Error(readTree.stderr.trim() || 'merge-result-read-tree-failed');
      let conflicts = parseUnmerged(Buffer.concat(mergeRecords.flatMap((row) => [row, Buffer.from([0])])), attempt.id);
      if (conflicts.length > 0 && resumed) {
        const resolutions = new Map(this.store.listConflicts(attempt.id).map((row) => [row.pathBytesBase64, row]));
        for (const conflict of conflicts) {
          const resolved = resolutions.get(conflict.pathBytesBase64);
          if (!resolved?.resolution) continue;
          const oid = resolved.resolutionBlobOid;
          const p = displayPath(conflict.pathBytesBase64);
          if (oid) {
            const modeResult = await this.runGit(primaryPath, ['ls-files', '-u', '--', p], opts);
            const mode = modeResult.stdout.trim().split(/\s+/)[0] || '100644';
            await this.runGit(primaryPath, ['update-index', '--add', '--cacheinfo', mode, oid, p], opts);
          } else {
            await this.runGit(primaryPath, ['update-index', '--force-remove', '--', p], opts);
          }
        }
        conflicts = conflicts.filter((conflict) => !resolutions.get(conflict.pathBytesBase64)?.resolution);
      }
      if (conflicts.length > 0) {
        this.store.replaceConflicts(attempt.id, conflicts);
        this.store.updateAttempt({ id: attempt.id, state: 'conflicted', endedAt: this.now() });
        this.store.updateActivity({ executionRunId, state: 'merge-conflicted', failureCode: null, updatedAt: this.now() });
        return { status: 'conflicted', attemptId: attempt.id, conflicts };
      }

      const treeResult = await this.runGit(primaryPath, ['write-tree'], opts);
      const treeOid = treeResult.stdout.trim();
      if (treeResult.code !== 0 || !OID_RE.test(treeOid)) throw new Error('merge-write-tree-failed');
      const changedBytes = await this.runGitBytes(primaryPath,
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', ours, treeOid],
        { ...OPTS, gitExe: this.deps.gitExe });
      if (changedBytes.code !== 0) throw new Error('merge-path-discovery-failed');
      const affected = splitZero(changedBytes.stdout);

      // Affected primary paths must be clean. Unrelated dirt is deliberately not
      // inspected and therefore cannot block or be reconciled by this operation.
      for (const rawPath of affected) {
        const p = rawPath.toString('utf8');
        const status = await this.runGitBytes(primaryPath,
          ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', p],
          { ...OPTS, gitExe: this.deps.gitExe });
        if (status.code !== 0 || status.stdout.length > 0) {
          const [desired, staged, worktree] = await Promise.all([
            this.runGit(primaryPath, ['ls-tree', treeOid, '--', p], { ...OPTS, gitExe: this.deps.gitExe }),
            this.runGit(primaryPath, ['ls-files', '--stage', '--', p], { ...OPTS, gitExe: this.deps.gitExe }),
            fs.existsSync(path.join(primaryPath, p))
              ? this.runGit(primaryPath, ['hash-object', `--path=${p}`, '--', p], { ...OPTS, gitExe: this.deps.gitExe })
              : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
          ]);
          const desiredOid = desired.stdout.trim().split(/\s+/)[2] ?? '';
          const stagedOid = staged.stdout.trim().split(/\s+/)[1] ?? '';
          const alreadyMerged = desired.code === 0 && staged.code === 0 && worktree.code === 0
            && desiredOid === stagedOid && desiredOid === worktree.stdout.trim();
          if (!alreadyMerged) {
            this.store.updateAttempt({ id: attempt.id, state: 'failed', endedAt: this.now() });
            this.store.updateActivity({ executionRunId, state: 'merge-pending', failureCode: 'primary-path-dirty', updatedAt: this.now() });
            return { status: 'pending', attemptId: attempt.id, reason: `primary path is dirty: ${p}` };
          }
        }
      }

      let proposed = theirs;
      if (ours !== base) {
        const commit = await this.runGit(primaryPath,
          ['commit-tree', treeOid, '-p', ours, '-p', theirs, '-m', `Promote planning activity ${executionRunId}`],
          { ...OPTS, gitExe: this.deps.gitExe, mode: 'user-commit' });
        proposed = commit.stdout.trim();
        if (commit.code !== 0 || !OID_RE.test(proposed)) throw new Error('merge-commit-tree-failed');
      }
      this.store.updateAttempt({ id: attempt.id, proposedCommitOid: proposed });
      await this.deps.afterTentativeCommit?.({ ...attempt, proposedCommitOid: proposed });
      const cas = await this.runGit(primaryPath,
        ['update-ref', '-m', `lares-activity-merge:${attempt.id}`, 'HEAD', proposed, ours],
        { ...OPTS, gitExe: this.deps.gitExe });
      if (cas.code !== 0) {
        this.store.updateAttempt({ id: attempt.id, state: 'stale', endedAt: this.now() });
        this.store.updateActivity({ executionRunId, state: 'merge-pending', failureCode: 'primary-head-moved', updatedAt: this.now() });
        return { status: 'stale', attemptId: attempt.id };
      }

      // Reconcile only paths proven clean above, from the already-verified temp index.
      if (affected.length > 0) {
        const stdin = Buffer.concat(affected.flatMap((p) => [p, Buffer.from([0])]));
        const checkout = await this.runGit(primaryPath, ['checkout-index', '--force', '--stdin', '-z'], { ...opts, stdin });
        if (checkout.code !== 0) throw new Error('primary-worktree-reconcile-failed');
        const stage = await this.runGitBytes(primaryPath, ['ls-files', '--stage', '-z', '--', ...affected.map((p) => p.toString('utf8'))], opts);
        const present = new Set(splitZero(stage.stdout).map((row) => row.subarray(row.indexOf(9) + 1).toString('base64')));
        let indexInfo = stage.stdout;
        for (const p of affected) {
          if (!present.has(p.toString('base64'))) indexInfo = Buffer.concat([indexInfo, Buffer.from(`0 ${'0'.repeat(40)}\t`), p, Buffer.from([0])]);
        }
        const updateIndex = await this.runGit(primaryPath, ['update-index', '--add', '--remove', '-z', '--index-info'],
          { ...OPTS, gitExe: this.deps.gitExe, stdin: indexInfo });
        if (updateIndex.code !== 0) throw new Error('primary-index-reconcile-failed');
      }
      const promotedActivityCommits = await this.runGit(activity.path,
        ['rev-list', '--reverse', `${base}..${theirs}`],
        { ...OPTS, gitExe: this.deps.gitExe });
      if (promotedActivityCommits.code !== 0) throw new Error('promotion-source-commits-unavailable');
      this.store.recordPromotedCheckpointRefs?.({
        primaryRepositoryKey: activity.primaryRepositoryKey,
        promotedCommitOid: proposed,
        sourceRepositoryKey: activity.activityRepositoryKey,
        sourceCommitOids: promotedActivityCommits.stdout.split(/\r?\n/).filter((oid) => OID_RE.test(oid)),
        createdAt: this.now(),
      });
      this.store.updateAttempt({ id: attempt.id, state: 'committed', proposedCommitOid: proposed, endedAt: this.now() });
      this.store.updateActivity({ executionRunId, promotedHeadOid: proposed, state: 'active', failureCode: null, updatedAt: this.now() });
      return { status: 'promoted', attemptId: attempt.id, primaryHeadOid: proposed };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.updateAttempt({ id: attempt.id, state: 'failed', endedAt: this.now() });
      this.store.updateActivity({ executionRunId, state: 'recovery-required', failureCode: reason.slice(0, 300), updatedAt: this.now() });
      return { status: 'recovery-required', attemptId: attempt.id, reason };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
}
