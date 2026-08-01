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
let initialCommitOid = '';
const observedCommands: string[][] = [];

// Live checkpoint refs pointing at the fixture's initial commit. Their tree holds
// the ORIGINAL blobs, so the (now dirty) worktree members never match — protection
// stays `unprotected` while the batched liveness + tree reads are still exercised.
const BEFORE_REF = 'refs/lares/checkpoints/fixture/before';
const AFTER_REF = 'refs/lares/checkpoints/fixture/after';

function git(cwd: string, args: string[]): string {
  return execFileSync(gitExe, args, { cwd, encoding: 'utf8' });
}

/** A turn whose before/after edges resolve LIVE to the fixture's initial commit,
 *  so `evaluateCheckpointProtection` actually issues its batched Git probes. */
function captureTurn(id: string): CaptureHealthTurn {
  return {
    id,
    status: 'accepted',
    beforeOid: initialCommitOid,
    afterOid: initialCommitOid,
    beforeRef: BEFORE_REF,
    afterRef: AFTER_REF,
    beforeReady: true,
    afterReady: true,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    beforePrunedAt: null,
    afterPrunedAt: null,
    failureReason: null,
  };
}

/** A turn with no live edges (all metadata null) — the pre-SC-WP-1K blind spot,
 *  kept only to prove the batch path still issues zero Git for unusable edges. */
function deadTurn(id: string): CaptureHealthTurn {
  return {
    ...captureTurn(id),
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
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
  initialCommitOid = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['update-ref', BEFORE_REF, initialCommitOid]);
  git(repo, ['update-ref', AFTER_REF, initialCommitOid]);

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
  // No member is checkpoint-protected in this fixture (the worktree diverged from
  // the initial commit), so the mode-confirm `ls-tree` never fires; liveness and
  // membership are both batched `cat-file` probes.
  assert.deepEqual([...commandNames].sort(), [
    'cat-file',
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
    assert.equal(args.includes('update-ref'), false);
  }
});

// SC-WP-1K perf gate. The pre-fix protection path issued one `rev-parse` PER edge
// plus one `ls-tree` per member × live edge — thousands of serialized git spawns on
// the real ~840-turn workspace (minutes). This asserts the batched replacement:
// exactly TWO `cat-file` probes (liveness + membership), INDEPENDENT of the edge
// count, and NO per-edge `ls-tree` fan-out. A fixture that exercises zero live-edge
// calls (the SC-WP-1B.2 blind spot) issues zero `cat-file` and fails these guards.
test('protection Git probes are request-scoped and batched, independent of edge count', async () => {
  const commands: string[][] = [];
  const cmdName = (args: string[]): string =>
    args[0] === '--no-optional-locks' ? args[1] : args[0];
  const perfService = new CommitCandidateService({
    runGit: async (cwd, args, options) => {
      commands.push([...args]);
      return runGit(cwd, args, { ...options, gitExe });
    },
    runGitBytes: async (cwd, args, options) => {
      commands.push([...args]);
      return runGitBytes(cwd, args, { ...options, gitExe });
    },
    readTurnWitnesses: () => [],
    // 200 live turns on the target workspace ⇒ 400 before/after edges, but only two
    // distinct refs and ONE distinct live commit OID.
    readCaptureTurns: (workspaceId) =>
      workspaceId === 'workspace-a'
        ? Array.from({ length: 200 }, (_unused, index) => captureTurn(`perf-turn-${index}`))
        : [],
  });

  await perfService.assembleInventory({ targetWorkspaceId: 'workspace-a', workspaces });

  const catFile = commands.filter((args) => cmdName(args) === 'cat-file');
  const lsTree = commands.filter((args) => cmdName(args) === 'ls-tree');
  const revParse = commands.filter((args) => cmdName(args) === 'rev-parse');

  assert.equal(catFile.length, 2, 'liveness + membership: two batched cat-file probes for 400 edges');
  assert.equal(
    catFile.filter((args) => !args.includes('-z')).length,
    1,
    'exactly one liveness probe (cat-file --batch-check)',
  );
  assert.equal(
    catFile.filter((args) => args.includes('-z')).length,
    1,
    'exactly one NUL-delimited membership probe (cat-file --batch-check -z)',
  );
  // Nothing is protected here, so the mode-confirm ls-tree never fires; crucially
  // there is NO per-edge / per-member ls-tree fan-out regardless of the 400 edges.
  assert.equal(lsTree.length, 0, 'no ls-tree fan-out when no member has a blob hit');
  // rev-parse belongs to scope discovery only (a small fixed probe set), never to
  // liveness — the pre-fix per-edge rev-parse storm must not reappear.
  assert.ok(revParse.length <= 8, `rev-parse must not scale with edges: ${revParse.length}`);
  assert.ok(commands.length < 40, `total git spawns must stay bounded: ${commands.length}`);
});

test('turns with no live edges issue zero liveness/tree Git (batch stays honest)', async () => {
  const commands: string[][] = [];
  const cmdName = (args: string[]): string =>
    args[0] === '--no-optional-locks' ? args[1] : args[0];
  const deadService = new CommitCandidateService({
    runGit: async (cwd, args, options) => {
      commands.push([...args]);
      return runGit(cwd, args, { ...options, gitExe });
    },
    runGitBytes: async (cwd, args, options) => {
      commands.push([...args]);
      return runGitBytes(cwd, args, { ...options, gitExe });
    },
    readTurnWitnesses: () => [],
    readCaptureTurns: (workspaceId) =>
      workspaceId === 'workspace-a' ? [deadTurn('dead-1'), deadTurn('dead-2')] : [],
  });

  await deadService.assembleInventory({ targetWorkspaceId: 'workspace-a', workspaces });

  assert.equal(
    commands.filter((args) => cmdName(args) === 'cat-file').length,
    0,
    'no usable edges ⇒ no liveness probe spawned',
  );
  assert.equal(commands.filter((args) => cmdName(args) === 'ls-tree').length, 0);
});

test('scope probe memo is request-local and deduplicates only repeated target reads', async () => {
  const revParseReads: Array<{ cwd: string; args: string[] }> = [];
  const memoService = new CommitCandidateService({
    runGit: async (cwd, args, options) => {
      if (args[0] === 'rev-parse') revParseReads.push({ cwd, args: [...args] });
      return runGit(cwd, args, { ...options, gitExe });
    },
    runGitBytes: (cwd, args, options) => runGitBytes(cwd, args, { ...options, gitExe }),
    readTurnWitnesses: () => [],
    readCaptureTurns: () => [],
  });
  const request = { targetWorkspaceId: 'workspace-a', workspaces };

  await memoService.assembleInventory(request);
  assert.equal(revParseReads.length, 8, 'two workspaces × four probes; target duplicate is memoized');
  for (const args of [
    ['rev-parse', '--is-bare-repository'],
    ['rev-parse', '--absolute-git-dir'],
    ['rev-parse', '--git-path', 'index'],
    ['rev-parse', '--show-object-format'],
  ]) {
    assert.equal(
      revParseReads.filter((read) =>
        read.cwd === workspaces[0].workspaceDir
        && JSON.stringify(read.args) === JSON.stringify(args)
      ).length,
      1,
      `target probe runs once within the request: ${args.join(' ')}`,
    );
  }

  await memoService.assembleInventory(request);
  assert.equal(revParseReads.length, 16, 'a separate request performs fresh live probes');
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
