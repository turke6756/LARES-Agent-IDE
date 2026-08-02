// SC-WP-2H — pure retention-pin quota policy.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/protection-policy.test.js

import assert from 'node:assert/strict';

import {
  RETENTION_PIN_MAX_EXTENSION_MS,
  RETENTION_PIN_QUOTA_BYTES,
} from '../../shared/constants';
import {
  selectRetentionPins,
  type EdgePinCandidate,
} from './protection-policy';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const ELIGIBLE_AT = 10_000;
const NOW = ELIGIBLE_AT + 1;

function candidate(
  turnId: string,
  edge: EdgePinCandidate['edge'],
  estimatedBytes: number,
  dirtyEntryIds: string[] = [`entry-${turnId}-${edge}`],
  normalPruneEligibleAt = ELIGIBLE_AT,
): EdgePinCandidate {
  return { turnId, edge, dirtyEntryIds, normalPruneEligibleAt, estimatedBytes };
}

function refs(edges: EdgePinCandidate[]): string[] {
  return edges.map(({ turnId, edge }) => `${turnId}:${edge}`);
}

test('selection is deterministic, ordered by eligibility then turn id, and edge-atomic', () => {
  const oldest = candidate('turn-z', 'after', 300_000_000, ['entry-z'], ELIGIBLE_AT - 2);
  const tieFirst = candidate('turn-a', 'after', 200_000_000, ['entry-a'], ELIGIBLE_AT - 1);
  const cannotPartiallyFit = candidate('turn-b', 'after', 50_000_000, ['entry-b'], ELIGIBLE_AT - 1);

  const forward = selectRetentionPins([cannotPartiallyFit, oldest, tieFirst], NOW);
  const reverse = selectRetentionPins([tieFirst, oldest, cannotPartiallyFit], NOW);

  assert.deepEqual(refs(forward.retainedEdges), ['turn-z:after', 'turn-a:after']);
  assert.deepEqual(refs(forward.releasedEdges), ['turn-b:after']);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.warning?.usedBytes, 500_000_000);
});

test('AFTER wins over BEFORE for one turn when only one complete edge fits', () => {
  const edgeBytes = 300_000_000;
  const result = selectRetentionPins([
    candidate('same-turn', 'before', edgeBytes),
    candidate('same-turn', 'after', edgeBytes),
  ], NOW);

  assert.deepEqual(refs(result.retainedEdges), ['same-turn:after']);
  assert.deepEqual(refs(result.releasedEdges), ['same-turn:before']);
  assert.equal(result.warning?.usedBytes, edgeBytes);
});

test('an edge whose full cost exactly reaches the quota is retained', () => {
  const result = selectRetentionPins([
    candidate('a', 'after', RETENTION_PIN_QUOTA_BYTES - 1),
    candidate('b', 'after', 1),
  ], NOW);

  assert.deepEqual(refs(result.retainedEdges), ['a:after', 'b:after']);
  assert.deepEqual(result.releasedEdges, []);
  assert.equal(result.warning, null);
});

test('pin remains live at pinExpiresAt and falls through immediately after it', () => {
  const edge = candidate('expiring', 'after', 1, ['dirty-b', 'dirty-a', 'dirty-b']);
  const pinExpiresAt = edge.normalPruneEligibleAt + RETENTION_PIN_MAX_EXTENSION_MS;

  const atBoundary = selectRetentionPins([edge], pinExpiresAt);
  assert.deepEqual(refs(atBoundary.retainedEdges), ['expiring:after']);
  assert.equal(atBoundary.warning, null);

  const expired = selectRetentionPins([edge], pinExpiresAt + 1);
  assert.deepEqual(refs(expired.releasedEdges), ['expiring:after']);
  assert.deepEqual(expired.warning, {
    quotaBytes: RETENTION_PIN_QUOTA_BYTES,
    usedBytes: 0,
    releasedEdges: [{ turnId: 'expiring', edge: 'after' }],
    willWeakenPaths: ['dirty-a', 'dirty-b'],
  });
});

test('warning is emitted only when a forced release still protects dirty entries', () => {
  const fits = selectRetentionPins([candidate('fits', 'after', 1)], NOW);
  assert.equal(fits.warning, null);

  const releasedButClean = selectRetentionPins([
    candidate('fills-quota', 'after', RETENTION_PIN_QUOTA_BYTES),
    candidate('no-dirty-entry', 'before', 1, []),
  ], NOW);
  assert.deepEqual(refs(releasedButClean.releasedEdges), ['no-dirty-entry:before']);
  assert.equal(releasedButClean.warning, null);

  const releasedDirty = selectRetentionPins([
    candidate('fills-quota', 'after', RETENTION_PIN_QUOTA_BYTES),
    candidate('z-dirty', 'before', 1, ['path-z', 'path-a']),
  ], NOW);
  assert.deepEqual(releasedDirty.warning, {
    quotaBytes: RETENTION_PIN_QUOTA_BYTES,
    usedBytes: RETENTION_PIN_QUOTA_BYTES,
    releasedEdges: [{ turnId: 'z-dirty', edge: 'before' }],
    willWeakenPaths: ['path-a', 'path-z'],
  });
});

test('selection does not mutate the candidate array', () => {
  const input = [
    candidate('z', 'before', 1),
    candidate('a', 'after', 1),
  ];
  const original = [...input];

  selectRetentionPins(input, NOW);

  assert.deepEqual(input, original);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) process.exitCode = 1;
else console.log(`\n${tests.length} protection-policy tests passed`);
