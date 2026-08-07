import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPromotedPlanFolders } from './plan-ipc';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-plan-folders-'));
try {
  const plansRoot = path.join(root, '.lares', 'plans');
  fs.mkdirSync(path.join(plansRoot, 'active'), { recursive: true });
  fs.mkdirSync(path.join(plansRoot, 'archived'), { recursive: true });
  fs.writeFileSync(path.join(plansRoot, 'active', 'plan.json'), JSON.stringify({
    plan_artifact_id: 'plan_active', title: 'Active title', status: 'ready', updated_at: 20,
    responsibility_events: [
      { event: 'assigned', agent_id: 'old', display: 'Old owner', source: 'manual-skill' },
      { event: 'assigned', agent_id: 'latest', display: 'Latest owner', source: 'promotion-service' },
    ],
  }));
  fs.writeFileSync(path.join(plansRoot, 'archived', 'plan.json'), JSON.stringify({
    plan_artifact_id: 'plan_archived', plan_sku: 'Archived title', status: 'archived', updated_at: 10,
  }));
  resetWorkspaceStateDirCacheForTests();
  const result = listPromotedPlanFolders(
    'ws-1',
    root,
    'windows',
    (_workspaceId, artifactId) => artifactId === 'plan_active' ? 'db:plan_active' : null,
    {
      getPlan: (planId) => planId === 'db:plan_active' ? { runState: 'executing' } as any : null,
      listPackages: (planId) => planId === 'db:plan_active' ? [
        { id: 'done', workspaceId: 'ws-1', planId, state: 'done' },
        { id: 'blocked', workspaceId: 'ws-1', planId, state: 'blocked' },
        { id: 'archived', workspaceId: 'ws-1', planId, state: 'archived' },
      ] as any : [],
      listTurns: () => [],
    },
  );
  assert.equal(result.plans.length, 2);
  assert.deepEqual(result.plans[0], {
    planArtifactId: 'plan_active', planId: 'db:plan_active', folderName: 'active', title: 'Active title',
    status: 'ready', archived: false, updatedAt: 20,
    responsibleSupervisor: { display: 'Latest owner', agentId: 'latest', source: 'promotion-service' },
    lifecycle: 'executing',
    rollup: { total: 3, landed: 1, remaining: 1, archived: 1, completed: false },
    activeVerifiedTurnCount: 0,
  });
  assert.deepEqual(result.plans[1], {
    planArtifactId: 'plan_archived', planId: 'plan_archived', folderName: 'archived', title: 'Archived title',
    status: 'archived', archived: true, updatedAt: 10, responsibleSupervisor: null,
    lifecycle: 'unknown', rollup: null, activeVerifiedTurnCount: 0,
  });
  console.log('  ok  maps plan-folder metadata and last assigned supervisor');
} finally {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('refusing to remove non-temp fixture');
  fs.rmSync(resolved, { recursive: true, force: true });
}
