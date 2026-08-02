// SC-WP-2I — immutable stamp projection acceptance tests.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/stamp-projection.test.js

import assert from 'node:assert/strict';

import type { DirtyEntry, EncodedGitPath, RepositoryIdentity } from '../../shared/commit-candidates';
import type { TurnWitnessRead } from '../database';
import { assembleConflictComponents } from './component-assembler';
import type { DirtyInventoryDraft } from './dirty-inventory';
import { createTurnStampSource, type TurnStampRecord } from './stamp-projection';
import { projectWitnesses } from './witness-projection';

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

function turn(turnId: string, agentId: string, ...entryIds: string[]): TurnWitnessRead {
  return {
    turnId,
    agentId,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    touched: entryIds.map((entryId) => ({ path: `${entryId}.ts`, op: 'write' })),
  };
}

function row(
  id: string,
  planId: string | null,
  planStampSource: TurnStampRecord['planStampSource'],
): TurnStampRecord {
  return {
    id,
    workspaceId: 'workspace',
    planId,
    planItemId: null,
    planStampSource,
  };
}

function project(
  entries: readonly DirtyEntry[],
  turns: readonly TurnWitnessRead[],
  rows: readonly TurnStampRecord[],
) {
  const byId = new Map(rows.map((record) => [record.id, record]));
  return projectWitnesses(
    repository,
    entries,
    () => turns,
    createTurnStampSource((turnId) => byId.get(turnId) ?? null),
  );
}

test('newly stamped immutable turn rows project plan attribution', () => {
  const witnesses = project(
    [entry('A')],
    [turn('turn-a', 'agent-a', 'A')],
    [row('turn-a', 'plan-a', 'agent-default')],
  );

  assert.equal(witnesses.length, 1);
  assert.equal(witnesses[0].planId, 'plan-a');
  assert.equal(witnesses[0].planItemId, null);
  assert.equal(witnesses[0].planAttributionAvailable, true);
});

test('legacy, unavailable, and mismatched turn rows stay null-attributed', () => {
  const turns = [
    turn('legacy', 'agent-legacy', 'A'),
    turn('missing', 'agent-missing', 'B'),
    turn('wrong-workspace', 'agent-wrong', 'C'),
  ];
  const rows: TurnStampRecord[] = [
    row('legacy', 'must-not-backfill', 'legacy-unstamped'),
    { ...row('wrong-workspace', 'must-not-cross', 'explicit'), workspaceId: 'other' },
  ];
  const witnesses = project([entry('A'), entry('B'), entry('C')], turns, rows);

  assert.deepEqual(
    witnesses.map(({ entryId, planId, planItemId, planAttributionAvailable }) => ({
      entryId, planId, planItemId, planAttributionAvailable,
    })),
    [
      { entryId: 'A', planId: null, planItemId: null, planAttributionAvailable: false },
      { entryId: 'B', planId: null, planItemId: null, planAttributionAvailable: false },
      { entryId: 'C', planId: null, planItemId: null, planAttributionAvailable: false },
    ],
  );
});

test('mixed-plan transitive component remains one component when stamps are present', () => {
  const entries = [entry('A'), entry('B'), entry('C')];
  const turns = [
    turn('turn-ab', 'agent-a', 'A', 'B'),
    turn('turn-bc', 'agent-b', 'B', 'C'),
  ];
  const unstamped = projectWitnesses(repository, entries, () => turns, null);
  const stamped = project(entries, turns, [
    row('turn-ab', 'plan-a', 'explicit'),
    row('turn-bc', 'plan-b', 'fork-carry'),
  ]);
  const draft: DirtyInventoryDraft = { repository, entries };
  const before = assembleConflictComponents(draft, unstamped);
  const after = assembleConflictComponents(draft, stamped);

  assert.equal(before.components.length, 1);
  assert.equal(after.components.length, 1);
  assert.deepEqual(after.components[0].dirtyEntryIds, before.components[0].dirtyEntryIds);
  assert.deepEqual(after.components[0].associations.map((association) => association.planId), [
    'plan-a',
    'plan-b',
  ]);
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
  console.error(`\n${failures}/${tests.length} stamp-projection tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} stamp-projection tests passed`);
}
