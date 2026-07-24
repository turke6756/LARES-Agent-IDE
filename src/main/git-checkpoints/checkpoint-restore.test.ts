// Git-Native WP-G1.3c — Restore: guarded blob-write (uniform, byte-exact).
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/checkpoint-restore.test.js
//
// Restore is the second safety-critical half of the checkpoint engine, so its invariant
// proofs run a REAL git in throwaway temp repos. The proofs cover, per the plan's G1.3c
// test list:
//   • byte-exact restore of scrambled / deleted / created paths (create → delete on
//     revert); the real index checksum + HEAD + ALL branch refs unchanged; porcelain
//     unchanged for UNAFFECTED paths; affected entries exactly reflect restored bytes;
//   • core.autocrlf=true byte-exactness (no re-normalization / smudge); binary byte-exact;
//   • the check-ignore exit-code contract (exit 1 = proceed; ignored request = reject);
//   • unsupported-entry-type rejection; the path-scoped PRE safety snapshot recorded with
//     present/absent structure + its ref verified BEFORE any mutation;
//   • mutation-blocked-midway → partial with accurate completed_paths + a usable PRE;
//   • directory-transition guards (non-empty dir blocking, no recursive deletion of
//     unrelated descendants); symlink-ancestor traversal rejection; Windows read-only
//     replace; symlink/mode → visible failure; file↔directory transition;
//   • a concurrent BEFORE enqueued during a restore waits (withLock held).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveInternalGit } from '../git/git-runtime';
import {
  runGit as realRunGit,
  runGitBlobToFile as realRunGitBlobToFile,
  type RunGitBlobToFileOptions,
} from './git-command';
import { CheckpointQueue } from './checkpoint-queue';
import { enumerateScope, type EnumerationOutcome } from './checkpoint-gating';
import type { GitCapability } from '../../shared/types';
import type { TurnRecord, RecoveryOperation, InsertRecoveryOperationFields } from '../database';
import {
  CheckpointService,
  type CheckpointTurnStore,
  type CheckpointRecoveryStore,
  type CheckpointServiceOptions,
  type RestoreOutcome,
  type PreIncludedPath,
} from './checkpoint-service';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

let EXE = '';
const trash: string[] = [];
function mkTmpDir(prefix = 'lares-restore-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(d);
  return d;
}
function cleanup(): void {
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function git(cwd: string, args: string[], input?: Buffer | string): string {
  return execFileSync(EXE, args, { cwd, input }).toString();
}
function mkRepo(opts: { config?: [string, string][] } = {}): string {
  const dir = mkTmpDir();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@lares.local']);
  git(dir, ['config', 'user.name', 'Lares Test']);
  for (const [k, v] of opts.config ?? []) git(dir, ['config', k, v]);
  return dir;
}
function commitAll(repo: string, msg = 'c'): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}
function capFor(repo: string, opts: { workspacePrefix?: string } = {}): GitCapability {
  const real = fs.realpathSync(repo);
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo',
    commonDir: path.join(real, '.git'),
    commonDirQueueKey: real.toLowerCase(),
    repoRoot: repo,
    workspacePrefix: opts.workspacePrefix ?? '',
    protectedRoot: false,
    reason: 'ok',
    detail: null,
  };
}

// ── in-memory stores ────────────────────────────────────────────────────────────

class FakeStore implements CheckpointTurnStore {
  rows = new Map<string, Record<string, unknown>>();
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
    Object.assign(r, updates);
    return { ...r } as unknown as TurnRecord;
  }
  listTurnRecords(workspaceId: string, opts?: { agentId?: string }): TurnRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (!opts?.agentId || r.agentId === opts.agentId))
      .map((r) => ({ ...r } as unknown as TurnRecord));
  }
}

