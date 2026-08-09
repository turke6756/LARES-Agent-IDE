// Git-Native WP-G1.3b — snapshot core: full raw capture + durable finalize.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/checkpoint-service.test.js
//
// This is the most safety-critical package, so the invariant proofs drive a REAL
// git in throwaway temp repos: HEAD / real-index-checksum / porcelain-v2 / all
// refs/heads/* byte-identical after a snapshot; the core.autocrlf CRLF proof; mode
// preservation; unborn HEAD; commit-tree with no identity + gpgsign=true; sub-prefix
// scoping; deletion/creation; filtered-path bypass; and the wall-clock contract
// (deadline-before-candidate → abandoned; finalize-overrun → persisted-non-ready with
// delivery released at deadlineAt). A deterministic fake-git dispatcher covers the
// pure control-flow: the ready=0→ref→verify→ready=1 write order, argv chunking +
// newline-in-name individual hashing, the NUL-safe index-info batch (additions +
// delete form), and the gitlink visible reject — none of which need a real process
// and some of which (a newline filename) are impossible on Windows.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit, GitCommandError, type GitRunResult, type RunGitOptions } from './git-command';
import { CheckpointQueue } from './checkpoint-queue';
import type { EnumerationOutcome, EnumerationResult } from './checkpoint-gating';
import type { GitCapability } from '../../shared/types';
import type { TurnRecord } from '../database';
import {
  CheckpointService,
  type CheckpointTurnStore,
  type CheckpointServiceOptions,
  type RunGitLike,
} from './checkpoint-service';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-ckpt-'): string {
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
/** A throwaway repo with an identity configured (override for the no-identity test). */
function mkRepo(opts: { identity?: boolean; config?: [string, string][] } = {}): string {
  const dir = mkTmpDir();
  git(dir, ['init', '-q']);
  if (opts.identity !== false) {
    git(dir, ['config', 'user.email', 't@lares.local']);
    git(dir, ['config', 'user.name', 'Lares Test']);
  }
  for (const [k, v] of opts.config ?? []) git(dir, ['config', k, v]);
  return dir;
}
function commitAll(repo: string, msg = 'c'): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}

function capFor(
  repo: string,
  opts: { repoState?: 'repo' | 'unborn'; workspacePrefix?: string } = {},
): GitCapability {
  const real = fs.realpathSync(repo);
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: opts.repoState ?? 'repo',
    commonDir: path.join(real, '.git'),
    commonDirQueueKey: real.toLowerCase(),
    repoRoot: repo,
    workspacePrefix: opts.workspacePrefix ?? '',
    protectedRoot: false,
    reason: 'ok',
    detail: null,
  };
}

// ── in-memory turn store (WP-A0 contract: terminal rows immutable) ──────────────

interface StoreEvent { tag: string; updates: Record<string, unknown>; }
class FakeStore implements CheckpointTurnStore {
  rows = new Map<string, Record<string, unknown>>();
  events: StoreEvent[] = [];
  seedOpen(id: string, workspaceId: string, extra: Record<string, unknown> = {}): void {
    this.rows.set(id, {
      id, workspaceId, status: 'open', agentId: null,
      beforeReady: false, afterReady: false, touched: [],
      beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
      ...extra,
    });
  }
  getTurnRecord(id: string): TurnRecord | null {
    const r = this.rows.get(id);
    return r ? ({ ...r } as unknown as TurnRecord) : null;
  }
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null {
    const r = this.rows.get(id);
    if (!r) return null;
    if (r.status && r.status !== 'open' && updates.status === undefined) {
      // Mirror the real accessor: a terminal row is immutable.
      if (r.status !== 'open') throw new Error(`turn ${id} terminal`);
    }
    Object.assign(r, updates);
    const tag = updates.beforeReady === false || updates.afterReady === false ? 'persist0'
      : updates.beforeReady === true || updates.afterReady === true ? 'persist1'
      : 'update';
    this.events.push({ tag, updates });
    return { ...r } as unknown as TurnRecord;
  }
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (!opts?.agentId || r.agentId === opts.agentId))
      .map((r) => ({ ...r } as unknown as TurnRecord));
  }
}

