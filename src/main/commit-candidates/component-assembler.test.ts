// SC-WP-1D — connected-component/topology assembler acceptance tests.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/component-assembler.test.js

import assert from 'node:assert/strict';

import type { DirtyEntry, EncodedGitPath, RepositoryIdentity } from '../../shared/commit-candidates';
import { assembleConflictComponents } from './component-assembler';
import type { DirtyInventoryDraft } from './dirty-inventory';
import type { ProjectedWitness } from './witness-projection';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const repository: RepositoryIdentity = {
  repositoryKey: 'repository-key',
  objectDatabaseKey: 'object-database-key',
  gitObjectFormat: 'sha1',
  bareRepo: false,
  workspaces: [{ workspaceId: 'workspace', workspacePrefix: '' }],
};

function path(value: string): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from(value).toString('base64'),
    displayPath: value,
    utf8Clean: true,
  };
}

function entry(entryId: string): DirtyEntry {
  const encoded = path(`${entryId}.ts`);
  return {
    entryId,
    path: encoded,
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: 'a'.repeat(40),
    gitLevelEligibility: 'supported',
    commitPathspecs: [encoded],
  };
}

function draft(...entryIds: string[]): DirtyInventoryDraft {
  return { repository, entries: entryIds.map(entry) };
}

function witness(
  entryId: string,
  turnId: string,
  agentId: string | null,
  planId: string | null = null,
  planItemId: string | null = null,
  ownerAgentId: string | null = null,
): ProjectedWitness {
  return {
    entryId,
    workspaceId: 'workspace',
    turnId,
    agentId,
    ownerAgentId,
    ownerBrickGeneration: null,
    planId,
    planItemId,
    planAttributionAvailable: planId !== null || planItemId !== null,
  };
}

function componentContaining(
  result: ReturnType<typeof assembleConflictComponents>,
  entryId: string,
) {
  const component = result.components.find((candidate) => candidate.dirtyEntryIds.includes(entryId));
  assert.ok(component, `missing component for ${entryId}`);
  return component;
}

test('transitively fuses A-B and B-C witness links into one component', () => {
  const result = assembleConflictComponents(
    draft('A', 'B', 'C'),
    [
      witness('A', 'turn-ab', 'agent-a'),
      witness('B', 'turn-ab', 'agent-b'),
      witness('B', 'turn-bc', 'agent-b'),
      witness('C', 'turn-bc', 'agent-c'),
    ],
  );

  assert.equal(result.components.length, 1);
  assert.deepEqual(result.components[0].dirtyEntryIds, ['A', 'B', 'C']);
  assert.equal(result.components[0].overlap.contributingAgentCount, 3);
  assert.equal(result.components[0].overlap.requiresOverlapAck, true);
  assert.deepEqual(result.components[0].associations, [{
    planId: null,
    planItemId: null,
    contributingTurnIds: ['turn-ab', 'turn-bc'],
    memberEntryIds: ['A', 'B', 'C'],
  }]);
});

test('always emits unattributedEntryIds and never groups unwitnessed entries', () => {
  const sharedPath = path('shared.ts');
  const none = assembleConflictComponents({
    repository,
    entries: [
      { ...entry('A'), path: sharedPath, commitPathspecs: [sharedPath] },
      { ...entry('B'), path: sharedPath, commitPathspecs: [sharedPath] },
    ],
  }, []);
  assert.deepEqual(none.inventory.unattributedEntryIds, ['A', 'B']);
  assert.deepEqual(none.components, []);

  const empty = assembleConflictComponents(
    draft('A', 'B'),
    [witness('A', 'turn-a', 'agent-a'), witness('B', 'turn-b', 'agent-a')],
  );
  assert.deepEqual(empty.inventory.unattributedEntryIds, []);
  assert.equal(empty.components.length, 1);
});

test('is permutation-invariant for entries, witnesses, topology, and output shapes', () => {
  const entries = draft('A', 'B', 'C');
  const witnesses = [
    witness('A', 'turn-a', 'agent-a', 'plan-1', 'item-1'),
    witness('B', 'turn-a', 'agent-a', 'plan-1', 'item-1'),
    witness('B', 'turn-b', 'agent-b', 'plan-2', 'item-2'),
    witness('C', 'turn-c', 'agent-c', 'plan-3', 'item-3'),
  ];
  const forward = assembleConflictComponents(entries, witnesses);
  const reverse = assembleConflictComponents(
    { repository, entries: [...entries.entries].reverse() },
    [...witnesses].reverse(),
  );

  assert.deepEqual(reverse, forward);
});

test('changes topology digests when a new shared-path connection fuses components', () => {
  const inventory = draft('A', 'B');
  const separate = assembleConflictComponents(
    inventory,
    [witness('A', 'turn-a', 'agent-a'), witness('B', 'turn-b', 'agent-b')],
  );
  const connected = assembleConflictComponents(
    inventory,
    [
      witness('A', 'turn-a', 'agent-a'),
      witness('B', 'turn-b', 'agent-b'),
      witness('A', 'turn-bridge', 'agent-a'),
      witness('B', 'turn-bridge', 'agent-b'),
    ],
  );

  assert.equal(separate.components.length, 2);
  assert.equal(connected.components.length, 1);
  assert.notEqual(connected.inventory.topologyDigest, separate.inventory.topologyDigest);
  assert.notEqual(
    connected.components[0].componentTopologyDigest,
    componentContaining(separate, 'A').componentTopologyDigest,
  );
});

