// WP-3 concurrency policy fixtures: real checkpoint trees, including pruned
// evidence. Run after `npm run build:main`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import { runGit } from './git-command';
import {
  classifyPathConcurrency,
  observePathIntents,
  projectConcurrencyActions,
  type PathIntentCheckpointEvidence,
} from './concurrency-policy';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void { tests.push({ name, run }); }

const gitExe = 'git';

function git(cwd: string, args: string[], stdin?: string): string {
  const result = spawnSync(gitExe, args, {
    cwd, input: stdin, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Lares Test', GIT_AUTHOR_EMAIL: 'test@lares.local',
      GIT_COMMITTER_NAME: 'Lares Test', GIT_COMMITTER_EMAIL: 'test@lares.local' },
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lares-concurrency-'));
  git(root, ['init', '--quiet']);
  const blob = (body: string) => git(root, ['hash-object', '-w', '--stdin'], body);
  const tree = (oid: string) => git(root, ['mktree'], `100644 blob ${oid}\tshared.txt\n`);
  const commit = (treeOid: string, parent?: string) => git(
    root, ['commit-tree', treeOid, ...(parent ? ['-p', parent] : [])], 'fixture\n',
  );
  const baseBlob = blob('base\n');
  const alphaBlob = blob('alpha\n');
  const betaBlob = blob('beta\n');
  const base = commit(tree(baseBlob));
  const alpha = commit(tree(alphaBlob), base);
  const beta = commit(tree(betaBlob), base);
  const carriedBeta = commit(tree(betaBlob), alpha);
  return { root, baseBlob, alphaBlob, betaBlob, base, alpha, beta, carriedBeta };
}

const path = encodeGitPath(Buffer.from('shared.txt'));
function turn(
  intentId: string,
  turnId: string,
  beforeCommitOid: string | null,
  afterCommitOid: string | null,
  startedAt: number,
  endedAt: number,
): PathIntentCheckpointEvidence {
  return { intentId, turnId, agentId: `agent-${turnId}`, beforeCommitOid, afterCommitOid, startedAt, endedAt };
}

async function observed(
  f: ReturnType<typeof fixture>,
  turns: PathIntentCheckpointEvidence[],
  finalBlobOid: string | null,
) {
  return observePathIntents({
    repoRoot: f.root, gitExe, repositoryKey: 'repo', path, finalBlobOid, turns, runGit,
  });
}

test('real checkpoint trees classify all four mechanically provable classes', async () => {
  const f = fixture();
  try {
    const same = classifyPathConcurrency(await observed(f, [
      turn('intent-a', 'a1', f.base, f.alpha, 1, 2),
      turn('intent-a', 'a2', f.alpha, f.carriedBeta, 3, 4),
    ], f.betaBlob));
    assert.equal(same[0].classification, 'same-intent-coauthor');

    const convergent = classifyPathConcurrency(await observed(f, [
      turn('intent-a', 'a', f.base, f.beta, 1, 2),
      turn('intent-b', 'b', f.base, f.carriedBeta, 3, 4),
    ], f.betaBlob));
    assert.equal(convergent[0].classification, 'cross-intent-convergent');

    const carried = classifyPathConcurrency(await observed(f, [
      turn('intent-a', 'a', f.base, f.alpha, 1, 2),
      turn('intent-b', 'b', f.alpha, f.carriedBeta, 3, 4),
    ], f.betaBlob));
    assert.equal(carried[0].classification, 'cross-intent-carried-forward');
    assert.equal(carried[0].blocking, false);
    assert.equal(projectConcurrencyActions(carried).nonBlockingNotes.length, 1);

    const lost = classifyPathConcurrency(await observed(f, [
      turn('intent-a', 'a', f.base, f.alpha, 1, 2),
      turn('intent-b', 'b', f.base, f.beta, 3, 4),
    ], f.betaBlob));
    assert.equal(lost[0].classification, 'cross-intent-suspected-lost-update');
    assert.equal(lost[0].blocking, true);
    const projected = projectConcurrencyActions(lost);
    assert.equal(projected.blockingAtoms.length, 1);
    assert.equal(projected.blockingAtoms[0].kind, 'cross-intent');
    const witnessChanged = classifyPathConcurrency(await observed(f, [
      turn('intent-a', 'a-recaptured', f.base, f.alpha, 1, 2),
      turn('intent-b', 'b', f.base, f.beta, 3, 4),
    ], f.betaBlob));
    assert.notEqual(witnessChanged[0].evidenceDigest, lost[0].evidenceDigest);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('missing or pruned checkpoint evidence is incomplete and never a collision', async () => {
  const f = fixture();
  try {
    const observations = await observed(f, [
      turn('intent-a', 'a', f.base, f.alpha, 1, 2),
      turn('intent-b', 'b', '0000000000000000000000000000000000000000', null, 3, 4),
    ], f.betaBlob);
    const result = classifyPathConcurrency(observations);
    assert.equal(observations[1].evidenceQuality, 'partial');
    assert.equal(result[0].classification, 'evidence-incomplete');
    assert.equal(result[0].blocking, false);
    assert.deepEqual(projectConcurrencyActions(result).blockingAtoms, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('one contested path emits exactly one picker atom per intent pair', async () => {
  const f = fixture();
  try {
    const result = classifyPathConcurrency(await observed(f, [
      turn('intent-a', 'a1', f.base, f.alpha, 1, 2),
      turn('intent-a', 'a2', f.base, f.alpha, 1, 2),
      turn('intent-b', 'b1', f.base, f.beta, 3, 4),
    ], f.betaBlob));
    assert.equal(result.length, 1);
    assert.equal(projectConcurrencyActions(result).blockingAtoms.length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

void (async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (error) { failed++; console.error(`  FAIL ${t.name}`); console.error(error); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
