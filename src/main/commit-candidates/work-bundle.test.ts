// SC-WP-1G — pure renderer DTO projection acceptance.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/work-bundle.test.js

import assert from 'node:assert/strict';

import type {
  BundleCaptureHealth,
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  EncodedGitPath,
  RepositoryIdentity,
} from '../../shared/commit-candidates';
import { projectWorkBundles } from './work-bundle';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const repository: RepositoryIdentity = {
  repositoryKey: 'repository-key',
  objectDatabaseKey: 'C:\\raw\\absolute\\.git',
  gitObjectFormat: 'sha1',
  bareRepo: false,
  workspaces: [
    { workspaceId: 'workspace-a', workspacePrefix: 'packages/a' },
    { workspaceId: 'workspace-b', workspacePrefix: 'packages/b' },
  ],
};

function encoded(displayPath: string): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from(displayPath).toString('base64'),
    displayPath,
    utf8Clean: true,
  };
}

function entry(entryId: string, displayPath: string): DirtyEntry {
  const path = encoded(displayPath);
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
    gitLevelEligibility: 'supported',
    commitPathspecs: [path],
  };
}

const entries = [
  entry('entry-a', 'packages/a/src/a.ts'),
  entry('entry-b', 'packages/b/src/b.ts'),
  entry('entry-loose', 'packages/b/generated.txt'),
];

const component: ConflictComponent = {
  componentId: 'component-ab',
  dirtyEntryIds: ['entry-b', 'entry-a'],
  associations: [{
    planId: 'plan-1',
    planItemId: null,
    contributingTurnIds: ['turn-a', 'turn-b'],
    memberEntryIds: ['entry-a', 'entry-b'],
  }],
  overlap: {
    componentId: 'component-ab',
    contributingAgentCount: 2,
    mergedGroupCount: 2,
    perPathContributors: {},
    requiresOverlapAck: true,
  },
  componentTopologyDigest: 'digest-ab',
};

const inventory: DirtyInventory = {
  repository,
  entries,
  unattributedEntryIds: ['entry-loose'],
  topologyDigest: 'inventory-digest',
};

const componentHealth: BundleCaptureHealth = {
  turns: [{
    turnId: 'turn-a',
    beforeEdge: 'verified-live',
    afterEdge: 'ready-hint-only',
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    failureClass: 'none',
  }],
  captureOutage: false,
  pathsWithoutFinalizationEdge: [
    entries[0].path.pathBytesBase64,
    entries[1].path.pathBytesBase64,
  ],
};

const unattributedHealth: BundleCaptureHealth = {
  turns: [],
  captureOutage: false,
  pathsWithoutFinalizationEdge: [entries[2].path.pathBytesBase64],
};

function project() {
  return projectWorkBundles({
    inventory,
    components: [component],
    captureHealthByComponentId: { [component.componentId]: componentHealth },
    unattributedCaptureHealth: unattributedHealth,
    protectionByEntryId: {
      'entry-a': 'checkpoint-protected',
      'entry-b': 'unprotected',
      'entry-loose': 'checkpoint-protected',
    },
  });
}

test('copies canonical component membership verbatim and attaches labels', () => {
  const [bundle] = project();
  assert.equal(bundle.kind, 'component');
  assert.equal(bundle.component, component);
  assert.deepEqual(
    bundle.members.map((member) => member.entry.entryId),
    component.dirtyEntryIds,
  );
  assert.deepEqual(bundle.labels, [
    'Plan plan-1',
    'Overlapping work',
  ]);
  assert.equal(bundle.label, 'Work package');
  assert.equal(bundle.identity, null);
});

test('always adds one synthetic unattributed pseudo-bundle without components', () => {
  const bundles = project();
  const unattributed = bundles.find((bundle) => bundle.kind === 'unattributed');
  assert.ok(unattributed);
  assert.equal(unattributed!.component, null);
  assert.equal(unattributed!.label, 'Unattributed changes');
  assert.deepEqual(
    unattributed!.members.map((member) => member.entry.entryId),
    inventory.unattributedEntryIds,
  );

  const empty = projectWorkBundles({
    ...{
      inventory: { ...inventory, unattributedEntryIds: [] },
      components: [component],
      captureHealthByComponentId: { [component.componentId]: componentHealth },
      unattributedCaptureHealth: {
        turns: [],
        captureOutage: false,
        pathsWithoutFinalizationEdge: [],
      },
      protectionByEntryId: {},
    },
  }).at(-1)!;
  assert.equal(empty.kind, 'unattributed');
  assert.deepEqual(empty.members, []);
  assert.equal(empty.weakestProtection, null);
});

test('carries capture health and computes the weakest protection rung', () => {
  const [componentBundle, unattributedBundle] = project();
  assert.equal(componentBundle.captureHealth, componentHealth);
  assert.equal(componentBundle.weakestProtection, 'unprotected');
  assert.equal(unattributedBundle.captureHealth, unattributedHealth);
  assert.equal(unattributedBundle.weakestProtection, 'checkpoint-protected');
});

test('serialized DTO omits every raw absolute main-process path', () => {
  const serialized = JSON.stringify(project());
  assert.equal(serialized.includes(repository.objectDatabaseKey), false);
  assert.equal(serialized.includes('C:\\raw\\absolute'), false);
  assert.equal(serialized.includes('"objectDatabaseKey"'), false);
  assert.match(serialized, /packages\/a\/src\/a\.ts/);
});

test('rejects a component that references an entry absent from canonical inventory', () => {
  assert.throws(() => projectWorkBundles({
    inventory,
    components: [{ ...component, dirtyEntryIds: ['invented-entry'] }],
    captureHealthByComponentId: {},
    unattributedCaptureHealth: unattributedHealth,
    protectionByEntryId: {},
  }), /unknown dirty entry/);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.run();
      console.log(`  ok  ${current.name}`);
      passed++;
    } catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
