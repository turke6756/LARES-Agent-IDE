// SC-WP-1A — repository scope discovery (bundle contract v1 §1).
//
//   npm run build:main
//   node dist/main/main/commit-candidates/scope-discovery.test.js
//
// NO real git / disk: each workspace's git seam is a canned fixture. Proves:
// multiple workspace aliases of one worktree → ONE repositoryKey with a
// deterministically-sorted `workspaces` array; linked worktree → a SEPARATE
// scope sharing objectDatabaseKey; bare/non-repo workspaces are rejected out of
// the grouping, never contributing.

import assert from 'node:assert/strict';

import {
  discoverRepositoryScopes,
  discoverScopeForWorkspace,
  type ScopeDiscoveryDeps,
  type WorkspaceScopeInput,
} from './scope-discovery';
import type { GitExecResult } from '../git/git-runtime';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const OK = (stdout: string): GitExecResult => ({ code: 0, stdout, stderr: '' });

/** Per-workspace git fixture: maps workspaceDir → (argv → result). */
type GitTable = Record<string, Record<string, GitExecResult>>;

function makeDeps(
  table: GitTable,
  opts?: { realpath?: (p: string) => string; exists?: (p: string) => boolean },
): ScopeDiscoveryDeps {
  return {
    platform: 'win32',
    realpath: opts?.realpath ?? ((p) => p),
    fileExists: opts?.exists ?? (() => true),
    runGitFor: (workspaceDir: string) => async (args: string[]) => {
      const key = args.join(' ');
      const forWs = table[workspaceDir] ?? {};
      if (key in forWs) return forWs[key];
      if (key === 'rev-parse --is-bare-repository') return OK('false');
      if (key === 'rev-parse --show-object-format') return OK('sha1');
      throw new Error(`unexpected git argv for ${workspaceDir}: ${key}`);
    },
  };
}

/** A workspace whose index resolves (via realpath) to `canonicalIndex`. */
function ws(
  workspaceId: string,
  workspaceDir: string,
  rawIndex: string,
  commonDirQueueKey: string,
  workspacePrefix: string,
): WorkspaceScopeInput {
  return { workspaceId, workspaceDir, capability: { commonDirQueueKey, workspacePrefix } };
}

// ── aliases of one worktree → ONE scope, sorted workspaces ────────────────────

test('multiple workspace aliases of one worktree → ONE repositoryKey, workspaces sorted by workspaceId', async () => {
  const canonical = 'C:\\Repo\\.git\\index';
  const table: GitTable = {
    'C:\\aliasZ': { 'rev-parse --git-path index': OK('C:/aliasZ/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/aliasZ/.git') },
    'C:\\aliasA': { 'rev-parse --git-path index': OK('C:/aliasA/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/aliasA/.git') },
  };
  const deps = makeDeps(table, { realpath: () => canonical });
  const inputs = [
    // Deliberately out-of-order ids to prove the deterministic sort.
    ws('ws-zeta', 'C:\\aliasZ', 'C:/aliasZ/.git/index', 'c:\\repo\\.git', 'aliasZ'),
    ws('ws-alpha', 'C:\\aliasA', 'C:/aliasA/.git/index', 'c:\\repo\\.git', ''),
  ];
  const { scopes, rejected } = await discoverRepositoryScopes(inputs, deps);
  assert.equal(rejected.length, 0);
  assert.equal(scopes.size, 1, 'both aliases collapse into ONE scope');
  const identity = [...scopes.values()][0].identity;
  assert.equal(identity.bareRepo, false);
  assert.deepEqual(
    identity.workspaces.map((w) => w.workspaceId),
    ['ws-alpha', 'ws-zeta'],
    'workspaces deterministically sorted by workspaceId',
  );
  // workspacePrefix carried verbatim from each capability.
  assert.deepEqual(
    identity.workspaces,
    [
      { workspaceId: 'ws-alpha', workspacePrefix: '' },
      { workspaceId: 'ws-zeta', workspacePrefix: 'aliasZ' },
    ],
  );
});

// ── linked worktree → separate scope, shared objectDatabaseKey ────────────────

