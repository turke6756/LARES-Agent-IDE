// SC-WP-1A — repository identity derivation (bundle contract v1 §1).
//
//   npm run build:main
//   node dist/main/main/commit-candidates/repository-identity.test.js
//
// NO real git / disk: derivation runs through an injected `runGit` fixture plus a
// fake realpath/fileExists. Proves: repositoryKey from the REAL index path;
// linked worktree → distinct key, shared objectDatabaseKey; workspace aliases →
// one key; bare repo rejected; absent / non-canonicalizable index → explicit
// outcome, no crash.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  deriveRepositoryIdentity,
  normalizeIndexKeyPath,
  type RepositoryIdentityDeps,
} from './repository-identity';
import type { GitExecResult } from '../git/git-runtime';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const OK = (stdout: string): GitExecResult => ({ code: 0, stdout, stderr: '' });
const FAIL = (stderr: string): GitExecResult => ({ code: 128, stdout: '', stderr });

/** Build a runGit fixture from a map of `argv.join(' ')` → result. Unmapped
 *  argv default to a benign non-sha256 object-format so tests need only pin the
 *  args they care about. */
function fakeRunGit(map: Record<string, GitExecResult>): RepositoryIdentityDeps['runGit'] {
  return async (args: string[]) => {
    const key = args.join(' ');
    if (key in map) return map[key];
    if (key === 'rev-parse --is-bare-repository') return OK('false');
    if (key === 'rev-parse --show-object-format') return OK('sha1');
    throw new Error(`unexpected git argv in fixture: ${key}`);
  };
}

/** win32-shaped deps with an injectable realpath/fileExists table. */
function win32Deps(
  runGit: RepositoryIdentityDeps['runGit'],
  opts?: { realpath?: (p: string) => string; exists?: (p: string) => boolean },
): RepositoryIdentityDeps {
  return {
    runGit,
    platform: 'win32',
    realpath: opts?.realpath ?? ((p) => p),
    fileExists: opts?.exists ?? (() => true),
  };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── repositoryKey from the REAL index path ────────────────────────────────────

test('independent rev-parse probes run concurrently with unchanged identity result', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const runGit: RepositoryIdentityDeps['runGit'] = async (args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight--;
    const key = args.join(' ');
    if (key === 'rev-parse --is-bare-repository') return OK('false');
    if (key === 'rev-parse --absolute-git-dir') return OK('C:/Repo/.git');
    if (key === 'rev-parse --git-path index') return OK('C:/Repo/.git/index');
    if (key === 'rev-parse --show-object-format') return OK('sha1');
    throw new Error(`unexpected git argv: ${key}`);
  };

  const out = await deriveRepositoryIdentity(
    'C:\\Repo',
    { commonDirQueueKey: 'c:\\repo\\.git' },
    win32Deps(runGit),
  );
  assert.equal(maxInFlight, 4, 'all four independent probes overlap');
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.gitObjectFormat, 'sha1');
});

test('repositoryKey = sha256 of the realpath-canonicalized, normalized index path', async () => {
  // git reports the index under a symlinked/aliased dir; realpath resolves it to
  // the canonical location. The key must hash the CANONICAL path, not the raw one.
  const raw = 'C:/Repo/Alias/.git/index';
  const canonical = 'C:\\Repo\\Real\\.git\\index';
  const deps = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK(raw), 'rev-parse --absolute-git-dir': OK('C:/Repo/Alias/.git') }),
    { realpath: (p) => (p === 'C:\\Repo\\Alias\\.git\\index' ? canonical : p) },
  );
  const out = await deriveRepositoryIdentity('C:\\Repo\\Alias', { commonDirQueueKey: 'c:\\repo\\real\\.git' }, deps);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.indexCanonicalization, 'realpath');
  // Normalized (win32 lowercased) canonical path is what gets hashed.
  const expectedKey = sha256(normalizeIndexKeyPath(canonical, 'win32'));
  assert.equal(out.repositoryKey, expectedKey);
  assert.equal(out.canonicalIndexPath, 'c:\\repo\\real\\.git\\index');
  // objectDatabaseKey is carried VERBATIM (already case-folded) — never re-normalized.
  assert.equal(out.objectDatabaseKey, 'c:\\repo\\real\\.git');
});

