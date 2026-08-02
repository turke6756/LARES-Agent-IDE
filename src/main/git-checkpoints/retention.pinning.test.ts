// SC-WP-2K — retention executor integration for dirty edge pins.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DirtyEntry, EncodedGitPath } from '../../shared/commit-candidates';
import { RETENTION_PIN_MAX_EXTENSION_MS } from '../../shared/constants';
import type { TurnRecord } from '../database';
import { resolveInternalGit } from '../git/git-runtime';
import { CheckpointQueue } from './checkpoint-queue';
import { runGit as realRunGit } from './git-command';
import { runRetentionPass, type RetentionDeps, type RetentionTurnStore } from './retention';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const WS = 'workspace';
const AGENT = 'agent';
const NOW = 1_000_000;
const RETENTION_MS = 100;
let EXE = '';
const trash: string[] = [];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(EXE, args, { cwd, input }).toString().trim();
}
function ref(turnId: string, edge: 'before' | 'after'): string {
  return `refs/lares/checkpoints/${WS}/${AGENT}/${turnId}/${edge}`;
}
function resolves(repo: string, name: string): boolean {
  try {
    execFileSync(EXE, ['rev-parse', '--verify', `${name}^{commit}`], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch { return false; }
}
function encoded(value: string): EncodedGitPath {
  return { pathBytesBase64: Buffer.from(value).toString('base64'), displayPath: value, utf8Clean: true };
}
function dirty(entryId: string, filePath: string, oid: string): DirtyEntry {
  const pathValue = encoded(filePath);
  return {
    entryId, path: pathValue, originalPath: null, entryKind: 'ordinary',
    indexStatus: '.', worktreeStatus: 'M', headMode: '100644', indexMode: '100644',
    worktreeMode: '100644', submoduleState: null, renameOrCopyScore: null,
    expectedWorktreeState: 'present', rawWorktreeBlobOid: oid,
    gitLevelEligibility: 'supported', commitPathspecs: [pathValue],
  };
}

class Store implements RetentionTurnStore {
  rows = new Map<string, TurnRecord>();
  seed(id: string, endedAt = NOW - RETENTION_MS - 1): void {
    const oid = this.repoOid;
    this.rows.set(id, {
      id, workspaceId: WS, turnSeq: this.rows.size + 1, agentId: AGENT, agentTitle: null,
      ownerAgentId: null, ownerBrickGeneration: null, sessionId: null, taskLabel: null,
      startedAt: endedAt - 10, endedAt, status: 'stopped',
      beforeOid: oid, afterOid: oid, beforeRef: ref(id, 'before'), afterRef: ref(id, 'after'),
      beforeReady: true, afterReady: true, beforeQuality: 'guaranteed', afterQuality: 'hook',
      beforeRawFilterBypassed: false, beforeFilteredPaths: null,
      beforePrunedAt: null, afterPrunedAt: null,
      touched: [{ path: 'dirty.txt', op: 'write' }],
      // Pre-distilled: these tests isolate pin selection/ref mutation.
      diffStats: {}, compactDiff: '', compactDiffProvenance: 'witnessed', failureReason: null,
    });
    git(this.repo, ['update-ref', ref(id, 'before'), oid]);
    git(this.repo, ['update-ref', ref(id, 'after'), oid]);
  }
  constructor(readonly repo: string, readonly repoOid: string) {}
  listTurnRecords(workspaceId: string): TurnRecord[] {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row }));
  }
  getTurnRecord(id: string): TurnRecord | null { return this.rows.get(id) ?? null; }
  updateTurnRecord(id: string, updates: Record<string, unknown>): TurnRecord | null {
    const row = this.rows.get(id);
    if (!row) return null;
    Object.assign(row, updates);
    return row;
  }
}

