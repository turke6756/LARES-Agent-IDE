// SC-WP-1W — witness projection acceptance tests.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/witness-projection.test.js

import assert from 'node:assert/strict';

import type { DirtyEntry, EncodedGitPath, RepositoryIdentity } from '../../shared/commit-candidates';
import type { TurnWitnessRead } from '../database';
import { projectWitnesses, type TurnWitnessReader } from './witness-projection';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function encodedPath(bytes: Buffer, utf8Clean = true, displayPath?: string): EncodedGitPath {
  return {
    pathBytesBase64: bytes.toString('base64'),
    displayPath: displayPath ?? bytes.toString('utf8'),
    utf8Clean,
  };
}

function dirtyEntry(entryId: string, path: EncodedGitPath): DirtyEntry {
  return {
    entryId,
    path,
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
    gitLevelEligibility: path.utf8Clean ? 'supported' : 'unsupported-git-state',
    commitPathspecs: [path],
  };
}

function turn(turnId: string, agentId: string, ...paths: string[]): TurnWitnessRead {
  return {
    turnId,
    agentId,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    touched: paths.map((path) => ({ path, op: 'write' })),
  };
}

function fixtureReader(rows: Record<string, TurnWitnessRead[]>): TurnWitnessReader {
  return (workspaceId) => rows[workspaceId] ?? [];
}

const repository: RepositoryIdentity = {
  repositoryKey: 'repository-key',
  objectDatabaseKey: 'object-database-key',
  gitObjectFormat: 'sha1',
  bareRepo: false,
  workspaces: [
    { workspaceId: 'ws-app', workspacePrefix: 'packages/app' },
    { workspaceId: 'ws-lib', workspacePrefix: 'packages/lib' },
  ],
};

test('prepends each workspace prefix before matching two workspaces in one repository', () => {
  const entries = [
    dirtyEntry('entry-app', encodedPath(Buffer.from('packages/app/src/index.ts'))),
    dirtyEntry('entry-lib', encodedPath(Buffer.from('packages/lib/src/index.ts'))),
  ];
  const result = projectWitnesses(
    repository,
    entries,
    fixtureReader({
      'ws-app': [turn('turn-app', 'agent-app', 'src/index.ts')],
      'ws-lib': [turn('turn-lib', 'agent-lib', 'src/index.ts')],
    }),
    null,
  );

  assert.deepEqual(
    result.map(({ entryId, workspaceId, turnId }) => ({ entryId, workspaceId, turnId })),
    [
      { entryId: 'entry-app', workspaceId: 'ws-app', turnId: 'turn-app' },
      { entryId: 'entry-lib', workspaceId: 'ws-lib', turnId: 'turn-lib' },
    ],
  );
});

test('never matches a non-UTF-8 Git path through its lossy display string', () => {
  const invalidBytes = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x73]);
  const lossyDisplay = invalidBytes.toString('utf8');
  const entries = [
    dirtyEntry('entry-non-utf8', encodedPath(invalidBytes, false, lossyDisplay)),
  ];
  const rootRepository: RepositoryIdentity = {
    ...repository,
    workspaces: [{ workspaceId: 'ws-root', workspacePrefix: '' }],
  };

  const result = projectWitnesses(
    rootRepository,
    entries,
    fixtureReader({ 'ws-root': [turn('turn-lossy', 'agent-a', lossyDisplay)] }),
    null,
  );

  assert.deepEqual(result, [], 'no edge means WP-1D will keep the entry unattributed');
});

test('legacy Stage ① turn has null plan association when stampSource is null', () => {
  const entries = [
    dirtyEntry('entry-app', encodedPath(Buffer.from('packages/app/src/legacy.ts'))),
  ];
  const result = projectWitnesses(
    repository,
    entries,
    fixtureReader({ 'ws-app': [turn('turn-legacy', 'agent-legacy', 'src/legacy.ts')] }),
    null,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].planId, null);
  assert.equal(result[0].planItemId, null);
});

test('optional stampSource projects frozen Stage ② association fields without a rewrite', () => {
  const entries = [
    dirtyEntry('entry-app', encodedPath(Buffer.from('packages/app/src/stamped.ts'))),
  ];
  const result = projectWitnesses(
    repository,
    entries,
    fixtureReader({ 'ws-app': [turn('turn-stamped', 'agent-stamped', 'src/stamped.ts')] }),
    (workspaceId, turnId) => {
      assert.equal(workspaceId, 'ws-app');
      assert.equal(turnId, 'turn-stamped');
      return { planId: 'plan-frozen', planItemId: 'item-frozen' };
    },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].planId, 'plan-frozen');
  assert.equal(result[0].planItemId, 'item-frozen');
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
