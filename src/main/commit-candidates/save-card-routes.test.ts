// SC-WP-1J — production Save-card route wiring (read-only) acceptance.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/save-card-routes.test.js
//
// Exercises the bootstrap-side adapter end to end against a REAL temp Git repo
// and the REAL capability probe / git seams; only the workspace registry and the
// two DB readers (witness / capture turns) are faked. Proves the adapter:
//   • maps the renderer `{ workspaceId }` to a full repository-scoped request,
//   • carries EVERY registered workspace so shared-worktree lanes union,
//   • narrows past registered workspaces that are not in the target's repo,
//   • issues only the read-only Git command family (no mutating verb), and
//   • plugs into the SC-WP-1H IPC seam: unavailable before wiring, live after.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TurnWitnessRead } from '../database';
import { runGit, runGitBytes } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';
import { registerSaveCardIpc, type IpcLike, type SaveCardRoutes } from './save-card-ipc';
import { SAVECARD_CHANNELS } from '../../shared/types';
import type { CaptureHealthTurn } from './capture-health';
import { createSaveCardRoutes } from './save-card-routes';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let gitExe = '';
let repo = '';
let outsideRepoDir = '';
const observedCommands: string[][] = [];

function git(cwd: string, args: string[]): void {
  execFileSync(gitExe, args, { cwd, encoding: 'utf8' });
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

function witness(turnId: string, touchedPath: string): TurnWitnessRead {
  return {
    turnId,
    agentId: 'shared-agent',
    ownerAgentId: null,
    ownerBrickGeneration: null,
    touched: [{ path: touchedPath, op: 'write' }],
  };
}

// Fake registry: two lanes sharing ONE worktree (packages/a, packages/b) plus a
// third registered workspace that is NOT in this repo — the adapter must pass all
// three and let the facade's scope discovery narrow to the shared worktree.
function fakeGetWorkspaces(): Array<{ id: string; path: string }> {
  return [
    { id: 'workspace-a', path: path.join(repo, 'packages', 'a') },
    { id: 'workspace-b', path: path.join(repo, 'packages', 'b') },
    { id: 'workspace-outside', path: outsideRepoDir },
  ];
}

const witnessRows: Record<string, TurnWitnessRead[]> = {
  'workspace-a': [witness('turn-a', 'one.txt')],
  'workspace-b': [witness('turn-b', 'two.txt')],
};
const captureRows: Record<string, CaptureHealthTurn[]> = {
  'workspace-a': [captureTurn('turn-a')],
  'workspace-b': [captureTurn('turn-b')],
};

function buildRoutes(): SaveCardRoutes {
  return createSaveCardRoutes({
    gitExe,
    getWorkspaces: fakeGetWorkspaces,
    readTurnWitnesses: (workspaceId) => witnessRows[workspaceId] ?? [],
    readCaptureTurns: (workspaceId) => captureRows[workspaceId] ?? [],
    // Real capability probe, but observe the git command family it + the facade
    // issue by wrapping the real runners.
    runGit: async (cwd, args, options) => {
      observedCommands.push([...args]);
      return runGit(cwd, args, { ...options, gitExe });
    },
    runGitBytes: async (cwd, args, options) => {
      observedCommands.push([...args]);
      return runGitBytes(cwd, args, { ...options, gitExe });
    },
  });
}

async function setup(): Promise<void> {
  const internal = await resolveInternalGit();
  if (!internal) throw new Error('no compatible Git resolved');
  gitExe = internal.execPath;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-save-card-routes-'));
  outsideRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-save-card-outside-'));
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
}

test('maps the renderer workspaceId to the shared-worktree repository inventory', async () => {
  const routes = buildRoutes();
  const bundles = await routes.getInventory({ workspaceId: 'workspace-a' });

  // One component (attributed one.txt + two.txt) + the unattributed pseudo-bundle.
  const component = bundles.find((bundle) => bundle.kind === 'component');
  const unattributed = bundles.find((bundle) => bundle.kind === 'unattributed');
  assert.ok(component, 'expected an attributed component bundle');
  assert.ok(unattributed, 'expected the unattributed pseudo-bundle');
  assert.ok(component!.component, 'component bundle carries its ConflictComponent');

  const componentPaths = component!.members
    .map((member) => member.entry.path.displayPath)
    .sort();
  assert.deepEqual(componentPaths, ['packages/a/one.txt', 'packages/b/two.txt']);
  const unattributedPaths = unattributed!.members.map((member) => member.entry.path.displayPath);
  assert.deepEqual(unattributedPaths, ['packages/b/generated.txt']);
  // The out-of-repo change is never scoped in.
  const allPaths = bundles.flatMap((bundle) => bundle.members.map((m) => m.entry.path.displayPath));
  assert.equal(allPaths.includes('outside.txt'), false);
});

test('candidate request carries every registered workspace so sibling lanes union', async () => {
  const routes = buildRoutes();
  const bundles = await routes.getInventory({ workspaceId: 'workspace-b' });
  // Both in-repo lanes appear in the repository identity; the out-of-repo
  // workspace was passed as a candidate but narrowed out by scope discovery.
  const component = bundles.find((bundle) => bundle.kind === 'component')!;
  assert.deepEqual(component.workspaces, [
    { workspaceId: 'workspace-a', workspacePrefix: 'packages/a' },
    { workspaceId: 'workspace-b', workspacePrefix: 'packages/b' },
  ]);
});

test('issues only the read-only Git command family — never a mutating verb', async () => {
  observedCommands.length = 0;
  const routes = buildRoutes();
  await routes.getInventory({ workspaceId: 'workspace-a' });

  const verbs = new Set(observedCommands.map((args) =>
    args[0] === '--no-optional-locks' ? args[1] : args[0],
  ));
  // rev-parse (probe + scope), status (inventory), hash-object (identity).
  for (const verb of verbs) {
    assert.ok(
      ['rev-parse', 'status', 'hash-object'].includes(verb),
      `unexpected git verb issued by the read-only Save-card path: ${verb}`,
    );
  }
  for (const args of observedCommands) {
    assert.equal(args.includes('-w'), false, `hash-object must not write: ${args.join(' ')}`);
    for (const mutating of ['commit', 'add', 'reset', 'restore', 'checkout', 'update-index', 'update-ref']) {
      assert.equal(args.includes(mutating), false, `mutating verb leaked: ${args.join(' ')}`);
    }
  }
});

test('serialized DTOs never leak absolute filesystem paths or the git exe', async () => {
  const routes = buildRoutes();
  const bundles = await routes.getInventory({ workspaceId: 'workspace-a' });
  const serialized = JSON.stringify(bundles);
  assert.equal(serialized.includes(repo), false);
  assert.equal(serialized.includes(repo.replace(/\\/g, '/')), false);
  assert.equal(serialized.includes(gitExe), false);
});

test('IPC seam contract: unavailable before wiring, live inventory after', async () => {
  // Mirror the exact SC-WP-1J bootstrap contract: the channel is registered with
  // a lazy getter that starts null (no-engine fallback → honest "unavailable"),
  // and flips to the production routes once the engine bootstrap wires them.
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcLike = { handle: (channel, listener) => { handlers.set(channel, listener); } };
  let routes: SaveCardRoutes | null = null;
  registerSaveCardIpc(ipc, () => routes);
  const invoke = (arg: unknown) => handlers.get(SAVECARD_CHANNELS.getInventory)!({}, arg);

  await assert.rejects(
    () => Promise.resolve(invoke({ workspaceId: 'workspace-a' })),
    /save-card engine unavailable|bootstrapping/i,
  );

  routes = buildRoutes();
  const bundles = await invoke({ workspaceId: 'workspace-a' }) as Awaited<
    ReturnType<SaveCardRoutes['getInventory']>
  >;
  assert.ok(bundles.some((bundle) => bundle.kind === 'component'));
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
    for (const dir of [repo, outsideRepoDir]) {
      if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
