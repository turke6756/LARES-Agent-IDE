// SC-WP-1G — read-only facade + real Git integration acceptance.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/candidate-service.read.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TurnWitnessRead } from '../database';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';
import {
  CommitCandidateService,
  type CandidateWorkspaceInput,
  type CaptureTurnReader,
} from './candidate-service';
import type { CaptureHealthTurn } from './capture-health';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let gitExe = '';
let repo = '';
let service: CommitCandidateService;
let workspaces: CandidateWorkspaceInput[] = [];
const observedCommands: string[][] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync(gitExe, args, { cwd, encoding: 'utf8' });
}

function captureTurn(id: string): CaptureHealthTurn {
  return {
    id,
    status: 'accepted',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    beforePrunedAt: null,
    afterPrunedAt: null,
    failureReason: null,
  };
}

function witness(
  turnId: string,
  agentId: string,
  touchedPath: string,
): TurnWitnessRead {
  return {
    turnId,
    agentId,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    touched: [{ path: touchedPath, op: 'write' }],
  };
}

function rawScopedStatusPaths(): string[] {
  const stdout = execFileSync(gitExe, [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--',
    ':(top,literal)packages/a',
    ':(top,literal)packages/b',
  ], { cwd: repo });
  return stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      if (record.startsWith('? ')) return record.slice(2);
      const fieldsBeforePath = record.startsWith('1 ') ? 8 : 9;
      let spaces = 0;
      for (let index = 0; index < record.length; index++) {
        if (record[index] === ' ' && ++spaces === fieldsBeforePath) {
          return record.slice(index + 1);
        }
      }
      throw new Error(`unexpected porcelain record: ${record}`);
    })
    .sort();
}

async function setup(): Promise<void> {
  const internal = await resolveInternalGit();
  if (!internal) throw new Error('no compatible Git resolved');
  gitExe = internal.execPath;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-candidate-service-'));
  fs.mkdirSync(path.join(repo, 'packages', 'a'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages', 'b'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'a', 'one.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'packages', 'b', 'two.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'outside\n');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture']);

  fs.writeFileSync(path.join(repo, 'packages', 'a', 'one.txt'), 'one changed\n');
  fs.writeFileSync(path.join(repo, 'packages', 'b', 'two.txt'), 'two changed\n');
  fs.writeFileSync(path.join(repo, 'packages', 'b', 'generated.txt'), 'generated\n');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'outside changed\n');

  workspaces = [
    {
      workspaceId: 'workspace-a',
      workspaceDir: path.join(repo, 'packages', 'a'),
      capability: {
        commonDirQueueKey: 'fixture-object-db',
        workspacePrefix: 'packages/a',
        repoRoot: repo,
      },
      gitExe,
    },
    {
      workspaceId: 'workspace-b',
      workspaceDir: path.join(repo, 'packages', 'b'),
      capability: {
        commonDirQueueKey: 'fixture-object-db',
        workspacePrefix: 'packages/b',
        repoRoot: repo,
      },
      gitExe,
    },
  ];

  const witnessRows: Record<string, TurnWitnessRead[]> = {
    'workspace-a': [witness('turn-a', 'shared-agent', 'one.txt')],
    'workspace-b': [witness('turn-b', 'shared-agent', 'two.txt')],
  };
  const captureRows: Record<string, CaptureHealthTurn[]> = {
    'workspace-a': [captureTurn('turn-a')],
    'workspace-b': [captureTurn('turn-b')],
  };
  const readCaptureTurns: CaptureTurnReader =
    (workspaceId) => captureRows[workspaceId] ?? [];

  service = new CommitCandidateService({
    runGit: async (cwd, args, options) => {
      observedCommands.push([...args]);
      return runGit(cwd, args, { ...options, gitExe });
    },
    runGitBytes: async (cwd, args, options) => {
      observedCommands.push([...args]);
      return runGitBytes(cwd, args, { ...options, gitExe });
    },
    readTurnWitnesses: (workspaceId) => witnessRows[workspaceId] ?? [],
    readCaptureTurns,
  });
}

