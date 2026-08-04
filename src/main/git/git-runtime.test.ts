// Git-Native WP-G0.2 — git-runtime dual resolution + capability probe.
//
//   npm run build:main
//   node dist/main/main/git/git-runtime.test.js
//
// Discovery is exercised through pure functions and the workspace probe through
// injected deps. The user-commit identity test drives the resolved git in one
// throwaway repository because the committed object is the contract boundary.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GitCandidate, GitExecResult, RunGit } from './git-runtime';
import {
  buildGitEnv,
  describeAgentShellGit,
  gitArgsPrefix,
  isGitVersionCompatible,
  isProtectedRoot,
  isWslPath,
  parseGitVersion,
  pickInternalGit,
  probeWorkspaceGit,
  resolveInternalGit,
} from './git-runtime';
import type { GitResolution } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── parseGitVersion ──────────────────────────────────────────────────────────

test('parseGitVersion: standard windows suffix', () => {
  assert.deepEqual(parseGitVersion('git version 2.45.2.windows.1'), { major: 2, minor: 45, patch: 2 });
});
test('parseGitVersion: plain three-part', () => {
  assert.deepEqual(parseGitVersion('git version 2.35.0'), { major: 2, minor: 35, patch: 0 });
});
test('parseGitVersion: patchless defaults patch to 0', () => {
  assert.deepEqual(parseGitVersion('git version 3.1'), { major: 3, minor: 1, patch: 0 });
});
test('parseGitVersion: unparseable → null (never treated as too-old)', () => {
  assert.equal(parseGitVersion('not a version'), null);
  assert.equal(parseGitVersion(''), null);
  assert.equal(parseGitVersion(undefined), null);
});

test('isGitVersionCompatible: floor at 2.35', () => {
  assert.equal(isGitVersionCompatible({ major: 2, minor: 35, patch: 0 }), true);
  assert.equal(isGitVersionCompatible({ major: 2, minor: 34, patch: 9 }), false);
  assert.equal(isGitVersionCompatible({ major: 2, minor: 45, patch: 1 }), true);
  assert.equal(isGitVersionCompatible({ major: 3, minor: 0, patch: 0 }), true);
  assert.equal(isGitVersionCompatible({ major: 1, minor: 99, patch: 0 }), false);
});

// ── Dual-resolution matrix ───────────────────────────────────────────────────

const OLD_SYSTEM: GitCandidate = { source: 'system', execPath: 'C:/old/git.exe', semver: { major: 2, minor: 20, patch: 0 } };
const NEW_SYSTEM: GitCandidate = { source: 'system', execPath: 'C:/new/git.exe', semver: { major: 2, minor: 45, patch: 0 } };
const BUNDLED: GitCandidate = { source: 'bundled', execPath: 'C:/app/mingit/cmd/git.exe', semver: { major: 2, minor: 45, patch: 0 } };
const UNPARSEABLE_SYSTEM: GitCandidate = { source: 'system', execPath: 'C:/weird/git.exe', semver: null };

test('pickInternalGit: compatible system wins', () => {
  const internal = pickInternalGit([NEW_SYSTEM], BUNDLED);
  assert.deepEqual(internal, { source: 'system', execPath: NEW_SYSTEM.execPath, semver: NEW_SYSTEM.semver });
});

test('pickInternalGit: old system + bundled → internal = bundled', () => {
  const internal = pickInternalGit([OLD_SYSTEM], BUNDLED);
  assert.equal(internal?.source, 'bundled');
  assert.equal(internal?.execPath, BUNDLED.execPath);
});

test('pickInternalGit: unparseable system skipped → falls to bundled', () => {
  const internal = pickInternalGit([UNPARSEABLE_SYSTEM], BUNDLED);
  assert.equal(internal?.source, 'bundled');
});

test('pickInternalGit: no bundled + only-old system → null', () => {
  assert.equal(pickInternalGit([OLD_SYSTEM], null), null);
});

test('pickInternalGit: bundled only → bundled', () => {
  assert.equal(pickInternalGit([], BUNDLED)?.source, 'bundled');
});