function mkService(over: Partial<CheckpointServiceOptions> & { store: FakeStore }): CheckpointService {
  return new CheckpointService({
    queue: over.queue ?? new CheckpointQueue(),
    gitExe: EXE,
    ...over,
  });
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
function indexChecksum(repo: string): string {
  return sha256(fs.readFileSync(path.join(repo, '.git', 'index')));
}
function refsHeads(repo: string): string {
  return git(repo, ['for-each-ref', 'refs/heads']);
}
function porcelain(repo: string): string {
  return git(repo, ['status', '--porcelain=v2']);
}

// ══ REAL-GIT invariant proofs ═══════════════════════════════════════════════════

test('snapshot leaves HEAD, real index checksum, porcelain-v2, and all refs/heads/* byte-identical', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
  commitAll(repo);
  git(repo, ['branch', 'feature']);
  // Dirty the worktree — dirtiness is the INPUT to checkpointing, never a rejection.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one-modified\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'untracked\n');

  const beforeHead = git(repo, ['rev-parse', 'HEAD']);
  const beforeIdx = indexChecksum(repo);
  const beforePorc = porcelain(repo);
  const beforeRefs = refsHeads(repo);

  const store = new FakeStore();
  store.seedOpen('T1', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T1', workspaceId: 'WS', agentId: 'agent-1',
    capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();

  assert.equal(res.status, 'ready');
  assert.ok(res.oid && res.ref);
  // The snapshot used a temp index + only created refs/lares/* — the repo is untouched.
  assert.equal(git(repo, ['rev-parse', 'HEAD']), beforeHead, 'HEAD unchanged');
  assert.equal(indexChecksum(repo), beforeIdx, 'real index checksum unchanged');
  assert.equal(porcelain(repo), beforePorc, 'porcelain unchanged');
  assert.equal(refsHeads(repo), beforeRefs, 'all refs/heads/* unchanged');
  // No temp index leaked into .git/.
  assert.equal(fs.readdirSync(path.join(repo, '.git')).some((f) => f.startsWith('lares-idx-')), false);
});

test('afterImageRestoreInput exposes a verified per-path blob without restoring', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'after.txt'), 'verified after image\n');
  commitAll(repo);
  const afterOid = git(repo, ['rev-parse', 'HEAD']).trim();
  const expectedBlob = git(repo, ['rev-parse', 'HEAD:after.txt']).trim();
  const store = new FakeStore();
  store.seedOpen('after-turn', 'WS', {
    afterOid, afterRef: 'HEAD', afterReady: true,
    touched: [{ path: 'after.txt', op: 'write' }],
  });
  const svc = mkService({ store });
  const input = await svc.afterImageRestoreInput({
    turnId: 'after-turn', workspaceId: 'WS', repoRoot: repo, path: 'after.txt',
  });
  assert.deepEqual(input, {
    turnId: 'after-turn', workspaceId: 'WS', path: 'after.txt',
    afterCommitOid: afterOid, afterBlobOid: expectedBlob,
  });
  assert.equal(fs.readFileSync(path.join(repo, 'after.txt'), 'utf8'), 'verified after image\n');
});

test('[V] core.autocrlf=true: captured blob bytes == worktree CRLF bytes, NOT the LF HEAD blob', async () => {
  const repo = mkRepo({ config: [['core.autocrlf', 'true']] });
  const crlf = Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'latin1');
  fs.writeFileSync(path.join(repo, 'win.txt'), crlf);
  commitAll(repo); // under autocrlf, HEAD stores the normalized LF blob; worktree keeps CRLF
  // Sanity: the file is CLEAN (autocrlf round-trips) yet HEAD != worktree bytes.
  const headBlobOid = git(repo, ['rev-parse', 'HEAD:win.txt']).trim();
  const headBytes = execFileSync(EXE, ['cat-file', 'blob', headBlobOid], { cwd: repo });
  assert.ok(!headBytes.includes(0x0d), 'HEAD blob is LF-normalized');

  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'ready');

  const entry = git(repo, ['ls-tree', res.oid as string, '--', 'win.txt']).trim();
  const capturedBlob = entry.split(/\s+/)[2];
  assert.notEqual(capturedBlob, headBlobOid, 'captured blob is NOT the LF HEAD blob');
  const capturedBytes = execFileSync(EXE, ['cat-file', 'blob', capturedBlob], { cwd: repo });
  assert.deepEqual(capturedBytes, crlf, 'captured bytes are the verbatim worktree CRLF bytes');
});

