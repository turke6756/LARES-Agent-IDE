// SC-WP-W2a — preload/source contract smoke test.
//
// The renderer TypeScript surface and the actual contextBridge object are authored
// separately, so this small source assertion prevents a typed method from existing
// without a matching ipcRenderer binding (the original fleet-finalize gap).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const preload = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');
const saveCard = fs.readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'save', 'SaveCard.tsx'),
  'utf8',
);
const plan = fs.readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'plan', 'PlanSurfaceView.tsx'),
  'utf8',
);
const missionBoard = fs.readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'plan', 'MissionBoard.tsx'),
  'utf8',
);
const candidateSubmit = fs.readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'save', 'candidate-submit.ts'),
  'utf8',
);

for (const binding of [
  'getInventory: (req) => ipcRenderer.invoke(SAVECARD_CHANNELS.getInventory, req)',
  'preview: (req) => ipcRenderer.invoke(SAVECARD_PREVIEW_CHANNEL, req)',
  'markDone: (req) => ipcRenderer.invoke(SAVECARD_FINALIZE_CHANNEL, req)',
  'mint: (req) => ipcRenderer.invoke(COMMIT_CANDIDATE_MINT_CHANNEL, req)',
  'commit: (req) => ipcRenderer.invoke(COMMIT_COORDINATOR_CHANNEL, req)',
]) {
  assert.ok(preload.includes(binding), `preload is missing binding: ${binding}`);
}

assert.ok(saveCard.includes('window.api.saveCard.getInventory('));
for (const surface of [saveCard, plan, missionBoard]) {
  assert.ok(surface.includes('createCandidateSubmitter'));
  assert.equal(surface.includes('window.api.commitCoordinator.commit('), false);
  assert.equal(surface.includes('window.api.commitCoordinator.mint('), false);
}
assert.ok(candidateSubmit.includes('window.api.saveCard.preview('));
assert.ok(candidateSubmit.includes('window.api.commitCoordinator.mint('));
assert.ok(candidateSubmit.includes('window.api.commitCoordinator.commit('));

console.log('  ✓ preload bindings match the one shared Save/Plan transaction helper');
