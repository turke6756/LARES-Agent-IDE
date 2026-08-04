// WP-P7C acceptance tests.
//   npm run build:main
//   node dist/main/main/plans/blame-to-intent.test.js

import assert from 'node:assert/strict';

import type { Plan, Workspace } from '../../shared/types';
import type { CommitRecord, CommitTurnLink, TurnRecord } from '../database';
import {
  normalizeBlameIntentPath,
  queryBlameToIntent,
  type BlameToIntentDeps,
} from './blame-to-intent';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const workspace: Workspace = {
  id: 'ws-1', title: 'Workspace', path: 'C:/workspace', pathType: 'windows',
  description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
};

function plan(id: string): Plan {
  return {
    id, workspaceId: workspace.id, path: `.lares/plans/${id}/plan.md`, slug: id,
    format: 'structured', runState: 'executing', mtimeMs: 0, sizeBytes: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
  };
}

function turn(id: string, planId: string | null, status: TurnRecord['status'] = 'accepted'): TurnRecord {
  return {
    id, workspaceId: workspace.id, turnSeq: Number(id.replace(/\D/g, '')) || 1,
    agentId: `agent-${id}`, agentTitle: null, ownerAgentId: null, ownerBrickGeneration: null,
    planId, planItemId: null, planStampSource: planId ? 'explicit' : 'explicit-none',
    sessionId: null, taskLabel: `Task ${id}`, startedAt: 1, endedAt: 2, status,
    beforeOid: null, afterOid: null, beforeRef: null, afterRef: null,
    beforeReady: false, afterReady: false, beforeQuality: null, afterQuality: null,
    beforeRawFilterBypassed: false, beforeFilteredPaths: null, beforePrunedAt: null,
    afterPrunedAt: null, touched: [{ path: 'src/file.ts', op: 'write' }], diffStats: null,
    compactDiff: null, compactDiffProvenance: null, failureReason: null,
  };
}

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const REPOSITORY_KEY = 'repo-key-for-test';

function deps(options: {
  turns?: TurnRecord[];
  links?: Record<string, CommitTurnLink[]>;
  ledger?: boolean;
  blameCode?: number;
} = {}): BlameToIntentDeps {
  const turns = options.turns ?? [];
  const plans = new Map(['plan-a', 'plan-b'].map((id) => [id, plan(id)]));
  const commit = (oid: string): CommitRecord => ({
    repositoryKey: REPOSITORY_KEY, commitOid: oid, parentOid: null, observedAt: 1,
    source: 'lares', pushedRemoteCount: 0, lastReconciledAt: null,
  });
  return {
    getWorkspace: (id) => id === workspace.id ? workspace : null,
    listTurns: () => turns,
    getTurn: (id) => turns.find((row) => row.id === id) ?? null,
    getPlan: (id) => plans.get(id) ?? null,
    ledger: options.ledger === false ? null : {
      getCommitRecord: (_key, oid) => options.links?.[oid] ? commit(oid) : null,
      listCommitTurnLinks: (_key, oid) => options.links?.[oid] ?? [],
    },
    runGit: async (_cwd, args) => args[0] === 'rev-parse'
      ? { code: 0, stdout: '.git/index\n', stderr: '' }
      : { code: options.blameCode ?? 0, stdout: `${COMMIT_A} 1 1 1\n${COMMIT_B} 2 2 1\n`, stderr: '' },
    // Make repositoryKey derivation deterministic without touching disk.
    canonicalizeIndex: () => {
      // The query hashes this value, so tests replace ledger keys below after
      // calculating the same hash through the requested calls.
      return 'C:/not-used-by-ledger-test';
    },
  };
}

function acceptAnyRepositoryKey(base: BlameToIntentDeps): BlameToIntentDeps {
  const ledger = base.ledger!;
  return {
    ...base,
    ledger: {
      getCommitRecord: (_key, oid) => ledger.getCommitRecord(REPOSITORY_KEY, oid),
      listCommitTurnLinks: (_key, oid) => ledger.listCommitTurnLinks(REPOSITORY_KEY, oid),
    },
  };
}

