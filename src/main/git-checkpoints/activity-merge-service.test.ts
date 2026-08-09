import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { ActivityMergeAttempt, ActivityMergeConflict, PlanningActivityWorktree } from '../database';
import type { GitRunBytesResult, GitRunResult, RunGitOptions } from './git-command';
import { ActivityMergeService, type ActivityMergeStore } from './activity-merge-service';

function exec(cwd: string, args: string[], opts: RunGitOptions, bytes: true): Promise<GitRunBytesResult>;
function exec(cwd: string, args: string[], opts: RunGitOptions, bytes?: false): Promise<GitRunResult>;
function exec(cwd: string, args: string[], opts: RunGitOptions, bytes = false): Promise<GitRunResult | GitRunBytesResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env, ...(opts.indexFile ? { GIT_INDEX_FILE: opts.indexFile } : {}) };
    const child = execFile('git', args, { cwd, env, windowsHide: true, encoding: bytes ? 'buffer' : 'utf8',
      timeout: opts.timeoutMs, maxBuffer: opts.maxBytes }, (error, stdout, stderr) => {
      const code = error ? 1 : 0;
      if (error && !opts.allowNonzero) reject(error);
      else resolve({ code, stdout: bytes ? Buffer.from(stdout as Buffer) : String(stdout), stderr: String(stderr) } as GitRunResult & GitRunBytesResult);
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin); else child.stdin?.end();
  });
}
const runGit = (cwd: string, args: string[], opts: RunGitOptions) => exec(cwd, args, opts);
const runGitBytes = (cwd: string, args: string[], opts: RunGitOptions) => exec(cwd, args, opts, true);
const git = (cwd: string, ...args: string[]) => String(execFileSync('git', args, { cwd, windowsHide: true })).trim();
const BASE_LINES = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
const BASE_SHARED = `${BASE_LINES.join('\n')}\n`;
const MAIN_SHARED = `${BASE_LINES.map((line, index) => index === 0 ? 'MAIN ONE' : line).join('\n')}\n`;
const PLAN_SHARED = `${BASE_LINES.map((line, index) => index === 39 ? 'PLAN FORTY' : line).join('\n')}\n`;