test('filter-driver path (git-crypt/LFS) captured as on-disk bytes + before_raw_filter_bypassed=1, not skipped', async () => {
  const repo = mkRepo();
  const secretBytes = Buffer.from('PLAINTEXT-SECRET-BYTES\n');
  fs.writeFileSync(path.join(repo, 'secret.bin'), secretBytes);
  commitAll(repo); // committed WITHOUT the attribute (no driver installed)
  // Now assign a filter driver to the path — check-attr reports it; --no-filters bypasses it.
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'secret.bin filter=git-crypt\n');

  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();

  assert.equal(res.status, 'ready');
  assert.equal(res.rawFilterBypassed, true);
  assert.deepEqual(res.filteredPaths, ['secret.bin']);
  assert.equal(store.rows.get('T')!.beforeRawFilterBypassed, true);
  assert.deepEqual(store.rows.get('T')!.beforeFilteredPaths, ['secret.bin']);
  const blob = git(repo, ['ls-tree', res.oid as string, '--', 'secret.bin']).trim().split(/\s+/)[2];
  assert.deepEqual(execFileSync(EXE, ['cat-file', 'blob', blob], { cwd: repo }), secretBytes);
});

test('unborn-HEAD repo snapshots via read-tree --empty', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a',
    capability: capFor(repo, { repoState: 'unborn' }), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'ready');
  // The candidate commit's tree contains exactly the untracked file.
  const tree = git(repo, ['ls-tree', '--name-only', res.oid as string]).trim();
  assert.equal(tree, 'new.txt');
});

test('commit-tree succeeds with NO user.name/email and commit.gpgsign=true, without signing/prompting, config untouched', async () => {
  const repo = mkRepo({ identity: false, config: [['commit.gpgsign', 'true']] });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a',
    capability: capFor(repo, { repoState: 'unborn' }), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'ready');
  // Identity came from buildGitEnv commit mode; gpgsign was overridden per-invocation.
  const committer = git(repo, ['show', '-s', '--format=%cn <%ce>', res.oid as string]).trim();
  assert.match(committer, /Lares Checkpoints <checkpoints@lares\.local>/);
  // The user's config is untouched — we set NO local identity (a global user.name may
  // exist on the host and legitimately leaks in per invariant #5; the commit still used
  // the buildGitEnv identity above, not it), and the repo-local gpgsign is still true.
  assert.throws(() => git(repo, ['config', '--local', '--get', 'user.name']), 'no local user.name written');
  assert.equal(git(repo, ['config', '--local', '--get', 'commit.gpgsign']).trim(), 'true');
  // The commit is NOT signed (no gpgsig header).
  assert.equal(git(repo, ['cat-file', 'commit', res.oid as string]).includes('gpgsig'), false);
});

test('sub-prefix staging excludes parent dirty files (nested-in-larger-repo)', async () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'root.txt'), 'root-v1\n');
  fs.writeFileSync(path.join(repo, 'sub', 'inner.txt'), 'inner-v1\n');
  commitAll(repo);
  const rootHeadBlob = git(repo, ['rev-parse', 'HEAD:root.txt']).trim();
  // Dirty BOTH the parent file and the in-scope file.
  fs.writeFileSync(path.join(repo, 'root.txt'), 'root-DIRTY\n');
  fs.writeFileSync(path.join(repo, 'sub', 'inner.txt'), 'inner-DIRTY\n');

  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a',
    capability: capFor(repo, { workspacePrefix: 'sub/' }), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'ready');
  // root.txt keeps the seeded HEAD blob (parent dirt excluded); sub/inner.txt is the dirty worktree bytes.
  const rootInTree = git(repo, ['ls-tree', res.oid as string, '--', 'root.txt']).trim().split(/\s+/)[2];
  assert.equal(rootInTree, rootHeadBlob, 'parent dirty file NOT captured — HEAD blob preserved via seed');
  const innerBytes = execFileSync(EXE, ['cat-file', 'blob',
    git(repo, ['ls-tree', res.oid as string, '--', 'sub/inner.txt']).trim().split(/\s+/)[2]], { cwd: repo });
  assert.deepEqual(innerBytes, Buffer.from('inner-DIRTY\n'));
});

test('tracked-deletion removed from tree; untracked-creation present', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'k\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'g\n');
  commitAll(repo);
  fs.rmSync(path.join(repo, 'gone.txt'));
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'new\n');

  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  const names = git(repo, ['ls-tree', '--name-only', res.oid as string]).trim().split('\n').sort();
  assert.deepEqual(names, ['fresh.txt', 'keep.txt']);
});