test('relative `--git-path index` is resolved against the workspace dir', async () => {
  const deps = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK('.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Ws/.git') }),
    { realpath: (p) => p },
  );
  const out = await deriveRepositoryIdentity('C:\\Ws', { commonDirQueueKey: 'c:\\ws\\.git' }, deps);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.canonicalIndexPath, 'c:\\ws\\.git\\index');
});

// ── linked worktree: distinct repositoryKey, SHARED objectDatabaseKey ─────────

test('linked worktree → DISTINCT repositoryKey but SHARED objectDatabaseKey', async () => {
  const shared = 'c:\\repo\\.git'; // one common object db, case-folded
  const main = await deriveRepositoryIdentity(
    'C:\\Repo',
    { commonDirQueueKey: shared },
    win32Deps(fakeRunGit({ 'rev-parse --git-path index': OK('C:/Repo/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git') })),
  );
  const linked = await deriveRepositoryIdentity(
    'C:\\Repo\\wt',
    { commonDirQueueKey: shared },
    win32Deps(fakeRunGit({ 'rev-parse --git-path index': OK('C:/Repo/.git/worktrees/wt/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git/worktrees/wt') })),
  );
  assert.equal(main.ok && linked.ok, true);
  if (!main.ok || !linked.ok) return;
  assert.notEqual(main.repositoryKey, linked.repositoryKey, 'distinct index → distinct key');
  assert.equal(main.objectDatabaseKey, linked.objectDatabaseKey, 'same common dir → shared object-db key');
});

// ── multiple workspace aliases of ONE worktree → ONE repositoryKey ────────────

test('two workspace aliases of one worktree collapse (via realpath) to ONE repositoryKey', async () => {
  const canonical = 'C:\\Repo\\.git\\index';
  // Alias A and alias B report different raw index paths; realpath collapses both.
  const depsA = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK('C:/aliasA/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/aliasA/.git') }),
    { realpath: () => canonical },
  );
  const depsB = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK('C:/aliasB/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/aliasB/.git') }),
    { realpath: () => canonical },
  );
  const a = await deriveRepositoryIdentity('C:\\aliasA', { commonDirQueueKey: 'c:\\repo\\.git' }, depsA);
  const b = await deriveRepositoryIdentity('C:\\aliasB', { commonDirQueueKey: 'c:\\repo\\.git' }, depsB);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.repositoryKey, b.repositoryKey, 'aliases of one worktree share one repositoryKey');
});

test('win32 drive-letter case + separators are normalized before hashing', async () => {
  // Same physical index reported with different drive-letter case / separators
  // must yield the SAME key after normalization.
  const lower = await deriveRepositoryIdentity(
    'C:\\Repo',
    { commonDirQueueKey: 'x' },
    win32Deps(fakeRunGit({ 'rev-parse --git-path index': OK('c:/repo/.git/index'), 'rev-parse --absolute-git-dir': OK('c:/repo/.git') }), { realpath: (p) => p }),
  );
  const upper = await deriveRepositoryIdentity(
    'C:\\Repo',
    { commonDirQueueKey: 'x' },
    win32Deps(fakeRunGit({ 'rev-parse --git-path index': OK('C:\\Repo\\.git\\index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git') }), { realpath: (p) => p }),
  );
  assert.equal(lower.ok && upper.ok, true);
  if (!lower.ok || !upper.ok) return;
  assert.equal(lower.repositoryKey, upper.repositoryKey);
});

// ── bare repo rejected ────────────────────────────────────────────────────────

test('bare repository is rejected with an explicit outcome', async () => {
  const deps = win32Deps(fakeRunGit({ 'rev-parse --is-bare-repository': OK('true') }));
  const out = await deriveRepositoryIdentity('C:\\bare.git', { commonDirQueueKey: 'c:\\bare.git' }, deps);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'bare-repo');
});