test('normalizes only file-level workspace-relative POSIX paths', () => {
  assert.equal(normalizeBlameIntentPath('src/./plans/file.ts'), 'src/plans/file.ts');
  assert.equal(normalizeBlameIntentPath('../secret'), null);
  assert.equal(normalizeBlameIntentPath('C:/absolute.ts'), null);
  assert.equal(normalizeBlameIntentPath('src\\file.ts'), null);
});

test('degrades honestly to low-confidence witnessed turns without the ledger', async () => {
  const result = await queryBlameToIntent(
    { workspaceId: workspace.id, path: 'src/file.ts' },
    deps({ ledger: false, turns: [turn('turn-1', 'plan-a'), turn('turn-2', null)] }),
  );
  assert.ok(result);
  assert.equal(result.framing, 'These plans and turns contributed to this file.');
  assert.equal(result.ledgerStrengthening, 'unavailable');
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.contributors.map((row) => ({
    turn: row.turnId, plan: row.plan?.id ?? null, evidence: row.evidence,
  })), [
    { turn: 'turn-1', plan: 'plan-a', evidence: 'turn-witness' },
    { turn: 'turn-2', plan: null, evidence: 'turn-witness' },
  ]);
  assert.deepEqual(result.conflictingContributors.map((row) => row.turnId), ['turn-1', 'turn-2']);
  assert.equal(JSON.stringify(result).includes('authored'), false);
  assert.equal(JSON.stringify(result).includes('clobber'), false);
});

test('blamed commits strengthen linked turns while remaining commit-level', async () => {
  const turns = [turn('turn-1', 'plan-a'), turn('turn-2', 'plan-b')];
  const base = deps({ turns, links: {
    [COMMIT_A]: [{
      repositoryKey: REPOSITORY_KEY, commitOid: COMMIT_A, turnId: 'turn-1',
      planId: 'plan-a', planItemId: null, relation: 'exact_path_match', captureQuality: 'hook',
    }],
    [COMMIT_B]: [{
      repositoryKey: REPOSITORY_KEY, commitOid: COMMIT_B, turnId: 'turn-2',
      planId: 'plan-b', planItemId: null, relation: 'candidate_member', captureQuality: 'hook',
    }],
  } });
  const result = await queryBlameToIntent(
    { workspaceId: workspace.id, path: 'src/file.ts' }, acceptAnyRepositoryKey(base),
  );
  assert.ok(result);
  assert.equal(result.ledgerStrengthening, 'applied');
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.contributors.map((row) => ({
    turn: row.turnId, confidence: row.confidence, commitLevelOnly: row.commitLevelOnly,
    commits: row.commitOids,
  })), [
    { turn: 'turn-1', confidence: 'high', commitLevelOnly: true, commits: [COMMIT_A] },
    { turn: 'turn-2', confidence: 'medium', commitLevelOnly: true, commits: [COMMIT_B] },
  ]);
  assert.deepEqual(result.conflictingContributors.map((row) => row.plan?.id), ['plan-a', 'plan-b']);
});

test('a blame failure retains fallback evidence and makes no stronger claim', async () => {
  const result = await queryBlameToIntent(
    { workspaceId: workspace.id, path: 'src/file.ts' },
    deps({ turns: [turn('turn-1', 'plan-a')], blameCode: 128 }),
  );
  assert.ok(result);
  assert.equal(result.ledgerStrengthening, 'no-linked-commits');
  assert.equal(result.contributors[0].confidence, 'low');
  assert.match(result.warnings.join(' '), /blame unavailable/);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try { await current.run(); console.log(`  ok  ${current.name}`); passed += 1; }
    catch (error) {
      console.error(`  FAIL ${current.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