test('executable-bit tracked file keeps 100755 under core.filemode=false', async () => {
  const repo = mkRepo({ config: [['core.filemode', 'false']] });
  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho v1\n');
  git(repo, ['add', '--', 'run.sh']);
  git(repo, ['update-index', '--chmod=+x', '--', 'run.sh']); // force 100755 in the index
  git(repo, ['commit', '-q', '-m', 'exec']);
  assert.match(git(repo, ['ls-files', '--stage', '--', 'run.sh']), /^100755 /);
  // Modify content; the mode must still be preserved from the seed, not downgraded.
  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho v2\n');

  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  const mode = git(repo, ['ls-tree', res.oid as string, '--', 'run.sh']).trim().split(/\s+/)[0];
  assert.equal(mode, '100755', 'seeded 100755 preserved (no filemode=false downgrade)');
});

test('unchanged tree → a NEW ref with a possibly-identical OID; never reuses the prior edge ref', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'stable\n');
  commitAll(repo);

  const store = new FakeStore();
  store.seedOpen('T1', 'WS');
  store.seedOpen('T2', 'WS');
  const svc = mkService({ store });
  const r1 = await svc.captureEdge({ edge: 'before', turnId: 'T1', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed' });
  const r2 = await svc.captureEdge({ edge: 'before', turnId: 'T2', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed' });
  await svc.settleCleanups();
  assert.equal(r1.status, 'ready');
  assert.equal(r2.status, 'ready');
  assert.notEqual(r1.ref, r2.ref, 'each turn gets its OWN deterministic ref');
  // Both refs exist and resolve.
  assert.equal(git(repo, ['rev-parse', '--verify', `${r1.ref}^{commit}`]).trim(), r1.oid);
  assert.equal(git(repo, ['rev-parse', '--verify', `${r2.ref}^{commit}`]).trim(), r2.oid);
  // Identical content ⇒ identical tree; the two commit OIDs may or may not match, but
  // the ref names are always distinct (no reuse).
  const t1 = git(repo, ['rev-parse', `${r1.oid}^{tree}`]).trim();
  const t2 = git(repo, ['rev-parse', `${r2.oid}^{tree}`]).trim();
  assert.equal(t1, t2, 'unchanged content → identical tree OID (idempotent object writes)');
});

// ── wall-clock contract ─────────────────────────────────────────────────────────

test('deadline expires before candidate-persist → abandoned (degraded, no ref, nothing for reconciliation)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  commitAll(repo);
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  // finalizeAllowance > budget ⇒ captureDeadline is already in the past on entry ⇒
  // abandon before any candidate is produced.
  const svc = mkService({ store, timing: { beforeBudgetMs: 50, finalizeAllowanceMs: 5000 } });
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'abandoned');
  assert.equal(res.failureReason, 'budget-exceeded');
  assert.equal(res.oid, null);
  assert.equal(res.ref, null);
  assert.equal(store.rows.get('T')!.beforeQuality, 'degraded');
  assert.equal(store.rows.get('T')!.beforeOid, null);
  assert.equal(store.rows.get('T')!.beforeReady, false);
});

test('finalize overrun → delivery released at deadlineAt, edge persisted non-ready; never usable before verify', async () => {
  const repo = mkRepo();
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const fake = makeFakeGit();

  // Slow-update-ref seam: it wants to run far past the deadline; it instead resolves
  // (throwing a deadline kill) exactly AT deadlineAt — modelling git-command's bound.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const slowRunGit: RunGitLike = async (cwd, args, opts) => {
    if (args.includes('update-ref')) {
      const remaining = opts.deadlineAt !== undefined ? opts.deadlineAt - Date.now() : 0;
      await sleep(Math.max(0, remaining));
      throw new GitCommandError('deadline', 'simulated update-ref overrun', null, '');
    }
    return fake.run(cwd, args, opts);
  };
  // Keep capture deterministic so this row tests only the finalize-overrun contract;
  // real-Git capture duration is covered by the invariant rows above. Budget 300,
  // finalize allowance 200 ⇒ captureDeadline = enqueue+100, while the absolute
  // deadlineAt = enqueue+300 cuts off finalization.
  const svc = mkService({
    store,
    runGit: slowRunGit,
    enumerate: synthEnumeration({
      capturable: [{ path: 'a.txt', type: 'regular', mode: 0o644, size: 1 }],
      observed: { paths: 1, bytes: 1 },
    }),
    timing: { beforeBudgetMs: 300, finalizeAllowanceMs: 200 },
  });
  const enqueueTime = Date.now();
  const res = await svc.captureEdge({
    edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed', enqueueTime,
  });
  const elapsed = Date.now() - enqueueTime;
  await svc.settleCleanups();

  assert.equal(res.status, 'persisted-non-ready');
  assert.ok(res.oid, 'candidate OID persisted for reconciliation');
  assert.ok(res.ref, 'deterministic ref name persisted for reconciliation');
  assert.equal(res.ready, false);
  // Delivery is not held past the deadline: the service returns by ~deadlineAt.
  assert.ok(elapsed <= 300 + 400, `returned by ~deadlineAt (elapsed ${elapsed}ms)`);
  // The row records the candidate but is NON-ready (ready=0) — never a usable guarantee.
  assert.equal(store.rows.get('T')!.beforeOid, res.oid);
  assert.equal(store.rows.get('T')!.beforeReady, false);
  assert.notEqual(store.rows.get('T')!.beforeQuality, 'guaranteed');
});

