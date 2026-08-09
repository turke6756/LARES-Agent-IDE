// Save-card architecture WP-5 — startup reconciliation for provisioning crashes.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getWorkspace,
  listPlanningActivityWorktrees,
  updatePlanningActivityWorktree,
  type PlanningActivityWorktree,
} from '../database';
import { runGit as realRunGit, type RunGitOptions } from './git-command';
import {
  PLANNING_WORKTREE_MARKER,
  type PlanningGitRunner,
} from './planning-worktree-service';

const OPTS: RunGitOptions = { allowNonzero: true, timeoutMs: 10_000, maxBytes: 1 << 20 };

export interface PlanningWorktreeReconcileResult {
  executionRunId: string;
  disposition: 'finished' | 'quarantined';
  failureCode: string | null;
}

export interface PlanningWorktreeReconcilerDeps {
  listProvisioning?: () => PlanningActivityWorktree[];
  resolvePrimaryPath?: (logicalWorkspaceId: string) => string | null;
  updateActivity?: typeof updatePlanningActivityWorktree;
  runGit?: PlanningGitRunner;
  /** Optional app-owned recovery seam. If it can complete activation, return true;
   * otherwise the intact worktree is quarantined for an explicit later recovery. */
  finishActivation?: (row: PlanningActivityWorktree) => Promise<boolean>;
  now?: () => number;
  gitExe?: string;
}

function markerOwnedBy(markerPath: string, executionRunId: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    return parsed.owner === 'lares' && parsed.version === 1
      && parsed.executionRunId === executionRunId;
  } catch {
    return false;
  }
}

/** Reconcile every pre-activation row. Nothing is deleted here (cleanup belongs to
 * WP-6); an incomplete or unverifiable artifact is moved to recovery-required. */
export async function reconcilePlanningActivityWorktrees(
  deps: PlanningWorktreeReconcilerDeps = {},
): Promise<PlanningWorktreeReconcileResult[]> {
  const rows = (deps.listProvisioning ?? (() => listPlanningActivityWorktrees(['provisioning'])))();
  const resolvePrimaryPath = deps.resolvePrimaryPath ?? ((workspaceId) => getWorkspace(workspaceId)?.path ?? null);
  const updateActivity = deps.updateActivity ?? updatePlanningActivityWorktree;
  const runGit = deps.runGit ?? realRunGit;
  const now = deps.now ?? Date.now;
  const results: PlanningWorktreeReconcileResult[] = [];

  for (const row of rows) {
    let failureCode: string | null = null;
    const primaryPath = resolvePrimaryPath(row.logicalWorkspaceId);
    if (!primaryPath) failureCode = 'primary-workspace-missing';
    else if (!fs.existsSync(row.path)) failureCode = 'activity-path-missing';
    else if (!markerOwnedBy(path.join(row.path, PLANNING_WORKTREE_MARKER), row.executionRunId)) {
      failureCode = 'ownership-marker-invalid';
    } else {
      const [head, ref] = await Promise.all([
        runGit(row.path, ['rev-parse', '--verify', 'HEAD'], { ...OPTS, gitExe: deps.gitExe }),
        runGit(primaryPath, ['rev-parse', '--verify', row.activityHeadRef], { ...OPTS, gitExe: deps.gitExe }),
      ]);
      if (head.code !== 0 || head.stdout.trim() !== row.baselineOid) {
        failureCode = 'activity-head-mismatch';
      } else if (ref.code !== 0 || ref.stdout.trim() !== row.baselineOid) {
        failureCode = 'activity-ref-mismatch';
      }
    }

    if (!failureCode && deps.finishActivation && await deps.finishActivation(row)) {
      results.push({ executionRunId: row.executionRunId, disposition: 'finished', failureCode: null });
      continue;
    }
    failureCode ??= 'activation-reconciliation-required';
    updateActivity({
      executionRunId: row.executionRunId,
      state: 'recovery-required',
      failureCode,
      updatedAt: now(),
    });
    results.push({ executionRunId: row.executionRunId, disposition: 'quarantined', failureCode });
  }
  return results;
}