test('keeps a component digest inert when only another component changes', () => {
  const inventory = draft('A', 'B', 'C');
  const before = assembleConflictComponents(
    inventory,
    [
      witness('A', 'turn-a', 'agent-a'),
      witness('B', 'turn-b', 'agent-b'),
      witness('C', 'turn-c', 'agent-c'),
    ],
  );
  const after = assembleConflictComponents(
    inventory,
    [
      witness('A', 'turn-a', 'agent-a'),
      witness('B', 'turn-b', 'agent-b'),
      witness('C', 'turn-c', 'agent-c'),
      witness('B', 'turn-bc', 'agent-b'),
      witness('C', 'turn-bc', 'agent-c'),
    ],
  );

  assert.equal(
    componentContaining(after, 'A').componentTopologyDigest,
    componentContaining(before, 'A').componentTopologyDigest,
  );
  assert.notEqual(after.inventory.topologyDigest, before.inventory.topologyDigest);
});

test('distinguishes equal aggregate participants with different per-path structure', () => {
  const inventory = draft('A', 'B');
  const crossed = assembleConflictComponents(
    inventory,
    [
      witness('A', 'turn-1', 'agent-1'),
      witness('B', 'turn-2', 'agent-2'),
      witness('A', 'turn-bridge', 'agent-2'),
    ],
  );
  const mirrored = assembleConflictComponents(
    inventory,
    [
      witness('A', 'turn-2', 'agent-2'),
      witness('B', 'turn-1', 'agent-1'),
      witness('B', 'turn-bridge', 'agent-2'),
    ],
  );

  assert.deepEqual(
    new Set(crossed.components[0].overlap.perPathContributors.A.agentIds),
    new Set(mirrored.components[0].overlap.perPathContributors.B.agentIds),
  );
  assert.notEqual(
    crossed.components[0].componentTopologyDigest,
    mirrored.components[0].componentTopologyDigest,
  );
  assert.notEqual(crossed.inventory.topologyDigest, mirrored.inventory.topologyDigest);
});

test('emits exact stamped associations and owner-plan overlap groups', () => {
  const result = assembleConflictComponents(
    draft('A', 'B'),
    [
      witness('A', 'turn-1', 'agent-1', 'plan-1', 'item-1'),
      witness('B', 'turn-2', 'agent-1', 'plan-2', 'item-2'),
    ],
  );
  const component = result.components[0];

  assert.deepEqual(component.associations, [
    {
      planId: 'plan-1',
      planItemId: 'item-1',
      contributingTurnIds: ['turn-1'],
      memberEntryIds: ['A'],
    },
    {
      planId: 'plan-2',
      planItemId: 'item-2',
      contributingTurnIds: ['turn-2'],
      memberEntryIds: ['B'],
    },
  ]);
  assert.equal(component.overlap.mergedGroupCount, 2);
  assert.equal(component.overlap.requiresOverlapAck, true);
});

test('binds owner identity into topology digests and the overlap challenge', () => {
  const inventory = draft('A', 'B');
  const sharedOwner = assembleConflictComponents(inventory, [
    witness('A', 'turn-1', 'agent-1', 'plan-1', 'item-1', 'owner-1'),
    witness('B', 'turn-2', 'agent-1', 'plan-1', 'item-1', 'owner-1'),
  ]);
  const splitOwners = assembleConflictComponents(inventory, [
    witness('A', 'turn-1', 'agent-1', 'plan-1', 'item-1', 'owner-1'),
    witness('B', 'turn-2', 'agent-1', 'plan-1', 'item-1', 'owner-2'),
  ]);

  assert.equal(sharedOwner.components[0].overlap.requiresOverlapAck, false);
  assert.equal(splitOwners.components[0].overlap.requiresOverlapAck, true);
  assert.notEqual(
    sharedOwner.components[0].componentTopologyDigest,
    splitOwners.components[0].componentTopologyDigest,
  );
  assert.notEqual(sharedOwner.inventory.topologyDigest, splitOwners.inventory.topologyDigest);
  assert.equal(sharedOwner.selectedTopology.requiresOverlapAck, false);
  assert.deepEqual(sharedOwner.overlapChallengeAtoms, []);
  assert.equal(splitOwners.selectedTopology.requiresOverlapAck, true);
  assert.equal(splitOwners.ownershipGroupKeys.length, 2);
  assert.equal(splitOwners.overlapChallengeAtoms.length, 1);
  const [overlapAtom] = splitOwners.overlapChallengeAtoms;
  assert.equal(overlapAtom.kind, 'overlap');
  if (overlapAtom.kind !== 'overlap') throw new Error('expected overlap challenge atom');
  assert.deepEqual(
    overlapAtom.ownershipGroupKeys,
    splitOwners.ownershipGroupKeys,
  );
  assert.deepEqual(
    overlapAtom.contributors,
    splitOwners.selectedTopology.contributors,
  );
});

let failures = 0;
for (const current of tests) {
  try {
    current.run();
    console.log(`PASS ${current.name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${current.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${tests.length} component-assembler tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} component-assembler tests passed`);
}
