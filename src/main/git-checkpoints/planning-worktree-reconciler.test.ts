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
    runGit: async () => ({ code: 0, stdout: `${activity.baselineOid}\n`, stderr: '' }),
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
    updateActivity: (input) => {
      updates.push({ id: input.executionRunId, state: input.state, failure: input.failureCode });
      return { ...(input.executionRunId === missing.executionRunId ? missing : unowned),
        state: input.state ?? 'provisioning', failureCode: input.failureCode ?? null };
    },
  });
  assert.deepEqual(results.map((result) => result.failureCode), [
    'activity-path-missing', 'ownership-marker-invalid',
  ]);
  assert.equal(updates.every((update) => update.state === 'recovery-required'), true);
  assert.equal(fs.existsSync(unowned.path), true, 'WP-5 reconciliation never cleans worktrees');
});
