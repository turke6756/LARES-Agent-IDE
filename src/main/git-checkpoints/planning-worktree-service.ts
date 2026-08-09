// Save-card architecture WP-5 — isolated planning-activity worktrees.
// MAIN-PROCESS ONLY. Worktrees are physical execution roots, never workspaces.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getActiveAgents,
  getPlanningActivityWorktree,
  insertPlanningActivityWorktreeProvisioning,
  listActivityMergeAttempts,
  updatePlanningActivityWorktree,
  type PlanningActivityWorktree,
} from '../database';
import { runGit as realRunGit, type GitRunResult, type RunGitOptions } from './git-command';
import { encodeIdComponent } from './ref-encoding';

export const PLANNING_ACTIVITY_REF_PREFIX = 'refs/lares/activities';
export const PLANNING_WORKTREE_MARKER = '.lares-planning-worktree.json';

const GIT_OPTS: RunGitOptions = {
  allowNonzero: true,
  timeoutMs: 30_000,
  maxBytes: 1 << 20,
};

export type PlanningCreationStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type PlanningGitRunner = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunResult>;

export interface PlanningRepositoryIdentity {
  repositoryKey: string;
  objectDatabaseKey: string;
}

export function planningActivityHeadRef(executionRunId: string): string {
  if (!executionRunId) throw new Error('executionRunId must be non-empty');
  return `${PLANNING_ACTIVITY_REF_PREFIX}/${encodeIdComponent(executionRunId)}/head`;
}

export function planningActivityPath(
  appUserDataPath: string,
  workspaceId: string,
  executionRunId: string,
): string {
  return path.join(
    appUserDataPath,
    'planning-worktrees',
    encodeIdComponent(workspaceId),
    encodeIdComponent(executionRunId),
  );
}

