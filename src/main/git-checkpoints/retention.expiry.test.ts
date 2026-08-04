// SC-WP-N2 — checkpoint-expiry attention notice construction.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/retention.expiry.test.js
//
// Covers the pure `buildCheckpointExpiryNotice` (empty case, repositoryKey gate,
// within-window filter, deterministic ordering, affectedEntryIds carry-through)
// plus an end-to-end assertion that `runRetentionPass` emits the notice from its
// ACTUAL retained-pin selection (real git, mirroring retention.pinning.test).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DirtyEntry, EncodedGitPath } from '../../shared/commit-candidates';
import { RETENTION_PIN_MAX_EXTENSION_MS } from '../../shared/constants';
import type { TurnRecord } from '../database';
import type { EdgePinCandidate } from './protection-policy';
import { resolveInternalGit } from '../git/git-runtime';
import { CheckpointQueue } from './checkpoint-queue';
import { runGit as realRunGit } from './git-command';
import {
  buildCheckpointExpiryNotice,
  runRetentionPass,
  CHECKPOINT_EXPIRY_ATTENTION_WINDOW_MS,
  type RetentionDeps,
  type RetentionTurnStore,
} from './retention';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const NOW = 5_000_000;

function edge(
  turnId: string,
  edge: 'before' | 'after',
  normalPruneEligibleAt: number,
  dirtyEntryIds: string[],
): EdgePinCandidate {
  return { turnId, edge, dirtyEntryIds, normalPruneEligibleAt, estimatedBytes: 10 };
}

// ── pure buildCheckpointExpiryNotice ─────────────────────────────────────────

test('empty selection ⇒ null (nothing is expiring)', () => {
  const notice = buildCheckpointExpiryNotice({
    retainedEdges: [],
    repositoryKey: 'repo-1',
    now: NOW,
    expiresWithinMs: CHECKPOINT_EXPIRY_ATTENTION_WINDOW_MS,
  });
  assert.equal(notice, null);
});

test('null repositoryKey ⇒ null even with retained edges (per-edge repo unknown)', () => {
  const notice = buildCheckpointExpiryNotice({
    // normalPruneEligibleAt so expiresAt sits well inside the window.
    retainedEdges: [edge('t1', 'after', NOW - RETENTION_PIN_MAX_EXTENSION_MS + 1000, ['e1'])],
    repositoryKey: null,
    now: NOW,
    expiresWithinMs: CHECKPOINT_EXPIRY_ATTENTION_WINDOW_MS,
  });
  assert.equal(notice, null);
});

test('only edges expiring within the window are surfaced', () => {
  // soon: expiresAt = NOW + 1000 (inside a 1h window). far: expiresAt = NOW + 10 days.
  const soon = edge('t-soon', 'after', NOW + 1000 - RETENTION_PIN_MAX_EXTENSION_MS, ['soon']);
  const far = edge('t-far', 'after', NOW + 10 * 86_400_000 - RETENTION_PIN_MAX_EXTENSION_MS, ['far']);
  const notice = buildCheckpointExpiryNotice({
    retainedEdges: [far, soon],
    repositoryKey: 'repo-1',
    now: NOW,
    expiresWithinMs: 60 * 60 * 1000, // 1 hour
  });
  assert.ok(notice);
  assert.equal(notice!.edges.length, 1);
  assert.equal(notice!.edges[0].turnId, 't-soon');
  assert.equal(notice!.observedAt, NOW);
  assert.equal(notice!.expiresWithinMs, 60 * 60 * 1000);
});

test('edges are ordered soonest-first, then turnId, then edge; entryIds carried', () => {
  const base = NOW - RETENTION_PIN_MAX_EXTENSION_MS; // expiresAt === normalPruneEligibleAt + ext
  const later = edge('t-b', 'after', base + 2000, ['b1', 'b2']);
  const earlierAfter = edge('t-a', 'after', base + 1000, ['a-after']);
  const earlierBefore = edge('t-a', 'before', base + 1000, ['a-before']);
  const notice = buildCheckpointExpiryNotice({
    retainedEdges: [later, earlierBefore, earlierAfter],
    repositoryKey: 'repo-1',
    now: NOW,
    expiresWithinMs: 10_000,
  });
  assert.ok(notice);
  // Same expiry for t-a's two edges → AFTER wins the tie (recoverable end-state).
  assert.deepEqual(
    notice!.edges.map((e) => `${e.turnId}:${e.edge}`),
    ['t-a:after', 't-a:before', 't-b:after'],
  );
  assert.deepEqual(notice!.edges[0].affectedEntryIds, ['a-after']);
  assert.deepEqual(notice!.edges[2].affectedEntryIds, ['b1', 'b2']);
  assert.equal(notice!.edges[0].repositoryKey, 'repo-1');
  assert.equal(notice!.edges[0].expiresAt, base + 1000 + RETENTION_PIN_MAX_EXTENSION_MS);
});

