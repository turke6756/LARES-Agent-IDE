// git-init.test.ts — Git-Native WP-G3.4: the human-only `git init` consent action.
//
// Load-bearing properties:
//   - a healthy NON-REPO workspace is initialized and then RE-PROBES as a repo
//     (real git, real temp dir);
//   - an already-initialized workspace is REFUSED (no second `git init`, no
//     shadow repo);
//   - a git failure surfaces a typed `error` result and leaves NO partial `.git`;
//   - protected-root and unusable-git are refused honestly (typed, no init);
//   - the consent action is HUMAN-side only: it is NOT an agent MCP checkpoint
//     tool (mcp-tools-checkpoints), NOT granted by any lane (mcp-config-builder),
//     and NOT a capability HTTP route (api-server) — it is a `checkpoint:` IPC
//     channel and nothing else.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/git-init.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { initWorkspaceGitRepo } from './git-init';
import { GitCommandError } from './git-command';
import { resolveInternalGit, probeWorkspaceGit } from '../git/git-runtime';
import { toolsetsForLane } from '../supervisor/mcp-config-builder';
import { CHECKPOINT_CHANNELS } from '../../shared/types';
import type { GitCapability } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-gitinit-'): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** A minimal GitCapability for the injected-probe branches. */
function cap(over: Partial<GitCapability>): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'non-repo',
    commonDir: null,
    commonDirQueueKey: null,
    repoRoot: null,
    workspacePrefix: null,
    protectedRoot: false,
    reason: 'ok',
    detail: null,
    ...over,
  };
}

// ── 1. Happy path: init a non-repo, then re-probe as a repo ──────────────────────

test('initializes a non-repo workspace and it re-probes as an available repo', async () => {
  const dir = mkTmpDir();
  // Precondition: genuinely a non-repo.
  const before = await probeWorkspaceGit(dir);
  assert.equal(before.repoState, 'non-repo');
  assert.equal(before.repoRoot, null);

  const res = await initWorkspaceGitRepo(dir, EXE);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'initialized');
  assert.ok(fs.existsSync(path.join(dir, '.git')), '.git must exist after init');

  // The whole point of the action: the workspace now probes as a usable repo.
  const after = await probeWorkspaceGit(dir);
  assert.equal(after.reason, 'ok');
  assert.ok(after.repoRoot, 'repoRoot must be set after init');
  // A fresh repo has an unborn HEAD, which WP-G0.3 treats as a supported repo.
  assert.ok(after.repoState === 'unborn' || after.repoState === 'repo', `unexpected repoState ${after.repoState}`);
});

// ── 2. Refuse an already-initialized repo (no shadow repo) ───────────────────────

test('refuses a workspace that is already a Git repository', async () => {
  const dir = mkTmpDir();
  execFileSync(EXE, ['init', '-q'], { cwd: dir });
  const headBefore = fs.statSync(path.join(dir, '.git')).ctimeMs;

  const res = await initWorkspaceGitRepo(dir, EXE);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'already-repo');
  // No second init ran against the existing repo.
  const headAfter = fs.statSync(path.join(dir, '.git')).ctimeMs;
  assert.equal(headAfter, headBefore, '.git must be untouched');
});

// ── 3. A git failure surfaces an error and leaves NO partial state ───────────────

test('a git failure returns a typed error and creates no partial .git', async () => {
  const dir = mkTmpDir();
  const res = await initWorkspaceGitRepo(dir, EXE, {
    // Real probe (a real non-repo) but a git that fails the init call.
    runGitFn: async () => { throw new GitCommandError('spawn', 'boom', null, 'fatal: could not create work tree'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'error');
  assert.match(res.detail ?? '', /work tree|boom/);
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'no .git may be left behind on failure');
});

// ── 4. Protected root + unusable git are refused honestly (no init) ──────────────

test('refuses a protected root without attempting init', async () => {
  const dir = mkTmpDir();
  let ran = false;
  const res = await initWorkspaceGitRepo(dir, EXE, {
    probe: async () => cap({ protectedRoot: true, detail: 'home folder' }),
    runGitFn: async () => { ran = true; throw new Error('should not run'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'protected-root');
  assert.equal(ran, false);
  assert.ok(!fs.existsSync(path.join(dir, '.git')));
});

test('refuses when git is unusable for the workspace (degraded reason)', async () => {
  const dir = mkTmpDir();
  let ran = false;
  const res = await initWorkspaceGitRepo(dir, EXE, {
    probe: async () => cap({ reason: 'unsupported-path', detail: 'WSL path' }),
    runGitFn: async () => { ran = true; throw new Error('should not run'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unusable-git');
  assert.equal(ran, false);
});

// ── 5. HUMAN-ONLY: not an agent MCP tool, not a lane grant, not an HTTP route ─────

test('the consent action is a human IPC channel, never an agent MCP tool / lane grant', () => {
  // It is a `checkpoint:` renderer IPC channel — not an `/api/...` route shape.
  assert.equal(CHECKPOINT_CHANNELS.gitInit, 'checkpoint:gitInit');
  assert.ok(!CHECKPOINT_CHANNELS.gitInit.startsWith('/api/'), 'must not be an HTTP route path');

  // NOT in any MCP toolset grant: no lane's grant names a git-init toolset, and the
  // supervisor's `checkpoints` recovery toolset does not smuggle one in.
  for (const lane of ['supervisor', 'worker', 'researcher', 'legacy'] as const) {
    const grant = toolsetsForLane(lane);
    assert.ok(!/init/i.test(grant), `${lane} grant must not expose a git-init toolset (got: '${grant}')`);
  }

  // NOT an agent MCP checkpoint tool: the supervisor-only checkpoints toolset's
  // verbs are a fixed set; `git init` is not among them. (Loaded from the very
  // module the MCP server exposes, run with cwd = repo root.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.resolve('scripts/mcp-tools-checkpoints.js')) as {
    getCheckpointsToolDefinitions: () => { name: string }[];
  };
  const names = mod.getCheckpointsToolDefinitions().map((t) => t.name);
  assert.ok(names.length > 0, 'sanity: some checkpoint tools exist');
  for (const n of names) {
    assert.ok(!/init/i.test(n), `checkpoint MCP tool '${n}' must not be a git-init verb`);
  }

  // NOT a capability HTTP route: api-server exposes no git-init checkpoint route
  // and never references the human-only initRepo surface.
  const apiServerSrc = fs.readFileSync(path.resolve('src/main/api-server.ts'), 'utf8');
  assert.ok(!/checkpoints\/init/i.test(apiServerSrc), 'api-server must not route /api/checkpoints/init');
  assert.ok(!/gitInit|initRepo/.test(apiServerSrc), 'api-server must not reference the human-only git-init surface');
});

// ── runner ───────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-G3.4 tests need real git.');
    process.exit(1);
  }
  EXE = internal.execPath;

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
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