class FakeRecoveryStore implements CheckpointRecoveryStore {
  rows = new Map<string, Record<string, unknown>>();
  insertRecoveryOperation(workspaceId: string, fields: InsertRecoveryOperationFields): RecoveryOperation {
    const id = fields.id ?? randomUUID();
    const row: Record<string, unknown> = {
      id, workspaceId,
      kind: fields.kind, actor: fields.actor,
      sourceTurnId: fields.sourceTurnId ?? null,
      preRef: fields.preRef ?? null, preOid: fields.preOid ?? null, preReady: !!fields.preReady,
      preIncludedPaths: fields.preIncludedPaths ?? null,
      requestedPaths: fields.requestedPaths ?? null,
      previewToken: fields.previewToken ?? null,
      status: fields.status ?? 'pending',
      completedPaths: fields.completedPaths ?? null,
      result: fields.result ?? null, failureReason: fields.failureReason ?? null,
      createdAt: 1, endedAt: null,
    };
    this.rows.set(id, row);
    return { ...row } as unknown as RecoveryOperation;
  }
  getRecoveryOperation(id: string): RecoveryOperation | null {
    const r = this.rows.get(id);
    return r ? ({ ...r } as unknown as RecoveryOperation) : null;
  }
  updateRecoveryOperation(id: string, updates: Record<string, unknown>): RecoveryOperation | null {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, updates);
    return { ...r } as unknown as RecoveryOperation;
  }
}

function mkService(over: Partial<CheckpointServiceOptions> & { store: FakeStore; recoveryStore: FakeRecoveryStore }): CheckpointService {
  return new CheckpointService({
    queue: over.queue ?? new CheckpointQueue(),
    gitExe: EXE,
    ...over,
  });
}

// ── setup: capture a REAL, usable before edge, then wire the turn's witnessed set ──

interface Setup {
  svc: CheckpointService;
  store: FakeStore;
  recoveryStore: FakeRecoveryStore;
  queue: CheckpointQueue;
  beforeOid: string;
}
/** Capture a real before edge for `turnId` over `repo`, seed `touched`, return the svc. */
async function setupBefore(
  repo: string,
  turnId: string,
  ws: string,
  touched: { path: string; op: string }[],
): Promise<Setup> {
  const store = new FakeStore();
  const recoveryStore = new FakeRecoveryStore();
  store.seedOpen(turnId, ws, { agentId: 'agent-1' });
  const queue = new CheckpointQueue();
  const svc = mkService({ store, recoveryStore, queue });
  const before = await svc.captureEdge({
    edge: 'before', turnId, workspaceId: ws, agentId: 'agent-1',
    capability: capFor(repo), quality: 'guaranteed',
  });
  await svc.settleCleanups();
  assert.equal(before.status, 'ready', 'before edge must be ready for restore');
  store.rows.get(turnId)!.touched = touched;
  return { svc, store, recoveryStore, queue, beforeOid: before.oid as string };
}

/** Build a synthetic before commit with arbitrary index-info entries (crafts modes a
 *  real worktree cannot portably produce: 120000 symlink / 160000 gitlink). Wires the
 *  turn row's before edge to a fresh ref pointing at it. */
function craftBeforeEdge(
  repo: string,
  store: FakeStore,
  turnId: string,
  entries: { mode: string; path: string; content?: string; oid?: string }[],
): string {
  const idx = path.join(mkTmpDir('craft-idx-'), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const lines: string[] = [];
  for (const e of entries) {
    let oid = e.oid;
    if (oid === undefined) {
      oid = execFileSync(EXE, ['hash-object', '-w', '--stdin'], { cwd: repo, input: e.content ?? '' }).toString().trim();
    }
    lines.push(`${e.mode} ${oid}\t${e.path}`);
  }
  execFileSync(EXE, ['update-index', '--index-info'], { cwd: repo, env, input: lines.join('\n') + '\n' });
  const tree = execFileSync(EXE, ['write-tree'], { cwd: repo, env }).toString().trim();
  const commit = execFileSync(EXE, ['commit-tree', tree, '-m', 'craft-before'], { cwd: repo, env }).toString().trim();
  const ref = `refs/lares/craft/${turnId}`;
  git(repo, ['update-ref', ref, commit]);
  const row = store.rows.get(turnId)!;
  row.beforeOid = commit;
  row.beforeRef = ref;
  row.beforeReady = true;
  return commit;
}

function indexChecksum(repo: string): string {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex');
}
function refsHeads(repo: string): string { return git(repo, ['for-each-ref', 'refs/heads']); }
function porcelain(repo: string): string { return git(repo, ['status', '--porcelain=v2']); }
function preOf(rs: FakeRecoveryStore, opId: string): PreIncludedPath[] {
  return (rs.rows.get(opId)!.preIncludedPaths as PreIncludedPath[]) ?? [];
}

// ══ byte-exact restore + invariant #1 ═══════════════════════════════════════════

test('scrambled file restored byte-exact; index checksum + HEAD + all branch refs unchanged; porcelain unchanged for unaffected paths', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'orig-a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'orig-b\n');
  commitAll(repo);
  git(repo, ['branch', 'feature']);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'a.txt', op: 'write' }]);

  // The agent scrambles the witnessed a.txt AND leaves an UNAFFECTED dirty b.txt.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'SCRAMBLED-DIFFERENT-LENGTH\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'orig-b-dirty\n');

  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const idxBefore = indexChecksum(repo);
  const refsBefore = refsHeads(repo);
  const porcBBefore = porcelain(repo).split('\n').filter((l) => l.includes('b.txt')).join('\n');

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['a.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();

  assert.equal(res.status, 'completed');
  assert.deepEqual(res.completedPaths, ['a.txt']);
  // Affected entry reflects restored bytes exactly (byte compare, not git restore).
  assert.deepEqual(fs.readFileSync(path.join(repo, 'a.txt')), Buffer.from('orig-a\n'));
  // Invariant #1: HEAD / real index checksum / ALL branch refs untouched.
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'HEAD unchanged');
  assert.equal(indexChecksum(repo), idxBefore, 'real index checksum unchanged');
  assert.equal(refsHeads(repo), refsBefore, 'all refs/heads/* unchanged');
  // Porcelain for the UNAFFECTED b.txt is identical.
  const porcBAfter = porcelain(repo).split('\n').filter((l) => l.includes('b.txt')).join('\n');
  assert.equal(porcBAfter, porcBBefore, 'porcelain unchanged for unaffected b.txt');
  // No restore temp leaked.
  assert.equal(fs.readdirSync(repo).some((f) => f.startsWith('.lares-restore-')), false);
});