function canonical(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function keyPath(p: string): string {
  const resolved = canonical(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(keyPath(parent), keyPath(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function deriveIdentity(
  cwd: string,
  runGit: PlanningGitRunner,
  gitExe?: string,
): Promise<PlanningRepositoryIdentity> {
  const opts = { ...GIT_OPTS, gitExe };
  const [common, index] = await Promise.all([
    runGit(cwd, ['rev-parse', '--git-common-dir'], opts),
    runGit(cwd, ['rev-parse', '--git-path', 'index'], opts),
  ]);
  if (common.code !== 0 || index.code !== 0 || !common.stdout.trim() || !index.stdout.trim()) {
    throw new Error('planning-worktree-identity-unavailable');
  }
  const commonPath = path.isAbsolute(common.stdout.trim())
    ? common.stdout.trim() : path.resolve(cwd, common.stdout.trim());
  const indexPath = path.isAbsolute(index.stdout.trim())
    ? index.stdout.trim() : path.resolve(cwd, index.stdout.trim());
  return {
    repositoryKey: createHash('sha256').update(keyPath(indexPath), 'utf8').digest('hex'),
    objectDatabaseKey: keyPath(commonPath),
  };
}

export interface ProvisionPlanningActivityInput {
  executionRunId: string;
  planId: string;
  logicalWorkspaceId: string;
  primaryRepoRoot: string;
  appUserDataPath: string;
  createdAt: number;
  gitExe?: string;
}

export interface ProvisionPlanningActivityDeps {
  recheckEligibility: () => Promise<boolean>;
  probeHead: () => Promise<string | null>;
  activate: (activity: PlanningActivityWorktree) => Promise<void> | void;
  runGit?: PlanningGitRunner;
  getExisting?: typeof getPlanningActivityWorktree;
  insertProvisioning?: typeof insertPlanningActivityWorktreeProvisioning;
  updateActivity?: typeof updatePlanningActivityWorktree;
  afterStep?: (step: PlanningCreationStep, activity: PlanningActivityWorktree | null) => void;
  writeMarker?: (markerPath: string, body: string) => void;
}

export type ProvisionPlanningActivityResult =
  | { ok: true; activity: PlanningActivityWorktree }
  | { ok: false; reason: 'ineligible' | 'worktree-requires-initial-commit' | 'worktree-provision-failed'; diagnostic?: string };

/** Execute design §4's nine creation steps. Every durable artifact is derived from
 * executionRunId, making retries/reconciliation idempotent and preventing a second
 * worktree for the same run. */
export async function provisionPlanningActivity(
  input: ProvisionPlanningActivityInput,
  deps: ProvisionPlanningActivityDeps,
): Promise<ProvisionPlanningActivityResult> {
  const runGit = deps.runGit ?? realRunGit;
  const getExisting = deps.getExisting ?? getPlanningActivityWorktree;
  const insertProvisioning = deps.insertProvisioning ?? insertPlanningActivityWorktreeProvisioning;
  const updateActivity = deps.updateActivity ?? updatePlanningActivityWorktree;
  const afterStep = deps.afterStep ?? (() => undefined);
  let activity: PlanningActivityWorktree | null = getExisting(input.executionRunId);
  try {
    // 1. Recheck Implement eligibility.
    if (!(await deps.recheckEligibility())) return { ok: false, reason: 'ineligible' };
    afterStep(1, activity);

    // 2. Pin a real primary HEAD; linked detached worktrees cannot use unborn HEAD.
    const baselineOid = await deps.probeHead();
    if (!baselineOid) return { ok: false, reason: 'worktree-requires-initial-commit' };
    afterStep(2, activity);

    // 3. Allocate deterministic app-owned path/ref for the already-allocated run id.
    const activityPath = planningActivityPath(
      input.appUserDataPath, input.logicalWorkspaceId, input.executionRunId,
    );
    const activityRef = planningActivityHeadRef(input.executionRunId);
    if (isInside(input.primaryRepoRoot, activityPath)) {
      throw new Error('planning worktree path must be outside the primary repository');
    }
    const primaryIdentity = await deriveIdentity(input.primaryRepoRoot, runGit, input.gitExe);
    afterStep(3, activity);

    // 4. Persist the recoverable row before creating a ref or directory.
    if (!activity) {
      activity = insertProvisioning({
        executionRunId: input.executionRunId,
        planId: input.planId,
        logicalWorkspaceId: input.logicalWorkspaceId,
        objectDatabaseKey: primaryIdentity.objectDatabaseKey,
        activityRepositoryKey: `provisioning:${input.executionRunId}`,
        primaryRepositoryKey: primaryIdentity.repositoryKey,
        path: activityPath,
        baselineOid,
        activityHeadRef: activityRef,
        promotedHeadOid: null,
        state: 'provisioning',
        failureCode: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
    }
    afterStep(4, activity);

    // 5. Create the durable activity ref at the pinned baseline.
    const createRef = await runGit(input.primaryRepoRoot, ['update-ref', activityRef, baselineOid], {
      ...GIT_OPTS, gitExe: input.gitExe,
    });
    if (createRef.code !== 0) throw new Error(`activity-ref-create-failed:${createRef.stderr.trim()}`);
    afterStep(5, activity);

    // 6. Create exactly one detached linked worktree.
    fs.mkdirSync(path.dirname(activityPath), { recursive: true });
    if (!fs.existsSync(activityPath)) {
      const added = await runGit(input.primaryRepoRoot,
        ['worktree', 'add', '--detach', activityPath, baselineOid],
        { ...GIT_OPTS, gitExe: input.gitExe });
      if (added.code !== 0) throw new Error(`git-worktree-add-failed:${added.stderr.trim()}`);
    }
    afterStep(6, activity);

    // 7. Persist marker, verify common objects + HEAD, and freeze the per-index key.
    const markerPath = path.join(activityPath, PLANNING_WORKTREE_MARKER);
    const markerBody = JSON.stringify({
      owner: 'lares', version: 1, executionRunId: input.executionRunId,
      logicalWorkspaceId: input.logicalWorkspaceId, path: activityPath,
    }, null, 2);
    (deps.writeMarker ?? ((p, body) => fs.writeFileSync(p, body, { encoding: 'utf8', flag: 'wx' })))(
      markerPath, markerBody,
    );
    const head = await runGit(activityPath, ['rev-parse', '--verify', 'HEAD'], {
      ...GIT_OPTS, gitExe: input.gitExe,
    });
    const activityIdentity = await deriveIdentity(activityPath, runGit, input.gitExe);
    if (head.code !== 0 || head.stdout.trim() !== baselineOid
      || activityIdentity.objectDatabaseKey !== primaryIdentity.objectDatabaseKey
      || activityIdentity.repositoryKey === primaryIdentity.repositoryKey
      || !fs.existsSync(markerPath)) {
      throw new Error('planning-worktree-verification-failed');
    }
    activity = updateActivity({
      executionRunId: input.executionRunId,
      activityRepositoryKey: activityIdentity.repositoryKey,
      objectDatabaseKey: activityIdentity.objectDatabaseKey,
      failureCode: null,
      updatedAt: input.createdAt,
    });
    afterStep(7, activity);

    // 8. Caller performs run insert/activation + activity active flip atomically.
    await deps.activate(activity);
    activity = getExisting(input.executionRunId) ?? { ...activity, state: 'active' };
    afterStep(8, activity);

    // 9. Success boundary; failures before activation remain recoverable below.
    afterStep(9, activity);
    return { ok: true, activity };
  } catch (error) {
    if (activity?.state === 'provisioning') {
      try {
        activity = updateActivity({
          executionRunId: activity.executionRunId,
          failureCode: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          updatedAt: Date.now(),
        });
      } catch { /* the reconciler can still infer artifacts from deterministic ids */ }
    }
    return {
      ok: false,
      reason: 'worktree-provision-failed',
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Atomically advance detached worktree HEAD and its durable activity ref with CAS. */
export async function advancePlanningActivityHead(input: {
  activityPath: string;
  activityHeadRef: string;
  expectedOldOid: string;
  newOid: string;
  gitExe?: string;
  runGit?: PlanningGitRunner;
}): Promise<{ ok: boolean; diagnostic?: string }> {
  const stdin = [
    'start',
    `update HEAD ${input.newOid} ${input.expectedOldOid}`,
    `update ${input.activityHeadRef} ${input.newOid} ${input.expectedOldOid}`,
    'prepare',
    'commit',
    '',
  ].join('\n');
  const result = await (input.runGit ?? realRunGit)(input.activityPath, ['update-ref', '--stdin'], {
    ...GIT_OPTS, gitExe: input.gitExe, stdin,
  });
  return result.code === 0 ? { ok: true } : { ok: false, diagnostic: result.stderr.trim() };
}

export interface PlanningActivityCleanupProofs {
  activityCompleted: boolean;
  reachable: boolean;
  worktreeClean: boolean;
  noLiveLease: boolean;
  noPendingMerge: boolean;
  fullyPromoted: boolean;
  ownershipMarker: boolean;
}

export type PlanningActivityCleanupResult =
  | { ok: true; state: 'cleaned'; proofs: PlanningActivityCleanupProofs }
  | { ok: false; state: 'recovery-required'; proofs: PlanningActivityCleanupProofs; reason: string };

function markerOwnedByRun(markerPath: string, executionRunId: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    return marker.owner === 'lares' && marker.version === 1 && marker.executionRunId === executionRunId;
  } catch { return false; }
}

/** Design §5.3 proof gate. The activity directory/ref are removed only after every
 * proof passes, and Git's non-forced worktree removal is the final authority. */
export async function cleanupPlanningActivity(input: {
  executionRunId: string;
  primaryRepoRoot: string;
  activityCompleted: boolean;
  gitExe?: string;
}, deps: {
  runGit?: PlanningGitRunner;
  getActivity?: typeof getPlanningActivityWorktree;
  updateActivity?: typeof updatePlanningActivityWorktree;
  hasLiveLease?: (activityPath: string) => boolean;
  hasPendingMerge?: (executionRunId: string) => boolean;
  now?: () => number;
} = {}): Promise<PlanningActivityCleanupResult> {
  const runGit = deps.runGit ?? realRunGit;
  const getActivity = deps.getActivity ?? getPlanningActivityWorktree;
  const updateActivity = deps.updateActivity ?? updatePlanningActivityWorktree;
  const now = deps.now ?? Date.now;
  const activity = getActivity(input.executionRunId);
  if (!activity) throw new Error(`planning activity not found: ${input.executionRunId}`);
  const opts = { ...GIT_OPTS, gitExe: input.gitExe };
  const [reachableResult, status, activityHead] = await Promise.all([
    activity.promotedHeadOid
      ? runGit(input.primaryRepoRoot, ['merge-base', '--is-ancestor', activity.activityHeadRef, activity.promotedHeadOid], opts)
      : Promise.resolve({ code: 1, stdout: '', stderr: 'not promoted' }),
    fs.existsSync(activity.path)
      ? runGit(activity.path, ['status', '--porcelain', '--untracked-files=all'], opts)
      : Promise.resolve({ code: 1, stdout: '', stderr: 'activity path missing' }),
    runGit(input.primaryRepoRoot, ['rev-parse', '--verify', activity.activityHeadRef], opts),
  ]);
  const pending = deps.hasPendingMerge?.(input.executionRunId)
    ?? listActivityMergeAttempts(input.executionRunId).some((row) => row.state === 'pending' || row.state === 'conflicted');
  const liveLease = deps.hasLiveLease?.(activity.path)
    ?? getActiveAgents().some((agent) => keyPath(agent.workingDirectory) === keyPath(activity.path));
  const proofs: PlanningActivityCleanupProofs = {
    activityCompleted: input.activityCompleted,
    reachable: reachableResult.code === 0,
    worktreeClean: status.code === 0 && status.stdout.split(/\r?\n/).filter(Boolean)
      .every((line) => line.endsWith(PLANNING_WORKTREE_MARKER)),
    noLiveLease: !liveLease,
    noPendingMerge: !pending,
    fullyPromoted: Boolean(activity.promotedHeadOid) && activityHead.code === 0
      && reachableResult.code === 0,
    ownershipMarker: markerOwnedByRun(path.join(activity.path, PLANNING_WORKTREE_MARKER), input.executionRunId),
  };
  const failed = Object.entries(proofs).find(([, passed]) => !passed)?.[0];
  if (failed) {
    updateActivity({ executionRunId: input.executionRunId, state: 'recovery-required',
      failureCode: `cleanup-proof-failed:${failed}`, updatedAt: now() });
    return { ok: false, state: 'recovery-required', proofs, reason: `cleanup-proof-failed:${failed}` };
  }
  updateActivity({ executionRunId: input.executionRunId, state: 'cleanup-pending', failureCode: null, updatedAt: now() });
  const removed = await runGit(input.primaryRepoRoot, ['worktree', 'remove', activity.path], opts);
  if (removed.code !== 0) {
    updateActivity({ executionRunId: input.executionRunId, state: 'recovery-required',
      failureCode: 'worktree-remove-refused', updatedAt: now() });
    return { ok: false, state: 'recovery-required', proofs, reason: 'worktree-remove-refused' };
  }
  await runGit(input.primaryRepoRoot, ['worktree', 'prune'], opts);
  const deleted = await runGit(input.primaryRepoRoot,
    ['update-ref', '-d', activity.activityHeadRef, activityHead.stdout.trim()], opts);
  if (deleted.code !== 0) {
    updateActivity({ executionRunId: input.executionRunId, state: 'recovery-required',
      failureCode: 'activity-ref-delete-refused', updatedAt: now() });
    return { ok: false, state: 'recovery-required', proofs, reason: 'activity-ref-delete-refused' };
  }
  updateActivity({ executionRunId: input.executionRunId, state: 'cleaned', failureCode: null, updatedAt: now() });
  return { ok: true, state: 'cleaned', proofs };
}
