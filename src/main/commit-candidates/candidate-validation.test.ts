import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  candidateCommitSigningArgs,
  readCandidateCommitPolicy,
  validateCandidateTree,
} from './candidate-validation';
import { runGit } from '../git-checkpoints/git-command';
import { resolveInternalGit } from '../git/git-runtime';

let gitExe = '';
const trash: string[] = [];

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(gitExe, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}

function initRepo(): string {
  const repo = temp('lares-candidate-validation-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Validation Test']);
  git(repo, ['config', 'user.email', 'validation@lares.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

function treeFromPaths(repo: string, paths: string[]): string {
  const indexFile = path.join(temp('lares-candidate-index-'), 'index');
  const env = { GIT_INDEX_FILE: indexFile };
  git(repo, ['read-tree', 'HEAD'], env);
  for (const relative of paths) {
    const oid = git(repo, ['hash-object', '-w', '--', relative]).trim();
    git(repo, ['update-index', '--add', '--cacheinfo', '100644', oid, relative], env);
  }
  return git(repo, ['write-tree'], env).trim();
}

async function validationFixture(): Promise<void> {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'main.cjs'), "const dep = require('./dependent.cjs'); if (dep !== 1) throw new Error('mismatch');\n");
  fs.writeFileSync(path.join(repo, 'dependent.cjs'), 'module.exports = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);

  // The dirty worktree is internally complete. A candidate omitting dependent.cjs
  // must nevertheless fail because validation materializes the candidate tree.
  fs.writeFileSync(path.join(repo, 'main.cjs'), "const dep = require('./dependent.cjs'); if (dep !== 2) throw new Error('mismatch');\n");
  fs.writeFileSync(path.join(repo, 'dependent.cjs'), 'module.exports = 2;\n');
  const incompleteTree = treeFromPaths(repo, ['main.cjs']);
  const completeTree = treeFromPaths(repo, ['main.cjs', 'dependent.cjs']);
  git(repo, ['config', 'lares.candidateValidation.enabled', 'true']);
  git(repo, ['config', '--add', 'lares.candidateValidation.command', 'node main.cjs']);

  const policy = await readCandidateCommitPolicy({ repoRoot: repo, gitExe, runGit });
  assert.equal(policy.validation.enabled, true);
  assert.deepEqual(policy.validation.commands, ['node main.cjs']);
  assert.equal(policy.signing.enabled, false, 'signing stays off unless separately opted in');

  const incomplete = await validateCandidateTree({ repoRoot: repo, gitExe, runGit, treeOid: incompleteTree, policy: policy.validation });
  assert.equal(incomplete.ok, false, 'dependent-file-omitted candidate tree must refuse');
  const complete = await validateCandidateTree({ repoRoot: repo, gitExe, runGit, treeOid: completeTree, policy: policy.validation });
  assert.deepEqual(complete, { ok: true }, 'complete candidate tree must pass');
}

async function defaultOffFixture(): Promise<void> {
  const repo = initRepo();
  const policy = await readCandidateCommitPolicy({ repoRoot: repo, gitExe, runGit });
  assert.deepEqual(policy, {
    validation: { enabled: false, commands: [], timeoutMs: 600_000 },
    signing: { enabled: false, signingKey: null },
  });
  assert.deepEqual(candidateCommitSigningArgs(policy.signing), []);
}

function signingFixture(): void {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'signed.txt'), 'reviewed bytes\n');
  git(repo, ['add', '-A']);
  const treeOid = git(repo, ['write-tree']).trim();
  const keyPath = path.join(temp('lares-signing-key-'), 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { windowsHide: true });
  git(repo, ['config', 'gpg.format', 'ssh']);
  const args = ['commit-tree', treeOid, ...candidateCommitSigningArgs({ enabled: true, signingKey: keyPath }), '-m', 'signed candidate'];
  const commitOid = git(repo, args).trim();
  assert.equal(git(repo, ['rev-parse', `${commitOid}^{tree}`]).trim(), treeOid, 'signing must preserve the verified tree');
  assert.match(git(repo, ['cat-file', 'commit', commitOid]), /^gpgsig /m, 'commit object carries a signature');
}

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  if (!internal?.execPath) {
    console.log('candidate-validation: skipped (no internal git)');
    return;
  }
  gitExe = internal.execPath;
  try {
    await defaultOffFixture();
    console.log('ok - policy is off by default');
    await validationFixture();
    console.log('ok - exact candidate tree refuses omitted dependency and accepts complete tree');
    signingFixture();
    console.log('ok - repo-policy signing preserves the verified tree');
  } finally {
    for (const dir of trash) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('\ncandidate-validation: 3 passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