// ══ FAKE-GIT control-flow proofs (deterministic; platform-independent) ═══════════

/** A canned git that emulates just the snapshot+finalize plumbing and records what
 *  it was asked to do — no real process, so newline filenames + argv chunking + the
 *  index-info batch shape can be asserted precisely (and on Windows). */
function makeFakeGit(opts: { seededModes?: string; onUpdateRef?: () => void; verifyMismatch?: boolean } = {}) {
  const KNOWN = ['read-tree', 'ls-files', 'hash-object', 'update-index', 'write-tree', 'commit-tree', 'update-ref', 'rev-parse'];
  const hashInvocations: string[][] = [];
  const indexInfoBatches: string[] = [];
  const eventLog: string[] = [];
  let counter = 1;
  let lastCommit = '';
  const run: RunGitLike = async (_cwd, args, o: RunGitOptions): Promise<GitRunResult> => {
    const sub = args.find((a) => KNOWN.includes(a)) ?? '';
    eventLog.push(sub);
    const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' });
    switch (sub) {
      case 'read-tree': return ok();
      case 'ls-files': return ok(opts.seededModes ?? '');
      case 'hash-object': {
        const dd = args.indexOf('--');
        const paths = args.slice(dd + 1);
        hashInvocations.push(paths);
        return ok(paths.map(() => (counter++).toString(16).padStart(40, '0')).join('\n') + '\n');
      }
      case 'update-index': {
        indexInfoBatches.push(String(o.stdin ?? ''));
        return ok();
      }
      case 'write-tree': return ok('t'.repeat(40) + '\n');
      case 'commit-tree': { lastCommit = (counter++).toString(16).padStart(40, '0'); return ok(lastCommit + '\n'); }
      case 'update-ref': { opts.onUpdateRef?.(); return ok(); }
      case 'rev-parse': return ok((opts.verifyMismatch ? 'f'.repeat(40) : lastCommit) + '\n');
      default: return ok();
    }
  };
  return { run, hashInvocations, indexInfoBatches, eventLog, get lastCommit() { return lastCommit; } };
}

function synthEnumeration(over: Partial<EnumerationResult>): (o: unknown) => Promise<EnumerationOutcome> {
  const base: EnumerationResult = {
    kind: 'ok', capturable: [], deletions: [], gitlinks: [], unsupported: [],
    filteredPaths: [], beforeRawFilterBypassed: false, observed: { paths: 0, bytes: 0 },
  };
  return async () => ({ ...base, ...over });
}

