// SC-WP-1E capture-health acceptance.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/capture-health.test.js

import assert from 'node:assert/strict';

import type { DirtyEntry } from '../../shared/commit-candidates';
import type { LiveEdgeRunGit } from '../git-checkpoints/live-edge';
import {
  classifyCaptureFailure,
  computeBundleCaptureHealth,
  type CaptureHealthTurn,
} from './capture-health';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const OID = 'a'.repeat(40);
const OTHER_OID = 'b'.repeat(40);

function turn(extra: Partial<CaptureHealthTurn> = {}): CaptureHealthTurn {
  return {
    id: 'turn-1',
    status: 'accepted',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
    beforeQuality: null,
    afterQuality: null,
    beforePrunedAt: null,
    afterPrunedAt: null,
    failureReason: null,
    ...extra,
  };
}

// Emulate `git cat-file --batch-check`: one output line per stdin ref query
// (`<ref>^{commit}`), in order — "<oid> commit <size>" when known, else
// "<query> missing". This is the batched liveness seam capture-health now uses.
function fakeGit(refs: Readonly<Record<string, string>>): LiveEdgeRunGit {
  return async (_cwd, _args, opts) => {
    const stdin = (opts.stdin ?? '').toString();
    const queries = stdin.split('\n').filter((line) => line.length > 0);
    const stdout = queries
      .map((query) => {
        const ref = query.replace(/\^\{commit\}$/, '');
        const oid = refs[ref];
        return oid ? `${oid} commit 100` : `${query} missing`;
      })
      .join('\n') + '\n';
    return { code: 0, stdout, stderr: '' };
  };
}

function dirty(pathBytesBase64: string, displayPath: string): Pick<DirtyEntry, 'path'> {
  return { path: { pathBytesBase64, displayPath, utf8Clean: true } };
}

test('live rev-parse overrides after_ready in both directions', async () => {
  const refs = {
    'refs/live-without-hint': OID,
    'refs/live-wrong-oid': OTHER_OID,
  };
  const result = await computeBundleCaptureHealth({
    repoRoot: 'C:/fixture',
    turns: [
      turn({
        id: 'hint-true-but-dead',
        afterReady: true,
        afterRef: 'refs/missing',
        afterOid: OID,
      }),
      turn({
        id: 'hint-false-but-live',
        afterReady: false,
        afterRef: 'refs/live-without-hint',
        afterOid: OID,
      }),
      turn({
        id: 'hint-true-but-mismatch',
        afterReady: true,
        afterRef: 'refs/live-wrong-oid',
        afterOid: OID,
      }),
    ],
    dirtyEntries: [],
    runGit: fakeGit(refs),
  });

  assert.equal(result.turns[0].afterEdge, 'ready-hint-only');
  assert.equal(result.turns[1].afterEdge, 'verified-live');
  assert.equal(result.turns[2].afterEdge, 'ready-hint-only');
});

test('live authority also overrides a stale pruned hint; otherwise hints classify the dead edge', async () => {
  const result = await computeBundleCaptureHealth({
    repoRoot: 'C:/fixture',
    turns: [
      turn({
        id: 'live-despite-pruned-hint',
        beforeRef: 'refs/live',
        beforeOid: OID,
        beforePrunedAt: 123,
      }),
      turn({
        id: 'pruned',
        beforeRef: 'refs/dead',
        beforeOid: OID,
        beforePrunedAt: 123,
      }),
      turn({ id: 'absent' }),
    ],
    dirtyEntries: [],
    runGit: fakeGit({ 'refs/live': OID }),
  });

  assert.deepEqual(result.turns.map((t) => t.beforeEdge), [
    'verified-live',
    'pruned',
    'absent',
  ]);
});

test('captureOutage is true only for an explicitly classified capture outage', async () => {
  const nonOutages = await computeBundleCaptureHealth({
    repoRoot: 'C:/fixture',
    turns: [
      turn({ id: 'overlap', failureReason: 'overlapping-active-turn' }),
      turn({ id: 'delivery', status: 'delivery_failed' }),
      turn({ id: 'skip', status: 'skipped', failureReason: 'oversized' }),
      turn({ id: 'other', failureReason: 'unrelated-domain-error' }),
      turn({ id: 'none' }),
    ],
    dirtyEntries: [],
    runGit: fakeGit({}),
  });
  assert.deepEqual(nonOutages.turns.map((t) => t.failureClass), [
    'overlap',
    'delivery-failed',
    'skipped',
    'other',
    'none',
  ]);
  assert.equal(nonOutages.captureOutage, false);

  const outage = await computeBundleCaptureHealth({
    repoRoot: 'C:/fixture',
    turns: [turn({ failureReason: 'snapshot-failed' })],
    dirtyEntries: [],
    runGit: fakeGit({}),
  });
  assert.equal(outage.turns[0].failureClass, 'capture-outage');
  assert.equal(outage.captureOutage, true);
});

test('failure classifier keeps delivery and overlap out of outage even with misleading details', () => {
  assert.equal(classifyCaptureFailure('delivery_failed', 'snapshot-failed'), 'delivery-failed');
  assert.equal(classifyCaptureFailure('interrupted', 'overlapping-active-turn'), 'overlap');
  assert.equal(classifyCaptureFailure('accepted', 'before-capture-threw:boom'), 'capture-outage');
});

test('pathsWithoutFinalizationEdge contains every dirty member keyed by exact path bytes', async () => {
  const newlineBytes = Buffer.from('line\nname.txt', 'utf8').toString('base64');
  const nonUtf8Bytes = Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]).toString('base64');
  const result = await computeBundleCaptureHealth({
    repoRoot: 'C:/fixture',
    turns: [],
    dirtyEntries: [
      dirty(newlineBytes, 'line\\nname.txt'),
      dirty(nonUtf8Bytes, '�.txt'),
    ],
    runGit: fakeGit({}),
  });

  assert.deepEqual(result.pathsWithoutFinalizationEdge, [newlineBytes, nonUtf8Bytes]);
  assert.ok(!result.pathsWithoutFinalizationEdge.includes('line\\nname.txt'));
});

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
