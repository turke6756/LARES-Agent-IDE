// WP2 provenance spine — section-cache unit test (R2 §2.4).
//
// The in-memory diff engine: first-seen SEEDS silently, a moved hash emits
// exactly one change row, an unchanged hash emits nothing, and seed() primes a
// baseline so the first live reparse diffs against real prior state.
//
//   npm run build:main
//   node dist/main/main/plans/section-cache.test.js

import assert from 'node:assert/strict';
import { SectionCache, type ParsedSectionHash } from './section-cache';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const PLAN = 'plan-1';

interface Recorded {
  planId: string; sectionAnchor: string; blockAnchor: string | null;
  contentHash: string; changedAt?: string;
}
function makeCache() {
  const rows: Recorded[] = [];
  const cache = new SectionCache({
    recordPlanSectionChange: (input) => {
      rows.push({ blockAnchor: null, ...input });
      return 'row-' + rows.length;
    },
  });
  return { cache, rows };
}
const sec = (sectionAnchor: string, contentHash: string, blockAnchor?: string | null): ParsedSectionHash =>
  ({ sectionAnchor, contentHash, blockAnchor });

// ── first-seen seeds silently ────────────────────────────────────────────────

test('first-seen section records no change row (seeds silently)', () => {
  const { cache, rows } = makeCache();
  const changed = cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]);
  assert.equal(rows.length, 0, 'boot reparse must not spam unattributable change rows');
  assert.equal(changed.length, 0);
  assert.equal(cache.peek(PLAN, 'sec_aaa111'), 'h1', 'but the baseline is now primed');
});

// ── moved hash → exactly one change row ──────────────────────────────────────

test('moved hash records exactly one change row', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]);        // seed
  const changed = cache.observeReparse(PLAN, [sec('sec_aaa111', 'h2')]); // move
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sectionAnchor, 'sec_aaa111');
  assert.equal(rows[0].contentHash, 'h2');
  assert.equal(rows[0].planId, PLAN);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].contentHash, 'h2');
});

test('a second move on the same section emits a second row (append-only)', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]);
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h2')]);
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h3')]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].contentHash, 'h3');
});

// ── unchanged → no row ───────────────────────────────────────────────────────

test('unchanged hash records nothing', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]);   // seed
  const changed = cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]); // same
  assert.equal(rows.length, 0);
  assert.equal(changed.length, 0);
});

test('only the moved section of several is recorded', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1'), sec('sec_bbb222', 'g1'), sec('sec_ccc333', 'k1')]);
  const changed = cache.observeReparse(PLAN, [
    sec('sec_aaa111', 'h1'),  // unchanged
    sec('sec_bbb222', 'g2'),  // moved
    sec('sec_ccc333', 'k1'),  // unchanged
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sectionAnchor, 'sec_bbb222');
  assert.deepEqual(changed.map((c) => c.sectionAnchor), ['sec_bbb222']);
});

// ── seed() primes baseline ───────────────────────────────────────────────────

test('seed() primes a baseline so the first reparse diffs against it', () => {
  const { cache, rows } = makeCache();
  cache.seed(PLAN, [sec('sec_aaa111', 'h1')]);
  assert.equal(cache.peek(PLAN, 'sec_aaa111'), 'h1');
  // First live reparse with a different hash is a MOVE, not a first-seen seed.
  const changed = cache.observeReparse(PLAN, [sec('sec_aaa111', 'h2')]);
  assert.equal(rows.length, 1);
  assert.equal(changed.length, 1);
});

test('seed() then unchanged reparse records nothing', () => {
  const { cache, rows } = makeCache();
  cache.seed(PLAN, [sec('sec_aaa111', 'h1')]);
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]);
  assert.equal(rows.length, 0);
});

// ── block-anchor keying ──────────────────────────────────────────────────────

test('block anchors key independently of the section', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1'), sec('sec_aaa111', 'b1', 'blk_zzz999')]); // both first-seen
  assert.equal(rows.length, 0);
  const changed = cache.observeReparse(PLAN, [
    sec('sec_aaa111', 'h1'),                    // section unchanged
    sec('sec_aaa111', 'b2', 'blk_zzz999'),      // block moved
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blockAnchor, 'blk_zzz999');
  assert.equal(changed.length, 1);
});

test('changedAt is threaded through to the change row', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h1')]);
  cache.observeReparse(PLAN, [sec('sec_aaa111', 'h2')], '2026-07-05T00:00:00.000Z');
  assert.equal(rows[0].changedAt, '2026-07-05T00:00:00.000Z');
});

test('the same anchor under two plans is keyed separately', () => {
  const { cache, rows } = makeCache();
  cache.observeReparse('plan-A', [sec('sec_aaa111', 'h1')]);
  cache.observeReparse('plan-B', [sec('sec_aaa111', 'h1')]);   // first-seen under B, not a move
  assert.equal(rows.length, 0);
  assert.equal(cache.peek('plan-A', 'sec_aaa111'), 'h1');
  assert.equal(cache.peek('plan-B', 'sec_aaa111'), 'h1');
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