test('durable finalize write order: persist ready=0 → update-ref → rev-parse verify → mark ready=1', async () => {
  const fake = makeFakeGit();
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const combined: string[] = [];
  // Interleave store + git events by wrapping both sinks.
  const svc = new CheckpointService({
    queue: new CheckpointQueue(), gitExe: EXE, runGit: async (c, a, o) => { const r = await fake.run(c, a, o); combined.push(`git:${a.find((x) => ['update-ref', 'rev-parse'].includes(x)) ?? ''}`.replace(/:$/, '')); return r; },
    store: new Proxy(store, { get(t, p) { if (p === 'updateTurnRecord') return (id: string, u: Record<string, unknown>) => { combined.push(u.beforeReady === false ? 'store:persist0' : u.beforeReady === true ? 'store:persist1' : 'store:update'); return t.updateTurnRecord(id, u); }; return (t as never)[p]; } }) as unknown as CheckpointTurnStore,
    enumerate: synthEnumeration({ capturable: [{ path: 'a.txt', type: 'regular', mode: 0o644, size: 1 }], observed: { paths: 1, bytes: 1 } }),
  });
  const res = await svc.captureEdge({ edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(mkRepo()), quality: 'guaranteed' });
  await svc.settleCleanups();
  assert.equal(res.status, 'ready');
  const order = combined.filter((e) => e !== 'git');
  // The candidate is persisted (ready=0) BEFORE the ref write; ready=1 only AFTER verify.
  const persist0 = order.indexOf('store:persist0');
  const updateRef = order.findIndex((e) => e.includes('update-ref'));
  const revParse = order.findIndex((e) => e.includes('rev-parse'));
  const persist1 = order.indexOf('store:persist1');
  assert.ok(persist0 >= 0 && updateRef > persist0, 'persist ready=0 precedes update-ref');
  assert.ok(revParse > updateRef, 'rev-parse verify follows update-ref');
  assert.ok(persist1 > revParse, 'mark ready=1 follows verify');
});

test('verify mismatch after candidate-persist → persisted-non-ready (never marked ready)', async () => {
  const fake = makeFakeGit({ verifyMismatch: true });
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = new CheckpointService({
    queue: new CheckpointQueue(), gitExe: EXE, runGit: fake.run, store,
    enumerate: synthEnumeration({ capturable: [{ path: 'a', type: 'regular', mode: 0o644, size: 1 }], observed: { paths: 1, bytes: 1 } }),
  });
  const res = await svc.captureEdge({ edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(mkRepo()), quality: 'guaranteed' });
  assert.equal(res.status, 'persisted-non-ready');
  assert.equal(res.failureReason, 'finalize-verify-mismatch');
  assert.equal(store.rows.get('T')!.beforeReady, false);
});

test('newline-in-filename hashed in its OWN invocation; argv chunking bounded', async () => {
  const fake = makeFakeGit();
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  // One newline-containing name + many long normal names to force >1 chunk.
  const nl = 'weird\nname.txt';
  const many = Array.from({ length: 400 }, (_, i) => `dir/file-${'x'.repeat(80)}-${i}.txt`);
  const svc = new CheckpointService({
    queue: new CheckpointQueue(), gitExe: EXE, runGit: fake.run, store,
    enumerate: synthEnumeration({
      capturable: [{ path: nl, type: 'regular', mode: 0o644, size: 1 }, ...many.map((p) => ({ path: p, type: 'regular' as const, mode: 0o644, size: 1 }))],
      observed: { paths: many.length + 1, bytes: many.length + 1 },
    }),
  });
  const res = await svc.captureEdge({ edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(mkRepo()), quality: 'guaranteed' });
  assert.equal(res.status, 'ready');
  // The newline path is alone in exactly one invocation.
  const soloNl = fake.hashInvocations.filter((inv) => inv.length === 1 && inv[0] === nl);
  assert.equal(soloNl.length, 1, 'newline path hashed by itself');
  assert.equal(fake.hashInvocations.some((inv) => inv.length > 1 && inv.includes(nl)), false);
  // The normal names were chunked (more than one invocation) and every chunk is bounded.
  const normalInvs = fake.hashInvocations.filter((inv) => !(inv.length === 1 && inv[0] === nl));
  assert.ok(normalInvs.length >= 2, 'normal set split into multiple bounded chunks');
  for (const inv of normalInvs) {
    const argLen = ['hash-object', '--no-filters', '-w', '--', ...inv].join(' ').length;
    assert.ok(argLen <= 30_000, `chunk within argv bound (${argLen})`);
  }
  // Every capturable path was hashed exactly once.
  const allHashed = fake.hashInvocations.flat().sort();
  assert.deepEqual(allHashed, [nl, ...many].sort());
});