function fixture(): { root: string; primary: string; activity: string; row: PlanningActivityWorktree; store: ActivityMergeStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-merge-'));
  const primary = path.join(root, 'primary');
  const activity = path.join(root, 'activity');
  fs.mkdirSync(primary);
  git(primary, 'init'); git(primary, 'config', 'user.email', 'test@lares.local'); git(primary, 'config', 'user.name', 'Lares Test');
  git(primary, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(primary, 'shared.txt'), BASE_SHARED);
  fs.writeFileSync(path.join(primary, 'unrelated.txt'), 'base\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'base');
  const base = git(primary, 'rev-parse', 'HEAD');
  const ref = 'refs/lares/activities/run-1/head';
  git(primary, 'update-ref', ref, base);
  git(primary, 'worktree', 'add', '--detach', activity, ref);
  const row: PlanningActivityWorktree = {
    executionRunId: 'run-1', planId: 'plan-b', logicalWorkspaceId: 'ws',
    objectDatabaseKey: 'odb', activityRepositoryKey: 'activity-key', primaryRepositoryKey: 'primary-key',
    path: activity, baselineOid: base, activityHeadRef: ref, promotedHeadOid: null,
    state: 'active', failureCode: null, createdAt: 1, updatedAt: 1,
  };
  const attempts: ActivityMergeAttempt[] = [];
  const conflicts = new Map<string, ActivityMergeConflict[]>();
  const store: ActivityMergeStore = {
    getActivity: () => row,
    getAttempt: (id) => attempts.find((a) => a.id === id) ?? null,
    listAttempts: () => [...attempts].sort((a, b) => b.startedAt - a.startedAt),
    listConflicts: (id) => conflicts.get(id) ?? [],
    insertAttempt: (a) => { attempts.push({ ...a }); return attempts.at(-1)!; },
    updateAttempt: (input) => {
      const current = attempts.find((a) => a.id === input.id)!;
      Object.assign(current, input); return current;
    },
    replaceConflicts: (id, rows) => conflicts.set(id, rows.map((r) => ({ ...r }))),
    resolveConflict: (input) => {
      const found = conflicts.get(input.attemptId)?.find((r) => r.pathBytesBase64 === input.pathBytesBase64) ?? null;
      if (found) Object.assign(found, input); return found;
    },
    updateActivity: (input) => { Object.assign(row, input); return row; },
  };
  return { root, primary, activity, row, store };
}

function activityCommit(f: ReturnType<typeof fixture>, mutate: () => void): string {
  mutate(); git(f.activity, 'add', '-A'); git(f.activity, 'commit', '-m', 'plan task');
  const head = git(f.activity, 'rev-parse', 'HEAD');
  git(f.primary, 'update-ref', f.row.activityHeadRef, head, f.row.baselineOid);
  return head;
}

test('scenario 5: compatible same-file activity promotion preserves unrelated primary dirt', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  activityCommit(f, () => fs.writeFileSync(path.join(f.activity, 'shared.txt'), PLAN_SHARED));
  fs.writeFileSync(path.join(f.primary, 'shared.txt'), MAIN_SHARED);
  git(f.primary, 'add', 'shared.txt'); git(f.primary, 'commit', '-m', 'other plan');
  fs.writeFileSync(path.join(f.primary, 'unrelated.txt'), 'human dirt\n');
  const service = new ActivityMergeService({ runGit, runGitBytes, store: f.store,
    resolvePrimaryPath: () => f.primary, newAttemptId: () => 'merge-compatible', now: () => 10 });
  const result = await service.promote('run-1');
  assert.equal(result.status, 'promoted');
  assert.equal(fs.readFileSync(path.join(f.primary, 'shared.txt'), 'utf8'),
    `${BASE_LINES.map((line, index) => index === 0 ? 'MAIN ONE' : index === 39 ? 'PLAN FORTY' : line).join('\n')}\n`);
  assert.equal(fs.readFileSync(path.join(f.primary, 'unrelated.txt'), 'utf8'), 'human dirt\n');
  assert.equal(git(f.primary, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
});

test('scenario 6: incompatible plan commits persist exact conflicts and leave primary untouched', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  activityCommit(f, () => fs.writeFileSync(path.join(f.activity, 'shared.txt'),
    `${BASE_LINES.map((line, index) => index === 20 ? 'PLAN B' : line).join('\n')}\n`));
  const planA = `${BASE_LINES.map((line, index) => index === 20 ? 'PLAN A' : line).join('\n')}\n`;
  fs.writeFileSync(path.join(f.primary, 'shared.txt'), planA);
  git(f.primary, 'add', 'shared.txt'); git(f.primary, 'commit', '-m', 'plan A');
  const before = git(f.primary, 'rev-parse', 'HEAD');
  const service = new ActivityMergeService({ runGit, runGitBytes, store: f.store,
    resolvePrimaryPath: () => f.primary, newAttemptId: () => 'merge-conflict', now: () => 20 });
  const result = await service.promote('run-1');
  assert.equal(result.status, 'conflicted');
  assert.equal(git(f.primary, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(f.primary, 'shared.txt'), 'utf8'), planA);
  assert.equal(f.row.state, 'merge-conflicted');
  assert.deepEqual(result.status === 'conflicted' && result.conflicts.map((c) => c.pathBytesBase64),
    [Buffer.from('shared.txt').toString('base64')]);
  if (result.status !== 'conflicted') return;
  const resolved = await service.resolveAndPromote({ attemptId: result.attemptId, resolutions: [{
    pathBytesBase64: result.conflicts[0].pathBytesBase64, resolution: 'take-activity',
  }] });
  assert.equal(resolved.status, 'promoted');
  assert.equal(fs.readFileSync(path.join(f.primary, 'shared.txt'), 'utf8'),
    `${BASE_LINES.map((line, index) => index === 20 ? 'PLAN B' : line).join('\n')}\n`);
  assert.equal(git(f.primary, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3,
    'resolution retains both already-attributable plan commits');
});

test('scenario 10: merge CAS race marks stale and never clobbers the racing commit', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  activityCommit(f, () => fs.writeFileSync(path.join(f.activity, 'shared.txt'), PLAN_SHARED));
  const service = new ActivityMergeService({ runGit, runGitBytes, store: f.store,
    resolvePrimaryPath: () => f.primary, newAttemptId: () => 'merge-race', now: () => 30,
    afterTentativeCommit: () => { git(f.primary, 'commit', '--allow-empty', '-m', 'racing head'); },
  });
  const result = await service.promote('run-1');
  assert.equal(result.status, 'stale');
  assert.equal(git(f.primary, 'log', '-1', '--format=%s'), 'racing head');
  assert.equal(f.row.state, 'merge-pending');
});

test('an affected primary path already equal to the merged result is safe to reconcile', async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  activityCommit(f, () => fs.writeFileSync(path.join(f.activity, 'shared.txt'), PLAN_SHARED));
  fs.writeFileSync(path.join(f.primary, 'shared.txt'), PLAN_SHARED);
  git(f.primary, 'add', 'shared.txt');
  const service = new ActivityMergeService({ runGit, runGitBytes, store: f.store,
    resolvePrimaryPath: () => f.primary, newAttemptId: () => 'already-merged', now: () => 40 });
  assert.equal((await service.promote('run-1')).status, 'promoted');
  assert.equal(git(f.primary, 'status', '--porcelain', '--', 'shared.txt'), '');
});

