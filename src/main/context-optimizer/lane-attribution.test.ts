// lane-attribution unit tests (design §4.2) — table-driven, all five outcomes.
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/lane-attribution.test.js

import assert from 'node:assert/strict';
import {
  laneForWorkingDir,
  type LaneVerdict,
  buildToolsetLaneGrants,
  exclusiveLaneForToolset,
  classifyAttribution,
  UNATTRIBUTED_LANE,
  KNOWN_LANES,
} from './lane-attribution';

interface Row { name: string; dir: string | null | undefined; expect: LaneVerdict; }

const rows: Row[] = [
  // supervisor
  { name: 'supervisor (windows)', dir: 'C:\\Users\\e\\Projects\\App\\.dashboard\\supervisor', expect: 'supervisor' },
  { name: 'supervisor (posix, trailing slash)', dir: '/home/e/App/.dashboard/supervisor/', expect: 'supervisor' },
  // worker
  { name: 'worker claude (windows)', dir: 'C:\\proj\\.dashboard\\workers\\claude', expect: 'worker' },
  { name: 'worker codex (posix)', dir: '/proj/.dashboard/workers/codex', expect: 'worker' },
  // researcher
  { name: 'researcher (windows)', dir: 'C:\\proj\\.dashboard\\researcher', expect: 'researcher' },
  // legacy — real workspace root, no .dashboard template tail
  { name: 'legacy workspace root (windows)', dir: 'C:\\Users\\turke\\Projects\\AgentDashboard', expect: 'legacy' },
  { name: 'legacy workspace root (posix)', dir: '/home/e/code/thing', expect: 'legacy' },
  { name: 'legacy home dir', dir: 'C:\\Users\\turke', expect: 'legacy' },
  // unknown — unrecognized .dashboard template, or no usable dir
  { name: 'unknown .dashboard subdir', dir: '/proj/.dashboard/plumber', expect: 'unknown' },
  { name: 'unknown bare .dashboard', dir: '/proj/.dashboard', expect: 'unknown' },
  { name: 'unknown null', dir: null, expect: 'unknown' },
  { name: 'unknown empty', dir: '', expect: 'unknown' },
  { name: 'unknown whitespace', dir: '   ', expect: 'unknown' },
  // case-insensitive fold (Windows)
  { name: 'supervisor case-fold', dir: 'C:\\Proj\\.Dashboard\\Supervisor', expect: 'supervisor' },
];