test('core.autocrlf=true: restore is byte-exact CRLF (no re-normalization / smudge)', async () => {
  const repo = mkRepo({ config: [['core.autocrlf', 'true']] });
  const crlf = Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'latin1');
  fs.writeFileSync(path.join(repo, 'win.txt'), crlf);
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'win.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'win.txt'), Buffer.from('scrambled\n'));

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['win.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'win.txt')), crlf, 'exact CRLF bytes restored, not the LF-normalized HEAD blob');
});

test('binary file restored byte-exact', async () => {
  const repo = mkRepo();
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 13, 10, 200, 42]);
  fs.writeFileSync(path.join(repo, 'blob.bin'), bin);
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'blob.bin', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([9, 9, 9]));

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['blob.bin'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'blob.bin')), bin);
});

// ══ check-ignore contract ═══════════════════════════════════════════════════════

test('all-clean input → check-ignore exits 1 → restore PROCEEDS (exit 1 is not failure)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'a.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n');
  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['a.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed', 'no requested path ignored → proceed');
  assert.equal(res.failureReason, null);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'a.txt')), Buffer.from('v1\n'));
});

test('ignored-untracked requested path → visible rejection (not-covered-by-before-checkpoint), NO mutation', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'debug.log', op: 'create' }]);
  fs.writeFileSync(path.join(repo, 'debug.log'), 'AGENT-CREATED\n');

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['debug.log'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, 'not-covered-by-before-checkpoint');
  assert.deepEqual(res.rejectedPaths, ['debug.log']);
  assert.deepEqual(res.completedPaths, []);
  // No mutation: the ignored file is untouched.
  assert.deepEqual(fs.readFileSync(path.join(repo, 'debug.log')), Buffer.from('AGENT-CREATED\n'));
});

// ══ create / delete round-trips + PRE structure ═════════════════════════════════

test('untracked-creation restore removes it; PRE recorded it present (reversible)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'created.txt', op: 'create' }]);
  fs.writeFileSync(path.join(repo, 'created.txt'), 'agent-made-this\n');

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['created.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.equal(fs.existsSync(path.join(repo, 'created.txt')), false, 'created file removed on revert');
  // PRE captured the created file as present → the op is reversible.
  const pre = preOf(s.recoveryStore, res.operationId);
  const entry = pre.find((p) => p.path === 'created.txt')!;
  assert.equal(entry.state, 'present');
  assert.ok(entry.oid && entry.mode === '100644');
});