test('linked worktree lands in a SEPARATE scope but shares objectDatabaseKey', async () => {
  const shared = 'c:\\repo\\.git';
  const table: GitTable = {
    'C:\\Repo': { 'rev-parse --git-path index': OK('C:/Repo/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git') },
    'C:\\Repo\\wt': { 'rev-parse --git-path index': OK('C:/Repo/.git/worktrees/wt/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git/worktrees/wt') },
  };
  const deps = makeDeps(table, { realpath: (p) => p });
  const inputs = [
    ws('ws-main', 'C:\\Repo', 'C:/Repo/.git/index', shared, ''),
    ws('ws-wt', 'C:\\Repo\\wt', 'C:/Repo/.git/worktrees/wt/index', shared, ''),
  ];
  const { scopes } = await discoverRepositoryScopes(inputs, deps);
  assert.equal(scopes.size, 2, 'main + linked worktree → two scopes');
  const objectKeys = [...scopes.values()].map((s) => s.identity.objectDatabaseKey);
  assert.deepEqual(objectKeys, [shared, shared], 'both scopes share the object-db key');
  const repoKeys = [...scopes.values()].map((s) => s.identity.repositoryKey);
  assert.notEqual(repoKeys[0], repoKeys[1], 'distinct repositoryKeys');
});

// ── rejected workspaces do not contribute ─────────────────────────────────────

test('bare + non-repo workspaces are rejected, never grouped', async () => {
  const table: GitTable = {
    'C:\\Good': { 'rev-parse --git-path index': OK('C:/Good/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Good/.git') },
    'C:\\Bare': { 'rev-parse --is-bare-repository': OK('true') },
    'C:\\Plain': { 'rev-parse --absolute-git-dir': { code: 128, stdout: '', stderr: 'fatal: not a git repository' } },
  };
  const deps = makeDeps(table, { realpath: (p) => p });
  const inputs = [
    ws('ws-good', 'C:\\Good', 'C:/Good/.git/index', 'c:\\good\\.git', ''),
    ws('ws-bare', 'C:\\Bare', '', 'c:\\bare.git', ''),
    ws('ws-plain', 'C:\\Plain', '', 'c:\\plain', ''),
  ];
  const { scopes, rejected } = await discoverRepositoryScopes(inputs, deps);
  assert.equal(scopes.size, 1, 'only the good workspace forms a scope');
  assert.deepEqual([...scopes.values()][0].identity.workspaces.map((w) => w.workspaceId), ['ws-good']);
  assert.deepEqual(
    rejected.map((r) => [r.workspaceId, r.outcome.reason]).sort(),
    [['ws-bare', 'bare-repo'], ['ws-plain', 'not-a-repo']].sort(),
  );
});

// ── discoverScopeForWorkspace convenience ─────────────────────────────────────

test('discoverScopeForWorkspace returns the scope containing the target (all aliases)', async () => {
  const canonical = 'C:\\Repo\\.git\\index';
  const table: GitTable = {
    'C:\\aliasA': { 'rev-parse --git-path index': OK('C:/aliasA/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/aliasA/.git') },
    'C:\\aliasB': { 'rev-parse --git-path index': OK('C:/aliasB/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/aliasB/.git') },
  };
  const deps = makeDeps(table, { realpath: () => canonical });
  const inputs = [
    ws('ws-a', 'C:\\aliasA', 'C:/aliasA/.git/index', 'c:\\repo\\.git', ''),
    ws('ws-b', 'C:\\aliasB', 'C:/aliasB/.git/index', 'c:\\repo\\.git', ''),
  ];
  const identity = await discoverScopeForWorkspace('ws-b', inputs, deps);
  assert.notEqual(identity, null);
  assert.deepEqual(identity!.workspaces.map((w) => w.workspaceId), ['ws-a', 'ws-b']);
});

test('discoverScopeForWorkspace returns null for a rejected / unknown target', async () => {
  const deps = makeDeps({ 'C:\\Bare': { 'rev-parse --is-bare-repository': OK('true') } });
  const inputs = [ws('ws-bare', 'C:\\Bare', '', 'c:\\bare.git', '')];
  assert.equal(await discoverScopeForWorkspace('ws-bare', inputs, deps), null, 'rejected target → null');
  assert.equal(await discoverScopeForWorkspace('ws-missing', inputs, deps), null, 'unknown target → null');
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
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