test('describeAgentShellGit: old system + bundled → agent shell flagged divergent', () => {
  const internal = pickInternalGit([OLD_SYSTEM], BUNDLED);
  const agentShell = describeAgentShellGit([OLD_SYSTEM], BUNDLED, internal);
  assert.equal(agentShell.source, 'system');
  assert.match(agentShell.note, /Divergent/);
});

test('describeAgentShellGit: both system → no divergence', () => {
  const internal = pickInternalGit([NEW_SYSTEM], BUNDLED);
  const agentShell = describeAgentShellGit([NEW_SYSTEM], BUNDLED, internal);
  assert.equal(agentShell.source, 'system');
  assert.doesNotMatch(agentShell.note, /Divergent/);
});

test('describeAgentShellGit: bundled-only → source bundled, no divergence', () => {
  const internal = pickInternalGit([], BUNDLED);
  const agentShell = describeAgentShellGit([], BUNDLED, internal);
  assert.equal(agentShell.source, 'bundled');
  assert.doesNotMatch(agentShell.note, /Divergent/);
});

test('describeAgentShellGit: no git anywhere → source null', () => {
  const agentShell = describeAgentShellGit([], null, null);
  assert.equal(agentShell.source, null);
});

test('resolveInternalGit: uses injected discovery (old system + bundled → bundled)', async () => {
  const internal = await resolveInternalGit({
    discoverSystem: async () => [OLD_SYSTEM],
    discoverBundled: async () => BUNDLED,
  });
  assert.equal(internal?.source, 'bundled');
});

// ── buildGitEnv ──────────────────────────────────────────────────────────────

test('buildGitEnv: deletes every repo-routing var + GIT_CONFIG_KEY_*/VALUE_*', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    GIT_DIR: '/x/.git',
    GIT_WORK_TREE: '/x',
    GIT_COMMON_DIR: '/x/.git',
    GIT_INDEX_FILE: '/x/.git/index',
    GIT_OBJECT_DIRECTORY: '/x/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y/objects',
    GIT_NAMESPACE: 'ns',
    GIT_CONFIG: '/x/.gitconfig',
    GIT_CONFIG_PARAMETERS: "'a.b=c'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'a.b',
    GIT_CONFIG_VALUE_0: 'c',
  };
  const env = buildGitEnv(base, { mode: 'read' });
  for (const k of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  ]) {
    assert.equal(env[k], undefined, `${k} should be deleted`);
  }
  // Unrelated vars preserved; base object not mutated.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(base.GIT_DIR, '/x/.git');
});

test('buildGitEnv: strips claude/electron markers, sets locks + prompt', () => {
  const env = buildGitEnv(
    { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ELECTRON_RUN_AS_NODE: '1' },
    { mode: 'read' },
  );
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
});

test('buildGitEnv: leaves GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM unset', () => {
  const env = buildGitEnv({ PATH: '/usr/bin' }, { mode: 'commit' });
  assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined);
});

test('buildGitEnv: checkpoint identity ONLY in commit mode', () => {
  const read = buildGitEnv({}, { mode: 'read' });
  assert.equal(read.GIT_AUTHOR_NAME, undefined);
  assert.equal(read.GIT_COMMITTER_EMAIL, undefined);

  const userCommit = buildGitEnv({}, { mode: 'user-commit' });
  assert.equal(userCommit.GIT_AUTHOR_NAME, undefined);
  assert.equal(userCommit.GIT_AUTHOR_EMAIL, undefined);
  assert.equal(userCommit.GIT_COMMITTER_NAME, undefined);
  assert.equal(userCommit.GIT_COMMITTER_EMAIL, undefined);
  assert.equal(userCommit.GIT_TERMINAL_PROMPT, '0');
  assert.equal(userCommit.GIT_OPTIONAL_LOCKS, '0');

  const commit = buildGitEnv({}, { mode: 'commit' });
  assert.equal(commit.GIT_AUTHOR_NAME, 'Lares Checkpoints');
  assert.equal(commit.GIT_AUTHOR_EMAIL, 'checkpoints@lares.local');
  assert.equal(commit.GIT_COMMITTER_NAME, 'Lares Checkpoints');
  assert.equal(commit.GIT_COMMITTER_EMAIL, 'checkpoints@lares.local');
});