test('tracked-deletion restore recreates exact bytes; PRE records the currently-absent path as absent', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'important-data\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'gone.txt', op: 'write' }]);
  fs.rmSync(path.join(repo, 'gone.txt'));

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['gone.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'gone.txt')), Buffer.from('important-data\n'));
  const pre = preOf(s.recoveryStore, res.operationId);
  assert.equal(pre.find((p) => p.path === 'gone.txt')!.state, 'absent');
});

test('PRE safety ref is created + VERIFIED before any mutation, is path-scoped, and holds the pre-restore bytes', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'orig\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'keep.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'scrambled\n');

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['keep.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.ok(res.preRef && res.preOid);
  // The pre ref exists and resolves to the persisted pre commit (verified live).
  assert.equal(git(repo, ['rev-parse', '--verify', `${res.preRef}^{commit}`]).trim(), res.preOid);
  assert.equal(s.recoveryStore.rows.get(res.operationId)!.preReady, true);
  // The pre ref authoritatively holds keep.txt's PRE-restore bytes (rollback source):
  const preKeep = git(repo, ['cat-file', 'blob', `${res.preOid}:keep.txt`]);
  assert.equal(preKeep, 'scrambled\n', 'pre ref carries the pre-restore (scrambled) bytes → rollback re-scrambles');
  // Path-scoped: pre_included_paths lists ONLY the requested path, never other.txt.
  const pre = preOf(s.recoveryStore, res.operationId);
  assert.deepEqual(pre.map((p) => p.path), ['keep.txt']);
  assert.equal(pre.find((p) => p.path === 'other.txt'), undefined);
});

// ══ directory-transition safety (invariant #24) ═════════════════════════════════

test('non-empty directory with an UNRELATED file, tree wants a file → fails visibly; unrelated file survives', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'data'), 'orig-file\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'data', op: 'write' }]);
  // Agent replaced the file `data` with a directory holding an unrelated file.
  fs.rmSync(path.join(repo, 'data'));
  fs.mkdirSync(path.join(repo, 'data'));
  fs.writeFileSync(path.join(repo, 'data', 'unrelated.txt'), 'keep-me\n');

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['data'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'partial');
  assert.deepEqual(res.completedPaths, []);
  assert.equal(res.failures[0].path, 'data');
  assert.match(res.failures[0].reason, /dir-transition-blocked/);
  // The unrelated descendant is NEVER recursively deleted.
  assert.deepEqual(fs.readFileSync(path.join(repo, 'data', 'unrelated.txt')), Buffer.from('keep-me\n'));
});

test('empty directory occupying a file path → removed and replaced with the restored file', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'x'), 'file-bytes\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'x', op: 'write' }]);
  fs.rmSync(path.join(repo, 'x'));
  fs.mkdirSync(path.join(repo, 'x')); // empty dir in the way

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['x'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.ok(fs.statSync(path.join(repo, 'x')).isFile());
  assert.deepEqual(fs.readFileSync(path.join(repo, 'x')), Buffer.from('file-bytes\n'));
});

// ══ symlink-ancestor traversal rejection (invariant #13) ════════════════════════

test('symlink/junction ancestor escaping the workspace → rejected; the outside target is never written', async () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, 'data'));
  fs.writeFileSync(path.join(repo, 'data', 'secret.txt'), 'orig\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'data/secret.txt', op: 'write' }]);

  // Agent replaces the in-workspace `data` dir with a link escaping the workspace.
  const outside = mkTmpDir('outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'evil-preexisting\n');
  fs.rmSync(path.join(repo, 'data'), { recursive: true, force: true });
  try {
    fs.symlinkSync(outside, path.join(repo, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    console.error('  SKIP inner — could not create a symlink/junction:', (err as Error).message);
    return;
  }

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['data/secret.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'partial');
  assert.match(res.failures[0].reason, /ancestor-escapes-workspace/);
  // The out-of-workspace target is untouched — the escape was refused, not followed.
  assert.deepEqual(fs.readFileSync(path.join(outside, 'secret.txt')), Buffer.from('evil-preexisting\n'));
});

// ══ Windows read-only replace ═══════════════════════════════════════════════════

test('read-only target is replaced (Windows read-only clear); byte-exact', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'ro.txt'), 'v1\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'ro.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'ro.txt'), 'v2-dirty\n');
  fs.chmodSync(path.join(repo, 'ro.txt'), 0o444); // read-only

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['ro.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'ro.txt')), Buffer.from('v1\n'));
});

// ══ symlink / gitlink tree mode → visible failure (never silent conversion) ══════