test('unions raw scoped git status membership across both workspace prefixes', async () => {
  const assembled = await service.assembleInventory({
    targetWorkspaceId: 'workspace-a',
    workspaces,
  });
  const actual = assembled.inventory.entries
    .map((entry) => entry.path.displayPath)
    .sort();
  assert.deepEqual(actual, rawScopedStatusPaths());
  assert.deepEqual(actual, [
    'packages/a/one.txt',
    'packages/b/generated.txt',
    'packages/b/two.txt',
  ]);
  assert.equal(actual.includes('outside.txt'), false);
});

test('same worktree multi-workspace attribution produces one repository component graph', async () => {
  const assembled = await service.assembleInventory({
    targetWorkspaceId: 'workspace-b',
    workspaces,
  });
  assert.deepEqual(assembled.inventory.repository.workspaces, [
    { workspaceId: 'workspace-a', workspacePrefix: 'packages/a' },
    { workspaceId: 'workspace-b', workspacePrefix: 'packages/b' },
  ]);
  assert.equal(assembled.components.length, 1);
  assert.deepEqual(
    assembled.components[0].dirtyEntryIds
      .map((entryId) => assembled.inventory.entries.find((entry) => entry.entryId === entryId)!.path.displayPath)
      .sort(),
    ['packages/a/one.txt', 'packages/b/two.txt'],
  );
  assert.deepEqual(
    assembled.inventory.unattributedEntryIds
      .map((entryId) => assembled.inventory.entries.find((entry) => entry.entryId === entryId)!.path.displayPath),
    ['packages/b/generated.txt'],
  );
});

test('listWorkBundles carries components, pseudo-bundle, capture health, and weakest rung', async () => {
  const bundles = await service.listWorkBundles({
    targetWorkspaceId: 'workspace-a',
    workspaces,
  });
  assert.equal(bundles.length, 2);
  const component = bundles.find((bundle) => bundle.kind === 'component')!;
  const unattributed = bundles.find((bundle) => bundle.kind === 'unattributed')!;
  assert.ok(component.component);
  assert.deepEqual(component.captureHealth.turns.map((turn) => turn.turnId), [
    'turn-a',
    'turn-b',
  ]);
  assert.equal(component.captureHealth.pathsWithoutFinalizationEdge.length, 2);
  assert.equal(component.weakestProtection, 'unprotected');
  assert.equal(unattributed.component, null);
  assert.equal(unattributed.members.length, 1);
  assert.equal(unattributed.weakestProtection, 'unprotected');
});

test('serialized DTOs never leak raw absolute filesystem paths', async () => {
  const bundles = await service.listWorkBundles({
    targetWorkspaceId: 'workspace-a',
    workspaces,
  });
  const serialized = JSON.stringify(bundles);
  assert.equal(serialized.includes(repo), false);
  assert.equal(serialized.includes(repo.replace(/\\/g, '/')), false);
  for (const workspace of workspaces) {
    assert.equal(serialized.includes(workspace.workspaceDir), false);
  }
  assert.equal(serialized.includes(gitExe), false);
  assert.equal(serialized.includes('objectDatabaseKey'), false);
});

test('facade issues only the expected read-only Git command family', async () => {
  await service.listWorkBundles({
    targetWorkspaceId: 'workspace-a',
    workspaces,
  });
  const commandNames = new Set(observedCommands.map((args) =>
    args[0] === '--no-optional-locks' ? args[1] : args[0],
  ));
  assert.deepEqual([...commandNames].sort(), [
    'hash-object',
    'rev-parse',
    'status',
  ]);
  for (const args of observedCommands) {
    assert.equal(args.includes('-w'), false, `hash-object must not write: ${args.join(' ')}`);
    assert.equal(args.includes('commit'), false);
    assert.equal(args.includes('add'), false);
    assert.equal(args.includes('reset'), false);
    assert.equal(args.includes('restore'), false);
    assert.equal(args.includes('checkout'), false);
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  try {
    await setup();
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
  } catch (error) {
    console.error('  FAIL fixture setup');
    console.error('       ', error instanceof Error ? error.stack || error.message : error);
    failed++;
  } finally {
    if (repo) {
      try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
