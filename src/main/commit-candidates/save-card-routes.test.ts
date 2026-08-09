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
import type { Agent } from '../../shared/types';
import type { CaptureHealthTurn } from './capture-health';
import { createSaveCardRoutes } from './save-card-routes';
import type { TurnStampRecord } from './stamp-projection';

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
    ownerAgentId: 'supervisor-1',
    ownerBrickGeneration: null,
    touched: [{ path: touchedPath, op: 'write' }],
  };
}

const supervisor = {
  id: 'supervisor-1', workspaceId: 'workspace-a', title: 'Save Card Lead',
  roleDescription: 'Coordinates the Save-card feature.', isSupervisor: true,
  isWorker: false, isSupervised: false, ownerAgentId: null,
} as Agent;
const worker = {
  id: 'shared-agent', workspaceId: 'workspace-a', title: 'Bundle Label Worker',
  roleDescription: 'Builds recognizable bundle labels.', isSupervisor: false,
  isWorker: true, isSupervised: true, ownerAgentId: 'supervisor-1',
} as Agent;

// Fake registry: two lanes sharing ONE worktree (packages/a, packages/b) plus a
// third registered workspace that is NOT in this repo — the adapter must pass all
// three and let the facade's scope discovery narrow to the shared worktree.
function fakeGetWorkspaces(): Array<{ id: string; path: string; title: string }> {
  return [
    { id: 'workspace-a', path: path.join(repo, 'packages', 'a'), title: 'Package A' },
    { id: 'workspace-b', path: path.join(repo, 'packages', 'b'), title: 'Package B' },
    { id: 'workspace-outside', path: outsideRepoDir, title: 'Computer Root' },
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

type RouteOverrides = Partial<Omit<Parameters<typeof createSaveCardRoutes>[0], 'gitExe'>>;

function buildRoutes(overrides: RouteOverrides = {}): SaveCardRoutes {
  return createSaveCardRoutes({
    gitExe,
    getWorkspaces: fakeGetWorkspaces,
    readTurnWitnesses: (workspaceId) => witnessRows[workspaceId] ?? [],
    readTurnRecord: (turnId): TurnStampRecord | null => {
      const workspaceId = Object.entries(witnessRows).find(([, rows]) =>
        rows.some((row) => row.turnId === turnId))?.[0];
      return workspaceId ? {
        id: turnId,
        workspaceId,
        planId: null,
        planItemId: null,
        planStampSource: 'legacy-unstamped',
      } : null;
    },
    readCaptureTurns: (workspaceId) => captureRows[workspaceId] ?? [],
    getAgentsByWorkspace: (workspaceId) => workspaceId === 'workspace-a' ? [supervisor, worker] : [],
    readBundleTurns: (workspaceId) => (captureRows[workspaceId] ?? []).map((turn, index) => ({
      id: turn.id,
      agentId: 'shared-agent',
      agentTitle: 'Bundle Label Worker',
      startedAt: Date.UTC(2026, 6, 30 + index),
      endedAt: Date.UTC(2026, 6, 30 + index),
    })),
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
    listPlanningActivities: () => [],
    ...overrides,
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
  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });

  // One component (attributed one.txt + two.txt) + the unattributed pseudo-bundle.
  const component = bundles.find((bundle) => bundle.kind === 'component');
  const unattributed = bundles.find((bundle) => bundle.kind === 'unattributed');
  assert.ok(component, 'expected an attributed component bundle');
  assert.ok(unattributed, 'expected the unattributed pseudo-bundle');
  assert.ok(component!.component, 'component bundle carries its ConflictComponent');
  assert.equal(component!.label, 'Save Card Lead');
  assert.equal(component!.identity?.roleDescription, 'Coordinates the Save-card feature.');
  assert.deepEqual(component!.identity?.workerUnits.map((unit) => unit.name), ['Bundle Label Worker']);

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

test('flagged production inventory returns intentUnits beside parity bundles', async () => {
  const routes = buildRoutes({
    intentPackaging: true,
    readTurnWitnesses: (workspaceId) => workspaceId === 'workspace-a'
      ? [{ ...witness('turn-a', 'one.txt'), agentId: 'agent-a', intentId: 'intent-task' }]
      : workspaceId === 'workspace-b'
        ? [{ ...witness('turn-b', 'two.txt'), agentId: 'agent-b', intentId: 'intent-task' }]
        : [],
    listSaveIntents: () => [{
      id: 'intent-task', workspaceId: 'workspace-a', executionRunId: null,
      repositoryKey: null, kind: 'task', planId: null, planItemId: null,
      title: 'Implement intent inventory', briefDigest: null,
      dispatchAttemptId: 'dispatch-1', createdBy: 'task-dispatch', createdById: null,
      state: 'open', revision: 1, createdAt: 1, readyAt: null, committedAt: null,
    }],
    listNamedSaveSetMembers: () => [],
    getAgent: () => null,
  });
  const inventory = await routes.getInventory({ workspaceId: 'workspace-a' });
  assert.ok(inventory.intentUnits, 'production route must expose flagged intentUnits');
  assert.equal(inventory.intentUnits!.length, 1,
    'one intent over disconnected agent topology remains one card');
  assert.deepEqual(
    inventory.intentUnits![0].members.map((member) => member.entry.path.displayPath).sort(),
    ['packages/a/one.txt', 'packages/b/two.txt'],
  );
  assert.deepEqual(
    inventory.intentUnits![0].members.map((member) => member.entry.entryId).sort(),
    inventory.bundles.filter((bundle) => bundle.kind === 'component')
      .flatMap((bundle) => bundle.members.map((member) => member.entry.entryId)).sort(),
    'intent and legacy bundle projections agree on identical evidence bytes',
  );
});

test('flagged inventory projects each planning activity as its own card with persisted conflicts', async () => {
  const pathBytesBase64 = Buffer.from('conflicted/path.ts').toString('base64');
  const routes = buildRoutes({
    intentPackaging: true,
    listSaveIntents: () => [], listNamedSaveSetMembers: () => [],
    listPlanningActivities: () => [{
      executionRunId: 'run-plan-b', planId: 'plan-b', logicalWorkspaceId: 'workspace-a',
      objectDatabaseKey: 'odb', activityRepositoryKey: 'activity', primaryRepositoryKey: 'primary',
      path: '/activity', baselineOid: 'a'.repeat(40), activityHeadRef: 'refs/lares/activities/run-plan-b/head',
      promotedHeadOid: null, state: 'merge-conflicted', failureCode: null, createdAt: 1, updatedAt: 2,
    }],
    listActivityMergeAttempts: () => [{
      id: 'attempt-b', executionRunId: 'run-plan-b', baseOid: 'a'.repeat(40),
      primaryHeadOid: 'b'.repeat(40), activityHeadOid: 'c'.repeat(40), proposedCommitOid: null,
      state: 'conflicted', startedAt: 2, endedAt: 3,
    }],
    listActivityMergeConflicts: () => [{
      attemptId: 'attempt-b', pathBytesBase64, baseBlobOid: '1'.repeat(40),
      primaryBlobOid: '2'.repeat(40), activityBlobOid: '3'.repeat(40),
      resolutionBlobOid: null, resolution: null,
    }],
    getPlan: (() => ({ id: 'plan-b', slug: 'Plan B', path: '/plan-b' })) as any,
  });
  const inventory = await routes.getInventory({ workspaceId: 'workspace-a' });
  assert.equal(inventory.planningActivities?.length, 1);
  assert.equal(inventory.planningActivities?.[0].status, 'merge-conflicted');
  assert.equal(inventory.planningActivities?.[0].conflicts[0].displayPath, 'conflicted/path.ts');
});

test('projects immutable turn stamps into Save-card plan labels', async () => {
  const routes = buildRoutes({
    readTurnRecord: (turnId) => ({
      id: turnId,
      workspaceId: turnId === 'turn-a' ? 'workspace-a' : 'workspace-b',
      planId: 'plan-frozen',
      planItemId: null,
      planStampSource: 'agent-default',
    }),
  });
  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
  const component = bundles.find((bundle) => bundle.kind === 'component');

  assert.ok(component);
  assert.ok(component.labels.includes('Plan plan-frozen'));
  assert.equal(component.labels.includes('Plan attribution unavailable — legacy-unstamped'), false);
});

test('candidate request carries every registered workspace so sibling lanes union', async () => {
  const routes = buildRoutes();
  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-b' });
  // Both in-repo lanes appear in the repository identity; the out-of-repo
  // workspace was passed as a candidate but narrowed out by scope discovery.
  const component = bundles.find((bundle) => bundle.kind === 'component')!;
  assert.deepEqual(component.workspaces, [
    { workspaceId: 'workspace-a', workspacePrefix: 'packages/a' },
    { workspaceId: 'workspace-b', workspacePrefix: 'packages/b' },
  ]);
});

// SC-WP-W5 — LIVE BLOCKER regression: saveability keys off the PANE's workspace,
// not a contributing agent's home workspace. A package whose files live in the
// pane's repo (workspace-a) is saveable EVEN WHEN a contributing agent's home is a
// repo-less "Computer Root" — the old code wrongly marked it unsavable, which
// refused every save Edward attempted.
test('a package contributed by an agent from a no-repo workspace is saveable in a repo-backed pane', async () => {
  const outsideAgent = {
    ...worker,
    workspaceId: 'workspace-outside',
    ownerAgentId: null,
  } as Agent;
  const routes = buildRoutes({
    readTurnWitnesses: (workspaceId) => workspaceId === 'workspace-a'
      ? [{ ...witness('turn-a', 'one.txt'), ownerAgentId: null }]
      : [],
    getAgentsByWorkspace: () => [],
    getAgent: (agentId) => agentId === outsideAgent.id ? outsideAgent : null,
  });

  // Pane is workspace-a, which HAS a repo and where the package's files live.
  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
  const component = bundles.find((bundle) => bundle.kind === 'component');
  assert.ok(component, 'expected the attributed component bundle');
  assert.deepEqual(component?.saveability, { saveable: true });
  // The unattributed pseudo-bundle in the same repo-backed pane is saveable too.
  const unattributed = bundles.find((bundle) => bundle.kind === 'unattributed');
  assert.deepEqual(unattributed?.saveability, { saveable: true });
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

test('mixed identity stays compact while retaining all forty worker sub-units', async () => {
  const agents = Array.from({ length: 40 }, (_, index) => ({
    id: `worker-${String(index).padStart(2, '0')}`,
    workspaceId: 'workspace-a',
    title: index === 0 ? 'app icon' : index === 1 ? 'Guard exit-code source fix' : `Agent ${index + 1}`,
    roleDescription: index === 0
      ? `First role memory jog ${'with deliberately verbose detail '.repeat(10)}`
      : `Distinct role description ${index + 1}`,
    isSupervisor: false,
    isWorker: true,
    isSupervised: false,
    ownerAgentId: null,
  } as Agent));
  const witnesses = agents.map((agent, index): TurnWitnessRead => ({
    turnId: `many-turn-${index}`,
    agentId: agent.id,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    touched: [{ path: 'one.txt', op: 'write' }],
  }));
  const captureTurns = agents.map((_, index) => captureTurn(`many-turn-${index}`));
  const routes = buildRoutes({
    readTurnWitnesses: (workspaceId) => workspaceId === 'workspace-a' ? witnesses : [],
    readCaptureTurns: (workspaceId) => workspaceId === 'workspace-a' ? captureTurns : [],
    getAgentsByWorkspace: (workspaceId) => workspaceId === 'workspace-a' ? agents : [],
    readBundleTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? agents.map((agent, index) => ({
        id: `many-turn-${index}`,
        agentId: agent.id,
        agentTitle: agent.title,
        startedAt: Date.UTC(2026, 6, 1, index),
        endedAt: Date.UTC(2026, 6, 1, index),
      }))
      : [],
  });

  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
  const identity = bundles.find((bundle) => bundle.kind === 'component')?.identity;
  assert.ok(identity, 'expected a mixed component identity');
  assert.equal(identity.source, 'mixed');
  assert.equal(identity.name, 'app icon, Guard exit-code source fix + 38 more agents');
  assert.ok(identity.name.length <= 80, `name exceeded clamp: ${identity.name.length}`);
  assert.match(identity.roleDescription, /^Overlapping work from 40 agents across 40 turns — First role memory jog/);
  assert.ok(
    identity.roleDescription.length <= 200,
    `role description exceeded clamp: ${identity.roleDescription.length}`,
  );
  assert.equal(identity.roleDescription.endsWith('…'), true);
  assert.equal(identity.workerUnits.length, 40);
});

test('single-owner identity applies the same hard text clamps', async () => {
  const longOwner = {
    ...supervisor,
    id: 'long-owner',
    title: 'Long owner title '.repeat(10),
    roleDescription: 'Long owner role description. '.repeat(20),
  } as Agent;
  const ownedWorker = { ...worker, ownerAgentId: longOwner.id } as Agent;
  const routes = buildRoutes({
    readTurnWitnesses: (workspaceId) => workspaceId === 'workspace-a'
      ? [{ ...witness('long-owner-turn', 'one.txt'), ownerAgentId: longOwner.id }]
      : [],
    readCaptureTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? [captureTurn('long-owner-turn')]
      : [],
    getAgentsByWorkspace: (workspaceId) => workspaceId === 'workspace-a'
      ? [longOwner, ownedWorker]
      : [],
    readBundleTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? [{
        id: 'long-owner-turn',
        agentId: ownedWorker.id,
        agentTitle: ownedWorker.title,
        startedAt: Date.UTC(2026, 6, 1),
        endedAt: Date.UTC(2026, 6, 1),
      }]
      : [],
  });

  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
  const identity = bundles.find((bundle) => bundle.kind === 'component')?.identity;
  assert.ok(identity, 'expected an owner identity');
  assert.equal(identity.source, 'supervisor');
  assert.ok(identity.name.length <= 80);
  assert.equal(identity.name.endsWith('…'), true);
  assert.ok(identity.roleDescription.length <= 200);
  assert.equal(identity.roleDescription.endsWith('…'), true);
});

test('SC-WP-1L.2 regression: a supervised agent with no owner edge is never attributed to a workspace supervisor', async () => {
  // Defect A: a lone, human-launched agent (isSupervised, ownerAgentId null) that
  // merely shares a workspace with a supervisor row must resolve to ITSELF — never
  // to the structurally-present supervisor that did not launch it. Owner resolution
  // uses only real data (witness/agent owner edges), so with none it stays 'agent'.
  const loneAgent = {
    id: 'lone-agent', workspaceId: 'workspace-a', title: 'minor tweeks',
    roleDescription: 'Human-launched lone agent.', isSupervisor: false,
    isWorker: false, isSupervised: true, ownerAgentId: null,
  } as Agent;
  const routes = buildRoutes({
    readTurnWitnesses: (workspaceId) => workspaceId === 'workspace-a'
      ? [{
        turnId: 'lone-turn', agentId: 'lone-agent', ownerAgentId: null,
        ownerBrickGeneration: null, touched: [{ path: 'one.txt', op: 'write' }],
      }]
      : [],
    readCaptureTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? [captureTurn('lone-turn')]
      : [],
    // The workspace ALSO carries a supervisor row — the structural-supervisor trap.
    getAgentsByWorkspace: (workspaceId) => workspaceId === 'workspace-a'
      ? [supervisor, loneAgent]
      : [],
    readBundleTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? [{
        id: 'lone-turn', agentId: 'lone-agent', agentTitle: 'minor tweeks',
        startedAt: Date.UTC(2026, 6, 1), endedAt: Date.UTC(2026, 6, 1),
      }]
      : [],
  });

  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
  const identity = bundles.find((bundle) => bundle.kind === 'component')?.identity;
  assert.ok(identity, 'expected a component identity');
  assert.equal(identity.source, 'agent');
  assert.equal(identity.agentId, 'lone-agent');
  assert.notEqual(identity.agentId, 'supervisor-1');
  assert.equal(identity.name, 'minor tweeks');
});

test('SC-WP-1L.2: a component with two distinct real owners resolves to mixed with no identity agent', async () => {
  const ownerX = {
    id: 'owner-x', workspaceId: 'workspace-a', title: 'Owner X', roleDescription: 'X.',
    isSupervisor: true, isWorker: false, isSupervised: false, ownerAgentId: null,
  } as Agent;
  const ownerY = {
    id: 'owner-y', workspaceId: 'workspace-a', title: 'Owner Y', roleDescription: 'Y.',
    isSupervisor: true, isWorker: false, isSupervised: false, ownerAgentId: null,
  } as Agent;
  const workerX = {
    id: 'worker-x', workspaceId: 'workspace-a', title: 'Worker X', roleDescription: 'wx.',
    isSupervisor: false, isWorker: true, isSupervised: true, ownerAgentId: 'owner-x',
  } as Agent;
  const workerY = {
    id: 'worker-y', workspaceId: 'workspace-a', title: 'Worker Y', roleDescription: 'wy.',
    isSupervisor: false, isWorker: true, isSupervised: true, ownerAgentId: 'owner-y',
  } as Agent;
  const routes = buildRoutes({
    readTurnWitnesses: (workspaceId) => workspaceId === 'workspace-a'
      ? [
        { turnId: 'turn-x', agentId: 'worker-x', ownerAgentId: 'owner-x', ownerBrickGeneration: null, touched: [{ path: 'one.txt', op: 'write' }] },
        { turnId: 'turn-y', agentId: 'worker-y', ownerAgentId: 'owner-y', ownerBrickGeneration: null, touched: [{ path: 'one.txt', op: 'write' }] },
      ]
      : [],
    readCaptureTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? [captureTurn('turn-x'), captureTurn('turn-y')]
      : [],
    getAgentsByWorkspace: (workspaceId) => workspaceId === 'workspace-a'
      ? [ownerX, ownerY, workerX, workerY]
      : [],
    readBundleTurns: (workspaceId) => workspaceId === 'workspace-a'
      ? [
        { id: 'turn-x', agentId: 'worker-x', agentTitle: 'Worker X', startedAt: Date.UTC(2026, 6, 1), endedAt: Date.UTC(2026, 6, 1) },
        { id: 'turn-y', agentId: 'worker-y', agentTitle: 'Worker Y', startedAt: Date.UTC(2026, 6, 2), endedAt: Date.UTC(2026, 6, 2) },
      ]
      : [],
  });

  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
  const identity = bundles.find((bundle) => bundle.kind === 'component')?.identity;
  assert.ok(identity, 'expected a component identity');
  assert.equal(identity.source, 'mixed');
  assert.equal(identity.agentId, null);
  assert.equal(identity.workerUnits.length, 2);
});

test('serialized DTOs never leak absolute filesystem paths or the git exe', async () => {
  const routes = buildRoutes();
  const { bundles } = await routes.getInventory({ workspaceId: 'workspace-a' });
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
  const inventory = await invoke({ workspaceId: 'workspace-a' }) as Awaited<
    ReturnType<SaveCardRoutes['getInventory']>
  >;
  assert.ok(inventory.bundles.some((bundle) => bundle.kind === 'component'));
});

test('surfaces the WP-2K quota-weakening warning on the inventory response', async () => {
  const warning = {
    quotaBytes: 536_870_912,
    usedBytes: 536_870_912,
    releasedEdges: [{ turnId: 'turn-a', edge: 'after' as const }],
    willWeakenPaths: ['entry-a'],
  };
  const routes = buildRoutes({ readQuotaWeakening: () => warning });
  const inventory = await routes.getInventory({ workspaceId: 'workspace-a' });
  assert.deepEqual(inventory.quotaWeakening, warning);

  // Absent seam ⇒ no warning (the banner stays silent).
  const silent = await buildRoutes().getInventory({ workspaceId: 'workspace-a' });
  assert.equal(silent.quotaWeakening, null);

  // The warning carries entry/turn identities only — never a raw path.
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes(repo), false);
  assert.equal(serialized.includes(repo.replace(/\\/g, '/')), false);
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