test('non-repo (absolute-git-dir fails) → not-a-repo, no crash', async () => {
  const deps = win32Deps(fakeRunGit({ 'rev-parse --absolute-git-dir': FAIL('fatal: not a git repository') }));
  const out = await deriveRepositoryIdentity('C:\\plain', { commonDirQueueKey: null }, deps);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'not-a-repo');
});

// ── absent / non-canonicalizable index target → explicit outcome, no crash ────

test('absent index file → directory-fallback canonicalization, still a deterministic key', async () => {
  // Fresh repo: the index file does not exist yet, but its parent (.git) does.
  const exists = (p: string) => p === 'C:\\Repo\\.git'; // dir exists, index does not
  const deps = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK('C:/Repo/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git') }),
    { exists, realpath: (p) => p },
  );
  const out = await deriveRepositoryIdentity('C:\\Repo', { commonDirQueueKey: 'c:\\repo\\.git' }, deps);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.indexCanonicalization, 'directory-fallback');
  assert.equal(out.canonicalIndexPath, 'c:\\repo\\.git\\index');
});

test('non-canonicalizable index target (nothing exists, realpath throws) → normalized-fallback, no crash', async () => {
  const deps = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK('C:/Gone/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Gone/.git') }),
    {
      exists: () => false,
      realpath: () => { throw new Error('ENOENT'); },
    },
  );
  const out = await deriveRepositoryIdentity('C:\\Gone', { commonDirQueueKey: 'c:\\gone\\.git' }, deps);
  assert.equal(out.ok, true, 'never crashes on a missing target');
  if (!out.ok) return;
  assert.equal(out.indexCanonicalization, 'normalized-fallback');
  assert.equal(out.canonicalIndexPath, 'c:\\gone\\.git\\index');
});

test('realpath throwing on an existing index degrades to directory/normalized fallback (no crash)', async () => {
  const deps = win32Deps(
    fakeRunGit({ 'rev-parse --git-path index': OK('C:/Repo/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git') }),
    {
      exists: (p) => p === 'C:\\Repo\\.git\\index' || p === 'C:\\Repo\\.git',
      realpath: (p) => { if (p === 'C:\\Repo\\.git\\index') throw new Error('EACCES'); return p; },
    },
  );
  const out = await deriveRepositoryIdentity('C:\\Repo', { commonDirQueueKey: 'c:\\repo\\.git' }, deps);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.indexCanonicalization, 'directory-fallback', 'index realpath threw → falls to dir realpath');
});

// ── object-db key + object format ─────────────────────────────────────────────

test('missing commonDirQueueKey → object-db-unavailable (not assemblable)', async () => {
  const deps = win32Deps(fakeRunGit({ 'rev-parse --git-path index': OK('C:/Repo/.git/index'), 'rev-parse --absolute-git-dir': OK('C:/Repo/.git') }));
  const out = await deriveRepositoryIdentity('C:\\Repo', { commonDirQueueKey: null }, deps);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'object-db-unavailable');
});

test('gitObjectFormat reflects --show-object-format (sha256 repo)', async () => {
  const deps = win32Deps(fakeRunGit({
    'rev-parse --git-path index': OK('C:/Repo/.git/index'),
    'rev-parse --absolute-git-dir': OK('C:/Repo/.git'),
    'rev-parse --show-object-format': OK('sha256'),
  }), { realpath: (p) => p });
  const out = await deriveRepositoryIdentity('C:\\Repo', { commonDirQueueKey: 'c:\\repo\\.git' }, deps);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.gitObjectFormat, 'sha256');
});

test('posix: no case-folding, forward separators preserved', async () => {
  const deps: RepositoryIdentityDeps = {
    runGit: fakeRunGit({ 'rev-parse --git-path index': OK('/repo/.git/index'), 'rev-parse --absolute-git-dir': OK('/repo/.git') }),
    platform: 'linux',
    realpath: (p) => p,
    fileExists: () => true,
  };
  const out = await deriveRepositoryIdentity('/repo', { commonDirQueueKey: '/repo/.git' }, deps);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.canonicalIndexPath, '/repo/.git/index');
  assert.equal(out.repositoryKey, sha256('/repo/.git/index'));
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
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
