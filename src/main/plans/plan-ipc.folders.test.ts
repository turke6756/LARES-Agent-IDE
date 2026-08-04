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
  const result = listPromotedPlanFolders('ws-1', root, 'windows', (_workspaceId, artifactId) => `db:${artifactId}`);
  assert.equal(result.plans.length, 2);
  assert.deepEqual(result.plans[0], {
    planArtifactId: 'plan_active', planId: 'db:plan_active', folderName: 'active', title: 'Active title',
    status: 'ready', archived: false, updatedAt: 20,
    responsibleSupervisor: { display: 'Latest owner', agentId: 'latest', source: 'promotion-service' },
  });
  assert.equal(result.plans[1].archived, true);
  console.log('  ok  maps plan-folder metadata and last assigned supervisor');
} finally {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('refusing to remove non-temp fixture');
  fs.rmSync(resolved, { recursive: true, force: true });
}
