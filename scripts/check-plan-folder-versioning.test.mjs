import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CHECKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-plan-folder-versioning.mjs');

function run(cwd, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function write(root, rel, content = '') {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function manifest(folder) {
  return JSON.stringify({
    schema_version: 1,
    plan_artifact_id: 'plan_1234abcd',
    plan_sku: folder,
    source_proposal: { artifact_id: 'prop_1234abcd', rel_path: '.lares/proposals/source.md' },
    responsibility_events: [],
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-versioning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  run(root, 'git', ['init', '--quiet']);
  run(root, 'git', ['config', 'user.name', 'Plan Checker Test']);
  run(root, 'git', ['config', 'user.email', 'plan-checker@example.invalid']);
  return root;
}

function check(root, expected) {
  return run(root, process.execPath, [CHECKER, '--check'], expected);
}

test('a superseded draft remains durable and must be tracked beside the winning synthesis', (t) => {
  const root = fixture(t);
  const folder = 'superseded draft case';
  const base = `.lares/plans/${folder}`;
  write(root, `${base}/plan.json`, manifest(folder));
  write(root, `${base}/deliberations/winning-synthesis.md`, 'winner');
  write(root, `${base}/deliberations/superseded-draft.md`, 'draft');
  run(root, 'git', ['add', `${base}/plan.json`, `${base}/deliberations/winning-synthesis.md`]);
  const result = check(root, 1);
  assert.match(result.stdout, /VIOLATION untracked-durable .*superseded-draft\.md/);
});

test('paths with spaces pass while lock and write-temp siblings stay local', (t) => {
  const root = fixture(t);
  const folder = 'plan folder with spaces';
  const base = `.lares/plans/${folder}`;
  write(root, `${base}/plan.json`, manifest(folder));
  write(root, `${base}/research/source notes.md`, 'notes');
  write(root, `${base}/plan.json.lock-owner`, 'lock');
  write(root, `${base}/plan.json.wtmp-123`, 'temp');
  run(root, 'git', ['add', `${base}/plan.json`, `${base}/research/source notes.md`]);
  const result = check(root, 0);
  assert.match(result.stdout, /LOCAL\s+.*plan\.json\.lock-owner/);
  assert.match(result.stdout, /LOCAL\s+.*plan\.json\.wtmp-123/);
});

test('.dashboard fallback is enforced, including tracked ephemeral files', (t) => {
  const root = fixture(t);
  const folder = 'fallback-plan';
  const base = `.dashboard/plans/${folder}`;
  write(root, `${base}/plan.json`, manifest(folder));
  write(root, `${base}/OVERVIEW.md`, 'overview');
  write(root, `${base}/plan.json.lock-stale`, 'stale lock');
  run(root, 'git', ['add', '-f', `${base}/plan.json`, `${base}/OVERVIEW.md`, `${base}/plan.json.lock-stale`]);
  const result = check(root, 1);
  assert.match(result.stdout, /VIOLATION tracked-ephemeral \.dashboard\/plans\/fallback-plan\/plan\.json\.lock-stale/);
});

test('an untracked or invalid plan.json makes the plan folder fail', (t) => {
  const root = fixture(t);
  const folder = 'invalid-plan';
  const base = `.lares/plans/${folder}`;
  write(root, `${base}/plan.json`, '{not json');
  write(root, `${base}/plan.md`, 'plan');
  run(root, 'git', ['add', `${base}/plan.md`]);
  let result = check(root, 1);
  assert.match(result.stdout, /VIOLATION missing-tracked-plan-json/);
  run(root, 'git', ['add', `${base}/plan.json`]);
  result = check(root, 1);
  assert.match(result.stdout, /VIOLATION invalid-tracked-plan-json/);
});
