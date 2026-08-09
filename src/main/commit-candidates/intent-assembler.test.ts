import assert from 'node:assert/strict';

import type { DirtyEntry, DirtyInventory, ConflictComponent } from '../../shared/commit-candidates';
import type { SaveIntent } from '../database';
import { projectIntentUnits } from './intent-assembler';
import type { ComponentAssembly } from './component-assembler';
import type { ProjectedWitness } from './witness-projection';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

function entry(id: string): DirtyEntry {
  const path = { pathBytesBase64: Buffer.from(`${id}.ts`).toString('base64'), displayPath: `${id}.ts`, utf8Clean: true };
  return {
    entryId: id, path, originalPath: null, entryKind: 'ordinary', indexStatus: '.', worktreeStatus: 'M',
    headMode: '100644', indexMode: '100644', worktreeMode: '100644', submoduleState: null,
    renameOrCopyScore: null, expectedWorktreeState: 'present', rawWorktreeBlobOid: 'a'.repeat(40),
    gitLevelEligibility: 'supported', commitPathspecs: [path],
  };
}

const entries = ['a', 'b', 'shared', 'legacy', 'loose'].map(entry);
const inventory: DirtyInventory = {
  repository: {
    repositoryKey: 'repo', objectDatabaseKey: 'private', gitObjectFormat: 'sha1', bareRepo: false,
    workspaces: [{ workspaceId: 'ws', workspacePrefix: '' }],
  },
  entries, unattributedEntryIds: ['loose'], topologyDigest: 'digest-1',
};

function component(id: string, entryIds: string[]): ConflictComponent {
  return {
    componentId: id, dirtyEntryIds: entryIds, associations: [], componentTopologyDigest: `${id}-digest`,
    overlap: { componentId: id, contributingAgentCount: 1, mergedGroupCount: 1, perPathContributors: {} },
  };
}
const components = [component('ca', ['a']), component('cb', ['b']), component('cs', ['shared', 'legacy'])];
const topology = { components } as ComponentAssembly;

function intent(id: string, kind: SaveIntent['kind'] = 'task'): SaveIntent {
  return {
    id, workspaceId: 'ws', executionRunId: null, repositoryKey: 'repo', kind,
    planId: 'plan', planItemId: 'item', title: id, briefDigest: null,
    dispatchAttemptId: kind === 'task' ? `dispatch-${id}` : null,
    createdBy: kind === 'task' ? 'task-dispatch' : 'human-save-card', createdById: null,
    state: 'open', revision: 1, createdAt: 1, readyAt: null, committedAt: null,
  };
}

function witness(entryId: string, intentId: string | null, turnId = `${entryId}-${intentId}`): ProjectedWitness {
  return {
    entryId, workspaceId: 'ws', turnId, agentId: 'agent', ownerAgentId: null,
    ownerBrickGeneration: null, planId: intentId ? 'plan' : null,
    planItemId: intentId ? 'item' : null, intentId, planAttributionAvailable: intentId !== null,
  };
}

const witnesses = [
  witness('a', 'intent-one', 'turn-a'), witness('b', 'intent-one', 'turn-b'),
  witness('shared', 'intent-two', 'turn-two'), witness('shared', 'intent-three', 'turn-three'),
  witness('legacy', null, 'turn-legacy'),
];

function project() {
  return projectIntentUnits({
    inventory, topology, witnesses,
    intents: [intent('intent-one'), intent('intent-two'), intent('intent-three'), intent('manual', 'named-save-set')],
    namedMembers: [{
      intentId: 'manual', entryId: 'loose',
      pathBytesBase64: entries.find((item) => item.entryId === 'loose')!.path.pathBytesBase64,
      inventoryDigest: 'digest-1',
    }],
  });
}

test('one intent spanning disconnected topology components remains one task unit', () => {
  const unit = project().intentUnits.find((candidate) => candidate.intent.id === 'intent-one')!;
  assert.deepEqual(unit.memberEntryIds, ['a', 'b']);
  assert.deepEqual(unit.topologyComponentIds, ['ca', 'cb']);
});

test('one topology component carrying two intents projects two task cards', () => {
  const projected = project().intentUnits.filter((unit) => unit.memberEntryIds.includes('shared'));
  assert.deepEqual(projected.map((unit) => unit.intent.id), ['intent-three', 'intent-two']);
  assert.ok(projected.every((unit) => unit.topologyComponentIds[0] === 'cs'));
});

test('separates truly unwitnessed work from honest legacy identity-unavailable work', () => {
  const result = projectIntentUnits({
    inventory, topology, witnesses,
    intents: [intent('intent-one'), intent('intent-two'), intent('intent-three')],
    namedMembers: [],
  });
  assert.deepEqual(result.unwitnessedEntryIds, ['loose']);
  assert.deepEqual(result.legacyTaskIdentityUnavailableEntryIds, ['legacy']);
});

test('named membership is byte addressed and becomes stale on inventory digest change', () => {
  const valid = project();
  assert.deepEqual(valid.intentUnits.find((unit) => unit.intent.id === 'manual')!.memberEntryIds, ['loose']);
  assert.deepEqual(valid.unwitnessedEntryIds, [], 'valid named membership removes the entry from Unwitnessed');
  const stale = projectIntentUnits({
    inventory: { ...inventory, topologyDigest: 'digest-2' }, topology, witnesses, intents: [intent('manual', 'named-save-set')],
    namedMembers: [{ intentId: 'manual', entryId: 'loose', pathBytesBase64: entries[4].path.pathBytesBase64, inventoryDigest: 'digest-1' }],
  });
  assert.equal(stale.intentUnits[0].intent.id, 'manual');
  assert.deepEqual(stale.intentUnits[0].memberEntryIds, []);
  assert.deepEqual(stale.staleNamedSaveSetIds, ['manual']);
});

let passed = 0;
let failed = 0;
for (const current of tests) {
  try { current.run(); console.log(`  ok  ${current.name}`); passed += 1; }
  catch (error) { console.error(`  FAIL ${current.name}`, error); failed += 1; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