// ── end-to-end: runRetentionPass emits the notice from its real selection ─────

const WS = 'workspace';
const AGENT = 'agent';
const RETENTION_MS = 100;
let EXE = '';
const trash: string[] = [];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(EXE, args, { cwd, input }).toString().trim();
}
function ref(turnId: string, e: 'before' | 'after'): string {
  return `refs/lares/checkpoints/${WS}/${AGENT}/${turnId}/${e}`;
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
  constructor(readonly repo: string, readonly repoOid: string) {}
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
      diffStats: {}, compactDiff: '', compactDiffProvenance: 'witnessed', failureReason: null,
    } as TurnRecord);
    git(this.repo, ['update-ref', ref(id, 'before'), oid]);
    git(this.repo, ['update-ref', ref(id, 'after'), oid]);
  }
  listTurnRecords(workspaceId: string): TurnRecord[] {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r }));
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-expiry-'));
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

function deps(repo: string, store: Store, entries: DirtyEntry[], windowMs: number): RetentionDeps {
  return {
    workspaceId: WS, repoRoot: repo, gitExe: EXE, queue: new CheckpointQueue(),
    commonDirQueueKey: repo, workspacePrefix: '', runGit: realRunGit, turnStore: store,
    now: () => NOW, retentionMs: RETENTION_MS,
    checkpointExpiryWindowMs: windowMs,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    enumerateDirtyEntries: async () => ({ repositoryKey: 'repo-key', entries }),
    readLocallyCommittedEntryIds: async () => new Set(),
  };
}

test('runRetentionPass emits the notice from the actual retained selection', async () => {
  const { repo, head, dirtyOid } = makeRepo();
  const store = new Store(repo, head);
  store.seed('turn-a');
  // Widen the window past the 30-day max extension so the retained edge qualifies.
  const result = await runRetentionPass(
    deps(repo, store, [dirty('entry-a', 'dirty.txt', dirtyOid)], RETENTION_PIN_MAX_EXTENSION_MS * 2),
  );
  const notice = result.checkpointExpiryNotice;
  assert.ok(notice, 'expected a checkpoint-expiry notice');
  // Both edges of the still-dirty turn are pinned/retained → both surface.
  assert.equal(notice!.edges.length, 2);
  for (const e of notice!.edges) {
    assert.equal(e.turnId, 'turn-a');
    assert.equal(e.repositoryKey, 'repo-key');
    assert.deepEqual(e.affectedEntryIds, ['entry-a']);
    // normalPruneEligibleAt = (NOW - RETENTION_MS - 1) + RETENTION_MS = NOW - 1.
    assert.equal(e.expiresAt, NOW - 1 + RETENTION_PIN_MAX_EXTENSION_MS);
  }
  assert.equal(notice!.observedAt, NOW);
});

test('kept turn inside the dense window ⇒ no notice (empty selection)', async () => {
  const { repo, head, dirtyOid } = makeRepo();
  const store = new Store(repo, head);
  store.seed('turn-fresh', NOW - 1); // inside dense window → not prunable, never pinned
  const result = await runRetentionPass(
    deps(repo, store, [dirty('entry-a', 'dirty.txt', dirtyOid)], RETENTION_PIN_MAX_EXTENSION_MS * 2),
  );
  assert.equal(result.checkpointExpiryNotice, null);
});

async function main(): Promise<void> {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('SKIP - no compatible git resolved');
    process.exit(1);
  }
  EXE = internal.execPath;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL - ${t.name}`);
      console.error(err);
    }
  }
  for (const dir of trash) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (failed > 0) {
    console.error(`${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length} passed`);
}

void main();
