// Save-card architecture WP-5/WP-6 — full planning-worktree startup recovery.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getPlanExecutionRun,
  getWorkspace,
  listActivityMergeAttempts,
  listPlanningActivityWorktrees,
  updateActivityMergeAttempt,
  updatePlanningActivityWorktree,
  type PlanningActivityWorktree,
} from '../database';
import { runGit as realRunGit, type RunGitOptions } from './git-command';
import {
  cleanupPlanningActivity,
  PLANNING_WORKTREE_MARKER,
  type PlanningGitRunner,
} from './planning-worktree-service';
import { recordIntentArchitectureEvent } from './intent-architecture-telemetry';

const OPTS: RunGitOptions = { allowNonzero: true, timeoutMs: 30_000, maxBytes: 1 << 20 };

export interface PlanningWorktreeReconcileResult {
  executionRunId: string;
  disposition: 'finished' | 'removed' | 'recreated' | 'restored' | 'retried' | 'quarantined';
  failureCode: string | null;
}

export interface PlanningWorktreeReconcilerDeps {
  listActivities?: () => PlanningActivityWorktree[];
  /** WP-5 compatibility seam. */
  listProvisioning?: () => PlanningActivityWorktree[];
  resolvePrimaryPath?: (logicalWorkspaceId: string) => string | null;
  updateActivity?: typeof updatePlanningActivityWorktree;
  runGit?: PlanningGitRunner;
  finishActivation?: (row: PlanningActivityWorktree) => Promise<boolean>;
  hasExecutionRun?: (executionRunId: string) => boolean;
  listMergeAttempts?: typeof listActivityMergeAttempts;
  updateMergeAttempt?: typeof updateActivityMergeAttempt;
  isActivityCompleted?: (executionRunId: string) => boolean;
  cleanup?: typeof cleanupPlanningActivity;
  now?: () => number;
  gitExe?: string;
}

function markerOwnedBy(markerPath: string, executionRunId: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    return parsed.owner === 'lares' && parsed.version === 1 && parsed.executionRunId === executionRunId;
  } catch { return false; }
}

async function probe(runGit: PlanningGitRunner, cwd: string, args: string[], gitExe?: string) {
  return runGit(cwd, args, { ...OPTS, gitExe });
}

/** Implements every design §5.4 row. Recovery is conservative: any dirty or
 * unowned filesystem artifact is quarantined, never removed by decoded id alone. */