test('scenario 4: two plans touching different files promote independently into one primary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-merge-two-plans-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary'); fs.mkdirSync(primary);
  git(primary, 'init'); git(primary, 'config', 'user.email', 'test@lares.local');
  git(primary, 'config', 'user.name', 'Lares Test'); git(primary, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(primary, 'a.txt'), 'a0\n'); fs.writeFileSync(path.join(primary, 'b.txt'), 'b0\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'base');
  const base = git(primary, 'rev-parse', 'HEAD');
  const rows = new Map<string, PlanningActivityWorktree>();
  for (const id of ['run-a', 'run-b']) {
    const ref = `refs/lares/activities/${id}/head`; const activityPath = path.join(root, id);
    git(primary, 'update-ref', ref, base); git(primary, 'worktree', 'add', '--detach', activityPath, ref);
    rows.set(id, { executionRunId: id, planId: id, logicalWorkspaceId: 'ws', objectDatabaseKey: 'odb',
      activityRepositoryKey: id, primaryRepositoryKey: 'primary', path: activityPath, baselineOid: base,
      activityHeadRef: ref, promotedHeadOid: null, state: 'active', failureCode: null, createdAt: 1, updatedAt: 1 });
  }
  fs.writeFileSync(path.join(rows.get('run-a')!.path, 'a.txt'), 'a1\n');
  git(rows.get('run-a')!.path, 'add', 'a.txt'); git(rows.get('run-a')!.path, 'commit', '-m', 'plan a');
  fs.writeFileSync(path.join(rows.get('run-b')!.path, 'b.txt'), 'b1\n');
  git(rows.get('run-b')!.path, 'add', 'b.txt'); git(rows.get('run-b')!.path, 'commit', '-m', 'plan b');
  for (const row of rows.values()) git(primary, 'update-ref', row.activityHeadRef, git(row.path, 'rev-parse', 'HEAD'), base);
  const attempts: ActivityMergeAttempt[] = []; const conflicts = new Map<string, ActivityMergeConflict[]>();
  const store: ActivityMergeStore = {
    getActivity: (id) => rows.get(id) ?? null, getAttempt: (id) => attempts.find((a) => a.id === id) ?? null,
    listAttempts: (id) => attempts.filter((a) => a.executionRunId === id).reverse(),
    listConflicts: (id) => conflicts.get(id) ?? [], insertAttempt: (a) => { attempts.push({ ...a }); return attempts.at(-1)!; },
    updateAttempt: (input) => { const found = attempts.find((a) => a.id === input.id)!; Object.assign(found, input); return found; },
    replaceConflicts: (id, values) => conflicts.set(id, values.map((v) => ({ ...v }))), resolveConflict: () => null,
    updateActivity: (input) => { const found = rows.get(input.executionRunId)!; Object.assign(found, input); return found; },
  };
  let seq = 0;
  const service = new ActivityMergeService({ runGit, runGitBytes, store, resolvePrimaryPath: () => primary,
    newAttemptId: () => `attempt-${++seq}`, now: () => seq });
  assert.equal((await service.promote('run-a')).status, 'promoted');
  assert.equal((await service.promote('run-b')).status, 'promoted');
  assert.equal(fs.readFileSync(path.join(primary, 'a.txt'), 'utf8'), 'a1\n');
  assert.equal(fs.readFileSync(path.join(primary, 'b.txt'), 'utf8'), 'b1\n');
});
