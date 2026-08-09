import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type {
  PlanningActivityWorktree,
  PlanningActivityWorktreeState,
} from '../database';
import type { RunGitOptions } from './git-command';
import {
  advancePlanningActivityHead,
  cleanupPlanningActivity,
  planningActivityHeadRef,
  provisionPlanningActivity,
  type PlanningGitRunner,
} from './planning-worktree-service';

const git: PlanningGitRunner = (cwd, args, opts) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: opts.timeoutMs,
    maxBuffer: opts.maxBytes,
  }, (error, stdout, stderr) => {
    const code = typeof (error as NodeJS.ErrnoException & { code?: number })?.code === 'number'
      ? (error as NodeJS.ErrnoException & { code: number }).code : error ? 1 : 0;
    if (error && !opts.allowNonzero) reject(error);
    else resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  }).stdin?.end(opts.stdin);
});

function gitSync(cwd: string, args: string[]): string {
  return String(execFileSyncUtf8('git', args, cwd)).trim();
}

function execFileSyncUtf8(exe: string, args: string[], cwd: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:child_process').execFileSync(exe, args, { cwd, windowsHide: true });
}

function scratchRepo(): { root: string; repo: string; appData: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp5-'));
  const repo = path.join(root, 'primary');
  const appData = path.join(root, 'app-user-data');
  fs.mkdirSync(repo);
  gitSync(repo, ['init']);
  gitSync(repo, ['config', 'user.name', 'Lares Test']);
  gitSync(repo, ['config', 'user.email', 'lares@example.invalid']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  gitSync(repo, ['add', 'tracked.txt']);
  gitSync(repo, ['commit', '-m', 'baseline']);
  return { root, repo, appData, head: gitSync(repo, ['rev-parse', 'HEAD']) };
}

function memoryStore() {
  const rows = new Map<string, PlanningActivityWorktree>();
  return {
    rows,
    getExisting: (id: string) => rows.get(id) ?? null,
    insertProvisioning: (row: PlanningActivityWorktree) => {
      rows.set(row.executionRunId, { ...row });
      return rows.get(row.executionRunId)!;
    },
    updateActivity: (input: {
      executionRunId: string; activityRepositoryKey?: string; objectDatabaseKey?: string;
      state?: PlanningActivityWorktreeState; failureCode?: string | null; updatedAt: number;
    }) => {
      const row = rows.get(input.executionRunId)!;
      const next = {
        ...row,
        activityRepositoryKey: input.activityRepositoryKey ?? row.activityRepositoryKey,
        objectDatabaseKey: input.objectDatabaseKey ?? row.objectDatabaseKey,
        state: input.state ?? row.state,
        failureCode: input.failureCode === undefined ? row.failureCode : input.failureCode,
        updatedAt: input.updatedAt,
      };
      rows.set(input.executionRunId, next);
      return next;
    },
  };
}

test('real git worktree add provisions one detached app-owned activity root', async (t) => {
  const fixture = scratchRepo();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const store = memoryStore();
  const result = await provisionPlanningActivity({
    executionRunId: 'run / unicode Ω', planId: 'plan-1', logicalWorkspaceId: 'workspace-1',
    primaryRepoRoot: fixture.repo, appUserDataPath: fixture.appData, createdAt: 100,
  }, {
    runGit: git, getExisting: store.getExisting, insertProvisioning: store.insertProvisioning,
    updateActivity: store.updateActivity, recheckEligibility: async () => true,
    probeHead: async () => fixture.head,
    activate: (row) => { store.updateActivity({ executionRunId: row.executionRunId, state: 'active', updatedAt: 101 }); },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(path.relative(fixture.repo, result.activity.path).startsWith('..'), true);
  assert.equal(gitSync(result.activity.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  assert.equal(gitSync(result.activity.path, ['rev-parse', 'HEAD']), fixture.head);
  assert.equal(gitSync(fixture.repo, ['rev-parse', planningActivityHeadRef('run / unicode Ω')]), fixture.head);
  assert.notEqual(result.activity.activityRepositoryKey, result.activity.primaryRepositoryKey);
  assert.equal(result.activity.state, 'active');
});

for (const crashStep of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
  test(`creation sequence crash fixture after step ${crashStep}`, async (t) => {
    const fixture = scratchRepo();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const store = memoryStore();
    const seen: number[] = [];
    const result = await provisionPlanningActivity({
      executionRunId: `run-${crashStep}`, planId: 'plan-1', logicalWorkspaceId: 'workspace-1',
      primaryRepoRoot: fixture.repo, appUserDataPath: fixture.appData, createdAt: 100,
    }, {
      runGit: git, getExisting: store.getExisting, insertProvisioning: store.insertProvisioning,
      updateActivity: store.updateActivity, recheckEligibility: async () => true,
      probeHead: async () => fixture.head,
      activate: (row) => { store.updateActivity({ executionRunId: row.executionRunId, state: 'active', updatedAt: 101 }); },
      afterStep: (step) => { seen.push(step); if (step === crashStep) throw new Error(`crash-${step}`); },
    });
    assert.equal(result.ok, false);
    assert.equal(seen.at(-1), crashStep);
    const row = store.rows.get(`run-${crashStep}`);
    if (crashStep < 4) assert.equal(row, undefined);
    else assert.ok(row, 'step 4+ must leave a durable recoverable row');
    if (crashStep >= 8) assert.equal(row?.state, 'active');
    else if (row) assert.equal(row.state, 'provisioning');
  });
}

test('activity HEAD and durable ref advance in one CAS transaction', async (t) => {
  const fixture = scratchRepo();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const store = memoryStore();
  const result = await provisionPlanningActivity({
    executionRunId: 'run-save', planId: 'plan-1', logicalWorkspaceId: 'workspace-1',
    primaryRepoRoot: fixture.repo, appUserDataPath: fixture.appData, createdAt: 100,
  }, {
    runGit: git, getExisting: store.getExisting, insertProvisioning: store.insertProvisioning,
    updateActivity: store.updateActivity, recheckEligibility: async () => true,
    probeHead: async () => fixture.head,
    activate: (row) => { store.updateActivity({ executionRunId: row.executionRunId, state: 'active', updatedAt: 101 }); },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const tree = gitSync(result.activity.path, ['write-tree']);
  const commit = gitSync(result.activity.path, [
    '-c', 'user.name=Lares Test', '-c', 'user.email=lares@example.invalid',
    'commit-tree', tree, '-p', fixture.head, '-m', 'save',
  ]);
  const advanced = await advancePlanningActivityHead({
    activityPath: result.activity.path, activityHeadRef: result.activity.activityHeadRef,
    expectedOldOid: fixture.head, newOid: commit, runGit: git,
  });
  assert.equal(advanced.ok, true, advanced.diagnostic);
  assert.equal(gitSync(result.activity.path, ['rev-parse', 'HEAD']), commit);
  assert.equal(gitSync(fixture.repo, ['rev-parse', result.activity.activityHeadRef]), commit);
});

test('cleanup requires every proof and uses only non-forced worktree removal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp6-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activityPath = path.join(root, 'activity');
  fs.mkdirSync(activityPath);
  fs.writeFileSync(path.join(activityPath, '.lares-planning-worktree.json'), JSON.stringify({
    owner: 'lares', version: 1, executionRunId: 'run-cleanup',
  }));
  const oid = 'a'.repeat(40);
  const activity: PlanningActivityWorktree = {
    executionRunId: 'run-cleanup', planId: 'plan', logicalWorkspaceId: 'ws',
    objectDatabaseKey: 'odb', activityRepositoryKey: 'activity', primaryRepositoryKey: 'primary',
    path: activityPath, baselineOid: oid, activityHeadRef: 'refs/lares/activities/run-cleanup/head',
    promotedHeadOid: oid, state: 'merged', failureCode: null, createdAt: 1, updatedAt: 1,
  };
  const commands: string[][] = [];
  const result = await cleanupPlanningActivity({
    executionRunId: activity.executionRunId, primaryRepoRoot: root, activityCompleted: true,
  }, {
    getActivity: () => activity,
    updateActivity: (input) => { Object.assign(activity, input); return activity; },
    hasLiveLease: () => false, hasPendingMerge: () => false, now: () => 2,
    runGit: async (_cwd, args) => {
      commands.push(args);
      if (args[0] === 'status') return { code: 0, stdout: '?? .lares-planning-worktree.json\n', stderr: '' };
      return { code: 0, stdout: `${oid}\n`, stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(activity.state, 'cleaned');
  const remove = commands.find((args) => args[0] === 'worktree' && args[1] === 'remove');
  assert.ok(remove);
  assert.equal(remove.includes('--force'), false);
});

test('cleanup proof failure marks recovery-required and performs no deletion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp6-cleanup-refuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activity: PlanningActivityWorktree = {
    executionRunId: 'run-refuse', planId: 'plan', logicalWorkspaceId: 'ws', objectDatabaseKey: 'odb',
    activityRepositoryKey: 'activity', primaryRepositoryKey: 'primary', path: root,
    baselineOid: 'a'.repeat(40), activityHeadRef: 'refs/lares/activities/run-refuse/head',
    promotedHeadOid: null, state: 'merged', failureCode: null, createdAt: 1, updatedAt: 1,
  };
  const commands: string[][] = [];
  const result = await cleanupPlanningActivity({
    executionRunId: activity.executionRunId, primaryRepoRoot: root, activityCompleted: true,
  }, {
    getActivity: () => activity,
    updateActivity: (input) => { Object.assign(activity, input); return activity; },
    hasLiveLease: () => true, hasPendingMerge: () => true,
    runGit: async (_cwd, args) => { commands.push(args); return { code: 1, stdout: '', stderr: '' }; },
  });
  assert.equal(result.ok, false);
  assert.equal(activity.state, 'recovery-required');
  assert.equal(commands.some((args) => args[0] === 'worktree' && args[1] === 'remove'), false);
});