export async function reconcilePlanningActivityWorktrees(
  deps: PlanningWorktreeReconcilerDeps = {},
): Promise<PlanningWorktreeReconcileResult[]> {
  const rows = (deps.listActivities ?? deps.listProvisioning ?? (() => listPlanningActivityWorktrees()))();
  const resolvePrimaryPath = deps.resolvePrimaryPath ?? ((id) => getWorkspace(id)?.path ?? null);
  const updateActivity = deps.updateActivity ?? updatePlanningActivityWorktree;
  const runGit = deps.runGit ?? realRunGit;
  const now = deps.now ?? Date.now;
  const completed = deps.isActivityCompleted ?? ((id) => getPlanExecutionRun(id)?.lifecycleState === 'archived');
  const results: PlanningWorktreeReconcileResult[] = [];

  const quarantine = (row: PlanningActivityWorktree, failureCode: string) => {
    updateActivity({ executionRunId: row.executionRunId, state: 'recovery-required', failureCode, updatedAt: now() });
    results.push({ executionRunId: row.executionRunId, disposition: 'quarantined', failureCode });
  };

  for (const row of rows) {
    if (row.state === 'cleaned' || row.state === 'recovery-required') continue;
    const primaryPath = resolvePrimaryPath(row.logicalWorkspaceId);
    if (!primaryPath) { quarantine(row, 'primary-workspace-missing'); continue; }
    const pathExists = fs.existsSync(row.path);
    const owned = pathExists && markerOwnedBy(path.join(row.path, PLANNING_WORKTREE_MARKER), row.executionRunId);
    const ref = await probe(runGit, primaryPath, ['rev-parse', '--verify', row.activityHeadRef], deps.gitExe);
    const refExists = ref.code === 0 && Boolean(ref.stdout.trim());

    // missing both path and ref -> recovery-required; never claim merged.
    if (!pathExists && !refExists) { quarantine(row, 'activity-path-and-ref-missing'); continue; }

    // missing ref + verified owned worktree -> recreate from its HEAD.
    if (pathExists && !refExists) {
      if (!owned) { quarantine(row, 'ownership-marker-invalid'); continue; }
      const head = await probe(runGit, row.path, ['rev-parse', '--verify', 'HEAD'], deps.gitExe);
      if (head.code !== 0) { quarantine(row, 'activity-head-missing'); continue; }
      const created = await probe(runGit, primaryPath, ['update-ref', row.activityHeadRef, head.stdout.trim()], deps.gitExe);
      if (created.code !== 0) { quarantine(row, 'activity-ref-recreate-failed'); continue; }
      results.push({ executionRunId: row.executionRunId, disposition: 'recreated', failureCode: null });
      continue;
    }

    // active + missing path + valid ref -> rebuild detached worktree and marker.
    if (!pathExists && refExists) {
      if (row.state === 'active' || row.state === 'merge-pending' || row.state === 'merge-conflicted' || row.state === 'merged') {
        fs.mkdirSync(path.dirname(row.path), { recursive: true });
        const add = await probe(runGit, primaryPath, ['worktree', 'add', '--detach', row.path, row.activityHeadRef], deps.gitExe);
        if (add.code !== 0) { quarantine(row, 'activity-worktree-recreate-failed'); continue; }
        fs.writeFileSync(path.join(row.path, PLANNING_WORKTREE_MARKER), JSON.stringify({
          owner: 'lares', version: 1, executionRunId: row.executionRunId,
          logicalWorkspaceId: row.logicalWorkspaceId, path: row.path,
        }, null, 2), { encoding: 'utf8', flag: 'wx' });
        results.push({ executionRunId: row.executionRunId, disposition: 'recreated', failureCode: null });
      } else { quarantine(row, 'activity-path-missing'); }
      continue;
    }

    if (!owned) { quarantine(row, 'ownership-marker-invalid'); continue; }
    const [head, status] = await Promise.all([
      probe(runGit, row.path, ['rev-parse', '--verify', 'HEAD'], deps.gitExe),
      probe(runGit, row.path, ['status', '--porcelain', '--untracked-files=all'], deps.gitExe),
    ]);
    if (head.code !== 0) { quarantine(row, 'activity-head-missing'); continue; }
    const dirtyRows = status.stdout.split(/\r?\n/).filter(Boolean)
      .filter((line) => !line.endsWith(PLANNING_WORKTREE_MARKER));
    if (status.code !== 0 || dirtyRows.length > 0) { quarantine(row, 'dirty-activity-orphan'); continue; }

    if (row.state === 'provisioning') {
      if (head.stdout.trim() !== row.baselineOid || ref.stdout.trim() !== row.baselineOid) {
        quarantine(row, 'provisioning-head-or-ref-mismatch'); continue;
      }
      if (deps.finishActivation && await deps.finishActivation(row)) {
        results.push({ executionRunId: row.executionRunId, disposition: 'finished', failureCode: null });
      } else if (!(deps.hasExecutionRun ?? ((id) => Boolean(getPlanExecutionRun(id))))(row.executionRunId)) {
        // Baseline-only clean orphan: marker, path, HEAD and ref were all proven.
        const removed = await probe(runGit, primaryPath, ['worktree', 'remove', row.path], deps.gitExe);
        if (removed.code === 0) {
          await probe(runGit, primaryPath, ['worktree', 'prune'], deps.gitExe);
          await probe(runGit, primaryPath, ['update-ref', '-d', row.activityHeadRef, row.baselineOid], deps.gitExe);
          updateActivity({ executionRunId: row.executionRunId, state: 'cleaned', failureCode: null, updatedAt: now() });
          results.push({ executionRunId: row.executionRunId, disposition: 'removed', failureCode: null });
        } else quarantine(row, 'baseline-orphan-remove-refused');
      } else quarantine(row, 'activation-reconciliation-required');
      continue;
    }

    if (row.state === 'merge-pending' || row.state === 'merge-conflicted') {
      const uncertain = (deps.listMergeAttempts ?? listActivityMergeAttempts)(row.executionRunId)
        .find((attempt) => attempt.state === 'pending' && attempt.proposedCommitOid);
      if (uncertain?.proposedCommitOid) {
        const primaryHead = await probe(runGit, primaryPath, ['rev-parse', '--verify', 'HEAD'], deps.gitExe);
        const reflog = primaryHead.stdout.trim() === uncertain.proposedCommitOid
          ? null
          : await probe(runGit, primaryPath, ['reflog', '--format=%H %gs'], deps.gitExe);
        const marker = `lares-activity-merge:${uncertain.id}`;
        const casWasApplied = primaryHead.stdout.trim() === uncertain.proposedCommitOid
          || (reflog?.code === 0 && reflog.stdout.split(/\r?\n/).some((line) =>
            line.startsWith(`${uncertain.proposedCommitOid} `) && line.includes(marker)));
        if (casWasApplied) {
          (deps.updateMergeAttempt ?? updateActivityMergeAttempt)({ id: uncertain.id, state: 'committed', endedAt: now() });
          updateActivity({ executionRunId: row.executionRunId, promotedHeadOid: uncertain.proposedCommitOid,
            state: 'active', failureCode: null, updatedAt: now() });
        }
      }
      results.push({ executionRunId: row.executionRunId, disposition: 'restored', failureCode: null });
      continue;
    }

    if (row.state === 'cleanup-pending' || completed(row.executionRunId)) {
      const result = await (deps.cleanup ?? cleanupPlanningActivity)({
        executionRunId: row.executionRunId, primaryRepoRoot: primaryPath,
        activityCompleted: completed(row.executionRunId), gitExe: deps.gitExe,
      });
      results.push({ executionRunId: row.executionRunId,
        disposition: result.ok ? 'retried' : 'quarantined', failureCode: result.ok ? null : result.reason });
      continue;
    }
    results.push({ executionRunId: row.executionRunId, disposition: 'finished', failureCode: null });
  }
  const recovered = results.filter((result) =>
    result.disposition === 'removed' || result.disposition === 'recreated'
    || result.disposition === 'restored' || result.disposition === 'retried').length;
  if (recovered > 0) recordIntentArchitectureEvent('recovered', recovered);
  return results;
}
