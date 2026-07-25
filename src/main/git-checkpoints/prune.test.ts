// Git-Native WP-G3.5 — the explicit prune command + repo-wide purge.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/prune.test.js
//
// These drive a REAL git in throwaway temp repos: the load-bearing properties are
// (a) prune deletes EXACTLY the asserted workspace's two encoded namespaces, leaving
// every OTHER workspace's refs/lares/* and ALL user branches/tags intact; (b) the
// delete is ONE atomic update-ref --stdin batch; (c) NO gc/prune/maintenance/repack
// is ever invoked (objects are left for normal maintenance); (d) the repo-wide purge
// enumerates + names every affected workspace before clearing them. A fake could
// paper over "the ref no longer resolves," so these use live rev-parse.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit, type GitRunResult } from './git-command';
import type { RunGitLike } from './checkpoint-service';
import { checkpointRef, recoveryRef } from './ref-encoding';
import {
  pruneWorkspaceCheckpoints,
  enumerateRepoLaresRefs,
  repoWidePurgeExecute,
  refWorkspaceId,
} from './prune';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-prune-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function git(cwd: string, args: string[]): string {
  return execFileSync(EXE, args, { cwd }).toString();
}
function refExists(repo: string, ref: string): boolean {
  try { git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]); return true; } catch { return false; }
}
function allRefs(repo: string): string[] {
  return git(repo, ['for-each-ref', '--format=%(refname)'])
    .split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A repo with one commit + a user branch (main) and a tag (v1). Returns repo + oid. */
function mkRepo(): { repo: string; oid: string } {
  const repo = mkTmpDir();
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@lares.local']);
  git(repo, ['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hello\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const oid = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['tag', 'v1']);
  return { repo, oid };
}

/** Point a checkpoint before+after ref pair at `oid` for (ws, agent, turn). */
function seedTurn(repo: string, oid: string, ws: string, agent: string, turn: string): string[] {
  const b = checkpointRef({ workspaceId: ws, agentId: agent, turnId: turn, edge: 'before' });
  const a = checkpointRef({ workspaceId: ws, agentId: agent, turnId: turn, edge: 'after' });
  git(repo, ['update-ref', b, oid]);
  git(repo, ['update-ref', a, oid]);
  return [b, a];
}
/** Point a recovery `pre` ref at `oid` for (ws, op). */
function seedRecovery(repo: string, oid: string, ws: string, op: string): string {
  const r = recoveryRef({ workspaceId: ws, operationId: op });
  git(repo, ['update-ref', r, oid]);
  return r;
}

const WS_A = 'ws-alpha';
const WS_B = 'ws-beta';

/** Seed a repo with WS_A (2 turns + 1 recovery = 5 refs) and WS_B (1 turn + 1
 *  recovery = 3 refs), plus the user branch + tag from mkRepo. */
function mkSeededRepo(): { repo: string; oid: string; aRefs: string[]; bRefs: string[] } {
  const { repo, oid } = mkRepo();
  const aRefs = [
    ...seedTurn(repo, oid, WS_A, 'agentA', 't1'),
    ...seedTurn(repo, oid, WS_A, 'agentA', 't2'),
    seedRecovery(repo, oid, WS_A, 'op1'),
  ];
  const bRefs = [
    ...seedTurn(repo, oid, WS_B, 'agentB', 't1'),
    seedRecovery(repo, oid, WS_B, 'op1'),
  ];
  return { repo, oid, aRefs, bRefs };
}

// ── 1. workspace-scoped prune deletes exactly two namespaces; siblings intact ──────

test('prune deletes exactly the asserted workspace\'s two namespaces (count + refs)', async () => {
  const { repo, aRefs, bRefs } = mkSeededRepo();

  const res = await pruneWorkspaceCheckpoints({ workspaceId: WS_A, repoRoot: repo, gitExe: EXE });
  assert.equal(res.deletedRefs, 5, 'WS_A has 4 checkpoint + 1 recovery ref');
  assert.equal(res.workspaceId, WS_A);

  // Every WS_A ref is gone…
  for (const r of aRefs) assert.ok(!refExists(repo, r), `${r} must be deleted`);
  // …every WS_B ref survives…
  for (const r of bRefs) assert.ok(refExists(repo, r), `${r} must survive`);
  // …and the user branch + tag are untouched.
  assert.ok(refExists(repo, 'refs/heads/main'), 'user branch intact');
  assert.ok(refExists(repo, 'refs/tags/v1'), 'user tag intact');
});

test('prune leaves ALL user branches/tags and other refs/lares/* intact', async () => {
  const { repo, bRefs } = mkSeededRepo();
  const before = allRefs(repo);
  await pruneWorkspaceCheckpoints({ workspaceId: WS_A, repoRoot: repo, gitExe: EXE });
  const after = allRefs(repo);
  // The only refs removed are WS_A's; everything else (branches, tag, WS_B) remains.
  const removed = before.filter((r) => !after.includes(r));
  for (const r of removed) assert.equal(refWorkspaceId(r), WS_A, `only WS_A refs removed, saw ${r}`);
  for (const r of bRefs) assert.ok(after.includes(r), `${r} survives`);
  assert.ok(after.includes('refs/heads/main'));
  assert.ok(after.includes('refs/tags/v1'));
});

// ── 2. atomic single batch + no gc/prune/maintenance ─────────────────────────────

test('prune uses ONE atomic update-ref --stdin batch and NEVER runs gc/prune/maintenance', async () => {
  const { repo } = mkSeededRepo();
  const calls: string[][] = [];
  const recording: RunGitLike = (cwd, args, opts): Promise<GitRunResult> => {
    calls.push(args);
    return realRunGit(cwd, args, { ...opts, gitExe: EXE });
  };

  const res = await pruneWorkspaceCheckpoints({ workspaceId: WS_A, repoRoot: repo, gitExe: EXE, runGit: recording });
  assert.equal(res.deletedRefs, 5);

  // Only ever `for-each-ref` (enumerate) and `update-ref` (the atomic --stdin delete).
  const subcommands = calls.map((a) => a[0]);
  for (const c of subcommands) {
    assert.ok(['for-each-ref', 'update-ref'].includes(c), `unexpected git subcommand: ${c}`);
  }
  // Exactly one delete transaction, and it is the atomic --stdin form.
  const deletes = calls.filter((a) => a[0] === 'update-ref');
  assert.equal(deletes.length, 1, 'a single atomic delete batch');
  assert.deepEqual(deletes[0], ['update-ref', '--stdin'], 'atomic stdin batch, not per-ref -d');
  // Belt-and-suspenders: no object-store maintenance verb ever appears.
  const flat = calls.flat();
  for (const banned of ['gc', 'maintenance', 'repack', 'prune', 'count-objects']) {
    assert.ok(!flat.includes(banned), `must never invoke '${banned}'`);
  }
});

// ── 3. empty namespace → 0 deletions, no delete call ─────────────────────────────

test('prune on a workspace with no refs deletes nothing and runs no delete batch', async () => {
  const { repo } = mkRepo(); // no lares refs seeded
  const calls: string[][] = [];
  const recording: RunGitLike = (cwd, args, opts) => { calls.push(args); return realRunGit(cwd, args, { ...opts, gitExe: EXE }); };
  const res = await pruneWorkspaceCheckpoints({ workspaceId: WS_A, repoRoot: repo, gitExe: EXE, runGit: recording });
  assert.equal(res.deletedRefs, 0);
  assert.ok(!calls.some((a) => a[0] === 'update-ref'), 'no delete batch for an empty namespace');
});

// ── 4. exact-decode scoping (not just prefix match) ──────────────────────────────

test('prune scopes by exact decode — a ref that does not decode to the workspace is never deleted', async () => {
  const { repo, oid } = mkRepo();
  // WS_A's own refs.
  const aRefs = seedTurn(repo, oid, WS_A, 'agentA', 't1');
  // A ref in the SAME namespace root but a different (encoded) workspace whose id is
  // a string-superset — its encoding differs, so it must survive an WS_A prune.
  const otherWs = `${WS_A}-sibling`;
  const otherRef = seedTurn(repo, oid, otherWs, 'agentX', 't1')[0];

  await pruneWorkspaceCheckpoints({ workspaceId: WS_A, repoRoot: repo, gitExe: EXE });
  for (const r of aRefs) assert.ok(!refExists(repo, r), `${r} deleted`);
  assert.ok(refExists(repo, otherRef), 'a different workspace\'s ref is never swept in');
});

// ── 5. repo-wide enumeration NAMES every affected workspace ───────────────────────

test('enumerateRepoLaresRefs groups every Lares ref by decoded workspace + undecodable bucket', async () => {
  const { repo, oid } = mkSeededRepo();
  // An undecodable Lares ref (too few segments) — still enumerated, bucketed apart.
  const bad = 'refs/lares/checkpoints/zzNotAValidTurn';
  git(repo, ['update-ref', bad, oid]);

  const e = await enumerateRepoLaresRefs({ repoRoot: repo, gitExe: EXE });
  assert.equal(e.allRefs.length, 5 + 3 + 1, 'all lares refs enumerated');
  const ids = e.byWorkspace.map((g) => g.workspaceId);
  assert.deepEqual(ids, [WS_A, WS_B], 'both workspaces named, sorted');
  assert.equal(e.byWorkspace.find((g) => g.workspaceId === WS_A)!.refs.length, 5);
  assert.equal(e.byWorkspace.find((g) => g.workspaceId === WS_B)!.refs.length, 3);
  assert.deepEqual(e.undecodableRefs, [bad], 'the undecodable ref is surfaced, not hidden');
});

// ── 6. repo-wide purge clears ALL lares refs, leaves branches/tags ────────────────

test('repoWidePurgeExecute clears every refs/lares/* (all workspaces) but no user refs', async () => {
  const { repo, oid } = mkSeededRepo();
  const bad = 'refs/lares/recovery/zzOrphan';
  git(repo, ['update-ref', bad, oid]);

  const res = await repoWidePurgeExecute({ repoRoot: repo, gitExe: EXE });
  assert.equal(res.deletedRefs, 5 + 3 + 1, 'both workspaces + the orphan cleared');

  const after = allRefs(repo);
  assert.ok(!after.some((r) => r.startsWith('refs/lares/')), 'no lares ref remains');
  assert.ok(after.includes('refs/heads/main'), 'user branch intact');
  assert.ok(after.includes('refs/tags/v1'), 'user tag intact');
});

// ── runner ────────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-G3.5 prune tests need real git.');
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
