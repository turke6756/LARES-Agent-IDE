import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { PlanningActivityWorktree } from '../database';
import { PLANNING_WORKTREE_MARKER } from './planning-worktree-service';
import { reconcilePlanningActivityWorktrees } from './planning-worktree-reconciler';

function row(root: string, id: string): PlanningActivityWorktree {
  return {
    executionRunId: id, planId: 'plan', logicalWorkspaceId: 'ws',
    objectDatabaseKey: 'objects', activityRepositoryKey: 'activity',
    primaryRepositoryKey: 'primary', path: path.join(root, id),
    baselineOid: 'a'.repeat(40), activityHeadRef: `refs/lares/activities/${id}/head`,
    promotedHeadOid: null, state: 'provisioning', failureCode: null,
    createdAt: 1, updatedAt: 1,
  };
}

test('startup reconciler finishes an intact provisioning activity through recovery seam', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activity = row(root, 'run-good');
  fs.mkdirSync(activity.path, { recursive: true });
  fs.writeFileSync(path.join(activity.path, PLANNING_WORKTREE_MARKER), JSON.stringify({
    owner: 'lares', version: 1, executionRunId: activity.executionRunId,
  }));
  let finishCalls = 0;
  const results = await reconcilePlanningActivityWorktrees({
    listProvisioning: () => [activity], resolvePrimaryPath: () => root,
    runGit: async (_cwd, args) => ({ code: 0,
      stdout: args[0] === 'status' ? '' : `${activity.baselineOid}\n`, stderr: '' }),
    updateActivity: () => { throw new Error('must not quarantine'); },
    finishActivation: async () => { finishCalls += 1; return true; },
  });
  assert.equal(finishCalls, 1);
  assert.deepEqual(results, [{ executionRunId: 'run-good', disposition: 'finished', failureCode: null }]);
});

test('startup reconciler quarantines missing/unowned artifacts without cleanup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = row(root, 'run-missing');
  const unowned = row(root, 'run-unowned');
  fs.mkdirSync(unowned.path, { recursive: true });
  const updates: Array<{ id: string; state?: string; failure?: string | null }> = [];
  const results = await reconcilePlanningActivityWorktrees({
    listProvisioning: () => [missing, unowned], resolvePrimaryPath: () => root,
    runGit: async (_cwd, args) => ({
      code: args.includes(unowned.activityHeadRef) ? 0 : 1,
      stdout: args.includes(unowned.activityHeadRef) ? `${unowned.baselineOid}\n` : '', stderr: '',
    }),
    updateActivity: (input) => {
      updates.push({ id: input.executionRunId, state: input.state, failure: input.failureCode });
      return { ...(input.executionRunId === missing.executionRunId ? missing : unowned),
        state: input.state ?? 'provisioning', failureCode: input.failureCode ?? null };
    },
  });
  assert.deepEqual(results.map((result) => result.failureCode), [
    'activity-path-and-ref-missing', 'ownership-marker-invalid',
  ]);
  assert.equal(updates.every((update) => update.state === 'recovery-required'), true);
  assert.equal(fs.existsSync(unowned.path), true, 'WP-5 reconciliation never cleans worktrees');
});