function makeRepo(): { repo: string; head: string; dirtyOid: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-pin-retention-'));
  trash.push(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@lares.local']);
  git(repo, ['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const dirtyOid = git(repo, ['hash-object', '-w', '--stdin'], 'dirty bytes\n');
  return { repo, head, dirtyOid };
}

function deps(repo: string, store: Store, entries: DirtyEntry[]): RetentionDeps {
  return {
    workspaceId: WS, repoRoot: repo, gitExe: EXE, queue: new CheckpointQueue(),
    commonDirQueueKey: repo, workspacePrefix: '', runGit: realRunGit, turnStore: store,
    now: () => NOW, retentionMs: RETENTION_MS,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    enumerateDirtyEntries: async () => ({ repositoryKey: 'repo-key', entries }),
    readLocallyCommittedEntryIds: async () => new Set(),
  };
}

test('dirty multi-path edge is retained atomically by the executor', async () => {
  const { repo, head, dirtyOid } = makeRepo();
  const store = new Store(repo, head);
  store.seed('turn-a');
  const second = dirty('entry-b', 'dirty.txt', dirtyOid);
  const result = await runRetentionPass(deps(repo, store, [dirty('entry-a', 'dirty.txt', dirtyOid), second]));
  assert.equal(result.outcomes[0].action, 'kept');
  assert.equal(resolves(repo, ref('turn-a', 'before')), true);
  assert.equal(resolves(repo, ref('turn-a', 'after')), true);
});

test('locally-committed paths leave the pin set and resume normal thinning', async () => {
  const { repo, head, dirtyOid } = makeRepo();
  const store = new Store(repo, head);
  store.seed('committed');
  const entry = dirty('committed-entry', 'dirty.txt', dirtyOid);
  const configured = deps(repo, store, [entry]);
  configured.readLocallyCommittedEntryIds = async () => new Set([entry.entryId]);
  const result = await runRetentionPass(configured);
  assert.equal(result.outcomes[0].action, 'pruned');
  assert.equal(resolves(repo, ref('committed', 'before')), false);
  assert.equal(resolves(repo, ref('committed', 'after')), false);
});

test('enumeration failure considers every otherwise-prunable live edge, bounded and quota-selected', async () => {
  const { repo, head } = makeRepo();
  const store = new Store(repo, head);
  store.seed('a');
  store.seed('b');
  store.seed('expired', NOW - RETENTION_MS - RETENTION_PIN_MAX_EXTENSION_MS - 1);
  const configured = deps(repo, store, []);
  configured.enumerateDirtyEntries = async () => { throw new Error('status unavailable'); };
  const result = await runRetentionPass(configured);

  // Same eligibility: 2H orders AFTER before BEFORE, then turn id. One full-quota
  // fallback edge fits; all other live candidates fall through to normal pruning.
  assert.equal(resolves(repo, ref('a', 'after')), true, 'preferred after edge retained');
  assert.equal(resolves(repo, ref('a', 'before')), false);
  assert.equal(resolves(repo, ref('b', 'after')), false);
  assert.equal(resolves(repo, ref('b', 'before')), false);
  assert.equal(resolves(repo, ref('expired', 'after')), false, 'past-max edge falls through normally');
  assert.equal(resolves(repo, ref('expired', 'before')), false, 'past-max edge is not a fallback candidate');
  assert.deepEqual(result.pinningWarning?.releasedEdges, [
    { turnId: 'a', edge: 'before' },
    { turnId: 'b', edge: 'after' },
    { turnId: 'b', edge: 'before' },
  ]);
});

test('an accounting dependency error retains live unexpired edges fail-safe', async () => {
  const { repo, head, dirtyOid } = makeRepo();
  const store = new Store(repo, head);
  store.seed('fail-safe');
  const configured = deps(repo, store, [dirty('entry', 'dirty.txt', dirtyOid)]);
  configured.activeBoundaryRefs = async () => { throw new Error('boundary ledger unavailable'); };
  const result = await runRetentionPass(configured);
  assert.equal(result.outcomes[0].action, 'kept');
  assert.equal(resolves(repo, ref('fail-safe', 'before')), true);
  assert.equal(resolves(repo, ref('fail-safe', 'after')), true);
});

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('SKIP - no compatible git resolved');
    process.exit(1);
  }
  EXE = internal.execPath;
  let failures = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`ok - ${current.name}`); }
    catch (error) { failures++; console.error(`not ok - ${current.name}`); console.error(error); }
  }
  for (const directory of trash) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`\n${tests.length} retention pinning tests passed`);
})();
