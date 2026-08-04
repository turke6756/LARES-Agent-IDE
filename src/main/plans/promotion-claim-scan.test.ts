// WP-P3-wire — the production claim-scan classifier (§R-P3 points 9, 11).
//
// Pure over injected filesystem primitives (no real plans tree, no DB): proves the
// none / claimed / duplicate / foreign classification the WP-P3B-core front half
// depends on, keyed on disk-truth `source_proposal.artifact_id`.
//
// INTENTIONALLY not registered in scripts/run-main-tests.mjs (P3Z owns that
// registry). Run the compiled test directly:
//   npm run build:main
//   node dist/main/main/plans/promotion-claim-scan.test.js

import assert from 'node:assert/strict';
import { makePromotionClaimScan } from './promotion-claim-scan';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const PLANS_HOME = '.lares/plans';
const PROPOSAL = 'prop_abc';
const DETERMINISTIC = `${PLANS_HOME}/2026-08-03-x-plan_abc0`; // basename is the deterministic folder

/** Build a scan over an in-memory folder → claim map. */
function scanOver(folders: Record<string, { planArtifactId: string; sourceProposalArtifactId: string | null } | null>) {
  return makePromotionClaimScan({
    resolvePlansHomeRoot: () => '/abs/plans',
    listFolderNames: () => Object.keys(folders),
    readFolderClaim: (folderAbs) => folders[folderAbs.replace(/^.*[\\/]/, '')] ?? null,
  });
}

function input() {
  return {
    workspaceId: 'ws-1',
    proposalArtifactId: PROPOSAL,
    deterministicPlanArtifactId: 'plan_abc0',
    deterministicFolderRelPath: DETERMINISTIC,
  };
}

test('no folder claims the proposal → none', async () => {
  const scan = scanOver({
    'other-1': { planArtifactId: 'plan_zzz', sourceProposalArtifactId: 'prop_other' },
    'stray': null,
  });
  assert.deepEqual(await scan(input()), { kind: 'none' });
});

test('exactly one valid folder claims it → claimed (retains ITS identity + rel path)', async () => {
  const scan = scanOver({
    '2026-08-03-manual-plan_man': { planArtifactId: 'plan_manual', sourceProposalArtifactId: PROPOSAL },
    'unrelated': { planArtifactId: 'plan_u', sourceProposalArtifactId: null },
  });
  assert.deepEqual(await scan(input()), {
    kind: 'claimed',
    planArtifactId: 'plan_manual',
    folderRelPath: `${PLANS_HOME}/2026-08-03-manual-plan_man`,
  });
});

test('two valid folders claim it → duplicate (blocks, lists both)', async () => {
  const scan = scanOver({
    'a-plan_a': { planArtifactId: 'plan_a', sourceProposalArtifactId: PROPOSAL },
    'b-plan_b': { planArtifactId: 'plan_b', sourceProposalArtifactId: PROPOSAL },
  });
  const res: any = await scan(input());
  assert.equal(res.kind, 'duplicate');
  assert.equal(res.folderRelPaths.length, 2);
  assert.ok(res.folderRelPaths.includes(`${PLANS_HOME}/a-plan_a`));
  assert.ok(res.folderRelPaths.includes(`${PLANS_HOME}/b-plan_b`));
});

test('deterministic target occupied by a DIFFERENT proposal → foreign', async () => {
  const scan = scanOver({
    '2026-08-03-x-plan_abc0': { planArtifactId: 'plan_abc0', sourceProposalArtifactId: 'prop_someone_else' },
  });
  const res: any = await scan(input());
  assert.equal(res.kind, 'foreign');
  assert.equal(res.folderRelPath, DETERMINISTIC);
  assert.match(res.diagnostic, /different proposal/i);
});

test('deterministic target with NO source_proposal claim → none (not foreign)', async () => {
  const scan = scanOver({
    '2026-08-03-x-plan_abc0': { planArtifactId: 'plan_abc0', sourceProposalArtifactId: null },
  });
  assert.deepEqual(await scan(input()), { kind: 'none' });
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