test('single NUL-safe index-info batch: additions + tracked-absent delete form', async () => {
  const fake = makeFakeGit();
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = new CheckpointService({
    queue: new CheckpointQueue(), gitExe: EXE, runGit: fake.run, store,
    enumerate: synthEnumeration({
      capturable: [{ path: 'a.txt', type: 'regular', mode: 0o644, size: 1 }, { path: 'link', type: 'symlink', mode: 0o120000, size: 1 }],
      deletions: ['gone.txt'],
      observed: { paths: 3, bytes: 2 },
    }),
  });
  await svc.captureEdge({ edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(mkRepo()), quality: 'guaranteed' });
  assert.equal(fake.indexInfoBatches.length, 1, 'exactly one update-index --index-info batch');
  const batch = fake.indexInfoBatches[0];
  const records = batch.split('\0').filter((r) => r.length > 0);
  // a.txt is a regular addition (100644); link is a new symlink (120000); gone.txt is the delete form.
  assert.ok(records.some((r) => /^100644 [0-9a-f]{40}\ta\.txt$/.test(r)), 'regular addition');
  assert.ok(records.some((r) => /^120000 [0-9a-f]{40}\tlink$/.test(r)), 'symlink addition mode 120000');
  assert.ok(records.some((r) => /^0 0{40}\tgone\.txt$/.test(r)), 'delete form for tracked-absent path');
});

test('gitlink (160000) visibly rejected, never captured', async () => {
  const fake = makeFakeGit();
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = new CheckpointService({
    queue: new CheckpointQueue(), gitExe: EXE, runGit: fake.run, store,
    enumerate: synthEnumeration({
      capturable: [{ path: 'keep.txt', type: 'regular', mode: 0o644, size: 1 }],
      gitlinks: ['submod'],
      unsupported: ['a.fifo'],
      observed: { paths: 1, bytes: 1 },
    }),
  });
  const res = await svc.captureEdge({ edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(mkRepo()), quality: 'guaranteed' });
  assert.equal(res.status, 'ready');
  assert.deepEqual(res.rejectedGitlinks, ['submod']);
  assert.deepEqual(res.unsupportedPaths, ['a.fifo']);
  // The submodule path is never handed to hash-object.
  assert.equal(fake.hashInvocations.flat().includes('submod'), false);
  // The index-info batch stages only the real file, never the gitlink.
  assert.equal(fake.indexInfoBatches[0].includes('submod'), false);
});

// ── diff generation ─────────────────────────────────────────────────────────────

test('witnessed-path diff and raw-window diff returned separately + labeled; unusable edge → unavailable', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  commitAll(repo);
  const store = new FakeStore();
  store.seedOpen('T', 'WS');
  const svc = mkService({ store });

  const before = await svc.captureEdge({ edge: 'before', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'guaranteed' });
  assert.equal(before.status, 'ready');
  // The agent writes a.txt (witnessed) and drops an unattributed b.txt.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'sneaky\n');
  store.rows.get('T')!.touched = [{ path: 'a.txt', op: 'write' }];
  const after = await svc.captureEdge({ edge: 'after', turnId: 'T', workspaceId: 'WS', agentId: 'a', capability: capFor(repo), quality: 'hook' });
  assert.equal(after.status, 'ready');
  await svc.settleCleanups();

  const diffs = await svc.generateDiffs('T', repo);
  assert.equal(diffs.witnessed.available, true);
  assert.equal(diffs.witnessed.label, 'witnessed changes');
  assert.equal(diffs.witnessed.provenance, 'witnessed');
  assert.match(diffs.witnessed.text as string, /a\.txt/);
  assert.equal((diffs.witnessed.text as string).includes('b.txt'), false, 'witnessed diff is scoped to witnessed paths');

  assert.equal(diffs.window.available, true);
  assert.equal(diffs.window.label, 'unattributed changes in this window');
  assert.equal(diffs.window.provenance, 'raw-window');
  assert.match(diffs.window.text as string, /b\.txt/, 'raw-window diff surfaces the unattributed change');

  // A ready flag alone is never enough: delete the ref and both diffs go unavailable
  // (live rev-parse is the authority, not the DB).
  git(repo, ['update-ref', '-d', after.ref as string]);
  const gone = await svc.generateDiffs('T', repo);
  assert.equal(gone.witnessed.available, false);
  assert.equal(gone.window.available, false);
});

// ── WP-G3.1 file history ────────────────────────────────────────────────────────