test('design 5.4 recovery matrix covers orphan removal, recreation, merge restore, uncertain CAS, cleanup retry, and missing ref', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp6-matrix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mk = (id: string, state: PlanningActivityWorktree['state']) => ({ ...row(root, id), state });
  const baselineOrphan = mk('baseline-orphan', 'provisioning');
  const activeMissing = mk('active-missing', 'active');
  const mergePending = mk('merge-pending', 'merge-pending');
  const mergeConflicted = mk('merge-conflicted', 'merge-conflicted');
  const uncertain = mk('uncertain', 'merge-pending');
  const cleanupPending = { ...mk('cleanup', 'cleanup-pending'), promotedHeadOid: 'c'.repeat(40) };
  const missingRef = mk('missing-ref', 'active');
  for (const activity of [baselineOrphan, mergePending, mergeConflicted, uncertain, cleanupPending, missingRef]) {
    fs.mkdirSync(activity.path, { recursive: true });
    fs.writeFileSync(path.join(activity.path, PLANNING_WORKTREE_MARKER), JSON.stringify({
      owner: 'lares', version: 1, executionRunId: activity.executionRunId,
    }));
  }
  const commands: string[][] = [];
  const updates: Array<{ id: string; state?: string; promoted?: string | null }> = [];
  let cleanupCalls = 0;
  const proposed = 'd'.repeat(40);
  const results = await reconcilePlanningActivityWorktrees({
    listActivities: () => [baselineOrphan, activeMissing, mergePending, mergeConflicted, uncertain, cleanupPending, missingRef],
    resolvePrimaryPath: () => root,
    hasExecutionRun: (id) => id !== baselineOrphan.executionRunId,
    isActivityCompleted: (id) => id === cleanupPending.executionRunId,
    listMergeAttempts: (id) => id === uncertain.executionRunId ? [{
      id: 'attempt-uncertain', executionRunId: id, baseOid: uncertain.baselineOid,
      primaryHeadOid: uncertain.baselineOid, activityHeadOid: uncertain.baselineOid,
      proposedCommitOid: proposed, state: 'pending', startedAt: 1, endedAt: null,
    }] : [],
    updateMergeAttempt: (input) => ({
      id: input.id, executionRunId: uncertain.executionRunId, baseOid: uncertain.baselineOid,
      primaryHeadOid: uncertain.baselineOid, activityHeadOid: uncertain.baselineOid,
      proposedCommitOid: proposed, state: input.state ?? 'pending', startedAt: 1,
      endedAt: input.endedAt ?? null,
    }),
    updateActivity: (input) => {
      updates.push({ id: input.executionRunId, state: input.state, promoted: input.promotedHeadOid });
      const current = [baselineOrphan, activeMissing, mergePending, mergeConflicted, uncertain, cleanupPending, missingRef]
        .find((activity) => activity.executionRunId === input.executionRunId)!;
      Object.assign(current, input); return current;
    },
    cleanup: async () => {
      cleanupCalls += 1;
      return { ok: true, state: 'cleaned', proofs: {
        activityCompleted: true, reachable: true, worktreeClean: true, noLiveLease: true,
        noPendingMerge: true, fullyPromoted: true, ownershipMarker: true,
      } };
    },
    runGit: async (cwd, args) => {
      commands.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(activeMissing.path, { recursive: true });
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args.includes(missingRef.activityHeadRef)) return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args.includes('HEAD') && cwd === root) return { code: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
      if (args[0] === 'reflog') return { code: 0, stdout: `${proposed} lares-activity-merge:attempt-uncertain\n`, stderr: '' };
      return { code: 0, stdout: `${baselineOrphan.baselineOid}\n`, stderr: '' };
    },
  });
  const byId = new Map(results.map((result) => [result.executionRunId, result.disposition]));
  assert.equal(byId.get('baseline-orphan'), 'removed');
  assert.equal(byId.get('active-missing'), 'recreated');
  assert.equal(byId.get('merge-pending'), 'restored');
  assert.equal(byId.get('merge-conflicted'), 'restored');
  assert.equal(byId.get('uncertain'), 'restored');
  assert.equal(byId.get('cleanup'), 'retried');
  assert.equal(byId.get('missing-ref'), 'recreated');
  assert.equal(cleanupCalls, 1);
  assert.ok(commands.some((args) => args[0] === 'worktree' && args[1] === 'remove' && !args.includes('--force')));
  assert.ok(commands.some((args) => args[0] === 'worktree' && args[1] === 'add'));
  assert.ok(commands.some((args) => args[0] === 'update-ref' && args.includes(missingRef.activityHeadRef)));
  assert.ok(updates.some((update) => update.id === uncertain.executionRunId && update.promoted === proposed));
});