test('before-tree symlink (120000) and gitlink (160000) modes → visible per-path failure, never converted', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  commitAll(repo);
  const store = new FakeStore();
  const recoveryStore = new FakeRecoveryStore();
  store.seedOpen('T', 'WS', { agentId: 'a', touched: [{ path: 'link', op: 'write' }, { path: 'sub', op: 'write' }] });
  const svc = mkService({ store, recoveryStore });
  // Craft a before edge whose tree has a symlink + a gitlink at these paths. A gitlink
  // (160000) must point at a real commit OID — reuse HEAD's.
  const headCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  craftBeforeEdge(repo, store, 'T', [
    { mode: '120000', path: 'link', content: 'some/target' },
    { mode: '160000', path: 'sub', oid: headCommit },
  ]);
  // Current worktree: plain files (so classification passes).
  fs.writeFileSync(path.join(repo, 'link'), 'regular\n');
  fs.writeFileSync(path.join(repo, 'sub'), 'regular\n');

  const res = await svc.restorePaths({
    turnId: 'T', requestedPaths: ['link', 'sub'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'partial');
  assert.deepEqual(res.completedPaths, []);
  const byPath = Object.fromEntries(res.failures.map((f) => [f.path, f.reason]));
  assert.match(byPath['link'], /symlink-restore-unsupported/);
  assert.match(byPath['sub'], /gitlink-restore-unsupported/);
  // Never silently converted — the worktree files are left as they were.
  assert.deepEqual(fs.readFileSync(path.join(repo, 'link')), Buffer.from('regular\n'));
});

// ══ unsupported current entry type ══════════════════════════════════════════════

test('unsupported current entry type (FIFO/device via injected lstat) → rejected, no mutation', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'a.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n');

  // Inject an lstat that reports a.txt as a FIFO (a device/FIFO is impossible to
  // create on Windows; the injected seam models it deterministically).
  const store = s.store;
  const svc = mkService({
    store, recoveryStore: s.recoveryStore, queue: s.queue,
    lstat: () => ({
      isFile: false, isSymbolicLink: false, isDirectory: false,
      isFIFO: true, isSocket: false, isCharacterDevice: false, isBlockDevice: false,
      mode: 0, size: 0,
    }),
  });
  const res = await svc.restorePaths({
    turnId: 'T', requestedPaths: ['a.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, 'not-covered-by-before-checkpoint');
  assert.deepEqual(res.rejectedPaths, ['a.txt']);
  // No mutation: still the dirty bytes.
  assert.deepEqual(fs.readFileSync(path.join(repo, 'a.txt')), Buffer.from('v2\n'));
});

// ══ partial-failure accounting ══════════════════════════════════════════════════

test('mutation blocked midway → partial with accurate completed_paths, PRE usable to roll back', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'good.txt'), 'good-orig\n');
  commitAll(repo);
  const store = new FakeStore();
  const recoveryStore = new FakeRecoveryStore();
  store.seedOpen('T', 'WS', { agentId: 'a', touched: [{ path: 'good.txt', op: 'write' }, { path: 'bad', op: 'write' }] });
  const svc = mkService({ store, recoveryStore });
  // good.txt restores to a real blob; `bad` is a symlink mode → per-path failure.
  const goodBlob = git(repo, ['rev-parse', 'HEAD:good.txt']).trim();
  craftBeforeEdge(repo, store, 'T', [
    { mode: '100644', path: 'good.txt', oid: goodBlob },
    { mode: '120000', path: 'bad', content: 'target' },
  ]);
  fs.writeFileSync(path.join(repo, 'good.txt'), 'good-dirty\n');
  fs.writeFileSync(path.join(repo, 'bad'), 'regular\n');

  const res = await svc.restorePaths({
    turnId: 'T', requestedPaths: ['good.txt', 'bad'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  await svc.settleCleanups();
  assert.equal(res.status, 'partial');
  assert.deepEqual(res.completedPaths, ['good.txt']);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'good.txt')), Buffer.from('good-orig\n'), 'the succeeding path restored');
  // The recovery row is recoverable: partial with completed_paths populated + a pre ref.
  const row = recoveryStore.rows.get(res.operationId)!;
  assert.equal(row.status, 'partial');
  assert.deepEqual(row.completedPaths, ['good.txt']);
  assert.ok(row.preRef && row.preReady === true);
  // PRE holds good.txt's pre-restore bytes → the completed path is rollback-able.
  assert.equal(git(repo, ['cat-file', 'blob', `${res.preOid}:good.txt`]), 'good-dirty\n');
});