test('fileHistory lists only live-verified before-edges; a pruned edge is excluded', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v0\n');
  commitAll(repo);
  const store = new FakeStore();
  const svc = mkService({ store });

  // Turn T1 writes a.txt (witnessed) — both edges captured + ready.
  store.seedOpen('T1', 'WS', { turnSeq: 1, agentId: 'ag', agentTitle: 'Worker 7', taskLabel: 'edit a' });
  const b1 = await svc.captureEdge({ edge: 'before', turnId: 'T1', workspaceId: 'WS', agentId: 'ag', capability: capFor(repo), quality: 'guaranteed' });
  assert.equal(b1.status, 'ready');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  store.rows.get('T1')!.touched = [{ path: 'a.txt', op: 'write' }];
  const a1 = await svc.captureEdge({ edge: 'after', turnId: 'T1', workspaceId: 'WS', agentId: 'ag', capability: capFor(repo), quality: 'hook' });
  assert.equal(a1.status, 'ready');

  // Turn T2 also writes a.txt, but its before ref is later PRUNED.
  store.seedOpen('T2', 'WS', { turnSeq: 2, agentId: 'ag', agentTitle: 'Worker 7', taskLabel: 'edit a again' });
  const b2 = await svc.captureEdge({ edge: 'before', turnId: 'T2', workspaceId: 'WS', agentId: 'ag', capability: capFor(repo), quality: 'guaranteed' });
  assert.equal(b2.status, 'ready');
  store.rows.get('T2')!.touched = [{ path: 'a.txt', op: 'write' }];
  await svc.settleCleanups();

  // Prune T2's before ref → live rev-parse fails → the version must be excluded.
  git(repo, ['update-ref', '-d', b2.ref as string]);

  const versions = await svc.fileHistory({ workspaceId: 'WS', path: 'a.txt', repoRoot: repo });
  assert.equal(versions.length, 1, 'only the live-verified before-edge is listed');
  assert.equal(versions[0].turnId, 'T1');
  assert.equal(versions[0].witnessedPath, 'a.txt');
  assert.equal(versions[0].op, 'write');
  assert.equal(versions[0].agentTitle, 'Worker 7');
  assert.equal(versions[0].afterVerified, true, 'both edges live → diff available');

  // A path with no witnessed history → empty.
  assert.deepEqual(await svc.fileHistory({ workspaceId: 'WS', path: 'nope.txt', repoRoot: repo }), []);

  // An absolute worktree path canonicalizes to the same repo-relative key.
  const abs = await svc.fileHistory({ workspaceId: 'WS', path: path.join(repo, 'a.txt'), repoRoot: repo });
  assert.equal(abs.length, 1, 'absolute path resolves to the repo-relative witnessed key');
  assert.equal(abs[0].turnId, 'T1');

  // If T1's before ref is ALSO pruned, the whole history goes empty (nothing restorable).
  git(repo, ['update-ref', '-d', b1.ref as string]);
  assert.deepEqual(await svc.fileHistory({ workspaceId: 'WS', path: 'a.txt', repoRoot: repo }), []);
});

// ── attribution enforcement ─────────────────────────────────────────────────────

test('revertTurn path set = canonical witnessed write/create set (deduped)', () => {
  const store = new FakeStore();
  store.seedOpen('T', 'WS', { touched: [{ path: 'a', op: 'write' }, { path: 'b', op: 'create' }, { path: 'a', op: 'write' }] });
  const svc = mkService({ store });
  assert.deepEqual(svc.revertTurnPathSet('T').paths, ['a', 'b']);
});

test('restorePaths accepts only a subset; rejects non-witnessed; flags same-path open-turn contention', () => {
  const store = new FakeStore();
  store.seedOpen('T', 'WS', { touched: [{ path: 'a', op: 'write' }, { path: 'b', op: 'create' }] });
  store.seedOpen('T2', 'WS', { touched: [{ path: 'a', op: 'write' }] }); // still OPEN — contends on 'a'
  const svc = mkService({ store });

  const subsetOk = svc.validateRestorePaths('T', ['a'], 'WS');
  assert.equal(subsetOk.ok, true);
  assert.deepEqual(subsetOk.validatedPaths, ['a']);
  assert.deepEqual(subsetOk.rejectedPaths, []);
  assert.deepEqual(subsetOk.contention, [{ path: 'a', turnId: 'T2' }]);

  const nonWitnessed = svc.validateRestorePaths('T', ['a', 'c'], 'WS');
  assert.equal(nonWitnessed.ok, false, 'non-witnessed path rejected');
  assert.deepEqual(nonWitnessed.rejectedPaths, ['c']);
  assert.deepEqual(nonWitnessed.validatedPaths, ['a']);

  // A CLOSED turn no longer contends.
  (store.rows.get('T2') as Record<string, unknown>).status = 'accepted';
  assert.deepEqual(svc.validateRestorePaths('T', ['a'], 'WS').contention, []);
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-G1.3b tests need real git.');
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
