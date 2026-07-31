// SC-WP-1E shared live-edge verifier.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/live-edge.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit } from './git-command';
import { verifyLiveEdge, type LiveEdgeRunGit } from './live-edge';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

let gitExe = '';
let repo = '';
let commitOid = '';
const REF = 'refs/lares/checkpoints/test/live';

function git(args: string[]): string {
  return execFileSync(gitExe, args, { cwd: repo }).toString('utf8').trim();
}

test('real ref peeled to commit and equal to stored OID is live', async () => {
  assert.equal(await verifyLiveEdge({
    repoRoot: repo,
    ref: REF,
    oid: commitOid,
    runGit,
    gitExe,
  }), true);
});

test('real missing ref is not live', async () => {
  assert.equal(await verifyLiveEdge({
    repoRoot: repo,
    ref: 'refs/lares/checkpoints/test/missing',
    oid: commitOid,
    runGit,
    gitExe,
  }), false);
});

test('real ref resolving to a different stored OID is not live', async () => {
  assert.equal(await verifyLiveEdge({
    repoRoot: repo,
    ref: REF,
    oid: '0'.repeat(commitOid.length),
    runGit,
    gitExe,
  }), false);
});

test('missing ref or OID short-circuits without invoking Git', async () => {
  let calls = 0;
  const fake: LiveEdgeRunGit = async () => {
    calls++;
    return { code: 0, stdout: commitOid, stderr: '' };
  };
  assert.equal(await verifyLiveEdge({ repoRoot: repo, ref: null, oid: commitOid, runGit: fake }), false);
  assert.equal(await verifyLiveEdge({ repoRoot: repo, ref: REF, oid: null, runGit: fake }), false);
  assert.equal(calls, 0);
});

test('Git execution failure degrades to false', async () => {
  const fake: LiveEdgeRunGit = async () => { throw new Error('git unavailable'); };
  assert.equal(await verifyLiveEdge({
    repoRoot: repo,
    ref: REF,
    oid: commitOid,
    runGit: fake,
  }), false);
});

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  FAIL no compatible Git resolved; live-edge tests require real Git.');
    process.exit(1);
  }
  gitExe = internal.execPath;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-live-edge-'));

  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@lares.local']);
    git(['config', 'user.name', 'Lares Test']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'live edge\n');
    git(['add', '--', 'tracked.txt']);
    git(['commit', '-q', '-m', 'fixture']);
    commitOid = git(['rev-parse', 'HEAD']);
    git(['update-ref', REF, commitOid]);

    let passed = 0;
    let failed = 0;
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
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
})();