// ══ non-witnessed rejection ═════════════════════════════════════════════════════

test('restorePaths rejects a non-witnessed path visibly (no lock, no row)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'a.txt', op: 'write' }]);
  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['a.txt', 'never-witnessed.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, 'non-witnessed-paths');
  assert.deepEqual(res.rejectedPaths, ['never-witnessed.txt']);
  assert.equal(s.recoveryStore.rows.size, 0, 'no recovery row created for a rejected request');
});

// ══ revertTurn whole witnessed set ══════════════════════════════════════════════

test('revertTurn restores the whole witnessed set (modify + create → delete)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'm.txt'), 'm-orig\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'm.txt', op: 'write' }, { path: 'c.txt', op: 'create' }]);
  fs.writeFileSync(path.join(repo, 'm.txt'), 'm-changed\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'created\n');

  const res = await s.svc.revertTurn({ turnId: 'T', workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo) });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'completed');
  assert.equal(res.kind, 'revert_turn');
  assert.deepEqual(res.completedPaths.sort(), ['c.txt', 'm.txt']);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'm.txt')), Buffer.from('m-orig\n'));
  assert.equal(fs.existsSync(path.join(repo, 'c.txt')), false, 'created file deleted on revert');
});

// ══ preview-token anti-TOCTOU ═══════════════════════════════════════════════════

test('preview-token mismatch aborts before mutation unless forced', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'a.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n');

  const res = await s.svc.restorePaths({
    turnId: 'T', requestedPaths: ['a.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
    previewTokens: { 'a.txt': 'stale-token-that-does-not-match' },
  });
  await s.svc.settleCleanups();
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, 'preview-token-mismatch');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'a.txt')), Buffer.from('v2\n'), 'no mutation on mismatch');
});

// ══ concurrency: a BEFORE enqueued during a restore waits (withLock held) ════════

test('a concurrent BEFORE checkpoint enqueued during a restore does not start until the restore releases the lock', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'orig\n');
  commitAll(repo);
  const s = await setupBefore(repo, 'T', 'WS', [{ path: 'a.txt', op: 'write' }]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'scrambled\n');
  s.store.seedOpen('T2', 'WS', { agentId: 'agent-2' });

  const log: string[] = [];
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => { releaseGate = r; });

  // Same queue → same key → serialized. The restore's blob-write holds the lock open
  // until we release the gate; a BEFORE capture (the only path that calls `enumerate`)
  // must not run until then.
  const svc = mkService({
    store: s.store, recoveryStore: s.recoveryStore, queue: s.queue,
    enumerate: async (o): Promise<EnumerationOutcome> => { log.push('before:enumerate'); return enumerateScope(o as never); },
    runGitBlobToFile: async (cwd, oid, dst, opts: RunGitBlobToFileOptions) => {
      log.push('restore:blob');
      await gate;
      log.push('restore:released');
      return realRunGitBlobToFile(cwd, oid, dst, opts);
    },
  });

  const restoreP = svc.restorePaths({
    turnId: 'T', requestedPaths: ['a.txt'], workspaceId: 'WS', actor: 'human-ipc', capability: capFor(repo),
  });
  // Wait until the restore is parked inside the blob-write (holding the lock).
  for (let i = 0; i < 200 && !log.includes('restore:blob'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(log.includes('restore:blob'), 'restore reached its blob-write');

  // Enqueue a BEFORE capture on the SAME key; it must wait behind the RESTORE lock.
  const beforeP = svc.captureEdge({
    edge: 'before', turnId: 'T2', workspaceId: 'WS', agentId: 'agent-2', capability: capFor(repo), quality: 'guaranteed',
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(log.includes('before:enumerate'), false, 'BEFORE capture did not start while the restore held the lock');

  releaseGate();
  const [restore, before] = await Promise.all([restoreP, beforeP]);
  await svc.settleCleanups();
  assert.equal(restore.status, 'completed');
  assert.equal(before.status, 'ready');
  // The BEFORE work only ran AFTER the restore released the lock.
  assert.ok(log.indexOf('before:enumerate') > log.indexOf('restore:released'), 'BEFORE ran only after the restore released');
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-G1.3c tests need real git.');
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
