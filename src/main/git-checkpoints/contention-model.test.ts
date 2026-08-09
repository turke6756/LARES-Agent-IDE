// WP-P7B — compiled test:
//   npm run build:main
//   node dist/main/main/git-checkpoints/contention-model.test.js

import assert from 'node:assert/strict';

import type { TurnRecord } from '../database';
import {
  advisePackageContention,
  buildPathContentionGraph,
  encodePlannedPath,
  type ContentionWorkspaceScope,
} from './contention-model';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const NOW = 10_000;
const ROOT: ContentionWorkspaceScope = {
  workspaceId: 'ws-root', repositoryKey: 'worktree-main', workspacePrefix: '',
};
const SUB_A: ContentionWorkspaceScope = {
  workspaceId: 'ws-a', repositoryKey: 'worktree-main', workspacePrefix: 'packages/a',
};
const SUB_B: ContentionWorkspaceScope = {
  workspaceId: 'ws-b', repositoryKey: 'worktree-main', workspacePrefix: 'packages/b',
};
const LINKED: ContentionWorkspaceScope = {
  workspaceId: 'ws-linked', repositoryKey: 'worktree-linked', workspacePrefix: 'packages/a',
};

function turn(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'id' | 'workspaceId'>): TurnRecord {
  return {
    turnSeq: 1,
    agentId: 'agent-1',
    agentTitle: null,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    sessionId: null,
    taskLabel: 'editing',
    intentId: 'intent-default',
    intentStampSource: 'task-dispatch',
    startedAt: NOW - 100,
    endedAt: null,
    status: 'open',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
    beforeQuality: null,
    afterQuality: null,
    beforeRawFilterBypassed: false,
    beforeFilteredPaths: null,
    beforePrunedAt: null,
    afterPrunedAt: null,
    touched: [{ path: 'src/default.ts', op: 'write' }],
    diffStats: null,
    compactDiff: null,
    compactDiffProvenance: null,
    failureReason: null,
    ...overrides,
  };
}

test('planned workspace-relative paths include the repository prefix before byte encoding', () => {
  const encoded = encodePlannedPath(SUB_A, 'src/foo.ts');
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded.pathBytesBase64, 'base64').toString('utf8'), 'packages/a/src/foo.ts');
  assert.equal(encoded.displayPath, 'packages/a/src/foo.ts');
});

test('repo-normalized overlap emits a non-blocking advisory', () => {
  const graph = buildPathContentionGraph({
    now: NOW,
    turns: [turn({ id: 'active-a', workspaceId: 'ws-a', touched: [
      { path: 'packages/a/src/foo.ts', op: 'write' },
    ] })],
    workspaces: [SUB_A],
  });
  const advisory = advisePackageContention(graph, 'pkg-a', SUB_A, [
    { path: 'src/foo.ts', intentKind: 'edit' },
  ]);
  assert.ok(advisory);
  assert.equal(advisory.advisoryOnly, true);
  assert.equal(advisory.blocks, false);
  assert.equal(advisory.overlaps.length, 1);
  assert.equal(advisory.overlaps[0].turns[0].turnId, 'active-a');
  assert.equal(advisory.overlaps[0].turns[0].intentId, 'intent-default');
  assert.equal(advisory.overlaps[0].path.pathBytesBase64,
    Buffer.from('packages/a/src/foo.ts', 'utf8').toString('base64'));
});

test('same workspace-relative path in sibling workspace prefixes does not collide', () => {
  const graph = buildPathContentionGraph({
    now: NOW,
    turns: [turn({ id: 'active-a', workspaceId: 'ws-a', touched: [
      { path: 'packages/a/src/foo.ts', op: 'write' },
    ] })],
    workspaces: [SUB_A, SUB_B],
  });
  assert.equal(advisePackageContention(graph, 'pkg-b', SUB_B, [{ path: 'src/foo.ts' }]), null);
});

test('linked worktrees are not conflated even with identical repo-relative paths', () => {
  const graph = buildPathContentionGraph({
    now: NOW,
    turns: [turn({ id: 'main-turn', workspaceId: 'ws-a', touched: [
      { path: 'packages/a/src/foo.ts', op: 'write' },
    ] })],
    workspaces: [SUB_A, LINKED],
  });
  assert.equal(advisePackageContention(graph, 'linked-pkg', LINKED, [{ path: 'src/foo.ts' }]), null);
});

test('workspace aliases of the same worktree and prefix do collide', () => {
  const alias = { workspaceId: 'ws-alias', repositoryKey: SUB_A.repositoryKey, workspacePrefix: SUB_A.workspacePrefix };
  const graph = buildPathContentionGraph({
    now: NOW,
    turns: [turn({ id: 'alias-turn', workspaceId: alias.workspaceId, touched: [
      { path: 'packages/a/src/foo.ts', op: 'create' },
    ] })],
    workspaces: [SUB_A, alias],
  });
  assert.ok(advisePackageContention(graph, 'pkg-a', SUB_A, [{ path: 'src/foo.ts' }]));
});

test('active turns always remain; closed turns roll out after the recent window', () => {
  const graph = buildPathContentionGraph({
    now: NOW,
    recentWindowMs: 500,
    workspaces: [ROOT],
    turns: [
      turn({ id: 'open-old', workspaceId: ROOT.workspaceId, startedAt: 1,
        touched: [{ path: 'src/open.ts', op: 'write' }] }),
      turn({ id: 'recent', workspaceId: ROOT.workspaceId, status: 'accepted', endedAt: NOW - 400,
        touched: [{ path: 'src/recent.ts', op: 'create' }] }),
      turn({ id: 'stale', workspaceId: ROOT.workspaceId, status: 'accepted', endedAt: NOW - 501,
        touched: [{ path: 'src/stale.ts', op: 'write' }] }),
    ],
  });
  assert.ok(advisePackageContention(graph, 'pkg', ROOT, [{ path: 'src/open.ts' }]));
  assert.ok(advisePackageContention(graph, 'pkg', ROOT, [{ path: 'src/recent.ts' }]));
  assert.equal(advisePackageContention(graph, 'pkg', ROOT, [{ path: 'src/stale.ts' }]), null);
});

test('reads, malformed witness paths, and invalid planned paths never become nodes', () => {
  const graph = buildPathContentionGraph({
    now: NOW,
    workspaces: [ROOT],
    turns: [turn({ id: 'noise', workspaceId: ROOT.workspaceId, touched: [
      { path: 'src/read.ts', op: 'read' as 'write' },
      { path: '../escape.ts', op: 'write' },
    ] })],
  });
  assert.equal(graph.paths.length, 0);
  assert.equal(advisePackageContention(graph, 'pkg', ROOT, [{ path: '../escape.ts' }]), null);
});

let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); }
  catch (error) { failed++; console.error(`  FAIL ${t.name}`); console.error(error); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