test('buildGitEnv: user-commit object uses the repository-configured user identity', async () => {
  const internal = await resolveInternalGit();
  assert.ok(internal, 'a compatible git is required for the user-commit contract test');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-user-commit-'));
  try {
    execFileSync(internal.execPath, ['init', '-q'], { cwd: repo });
    execFileSync(internal.execPath, ['config', 'user.name', 'Save Card User'], { cwd: repo });
    execFileSync(internal.execPath, ['config', 'user.email', 'save-card-user@example.test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'saved.txt'), 'saved\n');
    execFileSync(internal.execPath, ['add', '--', 'saved.txt'], { cwd: repo });

    const base: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: path.join(repo, 'poison.git') };
    delete base.GIT_AUTHOR_NAME;
    delete base.GIT_AUTHOR_EMAIL;
    delete base.GIT_COMMITTER_NAME;
    delete base.GIT_COMMITTER_EMAIL;
    const env = buildGitEnv(base, { mode: 'user-commit' });

    assert.equal(env.GIT_DIR, undefined, 'routing-variable sanitization is retained');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'user commits remain noninteractive');
    execFileSync(internal.execPath, ['commit', '-q', '-m', 'save card'], { cwd: repo, env });

    const identity = execFileSync(
      internal.execPath,
      ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', 'HEAD'],
      { cwd: repo, encoding: 'utf8' },
    ).trim().split('\0');
    assert.deepEqual(identity, [
      'Save Card User',
      'save-card-user@example.test',
      'Save Card User',
      'save-card-user@example.test',
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ── gitArgsPrefix ────────────────────────────────────────────────────────────

test('gitArgsPrefix: commit on Windows adds gpgsign + longpaths', () => {
  const args = gitArgsPrefix('commit', 'win32');
  assert.deepEqual(args, ['-c', 'core.longpaths=true', '-c', 'commit.gpgsign=false']);
});
test('gitArgsPrefix: diff on Windows adds longpaths + no-ext-diff/no-textconv', () => {
  const args = gitArgsPrefix('diff', 'win32');
  assert.deepEqual(args, ['-c', 'core.longpaths=true', '--no-ext-diff', '--no-textconv']);
});
test('gitArgsPrefix: read on non-Windows is empty', () => {
  assert.deepEqual(gitArgsPrefix('read', 'linux'), []);
});
test('gitArgsPrefix: commit on non-Windows is gpgsign only', () => {
  assert.deepEqual(gitArgsPrefix('commit', 'linux'), ['-c', 'commit.gpgsign=false']);
});

// ── path predicates ──────────────────────────────────────────────────────────

test('isWslPath: WSL UNC + POSIX-absolute, not Windows drive', () => {
  assert.equal(isWslPath('\\\\wsl$\\Ubuntu\\home\\me'), true);
  assert.equal(isWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), true);
  assert.equal(isWslPath('/home/me/proj'), true);
  assert.equal(isWslPath('C:\\Users\\me\\proj'), false);
  assert.equal(isWslPath('\\\\server\\share\\proj'), false);
});

test('isProtectedRoot: drive root / home / shell folder', () => {
  const deps = { platform: 'win32' as NodeJS.Platform, homedir: () => 'C:\\Users\\me', shellFolders: ['C:\\Users\\me\\Desktop'] };
  assert.equal(isProtectedRoot('C:\\', deps), true);
  assert.equal(isProtectedRoot('C:\\Users\\me', deps), true);
  assert.equal(isProtectedRoot('c:\\users\\me\\desktop', deps), true); // case-insensitive
  assert.equal(isProtectedRoot('C:\\Users\\me\\proj', deps), false);
});

// ── probeWorkspaceGit ────────────────────────────────────────────────────────

const RESOLUTION: GitResolution = {
  agentShell: { source: 'system', note: '' },
  internal: { source: 'system', execPath: 'C:/git/git.exe', semver: { major: 2, minor: 45, patch: 0 } },
};

/** A runGit fixture: exact arg-vector (joined by space) → result. Unmatched
 *  calls default to a non-zero "unset/absent" result. */
function fakeRunGit(map: Record<string, Partial<GitExecResult>>): RunGit {
  return async (args) => {
    const key = args.join(' ');
    const hit = map[key];
    return { code: 1, stdout: '', stderr: '', ...(hit ?? {}) };
  };
}

function baseProbeDeps(overrides: Partial<Parameters<typeof probeWorkspaceGit>[1]> = {}) {
  return {
    resolution: RESOLUTION,
    internal: RESOLUTION.internal,
    platform: 'win32' as NodeJS.Platform,
    homedir: () => 'C:\\Users\\me',
    shellFolders: [],
    realpath: (p: string) => p,
    fileExists: () => false,
    hasNestedGitInside: () => false,
    ...overrides,
  };
}

const REPO_PROBES = {
  'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
  'rev-parse --git-common-dir': { code: 0, stdout: 'C:/repo/.git\n' },
  'rev-parse --verify HEAD': { code: 0, stdout: 'deadbeef\n' },
};

test('probe: workspace inside a larger repo → repo + non-empty prefix, ok', async () => {
  const cap = await probeWorkspaceGit('C:\\repo\\sub\\pkg', baseProbeDeps({
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/repo\n' } }),
  }));
  assert.equal(cap.repoState, 'repo');
  assert.equal(cap.workspacePrefix, 'sub/pkg');
  assert.equal(cap.reason, 'ok');
  assert.equal(cap.protectedRoot, false);
  assert.equal(cap.repoRoot, 'C:\\repo');
});

test('probe: workspace at repo root → repo + empty prefix', async () => {
  const cap = await probeWorkspaceGit('C:\\repo', baseProbeDeps({
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/repo\n' } }),
  }));
  assert.equal(cap.repoState, 'repo');
  assert.equal(cap.workspacePrefix, '');
});

test('probe: common dir canonicalized + case-folded queue key', async () => {
  const cap = await probeWorkspaceGit('C:\\Repo', baseProbeDeps({
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/Repo\n' } }),
  }));
  assert.equal(cap.commonDir, 'C:\\repo\\.git'); // realpath is identity; native separators
  assert.equal(cap.commonDirQueueKey, 'c:\\repo\\.git');
});

test('probe: nested git inside workspace → nested, unsupported-layout', async () => {
  const cap = await probeWorkspaceGit('C:\\repo', baseProbeDeps({
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/repo\n' } }),
    hasNestedGitInside: () => true,
  }));
  assert.equal(cap.repoState, 'nested');
  assert.equal(cap.reason, 'unsupported-layout');
});

test('probe: toplevel outside workspace subtree → spans-boundary', async () => {
  const cap = await probeWorkspaceGit('C:\\repo', baseProbeDeps({
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/other\n' } }),
  }));
  assert.equal(cap.repoState, 'spans-boundary');
  assert.equal(cap.reason, 'unsupported-layout');
});

test('probe: unborn HEAD → unborn, ok (supported)', async () => {
  const cap = await probeWorkspaceGit('C:\\repo', baseProbeDeps({
    runGit: fakeRunGit({
      'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
      'rev-parse --show-toplevel': { code: 0, stdout: 'C:/repo\n' },
      'rev-parse --git-common-dir': { code: 0, stdout: 'C:/repo/.git\n' },
      'rev-parse --verify HEAD': { code: 128, stderr: 'fatal: Needed a single revision' },
    }),
  }));
  assert.equal(cap.repoState, 'unborn');
  assert.equal(cap.reason, 'ok');
});

test('probe: non-repo → non-repo', async () => {
  const cap = await probeWorkspaceGit('C:\\plain', baseProbeDeps({
    runGit: fakeRunGit({
      'rev-parse --is-inside-work-tree': { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' },
    }),
  }));
  assert.equal(cap.repoState, 'non-repo');
  assert.equal(cap.reason, 'ok'); // git is fine; the G1.3a gate rejects on repoState
});

test('probe: dubious ownership → unsafe-directory with remediation', async () => {
  const cap = await probeWorkspaceGit('C:\\foreign', baseProbeDeps({
    runGit: fakeRunGit({
      'rev-parse --is-inside-work-tree': { code: 128, stderr: 'fatal: detected dubious ownership in repository at C:/foreign' },
    }),
  }));
  assert.equal(cap.reason, 'unsafe-directory');
  assert.match(cap.detail || '', /safe\.directory/);
});

test('probe: timeout on first rev-parse → timeout', async () => {
  const cap = await probeWorkspaceGit('C:\\repo', baseProbeDeps({
    runGit: fakeRunGit({ 'rev-parse --is-inside-work-tree': { code: 1, timedOut: true } }),
  }));
  assert.equal(cap.reason, 'timeout');
});

test('probe: WSL path → unsupported-wsl / unsupported-path (no git calls)', async () => {
  let called = false;
  const cap = await probeWorkspaceGit('\\\\wsl$\\Ubuntu\\home\\me\\proj', baseProbeDeps({
    runGit: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
  }));
  assert.equal(cap.repoState, 'unsupported-wsl');
  assert.equal(cap.reason, 'unsupported-path');
  assert.equal(called, false);
});

test('probe: no internal git → missing', async () => {
  const cap = await probeWorkspaceGit('C:\\repo', baseProbeDeps({
    internal: null,
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    runGit: async () => ({ code: 127, stdout: '', stderr: '' }),
  }));
  assert.equal(cap.reason, 'missing');
});

test('probe: protected root that IS a repo → protectedRoot:true alongside ok', async () => {
  const cap = await probeWorkspaceGit('C:\\Users\\me', baseProbeDeps({
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/Users/me\n' } }),
  }));
  assert.equal(cap.protectedRoot, true);
  assert.equal(cap.repoState, 'repo');
  assert.equal(cap.reason, 'ok'); // reason stays underlying; gating is on the boolean
});

// ── layout probes (diagnostic only) ──────────────────────────────────────────

async function probeWithConfig(extra: Record<string, Partial<GitExecResult>>, fileExists: (p: string) => boolean = () => false) {
  return probeWorkspaceGit('C:\\repo', baseProbeDeps({
    fileExists,
    runGit: fakeRunGit({ ...REPO_PROBES, 'rev-parse --show-toplevel': { code: 0, stdout: 'C:/repo\n' }, ...extra }),
  }));
}

test('probe: submodules via config → diagnostic detail, still ok', async () => {
  const cap = await probeWithConfig({ 'config --get-regexp ^submodule\\.': { code: 0, stdout: 'submodule.libfoo.url git@x\n' } });
  assert.equal(cap.reason, 'ok');
  assert.match(cap.detail || '', /submodules/);
});

test('probe: submodules via .gitmodules file → diagnostic detail', async () => {
  const cap = await probeWithConfig({}, (p) => p.replace(/\\/g, '/').endsWith('/.gitmodules'));
  assert.match(cap.detail || '', /submodules/);
});

test('probe: sparse checkout → diagnostic detail', async () => {
  const cap = await probeWithConfig({ 'config --get core.sparseCheckout': { code: 0, stdout: 'true\n' } });
  assert.match(cap.detail || '', /sparse-checkout/);
});

test('probe: partial clone / promisor → diagnostic detail', async () => {
  const cap = await probeWithConfig({ 'config --get-regexp ^(extensions\\.partialclone|remote\\..*\\.promisor)': { code: 0, stdout: 'extensions.partialclone origin\n' } });
  assert.match(cap.detail || '', /partial-clone/);
});

test('probe: core.longpaths → diagnostic detail', async () => {
  const cap = await probeWithConfig({ 'config --get core.longpaths': { code: 0, stdout: 'true\n' } });
  assert.match(cap.detail || '', /core\.longpaths/);
});

// ── runner ───────────────────────────────────────────────────────────────────

(async () => {
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
  process.exit(failed === 0 ? 0 : 1);
})();
