import assert from 'node:assert/strict';

import type { ConflictComponent, DirtyEntry, DirtyInventory, RepositoryIdentity } from '../../shared/commit-candidates';
import type { PackageFinalization } from '../database';
import { resolvePinnedSelectionDrift, selectionDriftBlocks } from './pinned-selection-drift';

const repository: RepositoryIdentity = {
  repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1', bareRepo: false,
  workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
};
function entry(id: string, rawBlobOid = `raw-${id}`): DirtyEntry {
  const displayPath = `.lares/proposals/${id}.md`;
  return {
    entryId: id,
    path: { pathBytesBase64: Buffer.from(displayPath).toString('base64'), displayPath, utf8Clean: true },
    originalPath: null, entryKind: 'ordinary', indexStatus: '?', worktreeStatus: '?',
    headMode: null, indexMode: null, worktreeMode: null, submoduleState: null,
    renameOrCopyScore: null, expectedWorktreeState: 'present', rawWorktreeBlobOid: rawBlobOid,
    gitLevelEligibility: 'supported', commitPathspecs: [],
  };
}
function inventory(entries: DirtyEntry[], unattributedEntryIds: string[]): DirtyInventory {
  return { repository, entries, unattributedEntryIds, topologyDigest: 'topology' };
}
function finalization(...members: DirtyEntry[]): PackageFinalization {
  return {
    id: 'fin-1', packageId: 'unattributed:repo-1', repositoryKey: 'repo-1',
    finalizationKind: 'fleet-adhoc', planId: null, planItemId: null, packageRevision: 1,
    finalizedAt: 1, finalizedBy: 'human-ipc', checkpointTurnId: null, checkpointOid: 'boundary',
    boundaryRef: 'refs/lares/fin-1', boundaryStatus: 'ready', lifecycleStatus: 'active',
    supersededByFinalizationId: null, releasedAt: null,
    memberManifestJson: JSON.stringify(members.map((member) => ({
      pathBytesBase64: member.path.pathBytesBase64, expectedState: 'present',
      rawBlobOid: member.rawWorktreeBlobOid, commitBlobOid: `commit-${member.entryId}`, commitMode: '100644',
    }))),
    contractVersion: 1, failureReason: null, createdFromWorkspaceId: 'ws-1',
  };
}
const none: ConflictComponent[] = [];
const pinned = [entry('one'), entry('two')];

const added = entry('three');
const benign = resolvePinnedSelectionDrift({
  repositoryKey: 'repo-1', inventory: inventory([...pinned, added], ['one', 'two', 'three']),
  components: none, finalizations: [finalization(...pinned)], requestedComponentIds: [],
  requestedUnattributedEntryIds: ['one', 'two', 'three'],
});
assert.deepEqual(benign.drift, {
  added: [added.path.pathBytesBase64], missing: [], reAttributed: [], byteMoved: [],
});
assert.deepEqual(benign.pinnedSelection.selectedUnattributedEntryIds, ['one', 'two']);
assert.equal(selectionDriftBlocks(benign.drift), false);

const edited = resolvePinnedSelectionDrift({
  repositoryKey: 'repo-1', inventory: inventory([entry('one', 'changed'), pinned[1]], ['one', 'two']),
  components: none, finalizations: [finalization(...pinned)], requestedComponentIds: [],
  requestedUnattributedEntryIds: ['one', 'two'],
});
assert.deepEqual(edited.drift.byteMoved, [pinned[0].path.pathBytesBase64]);
assert.deepEqual(edited.drift.missing, []);
assert.equal(selectionDriftBlocks(edited.drift), true);

const missing = resolvePinnedSelectionDrift({
  repositoryKey: 'repo-1', inventory: inventory([pinned[1]], ['two']), components: none,
  finalizations: [finalization(...pinned)], requestedComponentIds: [], requestedUnattributedEntryIds: ['one', 'two'],
});
assert.deepEqual(missing.drift.missing, [pinned[0].path.pathBytesBase64]);

const attributedComponent: ConflictComponent = {
  componentId: 'component-1', dirtyEntryIds: ['one'], associations: [],
  overlap: { componentId: 'component-1', contributingAgentCount: 1, mergedGroupCount: 1, perPathContributors: {} },
  componentTopologyDigest: 'component-topology',
};
const reAttributed = resolvePinnedSelectionDrift({
  repositoryKey: 'repo-1', inventory: inventory(pinned, ['two']), components: [attributedComponent],
  finalizations: [finalization(...pinned)], requestedComponentIds: [], requestedUnattributedEntryIds: ['one', 'two'],
});
assert.deepEqual(reAttributed.drift.reAttributed, [pinned[0].path.pathBytesBase64]);

console.log('All pinned-selection drift tests passed');