let passed = 0; let failed = 0;
for (const r of rows) {
  try {
    const got = laneForWorkingDir(r.dir);
    assert.equal(got, r.expect, `${r.dir} → ${got}, expected ${r.expect}`);
    console.log(`  ok  ${r.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${r.name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}
// ── WP-C: four-tier classifier (grant topology, precedence, gating) ────────────

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}

const grants = buildToolsetLaneGrants();

check('grant topology: exclusive toolsets map to their single lane', () => {
  assert.equal(exclusiveLaneForToolset('orchestration', grants), 'supervisor');
  assert.equal(exclusiveLaneForToolset('plans', grants), 'supervisor');
  assert.equal(exclusiveLaneForToolset('plans-read', grants), 'worker');
  assert.equal(exclusiveLaneForToolset('browser', grants), 'researcher');
  // WP-F (P5): observability-analytics is granted to the supervisor lane ONLY, so
  // an analytics tool call can be inferred to supervisor from the grant topology.
  assert.equal(exclusiveLaneForToolset('observability-analytics', grants), 'supervisor');
});

check('grant topology: multi-lane toolsets are NOT exclusive (gating invariant)', () => {
  // comms / observability-core / browser-present are granted to >1 lane → no inference.
  assert.equal(exclusiveLaneForToolset('comms', grants), null);
  assert.equal(exclusiveLaneForToolset('observability-core', grants), null);
  assert.equal(exclusiveLaneForToolset('browser-present', grants), null);
  // WP-F: the pre-split `observability` union is granted to no lane → not exclusive.
  assert.equal(exclusiveLaneForToolset('observability', grants), null);
});

check('grant topology: unknown / null toolset is not exclusive', () => {
  assert.equal(exclusiveLaneForToolset('no-such-toolset', grants), null);
  assert.equal(exclusiveLaneForToolset(null, grants), null);
});

check('KNOWN_LANES covers every grant-bearing lane (topology source of truth)', () => {
  assert.ok(KNOWN_LANES.includes('supervisor'));
  assert.ok(KNOWN_LANES.includes('worker'));
  assert.ok(KNOWN_LANES.includes('researcher'));
  assert.ok(KNOWN_LANES.includes('legacy'));
});

check('precedence: agent beats everything (tier 1)', () => {
  const o = classifyAttribution({ hasAgent: true, explicitLane: 'worker', toolset: 'orchestration' }, grants);
  assert.equal(o.tier, 'agent-attributed');
  assert.equal(o.lane, 'worker'); // explicit lane is the best secondary signal
});

check('tier 1: agent with no explicit lane falls back to exclusive-grant lane for the cross-tab', () => {
  const o = classifyAttribution({ hasAgent: true, explicitLane: null, toolset: 'orchestration' }, grants);
  assert.equal(o.tier, 'agent-attributed');
  assert.equal(o.lane, 'supervisor');
});

check('tier 1: agent with no lane signal at all → unattributed lane, still agent tier', () => {
  const o = classifyAttribution({ hasAgent: true, explicitLane: null, toolset: 'comms' }, grants);
  assert.equal(o.tier, 'agent-attributed');
  assert.equal(o.lane, UNATTRIBUTED_LANE);
});

check('tier 2: explicit lane (no agent) → lane-attributed-explicit', () => {
  const o = classifyAttribution({ hasAgent: false, explicitLane: 'supervisor', toolset: 'comms' }, grants);
  assert.equal(o.tier, 'lane-attributed-explicit');
  assert.equal(o.lane, 'supervisor');
});

check('"unknown" explicit lane does NOT count as explicit (falls through)', () => {
  // toolset comms is multi-lane → cannot infer → unattributed.
  const o = classifyAttribution({ hasAgent: false, explicitLane: 'unknown', toolset: 'comms' }, grants);
  assert.equal(o.tier, 'unattributed');
  assert.equal(o.lane, UNATTRIBUTED_LANE);
});

check('tier 3: exclusive-grant inference with basis + reason', () => {
  const o = classifyAttribution({ hasAgent: false, explicitLane: null, toolset: 'orchestration' }, grants);
  assert.equal(o.tier, 'lane-inferred-from-current-grant');
  assert.equal(o.lane, 'supervisor');
  assert.equal(o.basis, 'current-toolsetsForLane exclusive to supervisor');
  assert.match(o.reason!, /granted to exactly one lane \(supervisor\)/);
});

check('tier 3 (WP-F): an observability-analytics call with no agent/lane infers supervisor', () => {
  const o = classifyAttribution({ hasAgent: false, explicitLane: null, toolset: 'observability-analytics' }, grants);
  assert.equal(o.tier, 'lane-inferred-from-current-grant');
  assert.equal(o.lane, 'supervisor');
  assert.match(o.reason!, /granted to exactly one lane \(supervisor\)/);
});

check('tier 3 gating: multi-lane toolset is NEVER inferred (stays unattributed)', () => {
  for (const toolset of ['comms', 'observability-core', 'browser-present']) {
    const o = classifyAttribution({ hasAgent: false, explicitLane: null, toolset }, grants);
    assert.equal(o.tier, 'unattributed', `${toolset} must not be inferred`);
    assert.equal(o.lane, UNATTRIBUTED_LANE);
  }
});

check('tier 4: no signals at all → unattributed (first-class)', () => {
  const o = classifyAttribution({ hasAgent: false, explicitLane: null, toolset: null }, grants);
  assert.equal(o.tier, 'unattributed');
  assert.equal(o.lane, UNATTRIBUTED_LANE);
  assert.equal(o.basis, '');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
